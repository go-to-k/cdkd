import {
  ServiceDiscoveryClient,
  CreatePrivateDnsNamespaceCommand,
  UpdatePrivateDnsNamespaceCommand,
  DeleteNamespaceCommand,
  CreateServiceCommand,
  UpdateServiceCommand,
  DeleteServiceCommand,
  UpdateServiceAttributesCommand,
  DeleteServiceAttributesCommand,
  GetServiceAttributesCommand,
  GetNamespaceCommand,
  GetOperationCommand,
  GetServiceCommand,
  ListNamespacesCommand,
  ListServicesCommand,
  ListTagsForResourceCommand,
  NamespaceNotFound,
  ServiceNotFound,
  type DnsConfig,
  type DnsConfigChange,
  type HealthCheckCustomConfig,
  type HealthCheckConfig,
  type PrivateDnsNamespaceChange,
  type ServiceChange,
  type Tag,
  type ServiceTypeOption,
} from '@aws-sdk/client-servicediscovery';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { getLogger } from '../../utils/logger.js';
import { withRetry } from '../../deployment/retry.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { matchesCdkPath, normalizeAwsTagsToCfn } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * AWS Service Discovery Provider
 *
 * Implements resource provisioning for:
 * - AWS::ServiceDiscovery::PrivateDnsNamespace
 * - AWS::ServiceDiscovery::Service
 *
 * WHY: CreatePrivateDnsNamespace is async (returns OperationId) but we handle
 * the polling ourselves, avoiding the CC API's generic polling overhead and
 * giving us direct control over the operation lifecycle.
 */
export class ServiceDiscoveryProvider implements ResourceProvider {
  private client?: ServiceDiscoveryClient;
  private stsClient?: STSClient;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('ServiceDiscoveryProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::ServiceDiscovery::PrivateDnsNamespace',
      new Set(['Name', 'Vpc', 'Description', 'Tags', 'Properties']),
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

  private getClient(): ServiceDiscoveryClient {
    if (!this.client) {
      this.client = new ServiceDiscoveryClient(
        this.providerRegion ? { region: this.providerRegion } : {}
      );
    }
    return this.client;
  }

  private getStsClient(): STSClient {
    if (!this.stsClient) {
      this.stsClient = new STSClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.stsClient;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::ServiceDiscovery::PrivateDnsNamespace':
        return this.createNamespace(logicalId, resourceType, properties);
      case 'AWS::ServiceDiscovery::Service':
        return this.createService(logicalId, resourceType, properties);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId
        );
    }
  }

  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    switch (resourceType) {
      case 'AWS::ServiceDiscovery::PrivateDnsNamespace':
        return this.updateNamespace(logicalId, physicalId, resourceType, properties);
      case 'AWS::ServiceDiscovery::Service':
        return this.updateService(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::ServiceDiscovery::PrivateDnsNamespace':
        return this.deleteNamespace(logicalId, physicalId, resourceType, context);
      case 'AWS::ServiceDiscovery::Service':
        return this.deleteService(logicalId, physicalId, resourceType, context);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  // ─── AWS::ServiceDiscovery::PrivateDnsNamespace ───────────────────

  private async createNamespace(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating private DNS namespace ${logicalId}`);
    const client = this.getClient();

    const name = properties['Name'] as string;
    const vpc = properties['Vpc'] as string;
    const description = properties['Description'] as string | undefined;
    const tags = properties['Tags'] as Tag[] | undefined;

    if (!name) {
      throw new ProvisioningError(
        `Name is required for PrivateDnsNamespace ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    if (!vpc) {
      throw new ProvisioningError(
        `Vpc is required for PrivateDnsNamespace ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // CFn `Properties.DnsProperties.SOA.TTL` is mutable. Pass it through to
    // CreatePrivateDnsNamespace so a templated TTL is actually applied
    // (without this, cdkd silently dropped the property and AWS used its
    // default 15 — readCurrentState would then surface the AWS default,
    // detected as drift on the very first run after deploy). PR #201
    // follow-up: also added `Properties` to the handledProperties set so
    // the deploy engine doesn't fall back to CC API on this resource type.
    const propsBag = properties['Properties'] as Record<string, unknown> | undefined;
    const dnsProps = propsBag?.['DnsProperties'] as Record<string, unknown> | undefined;
    const soa = dnsProps?.['SOA'] as { TTL?: number } | undefined;
    const inputProperties =
      soa?.TTL !== undefined ? { DnsProperties: { SOA: { TTL: Number(soa.TTL) } } } : undefined;

    try {
      const response = await client.send(
        new CreatePrivateDnsNamespaceCommand({
          Name: name,
          Vpc: vpc,
          ...(description && { Description: description }),
          ...(tags && tags.length > 0 && { Tags: tags }),
          ...(inputProperties && { Properties: inputProperties }),
        })
      );

      const operationId = response.OperationId;
      if (!operationId) {
        throw new Error('CreatePrivateDnsNamespace did not return OperationId');
      }

      // Poll for operation completion
      const namespaceId = await this.pollOperation(operationId, logicalId, resourceType);

      // Build ARN
      const arn = await this.buildNamespaceArn(namespaceId);

      this.logger.debug(`Successfully created private DNS namespace ${logicalId}: ${namespaceId}`);

      return {
        physicalId: namespaceId,
        attributes: {
          Id: namespaceId,
          Arn: arn,
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create private DNS namespace ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update a private DNS namespace.
   *
   * AWS exposes `UpdatePrivateDnsNamespace` for two mutable surfaces:
   *  - `Description`
   *  - `Properties.DnsProperties.SOA.TTL`
   *
   * `Name` and `Vpc` are immutable; the deploy engine's
   * replacement-detection layer routes those through DELETE+CREATE
   * before this method is ever called, so we do not validate them here.
   *
   * Empty-string Description is intentionally allowed through (`!== undefined`
   * gate, not truthy) so `cdkd drift --revert` can clear a console-side ADD.
   */
  private async updateNamespace(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating private DNS namespace ${logicalId}: ${physicalId}`);
    const client = this.getClient();

    const namespaceChange: PrivateDnsNamespaceChange = {};

    if (properties['Description'] !== undefined) {
      namespaceChange.Description = properties['Description'] as string;
    }

    const propsBag = properties['Properties'] as Record<string, unknown> | undefined;
    const dnsProps = propsBag?.['DnsProperties'] as Record<string, unknown> | undefined;
    const soa = dnsProps?.['SOA'] as { TTL?: number } | undefined;
    if (soa?.TTL !== undefined) {
      namespaceChange.Properties = {
        DnsProperties: {
          SOA: { TTL: Number(soa.TTL) },
        },
      };
    }

    if (Object.keys(namespaceChange).length === 0) {
      this.logger.debug(`No mutable diff for PrivateDnsNamespace ${logicalId}, skipping update`);
      return { physicalId, wasReplaced: false };
    }

    try {
      const response = await client.send(
        new UpdatePrivateDnsNamespaceCommand({
          Id: physicalId,
          Namespace: namespaceChange,
        })
      );

      const operationId = response.OperationId;
      if (operationId) {
        await this.pollOperation(operationId, logicalId, resourceType);
      }

      this.logger.debug(`Successfully updated private DNS namespace ${logicalId}`);

      return { physicalId, wasReplaced: false };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update private DNS namespace ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteNamespace(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting private DNS namespace ${logicalId}: ${physicalId}`);
    const client = this.getClient();

    try {
      const response = await client.send(new DeleteNamespaceCommand({ Id: physicalId }));

      const operationId = response.OperationId;
      if (operationId) {
        await this.pollOperation(operationId, logicalId, resourceType);
      }

      this.logger.debug(`Successfully deleted private DNS namespace ${logicalId}`);
    } catch (error) {
      if (error instanceof NamespaceNotFound) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Namespace ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete private DNS namespace ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── AWS::ServiceDiscovery::Service ───────────────────────────────

  private async createService(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating service discovery service ${logicalId}`);
    const client = this.getClient();

    const name = properties['Name'] as string;
    const namespaceId = properties['NamespaceId'] as string | undefined;
    const description = properties['Description'] as string | undefined;
    const dnsConfig = properties['DnsConfig'] as DnsConfig | undefined;
    const healthCheckCustomConfig = properties['HealthCheckCustomConfig'] as
      | HealthCheckCustomConfig
      | undefined;
    const healthCheckConfig = properties['HealthCheckConfig'] as HealthCheckConfig | undefined;
    const tags = properties['Tags'] as Tag[] | undefined;
    const type = properties['Type'] as ServiceTypeOption | undefined;

    if (!name) {
      throw new ProvisioningError(
        `Name is required for ServiceDiscovery Service ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const response = await client.send(
        new CreateServiceCommand({
          Name: name,
          ...(namespaceId && { NamespaceId: namespaceId }),
          ...(description && { Description: description }),
          ...(dnsConfig && { DnsConfig: dnsConfig }),
          ...(healthCheckCustomConfig && {
            HealthCheckCustomConfig: healthCheckCustomConfig,
          }),
          ...(healthCheckConfig && { HealthCheckConfig: healthCheckConfig }),
          ...(tags && tags.length > 0 && { Tags: tags }),
          ...(type && { Type: type }),
        })
      );

      const service = response.Service;
      if (!service || !service.Id) {
        throw new Error('CreateService did not return Service ID');
      }
      const serviceId = service.Id;

      this.logger.debug(
        `Successfully created service discovery service ${logicalId}: ${serviceId}`
      );

      // ServiceAttributes is NOT accepted by CreateService — it rides on a
      // separate post-create `UpdateServiceAttributes` control-plane call.
      // CreateService has already committed the service on AWS, so a failure
      // here would strand a half-configured service that the next deploy plans
      // CREATE for (and AWS then rejects with a name collision). Wrap the
      // attributes call in an inner try/catch that issues a best-effort
      // `DeleteService` before re-throwing (atomicity), mirroring the ELBv2
      // Listener create path (PR #879).
      try {
        const attrs = this.normalizeServiceAttributes(properties['ServiceAttributes']);
        if (Object.keys(attrs).length > 0) {
          await withRetry(
            () =>
              client.send(
                new UpdateServiceAttributesCommand({ ServiceId: serviceId, Attributes: attrs })
              ),
            logicalId,
            { logger: this.logger }
          );
          this.logger.debug(
            `Applied ${Object.keys(attrs).length} ServiceAttribute(s) for ${logicalId}`
          );
        }
      } catch (innerError) {
        try {
          await client.send(new DeleteServiceCommand({ Id: serviceId }));
          this.logger.debug(
            `Cleaned up partially-created ServiceDiscovery Service ${logicalId} (${serviceId}) after ServiceAttributes wiring failure`
          );
        } catch (cleanupError) {
          this.logger.warn(
            `Failed to clean up partially-created ServiceDiscovery Service ${logicalId} (${serviceId}) after ServiceAttributes wiring failure: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. Manual deletion may be required before the next deploy: aws servicediscovery delete-service --id ${serviceId}`
          );
        }
        throw innerError;
      }

      return {
        physicalId: serviceId,
        attributes: {
          Id: serviceId,
          Arn: service.Arn || '',
          Name: service.Name || name || '',
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create service discovery service ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update a service discovery service.
   *
   * Per AWS docs, `UpdateService` accepts a `ServiceChange` body with
   * `Description`, `DnsConfig.DnsRecords` (TTLs etc. — `NamespaceId` /
   * `RoutingPolicy` are not part of the change shape and are immutable
   * here), and `HealthCheckConfig`. `Name` / `NamespaceId` /
   * `HealthCheckCustomConfig` are immutable on UpdateService — the
   * replacement-detection layer routes those through DELETE+CREATE.
   *
   * Per AWS docs, omitting `DnsRecords` / `HealthCheckConfig` from the
   * request DELETES that configuration. To preserve fields cdkd is not
   * actively reverting, we always echo the AWS-current value when the
   * caller did not supply a change. `cdkd drift --revert` passes the
   * full AWS-current snapshot as `properties`, so the round-trip is
   * value-preserving.
   */
  private async updateService(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating service discovery service ${logicalId}: ${physicalId}`);
    const client = this.getClient();

    const serviceChange: ServiceChange = {};

    if (properties['Description'] !== undefined) {
      serviceChange.Description = properties['Description'] as string;
    }

    const dnsConfig = properties['DnsConfig'] as DnsConfig | undefined;
    if (dnsConfig?.DnsRecords !== undefined) {
      const change: DnsConfigChange = { DnsRecords: dnsConfig.DnsRecords };
      serviceChange.DnsConfig = change;
    }

    if (properties['HealthCheckConfig'] !== undefined) {
      serviceChange.HealthCheckConfig = properties['HealthCheckConfig'] as HealthCheckConfig;
    }

    // ServiceAttributes is NOT part of the `ServiceChange` body — it is
    // mutated via its own `UpdateServiceAttributes` (upsert) /
    // `DeleteServiceAttributes` (remove keys) APIs. Diff old vs new: keys
    // whose value changed or are new go in the upsert map; keys present only
    // in the old set are removed. These calls THROW on AWS failure (NOT
    // warn-swallow) so cdkd state is never written as-if-applied — see memory
    // feedback_tags_on_update_must_throw; the next deploy retries naturally.
    const newAttrs = this.normalizeServiceAttributes(properties['ServiceAttributes']);
    const oldAttrs = this.normalizeServiceAttributes(previousProperties['ServiceAttributes']);
    const upsertAttrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(newAttrs)) {
      if (oldAttrs[k] !== v) upsertAttrs[k] = v;
    }
    const removedAttrKeys = Object.keys(oldAttrs).filter((k) => !(k in newAttrs));

    const hasServiceChange = Object.keys(serviceChange).length > 0;
    const hasAttrUpsert = Object.keys(upsertAttrs).length > 0;
    const hasAttrRemove = removedAttrKeys.length > 0;

    if (!hasServiceChange && !hasAttrUpsert && !hasAttrRemove) {
      this.logger.debug(
        `No mutable diff for ServiceDiscovery Service ${logicalId}, skipping update`
      );
      return { physicalId, wasReplaced: false };
    }

    try {
      if (hasServiceChange) {
        const response = await client.send(
          new UpdateServiceCommand({
            Id: physicalId,
            Service: serviceChange,
          })
        );

        const operationId = response.OperationId;
        if (operationId) {
          await this.pollOperation(operationId, logicalId, resourceType);
        }
      }

      if (hasAttrUpsert) {
        await withRetry(
          () =>
            client.send(
              new UpdateServiceAttributesCommand({ ServiceId: physicalId, Attributes: upsertAttrs })
            ),
          logicalId,
          { logger: this.logger }
        );
        this.logger.debug(
          `Applied ${Object.keys(upsertAttrs).length} ServiceAttribute change(s) for ${logicalId}`
        );
      }

      if (hasAttrRemove) {
        await withRetry(
          () =>
            client.send(
              new DeleteServiceAttributesCommand({
                ServiceId: physicalId,
                Attributes: removedAttrKeys,
              })
            ),
          logicalId,
          { logger: this.logger }
        );
        this.logger.debug(`Removed ${removedAttrKeys.length} ServiceAttribute(s) for ${logicalId}`);
      }

      this.logger.debug(`Successfully updated service discovery service ${logicalId}`);

      return { physicalId, wasReplaced: false };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update service discovery service ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteService(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting service discovery service ${logicalId}: ${physicalId}`);
    const client = this.getClient();

    try {
      await client.send(new DeleteServiceCommand({ Id: physicalId }));
      this.logger.debug(`Successfully deleted service discovery service ${logicalId}`);
    } catch (error) {
      if (error instanceof ServiceNotFound) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Service ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete service discovery service ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  /**
   * Poll a Service Discovery operation until it completes.
   * Returns the target resource ID from the operation result.
   */
  private async pollOperation(
    operationId: string,
    logicalId: string,
    resourceType: string
  ): Promise<string> {
    const client = this.getClient();
    const maxAttempts = 60;
    let delay = 1000; // start at 1s

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const result = await client.send(new GetOperationCommand({ OperationId: operationId }));

      const status = result.Operation?.Status;

      if (status === 'SUCCESS') {
        // Extract the target resource ID (NAMESPACE or SERVICE)
        const targets = result.Operation?.Targets;
        if (targets) {
          return targets['NAMESPACE'] || targets['SERVICE'] || operationId;
        }
        return operationId;
      }

      if (status === 'FAIL') {
        const errorMessage = result.Operation?.ErrorMessage || 'Unknown error';
        throw new ProvisioningError(
          `Operation failed for ${logicalId}: ${errorMessage}`,
          resourceType,
          logicalId
        );
      }

      // SUBMITTED or PENDING - wait and retry
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 10000); // exponential backoff, max 10s
    }

    throw new ProvisioningError(
      `Operation timed out for ${logicalId} (operationId: ${operationId})`,
      resourceType,
      logicalId
    );
  }

  // ─── Import dispatch ──────────────────────────────────────────────

  /**
   * Adopt an existing Cloud Map (Service Discovery) resource into cdkd state.
   *
   *  - **AWS::ServiceDiscovery::PrivateDnsNamespace**: tag-based auto-lookup
   *    via `ListNamespaces` + `ListTagsForResource(ResourceARN)` (Tag[]
   *    array). Falls back to `--resource` override or matching
   *    `Properties.Name` against the namespace name.
   *  - **AWS::ServiceDiscovery::Service**: same shape — `ListServices` +
   *    `ListTagsForResource`. Both use `Tag[]` arrays.
   */
  /**
   * Read the AWS-current ServiceDiscovery resource configuration in CFn-property shape.
   *
   * Dispatch per resource type:
   *  - `PrivateDnsNamespace` → `GetNamespace` (Name, Description). `Vpc`
   *    is NOT returned by `GetNamespace` — Cloud Map exposes the VPC only
   *    at create time and via `ListNamespaces`-side `Properties.DnsProperties.HostedZoneId`,
   *    not as a directly comparable VPC ID. We skip it; the comparator
   *    only descends into keys present in cdkd state, so an absent key
   *    cannot fire false drift, but a `Vpc` change will not be detected
   *    via this provider's drift surface (use the CFn-side `aws cloudmap`
   *    CLI for that edge case).
   *  - `Service` → `GetService` (Name, NamespaceId, Description, Type,
   *    DnsConfig, HealthCheckConfig, HealthCheckCustomConfig).
   *
   * Tags are surfaced via a follow-up `ListTagsForResource(ResourceARN)`
   * call (using the resource ARN from `GetNamespace.Arn` or
   * `GetService.Arn`). CDK's `aws:*` auto-tags are filtered out and the
   * result key is omitted when AWS reports no user tags. Returns
   * `undefined` when the resource is gone (`NamespaceNotFound` /
   * `ServiceNotFound`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    switch (resourceType) {
      case 'AWS::ServiceDiscovery::PrivateDnsNamespace':
        return this.readNamespace(physicalId);
      case 'AWS::ServiceDiscovery::Service':
        return this.readService(physicalId);
      default:
        return undefined;
    }
  }

  /**
   * Declare drift-unreadable property paths.
   *
   * - `AWS::ServiceDiscovery::PrivateDnsNamespace.Vpc`: Cloud Map's
   *   `GetNamespace` does NOT return the VPC ID — it is only consumed at
   *   create time and surfaced in opaque form via
   *   `Properties.DnsProperties.HostedZoneId`. Without this declaration
   *   the comparator would walk into `Vpc` (state has it because cdkd
   *   stored the user-supplied template value) and report a guaranteed
   *   false-positive on every clean drift run, since `readCurrentState`
   *   deliberately omits the key.
   */
  getDriftUnknownPaths(resourceType: string): string[] {
    if (resourceType === 'AWS::ServiceDiscovery::PrivateDnsNamespace') {
      return ['Vpc'];
    }
    return [];
  }

  private async readNamespace(physicalId: string): Promise<Record<string, unknown> | undefined> {
    let ns;
    try {
      const resp = await this.getClient().send(new GetNamespaceCommand({ Id: physicalId }));
      ns = resp.Namespace;
    } catch (err) {
      if (err instanceof NamespaceNotFound) return undefined;
      throw err;
    }
    if (!ns) return undefined;

    const result: Record<string, unknown> = {};
    if (ns.Name !== undefined) result['Name'] = ns.Name;
    result['Description'] = ns.Description ?? '';
    // Properties.DnsProperties.SOA.TTL is the only mutable nested field
    // (PR #195's update path round-trips it). Surface it on read too so
    // the comparator can detect a console-side TTL change. Always emit
    // the Properties placeholder for v3 baseline parity.
    const soa = ns.Properties?.DnsProperties?.SOA;
    if (soa?.TTL !== undefined) {
      result['Properties'] = { DnsProperties: { SOA: { TTL: soa.TTL } } };
    } else {
      result['Properties'] = {};
    }
    if (ns.Arn) await this.attachTags(result, ns.Arn);
    return result;
  }

  private async readService(physicalId: string): Promise<Record<string, unknown> | undefined> {
    let svc;
    try {
      const resp = await this.getClient().send(new GetServiceCommand({ Id: physicalId }));
      svc = resp.Service;
    } catch (err) {
      if (err instanceof ServiceNotFound) return undefined;
      throw err;
    }
    if (!svc) return undefined;

    const result: Record<string, unknown> = {};
    if (svc.Name !== undefined) result['Name'] = svc.Name;
    if (svc.NamespaceId !== undefined) result['NamespaceId'] = svc.NamespaceId;
    result['Description'] = svc.Description ?? '';
    if (svc.Type !== undefined) result['Type'] = svc.Type;
    if (svc.DnsConfig) {
      result['DnsConfig'] = svc.DnsConfig as unknown as Record<string, unknown>;
    }
    if (svc.HealthCheckConfig) {
      result['HealthCheckConfig'] = svc.HealthCheckConfig as unknown as Record<string, unknown>;
    }
    if (svc.HealthCheckCustomConfig) {
      result['HealthCheckCustomConfig'] = svc.HealthCheckCustomConfig as unknown as Record<
        string,
        unknown
      >;
    }

    // ServiceAttributes via GetServiceAttributes (a separate call from
    // GetService). Emit the full key→value map so a console-side attribute
    // change surfaces as drift against the deploy-time baseline. On a
    // permission / transient error leave the key absent rather than firing
    // false drift on every run (matching attachTags' best-effort posture);
    // the drift comparator is state-keys-only so an absent key is safe.
    try {
      const attrsResp = await this.getClient().send(
        new GetServiceAttributesCommand({ ServiceId: physicalId })
      );
      result['ServiceAttributes'] = attrsResp.ServiceAttributes?.Attributes ?? {};
    } catch (err) {
      this.logger.debug(
        `ServiceDiscovery GetServiceAttributes(${physicalId}) failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (svc.Arn) await this.attachTags(result, svc.Arn);
    return result;
  }

  /**
   * Normalize a CFn `ServiceAttributes` value (a bare key→value JSON map) into
   * the SDK's `Attributes` shape (`Record<string,string>`). Only string /
   * number / boolean values are coerced via `String()`; a non-scalar value is
   * malformed input and is dropped rather than stringified to `[object
   * Object]`. A non-object input (absent / null / array) yields `{}` so callers
   * can branch on `Object.keys(...).length`.
   */
  private normalizeServiceAttributes(raw: unknown): Record<string, string> {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v === undefined || v === null) continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        out[k] = String(v);
      }
    }
    return out;
  }

  /** Best-effort tag fetch via `ListTagsForResource(ResourceARN)`. */
  private async attachTags(result: Record<string, unknown>, arn: string): Promise<void> {
    try {
      const tagsResp = await this.getClient().send(
        new ListTagsForResourceCommand({ ResourceARN: arn })
      );
      const tags = normalizeAwsTagsToCfn(tagsResp.Tags);
      result['Tags'] = tags;
    } catch (err) {
      this.logger.debug(
        `ServiceDiscovery ListTagsForResource(${arn}) failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    switch (input.resourceType) {
      case 'AWS::ServiceDiscovery::PrivateDnsNamespace':
        return this.importNamespaceResource(input);
      case 'AWS::ServiceDiscovery::Service':
        return this.importServiceResource(input);
      default:
        return null;
    }
  }

  private async importNamespaceResource(
    input: ResourceImportInput
  ): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      try {
        await this.getClient().send(new GetNamespaceCommand({ Id: input.knownPhysicalId }));
        return { physicalId: input.knownPhysicalId, attributes: {} };
      } catch (err) {
        if (err instanceof NamespaceNotFound) return null;
        throw err;
      }
    }

    const desiredName =
      typeof input.properties?.['Name'] === 'string' ? input.properties['Name'] : undefined;

    let token: string | undefined;
    do {
      const list = await this.getClient().send(
        new ListNamespacesCommand({ ...(token && { NextToken: token }) })
      );
      for (const ns of list.Namespaces ?? []) {
        if (!ns.Id || !ns.Arn) continue;
        if (desiredName && ns.Name === desiredName) {
          return { physicalId: ns.Id, attributes: {} };
        }
        if (input.cdkPath) {
          try {
            const tagsResp = await this.getClient().send(
              new ListTagsForResourceCommand({ ResourceARN: ns.Arn })
            );
            if (matchesCdkPath(tagsResp.Tags, input.cdkPath)) {
              return { physicalId: ns.Id, attributes: {} };
            }
          } catch (err) {
            if (err instanceof NamespaceNotFound) continue;
            throw err;
          }
        }
      }
      token = list.NextToken;
    } while (token);
    return null;
  }

  private async importServiceResource(
    input: ResourceImportInput
  ): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      try {
        await this.getClient().send(new GetServiceCommand({ Id: input.knownPhysicalId }));
        return { physicalId: input.knownPhysicalId, attributes: {} };
      } catch (err) {
        if (err instanceof ServiceNotFound) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    let token: string | undefined;
    do {
      const list = await this.getClient().send(
        new ListServicesCommand({ ...(token && { NextToken: token }) })
      );
      for (const svc of list.Services ?? []) {
        if (!svc.Id || !svc.Arn) continue;
        try {
          const tagsResp = await this.getClient().send(
            new ListTagsForResourceCommand({ ResourceARN: svc.Arn })
          );
          if (matchesCdkPath(tagsResp.Tags, input.cdkPath)) {
            return { physicalId: svc.Id, attributes: {} };
          }
        } catch (err) {
          if (err instanceof ServiceNotFound) continue;
          throw err;
        }
      }
      token = list.NextToken;
    } while (token);
    return null;
  }

  /**
   * Build a namespace ARN from namespace ID.
   * Format: arn:aws:servicediscovery:{region}:{account}:namespace/{namespaceId}
   */
  private async buildNamespaceArn(namespaceId: string): Promise<string> {
    const stsClient = this.getStsClient();
    const identity = await stsClient.send(new GetCallerIdentityCommand({}));
    const accountId = identity.Account || '';
    const region = await this.getClient().config.region();
    return `arn:aws:servicediscovery:${region}:${accountId}:namespace/${namespaceId}`;
  }
}
