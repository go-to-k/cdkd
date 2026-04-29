import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger to suppress output during tests.
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
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
const mockListStacks = vi.fn<() => Promise<string[]>>();
const mockGetState =
  vi.fn<
    (
      stackName: string
    ) => Promise<{ state: { resources: Record<string, unknown>; lastModified: number } } | null>
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
const mockIsLocked = vi.fn<(stackName: string) => Promise<boolean>>();
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

  it('prints stack names sorted alphabetically, one per line', async () => {
    mockListStacks.mockResolvedValue(['Charlie', 'alpha', 'Bravo']);
    const out = await runStateList(['list']);
    expect(out).toBe('Bravo\nCharlie\nalpha\n');
  });

  it('supports the `ls` alias', async () => {
    mockListStacks.mockResolvedValue(['One', 'Two']);
    const out = await runStateList(['ls']);
    expect(out).toBe('One\nTwo\n');
  });

  it('emits a JSON array of stack names with --json', async () => {
    mockListStacks.mockResolvedValue(['B', 'a', 'C']);
    const out = await runStateList(['list', '--json']);
    expect(JSON.parse(out)).toEqual(['B', 'C', 'a']);
  });

  it('emits long human-readable details with --long', async () => {
    mockListStacks.mockResolvedValue(['StackA', 'StackB']);
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

    expect(out).toContain('StackA');
    expect(out).toContain('  Resources: 3');
    expect(out).toContain('  Last Modified: 2026-04-29T10:23:45.000Z');
    expect(out).toContain('  Lock: unlocked');
    expect(out).toContain('StackB');
    expect(out).toContain('  Resources: 0');
    expect(out).toContain('  Last Modified: 2026-04-25T08:00:00.000Z');
    expect(out).toContain('  Lock: locked');
  });

  it('handles missing state by reporting zero resources and unknown last-modified', async () => {
    mockListStacks.mockResolvedValue(['Orphan']);
    mockGetState.mockResolvedValue(null);
    mockIsLocked.mockResolvedValue(false);

    const out = await runStateList(['list', '--long']);

    expect(out).toContain('Orphan');
    expect(out).toContain('  Resources: 0');
    expect(out).toContain('  Last Modified: unknown');
    expect(out).toContain('  Lock: unlocked');
  });

  it('emits a JSON array of details when --long --json is combined', async () => {
    mockListStacks.mockResolvedValue(['X']);
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
        resourceCount: 2,
        lastModified: '2026-01-01T00:00:00.000Z',
        locked: true,
      },
    ]);
  });

  it('fetches state and lock status for each stack', async () => {
    mockListStacks.mockResolvedValue(['One', 'Two']);
    mockGetState.mockResolvedValue({
      state: { resources: {}, lastModified: 0 },
    });
    mockIsLocked.mockResolvedValue(false);

    await runStateList(['list', '--long']);

    expect(mockGetState).toHaveBeenCalledWith('One');
    expect(mockGetState).toHaveBeenCalledWith('Two');
    expect(mockIsLocked).toHaveBeenCalledWith('One');
    expect(mockIsLocked).toHaveBeenCalledWith('Two');
  });
});
