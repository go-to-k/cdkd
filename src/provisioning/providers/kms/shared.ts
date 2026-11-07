import { AmbiguousCreateLatch, RecentIdSet } from '../ambiguous-create.js';

/**
 * Retry-safety state for `CreateKey`, which has no idempotency token and
 * whose key has no name (issue [#2080](https://github.com/go-to-k/cdkd/issues/2080)).
 * Module-scoped rather than on the provider: a provider instance is per
 * registry, and one process can build several.
 */
export const createKeyLatch = new AmbiguousCreateLatch('CreateKey');
/** Keys this process created and recorded, never offered as orphan candidates. */
export const keysCreatedByThisProcess = new RecentIdSet();
/**
 * A key whose `CreateKey` SUCCEEDED but whose create then failed in a
 * follow-up call (`EnableKeyRotation`, `DisableKey`), keyed by
 * `createAttemptKey('CreateKey', logicalId)`. The retry resumes it -- its id
 * came back in our own response, so the attribution is exact -- instead of
 * minting a second key and orphaning this one. `inputDigest` binds it to the
 * `CreateKey` input that made it: a later create of the same logical id with
 * different inputs (a rollback replay of an older record) must not inherit it.
 */
export const pendingKeys = new Map<
  string,
  { keyId: string; keyArn: string; inputDigest: string; heldAtMs: number }
>();

/**
 * go-to-k/cdkd#4945: attempt keys whose held key a retry DECLINED (and named
 * in a warning). The next key `CreateKey` makes for that attempt key replaces
 * it, so its error is stamped `markSupersedesEarlierCreate` even when the
 * declining attempt's own `CreateKey` failed first. Consumed by that key, and
 * aged out like `pendingKeys` (`AMBIGUOUS_LATCH_TTL_MS`).
 */
export const supersededAttempts = new Map<string, number>();

/** Key states a resumed key may be in. `PendingImport` is an `EXTERNAL`-origin key's normal state before material is imported. */
export const RESUMABLE_KEY_STATES: ReadonlySet<string> = new Set([
  'Enabled',
  'Disabled',
  'PendingImport',
]);

/**
 * Most `DescribeKey` calls one orphan lookup makes. `ListKeys` carries no
 * creation date, so each candidate costs a call; the lookup runs only after an
 * AMBIGUOUS `CreateKey` failure, and says so when this cap cut it short.
 */
export const MAX_ORPHAN_DESCRIBES = 200;

/** Page ceiling for the `ListKeys` sweep (1000 keys a page). */
export const MAX_LIST_KEYS_PAGES = 20;

/** Most key ids one orphan report names. */
export const MAX_REPORTED_ORPHANS = 5;

/** Reset the module-scoped retry-safety state. TEST-ONLY. */
export function resetKmsCreateRetryStateForTests(): void {
  createKeyLatch.resetForTests();
  keysCreatedByThisProcess.resetForTests();
  pendingKeys.clear();
  supersededAttempts.clear();
}

/**
 * A template boolean as CloudFormation reads it: `true` / `'true'` is true,
 * `false` / `'false'` is false (a String parameter's Ref arrives as a
 * string), absent stays absent. Anything else is truthiness, as before.
 */
export function templateBool(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return Boolean(value);
}
