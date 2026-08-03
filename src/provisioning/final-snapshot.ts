import {
  CreateSnapshotCommand,
  DescribeSnapshotsCommand,
  type EC2Client,
} from '@aws-sdk/client-ec2';
import {
  CreateClusterSnapshotCommand,
  DescribeClusterSnapshotsCommand,
  type RedshiftClient,
} from '@aws-sdk/client-redshift';
import {
  CreateSnapshotCommand as CreateElastiCacheSnapshotCommand,
  DescribeSnapshotsCommand as DescribeElastiCacheSnapshotsCommand,
  type ElastiCacheClient,
} from '@aws-sdk/client-elasticache';
import { CdkdError } from '../utils/error-handler.js';

/** Minimal logger surface used here (avoids coupling to the full Logger type). */
type InfoLogger = { info(message: string): void; debug(message: string): void };

/**
 * `DeletionPolicy: Snapshot` support (issues #1352 / #1353).
 *
 * CloudFormation creates a final snapshot BEFORE deleting a resource whose
 * `DeletionPolicy` is `Snapshot`. cdkd historically treated the policy as
 * `Delete` (no snapshot — silent data loss vs CFn, live-A/B-confirmed on
 * `AWS::EC2::Volume`). The delete paths now honor the policy through the
 * two mechanisms below; a Snapshot-tagged type supported by NEITHER (or one
 * routed via Cloud Control, which has no snapshot notion) is refused with an
 * actionable error unless `--skip-final-snapshot` opts into the data loss.
 *
 * The full CFn-documented Snapshot-capable type list (CFn refuses the
 * attribute on anything else): AWS::EC2::Volume, AWS::ElastiCache::CacheCluster,
 * AWS::ElastiCache::ReplicationGroup, AWS::Neptune::DBCluster,
 * AWS::RDS::DBCluster, AWS::RDS::DBInstance, AWS::Redshift::Cluster,
 * AWS::DocDB::DBCluster — all covered by one of the two mechanisms.
 */

/**
 * Types whose delete API takes an atomic final-snapshot parameter. The
 * destroy paths generate a snapshot identifier and pass it via
 * `DeleteContext.finalSnapshotIdentifier`; the type's SDK provider flips its
 * delete call from `SkipFinalSnapshot: true` to the final-snapshot form.
 */
export const ATOMIC_FINAL_SNAPSHOT_TYPES: ReadonlySet<string> = new Set([
  'AWS::RDS::DBInstance',
  'AWS::RDS::DBCluster',
  'AWS::Neptune::DBCluster',
  'AWS::DocDB::DBCluster',
  'AWS::ElastiCache::CacheCluster',
]);

/**
 * Types with no atomic delete parameter, where cdkd snapshots explicitly
 * BEFORE the (routing-layer-agnostic) delete via
 * {@link createPreDeleteFinalSnapshot}. All three are CC-API-routed (no SDK
 * provider), so the pre-delete snapshot lives at the delete call sites, not
 * in a provider: `AWS::EC2::Volume` (EC2 `CreateSnapshot`, issue #1352),
 * `AWS::Redshift::Cluster` (`CreateClusterSnapshot`, issue #1353), and
 * `AWS::ElastiCache::ReplicationGroup` (ElastiCache `CreateSnapshot`
 * against the replication group, issue #1353).
 */
export const PRE_DELETE_SNAPSHOT_TYPES: ReadonlySet<string> = new Set([
  'AWS::EC2::Volume',
  'AWS::Redshift::Cluster',
  'AWS::ElastiCache::ReplicationGroup',
]);

/** Can cdkd honor `DeletionPolicy: Snapshot` for this type? */
export function supportsFinalSnapshot(resourceType: string): boolean {
  return (
    ATOMIC_FINAL_SNAPSHOT_TYPES.has(resourceType) || PRE_DELETE_SNAPSHOT_TYPES.has(resourceType)
  );
}

/** Sanitize a physical id into the snapshot-identifier charset (shared by the
 * identifier builder and the pre-delete reuse-probe prefix match). */
function sanitizeSnapshotBase(physicalId: string): string {
  let base = physicalId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(base)) base = `r${base}`;
  return base;
}

/** Length of the compact UTC timestamp suffix (`yyyymmdd-hhmmss`). */
const FINAL_SNAPSHOT_TS_LENGTH = 15;

/**
 * The `<sanitized-physical-id>-final-` prefix every cdkd final snapshot of a
 * given source shares — the reuse-probe key for the name-keyed snapshot APIs
 * (Redshift / ElastiCache), the analogue of the EBS tag. Applies the same
 * per-service length cap as {@link buildFinalSnapshotIdentifier} so a
 * truncated generated name still matches its own prefix.
 */
export function finalSnapshotNamePrefix(physicalId: string, resourceType?: string): string {
  // RDS-family snapshot identifiers allow up to 255 chars; ElastiCache
  // snapshot names follow the ~50-char cluster-naming rules — a longer name
  // makes the snapshot call reject and the delete fail mid-run.
  const maxLength =
    resourceType === 'AWS::ElastiCache::CacheCluster' ||
    resourceType === 'AWS::ElastiCache::ReplicationGroup'
      ? 50
      : 255;
  const base = sanitizeSnapshotBase(physicalId)
    .slice(0, maxLength - ('-final-'.length + FINAL_SNAPSHOT_TS_LENGTH))
    .replace(/-+$/, '');
  return `${base}-final-`;
}

/**
 * Build the final-snapshot identifier for a snapshot-creating delete.
 *
 * Constraints are the intersection of the RDS / Neptune / DocDB snapshot
 * identifier rules and the ElastiCache snapshot name rules: start with a
 * letter, letters/digits/hyphens only, no consecutive or trailing hyphen.
 * The physical id already satisfies the source API's naming rules; it is
 * lowercased (RDS canonicalizes to lowercase anyway) and defensively
 * re-sanitized. A UTC timestamp suffix keeps repeated deletes of a
 * re-created same-name resource from colliding; within ONE run the
 * identifier is generated once per resource, so delete retries reuse it.
 */
export function buildFinalSnapshotIdentifier(
  physicalId: string,
  resourceType?: string,
  now: Date = new Date()
): string {
  const ts = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..*$/, '')
    .replace('T', '-')
    .toLowerCase();
  return `${finalSnapshotNamePrefix(physicalId, resourceType)}${ts}`;
}

/** Tag key marking a cdkd-created final snapshot of an EBS volume. */
export const EBS_FINAL_SNAPSHOT_TAG_KEY = 'cdkd:final-snapshot-of';

/** Test seam (matches the `describe-type.ts` / macro-expander pattern). */
export const finalSnapshotDelays = {
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

const PRE_DELETE_SNAPSHOT_POLL_INTERVAL_MS = 5_000;
const PRE_DELETE_SNAPSHOT_TIMEOUT_MS = 60 * 60 * 1_000;

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isVolumeNotFound(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  return name === 'InvalidVolume.NotFound' || errMsg(error).includes('InvalidVolume.NotFound');
}

/**
 * Create (or resume waiting on) the final EBS snapshot of a volume and wait
 * until it completes, mirroring CloudFormation's observable behavior — CFn
 * deletes the volume only after the final snapshot is done.
 *
 * Idempotent across destroy re-runs: an existing pending/completed snapshot
 * carrying the `cdkd:final-snapshot-of: <volumeId>` tag is reused instead of
 * creating a second one.
 *
 * @returns the snapshot id, or `null` when the volume no longer exists
 *   (nothing to snapshot; the subsequent delete is idempotent too).
 */
export async function createEbsFinalSnapshot(
  client: EC2Client,
  volumeId: string,
  logicalId: string,
  logger: InfoLogger
): Promise<string | null> {
  let snapshotId: string | undefined;
  try {
    const existing = await client.send(
      new DescribeSnapshotsCommand({
        OwnerIds: ['self'],
        Filters: [
          { Name: `tag:${EBS_FINAL_SNAPSHOT_TAG_KEY}`, Values: [volumeId] },
          { Name: 'status', Values: ['pending', 'completed'] },
        ],
      })
    );
    snapshotId = existing.Snapshots?.[0]?.SnapshotId;
    if (snapshotId) {
      logger.debug(
        `Reusing existing final snapshot ${snapshotId} for ${logicalId} (${volumeId}) from a previous destroy attempt`
      );
    }
  } catch (probeError) {
    // Best-effort reuse probe — fall through to CreateSnapshot.
    logger.debug(`Final-snapshot reuse probe failed for ${volumeId}: ${errMsg(probeError)}`);
  }

  if (!snapshotId) {
    try {
      const created = await client.send(
        new CreateSnapshotCommand({
          VolumeId: volumeId,
          Description: `cdkd final snapshot for ${volumeId} (DeletionPolicy: Snapshot)`,
          TagSpecifications: [
            {
              ResourceType: 'snapshot',
              Tags: [{ Key: EBS_FINAL_SNAPSHOT_TAG_KEY, Value: volumeId }],
            },
          ],
        })
      );
      snapshotId = created.SnapshotId;
    } catch (createError) {
      if (isVolumeNotFound(createError)) {
        logger.debug(
          `Volume ${volumeId} no longer exists — skipping final snapshot for ${logicalId}`
        );
        return null;
      }
      throw new CdkdError(
        `Failed to create the final snapshot for ${logicalId} (${volumeId}) required by ` +
          `DeletionPolicy: Snapshot: ${errMsg(createError)}. The volume was NOT deleted.`,
        'FINAL_SNAPSHOT_FAILED'
      );
    }
  }
  if (!snapshotId) {
    throw new CdkdError(
      `CreateSnapshot for ${logicalId} (${volumeId}) returned no snapshot id. The volume was NOT deleted.`,
      'FINAL_SNAPSHOT_FAILED'
    );
  }

  logger.info(
    `Creating final snapshot ${snapshotId} for ${logicalId} (${volumeId}) — DeletionPolicy: Snapshot`
  );

  const deadline = Date.now() + PRE_DELETE_SNAPSHOT_TIMEOUT_MS;
  // EC2 is eventually consistent: a just-created snapshot id can 404
  // (`InvalidSnapshot.NotFound`) on the first polls. Tolerate it briefly.
  let notFoundPolls = 0;
  for (;;) {
    let state: string | undefined;
    try {
      const described = await client.send(
        new DescribeSnapshotsCommand({ SnapshotIds: [snapshotId] })
      );
      state = described.Snapshots?.[0]?.State;
      notFoundPolls = 0;
    } catch (pollError) {
      const name = pollError instanceof Error ? pollError.name : '';
      const isSnapshotNotFound =
        name === 'InvalidSnapshot.NotFound' ||
        errMsg(pollError).includes('InvalidSnapshot.NotFound');
      if (isSnapshotNotFound && ++notFoundPolls <= 24) {
        state = undefined; // still propagating — keep polling
      } else {
        // Wrap EVERY poll failure in the typed FINAL_SNAPSHOT error. This is
        // load-bearing beyond nice messaging: the destroy call sites'
        // idempotent-delete heuristics match "not found" / "does not exist"
        // SUBSTRINGS and would otherwise read a raw poll error as "resource
        // already deleted", dropping a live volume from state WITHOUT
        // deleting it. The call sites rethrow FINAL_SNAPSHOT_* errors before
        // applying those heuristics.
        throw new CdkdError(
          `Failed while waiting for final snapshot ${snapshotId} of ${logicalId} (${volumeId}): ` +
            `${errMsg(pollError)}. The volume was NOT deleted; re-run the destroy (the ` +
            `snapshot is reused, not duplicated).`,
          'FINAL_SNAPSHOT_FAILED',
          pollError instanceof Error ? pollError : undefined
        );
      }
    }
    if (state === 'completed') {
      logger.info(`Final snapshot ${snapshotId} completed for ${logicalId} (${volumeId})`);
      return snapshotId;
    }
    if (state === 'error') {
      throw new CdkdError(
        `Final snapshot ${snapshotId} for ${logicalId} (${volumeId}) entered 'error' state. ` +
          `The volume was NOT deleted.`,
        'FINAL_SNAPSHOT_FAILED'
      );
    }
    if (Date.now() >= deadline) {
      throw new CdkdError(
        `Timed out waiting for final snapshot ${snapshotId} of ${logicalId} (${volumeId}) to ` +
          `complete. The volume was NOT deleted; the snapshot continues in AWS — re-run the ` +
          `destroy once it completes (the existing snapshot is reused, not duplicated).`,
        'FINAL_SNAPSHOT_TIMEOUT'
      );
    }
    await finalSnapshotDelays.sleep(PRE_DELETE_SNAPSHOT_POLL_INTERVAL_MS);
  }
}

/**
 * Is this one of the typed final-snapshot failures the destroy call sites
 * must RETHROW before applying their "not found = already deleted"
 * idempotency heuristics? (Those heuristics match message substrings; a raw
 * snapshot-poll NotFound would otherwise be read as "resource already
 * deleted" and strand a live, un-snapshotted volume outside state.)
 */
export function isFinalSnapshotError(error: unknown): boolean {
  return (
    error instanceof CdkdError &&
    (error.code === 'FINAL_SNAPSHOT_FAILED' ||
      error.code === 'FINAL_SNAPSHOT_TIMEOUT' ||
      error.code === 'FINAL_SNAPSHOT_UNSUPPORTED')
  );
}

/**
 * Refusal for an atomic-final-snapshot type whose state records
 * `provisionedBy: 'cc-api'` (#614 silent-drop routing / `--recreate-via-cc-api`).
 * Cloud Control `DeleteResource` has no final-snapshot parameter and
 * `CloudControlProvider` cannot honor `finalSnapshotIdentifier`, so deleting
 * via that route would silently drop the promised snapshot — refuse instead.
 */
export function ccRoutedFinalSnapshotError(
  logicalId: string,
  resourceType: string,
  skipFlagHint: string
): CdkdError {
  return new CdkdError(
    `${logicalId} (${resourceType}) has DeletionPolicy: Snapshot, but the resource is ` +
      `managed via the Cloud Control API route (provisionedBy: cc-api), which has no ` +
      `final-snapshot delete parameter — deleting it now would destroy its data WITHOUT ` +
      `the final snapshot the policy promises. Create a snapshot manually ` +
      `(e.g. aws rds create-db-snapshot / aws elasticache create-snapshot), then re-run ` +
      `with ${skipFlagHint} to delete WITHOUT cdkd's final snapshot (DATA LOSS otherwise), ` +
      `or retain the resource (DeletionPolicy: Retain) and delete it manually.`,
    'FINAL_SNAPSHOT_UNSUPPORTED'
  );
}

/**
 * Build the refusal error for a Snapshot-tagged type cdkd cannot snapshot.
 * Thrown by the delete call sites BEFORE any delete is issued. Since #1353
 * every CFn-documented Snapshot-capable type is covered, so this only fires
 * for a type CloudFormation itself would refuse the attribute on (hand-
 * edited templates / imported state).
 */
export function unsupportedFinalSnapshotError(
  logicalId: string,
  resourceType: string,
  skipFlagHint: string
): CdkdError {
  return new CdkdError(
    `${logicalId} (${resourceType}) has DeletionPolicy: Snapshot, but cdkd does not ` +
      `implement final snapshots for this type (CloudFormation itself only supports Snapshot ` +
      `on: EC2 Volume, ElastiCache CacheCluster / ReplicationGroup, Neptune / RDS / DocDB ` +
      `clusters, RDS instances, Redshift clusters). ` +
      `Deleting it now would destroy its data WITHOUT the final snapshot the policy promises. ` +
      `Re-run with ${skipFlagHint} to delete WITHOUT a final snapshot (DATA LOSS), or retain ` +
      `the resource (DeletionPolicy: Retain) and delete it manually after snapshotting.`,
    'FINAL_SNAPSHOT_UNSUPPORTED'
  );
}

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
  readyStatus: string;
  failedStatus: string;
  pollStatus: () => Promise<string | undefined>;
  isTransientNotFound: (error: unknown) => boolean;
  logger: InfoLogger;
}): Promise<string> {
  const { snapshotId, logicalId, sourceId, noun, logger } = opts;
  logger.info(
    `Creating final snapshot ${snapshotId} for ${logicalId} (${sourceId}) — DeletionPolicy: Snapshot`
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
        throw new CdkdError(
          `Failed while waiting for final snapshot ${snapshotId} of ${logicalId} (${sourceId}): ` +
            `${errMsg(pollError)}. The ${noun} was NOT deleted; re-run the delete (the ` +
            `snapshot is reused, not duplicated).`,
          'FINAL_SNAPSHOT_FAILED',
          pollError instanceof Error ? pollError : undefined
        );
      }
    }
    if (status === opts.readyStatus) {
      logger.info(`Final snapshot ${snapshotId} ready for ${logicalId} (${sourceId})`);
      return snapshotId;
    }
    if (status === opts.failedStatus) {
      throw new CdkdError(
        `Final snapshot ${snapshotId} for ${logicalId} (${sourceId}) entered '${opts.failedStatus}' ` +
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
  const prefix = finalSnapshotNamePrefix(clusterId, 'AWS::Redshift::Cluster');
  let snapshotId: string | undefined;
  try {
    const existing = await client.send(
      new DescribeClusterSnapshotsCommand({
        ClusterIdentifier: clusterId,
        SnapshotType: 'manual',
      })
    );
    snapshotId = existing.Snapshots?.find(
      (s) =>
        s.SnapshotIdentifier?.startsWith(prefix) &&
        (s.Status === 'creating' || s.Status === 'available')
    )?.SnapshotIdentifier;
    if (snapshotId) {
      logger.debug(
        `Reusing existing final snapshot ${snapshotId} for ${logicalId} (${clusterId}) from a previous delete attempt`
      );
    }
  } catch (probeError) {
    // Best-effort reuse probe — fall through to CreateClusterSnapshot.
    logger.debug(`Final-snapshot reuse probe failed for ${clusterId}: ${errMsg(probeError)}`);
  }

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
      throw new CdkdError(
        `Failed to create the final snapshot for ${logicalId} (${clusterId}) required by ` +
          `DeletionPolicy: Snapshot: ${errMsg(createError)}. The cluster was NOT deleted.`,
        'FINAL_SNAPSHOT_FAILED'
      );
    }
  }

  return waitForNamedSnapshot({
    snapshotId,
    logicalId,
    sourceId: clusterId,
    noun: 'cluster',
    readyStatus: 'available',
    failedStatus: 'failed',
    pollStatus: async () => {
      const described = await client.send(
        new DescribeClusterSnapshotsCommand({ SnapshotIdentifier: snapshotId })
      );
      return described.Snapshots?.[0]?.Status;
    },
    isTransientNotFound: (e) => errorNameOrMessageIncludes(e, 'ClusterSnapshotNotFoundFault'),
    logger,
  });
}

/**
 * ElastiCache `CreateSnapshot` against a replication group + wait to
 * `available` (issue #1353). Snapshots the primary node; AWS rejects the
 * call for Memcached / snapshot-incapable node types — that error surfaces
 * wrapped, matching CloudFormation's DELETE_FAILED for the same template.
 * Idempotent across delete re-runs via the `<group>-final-` name prefix.
 */
export async function createReplicationGroupFinalSnapshot(
  client: ElastiCacheClient,
  replicationGroupId: string,
  logicalId: string,
  logger: InfoLogger
): Promise<string | null> {
  const prefix = finalSnapshotNamePrefix(replicationGroupId, 'AWS::ElastiCache::ReplicationGroup');
  let snapshotId: string | undefined;
  try {
    const existing = await client.send(
      new DescribeElastiCacheSnapshotsCommand({ ReplicationGroupId: replicationGroupId })
    );
    snapshotId = existing.Snapshots?.find(
      (s) =>
        s.SnapshotName?.startsWith(prefix) &&
        (s.SnapshotStatus === 'creating' || s.SnapshotStatus === 'available')
    )?.SnapshotName;
    if (snapshotId) {
      logger.debug(
        `Reusing existing final snapshot ${snapshotId} for ${logicalId} (${replicationGroupId}) from a previous delete attempt`
      );
    }
  } catch (probeError) {
    // Best-effort reuse probe — fall through to CreateSnapshot.
    logger.debug(
      `Final-snapshot reuse probe failed for ${replicationGroupId}: ${errMsg(probeError)}`
    );
  }

  if (!snapshotId) {
    const newId = buildFinalSnapshotIdentifier(
      replicationGroupId,
      'AWS::ElastiCache::ReplicationGroup'
    );
    try {
      await client.send(
        new CreateElastiCacheSnapshotCommand({
          ReplicationGroupId: replicationGroupId,
          SnapshotName: newId,
        })
      );
      snapshotId = newId;
    } catch (createError) {
      if (errorNameOrMessageIncludes(createError, 'ReplicationGroupNotFoundFault')) {
        logger.debug(
          `Replication group ${replicationGroupId} no longer exists — skipping final snapshot for ${logicalId}`
        );
        return null;
      }
      throw new CdkdError(
        `Failed to create the final snapshot for ${logicalId} (${replicationGroupId}) required ` +
          `by DeletionPolicy: Snapshot: ${errMsg(createError)}. The replication group was NOT ` +
          `deleted.`,
        'FINAL_SNAPSHOT_FAILED'
      );
    }
  }

  return waitForNamedSnapshot({
    snapshotId,
    logicalId,
    sourceId: replicationGroupId,
    noun: 'replication group',
    readyStatus: 'available',
    failedStatus: 'failed',
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
