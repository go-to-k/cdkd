import { CdkdError } from '../../utils/error-handler.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { markRedactedCause } from '../../deployment/retryable-errors.js';
import { safeMsg } from '../../utils/display-safe.js';

/** Minimal logger surface used here (avoids coupling to the full Logger type). */
export type InfoLogger = { info(message: string): void; debug(message: string): void };

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
  return finalSnapshotNameCut(physicalId, resourceType).prefix;
}

/**
 * {@link finalSnapshotNamePrefix} with what it was cut from: `sanitized` is
 * the whole sanitized physical id, and `kept` how many of its leading
 * characters the prefix carries. `kept < sanitized.length` only where the
 * per-service cap CUT the id (ElastiCache's 28 characters), so a value the id
 * spells across that point appears in the snapshot name as a fragment, which
 * no literal masker matches (go-to-k/cdkd#3869).
 */
export function finalSnapshotNameCut(
  physicalId: string,
  resourceType?: string
): { prefix: string; sanitized: string; kept: number } {
  // RDS-family snapshot identifiers allow up to 255 chars; ElastiCache
  // snapshot names follow the ~50-char cluster-naming rules — a longer name
  // makes the snapshot call reject and the delete fail mid-run.
  const maxLength =
    resourceType === 'AWS::ElastiCache::CacheCluster' ||
    resourceType === 'AWS::ElastiCache::ReplicationGroup'
      ? 50
      : 255;
  const sanitized = sanitizeSnapshotBase(physicalId);
  const base = sanitized
    .slice(0, maxLength - ('-final-'.length + FINAL_SNAPSHOT_TS_LENGTH))
    .replace(/-+$/, '');
  return { prefix: `${base}-final-`, sanitized, kept: base.length };
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

export const PRE_DELETE_SNAPSHOT_POLL_INTERVAL_MS = 5_000;
export const PRE_DELETE_SNAPSHOT_TIMEOUT_MS = 60 * 60 * 1_000;
/** Post-snapshot settle budget for a Redshift cluster before its delete. */
export const REDSHIFT_CLUSTER_SETTLE_TIMEOUT_MS = 20 * 60 * 1_000;

export function errMsg(error: unknown): string {
  // `.detail` IS `error instanceof Error ? error.message : String(error)`,
  // minus the throw: `String()` dies on a null-prototype object or a hostile
  // `toString`. That matters here because `createPreDeleteFinalSnapshot` is
  // called from `destroy-runner.ts` INSIDE the per-resource try, so a throw
  // from this helper replaces the snapshot failure with a `TypeError` before
  // anything records which resource was left un-snapshotted
  // (go-to-k/cdkd#3348; review found it after two passes had called the
  // destroy path complete without it).
  return describeAwsFailure(error).detail;
}

/**
 * The failure sentence a thrown `FINAL_SNAPSHOT_FAILED` message quotes
 * (go-to-k/cdkd#2319). A thrown message is persisted to
 * `deployments/{runId}.jsonl`, and an AWS `AccessDenied` names the caller's
 * assumed-role ARN, so an AWS-authored failure is its CLASS plus the
 * `--verbose` pointer, and AWS's own text goes to `debug` after `head`. A
 * cdkd-authored error keeps its text. Always ends its sentence.
 */
export function failureSentence(logger: InfoLogger, head: string, error: unknown): string {
  const failure = describeAwsFailure(error);
  if (!failure.redacted) return `${failure.detail}.`;
  logger.debug(safeMsg`${head}: ${failure.detail}`);
  return failure.summary;
}

/**
 * A `FINAL_SNAPSHOT_FAILED` refusal carrying `error` as its `cause`, stamped
 * `markRedactedCause` when AWS's text was withheld from the message, so the
 * retry classifiers read it on the chain instead.
 */
export function finalSnapshotFailure(message: string, error: unknown): CdkdError {
  const cause = error instanceof Error ? error : undefined;
  const thrown = new CdkdError(message, 'FINAL_SNAPSHOT_FAILED', cause);
  return cause !== undefined && describeAwsFailure(cause).redacted
    ? markRedactedCause(thrown)
    : thrown;
}
