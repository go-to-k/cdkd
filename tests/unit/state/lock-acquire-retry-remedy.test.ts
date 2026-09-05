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
    expect(message).toContain('inspect the lock object directly');
    expect(message).toContain('would address a different lock');
  });

  it('quotes a stack name that needs it, so the suggestion is pastable', async () => {
    const message = await failureMessage('Parent~Child', 'us-east-1', LIVE_LOCK());
    expect(message).toContain("cdkd force-unlock 'Parent~Child' --stack-region us-east-1");
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
