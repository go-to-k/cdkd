import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the
 * `force-unlock.ts` slice. The per-region catch reads the failure's text to
 * tell "no lock to delete" (a success) from a real delete failure, records the
 * latter and moves on to the next stack and region. It built that text with
 * `x instanceof Error ? x.message : String(x)`, and `String(Object.create(null))`
 * throws `TypeError: Cannot convert object to primitive value` -- so the catch
 * threw, the walk stopped at the first such failure, and every stack after it
 * was never attempted.
 */

const errorSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
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
    destroyClient: vi.fn(),
    listStacks: mockListStacks,
  })),
}));

const mockForceReleaseLock = vi.fn<(stackName: string, region?: string) => Promise<void>>();
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    forceReleaseLock: mockForceReleaseLock,
    getLockInfo: vi.fn(async () => null),
  })),
}));

import { createForceUnlockCommand } from '../../../src/cli/commands/force-unlock.js';

/** What `describeAwsFailure(x).detail` renders for a value `String()` cannot convert. */
const PLACEHOLDER = 'a value that could not be converted to text';

/** A rejection whose `String()` throws. */
const unconvertible = (): unknown => Object.create(null) as unknown;

/** Runs the command and returns the exit code `withErrorHandling` would have used. */
async function runForceUnlock(args: string[]): Promise<number | undefined> {
  let exitCode: number | undefined;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error('__process_exit__');
  }) as never);
  try {
    const cmd = createForceUnlockCommand();
    cmd.exitOverride();
    await cmd.parseAsync(args, { from: 'user' });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== '__process_exit__') throw error;
  } finally {
    exitSpy.mockRestore();
  }
  return exitCode;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cdkd force-unlock (#3361)', () => {
  it('a lock delete rejecting with an unconvertible value is recorded as a failure, and the walk goes on', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'First', region: 'us-east-1' },
      { stackName: 'Second', region: 'us-east-1' },
    ]);
    mockForceReleaseLock.mockImplementation(async (stackName: string) => {
      if (stackName === 'First') throw unconvertible();
    });

    const code = await runForceUnlock(['First', 'Second', '--state-bucket', 'b']);

    // `Second` comes after the failure and must still have been attempted.
    expect(mockForceReleaseLock).toHaveBeenCalledTimes(2);
    expect(mockForceReleaseLock).toHaveBeenNthCalledWith(2, 'Second', 'us-east-1', expect.any(Function));
    // Not the "No lock found" success arm: the run still reports failure.
    expect(code).toBe(1);
    const failed = errorSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('Failed to unlock stack'));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain(PLACEHOLDER);
  });
});
