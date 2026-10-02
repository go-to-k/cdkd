import type { ResourceState } from '../../types/state.js';
import type {
  ResourceCreateResult,
  ResourceProvider,
  ResourceUpdateResult,
} from '../../types/resource.js';
import { withCurrentResourceSecrets } from '../resource-secrets-scope.js';
import {
  prepareRemovalForUpdate,
  removalWarning,
  withoutInjectedRemovals,
} from '../../provisioning/update-removal.js';
// Issues #2038 / #4037: every `withRetry` site's `RetryLogger` runs over one
// op's masker (`createOpMasker`) — the providers' shared module, not a second
// copy of that security contract.
import { createMaskedRetryLogger, type MaskerFn } from '../../provisioning/masked-retry-logger.js';
import { type RecordedSecretValues } from '../secret-redaction.js';
import { withRetry } from '../retry.js';
import { type RollbackExecutorContext } from './types.js';
import { safe } from './messages.js';

/**
 * Retry schedule for a re-create that must wait out a name-release delay:
 * an async delete's late name release ("already exists") or the SQS 60s
 * same-name cooldown (issue #1206). 2s/4s/8s then capped at 10s over 8
 * retries ≈ 64s of total sleep — enough to cover the full cooldown window.
 */
const RECREATE_RETRY_SCHEDULE = {
  maxRetries: 8,
  initialDelayMs: 2_000,
  maxDelayMs: 10_000,
} as const;

export async function updateWithRollbackRetry(
  provider: ResourceProvider,
  args: Parameters<ResourceProvider['update']>,
  logicalId: string,
  logger: RollbackExecutorContext['logger'],
  isInterrupted: (() => boolean) | undefined,
  secrets: RecordedSecretValues,
  /** The op's masker ({@link createOpMasker}) for the retry lines. */
  mask: MaskerFn
): Promise<ResourceUpdateResult> {
  // Issue #1160, for BOTH revert arms: each hands over two state records, so
  // the removal is template-vs-template on either. Once per op, outside the
  // retry loop, exactly as the deploy's in-place update does it.
  const [, , resourceType, desired, previous, context] = args;
  const removal = prepareRemovalForUpdate(provider, resourceType, desired, previous);
  const revertArgs: Parameters<ResourceProvider['update']> = [
    args[0],
    args[1],
    resourceType,
    removal.properties,
    previous,
    { ...context, ...removal.context },
  ];
  // An injected reset is sent, never recorded: the record keeps the template.
  // The warning follows a SUCCESSFUL revert only, as on the deploy side.
  const recorded = (result: ResourceUpdateResult): ResourceUpdateResult => {
    if (removal.unhandled.length > 0) {
      logger.warn(mask(removalWarning(logicalId, resourceType, removal.unhandled, 'rollback')));
    }
    return withoutInjectedRemovals(result, removal.injected);
  };
  if (provider.disableOuterRetry) {
    // Single-shot — the provider handles transient errors internally, and an
    // outer retry would invalidate its per-call invariant state.
    return recorded(
      await withCurrentResourceSecrets(secrets, () => provider.update(...revertArgs))
    );
  }
  const result = await withRetry(
    // INSIDE the retry arrow, so the store is bound per ATTEMPT, exactly as the
    // deploy engine binds its own provider calls.
    () => withCurrentResourceSecrets(secrets, () => provider.update(...revertArgs)),
    // A LABEL to `withRetry` -- it names the operation in the retry / give-up
    // lines and is used for nothing else -- so it takes the replay's rendering (`safe`)
    // (issue #3092): `retry.ts` sanitizes its label too, but a label is not
    // always an identifier there, so the boundary quoting and the cap are
    // decided here, where the value is known to be a journal field.
    // `createWithRollbackRetry` does the same for its two loops.
    safe(logicalId),
    {
      logger: createMaskedRetryLogger(logger, mask),
      ...(isInterrupted && {
        isInterrupted,
        onInterrupted: () => new Error('Rollback interrupted while retrying a resource update'),
      }),
    }
  );
  return recorded(result);
}

/**
 * Both retry loops around a reverse-replacement replay-CREATE (issue
 * [#2032](https://github.com/go-to-k/cdkd/issues/2032)) — the create-side twin
 * of {@link updateWithRollbackRetry}, and the single place the two replay arms
 * get their `disableOuterRetry` guard.
 *
 * ## The nesting, and why it is required
 *
 * A caller-supplied `isRetryable` REPLACES `isRetryableTransientError`
 * outright, and ANY explicit schedule knob sets `defaultSchedule = false` in
 * `retry.ts`, which is the gate on the dense IAM-propagation path. Both
 * replay-CREATE arms pass BOTH ({@link RECREATE_RETRY_SCHEDULE} plus
 * `isNameCooldownError` / `isRecreateRetryableError`), so a propagation error
 * raised by the re-create — the old execution role was re-created moments
 * earlier in this same rollback, so `CreateFunction` answers `The role defined
 * for the function cannot be assumed by Lambda.` — was non-retryable on
 * attempt 0 and rethrown raw, leaving the resource absent from BOTH AWS and
 * state. The INNER call passes NO knobs and NO classifier, so it gets the
 * dense 26-retry / 47.75s propagation schedule while the OUTER one keeps
 * owning the name-release cadence.
 *
 * ## What the deploy engine's precedents actually are
 *
 * They are two DIFFERENT shapes, and the two rollback arms need one each —
 * this helper is deliberately the sum of both rather than a copy of either:
 *
 *  - Arm 2 (post-delete-new-first) matches the delete-then-re-create sites,
 *    `deploy-engine/replacement.ts`'s `--replace` delete-first fallback and
 *    `deploy-engine/update-replace.ts`'s named replacement, which nest `this.withRetry(...)` INSIDE an outer
 *    `isRecreateRetryableError` retry. Same two loops as here.
 *  - Arm 1 (create-first) has NO such twin. Its deploy-engine analogue is the
 *    property-driven create-first in `updateByReplacement` (`deploy-engine/update-replace.ts`), which calls
 *    `this.withRetry(...)` on its OWN — one default-schedule loop, no outer
 *    custom-classifier loop at all — and whose catch then reads
 *    `isNameCollisionErrorFrom` to reach the delete-first fallback. Arm 1 is that
 *    shape PLUS the outer SQS-cooldown loop issue #1206 added, so it is the
 *    SUM of both precedents.
 *
 * ## Why the guard lives here and not in `retry.ts`
 *
 * `withRetry` never receives the provider, so it cannot honour
 * `disableOuterRetry` — re-running `CustomResourceProvider.create()` /
 * `NestedStackProvider.create()` mints a fresh pre-signed S3 URL + RequestId
 * and strands the previous attempt at a key nobody polls, and re-running
 * `NestedStackProvider.create()` re-creates child stacks and child state
 * files. That check therefore has to live next to the provider, exactly as
 * `DeployEngine.withRetry` does it.
 *
 * The guard covers BOTH loops, not just the inner one. Guarding only the inner
 * loop left the outer schedule free to re-enter, which measured at 9
 * `create()` calls for a cooldown and 10 for a collision against an opt-out
 * provider — i.e. the exact hazard the flag exists for, arriving through the
 * outer loop instead. A single-shot call still lets a name collision reach the
 * CALLER's catch on attempt 0 (that catch sits outside this helper), so the
 * delete-new-first fallback is unaffected by the opt-out.
 *
 * ## The collision arm is deliberately untouched
 *
 * `isNameCollisionError`'s signature (`already exist(s)` / `AlreadyExists`) is
 * NOT in `RETRYABLE_ERROR_MESSAGE_PATTERNS`, so the inner classifier rejects it
 * on attempt 0 and it reaches the caller's catch on the FIRST outer attempt,
 * exactly as before. The SQS cooldown IS matched by the inner classifier (the
 * generic table carries `wait 60 seconds`), which is the same division of
 * labour the deploy engine's named-replacement site documents. Since issue
 * #2116 the inner retry rides the name-cooldown grid (≈64s) rather than the
 * generic ~47s one, so it covers the whole 60s window on its own instead of
 * absorbing most of it and leaving a tail for the outer loop; the outer loop
 * now earns its place by ALSO covering the late name release that the inner
 * default classifier rejects. The two compound — measured at 640s of total
 * sleep on a cooldown, inside the 30-minute per-resource deadline.
 *
 * ## The secrets scope, on both call sites (issue #2086)
 *
 * Each caller's `create` thunk binds {@link withCurrentResourceSecrets} around
 * `createProvider.create(...)`, as {@link updateWithRollbackRetry} does around
 * `update(...)`, but for a reason of its own that is live on this path: a
 * reverse-replacement replay of an `AWS::CloudFormation::Stack` row re-CREATES
 * the child through `NestedStackProvider.create`, which has no journal-replay
 * arm and reaches `runChildDeploy` in a deploy-mode context, and an unbound
 * store makes the child engine persist the parent's plaintext. It sits INSIDE
 * the thunk, so it is re-established on every attempt of both loops rather
 * than once around them.
 */
export async function createWithRollbackRetry(
  provider: ResourceProvider,
  create: () => Promise<ResourceCreateResult>,
  logicalId: string,
  logger: RollbackExecutorContext['logger'],
  isInterrupted: (() => boolean) | undefined,
  /** The op's masker ({@link createOpMasker}) for the retry lines. */
  mask: MaskerFn,
  outer: {
    /**
     * See `RetryOptions.isRetryable` in `./retry.ts`: the argument is the
     * CLASSIFICATION text, which for an error stamped `markRedactedCause` is
     * the joined `.cause` chain rather than `error.message` (issue #2302).
     * Classify on it; never log or throw it.
     */
    isRetryable: (classificationText: string) => boolean;
    interruptedMessage: string;
  }
): Promise<ResourceCreateResult> {
  if (provider.disableOuterRetry) {
    // Single-shot — BOTH loops skipped. The provider handles transient errors
    // internally, and any retry would invalidate its per-call invariant state
    // (a Custom Resource's pre-signed response URL + RequestId).
    return await create();
  }
  // Issue #2038: the bag handed to `create()` is PLAINTEXT, and every retry
  // sink below — the per-attempt debug line AND the give-up summary the inner
  // loop can now emit at `warn` — interpolates the AWS message verbatim.
  const maskedLogger = createMaskedRetryLogger(logger, mask);
  // The `withRetry` LABEL, display-only in `retry.ts`, rendered ONCE here for
  // both loops -- as `updateWithRollbackRetry` does -- so a caller passes the
  // raw id and the provider call it wraps keeps it (issue #3092).
  const shownId = safe(logicalId);
  return await withRetry(
    () =>
      withRetry(create, shownId, {
        logger: maskedLogger,
        ...(isInterrupted && {
          isInterrupted,
          onInterrupted: () =>
            new Error('Rollback interrupted while retrying the replay re-create'),
        }),
      }),
    shownId,
    {
      ...RECREATE_RETRY_SCHEDULE,
      logger: maskedLogger,
      ...(isInterrupted && {
        isInterrupted,
        onInterrupted: () => new Error(outer.interruptedMessage),
      }),
      isRetryable: outer.isRetryable,
    }
  );
}

/**
 * The state record to store after a rollback UPDATE arm (issue #1644).
 *
 * The bag handed to `update()` on both arms IS `restored.properties`, so a
 * returned `effectiveProperties` is its complete replacement — no per-key
 * delta is needed here (unlike `drift --revert`, which sends a merged bag).
 * Everything else on the record — physical id, attributes, dependencies,
 * policies — is the restored resource's and must survive untouched.
 */
export function recordAfterRollbackUpdate(
  restored: ResourceState,
  result: ResourceUpdateResult | undefined
): ResourceState {
  // Copied, not aliased: the record outlives the call and a provider is free to
  // keep mutating the object it handed back. The optional `result` mirrors the
  // same tolerance `drift.ts`'s capture applies — a provider that resolves
  // `undefined` must not crash a recovery path.
  return result?.effectiveProperties
    ? { ...restored, properties: { ...result.effectiveProperties } }
    : restored;
}

/**
 * The `properties` override to merge into the state record rebuilt after the
 * reverse-replacement replay-CREATE (issue #1682) — the create-side twin of
 * {@link recordAfterRollbackUpdate}.
 *
 * The bag handed to `create()` on both arms of that path IS `prev.properties`,
 * so — exactly as on the UPDATE side — a returned `effectiveProperties` is its
 * complete replacement and no per-key delta is needed. Without this the arm
 * rebuilt the record from `prev.properties` unconditionally, so a provider that
 * deliberately SUBSTITUTED a malformed block on a replay (the `replayWarn`
 * downgrade of issue #1544) announced the substitution into a void and the
 * phantom drift it exists to close survived the rollback.
 *
 * Falls back to the restored record's own `properties` when the provider
 * reported nothing — the pre-#1682 behavior — rather than blanking the record.
 * An empty object is a legitimate COMPLETE answer (a provider that sent
 * nothing), so the gate is an explicit PRESENCE test rather than truthiness —
 * matching the `??` the contract in `.claude/rules/providers.md` prescribes,
 * and saying so at the one place a future reader would otherwise have to
 * re-derive that `{}` must not fall back.
 *
 * Applied on the name-idempotent ADOPT path too (`adoptedLiveNewResource`).
 * That arm's warning says state records "the pre-replacement properties", and
 * it still does: a substitution repairs an unusable field of that same
 * pre-replacement bag, it does not swap in the new generation's values.
 */
export function recordedPropertiesAfterReplayCreate(
  restored: Omit<ResourceState, 'observedProperties'>,
  result: ResourceCreateResult
): ResourceState['properties'] {
  // The PROVIDER's bag is copied at the TOP LEVEL, so the record does not
  // alias the object a provider is free to keep mutating after handing it
  // back. Nested values stay shared — the same shallow-copy bound
  // `recordAfterRollbackUpdate` has; deep-cloning here would diverge from it
  // for a hazard neither has ever hit. The fallback deliberately passes
  // `restored.properties` through BY REFERENCE — that is cdkd's own state
  // object and is exactly what the pre-#1682 spread of `prevRecord` already
  // put on the record, so copying it would be a behavior change smuggled in
  // under a no-op.
  return result.effectiveProperties === undefined
    ? restored.properties
    : { ...result.effectiveProperties };
}
