import {
  RDSClient,
  CreateDBProxyEndpointCommand,
  ModifyDBProxyEndpointCommand,
  DeleteDBProxyEndpointCommand,
  DescribeDBProxyEndpointsCommand,
  ListTagsForResourceCommand,
  AddTagsToResourceCommand,
  RemoveTagsFromResourceCommand,
  DBProxyEndpointNotFoundFault,
  DBProxyNotFoundFault,
  type DBProxyEndpointTargetRole,
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
 * AWS RDS DBProxyEndpoint Provider
 *
 * Implements resource provisioning for `AWS::RDS::DBProxyEndpoint` — the
 * additional read/write or read-only endpoint that can be attached to a
 * parent DBProxy.
 *
 * **Why a dedicated SDK provider** (per `feedback_dedicated_provider_over_special_case.md`):
 * completes the RDS DBProxy family started in PR #387 (`DBProxyTargetGroup`)
 * and PR #394 (`DBProxy`). Keeps the whole family on one codebase so create /
 * update / delete handling stays consistent across the parent + endpoints +
 * target-group children.
 *
 * **Lifecycle**:
 * - `create`: validates required fields (`DBProxyName` / `VpcSubnetIds`),
 *   issues `CreateDBProxyEndpointCommand`, then polls `DescribeDBProxyEndpoints`
 *   until `Status === 'available'`. Returns `physicalId = DBProxyEndpointName`
 *   plus `Endpoint` / `DBProxyEndpointArn` / `IsDefault` / `VpcId` in
 *   `attributes`.
 * - `update`: `ModifyDBProxyEndpointCommand` for the mutable fields
 *   (`VpcSecurityGroupIds` → SDK input `VpcSecurityGroupIds`,
 *   `NewDBProxyEndpointName` via rename). Tags diff via separate
 *   `AddTagsToResource` / `RemoveTagsFromResource` calls. DBProxyName /
 *   VpcSubnetIds / TargetRole are immutable on AWS.
 * - `delete`: `DeleteDBProxyEndpointCommand`, then polls until
 *   `DBProxyEndpointNotFoundFault`. Idempotent on NotFound (region-match
 *   gated). `DBProxyNotFoundFault` also idempotent — if the parent DBProxy
 *   is already gone via CASCADE, the endpoint is too.
 * - `getAttribute`: `Endpoint` / `DBProxyEndpointArn` / `IsDefault` / `VpcId`
 *   via `DescribeDBProxyEndpoints`, cached per `(physicalId, attribute)`.
 * - `import`: explicit `--resource <id>=<DBProxyEndpointName>` first; falls
 *   back to paginated auto-lookup via `DescribeDBProxyEndpoints` +
 *   `ListTagsForResource` matching `aws:cdk:path`.
 *
 * **physicalId** = DBProxyEndpointName (matches CFn `primaryIdentifier`).
 */
export class RDSDBProxyEndpointProvider implements ResourceProvider {
  private rdsClient?: RDSClient;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('RDSDBProxyEndpointProvider');
  private readonly attributeCache = new Map<string, unknown>();

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::RDS::DBProxyEndpoint',
      new Set([
        'DBProxyEndpointName',
        'DBProxyName',
        'VpcSubnetIds',
        'VpcSecurityGroupIds',
        'TargetRole',
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
    const dbProxyName = properties['DBProxyName'] as string | undefined;
    if (!dbProxyName) {
      throw new ProvisioningError(
        `DBProxyName is required for AWS::RDS::DBProxyEndpoint ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    const dbProxyEndpointName =
      (properties['DBProxyEndpointName'] as string | undefined) ??
      generateResourceName(logicalId, { maxLength: 64 });
    const vpcSubnetIds = properties['VpcSubnetIds'] as string[] | undefined;
    if (!vpcSubnetIds || vpcSubnetIds.length === 0) {
      throw new ProvisioningError(
        `VpcSubnetIds (at least one) is required for AWS::RDS::DBProxyEndpoint ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const client = this.getClient();
    this.logger.debug(`Creating DBProxyEndpoint ${dbProxyEndpointName} (proxy=${dbProxyName})`);

    try {
      await client.send(
        new CreateDBProxyEndpointCommand({
          DBProxyName: dbProxyName,
          DBProxyEndpointName: dbProxyEndpointName,
          VpcSubnetIds: vpcSubnetIds,
          VpcSecurityGroupIds: properties['VpcSecurityGroupIds'] as string[] | undefined,
          TargetRole: properties['TargetRole'] as DBProxyEndpointTargetRole | undefined,
          Tags: this.toAwsTags(properties['Tags']),
        })
      );
    } catch (error) {
      throw this.wrapError(error, 'CREATE', resourceType, logicalId, undefined);
    }

    let endpoint: string | undefined;
    let arn: string | undefined;
    let isDefault: boolean | undefined;
    let vpcId: string | undefined;
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let status: string | undefined;
    while (Date.now() < deadline) {
      try {
        const describe = await client.send(
          new DescribeDBProxyEndpointsCommand({
            DBProxyName: dbProxyName,
            DBProxyEndpointName: dbProxyEndpointName,
          })
        );
        const ep = describe.DBProxyEndpoints?.[0];
        status = ep?.Status;
        if (status === 'available') {
          endpoint = ep?.Endpoint;
          arn = ep?.DBProxyEndpointArn;
          isDefault = ep?.IsDefault;
          vpcId = ep?.VpcId;
          break;
        }
        if (status === 'incompatible-network' || status === 'insufficient-resource-limits') {
          throw new ProvisioningError(
            `DBProxyEndpoint ${dbProxyEndpointName} entered terminal failure state: ${status}`,
            resourceType,
            logicalId,
            dbProxyEndpointName
          );
        }
      } catch (error) {
        if (
          error instanceof DBProxyEndpointNotFoundFault ||
          error instanceof DBProxyNotFoundFault
        ) {
          // Not yet visible — keep polling.
        } else if (error instanceof ProvisioningError) {
          throw error;
        } else {
          throw this.wrapError(
            error,
            'CREATE (poll)',
            resourceType,
            logicalId,
            dbProxyEndpointName
          );
        }
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    if (!endpoint || !arn) {
      throw new ProvisioningError(
        `Timed out waiting for DBProxyEndpoint ${dbProxyEndpointName} to become available (last status: ${status ?? 'unknown'})`,
        resourceType,
        logicalId,
        dbProxyEndpointName
      );
    }

    return {
      physicalId: dbProxyEndpointName,
      attributes: {
        Endpoint: endpoint,
        DBProxyEndpointArn: arn,
        IsDefault: isDefault ?? false,
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
    for (const field of ['DBProxyName', 'DBProxyEndpointName', 'VpcSubnetIds', 'TargetRole']) {
      if (JSON.stringify(properties[field]) !== JSON.stringify(previousProperties[field])) {
        throw new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          `${field} is immutable on AWS::RDS::DBProxyEndpoint — destroy + redeploy to change it`
        );
      }
    }

    // AWS only allows VpcSecurityGroupIds + NewDBProxyEndpointName on
    // ModifyDBProxyEndpoint. TargetRole / VpcSubnetIds / DBProxyName are
    // immutable (rejected above).
    const oldSG = (previousProperties['VpcSecurityGroupIds'] as string[]) ?? [];
    const newSG = (properties['VpcSecurityGroupIds'] as string[]) ?? [];
    if (JSON.stringify(oldSG) !== JSON.stringify(newSG)) {
      this.logger.debug(`Updating DBProxyEndpoint ${physicalId} security groups`);
      try {
        await client.send(
          new ModifyDBProxyEndpointCommand({
            DBProxyEndpointName: physicalId,
            VpcSecurityGroupIds: newSG,
          })
        );
      } catch (error) {
        throw this.wrapError(error, 'UPDATE', resourceType, logicalId, physicalId);
      }
    }

    await this.applyTagDiff(
      physicalId,
      previousProperties['Tags'],
      properties['Tags'],
      resourceType,
      logicalId
    );

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

    this.logger.debug(`Deleting DBProxyEndpoint ${physicalId}`);

    try {
      await client.send(new DeleteDBProxyEndpointCommand({ DBProxyEndpointName: physicalId }));
    } catch (error) {
      if (error instanceof DBProxyEndpointNotFoundFault || error instanceof DBProxyNotFoundFault) {
        const clientRegion = await client.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(
          `DBProxyEndpoint ${physicalId} or parent already gone, treating as success`
        );
        return;
      }
      throw this.wrapError(error, 'DELETE', resourceType, logicalId, physicalId);
    }

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        await client.send(new DescribeDBProxyEndpointsCommand({ DBProxyEndpointName: physicalId }));
      } catch (error) {
        if (
          error instanceof DBProxyEndpointNotFoundFault ||
          error instanceof DBProxyNotFoundFault
        ) {
          this.logger.debug(`DBProxyEndpoint ${physicalId} fully deleted`);
          return;
        }
        throw this.wrapError(error, 'DELETE (poll)', resourceType, logicalId, physicalId);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new ProvisioningError(
      `Timed out waiting for DBProxyEndpoint ${physicalId} to fully delete`,
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
      attributeName !== 'DBProxyEndpointArn' &&
      attributeName !== 'IsDefault' &&
      attributeName !== 'VpcId'
    ) {
      this.logger.warn(
        `Unknown attribute ${attributeName} for AWS::RDS::DBProxyEndpoint, returning undefined`
      );
      return undefined;
    }

    try {
      const describe = await this.getClient().send(
        new DescribeDBProxyEndpointsCommand({ DBProxyEndpointName: physicalId })
      );
      const ep = describe.DBProxyEndpoints?.[0];
      if (!ep) return undefined;
      const map: Record<string, unknown> = {
        Endpoint: ep.Endpoint,
        DBProxyEndpointArn: ep.DBProxyEndpointArn,
        IsDefault: ep.IsDefault ?? false,
        VpcId: ep.VpcId,
      };
      const value = map[attributeName];
      if (value !== undefined) this.attributeCache.set(cacheKey, value);
      return value;
    } catch (error) {
      if (error instanceof DBProxyEndpointNotFoundFault || error instanceof DBProxyNotFoundFault) {
        return undefined;
      }
      throw error;
    }
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'DBProxyEndpointName');
    if (explicit) {
      return this.buildImportResult(explicit);
    }

    const client = this.getClient();
    let marker: string | undefined;
    do {
      const describe = await client.send(
        new DescribeDBProxyEndpointsCommand({ Marker: marker, MaxRecords: 100 })
      );
      for (const ep of describe.DBProxyEndpoints ?? []) {
        if (!ep.DBProxyEndpointArn) continue;
        try {
          const tags = await client.send(
            new ListTagsForResourceCommand({ ResourceName: ep.DBProxyEndpointArn })
          );
          if (matchesCdkPath(tags.TagList ?? [], input.cdkPath)) {
            return this.buildImportResult(ep.DBProxyEndpointName ?? '');
          }
        } catch (error) {
          this.logger.debug(
            `ListTagsForResource failed for ${ep.DBProxyEndpointName}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      marker = describe.Marker;
    } while (marker);
    return null;
  }

  async readCurrentState(physicalId: string): Promise<Record<string, unknown> | undefined> {
    const client = this.getClient();
    let ep: unknown;
    try {
      const describe = await client.send(
        new DescribeDBProxyEndpointsCommand({ DBProxyEndpointName: physicalId })
      );
      ep = describe.DBProxyEndpoints?.[0];
      if (!ep) return undefined;
    } catch (error) {
      if (error instanceof DBProxyEndpointNotFoundFault || error instanceof DBProxyNotFoundFault) {
        return undefined;
      }
      throw error;
    }
    const e = ep as {
      DBProxyEndpointName?: string;
      DBProxyEndpointArn?: string;
      DBProxyName?: string;
      VpcSubnetIds?: string[];
      VpcSecurityGroupIds?: string[];
      TargetRole?: string;
    };
    const result: Record<string, unknown> = {
      DBProxyEndpointName: e.DBProxyEndpointName,
      DBProxyName: e.DBProxyName,
      VpcSubnetIds: e.VpcSubnetIds ?? [],
      VpcSecurityGroupIds: e.VpcSecurityGroupIds ?? [],
      TargetRole: e.TargetRole ?? 'READ_WRITE',
    };

    if (e.DBProxyEndpointArn) {
      try {
        const tagResp = await client.send(
          new ListTagsForResourceCommand({ ResourceName: e.DBProxyEndpointArn })
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
    const oldMap = this.toTagMap(oldTags);
    const newMap = this.toTagMap(newTags);

    // Reviewer minor fix: skip the ARN-resolution Describe entirely when
    // there is no tag diff to apply.
    const sameKeys = oldMap.size === newMap.size && [...oldMap.keys()].every((k) => newMap.has(k));
    const sameValues = sameKeys && [...oldMap.entries()].every(([k, v]) => newMap.get(k) === v);
    if (sameValues) return;

    const client = this.getClient();
    const arnCacheKey = `${physicalId}:DBProxyEndpointArn`;
    let arn = this.attributeCache.get(arnCacheKey) as string | undefined;
    if (!arn) {
      try {
        const describe = await client.send(
          new DescribeDBProxyEndpointsCommand({ DBProxyEndpointName: physicalId })
        );
        arn = describe.DBProxyEndpoints?.[0]?.DBProxyEndpointArn;
        if (arn) this.attributeCache.set(arnCacheKey, arn);
      } catch (error) {
        this.logger.debug(
          `Skipping tag diff for ${physicalId} (no ARN): ${error instanceof Error ? error.message : String(error)}`
        );
        return;
      }
    }
    if (!arn) return;

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
    try {
      const describe = await this.getClient().send(
        new DescribeDBProxyEndpointsCommand({ DBProxyEndpointName: physicalId })
      );
      const ep = describe.DBProxyEndpoints?.[0];
      return {
        physicalId,
        attributes: {
          Endpoint: ep?.Endpoint ?? '',
          DBProxyEndpointArn: ep?.DBProxyEndpointArn ?? '',
          IsDefault: ep?.IsDefault ?? false,
          VpcId: ep?.VpcId ?? '',
        },
      };
    } catch {
      return {
        physicalId,
        attributes: { Endpoint: '', DBProxyEndpointArn: '', IsDefault: false, VpcId: '' },
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
