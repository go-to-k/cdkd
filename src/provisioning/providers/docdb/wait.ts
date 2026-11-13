import { cdkdRemedy } from '../../../utils/pasteable-command.js';
import type { DocDBProvider } from '../docdb-provider.js';
import {
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  type DBCluster,
} from '@aws-sdk/client-docdb';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { isDocDBNotFoundError } from '../docdb-shared.js';
import {
  deleteAfterProtectionFlipWithFinalSnapshot,
  isTerminalDbWaitStatus,
} from '../deletion-protection-compensation.js';
import { SETTLE_MAX_WAIT_MS, DEADLINE_MARGIN_MS, CLUSTER_AVAILABLE_MAX_WAIT_MS } from './shared.js';

/**
 * Poll until each change AWS accepted reads back, so the observed baseline the
 * engine captures after update() does not record the old value (phantom
 * drift). No key: no call. The change was accepted, so the cap (the tighter
 * of `maxWaitMs` and what the resource deadline leaves) is a warning naming
 * the keys still old, not a failure. The baseline then keeps that old value,
 * which outlives the change landing, so the warning says how to refresh it.
 */
export async function waitForApplied<T>(
  this: DocDBProvider,
  logicalId: string,
  applied: ReadonlyMap<string, (live: T | undefined) => boolean>,
  read: () => Promise<T | undefined>,
  maxWaitMs = SETTLE_MAX_WAIT_MS
): Promise<void> {
  if (applied.size === 0) return;
  const capMs = Math.min(maxWaitMs, enclosingDeadlineRemainingMs() - DEADLINE_MARGIN_MS);
  const startTime = Date.now();
  let delay = 2_000;
  for (;;) {
    const live = await read();
    const pending = [...applied].filter(([, isApplied]) => !isApplied(live));
    if (pending.length === 0) return;
    if (Date.now() - startTime + delay >= capMs) {
      const keys = pending.map(([key]) => key).join(', ');
      this.logger.warn(
        safeMsg`${logicalId}: the new ${keys} did not read back when cdkd stopped waiting; AWS accepted the change, so cdkd drift may report the old value as the baseline. Once it applies, run ${cdkdRemedy('cdkd drift', '--accept')}.`
      );
      return;
    }
    await this.sleep(delay);
    delay = Math.min(delay * 2, 10_000);
  }
}

export async function describeDBCluster(this: DocDBProvider, dbClusterIdentifier: string) {
  const response = await this.getClient().send(
    new DescribeDBClustersCommand({
      DBClusterIdentifier: dbClusterIdentifier,
    })
  );
  return response.DBClusters?.[0];
}

export async function describeDBInstance(this: DocDBProvider, dbInstanceIdentifier: string) {
  const response = await this.getClient().send(
    new DescribeDBInstancesCommand({
      DBInstanceIdentifier: dbInstanceIdentifier,
    })
  );
  return response.DBInstances?.[0];
}

/**
 * Issue #1160: wait out a member instance's transition (`transitional`) after
 * its cluster's security groups or port changed. Only that transition is
 * waited out: a member in a lasting state (maintenance, upgrading,
 * storage-optimization, ...) or deleted out of band does not hold the update,
 * as CloudFormation reports the cluster updated in those cases too.
 */
export async function waitForMemberAfterClusterChange(
  this: DocDBProvider,
  dbInstanceIdentifier: string,
  clusterLogicalId: string,
  transitional: ReadonlySet<string>,
  change: string,
  maxWaitMs = 1_800_000
): Promise<void> {
  const startTime = Date.now();
  let delay = 5_000;
  while (Date.now() - startTime < maxWaitMs) {
    let status: string | undefined;
    try {
      status = (await this.describeDBInstance(dbInstanceIdentifier))?.DBInstanceStatus;
    } catch (error) {
      if (isDocDBNotFoundError(error, 'DBInstanceNotFoundFault')) return;
      throw error;
    }
    if (status === undefined || !transitional.has(status)) return;
    await this.sleep(delay);
    delay = Math.min(delay * 2, 10_000);
  }
  // The member's identifier is the physical id of ANOTHER resource, which
  // this cluster's masking bag does not cover (it can be secret-derived), so
  // only the cluster's logical id is named.
  throw new Error(
    safeMsg`Timed out waiting for a member instance of DocDB DBCluster ${clusterLogicalId} to finish applying its new ${change}`
  );
}

/**
 * A cluster read inside an update wait (issues #5411, #5419). A vanished
 * cluster or a terminal status (`isTerminalDbWaitStatus`) never reaches the
 * awaited state, so fail now rather than after the 30-minute budget.
 */
export function requireClusterWhileWaiting(
  this: DocDBProvider,
  cluster: DBCluster | undefined,
  logicalId: string,
  change: string
): DBCluster {
  // A deleted cluster usually throws DBClusterNotFoundFault from the describe
  // itself; this arm covers an empty `DBClusters` list.
  if (cluster === undefined) {
    throw new Error(
      safeMsg`DescribeDBClusters returned no cluster for DocDB DBCluster ${logicalId} while waiting for its new ${change}`
    );
  }
  if (isTerminalDbWaitStatus(cluster.Status)) {
    throw new Error(
      safeMsg`DocDB DBCluster ${logicalId} entered status ${cluster.Status ?? ''} while applying its new ${change}`
    );
  }
  return cluster;
}

/**
 * Wait until the cluster is out of `modifying` and reports `port` (issue
 * #1160). `available` alone can still read before the port change starts;
 * the port cannot.
 */
export async function waitForClusterPortApplied(
  this: DocDBProvider,
  dbClusterIdentifier: string,
  logicalId: string,
  port: number,
  maxWaitMs = 1_800_000
): Promise<void> {
  const startTime = Date.now();
  let delay = 5_000;
  while (Date.now() - startTime < maxWaitMs) {
    const cluster = this.requireClusterWhileWaiting(
      await this.describeDBCluster(dbClusterIdentifier),
      logicalId,
      'port'
    );
    if (cluster.Status !== 'modifying' && cluster.Port === port) return;
    this.logger.debug(
      safeMsg`DocDB DBCluster ${logicalId} port not applied yet (status ${cluster.Status ?? 'unknown'})`
    );
    await this.sleep(delay);
    delay = Math.min(delay * 2, 10_000);
  }
  throw new Error(`Timed out waiting for DocDB DBCluster ${logicalId} to apply its new port`);
}

/**
 * Wait until the cluster is out of `modifying` AND reports exactly `expected` as
 * its VPC security groups, all `active` (issue #1160). Being out of
 * `modifying` alone can still read before the group swap has started; the
 * group statuses cannot.
 */
export async function waitForSecurityGroupsApplied(
  this: DocDBProvider,
  dbClusterIdentifier: string,
  logicalId: string,
  expected: readonly string[],
  maxWaitMs = 1_800_000
): Promise<void> {
  const want = [...new Set(expected)].sort().join(' ');
  const startTime = Date.now();
  let delay = 5_000;
  while (Date.now() - startTime < maxWaitMs) {
    const cluster = this.requireClusterWhileWaiting(
      await this.describeDBCluster(dbClusterIdentifier),
      logicalId,
      'VPC security groups'
    );
    const groups = cluster.VpcSecurityGroups ?? [];
    const ids = groups
      .map((group) => group.VpcSecurityGroupId ?? '')
      .sort()
      .join(' ');
    // `modifying` is the swap's own transition; any lasting state (backing-up,
    // maintenance, ...) is not this change's to wait out.
    const settled =
      cluster.Status !== 'modifying' &&
      groups.every((group) => group.Status === 'active') &&
      ids === want;
    if (settled) return;
    this.logger.debug(
      safeMsg`DocDB DBCluster ${logicalId} security groups not settled yet (status ${cluster.Status ?? 'unknown'})`
    );
    await this.sleep(delay);
    delay = Math.min(delay * 2, 10_000);
  }
  throw new Error(
    `Timed out waiting for DocDB DBCluster ${logicalId} to apply its new VPC security groups`
  );
}

/**
 * Issues #5155 / #5184: the final-snapshot delete after a `--remove-protection`
 * flip (deleteAfterProtectionFlipWithFinalSnapshot owns the wait, the retry
 * and their bounds).
 */
export async function deleteAfterProtectionFlip(
  this: DocDBProvider,
  logicalId: string,
  physicalId: string,
  send: () => Promise<unknown>
): Promise<void> {
  await deleteAfterProtectionFlipWithFinalSnapshot({
    stateFault: 'InvalidDBClusterStateFault',
    send,
    noun: 'cluster',
    label: 'DocDB DBCluster',
    logicalId,
    read: async () => {
      const current = await this.describeDBCluster(physicalId);
      return current === undefined
        ? undefined
        : { deletionProtection: current.DeletionProtection, status: current.Status };
    },
    sleep: (ms) => this.sleep(ms),
    logger: this.logger,
    remainingMs: enclosingDeadlineRemainingMs(),
  });
}

/**
 * Wait for a DocDB DBCluster to become available. DocDB's SDK does not ship
 * a `waitUntilDBClusterAvailable` waiter (only DBInstance has waiters), so
 * Status is polled with exponential backoff. A terminal status
 * (`isTerminalDbWaitStatus`) fails at once rather than after the
 * 30-minute budget (issue #5426).
 */
export async function waitForClusterAvailable(
  this: DocDBProvider,
  logicalId: string,
  dbClusterIdentifier: string,
  maxWaitMs = CLUSTER_AVAILABLE_MAX_WAIT_MS
): Promise<void> {
  const startTime = Date.now();
  let delay = 5_000;

  while (Date.now() - startTime < maxWaitMs) {
    const cluster = await this.describeDBCluster(dbClusterIdentifier);
    const status = cluster?.Status;

    this.logger.debug(`DocDB DBCluster ${dbClusterIdentifier} status: ${status}`);

    if (status === 'available') return;
    // Issue #5426: a terminal status never becomes 'available'.
    if (isTerminalDbWaitStatus(status)) {
      throw new Error(
        safeMsg`DocDB DBCluster ${logicalId} entered status ${status ?? ''} while being created, which it does not leave on its own`
      );
    }

    await this.sleep(delay);
    delay = Math.min(delay * 2, 10_000);
  }

  throw new Error(
    `Timed out waiting for DocDB DBCluster ${dbClusterIdentifier} to become available`
  );
}

/**
 * Wait for a DBCluster to be deleted (no SDK waiter — manual poll).
 */
export async function waitForClusterDeleted(
  this: DocDBProvider,
  logicalId: string,
  dbClusterIdentifier: string,
  maxWaitMs = 1_800_000
): Promise<void> {
  const startTime = Date.now();
  let delay = 5_000;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const cluster = await this.describeDBCluster(dbClusterIdentifier);
      const status = cluster?.Status;

      this.logger.debug(`DocDB DBCluster ${logicalId} status: ${status}`);

      if (!cluster) return;
    } catch (error) {
      if (isDocDBNotFoundError(error, 'DBClusterNotFoundFault')) {
        return;
      }
      throw error;
    }

    await this.sleep(delay);
    delay = Math.min(delay * 2, 10_000);
  }

  throw new Error(`Timed out waiting for DocDB DBCluster ${logicalId} to be deleted`);
}

/**
 * Wait for a DocDB DBInstance to become available. A terminal status
 * (`isTerminalDbWaitStatus`) fails at once rather than after the
 * 30-minute budget (issue #5426).
 */
export async function waitForInstanceAvailable(
  this: DocDBProvider,
  logicalId: string,
  dbInstanceIdentifier: string,
  maxWaitMs = 1_800_000
): Promise<void> {
  const startTime = Date.now();
  let delay = 10_000;

  while (Date.now() - startTime < maxWaitMs) {
    const instance = await this.describeDBInstance(dbInstanceIdentifier);
    const status = instance?.DBInstanceStatus;

    this.logger.debug(`DocDB DBInstance ${dbInstanceIdentifier} status: ${status}`);

    if (status === 'available') return;
    // Issue #5426: a terminal status never becomes 'available'.
    if (isTerminalDbWaitStatus(status)) {
      throw new Error(
        safeMsg`DocDB DBInstance ${logicalId} entered status ${status ?? ''} while being created, which it does not leave on its own`
      );
    }

    await this.sleep(delay);
    delay = Math.min(delay * 2, 10_000);
  }

  throw new Error(
    `Timed out waiting for DocDB DBInstance ${dbInstanceIdentifier} to become available`
  );
}

export async function waitForInstanceDeleted(
  this: DocDBProvider,
  dbInstanceIdentifier: string,
  maxWaitMs = 1_800_000
): Promise<void> {
  const startTime = Date.now();
  let delay = 10_000;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const instance = await this.describeDBInstance(dbInstanceIdentifier);
      const status = instance?.DBInstanceStatus;

      this.logger.debug(`DocDB DBInstance ${dbInstanceIdentifier} status: ${status}`);

      if (!instance) return;
    } catch (error) {
      if (isDocDBNotFoundError(error, 'DBInstanceNotFoundFault')) {
        return;
      }
      throw error;
    }

    await this.sleep(delay);
    delay = Math.min(delay * 2, 10_000);
  }

  throw new Error(`Timed out waiting for DocDB DBInstance ${dbInstanceIdentifier} to be deleted`);
}
