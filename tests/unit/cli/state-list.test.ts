import { inspect } from 'node:util';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// Shared so a case can read what `state list --long` logged at every level (issue #3069).
const mockLoggerWarn = vi.hoisted(() => vi.fn());
const mockLoggerOther = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), error: vi.fn() }));

// Mock logger to suppress output during tests.
vi.mock('../../../src/utils/logger.js', () => ({
  // Issue #2280: the commands under test call this under --json; the mock
  // must export it or the import is `undefined` and the call throws.
  reserveStdoutForPayload: vi.fn(),
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: mockLoggerOther.debug,
    info: mockLoggerOther.info,
    warn: mockLoggerWarn,
    error: mockLoggerOther.error,
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

// Mock state bucket resolver so we don't talk to STS.
vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

// Mock AwsClients factory: just hand back something with an s3 getter and
// destroy(). The S3StateBackend / LockManager are themselves mocked, so the
// concrete client value is irrelevant.
vi.mock('../../../src/utils/aws-clients.ts', () => {
  return {
    AwsClients: vi.fn().mockImplementation(() => ({
      get s3() {
        return {};
      },
      destroy: vi.fn(),
    })),
    setAwsClients: vi.fn(),
    getAwsClients: vi.fn(),
  };
});

// Mock S3StateBackend.
const mockListStacks =
  vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
const mockGetState =
  vi.fn<
    (
      stackName: string,
      region: string
    ) => Promise<{
      state: {
        // `unknown`, not `Record<string, unknown>`: `parseStateBody` validates
        // nothing inside the root, so a case must be able to plant any value.
        resources: unknown;
        lastModified: number;
        parentStack?: string;
        parentLogicalId?: string;
        parentRegion?: string;
      };
    } | null>
  >();
const mockVerifyBucketExists = vi.fn<() => Promise<void>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    listStacks: mockListStacks,
    getState: mockGetState,
    verifyBucketExists: mockVerifyBucketExists,
  })),
}));

// Mock LockManager.
const mockIsLocked = vi.fn<(stackName: string, region?: string) => Promise<boolean>>();
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    isLocked: mockIsLocked,
  })),
}));

import { createStateCommand } from '../../../src/cli/commands/state.js';

/**
 * Helper to capture process.stdout.write output.
 */
function captureStdout(): { output: string[]; restore: () => void } {
  const output: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // Replace with a recorder that always returns true (the boolean overload of write).
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  return {
    output,
    restore: () => {
      process.stdout.write = original;
    },
  };
}

async function runStateList(args: string[]): Promise<string> {
  const cap = captureStdout();
  try {
    const stateCmd = createStateCommand();
    // Disable Commander's exitOverride so action errors bubble up.
    stateCmd.exitOverride();
    stateCmd.commands.forEach((sub) => sub.exitOverride());
    // First arg is the subcommand name, remaining are flags.
    await stateCmd.parseAsync(args, { from: 'user' });
  } finally {
    cap.restore();
  }
  return cap.output.join('');
}

/**
 * Same as runStateList but also returns captured stderr. Used by the
 * deprecation-warning test below. Uses the same direct-replacement
 * technique as captureStdout because vi.spyOn on process.stderr.write
 * does not always intercept under vitest's output capture.
 */
async function runStateListWithStderr(args: string[]): Promise<{
  stdout: string;
  stderr: string;
}> {
  const cap = captureStdout();
  const errOutput: string[] = [];
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    errOutput.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    const stateCmd = createStateCommand();
    stateCmd.exitOverride();
    stateCmd.commands.forEach((sub) => sub.exitOverride());
    await stateCmd.parseAsync(args, { from: 'user' });
  } finally {
    cap.restore();
    process.stderr.write = originalErr;
  }
  return {
    stdout: cap.output.join(''),
    stderr: errOutput.join(''),
  };
}

describe('cdkd state list', () => {
  beforeEach(() => {
    mockListStacks.mockReset();
    mockGetState.mockReset();
    mockIsLocked.mockReset();
    mockVerifyBucketExists.mockReset();
    mockVerifyBucketExists.mockResolvedValue();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('emits nothing when no stacks are registered (default)', async () => {
    mockListStacks.mockResolvedValue([]);
    const out = await runStateList(['list']);
    expect(out).toBe('');
  });

  it('prints "Stack (region)" sorted alphabetically, one per line', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'Charlie', region: 'us-east-1' },
      { stackName: 'alpha', region: 'us-west-2' },
      { stackName: 'Bravo', region: 'eu-west-1' },
    ]);
    const out = await runStateList(['list']);
    expect(out).toBe('Bravo (eu-west-1)\nCharlie (us-east-1)\nalpha (us-west-2)\n');
  });

  it('renders the same stack name in two regions as two rows', async () => {
    // The whole point of region-prefixed state keys: a stack name can have
    // independent state per region. `state list` should surface that.
    mockListStacks.mockResolvedValue([
      { stackName: 'MyStack', region: 'us-west-2' },
      { stackName: 'MyStack', region: 'us-east-1' },
    ]);
    const out = await runStateList(['list']);
    expect(out).toBe('MyStack (us-east-1)\nMyStack (us-west-2)\n');
  });

  it('renders legacy version-1 records (no region) as plain stack name', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'LegacyStack' /* region: undefined */ },
    ]);
    const out = await runStateList(['list']);
    expect(out).toBe('LegacyStack\n');
  });

  it('supports the `ls` alias', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'One', region: 'us-east-1' },
      { stackName: 'Two', region: 'us-east-1' },
    ]);
    const out = await runStateList(['ls']);
    expect(out).toBe('One (us-east-1)\nTwo (us-east-1)\n');
  });

  it('emits a JSON array of {stackName, region} with --json', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'B', region: 'us-east-1' },
      { stackName: 'a', region: 'us-west-2' },
      { stackName: 'C' /* legacy */ },
    ]);
    const out = await runStateList(['list', '--json']);
    expect(JSON.parse(out)).toEqual([
      { stackName: 'B', region: 'us-east-1' },
      { stackName: 'C', region: null },
      { stackName: 'a', region: 'us-west-2' },
    ]);
  });

  it('emits long human-readable details with --long', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'StackA', region: 'us-east-1' },
      { stackName: 'StackB', region: 'us-west-2' },
    ]);
    mockGetState.mockImplementation(async (name) => {
      if (name === 'StackA') {
        return {
          state: {
            resources: { R1: {}, R2: {}, R3: {} },
            lastModified: Date.UTC(2026, 3, 29, 10, 23, 45),
          },
        };
      }
      return {
        state: {
          resources: {},
          lastModified: Date.UTC(2026, 3, 25, 8, 0, 0),
        },
      };
    });
    mockIsLocked.mockImplementation(async (name) => name === 'StackB');

    const out = await runStateList(['list', '--long']);

    expect(out).toContain('StackA (us-east-1)');
    expect(out).toContain('  Region: us-east-1');
    expect(out).toContain('  Resources: 3');
    expect(out).toContain('  Last Modified: 2026-04-29T10:23:45.000Z');
    expect(out).toContain('  Lock: unlocked');
    expect(out).toContain('StackB (us-west-2)');
    expect(out).toContain('  Region: us-west-2');
    expect(out).toContain('  Resources: 0');
    expect(out).toContain('  Last Modified: 2026-04-25T08:00:00.000Z');
    expect(out).toContain('  Lock: locked');
  });

  it('handles missing state by reporting zero resources and unknown last-modified', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'Orphan', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue(null);
    mockIsLocked.mockResolvedValue(false);

    const out = await runStateList(['list', '--long']);

    expect(out).toContain('Orphan');
    expect(out).toContain('  Resources: 0');
    expect(out).toContain('  Last Modified: unknown');
    expect(out).toContain('  Lock: unlocked');
  });

  it('emits a JSON array of details when --long --json is combined', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'X', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({
      state: {
        resources: { R1: {}, R2: {} },
        lastModified: Date.UTC(2026, 0, 1, 0, 0, 0),
      },
    });
    mockIsLocked.mockResolvedValue(true);

    const out = await runStateList(['list', '--long', '--json']);

    const parsed = JSON.parse(out);
    expect(parsed).toEqual([
      {
        stackName: 'X',
        region: 'us-east-1',
        resourceCount: 2,
        lastModified: '2026-01-01T00:00:00.000Z',
        locked: true,
        stateReadError: null,
        lockReadError: null,
      },
    ]);
  });

  it('fetches state and lock status for each (stackName, region) pair', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'One', region: 'us-east-1' },
      { stackName: 'Two', region: 'us-west-2' },
    ]);
    mockGetState.mockResolvedValue({
      state: { resources: {}, lastModified: 0 },
    });
    mockIsLocked.mockResolvedValue(false);

    await runStateList(['list', '--long']);

    expect(mockGetState).toHaveBeenCalledWith('One', 'us-east-1');
    expect(mockGetState).toHaveBeenCalledWith('Two', 'us-west-2');
    expect(mockIsLocked).toHaveBeenCalledWith('One', 'us-east-1');
    expect(mockIsLocked).toHaveBeenCalledWith('Two', 'us-west-2');
  });

  /**
   * One unreadable stack must cost only ITS row (issue #3069). Before the fix
   * the first rejection in the per-row `Promise.all` rejected the whole
   * listing, so the command printed no row at all.
   *
   * Every assertion reads ONE row's block. A whole-output assertion would be
   * wrong in both directions here: the degraded row legitimately carries
   * `unknown`, so "`unknown` does not appear" fails on correct code, and the
   * healthy peer carries every label a degraded row does, so "the label
   * appears" passes whichever row printed it.
   */
  describe('--long degrades a row whose read fails (#3069)', () => {
    const STATE_REASON = 'state record could not be read; run `cdkd state show` for the error';
    const LOCK_REASON = 'lock could not be read; run `cdkd state show` for the error';

    /** The text block for `ref` in `--long` output: its header line through the next blank line. */
    function blockOf(out: string, ref: string): string {
      const blocks = out.trimEnd().split('\n\n');
      const matches = blocks.filter((b) => b.split('\n')[0] === ref);
      expect(matches).toHaveLength(1);
      return matches[0]!;
    }

    function accessDenied(): Error {
      return Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
    }

    beforeEach(() => {
      mockLoggerWarn.mockReset();
      mockLoggerOther.debug.mockReset();
      mockLoggerOther.info.mockReset();
      mockLoggerOther.error.mockReset();
    });

    it('still prints the healthy peer when the other stack\'s record read rejects', async () => {
      mockListStacks.mockResolvedValue([
        { stackName: 'Broken', region: 'us-east-1' },
        { stackName: 'Healthy', region: 'us-east-1' },
      ]);
      mockGetState.mockImplementation(async (name) => {
        if (name === 'Broken') throw accessDenied();
        return { state: { resources: { A: {}, B: {} }, lastModified: Date.UTC(2026, 8, 1) } };
      });
      mockIsLocked.mockResolvedValue(false);

      const out = await runStateList(['list', '--long']);

      expect(blockOf(out, 'Healthy (us-east-1)')).toBe(
        [
          'Healthy (us-east-1)',
          '  Region: us-east-1',
          '  Resources: 2',
          '  Last Modified: 2026-09-01T00:00:00.000Z',
          '  Lock: unlocked',
        ].join('\n')
      );
      expect(blockOf(out, 'Broken (us-east-1)')).toBe(
        [
          'Broken (us-east-1)',
          '  Region: us-east-1',
          `  Resources: unknown (${STATE_REASON})`,
          '  Last Modified: unknown',
          '  Lock: unlocked',
        ].join('\n')
      );
    });

    it('keeps the LOCK of a row whose RECORD failed, and the COUNTS of a row whose LOCK failed', async () => {
      mockListStacks.mockResolvedValue([
        { stackName: 'RecordFails', region: 'us-east-1' },
        { stackName: 'LockFails', region: 'us-east-1' },
      ]);
      mockGetState.mockImplementation(async (name) => {
        if (name === 'RecordFails') throw accessDenied();
        // Nonzero, so a count replaced by a default 0 would show.
        return { state: { resources: { A: {}, B: {}, C: {} }, lastModified: Date.UTC(2026, 8, 2) } };
      });
      mockIsLocked.mockImplementation(async (name) => {
        if (name === 'LockFails') throw accessDenied();
        // `true`, so a lock replaced by a default `unlocked` would show.
        return true;
      });

      const out = await runStateList(['list', '--long']);

      const recordFails = blockOf(out, 'RecordFails (us-east-1)');
      expect(recordFails).toContain(`  Resources: unknown (${STATE_REASON})`);
      expect(recordFails).toContain('  Lock: locked');

      const lockFails = blockOf(out, 'LockFails (us-east-1)');
      expect(lockFails).toContain('  Resources: 3');
      expect(lockFails).toContain('  Last Modified: 2026-09-02T00:00:00.000Z');
      expect(lockFails).toContain(`  Lock: unknown (${LOCK_REASON})`);
    });

    it('reports each failed side separately in --long --json, with null rather than a fabricated value', async () => {
      mockListStacks.mockResolvedValue([
        { stackName: 'LockFails', region: 'us-east-1' },
        { stackName: 'RecordFails', region: 'us-east-1' },
      ]);
      mockGetState.mockImplementation(async (name) => {
        if (name === 'RecordFails') throw accessDenied();
        return { state: { resources: { A: {} }, lastModified: Date.UTC(2026, 8, 3) } };
      });
      mockIsLocked.mockImplementation(async (name) => {
        if (name === 'LockFails') throw accessDenied();
        return true;
      });

      const out = await runStateList(['list', '--long', '--json']);

      expect(JSON.parse(out)).toEqual([
        {
          stackName: 'LockFails',
          region: 'us-east-1',
          resourceCount: 1,
          lastModified: '2026-09-03T00:00:00.000Z',
          locked: null,
          stateReadError: null,
          lockReadError: LOCK_REASON,
        },
        {
          stackName: 'RecordFails',
          region: 'us-east-1',
          resourceCount: null,
          lastModified: null,
          locked: true,
          stateReadError: STATE_REASON,
          lockReadError: null,
        },
      ]);
    });

    it('does not copy the caught message into either output mode or the warning', async () => {
      // `getState`'s invalid-JSON refusal quotes bytes of the state body, which
      // whoever can write the bucket chooses. A reason copied from the caught
      // message would carry this canary.
      const CANARY = 'CANARY-plaintext-3069-q7x';
      mockListStacks.mockResolvedValue([{ stackName: 'Planted', region: 'us-east-1' }]);
      // The real `StateError` carries the parser's `SyntaxError` as `cause`, so
      // the canary is planted one link down as well as in the message.
      mockGetState.mockRejectedValue(
        new Error(`Failed to parse state: Unexpected token '${CANARY}' is not valid JSON`, {
          cause: new SyntaxError(`Unexpected token '${CANARY}'`),
        })
      );
      mockIsLocked.mockRejectedValue(
        new Error(`lock body ${CANARY}`, { cause: new SyntaxError(CANARY) })
      );

      const text = await runStateListWithStderr(['list', '--long']);
      const json = await runStateListWithStderr(['list', '--long', '--json']);

      // Premise: BOTH rejections really reached the row, so the absence below
      // is not the absence of a row or of a degraded side.
      expect(text.stdout).toContain(`Resources: unknown (${STATE_REASON})`);
      expect(text.stdout).toContain(`Lock: unknown (${LOCK_REASON})`);
      expect(JSON.parse(json.stdout)[0].stateReadError).toBe(STATE_REASON);
      expect(JSON.parse(json.stdout)[0].lockReadError).toBe(LOCK_REASON);
      for (const stream of [text.stdout, text.stderr, json.stdout, json.stderr]) {
        expect(stream).not.toContain(CANARY);
      }
      // Every logger level, not only `warn`: a `debug` of the caught error would
      // put it on stderr under `--verbose`.
      for (const spy of [mockLoggerWarn, mockLoggerOther.debug, mockLoggerOther.info, mockLoggerOther.error]) {
        for (const call of spy.mock.calls) {
          // `inspect` renders an Error nested inside an object, and its `cause`,
          // where `JSON.stringify` would print `{}`.
          expect(inspect(call, { depth: 10 })).not.toContain(CANARY);
        }
      }
    });

    it('warns with a count of degraded rows, and does not warn when every read succeeds', async () => {
      mockListStacks.mockResolvedValue([
        { stackName: 'Ok', region: 'us-east-1' },
        { stackName: 'Bad', region: 'us-east-1' },
        { stackName: 'AlsoOk', region: 'us-east-1' },
      ]);
      mockGetState.mockImplementation(async (name) => {
        if (name === 'Bad') throw accessDenied();
        return { state: { resources: {}, lastModified: 0 } };
      });
      mockIsLocked.mockResolvedValue(false);

      await runStateList(['list', '--long']);

      expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
      expect(mockLoggerWarn.mock.calls[0]![0]).toBe(
        '1 of 3 stack(s) could not be fully read or counted; their rows say why.'
      );

      mockLoggerWarn.mockReset();
      mockGetState.mockResolvedValue({ state: { resources: {}, lastModified: 0 } });

      const healthy = await runStateList(['list', '--long']);

      // Premise: the rows really printed, so the silence is not an early exit.
      expect(healthy.match(/^ {2}Resources: 0$/gm)).toHaveLength(3);
      expect(mockLoggerWarn).not.toHaveBeenCalled();
    });

    it('counts a row whose LOCK alone failed in the warning', async () => {
      mockListStacks.mockResolvedValue([
        { stackName: 'LockOnly', region: 'us-east-1' },
        { stackName: 'Fine', region: 'us-east-1' },
      ]);
      mockGetState.mockResolvedValue({ state: { resources: {}, lastModified: 0 } });
      mockIsLocked.mockImplementation(async (name) => {
        if (name === 'LockOnly') throw accessDenied();
        return false;
      });

      await runStateList(['list', '--long']);

      expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
      expect(mockLoggerWarn.mock.calls[0]![0]).toBe(
        '1 of 2 stack(s) could not be fully read or counted; their rows say why.'
      );
    });

    it('degrades only the lock of a legacy row with no region, whose record is never read', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'Legacy' /* no region */ }]);
      mockIsLocked.mockRejectedValue(accessDenied());

      const out = await runStateList(['list', '--long']);

      expect(mockGetState).not.toHaveBeenCalled();
      expect(blockOf(out, 'Legacy')).toBe(
        [
          'Legacy',
          '  Region: (legacy)',
          '  Resources: 0',
          '  Last Modified: unknown',
          // Not LOCK_REASON: `cdkd state show` refuses a region-less record
          // before it reads the lock, so this row names no follow-up.
          '  Lock: unknown (lock could not be read)',
        ].join('\n')
      );
    });

    it('renders an out-of-range lastModified as unknown instead of rejecting the listing', async () => {
      // `new Date(1e300).toISOString()` throws a RangeError, AFTER the read
      // guard has already reported success.
      expect(() => new Date(1e300).toISOString()).toThrow(RangeError);
      mockListStacks.mockResolvedValue([
        { stackName: 'Huge', region: 'us-east-1' },
        { stackName: 'Healthy', region: 'us-east-1' },
      ]);
      mockGetState.mockImplementation(async (name) => ({
        state: {
          resources: { A: {} },
          lastModified: name === 'Huge' ? 1e300 : Date.UTC(2026, 8, 4),
        },
      }));
      mockIsLocked.mockResolvedValue(false);

      const out = await runStateList(['list', '--long']);

      expect(blockOf(out, 'Huge (us-east-1)')).toContain('  Last Modified: unknown');
      expect(blockOf(out, 'Healthy (us-east-1)')).toContain(
        '  Last Modified: 2026-09-04T00:00:00.000Z'
      );
    });

    it('cannot forge a line in the --long text view through a control character in the stack name or region', async () => {
      const EVIL_NAME = 'Evil\n  Lock: unlocked\u001b[31m';
      const EVIL_REGION = 'us-east-1\n  Resources: 999';
      mockListStacks.mockResolvedValue([{ stackName: EVIL_NAME, region: EVIL_REGION }]);
      mockGetState.mockResolvedValue({ state: { resources: { A: {} }, lastModified: 0 } });
      mockIsLocked.mockResolvedValue(true);

      const out = await runStateList(['list', '--long']);

      // The inputs carry newlines, so a raw render adds lines: the exact line
      // count and the single `Lock:` / `Resources:` lines below are what break.
      expect(EVIL_NAME).toContain('\n');
      expect(EVIL_REGION).toContain('\n');
      expect(out).not.toContain('\u001b');
      const lines = out.trimEnd().split('\n');
      expect(lines).toHaveLength(5);
      expect(lines.filter((l) => l.startsWith('  Lock:'))).toEqual(['  Lock: locked']);
      expect(lines.filter((l) => l.startsWith('  Resources:'))).toEqual(['  Resources: 1']);
    });

    it('cannot forge a line in the --tree text view through a control character in the stack name', async () => {
      mockListStacks.mockResolvedValue([
        { stackName: 'Evil\n└── Forged (us-east-1)\u001b[31m', region: 'us-east-1' },
      ]);
      mockGetState.mockResolvedValue({ state: { resources: {}, lastModified: 0 } });

      const out = await runStateList(['list', '--tree']);

      expect(out).not.toContain('\u001b');
      // The single line is the sanitized label itself, not an empty output.
      const lines = out.trimEnd().split('\n');
      expect(lines).toHaveLength(1);
      // Issue #3164: the label is now JSON-QUOTED, because the sanitized form
      // carries this view's own connector characters and a bare render would
      // read as a genuine sibling row. The `(us-east-1)` OUTSIDE the closing
      // quote is cdkd's annotation; the one inside is the planted text.
      expect(lines[0]).toMatch(/^"Evil .*Forged \(us-east-1\).*" \(us-east-1\)$/);
    });

    it('reports a resources value that is not a JSON object as unknown instead of counting it', async () => {
      const ABSENT = Symbol('absent');
      const bags: Record<string, unknown> = {
        Str: 'abcdef',
        List: [1, 2, 3],
        Num: 42,
        Bool: true,
        NullBag: null,
        Absent: ABSENT,
        Healthy: { A: {}, B: {} },
      };
      mockListStacks.mockResolvedValue(
        Object.keys(bags).map((stackName) => ({ stackName, region: 'us-east-1' }))
      );
      mockGetState.mockImplementation(async (name) => ({
        state: {
          ...(bags[name] !== ABSENT && { resources: bags[name] }),
          lastModified: 0,
        } as { resources: unknown; lastModified: number },
      }));
      mockIsLocked.mockResolvedValue(false);

      const text = await runStateList(['list', '--long']);
      // The four malformed rows are counted; the absent and `null` bags are not.
      expect(mockLoggerWarn.mock.calls.map((call) => call[0])).toEqual([
        '4 of 7 stack(s) could not be fully read or counted; their rows say why.',
      ]);
      const json = await runStateList(['list', '--long', '--json']);

      const malformed =
        'unknown (resources is not a JSON object; run `cdkd state show --json` to see the record)';
      const resourcesLine = (name: string): string =>
        text
          .split('\n\n')
          .find((block) => block.startsWith(`${name} (us-east-1)\n`))!
          .split('\n')
          .find((line) => line.startsWith('  Resources:'))!;
      expect(Object.keys(bags).map((name) => [name, resourcesLine(name)])).toEqual([
        ['Str', `  Resources: ${malformed}`],
        ['List', `  Resources: ${malformed}`],
        ['Num', `  Resources: ${malformed}`],
        ['Bool', `  Resources: ${malformed}`],
        ['NullBag', '  Resources: 0'],
        ['Absent', '  Resources: 0'],
        ['Healthy', '  Resources: 2'],
      ]);
      const reason = 'resources is not a JSON object; run `cdkd state show --json` to see the record';
      const rows = JSON.parse(json) as Array<{
        stackName: string;
        resourceCount: number | null;
        stateReadError: string | null;
      }>;
      expect(
        Object.keys(bags).map((name) => {
          const row = rows.find((r) => r.stackName === name)!;
          return [name, row.resourceCount, row.stateReadError];
        })
      ).toEqual([
        ['Str', null, reason],
        ['List', null, reason],
        ['Num', null, reason],
        ['Bool', null, reason],
        ['NullBag', 0, null],
        ['Absent', 0, null],
        ['Healthy', 2, null],
      ]);
    });

    it('keeps --tree whole when a record read resolves to no record', async () => {
      mockListStacks.mockResolvedValue([
        { stackName: 'Gone', region: 'us-east-1' },
        { stackName: 'Healthy', region: 'us-east-1' },
      ]);
      // `getState` resolves `null` for a key that disappeared between the
      // listing and the read, so the link rule must not dereference the state.
      mockGetState.mockImplementation(async (name) =>
        name === 'Gone' ? null : { state: { resources: {}, lastModified: 0 } }
      );

      const text = await runStateList(['list', '--tree']);
      const json = await runStateList(['list', '--tree', '--json']);

      expect(text.trimEnd().split('\n')).toEqual(['Gone (us-east-1)', 'Healthy (us-east-1)']);
      expect(
        JSON.parse(json).map((n: { stackName: string; parentStack: unknown }) => [n.stackName, n.parentStack])
      ).toEqual([
        ['Gone', null],
        ['Healthy', null],
      ]);
    });

    it('keeps --tree whole when a record holds a non-string parentStack', async () => {
      mockListStacks.mockResolvedValue([
        { stackName: 'Planted', region: 'us-east-1' },
        { stackName: 'Healthy', region: 'us-east-1' },
      ]);
      mockGetState.mockImplementation(async (name) => ({
        state: {
          resources: {},
          lastModified: 0,
          ...(name === 'Planted' && {
            // Interpolating this into a string throws a TypeError.
            parentStack: { toString: null } as unknown as string,
            parentRegion: ['us-east-1'] as unknown as string,
            // Never interpolated, but `--tree --json` declares it string | null.
            parentLogicalId: { toString: null } as unknown as string,
          }),
        },
      }));
      expect(() => `${{ toString: null } as unknown as string}`).toThrow(TypeError);

      const text = await runStateList(['list', '--tree']);
      const json = await runStateList(['list', '--tree', '--json']);

      expect(text.trimEnd().split('\n')).toEqual(['Healthy (us-east-1)', 'Planted (us-east-1)']);
      expect(
        JSON.parse(json).map((n: { stackName: string; parentStack: unknown; parentLogicalId: unknown }) => [
          n.stackName,
          n.parentStack,
          n.parentLogicalId,
        ])
      ).toEqual([
        ['Healthy', null, null],
        ['Planted', null, null],
      ]);
    });

    /**
     * The whole-link rule as a TABLE over `parentStack` x `parentRegion`
     * shapes, so a mutant of any arm of `linkIsValid` fails a row rather than
     * surviving until someone thinks of its one missing case. `null` is the
     * shape many JSON writers emit for an unset field, where `JSON.stringify`
     * itself omits it, which is the `absent` shape.
     *
     * Three records share the name `Parent`'s space: a legacy region-less
     * `Parent`, a regional `Parent` in `us-east-1`, and the `Child` carrying
     * the pair. Each expected value is written out, not derived from the rule
     * under test:
     * - `where`: `regional` / `legacy` (nested under that `Parent`) or `root`;
     * - `parentStack`: the value `--tree --json` emits for `Child`, so a kept
     *   link is checked by VALUE, not merely for being present.
     */
    describe('the parent-link rule as a table', () => {
      const ABSENT = Symbol('absent');
      const shapes = {
        "'Parent'": 'Parent',
        absent: ABSENT,
        null: null,
        '{toString: null}': { toString: null },
        '123': 123,
        "''": '',
      } as const;
      type ShapeName = keyof typeof shapes;
      type Verdict = { where: 'regional' | 'legacy' | 'root'; parentStack: string | null };
      const R: Verdict = { where: 'root', parentStack: null };
      // Rows: parentStack. Columns, in order: 'us-east-1', absent, null,
      // {toString: null}, 123, ''.
      const regionColumns = ["'us-east-1'", 'absent', 'null', '{toString: null}', '123', "''"] as const;
      const regionValue = {
        "'us-east-1'": 'us-east-1',
        absent: ABSENT,
        null: null,
        '{toString: null}': { toString: null },
        '123': 123,
        "''": '',
      } as const;
      const table: Record<ShapeName, Verdict[]> = {
        "'Parent'": [
          { where: 'regional', parentStack: 'Parent' },
          { where: 'legacy', parentStack: 'Parent' },
          R,
          R,
          R,
          // A string '' region is a valid link and keys like a legacy record.
          { where: 'legacy', parentStack: 'Parent' },
        ],
        absent: [R, R, R, R, R, R],
        null: [R, R, R, R, R, R],
        '{toString: null}': [R, R, R, R, R, R],
        '123': [R, R, R, R, R, R],
        // A string '' parentStack is a valid link that names no record.
        "''": [
          { where: 'root', parentStack: '' },
          { where: 'root', parentStack: '' },
          R,
          R,
          R,
          { where: 'root', parentStack: '' },
        ],
      };

      const rows = (Object.keys(table) as ShapeName[]).flatMap((stackName) =>
        regionColumns.map((regionName, i) => ({ stackName, regionName, expected: table[stackName][i]! }))
      );

      // A shrunk `regionColumns` list or a dropped stack row would shrink the
      // product and stay green, so the product size is pinned beside its
      // definition. A SHORT verdict row does not shrink it: `regionColumns.map`
      // still yields six rows, and the missing verdict fails its own row.
      it('covers every parentStack x parentRegion pair: 6 x 6', () => {
        expect(rows).toHaveLength(36);
        expect(new Set(rows.map((r) => `${r.stackName}|${r.regionName}`)).size).toBe(36);
      });

      it.each(rows)(
        'parentStack $stackName with parentRegion $regionName',
        async ({ stackName, regionName, expected }) => {
          const stackValue = shapes[stackName];
          const region = regionValue[regionName];
          // `null` and `123` are also STACK NAMES here: a link that admitted a
          // non-string `parentStack` would key it as that text and bind to the
          // same-named record, so each must stay childless on every row.
          mockListStacks.mockResolvedValue([
            { stackName: 'Child', region: 'us-east-1' },
            { stackName: 'Parent' /* legacy, no region */ },
            { stackName: 'Parent', region: 'us-east-1' },
            { stackName: 'null', region: 'us-east-1' },
            { stackName: '123', region: 'us-east-1' },
          ]);
          mockGetState.mockImplementation(async (name) => ({
            state: {
              resources: {},
              lastModified: 0,
              ...(name === 'Child' && {
                ...(stackValue !== ABSENT && { parentStack: stackValue as unknown as string }),
                ...(region !== ABSENT && { parentRegion: region as unknown as string }),
              }),
            },
          }));

          const json = await runStateList(['list', '--tree', '--json']);

          type Node = { stackName: string; region: string | null; parentStack: unknown; children: Node[] };
          const roots = JSON.parse(json) as Node[];
          const child = [...roots, ...roots.flatMap((n) => n.children)].filter((n) => n.stackName === 'Child');
          expect(child).toHaveLength(1);
          for (const coerced of ['null', '123']) {
            expect(roots.find((n) => n.stackName === coerced)!.children).toEqual([]);
          }
          const where = roots.some((n) => n.stackName === 'Child')
            ? 'root'
            : roots.find((n) => n.stackName === 'Parent' && n.region === null)!.children.length > 0
              ? 'legacy'
              : 'regional';
          expect({ where, parentStack: child[0]!.parentStack }).toEqual(expected);
        }
      );
    });

    it('drops a half-valid parent link WHOLE, so it cannot bind to a legacy record of the same name', async () => {
      mockListStacks.mockResolvedValue([
        { stackName: 'Child', region: 'us-east-1' },
        { stackName: 'Parent' /* legacy, no region */ },
        { stackName: 'Parent', region: 'us-east-1' },
      ]);
      mockGetState.mockImplementation(async (name) => ({
        state: {
          resources: {},
          lastModified: 0,
          ...(name === 'Child' && {
            parentStack: 'Parent',
            parentLogicalId: 'Child',
            parentRegion: { toString: null } as unknown as string,
          }),
        },
      }));

      const json = await runStateList(['list', '--tree', '--json']);

      type Node = { stackName: string; region: string | null; parentStack: unknown; children: Node[] };
      const roots = JSON.parse(json) as Node[];
      // Kept with only its region dropped, `Child` would key as `Parent` with
      // no region and nest under the LEGACY `Parent`.
      expect(roots.map((n) => [n.stackName, n.region, n.parentStack, n.children.length])).toEqual([
        ['Child', 'us-east-1', null, 0],
        ['Parent', 'us-east-1', null, 0],
        ['Parent', null, null, 0],
      ]);
    });

    it('still nests a child whose parentStack names a LEGACY region-less parent and whose parentRegion is absent', async () => {
      // The legitimate half of the whole-link rule: an absent `parentRegion`
      // is a valid link, not a half-valid one. Requiring a string region would
      // promote this child to the root.
      mockListStacks.mockResolvedValue([
        { stackName: 'Parent' /* legacy, no region */ },
        { stackName: 'Parent~Child', region: 'us-east-1' },
      ]);
      mockGetState.mockImplementation(async (name) => ({
        state: {
          resources: {},
          lastModified: 0,
          ...(name === 'Parent~Child' && { parentStack: 'Parent' }),
        },
      }));

      const json = await runStateList(['list', '--tree', '--json']);

      type Node = { stackName: string; region: string | null; children: Node[] };
      const roots = JSON.parse(json) as Node[];
      expect(roots.map((n) => [n.stackName, n.region, n.children.map((c) => c.stackName)])).toEqual([
        ['Parent', null, ['Parent~Child']],
      ]);
    });

    it('keeps a valid link but drops a non-string parentLogicalId on it', async () => {
      // `parentLogicalId` is informational: a bad value must not break the
      // link, and must not reach `--tree --json`, which declares it string | null.
      mockListStacks.mockResolvedValue([
        { stackName: 'Parent', region: 'us-east-1' },
        { stackName: 'Parent~Child', region: 'us-east-1' },
      ]);
      mockGetState.mockImplementation(async (name) => ({
        state: {
          resources: {},
          lastModified: 0,
          ...(name === 'Parent~Child' && {
            parentStack: 'Parent',
            parentRegion: 'us-east-1',
            parentLogicalId: { toString: null } as unknown as string,
          }),
        },
      }));

      const json = await runStateList(['list', '--tree', '--json']);

      type Node = { stackName: string; parentStack: unknown; parentLogicalId: unknown; children: Node[] };
      const roots = JSON.parse(json) as Node[];
      expect(roots.map((n) => n.stackName)).toEqual(['Parent']);
      expect(roots[0]!.children.map((c) => [c.stackName, c.parentStack, c.parentLogicalId])).toEqual([
        ['Parent~Child', 'Parent', null],
      ]);
    });

    it('drops a string parentRegion too when the parentStack beside it is not a string', async () => {
      // The other direction of a half-valid link: a region copied on its own
      // would print as a parent region for a stack with no parent.
      mockListStacks.mockResolvedValue([{ stackName: 'Planted', region: 'us-east-1' }]);
      mockGetState.mockResolvedValue({
        state: {
          resources: {},
          lastModified: 0,
          parentStack: { toString: null } as unknown as string,
          parentLogicalId: 'Planted',
          parentRegion: 'us-east-1',
        },
      });

      const json = await runStateList(['list', '--tree', '--json']);

      const roots = JSON.parse(json) as Array<Record<string, unknown>>;
      expect(roots).toHaveLength(1);
      expect([roots[0]!['parentStack'], roots[0]!['parentLogicalId'], roots[0]!['parentRegion']]).toEqual([
        null,
        null,
        null,
      ]);
    });

    it('cannot forge a reference line in the default listing through a control character in the stack name', async () => {
      mockListStacks.mockResolvedValue([
        { stackName: 'Decoy\nProdStack (us-east-1)\u001b[1A', region: 'us-east-1' },
      ]);

      const out = await runStateList(['list']);

      expect(out).not.toContain('\u001b');
      const lines = out.trimEnd().split('\n');
      expect(lines).toHaveLength(1);
      // Issue #3164: quoted, so the planted `ProdStack (us-east-1)` inside the
      // name cannot be read as this row's own reference.
      expect(lines[0]).toMatch(/^"Decoy .*ProdStack \(us-east-1\).*" \(us-east-1\)$/);
    });

    it('treats a non-number lastModified as unknown, in text and --json, instead of a made-up date', async () => {
      mockListStacks.mockResolvedValue([
        { stackName: 'Bool', region: 'us-east-1' },
        { stackName: 'Huge', region: 'us-east-1' },
        { stackName: 'Str', region: 'us-east-1' },
      ]);
      const stamps: Record<string, unknown> = { Bool: true, Huge: 1e300, Str: '2026-01-01' };
      // `new Date(true)` is a valid 1970 date: without the type check this row
      // would print a timestamp the record never held.
      expect(new Date(true as unknown as number).toISOString()).toBe('1970-01-01T00:00:00.001Z');
      mockGetState.mockImplementation(async (name) => ({
        state: { resources: {}, lastModified: stamps[name] as number },
      }));
      mockIsLocked.mockResolvedValue(false);

      const text = await runStateList(['list', '--long']);
      const json = await runStateList(['list', '--long', '--json']);

      for (const name of ['Bool', 'Huge', 'Str']) {
        expect(blockOf(text, `${name} (us-east-1)`)).toContain('  Last Modified: unknown');
      }
      expect(JSON.parse(json).map((r: { lastModified: unknown }) => r.lastModified)).toEqual([
        null,
        null,
        null,
      ]);
    });
  });

  it('emits a deprecation warning to stderr when --region is passed (PR 5)', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'StackA', region: 'us-east-1' }]);
    const { stdout, stderr } = await runStateListWithStderr([
      'list',
      '--region',
      'us-west-2',
    ]);
    // Command still completes successfully (PR 1 added region suffix to default output).
    expect(stdout).toBe('StackA (us-east-1)\n');
    expect(stderr).toMatch(/--region is deprecated and will be removed in a future release/);
    expect(stderr).toMatch(/AWS_REGION/);
  });

  it('does not emit the deprecation warning when --region is omitted', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'StackA', region: 'us-east-1' }]);
    const { stderr } = await runStateListWithStderr(['list']);
    expect(stderr).not.toMatch(/--region is deprecated/);
  });

  // #555 A3: parent → child tree rendering.
  describe('--tree', () => {
    it('renders a 3-level tree from v6 parentStack / parentRegion fields', async () => {
      mockListStacks.mockResolvedValue([
        { stackName: 'NestedStackDeep', region: 'us-east-1' },
        { stackName: 'NestedStackDeep~Child', region: 'us-east-1' },
        { stackName: 'NestedStackDeep~Child~Grandchild', region: 'us-east-1' },
      ]);
      mockGetState.mockImplementation(async (name) => {
        if (name === 'NestedStackDeep') {
          return { state: { resources: {}, lastModified: 0 } };
        }
        if (name === 'NestedStackDeep~Child') {
          return {
            state: {
              resources: {},
              lastModified: 0,
              parentStack: 'NestedStackDeep',
              parentLogicalId: 'Child',
              parentRegion: 'us-east-1',
            },
          };
        }
        return {
          state: {
            resources: {},
            lastModified: 0,
            parentStack: 'NestedStackDeep~Child',
            parentLogicalId: 'Grandchild',
            parentRegion: 'us-east-1',
          },
        };
      });

      const out = await runStateList(['list', '--tree']);
      expect(out).toBe(
        [
          'NestedStackDeep (us-east-1)',
          '└── NestedStackDeep~Child (us-east-1)',
          '    └── NestedStackDeep~Child~Grandchild (us-east-1)',
          '',
        ].join('\n')
      );
    });

    it('emits a nested JSON shape with --tree --json', async () => {
      mockListStacks.mockResolvedValue([
        { stackName: 'Parent', region: 'us-east-1' },
        { stackName: 'Parent~Child', region: 'us-east-1' },
      ]);
      mockGetState.mockImplementation(async (name) => {
        if (name === 'Parent') {
          return { state: { resources: {}, lastModified: 0 } };
        }
        return {
          state: {
            resources: {},
            lastModified: 0,
            parentStack: 'Parent',
            parentLogicalId: 'Child',
            parentRegion: 'us-east-1',
          },
        };
      });

      const out = await runStateList(['list', '--tree', '--json']);
      expect(JSON.parse(out)).toEqual([
        {
          stackName: 'Parent',
          region: 'us-east-1',
          parentStack: null,
          parentLogicalId: null,
          parentRegion: null,
          children: [
            {
              stackName: 'Parent~Child',
              region: 'us-east-1',
              parentStack: 'Parent',
              parentLogicalId: 'Child',
              parentRegion: 'us-east-1',
              children: [],
            },
          ],
        },
      ]);
    });

    it('renders flat roots when no parent links are present', async () => {
      mockListStacks.mockResolvedValue([
        { stackName: 'Alpha', region: 'us-east-1' },
        { stackName: 'Bravo', region: 'us-east-1' },
      ]);
      mockGetState.mockResolvedValue({
        state: { resources: {}, lastModified: 0 },
      });

      const out = await runStateList(['list', '--tree']);
      expect(out).toBe('Alpha (us-east-1)\nBravo (us-east-1)\n');
    });

    it('emits nothing for an empty bucket under --tree', async () => {
      mockListStacks.mockResolvedValue([]);
      const out = await runStateList(['list', '--tree']);
      expect(out).toBe('');
    });

    it('emits `[]\\n` for an empty bucket under --tree --json so consumers can JSON.parse safely', async () => {
      // JSON mode emits the empty array verbatim (vs ASCII mode's no-output)
      // so a tool that pipes `cdkd state list --tree --json | jq` never
      // sees an empty stdin.
      mockListStacks.mockResolvedValue([]);
      const out = await runStateList(['list', '--tree', '--json']);
      expect(out).toBe('[]\n');
      expect(JSON.parse(out)).toEqual([]);
    });

    it('rejects --tree combined with --long at option-parsing time', async () => {
      // commander's `.conflicts('long')` aborts BEFORE the action runs, so no
      // AWS call should happen. The exitOverride helper turns commander's
      // own error path into a thrown CommanderError instead of process.exit.
      mockListStacks.mockResolvedValue([{ stackName: 'X', region: 'us-east-1' }]);
      await expect(runStateList(['list', '--tree', '--long'])).rejects.toThrow(
        /option '--tree' cannot be used with option '-l, --long'/
      );
      expect(mockListStacks).not.toHaveBeenCalled();
    });

    it('promotes an orphan child to root when its parent state is missing', async () => {
      // Parent record was hand-deleted; the child remains and should still
      // appear in the tree at the root (rather than vanishing).
      mockListStacks.mockResolvedValue([
        { stackName: 'Ghost~Orphan', region: 'us-east-1' },
      ]);
      mockGetState.mockResolvedValue({
        state: {
          resources: {},
          lastModified: 0,
          parentStack: 'Ghost',
          parentLogicalId: 'Orphan',
          parentRegion: 'us-east-1',
        },
      });

      const out = await runStateList(['list', '--tree']);
      expect(out).toBe('Ghost~Orphan (us-east-1)\n');
    });

    it('degrades a single getState failure to a top-level entry without aborting the whole tree', async () => {
      // One stack's state is unreadable (transient S3 503 / IAM hiccup);
      // siblings should still render. The unreadable row surfaces at the
      // root level with no parent link rather than killing the entire view.
      mockListStacks.mockResolvedValue([
        { stackName: 'GoodParent', region: 'us-east-1' },
        { stackName: 'GoodParent~Child', region: 'us-east-1' },
        { stackName: 'Unreadable', region: 'us-east-1' },
      ]);
      mockGetState.mockImplementation(async (name) => {
        if (name === 'GoodParent') {
          return { state: { resources: {}, lastModified: 0 } };
        }
        if (name === 'GoodParent~Child') {
          return {
            state: {
              resources: {},
              lastModified: 0,
              parentStack: 'GoodParent',
              parentLogicalId: 'Child',
              parentRegion: 'us-east-1',
            },
          };
        }
        throw new Error('S3 read failed (simulated 503)');
      });

      const out = await runStateList(['list', '--tree']);
      expect(out).toBe(
        [
          'GoodParent (us-east-1)',
          '└── GoodParent~Child (us-east-1)',
          'Unreadable (us-east-1)',
          '',
        ].join('\n')
      );
    });
  });
});
