import { GetBucketReplicationCommand, type S3Client } from '@aws-sdk/client-s3';
import { getLogger } from '../utils/logger.js';
import { displaySafe } from '../utils/display-safe.js';

/**
 * Tell the user when S3 REPLICATION has silently kept the bodies that
 * {@link ../state/s3-noncurrent-version-purge.js | the noncurrent-version
 * purge} just removed (issue
 * [#2447](https://github.com/go-to-k/cdkd/issues/2447)).
 *
 * ## The hole this closes
 *
 * `purgeNoncurrentKeyVersions` exists so that "cdkd deleted the object" means
 * the body is no longer retrievable. It reaches that by issuing
 * `DeleteObjects` entries that name a specific `VersionId`.
 *
 * **S3 never replicates a version-id delete.** Replication propagates PUTs
 * and — only when `DeleteMarkerReplication` is enabled — delete markers; a
 * delete naming a version id is deliberately not replicated, so that a delete
 * on the source cannot destroy data on the destination. On a state bucket
 * with Cross-Region (CRR) or Same-Region (SRR) replication the purge is
 * therefore SOURCE-ONLY: the replica keeps its own copy of every version,
 * `GetObject` with a `VersionId` still returns the secret, and cdkd reports
 * the purge as complete because on the only bucket it knows about, it was.
 *
 * That is exactly the shape the purge was built to remove — an operation that
 * reports success while the value stays readable — reproduced one bucket over
 * and invisible from every signal cdkd emitted. The user is not merely
 * unprotected, they are REASSURED, which is the direction this repo treats as
 * a defect rather than a gap.
 *
 * ## Why a probe and not only a doc line
 *
 * Documentation reaches the reader who goes looking. This reaches the one who
 * does not, at the moment the false belief would be formed. The whole cost is
 * one bucket-metadata call per process (see the cache below) and one IAM
 * action the caller may well not hold.
 *
 * ## Degrading is the DEFAULT, not the failure
 *
 * The purge's contract is that a missing permission produces a warning and
 * never an abort, and a detector bolted onto it must not be able to break
 * that. So this module NEVER THROWS, and treats every non-answer as "we do
 * not know" rather than as either polarity:
 *
 * - `ReplicationConfigurationNotFoundError` — the answer "no replication
 *   configuration exists". S3 reports the ABSENCE of a configuration as an
 *   ERROR, not as an empty response body, so this arm is the ordinary case
 *   for almost every bucket and must not read as a failure.
 *   `ReplicationConfiguration` ABSENT from a 200 response is treated the same
 *   way: the SDK models the field as optional, and a modelled field is not a
 *   promise that the API populates it.
 * - `AccessDenied` and friends — the caller lacks
 *   `s3:GetReplicationConfiguration`. Logged at DEBUG and never at `warn`:
 *   the overwhelming majority of buckets are not replicated, so warning here
 *   would tell almost every user to grant a permission in order to be told
 *   nothing. The doc names the action for the user who wants the check.
 * - anything else (throttle, 5xx, network) — DEBUG, and deliberately NOT
 *   cached, so the next purge in the same process retries.
 *
 * ## What is cached, what is deduped, and why they are different keys
 *
 * The PROBE is cached per (bucket, asserted owner) for the process lifetime, as
 * the sibling `src/provisioning/create-only-properties.ts` caches its
 * `DescribeType` lookups and for the same reason: the answer cannot change
 * mid-run, the value stored is the in-flight PROMISE so concurrent purges share
 * one call, and only non-transient outcomes are kept. Without it a stack with
 * thirty custom resources would issue thirty identical `GetBucketReplication`
 * calls.
 *
 * The WARNING is deduped too, but on a DIFFERENT and deliberately wider key —
 * (bucket, object description, destinations) — with the repeats sent to
 * `debug`. The two keys answer two questions and must not be merged:
 *
 * - the bucket alone is not enough, because `lock-manager.ts` routes this
 *   module's `warn` sink to `debug` on the ordinary release path (it purges a
 *   heartbeat record on every command and must not warn about it). Keyed on the
 *   bucket, that demoted line would consume the one warning the rollback
 *   journal or the response sidecar needed;
 * - adding the description is still not enough, because two rules covering
 *   different prefixes can name DIFFERENT destinations. Purging a `cdkd/dev/…`
 *   key can match only the first rule; a later `cdkd/prod/…` purge under the
 *   same description matches both, and without the destinations in the key the
 *   user would clean the first replica and never learn the second one holds the
 *   production journal.
 *
 * Deduping at all is a departure from the sibling purge module, which
 * deliberately repeats its own failure warning. The difference is that a
 * failure RECURS — each one is another object cdkd could not remove — while
 * this is a fact about a BUCKET, identical every time it is re-derived.
 * Repeating it thirty times in a deploy adds nothing and erodes the failure
 * warning standing next to it.
 */

/**
 * Parenthetical used when a caller names nothing.
 *
 * True of ANY object the purge is pointed at, which is the bar for a default
 * here: a caller that forgets to describe its object must still emit a warning
 * that is correct, just less specific. It deliberately does not guess at
 * content.
 *
 * Lives HERE rather than in `s3-noncurrent-version-purge.ts` only to keep the
 * import one-directional — the purge imports this module, so a shared constant
 * defined there and read here would be a cycle. It is the same sentence both
 * warnings fall back to, and one definition is what stops the two drifting.
 */
export const DEFAULT_PURGED_OBJECT_DESCRIPTION =
  'the body of an object cdkd has just reported as removed';

/** One enabled replication rule, reduced to what coverage needs. */
export interface ReplicationTarget {
  /**
   * The rule's effective key prefix; `''` when the rule covers the whole
   * bucket.
   */
  prefix: string;
  /** Human-readable destination, for the warning. Never empty. */
  destination: string;
  /**
   * Whether the rule is currently `Enabled`.
   *
   * A DISABLED rule is kept rather than dropped, which is the correction a
   * review round forced: disabling a rule stops FUTURE replication, it does
   * not remove what the rule already copied. A bucket whose rule covered
   * `cdkd/` last month and is `Disabled` today still holds every body ever
   * purged, so dropping it silently is exactly the reassured-user failure this
   * module exists to remove. The state is carried into the warning instead, so
   * the reader can judge.
   */
  enabled: boolean;
}

type ProbeResult =
  | { kind: 'rules'; rules: ReplicationTarget[] }
  | { kind: 'none' }
  | { kind: 'unknown'; reason: string; retry: boolean };

/**
 * Cache of the replication probe, holding the in-flight promise.
 *
 * Keyed on the bucket AND the `ExpectedBucketOwner` the caller asserts. The
 * SUCCESS answer does not depend on the owner assertion — two callers
 * differing only in whether they assert it read the same configuration — but
 * the FAILURE does: a mismatched-owner 403 is an answer about that caller's
 * request, and caching it under the bare bucket name silenced the detector for
 * every correctly-scoped caller in the process. cdkd has two shapes today (the
 * provider probes without an owner, the state backend and lock manager with
 * one), so the two are distinguishable in practice.
 */
const replicationProbeCache = new Map<string, Promise<ProbeResult>>();

/**
 * (bucket, object description, destinations) triples already warned about.
 *
 * The one thing the warning says that VARIES is `objectDescription`; the rest
 * is a fact about the bucket, identical every time. So a stack with thirty
 * custom resources repeated a ~600-character warning thirty times while adding
 * no information after the first — and warning fatigue erodes the purge's own
 * failure warning standing next to it.
 *
 * Keyed on all three precisely so this cannot become a silence hole; the
 * module doc above gives the two failures a narrower key produces. Entries are
 * added only after the warning is actually emitted, so a throwing sink does
 * not burn a slot.
 *
 * RESIDUAL, bounded and recorded: cdkd cannot see whether the caller's sink
 * DEMOTED the line, so a `lock-manager.ts` release (which routes `warn` to
 * `debug`) claims the lock's slot and a later reap of a stale lock — which
 * would have warned — is suppressed. It is bounded to the LOCK description,
 * whose object the docs describe as carrying no secret, and to one process.
 */
const warnedWarnings = new Set<string>();

/** Clear both process-scoped caches. Test-only helper. */
export function clearReplicationProbeCache(): void {
  replicationProbeCache.clear();
  warnedWarnings.clear();
}

/** How many destinations the warning names before it truncates. */
const MAX_NAMED_DESTINATIONS = 3;

/** Shown when a rule carries no `Destination.Bucket` for us to name. */
const UNNAMED_DESTINATION = '<destination not named by the replication rule>';

/**
 * Error codes meaning "this principal will never get an answer here".
 *
 * Cached like a real answer, because unlike a throttle they do not clear
 * within the process: retrying on every purge would spend one denied API call
 * per custom resource for a result that cannot change.
 */
const PERMANENT_DENIALS = new Set([
  'AccessDenied',
  'AccessDeniedException',
  'AllAccessDisabled',
  'MethodNotAllowed',
  'NotImplemented',
]);

/**
 * Credential-shaped failures that ARRIVE AS 403 and are nonetheless transient.
 *
 * Checked BEFORE the blanket 403 rule, which is the only way they can win:
 * `InvalidAccessKeyId` is the classic blip while an IAM principal or an
 * assumed-role credential propagates — this repo retries that whole class over
 * a 47.75 s schedule elsewhere — and an expired or skewed token clears on
 * refresh. Cached as permanent, ONE such blip on the first purge of a long
 * deploy would silence the detector for the rest of the process, which is the
 * "false silence leaves them believing a secret is gone" direction this module
 * forbids.
 */
const TRANSIENT_CREDENTIAL_CODES = new Set([
  'InvalidAccessKeyId',
  'ExpiredToken',
  'ExpiredTokenException',
  'InvalidToken',
  'TokenRefreshRequired',
  'RequestTimeTooSkewed',
  'RequestExpired',
]);

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Every wire error code the value offers, `name` and `Code` alike.
 *
 * NO PRECEDENCE, deliberately. An earlier revision collapsed the two to one
 * string and preferred a specific `name`, which had two failure modes in
 * opposite directions: preferring `name` unconditionally made the `Code`
 * fallback dead (`{ name: 'Error', Code: 'AccessDenied' }` classified as
 * retryable, so a denied principal re-probed on every purge), while
 * preferring a SPECIFIC `name` let a wrapper's own name hide
 * `Code: 'InvalidAccessKeyId'` and cache a credential blip as a permanent
 * denial. Membership is tested against every code the error carries, so
 * neither field can mask the other. (Verified against real S3: a missing
 * replication configuration arrives with that string on BOTH fields.)
 *
 * Null-safe because a `send` that rejects with `null` used to throw a
 * TypeError INSIDE the probe's own catch, leaving a REJECTED promise in the
 * cache forever: every later purge on that bucket then fell into the outer
 * `catch {}` with no warning and no debug line — a silently dead detector,
 * which is the worst possible failure for this module.
 *
 * This guard and `probe`'s rejection arm both serve one invariant — **no
 * rejection ever reaches the cache** — and the honest statement of their
 * relationship, measured one mutation at a time on 2026-09-05, is:
 *
 * - removing the ARM alone REDS a case (a rejection whose own `toString`
 *   throws: the guards pass that value through and `describe()` is what
 *   raises), so the arm is independently fenced;
 * - removing these GUARDS alone leaves the CACHING behaviour identical:
 *   `errorCodes` runs inside `runProbe`'s own catch, so a TypeError here is
 *   caught by the arm and produces the same `unknown` / `retry: true` /
 *   evicted outcome. What DOES change is the debug line's reason — guarded it
 *   reports the rejection (`: null`), unguarded it reports the classifier's
 *   own crash — and that difference is what the `throw null` case asserts, so
 *   the guards are fenced after all.
 *
 * They also earn their place structurally: classification is inside the catch
 * TODAY. An edit that hoists it out — or that adds a caller of `errorCodes`
 * outside a try — reinstates the original defect, in which a `null` rejection
 * crashed the classifier and left a REJECTED promise cached for the process,
 * so every later purge on that bucket fell into the outer `catch {}` with no
 * warning and no debug line: a silently dead detector.
 */
const errorCodes = (error: unknown): string[] => {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return [];
  const e = error as { name?: unknown; Code?: unknown };
  const codes: string[] = [];
  if (typeof e.name === 'string' && e.name.length > 0) codes.push(e.name);
  if (typeof e.Code === 'string' && e.Code.length > 0) codes.push(e.Code);
  return codes;
};

/** True when ANY code the error carries is in `set`. */
const hasCode = (error: unknown, set: ReadonlySet<string>): boolean =>
  errorCodes(error).some((code) => set.has(code));

const httpStatus = (error: unknown): number | undefined => {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function'))
    return undefined;
  const meta = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
  return typeof meta?.httpStatusCode === 'number' ? meta.httpStatusCode : undefined;
};

/**
 * Strip the ARN wrapper off `Destination.Bucket`, which S3 returns as
 * `arn:<partition>:s3:::<name>`.
 *
 * Partition-agnostic on purpose: `aws-cn` and `aws-us-gov` produce a
 * different second segment, and a hard-coded `arn:aws:s3:::` would leave the
 * whole ARN in the message there rather than mis-parse it — survivable, but
 * the regex costs nothing. A value that is not ARN-shaped is passed through
 * unchanged rather than rejected; the field is only ever displayed.
 */
function destinationName(bucketArn: string | undefined, account: string | undefined): string {
  if (bucketArn === undefined || bucketArn === '') return UNNAMED_DESTINATION;
  const name = bucketArn.replace(/^arn:[^:]*:s3:::/, '');
  // The cross-account replica is the case worth spelling out: the surviving
  // copy is then in a bucket the cdkd operator may not even be able to read.
  return account !== undefined && account !== '' ? `${name} (account ${account})` : name;
}

/**
 * Reduce a `ReplicationConfiguration` to the ENABLED rules and their effective
 * prefixes.
 *
 * Exported for its own unit tests: the mapping from the four filter shapes S3
 * accepts onto one prefix string is the part with real cases in it, and
 * pinning it through a stubbed client would test the plumbing instead.
 *
 * Over-approximates DELIBERATELY, in the direction of warning:
 *
 * - a rule filtering on a TAG (`Filter.Tag`, or `Filter.And.Tags` with no
 *   `Prefix`) cannot be evaluated without reading each object's tag set, so
 *   its prefix reduces to `''` and it covers everything. A false warning
 *   sends the reader to look at a replica; a false silence leaves them
 *   believing a secret is gone.
 * - a `Disabled` rule is KEPT, flagged rather than dropped. Disabling a rule
 *   stops FUTURE replication; it does not remove what the rule already
 *   copied, so a bucket whose rule covered `cdkd/` last month and is disabled
 *   today still holds every body ever purged. Dropping it was the first cut
 *   and is the reassured-user failure this module exists to remove, arriving
 *   inside the module that removes it. A rule with no `Status` at all is kept
 *   as ENABLED: `Status` is required by the model, so an absent one means the
 *   response was not what we assumed — the same reason the sibling purge
 *   treats an absent `IsLatest` as "assume the unsafe thing is true".
 *
 * Pure: it reads only its argument, so no ambient locale, clock or
 * environment can change the answer.
 */
export function normalizeReplicationRules(config: {
  Rules?: {
    Status?: string;
    Prefix?: string;
    Filter?: { Prefix?: string; And?: { Prefix?: string } };
    Destination?: { Bucket?: string; Account?: string };
  }[];
}): ReplicationTarget[] {
  const targets: ReplicationTarget[] = [];
  for (const rule of config.Rules ?? []) {
    // V2 rules carry `Filter`; V1 rules carry a top-level `Prefix`. A `Filter`
    // present but empty covers the whole bucket, which is why the `Filter`
    // branch does not fall through to `rule.Prefix`.
    const prefix =
      rule.Filter !== undefined
        ? (rule.Filter.Prefix ?? rule.Filter.And?.Prefix ?? '')
        : (rule.Prefix ?? '');
    targets.push({
      prefix,
      destination: destinationName(rule.Destination?.Bucket, rule.Destination?.Account),
      // Anything that is not the literal `Disabled` counts as enabled,
      // including an ABSENT `Status` -- the model requires the field, so its
      // absence means the response was not what we assumed, and the safe
      // assumption is that the rule is live.
      enabled: rule.Status !== 'Disabled',
    });
  }
  return targets;
}

async function runProbe(
  s3Client: Pick<S3Client, 'send'>,
  bucket: string,
  requestFields: { ExpectedBucketOwner?: string }
): Promise<ProbeResult> {
  try {
    const response = (await s3Client.send(
      new GetBucketReplicationCommand({ Bucket: bucket, ...requestFields })
    )) as { ReplicationConfiguration?: Parameters<typeof normalizeReplicationRules>[0] };
    const config = response.ReplicationConfiguration;
    if (config === undefined) return { kind: 'none' };
    const rules = normalizeReplicationRules(config);
    return rules.length === 0 ? { kind: 'none' } : { kind: 'rules', rules };
  } catch (error) {
    // The ordinary answer for an unreplicated bucket, delivered as an error.
    if (errorCodes(error).includes('ReplicationConfigurationNotFoundError')) {
      return { kind: 'none' };
    }
    // BEFORE the 403 rule, which would otherwise swallow every one of these:
    // credential-propagation and token-expiry failures all arrive as 403.
    if (hasCode(error, TRANSIENT_CREDENTIAL_CODES)) {
      return { kind: 'unknown', reason: describe(error), retry: true };
    }
    // The two halves are NOT redundant. `PERMANENT_DENIALS` catches an
    // authorization refusal whose transport status the double did not carry
    // (a bare `AccessDeniedException`); the 403 catches the real smithy shape
    // where an unmodelled error's `name` falls back to the status text and no
    // code we could enumerate is present. Each is fenced by its own test.
    const permanent = hasCode(error, PERMANENT_DENIALS) || httpStatus(error) === 403;
    return { kind: 'unknown', reason: describe(error), retry: !permanent };
  }
}

function probe(
  s3Client: Pick<S3Client, 'send'>,
  bucket: string,
  requestFields: { ExpectedBucketOwner?: string }
): Promise<ProbeResult> {
  const key = `${bucket}\u0000${requestFields.ExpectedBucketOwner ?? ''}`;
  const cached = replicationProbeCache.get(key);
  if (cached) return cached;
  // Eviction runs in a `.then`, hence in a microtask, hence strictly AFTER the
  // `set` below. Doing it inside `runProbe`'s own catch would evict BEFORE the
  // set if `send` ever threw synchronously, leaving a stale entry cached
  // forever.
  //
  // The `catch` is the second half of the "no rejection reaches the cache"
  // invariant `errorCodes`' doc describes: a rejection stored here would be
  // re-thrown to every later caller for the process lifetime and swallowed by
  // the caller's outer catch — a silently dead detector, the worst outcome for
  // this module. Evicted, so the next purge re-probes. It overlaps the
  // null-guards in `errorCodes` / `httpStatus` and that overlap is deliberate;
  // see there for the measurement.
  //
  // Both arms evict only the entry they own. `clearReplicationProbeCache()`
  // plus an in-flight probe could otherwise have a stale settle remove a
  // NEWER entry.
  const pending: Promise<ProbeResult> = runProbe(s3Client, bucket, requestFields).then(
    (result) => {
      if (result.kind === 'unknown' && result.retry) evictIfOwn(key, pending);
      return result;
    },
    (error: unknown) => {
      evictIfOwn(key, pending);
      return { kind: 'unknown', reason: describe(error), retry: true } as const;
    }
  );
  replicationProbeCache.set(key, pending);
  return pending;
}

/**
 * Remove a cache entry only when it is still the one we put there.
 *
 * The identity check is UNFENCED by a test, deliberately and stated rather
 * than left to be discovered: the only way a stale probe can settle against a
 * newer entry under the same key is for something to have cleared the cache
 * mid-flight, and the sole clearer is `clearReplicationProbeCache()`, a
 * test-only helper. Writing a test for it would be writing a test for the test
 * helper. It is kept because the alternative is an unconditional `delete` that
 * is wrong the moment a non-test clearer appears.
 */
function evictIfOwn(key: string, own: Promise<ProbeResult>): void {
  if (replicationProbeCache.get(key) === own) replicationProbeCache.delete(key);
}

export interface ReplicationGapWarningOptions {
  /** Merged into the probe request — in practice `ExpectedBucketOwner`. */
  requestFields?: { ExpectedBucketOwner?: string };
  /**
   * Sink for the warning. The SAME sink the purge warns through, so a caller
   * that demotes purge warnings (the lock release path) demotes this one too.
   *
   * `debug` is optional for the same reason it is optional on the purge: the
   * seam exists for a caller supplying a bare `warn` function.
   */
  logger?: { warn: (m: string) => void; debug?: (m: string) => void };
  /** What the surviving bodies contain — the purge's own `objectDescription`. */
  objectDescription?: string;
}

/**
 * Warn if replication on `bucket` covers any of `keys`.
 *
 * `keys` are the keys whose bodies were actually removed (or could not be
 * settled) — NOT everything the caller asked about. The purge scopes them; see
 * its call site for why announcing a survival that never happened is worse
 * than saying nothing.
 *
 * NEVER THROWS and never rejects: the caller runs on a cleanup path that must
 * not abort, and this is a diagnostic bolted onto it.
 */
export async function warnIfPurgeIsReplicated(
  s3Client: Pick<S3Client, 'send'>,
  bucket: string,
  keys: readonly string[],
  options: ReplicationGapWarningOptions = {}
): Promise<void> {
  if (keys.length === 0) return;
  // The caller's own `debug` when it has one, a module-scoped child otherwise.
  // Resolved through the caller OBJECT rather than a bare function reference so
  // a method that reads `this` (every `Logger` here does) still works.
  const emitDebug = (message: string): void => {
    const sink = options.logger;
    if (sink?.debug) sink.debug(message);
    else getLogger().child('s3-replication-check').debug(message);
  };
  // Sanitized ONCE, at the top: `bucket` appears in the debug line, the repeat
  // line, the warning and a pasteable command, and sanitizing only the command
  // left the same value rendered two ways in one string -- where an escape the
  // sanitization exists to stop fires from the raw occurrence and can hide the
  // sanitized one. `asciiOnly` is the positive allowlist: an S3 bucket name has
  // a known ASCII charset, so it has no residual.
  const safeBucket = displaySafe(bucket, { asciiOnly: true });
  try {
    const result = await probe(s3Client, bucket, options.requestFields ?? {});
    if (result.kind === 'none') return;
    if (result.kind === 'unknown') {
      // DEBUG, not `warn`: see the module doc — almost no bucket is
      // replicated, so warning here is a permission demand paid by everyone
      // to inform almost no one.
      emitDebug(
        `Could not determine whether s3://${safeBucket} is replicated ` +
          `(grant s3:GetReplicationConfiguration to enable the check): ` +
          `${displaySafe(result.reason)}`
      );
      return;
    }

    // `some`, NOT `every`: ONE covered key is enough, because one surviving
    // body is the whole subject. `cdkd gc` hands this thousands of keys under
    // a shared prefix, so `every` would go silent the moment a single one fell
    // outside the rule — a bug a single-key test population cannot see, since
    // for one element the two are the same function.
    const covered = result.rules.filter((rule) => keys.some((key) => key.startsWith(rule.prefix)));
    if (covered.length === 0) return;

    // De-duplicated and ORDER-STABLE: two rules replicating different prefixes
    // to one destination must not name it twice, and the message is asserted
    // on in tests. `asciiOnly` because a bucket name and an account id have a
    // KNOWN ASCII charset, which is the positive-allowlist case `displaySafe`
    // documents as having no residual — unlike the denylist path.
    //
    // SORTED ONCE, here, and read by all three consumers below — the dedupe
    // key, the repeat line and the warning. Rule order is S3's, so an unsorted
    // rendering could name a different three on two runs that found the
    // identical set, and the truncation would then hide a different replica
    // each time. Three separate `.sort()` calls is how the repeat line and the
    // warning came to order the same set differently in the first place;
    // one binding cannot diverge.
    const destinations = [
      ...new Set(
        covered.map((rule) =>
          rule.enabled
            ? rule.destination
            : `${rule.destination} (rule currently Disabled -- it stops FUTURE replication, not what it already copied)`
        )
      ),
    ].sort();

    // Deduped on (bucket, description, DESTINATIONS) — see the module doc for
    // why all three. RAW `bucket`, not `safeBucket`: this is an identity key,
    // not display text, and sanitizing it would let two different buckets
    // collapse onto one slot and silence the second.
    const warnKey = [bucket, options.objectDescription ?? '', ...destinations].join('\u0000');
    if (warnedWarnings.has(warnKey)) {
      emitDebug(
        `S3 replication on s3://${safeBucket} still covers purged keys ` +
          `(${options.objectDescription ?? DEFAULT_PURGED_OBJECT_DESCRIPTION}); ` +
          `already reported once this run for ` +
          `${destinations.map((d) => displaySafe(d, { asciiOnly: true })).join(', ')}.`
      );
      return;
    }

    const named = destinations
      .slice(0, MAX_NAMED_DESTINATIONS)
      .map((d) => displaySafe(d, { asciiOnly: true }));
    const elided = destinations.length - named.length;
    const logger = options.logger ?? getLogger().child('s3-replication-check');
    logger.warn(
      `S3 replication is enabled on s3://${safeBucket} and covers the key(s) cdkd just purged. ` +
        `S3 NEVER replicates a version-id delete, so the purge removed those versions from ` +
        `THIS bucket only — the copies in the destination bucket survive and remain readable ` +
        `there via GetObject with a VersionId ` +
        `(${options.objectDescription ?? DEFAULT_PURGED_OBJECT_DESCRIPTION}). ` +
        `cdkd cannot delete them. Remove them in the destination bucket yourself ` +
        `(aws s3api list-object-versions, then delete-object --version-id), or narrow the ` +
        `replication rule so it excludes the prefixes cdkd purges under. ` +
        `Destination(s): ${named.join(', ')}` +
        // The elided names are recoverable, and the message says how -- a
        // truncated warning that names a replica cdkd never names anywhere
        // would leave the user unable to act on it.
        (elided > 0
          ? ` (and ${elided} more; aws s3api get-bucket-replication --bucket ` +
            `${safeBucket} lists them all)`
          : '')
    );
    // Claimed only AFTER a successful emit. Claiming it first burnt the slot
    // for the process when the sink threw (a real `Logger` reaching a closed
    // stdout does so synchronously), losing the one warning entirely.
    warnedWarnings.add(warnKey);
  } catch {
    // Deliberately empty. Nothing above should throw — `probe` catches its own
    // SDK errors — but this function is called from a path whose contract is
    // that it cannot abort its caller, and that contract must hold even if a
    // future edit above starts throwing.
  }
}
