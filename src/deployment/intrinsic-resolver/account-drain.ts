import { AsyncLocalStorage } from 'node:async_hooks';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { canonicalizeRegion, derivePartitionAndUrlSuffix } from '../../utils/aws-partition.js';
import { drainDeadlines } from '../drain-budget.js';
import { markNonRetryable } from '../retryable-errors.js';
import { clearRecoverableMaskedOutputs } from '../secret-redaction.js';
import {
  ambientCredentialConfig,
  credentialFingerprint,
  type CredentialConfig,
} from '../../utils/ambient-client-defaults.js';
import { injectiveKey } from '../../state/record-keys.js';
import {
  type CachedAccountIdentity,
  type AwsAccountInfo,
  cachedAccountIdentities,
  cachedAvailabilityZones,
  recordedSecretExpressions,
  cachedEc2InstanceAttributes,
  cachedVpcDefaultSecurityGroups,
  cachedCloudFrontDomainNames,
  cachedSecurityGroupVpcIds,
} from './context.js';

/**
 * The region this call answers for: the caller's override, else the ambient one.
 *
 * Kept as one helper so the cached and the freshly-resolved paths cannot pick
 * different defaults (issue #1746).
 *
 * FOLDED here, at the source, rather than at each consumer (issue
 * [#1882](https://github.com/go-to-k/cdkd/issues/1882)). This is the value
 * `AWS::Region` returns, the value every `Fn::Sub` in a USER template
 * interpolates, and the `region-name` filter `resolveGetAZs` sends to EC2 when
 * the template names no region — three consumers with three different
 * case-sensitivities, which is why folding at the read beats folding at each of
 * them.
 *
 * #1882 held this raw pending a live CloudFormation A/B, on the reasoning that
 * `AWS::Region` is CFn's own passthrough and a user may legitimately read it
 * back. The A/B was run on 2026-08-25 and removes the premise rather than
 * answering it: a non-canonical region never reaches CloudFormation at all,
 * because SigV4's credential scope is compared case-sensitively by the service.
 * Measured against this repo's vendored SDK, every spelling but the canonical
 * one is refused before the request is served:
 *
 * ```text
 * STSClient({region:'us-east-1'}).send(GetCallerIdentity) -> OK
 * STSClient({region:'US-EAST-1'}).send(GetCallerIdentity) -> SignatureDoesNotMatch
 * STSClient({region:'Us-East-1'}).send(GetCallerIdentity) -> SignatureDoesNotMatch
 * CloudFormationClient({region:'US-EAST-1'}).send(ListStacks) -> SignatureDoesNotMatch
 *     "Credential should be scoped to a valid region."
 * ```
 *
 * Two routes a raw region could take are therefore closed BEFORE this function:
 * `--region` / `AWS_REGION` are folded at the CLI boundary (`foldRegionOption`,
 * issue #2065), and a CDK app declaring `env: { region: 'US-EAST-1' }` fails at
 * `app.synth()` — `EnvironmentUtils.parse` is case-sensitive, measured on
 * aws-cdk-lib 2.244.0.
 *
 * What is NOT closed, and is the reason this fold is more than tidiness: a Cloud
 * Assembly that reaches cdkd with a raw region in its `environment` string.
 * cdkd's own `parseEnvironment` (`src/types/assembly.ts`) accepts any region
 * text, so a hand-authored assembly, a non-CDK toolchain, or a `cdk.out` left
 * behind by a synth that threw AFTER writing the manifest all reach
 * `stackInfo.region` unfolded, and `deploy.ts` passes it on as the resolver's
 * region. That deploy SUCCEEDS — `AwsClients`' constructor folds the region its
 * clients sign with, so SigV4 never sees the raw spelling — and every
 * `${AWS::Region}` a user's `Fn::Sub` interpolates inherits it, producing
 * `arn:aws:s3:US-EAST-1:...`, which no IAM policy matches, and persisting it,
 * while every ARN cdkd itself constructs beside it is canonical (issue #1850).
 * Folding here removes that self-contradiction.
 *
 * UPGRADE CONSEQUENCE, stated because #1850's own entry states it for its fold:
 * a stack deployed that way keeps the raw spelling in its recorded properties,
 * so the next diff of a property interpolating `${AWS::Region}` sees a change,
 * and where the property is create-only that classifies as a REPLACEMENT.
 * Deliberate — the recorded value is unusable, so converging it is the point.
 * State KEYS are unaffected: they are built from `stackRegion`, which this does
 * not touch.
 *
 * The consumer-side `canonicalizeRegion` calls this subsumes are deliberately
 * LEFT in place. Only `s3-endpoints.ts`'s is still reachable from a caller that
 * does not come through here; the rest are now genuinely redundant and are kept
 * as defense in depth, since double-folding is a no-op and a future caller may
 * reach them another way.
 */
export function effectiveAccountInfoRegion(overrideRegion?: string): string {
  return canonicalizeRegion(overrideRegion || process.env['AWS_REGION']) || 'us-east-1';
}

/**
 * Build the caller's full answer from the cached account identity (issue #1746).
 *
 * `partition` is a FUNCTION of `region`, so it is derived HERE — per call —
 * rather than carried alongside the account. This is what makes the cache safe
 * to share between callers with different regions: an `arn:aws:...:cn-north-1`
 * (or the inverse `arn:aws-cn:...:us-east-1`) is structurally valid, so nothing
 * downstream could catch it.
 */
export function accountInfoFor(
  identity: CachedAccountIdentity,
  overrideRegion?: string
): AwsAccountInfo {
  const region = effectiveAccountInfoRegion(overrideRegion);
  return {
    accountId: identity.accountId,
    region,
    partition: derivePartitionAndUrlSuffix(region).partition,
    ...(identity.fabricated ? { fabricated: true } : {}),
  };
}

/**
 * How long a FABRICATED answer is reused before STS is retried (issue #1730,
 * PR review). Deliberately not the success path's forever-cache — the whole
 * point is that a transient blip must not poison the run — but not zero either:
 * `getAccountInfo` is on the path of EVERY `Fn::GetAtt` and every
 * `AWS::AccountId` / `AWS::Partition` / `AWS::StackId` pseudo-parameter, so an
 * uncached failure re-issues `GetCallerIdentity` (with the SDK's own 3-attempt
 * retry + backoff) dozens of times per stack and prints one warning each. This
 * window collapses a burst into one call while still letting a later phase of
 * the same deploy heal.
 */
export const FABRICATED_ACCOUNT_INFO_TTL_MS = 10_000;

/**
 * Retries after the first attempt for a dynamic-reference lookup, THROTTLE-shaped
 * failures only (issue #1933 review). Everything else — a missing parameter, a
 * denied secret — is a real answer and is thrown to the caller unchanged.
 *
 * It matters more since the cache became per-resolver AND stopped memoizing a
 * value whose ssm `Type` was unclassifiable: both raise the call COUNT for the
 * same template (one lookup per resolver rather than per process; one per
 * occurrence for the anomalous type), and a bare `send` turned the resulting
 * throttle into an aborted deploy. At the default backoff (1s -> 2s -> 4s -> 8s)
 * this adds at most ~15s of sleep, against re-running the whole deploy.
 */
export const MAX_DYNAMIC_REFERENCE_THROTTLE_RETRIES = 4;

/**
 * How many producer output KEYS an `Fn::GetStackOutput` not-found error may
 * enumerate (issue #2133 review). See {@link
 * IntrinsicFunctionResolver.describeAvailableOutputs} for why the list is
 * bounded at all; the value is "enough to fix a typo, few enough that one error
 * cannot dump a producer's whole key space".
 */
export const MAX_LISTED_AVAILABLE_OUTPUTS = 10;

/**
 * Test seam: overriding `sleep` lets unit tests drive the backoff schedule
 * without real waits (mirrors `describeTypeRetryDelays`).
 */
export const dynamicReferenceRetryDelays: { sleep?: (ms: number) => Promise<void> } = {};

/**
 * How long {@link allSettledKeepingFirstRejection} waits for the remaining
 * parts AFTER a rejection is in hand. Double the largest FIXED wait in this
 * file (the `Fn::GetAtt` `Ipv6CidrBlocks` poll's sleep budget, 15 attempts
 * x 2 s), which makes it a hang guard rather than a schedule — not a
 * guarantee that healthy work fits inside it; see the function's own note.
 *
 * It is the budget for one CALL of {@link IntrinsicFunctionResolver.resolve}
 * and everything nested under it: nested drains share the REMAINING wait, so
 * a template's nesting depth cannot multiply it. It is NOT a bound on a caller
 * that resolves in a LOOP -- each iteration opens its own budget unless the
 * caller wraps the loop in {@link withSharedDrainBudget}, which the outputs
 * pass does and `evaluateConditions` deliberately does not (its aggregate is
 * `#conditions x` this, before any resource is provisioned but with the
 * deploy lock already held).
 */
export const DRAIN_AFTER_REJECTION_MS = 60_000;

/** Sentinel for "the cap expired", distinguishable from any resolved value. */
export const CAP_EXPIRED = Symbol('drain-cap-expired');

/**
 * Test seam: overriding `ms` lets a unit test drive the cap without a real
 * minute of waiting (mirrors {@link dynamicReferenceRetryDelays}).
 */
export const concurrentDrainCap: { ms?: number } = {};

/**
 * The budgets whose drain has already reported abandoned inputs (issue
 * [#2814](https://github.com/go-to-k/cdkd/issues/2814)). A `WeakSet` so a
 * budget's entry dies with the budget, as the budget itself does with the
 * async context that opened it.
 */
export const abandonReported = new WeakSet<object>();

/**
 * The order in which drains CAPTURED rejections, across every drain in the
 * process (issue [#2805](https://github.com/go-to-k/cdkd/issues/2805)). A
 * counter, not `Date.now()`: two rejections in one millisecond still order.
 */
export let rejectionClock = 0;

/**
 * The capture orders a drain's NESTED drains threw their picks with, keyed by
 * the thrown error. Each drain starts its parts inside its own map's scope,
 * so a drain nested in one of them writes into its PARENT's map and nobody
 * else's. The parent then compares that failure by when it happened rather
 * than by when the inner drain let it go. Per parent, not one map per error:
 * a memoized error object can be in flight in two resolutions at once, and a
 * single record would let one resolution's drain overwrite the other's before
 * its parent read it, or hand one drain a capture that never happened in its
 * own parts. A `WeakMap` so an entry dies with its error. A primitive
 * rejection (`throw undefined`) has no key and is ordered by arrival, as
 * every rejection was before #2805.
 */
export const nestedCaptureOrders = new AsyncLocalStorage<WeakMap<object, number>>();

/**
 * `Promise.all`'s RESULT and its choice of error, with `Promise.allSettled`'s
 * TIMING: every promise started here has settled before this returns, and
 * before it throws unless the cap below expires first (issue
 * [#2563](https://github.com/go-to-k/cdkd/issues/2563)).
 *
 * Why the resolver needs that. Resolving a secret dynamic reference RECORDS
 * `plaintext -> expression` into `context.recordedSecretValues` just before
 * its promise settles, and that map is what every masking and redaction site
 * downstream uses as its needle set. Under a bare `Promise.all` a rejecting
 * part surfaces IMMEDIATELY, so a caller's `catch` / `finally` can run while a
 * sibling part is still in flight: `DeployEngine`'s `Export.Name` block copies
 * its private map into the pass map in exactly such a `finally`, and the
 * sibling's recording then lands in the private map after the copy and reaches
 * nothing. Draining here fixes it for every caller at once, which a
 * consumer-side drain cannot — `cdkd scrub`'s shared-map view (issue
 * [#2531](https://github.com/go-to-k/cdkd/issues/2531)) lets a late write land
 * whenever it happens but still cannot make it land before the next consumer
 * runs.
 *
 * THE ERROR IS SELECTED BY TIME, NOT BY INPUT ORDER, which is what `Promise.all`
 * does and what a naive `Promise.allSettled` + "first rejected entry" would
 * silently change: with two parts rejecting out of input order, the entry scan
 * reports the LATER one. Each promise gets its own `catch`, so the callbacks
 * fire in rejection order and each one is ranked as it arrives: by arrival,
 * or by the capture order a nested drain recorded for it (below).
 *
 * Every input is `catch`-ed, so nothing here can raise an unhandled rejection
 * while the drain waits.
 *
 * THE WAIT IS CAPPED ONCE A REJECTION IS IN HAND. The drain exists to let a
 * sibling finish RECORDING, and that is worth a wait — but `resolveOutputs`
 * runs at `deploy-engine.ts`'s worst moment: after every resource has been
 * created in AWS, before the final `saveState`, with the S3 lock held and its
 * heartbeat pushing `expiresAt` forward. An unbounded wait there costs a deploy
 * its state and its lock, and on a FIRST deploy (`currentEtag` undefined, so
 * the incremental saves were no-ops) every created resource becomes invisible
 * to cdkd. Nothing else bounds it: `withRetry` caps ATTEMPTS not duration, no
 * `requestTimeout` is configured, and `withResourceDeadline` wraps
 * `provisionResourceBody` — which does bound the resource path, property
 * resolution included, but not the outputs pass. So once a rejection is
 * recorded the remaining settles race {@link DRAIN_AFTER_REJECTION_MS}, and the
 * recorded rejection is thrown when it expires.
 *
 * The cap is a HANG GUARD, and it does not claim to be more. It is sized
 * against the largest fixed wait in the resolver — the `Fn::GetAtt`
 * `Ipv6CidrBlocks` poll's sleep budget, 15 attempts x 2 s, about 30 s — but
 * that budget is a floor, not a ceiling: the poll also awaits 15 AWS calls,
 * and one part can drive several lookups in sequence through object
 * properties or `Fn::Sub` variables. Two healthy shapes measured on review
 * already exceed 60 s — three sequential `Ipv6CidrBlocks` polls in one part
 * is 3 x (15 x 2 s) = 90 s with no hang and no throttling, and five throttled
 * dynamic references is 5 x (1+2+4+8 s) = 75 s at
 * `MAX_DYNAMIC_REFERENCE_THROTTLE_RETRIES` = 4. Healthy work CAN therefore
 * outlast the cap, and when it does its recording lands after the rejection
 * was released, which is the window this whole function exists to close.
 * Nothing here cancels that sibling — it keeps running and can record
 * arbitrarily later — so what the cap bounds is the WAIT, not the lateness.
 * That is the trade taken deliberately: a bounded wait with a late record
 * still possible beyond it, against an unbounded hold on a deploy's state
 * save.
 *
 * AND A DRAIN CAN GET NO GRACE AT ALL. The budget is shared REMAINING wait,
 * so a drain that arms once it is spent gets
 * `Math.max(0, remaining - openWindow)` = 0 and releases its rejection on the
 * next macrotask. That applies to any drain NOT ALREADY ARMED when a rejection
 * reaches it: the ordinary case is an inner drain that spends the full budget
 * and throws, whose every not-yet-armed ancestor then arms against an
 * exhausted remaining-wait budget. What it does NOT mean is that a fast sibling is exposed: a
 * sibling still pending at that moment has itself been running at least the
 * budget. What it means is that the sibling's own RECORDING gets no wait --
 * a lookup begun late inside a long-running part is fast in itself and still
 * lands after the rejection was released. That reasoning covers the NESTED
 * ancestor case; a caller that wraps a LOOP widens it, because a later
 * iteration starts FRESH siblings against a budget an earlier one already
 * spent and those need not be long-running at all. So the exposure does not
 * require the "healthy work slower than 60 s" shape the sizing paragraph
 * describes; that shape is the cheapest way to reach it with no nesting and
 * no wrapped loop, not the floor.
 *
 * WHAT HAPPENS TO A PART THE CAP STOPS WAITING FOR (issue
 * [#2814](https://github.com/go-to-k/cdkd/issues/2814)). It keeps running, and
 * its recording still lands in the context's map whenever it arrives -- the
 * cap costs it ORDER, not the write. So the answer sits with the READERS: one
 * that runs after the recording arrives must see it, which `DeployEngine`'s
 * outputs pass arranges for its `Export.Name` block (a map that writes each
 * recording through to the pass map at once, where a local copied in a
 * `finally` used to drop it) and for the persisted outputs, the exports index
 * and the deploy summary (each redacting against the pass map as it stands
 * at the moment it is written). A reader that took its
 * copy BEFORE the recording arrived -- a failure message already printed, a
 * state save already sent -- cannot be helped without waiting, and the wait
 * is what the cap bounds. Cancelling the
 * part would not close that either: a cancelled part never records, so its
 * plaintext would be missing for EVERY reader rather than for the early ones.
 * What this helper adds is the report: releasing a rejection with inputs
 * still running calls `onAbandoned` with how many, at most once per budget,
 * and the resolver turns that into a warning.
 *
 * THE EARLIEST-IN-TIME RULE HOLDS ACROSS NESTED DRAINS, not only per
 * invocation (issue [#2805](https://github.com/go-to-k/cdkd/issues/2805)).
 * For a join whose parts are `[listWithAnEarlyFailure, laterFailure]`, the
 * inner list's drain holds its own rejection while its slow sibling finishes,
 * so the outer join RECEIVES the later failure first. Picking by arrival would
 * report that shallower one, and it is not only cosmetic: the retry
 * classifiers read the message (`retryClassificationText` feeds
 * `isRetryableTransientError`, whose `RETRYABLE_ERROR_MESSAGE_PATTERNS` is a
 * substring table), so swapping which failure surfaces can swap a transient
 * verdict for a terminal one. So each rejection carries the order it was
 * CAPTURED in: a drain throws its pick with that order recorded in its
 * parent's {@link nestedCaptureOrders} map, and the parent keeps the smallest.
 * CAPTURED means the moment the first drain above a failure saw it, not the
 * moment its lookup failed: two failures inside one turn are ordered by how
 * many async layers each crossed to reach a drain, which is scheduling rather
 * than time, and the case file pins only failures a turn apart. The helper
 * STARTS the parts (`start`) so it can run them inside its own map's scope:
 * that is how a nested drain finds the one drain it throws to, and any other
 * drain receiving the same error object orders it by arrival. Where the
 * answer still differs from `Promise.all`'s: a drain the cap releases reports
 * the earliest it has RECEIVED, and an inner failure still held below it is
 * not among them; a layer that WRAPS an error between two drains drops the
 * order, and the wrapper is ordered by arrival.
 */
export async function allSettledKeepingFirstRejection<T>(
  start: () => readonly Promise<T>[],
  onAbandoned: (pending: number) => void
): Promise<T[]> {
  let rejection: { readonly error: unknown; readonly at: number } | undefined;
  // Where this drain's nested drains record their picks' capture orders, and
  // where this drain records its own, for its parent (issue #2805).
  const nestedOrders = new WeakMap<object, number>();
  const parentOrders = nestedCaptureOrders.getStore();
  const promises = nestedCaptureOrders.run(nestedOrders, start);
  // Unreachable through today's entry points: both public methods that reach
  // a drain open a store (`resolve`, `evaluateConditions`). A case in the
  // drain test reds when a public member reaches a drain without opening one
  // -- but only along the shape it walks, which is a `this.<identifier>(...)`
  // chain from THIS helper's call sites, over methods and callable fields. It
  // is a SYNTACTIC regression check and not a proof, on two axes: it asks
  // whether the member opens a budget somewhere in its body rather than
  // whether the resolution runs inside it, and an aliased receiver, a
  // `.bind`, an element-access call or a closure returned from a getter each
  // walk past it. That case enumerates them, measured. Kept as a fallback
  // because the alternative -- throwing -- would turn a fence miss into a
  // failed deploy, and a caller that somehow reached here should get the OLD
  // per-invocation bound rather than none. Never exercised by the suite:
  // instrumented across all of it, zero drains took it.
  const shared = drainDeadlines.getStore();
  // Armed by the FIRST rejection, so the cap measures the wait that a failure
  // caused rather than the resolution's own runtime: a slow but successful
  // pass is not on a clock.
  let armCap: (() => void) | undefined;
  // How many inputs have settled, so a release by the cap can say how many it
  // stopped waiting for (issue #2814).
  let settled = 0;
  const guarded = promises.map((promise) =>
    promise.then(
      (value) => {
        settled += 1;
        return value;
      },
      (error: unknown) => {
        settled += 1;
        // A primitive reads `undefined` from a `WeakMap`, so it needs no guard
        // here; the WRITE below does, since `set` throws on one.
        const recorded = nestedOrders.get(error as object);
        const at = recorded ?? (rejectionClock += 1);
        if (rejection === undefined) {
          rejection = { error, at };
          armCap?.();
        } else if (at < rejection.at) {
          rejection = { error, at };
        }
        // The value is never read: the throw below happens first whenever any
        // input rejected, and this cast keeps the settled-values type honest
        // for the caller rather than widening it to `T | undefined`.
        return undefined as unknown as T;
      }
    )
  );
  let capTimer: ReturnType<typeof setTimeout> | undefined;
  // Whether this drain took a share of the budget, so the `finally` knows to
  // release it. Not `capTimer !== undefined`: a drain with no store arms a
  // timer and charges nothing.
  let charged = false;
  const capped = new Promise<typeof CAP_EXPIRED>((resolve) => {
    armCap = () => {
      // A REMAINING budget, not a deadline. An absolute `at` spends the
      // budget by WALL CLOCK: ordinary resolution time between two drains
      // burns it although nothing drained, so in a wrapped loop an output
      // that failed with a 5 ms sibling could leave a later one with zero
      // grace after 60 s of clean AWS work. What the cap is supposed to
      // bound is total drain WAIT.
      const budget = concurrentDrainCap.ms ?? DRAIN_AFTER_REJECTION_MS;
      let wait = budget;
      if (shared !== undefined) {
        shared.remaining ??= budget;
        // `remaining` is only charged when the last waiter leaves, so a drain
        // arming while another is ALREADY waiting must subtract the part of
        // the open window that has run -- otherwise two staggered drains each
        // arm against the full remainder and keep extending the bound (drain
        // A at t=0 and B at t=80 of a 100 ms budget released at 100 and 180).
        const openWindow = shared.since === undefined ? 0 : Date.now() - shared.since;
        wait = Math.max(0, shared.remaining - openWindow);
        // Only the OUTERMOST waiting drain charges the budget. Nested drains
        // wait CONCURRENTLY -- an outer drain's wait contains its inner
        // one's -- so charging each would spend the budget once per level
        // and re-create the depth x cap shape one layer down.
        if (shared.waiting === 0) shared.since = Date.now();
        shared.waiting += 1;
        charged = true;
      }
      capTimer = setTimeout(() => resolve(CAP_EXPIRED), wait);
      // NOT `unref`'d, deliberately. The `finally` below clears the timer on
      // every exit from the race, so it is live only while something is
      // awaiting it — and an unref'd timer lets Node empty the loop and exit
      // 0 mid-deploy when the hung sibling holds nothing itself, which is
      // strictly worse than the hang this cap replaced. The unit suite
      // structurally cannot catch that: vitest's own loop holds the process
      // open regardless.
    };
  });
  try {
    const outcome = await Promise.race([Promise.all(guarded), capped]);
    // A bare re-throw of an error some OTHER site constructed, and the reason it
    // is safe is a CALLER's, not this line's.
    //
    // `allSettledKeepingFirstRejection` is a MODULE-SCOPE helper with no
    // `ResolverContext` parameter, so no secret bag is in scope here and masking
    // is not an option at all — which is the whole argument. What it is NOT: it
    // is not true that this runs "before any per-pass secret bag exists" (the
    // two call sites are mid-pass, which is what issue #2797 was about), and it
    // is not true that every error arriving here was built at a site the resolver's
    // coverage checker governs. The drained promises are `resolveValue`, which
    // reaches the dynamic-reference lookups. Since go-to-k/cdkd#3171
    // `sendWithThrottleRetry` rethrows an AWS rejection as a clone masked by
    // the request's names (an AccessDenied naming an `Fn::Sub`-assembled
    // SecretId included), so what arrives here from that route is already
    // masked. The downstream boundary masks stay as the layer for every other
    // error: `DeployEngine.handleOutputResolutionFailure` and the `cdkd import`
    // boundary (issues #2728 / #2803).
    if (rejection !== undefined) {
      // Inputs still running here means the CAP won the race: report them,
      // once per budget (issue #2814), so a failure that releases several
      // nested drains, or a wrapped loop whose later iterations find the
      // budget spent, warns once rather than once per drain. Counted now, not
      // when the timer fired: an input can settle in the turn between.
      const pending = promises.length - settled;
      if (pending > 0) {
        // Reported once per BUDGET. A drain with no store -- the fallback
        // above, which no public entry point reaches -- has no budget to key,
        // so it reports on its own rather than joining a set nothing could
        // ever look it up in again.
        if (shared === undefined) onAbandoned(pending);
        else if (!abandonReported.has(shared)) {
          abandonReported.add(shared);
          onAbandoned(pending);
        }
      }
      const { error, at } = rejection;
      if (parentOrders !== undefined && typeof error === 'object' && error !== null) {
        // The SMALLEST: two sibling drains can throw one memoized error object
        // in the same turn, before the parent has read either record.
        const earlier = parentOrders.get(error);
        parentOrders.set(error, earlier === undefined ? at : Math.min(earlier, at));
      }
      throw error;
    }
    // Narrowed rather than cast: winning the race without a rejection is
    // unreachable today, since only a rejection arms the cap — and an edit
    // that armed it elsewhere would otherwise hand a Symbol to the caller's
    // `resolvedValues.join(...)` with the compiler's blessing. Removing this
    // guard reds no TEST, and cannot: what it buys is a compile error, caught
    // by `vp run typecheck` over the src tree (`vp test`'s inline typecheck covers
    // test files only). That is the fence, not a missing case.
    if (outcome === CAP_EXPIRED) {
      // `markNonRetryable` even though this arm is documented unreachable:
      // if it ever fires, the retry classifiers read the message, and this
      // file's other deterministic refusals are marked the same way.
      throw markNonRetryable(new Error('drain cap expired with no rejection recorded'));
    }
    return outcome;
  } finally {
    if (capTimer !== undefined) clearTimeout(capTimer);
    if (charged && shared !== undefined) {
      shared.waiting -= 1;
      if (shared.waiting === 0 && shared.since !== undefined) {
        // Charge the wall clock spent while ANY drain under this budget was
        // waiting, which for overlapping waits is exactly the total drain
        // wait. Clean work between drains costs nothing.
        shared.remaining = Math.max(0, (shared.remaining ?? 0) - (Date.now() - shared.since));
        shared.since = undefined;
      }
    }
  }
}

/**
 * The key for the resolver's per-region SDK client caches ({@link
 * IntrinsicFunctionResolver}'s `cfnClients`, `regionScopedClients` and
 * `serviceDiscoveryClients`): the region PLUS the credential fingerprint of the
 * configuration the cached client was built from (issue
 * [#3588](https://github.com/go-to-k/cdkd/issues/3588)). Encoded through
 * {@link injectiveKey}, so no region or profile spelling can forge another
 * pair's key.
 */
export function clientCacheKey(region: string, credentialConfig: CredentialConfig): string {
  return injectiveKey(region, credentialFingerprint(credentialConfig));
}

/**
 * Is `region` safe to build an AWS SDK client from?
 *
 * This is a SECURITY gate, not an AWS region registry, and the distinction
 * decides how strict it is. The SDK turns a region into a hostname by
 * substitution — `https://ssm.{region}.amazonaws.com` — so a value carrying a
 * host delimiter escapes the label and re-points the endpoint: the measured
 * case is `evil.example.com#`, which yields
 * `https://ssm.evil.example.com/#.amazonaws.com` and sends a SigV4-SIGNED
 * request (access key id + signature) to an attacker-controlled host.
 *
 * The reachable input is `Fn::GetAZs`, whose argument is TEMPLATE-DERIVED and
 * can arrive through an `Fn::ImportValue` or a parameter — i.e. it is not
 * necessarily written by whoever runs the deploy. Before issue #1957 that value
 * only fed the `region-name` FILTER of a `DescribeAvailabilityZones` call and
 * never built a client, so binding lookups to a region is exactly what made it
 * reachable; the gate ships with the binding.
 *
 * So the predicate is CHARSET-based rather than shape-based: lowercase
 * alphanumerics and hyphens only, which cannot express `.`, `/`, `:`, `@`, `?`
 * or `#` and therefore cannot leave the hostname label. It deliberately does
 * NOT try to enumerate real regions — AWS keeps adding them
 * (`ap-southeast-7`, `il-central-1`, `mx-central-1`, `eusc-de-east-1`), and a
 * pattern tight enough to reject `----` would also reject the next one. A
 * region-shaped-but-nonexistent value is not a security problem: it resolves to
 * a hostname that does not exist and the SDK fails loudly.
 *
 * Note the sibling pattern in `src/cli/commands/state-file-keys.ts` is NOT
 * reusable here, and the reason is structural rather than a gap in its
 * coverage: it is SHAPE-based because its job is the opposite one — telling a
 * region segment apart from a stack name sitting in the same key position —
 * so it must enumerate the shape this predicate refuses to. (Its prefix was
 * exactly `^[a-z]{2}` until issue #2001, which is what made it reject the
 * European Sovereign Cloud partition's four-letter `eusc-de-east-1`; it now
 * takes `{2,4}`, and is still the wrong tool here.)
 *
 * Callers must {@link canonicalizeRegion} first — `US-EAST-1` is a documented
 * input and is lowercase-canonical, not invalid.
 */
export function isClientSafeRegion(region: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,30}$/.test(region);
}

/** Test seam for {@link FABRICATED_ACCOUNT_INFO_TTL_MS} expiry. */
export const accountInfoClock = { now: (): number => Date.now() };

/** The bounded fabricated-answer window, per credential identity (see {@link cachedAccountIdentities}). */
export const fabricatedAccountIdentities = new Map<
  string,
  { identity: CachedAccountIdentity; expiresAt: number }
>();

/**
 * The single in-flight lookup PER CREDENTIAL IDENTITY, so N concurrent callers
 * of one identity share ONE round trip, and a second identity never joins the
 * first's (issue #3660).
 *
 * The TTL above collapses SEQUENTIAL callers; this collapses PARALLEL ones
 * (PR review). `cdkd deploy --concurrency 10` resolves ten resources' intrinsics
 * at once, so without it an STS outage costs ten `GetCallerIdentity` calls —
 * each with the SDK's own 3-attempt retry — and ten identical warnings per
 * window. Cleared in a `finally` so a failure cannot wedge it.
 */
export const accountInfoInFlight = new Map<string, Promise<CachedAccountIdentity>>();

/**
 * Bumped by {@link resetAccountInfoCache}, so a lookup that was already in
 * flight cannot write the cache it was asked to forget.
 *
 * Without it the reset only cleared the SETTLED caches: an in-flight resolve
 * would land afterwards and re-populate `cachedAccountIdentities`, so the next
 * caller read the pre-reset account. That is the `*Once`-leak shape one layer
 * down — a later test silently inheriting an earlier one's answer — and the
 * reset's own comment already claimed to forget it.
 */
export let accountInfoGeneration = 0;

/**
 * Get AWS account information from STS, for the ACTIVE credential identity.
 *
 * `identityKey` is read FIRST and synchronously, and `resolveAccountIdentity`
 * reads `getAwsClients().sts` before its first `await`, so the key and the
 * client that answers come from ONE reading of the active clients (issue
 * #3660). Never log the key.
 */
export async function getAccountInfo(overrideRegion?: string): Promise<AwsAccountInfo> {
  const identityKey = credentialFingerprint(ambientCredentialConfig());
  const cached = cachedAccountIdentities.get(identityKey);
  if (cached) return accountInfoFor(cached, overrideRegion);

  // A fabricated answer inside its TTL is reused (see the constant above) —
  // WITHOUT promoting it to `cachedAccountIdentities`, so it still expires.
  const fabricated = fabricatedAccountIdentities.get(identityKey);
  if (fabricated && accountInfoClock.now() < fabricated.expiresAt) {
    return accountInfoFor(fabricated.identity, overrideRegion);
  }

  const pending = accountInfoInFlight.get(identityKey);
  if (pending) return accountInfoFor(await pending, overrideRegion);

  // NOTE the lookup is region-AGNOSTIC — it resolves the ACCOUNT, and every
  // caller's region is applied by `accountInfoFor` afterwards — so sharing one
  // in-flight promise across callers with different `overrideRegion`s is safe.
  // Since issue #1746 that is structural rather than a property to preserve:
  // `resolveAccountIdentity` takes no region at all.
  const inFlight = resolveAccountIdentity(identityKey);
  accountInfoInFlight.set(identityKey, inFlight);
  try {
    return accountInfoFor(await inFlight, overrideRegion);
  } finally {
    // Only clear the slot we still OWN. `resetAccountInfoCache` clears it too, so
    // a reset mid-flight lets a later caller install its own promise — an
    // unconditional clear here would drop THAT one and cost a redundant
    // `GetCallerIdentity`.
    if (accountInfoInFlight.get(identityKey) === inFlight) accountInfoInFlight.delete(identityKey);
  }
}

export async function resolveAccountIdentity(identityKey: string): Promise<CachedAccountIdentity> {
  const generation = accountInfoGeneration;
  const stillCurrent = (): boolean => generation === accountInfoGeneration;
  const logger = getLogger().child('IntrinsicFunctionResolver');
  // Read before the first `await`: the same reading `identityKey` was taken from.
  const awsClients = getAwsClients();
  const stsClient = awsClients.sts;

  try {
    const response = await stsClient.send(new GetCallerIdentityCommand({}));
    const accountId = response.Account || '123456789012';

    // A SUCCESSFUL call that carries no `Account` lands on the same hardcoded
    // id as the failure arm below, so it has to be flagged the same way (review
    // finding) — reachable against an emulated / non-AWS STS endpoint. Flagging
    // only the catch arm would leave the identical fabricated value unmarked on
    // the path that looks like it worked.
    const resolved: CachedAccountIdentity = {
      accountId,
      ...(response.Account ? {} : { fabricated: true }),
    };
    // Only a NON-fabricated answer is cached for the process (issue #1730,
    // mirroring `write-only-properties.ts`'s "only SUCCESSFUL lookups are
    // cached"): a fabricated id poisons every later caller in the run, and the
    // ARN-building consumers refuse on `fabricated`, so caching one turns a
    // single bad STS answer into a whole deploy that records no ARNs. A
    // fabricated one gets the short TTL above instead of nothing, so the retry
    // is bounded rather than per-call.
    if (!stillCurrent()) {
      // A reset landed while this lookup was in flight — return the answer to
      // our own caller but do NOT re-populate the cache it cleared.
    } else if (resolved.fabricated) {
      fabricatedAccountIdentities.set(identityKey, {
        identity: resolved,
        expiresAt: accountInfoClock.now() + FABRICATED_ACCOUNT_INFO_TTL_MS,
      });
    } else {
      cachedAccountIdentities.set(identityKey, resolved);
      fabricatedAccountIdentities.delete(identityKey);
    }
    // not-in-class(accountId): an AWS ACCOUNT ID from STS, never a resolved template value.
    logger.debug(`Retrieved AWS account info: ${accountId}`);
    return resolved;
  } catch (error) {
    // not-in-class(error instanceof Error ? error.message : String(error)): an STS GetCallerIdentity rejection -- `new GetCallerIdentityCommand({})` carries no parameters at all, so its message cannot echo a template value, and this helper is module scope with no ResolverContext to mask against.
    logger.warn(
      `Failed to get AWS account info from STS: ${error instanceof Error ? error.message : String(error)}, using defaults`
    );
    // Fallback to environment variables or defaults
    const fallback: CachedAccountIdentity = {
      accountId: process.env['AWS_ACCOUNT_ID'] || '123456789012',
      // Only when the id is the HARDCODED fallback. An `AWS_ACCOUNT_ID` the
      // operator supplied is a real answer to "which account", so flagging it
      // would make callers refuse a value that is fine.
      ...(process.env['AWS_ACCOUNT_ID'] ? {} : { fabricated: true }),
    };
    // A transient STS blip must not poison the rest of the run — see the
    // caching note on the success path. An operator-supplied `AWS_ACCOUNT_ID`
    // IS a real answer and is cached as one; a fabricated id gets the bounded
    // TTL so the retry does not fire on every single caller.
    if (!stillCurrent()) {
      // See the success arm: a reset invalidated this lookup's right to cache.
      return fallback;
    }
    if (fallback.fabricated) {
      // Guarded on the SAME identity's real answer so a late failure arm cannot
      // install a fabricated window over a real answer a concurrent call already
      // cached (PR review). Benign either way — the cached branch is read first —
      // but the invariant should be enforced rather than accidental.
      if (!cachedAccountIdentities.has(identityKey)) {
        fabricatedAccountIdentities.set(identityKey, {
          identity: fallback,
          expiresAt: accountInfoClock.now() + FABRICATED_ACCOUNT_INFO_TTL_MS,
        });
      }
    } else {
      cachedAccountIdentities.set(identityKey, fallback);
      fabricatedAccountIdentities.delete(identityKey);
    }
    return fallback;
  }
}

/**
 * Is a STORED `''` for this attribute a value the resource can never have —
 * so the flat lookup must read it as ABSENT and let the live arm run?
 *
 * Exactly one attribute qualifies today (issue #3097 review): an
 * `AWS::EC2::SecurityGroup`'s `VpcId`. Every security group lives in a VPC
 * (EC2-Classic retired 2022-08-15), so `''` can only be the pre-#3097
 * provider's copy of a template that declared no `VpcId` — and that record is
 * rewritten only by an `update()`, which a no-change deploy never issues, so
 * without this carve-out the stored `''` shadows the live arm for the life of
 * the record. The record itself stays `''` until the next update; only the
 * RESOLUTION changes.
 *
 * Deliberately NOT a general "`''` means absent" rule: #3077 records a settled
 * EC2 instance's missing public address as the KNOWN empty `''`
 * (CloudFormation's own answer), and that one must keep being served from
 * state rather than sent back to `DescribeInstances` on every resolution.
 * A new entry here needs the same argument — that `''` is IMPOSSIBLE for the
 * attribute, not merely unlikely.
 */
export function isImpossibleEmptyStoredAttribute(
  resourceType: string,
  attributeName: string,
  storedValue: unknown
): boolean {
  return (
    storedValue === '' && resourceType === 'AWS::EC2::SecurityGroup' && attributeName === 'VpcId'
  );
}

/**
 * Reset cached account info (useful for testing)
 */
export function resetAccountInfoCache(): void {
  cachedAccountIdentities.clear();
  // The bounded fabricated-answer window is part of the same cache and must
  // clear with it, or a test (or a later phase) would keep reading a fabricated
  // answer it just asked to forget.
  fabricatedAccountIdentities.clear();
  // Invalidate any lookup already in flight so its resolve cannot write the
  // caches this call just cleared.
  accountInfoGeneration += 1;
  // ...and so is the in-flight promise: a reset while a lookup is pending would
  // otherwise hand the next caller the identity this call asked to forget, and
  // the resolve arm would re-populate the cache AFTER the reset.
  accountInfoInFlight.clear();
  // Also reset AZ cache
  cachedAvailabilityZones.clear();
  // Resolved dynamic-reference VALUES are no longer cleared here: they live on
  // the resolver instance (issue #1933), so their lifetime already ends with
  // the stack / region context that chose the AWS clients behind the lookup.
  // The secret verdicts below are still process-global, hence still cleared
  // (issues #1901 / #1916) — keeping them would let a stale verdict decide
  // secret-ness for a reference this call just asked to forget.
  recordedSecretExpressions.clear();
  // Issue #2274's in-run recovery store shares this lifetime for the same
  // reason: it holds PLAINTEXT this process masked out of a producer's outputs,
  // and a test (or a later phase) that asks to forget the account's caches must
  // not keep serving a value from a run it just discarded.
  clearRecoverableMaskedOutputs();
  // The issue #2059 cross-stack associations are deliberately NOT cleared here,
  // and need no clearing at all: they are scoped to the resolution pass's own
  // `recordedSecretValues` bag through a `WeakMap`, so they die with it. A
  // module-level store cleared from here was the first shape, and is what let
  // one stack's expression be certified onto another stack's leaf.
  // Also reset the live-read attribute caches (EC2 instance, VPC default
  // security group, CloudFront domain name — issue #3096; security group VPC
  // — issue #3097).
  for (const key of Object.keys(cachedEc2InstanceAttributes)) {
    delete cachedEc2InstanceAttributes[key];
  }
  for (const key of Object.keys(cachedVpcDefaultSecurityGroups)) {
    delete cachedVpcDefaultSecurityGroups[key];
  }
  for (const key of Object.keys(cachedCloudFrontDomainNames)) {
    delete cachedCloudFrontDomainNames[key];
  }
  for (const key of Object.keys(cachedSecurityGroupVpcIds)) {
    delete cachedSecurityGroupVpcIds[key];
  }
}

/**
 * Does a constructed `Fn::GetAtt` answer embed the placeholder account id?
 *
 * The guard in `constructGuardedAttribute` used to test
 * `typeof value === 'string'` directly (issue #1746). Every account-bearing
 * branch of `constructAttribute` returns a string today — the only non-string
 * returns are the EC2 IPv6 CIDR LISTS, which carry no account — so that was
 * complete as written, but a future list-valued attribute embedding an account
 * would have slipped past silently with no test failing. Walking string arrays
 * (one level, which is the shape `constructAttribute` actually produces) closes
 * it now rather than at the moment someone adds one. A non-string, non-array
 * value is not account-bearing by construction and is left alone.
 *
 * EXPORTED for its own test: no `constructAttribute` branch returns an
 * account-bearing array today, so the array arm is unreachable through the
 * public resolver API and would ship unexercised otherwise.
 */
export function embedsAccountId(value: unknown, accountId: string): boolean {
  if (typeof value === 'string') return value.includes(accountId);
  if (Array.isArray(value)) {
    return value.some((entry) => typeof entry === 'string' && entry.includes(accountId));
  }
  return false;
}
