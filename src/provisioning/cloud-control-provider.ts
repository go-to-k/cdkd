import { CloudControlClient, type ProgressEvent } from '@aws-sdk/client-cloudcontrol';
import type { AwsAccountInfo } from '../deployment/intrinsic-function-resolver.js';
import { getAwsClients } from '../utils/aws-clients.js';
import {
  ProtectionFlipRegistry,
  type ProtectionFlipRecord,
  type ProtectionGuardSite,
} from './providers/deletion-protection-compensation.js';
import type { EC2Client } from '@aws-sdk/client-ec2';
import { getLogger } from '../utils/logger.js';
import { JsonPatchGenerator } from './json-patch-generator.js';
import type { ApiGatewayV2Reimport } from './apigwv2-body-import-patch.js';
import type { MaskerFn } from './masked-retry-logger.js';
import type { DeleteContext, RegionCheckPhase } from './region-check.js';
import type { CcProtectionEntry } from './cc-protection-properties.js';
import { isNonProvisionable } from './unsupported-types.js';
import type { Logger } from '../types/config.js';
import type {
  CreateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  UpdateContext,
  IndeterminateGuard,
  ResourceNotFound,
} from '../types/resource.js';
import {
  CloudControlWaitAbandonedError,
  type AbandonedRequestOutcome,
} from './cloud-control/shared.js';
import type { ProtectedEc2Instance } from './cloud-control/delete-guards.js';
import { type IdLogSink, IdScrubLog, idLogScope } from './cloud-control/id-log.js';
import { create, createInIdLogScope, cleanupFailedCreateRemnant } from './cloud-control/create.js';
import {
  update,
  updateInIdLogScope,
  reimportApiGatewayV2,
  readApiGatewayV2DefinitionObject,
} from './cloud-control/update.js';
import {
  deleteImpl,
  deleteInIdLogScope,
  deleteThroughCloudControl,
  sdkDeleteDelegateInCcRegion,
  ec2ClientInCcRegion,
} from './cloud-control/delete.js';
import {
  assertRecordedRegionAgainstClient,
  confirmDeleteTargetIdentity,
} from './cloud-control/delete-identity.js';
import {
  disableCcProtection,
  observeThenDisableCcProtection,
  reEnableCcProtection,
  warnGuardLeftOff,
  ccClientRegion,
  getResourceState,
} from './cloud-control/protection.js';
import {
  waitForOperation,
  resumeCreatedResource,
  resumeAbandonedRequest,
  abandonWait,
  buildResumeCommand,
} from './cloud-control/wait.js';
import {
  parseResourceModel,
  accountInfoForSynthesizedArn,
  mergeSparseModelReadback,
  isSparseAttributeMap,
  readCcResourceModel,
  handleError,
  sleep,
  readCurrentState,
  maskDeployedNonAttributeKeys,
} from './cloud-control/read.js';
import { enrichResourceAttributes } from './cloud-control/enrich.js';
import { importImpl, maskUncertifiedModelValues } from './cloud-control/import.js';

export {
  s3RedirectRegion,
  CloudControlOperationFailedError,
  CloudControlWaitAbandonedError,
} from './cloud-control/shared.js';
export type { AbandonedRequestOutcome } from './cloud-control/shared.js';
export { isTransientPollFailure, isNotFoundMessage } from './cloud-control/poll-failure.js';
export {
  CALLER_PRINCIPAL_MASK,
  ACCOUNT_ID_MASK,
  maskCallerIdentity,
  handlerAuthFailureHint,
} from './cloud-control/caller-identity.js';
export {
  requiresCcDeleteIdentityCheck,
  CC_DELETE_REGION_IDENTITY_GUARD,
  deletesThroughSdkProvider,
} from './cloud-control/delete-guards.js';
export { RESUME_COMMAND } from './cloud-control/id-log.js';

export class CloudControlProvider implements ResourceProvider {
  cloudControlClient: CloudControlClient;
  private readonly baseLogger: Logger = getLogger().child('CloudControlProvider');
  /**
   * Inside `create()` / `update()` / `delete()`, that call's
   * {@link IdScrubLog} (go-to-k/cdkd#3869), so every line this provider
   * prints on the call's behalf, helpers included, is scrubbed of a
   * secret-derived identifier; elsewhere the plain logger.
   */
  get logger(): IdLogSink {
    return idLogScope.getStore() ?? this.baseLogger;
  }
  patchGenerator = new JsonPatchGenerator();
  /**
   * Types whose unresolvable-schema import warning has already been printed —
   * see `maskUncertifiedModelValues`. Per-instance so a test cannot inherit
   * another test's suppression.
   */
  readonly warnedUnresolvableSchemaTypes = new Set<string>();
  /**
   * `--remove-protection` flips (the CC protection registry's types and a
   * Cloud Control-routed EC2 instance), keyed so a re-entered delete keeps
   * them (#2204).
   */
  readonly protectionFlips = new ProtectionFlipRegistry();

  // Maximum time to wait for operation completion (15 minutes)
  readonly MAX_WAIT_TIME_MS = 15 * 60 * 1000;
  // Initial poll interval (1 second) - increases with 1.5x exponential backoff
  readonly INITIAL_POLL_INTERVAL_MS = 1_000;
  // Maximum poll interval (10 seconds)
  readonly MAX_POLL_INTERVAL_MS = 10_000;
  /**
   * How long an UNBROKEN run of transient poll failures is tolerated before
   * `waitForOperation` gives up and throws {@link CloudControlWaitAbandonedError}
   * (issue #3236). Reset by any poll that gets an answer, so it measures one
   * outage rather than a session's total flakiness.
   *
   * It is a SECOND bound INSIDE the existing wall-clock budget, never an
   * extension of one: the `while` condition below still holds, so re-polling
   * can only consume time the wait already had. `slow-cc-operation-timeouts.ts`
   * couples that budget to the two outer per-resource deadlines deliberately,
   * and a separate attempt budget able to outlive it would break the coupling.
   *
   * Two minutes because the failures that reach this loop have already
   * outlasted the SDK's own three STANDARD-mode attempts, so the population is
   * outages of seconds to minutes — a VPN reconnect, a DHCP renew, a throttle
   * that needs more than the SDK's sub-second backoff. Waiting the FULL budget
   * instead (up to 60 min for a slow type) would buy nothing the resume hint
   * does not: past this point the operation is equally unreachable, and the
   * user gets the same request token thirteen to fifty-eight minutes sooner.
   */
  readonly POLL_TRANSIENT_GRACE_MS = 2 * 60 * 1000;
  /**
   * The grace `disableCcProtection`'s wait takes instead (issue
   * go-to-k/cdkd#3253 item 1). Its call site carries the reasoning; the short
   * version is that the flip is best-effort and swallowed, so a long wait there
   * is dead wall clock on a destroy that is failing anyway.
   */
  readonly PROTECTION_FLIP_TRANSIENT_GRACE_MS = 10_000;

  /**
   * The SDK provider per family a Cloud Control-routed RDS or Neptune delete
   * goes through (issues #3993, #4029; see {@link deletesThroughSdkProvider}),
   * and the region its client is pinned to. Kept across calls, not built per call:
   * its `--remove-protection` compensation registry latches across a
   * re-entered delete (`deletion-protection-compensation.ts`), which a fresh
   * provider per call would forget.
   */
  readonly sdkDeleteDelegates = new Map<
    'rds' | 'neptune',
    { region: string; provider: ResourceProvider }
  >();

  /**
   * The SDK `ASGProvider` a protected Cloud Control-routed group's delete is
   * delegated to (issue #798), one per {@link ambientRegion} -- the region the
   * delegate binds its clients to at construction, so a call in another region
   * still gets a delegate of its own, as building one per call did. Kept across
   * calls for the reason {@link sdkDeleteDelegates} is (issue #4400): its group
   * and instance `--remove-protection` flip registries latch across a
   * re-entered delete, which a fresh delegate per call would forget.
   */
  readonly asgDeleteDelegates = new Map<string | undefined, ResourceProvider>();

  constructor() {
    const awsClients = getAwsClients();
    this.cloudControlClient = awsClients.cloudControl;
  }

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  createInIdLogScope(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    idLog: IdScrubLog,
    mask: MaskerFn
  ): Promise<ResourceCreateResult> {
    return createInIdLogScope.call(this, logicalId, resourceType, properties, idLog, mask);
  }

  cleanupFailedCreateRemnant(
    error: unknown,
    resourceType: string,
    logicalId: string,
    // The create's masker, forwarded to the remnant's delete (go-to-k/cdkd#2007).
    mask: MaskerFn
  ): Promise<void> {
    return cleanupFailedCreateRemnant.call(this, error, resourceType, logicalId, mask);
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

  updateInIdLogScope(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context: UpdateContext | undefined,
    idLog: IdScrubLog
  ): Promise<ResourceUpdateResult> {
    return updateInIdLogScope.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context,
      idLog
    );
  }

  reimportApiGatewayV2(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    reimport: ApiGatewayV2Reimport
  ): Promise<void> {
    return reimportApiGatewayV2.call(this, logicalId, physicalId, resourceType, reimport);
  }

  readApiGatewayV2DefinitionObject(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    location: unknown
  ): Promise<string> {
    return readApiGatewayV2DefinitionObject.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      location
    );
  }

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  deleteInIdLogScope(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown> | undefined,
    context: DeleteContext | undefined
  ): Promise<void | ResourceDeleteResult> {
    return deleteInIdLogScope.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  deleteThroughCloudControl(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context: DeleteContext | undefined,
    indeterminateGuard: IndeterminateGuard | undefined,
    flip: ProtectionFlipRecord | undefined,
    protectedEc2: ProtectedEc2Instance | undefined
  ): Promise<void | ResourceDeleteResult> {
    return deleteThroughCloudControl.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      context,
      indeterminateGuard,
      flip,
      protectedEc2
    );
  }

  sdkDeleteDelegateInCcRegion(
    resourceType: string,
    logicalId: string,
    physicalId: string
  ): Promise<ResourceProvider> {
    return sdkDeleteDelegateInCcRegion.call(this, resourceType, logicalId, physicalId);
  }

  ec2ClientInCcRegion(
    resourceType: string,
    logicalId: string,
    physicalId: string
  ): Promise<EC2Client> {
    return ec2ClientInCcRegion.call(this, resourceType, logicalId, physicalId);
  }

  assertRecordedRegionAgainstClient(
    phase: RegionCheckPhase,
    expectedRegion: string | undefined,
    resourceType: string,
    logicalId: string,
    physicalId: string
  ): Promise<void> {
    return assertRecordedRegionAgainstClient.call(
      this,
      phase,
      expectedRegion,
      resourceType,
      logicalId,
      physicalId
    );
  }

  confirmDeleteTargetIdentity(
    logicalId: string,
    resourceType: string,
    physicalId: string,
    context?: DeleteContext
  ): Promise<IndeterminateGuard | undefined> {
    return confirmDeleteTargetIdentity.call(this, logicalId, resourceType, physicalId, context);
  }

  disableCcProtection(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    entry: CcProtectionEntry
  ): Promise<boolean> {
    return disableCcProtection.call(this, logicalId, physicalId, resourceType, entry);
  }

  observeThenDisableCcProtection(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    entry: CcProtectionEntry,
    flip: ProtectionFlipRecord,
    mask: MaskerFn | undefined
  ): Promise<void> {
    return observeThenDisableCcProtection.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      entry,
      flip,
      mask
    );
  }

  reEnableCcProtection(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    entry: CcProtectionEntry
  ): Promise<void> {
    return reEnableCcProtection.call(this, logicalId, physicalId, resourceType, entry);
  }

  warnGuardLeftOff(
    flip: ProtectionFlipRecord,
    error: unknown,
    site: ProtectionGuardSite,
    logicalId: string,
    physicalId: string
  ): void {
    return warnGuardLeftOff.call(this, flip, error, site, logicalId, physicalId);
  }

  ccClientRegion(): Promise<string | undefined> {
    return ccClientRegion.call(this);
  }

  getResourceState(
    resourceType: string,
    physicalId: string
  ): Promise<Record<string, unknown> | null> {
    return getResourceState.call(this, resourceType, physicalId);
  }

  waitForOperation(
    requestToken: string,
    logicalId: string,
    operation: 'CREATE' | 'UPDATE' | 'DELETE',
    resourceType: string,
    /**
     * Per-call override of {@link POLL_TRANSIENT_GRACE_MS}. Only the
     * `--remove-protection` flip and its compensation (`disableCcProtection`,
     * `reEnableCcProtection`) pass one; every provisioning call site takes the
     * default, and a new one should have to say why it does not.
     */
    transientGraceMs: number = this.POLL_TRANSIENT_GRACE_MS
  ): Promise<ProgressEvent> {
    return waitForOperation.call(
      this,
      requestToken,
      logicalId,
      operation,
      resourceType,
      transientGraceMs
    );
  }

  resumeCreatedResource(
    logicalId: string,
    resourceType: string,
    identifier: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return resumeCreatedResource.call(
      this,
      logicalId,
      resourceType,
      identifier,
      properties,
      context
    );
  }

  resumeAbandonedRequest(
    requestToken: string,
    logicalId: string,
    resourceType: string
  ): Promise<AbandonedRequestOutcome> {
    return resumeAbandonedRequest.call(this, requestToken, logicalId, resourceType);
  }

  abandonWait(
    requestToken: string,
    logicalId: string,
    operation: 'CREATE' | 'UPDATE' | 'DELETE',
    resourceType: string,
    lastSeenIdentifier: string | undefined,
    reason: string,
    cause: unknown
  ): Promise<CloudControlWaitAbandonedError> {
    return abandonWait.call(
      this,
      requestToken,
      logicalId,
      operation,
      resourceType,
      lastSeenIdentifier,
      reason,
      cause
    );
  }

  buildResumeCommand(requestToken: string): Promise<string> {
    return buildResumeCommand.call(this, requestToken);
  }

  parseResourceModel(resourceModel: string, log: IdLogSink = this.logger): Record<string, unknown> {
    return parseResourceModel.call(this, resourceModel, log);
  }

  accountInfoForSynthesizedArn(
    resourceType: string,
    attributeName: string,
    physicalId: string,
    log: IdLogSink = this.logger
  ): Promise<AwsAccountInfo | undefined> {
    return accountInfoForSynthesizedArn.call(this, resourceType, attributeName, physicalId, log);
  }

  enrichResourceAttributes(
    resourceType: string,
    physicalId: string,
    attributes: Record<string, unknown>,
    log: IdLogSink = this.logger
  ): Promise<Record<string, unknown>> {
    return enrichResourceAttributes.call(this, resourceType, physicalId, attributes, log);
  }

  mergeSparseModelReadback(
    resourceType: string,
    physicalId: string,
    attributes: Record<string, unknown>,
    log: IdLogSink = this.logger
  ): Promise<Record<string, unknown>> {
    return mergeSparseModelReadback.call(this, resourceType, physicalId, attributes, log);
  }

  isSparseAttributeMap(attributes: Record<string, unknown>, physicalId: string): boolean {
    return isSparseAttributeMap.call(this, attributes, physicalId);
  }

  readCcResourceModel(
    resourceType: string,
    physicalId: string,
    log: IdLogSink = this.logger
  ): Promise<Record<string, unknown> | undefined> {
    return readCcResourceModel.call(this, resourceType, physicalId, log);
  }

  handleError(
    error: unknown,
    operation: string,
    resourceType: string,
    logicalId: string,
    physicalId?: string
  ): never {
    return handleError.call(this, error, operation, resourceType, logicalId, physicalId);
  }

  sleep(ms: number): Promise<void> {
    return sleep.call(this, ms);
  }

  /**
   * Check if a resource type is supported by Cloud Control API
   *
   * This is a best-effort check. Some resource types may still fail
   * even if they appear to be supported.
   */
  static isSupportedResourceType(resourceType: string): boolean {
    // Common resource types that are NOT supported by Cloud Control API
    const unsupportedTypes = new Set([
      // IAM (most types not supported by Cloud Control; cdkd ships SDK
      // providers for these instead).
      'AWS::IAM::Role',
      'AWS::IAM::Policy',
      'AWS::IAM::User',
      'AWS::IAM::Group',
      'AWS::IAM::InstanceProfile',

      // Lambda layers
      'AWS::Lambda::LayerVersion',

      // S3 bucket policies (use SDK instead)
      'AWS::S3::BucketPolicy',

      // CloudFormation-specific resources
      'AWS::CloudFormation::Stack',
      'AWS::CloudFormation::WaitCondition',
      'AWS::CloudFormation::WaitConditionHandle',
      'AWS::CloudFormation::CustomResource',

      // CDK-specific resources
      'AWS::CDK::Metadata',
      'Custom::CDKBucketDeployment',
      'Custom::S3AutoDeleteObjects',
    ]);

    if (unsupportedTypes.has(resourceType)) {
      return false;
    }

    // Custom resources are never supported by Cloud Control
    if (
      resourceType.startsWith('Custom::') ||
      resourceType.startsWith('AWS::CloudFormation::CustomResource')
    ) {
      return false;
    }

    // AWS-declared NON_PROVISIONABLE (provider-coverage tier3): AWS itself
    // reports that Cloud Control cannot create/update/delete these, and cdkd
    // has no SDK provider for them. Reject so pre-flight fails fast with an
    // actionable message instead of letting the optimistic fallthrough below
    // reach an opaque mid-deploy Cloud Control CreateResource failure.
    if (isNonProvisionable(resourceType)) {
      return false;
    }

    // Most other AWS:: resources should be supported
    // (This is optimistic; some may still fail)
    return resourceType.startsWith('AWS::');
  }

  readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, resourceType, _properties);
  }

  maskDeployedNonAttributeKeys(
    attributes: Record<string, unknown>,
    modelKeys: readonly string[],
    resourceType: string,
    physicalId: string,
    attributeNamesLookup: Promise<ReadonlySet<string> | undefined>,
    desired: Record<string, unknown>,
    mask: MaskerFn,
    log: IdLogSink = this.logger
  ): Promise<Record<string, unknown>> {
    return maskDeployedNonAttributeKeys.call(
      this,
      attributes,
      modelKeys,
      resourceType,
      physicalId,
      attributeNamesLookup,
      desired,
      mask,
      log
    );
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }

  maskUncertifiedModelValues(
    model: Record<string, unknown>,
    resourceType: string,
    physicalId: string
  ): Promise<Record<string, unknown>> {
    return maskUncertifiedModelValues.call(this, model, resourceType, physicalId);
  }
}
