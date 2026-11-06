import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { isAmbiguousOutcomeError } from '../../../deployment/retryable-errors.js';
import type { S3StateBackend } from '../../../state/s3-state-backend.js';
// An export NAME is a template-controlled RESOLVED value and an index read's
// error message interpolates a bucket / key, so both reach the terminal only
// through the same control-byte strip `export-index-store.ts` uses for the
// name it logs.
import { displayStackName, safeMsg } from '../../../utils/display-safe.js';
import type { StackState } from '../../../types/state.js';
import { ScrubRefusalError } from './errors.js';

/**
 * What the superseded `state.json` versions scrub purges may hold, for the
 * purge's own warnings (go-to-k/cdkd#2624).
 */
export const SCRUBBED_STATE_OBJECT_DESCRIPTION =
  "the stack's earlier state.json versions, which may hold a plaintext secret";

/** The same, for the region's shared exports index. */
export const SCRUBBED_EXPORT_INDEX_OBJECT_DESCRIPTION =
  "the region's pre-scrub exports index, which may hold the plaintext secret scrub rewrote";

/**
 * `S3StateBackend`'s `getStateKey`, which is private. A unit test pins the two
 * together, so a change to the layout fails there rather than purging a key
 * nothing writes.
 */
export function scrubbedStateKey(backend: S3StateBackend, stackName: string, region: string) {
  return `${backend.prefix}/${stackName}/${region}/state.json`;
}

/**
 * `S3StateBackend`'s `getLegacyStateKey` (the pre-region layout), pinned the
 * same way. A record `getState` loaded from it (`migrationPending`) is saved to
 * the region-scoped key and the legacy key is deleted, which on a versioned
 * bucket leaves its plaintext body behind as a noncurrent version.
 */
export function scrubbedLegacyStateKey(backend: S3StateBackend, stackName: string) {
  return `${backend.prefix}/${stackName}/state.json`;
}

/**
 * Every key whose history a scrub of this record purges: the region-scoped key,
 * plus the legacy key when the record was loaded from it.
 */
export function stateHistoryKeys(
  backend: S3StateBackend,
  stackName: string,
  region: string,
  migrationPending: boolean | undefined
): string[] {
  return [
    scrubbedStateKey(backend, stackName, region),
    ...(migrationPending ? [scrubbedLegacyStateKey(backend, stackName)] : []),
  ];
}

/** `ExportIndexStore`'s `indexKey`, pinned the same way. */
export function scrubbedExportIndexKey(backend: S3StateBackend, region: string) {
  return `${backend.prefix}/_index/${region}/exports.json`;
}

/**
 * Did the AWS SDK retry the request that ended in `err`? It stamps
 * `$metadata.attempts` on the error it finally throws; any link of the cause
 * chain counts, since `saveState` wraps the SDK error.
 */
function wasRetriedBySdk(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && typeof current === 'object' && current !== null; depth++) {
    const attempts = (current as { $metadata?: { attempts?: unknown } }).$metadata?.attempts;
    if (typeof attempts === 'number' && attempts > 1) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Every `cdkd scrub` write of a `state.json` (go-to-k/cdkd#2624, site 1).
 *
 * Saves the scrubbed record, then purges the key's NONCURRENT versions: on a
 * versioned state bucket the PUT only supersedes the pre-scrub body, which stays
 * readable with `GetObject` and a `VersionId`, and removing the plaintext is
 * this command's whole purpose. The maintainer's decision on that issue is to
 * purge here and NOT on a deploy's implicit scrub, where those versions stay
 * the state-recovery capability.
 *
 * The purge runs in a `finally` once the PUT MAY have landed: after a save
 * that succeeded, and after one that failed AMBIGUOUSLY (a 5xx, a timeout or a
 * dropped socket: `isAmbiguousOutcomeError`), since the plaintext body may be
 * noncurrent already. So does any failure the SDK reached after RETRYING
 * (`$metadata.attempts > 1`): an attempt that committed but answered with a
 * 5xx or a reset is retried with the same `IfMatch`, and the retry's 412 is
 * all the classifier sees. Only a DEFINITE refusal on the FIRST attempt
 * (PreconditionFailed, an AccessDenied) proves nothing was written, so that
 * record keeps its recovery history, as every record scrub does not rewrite. It removes only
 * entries with `IsLatest === false`, so the current record is never touched.
 * It never throws and warns for itself (missing `s3:ListBucketVersions` /
 * `s3:DeleteObjectVersion`, a replicated bucket), so those warnings print
 * before the summary line and the save's own outcome is what reaches the
 * caller. On an unversioned bucket the listing holds only the current version,
 * so it deletes nothing. Callers hold the stack lock, and never call this
 * under `--dry-run`.
 */
export async function saveScrubbedState(
  stateBackend: S3StateBackend,
  stackName: string,
  region: string,
  state: StackState,
  loaded: { etag: string; migrationPending?: boolean | undefined }
): Promise<void> {
  let mayHaveWritten = false;
  try {
    // A LEGACY-layout record (`migrationPending`) is migrated the way every
    // other state writer migrates it (`state.ts`, `orphan.ts`, `drift.ts`):
    // its etag belongs to the legacy key, so an `IfMatch` on the new key could
    // only fail, and the legacy key — the one holding the plaintext — is
    // deleted once the new key is written.
    try {
      await stateBackend.saveState(stackName, region, state, {
        expectedEtag: loaded.etag,
        ...(loaded.migrationPending && { migrateLegacy: true }),
      });
    } catch (err) {
      mayHaveWritten = isAmbiguousOutcomeError(err) || wasRetriedBySdk(err);
      throw err;
    }
    mayHaveWritten = true;
    // `saveState`'s legacy delete is best-effort and only warns. Here a
    // surviving legacy key still holds the pre-scrub plaintext as its CURRENT
    // object, readable with no VersionId, while every later `getState` reads
    // the clean new key, so `--dry-run --fail` would go green over it. Checked,
    // and raised as this stack's failure, rather than left to that warning.
    if (loaded.migrationPending) {
      const legacyKey = scrubbedLegacyStateKey(stateBackend, stackName);
      let survives: boolean;
      try {
        survives = (await stateBackend.getRawObject(legacyKey)) !== null;
      } catch (err) {
        // The write LANDED, so a re-run reads the clean region-scoped key and
        // never looks at the legacy one again: an unverified check has to be
        // reported now, as this stack's failure, and say what to check.
        throw new ScrubRefusalError(
          safeMsg`${displayStackName(stackName)} was rewritten to the region-scoped state key, ` +
            safeMsg`but whether its legacy key ${legacyKey} still holds the pre-scrub record ` +
            safeMsg`could not be verified (${describeAwsFailure(err).detail}). ` +
            `Check that key yourself and, if it exists, delete it (aws s3api delete-object ` +
            `--bucket <state-bucket> --key <that key>), then purge its earlier versions as ` +
            `https://cdkd.dev/cli-scrub/#what-a-real-run-removes-and-what-it-cannot describes. A re-run will not check it again.`,
          'SCRUB_LEGACY_STATE_KEY_UNVERIFIED'
        );
      }
      if (survives) {
        throw new ScrubRefusalError(
          safeMsg`${displayStackName(stackName)} was rewritten to the region-scoped state key, ` +
            safeMsg`but its legacy key ${legacyKey} could not be deleted and still holds the ` +
            `pre-scrub record as its CURRENT object. Delete it (aws s3api delete-object ` +
            `--bucket <state-bucket> --key <that key>), then purge its earlier versions as ` +
            `https://cdkd.dev/cli-scrub/#what-a-real-run-removes-and-what-it-cannot describes.`,
          'SCRUB_LEGACY_STATE_KEY_SURVIVES'
        );
      }
    }
  } finally {
    if (mayHaveWritten) {
      await stateBackend.purgeNoncurrentVersions(
        stateHistoryKeys(stateBackend, stackName, region, loaded.migrationPending),
        { objectDescription: SCRUBBED_STATE_OBJECT_DESCRIPTION }
      );
    }
  }
}

/**
 * What every no-finding line is a claim ABOUT (go-to-k/cdkd#2868). Scrub learns
 * a secret's value only by resolving a `{{resolve:...}}` reference the template
 * spells, so a plaintext the template never references -- a value an operator
 * set out of band, recorded by design in the `observedProperties` drift
 * baseline -- is invisible to it, and an unscoped "No plaintext secrets found"
 * reads as a clean bill for the whole record. Appended right after the subject
 * of each such line, so the existing `No plaintext secrets found in <stack>`
 * prefix the integ fixtures grep for is unchanged.
 */
export const SCRUB_CLEAN_SCOPE_NOTE =
  ' (scrub checks only values the template names through a {{resolve:...}} reference)';
