import { ListObjectVersionsCommand, DeleteObjectsCommand, type S3Client } from '@aws-sdk/client-s3';
import { getLogger } from '../utils/logger.js';

/**
 * Delete the NONCURRENT versions of a KNOWN SET OF KEYS in the cdkd state
 * bucket (issue [#2340](https://github.com/go-to-k/cdkd/issues/2340)).
 *
 * ## Why this exists at all
 *
 * `cdkd bootstrap` turns VERSIONING ON for the state bucket, so `DeleteObject`
 * writes a DELETE MARKER and leaves every prior version readable through
 * `GetObject` with a `VersionId`. For an object whose body carried a secret,
 * a delete-only cleanup therefore reports success while the secret stays
 * retrievable by anyone holding `s3:GetObjectVersion`.
 *
 * ## Why it is a SHARED module and not a method
 *
 * Two independent paths delete custom-resource response objects — the
 * provider's own `cleanupResponseObject` and `cdkd gc`'s sweep of the
 * abandoned ones — and a copy in each is the failure this repo has shipped
 * before: the next lane fixes one spelling and the other keeps the defect.
 *
 * It is a LEAF module rather than a method on `S3StateBackend` because the
 * provider is one of the two callers, and `src/provisioning/**` has no runtime
 * edge to the state backend today (measured: the only `src/provisioning`
 * import of `s3-state-backend.js` is `nested-stack-context.ts`'s `import
 * type`). Adding one to share four lines would be a heavier change than the
 * sharing is worth; this module depends on nothing but the SDK and the logger.
 *
 * ## What it deliberately does NOT do
 *
 * It never sweeps a prefix wholesale, and it never touches what is CURRENT.
 * `CUSTOM_RESOURCE_RESPONSE_PREFIX` is a SHARED, TOP-LEVEL prefix that every
 * stack deploying into the region writes into, so a prefix-scoped purge would
 * take a concurrent deploy's live response object. Membership of `keys` plus
 * the `IsLatest` filter are what make it safe to run mid-flight, and both are
 * enforced here rather than at the call sites.
 *
 * It also NEVER THROWS. Both callers run it on a path that must not abort —
 * the provider's `finally` / timeout arms, and `gc` after a collection that
 * has already succeeded, whose `GC_DELETE_FAILED` identity must not be
 * borrowed by a purge failure. Making that a property of the MECHANISM rather
 * than of each call site is deliberate: a caller cannot forget it.
 *
 * ## Failures are counted in KEYS, and `DeleteObjects` failures COUNT
 *
 * `DeleteObjects` reports per-key failures (partial `AccessDenied`, Object
 * Lock, a `Deny` SCP, `SlowDown`) in `response.Errors` RATHER THAN THROWING —
 * and with `Quiet: true` the successes are omitted, so `Errors` is the only
 * signal there is. An earlier revision of this file discarded that response
 * entirely, which reproduced this issue's own defect with the warning
 * suppressed: a principal holding `s3:ListBucketVersions` but not
 * `s3:DeleteObjectVersion` — exactly the reader who adds one of the two doc
 * bullets and not the other — saw a clean run and kept every readable version.
 * The same JSDoc trap is documented on `S3StateBackend.deleteRawObjects`.
 *
 * The unit of the warning is therefore the KEY, not the listing prefix. An
 * earlier revision counted prefixes, so a `cdkd gc` run failing to purge 3000
 * keys reported `1 key(s)` and named the prefix.
 */
export interface NoncurrentVersionPurgeOptions {
  /**
   * Extra request fields merged into every S3 call — in practice the state
   * backend's `ExpectedBucketOwner`. Spread rather than named so a caller that
   * has no owner param (the provider) passes nothing and the field stays
   * absent rather than becoming an explicit `undefined`.
   */
  requestFields?: { ExpectedBucketOwner?: string };
  /**
   * ONE paginated walk of this prefix instead of one walk PER KEY. A cost
   * choice only: the safety filter is `keys` membership either way, so a
   * shared prefix returns other stacks' live objects and they are dropped.
   * `cdkd gc` passes it because its candidate list can run to thousands of
   * keys under one prefix; the provider has a single key and does not.
   */
  listPrefix?: string;
  /** Logger to warn through. Defaults to a module-scoped child. */
  logger?: { warn: (m: string) => void };
  /**
   * What the surviving versions CONTAIN, as a noun phrase, dropped into the
   * warning's parenthetical (issue
   * [#2346](https://github.com/go-to-k/cdkd/issues/2346)).
   *
   * This is per-CALLER rather than a fixed sentence because the warning names
   * the thing a reader has to go and inspect. Until #2346 the parenthetical was
   * hard-coded to the custom-resource response body, which was true while the
   * sidecar was the only caller and became FALSE the moment the rollback
   * journal, the bootstrap marker and the transient CFn template joined: a user
   * chasing a warning about "the handler's full response body, including
   * `Data`" would have been looking for an object that does not exist on those
   * paths. Widening the sentence into something vague enough to cover all four
   * was the other option and is worse — the caller knows exactly what it just
   * failed to purge, so it should say so.
   *
   * Only this clause varies. The ACTIONABLE half — the two IAM grants and the
   * purge-by-hand remedy — is correct at every call site and is not
   * parameterised.
   */
  objectDescription?: string;
}

/**
 * Parenthetical used when a caller names nothing.
 *
 * True of ANY object this function is pointed at, which is the bar for a
 * default here: a caller that forgets to describe its object must still emit a
 * warning that is correct, just less specific. It deliberately does not guess
 * at content.
 */
const DEFAULT_OBJECT_DESCRIPTION = 'the body of an object cdkd has just reported as removed';

/**
 * `objectDescription` for the custom-resource response sidecar.
 *
 * A SHARED CONSTANT rather than the same literal at both sites, for the reason
 * this whole module is shared: the provider's own `cleanupResponseObject` and
 * `cdkd gc`'s sweep of the abandoned placeholders delete the SAME object, so a
 * reader must not be able to tell from the warning which of the two produced
 * it. Two literals are how one of them drifts — and it is not hypothetical:
 * review probed it by editing `gc.ts`'s string alone and the suite stayed
 * green, because nothing tied the two together. One binding cannot drift, and
 * needs no test to say so.
 */
export const CUSTOM_RESOURCE_RESPONSE_OBJECT_DESCRIPTION =
  "a custom-resource response object, which is the handler's full cfn-response body including `Data`";

/**
 * `DeleteObjects` is capped at 1000 entries per call.
 *
 * DEFENCE IN DEPTH, and unreachable today: `stale` is accumulated from a
 * SINGLE `ListObjectVersions` page, whose `Versions` + `DeleteMarkers` are
 * capped at 1000 COMBINED by `MaxKeys`, so the chunking below never takes its
 * second iteration. It is kept because the invariant it guards ("never hand
 * DeleteObjects more than 1000") is one a future change accumulating across
 * pages would silently break.
 *
 * Mutation coverage of this constant is ASYMMETRIC, which is worth stating
 * because the obvious summary is wrong in one direction: RAISING it is green
 * (nothing ever reaches the second chunk, so a bigger ceiling changes
 * nothing), while LOWERING it to 500 is RED — the multi-page fixture's
 * thousand-entry pages then split and the asserted batch shape changes. So the
 * value is fenced from below and not from above.
 */
const DELETE_BATCH_SIZE = 1000;

/** How many failing keys the warning names before it truncates. */
const MAX_NAMED_FAILURES = 5;

/**
 * Label for a `DeleteObjects` error entry that carries no `Key`.
 *
 * S3 always populates it in practice; the point is that an unnameable failure
 * must still COUNT, because the alternative measured here was `failed.size`
 * reaching 0 and the whole warning disappearing.
 *
 * Each keyless entry gets its OWN slot (`<unknown key #1>`, `#2`, ...) rather
 * than sharing one. Collapsing them was defended as "the honest reading", but
 * it is honest about NAMING and not about COUNTING: N keyless failures then
 * reported `1 key(s)`, which is the same prefixes-not-keys under-count this
 * change was raised to fix, arriving through the branch that fixed it. One
 * slot per failure can over-count if S3 ever returns two entries for one
 * object, which is the direction that errs toward reporting too much.
 *
 * The slot name is SYNTHETIC and its uniqueness is not enforced: a real key
 * literally called `<unknown key #1>` would merge with the first keyless
 * entry and under-count by one. Unreachable here — every caller passes
 * `custom-resource-responses/<requestId>.json` — and stated rather than left
 * implied, because "the name cannot collide" is the kind of unstated
 * invariant this module exists to stop asserting.
 */
const UNKNOWN_KEY_PREFIX = '<unknown key #';

/** Reason recorded when a page says it is truncated but names no next key. */
const TRUNCATED_NO_MARKER =
  'listing reported IsTruncated with no NextKeyMarker; the walk stopped early ' +
  'and versions may remain';

/** Record a per-key failure reason without losing an earlier one. */
function recordFailure(failed: Map<string, string[]>, key: string, reason: string): void {
  const existing = failed.get(key);
  if (existing) existing.push(reason);
  else failed.set(key, [reason]);
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export async function purgeNoncurrentKeyVersions(
  s3Client: Pick<S3Client, 'send'>,
  bucket: string,
  keys: readonly string[],
  options: NoncurrentVersionPurgeOptions = {}
): Promise<void> {
  if (keys.length === 0) return;
  const logger = options.logger ?? getLogger().child('s3-version-purge');
  const requestFields = options.requestFields ?? {};

  // The safety filter, and the only thing standing between this and a sweep of
  // a prefix shared with every concurrent deploy in the region.
  const wanted = new Set(keys);
  // One walk per key, or one walk for the lot when the caller named a covering
  // prefix. Same loop body either way.
  const prefixes = options.listPrefix !== undefined ? [options.listPrefix] : keys;

  const failed = new Map<string, string[]>();
  // Hoisted OUT of `purgeUnderPrefix`, which runs once per prefix. Declared
  // inside it, the counter restarted at 0 on every walk, so in per-key mode
  // (`prefixes = keys`) two keyless entries on two different keys both wrote
  // `<unknown key #1>`, `recordFailure` appended to the same array, and
  // `failed.size` stayed 1 — reinstating the exact `1 key(s)` under-count the
  // slot scheme was introduced to remove.
  const unknown = { n: 0 };
  for (const prefix of prefixes) {
    try {
      await purgeUnderPrefix(s3Client, bucket, prefix, wanted, requestFields, failed, unknown);
    } catch (error) {
      // The LISTING failed, so nothing under this prefix could be purged. With
      // a covering `listPrefix` that is every requested key; without one the
      // prefix IS the key. Attributing it to the keys rather than to the
      // prefix is what keeps the warning's unit consistent.
      const affected = options.listPrefix !== undefined ? keys : [prefix];
      for (const key of affected) recordFailure(failed, key, describe(error));
    }
  }

  if (failed.size > 0) {
    const named = [...failed.entries()]
      .slice(0, MAX_NAMED_FAILURES)
      .map(([key, reasons]) => `${key} (${reasons.join('; ')})`);
    const elided = failed.size - named.length;
    // WARN rather than debug, and never a throw. What survives is the body of
    // an object cdkd has just reported as deleted; WHICH object is the
    // caller's to say (`objectDescription`), because the reader's next move is
    // to go and inspect it. A user whose custom-resource handler mints secrets
    // needs to know which grant would have removed them, and so does one whose
    // rollback journal recorded a failed write's properties.
    //
    // Kept at WARN on the provider's per-resource path too, where it can fire
    // once per custom-resource completion. A per-run dedupe was considered and
    // REJECTED: it needs module-global state, which this repo has been bitten
    // by under `--stack-concurrency > 1`, and the volume is bounded by the
    // number of custom resources in a stack. A security-relevant failure that
    // repeats is still a failure; silence is the defect class this file exists
    // to remove.
    logger.warn(
      `Could not purge noncurrent versions of ${failed.size} key(s) in s3://${bucket}. ` +
        `Their previous versions survive and remain readable via GetObject with a VersionId ` +
        `(${options.objectDescription ?? DEFAULT_OBJECT_DESCRIPTION}). ` +
        `Grant s3:ListBucketVersions and s3:DeleteObjectVersion on the ` +
        `state bucket, or purge the key(s) by hand. Failures: ${named.join(', ')}` +
        (elided > 0 ? ` (and ${elided} more)` : '')
    );
  }
}

/**
 * Paginate `ListObjectVersions` under one prefix and delete every returned
 * entry that is in `wanted` and is not the current version.
 *
 * Throws only when the LISTING fails; per-key delete failures are recorded in
 * `failed` and do not stop the walk.
 *
 * Safe on an UNVERSIONED bucket: S3 answers there with the single live object
 * carrying `VersionId: 'null'` and `IsLatest: true`, which the `IsLatest`
 * filter drops — so nothing is deleted and nothing throws. A `'null'` version
 * id is NOT filtered out on its own, because a bucket whose versioning was
 * SUSPENDED can carry a genuine noncurrent `'null'` version holding the body.
 */
async function purgeUnderPrefix(
  s3Client: Pick<S3Client, 'send'>,
  bucket: string,
  prefix: string,
  wanted: ReadonlySet<string>,
  requestFields: { ExpectedBucketOwner?: string },
  failed: Map<string, string[]>,
  /** Shared across ALL prefixes — see the call site for why it is not local. */
  unknown: { n: number }
): Promise<void> {
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;

  do {
    const resp = await s3Client.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        ...requestFields,
        // `Prefix` is a PREFIX and not an exact match — asking for `<key>`
        // also returns `<key>.bak` — so every returned entry is re-checked
        // against `wanted` below before anything is deleted.
        Prefix: prefix,
        ...(keyMarker !== undefined && { KeyMarker: keyMarker }),
        ...(versionIdMarker !== undefined && { VersionIdMarker: versionIdMarker }),
      })
    );

    const stale: { Key: string; VersionId: string }[] = [];
    for (const entry of [...(resp.Versions ?? []), ...(resp.DeleteMarkers ?? [])]) {
      if (entry.Key === undefined || !wanted.has(entry.Key)) continue;
      // `!== false`, not `=== true`: an entry with the field ABSENT must be
      // treated as possibly-current and left alone. Keying on `=== true` fails
      // OPEN — it would delete the CURRENT version of a key whose `IsLatest`
      // the response happened to omit.
      //
      // But skipping SILENTLY is the one direction this module exists to
      // forbid: the entry is in `wanted`, so it may be a body we were asked to
      // remove and did not. Unreachable against real S3, which always populates
      // the field — which is why it RECORDS rather than throws, and why the
      // reason says what was assumed. Recorded before the `VersionId` check
      // below, since an entry with neither field is the same non-removal.
      // REPORTS ONLY -- the skip itself is the `!== false` guard immediately
      // below, which already catches `undefined`. An earlier revision ended
      // this arm with its own `continue`, which was dead: removing it changed
      // no behaviour, while the comment on its test described it as a separate
      // mutation half. The two halves that ARE separate are this
      // `recordFailure` and the guard below.
      if (entry.IsLatest === undefined) {
        recordFailure(
          failed,
          entry.Key,
          `version ${entry.VersionId ?? '<unknown>'}: listing omitted IsLatest, so the entry was ` +
            `left alone rather than risk deleting a current version`
        );
      }
      if (entry.IsLatest !== false) continue;
      if (!entry.VersionId) continue;
      stale.push({ Key: entry.Key, VersionId: entry.VersionId });
    }

    for (let i = 0; i < stale.length; i += DELETE_BATCH_SIZE) {
      const batch = stale.slice(i, i + DELETE_BATCH_SIZE);
      try {
        const deleted = await s3Client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            ...requestFields,
            Delete: { Objects: batch, Quiet: true },
          })
        );
        // The load-bearing read. `Quiet: true` returns ONLY failures, so an
        // empty `Errors` is the success signal and a populated one is a
        // partial failure the call itself reported as overall success.
        for (const err of deleted.Errors ?? []) {
          // `NoSuchVersion` is the OUTCOME WE WANTED, reported as an error.
          // The version named is already gone, so the key is in exactly the
          // state this function exists to produce, and counting it as a
          // failure tells a blameless user to grant IAM they already hold.
          //
          // It is reachable rather than theoretical since issue #2346 site 5
          // put a purge on the LOCK key: two actors legitimately purge the
          // same lock concurrently -- a reaper taking over an expired lock and
          // the original owner waking up to release it -- and whichever loses
          // the race sees this code for rows the winner has already removed.
          // Deliberately NOT widened to `NoSuchKey` or to a general
          // 404-shaped bucket: those say the LISTING and the delete disagree
          // about the key itself, which is a different claim and one worth a
          // warning.
          //
          // What makes the carve-out safe rather than merely convenient is
          // that every `(Key, VersionId)` handed to `DeleteObjects` came from
          // the `ListObjectVersions` walk directly above -- this function never
          // synthesises an id. So `NoSuchVersion` cannot mean "we asked about
          // the wrong object"; it can only mean the row we listed stopped
          // existing between the listing and the delete, which is the state we
          // were trying to reach.
          if (err.Code === 'NoSuchVersion') continue;
          const reason =
            `version ${err.VersionId ?? '<unknown>'}: ${err.Code ?? 'Error'}` +
            (err.Message ? ` - ${err.Message}` : '');
          // A `Key`-less entry is bucketed under UNKNOWN_KEY rather than
          // skipped. Skipping it made `failed.size` 0 when EVERY entry was
          // keyless, so a `DeleteObjects` failure came back as a clean run
          // with no warning at all — this round's own blocker, reintroduced
          // inside the branch that fixed it. The count is then "keys we could
          // not purge" including the one we cannot name, which is the honest
          // reading.
          if (err.Key !== undefined) {
            recordFailure(failed, err.Key, reason);
          } else {
            unknown.n += 1;
            recordFailure(failed, `${UNKNOWN_KEY_PREFIX}${unknown.n}>`, reason);
          }
        }
      } catch (error) {
        // A throw takes out the whole batch, so every key in it is unpurged.
        for (const object of batch) recordFailure(failed, object.Key, describe(error));
      }
    }

    // Keyed on `NextKeyMarker` ALONE. Keying on "either marker present" spins
    // forever on a page that reports `IsTruncated: true` with no
    // `NextKeyMarker`: the next request omits the key marker, S3 ignores a
    // lone `VersionIdMarker`, and the same page comes back — an unkillable
    // hang on a path documented as never aborting. (boto3's paginator keys on
    // `IsTruncated` and feeds both tokens; `@aws-sdk/client-s3` ships no
    // `ListObjectVersions` paginator at all, so there is no JS authority to
    // cite here — this is a deliberate choice, not a convention.)
    if (resp.IsTruncated === true && resp.NextKeyMarker === undefined) {
      // Stopping here is correct — continuing cannot make progress — but
      // stopping SILENTLY trades a hang for an unreported partial purge, in
      // the one file whose whole premise is that a quiet failure is the bug.
      //
      // Blamed on the keys UNDER THIS PREFIX only. `wanted` is the full
      // requested set, so warning about all of it would name keys whose own
      // walks completed — over-warning, and a comment describing something the
      // code did not do.
      //
      // It still OVER-NAMES in two ways, both toward reporting too much, which
      // is the safe direction; they are listed because an unstated residual is
      // this file's own subject. (1) Keys already purged on an EARLIER page of
      // this same walk are named again — nothing here records which those
      // were. (2) `startsWith` is a PREFIX test, not equality, so even in
      // per-key mode a sibling key that merely extends this one is caught:
      // walking `<k>` while `<k>.bak` was also requested names `<k>.bak` too,
      // although its own walk completed. An earlier revision of this comment
      // claimed the filter "selects exactly it" in per-key mode; measured
      // against `[KEY_A, KEY_A + '.bak']`, it does not.
      for (const key of wanted) {
        if (key.startsWith(prefix)) recordFailure(failed, key, TRUNCATED_NO_MARKER);
      }
    }
    keyMarker = resp.IsTruncated === true ? resp.NextKeyMarker : undefined;
    versionIdMarker = keyMarker !== undefined ? resp.NextVersionIdMarker : undefined;
  } while (keyMarker !== undefined);
}
