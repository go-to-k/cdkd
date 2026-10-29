import {
  FirehoseClient,
  CreateDeliveryStreamCommand,
  DeleteDeliveryStreamCommand,
  DescribeDeliveryStreamCommand,
  type DescribeDeliveryStreamCommandOutput,
  ListTagsForDeliveryStreamCommand,
  ResourceNotFoundException,
  UpdateDestinationCommand,
  StartDeliveryStreamEncryptionCommand,
  StopDeliveryStreamEncryptionCommand,
  TagDeliveryStreamCommand,
  UntagDeliveryStreamCommand,
  type CreateDeliveryStreamCommandInput,
  type DeliveryStreamDescription,
  type DeliveryStreamEncryptionConfiguration,
  type S3DestinationConfiguration,
  type ExtendedS3DestinationConfiguration,
  type ExtendedS3DestinationUpdate,
  type RedshiftDestinationUpdate,
  type S3DestinationUpdate,
  type SplunkDestinationUpdate,
  type AmazonopensearchserviceDestinationUpdate,
  type AmazonOpenSearchServerlessDestinationUpdate,
  type HttpEndpointDestinationUpdate,
  type ElasticsearchDestinationUpdate,
  type IcebergDestinationUpdate,
  type SnowflakeDestinationUpdate,
  type Tag,
  type HttpEndpointDestinationConfiguration,
  type RedshiftDestinationConfiguration,
  type ElasticsearchDestinationConfiguration,
  type AmazonopensearchserviceDestinationConfiguration,
  type SplunkDestinationConfiguration,
  type AmazonOpenSearchServerlessDestinationConfiguration,
  type DeliveryStreamEncryptionConfigurationInput,
} from '@aws-sdk/client-firehose';
import { getLogger } from '../../utils/logger.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { maskerOrIdentity, type MaskerFn } from '../masked-retry-logger.js';
import { markNotGone } from '../not-gone.js';
import {
  CdkdError,
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import type {
  CreateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { waitForGoneAfterDelete } from '../delete-gone-wait.js';
import {
  markNonRetryable,
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import { holdsSecretDerivedEntry } from '../iam-policy-targets.js';
import { markCreatedBeforeFailure } from '../auxiliary-failure.js';
import { generatedNameFor } from '../resource-name.js';
import { startInterruptWatch } from '../interrupt-watch.js';
import { safeMsg } from '../../utils/display-safe.js';
import { isDeepStrictEqual } from 'node:util';
import {
  enclosingDeadlineExpired,
  enclosingDeadlineRemainingMs,
} from '../../deployment/resource-deadline.js';

const ENCRYPTION_KEY = 'DeliveryStreamEncryptionConfigurationInput';

/** One read of a declared `DeliveryStreamEncryptionConfigurationInput`. */
type EncryptionInputRead =
  /** Not declared (`undefined` / `null`). On an UPDATE this is a REMOVAL. */
  | { kind: 'absent' }
  | { kind: 'usable'; keyType: string; keyArn?: string }
  /** Declared but not an object with a string `KeyType` (and a string `KeyARN`, if any). */
  | { kind: 'unusable' };

/**
 * Read a `DeliveryStreamEncryptionConfigurationInput` block, accepting the
 * `KeyArn` spelling the create path also reads.
 *
 * `readCurrentState` spells "not encrypted" as an EMPTY `{}` placeholder, so
 * with `emptyIsAbsent` that reads as absent: set for a recorded previous side
 * (`cdkd drift --accept` can write the readback into a record) and for a
 * desired bag that is a readback (`desiredFromAwsReadback`). A TEMPLATE `{}`
 * stays unusable (the CFn schema requires `KeyType`), and so does a replayed
 * state record's: `replayingState` never licenses removing live config.
 */
function readEncryptionInput(value: unknown, emptyIsAbsent: boolean): EncryptionInputRead {
  if (value === undefined || value === null) return { kind: 'absent' };
  if (typeof value !== 'object' || Array.isArray(value)) return { kind: 'unusable' };
  const block = value as Record<string, unknown>;
  if (emptyIsAbsent && Object.keys(block).length === 0) return { kind: 'absent' };
  const keyType = block['KeyType'];
  const keyArn = block['KeyArn'] || block['KeyARN'];
  if (typeof keyType !== 'string' || keyType.length === 0) return { kind: 'unusable' };
  if (keyArn !== undefined && keyArn !== null && keyArn !== '' && typeof keyArn !== 'string') {
    return { kind: 'unusable' };
  }
  return typeof keyArn === 'string' && keyArn.length > 0
    ? { kind: 'usable', keyType, keyArn }
    : { kind: 'usable', keyType };
}

/** `true` when the desired and the recorded block ask AWS for the same thing. */
function sameEncryptionInput(next: unknown, nextRead: EncryptionInputRead, prev: unknown): boolean {
  const b = readEncryptionInput(prev, true);
  if (nextRead.kind === 'unusable' || b.kind === 'unusable') {
    return JSON.stringify(next) === JSON.stringify(prev);
  }
  if (nextRead.kind === 'absent' || b.kind === 'absent') return nextRead.kind === b.kind;
  return nextRead.keyType === b.keyType && nextRead.keyArn === b.keyArn;
}

/**
 * `true` when the stream's reported encryption is ENABLED with the requested
 * key. A KeyARN is compared only for a customer-managed key: AWS reports none
 * for `AWS_OWNED_CMK`.
 */
function encryptionMatches(
  live: DeliveryStreamEncryptionConfiguration | undefined,
  desired: { keyType: string; keyArn?: string }
): boolean {
  if (live?.Status !== 'ENABLED' || live.KeyType !== desired.keyType) return false;
  return desired.keyType !== 'CUSTOMER_MANAGED_CMK' || live.KeyARN === desired.keyArn;
}

/**
 * The CFn input shape of the stream's reported encryption, as
 * `readCurrentState` emits it: `{KeyARN?, KeyType}` while the stream is
 * encrypted or becoming so (ENABLED, ENABLING, DISABLING_FAILED), else the
 * `{}` placeholder. A KeyType AWS still reports beside DISABLED or
 * ENABLING_FAILED is not encryption in effect.
 */
function liveEncryptionAsCfn(
  live: DeliveryStreamEncryptionConfiguration | undefined
): Record<string, unknown> {
  const status = live?.Status;
  if (status !== 'ENABLED' && status !== 'ENABLING' && status !== 'DISABLING_FAILED') return {};
  return {
    ...(live?.KeyARN !== undefined && { KeyARN: live.KeyARN }),
    ...(live?.KeyType !== undefined && { KeyType: live.KeyType }),
  };
}

/** Polling cadence and cap for an encryption transition (measured at ~80-95 s). */
const ENCRYPTION_POLL_INTERVAL_MS = 5000;
const ENCRYPTION_POLL_MAX_ATTEMPTS = 120;

/**
 * Polling cadence and cap for the create-time wait for ACTIVE. The engine's
 * per-resource deadline ends the wait first under the default 30 min timeout;
 * the cap bounds it where no deadline encloses the call.
 */
const ACTIVE_POLL_INTERVAL_MS = 5000;
const ACTIVE_POLL_MAX_ATTEMPTS = 360;
/**
 * What the wait leaves of the resource deadline for its last read and its
 * throw to settle before the deadline fires (go-to-k/cdkd#5509).
 */
const ACTIVE_DEADLINE_MARGIN_MS = 2000;

/** Errors for an `ENABLING_FAILED` / `DISABLING_FAILED` report: AWS ended the transition. */
const terminalEncryptionFailures = new WeakSet<object>();

/**
 * `true` for `undefined` / `null` (ABSENT, the empty list) or a list of tag
 * objects each carrying a non-empty string `Key`. Anything else is malformed:
 * the Tags diff derives its `UntagDeliveryStream` keys from the gap between the
 * two sides, so reading a malformed side as empty would untag every key the
 * other side holds (go-to-k/cdkd#3948).
 */
function isReadableTagList(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return (
    Array.isArray(value) &&
    value.every(
      (t) =>
        typeof t === 'object' &&
        t !== null &&
        !Array.isArray(t) &&
        typeof (t as { Key?: unknown }).Key === 'string' &&
        (t as { Key: string }).Key.length > 0 &&
        // A dynamic reference or its mask names no tag key the stream holds.
        // Refused on BOTH sides, unlike the Auto Scaling group's recorded side:
        // Firehose's documented TagKey pattern admits neither `{` nor `:`, so an
        // UntagDeliveryStream of a recorded `{{resolve:...}}` key is rejected
        // rather than ignored, and the update never converged anyway.
        !holdsSecretDerivedEntry((t as { Key: string }).Key)
    )
  );
}

/**
 * The destinations whose `S3BackupMode` cannot change after the stream is
 * created (go-to-k/cdkd#5386), each with the `DescribeDeliveryStream`
 * description member that reports the live mode. Their `UpdateDestination`
 * shapes (`ElasticsearchDestinationUpdate`,
 * `AmazonopensearchserviceDestinationUpdate`,
 * `AmazonOpenSearchServerlessDestinationUpdate`) have no `S3BackupMode`
 * member, so the change has nothing to be sent through.
 *
 * CloudFormation behaves the same way, and `S3BackupMode` is not a
 * create-only property in its schema. Measured in us-east-1 on 2026-10-27: a
 * stack with an `AmazonOpenSearchServerlessDestinationConfiguration` at
 * `FailedDocumentsOnly`, updated to `AllDocuments`, ended `UPDATE_COMPLETE`
 * with the same stream, its `VersionId` still 1 and its mode still
 * `FailedDocumentsOnly`. (The two domain-backed destinations could not be
 * created without a live OpenSearch domain; they share the schema and the
 * update shape's gap.) cdkd keeps that outcome, records the declared value as
 * CloudFormation's stored template does, and warns instead of staying silent.
 */
const FIXED_BACKUP_MODE_DESTINATIONS: Readonly<
  Record<
    string,
    | 'ElasticsearchDestinationDescription'
    | 'AmazonopensearchserviceDestinationDescription'
    | 'AmazonOpenSearchServerlessDestinationDescription'
  >
> = {
  ElasticsearchDestinationConfiguration: 'ElasticsearchDestinationDescription',
  AmazonopensearchserviceDestinationConfiguration: 'AmazonopensearchserviceDestinationDescription',
  AmazonOpenSearchServerlessDestinationConfiguration:
    'AmazonOpenSearchServerlessDestinationDescription',
};

/** The mode Firehose applies when these destinations declare none. */
const DEFAULT_OPENSEARCH_BACKUP_MODE = 'FailedDocumentsOnly';

/**
 * The destination key whose `S3BackupMode` changed between the two bags but
 * cannot be applied in place (go-to-k/cdkd#5386), or `undefined`. Only a
 * destination both bags declare as an object is compared: a destination switch
 * is refused earlier, and with `changedProperties` set (the deploy's in-place
 * update) a destination the engine did not report as changed is skipped.
 */
function unappliedS3BackupModeDestination(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  destKey: string | undefined,
  changedProperties: ReadonlySet<string> | undefined
): string | undefined {
  if (destKey === undefined || !Object.hasOwn(FIXED_BACKUP_MODE_DESTINATIONS, destKey)) {
    return undefined;
  }
  if (changedProperties !== undefined && !changedProperties.has(destKey)) return undefined;
  const desired = properties[destKey];
  const previous = previousProperties[destKey];
  if (!isPlainRecord(desired) || !isPlainRecord(previous)) return undefined;
  return isDeepStrictEqual(desired['S3BackupMode'], previous['S3BackupMode']) ? undefined : destKey;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Poll cadence and cap for the post-delete gone-wait (issue #3872). The
 * DELETING window measured ~103-107s (us-east-1), so the cap is generous
 * headroom, not an estimate, and sits well under the 30-min per-resource
 * deadline.
 */
const FIREHOSE_DELETE_POLL_INTERVAL_MS = 5_000;
const FIREHOSE_DELETE_MAX_WAIT_MS = 10 * 60 * 1000;

/**
 * SDK Provider for AWS Kinesis Firehose resources
 *
 * Supports:
 * - AWS::KinesisFirehose::DeliveryStream
 *
 * CreateDeliveryStream is synchronous - the CC API adds unnecessary
 * polling overhead for an operation that completes immediately.
 */
export class FirehoseProvider implements ResourceProvider {
  private client: FirehoseClient | undefined;
  private createClient: FirehoseClient | undefined;
  private readonly providerRegion = ambientRegion();
  private logger = getLogger().child('FirehoseProvider');

  /**
   * The failure wrap this provider's create, update and delete catches throw.
   *
   * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
   * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
   * `deployments/{runId}.jsonl`, and an `AccessDenied` names the caller's
   * assumed-role ARN. AWS's own text goes to `debug` through the operation's
   * masker, and the wrap is stamped `markRedactedCause`, so the retry
   * classifiers read the withheld text on the `cause` chain. An "already
   * exists" is restated ({@link relayedNameCollision}), so a create-first
   * replacement still recognises the collision. A cdkd-authored or transport
   * error keeps its text, masked, stamped only when the mask changed it
   * (`wrapMaskedAwsError`, issue #4244); a non-`Error` throw is withheld like
   * an AWS one, unstamped (it has no chain). A delete catch tests not-found
   * before it wraps.
   *
   * `build` must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor call.
   */
  private wrapCaughtError(
    mask: MaskerFn,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    const failure = describeAwsFailure(error);
    if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
    this.logger.debug(mask(build(mask(failure.detail)).message));
    const wrapped = build(`${mask(failure.summary)}${relayedNameCollision(failure.detail)}`);
    return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::KinesisFirehose::DeliveryStream',
      new Set([
        'DeliveryStreamName',
        'DeliveryStreamType',
        'S3DestinationConfiguration',
        'ExtendedS3DestinationConfiguration',
        'KinesisStreamSourceConfiguration',
        'Tags',
        'HttpEndpointDestinationConfiguration',
        'RedshiftDestinationConfiguration',
        'ElasticsearchDestinationConfiguration',
        'AmazonopensearchserviceDestinationConfiguration',
        'SplunkDestinationConfiguration',
        'AmazonOpenSearchServerlessDestinationConfiguration',
        'DeliveryStreamEncryptionConfigurationInput',
      ]),
    ],
  ]);

  private getClient(): FirehoseClient {
    if (!this.client) {
      this.client = new FirehoseClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
      this.createClient = withoutServerErrorRetries(
        new FirehoseClient({
          ...ambientClientDefaults(),
          ...(this.providerRegion ? { region: this.providerRegion } : {}),
        })
      );
    }
    return this.client;
  }

  /**
   * The client `CreateDeliveryStream` goes through: SDK retries on, except a 5xx
   * (`withoutServerErrorRetries`, issue #4639). Separate so every other call
   * keeps the full SDK retry; built in {@link getClient}'s step, so both
   * capture the region and identity active at that ONE call.
   *
   * `CreateDeliveryStream` carries no idempotency token, and a delivery stream
   * name is unique per account and region, so the SDK's own replay of a 5xx whose request had
   * succeeded collides with what the first send made, and that "already
   * exists" surfaced from the engine's FIRST attempt as a name somebody else
   * holds. Refused here, the 5xx reaches the deploy engine's retry, which
   * marks the create as possibly replayed (`withRetry`, #3978). Nothing is
   * adopted on that collision: a name is not attribution
   * (`docs/provider-rules.md`, "Adopt only on EXACT attribution").
   */
  private getCreateClient(): FirehoseClient {
    this.getClient();
    return this.createClient as FirehoseClient;
  }

  /**
   * Create a Firehose delivery stream
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Firehose delivery stream ${logicalId}`);

    const deliveryStreamName = properties['DeliveryStreamName'] as string | undefined;
    const deliveryStreamType =
      (properties['DeliveryStreamType'] as string | undefined) || 'DirectPut';

    // The same Tags read the update path uses: a malformed list would reach
    // `tags.map` below (go-to-k/cdkd#3948).
    if (!isReadableTagList(properties['Tags'])) {
      throw markNonRetryable(
        new ProvisioningError(
          `Tags of Firehose delivery stream ${logicalId} is not a list of tags with a Key — the ` +
            `delivery stream was not created`,
          resourceType,
          logicalId
        )
      );
    }

    // go-to-k/cdkd#4583: the stream's name once CreateDeliveryStream returned
    // (no self-cleanup), so a later failure can name it for rollback.
    let createdStreamName: string | undefined;
    try {
      const input: CreateDeliveryStreamCommandInput = {
        // go-to-k/cdkd#5095: a stack with an instance id generates the name;
        // a legacy stack keeps the bare logical id.
        DeliveryStreamName:
          deliveryStreamName || generatedNameFor('AWS::KinesisFirehose::DeliveryStream', logicalId),
        DeliveryStreamType: deliveryStreamType as
          | 'DirectPut'
          | 'KinesisStreamAsSource'
          | 'MSKAsSource',
      };

      // Map S3DestinationConfiguration (CFn PascalCase -> SDK format)
      if (properties['S3DestinationConfiguration']) {
        const s3Config = properties['S3DestinationConfiguration'] as Record<string, unknown>;
        input.S3DestinationConfiguration = this.mapS3DestinationConfiguration(s3Config);
      }

      // Map ExtendedS3DestinationConfiguration
      if (properties['ExtendedS3DestinationConfiguration']) {
        const extS3Config = properties['ExtendedS3DestinationConfiguration'] as Record<
          string,
          unknown
        >;
        input.ExtendedS3DestinationConfiguration =
          this.mapExtendedS3DestinationConfiguration(extS3Config);
      }

      // Map KinesisStreamSourceConfiguration
      if (properties['KinesisStreamSourceConfiguration']) {
        const kinesisConfig = properties['KinesisStreamSourceConfiguration'] as Record<
          string,
          unknown
        >;
        input.KinesisStreamSourceConfiguration = {
          KinesisStreamARN: (kinesisConfig['KinesisStreamArn'] ||
            kinesisConfig['KinesisStreamARN']) as string,
          RoleARN: (kinesisConfig['RoleArn'] || kinesisConfig['RoleARN']) as string,
        };
      }

      // Map HttpEndpointDestinationConfiguration
      if (properties['HttpEndpointDestinationConfiguration']) {
        const httpConfig = properties['HttpEndpointDestinationConfiguration'] as Record<
          string,
          unknown
        >;
        const endpointConfig = httpConfig['EndpointConfiguration'] as
          | Record<string, unknown>
          | undefined;
        input.HttpEndpointDestinationConfiguration = {
          EndpointConfiguration: endpointConfig
            ? {
                Url: endpointConfig['Url'] as string,
                Name: endpointConfig['Name'] as string | undefined,
                AccessKey: endpointConfig['AccessKey'] as string | undefined,
              }
            : undefined,
          RoleARN: (httpConfig['RoleArn'] || httpConfig['RoleARN']) as string | undefined,
          BufferingHints: httpConfig['BufferingHints'] as
            | HttpEndpointDestinationConfiguration['BufferingHints']
            | undefined,
          CloudWatchLoggingOptions: httpConfig['CloudWatchLoggingOptions'] as
            | HttpEndpointDestinationConfiguration['CloudWatchLoggingOptions']
            | undefined,
          RequestConfiguration: httpConfig['RequestConfiguration'] as
            | HttpEndpointDestinationConfiguration['RequestConfiguration']
            | undefined,
          ProcessingConfiguration: httpConfig['ProcessingConfiguration'] as
            | HttpEndpointDestinationConfiguration['ProcessingConfiguration']
            | undefined,
          RetryOptions: httpConfig['RetryOptions'] as
            | HttpEndpointDestinationConfiguration['RetryOptions']
            | undefined,
          S3BackupMode: httpConfig['S3BackupMode'] as string | undefined,
          S3Configuration: httpConfig['S3Configuration']
            ? this.mapS3DestinationConfiguration(
                httpConfig['S3Configuration'] as Record<string, unknown>
              )
            : undefined,
          SecretsManagerConfiguration: httpConfig['SecretsManagerConfiguration'] as
            | HttpEndpointDestinationConfiguration['SecretsManagerConfiguration']
            | undefined,
        } as HttpEndpointDestinationConfiguration;
      }

      // Map RedshiftDestinationConfiguration
      if (properties['RedshiftDestinationConfiguration']) {
        const rsConfig = properties['RedshiftDestinationConfiguration'] as Record<string, unknown>;
        input.RedshiftDestinationConfiguration = {
          ClusterJDBCURL: rsConfig['ClusterJDBCURL'] as string,
          RoleARN: (rsConfig['RoleArn'] || rsConfig['RoleARN']) as string,
          CopyCommand: rsConfig['CopyCommand'] as RedshiftDestinationConfiguration['CopyCommand'],
          Username: rsConfig['Username'] as string | undefined,
          Password: rsConfig['Password'] as string | undefined,
          S3Configuration: rsConfig['S3Configuration']
            ? this.mapS3DestinationConfiguration(
                rsConfig['S3Configuration'] as Record<string, unknown>
              )
            : (undefined as unknown as S3DestinationConfiguration),
          CloudWatchLoggingOptions: rsConfig['CloudWatchLoggingOptions'] as
            | RedshiftDestinationConfiguration['CloudWatchLoggingOptions']
            | undefined,
          ProcessingConfiguration: rsConfig['ProcessingConfiguration'] as
            | RedshiftDestinationConfiguration['ProcessingConfiguration']
            | undefined,
          RetryOptions: rsConfig['RetryOptions'] as
            | RedshiftDestinationConfiguration['RetryOptions']
            | undefined,
          S3BackupMode: rsConfig['S3BackupMode'] as string | undefined,
          S3BackupConfiguration: rsConfig['S3BackupConfiguration']
            ? this.mapS3DestinationConfiguration(
                rsConfig['S3BackupConfiguration'] as Record<string, unknown>
              )
            : undefined,
          SecretsManagerConfiguration: rsConfig['SecretsManagerConfiguration'] as
            | RedshiftDestinationConfiguration['SecretsManagerConfiguration']
            | undefined,
        } as RedshiftDestinationConfiguration;
      }

      // Map ElasticsearchDestinationConfiguration
      if (properties['ElasticsearchDestinationConfiguration']) {
        const esConfig = properties['ElasticsearchDestinationConfiguration'] as Record<
          string,
          unknown
        >;
        input.ElasticsearchDestinationConfiguration = {
          DomainARN: (esConfig['DomainArn'] || esConfig['DomainARN']) as string | undefined,
          ClusterEndpoint: esConfig['ClusterEndpoint'] as string | undefined,
          IndexName: esConfig['IndexName'] as string,
          TypeName: esConfig['TypeName'] as string | undefined,
          IndexRotationPeriod: esConfig['IndexRotationPeriod'] as string | undefined,
          RoleARN: (esConfig['RoleArn'] || esConfig['RoleARN']) as string,
          BufferingHints: esConfig['BufferingHints'] as
            | ElasticsearchDestinationConfiguration['BufferingHints']
            | undefined,
          RetryOptions: esConfig['RetryOptions'] as
            | ElasticsearchDestinationConfiguration['RetryOptions']
            | undefined,
          S3BackupMode: esConfig['S3BackupMode'] as string | undefined,
          S3Configuration: esConfig['S3Configuration']
            ? this.mapS3DestinationConfiguration(
                esConfig['S3Configuration'] as Record<string, unknown>
              )
            : (undefined as unknown as S3DestinationConfiguration),
          CloudWatchLoggingOptions: esConfig['CloudWatchLoggingOptions'] as
            | ElasticsearchDestinationConfiguration['CloudWatchLoggingOptions']
            | undefined,
          ProcessingConfiguration: esConfig['ProcessingConfiguration'] as
            | ElasticsearchDestinationConfiguration['ProcessingConfiguration']
            | undefined,
          VpcConfiguration: esConfig['VpcConfiguration'] as
            | ElasticsearchDestinationConfiguration['VpcConfiguration']
            | undefined,
          DocumentIdOptions: esConfig['DocumentIdOptions'] as
            | ElasticsearchDestinationConfiguration['DocumentIdOptions']
            | undefined,
        } as ElasticsearchDestinationConfiguration;
      }

      // Map AmazonopensearchserviceDestinationConfiguration
      if (properties['AmazonopensearchserviceDestinationConfiguration']) {
        const aosConfig = properties['AmazonopensearchserviceDestinationConfiguration'] as Record<
          string,
          unknown
        >;
        input.AmazonopensearchserviceDestinationConfiguration = {
          DomainARN: (aosConfig['DomainArn'] || aosConfig['DomainARN']) as string | undefined,
          ClusterEndpoint: aosConfig['ClusterEndpoint'] as string | undefined,
          IndexName: aosConfig['IndexName'] as string,
          TypeName: aosConfig['TypeName'] as string | undefined,
          IndexRotationPeriod: aosConfig['IndexRotationPeriod'] as string | undefined,
          RoleARN: (aosConfig['RoleArn'] || aosConfig['RoleARN']) as string,
          BufferingHints: aosConfig['BufferingHints'] as
            | AmazonopensearchserviceDestinationConfiguration['BufferingHints']
            | undefined,
          RetryOptions: aosConfig['RetryOptions'] as
            | AmazonopensearchserviceDestinationConfiguration['RetryOptions']
            | undefined,
          S3BackupMode: aosConfig['S3BackupMode'] as string | undefined,
          S3Configuration: aosConfig['S3Configuration']
            ? this.mapS3DestinationConfiguration(
                aosConfig['S3Configuration'] as Record<string, unknown>
              )
            : (undefined as unknown as S3DestinationConfiguration),
          CloudWatchLoggingOptions: aosConfig['CloudWatchLoggingOptions'] as
            | AmazonopensearchserviceDestinationConfiguration['CloudWatchLoggingOptions']
            | undefined,
          ProcessingConfiguration: aosConfig['ProcessingConfiguration'] as
            | AmazonopensearchserviceDestinationConfiguration['ProcessingConfiguration']
            | undefined,
          VpcConfiguration: aosConfig['VpcConfiguration'] as
            | AmazonopensearchserviceDestinationConfiguration['VpcConfiguration']
            | undefined,
          DocumentIdOptions: aosConfig['DocumentIdOptions'] as
            | AmazonopensearchserviceDestinationConfiguration['DocumentIdOptions']
            | undefined,
        } as AmazonopensearchserviceDestinationConfiguration;
      }

      // Map SplunkDestinationConfiguration
      if (properties['SplunkDestinationConfiguration']) {
        const splunkConfig = properties['SplunkDestinationConfiguration'] as Record<
          string,
          unknown
        >;
        input.SplunkDestinationConfiguration = {
          HECEndpoint: splunkConfig['HECEndpoint'] as string,
          HECEndpointType: splunkConfig['HECEndpointType'] as string,
          HECToken: splunkConfig['HECToken'] as string,
          HECAcknowledgmentTimeoutInSeconds: splunkConfig['HECAcknowledgmentTimeoutInSeconds'] as
            | number
            | undefined,
          S3BackupMode: splunkConfig['S3BackupMode'] as string | undefined,
          S3Configuration: splunkConfig['S3Configuration']
            ? this.mapS3DestinationConfiguration(
                splunkConfig['S3Configuration'] as Record<string, unknown>
              )
            : (undefined as unknown as S3DestinationConfiguration),
          RetryOptions: splunkConfig['RetryOptions'] as
            | SplunkDestinationConfiguration['RetryOptions']
            | undefined,
          CloudWatchLoggingOptions: splunkConfig['CloudWatchLoggingOptions'] as
            | SplunkDestinationConfiguration['CloudWatchLoggingOptions']
            | undefined,
          ProcessingConfiguration: splunkConfig['ProcessingConfiguration'] as
            | SplunkDestinationConfiguration['ProcessingConfiguration']
            | undefined,
          BufferingHints: splunkConfig['BufferingHints'] as
            | SplunkDestinationConfiguration['BufferingHints']
            | undefined,
          SecretsManagerConfiguration: splunkConfig['SecretsManagerConfiguration'] as
            | SplunkDestinationConfiguration['SecretsManagerConfiguration']
            | undefined,
        } as SplunkDestinationConfiguration;
      }

      // Map AmazonOpenSearchServerlessDestinationConfiguration
      if (properties['AmazonOpenSearchServerlessDestinationConfiguration']) {
        const aossConfig = properties[
          'AmazonOpenSearchServerlessDestinationConfiguration'
        ] as Record<string, unknown>;
        input.AmazonOpenSearchServerlessDestinationConfiguration = {
          CollectionEndpoint: aossConfig['CollectionEndpoint'] as string,
          IndexName: aossConfig['IndexName'] as string,
          RoleARN: (aossConfig['RoleArn'] || aossConfig['RoleARN']) as string,
          BufferingHints: aossConfig['BufferingHints'] as
            | AmazonOpenSearchServerlessDestinationConfiguration['BufferingHints']
            | undefined,
          RetryOptions: aossConfig['RetryOptions'] as
            | AmazonOpenSearchServerlessDestinationConfiguration['RetryOptions']
            | undefined,
          S3BackupMode: aossConfig['S3BackupMode'] as string | undefined,
          S3Configuration: aossConfig['S3Configuration']
            ? this.mapS3DestinationConfiguration(
                aossConfig['S3Configuration'] as Record<string, unknown>
              )
            : (undefined as unknown as S3DestinationConfiguration),
          CloudWatchLoggingOptions: aossConfig['CloudWatchLoggingOptions'] as
            | AmazonOpenSearchServerlessDestinationConfiguration['CloudWatchLoggingOptions']
            | undefined,
          ProcessingConfiguration: aossConfig['ProcessingConfiguration'] as
            | AmazonOpenSearchServerlessDestinationConfiguration['ProcessingConfiguration']
            | undefined,
          VpcConfiguration: aossConfig['VpcConfiguration'] as
            | AmazonOpenSearchServerlessDestinationConfiguration['VpcConfiguration']
            | undefined,
        } as AmazonOpenSearchServerlessDestinationConfiguration;
      }

      // Map DeliveryStreamEncryptionConfigurationInput
      if (properties['DeliveryStreamEncryptionConfigurationInput']) {
        const encConfig = properties['DeliveryStreamEncryptionConfigurationInput'] as Record<
          string,
          unknown
        >;
        input.DeliveryStreamEncryptionConfigurationInput = {
          KeyARN: (encConfig['KeyArn'] || encConfig['KeyARN']) as string | undefined,
          KeyType: encConfig['KeyType'] as
            | DeliveryStreamEncryptionConfigurationInput['KeyType']
            | undefined,
        } as DeliveryStreamEncryptionConfigurationInput;
      }

      // Map Tags
      const tags = properties['Tags'] as Array<{ Key: string; Value: string }> | undefined;
      if (tags && tags.length > 0) {
        input.Tags = tags.map((t) => ({ Key: t.Key, Value: t.Value })) as Tag[];
      }

      const response = await this.getCreateClient().send(new CreateDeliveryStreamCommand(input));

      const physicalId =
        deliveryStreamName ||
        input.DeliveryStreamName ||
        response.DeliveryStreamARN?.split('/').pop() ||
        '';
      createdStreamName = physicalId;
      const arn = response.DeliveryStreamARN;

      this.logger.debug(
        `Successfully created Firehose delivery stream ${logicalId}: ${physicalId}`
      );

      // Wait for delivery stream to become ACTIVE before returning.
      // SubscriptionFilter and other dependents fail if the stream is still CREATING.
      await this.waitForActive(
        physicalId,
        logicalId,
        resourceType,
        maskerOrIdentity(context?.maskSecrets)
      );

      return {
        physicalId,
        attributes: {
          Arn: arn,
        },
      };
    } catch (error) {
      const thrown =
        error instanceof ProvisioningError
          ? error
          : this.wrapCaughtError(
              maskerOrIdentity(context?.maskSecrets),
              error,
              (text) =>
                new ProvisioningError(
                  `Failed to create Firehose delivery stream ${logicalId}: ${text}`,
                  resourceType,
                  logicalId,
                  undefined,
                  error instanceof Error ? error : undefined
                )
            );
      // go-to-k/cdkd#4583: the stream exists and no state record will hold it;
      // never before CreateDeliveryStream returned (another owner's name).
      if (createdStreamName !== undefined) {
        markCreatedBeforeFailure(thrown, logicalId, resourceType, createdStreamName);
      }
      throw thrown;
    }
  }

  /**
   * Apply in-place updates to a Firehose delivery stream via the per-shape
   * AWS APIs (#477):
   *
   *   - **Tags** (`TagDeliveryStream` / `UntagDeliveryStream`) — always
   *     supported; runs first since it is destination-independent.
   *   - **`ExtendedS3DestinationConfiguration`** (`UpdateDestination` with
   *     an `ExtendedS3DestinationUpdate` payload) — recovers
   *     `CurrentDeliveryStreamVersionId` + `DestinationId` from a
   *     `DescribeDeliveryStream` call, then applies the diff. Only fires
   *     when the destination shape actually differs.
   *
   *   - `RedshiftDestinationConfiguration` (#549) — same flow as
   *     ExtendedS3: `DescribeDeliveryStream` recovers VersionId +
   *     DestinationId, then `UpdateDestinationCommand` issues the
   *     diff with a `RedshiftDestinationUpdate` payload produced by
   *     {@link mapRedshiftConfigToUpdate}. Handles `CopyCommand`,
   *     `RetryOptions`, `S3Configuration` → `S3Update`,
   *     `S3BackupConfiguration` → `S3BackupUpdate`,
   *     `ProcessingConfiguration`, `S3BackupMode`,
   *     `CloudWatchLoggingOptions`, `Username` / `Password` /
   *     `RoleARN` / `ClusterJDBCURL`.
   *
   *   - `SplunkDestinationConfiguration` (#549) — same flow as
   *     Redshift: `DescribeDeliveryStream` recovers VersionId +
   *     DestinationId, then `UpdateDestinationCommand` issues the
   *     diff with a `SplunkDestinationUpdate` payload produced by
   *     {@link mapSplunkConfigToUpdate}. Handles `HECEndpoint`,
   *     `HECEndpointType`, `HECToken`,
   *     `HECAcknowledgmentTimeoutInSeconds`, `RetryOptions`,
   *     `S3BackupMode`, `S3Configuration` → `S3Update`,
   *     `ProcessingConfiguration`, `CloudWatchLoggingOptions`,
   *     `BufferingHints`, `SecretsManagerConfiguration`. Splunk has
   *     no S3 backup destination shape (no `S3BackupConfiguration`
   *     field) — unlike Redshift / ExtendedS3.
   *
   *   - `AmazonopensearchserviceDestinationConfiguration` (#549) —
   *     `AmazonopensearchserviceDestinationUpdate` payload produced
   *     by {@link mapAmazonopensearchserviceConfigToUpdate}. Handles
   *     `RoleARN`, `DomainARN`, `ClusterEndpoint`, `IndexName`,
   *     `TypeName`, `IndexRotationPeriod`, `BufferingHints`,
   *     `RetryOptions`, `S3Configuration` → `S3Update`,
   *     `ProcessingConfiguration`, `CloudWatchLoggingOptions`,
   *     `DocumentIdOptions`. `VpcConfiguration` has no Update member;
   *     it is create-only in the CloudFormation schema, so the diff
   *     plans a replacement for a change there.
   *
   *   - `AmazonOpenSearchServerlessDestinationConfiguration` (#549) —
   *     `AmazonOpenSearchServerlessDestinationUpdate` payload
   *     produced by {@link mapAmazonOpenSearchServerlessConfigToUpdate}.
   *     Simpler than the service variant — `RoleARN`,
   *     `CollectionEndpoint`, `IndexName`, `BufferingHints`,
   *     `RetryOptions`, `S3Configuration` → `S3Update`,
   *     `ProcessingConfiguration`, `CloudWatchLoggingOptions`.
   *
   *   - `S3BackupMode` on the three OpenSearch / Elasticsearch
   *     destinations has no Update member: a change is not sent, as
   *     CloudFormation does, and is warned (#5386,
   *     {@link warnUnappliedS3BackupMode}).
   *
   *   - `HttpEndpointDestinationConfiguration` (#549) —
   *     `HttpEndpointDestinationUpdate` payload produced by
   *     {@link mapHttpEndpointConfigToUpdate}. Handles
   *     `EndpointConfiguration`, `BufferingHints`,
   *     `CloudWatchLoggingOptions`, `RequestConfiguration`,
   *     `ProcessingConfiguration`, `RoleARN`, `RetryOptions`,
   *     `S3BackupMode`, `S3Configuration` → `S3Update`,
   *     `SecretsManagerConfiguration`.
   *
   *   - `ElasticsearchDestinationConfiguration` (#549) —
   *     `ElasticsearchDestinationUpdate` payload produced by
   *     {@link mapElasticsearchConfigToUpdate}. Legacy variant of
   *     `Amazonopensearchservice*`; same field shape sans
   *     `VpcConfiguration` (also create-only, so replaced).
   *
   *   - `IcebergDestinationConfiguration` (#549) —
   *     `IcebergDestinationUpdate` payload produced by
   *     {@link mapIcebergConfigToUpdate}. Handles
   *     `DestinationTableConfigurationList`,
   *     `SchemaEvolutionConfiguration`,
   *     `TableCreationConfiguration`, `BufferingHints`,
   *     `CloudWatchLoggingOptions`, `ProcessingConfiguration`,
   *     `S3BackupMode`, `RetryOptions`, `RoleARN`, `AppendOnly`,
   *     `CatalogConfiguration`, `S3Configuration`. **Quirk**: the
   *     SDK Update shape's S3 field is named `S3Configuration` (full
   *     `S3DestinationConfiguration` shape), NOT `S3Update` — unlike
   *     every other destination type. The reverse-mapper forwards it
   *     verbatim without renaming.
   *
   *   - `SnowflakeDestinationConfiguration` (#549) —
   *     `SnowflakeDestinationUpdate` payload produced by
   *     {@link mapSnowflakeConfigToUpdate}. Handles many connector
   *     credentials (`AccountUrl` / `PrivateKey` / `KeyPassphrase` /
   *     `User` / `Database` / `Schema` / `Table` /
   *     `SnowflakeRoleConfiguration`) plus the standard suite
   *     (`DataLoadingOption`, `MetaDataColumnName`,
   *     `ContentColumnName`, `CloudWatchLoggingOptions`,
   *     `ProcessingConfiguration`, `RoleARN`, `RetryOptions`,
   *     `S3BackupMode`, `S3Configuration` → `S3Update`,
   *     `SecretsManagerConfiguration`, `BufferingHints`).
   *
   *   - **`DeliveryStreamEncryptionConfigurationInput`** (#5357) —
   *     `StartDeliveryStreamEncryption` / `StopDeliveryStreamEncryption`,
   *     waiting for the asynchronous transition; see
   *     {@link applyEncryptionUpdate}. Runs after the destination update.
   *
   *   - The legacy `S3DestinationConfiguration` (#5439) —
   *     `S3DestinationUpdate` payload produced by
   *     {@link mapS3ConfigToUpdate}; see {@link applyS3DestinationUpdate}.
   *
   * Destination-type SWITCHES (e.g. ExtendedS3 → Redshift) are immutable
   * on AWS; cdkd surfaces `ResourceUpdateNotSupportedError` so the caller
   * can `cdkd deploy --replace`.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    // go-to-k/cdkd#2613: the physical id is the delivery stream NAME, so a client in another region
    // than the state record would retag and update a same-named stream cdkd does not manage.
    // Outside the try, ahead of `applyUpdate`'s first call. Refuse before any call; the client's
    // region is resolved only when there is one to compare with.
    assertRegionMatch(
      context?.expectedRegion ? await this.getClient().config.region() : undefined,
      context?.expectedRegion,
      resourceType,
      logicalId,
      physicalId,
      'pre-update'
    );
    try {
      return await this.applyUpdate(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context
      );
    } catch (error) {
      // Pass through every cdkd-typed error untouched: the destination-switch
      // guard below raises ResourceUpdateNotSupportedError, which the deploy
      // engine matches BY CLASS to fall back to replacement, and an inner
      // ProvisioningError already carries better context than a re-wrap.
      if (error instanceof CdkdError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        maskerOrIdentity(context?.maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update Firehose delivery stream ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  private async applyUpdate(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context: UpdateContext | undefined
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Firehose delivery stream ${logicalId}: ${physicalId}`);

    // Like the destination checks below, refused before any mutating call.
    const desiredEncryption = readEncryptionInput(
      properties[ENCRYPTION_KEY],
      context?.desiredFromAwsReadback === true
    );
    // go-to-k/cdkd#5380: an earlier update's Start / Stop that did not finish
    // left the key unsettled, so the stream may hold either block although the
    // template and the record agree. `applyEncryptionUpdate` reads the stream
    // and sends only what it lacks. An unusable block is not forced: it was
    // never sent, and refusing it now would fail a deploy that sent nothing.
    const encryptionChanged =
      !sameEncryptionInput(
        properties[ENCRYPTION_KEY],
        desiredEncryption,
        previousProperties[ENCRYPTION_KEY]
      ) ||
      (context?.unsettledProperties?.has(ENCRYPTION_KEY) === true &&
        desiredEncryption.kind !== 'unusable');
    let encryptionSkipped = false;
    if (encryptionChanged && desiredEncryption.kind === 'unusable') {
      const message =
        `${ENCRYPTION_KEY} of Firehose delivery stream ${logicalId} is not an object with a ` +
        `string KeyType (and a string KeyARN, if any)`;
      // A state record has no template-side remedy: leave the stream's
      // encryption as it is and record the previous block (issue #3141).
      if (context?.replayingState !== true) {
        throw markNonRetryable(
          new ProvisioningError(
            `${message} — nothing was updated`,
            resourceType,
            logicalId,
            physicalId
          )
        );
      }
      this.logger.warn(safeMsg`${message}; its encryption is left unchanged`);
      encryptionSkipped = true;
    }

    // Validate destination shape BEFORE issuing any mutating call so a
    // Tags+rejected-destination combined diff does not write Tags then
    // throw — otherwise AWS would carry new tags while cdkd state was
    // never updated (m1 in PR review).
    const destKey = this.findDestinationKey(properties);
    const prevDestKey = this.findDestinationKey(previousProperties);

    // Destination-type switch is immutable on AWS (UpdateDestination only
    // accepts the SAME destination type; switching types requires replace).
    if (destKey && prevDestKey && destKey !== prevDestKey) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        `Switching Firehose destination type from '${prevDestKey}' to '${destKey}' is not supported in-place — AWS UpdateDestination requires the same destination type as the original CreateDeliveryStream. Re-deploy with cdkd deploy --replace.`
      );
    }

    // Every destination key findDestinationKey returns has an in-place
    // UpdateDestination branch below.
    const activeDest = destKey ?? prevDestKey;

    // Now that destination validity is established, apply Tags
    // (TagDeliveryStream / UntagDeliveryStream is independent of
    // destination type but must not run BEFORE the rejection branches —
    // otherwise a partial AWS write strands tags on a stream whose
    // destination diff was rejected).
    const nextTagsOk = isReadableTagList(properties['Tags']);
    const prevTagsOk = isReadableTagList(previousProperties['Tags']);
    if (!nextTagsOk || !prevTagsOk) {
      // Names the side only, never record content. A recorded value holding a
      // dynamic reference or its mask must not be answered with "write the
      // value into state.json"; `[]` removes nothing and re-applies the tags.
      const recordedSecret = !prevTagsOk && holdsSecretDerivedEntry(previousProperties['Tags']);
      throw markNonRetryable(
        new ProvisioningError(
          `${[!nextTagsOk && 'desired Tags', !prevTagsOk && 'recorded Tags'].filter(Boolean).join(' / ')} ` +
            `of Firehose delivery stream ${logicalId} is not a list of tags with a Key — no tag ` +
            `was added or removed` +
            (prevTagsOk
              ? ''
              : recordedSecret
                ? ': the recorded Tags is secret-derived (cdkd keeps the dynamic reference or its ' +
                  'mask in state), so do not write the value into state.json; set it to [] in ' +
                  'state.json and re-run, which removes nothing'
                : ': repair the recorded Tags in state.json to a list of tags with a Key and re-run'),
          resourceType,
          logicalId,
          physicalId
        )
      );
    }
    await this.applyTagsDiff(physicalId, properties['Tags'], previousProperties['Tags']);

    if (activeDest === 'ExtendedS3DestinationConfiguration') {
      const nextDest = (properties[activeDest] ?? {}) as Record<string, unknown>;
      const prevDest = (previousProperties[activeDest] ?? {}) as Record<string, unknown>;
      if (JSON.stringify(nextDest) !== JSON.stringify(prevDest)) {
        await this.applyExtendedS3DestinationUpdate(logicalId, physicalId, nextDest);
      }
    }

    if (activeDest === 'S3DestinationConfiguration') {
      const nextDest = (properties[activeDest] ?? {}) as Record<string, unknown>;
      const prevDest = (previousProperties[activeDest] ?? {}) as Record<string, unknown>;
      if (JSON.stringify(nextDest) !== JSON.stringify(prevDest)) {
        await this.applyS3DestinationUpdate(logicalId, physicalId, nextDest);
      }
    }

    if (activeDest === 'RedshiftDestinationConfiguration') {
      const nextDest = (properties[activeDest] ?? {}) as Record<string, unknown>;
      const prevDest = (previousProperties[activeDest] ?? {}) as Record<string, unknown>;
      if (JSON.stringify(nextDest) !== JSON.stringify(prevDest)) {
        await this.applyRedshiftDestinationUpdate(logicalId, physicalId, nextDest);
      }
    }

    if (activeDest === 'SplunkDestinationConfiguration') {
      const nextDest = (properties[activeDest] ?? {}) as Record<string, unknown>;
      const prevDest = (previousProperties[activeDest] ?? {}) as Record<string, unknown>;
      if (JSON.stringify(nextDest) !== JSON.stringify(prevDest)) {
        await this.applySplunkDestinationUpdate(logicalId, physicalId, nextDest);
      }
    }

    if (activeDest === 'AmazonopensearchserviceDestinationConfiguration') {
      const nextDest = (properties[activeDest] ?? {}) as Record<string, unknown>;
      const prevDest = (previousProperties[activeDest] ?? {}) as Record<string, unknown>;
      if (JSON.stringify(nextDest) !== JSON.stringify(prevDest)) {
        await this.applyAmazonopensearchserviceDestinationUpdate(logicalId, physicalId, nextDest);
      }
    }

    if (activeDest === 'AmazonOpenSearchServerlessDestinationConfiguration') {
      const nextDest = (properties[activeDest] ?? {}) as Record<string, unknown>;
      const prevDest = (previousProperties[activeDest] ?? {}) as Record<string, unknown>;
      if (JSON.stringify(nextDest) !== JSON.stringify(prevDest)) {
        await this.applyAmazonOpenSearchServerlessDestinationUpdate(
          logicalId,
          physicalId,
          nextDest
        );
      }
    }

    if (activeDest === 'HttpEndpointDestinationConfiguration') {
      const nextDest = (properties[activeDest] ?? {}) as Record<string, unknown>;
      const prevDest = (previousProperties[activeDest] ?? {}) as Record<string, unknown>;
      if (JSON.stringify(nextDest) !== JSON.stringify(prevDest)) {
        await this.applyHttpEndpointDestinationUpdate(logicalId, physicalId, nextDest);
      }
    }

    if (activeDest === 'ElasticsearchDestinationConfiguration') {
      const nextDest = (properties[activeDest] ?? {}) as Record<string, unknown>;
      const prevDest = (previousProperties[activeDest] ?? {}) as Record<string, unknown>;
      if (JSON.stringify(nextDest) !== JSON.stringify(prevDest)) {
        await this.applyElasticsearchDestinationUpdate(logicalId, physicalId, nextDest);
      }
    }

    if (activeDest === 'IcebergDestinationConfiguration') {
      const nextDest = (properties[activeDest] ?? {}) as Record<string, unknown>;
      const prevDest = (previousProperties[activeDest] ?? {}) as Record<string, unknown>;
      if (JSON.stringify(nextDest) !== JSON.stringify(prevDest)) {
        await this.applyIcebergDestinationUpdate(logicalId, physicalId, nextDest);
      }
    }

    if (activeDest === 'SnowflakeDestinationConfiguration') {
      const nextDest = (properties[activeDest] ?? {}) as Record<string, unknown>;
      const prevDest = (previousProperties[activeDest] ?? {}) as Record<string, unknown>;
      if (JSON.stringify(nextDest) !== JSON.stringify(prevDest)) {
        await this.applySnowflakeDestinationUpdate(logicalId, physicalId, nextDest);
      }
    }

    if (encryptionChanged && desiredEncryption.kind !== 'unusable') {
      await this.applyEncryptionUpdate(
        logicalId,
        physicalId,
        resourceType,
        desiredEncryption,
        maskerOrIdentity(context?.maskSecrets),
        context?.markUnsettled
      );
    }

    // Pull current AWS state for the result envelope.
    const description = await this.getClient().send(
      new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
    );
    // go-to-k/cdkd#5386: named after the last call that could fail, so a
    // failed update (and its retry) never prints it, and confirmed against
    // this same read rather than a second one.
    this.warnUnappliedS3BackupMode(
      logicalId,
      properties,
      unappliedS3BackupModeDestination(
        properties,
        previousProperties,
        destKey,
        context?.changedProperties
      ),
      description.DeliveryStreamDescription
    );
    const desc = description.DeliveryStreamDescription;
    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        ...(desc?.DeliveryStreamARN !== undefined && { Arn: desc.DeliveryStreamARN }),
      },
      ...(encryptionSkipped && {
        effectiveProperties: this.withRecordedEncryption(
          properties,
          previousProperties[ENCRYPTION_KEY],
          desc?.DeliveryStreamEncryptionConfiguration
        ),
      }),
    };
  }

  /**
   * Warn that the `S3BackupMode` change {@link unappliedS3BackupModeDestination}
   * found was not applied (go-to-k/cdkd#5386), unless the live stream already
   * holds the declared mode. The state records the declared value, never
   * applied, so a template-to-state difference alone also fires on a rollback
   * revert, on a template reverted to what AWS holds, and on a mode declared at
   * the value AWS already has. `live` is the update's own closing
   * `DescribeDeliveryStream` answer. When it does not report the destination's
   * mode, the warning is kept: it cannot be confirmed either way, and the
   * update itself has succeeded.
   */
  private warnUnappliedS3BackupMode(
    logicalId: string,
    properties: Record<string, unknown>,
    destKey: string | undefined,
    live: DeliveryStreamDescription | undefined
  ): void {
    if (destKey === undefined) return;
    const declared = (properties[destKey] as Record<string, unknown>)['S3BackupMode'];
    const desired = declared ?? DEFAULT_OPENSEARCH_BACKUP_MODE;
    const member = FIXED_BACKUP_MODE_DESTINATIONS[destKey];
    const liveMode: unknown =
      member === undefined ? undefined : live?.Destinations?.[0]?.[member]?.S3BackupMode;
    if (liveMode !== undefined && liveMode === desired) return;
    if (liveMode === undefined) {
      this.logger.debug(
        safeMsg`Firehose delivery stream ${logicalId} reported no S3BackupMode for ${destKey}; warning unconfirmed`
      );
    }
    const kept =
      typeof liveMode === 'string' ? `its current mode (${liveMode})` : 'its current mode';
    this.logger.warn(
      safeMsg`${logicalId} (AWS::KinesisFirehose::DeliveryStream): ${destKey}.S3BackupMode changed, but Firehose cannot change the backup mode of an existing delivery stream, so the stream keeps ${kept}, as CloudFormation does. To apply it, replace the stream, for example by giving it a new DeliveryStreamName or a new logical id.`
    );
  }

  /**
   * The desired bag with the encryption block an update SKIPPED replaced by
   * what the stream holds: an absent previous drops the key, and a present one
   * records the live reading, in the shape `readCurrentState` emits. The
   * recorded previous is never trusted as-is: on a rollback it can be a block a
   * failed update never applied.
   */
  private withRecordedEncryption(
    properties: Record<string, unknown>,
    previous: unknown,
    live: DeliveryStreamEncryptionConfiguration | undefined
  ): Record<string, unknown> {
    const { [ENCRYPTION_KEY]: _skipped, ...rest } = properties;
    if (previous === undefined || previous === null) return rest;
    return { ...rest, [ENCRYPTION_KEY]: liveEncryptionAsCfn(live) };
  }

  /**
   * Recover `CurrentDeliveryStreamVersionId` + `DestinationId` from
   * `DescribeDeliveryStream` and issue `UpdateDestination` with the new
   * ExtendedS3 shape. The reverse-mapper at
   * {@link mapExtendedS3ConfigToUpdate} produces the
   * `ExtendedS3DestinationUpdate` payload (CFn property names →
   * SDK camelCase, omitting `Prefix` / `BufferingHints` / etc. when the
   * source is undefined), which keeps a removed sub-field live as
   * CloudFormation does (#1160).
   */
  private async applyExtendedS3DestinationUpdate(
    logicalId: string,
    physicalId: string,
    nextConfig: Record<string, unknown>
  ): Promise<void> {
    const description = await this.getClient().send(
      new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
    );
    const desc = description.DeliveryStreamDescription;
    const currentVersionId = desc?.VersionId;
    const currentDestination = desc?.Destinations?.[0];
    const destinationId = currentDestination?.DestinationId;
    if (!currentVersionId || !destinationId) {
      throw new ProvisioningError(
        `DescribeDeliveryStream for ${physicalId} did not return VersionId or DestinationId; UpdateDestination cannot proceed.`,
        'AWS::KinesisFirehose::DeliveryStream',
        logicalId,
        physicalId
      );
    }
    await this.getClient().send(
      new UpdateDestinationCommand({
        DeliveryStreamName: physicalId,
        CurrentDeliveryStreamVersionId: currentVersionId,
        DestinationId: destinationId,
        ExtendedS3DestinationUpdate: this.mapExtendedS3ConfigToUpdate(nextConfig),
      })
    );
  }

  /**
   * The legacy `S3DestinationConfiguration` (go-to-k/cdkd#5439):
   * `UpdateDestination` with an `S3DestinationUpdate` payload from
   * {@link mapS3ConfigToUpdate}, as CloudFormation does. Measured in
   * us-east-1: a change set changing `BufferingHints` / `Prefix` /
   * `CompressionFormat` planned `Replacement: False` and kept the stream ARN,
   * and one removing `Prefix` and `BufferingHints` beside a sibling change
   * kept both live values, so a removed sub-field is not sent (#1160).
   */
  private async applyS3DestinationUpdate(
    logicalId: string,
    physicalId: string,
    nextConfig: Record<string, unknown>
  ): Promise<void> {
    const description = await this.getClient().send(
      new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
    );
    const desc = description.DeliveryStreamDescription;
    const currentVersionId = desc?.VersionId;
    const destinationId = desc?.Destinations?.[0]?.DestinationId;
    if (!currentVersionId || !destinationId) {
      throw new ProvisioningError(
        `DescribeDeliveryStream for ${physicalId} did not return VersionId or DestinationId; UpdateDestination cannot proceed.`,
        'AWS::KinesisFirehose::DeliveryStream',
        logicalId,
        physicalId
      );
    }
    await this.getClient().send(
      new UpdateDestinationCommand({
        DeliveryStreamName: physicalId,
        CurrentDeliveryStreamVersionId: currentVersionId,
        DestinationId: destinationId,
        S3DestinationUpdate: this.mapS3ConfigToUpdate(nextConfig),
      })
    );
  }

  /**
   * Diff and apply changes to a Firehose delivery stream's Tags via the
   * `TagDeliveryStream` / `UntagDeliveryStream` AWS APIs.
   *
   * Tags shape is `[{Key, Value}]`. Removed keys go through
   * `UntagDeliveryStream` (key-only); added / modified entries go through
   * `TagDeliveryStream` (full {Key, Value}). No-op when before/after JSON
   * is identical.
   */
  private async applyTagsDiff(physicalId: string, next: unknown, prev: unknown): Promise<void> {
    if (JSON.stringify(next ?? []) === JSON.stringify(prev ?? [])) return;
    type CfnTag = { Key?: string; Value?: string };
    // Both sides were validated by the caller: absent reads as the empty list.
    const nextEntries = (next ?? []) as CfnTag[];
    const prevEntries = (prev ?? []) as CfnTag[];
    const nextByKey = new Map<string, CfnTag>();
    for (const t of nextEntries) {
      if (t.Key) nextByKey.set(t.Key, t);
    }
    const prevByKey = new Map<string, CfnTag>();
    for (const t of prevEntries) {
      if (t.Key) prevByKey.set(t.Key, t);
    }
    const tagKeysToRemove: string[] = [];
    for (const key of prevByKey.keys()) {
      if (!nextByKey.has(key)) tagKeysToRemove.push(key);
    }
    if (tagKeysToRemove.length > 0) {
      await this.getClient().send(
        new UntagDeliveryStreamCommand({
          DeliveryStreamName: physicalId,
          TagKeys: tagKeysToRemove,
        })
      );
    }
    const tagsToUpsert: CfnTag[] = [];
    for (const [key, tag] of nextByKey) {
      const before = prevByKey.get(key);
      if (JSON.stringify(before) === JSON.stringify(tag)) continue;
      tagsToUpsert.push(tag);
    }
    if (tagsToUpsert.length > 0) {
      await this.getClient().send(
        new TagDeliveryStreamCommand({
          DeliveryStreamName: physicalId,
          Tags: tagsToUpsert.map((t) => ({
            Key: t.Key as string,
            ...(t.Value !== undefined && { Value: t.Value }),
          })),
        })
      );
    }
  }

  /**
   * Apply a changed `DeliveryStreamEncryptionConfigurationInput` (issue
   * #5357): `StartDeliveryStreamEncryption` for a new or changed block,
   * `StopDeliveryStreamEncryption` for a removed one, as CloudFormation does
   * (both measured on a CFn stack, a removal alone and beside a Tags change).
   *
   * Both calls only START an asynchronous transition (ENABLING / DISABLING,
   * measured at 80-95 s), so the update waits for its end state. An earlier
   * transition is waited out first, and the call is skipped when the stream
   * already holds the requested state, since AWS answers
   * `InvalidArgumentException` to a Start with the customer-managed key already
   * in use and to a Stop on a stream that is not encrypted. That includes
   * `ENABLING_FAILED` after a rejected Start: measured, it reports no KeyType
   * and a Stop there is refused as "already disabled".
   */
  private async applyEncryptionUpdate(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    desired: { kind: 'absent' } | { kind: 'usable'; keyType: string; keyArn?: string },
    mask: MaskerFn,
    markUnsettled: ((propertyName: string) => void) | undefined
  ): Promise<void> {
    const settled = await this.waitForEncryption(logicalId, physicalId, resourceType, mask, {
      what: 'settle',
      done: (enc) => enc?.Status !== 'ENABLING' && enc?.Status !== 'DISABLING',
    });
    if (desired.kind === 'absent') {
      if (settled?.Status !== 'ENABLED' && settled?.Status !== 'DISABLING_FAILED') return;
      this.refuseToStartTransition(logicalId, physicalId, resourceType, 'disable');
      // go-to-k/cdkd#5380: after the refusal, before the call: from here a
      // failure leaves the stream in a state the record may not describe.
      markUnsettled?.(ENCRYPTION_KEY);
      await this.getClient().send(
        new StopDeliveryStreamEncryptionCommand({ DeliveryStreamName: physicalId })
      );
      await this.warnIfUnfinished(logicalId, 'StopDeliveryStreamEncryption', markUnsettled, () =>
        this.waitForEncryption(logicalId, physicalId, resourceType, mask, {
          what: 'disable',
          done: (enc) => enc === undefined || enc.Status === 'DISABLED',
          inProgress: 'DISABLING',
          failed: 'DISABLING_FAILED',
          staleFailure: settled.Status === 'DISABLING_FAILED',
        })
      );
      return;
    }
    if (encryptionMatches(settled, desired)) return;
    this.refuseToStartTransition(logicalId, physicalId, resourceType, 'enable');
    markUnsettled?.(ENCRYPTION_KEY);
    await this.getClient().send(
      new StartDeliveryStreamEncryptionCommand({
        DeliveryStreamName: physicalId,
        DeliveryStreamEncryptionConfigurationInput: {
          KeyType: desired.keyType as DeliveryStreamEncryptionConfigurationInput['KeyType'],
          ...(desired.keyArn !== undefined && { KeyARN: desired.keyArn }),
        },
      })
    );
    await this.warnIfUnfinished(logicalId, 'StartDeliveryStreamEncryption', markUnsettled, () =>
      this.waitForEncryption(logicalId, physicalId, resourceType, mask, {
        what: 'enable',
        done: (enc) => encryptionMatches(enc, desired),
        inProgress: 'ENABLING',
        failed: 'ENABLING_FAILED',
        staleFailure: settled?.Status === 'ENABLING_FAILED',
      })
    );
  }

  /**
   * Run the wait that follows an accepted Start / Stop, and when it fails
   * (a `*_FAILED` report, a timeout, the resource deadline, Ctrl-C) warn before
   * rethrowing. A throwing `update()` leaves the PREVIOUS block in state, while
   * the stream can still finish the transition, or after a `*_FAILED` hold
   * neither setting. On a deploy the call was preceded by `markUnsettled`
   * (go-to-k/cdkd#5380), so the record names the key unsettled and the next
   * deploy reads the stream and converges it, whichever template it applies.
   * Elsewhere (a rollback revert, `drift --revert`) nothing marks it, so the
   * warning points at `cdkd drift`.
   */
  private async warnIfUnfinished<T>(
    logicalId: string,
    call: 'StartDeliveryStreamEncryption' | 'StopDeliveryStreamEncryption',
    markUnsettled: ((propertyName: string) => void) | undefined,
    wait: () => Promise<T>
  ): Promise<T> {
    try {
      return await wait();
    } catch (error) {
      const outcome =
        typeof error === 'object' && error !== null && terminalEncryptionFailures.has(error)
          ? 'AWS reported the change failed, so the stream may no longer match'
          : 'the stream may still finish the change, so it may no longer match';
      this.logger.warn(
        safeMsg`Firehose delivery stream ${logicalId}: ${call} was sent but the encryption change did not finish; ${outcome} the previous setting cdkd keeps recorded. `.concat(
          markUnsettled === undefined
            ? "Run 'cdkd drift' to compare, then 'cdkd drift --revert' to apply the recorded setting or 'cdkd drift --accept' to record the stream's."
            : `cdkd records ${ENCRYPTION_KEY} as unsettled, so the next 'cdkd deploy' reads the stream and applies the template's setting. To keep the stream as it ends up instead, run 'cdkd drift --accept' once the stream no longer reads ENABLING or DISABLING (an accept during the transition keeps the key unsettled).`
        )
      );
      throw error;
    }
  }

  /**
   * Refuse to START an encryption transition once the engine's per-resource
   * deadline has run out, or after Ctrl-C. The deadline does not cancel this
   * update: the engine has already failed the resource and moved on, so a
   * Start / Stop sent now would change the stream with nobody waiting on it.
   * A signal that landed during the settle wait's last read is caught here:
   * that wait returns on a settled report before it re-checks, and the latch
   * is sticky, so a fresh watch reads it.
   */
  private refuseToStartTransition(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    what: 'enable' | 'disable'
  ): void {
    const watch = startInterruptWatch(`Firehose ${logicalId} encryption ${what}`);
    try {
      if (watch.isInterrupted()) throw watch.onInterrupted();
    } finally {
      watch.dispose();
    }
    // `remainingMs` reads the clock, so it can reach 0 before the timer that
    // sets `expired` has run.
    if (!enclosingDeadlineExpired() && enclosingDeadlineRemainingMs() > 0) return;
    throw markNonRetryable(
      new ProvisioningError(
        `The resource timeout expired before encryption could be ${what}d on Firehose ` +
          `delivery stream ${logicalId}; no encryption call was sent`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }

  /**
   * Poll `DescribeDeliveryStream` until `done` accepts the reported
   * encryption, and return it. A `failed` report is terminal and names AWS's
   * failure description, masked, and non-retryable: a retry would only issue
   * the same call against the same key. When the stream already reported
   * `failed` before the call (`staleFailure`), that report counts only after
   * the `inProgress` status has been seen, so an earlier failure is never
   * blamed on this call. Ctrl-C stops the wait with an `InterruptedWaitError`.
   * Either way the update is not recorded, so a redeploy of the same template
   * re-reads the stream and issues only what is still missing.
   */
  private async waitForEncryption(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    mask: MaskerFn,
    opts: {
      what: 'settle' | 'enable' | 'disable';
      done: (enc: DeliveryStreamEncryptionConfiguration | undefined) => boolean;
      inProgress?: 'ENABLING' | 'DISABLING';
      failed?: 'ENABLING_FAILED' | 'DISABLING_FAILED';
      staleFailure?: boolean;
    }
  ): Promise<DeliveryStreamEncryptionConfiguration | undefined> {
    const { what, done, inProgress, failed } = opts;
    const watch = startInterruptWatch(`Firehose ${logicalId} encryption ${what}`);
    try {
      let last: string | undefined;
      let sawInProgress = false;
      for (let attempt = 1; attempt <= ENCRYPTION_POLL_MAX_ATTEMPTS; attempt++) {
        if (watch.isInterrupted()) throw watch.onInterrupted();
        // The engine's deadline does not cancel this update, so a wait that
        // outlived it would keep polling with nobody waiting on it. Checked
        // before the read, so the wait ends as the deadline does.
        if (enclosingDeadlineRemainingMs() <= 0) {
          throw markNonRetryable(
            new ProvisioningError(
              `The resource timeout expired while waiting to ${what} encryption on Firehose ` +
                `delivery stream ${logicalId} (last status: ${last ?? 'none reported'})`,
              resourceType,
              logicalId,
              physicalId
            )
          );
        }
        const resp = await this.getClient().send(
          new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
        );
        const enc = resp.DeliveryStreamDescription?.DeliveryStreamEncryptionConfiguration;
        if (done(enc)) return enc;
        last = enc?.Status;
        if (last !== undefined && last === inProgress) sawInProgress = true;
        if (failed !== undefined && last === failed && (sawInProgress || !opts.staleFailure)) {
          const failure = enc?.FailureDescription;
          const terminal = markNonRetryable(
            new ProvisioningError(
              `Failed to ${what} encryption on Firehose delivery stream ${logicalId}: AWS reports ` +
                `${failed}` +
                (failure ? ` (${mask(`${failure.Type ?? ''}: ${failure.Details ?? ''}`)})` : ''),
              resourceType,
              logicalId,
              physicalId
            )
          );
          terminalEncryptionFailures.add(terminal);
          throw terminal;
        }
        if (watch.isInterrupted()) throw watch.onInterrupted();
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.max(0, Math.min(ENCRYPTION_POLL_INTERVAL_MS, enclosingDeadlineRemainingMs()))
          )
        );
      }
      throw markNonRetryable(
        new ProvisioningError(
          `Timed out waiting to ${what} encryption on Firehose delivery stream ${logicalId} ` +
            `(last status: ${last ?? 'none reported'})`,
          resourceType,
          logicalId,
          physicalId
        )
      );
    } finally {
      watch.dispose();
    }
  }

  /**
   * Return the key of the destination property present on a properties
   * record, or `undefined` if none is present. AWS allows exactly one
   * destination configuration per delivery stream, so the first match is
   * authoritative; the ordering walks the most-common types first.
   */
  private findDestinationKey(properties: Record<string, unknown>): string | undefined {
    const destinationKeys = [
      'ExtendedS3DestinationConfiguration',
      'S3DestinationConfiguration',
      'HttpEndpointDestinationConfiguration',
      'RedshiftDestinationConfiguration',
      'ElasticsearchDestinationConfiguration',
      'AmazonopensearchserviceDestinationConfiguration',
      'SplunkDestinationConfiguration',
      'AmazonOpenSearchServerlessDestinationConfiguration',
      // Every destination key supports in-place update via UpdateDestination
      // (#477, #549 follow-ups, #5439 for the legacy S3 shape).
      'IcebergDestinationConfiguration',
      'SnowflakeDestinationConfiguration',
    ];
    for (const key of destinationKeys) {
      if (properties[key] !== undefined) return key;
    }
    return undefined;
  }

  /**
   * Delete a Firehose delivery stream
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Firehose delivery stream ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new DeleteDeliveryStreamCommand({
          DeliveryStreamName: physicalId,
        })
      );
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(
          `Firehose delivery stream ${physicalId} does not exist, skipping deletion`
        );
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      const thrown = this.wrapCaughtError(
        maskerOrIdentity(context?.maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete Firehose delivery stream ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
      // The wrap names an AWS failure by its CLASS, and the delete classifiers
      // read `NotFoundException` in a message as "already deleted": only the
      // typed not-found above means this resource is gone (go-to-k/cdkd#2319).
      throw error instanceof Error && error.name.includes('NotFound')
        ? markNotGone(thrown)
        : thrown;
    }

    // Issue #3872: the delivery stream keeps its NAME while it is DELETING
    // (~100s measured), and a CreateDeliveryStream of that name is refused with
    // the same `already exists` text a live stream gets, so the delete is
    // complete only once the stream is gone. Outside the try: the wait's only
    // throw is the DELETING_FAILED error below, which must not be re-wrapped.
    await waitForGoneAfterDelete({
      what: `Firehose delivery stream ${physicalId}`,
      resourceType,
      describe: () => this.readDeliveryStreamStatusForDelete(physicalId),
      // DELETING_FAILED is terminal: Firehose could not finish the delete
      // (typically a customer-managed KMS key it can no longer use) and keeps
      // the stream until a forced delete. Returning would drop the state
      // record of a live stream, so this one exit throws and keeps it.
      failedStatus: (status) =>
        status === 'DELETING_FAILED'
          ? new ProvisioningError(
              `Firehose delivery stream ${logicalId} entered DELETING_FAILED after the delete ` +
                `was accepted, so AWS will not finish it on its own (commonly a customer-managed ` +
                `KMS key the stream can no longer use). Fix the key and re-run, or delete the ` +
                `stream outside cdkd with AllowForceDelete (cdkd never sends it); the state ` +
                `record is kept.`,
              resourceType,
              logicalId,
              physicalId
            )
          : undefined,
      logger: this.logger,
      pollIntervalMs: FIREHOSE_DELETE_POLL_INTERVAL_MS,
      maxWaitMs: FIREHOSE_DELETE_MAX_WAIT_MS,
    });
    this.logger.debug(`Successfully deleted Firehose delivery stream ${logicalId}`);
  }

  /** The delivery stream's status, or `undefined` once `DescribeDeliveryStream` reports it gone. */
  private async readDeliveryStreamStatusForDelete(streamName: string): Promise<string | undefined> {
    try {
      const response = await this.getClient().send(
        new DescribeDeliveryStreamCommand({ DeliveryStreamName: streamName })
      );
      return response.DeliveryStreamDescription?.DeliveryStreamStatus ?? 'UNKNOWN';
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return undefined;
      throw error;
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  /**
   * Map CFn S3DestinationConfiguration to SDK format
   *
   * CFn uses PascalCase (BucketArn, RoleArn) while SDK uses uppercase ARN
   * (BucketARN, RoleARN).
   */
  private mapS3DestinationConfiguration(
    config: Record<string, unknown>
  ): S3DestinationConfiguration {
    const result: S3DestinationConfiguration = {
      BucketARN: (config['BucketArn'] || config['BucketARN']) as string,
      RoleARN: (config['RoleArn'] || config['RoleARN']) as string,
    };

    if (config['Prefix'] !== undefined) {
      result.Prefix = config['Prefix'] as string;
    }

    if (config['ErrorOutputPrefix'] !== undefined) {
      result.ErrorOutputPrefix = config['ErrorOutputPrefix'] as string;
    }

    if (config['CompressionFormat'] !== undefined) {
      result.CompressionFormat = config[
        'CompressionFormat'
      ] as S3DestinationConfiguration['CompressionFormat'];
    }

    if (config['BufferingHints'] !== undefined) {
      const hints = config['BufferingHints'] as Record<string, unknown>;
      result.BufferingHints = {
        ...(hints['SizeInMBs'] !== undefined && { SizeInMBs: hints['SizeInMBs'] as number }),
        ...(hints['IntervalInSeconds'] !== undefined && {
          IntervalInSeconds: hints['IntervalInSeconds'] as number,
        }),
      };
    }

    if (config['EncryptionConfiguration'] !== undefined) {
      result.EncryptionConfiguration = config[
        'EncryptionConfiguration'
      ] as S3DestinationConfiguration['EncryptionConfiguration'];
    }

    if (config['CloudWatchLoggingOptions'] !== undefined) {
      result.CloudWatchLoggingOptions = config[
        'CloudWatchLoggingOptions'
      ] as S3DestinationConfiguration['CloudWatchLoggingOptions'];
    }

    return result;
  }

  /**
   * Map CFn ExtendedS3DestinationConfiguration to SDK format
   */
  private mapExtendedS3DestinationConfiguration(
    config: Record<string, unknown>
  ): ExtendedS3DestinationConfiguration {
    const result: ExtendedS3DestinationConfiguration = {
      BucketARN: (config['BucketArn'] || config['BucketARN']) as string,
      RoleARN: (config['RoleArn'] || config['RoleARN']) as string,
    };

    if (config['Prefix'] !== undefined) {
      result.Prefix = config['Prefix'] as string;
    }

    if (config['ErrorOutputPrefix'] !== undefined) {
      result.ErrorOutputPrefix = config['ErrorOutputPrefix'] as string;
    }

    if (config['CompressionFormat'] !== undefined) {
      result.CompressionFormat = config[
        'CompressionFormat'
      ] as ExtendedS3DestinationConfiguration['CompressionFormat'];
    }

    if (config['BufferingHints'] !== undefined) {
      const hints = config['BufferingHints'] as Record<string, unknown>;
      result.BufferingHints = {
        ...(hints['SizeInMBs'] !== undefined && { SizeInMBs: hints['SizeInMBs'] as number }),
        ...(hints['IntervalInSeconds'] !== undefined && {
          IntervalInSeconds: hints['IntervalInSeconds'] as number,
        }),
      };
    }

    if (config['EncryptionConfiguration'] !== undefined) {
      result.EncryptionConfiguration = config[
        'EncryptionConfiguration'
      ] as ExtendedS3DestinationConfiguration['EncryptionConfiguration'];
    }

    if (config['CloudWatchLoggingOptions'] !== undefined) {
      result.CloudWatchLoggingOptions = config[
        'CloudWatchLoggingOptions'
      ] as ExtendedS3DestinationConfiguration['CloudWatchLoggingOptions'];
    }

    if (config['ProcessingConfiguration'] !== undefined) {
      result.ProcessingConfiguration = config[
        'ProcessingConfiguration'
      ] as ExtendedS3DestinationConfiguration['ProcessingConfiguration'];
    }

    if (config['S3BackupMode'] !== undefined) {
      result.S3BackupMode = config[
        'S3BackupMode'
      ] as ExtendedS3DestinationConfiguration['S3BackupMode'];
    }

    if (config['S3BackupConfiguration'] !== undefined) {
      const backupConfig = config['S3BackupConfiguration'] as Record<string, unknown>;
      result.S3BackupConfiguration = this.mapS3DestinationConfiguration(backupConfig);
    }

    if (config['DataFormatConversionConfiguration'] !== undefined) {
      result.DataFormatConversionConfiguration = config[
        'DataFormatConversionConfiguration'
      ] as ExtendedS3DestinationConfiguration['DataFormatConversionConfiguration'];
    }

    // A dynamic-partitioning Prefix (`!{partitionKeyFromQuery:...}`) is refused
    // without `DynamicPartitioningConfiguration`, so dropping it fails the create.
    if (config['DynamicPartitioningConfiguration'] !== undefined) {
      result.DynamicPartitioningConfiguration = config[
        'DynamicPartitioningConfiguration'
      ] as ExtendedS3DestinationConfiguration['DynamicPartitioningConfiguration'];
    }

    if (config['FileExtension'] !== undefined) {
      result.FileExtension = config['FileExtension'] as string;
    }

    if (config['CustomTimeZone'] !== undefined) {
      result.CustomTimeZone = config['CustomTimeZone'] as string;
    }

    return result;
  }

  /**
   * Map CFn `ExtendedS3DestinationConfiguration` to the
   * `ExtendedS3DestinationUpdate` shape expected by AWS
   * `UpdateDestinationCommand` (#477). Shape is structurally identical
   * to `ExtendedS3DestinationConfiguration` but every field is optional
   * — only the fields present in `config` are forwarded so undefined
   * keys do not clobber AWS-side state.
   *
   * Omitting a sub-field REMOVED from the template is CloudFormation
   * parity, not a gap (#1160): `UpdateDestination` merges, and a live
   * CloudFormation A/B kept every removed sub-field (`Prefix`,
   * `ErrorOutputPrefix`, `BufferingHints`, `CompressionFormat`,
   * `FileExtension`, `CustomTimeZone`, `CloudWatchLoggingOptions`,
   * `ProcessingConfiguration`, and the nested S3 configuration's fields on
   * an HttpEndpoint destination) whether or not a sibling change forced the
   * update. Every destination's reverse-mapper below relies on this; do not
   * add a reset-on-removal here.
   *
   * `S3BackupConfiguration` is mapped through {@link mapS3ConfigToUpdate}
   * so its own optional fields likewise round-trip cleanly.
   */
  private mapExtendedS3ConfigToUpdate(
    config: Record<string, unknown>
  ): ExtendedS3DestinationUpdate {
    const result: ExtendedS3DestinationUpdate = {};
    const bucketArn = (config['BucketArn'] ?? config['BucketARN']) as string | undefined;
    if (bucketArn !== undefined) result.BucketARN = bucketArn;
    const roleArn = (config['RoleArn'] ?? config['RoleARN']) as string | undefined;
    if (roleArn !== undefined) result.RoleARN = roleArn;
    if (config['Prefix'] !== undefined) result.Prefix = config['Prefix'] as string;
    if (config['ErrorOutputPrefix'] !== undefined) {
      result.ErrorOutputPrefix = config['ErrorOutputPrefix'] as string;
    }
    if (config['CompressionFormat'] !== undefined) {
      result.CompressionFormat = config[
        'CompressionFormat'
      ] as ExtendedS3DestinationUpdate['CompressionFormat'];
    }
    if (config['BufferingHints'] !== undefined) {
      const hints = config['BufferingHints'] as Record<string, unknown>;
      result.BufferingHints = {
        ...(hints['SizeInMBs'] !== undefined && { SizeInMBs: hints['SizeInMBs'] as number }),
        ...(hints['IntervalInSeconds'] !== undefined && {
          IntervalInSeconds: hints['IntervalInSeconds'] as number,
        }),
      };
    }
    if (config['EncryptionConfiguration'] !== undefined) {
      result.EncryptionConfiguration = config[
        'EncryptionConfiguration'
      ] as ExtendedS3DestinationUpdate['EncryptionConfiguration'];
    }
    if (config['CloudWatchLoggingOptions'] !== undefined) {
      result.CloudWatchLoggingOptions = config[
        'CloudWatchLoggingOptions'
      ] as ExtendedS3DestinationUpdate['CloudWatchLoggingOptions'];
    }
    if (config['ProcessingConfiguration'] !== undefined) {
      result.ProcessingConfiguration = config[
        'ProcessingConfiguration'
      ] as ExtendedS3DestinationUpdate['ProcessingConfiguration'];
    }
    if (config['S3BackupMode'] !== undefined) {
      result.S3BackupMode = config['S3BackupMode'] as ExtendedS3DestinationUpdate['S3BackupMode'];
    }
    if (config['S3BackupConfiguration'] !== undefined) {
      // CFn property is `S3BackupConfiguration`; SDK's Update shape uses
      // `S3BackupUpdate`. The reverse-mapper consumes CFn-shaped input,
      // so only the CFn key needs to be handled.
      result.S3BackupUpdate = this.mapS3ConfigToUpdate(
        config['S3BackupConfiguration'] as Record<string, unknown>
      );
    }
    if (config['DataFormatConversionConfiguration'] !== undefined) {
      result.DataFormatConversionConfiguration = config[
        'DataFormatConversionConfiguration'
      ] as ExtendedS3DestinationUpdate['DataFormatConversionConfiguration'];
    }
    // On a stream with dynamic partitioning enabled, an `UpdateDestination`
    // that omits this block reads as "disable it" and is refused ("Enabling
    // or disabling Dynamic Partitioning is not supported"), so it is forwarded
    // on every update, like the rest of the desired shape.
    if (config['DynamicPartitioningConfiguration'] !== undefined) {
      result.DynamicPartitioningConfiguration = config[
        'DynamicPartitioningConfiguration'
      ] as ExtendedS3DestinationUpdate['DynamicPartitioningConfiguration'];
    }
    if (config['FileExtension'] !== undefined) {
      result.FileExtension = config['FileExtension'] as string;
    }
    if (config['CustomTimeZone'] !== undefined) {
      result.CustomTimeZone = config['CustomTimeZone'] as string;
    }
    return result;
  }

  /**
   * Recover `CurrentDeliveryStreamVersionId` + `DestinationId` from
   * `DescribeDeliveryStream` and issue `UpdateDestination` with the new
   * Redshift shape. The reverse-mapper at
   * {@link mapRedshiftConfigToUpdate} produces the
   * `RedshiftDestinationUpdate` payload — only fields present in the
   * input are forwarded so omitted CFn keys don't clobber AWS-side
   * state. Mirrors {@link applyExtendedS3DestinationUpdate} (#549).
   */
  private async applyRedshiftDestinationUpdate(
    logicalId: string,
    physicalId: string,
    nextConfig: Record<string, unknown>
  ): Promise<void> {
    const description = await this.getClient().send(
      new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
    );
    const desc = description.DeliveryStreamDescription;
    const currentVersionId = desc?.VersionId;
    const currentDestination = desc?.Destinations?.[0];
    const destinationId = currentDestination?.DestinationId;
    if (!currentVersionId || !destinationId) {
      throw new ProvisioningError(
        `DescribeDeliveryStream for ${physicalId} did not return VersionId or DestinationId; UpdateDestination cannot proceed.`,
        'AWS::KinesisFirehose::DeliveryStream',
        logicalId,
        physicalId
      );
    }
    await this.getClient().send(
      new UpdateDestinationCommand({
        DeliveryStreamName: physicalId,
        CurrentDeliveryStreamVersionId: currentVersionId,
        DestinationId: destinationId,
        RedshiftDestinationUpdate: this.mapRedshiftConfigToUpdate(nextConfig),
      })
    );
  }

  /**
   * Map CFn `RedshiftDestinationConfiguration` to the
   * `RedshiftDestinationUpdate` shape used by AWS
   * `UpdateDestinationCommand` (#549). Every field is `!== undefined`
   * gated so omitted CFn keys do not clobber AWS-side state. The CFn
   * `S3Configuration` field is mapped through
   * {@link mapS3ConfigToUpdate} into the SDK-side `S3Update` slot;
   * `S3BackupConfiguration` likewise into `S3BackupUpdate`.
   */
  private mapRedshiftConfigToUpdate(config: Record<string, unknown>): RedshiftDestinationUpdate {
    const result: RedshiftDestinationUpdate = {};
    const roleArn = (config['RoleArn'] ?? config['RoleARN']) as string | undefined;
    if (roleArn !== undefined) result.RoleARN = roleArn;
    const clusterJdbcUrl = (config['ClusterJDBCURL'] ?? config['ClusterJdbcUrl']) as
      | string
      | undefined;
    if (clusterJdbcUrl !== undefined) result.ClusterJDBCURL = clusterJdbcUrl;
    if (config['CopyCommand'] !== undefined) {
      result.CopyCommand = config['CopyCommand'] as RedshiftDestinationUpdate['CopyCommand'];
    }
    if (config['Username'] !== undefined) result.Username = config['Username'] as string;
    if (config['Password'] !== undefined) result.Password = config['Password'] as string;
    if (config['RetryOptions'] !== undefined) {
      result.RetryOptions = config['RetryOptions'] as RedshiftDestinationUpdate['RetryOptions'];
    }
    // CFn property is `S3Configuration`; SDK Update shape uses `S3Update`.
    if (config['S3Configuration'] !== undefined) {
      result.S3Update = this.mapS3ConfigToUpdate(
        config['S3Configuration'] as Record<string, unknown>
      );
    }
    if (config['ProcessingConfiguration'] !== undefined) {
      result.ProcessingConfiguration = config[
        'ProcessingConfiguration'
      ] as RedshiftDestinationUpdate['ProcessingConfiguration'];
    }
    if (config['S3BackupMode'] !== undefined) {
      result.S3BackupMode = config['S3BackupMode'] as RedshiftDestinationUpdate['S3BackupMode'];
    }
    // CFn property is `S3BackupConfiguration`; SDK Update shape uses
    // `S3BackupUpdate`. Mirrors the ExtendedS3 pattern.
    if (config['S3BackupConfiguration'] !== undefined) {
      result.S3BackupUpdate = this.mapS3ConfigToUpdate(
        config['S3BackupConfiguration'] as Record<string, unknown>
      );
    }
    if (config['CloudWatchLoggingOptions'] !== undefined) {
      result.CloudWatchLoggingOptions = config[
        'CloudWatchLoggingOptions'
      ] as RedshiftDestinationUpdate['CloudWatchLoggingOptions'];
    }
    if (config['SecretsManagerConfiguration'] !== undefined) {
      result.SecretsManagerConfiguration = config[
        'SecretsManagerConfiguration'
      ] as RedshiftDestinationUpdate['SecretsManagerConfiguration'];
    }
    return result;
  }

  /**
   * Recover `CurrentDeliveryStreamVersionId` + `DestinationId` from
   * `DescribeDeliveryStream` and issue `UpdateDestination` with the new
   * Splunk shape. The reverse-mapper at
   * {@link mapSplunkConfigToUpdate} produces the
   * `SplunkDestinationUpdate` payload — only fields present in the
   * input are forwarded so omitted CFn keys don't clobber AWS-side
   * state. Mirrors {@link applyRedshiftDestinationUpdate} (#549).
   */
  private async applySplunkDestinationUpdate(
    logicalId: string,
    physicalId: string,
    nextConfig: Record<string, unknown>
  ): Promise<void> {
    const description = await this.getClient().send(
      new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
    );
    const desc = description.DeliveryStreamDescription;
    const currentVersionId = desc?.VersionId;
    const currentDestination = desc?.Destinations?.[0];
    const destinationId = currentDestination?.DestinationId;
    if (!currentVersionId || !destinationId) {
      throw new ProvisioningError(
        `DescribeDeliveryStream for ${physicalId} did not return VersionId or DestinationId; UpdateDestination cannot proceed.`,
        'AWS::KinesisFirehose::DeliveryStream',
        logicalId,
        physicalId
      );
    }
    await this.getClient().send(
      new UpdateDestinationCommand({
        DeliveryStreamName: physicalId,
        CurrentDeliveryStreamVersionId: currentVersionId,
        DestinationId: destinationId,
        SplunkDestinationUpdate: this.mapSplunkConfigToUpdate(nextConfig),
      })
    );
  }

  /**
   * Map CFn `SplunkDestinationConfiguration` to the
   * `SplunkDestinationUpdate` shape used by AWS
   * `UpdateDestinationCommand` (#549). Every field is `!== undefined`
   * gated so omitted CFn keys do not clobber AWS-side state. The CFn
   * `S3Configuration` field is mapped through
   * {@link mapS3ConfigToUpdate} into the SDK-side `S3Update` slot.
   * Splunk has no `S3BackupConfiguration` field (unlike Redshift /
   * ExtendedS3).
   */
  private mapSplunkConfigToUpdate(config: Record<string, unknown>): SplunkDestinationUpdate {
    const result: SplunkDestinationUpdate = {};
    if (config['HECEndpoint'] !== undefined) {
      result.HECEndpoint = config['HECEndpoint'] as string;
    }
    if (config['HECEndpointType'] !== undefined) {
      result.HECEndpointType = config[
        'HECEndpointType'
      ] as SplunkDestinationUpdate['HECEndpointType'];
    }
    if (config['HECToken'] !== undefined) {
      result.HECToken = config['HECToken'] as string;
    }
    if (config['HECAcknowledgmentTimeoutInSeconds'] !== undefined) {
      result.HECAcknowledgmentTimeoutInSeconds = config[
        'HECAcknowledgmentTimeoutInSeconds'
      ] as number;
    }
    if (config['RetryOptions'] !== undefined) {
      result.RetryOptions = config['RetryOptions'] as SplunkDestinationUpdate['RetryOptions'];
    }
    if (config['S3BackupMode'] !== undefined) {
      result.S3BackupMode = config['S3BackupMode'] as SplunkDestinationUpdate['S3BackupMode'];
    }
    // CFn property is `S3Configuration`; SDK Update shape uses `S3Update`.
    if (config['S3Configuration'] !== undefined) {
      result.S3Update = this.mapS3ConfigToUpdate(
        config['S3Configuration'] as Record<string, unknown>
      );
    }
    if (config['ProcessingConfiguration'] !== undefined) {
      result.ProcessingConfiguration = config[
        'ProcessingConfiguration'
      ] as SplunkDestinationUpdate['ProcessingConfiguration'];
    }
    if (config['CloudWatchLoggingOptions'] !== undefined) {
      result.CloudWatchLoggingOptions = config[
        'CloudWatchLoggingOptions'
      ] as SplunkDestinationUpdate['CloudWatchLoggingOptions'];
    }
    if (config['BufferingHints'] !== undefined) {
      result.BufferingHints = config['BufferingHints'] as SplunkDestinationUpdate['BufferingHints'];
    }
    if (config['SecretsManagerConfiguration'] !== undefined) {
      result.SecretsManagerConfiguration = config[
        'SecretsManagerConfiguration'
      ] as SplunkDestinationUpdate['SecretsManagerConfiguration'];
    }
    return result;
  }

  /**
   * Apply UpdateDestination for `AmazonopensearchserviceDestinationConfiguration` (#549).
   * Mirrors {@link applyRedshiftDestinationUpdate}.
   */
  private async applyAmazonopensearchserviceDestinationUpdate(
    logicalId: string,
    physicalId: string,
    nextConfig: Record<string, unknown>
  ): Promise<void> {
    const description = await this.getClient().send(
      new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
    );
    const desc = description.DeliveryStreamDescription;
    const currentVersionId = desc?.VersionId;
    const destinationId = desc?.Destinations?.[0]?.DestinationId;
    if (!currentVersionId || !destinationId) {
      throw new ProvisioningError(
        `DescribeDeliveryStream for ${physicalId} did not return VersionId or DestinationId; UpdateDestination cannot proceed.`,
        'AWS::KinesisFirehose::DeliveryStream',
        logicalId,
        physicalId
      );
    }
    await this.getClient().send(
      new UpdateDestinationCommand({
        DeliveryStreamName: physicalId,
        CurrentDeliveryStreamVersionId: currentVersionId,
        DestinationId: destinationId,
        AmazonopensearchserviceDestinationUpdate:
          this.mapAmazonopensearchserviceConfigToUpdate(nextConfig),
      })
    );
  }

  /**
   * Map CFn `AmazonopensearchserviceDestinationConfiguration` to the
   * `AmazonopensearchserviceDestinationUpdate` shape (#549). Every field
   * `!== undefined` gated. CFn `S3Configuration` → SDK `S3Update`.
   * `VpcConfiguration` is intentionally NOT included — the SDK Update
   * shape has no field for it (AWS treats Vpc placement as immutable
   * post-create), and the CloudFormation schema lists it as create-only,
   * so a change there plans a replacement. `S3BackupMode` has no field
   * either and is not create-only: see {@link warnUnappliedS3BackupMode}.
   */
  private mapAmazonopensearchserviceConfigToUpdate(
    config: Record<string, unknown>
  ): AmazonopensearchserviceDestinationUpdate {
    const result: AmazonopensearchserviceDestinationUpdate = {};
    const roleArn = (config['RoleARN'] ?? config['RoleArn']) as string | undefined;
    if (roleArn !== undefined) result.RoleARN = roleArn;
    const domainArn = (config['DomainARN'] ?? config['DomainArn']) as string | undefined;
    if (domainArn !== undefined) result.DomainARN = domainArn;
    if (config['ClusterEndpoint'] !== undefined) {
      result.ClusterEndpoint = config['ClusterEndpoint'] as string;
    }
    if (config['IndexName'] !== undefined) result.IndexName = config['IndexName'] as string;
    if (config['TypeName'] !== undefined) result.TypeName = config['TypeName'] as string;
    if (config['IndexRotationPeriod'] !== undefined) {
      result.IndexRotationPeriod = config[
        'IndexRotationPeriod'
      ] as AmazonopensearchserviceDestinationUpdate['IndexRotationPeriod'];
    }
    if (config['BufferingHints'] !== undefined) {
      result.BufferingHints = config[
        'BufferingHints'
      ] as AmazonopensearchserviceDestinationUpdate['BufferingHints'];
    }
    if (config['RetryOptions'] !== undefined) {
      result.RetryOptions = config[
        'RetryOptions'
      ] as AmazonopensearchserviceDestinationUpdate['RetryOptions'];
    }
    if (config['S3Configuration'] !== undefined) {
      result.S3Update = this.mapS3ConfigToUpdate(
        config['S3Configuration'] as Record<string, unknown>
      );
    }
    if (config['ProcessingConfiguration'] !== undefined) {
      result.ProcessingConfiguration = config[
        'ProcessingConfiguration'
      ] as AmazonopensearchserviceDestinationUpdate['ProcessingConfiguration'];
    }
    if (config['CloudWatchLoggingOptions'] !== undefined) {
      result.CloudWatchLoggingOptions = config[
        'CloudWatchLoggingOptions'
      ] as AmazonopensearchserviceDestinationUpdate['CloudWatchLoggingOptions'];
    }
    if (config['DocumentIdOptions'] !== undefined) {
      result.DocumentIdOptions = config[
        'DocumentIdOptions'
      ] as AmazonopensearchserviceDestinationUpdate['DocumentIdOptions'];
    }
    return result;
  }

  /**
   * Apply UpdateDestination for `AmazonOpenSearchServerlessDestinationConfiguration` (#549).
   * Mirrors {@link applyRedshiftDestinationUpdate}.
   */
  private async applyAmazonOpenSearchServerlessDestinationUpdate(
    logicalId: string,
    physicalId: string,
    nextConfig: Record<string, unknown>
  ): Promise<void> {
    const description = await this.getClient().send(
      new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
    );
    const desc = description.DeliveryStreamDescription;
    const currentVersionId = desc?.VersionId;
    const destinationId = desc?.Destinations?.[0]?.DestinationId;
    if (!currentVersionId || !destinationId) {
      throw new ProvisioningError(
        `DescribeDeliveryStream for ${physicalId} did not return VersionId or DestinationId; UpdateDestination cannot proceed.`,
        'AWS::KinesisFirehose::DeliveryStream',
        logicalId,
        physicalId
      );
    }
    await this.getClient().send(
      new UpdateDestinationCommand({
        DeliveryStreamName: physicalId,
        CurrentDeliveryStreamVersionId: currentVersionId,
        DestinationId: destinationId,
        AmazonOpenSearchServerlessDestinationUpdate:
          this.mapAmazonOpenSearchServerlessConfigToUpdate(nextConfig),
      })
    );
  }

  /**
   * Map CFn `AmazonOpenSearchServerlessDestinationConfiguration` to the
   * `AmazonOpenSearchServerlessDestinationUpdate` shape (#549). Every
   * field `!== undefined` gated. CFn `S3Configuration` → SDK `S3Update`.
   * Simpler than the service variant — no VpcConfiguration / TypeName /
   * IndexRotationPeriod / DocumentIdOptions.
   */
  private mapAmazonOpenSearchServerlessConfigToUpdate(
    config: Record<string, unknown>
  ): AmazonOpenSearchServerlessDestinationUpdate {
    const result: AmazonOpenSearchServerlessDestinationUpdate = {};
    const roleArn = (config['RoleARN'] ?? config['RoleArn']) as string | undefined;
    if (roleArn !== undefined) result.RoleARN = roleArn;
    if (config['CollectionEndpoint'] !== undefined) {
      result.CollectionEndpoint = config['CollectionEndpoint'] as string;
    }
    if (config['IndexName'] !== undefined) result.IndexName = config['IndexName'] as string;
    if (config['BufferingHints'] !== undefined) {
      result.BufferingHints = config[
        'BufferingHints'
      ] as AmazonOpenSearchServerlessDestinationUpdate['BufferingHints'];
    }
    if (config['RetryOptions'] !== undefined) {
      result.RetryOptions = config[
        'RetryOptions'
      ] as AmazonOpenSearchServerlessDestinationUpdate['RetryOptions'];
    }
    if (config['S3Configuration'] !== undefined) {
      result.S3Update = this.mapS3ConfigToUpdate(
        config['S3Configuration'] as Record<string, unknown>
      );
    }
    if (config['ProcessingConfiguration'] !== undefined) {
      result.ProcessingConfiguration = config[
        'ProcessingConfiguration'
      ] as AmazonOpenSearchServerlessDestinationUpdate['ProcessingConfiguration'];
    }
    if (config['CloudWatchLoggingOptions'] !== undefined) {
      result.CloudWatchLoggingOptions = config[
        'CloudWatchLoggingOptions'
      ] as AmazonOpenSearchServerlessDestinationUpdate['CloudWatchLoggingOptions'];
    }
    return result;
  }

  /**
   * Apply UpdateDestination for `HttpEndpointDestinationConfiguration` (#549).
   * Mirrors {@link applyRedshiftDestinationUpdate}.
   */
  private async applyHttpEndpointDestinationUpdate(
    logicalId: string,
    physicalId: string,
    nextConfig: Record<string, unknown>
  ): Promise<void> {
    const description = await this.getClient().send(
      new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
    );
    const desc = description.DeliveryStreamDescription;
    const currentVersionId = desc?.VersionId;
    const destinationId = desc?.Destinations?.[0]?.DestinationId;
    if (!currentVersionId || !destinationId) {
      throw new ProvisioningError(
        `DescribeDeliveryStream for ${physicalId} did not return VersionId or DestinationId; UpdateDestination cannot proceed.`,
        'AWS::KinesisFirehose::DeliveryStream',
        logicalId,
        physicalId
      );
    }
    await this.getClient().send(
      new UpdateDestinationCommand({
        DeliveryStreamName: physicalId,
        CurrentDeliveryStreamVersionId: currentVersionId,
        DestinationId: destinationId,
        HttpEndpointDestinationUpdate: this.mapHttpEndpointConfigToUpdate(nextConfig),
      })
    );
  }

  /**
   * Map CFn `HttpEndpointDestinationConfiguration` to the
   * `HttpEndpointDestinationUpdate` shape (#549). Every field
   * `!== undefined` gated. CFn `S3Configuration` → SDK `S3Update`.
   * `EndpointConfiguration` (Url / Name / AccessKey) and
   * `SecretsManagerConfiguration` are both pass-through (AWS accepts
   * either auth mode on Update).
   */
  private mapHttpEndpointConfigToUpdate(
    config: Record<string, unknown>
  ): HttpEndpointDestinationUpdate {
    const result: HttpEndpointDestinationUpdate = {};
    if (config['EndpointConfiguration'] !== undefined) {
      result.EndpointConfiguration = config[
        'EndpointConfiguration'
      ] as HttpEndpointDestinationUpdate['EndpointConfiguration'];
    }
    if (config['BufferingHints'] !== undefined) {
      result.BufferingHints = config[
        'BufferingHints'
      ] as HttpEndpointDestinationUpdate['BufferingHints'];
    }
    if (config['CloudWatchLoggingOptions'] !== undefined) {
      result.CloudWatchLoggingOptions = config[
        'CloudWatchLoggingOptions'
      ] as HttpEndpointDestinationUpdate['CloudWatchLoggingOptions'];
    }
    if (config['RequestConfiguration'] !== undefined) {
      result.RequestConfiguration = config[
        'RequestConfiguration'
      ] as HttpEndpointDestinationUpdate['RequestConfiguration'];
    }
    if (config['ProcessingConfiguration'] !== undefined) {
      result.ProcessingConfiguration = config[
        'ProcessingConfiguration'
      ] as HttpEndpointDestinationUpdate['ProcessingConfiguration'];
    }
    const roleArn = (config['RoleARN'] ?? config['RoleArn']) as string | undefined;
    if (roleArn !== undefined) result.RoleARN = roleArn;
    if (config['RetryOptions'] !== undefined) {
      result.RetryOptions = config['RetryOptions'] as HttpEndpointDestinationUpdate['RetryOptions'];
    }
    if (config['S3BackupMode'] !== undefined) {
      result.S3BackupMode = config['S3BackupMode'] as HttpEndpointDestinationUpdate['S3BackupMode'];
    }
    if (config['S3Configuration'] !== undefined) {
      result.S3Update = this.mapS3ConfigToUpdate(
        config['S3Configuration'] as Record<string, unknown>
      );
    }
    if (config['SecretsManagerConfiguration'] !== undefined) {
      result.SecretsManagerConfiguration = config[
        'SecretsManagerConfiguration'
      ] as HttpEndpointDestinationUpdate['SecretsManagerConfiguration'];
    }
    return result;
  }

  /**
   * Apply UpdateDestination for `ElasticsearchDestinationConfiguration` (#549).
   * Mirrors {@link applyRedshiftDestinationUpdate}. Elasticsearch is the
   * legacy variant — AWS still accepts it for stacks that pre-date the
   * Amazonopensearchservice rename.
   */
  private async applyElasticsearchDestinationUpdate(
    logicalId: string,
    physicalId: string,
    nextConfig: Record<string, unknown>
  ): Promise<void> {
    const description = await this.getClient().send(
      new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
    );
    const desc = description.DeliveryStreamDescription;
    const currentVersionId = desc?.VersionId;
    const destinationId = desc?.Destinations?.[0]?.DestinationId;
    if (!currentVersionId || !destinationId) {
      throw new ProvisioningError(
        `DescribeDeliveryStream for ${physicalId} did not return VersionId or DestinationId; UpdateDestination cannot proceed.`,
        'AWS::KinesisFirehose::DeliveryStream',
        logicalId,
        physicalId
      );
    }
    await this.getClient().send(
      new UpdateDestinationCommand({
        DeliveryStreamName: physicalId,
        CurrentDeliveryStreamVersionId: currentVersionId,
        DestinationId: destinationId,
        ElasticsearchDestinationUpdate: this.mapElasticsearchConfigToUpdate(nextConfig),
      })
    );
  }

  /**
   * Map CFn `ElasticsearchDestinationConfiguration` to the
   * `ElasticsearchDestinationUpdate` shape (#549). Every field
   * `!== undefined` gated. CFn `S3Configuration` → SDK `S3Update`.
   * Field set mirrors {@link mapAmazonopensearchserviceConfigToUpdate}
   * — Elasticsearch is the legacy variant of the same destination.
   */
  private mapElasticsearchConfigToUpdate(
    config: Record<string, unknown>
  ): ElasticsearchDestinationUpdate {
    const result: ElasticsearchDestinationUpdate = {};
    const roleArn = (config['RoleARN'] ?? config['RoleArn']) as string | undefined;
    if (roleArn !== undefined) result.RoleARN = roleArn;
    const domainArn = (config['DomainARN'] ?? config['DomainArn']) as string | undefined;
    if (domainArn !== undefined) result.DomainARN = domainArn;
    if (config['ClusterEndpoint'] !== undefined) {
      result.ClusterEndpoint = config['ClusterEndpoint'] as string;
    }
    if (config['IndexName'] !== undefined) result.IndexName = config['IndexName'] as string;
    if (config['TypeName'] !== undefined) result.TypeName = config['TypeName'] as string;
    if (config['IndexRotationPeriod'] !== undefined) {
      result.IndexRotationPeriod = config[
        'IndexRotationPeriod'
      ] as ElasticsearchDestinationUpdate['IndexRotationPeriod'];
    }
    if (config['BufferingHints'] !== undefined) {
      result.BufferingHints = config[
        'BufferingHints'
      ] as ElasticsearchDestinationUpdate['BufferingHints'];
    }
    if (config['RetryOptions'] !== undefined) {
      result.RetryOptions = config[
        'RetryOptions'
      ] as ElasticsearchDestinationUpdate['RetryOptions'];
    }
    if (config['S3Configuration'] !== undefined) {
      result.S3Update = this.mapS3ConfigToUpdate(
        config['S3Configuration'] as Record<string, unknown>
      );
    }
    if (config['ProcessingConfiguration'] !== undefined) {
      result.ProcessingConfiguration = config[
        'ProcessingConfiguration'
      ] as ElasticsearchDestinationUpdate['ProcessingConfiguration'];
    }
    if (config['CloudWatchLoggingOptions'] !== undefined) {
      result.CloudWatchLoggingOptions = config[
        'CloudWatchLoggingOptions'
      ] as ElasticsearchDestinationUpdate['CloudWatchLoggingOptions'];
    }
    if (config['DocumentIdOptions'] !== undefined) {
      result.DocumentIdOptions = config[
        'DocumentIdOptions'
      ] as ElasticsearchDestinationUpdate['DocumentIdOptions'];
    }
    return result;
  }

  /**
   * Apply UpdateDestination for `IcebergDestinationConfiguration` (#549).
   * Mirrors {@link applyRedshiftDestinationUpdate}.
   */
  private async applyIcebergDestinationUpdate(
    logicalId: string,
    physicalId: string,
    nextConfig: Record<string, unknown>
  ): Promise<void> {
    const description = await this.getClient().send(
      new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
    );
    const desc = description.DeliveryStreamDescription;
    const currentVersionId = desc?.VersionId;
    const destinationId = desc?.Destinations?.[0]?.DestinationId;
    if (!currentVersionId || !destinationId) {
      throw new ProvisioningError(
        `DescribeDeliveryStream for ${physicalId} did not return VersionId or DestinationId; UpdateDestination cannot proceed.`,
        'AWS::KinesisFirehose::DeliveryStream',
        logicalId,
        physicalId
      );
    }
    await this.getClient().send(
      new UpdateDestinationCommand({
        DeliveryStreamName: physicalId,
        CurrentDeliveryStreamVersionId: currentVersionId,
        DestinationId: destinationId,
        IcebergDestinationUpdate: this.mapIcebergConfigToUpdate(nextConfig),
      })
    );
  }

  /**
   * Map CFn `IcebergDestinationConfiguration` to the
   * `IcebergDestinationUpdate` shape (#549). Every field
   * `!== undefined` gated. **Quirk vs every other destination**: the
   * SDK Update shape's S3 field is `S3Configuration` (a full
   * `S3DestinationConfiguration`), NOT `S3Update`. Iceberg is a newer
   * destination type and AWS chose to keep the field name aligned with
   * the create shape; this reverse-mapper forwards it verbatim.
   */
  private mapIcebergConfigToUpdate(config: Record<string, unknown>): IcebergDestinationUpdate {
    const result: IcebergDestinationUpdate = {};
    if (config['DestinationTableConfigurationList'] !== undefined) {
      result.DestinationTableConfigurationList = config[
        'DestinationTableConfigurationList'
      ] as IcebergDestinationUpdate['DestinationTableConfigurationList'];
    }
    if (config['SchemaEvolutionConfiguration'] !== undefined) {
      result.SchemaEvolutionConfiguration = config[
        'SchemaEvolutionConfiguration'
      ] as IcebergDestinationUpdate['SchemaEvolutionConfiguration'];
    }
    if (config['TableCreationConfiguration'] !== undefined) {
      result.TableCreationConfiguration = config[
        'TableCreationConfiguration'
      ] as IcebergDestinationUpdate['TableCreationConfiguration'];
    }
    if (config['BufferingHints'] !== undefined) {
      result.BufferingHints = config[
        'BufferingHints'
      ] as IcebergDestinationUpdate['BufferingHints'];
    }
    if (config['CloudWatchLoggingOptions'] !== undefined) {
      result.CloudWatchLoggingOptions = config[
        'CloudWatchLoggingOptions'
      ] as IcebergDestinationUpdate['CloudWatchLoggingOptions'];
    }
    if (config['ProcessingConfiguration'] !== undefined) {
      result.ProcessingConfiguration = config[
        'ProcessingConfiguration'
      ] as IcebergDestinationUpdate['ProcessingConfiguration'];
    }
    if (config['S3BackupMode'] !== undefined) {
      result.S3BackupMode = config['S3BackupMode'] as IcebergDestinationUpdate['S3BackupMode'];
    }
    if (config['RetryOptions'] !== undefined) {
      result.RetryOptions = config['RetryOptions'] as IcebergDestinationUpdate['RetryOptions'];
    }
    const roleArn = (config['RoleARN'] ?? config['RoleArn']) as string | undefined;
    if (roleArn !== undefined) result.RoleARN = roleArn;
    if (config['AppendOnly'] !== undefined) {
      result.AppendOnly = config['AppendOnly'] as boolean;
    }
    if (config['CatalogConfiguration'] !== undefined) {
      result.CatalogConfiguration = config[
        'CatalogConfiguration'
      ] as IcebergDestinationUpdate['CatalogConfiguration'];
    }
    // Iceberg's S3 field is named `S3Configuration` on the Update shape
    // (a full S3DestinationConfiguration), unlike the other destinations
    // which use the partial `S3Update` shape. Route through the shared
    // `mapS3DestinationConfiguration` helper so `BucketArn` / `RoleArn`
    // (the CDK-emitted lowercase aliases) get renamed to `BucketARN` /
    // `RoleARN` — verbatim forwarding would send the lowercase keys to
    // AWS, which rejects them on the Update API.
    if (config['S3Configuration'] !== undefined) {
      result.S3Configuration = this.mapS3DestinationConfiguration(
        config['S3Configuration'] as Record<string, unknown>
      );
    }
    return result;
  }

  /**
   * Apply UpdateDestination for `SnowflakeDestinationConfiguration` (#549).
   * Mirrors {@link applyRedshiftDestinationUpdate}.
   */
  private async applySnowflakeDestinationUpdate(
    logicalId: string,
    physicalId: string,
    nextConfig: Record<string, unknown>
  ): Promise<void> {
    const description = await this.getClient().send(
      new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
    );
    const desc = description.DeliveryStreamDescription;
    const currentVersionId = desc?.VersionId;
    const destinationId = desc?.Destinations?.[0]?.DestinationId;
    if (!currentVersionId || !destinationId) {
      throw new ProvisioningError(
        `DescribeDeliveryStream for ${physicalId} did not return VersionId or DestinationId; UpdateDestination cannot proceed.`,
        'AWS::KinesisFirehose::DeliveryStream',
        logicalId,
        physicalId
      );
    }
    await this.getClient().send(
      new UpdateDestinationCommand({
        DeliveryStreamName: physicalId,
        CurrentDeliveryStreamVersionId: currentVersionId,
        DestinationId: destinationId,
        SnowflakeDestinationUpdate: this.mapSnowflakeConfigToUpdate(nextConfig),
      })
    );
  }

  /**
   * Map CFn `SnowflakeDestinationConfiguration` to the
   * `SnowflakeDestinationUpdate` shape (#549). Every field
   * `!== undefined` gated. CFn `S3Configuration` → SDK `S3Update`.
   * Snowflake carries many connector-side credential / target-table
   * fields (`AccountUrl` / `PrivateKey` / `KeyPassphrase` / `User` /
   * `Database` / `Schema` / `Table`) all pass-through.
   */
  private mapSnowflakeConfigToUpdate(config: Record<string, unknown>): SnowflakeDestinationUpdate {
    const result: SnowflakeDestinationUpdate = {};
    if (config['AccountUrl'] !== undefined) result.AccountUrl = config['AccountUrl'] as string;
    if (config['PrivateKey'] !== undefined) result.PrivateKey = config['PrivateKey'] as string;
    if (config['KeyPassphrase'] !== undefined) {
      result.KeyPassphrase = config['KeyPassphrase'] as string;
    }
    if (config['User'] !== undefined) result.User = config['User'] as string;
    if (config['Database'] !== undefined) result.Database = config['Database'] as string;
    if (config['Schema'] !== undefined) result.Schema = config['Schema'] as string;
    if (config['Table'] !== undefined) result.Table = config['Table'] as string;
    if (config['SnowflakeRoleConfiguration'] !== undefined) {
      result.SnowflakeRoleConfiguration = config[
        'SnowflakeRoleConfiguration'
      ] as SnowflakeDestinationUpdate['SnowflakeRoleConfiguration'];
    }
    if (config['DataLoadingOption'] !== undefined) {
      result.DataLoadingOption = config[
        'DataLoadingOption'
      ] as SnowflakeDestinationUpdate['DataLoadingOption'];
    }
    if (config['MetaDataColumnName'] !== undefined) {
      result.MetaDataColumnName = config['MetaDataColumnName'] as string;
    }
    if (config['ContentColumnName'] !== undefined) {
      result.ContentColumnName = config['ContentColumnName'] as string;
    }
    if (config['CloudWatchLoggingOptions'] !== undefined) {
      result.CloudWatchLoggingOptions = config[
        'CloudWatchLoggingOptions'
      ] as SnowflakeDestinationUpdate['CloudWatchLoggingOptions'];
    }
    if (config['ProcessingConfiguration'] !== undefined) {
      result.ProcessingConfiguration = config[
        'ProcessingConfiguration'
      ] as SnowflakeDestinationUpdate['ProcessingConfiguration'];
    }
    const roleArn = (config['RoleARN'] ?? config['RoleArn']) as string | undefined;
    if (roleArn !== undefined) result.RoleARN = roleArn;
    if (config['RetryOptions'] !== undefined) {
      result.RetryOptions = config['RetryOptions'] as SnowflakeDestinationUpdate['RetryOptions'];
    }
    if (config['S3BackupMode'] !== undefined) {
      result.S3BackupMode = config['S3BackupMode'] as SnowflakeDestinationUpdate['S3BackupMode'];
    }
    if (config['S3Configuration'] !== undefined) {
      result.S3Update = this.mapS3ConfigToUpdate(
        config['S3Configuration'] as Record<string, unknown>
      );
    }
    if (config['SecretsManagerConfiguration'] !== undefined) {
      result.SecretsManagerConfiguration = config[
        'SecretsManagerConfiguration'
      ] as SnowflakeDestinationUpdate['SecretsManagerConfiguration'];
    }
    if (config['BufferingHints'] !== undefined) {
      result.BufferingHints = config[
        'BufferingHints'
      ] as SnowflakeDestinationUpdate['BufferingHints'];
    }
    return result;
  }

  /**
   * Map CFn `S3DestinationConfiguration` to the `S3DestinationUpdate`
   * shape used by AWS `UpdateDestinationCommand` (#477): the top-level
   * legacy destination ({@link applyS3DestinationUpdate}, #5439) and every
   * nested `S3Update` / `S3BackupUpdate` slot.
   * Every field optional — only present keys are forwarded.
   */
  private mapS3ConfigToUpdate(config: Record<string, unknown>): S3DestinationUpdate {
    const result: S3DestinationUpdate = {};
    const bucketArn = (config['BucketArn'] ?? config['BucketARN']) as string | undefined;
    if (bucketArn !== undefined) result.BucketARN = bucketArn;
    const roleArn = (config['RoleArn'] ?? config['RoleARN']) as string | undefined;
    if (roleArn !== undefined) result.RoleARN = roleArn;
    if (config['Prefix'] !== undefined) result.Prefix = config['Prefix'] as string;
    if (config['ErrorOutputPrefix'] !== undefined) {
      result.ErrorOutputPrefix = config['ErrorOutputPrefix'] as string;
    }
    if (config['CompressionFormat'] !== undefined) {
      result.CompressionFormat = config[
        'CompressionFormat'
      ] as S3DestinationUpdate['CompressionFormat'];
    }
    if (config['BufferingHints'] !== undefined) {
      const hints = config['BufferingHints'] as Record<string, unknown>;
      result.BufferingHints = {
        ...(hints['SizeInMBs'] !== undefined && { SizeInMBs: hints['SizeInMBs'] as number }),
        ...(hints['IntervalInSeconds'] !== undefined && {
          IntervalInSeconds: hints['IntervalInSeconds'] as number,
        }),
      };
    }
    if (config['EncryptionConfiguration'] !== undefined) {
      result.EncryptionConfiguration = config[
        'EncryptionConfiguration'
      ] as S3DestinationUpdate['EncryptionConfiguration'];
    }
    if (config['CloudWatchLoggingOptions'] !== undefined) {
      result.CloudWatchLoggingOptions = config[
        'CloudWatchLoggingOptions'
      ] as S3DestinationUpdate['CloudWatchLoggingOptions'];
    }
    return result;
  }

  /**
   * Adopt an existing Kinesis Firehose delivery stream into cdkd state.
   *
   * Lookup order:
   *  1. `--resource <id>=<name>` override or `Properties.DeliveryStreamName`
   *     → verify with `DescribeDeliveryStream`.
   *  2. Walk `ListDeliveryStreams` (paged via `ExclusiveStartDeliveryStreamName`)
   *     and match the `aws:cdk:path` tag via
   *     `ListTagsForDeliveryStream(DeliveryStreamName)`.
   *
   * Firehose tags use the standard `Tag[]` array shape (`Key`/`Value`).
   */
  /**
   * go-to-k/cdkd#5380: the encryption key is still in transition while the
   * stream reads ENABLING / DISABLING, which `liveEncryptionAsCfn` reports as
   * a settled value. A failed read answers it as still in transition too: the
   * caller keeps the name, which only costs a re-send on the next deploy.
   */
  async unsettledInTransition(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    names: ReadonlySet<string>
  ): Promise<ReadonlySet<string>> {
    if (!names.has(ENCRYPTION_KEY)) return new Set();
    try {
      const resp = await this.getClient().send(
        new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
      );
      const status = resp.DeliveryStreamDescription?.DeliveryStreamEncryptionConfiguration?.Status;
      return status === 'ENABLING' || status === 'DISABLING'
        ? new Set([ENCRYPTION_KEY])
        : new Set();
    } catch {
      return new Set([ENCRYPTION_KEY]);
    }
  }

  /**
   * Read the AWS-current Firehose delivery stream configuration in CFn-property shape.
   *
   * Surfaces top-level configuration that has a clean 1:1 mapping back to
   * cdkd state — `DeliveryStreamName`, `DeliveryStreamType`, and the
   * `KinesisStreamSourceConfiguration` parent fields when present (the
   * `DescribeDeliveryStream` response splits source under `Source.KinesisStreamSourceDescription`).
   *
   * **Destination configurations**: full coverage for S3 / ExtendedS3.
   * AWS returns destination config under `Destinations[0].*DestinationDescription`
   * (note: `Description`, not `Configuration`); the SDK reuses the same
   * type as the corresponding `*Configuration` input for the inner
   * sub-shapes, so reverse-mapping is a `pickDefinedDeep` pass-through.
   *
   * Surfaced top-level fields: `BucketARN`, `RoleARN`, `Prefix`,
   * `ErrorOutputPrefix`, `BufferingHints`, `CompressionFormat`, plus
   * `S3BackupMode` for Extended. Surfaced inner nested fields:
   * `EncryptionConfiguration`, `CloudWatchLoggingOptions` (both shapes);
   * additionally for Extended `ProcessingConfiguration`,
   * `DataFormatConversionConfiguration`, `DynamicPartitioningConfiguration`,
   * `S3BackupConfiguration` (reverse-mapped from the AWS-side
   * `S3BackupDescription`). Each inner subtree is always emitted (even
   * as `{}` placeholder) so the v3 `observedProperties` baseline catches
   * console-side ADDs to a previously-default sub-shape.
   *
   * Non-S3 destination types
   * (`Redshift`/`Elasticsearch`/`Amazonopensearchservice`/`Splunk`/`HttpEndpoint`/`AmazonOpenSearchServerless`)
   * are reverse-mapped via `mapRedshiftDescriptionToCfn` /
   * `mapHttpEndpointDescriptionToCfn` / `mapNonS3DestinationToCfn`. The
   * SDK reuses field names between Description and Configuration for
   * these destinations, so a `pickDefinedDeep` pass-through produces a
   * CFn-compatible shape. AWS-managed read-only `VpcId` is stripped
   * from `VpcConfigurationDescription`. Write-only fields AWS strips
   * from descriptions (`RedshiftDestinationConfiguration.Password`,
   * `HttpEndpointDestinationConfiguration.EndpointConfiguration.AccessKey`)
   * stay drift-unknown via `getDriftUnknownPaths` — no AWS API recovers them.
   *
   * `DeliveryStreamEncryptionConfigurationInput` is also surfaced. AWS
   * returns the read-side shape `DeliveryStreamEncryptionConfiguration`
   * (with extra `Status` / `FailureDescription` fields); we reverse-map
   * to the CFn input shape (`KeyARN` + `KeyType`) while the stream is
   * encrypted or becoming so, and otherwise emit a `{}` placeholder so the
   * v3 baseline catches console-side encryption enables on a
   * previously-default stream (`liveEncryptionAsCfn`).
   *
   * Tags are surfaced via a follow-up `ListTagsForDeliveryStream` call
   * with `aws:*` filtered out and always emitted as `[]` placeholder when
   * no user tags remain.
   *
   * Returns `RESOURCE_NOT_FOUND` when the stream is gone (`ResourceNotFoundException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let desc;
    try {
      const resp = await this.getClient().send(
        new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
      );
      desc = resp.DeliveryStreamDescription;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
      throw err;
    }
    if (!desc) return undefined;

    const result: Record<string, unknown> = {};
    if (desc.DeliveryStreamName !== undefined) {
      result['DeliveryStreamName'] = desc.DeliveryStreamName;
    }
    if (desc.DeliveryStreamType !== undefined) {
      result['DeliveryStreamType'] = desc.DeliveryStreamType;
    }

    // Source: only KinesisStreamSourceDescription has a clean CFn analogue.
    if (desc.Source?.KinesisStreamSourceDescription) {
      const src = desc.Source.KinesisStreamSourceDescription;
      const srcOut: Record<string, unknown> = {};
      if (src.KinesisStreamARN !== undefined) srcOut['KinesisStreamARN'] = src.KinesisStreamARN;
      if (src.RoleARN !== undefined) srcOut['RoleARN'] = src.RoleARN;
      if (Object.keys(srcOut).length > 0) {
        result['KinesisStreamSourceConfiguration'] = srcOut;
      }
    }

    // Destinations: Firehose holds at most one destination on a delivery
    // stream. CDK constructs typically emit ExtendedS3 (the modern shape)
    // even for plain S3 use cases; legacy `S3DestinationDescription` is
    // still surfaced separately for templates that pin the legacy shape.
    // The two shapes are mutually exclusive on AWS responses.
    const dest = desc.Destinations?.[0];
    if (dest?.ExtendedS3DestinationDescription) {
      result['ExtendedS3DestinationConfiguration'] = mapExtendedS3DescriptionToCfn(
        dest.ExtendedS3DestinationDescription as unknown as Record<string, unknown>
      );
    } else if (dest?.S3DestinationDescription) {
      result['S3DestinationConfiguration'] = mapS3DescriptionToCfn(
        dest.S3DestinationDescription as unknown as Record<string, unknown>
      );
    } else if (dest?.RedshiftDestinationDescription) {
      result['RedshiftDestinationConfiguration'] = mapRedshiftDescriptionToCfn(
        dest.RedshiftDestinationDescription as unknown as Record<string, unknown>
      );
    } else if (dest?.ElasticsearchDestinationDescription) {
      result['ElasticsearchDestinationConfiguration'] = mapNonS3DestinationToCfn(
        dest.ElasticsearchDestinationDescription as unknown as Record<string, unknown>
      );
    } else if (dest?.AmazonopensearchserviceDestinationDescription) {
      result['AmazonopensearchserviceDestinationConfiguration'] = mapNonS3DestinationToCfn(
        dest.AmazonopensearchserviceDestinationDescription as unknown as Record<string, unknown>
      );
    } else if (dest?.AmazonOpenSearchServerlessDestinationDescription) {
      result['AmazonOpenSearchServerlessDestinationConfiguration'] = mapNonS3DestinationToCfn(
        dest.AmazonOpenSearchServerlessDestinationDescription as unknown as Record<string, unknown>
      );
    } else if (dest?.SplunkDestinationDescription) {
      result['SplunkDestinationConfiguration'] = mapNonS3DestinationToCfn(
        dest.SplunkDestinationDescription as unknown as Record<string, unknown>
      );
    } else if (dest?.HttpEndpointDestinationDescription) {
      result['HttpEndpointDestinationConfiguration'] = mapHttpEndpointDescriptionToCfn(
        dest.HttpEndpointDestinationDescription as unknown as Record<string, unknown>
      );
    }

    // DeliveryStreamEncryptionConfigurationInput: AWS returns the read-side
    // shape `DeliveryStreamEncryptionConfiguration` with extra status /
    // failure fields. CFn input shape carries `KeyARN` + `KeyType` only.
    // Surface those when AWS reports them; emit `{}` placeholder always so
    // the v3 baseline catches a console-side enable on a previously-default
    // stream (PR #145 always-emit pattern).
    // Only while encryption is in effect or being enabled (issue #5357).
    result['DeliveryStreamEncryptionConfigurationInput'] = liveEncryptionAsCfn(
      desc.DeliveryStreamEncryptionConfiguration
    );

    // Tags via ListTagsForDeliveryStream.
    // Always emit `Tags` (even as `[]`) per docs/provider-rules.md#readcurrentstate-for-drift-detection
    //  "always emit user-controllable top-level keys": omitting the
    // key on the failure path means the comparator's state-keys-only
    // walk skips Tags forever, hiding console-side tag adds from drift.
    try {
      const tagsResp = await this.getClient().send(
        new ListTagsForDeliveryStreamCommand({ DeliveryStreamName: physicalId })
      );
      result['Tags'] = normalizeAwsTagsToCfn(tagsResp.Tags);
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
      this.logger.debug(
        `Firehose ListTagsForDeliveryStream(${physicalId}) failed: ${describeAwsFailure(err).detail}`
      );
      result['Tags'] = [];
    }

    return result;
  }

  /**
   * Drift-unknown paths for `AWS::KinesisFirehose::DeliveryStream`.
   *
   * The drift comparator skips these state property paths so they never
   * fire false-positive drift on every run. See the `readCurrentState`
   * docstring for the full rationale per category.
   *
   * Only write-only fields AWS strips from descriptions remain:
   * Redshift `Password`, HttpEndpoint `EndpointConfiguration.AccessKey`.
   * State that carries these would otherwise fire drift on every run —
   * declaring them as drift-unknown is the cleanest fix because there
   * is no AWS read API to recover their values.
   *
   * S3 / ExtendedS3 inner nested fields, non-S3 destination types
   * (Redshift / Elasticsearch / Amazonopensearchservice / Splunk /
   * HttpEndpoint / AmazonOpenSearchServerless), and
   * `DeliveryStreamEncryptionConfigurationInput` are all reverse-mapped
   * by `readCurrentState` and no longer drift-unknown.
   */
  getDriftUnknownPaths(): string[] {
    return [
      // Write-only fields AWS does not return on read — no API workaround.
      'RedshiftDestinationConfiguration.Password',
      'HttpEndpointDestinationConfiguration.EndpointConfiguration.AccessKey',
    ];
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'DeliveryStreamName');
    if (explicit) {
      try {
        await this.getClient().send(
          new DescribeDeliveryStreamCommand({ DeliveryStreamName: explicit })
        );
        return { physicalId: explicit, attributes: {} };
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so that
    // tag never exists on a real resource and the walk could not match (issue
    // #1134). Auto-mode import resolves ids from CloudFormation's
    // DescribeStackResources or the template's physical-name property; a
    // delivery stream reaching here needs an explicit `--resource` override.
    return null;
  }

  /**
   * Wait for a delivery stream to become ACTIVE (go-to-k/cdkd#5509).
   * CreateDeliveryStream returns while the stream is still CREATING, and a
   * stream left CREATING cannot be deleted or used by dependents
   * (`ResourceInUseException`), so a create that returned early would be
   * recorded as done while the next step fails. CloudFormation waits for
   * ACTIVE and fails the resource on CREATING_FAILED; so does this: a
   * `*_FAILED` report throws with AWS's failure description, masked, and the
   * wait ends with an error when the engine's per-resource deadline runs out,
   * on Ctrl-C, or at the poll cap. Each throw is non-retryable: the stream
   * exists, so a retried create would only collide with it. `create()` records
   * the stream through `markCreatedBeforeFailure`, so it is not orphaned.
   *
   * The wait aims to throw its deadline error while time is still left:
   * `withResourceDeadline` rejects with its own timeout error the moment it
   * fires and drops a later provider error, and the created-id mark rides
   * only on the provider's error, so a wait that ran into the deadline
   * would leave the stream recorded nowhere. It stops sleeping
   * {@link ACTIVE_DEADLINE_MARGIN_MS} before the deadline, and each read is
   * aborted at that same point, so a read held up by SDK retries or a slow
   * connection ends in the same error. The margin is what the throw has to
   * reach the wrapper; an event loop stalled for longer still loses the race
   * (the engine-level gap is go-to-k/cdkd#5511).
   */
  /**
   * One `DescribeDeliveryStream` read for {@link waitForActive}, aborted
   * {@link ACTIVE_DEADLINE_MARGIN_MS} before the enclosing resource deadline
   * (`'deadline'` then). Outside any deadline the read is unbounded.
   */
  private async describeBeforeDeadline(
    streamName: string
  ): Promise<DescribeDeliveryStreamCommandOutput | 'deadline'> {
    const command = new DescribeDeliveryStreamCommand({ DeliveryStreamName: streamName });
    const remaining = enclosingDeadlineRemainingMs();
    if (!Number.isFinite(remaining)) return this.getClient().send(command);
    const abort = new AbortController();
    const timer = setTimeout(
      () => abort.abort(),
      Math.max(0, remaining - ACTIVE_DEADLINE_MARGIN_MS)
    );
    try {
      return await this.getClient().send(command, { abortSignal: abort.signal });
    } catch (error) {
      if (abort.signal.aborted) return 'deadline';
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async waitForActive(
    streamName: string,
    logicalId: string,
    resourceType: string,
    mask: MaskerFn
  ): Promise<void> {
    const watch = startInterruptWatch(`Firehose ${logicalId} create`);
    try {
      let last: string | undefined;
      // The engine's deadline does not cancel this create, so the wait ends
      // itself before the deadline fires (see above).
      let deadlineNear = false;
      for (let attempt = 1; attempt <= ACTIVE_POLL_MAX_ATTEMPTS; attempt++) {
        if (watch.isInterrupted()) throw watch.onInterrupted();
        if (enclosingDeadlineRemainingMs() <= ACTIVE_DEADLINE_MARGIN_MS) {
          deadlineNear = true;
          break;
        }
        const resp = await this.describeBeforeDeadline(streamName);
        if (resp === 'deadline') {
          deadlineNear = true;
          break;
        }
        const description = resp.DeliveryStreamDescription;
        last = description?.DeliveryStreamStatus;
        if (last === 'ACTIVE') {
          this.logger.debug(`Firehose ${logicalId} is ACTIVE`);
          return;
        }
        if (last !== undefined && last.endsWith('_FAILED')) {
          const failure = description?.FailureDescription;
          throw markNonRetryable(
            new ProvisioningError(
              `Firehose delivery stream ${logicalId} did not become ACTIVE: AWS reports ${last}` +
                (failure ? ` (${mask(`${failure.Type ?? ''}: ${failure.Details ?? ''}`)})` : ''),
              resourceType,
              logicalId,
              streamName
            )
          );
        }
        this.logger.debug(
          `Firehose ${logicalId} status: ${last} (attempt ${attempt}/${ACTIVE_POLL_MAX_ATTEMPTS})`
        );
        if (watch.isInterrupted()) throw watch.onInterrupted();
        if (enclosingDeadlineRemainingMs() <= ACTIVE_POLL_INTERVAL_MS + ACTIVE_DEADLINE_MARGIN_MS) {
          deadlineNear = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, ACTIVE_POLL_INTERVAL_MS));
      }
      throw markNonRetryable(
        new ProvisioningError(
          (deadlineNear
            ? `The resource timeout would expire while waiting for Firehose delivery stream ${logicalId} to become ACTIVE `
            : `Timed out waiting for Firehose delivery stream ${logicalId} to become ACTIVE `) +
            `(last status: ${last ?? 'none reported'})`,
          resourceType,
          logicalId,
          streamName
        )
      );
    } finally {
      watch.dispose();
    }
  }
}

// ─── Description → CFn nested-shape helpers ──────────────────────────
//
// The AWS Firehose SDK returns destination configuration under
// `*DestinationDescription` types. For most of the inner sub-shapes
// (`EncryptionConfiguration`, `CloudWatchLoggingOptions`,
// `ProcessingConfiguration`, `DataFormatConversionConfiguration`,
// `DynamicPartitioningConfiguration`) the SDK reuses the same type as
// the corresponding `*Configuration` input — so reverse-mapping is a
// pass-through that strips `undefined` fields. Per docs/provider-rules.md#readcurrentstate-for-drift-detection
//  "always emit user-controllable top-level keys": even though
// these are nested rather than top-level, surfacing them on every
// readCurrentState call (as `{}` placeholder when AWS reports nothing)
// keeps the v3 observedProperties baseline consistent so console-side
// ADDs to a previously-undefined sub-shape surface as drift.

type Defined<T> = { [K in keyof T]-?: T[K] extends undefined ? never : Exclude<T[K], undefined> };

/**
 * Strip `undefined` fields (and empty resulting objects) from an AWS-SDK
 * Description object so it round-trips cleanly through cdkd's drift
 * comparator. Recursive — descends through nested objects but leaves
 * arrays as-is (positional compare on AWS-returned order is stable for
 * Firehose's response shapes).
 */
function pickDefinedDeep<T>(input: T | undefined): Partial<Defined<T>> | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'object') return input as unknown as Partial<Defined<T>>;
  if (Array.isArray(input)) {
    return input.map((v) => pickDefinedDeep(v)) as unknown as Partial<Defined<T>>;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (v === undefined) continue;
    const cleaned = pickDefinedDeep(v as unknown);
    if (cleaned === undefined) continue;
    if (
      cleaned !== null &&
      typeof cleaned === 'object' &&
      !Array.isArray(cleaned) &&
      Object.keys(cleaned as Record<string, unknown>).length === 0
    ) {
      // Drop empty nested objects to avoid `{}` clutter — except at the
      // top level, the caller decides whether to surface a placeholder.
      continue;
    }
    out[k] = cleaned;
  }
  return out as Partial<Defined<T>>;
}

/**
 * Map S3DestinationDescription → CFn S3DestinationConfiguration.
 * Surfaces the top-level subset that has a clean reverse-mapping plus
 * the inner nested complex fields (EncryptionConfiguration /
 * CloudWatchLoggingOptions) that the SDK reuses across both shapes.
 *
 * Typed as `Record<string, unknown>` to side-step the SDK's strict
 * required/optional discriminator on `RoleARN` / `BucketARN` that
 * `exactOptionalPropertyTypes` rejects when passing a sub-object whose
 * own RoleARN/BucketARN may be undefined (e.g. the deprecated
 * S3BackupDescription form). Behavior unchanged.
 */
function mapS3DescriptionToCfn(desc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (desc['BucketARN'] !== undefined) out['BucketARN'] = desc['BucketARN'];
  if (desc['RoleARN'] !== undefined) out['RoleARN'] = desc['RoleARN'];
  if (desc['Prefix'] !== undefined) out['Prefix'] = desc['Prefix'];
  if (desc['ErrorOutputPrefix'] !== undefined) {
    out['ErrorOutputPrefix'] = desc['ErrorOutputPrefix'];
  }
  if (desc['CompressionFormat'] !== undefined) {
    out['CompressionFormat'] = desc['CompressionFormat'];
  }
  if (desc['BufferingHints']) {
    const hints = pickDefinedDeep(desc['BufferingHints']);
    if (hints && typeof hints === 'object' && Object.keys(hints).length > 0) {
      out['BufferingHints'] = hints;
    }
  }
  // EncryptionConfiguration: surface always so a console-side enable on a
  // previously-default destination shows as drift on v3 baseline.
  out['EncryptionConfiguration'] = pickDefinedDeep(desc['EncryptionConfiguration']) ?? {};
  // CloudWatchLoggingOptions: same pattern.
  out['CloudWatchLoggingOptions'] = pickDefinedDeep(desc['CloudWatchLoggingOptions']) ?? {};
  return out;
}

/**
 * Map ExtendedS3DestinationDescription → CFn ExtendedS3DestinationConfiguration.
 * Adds the Extended-only inner fields (`ProcessingConfiguration`,
 * `DataFormatConversionConfiguration`, `DynamicPartitioningConfiguration`,
 * `S3BackupConfiguration`) on top of the S3 base set.
 *
 * `S3BackupDescription` (note: Description, not Configuration) is
 * delegated to `mapS3DescriptionToCfn` since AWS uses the deprecated
 * S3DestinationDescription shape for backup, but CFn input expects
 * S3DestinationConfiguration — same field names work.
 */
function mapExtendedS3DescriptionToCfn(desc: Record<string, unknown>): Record<string, unknown> {
  const out = mapS3DescriptionToCfn(desc);
  if (desc['S3BackupMode'] !== undefined) out['S3BackupMode'] = desc['S3BackupMode'];
  // Inner nested complex fields. SDK reuses the *Configuration types in
  // *Description responses, so a deep `pickDefinedDeep` produces a CFn-
  // compatible shape.
  out['ProcessingConfiguration'] = pickDefinedDeep(desc['ProcessingConfiguration']) ?? {};
  out['DataFormatConversionConfiguration'] =
    pickDefinedDeep(desc['DataFormatConversionConfiguration']) ?? {};
  out['DynamicPartitioningConfiguration'] =
    pickDefinedDeep(desc['DynamicPartitioningConfiguration']) ?? {};
  // AWS omits both from the description when they were never set.
  if (desc['FileExtension'] !== undefined) out['FileExtension'] = desc['FileExtension'];
  if (desc['CustomTimeZone'] !== undefined) out['CustomTimeZone'] = desc['CustomTimeZone'];
  // S3BackupConfiguration: AWS returns S3BackupDescription (deprecated
  // shape); reverse-map to the modern Configuration shape via the same
  // top-level helper. Field names align since the deprecated shape and
  // the modern shape share the BucketARN / RoleARN / Prefix / etc.
  // surface, just with the EncryptionConfiguration / CloudWatchLoggingOptions
  // inner placeholders included.
  if (desc['S3BackupDescription']) {
    out['S3BackupConfiguration'] = mapS3DescriptionToCfn(
      desc['S3BackupDescription'] as Record<string, unknown>
    );
  } else {
    out['S3BackupConfiguration'] = {};
  }
  return out;
}

/**
 * Map a non-S3 destination description (Elasticsearch /
 * Amazonopensearchservice / AmazonOpenSearchServerless / Splunk) to
 * its CFn `*Configuration` shape.
 *
 * AWS reuses field names between Description and Configuration for
 * these destinations, so a `pickDefinedDeep` pass-through produces a
 * CFn-compatible shape. The exception is `VpcConfigurationDescription`
 * which carries an AWS-managed read-only `VpcId` not present in the
 * CFn `VpcConfiguration` input shape — strip it so the comparator
 * doesn't fire false drift on the read-only field.
 *
 * Always-emit pattern: every nested complex sub-shape AWS reports
 * (BufferingHints / RetryOptions / ProcessingConfiguration /
 * CloudWatchLoggingOptions / VpcConfiguration / DocumentIdOptions /
 * SecretsManagerConfiguration) that the SDK reuses across both shapes
 * is surfaced via `pickDefinedDeep`. Non-templated sub-shapes are
 * dropped to avoid `{}` clutter; the v3 baseline catches console-side
 * ADDs at the top-level destination key, not at every leaf.
 */
function mapNonS3DestinationToCfn(desc: Record<string, unknown>): Record<string, unknown> {
  const cleaned = pickDefinedDeep(desc) as Record<string, unknown> | undefined;
  if (!cleaned) return {};
  // AWS returns VpcConfigurationDescription with a read-only VpcId; the
  // CFn VpcConfiguration shape does not include it. Strip if present.
  if (cleaned['VpcConfigurationDescription']) {
    const vpc = { ...(cleaned['VpcConfigurationDescription'] as Record<string, unknown>) };
    delete vpc['VpcId'];
    // Rename to the CFn key (`VpcConfiguration`).
    delete cleaned['VpcConfigurationDescription'];
    if (Object.keys(vpc).length > 0) cleaned['VpcConfiguration'] = vpc;
  }
  return cleaned;
}

/**
 * Map RedshiftDestinationDescription → CFn RedshiftDestinationConfiguration.
 *
 * Redshift carries a nested S3DestinationDescription (deprecated shape)
 * that's required as `S3Configuration` in the CFn input. Reverse-map via
 * the shared `mapS3DescriptionToCfn` helper. `S3BackupDescription` is
 * mapped to `S3BackupConfiguration` the same way.
 *
 * `Password` is write-only — AWS never returns it on read. State that
 * carries `Password` falls back to v2 baseline; declared in
 * `getDriftUnknownPaths`.
 */
function mapRedshiftDescriptionToCfn(desc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of [
    'RoleARN',
    'ClusterJDBCURL',
    'CopyCommand',
    'Username',
    'RetryOptions',
    'ProcessingConfiguration',
    'S3BackupMode',
    'CloudWatchLoggingOptions',
    'SecretsManagerConfiguration',
  ]) {
    const v = pickDefinedDeep(desc[k]);
    if (v !== undefined) out[k] = v;
  }
  // Required nested S3 destination — reverse-map via the S3 helper.
  if (desc['S3DestinationDescription']) {
    out['S3Configuration'] = mapS3DescriptionToCfn(
      desc['S3DestinationDescription'] as Record<string, unknown>
    );
  }
  if (desc['S3BackupDescription']) {
    out['S3BackupConfiguration'] = mapS3DescriptionToCfn(
      desc['S3BackupDescription'] as Record<string, unknown>
    );
  }
  return out;
}

/**
 * Map HttpEndpointDestinationDescription → CFn HttpEndpointDestinationConfiguration.
 *
 * AWS returns `EndpointConfiguration: HttpEndpointDescription` (Url +
 * Name only). The CFn input `HttpEndpointConfiguration` additionally
 * accepts `AccessKey` (write-only — redacted from the Description).
 * State that carries `AccessKey` falls back to v2 baseline; declared in
 * `getDriftUnknownPaths`.
 *
 * `RequestConfiguration` and `SecretsManagerConfiguration` are pass-
 * through (SDK reuses the same shapes between Configuration and
 * Description).
 */
function mapHttpEndpointDescriptionToCfn(desc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of [
    'BufferingHints',
    'CloudWatchLoggingOptions',
    'RequestConfiguration',
    'ProcessingConfiguration',
    'RoleARN',
    'RetryOptions',
    'SecretsManagerConfiguration',
  ]) {
    const v = pickDefinedDeep(desc[k]);
    if (v !== undefined) out[k] = v;
  }
  if (desc['EndpointConfiguration']) {
    const endpoint = pickDefinedDeep(desc['EndpointConfiguration']);
    if (endpoint !== undefined) out['EndpointConfiguration'] = endpoint;
  }
  return out;
}
