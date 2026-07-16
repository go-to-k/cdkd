import type { S3StateBackend } from '../../state/s3-state-backend.js';

/**
 * Shared helpers for enumerating and describing cdkd state-bucket keys.
 *
 * Extracted from `bootstrap-destroy.ts` (issue #1010) so that `cdkd gc`
 * (issue #1012) reuses the exact same whole-bucket state-file discovery
 * instead of duplicating it — the "scan the WHOLE bucket, not just the
 * default `cdkd/` prefix" rule was a review blocker once already (PR #1018)
 * and must not drift between the two commands.
 */

/**
 * Every cdkd state file ends with this suffix, regardless of the
 * `--state-prefix` it was deployed under (`{prefix}/{stack}/{region}/state.json`,
 * or legacy `{prefix}/{stack}/state.json`).
 */
export const STATE_FILE_SUFFIX = '/state.json';

/**
 * Every cdkd stack lock ends with this suffix — the lock lives next to the
 * state file (`{prefix}/{stack}/{region}/lock.json`).
 */
export const LOCK_FILE_SUFFIX = '/lock.json';

/** `us-east-1` / `ap-northeast-1` / `us-gov-west-1` — a region-shaped segment. */
const REGION_SEGMENT = /^[a-z]{2}(-[a-z]+)+-\d+$/;

/**
 * List every state file in the bucket — the WHOLE bucket, not just the
 * default `cdkd/` prefix. Other commands accept `--state-prefix`, so live
 * stack state may exist under ANY prefix in this bucket; scoping this
 * listing to the default prefix would let reference scans and teardown
 * guards silently miss those stacks and delete live data.
 */
export async function listAllStateKeys(
  stateBackend: Pick<S3StateBackend, 'listRawKeys'>
): Promise<string[]> {
  const keys = await stateBackend.listRawKeys('');
  return keys.filter((k) => k.endsWith(STATE_FILE_SUFFIX));
}

/**
 * List every stack lock file in the bucket — same whole-bucket rule as
 * {@link listAllStateKeys}. A lock under ANY prefix means a deploy /
 * destroy may be in flight for that stack.
 */
export async function listAllLockKeys(
  stateBackend: Pick<S3StateBackend, 'listRawKeys'>
): Promise<string[]> {
  const keys = await stateBackend.listRawKeys('');
  return keys.filter((k) => k.endsWith(LOCK_FILE_SUFFIX));
}

/**
 * `{prefix}/{stack}/{region}/state.json` → `stack (region)`; legacy
 * `{prefix}/{stack}/state.json` → `stack`. The prefix is arbitrary (custom
 * `--state-prefix` values included), so the stack/region pair is derived
 * from the key's TAIL: the last segment is treated as a region only when
 * it is region-shaped. Pass {@link LOCK_FILE_SUFFIX} to describe lock keys.
 */
export function describeStateKey(key: string, suffix: string = STATE_FILE_SUFFIX): string {
  const segments = key.slice(0, -suffix.length).split('/');
  const last = segments[segments.length - 1] ?? key;
  const secondLast = segments[segments.length - 2];
  if (secondLast !== undefined && REGION_SEGMENT.test(last)) {
    return `${secondLast} (${last})`;
  }
  return last;
}
