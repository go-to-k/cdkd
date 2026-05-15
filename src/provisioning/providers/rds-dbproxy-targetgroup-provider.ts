import {
  RDSClient,
  RegisterDBProxyTargetsCommand,
  DeregisterDBProxyTargetsCommand,
  DescribeDBProxyTargetGroupsCommand,
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
        throw this.wrapError(error, 'CREATE (pool config)', resourceType, logicalId, dbProxyName);
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
          dbProxyName
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
      throw this.wrapError(error, 'CREATE (describe)', resourceType, logicalId, dbProxyName);
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

  async update(
    _physicalId: string,
    logicalId: string,
    resourceType: string,
    _oldProperties: Record<string, unknown>,
    _newProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    throw new ResourceUpdateNotSupportedError(
      resourceType,
      logicalId,
      'redeploy after destroy + redeploy, or manage via cdkd deploy --replace; ' +
        'in-place updates of registered targets / connection pool config are not yet supported'
    );
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

  private wrapError(
    error: unknown,
    op: string,
    resourceType: string,
    logicalId: string,
    physicalId: string
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
