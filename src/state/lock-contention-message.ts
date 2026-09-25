/**
 * The message every fail-fast lock-contention site raises.
 *
 * Issue #2161 made six commands throw on `acquireLock` returning `false`
 * instead of running under a foreign lock. Issue #2170 is the follow-up: the
 * message those sites raise asked the user to decide "is another process
 * active?" while printing none of the evidence that would answer it, and the
 * recovery command it suggested could resolve against the wrong AWS account.
 *
 * Both matter more than they look, because of WHICH locks reach this message.
 * `LockManager.acquireLock` reaps an EXPIRED foreign lock and retries, so a
 * `false` return means the lock is LIVE — in practice a running `cdkd deploy`.
 * The user who follows a bare `cdkd force-unlock <stack>` suggestion therefore
 * deletes a live owner's lock and reproduces issue #2161's harm by hand, which
 * is the outcome #2161 exists to prevent.
 *
 * Centralising the text here also settles the third finding: the nine sites
 * had drifted to three spellings (`for stack` / `for nested stack` /
 * `for nested-stack child`), so a user grepping CI logs for one of them found
 * two of three. `subject` now varies only the noun.
 */

import { displaySafe, displayStackName, UNRENDERABLE } from '../utils/display-safe.js';
// Both moved to `src/utils/pasteable-command.ts` with the shared builder
// (go-to-k/cdkd#3436): `src/utils/**` imports nothing from `src/state/**`, so
// the builder could not have reached them here. Re-exported because this
// module's own callers and `.claude/rules/lock-contention-message.md` name
// this path.
import { commandHole, pasteableCommand, shellQuote } from '../utils/pasteable-command.js';

export { commandHole, shellQuote };
import { DEFAULT_STATE_PREFIX } from './state-prefix.js';
import type { LockManager } from './lock-manager.js';

/**
 * Flags that change WHICH lock object `cdkd force-unlock` resolves to.
 *
 * Only `--stack-region` was propagated before this (issue #2170). The rest are
 * load-bearing for the same reason: `force-unlock` re-resolves the state
 * bucket from the ambient profile and the CLI region
 * (`src/cli/commands/force-unlock.ts`), so after `cdkd destroy --profile prod`
 * a bare suggestion resolves the DEFAULT profile's account and force-deletes
 * the lock of a same-named stack somewhere else entirely.
 */
export interface LockRecoveryContext {
  /** The caller's `--profile`, when one was passed. */
  profile?: string | undefined;
  /**
   * The RESOLVED state bucket, not the raw flag. Always emitted: it is the
   * bucket the contended lock actually lives in, so naming it removes the
   * account ambiguity `--profile` alone leaves open.
   */
  stateBucket?: string | undefined;
  /**
   * The caller's `--state-prefix`. `--state-prefix` carries a commander
   * DEFAULT (`DEFAULT_STATE_PREFIX`), so every site supplies a value and an
   * unconditional emit would append `--state-prefix cdkd` to every hint — noise
   * that also trains the reader to skim the flags that DO matter. Only a
   * non-default prefix is emitted — an EMPTY one included, since the CLI
   * accepts it and it selects a different key space.
   */
  statePrefix?: string | undefined;
}

/**
 * Re-exported from its home in `src/utils/display-safe.ts` (moved there by
 * issue #3064 so the leaf's own dependants can use it); every importer of this
 * module's spelling keeps working.
 */
export { UNRENDERABLE };

/** What the contended lock is on — varies the noun, nothing else. */
export type LockSubject = 'stack' | 'nested stack' | 'nested-stack child';

export interface LockContentionArgs {
  lockManager: Pick<LockManager, 'getLockInfo'>;
  stackName: string;
  region: string;
  subject?: LockSubject | undefined;
  recovery?: LockRecoveryContext | undefined;
  /**
   * Replaces the "another cdkd process holds it" clause. `cdkd export`'s
   * nested-stack children call `acquireLockWithRetry` first, so for them the
   * accurate statement is that the holder survived the retry window.
   */
  heldClause?: string | undefined;
  /**
   * Appended verbatim after the HEAD sentence — i.e. BEFORE the advice and
   * before the recovery command, which is deliberately last so it can be
   * pasted (e.g. export's no-changeset note).
   */
  suffix?: string | undefined;
}

/**
 * The ONE rendering of a lock's deadline: `expires in 1m23s` / `expired 45s
 * ago` for a finite `expiresAt`, `expires at an unknown time` otherwise
 * (issue #3085). Consumed by this module's contention refusal, by
 * `LockManager`'s three sites (the expired-lock takeover warning, the acquire
 * retry line, the final `LockError`) and by `cdkd state show`'s lock row, so
 * a record renders the same everywhere it is shown.
 *
 * Takes the RAW `expiresAt`, never a difference: the field is an unchecked
 * cast, and `Number.isFinite` on the raw value is the test `isLockExpired`
 * makes, so what this SAYS agrees with what the expiry check DOES. Subtracting
 * first (the previous `formatRemaining(info.expiresAt - Date.now())`) coerced
 * a numeric string to a real deadline here while the check called it expired
 * — the one input that still split the renderers after issue #3083. `{}`,
 * `"soon"`, an absent field, and the `NaN` that `getLockRecord` substitutes
 * for a coercion that throws (go-to-k/cdkd#2947) all land on the unknown arm.
 *
 * Seconds precision, deliberately: this module used to round to `in ~12m`
 * "without implying more precision than a clock skew allows", but the
 * `LockError` refusal that advises the same force-unlock decision already
 * printed `expires in 4m12s`, so the coarser form was a second spelling of the
 * same fact rather than a guard against skew.
 */
export function formatLockExpiry(expiresAt: number): string {
  if (!Number.isFinite(expiresAt)) return 'expires at an unknown time';
  const remainingMs = expiresAt - Date.now();
  return remainingMs > 0
    ? `expires in ${formatDuration(remainingMs)}`
    : `expired ${formatDuration(-remainingMs)} ago`;
}

/** `1m23s` / `45s` from a non-negative millisecond count. */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${seconds % 60}s`;
}

/**
 * The `cdkd force-unlock ...` line, carrying every flag that decides which
 * lock object it resolves to — built through the SHARED `pasteableCommand`
 * gate since go-to-k/cdkd#3436's second half, and SUPPRESSED whole (`''`)
 * whenever the gate withheld anything.
 *
 * SUPPRESS, not a hole, on purpose: `cdkd force-unlock` deletes another
 * process's lock, so naming a stack that is not quite the record's is the
 * wrong-lock-object harm this module exists to close, and a hole the operator
 * fills from the prose beside it is the same harm one step later. What the
 * fold-in CHANGES is the set of values that suppress. The builder's own copy
 * gated on emptiness and exactness only (M-round finding recorded on
 * go-to-k/cdkd#3436): a record named `--state-bucket=attacker` rendered
 * exactly, passed every gate it had, and came out as
 * `cdkd force-unlock '--state-bucket=attacker' ...` — the shell strips the
 * quotes and Commander parses that argv entry as the FLAG — and a name past
 * the stack-ref cap was named in full. The gate refuses both (`option-shaped`,
 * `too-long`) beside `empty` and `altered`, which suppressed before too.
 *
 * Every other rule transfers verbatim: a value is sanitize-compared against
 * the RAW (`myΩstack` sanitizes to `my stack`, a DIFFERENT stack), shell-quoted
 * only when it survives that, and an EMPTY region — which `force-unlock.ts`
 * reads as "not supplied" and widens to every region holding the name — is
 * refused rather than emitted; an ABSENT region (a legacy lock key) is simply
 * omitted. The three `LockRecoveryContext` fragments keep their own
 * sanitize-and-exactness pair in {@link recoveryCommandFlags}, whose notes on
 * the DENYLIST versus `asciiOnly` (a profile name is legitimately not ASCII)
 * and on `--state-prefix ''` stand unchanged; its `exact` folds into the
 * suppression here. Anything that can suppress is named in
 * `UNREPRODUCIBLE_LOCK_VALUES` and in the no-command sentence — keep those in
 * step with the gate.
 */
export function buildForceUnlockCommand(
  stackName: string,
  /**
   * The lock's region, or `undefined` for a LEGACY lock key, which has none.
   * A first cut made the legacy caller pass `''` and the emptiness guard then
   * suppressed the whole command — so that branch always fell through to a
   * hand-built, UNQUOTED fallback, shipping exactly the paste defect this
   * function exists to prevent.
   */
  region: string | undefined,
  recovery?: LockRecoveryContext
): string {
  const recoveryFlags = recoveryCommandFlags(recovery);
  const built = pasteableCommand(
    'cdkd force-unlock',
    region === undefined
      ? [{ value: stackName, hole: 'stack' }]
      : [
          { value: stackName, hole: 'stack' },
          { flag: '--stack-region', value: region, hole: 'region' },
        ],
    recoveryFlags.flags
  );
  if (!built.exact || !recoveryFlags.exact) return '';
  return built.command;
}

/** What {@link recoveryCommandFlags} returns. */
export interface RecoveryCommandFlags {
  /** The flags, in `--profile` / `--state-bucket` / `--state-prefix` order. */
  flags: string[];
  /**
   * False when any supplied fragment is one `displaySafe` would ALTER. Its flag
   * is then a quoted {@link commandHole} (`'<profile>'` / `'<bucket>'` / `'<prefix>'`) rather than the value:
   * never the altered spelling (it names a different account or key space) and
   * never omitted (that silently resolves the ambient default).
   */
  exact: boolean;
}

/**
 * The flags that pin a pasteable state command to the caller's account and
 * bucket: `--profile`, the resolved `--state-bucket`, and a NON-default
 * `--state-prefix` (see {@link LockRecoveryContext} for why each is emitted
 * when it is). ONE spelling, shared by {@link buildForceUnlockCommand} and the
 * `cdkd orphan` properties refusal `malformed-resources-bag.ts` builds
 * (go-to-k/cdkd#3363): after `cdkd orphan --profile prod ...` a remedy that
 * carried none of these resolved the DEFAULT profile's bucket when pasted.
 * Each fragment takes {@link sanitizeRecoveryValue}'s sanitize + exactness
 * pair (go-to-k/cdkd#3377); what a caller does with an inexact one is its
 * own call — `buildForceUnlockCommand` suppresses the whole command, the orphan
 * refusal prints the hole.
 */
export function recoveryCommandFlags(recovery?: LockRecoveryContext): RecoveryCommandFlags {
  const profile = sanitizeRecoveryValue(recovery?.profile);
  const stateBucket = sanitizeRecoveryValue(recovery?.stateBucket);
  const statePrefix = sanitizeRecoveryValue(recovery?.statePrefix);
  const flags: string[] = [];
  // The SANITIZED value, not the raw one: they are byte-equal wherever a value
  // is printed (an inexact one prints as a hole instead), and quoting the
  // sanitized one is what makes "sanitize before quote" literally true at the
  // emit site rather than an invariant a reader has to reconstruct — the same
  // shape the shared gate applies to the stack and region in
  // `buildForceUnlockCommand`.
  // cdkd-profile-display: already sanitized AND already gated. Every value
  // below came out of `sanitizeRecoveryValue`, which applies `displaySafe` and
  // reports whether that CHANGED anything, and a fragment it changed is printed
  // as a `<profile>` hole, never as text. So a second `displayIdent` pass here
  // could only alter a value that is by construction byte-identical to the
  // user's -- which would name a different lock, the harm this whole function
  // exists to avoid. `tests/unit/state/lock-contention-message.test.ts` holds
  // the behavioural proof; this comment is the verdict the source-shape fence
  // cannot derive.
  if (profile.text || !profile.exact) {
    flags.push(
      profile.exact
        ? `--profile ${shellQuote(profile.text)}`
        : `--profile ${commandHole('profile')}`
    );
  }
  if (stateBucket.text || !stateBucket.exact) {
    flags.push(
      stateBucket.exact
        ? `--state-bucket ${shellQuote(stateBucket.text)}`
        : `--state-bucket ${commandHole('bucket')}`
    );
  }
  // DEFINED, not truthy: `--state-prefix` has no argParser, so `''` is
  // accepted and keys every record under `/`, and a hint that dropped it would
  // resolve the default `cdkd/` prefix instead — a different record with the
  // same name (go-to-k/cdkd#3363 review). Quoted, an empty value pastes as
  // `--state-prefix ''`. The premise — the option carries no argParser, and
  // the backend keys on the value verbatim — is fenced in
  // `tests/unit/state/lock-contention-message.test.ts`.
  const prefix = recovery?.statePrefix;
  if (prefix !== undefined && prefix !== DEFAULT_STATE_PREFIX) {
    flags.push(
      statePrefix.exact
        ? `--state-prefix ${shellQuote(statePrefix.text)}`
        : `--state-prefix ${commandHole('prefix')}`
    );
  }
  return { flags, exact: profile.exact && stateBucket.exact && statePrefix.exact };
}

/**
 * Sanitize ONE {@link LockRecoveryContext} fragment and report whether that
 * changed it.
 *
 * One helper for all three rather than three spellings, for the reason
 * `display-safe.ts`'s own header gives: this rule was widened BY HAND, one
 * value at a time, and missed an instance every round — go-to-k/cdkd#3377
 * named `--profile`, and the fix for it shipped with `--state-bucket` and
 * `--state-prefix` still raw on the next two lines. A fourth fragment added
 * later calls this and inherits both halves.
 *
 * ABSENT stays absent: `''` is returned for it, which every caller's `if`
 * treats as "emit nothing", and `exact` is true because there was nothing to
 * alter.
 */
export function sanitizeRecoveryValue(value: string | undefined): { text: string; exact: boolean } {
  if (value === undefined) return { text: '', exact: true };
  const text = displaySafe(value);
  return { text, exact: text === value };
}

/**
 * What to say INSTEAD of a `cdkd force-unlock ...` line when
 * {@link buildForceUnlockCommand} suppresses.
 *
 * Exported since issue [#2610]: `lock-manager.ts`'s exhausted-retry arm needed
 * the same branch, and it was the THIRD place to spell it. The module header's
 * point applies to the suppression sentence as much as to the command -- a
 * banner ending in a bare `run: ` is the shape the review found, and copies are
 * how the next one drifts. Byte-identical to what `forceQuitRecoveryClause`
 * emitted before the extraction; its callers see no change.
 */
/**
 * The VALUES `buildForceUnlockCommand` can suppress on, as one noun phrase.
 *
 * Extracted because the enumeration had reached THREE spellings and they had
 * already drifted -- go-to-k/cdkd#3377 gave the guard three more values while
 * two of the three sentences still said "the name or region", so a user whose
 * PROFILE carried an ESC was told their STACK NAME was unrenderable
 * (go-to-k/cdkd#3390 rounds 1 and 2 found one copy each). That is the exact
 * divergence this module was created to end, reproduced inside the module and
 * at one of its call sites.
 *
 * A growing list cannot be kept in step by hand across three sentences, so it
 * is one binding and the sentences interpolate it. Keep it in step with the
 * guard in {@link buildForceUnlockCommand}; the per-word assertion in
 * `tests/unit/state/lock-contention-message.test.ts` is what notices if it
 * falls behind.
 */
export const UNREPRODUCIBLE_LOCK_VALUES = 'the name, region, profile, state bucket or state prefix';

export const UNREPRODUCIBLE_LOCK_CLAUSE =
  `Inspect the lock object directly: ${UNREPRODUCIBLE_LOCK_VALUES} recorded for ` +
  `this stack cannot be reproduced safely on a command line (unrenderable, empty, ` +
  `too long, or beginning with '-', which cdkd refuses rather than risk it parsing ` +
  `as an option), so no command is shown: one built from it could address a ` +
  `different lock.`;

/**
 * The force-quit banner's recovery sentence.
 *
 * Exported so the two `destroy-runner.ts` banners do not each decide what to
 * say when {@link buildForceUnlockCommand} suppresses — a banner ending in a
 * bare `run: ` is the shape the review found, and two copies of the branch is
 * how the next one drifts. Returns a leading-space clause so the caller can
 * concatenate it unconditionally.
 */
export function forceQuitRecoveryClause(
  stackName: string,
  region: string,
  recovery?: LockRecoveryContext
): string {
  const command = buildForceUnlockCommand(stackName, region, recovery);
  return command
    ? ` If the next run reports a lock, run: ${command}`
    : ` ${UNREPRODUCIBLE_LOCK_CLAUSE}`;
}

/**
 * Build the contention message, reading the holder's identity best-effort.
 *
 * The `getLockInfo` read is one GetObject and is deliberately NOT allowed to
 * fail the command: the caller is already on its way to throwing, and turning
 * a contention refusal into an S3 error would lose the reason. A failed or
 * absent read degrades to the evidence-free wording rather than to a crash.
 */
export async function buildLockContentionMessage(args: LockContentionArgs): Promise<string> {
  const { lockManager, stackName, region, subject = 'stack', recovery, heldClause, suffix } = args;

  let held = heldClause ?? 'another cdkd process holds it';
  let sawHolder = false;
  try {
    const info = await lockManager.getLockInfo(stackName, region);
    if (info) {
      const operation = info.operation ? `, operation: ${displaySafe(info.operation)}` : '';
      const expires = formatLockExpiry(info.expiresAt);
      const owner = displaySafe(info.owner);
      // An ABSENT / empty owner is not evidence of a live holder. `getLockInfo`
      // is an unvalidated `JSON.parse(...) as LockInfo`, so `String(undefined)`
      // would otherwise print `held by undefined` AND certify "that process is
      // still running" — more confident than the pre-sanitize behaviour, which
      // threw into the catch and gave the cautious wording. Same empty-value
      // rule the command suppression applies.
      // The EXPIRY is independent evidence and survives an unusable owner --
      // the previous revision dropped both, which threw away the one fact the
      // lock file definitely carries. Only the "still running" CERTIFICATION
      // is withheld, since that is what an owner-less record cannot support.
      const holder = owner ? `held by ${owner}${operation}` : `held by an unnamed holder`;
      held = `${heldClause ? `${heldClause} — ` : ''}${holder}, ${expires}`;
      // LAST, and only for a NAMED holder: setting it earlier paired the
      // degraded wording with the confident advice.
      if (owner) sawHolder = true;
    }
  } catch {
    // Best-effort: keep the evidence-free wording rather than masking the
    // contention with a read error.
  }

  // The steer is stronger when the holder is KNOWN, because the module header's
  // point applies: `acquireLock` reaps an expired lock, so a holder we can name
  // is by construction still live. Telling that user only "if you are certain
  // no other process is active" invites the force-unlock this whole refusal
  // exists to prevent.
  // Built WITHOUT the trailing connector. The previous revision appended
  // `, run:` here and un-appended it by regex on the suppression path, so a
  // reword would silently produce `..., run: No recovery command can be shown`.
  const advice = sawHolder
    ? `That process is still running — wait for it to finish. Only if you are certain it is gone`
    : `Wait for it to finish, or if you are certain no other process is active`;

  // The command goes LAST and UNWRAPPED. Wrapping it in quotes was a live
  // defect: `shellQuote` also quotes, so a value needing it produced
  // `run 'cdkd force-unlock 'Root~Child' ...'` — unpastable, i.e. exactly the
  // truncation `shellQuote` exists to prevent. Trailing means there is no
  // sentence left to delimit it from.
  const recoveryCommand = buildForceUnlockCommand(stackName, region, recovery);

  // ONE head sentence, built once. The previous revision rebuilt it in an
  // early-return branch for the unrenderable case, and the two had ALREADY
  // drifted (the branch dropped `advice`) — which is the divergence this module
  // exists to end, reproduced inside the module itself.
  // The stack name in `displayIdent`'s boundary rather than inside cdkd's own
  // `'...'` (go-to-k/cdkd#3436's paste fence measured the hand-quoted form: a
  // name `x'$(touch OWNED) #` closed the prose quote and the rest ran when the
  // sentence was pasted — the go-to-k/cdkd#3706 / #3725 convention, applied
  // here). `displayStackName`, not `displayIdent`: the stack-ref cap (1152), the
  // same the command is gated at, so a long nested name is not cut in the head
  // while named whole in the command. A plain name renders bare; the region
  // stays inside parentheses.
  const safeRegion = displaySafe(region, { asciiOnly: true }) || UNRENDERABLE;
  const head =
    `Could not acquire lock for ${subject} ${displayStackName(stackName)} (${safeRegion}) — ${held}.` +
    (suffix ? ` ${suffix}` : '');

  // `buildForceUnlockCommand` returns '' when a value has nothing renderable
  // left. Suppress only the COMMAND — suggesting one that would carry an empty
  // `--stack-region` is worse than suggesting none, because force-unlock reads
  // a falsy value as "not supplied" and widens to every region holding the
  // stack name. The advice itself still applies.
  if (!recoveryCommand) {
    return (
      `${head} ${advice}. ` +
      `No recovery command can be shown: ${UNREPRODUCIBLE_LOCK_VALUES} recorded ` +
      `for this lock cannot be reproduced safely on a command line (unrenderable, ` +
      `empty, too long, or beginning with '-', which cdkd refuses rather than risk it ` +
      `parsing as an option), so no command is shown: one built from it could ` +
      `address a different lock — inspect the lock object directly.`
    );
  }

  return `${head} ${advice}, run: ${recoveryCommand}`;
}
