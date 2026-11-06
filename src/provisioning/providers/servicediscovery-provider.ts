import { ServiceDiscoveryClient, type ServiceChange } from '@aws-sdk/client-servicediscovery';
import { STSClient } from '@aws-sdk/client-sts';
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
import { NAMESPACE_TYPES } from './servicediscovery/shared.js';
import {
  getClient,
  getStsClient,
  maskedRetryLogger,
  maskErrorMessage,
  wrapCaughtError,
  extractSoaTtlProperties,
  resolveSoaTtlChange,
  resolveNamespaceArn,
  syncNamespaceTags,
  wrapOperationFailedError,
  pollOperation,
  buildNamespaceArn,
} from './servicediscovery/core.js';
import { create, update, deleteImpl } from './servicediscovery/dispatch.js';
import {
  createNamespace,
  updateNamespace,
  deleteNamespace,
  createHttpNamespace,
  updateHttpNamespace,
  createPublicDnsNamespace,
  updatePublicDnsNamespace,
} from './servicediscovery/namespace.js';
import {
  createService,
  updateService,
  planServiceChange,
  warnUnappliedDnsConfigMembers,
  keepUndeclaredServiceFields,
  deleteService,
} from './servicediscovery/service.js';
import {
  getAttribute,
  isSameResource,
  readNamespaceIdForIdentity,
  readServiceIdForIdentity,
  readCurrentState,
  getDriftUnknownPaths,
  readNamespace,
  readService,
  normalizeServiceAttributes,
  attachTags,
} from './servicediscovery/read-state.js';
import {
  importImpl,
  importNamespaceResource,
  importServiceResource,
} from './servicediscovery/import.js';

/**
 * AWS Service Discovery Provider
 *
 * Implements resource provisioning for:
 * - AWS::ServiceDiscovery::PrivateDnsNamespace
 * - AWS::ServiceDiscovery::HttpNamespace
 * - AWS::ServiceDiscovery::PublicDnsNamespace
 * - AWS::ServiceDiscovery::Service
 *
 * WHY: the Create*Namespace APIs are async (they return an OperationId) but we
 * handle the polling ourselves, avoiding the CC API's generic polling overhead
 * and giving us direct control over the operation lifecycle. HttpNamespace and
 * PublicDnsNamespace are `ProvisioningType: NON_PROVISIONABLE`, so Cloud
 * Control cannot handle them at all — this SDK provider is the only route
 * (issue #1044).
 */
export class ServiceDiscoveryProvider implements ResourceProvider {
  client?: ServiceDiscoveryClient;
  stsClient?: STSClient;
  readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('ServiceDiscoveryProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::ServiceDiscovery::PrivateDnsNamespace',
      new Set(['Name', 'Vpc', 'Description', 'Tags', 'Properties']),
    ],
    ['AWS::ServiceDiscovery::HttpNamespace', new Set(['Name', 'Description', 'Tags'])],
    [
      'AWS::ServiceDiscovery::PublicDnsNamespace',
      new Set(['Name', 'Description', 'Tags', 'Properties']),
    ],
    [
      'AWS::ServiceDiscovery::Service',
      new Set([
        'Name',
        'NamespaceId',
        'DnsConfig',
        'HealthCheckCustomConfig',
        'Description',
        'HealthCheckConfig',
        'Tags',
        'Type',
        'ServiceAttributes',
      ]),
    ],
  ]);

  /**
   * Issue #1160: each namespace kind's `Update*Namespace` change object
   * MERGES (absent = "no change"), so a Description REMOVED from the
   * template is reset with the `''` clear sentinel — the CFn-parity shape,
   * live CFn A/B'd 2026-08-11 on all three kinds (PR #1537) and re-measured
   * on the HTTP and public kinds 2026-10-30 (go-to-k/cdkd#5549):
   * CloudFormation leaves `GetNamespace` with no Description, polled for
   * three minutes, both when the removal is the only change and beside a Tags
   * change — and, on the public kind, beside an SOA TTL change. `SOA.TTL` is
   * nested, so its reset stays in {@link resolveSoaTtlChange}.
   */
  removalDefaults = new Map<string, ReadonlyMap<string, unknown>>(
    NAMESPACE_TYPES.map((type) => [type, new Map<string, unknown>([['Description', '']])])
  );

  /** Issue #1160: every other namespace property, each removal handled. */
  removalHandledInUpdate = new Map<string, ReadonlySet<string>>([
    // Name / Vpc are create-only; Tags are diffed; Properties carries the
    // SOA TTL, reset by resolveSoaTtlChange.
    ['AWS::ServiceDiscovery::PrivateDnsNamespace', new Set(['Name', 'Vpc', 'Tags', 'Properties'])],
    ['AWS::ServiceDiscovery::HttpNamespace', new Set(['Name', 'Tags'])],
    ['AWS::ServiceDiscovery::PublicDnsNamespace', new Set(['Name', 'Tags', 'Properties'])],
    // Name / NamespaceId / Type / HealthCheckCustomConfig are create-only;
    // Tags and ServiceAttributes are diffed. A removed Description /
    // DnsConfig / HealthCheckConfig follows CloudFormation — kept on its own,
    // cleared (or, for DnsConfig, refused) beside a Description /
    // HealthCheckConfig change; see planServiceChange.
    [
      'AWS::ServiceDiscovery::Service',
      new Set([
        'Name',
        'NamespaceId',
        'Type',
        'HealthCheckCustomConfig',
        'Tags',
        'ServiceAttributes',
        'Description',
        'DnsConfig',
        'HealthCheckConfig',
      ]),
    ],
  ]);

  getClient(): ServiceDiscoveryClient {
    return getClient.call(this);
  }

  getStsClient(): STSClient {
    return getStsClient.call(this);
  }

  maskedRetryLogger(maskSecrets: SecretMasker | undefined): RetryLogger {
    return maskedRetryLogger.call(this, maskSecrets);
  }

  maskErrorMessage(error: unknown, maskSecrets: SecretMasker | undefined): string {
    return maskErrorMessage.call(this, error, maskSecrets);
  }

  wrapCaughtError(
    mask: MaskerFn,
    error: unknown,
    build: (maskedText: string) => ProvisioningError
  ): ProvisioningError {
    return wrapCaughtError.call(this, mask, error, build);
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
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, _properties, context);
  }

  createNamespace(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    maskSecrets?: SecretMasker
  ): Promise<ResourceCreateResult> {
    return createNamespace.call(this, logicalId, resourceType, properties, maskSecrets);
  }

  updateNamespace(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    maskSecrets?: SecretMasker
  ): Promise<ResourceUpdateResult> {
    return updateNamespace.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      maskSecrets
    );
  }

  deleteNamespace(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    return deleteNamespace.call(this, logicalId, physicalId, resourceType, context);
  }

  createHttpNamespace(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    maskSecrets?: SecretMasker
  ): Promise<ResourceCreateResult> {
    return createHttpNamespace.call(this, logicalId, resourceType, properties, maskSecrets);
  }

  updateHttpNamespace(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    maskSecrets?: SecretMasker
  ): Promise<ResourceUpdateResult> {
    return updateHttpNamespace.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      maskSecrets
    );
  }

  createPublicDnsNamespace(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    maskSecrets?: SecretMasker
  ): Promise<ResourceCreateResult> {
    return createPublicDnsNamespace.call(this, logicalId, resourceType, properties, maskSecrets);
  }

  updatePublicDnsNamespace(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    maskSecrets?: SecretMasker
  ): Promise<ResourceUpdateResult> {
    return updatePublicDnsNamespace.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      maskSecrets
    );
  }

  createService(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    maskSecrets?: SecretMasker
  ): Promise<ResourceCreateResult> {
    return createService.call(this, logicalId, resourceType, properties, maskSecrets);
  }

  updateService(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    maskSecrets?: SecretMasker,
    changedProperties?: ReadonlySet<string>
  ): Promise<ResourceUpdateResult> {
    return updateService.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      maskSecrets,
      changedProperties
    );
  }

  planServiceChange(
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    changedProperties: ReadonlySet<string> | undefined
  ): { change: ServiceChange; keepRemovedFromLive: boolean } | undefined {
    return planServiceChange.call(this, properties, previousProperties, changedProperties);
  }

  warnUnappliedDnsConfigMembers(
    logicalId: string,
    physicalId: string,
    properties: Record<string, unknown>,
    candidates: readonly string[]
  ): Promise<void> {
    return warnUnappliedDnsConfigMembers.call(this, logicalId, physicalId, properties, candidates);
  }

  keepUndeclaredServiceFields(
    physicalId: string,
    serviceChange: ServiceChange
  ): Promise<string | undefined> {
    return keepUndeclaredServiceFields.call(this, physicalId, serviceChange);
  }

  deleteService(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    return deleteService.call(this, logicalId, physicalId, resourceType, context);
  }

  extractSoaTtlProperties(
    properties: Record<string, unknown>
  ): { DnsProperties: { SOA: { TTL: number } } } | undefined {
    return extractSoaTtlProperties.call(this, properties);
  }

  resolveSoaTtlChange(
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    defaultTtl: number
  ): { DnsProperties: { SOA: { TTL: number } } } | undefined {
    return resolveSoaTtlChange.call(this, properties, previousProperties, defaultTtl);
  }

  resolveNamespaceArn(namespaceId: string): Promise<string> {
    return resolveNamespaceArn.call(this, namespaceId);
  }

  syncNamespaceTags(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<void> {
    return syncNamespaceTags.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties
    );
  }

  wrapOperationFailedError(
    mask: MaskerFn,
    logicalId: string,
    resourceType: string,
    operation: { ErrorCode?: string | undefined; ErrorMessage?: string | undefined } | undefined
  ): ProvisioningError {
    return wrapOperationFailedError.call(this, mask, logicalId, resourceType, operation);
  }

  pollOperation(
    operationId: string,
    logicalId: string,
    resourceType: string,
    maskSecrets?: SecretMasker
  ): Promise<string> {
    return pollOperation.call(this, operationId, logicalId, resourceType, maskSecrets);
  }

  getAttribute(physicalId: string, resourceType: string, attributeName: string): Promise<unknown> {
    return getAttribute.call(this, physicalId, resourceType, attributeName);
  }

  isSameResource(
    journaledPhysicalId: string,
    record: { physicalId: string },
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<ResourceIdentityVerdict> {
    return isSameResource.call(this, journaledPhysicalId, record, resourceType, context);
  }

  readNamespaceIdForIdentity(namespaceId: string, kind: string): Promise<string | undefined> {
    return readNamespaceIdForIdentity.call(this, namespaceId, kind);
  }

  readServiceIdForIdentity(serviceId: string): Promise<string | undefined> {
    return readServiceIdForIdentity.call(this, serviceId);
  }

  readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, resourceType);
  }

  getDriftUnknownPaths(resourceType: string): string[] {
    return getDriftUnknownPaths.call(this, resourceType);
  }

  readNamespace(
    physicalId: string,
    options: { includeProperties: boolean }
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readNamespace.call(this, physicalId, options);
  }

  readService(physicalId: string): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readService.call(this, physicalId);
  }

  normalizeServiceAttributes(raw: unknown): Record<string, string> {
    return normalizeServiceAttributes.call(this, raw);
  }

  attachTags(result: Record<string, unknown>, arn: string): Promise<void> {
    return attachTags.call(this, result, arn);
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }

  /**
   * Map each namespace CFn type to its Cloud Map `Namespace.Type` value so
   * the import walk never adopts a same-named namespace of a different kind
   * (Cloud Map names are NOT unique across kinds; adopting the wrong one
   * would make a later destroy delete the wrong resource).
   */
  static readonly NAMESPACE_KIND_BY_TYPE: Record<string, string> = {
    'AWS::ServiceDiscovery::PrivateDnsNamespace': 'DNS_PRIVATE',
    'AWS::ServiceDiscovery::HttpNamespace': 'HTTP',
    'AWS::ServiceDiscovery::PublicDnsNamespace': 'DNS_PUBLIC',
  };

  importNamespaceResource(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importNamespaceResource.call(this, input);
  }

  importServiceResource(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importServiceResource.call(this, input);
  }

  buildNamespaceArn(namespaceId: string): Promise<string> {
    return buildNamespaceArn.call(this, namespaceId);
  }
}
