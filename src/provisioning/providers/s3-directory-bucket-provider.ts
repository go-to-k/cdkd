import {
  S3Client,
  DeleteBucketMetricsConfigurationCommand,
  DeleteBucketInventoryConfigurationCommand,
} from '@aws-sdk/client-s3';
import { S3ControlClient } from '@aws-sdk/client-s3-control';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { EC2Client, DescribeAvailabilityZonesCommand } from '@aws-sdk/client-ec2';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { derivePartitionAndUrlSuffix } from '../../utils/aws-partition.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type { DeleteContext } from '../region-check.js';
import type { MaskerFn } from '../masked-retry-logger.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  ResourceNotFound,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import {
  ambientClientDefaults,
  clientDefaultsFor,
  type CredentialConfig,
} from '../../utils/ambient-client-defaults.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { s3ClientDefaults } from '../../utils/s3-client-defaults.js';
import {
  create,
  applyConfigurations,
  deleteItemIdempotently,
} from './s3-directory-bucket/create.js';
import { update } from './s3-directory-bucket/update.js';
import {
  deleteImpl,
  deleteBucketWithEmptyRetry,
  emptyBucket,
} from './s3-directory-bucket/delete.js';
import {
  readState,
  readEncryption,
  readLifecycle,
  readMetrics,
  readInventory,
  readTags,
  importImpl,
} from './s3-directory-bucket/read-state.js';
import {
  itemId,
  recordedItems,
  canonicalizeConfigurationsForDrift,
  liveMatchesDesired,
} from './s3-directory-bucket/configurations.js';
import type { DesiredConfigurations } from './s3-directory-bucket/configurations.js';

/**
 * SDK Provider for AWS::S3Express::DirectoryBucket
 *
 * Uses S3 SDK directly for S3 Express Directory Bucket operations.
 * Directory buckets use the S3 Express One Zone storage class with
 * single-AZ data redundancy.
 */
export class S3DirectoryBucketProvider implements ResourceProvider {
  s3Client: S3Client;
  createClient: Promise<S3Client> | undefined;
  /** The credential half of the `AwsClients` `s3Client` came from (#4639). */
  readonly credentialConfig: CredentialConfig;
  stsClient: STSClient;
  logger: ConsoleLogger = getLogger().child('S3DirectoryBucketProvider');

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
  wrapCaughtError(
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
      'AWS::S3Express::DirectoryBucket',
      new Set([
        'DataRedundancy',
        'LocationName',
        'BucketName',
        'Tags',
        'BucketEncryption',
        'LifecycleConfiguration',
        'MetricsConfigurations',
        'InventoryConfigurations',
      ]),
    ],
  ]);

  /**
   * go-to-k/cdkd#5487: the live values of the unsettled `names`, for the
   * engine's convergence step and its post-update proof. That proof compares
   * the TEMPLATE's value with this read without the drift canonicalization,
   * so a configuration AWS holds as asked, but spells otherwise (an implied
   * `BucketKeyEnabled`, an `Id` S3 gave an unnamed lifecycle rule), is
   * answered in the template's spelling ({@link liveMatchesDesired});
   * anything else is answered as read. A failed read throws.
   */
  async readUnsettled(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    names: ReadonlySet<string>,
    recordedProperties?: Record<string, unknown>,
    desiredProperties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    // Every unsettled name must be read: a failed read throws.
    const live = await this.readState(physicalId);
    if (live === RESOURCE_NOT_FOUND) return live;
    const desired = desiredProperties ?? recordedProperties ?? {};
    const out: Record<string, unknown> = {};
    for (const name of names) {
      if (!Object.hasOwn(live, name)) continue;
      if (desired[name] !== undefined && liveMatchesDesired(name, desired, live)) {
        out[name] = desired[name];
        continue;
      }
      // An `Id` neither the record nor the template names is somebody else's
      // (added out of band): it is left out, so the convergence never deletes
      // it, as it never removes a tag it did not record. The known limit is
      // the Tags one in unsettled-convergence.ts: an Id a failed attempt Put,
      // then dropped from the template before the next deploy, is named by
      // neither side and stays.
      if (name === 'MetricsConfigurations' || name === 'InventoryConfigurations') {
        const named = new Set([
          ...recordedItems(recordedProperties?.[name]).keys(),
          ...recordedItems(desiredProperties?.[name]).keys(),
        ]);
        const items = live[name];
        out[name] = Array.isArray(items)
          ? items.filter((item) => {
              const id = itemId(item);
              return id !== undefined && named.has(id);
            })
          : items;
        continue;
      }
      out[name] = live[name];
    }
    return out;
  }

  /**
   * The two `Id`-keyed lists are SETS: S3 names each item by its `Id` and
   * documents no order for `ListBucketMetricsConfigurations` /
   * `ListBucketInventoryConfigurations`, and an inventory's `OptionalFields`
   * is a set of field names. `LifecycleConfiguration.Rules` stays ordered.
   */
  getDriftUnorderedPaths(resourceType: string): string[] {
    if (resourceType !== 'AWS::S3Express::DirectoryBucket') return [];
    return ['MetricsConfigurations', 'InventoryConfigurations'];
  }

  /**
   * Drops, from BOTH drift bags, what a template and the readback can each
   * spell either way for the same bucket: a `BucketKeyEnabled` at the value
   * its algorithm implies, and a lifecycle rule's empty `Prefix`
   * ({@link canonicalizeConfigurationsForDrift}). Identity otherwise.
   */
  canonicalizeDriftProperties(
    resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown> {
    if (resourceType !== 'AWS::S3Express::DirectoryBucket') return properties;
    return canonicalizeConfigurationsForDrift(properties);
  }

  ec2Client: EC2Client | undefined;
  s3ControlClient: S3ControlClient | undefined;
  readonly providerRegion = ambientRegion();

  constructor() {
    const awsClients = getAwsClients();
    this.s3Client = awsClients.s3;
    this.stsClient = awsClients.sts;
    // A test double may carry no `credentialConfig`: degrade to `{}`, as
    // `ambientCredentialConfig` does.
    this.credentialConfig =
      (awsClients as { credentialConfig?: CredentialConfig }).credentialConfig ?? {};
  }

  /**
   * The client `CreateBucket` goes through: SDK retries on, except a 5xx
   * (`withoutServerErrorRetries`, issue #4639). Separate so every other call
   * -- and every other provider sharing `getAwsClients().s3` -- keeps the full
   * SDK retry. Built in the shared client's REGION (read from it, as
   * `config.region()` resolves it), so the create cannot land in another
   * region than the calls around it, and with the credentials of the SAME
   * `AwsClients` that client came from, read at construction, so a later
   * `setAwsClients` switch cannot give the create another identity. The
   * PROMISE is cached, so two creates on a cold provider build one client; a
   * rejected region read is not cached, so the next create retries it.
   *
   * `CreateBucket` carries no idempotency token, and a directory bucket name
   * is unique in its zone, so the SDK's own replay of a 5xx whose request had
   * succeeded collides with the bucket the first send made, and that
   * collision surfaced from the engine's FIRST attempt as a name somebody else
   * holds. Refused here, the 5xx reaches the deploy engine's retry, which
   * marks the create as possibly replayed (`withRetry`, #3978). The bucket is
   * not adopted on that collision: a name is not attribution
   * (`docs/provider-rules.md`, "Adopt only on EXACT attribution").
   */
  getCreateClient(): Promise<S3Client> {
    this.createClient ??= this.s3Client.config.region().then(
      (region) =>
        withoutServerErrorRetries(
          new S3Client({
            ...clientDefaultsFor(this.credentialConfig),
            ...s3ClientDefaults(),
            region,
          })
        ),
      (error: unknown) => {
        this.createClient = undefined;
        throw error;
      }
    );
    return this.createClient;
  }

  getEc2Client(): EC2Client {
    if (!this.ec2Client) {
      this.ec2Client = new EC2Client({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.ec2Client;
  }

  /**
   * Directory-bucket tags live on the S3 control plane: `PutBucketTagging`
   * is documented "not supported for directory buckets", and the tag CRUD
   * after create is S3 Control's `TagResource` / `UntagResource` /
   * `ListTagsForResource` (requiring the `s3express:TagResource` /
   * `s3express:UntagResource` / `s3express:ListTagsForResource` permissions).
   */
  getS3ControlClient(): S3ControlClient {
    if (!this.s3ControlClient) {
      this.s3ControlClient = new S3ControlClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.s3ControlClient;
  }

  /**
   * Convert AZ name (us-east-1a) to AZ ID (use1-az1) via EC2 DescribeAvailabilityZones
   */
  async getAzId(azName: string): Promise<string> {
    try {
      const response = await this.getEc2Client().send(
        new DescribeAvailabilityZonesCommand({
          ZoneNames: [azName],
        })
      );
      const azId = response.AvailabilityZones?.[0]?.ZoneId;
      if (azId) {
        this.logger.debug(`Resolved AZ name ${azName} → AZ ID ${azId}`);
        return azId;
      }
    } catch (error) {
      this.logger.debug(
        `Failed to resolve AZ ID for ${azName}: ${describeAwsFailure(error).detail}`
      );
    }
    // Fallback: return the AZ name as-is
    return azName;
  }

  /**
   * Get the region from the S3 client config
   */
  async getRegion(): Promise<string> {
    const region = await this.s3Client.config.region();
    return region || 'us-east-1';
  }

  /**
   * Get the AWS account ID via STS
   */
  async getAccountId(): Promise<string> {
    const identity = await this.stsClient.send(new GetCallerIdentityCommand({}));
    return identity.Account!;
  }

  /**
   * Build attributes for a directory bucket
   */
  async buildAttributes(bucketName: string): Promise<Record<string, unknown>> {
    return {
      Arn: await this.buildBucketArn(bucketName),
    };
  }

  /**
   * Directory bucket ARN:
   * `arn:{partition}:s3express:{region}:{account}:bucket/{name}`.
   * Also the `ResourceArn` for the S3 Control tag operations. Callers that
   * already resolved the account (for the S3 Control `AccountId` parameter)
   * pass it in so the STS lookup runs once per operation.
   *
   * The partition is derived from the region through the same closed mapping
   * `${AWS::Partition}` uses (issue #1815) rather than hardcoded to `aws`.
   * Here it is load-bearing TWICE over: the value is served as the bucket's
   * `Arn` attribute AND passed to S3 Control as the `ResourceArn` of a tag
   * mutation, so outside the commercial partition the wrong literal does not
   * merely record a bad string — it aims the tag call at an ARN that does not
   * name this bucket.
   *
   * KNOWN BOUND (pre-existing, not introduced by #1815): the region — and now
   * the partition derived from it — comes from `s3Client`, while the tag
   * calls that consume this ARN go through `s3ControlClient`, built from
   * `providerRegion` (`ambientRegion()`). Those two can disagree,
   * so the ARN can name a different region than the client receiving it. The
   * region SEGMENT already had this exposure before the partition rode along
   * with it; unifying the two clients' region resolution is a separate change.
   */
  async buildBucketArn(bucketName: string, accountId?: string): Promise<string> {
    const region = await this.getRegion();
    const account = accountId ?? (await this.getAccountId());
    const { partition } = derivePartitionAndUrlSuffix(region);
    return `arn:${partition}:s3express:${region}:${account}:bucket/${bucketName}`;
  }

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  applyConfigurations(
    bucketName: string,
    desired: DesiredConfigurations,
    desiredRaw: Record<string, unknown>,
    previousRaw: Record<string, unknown>,
    creating: boolean,
    markUnsettled?: (key: string) => void
  ): Promise<void> {
    return applyConfigurations.call(
      this,
      bucketName,
      desired,
      desiredRaw,
      previousRaw,
      creating,
      markUnsettled
    );
  }

  deleteItemIdempotently(
    command: DeleteBucketMetricsConfigurationCommand | DeleteBucketInventoryConfigurationCommand
  ): Promise<void> {
    return deleteItemIdempotently.call(this, command);
  }

  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return update.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  deleteBucketWithEmptyRetry(
    logicalId: string,
    bucketName: string,
    allowAutoEmpty: boolean,
    maskSecrets: MaskerFn | undefined
  ): Promise<void> {
    return deleteBucketWithEmptyRetry.call(
      this,
      logicalId,
      bucketName,
      allowAutoEmpty,
      maskSecrets
    );
  }

  emptyBucket(bucketName: string, mask: MaskerFn): Promise<void> {
    return emptyBucket.call(this, bucketName, mask);
  }

  /**
   * Read the AWS-current S3 Express Directory Bucket configuration in
   * CFn-property shape.
   *
   * Issues `HeadBucket` to verify existence and surfaces `BucketName`
   * (the physicalId) plus `Tags` (via S3 Control `ListTagsForResource`,
   * the directory-bucket tag read). `DataRedundancy` comes from the
   * `HeadBucket` response's `BucketLocationType`; `LocationName` is not
   * exposed by any cheap S3 Express API — the only way to inspect it is by
   * parsing the bucket name's `--<az-id>--x-s3` suffix, which is best
   * effort.
   *
   * `--<az-id>--x-s3` suffix parsing: directory bucket names follow the
   * format `<base>--<az-id>--x-s3`, e.g.
   * `my-bucket--use1-az1--x-s3`. We don't reverse the AZ-ID -> AZ-name
   * mapping here (that would require a per-call EC2 `DescribeAvailabilityZones`
   * round-trip); state's `LocationName` is `us-east-1a--x-s3`-style,
   * while the bucket name carries the AZ-ID `use1-az1`. Cross-region
   * mapping is too expensive for v1 — we omit `LocationName` from the
   * snapshot and rely on the comparator's "key absent in state never
   * drifts" rule to no-op against state.
   *
   * Returns `RESOURCE_NOT_FOUND` when the bucket is gone (`HeadBucket` returns
   * `NotFound` / `NoSuchBucket`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return this.readState(physicalId);
  }

  readState(physicalId: string): Promise<Record<string, unknown> | ResourceNotFound> {
    return readState.call(this, physicalId);
  }

  readEncryption(bucket: string): Promise<Record<string, unknown>> {
    return readEncryption.call(this, bucket);
  }

  readLifecycle(bucket: string): Promise<Record<string, unknown>> {
    return readLifecycle.call(this, bucket);
  }

  readMetrics(bucket: string): Promise<Array<Record<string, unknown>>> {
    return readMetrics.call(this, bucket);
  }

  readInventory(bucket: string): Promise<Array<Record<string, unknown>>> {
    return readInventory.call(this, bucket);
  }

  readTags(bucketName: string): Promise<Array<{ Key: string; Value: string }>> {
    return readTags.call(this, bucketName);
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }
}
