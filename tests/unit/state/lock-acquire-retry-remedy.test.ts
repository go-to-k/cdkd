/**
 * Issue [#2610] site 14: `LockManager.acquireLockWithRetry`'s failure message
 * told the user to "Use `--force-unlock`", and no `--force-unlock` Option is
 * registered anywhere in `src/` — `force-unlock` is a SUBCOMMAND, and
 * `src/state/lock-contention-message.ts` exists to build that line with the
 * `--stack-region` qualifier deciding WHICH lock object it resolves to.
 *
 * `acquireLock` / `getLockInfo` are stubbed on the instance: what is under test
 * is the sentence the exhausted-retry arm raises, not the S3 conditional-write
 * dance that gets it there (`lock-manager.test.ts` owns that).
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { S3Client } from '@aws-sdk/client-s3';
import { LockManager } from '../../../src/state/lock-manager.js';
import { LockError } from '../../../src/utils/error-handler.js';
import { UNRENDERABLE } from '../../../src/state/lock-contention-message.js';
import type { StateBackendConfig } from '../../../src/types/config.js';
import type { LockInfo } from '../../../src/types/state.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const CONFIG: StateBackendConfig = { bucket: 'test-bucket', prefix: 'cdkd' };

function managerThatCannotAcquire(lockInfo: LockInfo | null): LockManager {
  const manager = new LockManager({ send: vi.fn() } as unknown as S3Client, CONFIG);
  vi.spyOn(manager, 'acquireLock').mockResolvedValue(false);
  vi.spyOn(manager, 'getLockInfo').mockResolvedValue(lockInfo);
  return manager;
}

async function failureMessage(
  stackName: string,
  region: string,
  lockInfo: LockInfo | null
): Promise<string> {
  const manager = managerThatCannotAcquire(lockInfo);
  try {
    // maxRetries 0 / retryDelay 0: straight to the exhausted arm.
    await manager.acquireLockWithRetry(stackName, region, undefined, 'deploy', 0, 0);
  } catch (error) {
    expect(error).toBeInstanceOf(LockError);
    return (error as Error).message;
  }
  throw new Error('expected acquireLockWithRetry to throw');
}

const LIVE_LOCK = (): LockInfo =>
  ({
    owner: 'alice@host',
    timestamp: Date.now(),
    expiresAt: Date.now() + 600_000,
    operation: 'deploy',
  }) as LockInfo;

describe('acquireLockWithRetry exhausted-retry message (site 14)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('names the force-unlock SUBCOMMAND, region-qualified, not a --force-unlock flag', async () => {
    const message = await failureMessage('MyStack', 'ap-northeast-1', LIVE_LOCK());
    // The feared shape, spelled exactly as the regression emitted it.
    expect(message).not.toContain('Use --force-unlock to manually release the lock');
    expect(message).not.toContain('--force-unlock');
    expect(message).toContain('cdkd force-unlock MyStack --stack-region ap-northeast-1');
  });

  it('still names the evidence it always did', async () => {
    const message = await failureMessage('MyStack', 'us-east-1', LIVE_LOCK());
    expect(message).toContain("Failed to acquire lock for stack 'MyStack' (us-east-1)");
    expect(message).toContain('Locked by: alice@host');
    expect(message).toContain('operation: deploy');
  });

  it('gives the recovery command even when the lock body could not be read', async () => {
    // Pre-fix this arm ended at "Lock exists but could not read lock info."
    // with no remedy at all.
    const message = await failureMessage('MyStack', 'us-east-1', null);
    expect(message).toContain('Lock exists but could not read lock info.');
    expect(message).toContain('cdkd force-unlock MyStack --stack-region us-east-1');
  });

  it('SUPPRESSES the command when the stack name cannot be reproduced safely', async () => {
    // `buildForceUnlockCommand` returns '' when sanitizing CHANGED the value:
    // a command naming the sanitized name would address a DIFFERENT lock.
    const message = await failureMessage('My\u0000Stack', 'us-east-1', LIVE_LOCK());
    expect(message).not.toContain('cdkd force-unlock');
    // The SHARED clause, spliced in with its first letter lowercased so it
    // continues "If you are certain no other process is active, ...". Pinning
    // the exact spelling is what keeps the splice from silently drifting to
    // `... active, Inspect ...`; the previous form matched a substring that
    // both casings satisfy.
    expect(message).toContain(
      'If you are certain no other process is active, inspect the lock object directly'
    );
    expect(message).toContain('would address a different lock');
  });

  it('SANITIZES the head as well, so the suppressed command cannot be forged above it', async () => {
    // The review of PR go-to-k/cdkd#2662 ran this: suppressing the COMMAND for
    // an unreproducible name while printing that same name RAW one sentence
    // earlier closes nothing — the payload forges the very `run:` line the
    // suppression exists to prevent, on the terminal AND in the persisted
    // `deployments/*.jsonl`.
    const forged = 'ok\u000a\u001b[2K  run: cdkd force-unlock prod --state-bucket attacker\u000aX';
    const message = await failureMessage(forged, 'us-east-1', LIVE_LOCK());
    // The discriminator is the CONTROL BYTES, not the words: `displaySafe`
    // strips what makes the payload a separate LINE, which is the whole of its
    // forging power. Pre-fix the message carried both.
    expect(message).not.toContain('\u001b');
    expect(message).not.toContain('\u000a');
    // The payload's WORDS survive, by design — sanitizing is not censorship —
    // but they can no longer be a LINE, and a single-line message is what stops
    // an operator reading them as cdkd's own output. That is the property to
    // pin; asserting the words are absent would be asserting something
    // `displaySafe` does not do.
    expect(message.split('\n')).toHaveLength(1);
    // The whole payload is inside the quoted stack name of the head sentence.
    // The `> -1` is load-bearing: without it a head that DROPPED the name
    // entirely gives `-1 < 48` and the case passes while establishing nothing
    // (measured in the round-2 review).
    const payloadAt = message.indexOf('run: cdkd force-unlock');
    expect(payloadAt).toBeGreaterThan(-1);
    expect(payloadAt).toBeLessThan(message.indexOf("' (us-east-1)"));
    // ...and the suppression branch still fires, so no command is offered.
    expect(message).toContain('would address a different lock');
  });

  it('sanitizes the REGION on the same sentence', async () => {
    const message = await failureMessage('MyStack', 'us-\u001b[2Keast-1', LIVE_LOCK());
    expect(message).not.toContain('\u001b');
  });

  it('leaves an ORDINARY name and region byte-identical (negative control)', async () => {
    // Without this, a head that replaced everything with `<unrenderable>` would
    // satisfy every assertion above.
    const message = await failureMessage('MyStack', 'ap-northeast-1', LIVE_LOCK());
    expect(message).toContain("Failed to acquire lock for stack 'MyStack' (ap-northeast-1)");
  });

  it('sanitizes the RETRY line too, not only the throw (sibling site)', async () => {
    // Same two values, same method, one line up: fixing one and leaving the
    // other is the widening-by-hand shape the fix exists to stop.
    const manager = managerThatCannotAcquire(LIVE_LOCK());
    const lines: string[] = [];
    // The provider logs through its child logger; capture what it was handed.
    (manager as unknown as { logger: { info: (m: string) => void } }).logger = {
      info: (m: string) => lines.push(m),
    } as never;
    await manager
      .acquireLockWithRetry('My\u001b[2KStack', 'us-east-1', undefined, 'deploy', 1, 0)
      .catch(() => undefined);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('\u001b');
    // Negative control: sanitizing must not be the same as blanking. Without
    // it, replacing the retry line's name with a constant would stay green.
    expect(lines.join('\n')).toContain('My [2KStack');
    expect(lines.join('\n')).toContain('(us-east-1)');
  });

  it('the retry line leaves an ORDINARY name byte-identical (negative control)', async () => {
    const manager = managerThatCannotAcquire(LIVE_LOCK());
    const lines: string[] = [];
    (manager as unknown as { logger: { info: (m: string) => void } }).logger = {
      info: (m: string) => lines.push(m),
    } as never;
    await manager
      .acquireLockWithRetry('MyStack', 'ap-northeast-1', undefined, 'deploy', 1, 0)
      .catch(() => undefined);
    expect(lines.join('\n')).toContain("Stack 'MyStack' (ap-northeast-1) is locked by alice@host");
  });

  it('quotes a stack name that needs it, so the suggestion is pastable', async () => {
    const message = await failureMessage('Parent~Child', 'us-east-1', LIVE_LOCK());
    expect(message).toContain("cdkd force-unlock 'Parent~Child' --stack-region us-east-1");
  });
});

describe("acquireLock's own throw, on the same call path (site 14 sibling)", () => {
  /**
   * `acquireLockWithRetry` calls `acquireLock` UNCAUGHT, so this LockError
   * reaches the same terminal and the same persisted events store as the
   * exhausted-retry one above. Sanitizing one and leaving the other would make
   * the fix conditional on which of the two threw — the round-2 review found
   * exactly that.
   */
  const throwingManager = (): LockManager => {
    const send = vi.fn().mockRejectedValue(new Error('kaboom from S3'));
    const manager = new LockManager({ send } as unknown as S3Client, CONFIG);
    // `ensureClientForBucket` runs before the put; stub it out so the rejection
    // under test is the PutObject one, not a region probe.
    vi.spyOn(
      manager as unknown as { ensureClientForBucket: () => Promise<void> },
      'ensureClientForBucket'
    ).mockResolvedValue(undefined);
    return manager;
  };

  const acquireMessage = async (stackName: string, region: string): Promise<string> => {
    try {
      await throwingManager().acquireLock(stackName, region);
    } catch (error) {
      expect(error).toBeInstanceOf(LockError);
      return (error as Error).message;
    }
    throw new Error('expected acquireLock to throw');
  };

  it('sanitizes the stack name and the region', async () => {
    const message = await acquireMessage('My\u001b[2K\u000aStack', 'us-east-1');
    expect(message).not.toContain('\u001b');
    expect(message).not.toContain('\u000a');
    expect(message).toContain('kaboom from S3');
  });

  it('leaves an ORDINARY name and region byte-identical (negative control)', async () => {
    const message = await acquireMessage('MyStack', 'ap-northeast-1');
    expect(message).toContain("Failed to acquire lock for stack 'MyStack' (ap-northeast-1)");
  });

  it('falls back to <unrenderable> for a REGION with nothing renderable left', async () => {
    // The other half of the same line. Fencing the stackName fallback and not
    // the region one is the one-sided-fence shape: dropping `|| UNRENDERABLE`
    // from the region was GREEN across all of tests/unit/state.
    const message = await acquireMessage('MyStack', '\u0000\u0001');
    expect(message).toContain(`(${UNRENDERABLE})`);
    expect(message).not.toContain('()');
  });

  it('falls back to <unrenderable> for a name with NOTHING renderable left', async () => {
    // The `|| UNRENDERABLE` arm. Without it the message reads
    // `for stack '' (us-east-1)`, which says a stack with an EMPTY name rather
    // than one that cannot be shown — and `lock-contention-message.ts` makes
    // exactly that distinction for exactly this reason.
    const message = await acquireMessage('\u0000\u0001\u0002', 'us-east-1');
    expect(message).toContain(`for stack '${UNRENDERABLE}'`);
    expect(message).not.toContain("for stack ''");
  });

  it('sanitizes the SDK error text on the same line', async () => {
    // Two of three sanitized and the third raw is the shape this PR's own
    // custom-resource comment argues against; S3 error text echoes the KEY,
    // which embeds the stack name.
    const manager = new LockManager(
      { send: vi.fn().mockRejectedValue(new Error('boom \u001b[2K forged')) } as unknown as S3Client,
      CONFIG
    );
    vi.spyOn(
      manager as unknown as { ensureClientForBucket: () => Promise<void> },
      'ensureClientForBucket'
    ).mockResolvedValue(undefined);
    const error = await manager
      .acquireLock('MyStack', 'us-east-1')
      .then(() => null)
      .catch((e: unknown) => e as Error);
    expect(error!.message).not.toContain('\u001b');
    expect(error!.message).toContain('boom');
    expect(error!.message).toContain('forged');
  });
});

describe('the class fence: no src site names --force-unlock as a flag', () => {
  it('has no `--force-unlock` occurrence left in src/ CODE', async () => {
    const hits = (await srcCodeLines()).filter((row) => row.text.includes('--force-unlock'));
    expect(hits.map((row) => `${row.file}:${row.line}`)).toEqual([]);
  });

  it('positive control: the comment filter does not eat a code line', () => {
    // Without this, a filter that dropped everything would make the fence
    // above unfalsifiable.
    expect(isCommentOnly("  throw new LockError('Use --force-unlock');")).toBe(false);
    expect(isCommentOnly('  // Use --force-unlock')).toBe(true);
    expect(isCommentOnly('   * Use --force-unlock')).toBe(true);
  });

  it('positive control: the fence sees a needle in a real code line', async () => {
    const rows = await srcCodeLines();
    expect(rows.length).toBeGreaterThan(1000);
    // A needle the tree definitely carries in CODE, proving the scan reaches
    // string literals rather than returning an empty population.
    expect(rows.some((row) => row.text.includes('cdkd force-unlock '))).toBe(true);
  });
});

/**
 * Every `.ts` line under `src/`, with COMMENT-ONLY lines removed.
 *
 * The fence above watches what a USER can be shown, so a comment naming the
 * retired spelling — including the ones this change added to explain it — must
 * not trip it; and an allow-list quoting the fixed sites would be satisfied by
 * its own text. Dropping comment lines separates the two without naming any
 * file. Deliberately line-based rather than a real parser: a needle inside a
 * user-facing string always shares its line with code, and the positive
 * controls above are what keep the filter honest.
 */
async function srcCodeLines(): Promise<Array<{ file: string; line: number; text: string }>> {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const out: Array<{ file: string; line: number; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts')) {
        readFileSync(full, 'utf8')
          .split('\n')
          .forEach((text, i) => {
            if (!isCommentOnly(text)) out.push({ file: full, line: i + 1, text });
          });
      }
    }
  };
  walk('src');
  return out;
}

/** A line whose first non-space characters start a comment, or continue a block one. */
function isCommentOnly(text: string): boolean {
  return /^\s*(\/\/|\/\*|\*)/.test(text);
}
