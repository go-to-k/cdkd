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
  /** Appended verbatim after the recovery line (e.g. export's no-changeset note). */
  suffix?: string | undefined;
}

/**
 * Strip control characters from a value read out of `lock.json`.
 *
 * `owner` and `operation` are attacker-influenced for anyone who can write the
 * state bucket, and this string reaches a TTY AND the persisted deployment-
 * events store. A `\r` or an ANSI escape there can forge a plausible extra
 * instruction line under cdkd's own output.
 */
function sanitizeForDisplay(value: unknown): string {
  // `String(...)` rather than a `string` parameter: `getLockInfo` returns
  // `JSON.parse(body) as LockInfo`, so a hand-written lock.json can carry a
  // number / object / null here, and `value.replace` then threw INTO the
  // caller's best-effort catch.
  //
  // The class is wider than C0 + DEL, which a first cut used and which misses
  // every one of these: U+0085 (NEL) and the C1 range (xterm treats U+009B as
  // CSI in UTF-8), U+2028 / U+2029 (this string is PERSISTED and re-rendered by
  // JSON / web log viewers), and the bidi overrides U+202A-U+202E / U+2066-
  // U+2069, which visually REORDER the very command being pasted.
  return (
    String(value)
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ')
      .trim()
  );
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

function shellQuote(value: string): string {
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
  region: string,
  recovery?: LockRecoveryContext
): string {
  // Sanitize BEFORE quoting. Quoting alone already neutralizes an injected
  // `\ncurl ... | sh` (inside `'...'` it is a literal, not a separator), but it
  // leaves a MULTI-LINE "recovery command" on the operator's terminal, which is
  // its own forgery surface. A control character has no legitimate place in a
  // stack name or a region, so drop it and then quote what remains.
  const safeStack = sanitizeForDisplay(stackName);
  const safeRegion = sanitizeForDisplay(region);
  // A value that sanitizes to NOTHING must not become an empty ARGUMENT:
  // `force-unlock.ts` treats a falsy `--stack-region` as "not supplied" and
  // widens the release to EVERY region holding that stack name — the opposite
  // of what a region-qualified hint is for. Emitting no command is the honest
  // answer; the message still names what could not be rendered.
  if (!safeStack || !safeRegion) return '';
  const parts = [
    `cdkd force-unlock ${shellQuote(safeStack)} --stack-region ${shellQuote(safeRegion)}`,
  ];
  if (recovery?.profile) parts.push(`--profile ${shellQuote(recovery.profile)}`);
  if (recovery?.stateBucket) parts.push(`--state-bucket ${shellQuote(recovery.stateBucket)}`);
  if (recovery?.statePrefix && recovery.statePrefix !== DEFAULT_STATE_PREFIX) {
    parts.push(`--state-prefix ${shellQuote(recovery.statePrefix)}`);
  }
  return parts.join(' ');
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
      const operation = info.operation ? `, operation: ${sanitizeForDisplay(info.operation)}` : '';
      const expires = formatRemaining(info.expiresAt - Date.now());
      held = `${heldClause ? `${heldClause} — ` : ''}held by ${sanitizeForDisplay(info.owner)}${operation}, expires ${expires}`;
      // LAST: anything above can still throw, and setting it earlier paired the
      // degraded wording with the confident "still running" advice.
      sawHolder = true;
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
  const advice = sawHolder
    ? `That process is still running — wait for it to finish. Only if you are certain it is gone, run:`
    : `Wait for it to finish, or if you are certain no other process is active, run:`;

  // The command goes LAST and UNWRAPPED. Wrapping it in quotes was a live
  // defect: `shellQuote` also quotes, so a value needing it produced
  // `run 'cdkd force-unlock 'Root~Child' ...'` — unpastable, i.e. exactly the
  // truncation `shellQuote` exists to prevent. Trailing means there is no
  // sentence left to delimit it from.
  const recoveryCommand = buildForceUnlockCommand(stackName, region, recovery);
  // `buildForceUnlockCommand` returns '' when the stack name or region could
  // not be rendered at all. Suggesting nothing beats suggesting a command that
  // would release every region's lock for this stack name.
  if (!recoveryCommand) {
    return (
      `Could not acquire lock for ${subject} '${sanitizeForDisplay(stackName)}' ` +
      `(${sanitizeForDisplay(region)}) — ${held}.` +
      (suffix ? ` ${suffix}` : '') +
      ` The stack name or region in this stack's state record contains no ` +
      `renderable characters, so no recovery command can be suggested; inspect ` +
      `the lock object directly.`
    );
  }
  // The PROSE head needs the same sanitization as the command. Applying it only
  // inside `buildForceUnlockCommand` left the fix half-done: `region` comes
  // from the state.json BODY, so a `\n`-bearing one still produced a
  // multi-line message — the forgery surface, one clause earlier.
  return (
    `Could not acquire lock for ${subject} '${sanitizeForDisplay(stackName)}' ` +
    `(${sanitizeForDisplay(region)}) — ${held}.` +
    (suffix ? ` ${suffix}` : '') +
    ` ${advice} ${recoveryCommand}`
  );
}
