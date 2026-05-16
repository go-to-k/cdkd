import {
  RDSClient,
  RegisterDBProxyTargetsCommand,
  DeregisterDBProxyTargetsCommand,
  DescribeDBProxyTargetGroupsCommand,
  DescribeDBProxyTargetsCommand,
  ModifyDBProxyTargetGroupCommand,
  DBProxyNotFoundFault,
  DBProxyTargetGroupNotFoundFault,
  DBProxyTargetNotFoundFault,
} from '@aws-sdk/client-rds';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * AWS RDS DBProxyTargetGroup Provider
 *
 * Implements resource provisioning for `AWS::RDS::DBProxyTargetGroup`.
 *
 * **Why a dedicated SDK provider** (per `feedback_dedicated_provider_over_special_case.md`):
 * pre-PR this type went through Cloud Control API, but CC API's resource
 * handler for `AWS::RDS::DBProxyTargetGroup` fails the delete path with
 * `Value null at 'dBProxyName' failed to satisfy constraint`. The handler
 * cannot derive `DBProxyName` from the TargetGroup ARN (the primary
 * identifier), so the underlying RDS API call goes out with
 * `DBProxyName: null` and AWS rejects it (Issue #385).
 *
 * **What this resource actually does on AWS**: a CFn
 * `AWS::RDS::DBProxyTargetGroup` is a wiring resource — every DBProxy gets
 * a default TargetGroup (`TargetGroupName: 'default'`) auto-created by AWS;
 * the CFn resource only manages target REGISTRATIONS
 * (`RegisterDBProxyTargets` / `DeregisterDBProxyTargets`) and the
 * connection pool config (`ModifyDBProxyTargetGroup`). The TargetGroup
 * object itself is not deleted on resource delete — it lives and dies with
 * the parent DBProxy.
 *
 * **Lifecycle**:
 * - `create`: optionally `ModifyDBProxyTargetGroup` (connection pool), then
 *   `RegisterDBProxyTargets` (cluster IDs and / or instance IDs), then
 *   `DescribeDBProxyTargetGroups` to recover the TargetGroupArn for state.
 * - `update`: rejected via `ResourceUpdateNotSupportedError` in MVP. The
 *   per-property update surface (add/remove targets, pool config rewrites)
 *   is a follow-up.
 * - `delete`: `DeregisterDBProxyTargets` for every registered target.
 *   `DBProxyNotFoundFault` / `DBProxyTargetGroupNotFoundFault` /
 *   `DBProxyTargetNotFoundFault` are treated as idempotent success
 *   (region-match-gated) — the parent DBProxy may already have been
 *   deleted by a sibling cdkd delete or by AWS CASCADE.
 * - `getAttribute`: `TargetGroupArn` returns the physicalId; `TargetGroupName`
 *   returns `'default'`.
 *
 * **physicalId** = TargetGroupArn (matches the CFn `primaryIdentifier`).
 */
export class RDSDBProxyTargetGroupProvider implements ResourceProvider {
  private rdsClient?: RDSClient;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('RDSDBProxyTargetGroupProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::RDS::DBProxyTargetGroup',
      new Set([
        'DBProxyName',
        'TargetGroupName',
        'DBClusterIdentifiers',
        'DBInstanceIdentifiers',
        'ConnectionPoolConfigurationInfo',
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
        `DBProxyName is required for AWS::RDS::DBProxyTargetGroup ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    const targetGroupName = (properties['TargetGroupName'] as string | undefined) ?? 'default';
    const dbClusterIdentifiers = properties['DBClusterIdentifiers'] as string[] | undefined;
    const dbInstanceIdentifiers = properties['DBInstanceIdentifiers'] as string[] | undefined;
    const connectionPoolConfig = properties['ConnectionPoolConfigurationInfo'] as
      | Record<string, unknown>
      | undefined;

    const client = this.getClient();

    if (connectionPoolConfig) {
      this.logger.debug(`Applying connection pool config to ${dbProxyName}/${targetGroupName}`);
      try {
        await client.send(
          new ModifyDBProxyTargetGroupCommand({
            DBProxyName: dbProxyName,
            TargetGroupName: targetGroupName,
            ConnectionPoolConfig: connectionPoolConfig as never,
          })
        );
      } catch (error) {
        throw this.wrapError(error, 'CREATE (pool config)', resourceType, logicalId, undefined);
      }
    }

    if (
      (dbClusterIdentifiers && dbClusterIdentifiers.length > 0) ||
      (dbInstanceIdentifiers && dbInstanceIdentifiers.length > 0)
    ) {
      this.logger.debug(
        `Registering targets for ${dbProxyName}/${targetGroupName}: ` +
          `clusters=[${dbClusterIdentifiers?.join(',') ?? ''}], ` +
          `instances=[${dbInstanceIdentifiers?.join(',') ?? ''}]`
      );
      try {
        await client.send(
          new RegisterDBProxyTargetsCommand({
            DBProxyName: dbProxyName,
            TargetGroupName: targetGroupName,
            DBClusterIdentifiers: dbClusterIdentifiers,
            DBInstanceIdentifiers: dbInstanceIdentifiers,
          })
        );
      } catch (error) {
        throw this.wrapError(
          error,
          'CREATE (register targets)',
          resourceType,
          logicalId,
          undefined
        );
      }
    }

    let targetGroupArn: string | undefined;
    try {
      const describeResponse = await client.send(
        new DescribeDBProxyTargetGroupsCommand({
          DBProxyName: dbProxyName,
          TargetGroupName: targetGroupName,
        })
      );
      targetGroupArn = describeResponse.TargetGroups?.[0]?.TargetGroupArn;
    } catch (error) {
      throw this.wrapError(error, 'CREATE (describe)', resourceType, logicalId, undefined);
    }

    if (!targetGroupArn) {
      throw new ProvisioningError(
        `Failed to recover TargetGroupArn for ${dbProxyName}/${targetGroupName} after create`,
        resourceType,
        logicalId
      );
    }

    return {
      physicalId: targetGroupArn,
      attributes: {
        TargetGroupArn: targetGroupArn,
        TargetGroupName: targetGroupName,
      },
    };
  }

  /**
   * In-place update support: target add/remove (DBClusterIdentifiers /
   * DBInstanceIdentifiers diff) via `RegisterDBProxyTargets` /
   * `DeregisterDBProxyTargets`, and ConnectionPoolConfigurationInfo
   * rewrite via `ModifyDBProxyTargetGroup`. DBProxyName + TargetGroupName
   * are part of the resource identity — a diff in either surfaces as
   * replacement upstream (not handled here).
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    const dbProxyName = properties['DBProxyName'] as string | undefined;
    if (!dbProxyName) {
      throw new ProvisioningError(
        `DBProxyName is required for AWS::RDS::DBProxyTargetGroup ${logicalId} update`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    const targetGroupName = (properties['TargetGroupName'] as string | undefined) ?? 'default';

    // Defensive: reject diffs in immutable identity fields. Replacement-rules.ts
    // SHOULD have routed those to a CREATE+DELETE replacement upstream; we
    // double-check here so a missing rule entry doesn't silently corrupt state.
    for (const field of ['DBProxyName', 'TargetGroupName']) {
      const oldVal = previousProperties[field];
      const newVal = properties[field];
      // TargetGroupName defaults to 'default' on AWS — treat undefined and
      // 'default' as equivalent on either side to avoid false-positive diff.
      const normalize = (v: unknown) =>
        field === 'TargetGroupName' && (v === undefined || v === 'default') ? 'default' : v;
      if (JSON.stringify(normalize(oldVal)) !== JSON.stringify(normalize(newVal))) {
        throw new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          `${field} is immutable on AWS::RDS::DBProxyTargetGroup — destroy + redeploy to change it`
        );
      }
    }

    const client = this.getClient();

    // 1. ConnectionPoolConfigurationInfo diff.
    const oldPool = previousProperties['ConnectionPoolConfigurationInfo'] as
      | Record<string, unknown>
      | undefined;
    const newPool = properties['ConnectionPoolConfigurationInfo'] as
      | Record<string, unknown>
      | undefined;
    if (JSON.stringify(oldPool) !== JSON.stringify(newPool)) {
      this.logger.debug(`Updating connection pool config for ${dbProxyName}/${targetGroupName}`);
      try {
        await client.send(
          new ModifyDBProxyTargetGroupCommand({
            DBProxyName: dbProxyName,
            TargetGroupName: targetGroupName,
            // Pass new config (may be empty {} when user removed the block;
            // AWS treats empty as "reset to defaults").
            ConnectionPoolConfig: (newPool ?? {}) as never,
          })
        );
      } catch (error) {
        throw this.wrapError(error, 'UPDATE (pool config)', resourceType, logicalId, physicalId);
      }
    }

    // 2. Target diff: deregister removed, register added. Process clusters
    // and instances independently so the SDK call shape stays clean.
    const oldClusters = new Set((previousProperties['DBClusterIdentifiers'] as string[]) ?? []);
    const newClusters = new Set((properties['DBClusterIdentifiers'] as string[]) ?? []);
    const oldInstances = new Set((previousProperties['DBInstanceIdentifiers'] as string[]) ?? []);
    const newInstances = new Set((properties['DBInstanceIdentifiers'] as string[]) ?? []);

    const clustersToRemove = [...oldClusters].filter((c) => !newClusters.has(c));
    const clustersToAdd = [...newClusters].filter((c) => !oldClusters.has(c));
    const instancesToRemove = [...oldInstances].filter((i) => !newInstances.has(i));
    const instancesToAdd = [...newInstances].filter((i) => !oldInstances.has(i));

    if (clustersToRemove.length > 0 || instancesToRemove.length > 0) {
      this.logger.debug(
        `Deregistering targets from ${dbProxyName}/${targetGroupName}: ` +
          `clusters=[${clustersToRemove.join(',')}], instances=[${instancesToRemove.join(',')}]`
      );
      try {
        await client.send(
          new DeregisterDBProxyTargetsCommand({
            DBProxyName: dbProxyName,
            TargetGroupName: targetGroupName,
            DBClusterIdentifiers: clustersToRemove.length > 0 ? clustersToRemove : undefined,
            DBInstanceIdentifiers: instancesToRemove.length > 0 ? instancesToRemove : undefined,
          })
        );
      } catch (error) {
        // Idempotent: a target that's already gone is fine — same shape
        // as delete()'s NotFound handling.
        if (!(error instanceof DBProxyTargetNotFoundFault)) {
          throw this.wrapError(error, 'UPDATE (deregister)', resourceType, logicalId, physicalId);
        }
      }
    }

    if (clustersToAdd.length > 0 || instancesToAdd.length > 0) {
      this.logger.debug(
        `Registering targets to ${dbProxyName}/${targetGroupName}: ` +
          `clusters=[${clustersToAdd.join(',')}], instances=[${instancesToAdd.join(',')}]`
      );
      try {
        await client.send(
          new RegisterDBProxyTargetsCommand({
            DBProxyName: dbProxyName,
            TargetGroupName: targetGroupName,
            DBClusterIdentifiers: clustersToAdd.length > 0 ? clustersToAdd : undefined,
            DBInstanceIdentifiers: instancesToAdd.length > 0 ? instancesToAdd : undefined,
          })
        );
      } catch (error) {
        throw this.wrapError(error, 'UPDATE (register)', resourceType, logicalId, physicalId);
      }
    }

    return { physicalId, wasReplaced: false };
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    const props = properties ?? {};
    const dbProxyName = props['DBProxyName'] as string | undefined;
    const targetGroupName = (props['TargetGroupName'] as string | undefined) ?? 'default';
    const dbClusterIdentifiers = props['DBClusterIdentifiers'] as string[] | undefined;
    const dbInstanceIdentifiers = props['DBInstanceIdentifiers'] as string[] | undefined;

    if (!dbProxyName) {
      // No way to deregister without DBProxyName. This shouldn't happen
      // when cdkd state was populated by this provider's create(), but
      // could occur on an imported / hand-edited state. Surface as a real
      // error rather than silently no-op so the user knows to clean up
      // manually.
      throw new ProvisioningError(
        `DBProxyName missing from state.properties for AWS::RDS::DBProxyTargetGroup ${logicalId}; cannot deregister targets. ` +
          `Manually run: aws rds deregister-db-proxy-targets --db-proxy-name <proxy-name> --target-group-name ${targetGroupName} ...`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    const hasTargets =
      (dbClusterIdentifiers && dbClusterIdentifiers.length > 0) ||
      (dbInstanceIdentifiers && dbInstanceIdentifiers.length > 0);

    if (!hasTargets) {
      this.logger.debug(
        `No targets registered for ${dbProxyName}/${targetGroupName}; nothing to deregister`
      );
      return;
    }

    this.logger.debug(
      `Deregistering targets from ${dbProxyName}/${targetGroupName}: ` +
        `clusters=[${dbClusterIdentifiers?.join(',') ?? ''}], ` +
        `instances=[${dbInstanceIdentifiers?.join(',') ?? ''}]`
    );

    try {
      await this.getClient().send(
        new DeregisterDBProxyTargetsCommand({
          DBProxyName: dbProxyName,
          TargetGroupName: targetGroupName,
          DBClusterIdentifiers: dbClusterIdentifiers,
          DBInstanceIdentifiers: dbInstanceIdentifiers,
        })
      );
    } catch (error) {
      // Idempotent success when the parent DBProxy, the TargetGroup, or
      // any individual target is already gone — typically because a sibling
      // cdkd delete or AWS-side CASCADE already removed them. Region-match
      // guard prevents silently masking a wrong-region destroy that would
      // otherwise leave the actual AWS resources orphaned.
      if (
        error instanceof DBProxyNotFoundFault ||
        error instanceof DBProxyTargetGroupNotFoundFault ||
        error instanceof DBProxyTargetNotFoundFault
      ) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(
          `${dbProxyName}/${targetGroupName} or its target is already gone, treating as success`
        );
        return;
      }
      throw this.wrapError(error, 'DELETE', resourceType, logicalId, physicalId);
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- attribute resolution does not need AWS calls
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    switch (attributeName) {
      case 'TargetGroupArn':
        return physicalId;
      case 'TargetGroupName':
        return 'default';
      default:
        this.logger.warn(
          `Unknown attribute ${attributeName} for AWS::RDS::DBProxyTargetGroup, returning undefined`
        );
        return undefined;
    }
  }

  /**
   * Adopt an existing DBProxyTargetGroup into cdkd state.
   *
   * **Explicit override only.** The TargetGroup itself has no tags
   * (the parent DBProxy carries the cdkd path tag, not the wiring child),
   * so there is no `aws:cdk:path`-based auto-lookup. Users must pass
   * `--resource <logicalId>=<TargetGroupArn>`.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      return {
        physicalId: input.knownPhysicalId,
        attributes: {
          TargetGroupArn: input.knownPhysicalId,
          TargetGroupName: 'default',
        },
      };
    }
    return null;
  }

  /**
   * Read the AWS-current configuration as CFn property shape. Used by
   * `cdkd drift` for the SDK-provider path (without it the comparator
   * falls back to CC API, which is broken on this type — Issue #385 the
   * SDK provider was added to fix in the first place).
   *
   * Maps:
   * - `DescribeDBProxyTargetGroups` → `ConnectionPoolConfigurationInfo`
   *   (the connection pool config CFn template carries).
   * - `DescribeDBProxyTargets` → `DBClusterIdentifiers` /
   *   `DBInstanceIdentifiers` reverse-mapped from the AWS-side target
   *   list via `Type` discriminator. The full target list also carries
   *   per-target Endpoint / Port / TargetHealth but those are read-only
   *   AWS-managed fields, intentionally not surfaced.
   *
   * Best-effort: a missing parent DBProxyName (state corruption) or any
   * AWS API failure surfaces as `undefined` (drift comparator skips the
   * resource), not a crash.
   */
  async readCurrentState(
    _physicalId: string,
    _logicalId: string,
    _resourceType: string,
    properties: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    const dbProxyName = properties['DBProxyName'] as string | undefined;
    const targetGroupName = (properties['TargetGroupName'] as string | undefined) ?? 'default';
    if (!dbProxyName) {
      // No way to recover the AWS-side state without the parent name —
      // happens on imported / hand-edited state that lost DBProxyName.
      return undefined;
    }

    const client = this.getClient();

    let connectionPoolConfig: Record<string, unknown> | undefined;
    try {
      const tgResp = await client.send(
        new DescribeDBProxyTargetGroupsCommand({
          DBProxyName: dbProxyName,
          TargetGroupName: targetGroupName,
        })
      );
      const tg = tgResp.TargetGroups?.[0];
      // AWS-side `ConnectionPoolConfig` (the Describe response shape) maps
      // 1:1 to the CFn `ConnectionPoolConfigurationInfo` field (the input
      // shape). Surfacing it always (even when AWS returns defaults) lets
      // a console-side change to MaxConnectionsPercent / etc. show as
      // drift on the v3 observedProperties baseline.
      connectionPoolConfig = tg?.ConnectionPoolConfig as Record<string, unknown> | undefined;
    } catch (error) {
      if (
        error instanceof DBProxyNotFoundFault ||
        error instanceof DBProxyTargetGroupNotFoundFault
      ) {
        return undefined;
      }
      throw error;
    }

    const dbClusterIdentifiers: string[] = [];
    const dbInstanceIdentifiers: string[] = [];
    try {
      const targetsResp = await client.send(
        new DescribeDBProxyTargetsCommand({
          DBProxyName: dbProxyName,
          TargetGroupName: targetGroupName,
        })
      );
      for (const target of targetsResp.Targets ?? []) {
        const id = target.RdsResourceId;
        if (!id) continue;
        if (target.Type === 'TRACKED_CLUSTER') {
          dbClusterIdentifiers.push(id);
        } else if (target.Type === 'RDS_INSTANCE') {
          dbInstanceIdentifiers.push(id);
        }
        // `RDS_SERVERLESS_ENDPOINT` targets are silently skipped — the
        // CFn `AWS::RDS::DBProxyTargetGroup` schema has no input slot for
        // them (only `DBClusterIdentifiers` / `DBInstanceIdentifiers`),
        // so they can't drift on a cdkd-managed target group.
      }
    } catch (error) {
      if (
        error instanceof DBProxyNotFoundFault ||
        error instanceof DBProxyTargetGroupNotFoundFault ||
        error instanceof DBProxyTargetNotFoundFault
      ) {
        return undefined;
      }
      throw error;
    }

    const result: Record<string, unknown> = {
      DBProxyName: dbProxyName,
      TargetGroupName: targetGroupName,
      DBClusterIdentifiers: dbClusterIdentifiers,
      DBInstanceIdentifiers: dbInstanceIdentifiers,
    };
    if (connectionPoolConfig !== undefined) {
      result['ConnectionPoolConfigurationInfo'] = connectionPoolConfig;
    }
    return result;
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
