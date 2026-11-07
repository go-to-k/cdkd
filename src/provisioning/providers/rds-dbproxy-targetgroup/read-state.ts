import type { RDSDBProxyTargetGroupProvider } from '../rds-dbproxy-targetgroup-provider.js';
import {
  DescribeDBProxyTargetGroupsCommand,
  ListTagsForResourceCommand,
  DBProxyNotFoundFault,
  DBProxyTargetGroupNotFoundFault,
  DBProxyTargetNotFoundFault,
} from '@aws-sdk/client-rds';
import { requireConfigString } from '../../config-shape.js';
import {
  type ResourceNotFound,
  RESOURCE_NOT_FOUND,
  type ResourceImportInput,
  type ResourceImportResult,
} from '../../../types/resource.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import { type TargetListKind, readTargetLists, readProxyName } from './shared.js';

/**
 * Adopt an existing DBProxyTargetGroup into cdkd state.
 *
 * **Explicit override only.** AWS rejects `aws:`-prefixed tag writes, so
 * no `aws:cdk:path` tag exists to look the target group up by. Users must pass
 * `--resource <logicalId>=<TargetGroupArn>`.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
export async function importImpl(
  this: RDSDBProxyTargetGroupProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
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
 * A missing parent DBProxyName (state corruption) surfaces as `undefined`
 * (drift comparator skips the resource), not a crash. A gone proxy, or a
 * gone `default` group, is `RESOURCE_NOT_FOUND`; a group NotFound for any
 * other recorded name addresses no group this resource made, so it stays
 * `undefined`.
 */
export async function readCurrentState(
  this: RDSDBProxyTargetGroupProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string,
  properties: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const dbProxyName = readProxyName(properties['DBProxyName']);
  const targetGroupName = requireConfigString(
    properties['TargetGroupName'],
    'default',
    'AWS::RDS::DBProxyTargetGroup TargetGroupName',
    { onUnusable: (message) => this.logger.warn(message) }
  );
  if (!dbProxyName) {
    // No way to recover the AWS-side state without the parent name —
    // happens on imported / hand-edited state that lost DBProxyName.
    return undefined;
  }

  const client = this.getClient();
  const groupGone = (error: unknown): boolean =>
    error instanceof DBProxyNotFoundFault ||
    (targetGroupName === 'default' && error instanceof DBProxyTargetGroupNotFoundFault);

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
    if (groupGone(error)) return RESOURCE_NOT_FOUND;
    if (error instanceof DBProxyTargetGroupNotFoundFault) return undefined;
    throw error;
  }

  let live: Record<TargetListKind, string[]>;
  try {
    live = await this.readLiveTargets(dbProxyName, targetGroupName);
  } catch (error) {
    if (groupGone(error)) return RESOURCE_NOT_FOUND;
    if (
      error instanceof DBProxyTargetGroupNotFoundFault ||
      error instanceof DBProxyTargetNotFoundFault
    ) {
      return undefined;
    }
    throw error;
  }

  // RDS reports identifiers lowercased; a live id matching a recorded one
  // case-insensitively is reported in the RECORDED spelling, so a template's
  // `MyCluster` is not phantom drift against AWS's `mycluster` (the same
  // equality `update()`'s diff uses).
  const recorded = readTargetLists({
    DBClusterIdentifiers: properties['DBClusterIdentifiers'],
    DBInstanceIdentifiers: properties['DBInstanceIdentifiers'],
  }).lists;
  const inRecordedSpelling = (ids: string[], spellings: string[]): string[] => {
    const byKey = new Map(spellings.map((s) => [s.toLowerCase(), s]));
    return ids.map((id) => byKey.get(id.toLowerCase()) ?? id);
  };
  const result: Record<string, unknown> = {
    DBProxyName: dbProxyName,
    TargetGroupName: targetGroupName,
    DBClusterIdentifiers: inRecordedSpelling(
      live.DBClusterIdentifiers,
      recorded.DBClusterIdentifiers
    ),
    DBInstanceIdentifiers: inRecordedSpelling(
      live.DBInstanceIdentifiers,
      recorded.DBInstanceIdentifiers
    ),
  };
  if (connectionPoolConfig !== undefined) {
    result['ConnectionPoolConfigurationInfo'] = connectionPoolConfig;
  }
  // Omitted, not `[]`, when the tag read fails: "could not read" must not
  // read as "has no tags".
  try {
    const tagResp = await client.send(new ListTagsForResourceCommand({ ResourceName: physicalId }));
    result['Tags'] = normalizeAwsTagsToCfn(tagResp.TagList ?? []);
  } catch (error) {
    this.logger.debug(
      safeMsg`ListTagsForResource failed for ${physicalId}: ${describeAwsFailure(error).detail}`
    );
  }
  return result;
}
