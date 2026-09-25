import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * `cdkd force-unlock` names each stack and region it unlocks, and the region
 * comes from `listStacks()` -- an S3 key segment anyone who can write the state
 * bucket chooses. A newline in it (or in the typed name, or in S3's error text,
 * which echoes the lock key) forged a line of the banner and a ROW of the
 * multi-line failure summary (issue #3027). Each value now renders through the
 * identifier guard; the harness below is `force-unlock-exit-code.test.ts`'s.
 */

const errorSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: vi.fn(),
    error: errorSpy,
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));

const mockListStacks = vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    listStacks: mockListStacks,
  })),
}));

const mockForceReleaseLock = vi.fn<(stackName: string, region?: string) => Promise<void>>();
const mockGetLockInfo = vi.fn<() => Promise<unknown>>();
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    forceReleaseLock: mockForceReleaseLock,
    getLockInfo: mockGetLockInfo,
  })),
}));

import { createForceUnlockCommand } from '../../../src/cli/commands/force-unlock.js';

/**
 * Runs the command and returns the exit code the CLI would have used.
 *
 * `withErrorHandling` swallows the throw and calls `process.exit`, so the exit
 * code is the only observable the command's contract is written in — asserting
 * `rejects.toThrow` would pass against a version that exited 0.
 */
async function runForceUnlock(args: string[]): Promise<number | undefined> {
  let exitCode: number | undefined;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error('__process_exit__');
  }) as never);
  try {
    const cmd = createForceUnlockCommand();
    cmd.exitOverride();
    // Commander's `parseAsync` expects argv WITHOUT the leading subcommand
    // name when the command object is parsed directly.
    await cmd.parseAsync(args, { from: 'user' });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== '__process_exit__') throw error;
  } finally {
    exitSpy.mockRestore();
  }
  return exitCode;
}

const STACK = 'Evil\n[ok] FORGED-STACK\u001b[2J';
const REGION = 'us-east-1\n[ok] FORGED-REGION';
// The zero-width space is stripped only by the ASCII allowlist.
const ERROR_TEXT = 'AccessDenied:\u200b cdkd/Evil\n[ok] FORGED-ERROR';

const SHOWN_STACK = '"Evil [ok] FORGED-STACK [2J"';
const SHOWN_REGION = '"us-east-1 [ok] FORGED-REGION"';
const SHOWN_ERROR = 'AccessDenied:  cdkd/Evil [ok] FORGED-ERROR';

// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u200b\ufeff]/;

function lines(spy: ReturnType<typeof vi.fn>): string[] {
  return spy.mock.calls.flatMap((c) => String(c[0]).split('\n'));
}

/** Every rendered line mentioning the payload shows it inside its boundary. */
function expectNoForgedLine(all: string[], ...shown: string[]): void {
  const hits = all.filter((l) => l.includes('FORGED'));
  expect(hits.length).toBeGreaterThan(0);
  for (const l of hits) {
    expect(l, l).not.toMatch(UNSAFE);
    expect(l.trimStart().startsWith('[ok]'), l).toBe(false);
  }
  for (const s of shown) expect(hits.some((l) => l.includes(s)), s).toBe(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetLockInfo.mockResolvedValue(null);
});

describe('cdkd force-unlock renders hostile names, regions and errors flat (issue #3027)', () => {
  it('the banner and the success line, for a region from listStacks', async () => {
    mockListStacks.mockResolvedValue([{ stackName: STACK, region: REGION }]);
    mockForceReleaseLock.mockResolvedValue(undefined);

    expect(await runForceUnlock([STACK, '--state-bucket', 'b'])).toBeUndefined();
    const all = lines(infoSpy);
    expect(all.some((l) => l.startsWith('Force-unlocking stack:'))).toBe(true);
    expect(all.some((l) => l.startsWith('✓ Lock released for stack:'))).toBe(true);
    expectNoForgedLine(all, `${SHOWN_STACK} (${SHOWN_REGION})`);
  });

  it('the legacy lock key and the no-lock line', async () => {
    mockListStacks.mockResolvedValue([{ stackName: STACK }]);
    mockForceReleaseLock.mockRejectedValue(new Error('No lock found'));

    expect(await runForceUnlock([STACK, '--state-bucket', 'b'])).toBeUndefined();
    const all = lines(infoSpy);
    expect(all.some((l) => l.startsWith('No lock found for stack:'))).toBe(true);
    expectNoForgedLine(all, `${SHOWN_STACK} (legacy lock key)`);
  });

  it('the per-region error and every row of the failure summary', async () => {
    mockListStacks.mockResolvedValue([{ stackName: STACK, region: REGION }]);
    mockForceReleaseLock.mockRejectedValue(new Error(ERROR_TEXT));

    expect(await runForceUnlock([STACK, '--state-bucket', 'b'])).toBe(1);
    const all = lines(errorSpy);
    expect(all.some((l) => l.startsWith('Failed to unlock stack'))).toBe(true);
    // The summary keeps its own row structure: one header, one row per lock.
    expect(all.filter((l) => l.startsWith('  - ')).length).toBe(1);
    expectNoForgedLine(all, `${SHOWN_STACK} (${SHOWN_REGION}): ${SHOWN_ERROR}`);
  });

  it('an error with nothing renderable left takes the stand-in', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockForceReleaseLock.mockRejectedValue(new Error('\u0007\u200b'));

    expect(await runForceUnlock(['MyStack', '--state-bucket', 'b'])).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to unlock stack MyStack (us-east-1): <unrenderable>'
    );
  });

  it('a plain name and region render exactly as before', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockForceReleaseLock.mockResolvedValue(undefined);

    await runForceUnlock(['MyStack', '--state-bucket', 'b']);
    expect(infoSpy).toHaveBeenCalledWith('Force-unlocking stack: MyStack (us-east-1)');
    expect(infoSpy).toHaveBeenCalledWith('✓ Lock released for stack: MyStack (us-east-1)');
  });
});
