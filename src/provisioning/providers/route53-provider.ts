import {
  Route53Client,
  type CreateHostedZoneCommandInput,
  type CreateHostedZoneCommandOutput,
  type HostedZone,
  type ResourceRecordSet,
} from '@aws-sdk/client-route-53';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type { DeleteProgress } from '../delete-started.js';
import type { DeleteContext } from '../region-check.js';
import type {
  CreateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  UpdateContext,
  ResourceNotFound,
} from '../../types/resource.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import {
  wrapCaughtError,
  wrapDeleteError,
  warnFailureText,
  getClient,
  create,
  update,
  deleteImpl,
  getAttribute,
  getHostedZoneAttribute,
} from './route53/core.js';
import {
  createHostedZone,
  createOrAdoptHostedZone,
  findHostedZoneByCallerReference,
  updateHostedZone,
} from './route53/hosted-zone.js';
import {
  deleteHostedZone,
  ensureAcceleratedRecoveryDisabledForDelete,
  waitForAcceleratedRecoveryFeatureSettled,
  waitForAcceleratedRecoveryMutable,
} from './route53/hosted-zone-delete.js';
import {
  createRecordSet,
  updateRecordSet,
  findLiveRecordSet,
  deleteRecordSet,
  buildResourceRecordSet,
} from './route53/record-set.js';
import {
  applyHostedZoneTags,
  readHostedZoneTags,
  applyQueryLoggingConfig,
  readQueryLogGroupArn,
  listQueryLoggingConfigIds,
  deleteQueryLoggingConfigForZone,
  syncVPCAssociations,
} from './route53/zone-config.js';
import { resolveHostedZoneId, resolveRecordSetIdentity } from './route53/resolve.js';
import {
  readCurrentState,
  readUnsettled,
  getDriftUnorderedPaths,
  readHostedZone,
  readRecordSet,
  readRecordSetAt,
} from './route53/read-state.js';
import {
  importImpl,
  compositeAgreesWithTemplate,
  importRecordSet,
  hostedZoneImportAttributes,
  importHostedZone,
} from './route53/import.js';
export {
  isZoneDisabledForMutationError,
  parseRecordSetCompositeId,
  isCnameConflictRefusal,
  recordIdentityChanged,
} from './route53/shared.js';

/**
 * AWS Route 53 Provider
 *
 * Implements resource provisioning for Route 53 resources:
 * - AWS::Route53::HostedZone
 * - AWS::Route53::RecordSet
 *
 * WHY: Route 53 operations are synchronous - the CC API adds unnecessary polling
 * overhead for operations that complete immediately. This SDK provider eliminates
 * that polling and returns instantly.
 */
export class Route53Provider implements ResourceProvider {
  route53Client?: Route53Client;
  readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('Route53Provider');

  wrapCaughtError(
    mask: ((text: string) => string) | undefined,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    return wrapCaughtError.call(this, mask, error, build);
  }

  wrapDeleteError(
    mask: ((text: string) => string) | undefined,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    return wrapDeleteError.call(this, mask, error, build);
  }

  warnFailureText(
    head: string,
    error: unknown,
    mask: ((text: string) => string) | undefined
  ): string {
    return warnFailureText.call(this, head, error, mask);
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Route53::HostedZone',
      new Set([
        'Name',
        'HostedZoneConfig',
        'HostedZoneTags',
        'VPCs',
        'QueryLoggingConfig',
        'HostedZoneFeatures',
        'DelegationSetId',
      ]),
    ],
    [
      'AWS::Route53::RecordSet',
      new Set([
        'HostedZoneId',
        'HostedZoneName',
        'Name',
        'Type',
        'TTL',
        'ResourceRecords',
        'AliasTarget',
        'SetIdentifier',
        'Weight',
        'Region',
        'Failover',
        'MultiValueAnswer',
        'HealthCheckId',
        'Comment',
        'GeoLocation',
        'GeoProximityLocation',
        'CidrRoutingConfig',
      ]),
    ],
  ]);

  getClient(): Route53Client {
    return getClient.call(this);
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

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  getAttribute(physicalId: string, resourceType: string, attributeName: string): Promise<unknown> {
    return getAttribute.call(this, physicalId, resourceType, attributeName);
  }

  createHostedZone(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    mask: ((text: string) => string) | undefined,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return createHostedZone.call(this, logicalId, resourceType, properties, mask, context);
  }

  createOrAdoptHostedZone(
    input: CreateHostedZoneCommandInput,
    mask?: (text: string) => string
  ): Promise<Partial<Pick<CreateHostedZoneCommandOutput, 'HostedZone' | 'DelegationSet'>>> {
    return createOrAdoptHostedZone.call(this, input, mask);
  }

  findHostedZoneByCallerReference(
    dnsName: string,
    callerReference: string
  ): Promise<HostedZone | undefined> {
    return findHostedZoneByCallerReference.call(this, dnsName, callerReference);
  }

  updateHostedZone(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    mask: ((text: string) => string) | undefined,
    context: UpdateContext | undefined
  ): Promise<ResourceUpdateResult> {
    return updateHostedZone.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      mask,
      context
    );
  }

  deleteHostedZone(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    return deleteHostedZone.call(this, logicalId, physicalId, resourceType, context);
  }

  ensureAcceleratedRecoveryDisabledForDelete(
    physicalId: string,
    logicalId: string,
    progress: DeleteProgress
  ): Promise<void> {
    return ensureAcceleratedRecoveryDisabledForDelete.call(this, physicalId, logicalId, progress);
  }

  getHostedZoneAttribute(physicalId: string, attributeName: string): Promise<unknown> {
    return getHostedZoneAttribute.call(this, physicalId, attributeName);
  }

  createRecordSet(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    mask: ((text: string) => string) | undefined
  ): Promise<ResourceCreateResult> {
    return createRecordSet.call(this, logicalId, resourceType, properties, mask);
  }

  updateRecordSet(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return updateRecordSet.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }

  findLiveRecordSet(
    hostedZoneId: string,
    properties: Record<string, unknown>
  ): Promise<ResourceRecordSet | undefined> {
    return findLiveRecordSet.call(this, hostedZoneId, properties);
  }

  deleteRecordSet(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    return deleteRecordSet.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  waitForAcceleratedRecoveryFeatureSettled(
    zoneId: string,
    logicalId: string,
    resourceType: string,
    enabled: boolean,
    freshZone?: boolean
  ): Promise<void> {
    return waitForAcceleratedRecoveryFeatureSettled.call(
      this,
      zoneId,
      logicalId,
      resourceType,
      enabled,
      freshZone
    );
  }

  waitForAcceleratedRecoveryMutable(
    zoneId: string,
    logicalId: string,
    resourceType: string,
    purpose?: {
      blocked: string;
      retry: string;
      settledAt?: 'ENABLED' | 'DISABLED';
      freshZone?: boolean;
    }
  ): Promise<void> {
    return waitForAcceleratedRecoveryMutable.call(this, zoneId, logicalId, resourceType, purpose);
  }

  buildResourceRecordSet(properties: Record<string, unknown>): ResourceRecordSet {
    return buildResourceRecordSet.call(this, properties);
  }

  applyHostedZoneTags(
    zoneId: string,
    properties: Record<string, unknown>,
    logicalId: string,
    previousProperties?: Record<string, unknown>,
    mask?: (text: string) => string
  ): Promise<void> {
    return applyHostedZoneTags.call(this, zoneId, properties, logicalId, previousProperties, mask);
  }

  readHostedZoneTags(properties: Record<string, unknown>): Array<{ Key: string; Value: string }> {
    return readHostedZoneTags.call(this, properties);
  }

  applyQueryLoggingConfig(
    zoneId: string,
    properties: Record<string, unknown>,
    logicalId: string,
    previousProperties?: Record<string, unknown>,
    mask?: (text: string) => string,
    markUnsettled?: (propertyName: string) => void
  ): Promise<void> {
    return applyQueryLoggingConfig.call(
      this,
      zoneId,
      properties,
      logicalId,
      previousProperties,
      mask,
      markUnsettled
    );
  }

  readQueryLogGroupArn(properties: Record<string, unknown>): string | undefined {
    return readQueryLogGroupArn.call(this, properties);
  }

  listQueryLoggingConfigIds(zoneId: string): Promise<string[]> {
    return listQueryLoggingConfigIds.call(this, zoneId);
  }

  deleteQueryLoggingConfigForZone(
    zoneId: string,
    logicalId: string,
    progress?: DeleteProgress
  ): Promise<void> {
    return deleteQueryLoggingConfigForZone.call(this, zoneId, logicalId, progress);
  }

  syncVPCAssociations(
    zoneId: string,
    properties: Record<string, unknown>,
    logicalId: string,
    previousProperties: Record<string, unknown>,
    mask?: (text: string) => string,
    marks?: Pick<UpdateContext, 'markUnsettled' | 'markAttempted'>
  ): Promise<void> {
    return syncVPCAssociations.call(
      this,
      zoneId,
      properties,
      logicalId,
      previousProperties,
      mask,
      marks
    );
  }

  resolveHostedZoneId(
    properties: Record<string, unknown>,
    logicalId: string,
    resourceType: string,
    physicalId?: string,
    options?: {
      requireUnambiguousZoneName?: boolean;
      requirePrivateZone?: boolean | undefined;
      subject?: { noun: string; remedy: string };
    }
  ): Promise<string> {
    return resolveHostedZoneId.call(this, properties, logicalId, resourceType, physicalId, options);
  }

  resolveRecordSetIdentity(
    physicalId: string,
    properties?: Record<string, unknown>,
    options?: { requireUnambiguousZoneName?: boolean }
  ): Promise<{ hostedZoneId: string; name: string; type: string } | undefined> {
    return resolveRecordSetIdentity.call(this, physicalId, properties, options);
  }

  readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, resourceType, properties);
  }

  readUnsettled(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    names: ReadonlySet<string>,
    recordedProperties?: Record<string, unknown>,
    desiredProperties?: Record<string, unknown>,
    attemptedItems?: ReadonlyMap<string, ReadonlySet<string>>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readUnsettled.call(
      this,
      physicalId,
      logicalId,
      resourceType,
      names,
      recordedProperties,
      desiredProperties,
      attemptedItems
    );
  }

  getDriftUnorderedPaths(resourceType: string): string[] {
    return getDriftUnorderedPaths.call(this, resourceType);
  }

  readHostedZone(
    physicalId: string,
    properties?: Record<string, unknown>,
    throwOnFailedQueryLoggingRead?: boolean
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readHostedZone.call(this, physicalId, properties, throwOnFailedQueryLoggingRead);
  }

  readRecordSet(
    physicalId: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readRecordSet.call(this, physicalId, properties);
  }

  readRecordSetAt(
    identity: { hostedZoneId: string; name: string; type: string },
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readRecordSetAt.call(this, identity, properties);
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }

  compositeAgreesWithTemplate(
    parsed: { hostedZoneId: string; name: string; type: string; nameCarriesSeparator: boolean },
    properties: Record<string, unknown>
  ): boolean {
    return compositeAgreesWithTemplate.call(this, parsed, properties);
  }

  importRecordSet(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importRecordSet.call(this, input);
  }

  hostedZoneImportAttributes(
    zoneId: string,
    logicalId: string
  ): Promise<Record<string, unknown> | null> {
    return hostedZoneImportAttributes.call(this, zoneId, logicalId);
  }

  importHostedZone(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importHostedZone.call(this, input);
  }
}
