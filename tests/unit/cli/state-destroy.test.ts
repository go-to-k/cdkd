import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';
import type { StackStateRef } from '../../../src/state/s3-state-backend.js';

const errorSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: vi.fn(),
    error: errorSpy,
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

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

const mockListStacks = vi.fn<() => Promise<StackStateRef[]>>();
const mockGetState = vi.fn<(stackName: string) => Promise<{ state: StackState; etag: string } | null>>();
const mockVerifyBucketExists = vi.fn<() => Promise<void>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    listStacks: mockListStacks,
    getState: mockGetState,
    verifyBucketExists: mockVerifyBucketExists,
  })),
}));

vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn(),
  })),
}));

vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    setCustomResourceResponseBucket: vi.fn(),
    getProvider: vi.fn(),
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));

// Replace the destroy-runner with a spy — we want to verify wiring (which
// stacks are dispatched, with which `skipConfirmation`), not re-test the
// runner itself (covered separately).
const mockRunDestroyForStack = vi.hoisted(() => vi.fn());
vi.mock('../../../src/cli/commands/destroy-runner.js', () => ({
  runDestroyForStack: mockRunDestroyForStack,
}));

// Mock readline so a prompt this command raised by itself would be observable.
// It raises none since `--all` and its batch prompt were removed
// (go-to-k/cdkd#3865); the per-stack prompt lives in the mocked runner.
const readlineQuestion = vi.hoisted(() => vi.fn<(prompt: string) => Promise<string>>());
const readlineClose = vi.hoisted(() => vi.fn());
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({
    question: readlineQuestion,
    close: readlineClose,
  })),
}));

import { createStateCommand } from '../../../src/cli/commands/state.js';
import { CdkdError } from '../../../src/utils/error-handler.js';
import { STATE_RESOURCES_MALFORMED } from '../../../src/state/malformed-resources-bag.js';

function makeStackState(stackName: string, region?: string): StackState {
  return {
    version: 1,
    stackName,
    ...(region && { region }),
    resources: {
      Bucket: {
        physicalId: `${stackName.toLowerCase()}-bucket`,
        resourceType: 'AWS::S3::Bucket',
        properties: {},
      },
    },
    outputs: {},
    lastModified: 0,
  };
}

function captureStdout(): { output: string[]; restore: () => void } {
  const output: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
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

async function runStateDestroy(args: string[]): Promise<string> {
  const cap = captureStdout();
  try {
    const stateCmd = createStateCommand();
    stateCmd.exitOverride();
    stateCmd.commands.forEach((sub) => sub.exitOverride());
    await stateCmd.parseAsync(args, { from: 'user' });
  } finally {
    cap.restore();
  }
  return cap.output.join('');
}

describe('cdkd state destroy', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  // Vitest's stdin is NOT a TTY. The cases present as INTERACTIVE so that a
  // prompt this command raised itself would reach the mocked `question`
  // rather than a non-interactive refusal, keeping the "no prompt" assertions
  // meaningful. Same stub as `gc.test.ts` / `prefix-migration-check.test.ts`.
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    originalIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    mockListStacks.mockReset();
    mockGetState.mockReset();
    mockVerifyBucketExists.mockReset();
    mockVerifyBucketExists.mockResolvedValue();
    mockRunDestroyForStack.mockReset();
    // Complete, not partial: `DestroyRunnerResult` requires every counter, and
    // a mock that omits them makes `totalSkipped` NaN at runtime while the
    // types still say `number` (issue #1752 review).
    mockRunDestroyForStack.mockResolvedValue({
      stackName: '',
      cancelled: false,
      skippedEmpty: false,
      deletedCount: 1,
      retainedCount: 0,
      skippedCount: 0,
      errorCount: 0,
      interrupted: false,
    });
    readlineQuestion.mockReset();
    readlineClose.mockReset();
    errorSpy.mockReset();
    infoSpy.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit-mock');
    }) as never);
  });

  afterEach(() => {
    // `defineProperty`, not a plain assignment: `process.stdin.isTTY` is typed
    // `boolean` while the saved original is `boolean | undefined` (it is absent
    // when stdin is not a TTY, which is vitest's normal state). The sibling
    // suite `prefix-migration-check.test.ts` restores it the same way.
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
      writable: true,
    });
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('rejects when no stack name is given', async () => {
    mockListStacks.mockResolvedValue([]);

    await expect(runStateDestroy(['destroy', '--yes'])).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/Stack name is required/);
    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
  });

  it('errors when a named stack has no state record', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'Other', region: 'us-east-1' }]);

    await expect(runStateDestroy(['destroy', 'Missing', '--yes'])).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/No state found for stack\(s\): Missing/);
    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
  });

  it('flattens a planted region onto the region-ambiguity line (go-to-k/cdkd#3374)', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'S', region: 'us-east-1' },
      { stackName: 'S', region: 'eu-west-1\nForged: all clear' },
    ]);

    await expect(runStateDestroy(['destroy', 'S', '--yes'])).rejects.toThrow();
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    // Flattened AND bounded: `displayIdent` maps the newline to a space and
    // quotes the altered value, so the planted text cannot read as the next
    // candidate or as cdkd's own sentence (go-to-k/cdkd#3027).
    expect(message).toContain('us-east-1, "eu-west-1 Forged: all clear".\nUse --stack-region');
    expect(message).not.toContain('\nForged');
  });

  it('passes --yes through to the runner so per-stack prompt is skipped', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({
      state: makeStackState('MyStack', 'us-east-1'),
      etag: '"abc"',
    });

    await runStateDestroy(['destroy', 'MyStack', '--yes']);

    expect(readlineQuestion).not.toHaveBeenCalled();
    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
    const callArgs = mockRunDestroyForStack.mock.calls[0];
    expect(callArgs?.[0]).toBe('MyStack');
    expect(callArgs?.[2].skipConfirmation).toBe(true);
  });

  it('passes --remove-protection through to the runner', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({
      state: makeStackState('MyStack', 'us-east-1'),
      etag: '"abc"',
    });

    await runStateDestroy(['destroy', 'MyStack', '--yes', '--remove-protection']);

    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
    const callArgs = mockRunDestroyForStack.mock.calls[0];
    expect(callArgs?.[2].removeProtection).toBe(true);
  });

  it('omits removeProtection (defaults to false) when the flag is not set', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({
      state: makeStackState('MyStack', 'us-east-1'),
      etag: '"abc"',
    });

    await runStateDestroy(['destroy', 'MyStack', '--yes']);

    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
    const callArgs = mockRunDestroyForStack.mock.calls[0];
    expect(callArgs?.[2].removeProtection).toBe(false);
  });

  /**
   * `--all` is removed (go-to-k/cdkd#3865): it destroyed every stack in the
   * state bucket, which every CDK app in the account shares. The option stays
   * DECLARED (hidden) so passing it reaches cdkd's own refusal, which names
   * the replacement, instead of commander's generic unknown-option error.
   *
   * Every shape is refused BEFORE the state bucket is read: stack names beside
   * `--all` are not run either, since the operator typed `--all` expecting the
   * old meaning. `-y` must not turn the refusal into a batch destroy.
   */
  describe('--all is removed (go-to-k/cdkd#3865)', () => {
    // Each shape is its own literal call so the operand-count fence
    // (`commander-parse-from-user-convention.test.ts`) can read every one.
    const shapes: readonly (readonly [string, () => Promise<string>])[] = [
      ['--all', () => runStateDestroy(['destroy', '--all'])],
      ['--all -y', () => runStateDestroy(['destroy', '--all', '-y'])],
      ['--all --yes', () => runStateDestroy(['destroy', '--all', '--yes'])],
      ['A --all --yes', () => runStateDestroy(['destroy', 'A', '--all', '--yes'])],
      ['--all A B', () => runStateDestroy(['destroy', '--all', 'A', 'B'])],
      [
        '--all --stack-region us-east-1 -y',
        () => runStateDestroy(['destroy', '--all', '--stack-region', 'us-east-1', '-y']),
      ],
    ];

    for (const [label, run] of shapes) {
      it(`refuses \`state destroy ${label}\` before reading state, prompting or destroying`, async () => {
        mockListStacks.mockResolvedValue([
          { stackName: 'A', region: 'us-east-1' },
          { stackName: 'B', region: 'us-east-1' },
        ]);
        mockGetState.mockImplementation(async (name: string) => ({
          state: makeStackState(name, 'us-east-1'),
          etag: '"x"',
        }));
        readlineQuestion.mockResolvedValue('y');

        await expect(run()).rejects.toThrow('process.exit-mock');
        expect(exitSpy).toHaveBeenCalledWith(1);
        const message = errorSpy.mock.calls.flat().join(' ');
        expect(message).toContain('cdkd state destroy no longer accepts --all');
        expect(message).toContain("cdkd state destroy '<stacks...>'");
        expect(message).toContain('cdkd destroy --all from the CDK app');
        expect(message).not.toMatch(/unknown option/i);

        expect(mockVerifyBucketExists).not.toHaveBeenCalled();
        expect(mockListStacks).not.toHaveBeenCalled();
        expect(mockGetState).not.toHaveBeenCalled();
        expect(readlineQuestion).not.toHaveBeenCalled();
        expect(mockRunDestroyForStack).not.toHaveBeenCalled();
      });
    }

    it('is not advertised in the help text', () => {
      const destroyCmd = createStateCommand().commands.find((c) => c.name() === 'destroy');
      expect(destroyCmd).toBeDefined();
      const help = destroyCmd!.helpInformation();
      expect(help).toContain('--remove-protection');
      // `--allow-unsupported-types` is listed, so match the flag as a whole word.
      expect(help).not.toMatch(/--all(?![-\w])/);
    });

    it('the "Stack name is required" usage no longer offers --all', async () => {
      await expect(runStateDestroy(['destroy', '-y'])).rejects.toThrow('process.exit-mock');
      const message = errorSpy.mock.calls.flat().join(' ');
      expect(message).toContain("Usage: cdkd state destroy '<stacks...>'");
      expect(message).not.toContain('--all');
    });
  });

  /**
   * A per-stack refusal ENDS a multi-stack run (issue go-to-k/cdkd#3161):
   * there is no per-stack catch around the dispatch, so the first stack whose
   * record cannot be read stops the ones not yet reached. The stacks not
   * reached are UNTOUCHED, which is what makes the behaviour acceptable — a
   * re-run after the repair proceeds — and that is the half this asserts.
   * (Pinned through `--all` until that option was removed, go-to-k/cdkd#3865.)
   */
  it('a multi-stack run stops at the first stack whose record is refused', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'A', region: 'us-east-1' },
      { stackName: 'B', region: 'us-east-1' },
    ]);
    mockGetState.mockImplementation(async (name: string) => ({
      state: makeStackState(name, 'us-east-1'),
      etag: '"x"',
    }));
    mockRunDestroyForStack.mockImplementation(async (name: string) => {
      if (name === 'A') throw new CdkdError('refused', STATE_RESOURCES_MALFORMED);
      return { errorCount: 0, deletedCount: 0, retainedCount: 0, skippedCount: 0 };
    });

    // The command's own error handler converts the refusal into a non-zero
    // exit, which the suite's `process.exit` spy turns into this throw — so the
    // assertion is on the EXIT, and the refusal's own text is asserted through
    // the error channel rather than through the rejection.
    await expect(runStateDestroy(['destroy', 'A', 'B', '-y'])).rejects.toThrow('process.exit-mock');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('refused');

    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
    expect(
      mockRunDestroyForStack.mock.calls[0]?.[0],
      'the dispatch order changed; this case is no longer asserting that B went unreached'
    ).toBe('A');
  });

  it('without --yes, named stacks raise no batch prompt and leave the per-stack prompt to the runner', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'A', region: 'us-east-1' },
      { stackName: 'B', region: 'us-east-1' },
    ]);
    mockGetState.mockImplementation(async (name: string) => ({
      state: makeStackState(name, 'us-east-1'),
      etag: '"x"',
    }));

    await runStateDestroy(['destroy', 'A', 'B']);

    expect(readlineQuestion).not.toHaveBeenCalled();
    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(2);
    for (const call of mockRunDestroyForStack.mock.calls) {
      expect(call[2].skipConfirmation).toBe(false);
    }
  });

  it('--stack-region filter skips a stack whose state.region disagrees', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'EuStack', region: 'eu-west-1' },
      { stackName: 'UsStack', region: 'us-east-1' },
    ]);
    mockGetState.mockImplementation(async (name: string) => {
      if (name === 'EuStack') return { state: makeStackState('EuStack', 'eu-west-1'), etag: '"x"' };
      return { state: makeStackState('UsStack', 'us-east-1'), etag: '"x"' };
    });

    await runStateDestroy([
      'destroy',
      'EuStack',
      'UsStack',
      '--stack-region',
      'us-east-1',
      '--yes',
    ]);

    // EuStack should be filtered out by --stack-region; UsStack should run.
    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
    expect(mockRunDestroyForStack.mock.calls[0]?.[0]).toBe('UsStack');
  });

  it('--stack-region tolerates state without a region tag (legacy layout)', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'Legacy', region: undefined }]);
    mockGetState.mockResolvedValue({ state: makeStackState('Legacy'), etag: '"x"' });

    await runStateDestroy(['destroy', 'Legacy', '--stack-region', 'us-east-1', '--yes']);

    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
  });

  it('exits with code 2 (PartialFailureError) when the runner reports per-resource errors', async () => {
    // Partial failure: state.json was preserved, the user can re-run.
    // Distinct exit code so CI / bench scripts can tell this apart from
    // a true command crash (which exits 1). See PartialFailureError in
    // src/utils/error-handler.ts.
    mockListStacks.mockResolvedValue([{ stackName: 'Bad', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({ state: makeStackState('Bad', 'us-east-1'), etag: '"x"' });
    mockRunDestroyForStack.mockResolvedValueOnce({
      stackName: 'Bad',
      cancelled: false,
      skippedEmpty: false,
      deletedCount: 0,
      errorCount: 2,
    });

    await expect(runStateDestroy(['destroy', 'Bad', '--yes'])).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(2);
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/2 resource error\(s\).*State preserved/);
    // Region-scoped (go-to-k/cdkd#3996).
    expect(message).toContain(
      "'cdkd state orphan <stack> --stack-region <region>' removes the stack's state in that region (every resource's record)"
    );
  });

  it('exits 2 when the runner SKIPPED a resource, even with zero errors (issue #1752)', async () => {
    // Twin of the destroy.ts branch: nothing FAILED, but cdkd left resources
    // it could not address and preserved their state records.
    mockListStacks.mockResolvedValue([{ stackName: 'Skipper', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({
      state: makeStackState('Skipper', 'us-east-1'),
      etag: '"x"',
    });
    mockRunDestroyForStack.mockResolvedValueOnce({
      stackName: 'Skipper',
      cancelled: false,
      skippedEmpty: false,
      deletedCount: 2,
      retainedCount: 0,
      skippedCount: 1,
      errorCount: 0,
      interrupted: false,
    });

    await expect(runStateDestroy(['destroy', 'Skipper', '--yes'])).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(2);
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toContain('skipped 1 entry');
    expect(message).toContain('may still exist in AWS');
    // Counted in ENTRIES, not resources: a skipped nested-stack row is one
    // entry however many of the child's resources it covers, so the old
    // "N resource(s)" wording stated a number that was wrong in exactly the
    // nested case (issue #1752 review).
    expect(message).not.toContain('resource(s) cdkd could not address');
    expect(message).toContain('counts as ONE entry');
    expect(message).toContain(
      "drop the records with 'cdkd state orphan <stack> --stack-region <region>'."
    );
  });

  it('iterates over multiple positional stack names in order', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'A', region: 'us-east-1' },
      { stackName: 'B', region: 'us-east-1' },
      { stackName: 'C', region: 'us-east-1' },
    ]);
    mockGetState.mockImplementation(async (name: string) => ({
      state: makeStackState(name, 'us-east-1'),
      etag: '"x"',
    }));

    await runStateDestroy(['destroy', 'A', 'B', '--yes']);

    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(2);
    expect(mockRunDestroyForStack.mock.calls[0]?.[0]).toBe('A');
    expect(mockRunDestroyForStack.mock.calls[1]?.[0]).toBe('B');
  });
});
