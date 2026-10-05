import { ListObjectVersionsCommand, DeleteObjectsCommand, type S3Client } from '@aws-sdk/client-s3';
import { getLogger } from '../utils/logger.js';
import { displaySafe, safeMsg } from '../utils/display-safe.js';
import { LISTING_ENCODING_TYPE, decodeListingKey } from '../utils/s3-listing-keys.js';
import {
  warnIfPurgeIsReplicated,
  DEFAULT_PURGED_OBJECT_DESCRIPTION,
} from './s3-replication-purge-gap.js';

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
 * provider is one of its callers, and `src/provisioning/**` has no runtime
 * edge to the state backend today (measured: the only `src/provisioning`
 * import of `s3-state-backend.js` is `nested-stack-context.ts`'s `import
 * type`). Adding one to share four lines would be a heavier change than the
 * sharing is worth; this module depends on nothing but the SDK and the logger.
 *
 * ## What it deliberately does NOT do
 *
 * {@link purgeNoncurrentKeyVersions} never sweeps a prefix wholesale, and
 * nothing here touches what is CURRENT. `CUSTOM_RESOURCE_RESPONSE_PREFIX` is a
 * SHARED, TOP-LEVEL prefix that every stack deploying into the region writes
 * into, so a prefix-scoped purge would take a concurrent deploy's live
 * response object. Membership of `keys` plus the `IsLatest` filter are what
 * make it safe to run mid-flight, and both are enforced here rather than at
 * the call sites.
 *
 * The one wholesale sweep is {@link purgeNoncurrentVersionsUnderPrefix}, for a
 * prefix ONE owner empties as a whole (a stack's own `deployments/` directory
 * on `cdkd events prune --all`, issue
 * [#2624](https://github.com/go-to-k/cdkd/issues/2624)). It reaches what a key
 * list cannot name: a key already behind a delete marker is absent from an
 * ordinary listing, so its versions are invisible to every caller of the
 * key-set form. It keeps the `IsLatest` filter, and it refuses a prefix that
 * does not end in `/`, so `cdkd/S/` can never take `cdkd/S2/`.
 *
 * It also NEVER THROWS. Its callers run it on paths that must not abort —
 * for example the provider's `finally` / timeout arms, and `gc` after a collection that
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
 *
 * ## What this CANNOT reach: S3 REPLICATION (issue [#2447](https://github.com/go-to-k/cdkd/issues/2447))
 *
 * A successful purge here removes the bodies from ONE bucket. If the state
 * bucket has Cross-Region or Same-Region Replication enabled, the destination
 * bucket keeps its own copies and this function cannot touch them: **S3 never
 * replicates a delete that names a `VersionId`** (delete MARKERS are
 * replicable and opt-in; version-id deletes are not, deliberately, so a delete
 * on the source cannot destroy data on the destination). Nothing this module
 * could send would change that, short of cdkd discovering the replication
 * configuration and issuing cross-BUCKET deletes — a much larger and more
 * dangerous capability than the one this file has.
 *
 * So on a replicated bucket the mechanism reproduces its own defect one bucket
 * over: a clean run, no warning, and the secret still readable by `VersionId`.
 * That is why {@link ./s3-replication-purge-gap.js | the replication probe}
 * runs at the end of a purge that removed a BODY (never a bare delete marker,
 * which carries none) — or that could not settle whether there was one — and
 * says so. It is a DETECTOR, not a fix — the remedy is the user's, and the point is that
 * they learn it exists.
 *
 * TWO KNOWN RESIDUALS, stated rather than implied. (1) The check is scoped to
 * keys with a noncurrent BODY to remove, plus keys whose provenance the walk
 * could not settle, so a key whose CURRENT-version delete
 * failed (nothing is noncurrent yet) gets no replication note; the body then
 * survives in the SOURCE too and the caller's own delete failure is what the
 * user is looking at, so there is no false reassurance to remove. (2) A
 * replication rule DELETED after it had already copied things reads as "no
 * configuration" and is silent — the same argument that keeps a `Disabled`
 * rule reported does not reach it, because nothing is left to read.
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
  /**
   * Logger to warn through. Defaults to a module-scoped child.
   *
   * `debug` is OPTIONAL because the seam exists for callers that supply a bare
   * `warn` sink to demote this module's output (`lock-manager.ts` does exactly
   * that on the ordinary release path). A caller that has a real logger gets
   * its diagnostics; one that does not falls back to a module-scoped child.
   */
  logger?: { warn: (m: string) => void; debug?: (m: string) => void };
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

/**
 * One `ListObjectVersions` entry, in the shape both `Versions` and
 * `DeleteMarkers` share for the fields this module reads.
 */
interface VersionEntry {
  // `| undefined` spelled out because `exactOptionalPropertyTypes` is on and
  // the SDK models these as explicitly-undefinable optionals.
  Key?: string | undefined;
  VersionId?: string | undefined;
  IsLatest?: boolean | undefined;
}

/** Record a per-key failure reason without losing an earlier one. */
function recordFailure(failed: Map<string, string[]>, key: string, reason: string): void {
  const existing = failed.get(key);
  if (existing) existing.push(reason);
  else failed.set(key, [reason]);
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Which listed entries a walk may delete, and whom an incomplete walk blames.
 * The two scopes are {@link purgeNoncurrentKeyVersions}' key set and
 * {@link purgeNoncurrentVersionsUnderPrefix}'s whole prefix.
 */
interface PurgeScope {
  /** Whether a DECODED listing key may have its noncurrent entries deleted. */
  covers(key: string): boolean;
  /**
   * Reporting handles for what a walk of `prefix` that failed or stopped early
   * left unsettled. Real keys in the key-set scope; one handle that STARTS
   * WITH the prefix in the prefix scope, so the replication check's
   * `startsWith(rule.prefix)` still matches a rule covering it.
   */
  unsettledUnder(prefix: string): string[];
  /**
   * Whether EVERY entry the listing returns is in scope. True for the prefix
   * scope: an entry whose key cannot be decoded is then a version the walk
   * was asked to remove and did not, so it is a FAILURE, not only a
   * replication-check note. The key-set scope cannot tell it from a
   * neighbouring key and leaves it out of the failure count.
   */
  readonly ownsEveryListedKey: boolean;
}

/** Marks the one reporting handle a prefix-wide walk uses for its whole prefix. */
const PREFIX_HANDLE_SUFFIX = '* (every key under this prefix)';

/**
 * What a prefix-wide purge did, so a caller can tell "removed N earlier
 * versions" from "found none" (a mistyped region sweeps an empty prefix and
 * must not read as a purge).
 */
export interface PrefixPurgeResult {
  /**
   * Noncurrent BODY versions this call deleted. Delete markers are removed
   * too but never counted: they hold nothing, and `--all` writes one for an
   * absent index key on every run.
   */
  deletedBodies: number;
  /** False when any failure was recorded, so a warning has already printed. */
  complete: boolean;
}

/**
 * Delete the noncurrent versions of EVERY key under `prefix` (issue
 * [#2624](https://github.com/go-to-k/cdkd/issues/2624)).
 *
 * For a prefix one owner empties as a whole, where a key list cannot name
 * everything: a key already behind a delete marker is missing from an
 * ordinary listing, yet its earlier versions stay readable. Today's one
 * caller is a stack's own `{prefix}/{stack}/{region}/deployments/` directory
 * on `cdkd events prune --all` / `cdkd destroy --purge-events`.
 *
 * Same guarantees as {@link purgeNoncurrentKeyVersions}: never throws, never
 * deletes an entry whose `IsLatest` is not `false` (so a concurrent writer's
 * CURRENT object survives), and warns rather than failing.
 *
 * `prefix` MUST end in `/`. S3's `Prefix` is a string prefix, so
 * `cdkd/S/us-east-1/deployments` would also list a sibling
 * `cdkd/S/us-east-1/deployments-old/`, and a stack-level `cdkd/S` would list
 * stack `S2`. Anything else is refused with a warning and nothing is listed.
 * A listing failure is reported as ONE handle for the whole prefix, since a
 * listing that never returned cannot say how many keys it held.
 */
export async function purgeNoncurrentVersionsUnderPrefix(
  s3Client: Pick<S3Client, 'send'>,
  bucket: string,
  prefix: string,
  options: Omit<NoncurrentVersionPurgeOptions, 'listPrefix'> = {}
): Promise<PrefixPurgeResult> {
  const logger = options.logger ?? getLogger().child('s3-version-purge');
  if (!prefix.endsWith('/') || prefix.replace(/\/+/g, '') === '') {
    // JSON-quoted so an empty prefix still shows as `""`; `safeMsg` keeps the
    // value on one line.
    logger.warn(
      safeMsg`Refused to purge noncurrent versions under ${JSON.stringify(prefix)}: ` +
        `a prefix-wide purge needs a non-empty prefix ending in '/'. Nothing was purged.`
    );
    return { deletedBodies: 0, complete: false };
  }
  const handle = `${prefix}${PREFIX_HANDLE_SUFFIX}`;
  return purgeWalk(s3Client, bucket, [prefix], {
    scope: {
      covers: (key) => key.startsWith(prefix),
      unsettledUnder: () => [handle],
      ownsEveryListedKey: true,
    },
    listingFailureHandles: () => [handle],
    options: { ...options, logger },
  });
}

export async function purgeNoncurrentKeyVersions(
  s3Client: Pick<S3Client, 'send'>,
  bucket: string,
  keys: readonly string[],
  options: NoncurrentVersionPurgeOptions = {}
): Promise<void> {
  if (keys.length === 0) return;
  // The safety filter, and the only thing standing between this and a sweep of
  // a prefix shared with every concurrent deploy in the region.
  const wanted = new Set(keys);
  // One walk per key, or one walk for the lot when the caller named a covering
  // prefix. Same loop body either way.
  const prefixes = options.listPrefix !== undefined ? [options.listPrefix] : keys;
  await purgeWalk(s3Client, bucket, prefixes, {
    scope: {
      covers: (key) => wanted.has(key),
      // `startsWith` over-reach is deliberate and documented at the truncation
      // arm in `purgeUnderPrefix`.
      unsettledUnder: (prefix) => [...wanted].filter((key) => key.startsWith(prefix)),
      ownsEveryListedKey: false,
    },
    // The LISTING failed, so nothing under this prefix could be purged. With
    // a covering `listPrefix` that is every requested key; without one the
    // prefix IS the key. Attributing it to the keys rather than to the
    // prefix is what keeps the warning's unit consistent.
    listingFailureHandles: (prefix) => (options.listPrefix !== undefined ? [...keys] : [prefix]),
    options,
  });
}

/** The walk, failure accounting and warnings both public entry points share. */
async function purgeWalk(
  s3Client: Pick<S3Client, 'send'>,
  bucket: string,
  prefixes: readonly string[],
  params: {
    scope: PurgeScope;
    listingFailureHandles: (prefix: string) => string[];
    options: NoncurrentVersionPurgeOptions;
  }
): Promise<PrefixPurgeResult> {
  const { scope, listingFailureHandles, options } = params;
  const logger = options.logger ?? getLogger().child('s3-version-purge');
  const requestFields = options.requestFields ?? {};

  const failed = new Map<string, string[]>();
  // Hoisted OUT of `purgeUnderPrefix`, which runs once per prefix. Declared
  // inside it, the counter restarted at 0 on every walk, so in per-key mode
  // (`prefixes = keys`) two keyless entries on two different keys both wrote
  // `<unknown key #1>`, `recordFailure` appended to the same array, and
  // `failed.size` stayed 1 — reinstating the exact `1 key(s)` under-count the
  // slot scheme was introduced to remove.
  const unknown = { n: 0 };
  // Keys for which the walk found at least one noncurrent entry WITH A BODY
  // (`Versions`, never `DeleteMarkers`) and tried to remove it. Only these plus
  // the ones we could not settle are handed to the replication check; see its
  // call below for why, and `purgeUnderPrefix` for why a delete marker does not
  // count.
  const purged = new Set<string>();
  // Keys we could NOT settle, restricted the same way: a failure on a row that
  // was only ever a delete marker says nothing about a surviving body, while a
  // failure whose provenance is genuinely unknown (the listing never returned)
  // is included because over-warning is the safe direction there.
  const unsettledBodies = new Set<string>();
  // BODY versions a `DeleteObjects` call confirmed removed (not reported in
  // `Errors`, not in a thrown batch). Delete markers are never counted, and
  // neither is `NoSuchVersion`: this call did not remove that entry.
  const removed = { n: 0 };
  for (const prefix of prefixes) {
    try {
      await purgeUnderPrefix(
        s3Client,
        bucket,
        prefix,
        scope,
        requestFields,
        failed,
        unknown,
        purged,
        unsettledBodies,
        removed
      );
    } catch (error) {
      for (const key of listingFailureHandles(prefix)) {
        recordFailure(failed, key, describe(error));
        // Provenance genuinely UNKNOWN here -- the listing never returned, so
        // we cannot say whether the key had a body. Over-warning is the safe
        // direction, and the purge-failure warning always accompanies it.
        // Unconditional: every handle is a requested key, or the swept prefix
        // itself, so a scope guard here could never be false and would read
        // as though an out-of-scope case existed.
        unsettledBodies.add(key);
      }
    }
  }

  if (failed.size > 0) {
    const named = [...failed.entries()]
      .slice(0, MAX_NAMED_FAILURES)
      // Sanitized WHOLE, key and reasons alike. The key embeds a stack name and
      // a region that reached cdkd from an S3 listing or a lock body; the
      // reasons carry AWS-supplied text (`err.Message`, the SDK's error string,
      // a `VersionId`). Neither is cdkd-authored, both end up on a terminal, and
      // sanitizing only the key would leave half of this line raw while a
      // comment claimed it was covered. `lock-manager.ts` already sanitizes the
      // key at its own call site; without this the shared helper's warning was
      // the one raw path, and issue #2346 site 5 made it newly reachable at
      // `warn` on the force-unlock and takeover arms.
      .map(([key, reasons]) => displaySafe(`${key} (${reasons.join('; ')})`));
    const elided = failed.size - named.length;
    // A prefix handle stands for every key under a prefix whose listing never
    // completed, so it is counted as a prefix, never as one key.
    const prefixCount = [...failed.keys()].filter((k) => k.endsWith(PREFIX_HANDLE_SUFFIX)).length;
    const keyCount = failed.size - prefixCount;
    const subject = [
      keyCount > 0 ? `${keyCount} key(s)` : '',
      prefixCount > 0 ? `every key under ${prefixCount} prefix(es)` : '',
    ]
      .filter((part) => part !== '')
      .join(' and ');
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
      // `bucket` sanitized like the keys beside it. It is cdkd-authored in
      // every shipped path, so this is defence rather than a fix -- but the
      // line already renders attacker-influenced key names through
      // `displaySafe`, and one raw interpolation in a string whose other half
      // is sanitized is the mixed-rendering shape that lets an escape fire
      // from the unsanitized occurrence. `asciiOnly` because an S3 bucket name
      // has a known ASCII charset.
      `Could not purge noncurrent versions of ${subject} in ` +
        `s3://${displaySafe(bucket, { asciiOnly: true })}. ` +
        `Their previous versions survive and remain readable via GetObject with a VersionId ` +
        `(${options.objectDescription ?? DEFAULT_PURGED_OBJECT_DESCRIPTION}). ` +
        `Grant s3:ListBucketVersions and s3:DeleteObjectVersion on the ` +
        `state bucket, or purge the key(s) by hand. Failures: ${named.join(', ')}` +
        (elided > 0 ? ` (and ${elided} more)` : '')
    );
  }

  // LAST, and it is not a failure report — it is the caveat on the SUCCESS,
  // which is the case the user is misled by: a run with no failures is exactly
  // the one that says "the body is gone". Runs after the failure warning so
  // the two read in that order, and it is handed the caller's own sink and
  // `objectDescription` so it inherits both the demotion the lock release path
  // applies and the "which object?" answer.
  //
  // SCOPED to the keys that actually had a body, which an earlier revision got
  // wrong in the direction that matters. It ran on `keys` unconditionally, and
  // `deleteRollbackJournal` fires on EVERY successful deploy — so a routine
  // green deploy of a stack that has never failed announced that the rollback
  // journal's copies "survive and remain readable" in the replica, about an
  // object that had never existed in either bucket. A warning that is
  // sometimes about nothing is how the one that matters stops being read.
  //
  // `unsettledBodies` joins it because a key we could not settle is one we do
  // not know about, and over-warning is the safe direction. It is built from
  // real keys only, so the synthetic `<unknown key #N>` slots in `failed` --
  // which are not keys and would match a whole-bucket rule on their own --
  // cannot reach the check by construction rather than by a filter. When
  // nothing was purged and nothing failed there is no probe at all, so the
  // common case also stops paying for the API call.
  const replicationKeys = [...new Set([...purged, ...unsettledBodies])];
  await warnIfPurgeIsReplicated(s3Client, bucket, replicationKeys, {
    requestFields,
    logger,
    ...(options.objectDescription !== undefined && {
      objectDescription: options.objectDescription,
    }),
  });
  return { deletedBodies: removed.n, complete: failed.size === 0 };
}

/**
 * Paginate `ListObjectVersions` under one prefix and delete every returned
 * entry that `scope` covers and is not the current version.
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
  scope: PurgeScope,
  requestFields: { ExpectedBucketOwner?: string },
  failed: Map<string, string[]>,
  /** Shared across ALL prefixes — see the call site for why it is not local. */
  unknown: { n: number },
  /** Keys that had at least one noncurrent BODY (never a bare delete marker). */
  purged: Set<string>,
  /** Keys with a body-bearing or unknown-provenance failure. */
  unsettledBodies: Set<string>,
  /** Count of entries a delete confirmed removed, shared across prefixes. */
  removed: { n: number }
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
        // against `scope` below before anything is deleted.
        Prefix: prefix,
        // Issue go-to-k/cdkd#3313: without this the XML round-trip turns a
        // CARRIAGE RETURN in a key into a LINE FEED, `scope.covers` then misses
        // the entry, and it is silently skipped — recorded in neither `purged`
        // nor `unsettledBodies`, so a version carrying a secret plaintext
        // survives a sweep that reports success.
        EncodingType: LISTING_ENCODING_TYPE,
        ...(keyMarker !== undefined && { KeyMarker: keyMarker }),
        ...(versionIdMarker !== undefined && { VersionIdMarker: versionIdMarker }),
      })
    );

    const stale: { Key: string; VersionId: string }[] = [];
    // `(Key, VersionId)` of the `stale` rows that carry a BODY. Only those
    // feed `removed`: a delete marker holds nothing, and `--all` itself writes
    // one for an absent index key on every run, so counting markers made a
    // second run over an EMPTY prefix report a purge.
    // Keyed Key -> VersionIds rather than by a joined string, so no
    // composite-key encoding is involved.
    const staleBodies = new Map<string, Set<string>>();
    const isStaleBody = (key: string | undefined, versionId: string | undefined): boolean =>
      key !== undefined && versionId !== undefined && staleBodies.get(key)?.has(versionId) === true;
    // Provenance is tracked, not just membership: a noncurrent DELETE MARKER is
    // removed like any other entry but has NO BODY, so it must not mark the key
    // as one whose body was purged. Getting that wrong reinstated the exact
    // defect `purged` was introduced to fix, one deploy later:
    // `deleteRollbackJournal` writes a marker on every successful deploy even
    // when no journal exists, so deploy 2 finds deploy 1's marker noncurrent,
    // "purges" it, and announces a surviving rollback journal for a stack that
    // has never had one.
    const entries: { entry: VersionEntry; hasBody: boolean }[] = [
      ...(resp.Versions ?? []).map((entry) => ({ entry, hasBody: true })),
      ...(resp.DeleteMarkers ?? []).map((entry) => ({ entry, hasBody: false })),
    ];
    for (const { entry, hasBody } of entries) {
      // DECODE before every use: the listing above asks for URL encoding, so a
      // raw `entry.Key` here would fail `scope.covers` for any key containing a
      // `%` and would delete the wrong object. Request and decode are one
      // decision (go-to-k/cdkd#3313).
      // PER ENTRY, not per page: `Prefix` is a prefix match, so this walk sees
      // NEIGHBOURING keys it was never asked about. Letting one undecodable
      // neighbour throw would abort the whole prefix and leave every
      // secret-bearing version behind — and the two callers swallow the throw to
      // a warn, so the sweep would report nothing wrong.
      let decodedKey: string | undefined;
      try {
        decodedKey = decodeListingKey(entry.Key);
      } catch {
        // FAIL-CLOSED, and the first cut of this arm did the opposite. It tested
        // `wanted.has(entry.Key)` with the RAW key before recording — but
        // the scope holds keys or a prefix cdkd CONSTRUCTED, i.e. already in decoded form, so
        // an encoded key can essentially never match one. The arm recorded
        // nothing, and the "a body went unsettled" signal it exists to raise was
        // lost for exactly the entries that could not be read.
        //
        // With no decodable key there is no way to tell an asked-about key from
        // a neighbour, so the undecidable case is recorded rather than dropped:
        // over-reporting costs a warning, under-reporting is a surviving
        // secret-bearing version the sweep called clean. The RAW key is carried
        // only to NAME it — nothing addresses an object with it.
        // The key recorded is the RAW, still-encoded one — there is no other.
        // It is a REPORTING handle and never addresses an object, but it does
        // reach `warnIfPurgeIsReplicated`'s `key.startsWith(rule.prefix)`, where
        // an encoded form can miss a prefix the real key matches. That is the
        // under-warn direction, so the entry is marked rather than left to look
        // like an ordinary key: a reader of the warning sees the encoding.
        if (hasBody && entry.Key !== undefined) {
          unsettledBodies.add(`${entry.Key} [key not decodable; shown as S3 returned it]`);
        }
        // In the prefix scope every listed entry is in scope, so an entry left
        // here is an unpurged version and must reach the failure warning, or
        // the caller's "purged unless a warning above says otherwise" is false.
        // `!== true`, like the decodable path: an absent `IsLatest` is an
        // entry left alone, which is a non-removal to report; a CURRENT one is
        // not a version this purge would ever remove.
        if (scope.ownsEveryListedKey && entry.Key !== undefined && entry.IsLatest !== true) {
          recordFailure(
            failed,
            `${entry.Key} [key not decodable; shown as S3 returned it]`,
            `version ${entry.VersionId ?? '<unknown>'}: listing key could not be decoded, so the entry was left alone`
          );
        }
        continue;
      }
      if (decodedKey === undefined || !scope.covers(decodedKey)) continue;
      // `!== false`, not `=== true`: an entry with the field ABSENT must be
      // treated as possibly-current and left alone. Keying on `=== true` fails
      // OPEN — it would delete the CURRENT version of a key whose `IsLatest`
      // the response happened to omit.
      //
      // But skipping SILENTLY is the one direction this module exists to
      // forbid: the entry is in scope, so it may be a body we were asked to
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
          decodedKey,
          `version ${entry.VersionId ?? '<unknown>'}: listing omitted IsLatest, so the entry was ` +
            `left alone rather than risk deleting a current version`
        );
        if (hasBody) unsettledBodies.add(decodedKey);
      }
      if (entry.IsLatest !== false) continue;
      // A NONCURRENT entry with no `VersionId` cannot be deleted -- there is
      // nothing to name in `DeleteObjects` -- and skipping it silently is the
      // one direction this module exists to forbid: on a `Versions` row that is
      // a body we were asked to remove and did not, in BOTH buckets, while the
      // run reports success. Unreachable against real S3, which always
      // populates the field; recorded rather than assumed away, exactly like
      // the `IsLatest` arm above.
      if (!entry.VersionId) {
        recordFailure(
          failed,
          decodedKey,
          `listing returned a noncurrent entry with no VersionId, so it could not be deleted`
        );
        if (hasBody) unsettledBodies.add(decodedKey);
        continue;
      }
      stale.push({ Key: decodedKey, VersionId: entry.VersionId });
      if (hasBody) {
        const ids = staleBodies.get(decodedKey) ?? new Set<string>();
        ids.add(entry.VersionId);
        staleBodies.set(decodedKey, ids);
      }
      // Provenance is decided HERE, at listing time, and nothing downstream may
      // revisit it: see the NOTE on the delete loop below.
      if (hasBody) purged.add(decodedKey);
    }

    for (let i = 0; i < stale.length; i += DELETE_BATCH_SIZE) {
      const batch = stale.slice(i, i + DELETE_BATCH_SIZE);
      // NOTE for the replication check: nothing below needs to feed it. A
      // body-bearing key entered `purged` at LISTING time, above, so a delete
      // that then fails cannot un-purge it and cannot remove it from the
      // check; and a key that was only ever a delete marker never entered.
      // An earlier revision gated these arms on provenance explicitly, which
      // measured as dead code -- correct behaviour credited to the wrong
      // mechanism, which is worse than no comment.
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
        let bodiesRemoved = batch.filter((o) => isStaleBody(o.Key, o.VersionId)).length;
        for (const err of deleted.Errors ?? []) {
          // A keyless error cannot be matched, so it is assumed to be a body:
          // the under-claiming direction.
          if (
            err.Key === undefined ||
            err.VersionId === undefined ||
            isStaleBody(err.Key, err.VersionId)
          ) {
            bodiesRemoved -= 1;
          }
        }
        removed.n += Math.max(0, bodiesRemoved);
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
      // Blamed on the keys UNDER THIS PREFIX only (the prefix scope names
      // the prefix itself). `wanted` is the full requested set, so warning
      // about all of it would name keys whose own walks completed —
      // over-warning, and a comment describing something the code did not do.
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
      for (const key of scope.unsettledUnder(prefix)) {
        recordFailure(failed, key, TRUNCATED_NO_MARKER);
        // Same unknown provenance as the listing-throw arm above: the walk
        // stopped early, so what remains under this key is unknown. It
        // inherits the SAME `startsWith` over-reach the block comment above
        // describes -- in per-key mode a sibling `<k>.bak` whose own walk
        // completed is named here too -- and in the same safe direction.
        unsettledBodies.add(key);
      }
    }
    // DECODED: the next request sends the RAW marker, and the listing above
    // asked for URL encoding (go-to-k/cdkd#3313). Sending the encoded form back
    // restarts the walk at the wrong key.
    keyMarker = resp.IsTruncated === true ? decodeListingKey(resp.NextKeyMarker) : undefined;
    versionIdMarker = keyMarker !== undefined ? resp.NextVersionIdMarker : undefined;
  } while (keyMarker !== undefined);
}
