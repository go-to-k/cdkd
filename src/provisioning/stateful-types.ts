/**
 * Stateful-resource guard list (issue [#615]).
 *
 * `--recreate-via-cc-api <LogicalId>` destroys + recreates the named
 * resource in one deploy so a previously-silent-dropped top-level CFn
 * property reaches AWS via Cloud Control API. For most types this is
 * safe — destroying + recreating an IAM Role or a Lambda Function
 * loses no user data — but for **data-bearing** types the destroy
 * cycle loses everything in the resource: rows in a DynamoDB table,
 * objects in an S3 bucket, log lines in a LogGroup, images in an ECR
 * repository, etc.
 *
 * To avoid an accidental data-loss footgun, cdkd refuses to recreate
 * any resource whose type is in {@link STATEFUL_TYPES} unless the user
 * ALSO passes `--force-stateful-recreation`. The two-flag protection
 * mirrors `--remove-protection`'s pattern (see
 * `src/cli/commands/destroy-runner.ts`).
 *
 * The list is hand-curated and intentionally **conservative**: every
 * type here carries user data that the AWS service does NOT
 * automatically migrate to the replacement resource. Types that the
 * AWS service treats as ephemeral (e.g. Lambda Function, IAM Role)
 * are NOT in this list — recreate is cheap.
 *
 * Two entries are **conditionally stateful** — they only count when
 * the resource actually contains data:
 *
 *   - `AWS::S3::Bucket`: empty buckets are safe to recreate. The
 *     deploy engine probes `s3:ListObjectsV2` at plan time and only
 *     refuses when the bucket has at least one object.
 *   - `AWS::Logs::LogGroup`: a log group with `RetentionInDays`
 *     undefined or zero is functionally ephemeral. The deploy engine
 *     refuses only when `RetentionInDays > 0`.
 *
 * Both conditional checks live in {@link isStatefulRecreateTarget};
 * the bare {@link STATEFUL_TYPES} set is the type-only first-cut.
 */

export const STATEFUL_TYPES: ReadonlySet<string> = new Set([
  // Database / storage primaries (data-bearing core).
  'AWS::RDS::DBInstance',
  'AWS::RDS::DBCluster',
  'AWS::DocDB::DBInstance',
  'AWS::DocDB::DBCluster',
  'AWS::Neptune::DBInstance',
  'AWS::Neptune::DBCluster',
  'AWS::DynamoDB::Table',
  'AWS::DynamoDB::GlobalTable',
  // Filesystem / blob.
  'AWS::EFS::FileSystem',
  'AWS::FSx::FileSystem',
  'AWS::S3::Bucket', // conditional — see isStatefulRecreateTarget
  'AWS::ECR::Repository',
  // Streaming.
  'AWS::Kinesis::Stream',
  // Search.
  'AWS::Elasticsearch::Domain',
  'AWS::OpenSearchService::Domain',
  // Identity / config (user-managed values).
  'AWS::Cognito::UserPool',
  'AWS::SecretsManager::Secret',
  'AWS::SSM::Parameter',
  // Metadata catalog.
  'AWS::Glue::Database',
  'AWS::Glue::Table',
  // Logs (retained data).
  'AWS::Logs::LogGroup', // conditional — see isStatefulRecreateTarget
  // Edge / URL-immutability — CloudFront URL change breaks downstream
  // consumers and the change has a ~20-minute propagation window.
  'AWS::CloudFront::Distribution',
]);

/**
 * Multi-region resource types — `--recreate-via-cc-api` refuses these
 * outright in v1 regardless of `--force-stateful-recreation`. Design
 * doc §8 calls these "out of scope": the destroy + recreate cycle
 * across replica regions is more involved than a single-region
 * destroy-and-create (replica regions, automated backups, eventual
 * consistency across the replication mesh, etc.).
 *
 * Distinct from {@link STATEFUL_TYPES} — STATEFUL_TYPES gates on data
 * loss (bypassable with `--force-stateful-recreation`); this set is
 * an out-of-scope refusal (no bypass).
 */
export const MULTI_REGION_RECREATE_BLOCKED_TYPES: ReadonlySet<string> = new Set([
  'AWS::DynamoDB::GlobalTable',
]);

/**
 * Reason an existing resource is treated as stateful for the
 * recreate-via-cc-api guard.
 *
 *  - `'always'` — destroy + recreate always loses user data for this
 *    type, regardless of the resource's current properties (RDS,
 *    DynamoDB, EFS, etc.).
 *  - `'has-objects'` — S3 bucket with at least one object (probed at
 *    plan time).
 *  - `'has-retention'` — Logs::LogGroup with `RetentionInDays > 0`
 *    (read from the resource's recorded properties).
 *  - `null` — not stateful for the purposes of this guard.
 */
export type StatefulReason = 'always' | 'has-objects' | 'has-retention' | null;

/**
 * Cheap, synchronous read of the resource's recorded properties only.
 * For `AWS::S3::Bucket` this returns `null` — the live `ListObjectsV2`
 * probe to distinguish empty buckets (safe to recreate) from
 * non-empty (data loss) lives in
 * `src/deployment/recreate-targets.ts#probeStatefulRecreateTargetsAsync`
 * (issue [#648]) and runs after this sync first-cut. Sync callers can
 * still treat `null` as "not stateful" — the deploy command does both
 * passes back-to-back; only callers that explicitly opt out of the
 * async probe need to assume conservative "stateful" semantics.
 *
 * Returns the {@link StatefulReason} when the type is stateful (or
 * `null` for non-stateful types).
 */
export function isStatefulRecreateTargetSync(
  resourceType: string,
  recordedProperties: Record<string, unknown> | undefined
): StatefulReason {
  if (!STATEFUL_TYPES.has(resourceType)) return null;
  if (resourceType === 'AWS::Logs::LogGroup') {
    const retention = recordedProperties?.['RetentionInDays'];
    if (typeof retention === 'number' && retention > 0) return 'has-retention';
    return null;
  }
  if (resourceType === 'AWS::S3::Bucket') {
    // The live object-count probe runs in the deploy engine. The bare
    // sync map cannot judge — defer.
    return null;
  }
  return 'always';
}

/**
 * Conservative variant for the `cdkd deploy --replace` mid-deploy guard.
 *
 * `--replace` catches a provider's immutable-update rejection while the deploy
 * is already in flight, so — unlike the `--recreate-via-*` pre-flight, which
 * runs {@link probeStatefulRecreateTargetsAsync} (`s3:ListObjectVersions`) —
 * there is no opportunity to probe an `AWS::S3::Bucket`'s object count. The
 * sync check returns `null` for S3 (it defers to that async probe), which would
 * let a NON-EMPTY bucket be DELETE + CREATEd (data loss) without
 * `--force-stateful-recreation`. To stay fail-safe, treat a deferred S3 bucket
 * as stateful here: the user must pass `--force-stateful-recreation` to replace
 * ANY S3 bucket via `--replace`, empty or not. Every other type matches
 * {@link isStatefulRecreateTargetSync} exactly (the LogGroup retention check is
 * fully resolvable from recorded properties, so no conservatism is needed there).
 */
export function isStatefulRecreateTargetForReplace(
  resourceType: string,
  recordedProperties: Record<string, unknown> | undefined
): StatefulReason {
  const sync = isStatefulRecreateTargetSync(resourceType, recordedProperties);
  if (sync) return sync;
  if (resourceType === 'AWS::S3::Bucket') {
    // Cannot prove the bucket is empty mid-deploy — assume it has data.
    return 'has-objects';
  }
  return null;
}

/**
 * Human-readable rendering of {@link StatefulReason} for error
 * messages. Used by the pre-flight guard's "X resources require
 * --force-stateful-recreation" listing.
 */
export function renderStatefulReason(reason: StatefulReason): string {
  switch (reason) {
    case 'always':
      return 'destroy loses all data in the resource';
    case 'has-objects':
      return 'S3 bucket is non-empty';
    case 'has-retention':
      return 'log group retains data (RetentionInDays > 0)';
    case null:
      return '(not stateful)';
  }
}
