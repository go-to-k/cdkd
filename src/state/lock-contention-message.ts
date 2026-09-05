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

import { displaySafe } from '../utils/display-safe.js';
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
   * non-default prefix is emitted.
   */
  statePrefix?: string | undefined;
}

/**
 * Stand-in for a value with nothing renderable left after sanitization. Named
 * rather than inlined so the message and the command-suppression branch cannot
 * disagree about what "unrenderable" looks like.
 */
export const UNRENDERABLE = '<unrenderable>';

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

/** Render `expiresIn` without implying more precision than a clock skew allows. */
function formatRemaining(ms: number): string {
  // A hand-written / truncated lock.json can omit `expiresAt`, which arrives
  // here as NaN and used to render `expires in ~NaNm`.
  if (!Number.isFinite(ms)) return 'at an unknown time';
  if (ms <= 0) return 'already expired';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'in under a minute';
  return `in ~${minutes}m`;
}

/**
 * Quote a value for a pasteable shell command.
 *
 * EXPORTED since issue [#2610]: `src/provisioning/replacement-protection-advice.ts`
 * prints `aws <service> ...` recovery commands naming a resource's physical id,
 * which is the same hazard one directory over. A second spelling of this
 * predicate is how the two would come to disagree about which values need
 * quoting -- the reason `display-safe.ts`'s header gives for not widening a
 * rule by hand. It is a pure function of its argument and imports nothing.
 */
export function shellQuote(value: string): string {
  // A profile / prefix / bucket with a space or a quote would otherwise produce
  // a suggestion that silently truncates when pasted.
  // `~` is deliberately NOT here. It was added for `Parent~Child` (every
  // nested-stack child name) when the command was still wrapped in `'...'` and
  // the two quotings composed into something unpastable. That wrapper is gone,
  // so a quoted `'Root~Child'` pastes fine and the widening bought nothing —
  // while costing tilde expansion on a value an S3 key can carry.
  return /^[A-Za-z0-9._/@:+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The `cdkd force-unlock ...` line, carrying every flag that decides which
 * lock object it resolves to.
 */
export function buildForceUnlockCommand(
  stackName: string,
  /**
   * The lock's region, or `undefined` for a LEGACY lock key, which has none.
   * A first cut made the legacy caller pass `''` and the emptiness guard below
   * then suppressed the whole command — so that branch always fell through to
   * a hand-built, UNQUOTED fallback, shipping exactly the paste defect this
   * function exists to prevent.
   */
  region: string | undefined,
  recovery?: LockRecoveryContext
): string {
  // Sanitize BEFORE quoting. Quoting alone already neutralizes an injected
  // `\ncurl ... | sh` (inside `'...'` it is a literal, not a separator), but it
  // leaves a MULTI-LINE "recovery command" on the operator's terminal, which is
  // its own forgery surface. A control character has no legitimate place in a
  // stack name or a region, so drop it and then quote what remains.
  // A value that sanitization CHANGED cannot be named in a command: the
  // command would address a DIFFERENT lock. `myΩstack` sanitizes to
  // `my stack`, and telling an operator to force-unlock that is the
  // wrong-lock-object harm this whole module exists to close — the same
  // reason an EMPTY value suppresses, one step earlier.
  const safeStack = displaySafe(stackName, { asciiOnly: true });
  const stackIsExact = safeStack === stackName;
  // An ABSENT region is legitimate (a legacy lock key); an UNRENDERABLE or an
  // ALTERED one is not.
  const safeRegion = region === undefined ? undefined : displaySafe(region, { asciiOnly: true });
  const regionIsExact = region === undefined || safeRegion === region;
  // A value that sanitizes to NOTHING must not become an empty ARGUMENT:
  // `force-unlock.ts` treats a falsy `--stack-region` as "not supplied" and
  // widens the release to EVERY region holding that stack name — the opposite
  // of what a region-qualified hint is for. Emitting no command is the honest
  // answer; the message still names what could not be rendered.
  if (!safeStack || safeRegion === '' || !stackIsExact || !regionIsExact) return '';
  const parts = [
    safeRegion === undefined
      ? `cdkd force-unlock ${shellQuote(safeStack)}`
      : `cdkd force-unlock ${shellQuote(safeStack)} --stack-region ${shellQuote(safeRegion)}`,
  ];
  if (recovery?.profile) parts.push(`--profile ${shellQuote(recovery.profile)}`);
  if (recovery?.stateBucket) parts.push(`--state-bucket ${shellQuote(recovery.stateBucket)}`);
  if (recovery?.statePrefix && recovery.statePrefix !== DEFAULT_STATE_PREFIX) {
    parts.push(`--state-prefix ${shellQuote(recovery.statePrefix)}`);
  }
  return parts.join(' ');
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
export const UNREPRODUCIBLE_LOCK_CLAUSE =
  `Inspect the lock object directly: the name or region recorded for this ` +
  `stack cannot be reproduced safely on a command line, so any command ` +
  `shown here would address a different lock.`;

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
      const expires = formatRemaining(info.expiresAt - Date.now());
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
      held = `${heldClause ? `${heldClause} — ` : ''}${holder}, expires ${expires}`;
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
  const safeStack = displaySafe(stackName, { asciiOnly: true }) || UNRENDERABLE;
  const safeRegion = displaySafe(region, { asciiOnly: true }) || UNRENDERABLE;
  const head =
    `Could not acquire lock for ${subject} '${safeStack}' (${safeRegion}) — ${held}.` +
    (suffix ? ` ${suffix}` : '');

  // `buildForceUnlockCommand` returns '' when a value has nothing renderable
  // left. Suppress only the COMMAND — suggesting one that would carry an empty
  // `--stack-region` is worse than suggesting none, because force-unlock reads
  // a falsy value as "not supplied" and widens to every region holding the
  // stack name. The advice itself still applies.
  if (!recoveryCommand) {
    return (
      `${head} ${advice}. ` +
      `No recovery command can be shown: the name or region recorded for this ` +
      `lock contains characters that cannot be reproduced safely on a command ` +
      `line, so any command shown here would address a different lock — ` +
      `inspect the lock object directly.`
    );
  }

  return `${head} ${advice}, run: ${recoveryCommand}`;
}
