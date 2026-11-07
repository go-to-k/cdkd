import { CdkdError } from '../utils/error-handler.js';
import { logicalIdShown, resourceTypeShown } from './composite-id.js';

// The bodies live in the `final-snapshot/` sibling directory (go-to-k/cdkd#5835);
// this entry re-exports every symbol it exported before, so importers are unchanged.
export {
  finalSnapshotNamePrefix,
  finalSnapshotNameCut,
  buildFinalSnapshotIdentifier,
  EBS_FINAL_SNAPSHOT_TAG_KEY,
  finalSnapshotDelays,
} from './final-snapshot/shared.js';
export { createEbsFinalSnapshot } from './final-snapshot/ebs.js';
export {
  createPreDeleteFinalSnapshot,
  createRedshiftFinalSnapshot,
  createReplicationGroupFinalSnapshot,
} from './final-snapshot/pre-delete.js';
export type { PreDeleteSnapshotClients } from './final-snapshot/pre-delete.js';

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
 *
 * The two sets are DISJOINT by construction and must stay that way:
 * {@link finalSnapshotMechanism} tests the atomic set first, so a type in
 * both would silently take the atomic arm and never be snapshotted here.
 * Pinned by `final-snapshot.test.ts`.
 */
export const PRE_DELETE_SNAPSHOT_TYPES: ReadonlySet<string> = new Set([
  'AWS::EC2::Volume',
  'AWS::Redshift::Cluster',
  'AWS::ElastiCache::ReplicationGroup',
]);

/**
 * The `DeletionPolicy` a delete must honor: the recorded one, or, when none
 * is recorded, CloudFormation's DEFAULT (issue #4030). That default is
 * `Delete` for every type except `AWS::RDS::DBCluster` and an
 * `AWS::RDS::DBInstance` without `DBClusterIdentifier`, where it is
 * `Snapshot` (CloudFormation Template Reference, "DeletionPolicy attribute").
 *
 * DeletionPolicy ONLY: `UpdateReplacePolicy` defaults to `Delete` for every
 * type, so a replacement delete never reads this. Applied where a delete
 * CONSUMES the policy, never where it is recorded: the recorded value is what
 * `cdkd diff` compares against the template's attribute.
 */
export function effectiveDeletionPolicy<P extends string>(
  resourceType: string,
  recorded: P | undefined,
  properties: Record<string, unknown> | undefined
): P | 'Snapshot' | undefined {
  if (recorded !== undefined) return recorded;
  if (resourceType === 'AWS::RDS::DBCluster') return 'Snapshot';
  if (
    resourceType === 'AWS::RDS::DBInstance' &&
    properties?.['DBClusterIdentifier'] === undefined
  ) {
    return 'Snapshot';
  }
  return undefined;
}

/**
 * The policy a REPLACEMENT's delete of the old resource honors, for
 * `DeleteContext.deletionPolicy` (issue #4029): its `UpdateReplacePolicy`,
 * whose CloudFormation default is `Delete` for every type (unlike
 * {@link effectiveDeletionPolicy}'s RDS exception).
 */
export function replacementDeletePolicy(updateReplacePolicy: string | undefined): string {
  return updateReplacePolicy ?? 'Delete';
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
 * `provisionedBy: 'cc-api'` (#614 SDK-unwired routing / `--recreate-via-cc-api`).
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
    // Both values come from a state record, and this line names an `aws`
    // command and the `--skip-final-snapshot` flag: each is named only when
    // plain, described otherwise, here in the builder so every caller is
    // covered (go-to-k/cdkd#4265, go-to-k/cdkd#3950's S1 rule).
    `${logicalIdShown(logicalId)} (${resourceTypeShown(resourceType)}) has DeletionPolicy: Snapshot, but the resource is ` +
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
    // Named only when plain, as in `ccRoutedFinalSnapshotError`.
    `${logicalIdShown(logicalId)} (${resourceTypeShown(resourceType)}) has DeletionPolicy: Snapshot, but cdkd does not ` +
      `implement final snapshots for this type (CloudFormation itself only supports Snapshot ` +
      `on: EC2 Volume, ElastiCache CacheCluster / ReplicationGroup, Neptune / RDS / DocDB ` +
      `clusters, RDS instances, Redshift clusters). ` +
      `Deleting it now would destroy its data WITHOUT the final snapshot the policy promises. ` +
      `Re-run with ${skipFlagHint} to delete WITHOUT a final snapshot (DATA LOSS), or retain ` +
      `the resource (DeletionPolicy: Retain) and delete it manually after snapshotting.`,
    'FINAL_SNAPSHOT_UNSUPPORTED'
  );
}
