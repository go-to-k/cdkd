import {
  CreateSnapshotCommand,
  DescribeSnapshotsCommand,
  type EC2Client,
} from '@aws-sdk/client-ec2';
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

/**
 * How a `Snapshot`-policy delete of a given (resourceType, routing layer) is
 * carried out — or why it cannot be.
 *
 *   - `atomic-delete-parameter`: the provider's delete call takes the
 *     identifier ({@link ATOMIC_FINAL_SNAPSHOT_TYPES} on the SDK route).
 *   - `pre-delete-snapshot`: cdkd snapshots explicitly first via
 *     {@link createPreDeleteFinalSnapshot}, then deletes plainly.
 *   - `refuse-cc-routed`: an atomic type routed through Cloud Control, whose
 *     `DeleteResource` has no final-snapshot parameter
 *     ({@link ccRoutedFinalSnapshotError}).
 *   - `refuse-unsupported-type`: no mechanism at all
 *     ({@link unsupportedFinalSnapshotError}).
 */
export type FinalSnapshotMechanism =
  | 'atomic-delete-parameter'
  | 'pre-delete-snapshot'
  | 'refuse-cc-routed'
  | 'refuse-unsupported-type';

/**
 * The mechanism matrix as a PURE function of (type, route) — issue #1366.
 *
 * Extracted so the executor that ACTS on it and the plan preview that
 * DESCRIBES it read one source: the preview used to promise "final snapshot,
 * then delete" for every Snapshot-policy resource, including the shapes the
 * replay was about to refuse. Deciding this in the CLI's label layer rather
 * than in the pure classifier is deliberate — whether a refusal actually
 * happens ALSO depends on `--skip-final-snapshot`, a flag the classifier
 * cannot see, and the label functions take it.
 *
 * `provisionedBy` must be the route the DELETE will take (state record first,
 * journaled op as the legacy fallback), not merely the op's recorded one —
 * a gate judging a different route than the delete uses is worse than none.
 */
export function finalSnapshotMechanism(
  resourceType: string,
  provisionedBy: 'sdk' | 'cc-api' | undefined
): FinalSnapshotMechanism {
  if (ATOMIC_FINAL_SNAPSHOT_TYPES.has(resourceType)) {
    return provisionedBy === 'cc-api' ? 'refuse-cc-routed' : 'atomic-delete-parameter';
  }
  if (PRE_DELETE_SNAPSHOT_TYPES.has(resourceType)) return 'pre-delete-snapshot';
  return 'refuse-unsupported-type';
}

/**
 * Will a `Snapshot`-policy delete of this (type, route) be REFUSED rather
 * than carried out? The plan preview's question (issue #1366).
 */
export function refusesFinalSnapshot(
  resourceType: string,
  provisionedBy: 'sdk' | 'cc-api' | undefined
): boolean {
  const mechanism = finalSnapshotMechanism(resourceType, provisionedBy);
  return mechanism === 'refuse-cc-routed' || mechanism === 'refuse-unsupported-type';
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
/** Post-snapshot settle budget for a Redshift cluster before its delete. */
const REDSHIFT_CLUSTER_SETTLE_TIMEOUT_MS = 20 * 60 * 1_000;

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
 * creating a second one. Reusing a `completed` snapshot is safe HERE (and
 * only here) because an EBS volume id is AWS-generated and never reused, so
 * the tag can only ever point at THIS volume's data — unlike the name-keyed
 * Redshift / ElastiCache APIs, whose user-chosen ids repeat across
 * generations and therefore only resume an in-flight snapshot (see
 * {@link RESUMABLE_SNAPSHOT_STATUS}).
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
      throw new CdkdError(
        `Failed to create the final snapshot for ${logicalId} (${clusterId}) required by ` +
          `DeletionPolicy: Snapshot: ${errMsg(createError)}. The cluster was NOT deleted.`,
        'FINAL_SNAPSHOT_FAILED'
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
    throw new CdkdError(
      `Failed to read replication group ${replicationGroupId} (${logicalId}) to pick the final ` +
        `snapshot source required by DeletionPolicy: Snapshot: ${errMsg(describeError)}. The ` +
        `replication group was NOT deleted.`,
      'FINAL_SNAPSHOT_FAILED',
      describeError instanceof Error ? describeError : undefined
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
