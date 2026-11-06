import {
  LambdaClient,
  type FunctionConfiguration,
  type FunctionScalingConfig,
  type FunctionCode,
  type VpcConfig,
} from '@aws-sdk/client-lambda';
import { EC2Client } from '@aws-sdk/client-ec2';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { LambdaCreateClientCache } from './lambda-create-client.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type { DeleteContext } from '../region-check.js';
import type {
  CreateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  UpdateContext,
  ResourceNotFound,
  ResourceIdentityVerdict,
} from '../../types/resource.js';
import type { MaskedLogSinks } from '../masked-retry-logger.js';
import {
  create,
  applyPostCreateConfig,
  putRuntimeManagementConfig,
  waitForLatestPublishedSettled,
  putFunctionScalingConfig,
} from './lambda-function/create.js';
import { wrapMaskedError, wrapStatusReasonError } from './lambda-function/errors.js';
import {
  update,
  applyTagDiff,
  waitForFunctionUpdated,
  waitForLambdaUpdateCompleted,
} from './lambda-function/update.js';
import {
  deleteImpl,
  waitForFunctionGone,
  cleanupLambdaEnis,
  deleteEniWithRetry,
  listLambdaEnis,
  logFunctionGone,
} from './lambda-function/delete.js';
import {
  buildVpcConfig,
  buildVpcConfigForUpdate,
  normalizeEnvironmentForUpdate,
  hasVpcConfig,
} from './lambda-function/vpc.js';
import { buildCode, createZipFromInlineCode, crc32 } from './lambda-function/code.js';
import {
  isSameResource,
  resourceIdentity,
  readFunctionIfExists,
  getAttribute,
  importImpl,
} from './lambda-function/identity.js';
import {
  readUnsettled,
  unsettledInTransition,
  readCurrentState,
} from './lambda-function/read-state.js';
export { inlineCodeFileNameForRuntime } from './lambda-function/shared.js';

/**
 * AWS Lambda Function Provider
 *
 * Implements resource provisioning for AWS::Lambda::Function using the Lambda SDK.
 * WHY: Lambda CreateFunction is synchronous - the CC API adds unnecessary polling
 * overhead (1s->2s->4s->8s) for an operation that completes immediately.
 * This SDK provider eliminates that polling and returns instantly.
 */
export class LambdaFunctionProvider implements ResourceProvider {
  lambdaClient: LambdaClient;
  /** `CreateFunction` goes through this client, which refuses the SDK retry of a 5xx (issue #4639). */
  readonly createClient = new LambdaCreateClientCache(() => this.lambdaClient);
  ec2Client: EC2Client;
  logger: ConsoleLogger = getLogger().child('LambdaFunctionProvider');
  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Lambda::Function',
      new Set([
        'FunctionName',
        'Code',
        'Role',
        'Tags',
        'Handler',
        'Runtime',
        'Timeout',
        'MemorySize',
        'Description',
        'Environment',
        'Layers',
        'Architectures',
        'PackageType',
        'TracingConfig',
        'EphemeralStorage',
        'VpcConfig',
        'DeadLetterConfig',
        'KmsKeyArn',
        'FileSystemConfigs',
        'ImageConfig',
        'SnapStart',
        'LoggingConfig',
        'RecursiveLoop',
        'ReservedConcurrentExecutions',
        'CodeSigningConfigArn',
        'RuntimeManagementConfig',
        'DurableConfig',
        'TenancyConfig',
        'CapacityProviderConfig',
        'FunctionScalingConfig',
        'PublishToLatestPublished',
      ]),
    ],
  ]);

  /**
   * Issue #1160 (`ResourceProvider.removalDefaults`): the CFn default each
   * UpdateFunctionConfiguration field is reset to when the template removes
   * it, since an absent field there means "no change" (#1155, #1157).
   */
  removalDefaults = new Map<string, ReadonlyMap<string, unknown>>([
    [
      'AWS::Lambda::Function',
      new Map<string, unknown>([
        ['Timeout', 3],
        ['MemorySize', 128],
        // Empty string clears the description.
        ['Description', ''],
        // Empty Variables map removes all env vars (the whole-block removal
        // twin of the per-key removal the diff already handles).
        ['Environment', { Variables: {} }],
        // Empty list detaches all layers.
        ['Layers', []],
        ['TracingConfig', { Mode: 'PassThrough' }],
        ['EphemeralStorage', { Size: 512 }],
        // Empty TargetArn detaches the DLQ.
        ['DeadLetterConfig', { TargetArn: '' }],
        // Empty string resets to the AWS-managed default key.
        ['KmsKeyArn', ''],
        // Empty list removes all EFS mounts.
        ['FileSystemConfigs', []],
        // Empty object resets container image overrides to the image defaults.
        ['ImageConfig', {}],
        // ApplyOn: 'None' disables SnapStart.
        ['SnapStart', { ApplyOn: 'None' }],
        // LogFormat: 'Text' is the CFn default (Text format clears the
        // JSON-only ApplicationLogLevel / SystemLogLevel filters).
        ['LoggingConfig', { LogFormat: 'Text' }],
      ]),
    ],
  ]);

  /**
   * Issue #1160 (`ResourceProvider.removalHandledInUpdate`): every other
   * property whose removal `update()` handles. `RecursiveLoop` is absent on
   * purpose: a removal keeps its live value, so the caller names it.
   */
  removalHandledInUpdate = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Lambda::Function',
      new Set([
        // Required, or create-only (a removal replaces the function).
        'Code',
        'Role',
        'Handler',
        'Runtime',
        'FunctionName',
        'PackageType',
        'TenancyConfig',
        // A presence toggle is routed to replacement (replacement-rules.ts).
        'DurableConfig',
        // Diffed, or reset by their own call.
        'Tags',
        'Architectures',
        'VpcConfig',
        'ReservedConcurrentExecutions',
        'CodeSigningConfigArn',
        'RuntimeManagementConfig',
        // Lambda Managed Instances: a removal is refused, reset by its own
        // call, or (the publish flag) back to its default.
        'CapacityProviderConfig',
        'FunctionScalingConfig',
        'PublishToLatestPublished',
      ]),
    ],
  ]);

  // ENI detach polling configuration (overridable for tests).
  // Lambda VPC ENI detach is async and can take 20-40 minutes in the worst case;
  // we poll up to 10 minutes and then warn-and-continue, since downstream Subnet/SG
  // deletion has its own retry logic that handles a small remaining window.
  // Budget for waiting on UpdateFunctionConfiguration to fully apply
  // (LastUpdateStatus -> Successful) after pre-delete VPC detach.
  // Cleanup-delete retry budget for `applyPostCreateConfig` (see there): a
  // function that is still `Pending` rejects DeleteFunction, so the atomicity
  // cleanup needs a few bounded attempts rather than one shot. Overridable in
  // tests so the retry path costs no wall-clock.
  readonly cleanupDeleteRetryDelayMs: number = 2000;

  readonly eniWaitTimeoutMs: number = 10 * 60 * 1000;
  readonly eniWaitInitialDelayMs: number = 10_000;
  readonly eniWaitMaxDelayMs: number = 10_000;

  // Budget for the post-Update wait that blocks until LastUpdateStatus
  // === 'Successful'. Required to prevent the SECOND in-flight call (e.g.
  // UpdateFunctionCode immediately after UpdateFunctionConfiguration)
  // from racing the first with "function is currently in the following
  // state: InProgress". Update typically settles in seconds; the 10-min
  // cap is generous slack for layer-update / VPC-detach edge cases.
  // Seconds (the SDK waiter contract is seconds, not ms).
  //
  // The post-CreateFunction `State=Active` wait used to live here too
  // (PR #121) but doubled deploy time on benchmark stacks because every
  // Lambda paid the cost regardless of whether anything synchronously
  // invoked it. The Active wait now lives in `CustomResourceProvider`
  // (the only deploy-time consumer that breaks against Pending).
  readonly functionUpdateMaxWaitSeconds: number = 10 * 60;
  readonly latestPublishedPollMs: number = 3000;
  readonly latestPublishedDeadlineMarginMs: number = 15_000;

  // delstack-style ENI cleanup tunables.
  // - initial sleep: gives AWS time to publish post-detach ENI state via
  //   DescribeNetworkInterfaces (right after the update, the API can return
  //   an empty list even though ENIs still exist).
  // - per-ENI retry budget: an in-use ENI cannot be deleted until AWS
  //   finishes the asynchronous detach. AWS's hyperplane ENI release is
  //   eventually-consistent and can take 5-30 minutes in practice — the
  //   budget here must cover that worst case so downstream Subnet/SG
  //   deletes don't race ahead and fail with "has dependencies".
  // - retry interval: polling cadence inside the per-ENI loop.
  readonly eniInitialSleepMs: number = 10_000;
  readonly eniDeleteRetryBudgetMs: number = 30 * 60 * 1000;
  readonly eniDeleteRetryIntervalMs: number = 15_000;
  // - deadline margin: the per-ENI budget also ends this long before the
  //   per-resource deadline (#5276). The budget alone equals the default
  //   deadline, which also covers the detach and the delete, so without it a
  //   slow release failed the delete instead of reaching the give-up.
  readonly eniDeadlineMarginMs: number = 2 * 60 * 1000;

  constructor() {
    const awsClients = getAwsClients();
    this.lambdaClient = awsClients.lambda;
    this.ec2Client = awsClients.ec2;
  }

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  wrapMaskedError(
    log: MaskedLogSinks,
    error: unknown,
    build: (maskedText: string) => ProvisioningError
  ): ProvisioningError {
    return wrapMaskedError.call(this, log, error, build);
  }

  applyPostCreateConfig(
    send: () => Promise<unknown>,
    ctx: {
      apiName: string;
      propertyName: string;
      logicalId: string;
      resourceType: string;
      functionName: string;
      /** The create operation's sinks (issue #2177): every line below goes through them. */
      log: MaskedLogSinks;
      /** Set `deleted` once the atomicity cleanup's DeleteFunction succeeded (#4583). */
      cleanup: { deleted: boolean };
      /** A Managed Instances function: the cleanup waits until it is gone. */
      awaitGone: boolean;
    }
  ): Promise<void> {
    return applyPostCreateConfig.call(this, send, ctx);
  }

  putRuntimeManagementConfig(functionName: string, config: Record<string, unknown>): Promise<void> {
    return putRuntimeManagementConfig.call(this, functionName, config);
  }

  waitForLatestPublishedSettled(
    target: { logicalId: string; resourceType: string; functionName: string },
    log: MaskedLogSinks,
    phase: 'before' | 'after'
  ): Promise<void> {
    return waitForLatestPublishedSettled.call(this, target, log, phase);
  }

  wrapStatusReasonError(
    target: { logicalId: string; resourceType: string; functionName: string },
    log: MaskedLogSinks,
    cfg: FunctionConfiguration
  ): ProvisioningError {
    return wrapStatusReasonError.call(this, target, log, cfg);
  }

  putFunctionScalingConfig(
    target: { logicalId: string; resourceType: string; functionName: string },
    log: MaskedLogSinks,
    config: FunctionScalingConfig | undefined
  ): Promise<void> {
    return putFunctionScalingConfig.call(this, target, log, config);
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

  waitForFunctionGone(
    target: { logicalId: string; resourceType: string; functionName: string },
    log: MaskedLogSinks
  ): Promise<void> {
    return waitForFunctionGone.call(this, target, log);
  }

  buildVpcConfig(raw: unknown): VpcConfig | undefined {
    return buildVpcConfig.call(this, raw);
  }

  buildVpcConfigForUpdate(newRaw: unknown, previousRaw: unknown): VpcConfig | undefined {
    return buildVpcConfigForUpdate.call(this, newRaw, previousRaw);
  }

  normalizeEnvironmentForUpdate(
    environment: { Variables?: Record<string, string> } | undefined
  ): { Variables?: Record<string, string> } | undefined {
    return normalizeEnvironmentForUpdate.call(this, environment);
  }

  hasVpcConfig(raw: unknown): boolean {
    return hasVpcConfig.call(this, raw);
  }

  applyTagDiff(
    functionArn: string | undefined,
    functionName: string,
    resourceType: string,
    logicalId: string,
    oldTagsRaw: unknown,
    newTagsRaw: unknown,
    log: MaskedLogSinks,
    unsettled?: { forceUpsert: boolean; beforeWrite: () => void }
  ): Promise<void> {
    return applyTagDiff.call(
      this,
      functionArn,
      functionName,
      resourceType,
      logicalId,
      oldTagsRaw,
      newTagsRaw,
      log,
      unsettled
    );
  }

  waitForFunctionUpdated(
    logicalId: string,
    resourceType: string,
    functionName: string,
    log: MaskedLogSinks
  ): Promise<void> {
    return waitForFunctionUpdated.call(this, logicalId, resourceType, functionName, log);
  }

  waitForLambdaUpdateCompleted(functionName: string): Promise<void> {
    return waitForLambdaUpdateCompleted.call(this, functionName);
  }

  cleanupLambdaEnis(functionName: string, deadline: number): Promise<void> {
    return cleanupLambdaEnis.call(this, functionName, deadline);
  }

  deleteEniWithRetry(eniId: string, functionName: string, deadline: number): Promise<void> {
    return deleteEniWithRetry.call(this, eniId, functionName, deadline);
  }

  listLambdaEnis(functionName: string): Promise<{ id: string; status: string }[]> {
    return listLambdaEnis.call(this, functionName);
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  buildCode(code: Record<string, unknown>, runtime: string | undefined): FunctionCode {
    return buildCode.call(this, code, runtime);
  }

  createZipFromInlineCode(code: string, runtime: string | undefined): Uint8Array {
    return createZipFromInlineCode.call(this, code, runtime);
  }

  crc32(data: Buffer): number {
    return crc32.call(this, data);
  }

  logFunctionGone(logicalId: string, physicalId: string, context: DeleteContext | undefined): void {
    return logFunctionGone.call(this, logicalId, physicalId, context);
  }

  isSameResource(
    journaledPhysicalId: string,
    record: { physicalId: string },
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<ResourceIdentityVerdict> {
    return isSameResource.call(this, journaledPhysicalId, record, resourceType, context);
  }

  resourceIdentity(
    physicalId: string,
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<string | ResourceNotFound | undefined> {
    return resourceIdentity.call(this, physicalId, resourceType, context);
  }

  readFunctionIfExists(
    functionName: string
  ): Promise<{ arn: string; lastModified: string | undefined } | undefined> {
    return readFunctionIfExists.call(this, functionName);
  }

  getAttribute(physicalId: string, _resourceType: string, attributeName: string): Promise<unknown> {
    return getAttribute.call(this, physicalId, _resourceType, attributeName);
  }

  readUnsettled(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    names: ReadonlySet<string>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readUnsettled.call(this, physicalId, logicalId, resourceType, names);
  }

  unsettledInTransition(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    names: ReadonlySet<string>
  ): Promise<ReadonlySet<string>> {
    return unsettledInTransition.call(this, physicalId, _logicalId, _resourceType, names);
  }

  readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, _resourceType);
  }

  /**
   * Lambda ZIP-package `Code` sub-paths AWS does not return on read.
   *
   * `GetFunction` returns a pre-signed S3 URL for ZIP-deployed code
   * (`Code.Location`), not the original `S3Bucket` / `S3Key` cdkd state
   * holds. `ZipFile` is inline source that AWS never echoes back. These
   * three fields are write-only via the GetFunction API (Category 1).
   *
   * `Code.ImageUri` IS recoverable — `GetFunction.Code.ImageUri` returns
   * the templated image URI for container Lambdas — so it is surfaced by
   * `readCurrentState` and NOT declared drift-unknown. `Code.SourceKMSKeyArn`
   * does come back (`FunctionCodeLocation.SourceKMSKeyArn`) but
   * `readCurrentState` does not surface it yet, so it stays skipped here.
   * `Code.S3ObjectStorageMode` has no member on that read shape at all.
   *
   * Pre-PR this method returned the whole `['Code']` subtree as
   * drift-unknown, which also hid `Code.ImageUri` drift on container
   * Lambdas. Narrowing the skip-list re-enables that detection.
   */
  getDriftUnknownPaths(): string[] {
    return [
      'Code.S3Bucket',
      'Code.S3Key',
      'Code.S3ObjectVersion',
      'Code.S3ObjectStorageMode',
      'Code.ZipFile',
      'Code.SourceKMSKeyArn',
      // A write-only directive: no read returns it.
      'PublishToLatestPublished',
    ];
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }
}
