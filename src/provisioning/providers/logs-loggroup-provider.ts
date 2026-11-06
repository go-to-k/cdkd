import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { STSClient } from '@aws-sdk/client-sts';
import type { MaskerFn } from '../masked-retry-logger.js';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type { DeleteContext } from '../region-check.js';
import {
  ProtectionFlipRegistry,
  type ProtectionFlipRecord,
} from './deletion-protection-compensation.js';
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
import {
  wrapCaughtError,
  generatedCreateName,
  holderCreatedAt,
  lookupNames,
} from './logs-loggroup/core.js';
import { create } from './logs-loggroup/create.js';
import { update, applyUpdate } from './logs-loggroup/update.js';
import { deleteImpl, deleteOnce, logGoneOnDelete } from './logs-loggroup/delete.js';
import {
  isSameResource,
  resourceIdentity,
  readIdentityIfExists,
  buildArn,
} from './logs-loggroup/identity.js';
import { getAttribute, readCurrentState } from './logs-loggroup/read-state.js';
import { importImpl } from './logs-loggroup/import.js';

/**
 * AWS CloudWatch Logs LogGroup Provider
 *
 * Implements resource provisioning for AWS::Logs::LogGroup using the CloudWatch Logs SDK.
 * WHY: CreateLogGroup is synchronous - the CC API adds unnecessary polling overhead
 * (1s->2s->4s->8s) for an operation that completes immediately.
 */
export class LogsLogGroupProvider implements ResourceProvider {
  logsClient: CloudWatchLogsClient;
  stsClient: STSClient;
  logger: ConsoleLogger = getLogger().child('LogsLogGroupProvider');
  /** `--remove-protection` flips, keyed so a re-entered delete keeps them (#2204). */
  readonly protectionFlips = new ProtectionFlipRegistry();

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Logs::LogGroup',
      new Set([
        'LogGroupName',
        'KmsKeyId',
        'RetentionInDays',
        'Tags',
        'DataProtectionPolicy',
        'LogGroupClass',
        'FieldIndexPolicies',
        'DeletionProtectionEnabled',
        'BearerTokenAuthenticationEnabled',
      ]),
    ],
  ]);

  /**
   * Issue #1412. `ResourcePolicyDocument` used to sit in
   * {@link handledProperties} purely to keep the log group off the Cloud
   * Control fallback path — but nothing ever wired it, so a template setting
   * it deployed "successfully" with the policy silently discarded (the
   * #1392 silent-drop class, which the sdk-wire harness now catches).
   *
   * It is not wired from here, by decision (issue #1412), not for lack of an
   * API. When #1412 was decided, the only CloudWatch Logs counterpart was the
   * ACCOUNT-scoped `PutResourcePolicy` behind the separate
   * `AWS::Logs::ResourcePolicy` type, keyed by a policy NAME rather than by the
   * log group. Owning it from the log group's lifecycle would have meant
   * inventing which name to claim, what to do on delete when the policy may be
   * shared, and how to resolve two log groups declaring conflicting documents.
   *
   * The API has since gained a log-group-scoped form: `PutResourcePolicy` /
   * `DescribeResourcePolicies` / `DeleteResourcePolicy` take `resourceArn` and
   * `policyScope: 'RESOURCE'` (present in `@aws-sdk/client-cloudwatch-logs`
   * 3.1156.0), with an `expectedRevisionId` handshake on writes. That removes
   * the account-wide objection, but adopting it is a separate decision: this
   * provider would then own a second resource's create / update / delete and
   * revision handling. It is not taken here. (That #1412 predates the
   * resource-scoped form is an inference from its wording, not a recorded
   * fact.) Managing the sibling `AWS::Logs::ResourcePolicy` resource stays
   * option 1 in issue #1412, deliberately not attempted.
   *
   * `tests/integration/sdk-to-cc-autoroute/` rests on this drop (issue
   * #5524): wiring the property ends that fixture's premise, which its step 0
   * reports by name.
   *
   * Declaring the drop instead makes the omission visible: the #614 routing
   * pass sends any log group whose template sets `ResourcePolicyDocument`
   * through the Cloud Control fallback, where AWS's own resource handler
   * applies the policy. This provider does NOT set `disableCcApiFallback`,
   * so that route is always available and no template is hard-rejected.
   */
  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::Logs::LogGroup',
      new Map<string, string>([
        [
          'ResourcePolicyDocument',
          'not driven by this provider by decision (issue #1412): no CreateLogGroup / PutRetentionPolicy member carries it, and both policy lifecycles — the account-scoped AWS::Logs::ResourcePolicy type and the log-group-scoped logs:PutResourcePolicy (resourceArn + policyScope RESOURCE) — are ones this provider does not take on — routed via Cloud Control, whose handler applies it',
        ],
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.logsClient = awsClients.cloudWatchLogs;
    this.stsClient = awsClients.sts;
  }

  wrapCaughtError(
    mask: MaskerFn,
    error: unknown,
    build: (maskedText: string) => ProvisioningError
  ): ProvisioningError {
    return wrapCaughtError.call(this, mask, error, build);
  }

  generatedCreateName(
    _resourceType: string,
    logicalId: string,
    properties: Record<string, unknown>
  ): string | undefined {
    return generatedCreateName.call(this, _resourceType, logicalId, properties);
  }

  holderCreatedAt(_resourceType: string, physicalId: string): Promise<number | undefined> {
    return holderCreatedAt.call(this, _resourceType, physicalId);
  }

  lookupNames(_resourceType: string, names: readonly string[]): Promise<Map<string, string>> {
    return lookupNames.call(this, _resourceType, names);
  }

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    callerContext?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return update.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      callerContext
    );
  }

  applyUpdate(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return applyUpdate.call(
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
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, _properties, context);
  }

  deleteOnce(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context: DeleteContext | undefined,
    flip: ProtectionFlipRecord
  ): Promise<void> {
    return deleteOnce.call(this, logicalId, physicalId, resourceType, context, flip);
  }

  logGoneOnDelete(logicalId: string, physicalId: string, context: DeleteContext | undefined): void {
    return logGoneOnDelete.call(this, logicalId, physicalId, context);
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

  readIdentityIfExists(
    name: string
  ): Promise<{ arn: string; creationTime: number | undefined } | undefined> {
    return readIdentityIfExists.call(this, name);
  }

  buildArn(logGroupName: string): Promise<string> {
    return buildArn.call(this, logGroupName);
  }

  getAttribute(physicalId: string, _resourceType: string, attributeName: string): Promise<unknown> {
    return getAttribute.call(this, physicalId, _resourceType, attributeName);
  }

  readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, _resourceType);
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }
}
