import { isAwsAuthoredFailure } from '../../utils/aws-failure-text.js';
import { MAX_CAUSE_CHAIN_DEPTH } from './marks.js';
import { NAME_COOLDOWN_ERROR_MESSAGE_PATTERNS } from './patterns.js';

/**
 * An `…AlreadyExists` error CODE as a whole token (`EntityAlreadyExists`,
 * `ResourceAlreadyExistsException`, `DBInstanceAlreadyExistsFault`). The
 * singular `…AlreadyExist` stays unmatched (see below); the one real code
 * spelled so, `SubscriptionAlreadyExistFault`, states the collision in prose.
 * A bare substring matched INSIDE an
 * identifier too (issue #3816): a logical id like `UserAlreadyExistsHandler…`
 * sits in every provider wrapper and in every cdkd-derived physical name AWS
 * echoes, so an unrelated failure — even Lambda's PENDING-state conflict
 * quoting the function ARN — read as a collision. A token right after `-`, `:`
 * or `/`, or right before `-`, is part of a name or ARN and is refused.
 * RESIDUAL: an unhashed logical id ENDING in the token, relayed after a space
 * by a provider wrapper, still matches there.
 */
const ALREADY_EXISTS_CODE = /(?<![-:/])\b[A-Za-z0-9]*AlreadyExists(?:Exception|Fault)?\b(?!-)/;

/**
 * Match the "already exists" name-collision signature raised when a create
 * targets a physical name still held by another resource (or by the same
 * name's not-yet-released tombstone after an async delete).
 *
 * Deliberately NOT part of {@link RETRYABLE_ERROR_MESSAGE_PATTERNS}: a name
 * collision is only worth retrying at the specific re-create sites that just
 * deleted the old holder (the deploy engine's --replace delete-first fallback
 * and the rollback executor's reverse-replacement) — everywhere else it is a
 * genuine conflict that must fail fast. Shared by those sites' collision
 * detection + retry filters so a signature extension lands in one place.
 *
 * The optional `s` is load-bearing, not defensive spelling (issue #1625):
 * Lambda's `CreateFunction` raises `ResourceConflictException: Function
 * already exist: <name>` — SINGULAR — so the `already exists` form missed it
 * entirely and NO Lambda function could take the collision path. The
 * consequence was not a cosmetic message: a property-driven replacement of a
 * Lambda (dropping `DurableConfig`, changing `TenancyConfig`) create-firsts
 * into its own still-live name, the raw `ResourceConflictException` escaped
 * instead of the actionable `NAMED_REPLACEMENT_COLLISION` error, and
 * `cdkd deploy --replace`'s delete-first fallback never fired — so the
 * replacement was unperformable by any flag. Verified against real AWS
 * (us-east-1, 2026-08-12) by creating one function name twice.
 *
 * Two fences keep the widened arm from crediting a NON-collision, which
 * matters because the sites that consult it react DESTRUCTIVELY (the
 * `--replace` delete-first fallback deletes the old resource):
 *  - `\b` after `exists?` rejects a participle ("already existed as a draft");
 *  - the lookbehind rejects a NEGATED or MODAL phrase — "the bucket does NOT
 *    already exist", "the destination bucket MUST already exist" — which the
 *    bare pattern matched. The modal form is the one that bites: a create
 *    rejected for a missing PREREQUISITE would be reported to the user as a
 *    name collision pointing at `--replace`, and following that advice
 *    deletes the live old resource before the re-create fails again for the
 *    same reason, leaving it absent from AWS with state still recording it.
 * The error-CODE arm stays exact (`AlreadyExists`): the singular
 * `AlreadyExist` is not an AWS code spelling, and loosening it would match
 * inside unrelated identifiers.
 *
 * Classification stays MESSAGE-based rather than moving to the exception
 * NAME, and that is load-bearing here rather than inherited: Lambda raises
 * `ResourceConflictException` for a function in a PENDING state too (see
 * `lambda-function-provider.ts`), so keying on the name would classify a
 * transient state conflict as a collision and delete a live function under
 * `--replace`.
 */
export function isNameCollisionError(message: string): boolean {
  return (
    /(?<!\b(?:must|not|should|may|cannot)\s)already exists?\b/i.test(message) ||
    ALREADY_EXISTS_CODE.test(message)
  );
}

/**
 * SDK exception NAMES that mean, on their own, "a resource with this NAME
 * already exists" — nothing else (issue
 * [#3208](https://github.com/go-to-k/cdkd/issues/3208)).
 *
 * This list is the NARROW exception to the paragraph above, not a reversal of
 * it. That paragraph refuses name-based classification because a name like
 * `ResourceConflictException` is AMBIGUOUS — Lambda raises it for a function in
 * a PENDING state too, so crediting it would delete a live function under
 * `--replace`. Every name here is the opposite: the service declares it for the
 * duplicate-name condition and for nothing else, so there is no second reading
 * to be wrong about. A name may join this list only on that test.
 *
 * It exists because ELBv2 states the condition in prose that the message
 * matcher above cannot see, and must not be widened to see. MEASURED against
 * the real API (us-east-1, 2026-09-16, `@aws-sdk/client-elastic-load-balancing-v2`
 * 3.1126.0), creating a second target group under a live name:
 *
 *   name    = 'DuplicateTargetGroupNameException'
 *   message = "A target group with the same name 'x' exists, but with
 *              different settings"
 *   cause   = none
 *
 * The message carries no code and never says "already exists", so
 * `isNameCollisionError` misses it — and the consequence is not cosmetic: the
 * `--replace` delete-first fallback and the rollback executor's
 * delete-new-first arm both gate on that predicate, so BOTH recovery paths went
 * inert and a create-only change to a cdkd-named target group could not be
 * deployed at all. Widening the prose matcher to a bare `exists` was rejected:
 * it is substring-matched against every service's text, and the direction of a
 * false positive here is a DELETE.
 *
 * The SET is complete rather than illustrative: `Duplicate*NameException` over
 * every installed `@aws-sdk/client-*` model yields exactly these three, all
 * ELBv2. Two ELBv2 siblings are deliberately EXCLUDED, and the reasons are the
 * membership test in action — `DuplicateListenerException` reports a listener
 * already bound to that PORT, which is not a name, and
 * `DuplicateTagKeysException` reports repeated keys WITHIN one request, which
 * is not an existence condition at all. Crediting either would hand a
 * destructive path a collision that no delete can clear.
 */
export const NAME_COLLISION_ERROR_NAMES: ReadonlySet<string> = new Set([
  // MEASURED live; see the block above.
  'DuplicateTargetGroupNameException',
  // Declared by the same client's model for the same condition
  // (`CreateLoadBalancer` / `CreateTrustStore`). Not reproduced live — an ALB
  // and a trust store cost minutes and dollars to collide on purpose — so they
  // are included on the model's word. That is the safe direction: a name the
  // service never raises is INERT, while omitting one that it does raise
  // re-opens exactly the defect this closes.
  'DuplicateLoadBalancerNameException',
  'DuplicateTrustStoreNameException',
]);

const NAME_COLLISION_MARKER = Symbol.for('cdkd.nameCollision');

/**
 * Declare a provider-built error a NAME collision (#3812 x #3816). For a
 * refusal whose AWS text states the conflict without "already exists" (Route
 * 53's CNAME-beside-a-record), a provider that has recognised it STRUCTURALLY
 * says so here rather than in prose: `isNameCollisionErrorFrom` no longer
 * credits cdkd-authored text, which can quote a template value. A
 * non-enumerable own symbol, like `markNonRetryable`'s, so it survives
 * `maskSecretsInError`'s clone and never serializes.
 */
export function markNameCollision<E extends Error>(error: E): E {
  if (!Object.isExtensible(error)) return error;
  Object.defineProperty(error, NAME_COLLISION_MARKER, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return error;
}

const REPLAY_MAY_COLLIDE_MARKER = Symbol.for('cdkd.replayMayCollide');

/**
 * Declare that `error` was thrown by a retry sequence whose EARLIER attempt may
 * have materialized the resource (issue
 * [#3978](https://github.com/go-to-k/cdkd/issues/3978)), so an "already exists"
 * in it can be the resource colliding with ITSELF. Stamped by `withRetry`
 * beside `markAuxiliaryFailure`, and needed because that mark cannot land on
 * every chain: it writes the first link WITHOUT its own `logicalId`, and a
 * Cloud Control `CloudControlOperationFailedError` carries the owner's id and
 * no `cause`, so its `ccErrorCode: 'AlreadyExists'` stayed credited. Same for
 * a provider wrapper stamped with {@link markNameCollision}.
 *
 * Read by {@link isNameCollisionErrorFrom}, ahead of its anchor, at every
 * link -- `deploy-engine.ts` re-wraps a provider failure, so the stamped error
 * can sit below the top -- and, the other way round, by the advice-only
 * {@link isReplayedNameCollisionFrom} (#3984). Deliberately NOT read by
 * {@link isUpdateUnsupportedError}: withholding a collision's delete-first is
 * the point, and widening the update-path cost `withRetry` accepts is not.
 *
 * A non-enumerable own symbol, like {@link markNonRetryable}'s: it survives
 * `maskSecretsInError`'s clone and never serializes. Never throws. A
 * non-extensible error is returned UNSTAMPED, so a frozen collision thrown
 * after an ambiguous attempt stays credited -- a residual, not wrapped away,
 * because a fresh wrapper would change the thrown error's class for every
 * `instanceof` reader; nothing in `src/` freezes, seals or
 * `preventExtensions` an error today.
 *
 * Deliberately NOT anchored to a logical id: a stamp anywhere in the chain
 * withholds the verdict, which can only err toward not deleting.
 */
export function markReplayMayCollide<E>(error: E): E {
  try {
    if (
      (typeof error !== 'object' && typeof error !== 'function') ||
      error === null ||
      !Object.isExtensible(error)
    ) {
      return error;
    }
    Object.defineProperty(error, REPLAY_MAY_COLLIDE_MARKER, {
      value: true,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  } catch {
    // Unstampable (a Proxy trap, say): returned as is. `withRetry`'s `catch`
    // calls this, where an out-throw would replace the error being settled.
  }
  return error;
}

/**
 * True when `error` or a link of its bounded `cause` chain carries
 * {@link markReplayMayCollide}'s stamp. Never throws: an unreadable chain reads
 * as unstamped, since `withRetry`'s `catch` calls it too.
 */
export function hasReplayMayCollide(error: unknown): boolean {
  try {
    let current: unknown = error;
    for (
      let depth = 0;
      depth < MAX_CAUSE_CHAIN_DEPTH &&
      (typeof current === 'object' || typeof current === 'function') &&
      current !== null;
      depth++
    ) {
      if (Object.getOwnPropertyDescriptor(current, REPLAY_MAY_COLLIDE_MARKER)?.value === true) {
        return true;
      }
      current = (current as { cause?: unknown }).cause;
    }
  } catch {
    // Unreadable chain: unstamped.
  }
  return false;
}

/**
 * {@link isNameCollisionError}, but reading the ERROR rather than a rendered
 * message — which is the only way to see an exception NAME (issue #3208).
 *
 * Walks the bounded `cause` chain (the same {@link MAX_CAUSE_CHAIN_DEPTH} as
 * every other classifier in this file). Three signals, each read off a link:
 *
 *  - `name` in {@link NAME_COLLISION_ERROR_NAMES};
 *  - a provider's `markNameCollision` on a link;
 *  - `ccErrorCode === 'AlreadyExists'` — the Cloud Control handler code a
 *    `CloudControlOperationFailedError` carries (the same code
 *    `cleanupFailedCreateRemnant` already trusts). It needs no top-level
 *    relay: the code is AWS's, and no provider rewords a Cloud Control
 *    failure to opt out today;
 *  - the "already exists" prose, credited only when BOTH the top-level message
 *    AND an AWS-authored link (`isAwsAuthoredFailure`: `$fault` or an HTTP
 *    status — bare `$metadata` is not proof, the retry middleware stamps it on
 *    socket errors too) say it (issue #3816). The SDK half keeps a cdkd
 *    refusal quoting a template value from classifying — the verdict here is
 *    a DELETE, acted on by the `--replace`
 *    delete-first fallback and the rollback's delete-new-first arm. The
 *    top-level half keeps a provider's opt-out: one that rewords an AWS
 *    collision it knows delete-first cannot clear (Glue's occupied table
 *    name, #3750) stays unclassified.
 *
 * Providers must thread the caught SDK error as `cause`
 * (`scripts/check-provider-error-cause.ts`), which is what makes the walk reach
 * it. RESIDUAL: an AWS validation error that echoes a template value carrying
 * the phrase still classifies — the surface is a name-like field AWS quotes
 * verbatim, not any cdkd refusal. Deliberately NOT classified: a non-`Error`
 * throw or a string; a Cloud Control handler reporting "already exists" under a
 * code other than `AlreadyExists`; a custom resource's FAILED reason; and S3's
 * `BucketAlreadyExists`, whose message carries neither form — another account
 * holds the name, so a delete-first would destroy the old bucket and free
 * nothing.
 */
export function isNameCollisionErrorFrom(error: unknown, logicalId: string): boolean {
  // Issue #3978: a retry sequence that may have made this very resource, read
  // ahead of the anchor so no positive arm below -- the Cloud Control code or a
  // provider's `markNameCollision` on an owner-anchored link -- can credit it.
  if (hasReplayMayCollide(error)) return false;
  return relaysNameCollision(error, logicalId, () => false);
}

/**
 * The replayed half {@link isNameCollisionErrorFrom} withholds (issue
 * [#3984](https://github.com/go-to-k/cdkd/issues/3984)): `error` carries
 * {@link markReplayMayCollide}'s stamp AND its chain still relays a name
 * collision for `logicalId`, read by the same arms and anchor.
 *
 * `isRetryAnchor` names the one link the anchor sees through: `withRetry`'s
 * auxiliary mark, which `withRetry` writes beside the stamp onto the first
 * link without its own logical id -- usually the very SDK error that says
 * "already exists". The caller supplies it (`auxiliary-failure.ts` owns the
 * mark's shape) so this module keeps its one import. Every other foreign
 * anchor still refuses, a provider's own auxiliary mark included: that one
 * names an auxiliary object, not the resource's name.
 *
 * ADVICE ONLY. A `true` here is the case where the collided resource is most
 * likely the one this create's own earlier attempt made, which is exactly why
 * no delete-first site may read it.
 *
 * RESIDUAL, advice text only: the retry mark cannot tell WHICH call it wraps.
 * A provider that runs an auxiliary call under its own `withRetry` inside
 * `create()` would leave this mark (not its own) on that call's "already
 * exists", and a resource whose logical id is literally `withRetry` would
 * spell a provider mark identically. Either costs a misworded log line, never
 * a delete.
 */
export function isReplayedNameCollisionFrom(
  error: unknown,
  logicalId: string,
  isRetryAnchor: (link: unknown) => boolean
): boolean {
  if (!hasReplayMayCollide(error)) return false;
  return relaysNameCollision(error, logicalId, isRetryAnchor);
}

/** The shared walk of {@link isNameCollisionErrorFrom} and {@link isReplayedNameCollisionFrom}. */
function relaysNameCollision(
  error: unknown,
  logicalId: string,
  isRetryAnchor: (link: unknown) => boolean
): boolean {
  const topRelaysIt =
    error instanceof Error &&
    typeof error.message === 'string' &&
    isNameCollisionError(error.message);
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_CHAIN_DEPTH && current != null; depth++) {
    const link = current as {
      name?: unknown;
      message?: unknown;
      logicalId?: unknown;
      ccErrorCode?: unknown;
      $metadata?: unknown;
      cause?: unknown;
    };

    // The ANCHOR runs FIRST at every depth, ahead of every read — the same
    // ordering, and for the same reason, as `isUpdateUnsupportedError`: a
    // rejection that NAMES ANOTHER RESOURCE must not classify this one by any
    // route. It is a GENERAL fence: `NestedStackProvider` throws a fresh
    // `Error` with no `cause`, so no child provider error reaches the parent's
    // chain today, and the fence keeps it that way if one ever does.
    //
    // RESIDUAL, stated because the sibling states it and the cost is WORSE
    // here: the anchor compares logical IDS, so a CHILD resource whose logical
    // id EQUALS the parent `AWS::CloudFormation::Stack`'s passes at every link
    // and that child's rejection classifies the parent. Reachable via CDK's
    // `overrideLogicalId`. For `isUpdateUnsupportedError` that costs a
    // replacement; here it costs the `--replace` delete-first destroying the
    // live child stack. Not a trust boundary — one operator authors both
    // templates — but do not read the anchor as total.
    if (
      typeof link.logicalId === 'string' &&
      link.logicalId !== logicalId &&
      !isRetryAnchor(current)
    ) {
      return false;
    }

    if (typeof link.name === 'string' && NAME_COLLISION_ERROR_NAMES.has(link.name)) return true;

    if (link.ccErrorCode === 'AlreadyExists') return true;

    if ((link as Record<symbol, unknown>)[NAME_COLLISION_MARKER] === true) return true;

    // The `typeof` check stays: a non-string `message` would otherwise reach
    // the regex and throw.
    if (
      topRelaysIt &&
      current instanceof Error &&
      isAwsAuthoredFailure(current) &&
      typeof link.message === 'string' &&
      isNameCollisionError(link.message)
    ) {
      return true;
    }

    current = link.cause;
  }
  return false;
}

/**
 * Match a same-name re-creation cooldown — an AWS service still holding a
 * resource's name while its asynchronous delete finishes. Every recognised
 * spelling lives in {@link NAME_COOLDOWN_ERROR_MESSAGE_PATTERNS}; add new ones
 * THERE rather than here, so the ordinary-create path
 * ({@link RETRYABLE_ERROR_MESSAGE_PATTERNS}, which composes that list) cannot
 * drift out of step with the delete-then-re-create sites again. That drift is
 * exactly what issue [#2116](https://github.com/go-to-k/cdkd/issues/2116)
 * found: SQS's wire message was retryable on an ordinary create while its
 * error code was not, and the Step Functions spelling was recognised by
 * neither.
 *
 * The delete-then-re-create sites (the deploy engine's `--replace`
 * delete-first fallback and the rollback executor's reverse-replacement)
 * override the retry filter with {@link isNameCollisionError}, which these
 * signatures do NOT match — so a replacement revert used to fail fast
 * mid-flight with the resource absent from both AWS and state (issue #1206).
 * Those sites OR this matcher into their retry filter, with a schedule long
 * enough to cover the 60s SQS window.
 *
 * Kept separate from {@link isNameCollisionError} on purpose: a cooldown at a
 * create-first site must NOT be treated as a collision (deleting the new
 * resource would not release the cooldown on the old name).
 */
export function isNameCooldownError(message: string): boolean {
  return NAME_COOLDOWN_ERROR_MESSAGE_PATTERNS.some((p) => message.includes(p));
}

/**
 * Retry filter for the delete-then-re-create sites: the old name holder was
 * just deleted, so both the late name release ("already exists" from an async
 * delete) and the SQS 60s name cooldown are worth waiting out. Pair with a
 * schedule that covers the full cooldown window (maxRetries 8, delays
 * 2s/4s/8s then capped at 10s ≈ 64s total sleep).
 */
export function isRecreateRetryableError(message: string): boolean {
  return isNameCollisionError(message) || isNameCooldownError(message);
}
