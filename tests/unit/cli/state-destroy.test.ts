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
    runWithStackAwsClients: (_clients: unknown, fn: () => unknown) => fn(),
    getAwsClients: vi.fn(),
  };
});

const mockListStacks = vi.fn<() => Promise<StackStateRef[]>>();
const mockGetState = vi.fn<(stackName: string) => Promise<{ state: StackState; etag: string } | null>>();
const mockVerifyBucketExists = vi.fn<() => Promise<void>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    destroyClient: vi.fn(),
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
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));

// Replace the destroy-runner with a spy — we want to verify wiring (which
// stacks are dispatched, with which `skipConfirmation`), not re-test the
// runner itself (covered separately).
const mockRunDestroyForStack = vi.hoisted(() => vi.fn());
vi.mock('../../../src/cli/commands/destroy-runner.js', () => ({
  runDestroyForStack: mockRunDestroyForStack,
}));

// Issue #2423: capture every deployment-event recorder the command opens. The
// store itself is mocked, NOT `deployment-events-run.js`, so the real
// RUN_STARTED / RUN_FINISHED bracket runs and these cases assert what it
// records. One entry per `new DeploymentEventsStore(...)`, in creation order.
interface CapturedRecorder {
  options: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
  finalized: unknown[];
}
const createdRecorders = vi.hoisted(() => [] as CapturedRecorder[]);
vi.mock('../../../src/state/deployment-events-store.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/state/deployment-events-store.js')>();
  class FakeDeploymentEventsStore {
    readonly cdkdVersion = '0.0.0-test';
    readonly captured: CapturedRecorder;
    constructor(_backend: unknown, options: Record<string, unknown>) {
      this.captured = { options, events: [], finalized: [] };
      createdRecorders.push(this.captured);
    }
    record(event: Record<string, unknown>): void {
      this.captured.events.push(event);
    }
    async finalize(result: unknown): Promise<void> {
      this.captured.finalized.push(result);
    }
  }
  return { ...actual, DeploymentEventsStore: FakeDeploymentEventsStore };
});

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
    createdRecorders.length = 0;
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
    // go-to-k/cdkd#4150: a top-level state destroy opts in to secret-principal resolution.
    expect(callArgs?.[2].resolveSecretDerivedPrincipals).toEqual({});
    // go-to-k/cdkd#2115: a top-level state destroy is a whole-stack teardown.
    expect(callArgs?.[2].stackDestroy).toBe(true);
    // go-to-k/cdkd#4705: a top-level state destroy checks the bucket's other state prefixes.
    expect(callArgs?.[2].crossPrefixCheck?.cache).toBeDefined();
    // go-to-k/cdkd#4682: no template, so no NoEcho re-resolution source.
    expect(callArgs?.[2]).not.toHaveProperty('noEchoReresolver');
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

  it('pre-starts every target record\'s scan before the first destroy, only for the records it destroys (go-to-k/cdkd#4705 review R5-8)', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'A', region: 'us-east-1' },
      { stackName: 'B', region: 'us-east-1' },
      { stackName: 'B', region: 'eu-west-1' },
      { stackName: 'Legacy', region: undefined },
    ]);
    mockGetState.mockImplementation(async (name: string) => ({
      state: makeStackState(name, 'us-east-1'),
      etag: '"x"',
    }));
    const { CrossPrefixGuard } = await import('../../../src/state/stack-registry.js');
    const order: string[] = [];
    const fullSpy = vi
      .spyOn(CrossPrefixGuard.prototype, 'full')
      .mockImplementation(async (name: string, region: string) => {
        order.push(`scan:${name}:${region}`);
        return { kind: 'clear' };
      });
    mockRunDestroyForStack.mockImplementation(async (name: string) => {
      order.push(`destroy:${name}`);
      return {
        stackName: name,
        cancelled: false,
        deletedCount: 0,
        errorCount: 0,
        skippedCount: 0,
        retainedCount: 0,
        guardIndeterminateCount: 0,
        skippedEmpty: false,
        interrupted: false,
      };
    });

    await runStateDestroy(['destroy', 'A', 'B', 'Legacy', '--stack-region', 'us-east-1', '--yes']);
    fullSpy.mockRestore();

    const firstDestroy = order.findIndex((o) => o.startsWith('destroy:'));
    expect(order.slice(0, firstDestroy)).toEqual([
      'scan:A:us-east-1',
      'scan:B:us-east-1',
      'scan:Legacy:us-east-1',
    ]);
    // B's eu-west-1 record is not destroyed, so it is not scanned.
    expect(order.filter((o) => o.startsWith('scan:'))).toHaveLength(3);
    expect(new Set(mockRunDestroyForStack.mock.calls.map((c) => c[2].crossPrefixCheck?.cache)).size).toBe(1);
    // Review R5-8: `setupStateBackend`'s dispose destroys the client of the
    // backend the destroys (and the scans) ran on, once.
    const backends = new Set(mockRunDestroyForStack.mock.calls.map((c) => c[2].stateBackend));
    expect(backends.size).toBe(1);
    expect([...backends][0].destroyClient).toHaveBeenCalledTimes(1);
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
    // whose delete it did not confirm and preserved their state records.
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
    expect(message).not.toContain('resource(s) whose delete');
    expect(message).toContain('counts as ONE entry');
    // go-to-k/cdkd#2122: a skip is not always a record cdkd could not ADDRESS
    // — a custom-resource Delete handler that ran and reported FAILED skips
    // too, and its record is fine. The text claims only the unconfirmed
    // delete, and offers the state.json repair as ONE remedy, not THE remedy.
    expect(message).toContain('whose delete cdkd did not confirm');
    expect(message).not.toContain('could not address');
    expect(message).not.toContain('Repair the physicalId');
    expect(message).toContain(
      "whether repairing the record in state.json helps: where it does, repair it and re-run " +
        "'cdkd state destroy'; otherwise (for example a custom-resource Delete handler that reported " +
        'FAILED), delete the resources by hand'
    );
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

  describe('deployment events (go-to-k/cdkd#2423)', () => {
    function runFinished(rec: CapturedRecorder): Record<string, unknown> {
      const finished = rec.events.filter((e) => e['eventType'] === 'RUN_FINISHED');
      expect(finished).toHaveLength(1);
      return finished[0]!;
    }

    it('records a destroy run for a clean destroy and threads the recorder into the runner', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'eu-west-1' }]);
      mockGetState.mockResolvedValue({
        state: makeStackState('MyStack', 'eu-west-1'),
        etag: '"abc"',
      });

      await runStateDestroy(['destroy', 'MyStack', '--yes']);

      expect(createdRecorders).toHaveLength(1);
      const rec = createdRecorders[0]!;
      // Keyed by the TARGET's region (the state record's key), under the same
      // `destroy` command literal `cdkd destroy` records.
      expect(rec.options).toMatchObject({
        stackName: 'MyStack',
        region: 'eu-west-1',
        command: 'destroy',
      });
      expect(rec.events[0]).toMatchObject({
        eventType: 'RUN_STARTED',
        stackName: 'MyStack',
        command: 'destroy',
        region: 'eu-west-1',
      });
      expect(runFinished(rec)).toMatchObject({
        result: 'SUCCEEDED',
        counts: { created: 0, updated: 0, deleted: 1 },
      });
      expect(rec.finalized).toEqual(['SUCCEEDED']);
      // The per-resource events come from the runner, so the SAME recorder must
      // reach it -- a recorder that only brackets the run records no resource.
      const ctx = mockRunDestroyForStack.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(ctx['eventRecorder']).toBeDefined();
      expect((ctx['eventRecorder'] as { captured: CapturedRecorder }).captured).toBe(rec);
    });

    it('records FAILED with the failed count when the runner reports resource errors', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'Bad', region: 'us-east-1' }]);
      mockGetState.mockResolvedValue({ state: makeStackState('Bad', 'us-east-1'), etag: '"x"' });
      mockRunDestroyForStack.mockResolvedValueOnce({
        stackName: 'Bad',
        cancelled: false,
        skippedEmpty: false,
        deletedCount: 1,
        retainedCount: 0,
        skippedCount: 0,
        errorCount: 2,
        interrupted: false,
      });

      await expect(runStateDestroy(['destroy', 'Bad', '--yes'])).rejects.toThrow();
      expect(exitSpy).toHaveBeenCalledWith(2);

      const finished = runFinished(createdRecorders[0]!);
      expect(finished['result']).toBe('FAILED');
      expect(finished['counts']).toEqual({ created: 0, updated: 0, deleted: 1, failed: 2 });
      expect(createdRecorders[0]!.finalized).toEqual(['FAILED']);
    });

    it('records FAILED naming the skip when the runner SKIPPED a resource (issue #1752 parity)', async () => {
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

      const finished = runFinished(createdRecorders[0]!);
      expect(finished['result']).toBe('FAILED');
      expect(finished['counts']).toEqual({ created: 0, updated: 0, deleted: 2, skipped: 1 });
      expect(createdRecorders[0]!.finalized).toEqual(['FAILED']);
    });

    it('records FAILED with the error metadata, and still finalizes, when the runner throws', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'Boom', region: 'us-east-1' }]);
      mockGetState.mockResolvedValue({ state: makeStackState('Boom', 'us-east-1'), etag: '"x"' });
      mockRunDestroyForStack.mockRejectedValueOnce(new Error('lock acquisition failed'));

      await expect(runStateDestroy(['destroy', 'Boom', '--yes'])).rejects.toThrow();
      expect(exitSpy).toHaveBeenCalledWith(1);

      const finished = runFinished(createdRecorders[0]!);
      expect(finished['result']).toBe('FAILED');
      expect(finished['error']).toMatchObject({ name: 'Error' });
      expect(finished['counts']).toBeUndefined();
      expect(createdRecorders[0]!.finalized).toEqual(['FAILED']);
    });

    it('opens one run per target, each under its own stack name and region', async () => {
      mockListStacks.mockResolvedValue([
        { stackName: 'A', region: 'us-east-1' },
        { stackName: 'B', region: 'ap-northeast-1' },
      ]);
      mockGetState.mockImplementation(async (name: string) => ({
        state: makeStackState(name, name === 'A' ? 'us-east-1' : 'ap-northeast-1'),
        etag: '"x"',
      }));

      await runStateDestroy(['destroy', 'A', 'B', '--yes']);

      expect(createdRecorders.map((r) => [r.options['stackName'], r.options['region']])).toEqual([
        ['A', 'us-east-1'],
        ['B', 'ap-northeast-1'],
      ]);
      for (const rec of createdRecorders) {
        expect(runFinished(rec)['result']).toBe('SUCCEEDED');
        expect(rec.finalized).toEqual(['SUCCEEDED']);
      }
      // Each runner call carries ITS target's recorder, not a shared one.
      const threaded = mockRunDestroyForStack.mock.calls.map(
        (c) => (c[2] as { eventRecorder: { captured: CapturedRecorder } }).eventRecorder.captured
      );
      expect(threaded).toEqual([createdRecorders[0], createdRecorders[1]]);
      expect(threaded[0]).not.toBe(threaded[1]);
    });

    it('opens no run for a target it never dispatches', async () => {
      // `--stack-region` matches no record of B, so B is warn-and-skipped: no
      // RUN_STARTED may be written for a stack nothing touched.
      mockListStacks.mockResolvedValue([
        { stackName: 'A', region: 'us-east-1' },
        { stackName: 'B', region: 'eu-west-1' },
      ]);
      mockGetState.mockImplementation(async (name: string) => ({
        state: makeStackState(name, 'us-east-1'),
        etag: '"x"',
      }));

      await runStateDestroy(['destroy', 'A', 'B', '--stack-region', 'us-east-1', '--yes']);

      expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
      expect(createdRecorders).toHaveLength(1);
      expect(createdRecorders[0]!.options['stackName']).toBe('A');
    });

    it('opens no run for a target whose state record vanished before the read', async () => {
      // The inner loop's `getState` -> null `continue`: listed, but gone by the
      // time it is read, so nothing is dispatched and nothing may be recorded.
      mockListStacks.mockResolvedValue([
        { stackName: 'Gone', region: 'us-east-1' },
        { stackName: 'Kept', region: 'us-east-1' },
      ]);
      mockGetState.mockImplementation(async (name: string) =>
        name === 'Gone' ? null : { state: makeStackState(name, 'us-east-1'), etag: '"x"' }
      );

      await runStateDestroy(['destroy', 'Gone', 'Kept', '--yes']);

      expect(mockRunDestroyForStack.mock.calls.map((c) => c[0])).toEqual(['Kept']);
      expect(createdRecorders.map((r) => r.options['stackName'])).toEqual(['Kept']);
    });

    it('records a SUCCEEDED run with nothing deleted when the user declines the prompt', async () => {
      // Parity with `cdkd destroy`: a declined per-stack prompt is not a
      // failure, so the run is SUCCEEDED with zero deletes -- the record says
      // the destroy was attempted and removed nothing.
      mockListStacks.mockResolvedValue([{ stackName: 'Declined', region: 'us-east-1' }]);
      mockGetState.mockResolvedValue({
        state: makeStackState('Declined', 'us-east-1'),
        etag: '"x"',
      });
      mockRunDestroyForStack.mockResolvedValueOnce({
        stackName: 'Declined',
        cancelled: true,
        skippedEmpty: false,
        deletedCount: 0,
        retainedCount: 0,
        skippedCount: 0,
        errorCount: 0,
        interrupted: false,
      });

      await runStateDestroy(['destroy', 'Declined']);

      expect(createdRecorders).toHaveLength(1);
      expect(runFinished(createdRecorders[0]!)).toMatchObject({
        result: 'SUCCEEDED',
        counts: { created: 0, updated: 0, deleted: 0 },
      });
      expect(createdRecorders[0]!.finalized).toEqual(['SUCCEEDED']);
    });
  });
});
