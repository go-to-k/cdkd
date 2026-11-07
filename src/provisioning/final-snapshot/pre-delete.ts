import { type EC2Client } from '@aws-sdk/client-ec2';
import {
  CreateClusterSnapshotCommand,
  DescribeClusterSnapshotsCommand,
  DescribeClustersCommand,
  type RedshiftClient,
} from '@aws-sdk/client-redshift';
import {
  CreateSnapshotCommand as CreateElastiCacheSnapshotCommand,
  DescribeReplicationGroupsCommand,
  DescribeSnapshotsCommand as DescribeElastiCacheSnapshotsCommand,
  type ElastiCacheClient,
} from '@aws-sdk/client-elasticache';
import { CdkdError } from '../../utils/error-handler.js';
import { createEbsFinalSnapshot } from './ebs.js';
import {
  PRE_DELETE_SNAPSHOT_POLL_INTERVAL_MS,
  PRE_DELETE_SNAPSHOT_TIMEOUT_MS,
  REDSHIFT_CLUSTER_SETTLE_TIMEOUT_MS,
  buildFinalSnapshotIdentifier,
  errMsg,
  failureSentence,
  finalSnapshotDelays,
  finalSnapshotFailure,
  finalSnapshotNamePrefix,
  type InfoLogger,
} from './shared.js';

// ─── Pre-delete final snapshots for name-keyed snapshot APIs (#1353) ───────

/**
 * The client set {@link createPreDeleteFinalSnapshot} draws from — satisfied
 * structurally by `AwsClients` (its `ec2` / `redshift` / `elastiCache`
 * getters), so call sites pass their region-scoped `AwsClients` instance and
 * only the clients a given resource type needs are ever instantiated.
 */
export interface PreDeleteSnapshotClients {
  ec2: EC2Client;
  redshift: RedshiftClient;
  elastiCache: ElastiCacheClient;
}

/**
 * Dispatch the pre-delete final snapshot for a `PRE_DELETE_SNAPSHOT_TYPES`
 * member: create (or resume) the snapshot and wait until it is ready, so the
 * caller's subsequent (routing-layer-agnostic) delete cannot lose data.
 *
 * @returns the snapshot id, or `null` when the source resource no longer
 *   exists (nothing to snapshot; the subsequent delete is idempotent too).
 */
export async function createPreDeleteFinalSnapshot(
  resourceType: string,
  physicalId: string,
  logicalId: string,
  clients: PreDeleteSnapshotClients,
  logger: InfoLogger
): Promise<string | null> {
  switch (resourceType) {
    case 'AWS::EC2::Volume':
      return createEbsFinalSnapshot(clients.ec2, physicalId, logicalId, logger);
    case 'AWS::Redshift::Cluster':
      return createRedshiftFinalSnapshot(clients.redshift, physicalId, logicalId, logger);
    case 'AWS::ElastiCache::ReplicationGroup':
      return createReplicationGroupFinalSnapshot(
        clients.elastiCache,
        physicalId,
        logicalId,
        logger
      );
    default:
      // Guard against a set/dispatcher drift — a PRE_DELETE type without an
      // implementation must fail closed, never silently skip the snapshot.
      throw new CdkdError(
        `No pre-delete final-snapshot implementation for ${logicalId} (${resourceType}). ` +
          `The resource was NOT deleted.`,
        'FINAL_SNAPSHOT_FAILED'
      );
  }
}

/**
 * Shared wait loop for the name-keyed snapshot APIs (Redshift / ElastiCache):
 * poll a status getter until the ready status, tolerating a bounded window of
 * eventual-consistency NotFound right after creation, and wrapping every
 * other poll failure as a typed FINAL_SNAPSHOT error (see the EBS loop's
 * comment for why the wrap is load-bearing).
 */
async function waitForNamedSnapshot(opts: {
  snapshotId: string;
  logicalId: string;
  sourceId: string;
  noun: string;
  /** True when the snapshot was resumed from a previous attempt, not created now. */
  reused: boolean;
  readyStatus: string;
  /**
   * Every TERMINAL non-ready status. Anything outside `readyStatus` +
   * these keeps polling, so a status the service can park in forever
   * (Redshift `cancelled` / `deleted`) must be listed here — otherwise the
   * wait burns its full hour before failing.
   */
  failedStatuses: readonly string[];
  pollStatus: () => Promise<string | undefined>;
  isTransientNotFound: (error: unknown) => boolean;
  logger: InfoLogger;
}): Promise<string> {
  const { snapshotId, logicalId, sourceId, noun, logger } = opts;
  logger.info(
    `${opts.reused ? 'Resuming' : 'Creating'} final snapshot ${snapshotId} for ${logicalId} ` +
      `(${sourceId}) — DeletionPolicy: Snapshot`
  );
  const deadline = Date.now() + PRE_DELETE_SNAPSHOT_TIMEOUT_MS;
  let notFoundPolls = 0;
  for (;;) {
    let status: string | undefined;
    try {
      status = await opts.pollStatus();
      notFoundPolls = 0;
    } catch (pollError) {
      if (opts.isTransientNotFound(pollError) && ++notFoundPolls <= 24) {
        status = undefined; // still propagating — keep polling
      } else {
        const head = `Failed while waiting for final snapshot ${snapshotId} of ${logicalId} (${sourceId})`;
        throw finalSnapshotFailure(
          `${head}: ${failureSentence(logger, head, pollError)} The ${noun} was NOT deleted; ` +
            `re-run the delete (the snapshot is reused, not duplicated).`,
          pollError
        );
      }
    }
    if (status === opts.readyStatus) {
      logger.info(`Final snapshot ${snapshotId} ready for ${logicalId} (${sourceId})`);
      return snapshotId;
    }
    if (status !== undefined && opts.failedStatuses.includes(status)) {
      throw new CdkdError(
        `Final snapshot ${snapshotId} for ${logicalId} (${sourceId}) entered '${status}' ` +
          `state. The ${noun} was NOT deleted.`,
        'FINAL_SNAPSHOT_FAILED'
      );
    }
    if (Date.now() >= deadline) {
      throw new CdkdError(
        `Timed out waiting for final snapshot ${snapshotId} of ${logicalId} (${sourceId}) to ` +
          `become ready. The ${noun} was NOT deleted; the snapshot continues in AWS — re-run ` +
          `the delete once it is ready (the existing snapshot is reused, not duplicated).`,
        'FINAL_SNAPSHOT_TIMEOUT'
      );
    }
    await finalSnapshotDelays.sleep(PRE_DELETE_SNAPSHOT_POLL_INTERVAL_MS);
  }
}

function errorNameOrMessageIncludes(error: unknown, token: string): boolean {
  const name = error instanceof Error ? error.name : '';
  return name === token || errMsg(error).includes(token);
}

/** Max reuse-probe pages to walk (bounded so a huge snapshot history cannot
 * stall a delete; a miss only costs one extra snapshot, never data). */
const REUSE_PROBE_MAX_PAGES = 10;

/**
 * Matcher for a snapshot cdkd itself generated for `physicalId`: the exact
 * `<sanitized-id>-final-<yyyymmdd>-<hhmmss>` shape, NOT a bare prefix. A bare
 * prefix would also match a USER's snapshot named e.g. `mydb-final-backup`
 * and silently adopt it as "the" final snapshot.
 */
function generatedSnapshotNameMatcher(physicalId: string, resourceType: string): RegExp {
  const prefix = finalSnapshotNamePrefix(physicalId, resourceType);
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}\\d{8}-\\d{6}$`);
}

/**
 * Is this snapshot resumable from an interrupted delete attempt?
 *
 * ONLY an in-flight (`creating`) snapshot qualifies. This is load-bearing,
 * not conservatism: Redshift / ElastiCache identifiers are USER-CHOSEN and
 * REUSABLE, and a manual snapshot outlives the resource it came from — so a
 * deploy -> destroy -> deploy -> destroy cycle of a fixed-name cluster would
 * find generation 1's `available` snapshot, skip `CreateSnapshot`, and delete
 * generation 2 with NO snapshot of its data. That is precisely the silent
 * data loss this whole feature exists to prevent (reviewer catch).
 *
 * A `creating` snapshot cannot span generations: the new generation can only
 * be created after the old resource is gone, by which time its snapshot has
 * settled to `available`. The cost of the narrower rule is one redundant
 * snapshot when a delete is re-run after its snapshot already completed —
 * cost, never data loss, and the timestamped identifier never collides.
 */
const RESUMABLE_SNAPSHOT_STATUS = 'creating';

/**
 * Redshift `CreateClusterSnapshot` + wait to `available` (issue #1353).
 * Idempotent across delete re-runs: a creating/available manual snapshot of
 * this cluster whose identifier carries cdkd's `<cluster>-final-` prefix is
 * reused instead of creating a second one.
 */
export async function createRedshiftFinalSnapshot(
  client: RedshiftClient,
  clusterId: string,
  logicalId: string,
  logger: InfoLogger
): Promise<string | null> {
  const matches = generatedSnapshotNameMatcher(clusterId, 'AWS::Redshift::Cluster');
  let snapshotId: string | undefined;
  try {
    let marker: string | undefined;
    for (let page = 0; page < REUSE_PROBE_MAX_PAGES && !snapshotId; page++) {
      const existing = await client.send(
        new DescribeClusterSnapshotsCommand({
          ClusterIdentifier: clusterId,
          SnapshotType: 'manual',
          ...(marker !== undefined && { Marker: marker }),
        })
      );
      snapshotId = existing.Snapshots?.find(
        (s) =>
          s.SnapshotIdentifier !== undefined &&
          matches.test(s.SnapshotIdentifier) &&
          s.Status === RESUMABLE_SNAPSHOT_STATUS
      )?.SnapshotIdentifier;
      marker = existing.Marker;
      if (marker === undefined) break;
    }
    if (snapshotId) {
      logger.debug(
        `Resuming in-flight final snapshot ${snapshotId} for ${logicalId} (${clusterId}) from a previous delete attempt`
      );
    }
  } catch (probeError) {
    // Best-effort reuse probe — fall through to CreateClusterSnapshot.
    logger.debug(`Final-snapshot reuse probe failed for ${clusterId}: ${errMsg(probeError)}`);
  }

  const reused = snapshotId !== undefined;
  if (!snapshotId) {
    const newId = buildFinalSnapshotIdentifier(clusterId, 'AWS::Redshift::Cluster');
    try {
      await client.send(
        new CreateClusterSnapshotCommand({
          SnapshotIdentifier: newId,
          ClusterIdentifier: clusterId,
        })
      );
      snapshotId = newId;
    } catch (createError) {
      if (errorNameOrMessageIncludes(createError, 'ClusterNotFoundFault')) {
        logger.debug(
          `Redshift cluster ${clusterId} no longer exists — skipping final snapshot for ${logicalId}`
        );
        return null;
      }
      // A cluster already `deleting` (an interrupted destroy being re-run)
      // cannot be snapshotted and is on its way out anyway — treat it as
      // gone rather than stranding the resource behind a permanent failure
      // (memory rule: FAILED_STATES must tolerate a stale read on recovery).
      if (errorNameOrMessageIncludes(createError, 'InvalidClusterStateFault')) {
        logger.info(
          `Redshift cluster ${clusterId} is not in a snapshottable state (likely already ` +
            `deleting) — skipping the final snapshot for ${logicalId}: ${errMsg(createError)}`
        );
        return null;
      }
      const head = `Failed to create the final snapshot for ${logicalId} (${clusterId}) required by DeletionPolicy: Snapshot`;
      throw finalSnapshotFailure(
        `${head}: ${failureSentence(logger, head, createError)} The cluster was NOT deleted.`,
        createError
      );
    }
  }

  const readySnapshotId = await waitForNamedSnapshot({
    snapshotId,
    logicalId,
    sourceId: clusterId,
    noun: 'cluster',
    reused,
    readyStatus: 'available',
    failedStatuses: ['failed', 'cancelled', 'deleted'],
    pollStatus: async () => {
      const described = await client.send(
        new DescribeClusterSnapshotsCommand({ SnapshotIdentifier: snapshotId })
      );
      return described.Snapshots?.[0]?.Status;
    },
    isTransientNotFound: (e) => errorNameOrMessageIncludes(e, 'ClusterSnapshotNotFoundFault'),
    logger,
  });

  // The SNAPSHOT reaching `available` does not mean the CLUSTER has: Redshift
  // keeps it busy for a short tail, and the delete that follows this call
  // then 400s with "There is an operation running on the Cluster. Please try
  // to delete it at a later time." (seen live 2026-08-03 — the snapshot we
  // just took is what put the cluster in that state, so settling it is this
  // function's job, not the caller's).
  await waitForRedshiftClusterSettled(client, clusterId, logicalId, logger);
  return readySnapshotId;
}

/**
 * Poll a Redshift cluster until it is out of the transient state a just-taken
 * snapshot leaves it in, so the caller's delete is not rejected. Bounded and
 * NEVER fatal: a NotFound means the cluster is already gone, and exhausting
 * the budget only logs — the delete (and its own retry) still runs.
 */
async function waitForRedshiftClusterSettled(
  client: RedshiftClient,
  clusterId: string,
  logicalId: string,
  logger: InfoLogger
): Promise<void> {
  const deadline = Date.now() + REDSHIFT_CLUSTER_SETTLE_TIMEOUT_MS;
  for (;;) {
    let status: string | undefined;
    try {
      const described = await client.send(
        new DescribeClustersCommand({ ClusterIdentifier: clusterId })
      );
      status = described.Clusters?.[0]?.ClusterStatus;
    } catch (pollError) {
      if (errorNameOrMessageIncludes(pollError, 'ClusterNotFoundFault')) return;
      logger.debug(
        `Could not read Redshift cluster ${clusterId} while waiting for it to settle: ${errMsg(pollError)}`
      );
      return;
    }
    if (status === undefined || status === 'available') {
      // `available` is necessary but NOT sufficient: Redshift reports it
      // while the just-taken snapshot's cluster-side work is still draining,
      // and there is no status field that exposes that operation (observed
      // live 2026-08-03 — the delete right after this point still 400s with
      // "There is an operation running on the Cluster"). Pay one grace
      // interval here; the delete's own transient retry — the message is in
      // RETRYABLE_ERROR_MESSAGE_PATTERNS — covers a longer tail.
      await finalSnapshotDelays.sleep(PRE_DELETE_SNAPSHOT_POLL_INTERVAL_MS);
      return;
    }
    if (Date.now() >= deadline) {
      logger.info(
        `Redshift cluster ${clusterId} (${logicalId}) is still '${status}' after the ` +
          `post-snapshot settle wait — proceeding with the delete anyway.`
      );
      return;
    }
    logger.debug(`Waiting for Redshift cluster ${clusterId} to settle (status: ${status})`);
    await finalSnapshotDelays.sleep(PRE_DELETE_SNAPSHOT_POLL_INTERVAL_MS);
  }
}

/**
 * ElastiCache final snapshot for a replication group + wait to `available`
 * (issue #1353), then the caller's delete proceeds.
 *
 * **Cluster-mode matters** (found live 2026-08-03, not by the mocked unit
 * tests): `CreateSnapshot` accepts `ReplicationGroupId` ONLY for a
 * cluster-mode-ENABLED (sharded) group. For the cluster-mode-DISABLED
 * default — which is what a plain CDK / CFn replication group is — AWS
 * rejects it with "Cannot snapshot a replication group with cluster-mode
 * disabled. Please specify a cache cluster instead.", and the snapshot must
 * name the PRIMARY member cache cluster instead. Both shapes produce one
 * snapshot of the group's data; only the parameter differs.
 *
 * Idempotent across delete re-runs via the `<group>-final-` name prefix,
 * probed against whichever source this group's mode uses.
 *
 * Redis only — Memcached / snapshot-incapable node types surface AWS's
 * rejection wrapped, matching CloudFormation's DELETE_FAILED for the same
 * template.
 */
export async function createReplicationGroupFinalSnapshot(
  client: ElastiCacheClient,
  replicationGroupId: string,
  logicalId: string,
  logger: InfoLogger
): Promise<string | null> {
  // Resolve the snapshot SOURCE first: the reuse probe has to look where the
  // snapshot would actually be created.
  let snapshotSource: { ReplicationGroupId: string } | { CacheClusterId: string };
  try {
    const described = await client.send(
      new DescribeReplicationGroupsCommand({ ReplicationGroupId: replicationGroupId })
    );
    const group = described.ReplicationGroups?.[0];
    if (group === undefined) {
      logger.debug(
        `Replication group ${replicationGroupId} no longer exists — skipping final snapshot for ${logicalId}`
      );
      return null;
    }
    if (group.ClusterEnabled === true) {
      snapshotSource = { ReplicationGroupId: replicationGroupId };
    } else {
      const primary = group.NodeGroups?.flatMap((n) => n.NodeGroupMembers ?? []).find(
        (m) => m.CurrentRole === 'primary'
      )?.CacheClusterId;
      const member = primary ?? group.MemberClusters?.[0];
      if (member === undefined) {
        throw new CdkdError(
          `Replication group ${replicationGroupId} (${logicalId}) has cluster-mode disabled but ` +
            `reports no member cache cluster to snapshot. The replication group was NOT deleted.`,
          'FINAL_SNAPSHOT_FAILED'
        );
      }
      snapshotSource = { CacheClusterId: member };
    }
  } catch (describeError) {
    if (describeError instanceof CdkdError) throw describeError;
    if (errorNameOrMessageIncludes(describeError, 'ReplicationGroupNotFoundFault')) {
      logger.debug(
        `Replication group ${replicationGroupId} no longer exists — skipping final snapshot for ${logicalId}`
      );
      return null;
    }
    const head = `Failed to read replication group ${replicationGroupId} (${logicalId}) to pick the final snapshot source required by DeletionPolicy: Snapshot`;
    throw finalSnapshotFailure(
      `${head}: ${failureSentence(logger, head, describeError)} The replication group was NOT deleted.`,
      describeError
    );
  }

  const matches = generatedSnapshotNameMatcher(
    replicationGroupId,
    'AWS::ElastiCache::ReplicationGroup'
  );
  let snapshotId: string | undefined;
  try {
    let marker: string | undefined;
    for (let page = 0; page < REUSE_PROBE_MAX_PAGES && !snapshotId; page++) {
      const existing = await client.send(
        new DescribeElastiCacheSnapshotsCommand({
          ...snapshotSource,
          ...(marker !== undefined && { Marker: marker }),
        })
      );
      snapshotId = existing.Snapshots?.find(
        (s) =>
          s.SnapshotName !== undefined &&
          matches.test(s.SnapshotName) &&
          s.SnapshotStatus === RESUMABLE_SNAPSHOT_STATUS
      )?.SnapshotName;
      marker = existing.Marker;
      if (marker === undefined) break;
    }
    if (snapshotId) {
      logger.debug(
        `Resuming in-flight final snapshot ${snapshotId} for ${logicalId} (${replicationGroupId}) from a previous delete attempt`
      );
    }
  } catch (probeError) {
    // Best-effort reuse probe — fall through to CreateSnapshot.
    logger.debug(
      `Final-snapshot reuse probe failed for ${replicationGroupId}: ${errMsg(probeError)}`
    );
  }

  const reused = snapshotId !== undefined;
  if (!snapshotId) {
    const newId = buildFinalSnapshotIdentifier(
      replicationGroupId,
      'AWS::ElastiCache::ReplicationGroup'
    );
    try {
      await client.send(
        new CreateElastiCacheSnapshotCommand({ ...snapshotSource, SnapshotName: newId })
      );
      snapshotId = newId;
    } catch (createError) {
      if (errorNameOrMessageIncludes(createError, 'ReplicationGroupNotFoundFault')) {
        logger.debug(
          `Replication group ${replicationGroupId} no longer exists — skipping final snapshot for ${logicalId}`
        );
        return null;
      }
      // Already `deleting` (an interrupted destroy being re-run): the group
      // cannot be snapshotted and is on its way out — treat it as gone
      // instead of stranding the resource behind a permanent failure.
      if (errorNameOrMessageIncludes(createError, 'InvalidReplicationGroupStateFault')) {
        logger.info(
          `Replication group ${replicationGroupId} is not in a snapshottable state (likely ` +
            `already deleting) — skipping the final snapshot for ${logicalId}: ${errMsg(createError)}`
        );
        return null;
      }
      const head = `Failed to create the final snapshot for ${logicalId} (${replicationGroupId}) required by DeletionPolicy: Snapshot`;
      throw finalSnapshotFailure(
        `${head}: ${failureSentence(logger, head, createError)} The replication group was NOT deleted.`,
        createError
      );
    }
  }

  return waitForNamedSnapshot({
    snapshotId,
    logicalId,
    sourceId: replicationGroupId,
    noun: 'replication group',
    reused,
    readyStatus: 'available',
    failedStatuses: ['failed'],
    pollStatus: async () => {
      const described = await client.send(
        new DescribeElastiCacheSnapshotsCommand({ SnapshotName: snapshotId })
      );
      return described.Snapshots?.[0]?.SnapshotStatus;
    },
    isTransientNotFound: (e) => errorNameOrMessageIncludes(e, 'SnapshotNotFoundFault'),
    logger,
  });
}
