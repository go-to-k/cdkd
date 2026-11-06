import { LambdaClient } from '@aws-sdk/client-lambda';
import {
  ElasticLoadBalancingV2Client,
  type Action,
  type Certificate,
  type TargetDescription,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import type { RetryLogger } from '../../deployment/retry.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type { DeleteContext } from '../region-check.js';
import type { MaskerFn } from '../masked-retry-logger.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  UpdateContext,
  SecretMasker,
  ResourceNotFound,
  ResourceIdentityVerdict,
} from '../../types/resource.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import {
  ProtectionFlipRegistry,
  type ProtectionFlipRecord,
} from './deletion-protection-compensation.js';
import {
  wrapCaughtError,
  getClient,
  waitForLambdaTargetsActive,
  maskedRetryLogger,
  maskErrorMessage,
  cleanupFailureText,
  isDeleteTargetGone,
  logDeleteTargetGone,
  create,
  update,
  applyUpdate,
  deleteImpl,
  isSameResource,
  readElbv2ArnIfExists,
  isNotFoundError,
} from './elbv2/core.js';
import {
  createLoadBalancer,
  waitForCapacityReservationProvisioned,
  deleteLoadBalancer,
  deleteLoadBalancerOnce,
} from './elbv2/load-balancer.js';
import { updateLoadBalancer } from './elbv2/load-balancer-update.js';
import { createTargetGroup, updateTargetGroup, deleteTargetGroup } from './elbv2/target-group.js';
import {
  listenerPortHeld,
  createListener,
  updateListener,
  deleteListener,
} from './elbv2/listener.js';
import {
  normalizeAttributes,
  diffAttributes,
  diffAttributeBag,
  readUpdateTargets,
  applyTagDiff,
  convertActions,
  convertCertificates,
} from './elbv2/attributes.js';
import {
  readCurrentState,
  readLoadBalancer,
  readTargetGroup,
  attachRegisteredTargets,
  getDriftUnknownPaths,
  getDriftUnorderedPaths,
  canonicalizeDriftPair,
  readListener,
  attachTags,
} from './elbv2/read-state.js';
import {
  generatedCreateName,
  holderCreatedAt,
  lookupNames,
  importImpl,
  importLoadBalancer,
  importTargetGroup,
} from './elbv2/import.js';
import { LISTENER_LEFT_IN_PLACE_ON_REMOVAL } from './elbv2/shared.js';
export { capacityReservationDelays, loadBalancerProtectionSite } from './elbv2/shared.js';

/**
 * AWS ELBv2 Provider
 *
 * Implements resource provisioning for ELBv2 resources:
 * - AWS::ElasticLoadBalancingV2::LoadBalancer
 * - AWS::ElasticLoadBalancingV2::TargetGroup
 * - AWS::ElasticLoadBalancingV2::Listener
 *
 * WHY: ELBv2 Create* APIs are synchronous - the CC API adds unnecessary polling
 * overhead for operations that complete immediately. This SDK provider eliminates
 * that polling.
 *
 * "The API is synchronous" is NOT the same claim as "the resource is ready",
 * and an earlier version of this comment conflated the two. TargetGroup and
 * Listener genuinely are ready on return; a LoadBalancer comes back with
 * `State.Code: provisioning` and is not servable for another 90-180s. So
 * createLoadBalancer waits for `active` (skippable with --no-wait) while the
 * other two do not.
 */

export class ELBv2Provider implements ResourceProvider {
  elbv2Client?: ElasticLoadBalancingV2Client;

  readonly providerRegion = ambientRegion();

  logger: ConsoleLogger = getLogger().child('ELBv2Provider');

  wrapCaughtError(
    mask: MaskerFn,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    return wrapCaughtError.call(this, mask, error, build);
  }

  /** `--remove-protection` flips per load balancer, kept across `delete()` re-entry (#2204). */
  readonly protectionFlips = new ProtectionFlipRegistry();

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      new Set([
        'Name',
        'Subnets',
        'SubnetMappings',
        'SecurityGroups',
        'Scheme',
        'Type',
        'IpAddressType',
        'LoadBalancerAttributes',
        'Tags',
        'EnablePrefixForIpv6SourceNat',
        'EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic',
        'Ipv4IpamPoolId',
        'MinimumLoadBalancerCapacity',
        'EnableCapacityReservationProvisionStabilize',
      ]),
    ],
    [
      'AWS::ElasticLoadBalancingV2::TargetGroup',
      new Set([
        'Protocol',
        'Port',
        'VpcId',
        'TargetType',
        'ProtocolVersion',
        'HealthCheckProtocol',
        'HealthCheckPort',
        'HealthCheckPath',
        'HealthCheckEnabled',
        'HealthCheckIntervalSeconds',
        'HealthCheckTimeoutSeconds',
        'HealthyThresholdCount',
        'UnhealthyThresholdCount',
        'Matcher',
        'Name',
        'Tags',
        'IpAddressType',
        'TargetControlPort',
        'TargetGroupAttributes',
        'Targets',
      ]),
    ],
    [
      'AWS::ElasticLoadBalancingV2::Listener',
      new Set([
        'LoadBalancerArn',
        'Certificates',
        'DefaultActions',
        'Port',
        'Protocol',
        'SslPolicy',
        'AlpnPolicy',
        'MutualAuthentication',
        'ListenerAttributes',
        // Sent by CreateListener, diffed by update's applyTagDiff and read back
        // by readListener. Undeclared, a tagged listener (any CDK app with
        // stack tags) routed via the slower Cloud Control path
        // (go-to-k/cdkd#2085).
        'Tags',
      ]),
    ],
  ]);

  /**
   * Issue #1160 (`ResourceProvider.removalHandledInUpdate`): every property of
   * the three types, each removal handled by `update()`, so the shared caller
   * warns about none of them. A removal `update()` leaves in place is listed
   * only where a CloudFormation A/B showed CloudFormation leaves it too.
   */
  removalHandledInUpdate = new Map<string, ReadonlySet<string>>([
    [
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      new Set([
        // Create-only: a removal replaces.
        'Name',
        'Scheme',
        'Type',
        // Full-replace calls (SetSubnets / SetSecurityGroups), a diff
        // (AddTags / RemoveTags), a reset (IpAddressType -> ipv4), or a
        // dedicated removal (RemoveIpamPools / ResetCapacityReservation).
        'Subnets',
        'SubnetMappings',
        'SecurityGroups',
        'Tags',
        'IpAddressType',
        'Ipv4IpamPoolId',
        'MinimumLoadBalancerCapacity',
        // A wait flag with no live value.
        'EnableCapacityReservationProvisionStabilize',
        // Left in place, as CloudFormation leaves them (CFn A/B 2026-10-17).
        'LoadBalancerAttributes',
        'EnablePrefixForIpv6SourceNat',
        'EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic',
      ]),
    ],
    [
      'AWS::ElasticLoadBalancingV2::TargetGroup',
      new Set([
        // Create-only (a removal replaces), or replaced by update() itself
        // (TargetControlPort has no modify API).
        'Protocol',
        'Port',
        'VpcId',
        'TargetType',
        'ProtocolVersion',
        'Name',
        'IpAddressType',
        'TargetControlPort',
        // Reset (HealthCheckPort -> traffic-port) or diffed (Register /
        // DeregisterTargets, AddTags / RemoveTags).
        'HealthCheckPort',
        'Targets',
        'Tags',
        // Left in place, as CloudFormation leaves them (CFn A/B 2026-08-10
        // and 2026-10-17).
        'HealthCheckProtocol',
        'HealthCheckPath',
        'HealthCheckEnabled',
        'HealthCheckIntervalSeconds',
        'HealthCheckTimeoutSeconds',
        'HealthyThresholdCount',
        'UnhealthyThresholdCount',
        'Matcher',
        'TargetGroupAttributes',
      ]),
    ],
    [
      'AWS::ElasticLoadBalancingV2::Listener',
      new Set([
        // Create-only (a removal replaces), or required.
        'LoadBalancerArn',
        'DefaultActions',
        // Diffed: RemoveTags for a removed tag; a removed attribute key is
        // left in place, as CloudFormation leaves it (CFn A/B 2026-10-17).
        'ListenerAttributes',
        'Tags',
        // Cleared by AWS on an HTTPS -> HTTP / TLS -> TCP change, otherwise
        // left in place, as CloudFormation leaves them (CFn A/B 2026-10-20),
        // and named in updateListener's own warning (no reset).
        ...LISTENER_LEFT_IN_PLACE_ON_REMOVAL,
      ]),
    ],
  ]);

  readonly lambdaClients = new Map<string, LambdaClient>();

  getClient(): ElasticLoadBalancingV2Client {
    return getClient.call(this);
  }

  waitForLambdaTargetsActive(
    logicalId: string,
    targetType: unknown,
    targets: TargetDescription[]
  ): Promise<void> {
    return waitForLambdaTargetsActive.call(this, logicalId, targetType, targets);
  }

  maskedRetryLogger(maskSecrets: SecretMasker | undefined): RetryLogger {
    return maskedRetryLogger.call(this, maskSecrets);
  }

  maskErrorMessage(error: unknown, maskSecrets: SecretMasker | undefined): string {
    return maskErrorMessage.call(this, error, maskSecrets);
  }

  cleanupFailureText(
    head: string,
    cleanupError: unknown,
    maskSecrets: SecretMasker | undefined
  ): string {
    return cleanupFailureText.call(this, head, cleanupError, maskSecrets);
  }

  isDeleteTargetGone(
    error: unknown,
    context: DeleteContext | undefined,
    notFoundName: string
  ): boolean {
    return isDeleteTargetGone.call(this, error, context, notFoundName);
  }

  logDeleteTargetGone(
    context: DeleteContext | undefined,
    what: string,
    physicalId: string,
    logicalId: string,
    debugText: string
  ): void {
    return logDeleteTargetGone.call(this, context, what, physicalId, logicalId, debugText);
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

  isSameResource(
    journaledPhysicalId: string,
    record: { physicalId: string },
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<ResourceIdentityVerdict> {
    return isSameResource.call(this, journaledPhysicalId, record, resourceType, context);
  }

  readElbv2ArnIfExists(resourceType: string, arn: string): Promise<string | undefined> {
    return readElbv2ArnIfExists.call(this, resourceType, arn);
  }

  createLoadBalancer(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    maskSecrets?: SecretMasker
  ): Promise<ResourceCreateResult> {
    return createLoadBalancer.call(this, logicalId, resourceType, properties, maskSecrets);
  }

  updateLoadBalancer(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    callerMaskSecrets?: SecretMasker,
    fromReadback = false
  ): Promise<ResourceUpdateResult> {
    return updateLoadBalancer.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      callerMaskSecrets,
      fromReadback
    );
  }

  waitForCapacityReservationProvisioned(lbArn: string, logicalId: string): Promise<void> {
    return waitForCapacityReservationProvisioned.call(this, lbArn, logicalId);
  }

  deleteLoadBalancer(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    return deleteLoadBalancer.call(this, logicalId, physicalId, resourceType, context);
  }

  deleteLoadBalancerOnce(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context: DeleteContext | undefined,
    flip: ProtectionFlipRecord
  ): Promise<void> {
    return deleteLoadBalancerOnce.call(this, logicalId, physicalId, resourceType, context, flip);
  }

  createTargetGroup(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    maskSecrets?: SecretMasker
  ): Promise<ResourceCreateResult> {
    return createTargetGroup.call(this, logicalId, resourceType, properties, maskSecrets);
  }

  updateTargetGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    callerMaskSecrets?: SecretMasker,
    fromReadback = false
  ): Promise<ResourceUpdateResult> {
    return updateTargetGroup.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      callerMaskSecrets,
      fromReadback
    );
  }

  deleteTargetGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    return deleteTargetGroup.call(this, logicalId, physicalId, resourceType, context);
  }

  listenerPortHeld(loadBalancerArn: string, port: number | undefined): Promise<boolean> {
    return listenerPortHeld.call(this, loadBalancerArn, port);
  }

  createListener(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    maskSecrets?: SecretMasker
  ): Promise<ResourceCreateResult> {
    return createListener.call(this, logicalId, resourceType, properties, maskSecrets);
  }

  updateListener(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return updateListener.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }

  deleteListener(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    return deleteListener.call(this, logicalId, physicalId, resourceType, context);
  }

  normalizeAttributes(raw: unknown): Array<{ Key: string; Value: string }> {
    return normalizeAttributes.call(this, raw);
  }

  diffAttributes(
    newAttrs: Array<{ Key: string; Value: string }>,
    oldAttrs: Array<{ Key: string; Value: string }>,
    removalValue: (key: string, currentValue: string) => string | undefined
  ): Array<{ Key: string; Value: string }> {
    return diffAttributes.call(this, newAttrs, oldAttrs, removalValue);
  }

  diffAttributeBag(
    bag: 'LoadBalancerAttributes' | 'TargetGroupAttributes' | 'ListenerAttributes',
    logicalId: string,
    desired: unknown,
    previous: unknown,
    removalValue: (key: string, currentValue: string) => string | undefined,
    fromReadback: boolean,
    maskSecrets: SecretMasker | undefined
  ): Array<{ Key: string; Value: string }> {
    return diffAttributeBag.call(
      this,
      bag,
      logicalId,
      desired,
      previous,
      removalValue,
      fromReadback,
      maskSecrets
    );
  }

  readUpdateTargets(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    desiredRaw: unknown,
    recordedRaw: unknown,
    groupPort: unknown
  ): Promise<{ newTargets: TargetDescription[]; oldTargets: TargetDescription[] }> {
    return readUpdateTargets.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      desiredRaw,
      recordedRaw,
      groupPort
    );
  }

  applyTagDiff(
    arn: string,
    resourceType: string,
    logicalId: string,
    oldTagsRaw: unknown,
    newTagsRaw: unknown,
    // A load balancer ARN carries its `Name`, which can be secret-derived
    // (go-to-k/cdkd#4275); absent means unmasked.
    maskSecrets?: SecretMasker
  ): Promise<void> {
    return applyTagDiff.call(
      this,
      arn,
      resourceType,
      logicalId,
      oldTagsRaw,
      newTagsRaw,
      maskSecrets
    );
  }

  convertActions(actions: Array<Record<string, unknown>> | undefined): Action[] | undefined {
    return convertActions.call(this, actions);
  }

  convertCertificates(
    certificates: Array<Record<string, unknown>> | undefined
  ): Certificate[] | undefined {
    return convertCertificates.call(this, certificates);
  }

  readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, resourceType);
  }

  readLoadBalancer(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readLoadBalancer.call(this, physicalId);
  }

  readTargetGroup(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readTargetGroup.call(this, physicalId);
  }

  attachRegisteredTargets(result: Record<string, unknown>, targetGroupArn: string): Promise<void> {
    return attachRegisteredTargets.call(this, result, targetGroupArn);
  }

  getDriftUnknownPaths(resourceType: string, properties?: Record<string, unknown>): string[] {
    return getDriftUnknownPaths.call(this, resourceType, properties);
  }

  getDriftUnorderedPaths(resourceType: string): string[] {
    return getDriftUnorderedPaths.call(this, resourceType);
  }

  canonicalizeDriftPair(
    resourceType: string,
    baseline: Record<string, unknown>,
    aws: Record<string, unknown>,
    properties?: Record<string, unknown>
  ): Promise<{ baseline: Record<string, unknown>; aws: Record<string, unknown> }> {
    return canonicalizeDriftPair.call(this, resourceType, baseline, aws, properties);
  }

  readListener(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readListener.call(this, physicalId);
  }

  attachTags(result: Record<string, unknown>, arn: string): Promise<void> {
    return attachTags.call(this, result, arn);
  }

  generatedCreateName(
    resourceType: string,
    logicalId: string,
    properties: Record<string, unknown>
  ): string | undefined {
    return generatedCreateName.call(this, resourceType, logicalId, properties);
  }

  holderCreatedAt(resourceType: string, physicalId: string): Promise<number | undefined> {
    return holderCreatedAt.call(this, resourceType, physicalId);
  }

  lookupNames(resourceType: string, names: readonly string[]): Promise<Map<string, string>> {
    return lookupNames.call(this, resourceType, names);
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }

  importLoadBalancer(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importLoadBalancer.call(this, input);
  }

  importTargetGroup(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importTargetGroup.call(this, input);
  }

  isNotFoundError(error: unknown): boolean {
    return isNotFoundError.call(this, error);
  }
}
