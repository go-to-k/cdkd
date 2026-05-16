import {
  RDSClient,
  CreateDBProxyCommand,
  ModifyDBProxyCommand,
  DeleteDBProxyCommand,
  DescribeDBProxiesCommand,
  ListTagsForResourceCommand,
  AddTagsToResourceCommand,
  RemoveTagsFromResourceCommand,
  DBProxyNotFoundFault,
  type UserAuthConfig,
  type EngineFamily,
  type Tag,
} from '@aws-sdk/client-rds';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import {
  matchesCdkPath,
  normalizeAwsTagsToCfn,
  resolveExplicitPhysicalId,
} from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * AWS RDS DBProxy Provider
 *
 * Implements resource provisioning for `AWS::RDS::DBProxy`.
 *
 * **Why a dedicated SDK provider** (per `feedback_dedicated_provider_over_special_case.md`):
 * keeps the AWS::RDS::DBProxy family (DBProxy + DBProxyTargetGroup) on one
 * codebase. Pre-PR DBProxy went through CC API, which worked for create
 * and delete but the sibling DBProxyTargetGroup type was broken — moving
 * the parent type to a dedicated provider ensures the whole family is
 * consistent and lets us evolve both surfaces together (e.g. shared
 * `DescribeDBProxies` calls in future enrichment, common error handling).
 *
 * **Lifecycle**:
 * - `create`: `CreateDBProxyCommand`, then poll `DescribeDBProxies` until
 *   `DBProxyStatus === 'available'`. Returns physicalId=DBProxyName plus
 *   `Endpoint` / `DBProxyArn` / `VpcId` in attributes.
 * - `update`: `ModifyDBProxyCommand` for the mutable fields (Auth /
 *   DebugLogging / IdleClientTimeout / RequireTLS / RoleArn /
 *   SecurityGroups). Tags handled via separate `AddTagsToResource` /
 *   `RemoveTagsFromResource` diff. EngineFamily and VpcSubnetIds are
 *   immutable on AWS; a diff in those surfaces as `ResourceReplacement`
 *   from the deploy engine, not handled here.
 * - `delete`: `DeleteDBProxyCommand`, then poll for `DBProxyNotFoundFault`
 *   to confirm full removal (AWS keeps the proxy in `deleting` state for
 *   ~30-60s after the delete returns). `DBProxyNotFoundFault` at any
 *   point is treated as idempotent success (region-match-gated).
 * - `getAttribute`: `DescribeDBProxies` for `Endpoint` / `DBProxyArn` /
 *   `VpcId`, cached per `(physicalId, attribute)`.
 * - `import`: explicit `--resource` override OR auto-lookup via
 *   `DescribeDBProxies` + `ListTagsForResource` matching `aws:cdk:path`.
 *
 * **physicalId** = DBProxyName (matches CFn `primaryIdentifier`).
 */
export class RDSDBProxyProvider implements ResourceProvider {
  private rdsClient?: RDSClient;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('RDSDBProxyProvider');
  private readonly attributeCache = new Map<string, unknown>();

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::RDS::DBProxy',
      new Set([
        'DBProxyName',
        'EngineFamily',
        'Auth',
        'RoleArn',
        'VpcSubnetIds',
        'VpcSecurityGroupIds',
        'RequireTLS',
        'IdleClientTimeout',
        'DebugLogging',
        'Tags',
      ]),
    ],
  ]);

  private getClient(): RDSClient {
    if (!this.rdsClient) {
      this.rdsClient = new RDSClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.rdsClient;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    const dbProxyName =
      (properties['DBProxyName'] as string | undefined) ??
      generateResourceName(logicalId, { maxLength: 64 });
    const engineFamily = properties['EngineFamily'] as EngineFamily | undefined;
    if (!engineFamily) {
      throw new ProvisioningError(
        `EngineFamily is required for AWS::RDS::DBProxy ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    const auth = properties['Auth'] as UserAuthConfig[] | undefined;
    if (!auth || auth.length === 0) {
      throw new ProvisioningError(
        `Auth (at least one entry) is required for AWS::RDS::DBProxy ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    const roleArn = properties['RoleArn'] as string | undefined;
    if (!roleArn) {
      throw new ProvisioningError(
        `RoleArn is required for AWS::RDS::DBProxy ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    const vpcSubnetIds = properties['VpcSubnetIds'] as string[] | undefined;
    if (!vpcSubnetIds || vpcSubnetIds.length === 0) {
      throw new ProvisioningError(
        `VpcSubnetIds (at least one) is required for AWS::RDS::DBProxy ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const client = this.getClient();

    this.logger.debug(`Creating DBProxy ${dbProxyName} (${engineFamily})`);

    try {
      await client.send(
        new CreateDBProxyCommand({
          DBProxyName: dbProxyName,
          EngineFamily: engineFamily,
          Auth: auth,
          RoleArn: roleArn,
          VpcSubnetIds: vpcSubnetIds,
          VpcSecurityGroupIds: properties['VpcSecurityGroupIds'] as string[] | undefined,
          RequireTLS: properties['RequireTLS'] as boolean | undefined,
          IdleClientTimeout: properties['IdleClientTimeout'] as number | undefined,
          DebugLogging: properties['DebugLogging'] as boolean | undefined,
          Tags: this.toAwsTags(properties['Tags']),
        })
      );
    } catch (error) {
      throw this.wrapError(error, 'CREATE', resourceType, logicalId, undefined);
    }

    // Wait until DBProxyStatus = 'available'. Post-create wiring (Targets via
    // RDSDBProxyTargetGroupProvider.create()) requires the proxy to be
    // available, so blocking here keeps the deploy engine's DAG consistent.
    let endpoint: string | undefined;
    let dbProxyArn: string | undefined;
    let vpcId: string | undefined;
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let status: string | undefined;
    while (Date.now() < deadline) {
      try {
        const describe = await client.send(
          new DescribeDBProxiesCommand({ DBProxyName: dbProxyName })
        );
        const proxy = describe.DBProxies?.[0];
        status = proxy?.Status;
        if (status === 'available') {
          endpoint = proxy?.Endpoint;
          dbProxyArn = proxy?.DBProxyArn;
          vpcId = proxy?.VpcId;
          break;
        }
        if (status === 'incompatible-network' || status === 'insufficient-resource-limits') {
          throw new ProvisioningError(
            `DBProxy ${dbProxyName} entered terminal failure state: ${status}`,
            resourceType,
            logicalId,
            dbProxyName
          );
        }
      } catch (error) {
        if (error instanceof DBProxyNotFoundFault) {
          // Not yet visible — keep polling.
        } else if (error instanceof ProvisioningError) {
          throw error;
        } else {
          throw this.wrapError(error, 'CREATE (poll)', resourceType, logicalId, dbProxyName);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    if (!endpoint || !dbProxyArn) {
      throw new ProvisioningError(
        `Timed out waiting for DBProxy ${dbProxyName} to become available (last status: ${status ?? 'unknown'})`,
        resourceType,
        logicalId,
        dbProxyName
      );
    }

    return {
      physicalId: dbProxyName,
      attributes: {
        DBProxyArn: dbProxyArn,
        Endpoint: endpoint,
        VpcId: vpcId ?? '',
      },
    };
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    const client = this.getClient();

    // Defensive: reject diffs in immutable fields. Replacement-rules.ts
    // SHOULD have routed those to a CREATE+DELETE replacement upstream, but
    // we double-check here so a missing rule entry doesn't silently corrupt
    // state (the PR #387 round 1 blocker class).
    for (const field of ['DBProxyName', 'EngineFamily', 'VpcSubnetIds']) {
      if (JSON.stringify(properties[field]) !== JSON.stringify(previousProperties[field])) {
        throw new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          `${field} is immutable on AWS::RDS::DBProxy — destroy + redeploy to change it`
        );
      }
    }

    const input: Record<string, unknown> = { DBProxyName: physicalId };
    let hasModify = false;
    const mutableFields: Array<keyof typeof properties> = [
      'Auth',
      'RequireTLS',
      'IdleClientTimeout',
      'DebugLogging',
      'RoleArn',
      'VpcSecurityGroupIds',
    ];
    for (const key of mutableFields) {
      if (JSON.stringify(properties[key]) !== JSON.stringify(previousProperties[key])) {
        // Translate VpcSecurityGroupIds → SecurityGroups (CFn → SDK shape).
        const sdkKey = key === 'VpcSecurityGroupIds' ? 'SecurityGroups' : key;
        input[sdkKey] = properties[key];
        hasModify = true;
      }
    }

    if (hasModify) {
      this.logger.debug(
        `Updating DBProxy ${physicalId}: ${Object.keys(input)
          .filter((k) => k !== 'DBProxyName')
          .join(', ')}`
      );
      try {
        await client.send(new ModifyDBProxyCommand(input as never));
      } catch (error) {
        throw this.wrapError(error, 'UPDATE', resourceType, logicalId, physicalId);
      }
    }

    // Tag diff via separate Add/Remove APIs.
    await this.applyTagDiff(
      physicalId,
      previousProperties['Tags'],
      properties['Tags'],
      resourceType,
      logicalId
    );

    // Invalidate attribute cache so subsequent getAttribute reads pick up
    // the latest Endpoint / etc. (Endpoint is immutable in practice; this
    // is defense-in-depth for any future AWS-side change).
    this.invalidateAttributeCache(physicalId);

    return { physicalId, wasReplaced: false };
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    const client = this.getClient();

    this.logger.debug(`Deleting DBProxy ${physicalId}`);

    try {
      await client.send(new DeleteDBProxyCommand({ DBProxyName: physicalId }));
    } catch (error) {
      if (error instanceof DBProxyNotFoundFault) {
        const clientRegion = await client.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`DBProxy ${physicalId} already gone, treating as success`);
        return;
      }
      throw this.wrapError(error, 'DELETE', resourceType, logicalId, physicalId);
    }

    // Wait for the proxy to fully disappear. AWS keeps the resource in
    // `deleting` state for ~30-60s before DescribeDBProxies starts
    // returning DBProxyNotFoundFault — without this wait, a subsequent
    // `cdkd deploy` of a same-named proxy can race AWS's eventual delete.
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        await client.send(new DescribeDBProxiesCommand({ DBProxyName: physicalId }));
      } catch (error) {
        if (error instanceof DBProxyNotFoundFault) {
          this.logger.debug(`DBProxy ${physicalId} fully deleted`);
          return;
        }
        throw this.wrapError(error, 'DELETE (poll)', resourceType, logicalId, physicalId);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new ProvisioningError(
      `Timed out waiting for DBProxy ${physicalId} to fully delete`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    const cacheKey = `${physicalId}:${attributeName}`;
    const cached = this.attributeCache.get(cacheKey);
    if (cached !== undefined) return cached;

    if (
      attributeName !== 'Endpoint' &&
      attributeName !== 'DBProxyArn' &&
      attributeName !== 'VpcId'
    ) {
      this.logger.warn(
        `Unknown attribute ${attributeName} for AWS::RDS::DBProxy, returning undefined`
      );
      return undefined;
    }

    try {
      const describe = await this.getClient().send(
        new DescribeDBProxiesCommand({ DBProxyName: physicalId })
      );
      const proxy = describe.DBProxies?.[0];
      if (!proxy) return undefined;
      const map: Record<string, unknown> = {
        Endpoint: proxy.Endpoint,
        DBProxyArn: proxy.DBProxyArn,
        VpcId: proxy.VpcId,
      };
      const value = map[attributeName];
      if (value !== undefined) this.attributeCache.set(cacheKey, value);
      return value;
    } catch (error) {
      if (error instanceof DBProxyNotFoundFault) return undefined;
      throw error;
    }
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'DBProxyName');
    if (explicit) {
      return this.buildImportResult(explicit);
    }

    // Auto-lookup: paginated DescribeDBProxies + per-proxy ListTagsForResource.
    const client = this.getClient();
    let marker: string | undefined;
    do {
      const describe = await client.send(
        new DescribeDBProxiesCommand({ Marker: marker, MaxRecords: 100 })
      );
      for (const proxy of describe.DBProxies ?? []) {
        if (!proxy.DBProxyArn) continue;
        try {
          const tags = await client.send(
            new ListTagsForResourceCommand({ ResourceName: proxy.DBProxyArn })
          );
          if (matchesCdkPath(tags.TagList ?? [], input.cdkPath)) {
            return this.buildImportResult(proxy.DBProxyName ?? '');
          }
        } catch (error) {
          this.logger.debug(
            `ListTagsForResource failed for ${proxy.DBProxyName}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      marker = describe.Marker;
    } while (marker);
    return null;
  }

  /**
   * Reads the AWS-current configuration. Drift comparator uses this as the
   * authoritative snapshot for resources written under schema v3+.
   */
  async readCurrentState(physicalId: string): Promise<Record<string, unknown> | undefined> {
    const client = this.getClient();
    let proxy: unknown;
    try {
      const describe = await client.send(new DescribeDBProxiesCommand({ DBProxyName: physicalId }));
      proxy = describe.DBProxies?.[0];
      if (!proxy) return undefined;
    } catch (error) {
      if (error instanceof DBProxyNotFoundFault) return undefined;
      throw error;
    }
    const p = proxy as {
      DBProxyName?: string;
      DBProxyArn?: string;
      EngineFamily?: string;
      RoleArn?: string;
      VpcSubnetIds?: string[];
      VpcSecurityGroupIds?: string[];
      RequireTLS?: boolean;
      IdleClientTimeout?: number;
      DebugLogging?: boolean;
      Auth?: Array<{
        Description?: string;
        UserName?: string;
        AuthScheme?: string;
        SecretArn?: string;
        IAMAuth?: string;
        ClientPasswordAuthType?: string;
      }>;
    };
    const result: Record<string, unknown> = {
      DBProxyName: p.DBProxyName,
      EngineFamily: p.EngineFamily,
      RoleArn: p.RoleArn,
      VpcSubnetIds: p.VpcSubnetIds ?? [],
      VpcSecurityGroupIds: p.VpcSecurityGroupIds ?? [],
      RequireTLS: p.RequireTLS ?? false,
      IdleClientTimeout: p.IdleClientTimeout,
      DebugLogging: p.DebugLogging ?? false,
      Auth: (p.Auth ?? []).map((a) => ({
        Description: a.Description,
        UserName: a.UserName,
        AuthScheme: a.AuthScheme,
        SecretArn: a.SecretArn,
        IAMAuth: a.IAMAuth,
        ClientPasswordAuthType: a.ClientPasswordAuthType,
      })),
    };

    // Tags via ListTagsForResource.
    if (p.DBProxyArn) {
      try {
        const tagResp = await client.send(
          new ListTagsForResourceCommand({ ResourceName: p.DBProxyArn })
        );
        result['Tags'] = normalizeAwsTagsToCfn(tagResp.TagList ?? []);
      } catch (error) {
        this.logger.debug(
          `ListTagsForResource failed for ${physicalId}: ${error instanceof Error ? error.message : String(error)}`
        );
        result['Tags'] = [];
      }
    } else {
      result['Tags'] = [];
    }

    return result;
  }

  private async applyTagDiff(
    physicalId: string,
    oldTags: unknown,
    newTags: unknown,
    resourceType: string,
    logicalId: string
  ): Promise<void> {
    const client = this.getClient();

    const arnCacheKey = `${physicalId}:DBProxyArn`;
    let arn = this.attributeCache.get(arnCacheKey) as string | undefined;
    if (!arn) {
      try {
        const describe = await client.send(
          new DescribeDBProxiesCommand({ DBProxyName: physicalId })
        );
        arn = describe.DBProxies?.[0]?.DBProxyArn;
        if (arn) this.attributeCache.set(arnCacheKey, arn);
      } catch (error) {
        // Can't tag without an ARN — log + skip.
        this.logger.debug(
          `Skipping tag diff for ${physicalId} (no ARN): ${error instanceof Error ? error.message : String(error)}`
        );
        return;
      }
    }
    if (!arn) return;

    const oldMap = this.toTagMap(oldTags);
    const newMap = this.toTagMap(newTags);

    const toRemove: string[] = [];
    const toAdd: Tag[] = [];
    for (const k of oldMap.keys()) {
      if (!newMap.has(k)) toRemove.push(k);
    }
    for (const [k, v] of newMap.entries()) {
      if (oldMap.get(k) !== v) toAdd.push({ Key: k, Value: v });
    }

    if (toRemove.length > 0) {
      try {
        await client.send(
          new RemoveTagsFromResourceCommand({ ResourceName: arn, TagKeys: toRemove })
        );
      } catch (error) {
        throw this.wrapError(error, 'UPDATE (remove tags)', resourceType, logicalId, physicalId);
      }
    }
    if (toAdd.length > 0) {
      try {
        await client.send(new AddTagsToResourceCommand({ ResourceName: arn, Tags: toAdd }));
      } catch (error) {
        throw this.wrapError(error, 'UPDATE (add tags)', resourceType, logicalId, physicalId);
      }
    }
  }

  private toTagMap(tags: unknown): Map<string, string> {
    const map = new Map<string, string>();
    if (Array.isArray(tags)) {
      for (const entry of tags as Array<{ Key?: string; Value?: string }>) {
        if (entry?.Key !== undefined) map.set(entry.Key, entry.Value ?? '');
      }
    }
    return map;
  }

  private toAwsTags(tags: unknown): Tag[] | undefined {
    if (!Array.isArray(tags) || tags.length === 0) return undefined;
    return (tags as Array<{ Key?: string; Value?: string }>)
      .filter((t) => t.Key !== undefined)
      .map((t) => ({ Key: t.Key, Value: t.Value ?? '' }));
  }

  private async buildImportResult(physicalId: string): Promise<ResourceImportResult> {
    // Recover attributes via DescribeDBProxies so the imported resource
    // gets the same shape a fresh create() would produce.
    try {
      const describe = await this.getClient().send(
        new DescribeDBProxiesCommand({ DBProxyName: physicalId })
      );
      const proxy = describe.DBProxies?.[0];
      return {
        physicalId,
        attributes: {
          DBProxyArn: proxy?.DBProxyArn ?? '',
          Endpoint: proxy?.Endpoint ?? '',
          VpcId: proxy?.VpcId ?? '',
        },
      };
    } catch {
      return {
        physicalId,
        attributes: { DBProxyArn: '', Endpoint: '', VpcId: '' },
      };
    }
  }

  private invalidateAttributeCache(physicalId: string): void {
    for (const key of this.attributeCache.keys()) {
      if (key.startsWith(`${physicalId}:`)) this.attributeCache.delete(key);
    }
  }

  private wrapError(
    error: unknown,
    op: string,
    resourceType: string,
    logicalId: string,
    physicalId: string | undefined
  ): ProvisioningError {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error ? error : undefined;
    return new ProvisioningError(
      `${op} failed for ${logicalId}: ${message}`,
      resourceType,
      logicalId,
      physicalId,
      cause
    );
  }
}
