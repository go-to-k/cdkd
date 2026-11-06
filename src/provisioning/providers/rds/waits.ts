import { RebootDBInstanceCommand, type DBCluster, type DBInstance } from '@aws-sdk/client-rds';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { isTerminalDbWaitStatus } from '../deletion-protection-compensation.js';
import type { RDSProvider } from '../rds-provider.js';
import {
  instanceParameterGroupPendingReboot,
  instanceParameterGroupSettled,
  instanceRebootApplied,
} from './instance-members.js';

/**
 * Issue #1160: wait out a member instance's transition (`transitional`) after
 * its cluster's security groups or port changed. Only that transition is
 * waited out: a member in a lasting state (maintenance, upgrading,
 * storage-optimization, ...) or deleted out of band does not hold the update,
 * as CloudFormation reports the cluster updated in those cases too.
 */
export async function waitForMemberAfterClusterChange(
  this: RDSProvider,
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
      if (this.isNotFoundError(error, 'DBInstanceNotFoundFault')) return;
      throw error;
    }
    if (status === undefined || !transitional.has(status)) return;
    await this.sleep(delay);
    delay = Math.min(delay * 2, 10_000);
  }
  throw new Error(
    // The member's identifier is another resource's physical id, which this
    // cluster's masking does not cover (it can be secret-derived): name only
    // the cluster.
    safeMsg`Timed out waiting for a member instance of DBCluster ${clusterLogicalId} to finish applying its new ${change}`
  );
}

/**
 * A cluster read inside an update wait (issue #5417). A vanished cluster or a
 * terminal status (`isTerminalDbWaitStatus`) never reaches the awaited state, so
 * fail now rather than after the 30-minute budget.
 */
export function requireClusterWhileWaiting(
  this: RDSProvider,
  cluster: DBCluster | undefined,
  logicalId: string,
  change: string
): DBCluster {
  // A deleted cluster usually throws DBClusterNotFoundFault from the describe
  // itself; this arm covers an empty `DBClusters` list.
  if (cluster === undefined) {
    throw new Error(
      safeMsg`DescribeDBClusters returned no cluster for DBCluster ${logicalId} while waiting for its new ${change}`
    );
  }
  if (isTerminalDbWaitStatus(cluster.Status)) {
    throw new Error(
      safeMsg`DBCluster ${logicalId} entered status ${cluster.Status ?? ''} while applying its new ${change}`
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
  this: RDSProvider,
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
      safeMsg`DBCluster ${logicalId} port not applied yet (status ${cluster.Status ?? 'unknown'})`
    );
    await this.sleep(delay);
    delay = Math.min(delay * 2, 10_000);
  }
  throw new Error(`Timed out waiting for DBCluster ${logicalId} to apply its new port`);
}

/**
 * Wait until the cluster is `available` AND reports exactly `expected` as its
 * VPC security groups, all `active` (issue #1160). `available` alone can still
 * read before the group swap has started; the group statuses cannot.
 */
export async function waitForSecurityGroupsApplied(
  this: RDSProvider,
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
      safeMsg`DBCluster ${logicalId} security groups not settled yet (status ${cluster.Status ?? 'unknown'})`
    );
    await this.sleep(delay);
    delay = Math.min(delay * 2, 10_000);
  }
  throw new Error(
    `Timed out waiting for DBCluster ${logicalId} to apply its new VPC security groups`
  );
}

/**
 * Poll a DBCluster until `done` holds, as {@link waitForInstanceState} does
 * for an instance: a missing cluster or a terminal status fails at once, and
 * the budget is the resource's own deadline, 30 minutes when none is in scope.
 */
export async function waitForClusterState(
  this: RDSProvider,
  logicalId: string,
  dbClusterIdentifier: string,
  done: (cluster: DBCluster) => boolean,
  change: string
): Promise<void> {
  const remaining = enclosingDeadlineRemainingMs();
  const maxWaitMs = Number.isFinite(remaining) ? remaining : 1_800_000;
  const startTime = Date.now();
  let delay = 5_000;
  while (Date.now() - startTime < maxWaitMs) {
    const cluster = this.requireClusterWhileWaiting(
      await this.describeDBCluster(dbClusterIdentifier),
      logicalId,
      change
    );
    if (done(cluster)) return;
    this.logger.debug(
      safeMsg`DBCluster ${logicalId} waiting for its ${change} (status ${cluster.Status ?? 'unknown'})`
    );
    await this.sleep(delay);
    delay = Math.min(delay * 2, 10_000);
  }
  throw new Error(safeMsg`Timed out waiting for DBCluster ${logicalId}'s ${change}`);
}

/**
 * Wait for a DBCluster to become available. A terminal status
 * (`isTerminalDbWaitStatus`) fails at once rather than after the
 * 30-minute budget (issue #5426).
 */
export async function waitForClusterAvailable(
  this: RDSProvider,
  logicalId: string,
  dbClusterIdentifier: string,
  maxWaitMs = 1_800_000,
  doing = 'being created'
): Promise<void> {
  const startTime = Date.now();
  let delay = 5_000;

  while (Date.now() - startTime < maxWaitMs) {
    const cluster = await this.describeDBCluster(dbClusterIdentifier);
    const status = cluster?.Status;

    this.logger.debug(`DBCluster ${dbClusterIdentifier} status: ${status}`);

    if (status === 'available') return;
    // Issue #5426: a terminal status never becomes 'available'.
    if (isTerminalDbWaitStatus(status)) {
      throw new Error(
        safeMsg`DBCluster ${logicalId} entered status ${status ?? ''} while ${doing}, which it does not leave on its own`
      );
    }

    await this.sleep(delay);
    delay = Math.min(delay * 2, 10_000);
  }

  throw new Error(`Timed out waiting for DBCluster ${dbClusterIdentifier} to become available`);
}

/**
 * Wait for a DBCluster to be deleted
 */
export async function waitForClusterDeleted(
  this: RDSProvider,
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

      this.logger.debug(`DBCluster ${logicalId} status: ${status}`);

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

  throw new Error(`Timed out waiting for DBCluster ${logicalId} to be deleted`);
}

/**
 * go-to-k/cdkd#2762: CloudFormation's post-update reboot. Its
 * `UpdateHandler` waits for the ModifyDBInstance to settle, reboots when the
 * instance's parameter group then reads `pending-reboot` (`shouldReboot`),
 * and waits for `available` with every parameter and option group `in-sync`
 * (`rebootAwait`). Without the reboot a changed group never takes effect:
 * RDS keeps it `pending-reboot` until something reboots the instance.
 *
 * Under `--no-wait` the settle wait and the reboot still run, since nothing
 * else applies the group; only the wait for the reboot to finish is
 * skipped. Returns the last instance read, for the update's attributes.
 */
export async function rebootForPendingParameterGroup(
  this: RDSProvider,
  logicalId: string,
  physicalId: string,
  sentGroup: string | undefined,
  caRotationRestarts: boolean
): Promise<DBInstance> {
  const settled = await this.waitForInstanceState(
    logicalId,
    physicalId,
    (instance) => instanceParameterGroupSettled(instance, sentGroup, caRotationRestarts),
    'parameter group change to settle'
  );
  if (!instanceParameterGroupPendingReboot(settled)) return settled;
  this.logger.info(
    safeMsg`Rebooting DBInstance ${logicalId} to apply its parameter group (pending-reboot), as CloudFormation does after an update`
  );
  await this.getClient().send(new RebootDBInstanceCommand({ DBInstanceIdentifier: physicalId }));
  if (process.env['CDKD_NO_WAIT'] === 'true') return settled;
  return this.waitForInstanceState(
    logicalId,
    physicalId,
    instanceRebootApplied,
    'reboot to apply its parameter group'
  );
}

/**
 * Poll a DBInstance until `done` holds. A missing instance or a terminal
 * status (`isTerminalDbWaitStatus`) fails at once. The budget is the
 * resource's own deadline (`--resource-timeout`), so a settle that rides a
 * long modification (a storage optimization, a major upgrade) waits as long
 * as the deploy allows; 30 minutes when no deadline is in scope.
 */
export async function waitForInstanceState(
  this: RDSProvider,
  logicalId: string,
  dbInstanceIdentifier: string,
  done: (instance: DBInstance) => boolean,
  change: string
): Promise<DBInstance> {
  const remaining = enclosingDeadlineRemainingMs();
  const maxWaitMs = Number.isFinite(remaining) ? remaining : 1_800_000;
  const startTime = Date.now();
  let delay = 5_000;
  while (Date.now() - startTime < maxWaitMs) {
    const instance = await this.describeDBInstance(dbInstanceIdentifier);
    if (instance === undefined) {
      throw new Error(
        safeMsg`DescribeDBInstances returned no instance for DBInstance ${logicalId} while waiting for its ${change}`
      );
    }
    if (isTerminalDbWaitStatus(instance.DBInstanceStatus)) {
      throw new Error(
        safeMsg`DBInstance ${logicalId} entered status ${instance.DBInstanceStatus ?? ''} while waiting for its ${change}`
      );
    }
    if (done(instance)) return instance;
    this.logger.debug(
      safeMsg`DBInstance ${logicalId} waiting for its ${change} (status ${instance.DBInstanceStatus ?? 'unknown'})`
    );
    await this.sleep(delay);
    delay = Math.min(delay * 2, 10_000);
  }
  throw new Error(safeMsg`Timed out waiting for DBInstance ${logicalId}'s ${change}`);
}

/**
 * Wait for a DBInstance to become available. A terminal status
 * (`isTerminalDbWaitStatus`) fails at once rather than after the
 * 30-minute budget (issue #5426).
 */
export async function waitForInstanceAvailable(
  this: RDSProvider,
  logicalId: string,
  dbInstanceIdentifier: string,
  maxWaitMs = 1_800_000,
  doing = 'being created'
): Promise<void> {
  const startTime = Date.now();
  let delay = 10_000;

  while (Date.now() - startTime < maxWaitMs) {
    const instance = await this.describeDBInstance(dbInstanceIdentifier);
    const status = instance?.DBInstanceStatus;

    this.logger.debug(`DBInstance ${dbInstanceIdentifier} status: ${status}`);

    if (status === 'available') return;
    // Issue #5426: a terminal status never becomes 'available'.
    if (isTerminalDbWaitStatus(status)) {
      throw new Error(
        safeMsg`DBInstance ${logicalId} entered status ${status ?? ''} while ${doing}, which it does not leave on its own`
      );
    }

    await this.sleep(delay);
    delay = Math.min(delay * 2, 10_000);
  }

  throw new Error(`Timed out waiting for DBInstance ${dbInstanceIdentifier} to become available`);
}

/**
 * Wait for a DBInstance to be deleted
 */
export async function waitForInstanceDeleted(
  this: RDSProvider,
  logicalId: string,
  dbInstanceIdentifier: string,
  maxWaitMs = 1_800_000
): Promise<void> {
  const startTime = Date.now();
  let delay = 10_000;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const instance = await this.describeDBInstance(dbInstanceIdentifier);
      const status = instance?.DBInstanceStatus;

      this.logger.debug(`DBInstance ${logicalId} status: ${status}`);

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

  throw new Error(`Timed out waiting for DBInstance ${logicalId} to be deleted`);
}
