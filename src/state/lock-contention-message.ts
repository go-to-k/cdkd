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
  /** The caller's `--state-prefix`, when it is not the default. */
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

/** Render `expiresIn` without implying more precision than a clock skew allows. */
function formatRemaining(ms: number): string {
  if (ms <= 0) return 'already expired';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'in under a minute';
  return `in ~${minutes}m`;
}

function shellQuote(value: string): string {
  // A profile / prefix / bucket with a space or a quote would otherwise produce
  // a suggestion that silently truncates when pasted.
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
  const parts = [`cdkd force-unlock ${shellQuote(stackName)} --stack-region ${region}`];
  if (recovery?.profile) parts.push(`--profile ${shellQuote(recovery.profile)}`);
  if (recovery?.stateBucket) parts.push(`--state-bucket ${shellQuote(recovery.stateBucket)}`);
  if (recovery?.statePrefix) parts.push(`--state-prefix ${shellQuote(recovery.statePrefix)}`);
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
  try {
    const info = await lockManager.getLockInfo(stackName, region);
    if (info) {
      const operation = info.operation ? `, operation: ${info.operation}` : '';
      const expires = formatRemaining(info.expiresAt - Date.now());
      held = `${heldClause ? `${heldClause} — ` : ''}held by ${info.owner}${operation}, expires ${expires}`;
    }
  } catch {
    // Best-effort: keep the evidence-free wording rather than masking the
    // contention with a read error.
  }

  const recoveryCommand = buildForceUnlockCommand(stackName, region, recovery);
  return (
    `Could not acquire lock for ${subject} '${stackName}' (${region}) — ${held}. ` +
    `Wait for it to finish, or run '${recoveryCommand}' if you are certain no other process is active.` +
    (suffix ? ` ${suffix}` : '')
  );
}
