import type { NeptuneProvider } from '../neptune-provider.js';
import {
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  type DBCluster,
} from '@aws-sdk/client-neptune';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { isTerminalDbWaitStatus } from '../deletion-protection-compensation.js';
import { CLUSTER_AVAILABLE_MAX_WAIT_MS, DEADLINE_MARGIN_MS, SETTLE_MAX_WAIT_MS } from './shared.js';

/**
 * Poll until a change AWS accepted reads back, so the observed baseline the
 * engine captures after update() does not record the old value (phantom
 * drift). The change was accepted, so the cap is a warning, not a failure.
 */
export async function waitForApplied(
  this: NeptuneProvider,
  logicalId: string,
  what: string,
  applied: () => Promise<boolean>
): Promise<void> {
  if (await this.pollUntilSettled(applied)) return;
  this.logger.warn(
    safeMsg`${logicalId}: the new ${what} did not read back when cdkd stopped waiting; AWS accepted it, so cdkd drift may report the old value as the baseline. Once it applies, run cdkd drift --accept.`
  );
}

/**
 * Read at least once, then poll until `settled` answers true or the cap, the
 * tighter of {@link SETTLE_MAX_WAIT_MS} and what the resource deadline
 * leaves, so a cap stays a warning instead of the deadline's failure.
 */
export async function pollUntilSettled(
  this: NeptuneProvider,
  settled: () => Promise<boolean>
): Promise<boolean> {
  const capMs = Math.min(SETTLE_MAX_WAIT_MS, enclosingDeadlineRemainingMs() - DEADLINE_MARGIN_MS);
  const startTime = Date.now();
  let delay = 2_000;
  for (;;) {
    if (await settled()) return true;
    if (Date.now() - startTime + delay >= capMs) return false;
    await this.sleep(delay);
    delay = Math.min(delay * 2, 10_000);
  }
}

export async function describeDBCluster(this: NeptuneProvider, dbClusterIdentifier: string) {
  const response = await this.getClient().send(
    new DescribeDBClustersCommand({
      DBClusterIdentifier: dbClusterIdentifier,
    })
  );
  return response.DBClusters?.[0];
}

export async function describeDBInstance(this: NeptuneProvider, dbInstanceIdentifier: string) {
  const response = await this.getClient().send(
    new DescribeDBInstancesCommand({
      DBInstanceIdentifier: dbInstanceIdentifier,
    })
  );
  return response.DBInstances?.[0];
}

/**
 * Issue #1160: wait out a member instance's `modifying` after its cluster's
 * security groups changed. Only that transition is waited out: a member in
 * a lasting state (maintenance, upgrading, storage-optimization, ...) or
 * deleted out of band does not hold the update, as CloudFormation reports
 * the cluster updated in those cases too.
 */
export async function waitForMemberAfterSecurityGroupChange(
  this: NeptuneProvider,
  dbInstanceIdentifier: string,
  clusterLogicalId: string,
  maxWaitMs = 1_800_000
): Promise<void> {
  const startTime = Date.now();
  let delay = 5_000;
  while (Date.now() - startTime < maxWaitMs) {
    let status: string | undefined;
    try {
      status = (await this.describeDBInstance(dbInstanceIdentifier))?.DBInstanceStatus;
    } catch (error) {
      if (this.isNotFoundError(error, 'DBInstanceNotFoundFault')) return;
      throw error;
    }
    if (status !== 'modifying') return;
    await this.sleep(delay);
    delay = Math.min(delay * 2, 10_000);
  }
  // The member's identifier is the physical id of ANOTHER resource, which
  // this cluster's masking bag does not cover (it can be secret-derived), so
  // only the cluster's logical id is named.
  throw new Error(
    safeMsg`Timed out waiting for a member instance of Neptune DBCluster ${clusterLogicalId} to finish applying its new VPC security groups`
  );
}

/**
 * A cluster read inside the security-group wait (issue #5419). A vanished
 * cluster or a terminal status (`isTerminalDbWaitStatus`) never reaches the
 * awaited state, so fail now rather than after the 30-minute budget.
 */
export function requireClusterWhileWaiting(
  this: NeptuneProvider,
  cluster: DBCluster | undefined,
  logicalId: string
): DBCluster {
  // A deleted cluster usually throws DBClusterNotFoundFault from the describe
  // itself; this arm covers an empty `DBClusters` list.
  if (cluster === undefined) {
    throw new Error(
      safeMsg`DescribeDBClusters returned no cluster for Neptune DBCluster ${logicalId} while waiting for its new VPC security groups`
    );
  }
  if (isTerminalDbWaitStatus(cluster.Status)) {
    throw new Error(
      safeMsg`Neptune DBCluster ${logicalId} entered status ${cluster.Status ?? ''} while applying its new VPC security groups`
    );
  }
  return cluster;
}

/**
 * Wait until the cluster is out of `modifying` AND reports exactly `expected` as
 * its VPC security groups, all `active` (issue #1160). Being out of
 * `modifying` alone can still read before the group swap has started; the
 * group statuses cannot.
 */
export async function waitForSecurityGroupsApplied(
  this: NeptuneProvider,
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
      logicalId
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
      safeMsg`Neptune DBCluster ${logicalId} security groups not settled yet (status ${cluster.Status ?? 'unknown'})`
    );
    await this.sleep(delay);
    delay = Math.min(delay * 2, 10_000);
  }
  throw new Error(
    `Timed out waiting for Neptune DBCluster ${logicalId} to apply its new VPC security groups`
  );
}

/**
 * Wait for a Neptune DBCluster to become available. A terminal status
 * (`isTerminalDbWaitStatus`) fails at once rather than after the
 * 30-minute budget (issue #5426).
 */
export async function waitForClusterAvailable(
  this: NeptuneProvider,
  logicalId: string,
  dbClusterIdentifier: string,
  during = 'being created',
  maxWaitMs = CLUSTER_AVAILABLE_MAX_WAIT_MS
): Promise<void> {
  const startTime = Date.now();
  let delay = 5_000;

  while (Date.now() - startTime < maxWaitMs) {
    const cluster = await this.describeDBCluster(dbClusterIdentifier);
    const status = cluster?.Status;

    this.logger.debug(`Neptune DBCluster ${dbClusterIdentifier} status: ${status}`);

    if (status === 'available') return;
    // Issue #5426: a terminal status never becomes 'available'.
    if (isTerminalDbWaitStatus(status)) {
      throw new Error(
        safeMsg`Neptune DBCluster ${logicalId} entered status ${status ?? ''} while ${during}, which it does not leave on its own`
      );
    }

    await this.sleep(delay);
    delay = Math.min(delay * 2, 10_000);
  }

  throw new Error(
    `Timed out waiting for Neptune DBCluster ${dbClusterIdentifier} to become available`
  );
}

/**
 * Wait for a DBCluster to be deleted (no SDK waiter — manual poll).
 */
export async function waitForClusterDeleted(
  this: NeptuneProvider,
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

      this.logger.debug(`Neptune DBCluster ${logicalId} status: ${status}`);

      if (!cluster) return;
    } catch (error) {
      if (this.isNotFoundError(error, 'DBClusterNotFoundFault')) {
        return;
      }
      throw error;
    }

    await this.sleep(delay);
    delay = Math.min(delay * 2, 10_000);
  }

  throw new Error(`Timed out waiting for Neptune DBCluster ${logicalId} to be deleted`);
}

/**
 * Wait for a Neptune DBInstance to become available. A terminal status
 * (`isTerminalDbWaitStatus`) fails at once rather than after the
 * 30-minute budget (issue #5426).
 */
export async function waitForInstanceAvailable(
  this: NeptuneProvider,
  logicalId: string,
  dbInstanceIdentifier: string,
  maxWaitMs = 1_800_000
): Promise<void> {
  const startTime = Date.now();
  let delay = 10_000;

  while (Date.now() - startTime < maxWaitMs) {
    const instance = await this.describeDBInstance(dbInstanceIdentifier);
    const status = instance?.DBInstanceStatus;

    this.logger.debug(`Neptune DBInstance ${dbInstanceIdentifier} status: ${status}`);

    if (status === 'available') return;
    // Issue #5426: a terminal status never becomes 'available'.
    if (isTerminalDbWaitStatus(status)) {
      throw new Error(
        safeMsg`Neptune DBInstance ${logicalId} entered status ${status ?? ''} while being created, which it does not leave on its own`
      );
    }

    await this.sleep(delay);
    delay = Math.min(delay * 2, 10_000);
  }

  throw new Error(
    `Timed out waiting for Neptune DBInstance ${dbInstanceIdentifier} to become available`
  );
}

export async function waitForInstanceDeleted(
  this: NeptuneProvider,
  dbInstanceIdentifier: string,
  maxWaitMs = 1_800_000
): Promise<void> {
  const startTime = Date.now();
  let delay = 10_000;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const instance = await this.describeDBInstance(dbInstanceIdentifier);
      const status = instance?.DBInstanceStatus;

      this.logger.debug(`Neptune DBInstance ${dbInstanceIdentifier} status: ${status}`);

      if (!instance) return;
    } catch (error) {
      if (this.isNotFoundError(error, 'DBInstanceNotFoundFault')) {
        return;
      }
      throw error;
    }

    await this.sleep(delay);
    delay = Math.min(delay * 2, 10_000);
  }

  throw new Error(`Timed out waiting for Neptune DBInstance ${dbInstanceIdentifier} to be deleted`);
}

export function sleep(this: NeptuneProvider, ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
