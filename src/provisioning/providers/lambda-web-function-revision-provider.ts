import {
  LambdaWebClient,
  ListWebFunctionRevisionsCommand,
  CreateWebFunctionRevisionCommand,
  GetWebFunctionRevisionCommand,
  DeleteWebFunctionRevisionCommand,
  ResourceNotFoundException,
  type BuildConfig,
  type ServiceConfig,
  type TelemetryConfig,
  type LoggingConfig,
  type CreateWebFunctionRevisionRequest,
  type GetWebFunctionRevisionResponse,
  type CreateWebFunctionRevisionResponse,
} from '@aws-sdk/client-lambda-web';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { createMaskedLogSinks, type MaskedLogSinks } from '../masked-retry-logger.js';
import { pasteableAwsCommand } from '../replacement-protection-advice.js';
import {
  AmbiguousCreateLatch,
  RecentIdSet,
  isInsideWindow,
  replayedSendWindow,
  withoutServerErrorRetries,
  type AmbiguousCreateWindow,
} from './ambiguous-create.js';
import {
  collectOrphanIds,
  orphanCommandRegionArg,
  reportPossibleOrphans,
} from './orphan-report.js';
import { getLogger } from '../../utils/logger.js';
import { safeMsg } from '../../utils/display-safe.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { isPlainImportValue, VALUE_NOT_SHOWN } from '../import-helpers.js';
import { logicalIdShown } from '../composite-id.js';
import { markCreatedBeforeFailure } from '../auxiliary-failure.js';
import { markNonRetryable } from '../../deployment/retryable-errors.js';
import { definedAttributes } from '../attribute-map.js';
import { coerceCfnInteger } from '../config-shape.js';
import type {
  CreateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  UpdateContext,
  ResourceNotFound,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import {
  parseWebFunctionChildArn,
  recordedFunctionNameSpelling,
  projectOntoRecorded,
  isPlainRecord,
  sleep,
  LAMBDA_WEB_POLL_INTERVAL_MS,
  LAMBDA_WEB_MAX_POLL_ATTEMPTS,
} from './lambda-web-function-arns.js';

/**
 * Retry-safety state for `CreateWebFunctionRevision`, which mints the revision
 * id and carries no idempotency token: a replay of a create AWS completed adds
 * a SECOND revision under the function, in no state record and holding a copy
 * of the revision's environment variables. Same handling as
 * `PublishLayerVersion` (issue #2080): no 5xx replay on the create client, and
 * a report of the candidates after an ambiguous attempt. Module-scoped: a
 * provider instance is per registry, and one process can build several.
 */
const createRevisionLatch = new AmbiguousCreateLatch('lambda-web:CreateWebFunctionRevision');
/** Revision ARNs this process created and recorded, never reported as orphan candidates. */
const revisionsCreatedByThisProcess = new RecentIdSet();

/** Reset the module-scoped retry-safety state. TEST-ONLY. */
export function resetWebFunctionRevisionCreateRetryStateForTests(): void {
  createRevisionLatch.resetForTests();
  revisionsCreatedByThisProcess.resetForTests();
}

/**
 * AWS Lambda Web Function Revision Provider (go-to-k/cdkd#4926)
 *
 * Implements `AWS::Lambda::WebFunctionRevision` through the dedicated
 * `lambda-web` service SDK (`@aws-sdk/client-lambda-web`). A revision is the
 * immutable unit of code + configuration a web function endpoint routes to, so
 * every code change creates one and the endpoint switches to it: this is the
 * per-deploy path, and the direct API settles about 1.5 s sooner than Cloud
 * Control on the create and 1.7 s sooner on the delete.
 *
 * **Every property is create-only** (the schema has no update handler), so a
 * change is a replacement and `update()` is never reached in practice.
 *
 * **Create waits for `Active`.** `CreateWebFunctionRevision` returns the
 * revision `Pending`, and an endpoint naming a `Pending` revision is refused
 * (`ConflictException: ... Only revisions in Active state can be deployed`),
 * so the wait runs in every mode, `--no-wait` included.
 *
 * **Physical id is the revision ARN** (`primaryIdentifier` =
 * `/properties/RevisionArn`), the same id Cloud Control records, so a resource
 * created by either route is addressed the same way.
 *
 * **Deleting a revision an endpoint still routes to is refused** (409
 * `ConflictException: ... endpoints [<name>] are using it`). That is the
 * ordinary state of a replaced revision until its endpoint has moved on; the
 * deploy engine retries a replaced resource's refused delete after the rest of
 * the deploy (go-to-k/cdkd#4900).
 */
export class LambdaWebFunctionRevisionProvider implements ResourceProvider {
  private client: LambdaWebClient;
  private createClient: Promise<LambdaWebClient> | undefined;
  private logger = getLogger().child('LambdaWebFunctionRevisionProvider');

  constructor() {
    this.client = getAwsClients().lambdaWeb;
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Lambda::WebFunctionRevision',
      new Set(['FunctionName', 'Description', 'KmsKeyArn', 'BuildConfig', 'ServiceConfig']),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::Lambda::WebFunctionRevision',
      new Map([
        ['FunctionArn', 'AWS-managed read-only attribute'],
        ['RevisionId', 'AWS-managed read-only attribute'],
        ['RevisionArn', 'AWS-managed read-only attribute (primaryIdentifier / physical id)'],
        ['State', 'AWS-managed read-only attribute'],
        ['StateReason', 'AWS-managed read-only attribute'],
        ['CreatedAt', 'AWS-managed read-only attribute'],
      ]),
    ],
  ]);

  getMinResourceTimeoutMs(): number {
    return LAMBDA_WEB_MAX_POLL_ATTEMPTS * LAMBDA_WEB_POLL_INTERVAL_MS;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(safeMsg`Creating Lambda web function revision ${logicalId}`);
    const input = this.buildCreateInput(logicalId, resourceType, properties, context);
    // Built per call; never cached on the provider, which serves concurrent resources.
    const log = createMaskedLogSinks(this.logger, context?.maskSecrets);

    let createdArn: string | undefined;
    try {
      // After an earlier ambiguous attempt, name the revision it may have
      // created before a second create is sent. Detection only.
      const orphanWindow = createRevisionLatch.take(logicalId);
      if (orphanWindow !== undefined) {
        await this.reportPossibleRevisionOrphans(logicalId, orphanWindow, log, input.functionName!);
      }
      const createClient = await this.getCreateClient();
      const attemptStartMs = Date.now();
      let response: CreateWebFunctionRevisionResponse;
      try {
        response = await createClient.send(new CreateWebFunctionRevisionCommand(input));
      } catch (error) {
        createRevisionLatch.noteFailure(logicalId, error, attemptStartMs, orphanWindow);
        throw error;
      }
      createdArn = response.revisionArn;
      if (createdArn) revisionsCreatedByThisProcess.add(createdArn);
      // The SDK replayed the create inside its `send`, so an earlier attempt
      // may have made one too (issue #4687). Detection only.
      const replayWindow = replayedSendWindow(response, attemptStartMs);
      if (replayWindow !== undefined) {
        await this.reportPossibleRevisionOrphans(logicalId, replayWindow, log, input.functionName!);
      }
      if (!createdArn || !response.revisionId) {
        throw new ProvisioningError(
          `CreateWebFunctionRevision succeeded but returned no revision ARN for ${logicalIdShown(logicalId)}`,
          resourceType,
          logicalId
        );
      }
      const active = await this.waitForActive(input.functionName!, createdArn, logicalId);
      return { physicalId: createdArn, attributes: buildAttributes(active) };
    } catch (error) {
      const thrown = this.wrapError('create', logicalId, resourceType, undefined, error);
      // go-to-k/cdkd#4945: delete the revision a later step (the readiness
      // wait) failed after, so a transient failure stays retryable.
      let leftBehindArn = createdArn;
      if (leftBehindArn) {
        try {
          await this.delete(logicalId, leftBehindArn, resourceType);
          leftBehindArn = undefined;
        } catch (cleanupError) {
          log.warn(
            safeMsg`Failed to delete partially-created Lambda web function revision ${logicalId}: ${describeAwsFailure(cleanupError).detail}. The failed deploy records it for \`cdkd rollback --revert-failed\`, or delete it by hand`
          );
        }
      }
      // The revision exists once CreateWebFunctionRevision returned its ARN (the
      // id delete() takes); name it for --revert-failed (go-to-k/cdkd#4583).
      if (leftBehindArn) {
        markCreatedBeforeFailure(thrown, logicalId, resourceType, leftBehindArn);
        // go-to-k/cdkd#4945: terminal. CreateWebFunctionRevision sends no name
        // and no token, so the engine's retry would make another revision while
        // the journal names one.
        markNonRetryable(thrown);
      }
      throw thrown;
    }
  }

  /**
   * The client `CreateWebFunctionRevision` goes through: SDK retries on, except
   * a 5xx (`withoutServerErrorRetries`), in the shared client's region. The
   * PROMISE is cached, so two creates on a cold provider build one client; a
   * rejected region read is not cached, so the next create retries it.
   */
  private getCreateClient(): Promise<LambdaWebClient> {
    this.createClient ??= this.client.config.region().then(
      (region) =>
        withoutServerErrorRetries(new LambdaWebClient({ ...ambientClientDefaults(), region })),
      (error: unknown) => {
        this.createClient = undefined;
        throw error;
      }
    );
    return this.createClient;
  }

  /**
   * List the revisions of `functionName` an earlier ambiguous create may have
   * made -- created inside its window and not recorded by this process -- and
   * warn, with a read and then a delete command to run only after confirming.
   * The commands go through Cloud Control, which every AWS CLI carries.
   */
  private async reportPossibleRevisionOrphans(
    logicalId: string,
    window: AmbiguousCreateWindow,
    log: MaskedLogSinks,
    functionName: string
  ): Promise<void> {
    const aws = pasteableAwsCommand(log.mask);
    const regionArg = await orphanCommandRegionArg(this.client, aws);
    await reportPossibleOrphans(logicalId, window, log, {
      action: 'CreateWebFunctionRevision',
      service: 'Lambda',
      listAction: 'ListWebFunctionRevisions',
      subject: `a revision of web function ${log.value(functionName)}`,
      noun: 'revision(s)',
      list: () =>
        collectOrphanIds(
          async (token) => {
            const page = await this.client.send(
              new ListWebFunctionRevisionsCommand({
                functionName,
                ...(token && { nextToken: token }),
              })
            );
            return { items: page.revisions ?? [], next: page.nextToken };
          },
          (item) =>
            item.revisionArn &&
            isInsideWindow(item.createdAt, window) &&
            !revisionsCreatedByThisProcess.has(item.revisionArn)
              ? item.revisionArn
              : undefined
        ),
      inspect: (id) =>
        aws`aws cloudcontrol get-resource --type-name AWS::Lambda::WebFunctionRevision --identifier ${id}${regionArg}`.render(),
      remove: (id) =>
        aws`aws cloudcontrol delete-resource --type-name AWS::Lambda::WebFunctionRevision --identifier ${id}${regionArg}`.render(),
    });
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    // go-to-k/cdkd#2613: a wrong-region client is named before the refusal
    // below steers toward a replacement.
    assertRegionMatch(
      context?.expectedRegion ? await this.client.config.region() : undefined,
      context?.expectedRegion,
      resourceType,
      logicalId,
      physicalId,
      'pre-update'
    );
    return Promise.reject(
      new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        'A Lambda web function revision is immutable — every property is create-only and there is no update API, so any change creates a new revision. cdkd normally classifies such a change as a replacement, so reaching this path is unexpected; re-run the deploy.'
      )
    );
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(safeMsg`Deleting Lambda web function revision ${logicalId}`);
    const parts = parseWebFunctionChildArn(physicalId, 'revision');
    if (!parts) {
      throw new ProvisioningError(
        `Cannot delete Lambda web function revision ${logicalIdShown(logicalId)}: its recorded id is not a revision ARN`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    try {
      try {
        await this.client.send(
          new DeleteWebFunctionRevisionCommand({
            functionName: parts.functionArn,
            revisionId: physicalId,
          })
        );
      } catch (error) {
        if (error instanceof ResourceNotFoundException) {
          assertRegionMatch(
            await this.client.config.region(),
            context?.expectedRegion,
            resourceType,
            logicalId,
            physicalId
          );
          this.logger.debug(
            safeMsg`Lambda web function revision ${logicalId} does not exist, skipping deletion`
          );
          return;
        }
        throw error;
      }
      // Measured: the revision reads as not found right after the delete returns;
      // confirm it so a destroy never reports an orphan as deleted.
      await this.waitForGone(parts.functionArn, physicalId, logicalId);
    } catch (error) {
      throw this.wrapError('delete', logicalId, resourceType, physicalId, error);
    }
  }

  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    const parts = parseWebFunctionChildArn(physicalId, 'revision');
    if (attributeName === 'RevisionArn') return physicalId;
    if (attributeName === 'RevisionId' && parts) return parts.childId;
    if (attributeName === 'FunctionArn' && parts) return parts.functionArn;
    if (!parts) return undefined;
    const resp = await this.client.send(
      new GetWebFunctionRevisionCommand({ functionName: parts.functionArn, revisionId: physicalId })
    );
    return buildAttributes(resp)[attributeName];
  }

  /**
   * Adopt an existing revision. Override-only: the revision ARN must be passed
   * via `--resource <logicalId>=<arn>`. A revision has no name and is not
   * taggable, so there is nothing to look it up by.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const arn = input.knownPhysicalId;
    if (!arn) return null;
    const parts = parseWebFunctionChildArn(arn, 'revision');
    if (!parts) {
      throw new Error(
        `--resource override for ${logicalIdShown(input.logicalId)} must be a Lambda web function revision ARN ` +
          `(got ${isPlainImportValue(arn) ? `'${arn}'` : VALUE_NOT_SHOWN}); use the arn:...:web-function/<name>/revision/<id> ARN.`
      );
    }
    try {
      const resp = await this.client.send(
        new GetWebFunctionRevisionCommand({ functionName: parts.functionArn, revisionId: arn })
      );
      return { physicalId: arn, attributes: buildAttributes(resp) };
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return null;
      throw error;
    }
  }

  /**
   * Read the live revision for `cdkd drift`, laid onto the recorded bag's
   * shape (see {@link projectOntoRecorded}). A revision is immutable, so in
   * practice this reports only whether it still exists.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    const parts = parseWebFunctionChildArn(physicalId, 'revision');
    if (!parts) return undefined;
    let resp: GetWebFunctionRevisionResponse;
    try {
      resp = await this.client.send(
        new GetWebFunctionRevisionCommand({
          functionName: parts.functionArn,
          revisionId: physicalId,
        })
      );
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
      throw error;
    }
    const live: Record<string, unknown> = {
      FunctionName: recordedFunctionNameSpelling(
        properties?.['FunctionName'],
        resp.functionArn ?? parts.functionArn
      ),
    };
    if (resp.description !== undefined) live['Description'] = resp.description;
    if (resp.kmsKeyArn !== undefined) live['KmsKeyArn'] = resp.kmsKeyArn;
    if (resp.buildConfig) live['BuildConfig'] = buildConfigToCfn(resp.buildConfig);
    if (resp.serviceConfig) live['ServiceConfig'] = serviceConfigToCfn(resp.serviceConfig);
    if (!properties) return live;
    const out: Record<string, unknown> = { FunctionName: live['FunctionName'] };
    for (const key of ['Description', 'KmsKeyArn', 'BuildConfig', 'ServiceConfig']) {
      if (key in live) out[key] = projectOntoRecorded(properties[key], live[key]);
    }
    return out;
  }

  // -- helpers -------------------------------------------------------------

  private buildCreateInput(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): CreateWebFunctionRevisionRequest {
    const fail = (message: string): never => {
      throw new ProvisioningError(
        `${message} for Lambda web function revision ${logicalIdShown(logicalId)}`,
        resourceType,
        logicalId
      );
    };
    const functionName = properties['FunctionName'];
    if (typeof functionName !== 'string' || functionName === '')
      fail('FunctionName must be a non-empty string');

    const build = properties['BuildConfig'];
    if (!isPlainRecord(build)) fail('BuildConfig must be an object');
    const code = (build as Record<string, unknown>)['CodeConfig'];
    const s3 = isPlainRecord(code) ? code['S3Object'] : undefined;
    if (!isPlainRecord(s3) || typeof s3['Bucket'] !== 'string' || typeof s3['Key'] !== 'string') {
      fail('BuildConfig.CodeConfig.S3Object.Bucket and .Key are required strings');
    }
    const runtimeConfig = (build as Record<string, unknown>)['RuntimeConfig'];
    const runtime = isPlainRecord(runtimeConfig) ? runtimeConfig['Runtime'] : undefined;
    if (typeof runtime !== 'string') fail('BuildConfig.RuntimeConfig.Runtime is a required string');

    const service = properties['ServiceConfig'];
    if (!isPlainRecord(service) || typeof service['ExecutionRoleArn'] !== 'string') {
      fail('ServiceConfig.ExecutionRoleArn is a required string');
    }

    const s3Object = s3 as Record<string, unknown>;
    const buildConfig: BuildConfig = {
      codeConfig: {
        s3Object: {
          bucket: s3Object['Bucket'] as string,
          key: s3Object['Key'] as string,
          ...(typeof s3Object['VersionId'] === 'string'
            ? { versionId: s3Object['VersionId'] }
            : {}),
        },
      },
      runtimeConfig: { runtime: runtime as string },
    };

    const input: CreateWebFunctionRevisionRequest = {
      functionName: functionName as string,
      buildConfig,
      serviceConfig: this.buildServiceConfig(service as Record<string, unknown>, fail, context),
    };
    if (typeof properties['Description'] === 'string')
      input.description = properties['Description'];
    if (typeof properties['KmsKeyArn'] === 'string') input.kmsKeyArn = properties['KmsKeyArn'];
    return input;
  }

  private buildServiceConfig(
    service: Record<string, unknown>,
    fail: (message: string) => never,
    context?: CreateContext
  ): ServiceConfig {
    const out: ServiceConfig = { executionRoleArn: service['ExecutionRoleArn'] as string };
    // A malformed optional member is refused on a template-path create and
    // omitted with a warning on a state replay (provider-replay-and-refusals.md).
    const integer = (
      key: 'TimeoutSeconds' | 'MaxConcurrencyPerEnvironment'
    ): number | undefined => {
      const raw = service[key];
      if (raw === undefined) return undefined;
      const n = coerceCfnInteger(raw);
      if (n !== undefined) return n;
      const message = `ServiceConfig.${key} must be an integer`;
      if (context?.replayingState) {
        this.logger.warn(safeMsg`${message}; omitting it while replaying a state record`);
        return undefined;
      }
      return fail(message);
    };
    const timeoutSeconds = integer('TimeoutSeconds');
    if (timeoutSeconds !== undefined) out.timeoutSeconds = timeoutSeconds;
    const maxConcurrencyPerEnvironment = integer('MaxConcurrencyPerEnvironment');
    if (maxConcurrencyPerEnvironment !== undefined) {
      out.maxConcurrencyPerEnvironment = maxConcurrencyPerEnvironment;
    }
    if (typeof service['EgressNetworkConnectorArn'] === 'string') {
      out.egressNetworkConnectorArn = service['EgressNetworkConnectorArn'];
    }
    const env = service['EnvironmentVariables'];
    if (env !== undefined) {
      if (isPlainRecord(env) && Object.values(env).every((v) => typeof v === 'string')) {
        out.environmentVariables = { ...(env as Record<string, string>) };
      } else if (context?.replayingState) {
        this.logger.warn(
          safeMsg`ServiceConfig.EnvironmentVariables must be an object of string values; omitting it while replaying a state record`
        );
      } else {
        fail('ServiceConfig.EnvironmentVariables must be an object of string values');
      }
    }
    const telemetry = service['TelemetryConfig'];
    if (isPlainRecord(telemetry)) {
      const telemetryConfig: TelemetryConfig = {};
      const logging = telemetry['LoggingConfig'];
      if (isPlainRecord(logging)) {
        const loggingConfig: LoggingConfig = {};
        if (typeof logging['LogGroup'] === 'string') loggingConfig.logGroup = logging['LogGroup'];
        if (typeof logging['ApplicationLogLevel'] === 'string') {
          loggingConfig.applicationLogLevel = logging[
            'ApplicationLogLevel'
          ] as LoggingConfig['applicationLogLevel'];
        }
        if (typeof logging['SystemLogLevel'] === 'string') {
          loggingConfig.systemLogLevel = logging[
            'SystemLogLevel'
          ] as LoggingConfig['systemLogLevel'];
        }
        telemetryConfig.loggingConfig = loggingConfig;
      }
      out.telemetryConfig = telemetryConfig;
    }
    return out;
  }

  private async waitForActive(
    functionName: string,
    revisionArn: string,
    logicalId: string
  ): Promise<GetWebFunctionRevisionResponse> {
    for (let attempt = 1; attempt <= LAMBDA_WEB_MAX_POLL_ATTEMPTS; attempt++) {
      const resp = await this.client.send(
        new GetWebFunctionRevisionCommand({ functionName, revisionId: revisionArn })
      );
      if (resp.state === 'Active') return resp;
      if (resp.state === 'Failed') {
        const errors = (resp.errors ?? []).map((e) =>
          `${e.errorCode ?? ''} ${e.errorMessage ?? ''}`.trim()
        );
        throw new Error(
          `Lambda web function revision ${logicalIdShown(logicalId)} entered Failed: ${resp.stateReason ?? 'no reason given'}` +
            (errors.length > 0 ? ` (${errors.join('; ')})` : '')
        );
      }
      await sleep(LAMBDA_WEB_POLL_INTERVAL_MS);
    }
    throw new Error(
      `Lambda web function revision ${logicalIdShown(logicalId)} did not become Active within ` +
        `${(LAMBDA_WEB_MAX_POLL_ATTEMPTS * LAMBDA_WEB_POLL_INTERVAL_MS) / 1000}s.`
    );
  }

  private async waitForGone(
    functionName: string,
    revisionArn: string,
    logicalId: string
  ): Promise<void> {
    for (let attempt = 1; attempt <= LAMBDA_WEB_MAX_POLL_ATTEMPTS; attempt++) {
      try {
        await this.client.send(
          new GetWebFunctionRevisionCommand({ functionName, revisionId: revisionArn })
        );
      } catch (error) {
        if (error instanceof ResourceNotFoundException) return;
        throw error;
      }
      await sleep(LAMBDA_WEB_POLL_INTERVAL_MS);
    }
    throw new Error(
      `Lambda web function revision ${logicalIdShown(logicalId)} was not fully deleted within ` +
        `${(LAMBDA_WEB_MAX_POLL_ATTEMPTS * LAMBDA_WEB_POLL_INTERVAL_MS) / 1000}s.`
    );
  }

  private wrapError(
    operation: string,
    logicalId: string,
    resourceType: string,
    physicalId: string | undefined,
    error: unknown
  ): ProvisioningError {
    if (error instanceof ProvisioningError) return error;
    const cause = error instanceof Error ? error : undefined;
    return new ProvisioningError(
      `Failed to ${operation} Lambda web function revision ${logicalIdShown(logicalId)}: ${error instanceof Error ? error.message : String(error)}`,
      resourceType,
      logicalId,
      physicalId,
      cause
    );
  }
}

function buildAttributes(resp: {
  revisionArn?: string | undefined;
  revisionId?: string | undefined;
  functionArn?: string | undefined;
  state?: string | undefined;
  stateReason?: string | undefined;
  createdAt?: Date | undefined;
}): Record<string, unknown> {
  return definedAttributes({
    RevisionArn: resp.revisionArn,
    RevisionId: resp.revisionId,
    FunctionArn: resp.functionArn,
    State: resp.state,
    StateReason: resp.stateReason,
    CreatedAt: resp.createdAt?.toISOString(),
  });
}

function buildConfigToCfn(config: BuildConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const s3 =
    config.codeConfig && 's3Object' in config.codeConfig ? config.codeConfig.s3Object : undefined;
  if (s3) {
    const S3Object: Record<string, unknown> = { Bucket: s3.bucket, Key: s3.key };
    if (s3.versionId !== undefined) S3Object['VersionId'] = s3.versionId;
    out['CodeConfig'] = { S3Object };
  }
  if (config.runtimeConfig) out['RuntimeConfig'] = { Runtime: config.runtimeConfig.runtime };
  return out;
}

function serviceConfigToCfn(config: ServiceConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { ExecutionRoleArn: config.executionRoleArn };
  if (config.timeoutSeconds !== undefined) out['TimeoutSeconds'] = config.timeoutSeconds;
  if (config.maxConcurrencyPerEnvironment !== undefined) {
    out['MaxConcurrencyPerEnvironment'] = config.maxConcurrencyPerEnvironment;
  }
  if (config.egressNetworkConnectorArn !== undefined) {
    out['EgressNetworkConnectorArn'] = config.egressNetworkConnectorArn;
  }
  if (config.environmentVariables !== undefined) {
    out['EnvironmentVariables'] = { ...config.environmentVariables };
  }
  const logging = config.telemetryConfig?.loggingConfig;
  if (logging) {
    const LoggingConfig: Record<string, unknown> = {};
    if (logging.logGroup !== undefined) LoggingConfig['LogGroup'] = logging.logGroup;
    if (logging.applicationLogLevel !== undefined)
      LoggingConfig['ApplicationLogLevel'] = logging.applicationLogLevel;
    if (logging.systemLogLevel !== undefined)
      LoggingConfig['SystemLogLevel'] = logging.systemLogLevel;
    out['TelemetryConfig'] = { LoggingConfig };
  }
  return out;
}
