/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import {
  AMBIGUOUS_LATCH_TTL_MS,
  AmbiguousCreateLatch,
  type AmbiguousCreateWindow,
  createAttemptKey,
  setBounded,
} from '../ambiguous-create.js';
import { canonicalizeRegion } from '../../../utils/aws-partition.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';

/**
 * SDK Provider for AWS::S3::Bucket
 *
 * Uses S3 SDK directly instead of CC API for synchronous bucket creation.
 * S3's CreateBucket is synchronous - no polling needed, unlike CC API which
 * requires async polling (1s→1.5s→2.25s...) adding seconds per resource.
 */
/**
 * The bucket's real region as reported on an S3 error response, if present.
 *
 * S3 puts `x-amz-bucket-region` on the `BucketAlreadyOwnedByYou` 409 itself,
 * which is what lets the issue #2227 guard answer without a second API call.
 * Measured 2026-08-26 against a bucket in `us-west-2`: clients pinned to
 * `us-east-1`, `eu-west-1` and `ap-northeast-1` all received it. Both header
 * bags are read because only `$response.headers` was populated on those three
 * -- `$metadata.httpHeaders` was absent -- and the SDK is not consistent about
 * which one carries headers across error paths.
 *
 * The lookup is per-KEY across both bags, not a `??` between the bags
 * themselves: selecting a bag would pick an EMPTY `$response.headers` over a
 * populated `$metadata.httpHeaders`, so a future SDK that attaches both would
 * silently lose the header. Missing it only costs the `GetBucketLocation`
 * fallback (the guard still fails closed), but the cost is avoidable.
 */
export function readBucketRegionHeader(error: unknown): string | undefined {
  const candidate = error as {
    $response?: { headers?: Record<string, unknown> };
    $metadata?: { httpHeaders?: Record<string, unknown> };
  };
  const value =
    candidate?.$response?.headers?.['x-amz-bucket-region'] ??
    candidate?.$metadata?.httpHeaders?.['x-amz-bucket-region'];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * The region a `GetBucketLocation` answer denotes, canonicalized.
 *
 * Two legacy wire shapes, both original to the S3 API and both still returned,
 * which is why this is a function rather than a field read:
 *
 *  - a bucket in `us-east-1` answers with an EMPTY / null `LocationConstraint`.
 *    Absent therefore means `us-east-1`, NEVER "unknown" -- treating it as
 *    unknown and failing closed would refuse correct deploys in the commonest
 *    region. Measured 2026-08-26: `get-bucket-location` on a us-east-1 bucket
 *    returns `{"LocationConstraint": null}`. `src/utils/aws-region-resolver.ts`
 *    folds the same quirk the same way.
 *  - `EU` is a legacy alias for `eu-west-1`, matching the fold that
 *    `src/cli/commands/state.ts` already applies.
 */
export function bucketLocationToRegion(constraint: string | null | undefined): string {
  const value = canonicalizeRegion((constraint ?? '').trim());
  if (value === '') return 'us-east-1';
  if (value === 'eu') return 'eu-west-1';
  return value;
}

/**
 * go-to-k/cdkd#4606: the skip reason of a failed CREATE's orphan bucket that
 * is not empty, which `delete()` never empties. A FIXED constant, plain prose
 * without the already-deleted phrases (`.claude/rules/provider-delete-path.md`).
 */
export const FAILED_CREATE_ORPHAN_NOT_EMPTY_SKIP_REASON =
  'the bucket a failed create left behind is not empty, and cdkd never empties such a bucket: ' +
  'something wrote to it after that create, so it may hold data or have been adopted by ' +
  'another deployment. Empty and delete it yourself if it is not in use';

/** `deleteBucketWithEmptyRetry`'s refusal of a non-empty bucket it may not empty. */
export class BucketNotEmptyRefusal extends Error {
  override name = 'BucketNotEmptyRefusal';
}

/**
 * A DNS-compatible general purpose bucket name (3-63 of `a-z 0-9 . -`,
 * starting and ending alphanumeric). The identity answers (`isSameResource`, `resourceIdentity`) refuse
 * anything else: a legacy mixed-case name, an ARN, a value cdkd would only
 * be guessing about.
 */
export function isPlainBucketName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value);
}

/**
 * `ListBuckets` can lag a bucket created moments ago, which is when a failed
 * CREATE's identity is read: re-read it this many times, this far apart,
 * well inside the caller's 10s bound (`RESOURCE_IDENTITY_TIMEOUT_MS`).
 */
export const BUCKET_LIST_IDENTITY_ATTEMPTS = 3;
export const BUCKET_LIST_IDENTITY_DELAY_MS = 1_500;
export const BUCKET_LIST_IDENTITY_BUDGET_MS = 6_000;

/**
 * go-to-k/cdkd#4969: `HeadBucket` can answer 404 for a bucket `CreateBucket`
 * made a moment ago. The deploy's observed capture reads right after cdkd's own
 * write (`afterOwnWrite`), and a 404 there would discard the drift baseline.
 * Before tags rode `CreateBucket`, the `PutBucketTagging` call sat between the
 * two and hid the race. The capture is off the dependency path, so no other
 * resource waits on it; only the final state save does, at most ~2s, and only
 * when `HeadBucket` lags.
 */
export const OWN_WRITE_HEAD_ATTEMPTS = 5;
export const OWN_WRITE_HEAD_DELAY_MS = 500;

/**
 * Whether an error from `GetBucketLocation` means "no bucket of that name".
 *
 * The test is the wire error CODE, which the SDK lifts onto `name`.
 *
 * An earlier revision of this comment said `GetBucketLocation` does NOT
 * deserialize its 404 into the modeled `NoSuchBucket` class "the way
 * `DeleteBucket`'s is", inferring that from `GetBucketLocationCommand.d.ts`
 * declaring only `@throws {@link S3ServiceException}`. That inference is
 * FALSE and was measured false on 2026-08-26 by feeding canned 404 XML through
 * the real client: both operations yield `ctor=NoSuchBucket`,
 * `name=NoSuchBucket`, `instanceof NoSuchBucket === true`, `status=404`.
 * `DeleteBucketCommand.d.ts` declares the same lone `S3ServiceException`, and
 * the deserializer resolves errors through a per-NAMESPACE schema registry
 * (`client-s3/dist-cjs/schemas/schemas_0.js`), not a per-operation one — so
 * the command's declared throw list never decided this. The PREDICATE was
 * right for the wrong reason; the reason is corrected rather than quietly
 * dropped, because the wrong one would have justified the wrong fixture in the
 * next provider that copied it.
 *
 * There is deliberately no `instanceof NoSuchBucket` arm. The generated class
 * assigns `name = 'NoSuchBucket'` on the instance
 * (`@aws-sdk/client-s3/dist-es/models/errors.js`), so every instance already
 * satisfies the check below: it would be an arm no case could ever make
 * decide, and a branch nothing can make decide is a branch nothing protects.
 *
 * A BARE HTTP 404 is deliberately NOT accepted, and this is the one place the
 * predicate is narrower than "the resource is missing". On the create path
 * `absent` is the answer that ENABLES the partial-create cleanup's
 * `DeleteBucket`, so anything that can 404 without S3 having said
 * `NoSuchBucket` — a corporate proxy, an `AWS_ENDPOINT_URL` override, an
 * S3-compatible gateway — would otherwise license a delete on the strength of
 * a response S3 never sent. Narrowing costs only that such a 404 becomes
 * `indeterminate`, and every caller's `indeterminate` branch is the
 * non-destructive one.
 *
 * Everything else — 403 from a bucket owned by another account, a throttle, a
 * network fault — is likewise NOT absence. Folding those into "absent"
 * is what would let a probe failure re-authorize the destructive branch each
 * caller below is guarding.
 */
export function isNoSuchBucketError(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'NoSuchBucket';
}

/**
 * The bucket's region as reported on an error's own `x-amz-bucket-region`
 * header, canonicalized — the free answer, requiring no second round trip.
 *
 * Shared by {@link S3BucketProvider.resolveOwnedBucketRegion} (reading the
 * `BucketAlreadyOwnedByYou` 409) and {@link S3BucketProvider.probeBucketRegion}
 * (reading a FAILED probe), so the header-then-canonicalize pair has one
 * spelling rather than two that can drift apart.
 */
export function regionFromErrorHeader(error: unknown): string | undefined {
  const fromHeader = readBucketRegionHeader(error);
  // `canonicalizeRegion` is defensive rather than load-bearing, and that is
  // worth stating so nobody spends a probe on it: it is only `toLowerCase`, S3
  // emits `x-amz-bucket-region` lowercase, and the `EU` legacy fold lives in
  // `bucketLocationToRegion` (which IS fenced). Removing it reddens nothing
  // because no producible header reaches it in another case -- kept for the
  // same reason the deploy-side comparison folds, since the cost is one call
  // and the failure it would prevent is a silent region mismatch.
  return fromHeader ? canonicalizeRegion(fromHeader) : undefined;
}

/**
 * Whether this error's `x-amz-bucket-region` describes the BUCKET rather than
 * the endpoint that answered.
 *
 * The distinction is the whole value of the header, and reading it off any
 * failure throws it away. Only two failure shapes are S3 telling you where the
 * BUCKET is: the 301 cross-region redirect (`PermanentRedirect`) and
 * `AuthorizationHeaderMalformed`, which is the SigV4 region mismatch reporting
 * the region you should have signed for. Every other failure -- a 403 for a
 * bucket the caller cannot see, a throttle, a 404 -- is answered by the
 * endpoint that was ASKED, so its header names the region the QUESTION went to.
 * That is the same property that already orders the absence check first in
 * {@link S3BucketProvider.probeBucketRegion}; this gate applies it to the rest
 * of the failure space instead of to `NoSuchBucket` alone.
 *
 * Accepting an endpoint-region header as the bucket's answer inverted both
 * guards built on top of it: on delete a 403 whose header echoed the deploy's
 * own region compared EQUAL and returned silently, which is exactly the hostile
 * bucket-policy `Deny` population {@link
 * S3BucketProvider.announceUnverifiedBucketIdentity} exists for; on create it
 * promoted an unanswerable probe to "the bucket is already there", producing a
 * false ADOPTED-and-ACLs-reset warning over a genuinely new bucket and
 * suppressing the orphan cleanup with no warning at all.
 *
 * Matched on the wire error CODE alone, never on an HTTP STATUS. An earlier
 * revision also accepted a bare `httpStatusCode === 301`, which is the same
 * defect {@link isNoSuchBucketError} was narrowed to close: a status S3 never
 * NAMED is not S3 speaking. A proxy, an `AWS_ENDPOINT_URL` override or an
 * S3-compatible gateway answering 301 with an `x-amz-bucket-region` of the
 * deploy's own region would have made `probe.region` compare EQUAL, and the
 * delete guard would have returned silently -- the same silent pass the 403
 * arm above was removed for, arriving through the status instead of the header.
 * Unreachable against real S3, since the redirect always carries the code, so
 * dropping the arm costs nothing and the shape stops being expressible.
 *
 * The `BucketAlreadyOwnedByYou` 409 is a THIRD region-bearing shape (measured
 * for issue #2227) and is deliberately absent here: `GetBucketLocation` cannot
 * return it, and the create path reads it through
 * {@link S3BucketProvider.resolveOwnedBucketRegion}'s explicit error argument,
 * which never routes through this gate.
 */
export function carriesBucketRegionHeader(error: unknown): boolean {
  const candidate = error as { name?: unknown } | null;
  if (candidate?.name === 'PermanentRedirect') return true;
  return candidate?.name === 'AuthorizationHeaderMalformed';
}

/**
 * What a pre-flight region probe of a bucket NAME can conclude.
 *
 * Three outcomes rather than a region-or-undefined, because the two failure
 * shapes license opposite things and collapsing them is the bug this type
 * exists to prevent: `absent` is a POSITIVE answer from S3 (the name is free),
 * while `indeterminate` means the probe could not answer at all. A caller that
 * treated the second as the first would re-authorize exactly the destructive
 * branch it was probing to avoid.
 */
export type BucketRegionProbe =
  | { readonly kind: 'absent' }
  | { readonly kind: 'region'; readonly region: string }
  | {
      readonly kind: 'indeterminate';
      /**
       * AWS's own message. Debug-level ONLY.
       *
       * The invariant holds across EVERY reader, not just the one that
       * motivated it, and it has already been broken once by fixing a single
       * consumer: there are two -- {@link S3BucketProvider.assertStateBucketRegion}
       * (update / delete) and the `us-east-1` create path's partial-cleanup
       * arm -- and the first fix left the second printing the identical string
       * to the identical sink. If a third appears, `grep -rn '\.reason\b'`
       * over this file is the check; reading the diff is not.
       */
      readonly reason: string;
      /**
       * The error CLASS, which is the half that is safe to print at default
       * verbosity.
       */
      readonly errorName: string;
    };

/**
 * Why the cross-region identity guard did not run, and what the operator can
 * do about THAT cause specifically.
 *
 * Two causes, not one, and they need different remedies: a probe that could not
 * answer (fix the permission, or retry) and a state record that never carried a
 * region to check against (re-deploy so the record gains one). Telling a user
 * with a pre-v2 record to grant `s3:GetBucketLocation` sends them to fix
 * something that is not wrong.
 */
export interface UnverifiedIdentityCause {
  /** Completes "Could not confirm which bucket X is before delete: ...". */
  readonly why: string;
  /** A full sentence naming the action that would make the guard run. */
  readonly remedy: string;
}

/** The probe was issued and could not answer. */
export function probeFailedCause(errorName: string): UnverifiedIdentityCause {
  return {
    // The error CLASS, never AWS's message. On the headline population for this
    // whole warning -- a bucket policy denying `s3:GetBucketLocation` -- S3's
    // text reads `User: arn:aws:sts::<account>:assumed-role/<role>/<session> is
    // not authorized to perform: s3:GetBucketLocation on resource: ...`, so
    // interpolating it printed an account id, a role name and a session name to
    // the terminal and to CI logs for exactly the cohort the warning was added
    // to serve. Making the guard visible must not make the caller visible.
    //
    // Terminal-only (this line is never thrown and never persisted, so the
    // issue #2179 redaction surface is not in play) -- but there is no reason
    // to print it, and `dynamodb-index-busy-delete.ts` already answered this
    // class the same way: class at default verbosity, AWS's own text at debug.
    why: `the GetBucketLocation identity check failed (${errorName})`,
    remedy:
      `Re-run with --verbose for AWS's own message. Re-run the destroy once the check can ` +
      `succeed, or grant s3:GetBucketLocation on the bucket (a bucket policy can Deny it), to ` +
      `have the guard verify the target first.`,
  };
}

/**
 * No probe was issued, because the state record names no region to check
 * against.
 *
 * `DeleteContext.expectedRegion` is absent exactly for a record written before
 * the region-keyed state layout, and `destroy-runner` omits the field rather
 * than inventing one. That cohort is the one MOST likely to predate the issue
 * #2227 create-path guard, so it is the likeliest carrier of a foreign-region
 * physical id -- and until this cause existed it was the one population that
 * got no probe, no warning and no debug line, i.e. the highest-risk shape with
 * the quietest output.
 *
 * Warn only. Refusing here would strand every legacy destroy with no IAM
 * remedy at all -- strictly worse than the stranding the guard already declines
 * to impose -- and defaulting `expectedRegion` to the client region in
 * `destroy-runner` would fabricate an expectation the record never made AND
 * change `assertRegionMatch` on the `NoSuchBucket` path, a far wider blast
 * radius than this.
 */
export function noRecordedRegionCause(): UnverifiedIdentityCause {
  return {
    why: `this state record carries no region, so there was nothing to check the bucket's location against`,
    remedy:
      `This record predates cdkd's region-keyed state layout. Re-deploy the stack to write a ` +
      `record that carries its region, or confirm the bucket's location yourself, to have the ` +
      `guard run on the next destroy.`,
  };
}

/**
 * "An earlier attempt at this `CreateBucket` ended ambiguous" (issue #4639).
 * Module-scoped, like the other latches: a provider instance is per registry,
 * and `create()` runs on a per-call view of it.
 */
export const createBucketLatch = new AmbiguousCreateLatch('CreateBucket');

/**
 * A window an attempt took from {@link createBucketLatch} but ended WITHOUT
 * the oracle's verdict on (issue #4639). Here `CreateBucket` itself is the
 * oracle -- a fresh 200, `BucketAlreadyOwnedByYou` or `BucketAlreadyExists`
 * -- so an attempt that failed some other way (an `OperationAborted`, a
 * `SlowDown` that outlasted the SDK's retries, a throttled `GetBucketLocation`
 * in the owned-bucket arm) leaves the question open, and the engine's next
 * attempt must still see the window. The latch re-arms only on an AMBIGUOUS
 * error, so the window is held here, keyed and aged like the latch.
 */
export const heldCreateBucketWindows = new Map<
  string,
  { window: AmbiguousCreateWindow; heldAtMs: number }
>();

/** The latch's window merged with one an earlier attempt held; both cleared. */
export function takeCreateBucketWindow(logicalId: string): AmbiguousCreateWindow | undefined {
  const latched = createBucketLatch.take(logicalId);
  const key = createAttemptKey('CreateBucket', logicalId);
  const held = heldCreateBucketWindows.get(key);
  heldCreateBucketWindows.delete(key);
  const kept =
    held !== undefined && Date.now() - held.heldAtMs <= AMBIGUOUS_LATCH_TTL_MS
      ? held.window
      : undefined;
  if (latched === undefined) return kept;
  if (kept === undefined) return latched;
  return {
    floorMs: Math.min(latched.floorMs, kept.floorMs),
    ceilingMs: Math.max(latched.ceilingMs, kept.ceilingMs),
  };
}

export function holdCreateBucketWindow(logicalId: string, window: AmbiguousCreateWindow): void {
  setBounded(heldCreateBucketWindows, createAttemptKey('CreateBucket', logicalId), {
    window,
    heldAtMs: Date.now(),
  });
}

/**
 * go-to-k/cdkd#4758: the bucket an attempt of THIS create made and could not
 * clean up (its wiring failed, then its `DeleteBucket` too), recorded so the
 * engine's retry of the same create can tell that bucket from any other
 * holder of the explicit name. Without it the retry's `CreateBucket` answers
 * `BucketAlreadyOwnedByYou` and the explicit-name refusal (go-to-k/cdkd#4684)
 * fails a deploy the retry would have finished.
 *
 * `identity` is {@link S3BucketProvider.resourceIdentity}'s token, read when
 * the attempt failed: after its last write, so the `CreationDate` S3 moves on
 * a configuration write outside us-east-1 is the one the retry reads again,
 * since nothing writes to the bucket in between. Taken once, by the next
 * attempt; keyed and aged like {@link heldCreateBucketWindows}. Never
 * journaled: the deploy engine journals the same bucket from the
 * created-before-failure mark.
 */
export const ownLeftoverBuckets = new Map<string, { identity: string; heldAtMs: number }>();

export function holdOwnLeftoverBucket(logicalId: string, identity: string): void {
  setBounded(ownLeftoverBuckets, createAttemptKey('CreateBucket', logicalId), {
    identity,
    heldAtMs: Date.now(),
  });
}

/**
 * go-to-k/cdkd#4758: the bound on each identity read for the own-leftover
 * record, as the deploy engine bounds its orphan identity read
 * (`RESOURCE_IDENTITY_TIMEOUT_MS`).
 */
export const OWN_LEFTOVER_IDENTITY_TIMEOUT_MS = 10_000;

/** The `CreationDate` part of a {@link S3BucketProvider.resourceIdentity} token. */
export function tokenDate(token: string): string {
  return token.slice(token.lastIndexOf('|') + 1);
}

/** The record an earlier attempt of this create held, cleared either way. */
export function takeOwnLeftoverBucket(logicalId: string): string | undefined {
  const key = createAttemptKey('CreateBucket', logicalId);
  const held = ownLeftoverBuckets.get(key);
  ownLeftoverBuckets.delete(key);
  return held !== undefined && Date.now() - held.heldAtMs <= AMBIGUOUS_LATCH_TTL_MS
    ? held.identity
    : undefined;
}

/** Reset the module-scoped `CreateBucket` retry state. TEST-ONLY. */
export function resetS3BucketCreateRetryStateForTests(): void {
  createBucketLatch.resetForTests();
  heldCreateBucketWindows.clear();
  ownLeftoverBuckets.clear();
}

/**
 * True when a `CreateBucket` that carried tags was refused for lacking
 * `s3:TagResource` (go-to-k/cdkd#4969). Measured wording, from a session
 * allowed `s3:CreateBucket` + `s3:PutBucketTagging` only: `AccessDenied` with
 * "... is not authorized to perform: s3:TagResource on resource: ...". Read off
 * the RAW SDK error (the create's own catch, before any wrap redacts it).
 */
export function isCreateTagResourceDenial(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'AccessDenied' &&
    describeAwsFailure(error).detail.includes('s3:TagResource')
  );
}

/**
 * True when S3 refused a `CreateBucket` for the SHAPE of the request it
 * carried tags in, rather than for the caller (go-to-k/cdkd#4969): a region or
 * partition whose endpoint does not take `CreateBucketConfiguration.Tags`
 * (the file already handles partitions whose CreateBucket surface lags, see
 * the `LocationConstraint` note in `create()`). Not measured -- every
 * commercial region probed accepts the member -- so it is keyed narrowly on
 * the request-shape refusals S3 documents: `MalformedXML` and `NotImplemented`
 * outright (the only XML this create adds over the untagged one is `Tags`), and
 * `InvalidArgument` / `InvalidRequest` only when the message names a tag.
 * `InvalidTag` (a bad key or value) is NOT here: the untagged path's
 * `PutBucketTagging` would refuse the same tag. Classification only; the text
 * is never printed.
 */
export function isCreateTagsShapeRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'MalformedXML' || error.name === 'NotImplemented') return true;
  return (
    (error.name === 'InvalidArgument' || error.name === 'InvalidRequest') &&
    /\btags?\b/i.test(describeAwsFailure(error).detail)
  );
}

/**
 * A tagged create's `s3:TagResource` denial whose untagged re-send met an
 * EXPLICIT deny (go-to-k/cdkd#4969): the policy type that denied the re-send
 * (a fixed constant, or `null` when unnamed), keyed on the tagged error the
 * create rethrows, so the wrap can name both causes.
 */
export const untaggedExplicitDeny = new WeakMap<object, string | null>();
