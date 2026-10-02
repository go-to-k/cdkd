import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

const errorSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
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
  resolveApp: vi.fn(() => 'fake-app-cmd'),
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

vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));

const mockListStacks = vi.fn<() => Promise<{ stackName: string; region?: string }[]>>();
const mockGetState =
  vi.fn<(stackName: string, region?: string) => Promise<{ state: StackState; etag: string } | null>>();
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

// Spy on the per-stack runner so we can verify which stacks are dispatched.
const mockRunDestroyForStack = vi.hoisted(() => vi.fn());
vi.mock('../../../src/cli/commands/destroy-runner.js', () => ({
  runDestroyForStack: mockRunDestroyForStack,
}));

// Issue #1752: capture the run-level events so the tests below can assert the
// RUN_FINISHED result a skip-only run records. The real recorder writes JSONL
// through the (mocked) state backend; a spy is both simpler and lets the
// assertions read the decision directly.
const recordedRunEvents = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: vi.fn(() => ({
    record: (event: Record<string, unknown>) => {
      recordedRunEvents.push(event);
    },
    finalize: vi.fn(async () => {}),
  })),
  recordRunFailed: vi.fn(),
  recordRunOutcome: vi.fn(),
}));

// Mock the synthesizer so we can return arbitrary StackInfo[] (including
// with terminationProtection set on individual stacks).
const mockSynthesize = vi.hoisted(() => vi.fn());
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: mockSynthesize,
  })),
}));

// Off by default, so every case sees the real exit-code path. A case that
// needs the thrown error itself (its `code`) turns it on to receive the
// rejection instead of a `process.exit`.
const passErrorsThrough = vi.hoisted(() => ({ on: false }));
vi.mock('../../../src/utils/error-handler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/error-handler.js')>();
  return {
    ...actual,
    withErrorHandling:
      <Args extends unknown[]>(fn: (...args: Args) => Promise<void> | void) =>
      async (...args: Args): Promise<void> => {
        if (passErrorsThrough.on) {
          await fn(...args);
          return;
        }
        await actual.withErrorHandling(fn)(...args);
      },
  };
});

import { createDestroyCommand } from '../../../src/cli/commands/destroy.js';
import { resolveApp } from '../../../src/cli/config-loader.js';

function makeStackState(stackName: string, region = 'us-east-1'): StackState {
  return {
    version: 1,
    stackName,
    region,
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

function makeStackInfo(
  stackName: string,
  region = 'us-east-1',
  terminationProtection?: boolean
): StackInfo {
  return {
    stackName,
    displayName: stackName,
    artifactId: stackName,
    template: { Resources: {} },
    dependencyNames: [],
    region,
    ...(terminationProtection !== undefined && { terminationProtection }),
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

async function runDestroy(args: string[]): Promise<string> {
  const cap = captureStdout();
  try {
    const cmd = createDestroyCommand();
    cmd.exitOverride();
    await cmd.parseAsync(args, { from: 'user' });
  } finally {
    cap.restore();
  }
  return cap.output.join('');
}

describe('cdkd destroy: terminationProtection guard', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
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
    mockSynthesize.mockReset();
    recordedRunEvents.length = 0;
    errorSpy.mockReset();
    infoSpy.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit-mock');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('refuses to destroy a single protected stack and exits with code 2', async () => {
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Protected', 'us-east-1', true)],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'Protected', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({ state: makeStackState('Protected'), etag: '"x"' });

    await expect(runDestroy(['Protected', '--yes'])).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(2);

    // Per-stack guard fires BEFORE the runner is invoked.
    expect(mockRunDestroyForStack).not.toHaveBeenCalled();

    // The error message names the stack and the bypass workflow.
    const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(messages).toMatch(/Protected/);
    expect(messages).toMatch(/terminationProtection: false/);
    expect(messages).toMatch(/redeploy/);
  });

  it('names no planted REGION in the multi-region refusal beside its labelled line (go-to-k/cdkd#3759)', async () => {
    // Regions come from S3 key segments. Printed raw, one carrying a newline
    // spelled a counterfeit `Remove one record with:` row above the real one.
    const forged = 'x\nRemove one record with: cdkd destroy --all --force #';
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Multi', 'eu-west-1')],
    });
    mockListStacks.mockResolvedValue([
      { stackName: 'Multi', region: 'us-east-1' },
      { stackName: 'Multi', region: forged },
    ]);

    await expect(runDestroy(['Multi', '--yes'])).rejects.toThrow();
    const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    // Positive control: the multi-region refusal fired, naming the plain region.
    expect(messages).toContain('has state in multiple regions: us-east-1, a region that is not a plain identifier');
    expect(messages).not.toContain('--all --force');
    expect(messages.split('\n').filter((l) => l.startsWith('Remove one record with:'))).toEqual([
      "Remove one record with: cdkd state orphan Multi --stack-region '<region>'",
    ]);
    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
  });

  it('withholds a non-plain state-listed STACK from `Remove one record with:` and explains the hole (go-to-k/cdkd#3759)', async () => {
    // No synth, so `candidateStacks` comes from `listStacks()` — the stack
    // name itself is an S3 key segment here. Named exactly (after `--`, so
    // `-Multi` is not read as an option): with no synthesized app, `--all` is
    // refused before the state fallback (go-to-k/cdkd#3839).
    for (const [name, clauseText] of [
      // Refused by `plainIdent` alone: the clause points at the listing.
      [
        'Multi\nRemove one record with: cdkd destroy --all --force #',
        "list the records as stored with 'cdkd state list --long'",
      ],
      // Padded: it renders exactly, so only `plainIdent` withholds it.
      [
        `Multi${' '.repeat(60)}Remove one record with: cdkd destroy --all --force #`,
        "is not a plain identifier (a letter or digit",
      ],
      // Option-shaped: the clause names the verb the hole belongs to.
      ['-Multi', "not safe to print as an argument to 'cdkd state orphan'"],
    ] as const) {
      errorSpy.mockClear();
      mockSynthesize.mockRejectedValue(new Error('synth unavailable'));
      mockListStacks.mockResolvedValue([
        { stackName: name, region: 'us-east-1' },
        { stackName: name, region: 'eu-west-1' },
      ]);

      await expect(runDestroy(['--yes', '--', name])).rejects.toThrow();
      const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
      // Positive control: the multi-region refusal fired.
      expect(messages, name).toContain(
        'Stack a stack name that is not a plain identifier has state in multiple regions: us-east-1, eu-west-1'
      );
      expect(messages, name).not.toContain('--all --force');
      expect(messages.split('\n').filter((l) => l.startsWith('Remove one record with:'))).toEqual([
        "Remove one record with: cdkd state orphan '<stack>' --stack-region '<region>'",
      ]);
      expect(messages, name).toContain(clauseText);
      expect(messages).toContain("This stack's name");
      expect(messages.indexOf(clauseText)).toBeLessThan(messages.indexOf('\nRemove one record with:'));
      expect(mockRunDestroyForStack).not.toHaveBeenCalled();
    }
    // Positive control: a plain name is quoted as before, with no clause.
    errorSpy.mockClear();
    mockSynthesize.mockRejectedValue(new Error('synth unavailable'));
    mockListStacks.mockResolvedValue([
      { stackName: 'Multi', region: 'us-east-1' },
      { stackName: 'Multi', region: 'eu-west-1' },
    ]);
    await expect(runDestroy(['Multi', '--yes'])).rejects.toThrow();
    const plain = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(plain).toContain("Stack 'Multi' has state in multiple regions: us-east-1, eu-west-1");
    expect(plain).toMatch(/^Remove one record with: cdkd state orphan Multi --stack-region '<region>'$/m);
    expect(plain).not.toContain('cdkd state list --long');
  });

  it('folds a newline in a state-listed STACK name onto its progress and skip lines (go-to-k/cdkd#3773)', async () => {
    // No synth, so the name is an S3 key segment. Printed raw, its newline
    // started a line the operator reads as cdkd's own.
    const name = 'Ghost\n  ✓ RealDatabase (AWS::RDS::DBInstance) deleted';
    warnSpy.mockClear();
    mockSynthesize.mockRejectedValue(new Error('synth unavailable'));
    mockListStacks.mockResolvedValue([{ stackName: name, region: 'us-east-1' }]);
    mockGetState.mockResolvedValue(null);

    // Named exactly: with no synthesized app, `--all` is refused (go-to-k/cdkd#3839).
    await runDestroy(['--yes', '--', name]).catch(() => undefined);
    const infos = infoSpy.mock.calls.map((c) => String(c[0] ?? ''));
    const preparing = infos.filter((l) => l.includes('Preparing to destroy stack:'));
    const skipped = warnSpy.mock.calls
      .map((c) => String(c[0] ?? ''))
      .filter((l) => l.includes('No state found for stack'));
    // Positive controls: both lines fired, naming the folded stack.
    expect(preparing).toEqual(['\nPreparing to destroy stack: Ghost   ✓ RealDatabase (AWS::RDS::DBInstance) deleted']);
    expect(infos.filter((l) => l.includes('stack(s) to destroy:'))).toEqual([
      'Found 1 stack(s) to destroy: Ghost   ✓ RealDatabase (AWS::RDS::DBInstance) deleted',
    ]);
    expect(skipped).toEqual(['No state found for stack Ghost   ✓ RealDatabase (AWS::RDS::DBInstance) deleted, skipping']);
    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
  });

  it('folds a newline in a SYNTHESIZED stack name onto its --remove-protection bypass line (go-to-k/cdkd#3773)', async () => {
    const name = 'Ghost\n  ✓ RealDatabase (AWS::RDS::DBInstance) deleted';
    warnSpy.mockClear();
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo(name, 'us-east-1', true)],
    });
    mockListStacks.mockResolvedValue([{ stackName: name, region: 'us-east-1' }]);
    mockGetState.mockResolvedValue(null);

    await runDestroy(['--all', '--yes', '--remove-protection']).catch(() => undefined);
    const warned = warnSpy.mock.calls.map((c) => String(c[0] ?? ''));
    // Positive control: the bypass fired, naming the folded stack.
    expect(warned.filter((l) => l.includes('terminationProtection'))).toEqual([
      'Stack Ghost   ✓ RealDatabase (AWS::RDS::DBInstance) deleted has terminationProtection: true — bypassing because --remove-protection set',
    ]);
    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
  });

  it('proceeds to destroy when terminationProtection is absent or false', async () => {
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      // First case: undefined (typical CDK default).
      // Second case: explicitly false.
      stacks: [
        makeStackInfo('Plain', 'us-east-1'),
        makeStackInfo('Unguarded', 'us-east-1', false),
      ],
    });
    mockListStacks.mockResolvedValue([
      { stackName: 'Plain', region: 'us-east-1' },
      { stackName: 'Unguarded', region: 'us-east-1' },
    ]);
    mockGetState.mockImplementation(async (name: string) => ({
      state: makeStackState(name),
      etag: '"x"',
    }));

    await runDestroy(['--all', '--yes']);

    // Both stacks flow through the runner — guard does not fire.
    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(2);
    const dispatched = new Set(
      mockRunDestroyForStack.mock.calls.map((c) => c[0] as string)
    );
    expect(dispatched).toEqual(new Set(['Plain', 'Unguarded']));
    // No partial-failure exit on the happy path.
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('names a region-scoped state orphan when resources failed (go-to-k/cdkd#3996)', async () => {
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Failer', 'us-east-1')],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'Failer', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({ state: makeStackState('Failer'), etag: '"x"' });
    mockRunDestroyForStack.mockResolvedValue({
      stackName: 'Failer',
      cancelled: false,
      skippedEmpty: false,
      deletedCount: 1,
      retainedCount: 0,
      skippedCount: 0,
      errorCount: 1,
      interrupted: false,
    });

    await expect(runDestroy(['Failer', '--yes'])).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(2);
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toContain('Destroy completed with 1 resource error(s)');
    expect(message).toContain(
      "'cdkd state orphan <stack> --stack-region <region>' removes the stack's state in that region (every resource's record)"
    );
  });

  it('exits 2 when the runner SKIPPED a resource, even with zero errors (issue #1752)', async () => {
    // A skip means cdkd left a resource whose delete it did not confirm and preserved
    // state — the stack is NOT destroyed. Exiting 0 there is exactly the
    // mis-report the issue was filed for.
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Skipper', 'us-east-1')],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'Skipper', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({ state: makeStackState('Skipper'), etag: '"x"' });
    mockRunDestroyForStack.mockResolvedValue({
      stackName: 'Skipper',
      cancelled: false,
      skippedEmpty: false,
      deletedCount: 2,
      retainedCount: 0,
      skippedCount: 1,
      errorCount: 0,
      interrupted: false,
    });

    await expect(runDestroy(['Skipper', '--yes'])).rejects.toThrow();
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
        "'cdkd destroy'; otherwise (for example a custom-resource Delete handler that reported " +
        'FAILED), delete the resources by hand'
    );
    // Region-scoped: a bare `cdkd state orphan <stack>` drops that name's
    // record in EVERY region (go-to-k/cdkd#3996).
    expect(message).toContain(
      "drop the records with 'cdkd state orphan <stack> --stack-region <region>'."
    );

    // The run-level record must agree with the exit code — a skip-only run is
    // FAILED, which is also what suppresses `--purge-events` (the post-mortem
    // must survive a destroy that did not finish).
    const finished = recordedRunEvents.find((e) => e['eventType'] === 'RUN_FINISHED')!;
    expect(finished).toBeDefined();
    expect(finished['result']).toBe('FAILED');
    // ...and it must NAME the skip, or the event says a run failed while
    // listing nothing that failed.
    expect(finished['counts']).toMatchObject({ deleted: 2, skipped: 1 });
    expect((finished['counts'] as Record<string, unknown>)['failed']).toBeUndefined();
  });

  it('still exits 0 when nothing was skipped (no behavior change, issue #1752)', async () => {
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Clean', 'us-east-1')],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'Clean', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({ state: makeStackState('Clean'), etag: '"x"' });
    mockRunDestroyForStack.mockResolvedValue({
      stackName: 'Clean',
      cancelled: false,
      skippedEmpty: false,
      deletedCount: 2,
      retainedCount: 0,
      skippedCount: 0,
      errorCount: 0,
      interrupted: false,
    });

    await runDestroy(['Clean', '--yes']);

    expect(exitSpy).not.toHaveBeenCalled();
    const finished = recordedRunEvents.find((e) => e['eventType'] === 'RUN_FINISHED')!;
    expect(finished['result']).toBe('SUCCEEDED');
    // No `skipped` member is emitted on a zero-skip run.
    expect((finished['counts'] as Record<string, unknown>)['skipped']).toBeUndefined();
  });

  it('--remove-protection bypasses terminationProtection guard with a WARN log and dispatches the runner', async () => {
    const warnSpy = vi.fn();
    // The destroy command logs the bypass at WARN level via the shared
    // logger. Spy on logger.warn for this test.
    const loggerModule = await import('../../../src/utils/logger.js');
    vi.spyOn(loggerModule, 'getLogger').mockReturnValue({
      setLevel: vi.fn(),
      debug: vi.fn(),
      info: infoSpy,
      warn: warnSpy,
      error: errorSpy,
      child: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    } as unknown as ReturnType<typeof loggerModule.getLogger>);

    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Protected', 'us-east-1', true)],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'Protected', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({ state: makeStackState('Protected'), etag: '"x"' });

    await runDestroy(['Protected', '--yes', '--remove-protection']);

    // The runner runs (bypass) and the runner gets removeProtection=true.
    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
    expect(mockRunDestroyForStack.mock.calls[0]?.[2].removeProtection).toBe(true);
    // go-to-k/cdkd#4150: a top-level destroy opts in to secret-principal resolution.
    expect(mockRunDestroyForStack.mock.calls[0]?.[2].resolveSecretDerivedPrincipals).toEqual({});

    // No exit-2 on the bypass path.
    expect(exitSpy).not.toHaveBeenCalled();

    // The bypass is announced via WARN so it shows in CI logs.
    const warnMessages = warnSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(warnMessages).toMatch(/Protected/);
    expect(warnMessages).toMatch(/--remove-protection/);
  });

  it('--all with one protected + one unprotected: unprotected destroys, protected counts as failure (exit 2)', async () => {
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [
        makeStackInfo('Protected', 'us-east-1', true),
        makeStackInfo('Plain', 'us-east-1'),
      ],
    });
    mockListStacks.mockResolvedValue([
      { stackName: 'Protected', region: 'us-east-1' },
      { stackName: 'Plain', region: 'us-east-1' },
    ]);
    mockGetState.mockImplementation(async (name: string) => ({
      state: makeStackState(name),
      etag: '"x"',
    }));

    await expect(runDestroy(['--all', '--yes'])).rejects.toThrow();

    // Unprotected stack went through the runner; protected one did not.
    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
    expect(mockRunDestroyForStack.mock.calls[0]?.[0]).toBe('Plain');

    // PartialFailureError aggregates the protected stack into the failure count.
    expect(exitSpy).toHaveBeenCalledWith(2);
    const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(messages).toMatch(/Protected/);
    expect(messages).toMatch(/1 resource error/);
  });
});

// ----- #555 A2: nested-stack child-only direct destroy refusal -----

/**
 * Build a v6 `StackState` carrying the `parentStack` / `parentLogicalId` /
 * `parentRegion` triple, matching what `NestedStackProvider.create`
 * writes for a nested child. The guard reads `parentStack` to decide
 * whether to refuse direct destroy.
 */
function makeChildStackState(
  stackName: string,
  parentStack: string,
  parentLogicalId: string,
  region = 'us-east-1'
): StackState {
  return {
    version: 6,
    stackName,
    region,
    parentStack,
    parentLogicalId,
    parentRegion: region,
    resources: {
      Bucket: {
        physicalId: `${stackName.toLowerCase().replace(/~/g, '-')}-bucket`,
        resourceType: 'AWS::S3::Bucket',
        properties: {},
        attributes: {},
        dependencies: [],
      },
    },
    outputs: {},
    lastModified: 0,
  };
}

describe('cdkd destroy: nested-stack child-only direct destroy refusal (#555 A2)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockListStacks.mockReset();
    mockGetState.mockReset();
    mockVerifyBucketExists.mockReset();
    mockVerifyBucketExists.mockResolvedValue();
    // `recordedRunEvents` is module-level and shared with the describe above,
    // which DOES assert on it — without this reset a RUN_FINISHED recorded
    // there leaks into these tests (issue #1752 review).
    recordedRunEvents.length = 0;
    mockRunDestroyForStack.mockReset();
    mockRunDestroyForStack.mockResolvedValue({
      stackName: '',
      cancelled: false,
      skippedEmpty: false,
      deletedCount: 1,
      retainedCount: 0,
      skippedCount: 0,
      interrupted: false,
      errorCount: 0,
    });
    mockSynthesize.mockReset();
    errorSpy.mockReset();
    infoSpy.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit-mock');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('refuses to destroy a nested child stack directly and exits with code 2', async () => {
    // Synth fails (no app available) so the candidate list comes from state —
    // this is the path that lets a user accidentally target a child directly
    // (synth-success mode filters children out since they are not in appStacks).
    mockSynthesize.mockRejectedValue(new Error('synth unavailable'));
    mockListStacks.mockResolvedValue([
      { stackName: 'NestedStackExample~Child', region: 'us-east-1' },
    ]);
    mockGetState.mockResolvedValue({
      state: makeChildStackState('NestedStackExample~Child', 'NestedStackExample', 'Child'),
      etag: '"x"',
    });

    await expect(
      runDestroy(['NestedStackExample~Child', '--yes'])
    ).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(2);

    // Guard fires BEFORE runDestroyForStack — no per-resource deletes attempted.
    expect(mockRunDestroyForStack).not.toHaveBeenCalled();

    const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(messages).toMatch(/NestedStackExample~Child/);
    expect(messages).toMatch(/nested child of 'NestedStackExample'/);
    // Error suggests both bypass paths: parent destroy AND state destroy escape hatch.
    expect(messages).toMatch(/cdkd destroy NestedStackExample/);
    // The labelled line, whole (go-to-k/cdkd#3436): a loose match accepts the
    // command back inside the sentence, which is the shape that pastes as shell.
    // The label says what the command DOES: `cdkd state destroy` deletes the
    // child's AWS resources and then its record — it is the synth-free destroy,
    // not a record-only drop (delta round 2 on go-to-k/cdkd#3436).
    expect(messages).toMatch(
      /^Destroy the child alone with: cdkd state destroy 'NestedStackExample~Child'$/m
    );
    // The parent's logical id helps the user identify which child this is when
    // a parent has multiple nested stacks with similar physical-key shapes.
    expect(messages).toMatch(/parent's logical id: Child/);
  });

  it('proceeds to destroy a top-level stack with no parentStack field set', async () => {
    // A normal top-level stack — v6 schema, but no nested-stack metadata —
    // must NOT trigger the guard.
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Plain', 'us-east-1')],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'Plain', region: 'us-east-1' }]);
    // makeStackState defaults to version: 1 — also exercises that the guard
    // tolerates pre-v6 states (parentStack is undefined on them).
    mockGetState.mockResolvedValue({ state: makeStackState('Plain'), etag: '"x"' });

    await runDestroy(['Plain', '--yes']);

    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
    expect(mockRunDestroyForStack.mock.calls[0]?.[0]).toBe('Plain');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('naming a parent + its nested child from state: parent destroys, child counts as failure (exit 2)', async () => {
    // Synth fails so the fallback path resolves both exact names from state.
    // The parent has no parentStack and proceeds; the child is refused. (This
    // used `--all`, which a failed synth now refuses outright, go-to-k/cdkd#3839.)
    mockSynthesize.mockRejectedValue(new Error('synth unavailable'));
    mockListStacks.mockResolvedValue([
      { stackName: 'NestedStackExample', region: 'us-east-1' },
      { stackName: 'NestedStackExample~Child', region: 'us-east-1' },
    ]);
    mockGetState.mockImplementation(async (name: string) => {
      if (name === 'NestedStackExample~Child') {
        return {
          state: makeChildStackState('NestedStackExample~Child', 'NestedStackExample', 'Child'),
          etag: '"x"',
        };
      }
      return { state: makeStackState(name), etag: '"x"' };
    });

    await expect(
      runDestroy(['NestedStackExample', 'NestedStackExample~Child', '--yes'])
    ).rejects.toThrow();

    // Parent destroyed; child refused.
    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
    expect(mockRunDestroyForStack.mock.calls[0]?.[0]).toBe('NestedStackExample');
    expect(exitSpy).toHaveBeenCalledWith(2);

    const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(messages).toMatch(/NestedStackExample~Child/);
    expect(messages).toMatch(/nested child of 'NestedStackExample'/);
    expect(messages).toMatch(/1 resource error/);
  });

  it('--all in synth-success mode does NOT trigger upfront refusal (children filtered out of candidateStacks; parent cascades through normal NestedStackProvider.delete path)', async () => {
    // The whole point of synth-success + `--all` is that ONLY top-level
    // stacks (appStacks) are destroyed; nested children are unreachable
    // through this code path because they aren't in candidateStacks. The
    // upfront-by-name refusal only fires for EXPLICIT named patterns, not
    // for `--all`. Verifies no false-positive A2 refusal on the most
    // common multi-stack destroy flow.
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('NestedStackExample', 'us-east-1')],
    });
    mockListStacks.mockResolvedValue([
      { stackName: 'NestedStackExample', region: 'us-east-1' },
      { stackName: 'NestedStackExample~Child', region: 'us-east-1' },
    ]);
    mockGetState.mockImplementation(async (name: string) => {
      if (name === 'NestedStackExample~Child') {
        return {
          state: makeChildStackState('NestedStackExample~Child', 'NestedStackExample', 'Child'),
          etag: '"x"',
        };
      }
      return { state: makeStackState(name), etag: '"x"' };
    });

    await runDestroy(['--all', '--yes']);

    // Parent dispatched to runner; child invisible to --all in synth-success.
    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
    expect(mockRunDestroyForStack.mock.calls[0]?.[0]).toBe('NestedStackExample');
    expect(exitSpy).not.toHaveBeenCalled();

    const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(messages).not.toMatch(/nested child of/);
  });

  it('refuses synth-success direct child destroy (the typical user-types-child path)', async () => {
    // synth-success path: appStacks contains only the parent (CDK top-level).
    // The child appears in state but is FILTERED OUT of candidateStacks by
    // the `appStacks.filter(stateNames.has)` pass, so matchStacks returns
    // empty. Pre-A2 the user saw a misleading "No matching stacks found in
    // state" message even though the state file existed. Post-A2 the
    // upfront-by-name guard catches the case and surfaces the dedicated
    // refusal with the parent's name.
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('NestedStackExample', 'us-east-1')],
    });
    mockListStacks.mockResolvedValue([
      { stackName: 'NestedStackExample', region: 'us-east-1' },
      { stackName: 'NestedStackExample~Child', region: 'us-east-1' },
    ]);
    mockGetState.mockImplementation(async (name: string) => {
      if (name === 'NestedStackExample~Child') {
        return {
          state: makeChildStackState('NestedStackExample~Child', 'NestedStackExample', 'Child'),
          etag: '"x"',
        };
      }
      return null;
    });

    await expect(
      runDestroy(['NestedStackExample~Child', '--yes'])
    ).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(2);

    // Refusal surfaced, no per-resource delete attempted.
    expect(mockRunDestroyForStack).not.toHaveBeenCalled();

    const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(messages).toMatch(/nested child of 'NestedStackExample'/);
    expect(messages).toMatch(/cdkd destroy NestedStackExample/);
    // The labelled line, whole (go-to-k/cdkd#3436): a loose match accepts the
    // command back inside the sentence, which is the shape that pastes as shell.
    // The label says what the command DOES: `cdkd state destroy` deletes the
    // child's AWS resources and then its record — it is the synth-free destroy,
    // not a record-only drop (delta round 2 on go-to-k/cdkd#3436).
    expect(messages).toMatch(
      /^Destroy the child alone with: cdkd state destroy 'NestedStackExample~Child'$/m
    );
  });

  it('wildcard pattern that matches only a child does NOT trigger the upfront refusal (generic miss is correct)', async () => {
    // The upfront-by-name refusal only fires for explicit, exact-name patterns
    // — wildcards / display paths don't carry the "destroy this specific
    // child" intent and fall through to the generic "No matching stacks"
    // miss. This guards against the refusal firing on `cdkd destroy "My*"`
    // when a child happens to match.
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('NestedStackExample', 'us-east-1')],
    });
    mockListStacks.mockResolvedValue([
      { stackName: 'NestedStackExample', region: 'us-east-1' },
      { stackName: 'NestedStackExample~Child', region: 'us-east-1' },
    ]);
    // matchStacks against a wildcard would match the parent (in candidateStacks)
    // — so set up the parent's state too. The point of THIS test is the
    // wildcard branch: a `Nope~*` wildcard matches no candidate-list entries
    // (the child is excluded from candidateStacks) and we want the generic
    // miss, not the A2 refusal.
    mockGetState.mockImplementation(async (name: string) => {
      if (name === 'NestedStackExample~Child') {
        return {
          state: makeChildStackState('NestedStackExample~Child', 'NestedStackExample', 'Child'),
          etag: '"x"',
        };
      }
      return null;
    });

    // Wildcard miss — falls through to generic "no matching" log, no exit.
    await runDestroy(['Nope~*', '--yes']);

    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    // No refusal message — generic miss only.
    const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(messages).not.toMatch(/nested child of/);
  });

  it('omits parent logical id from the message when v6 state lacks parentLogicalId', async () => {
    // Defense-in-depth case: a v6 state record where only `parentStack` is
    // populated (e.g. a hypothetical future writer that defers the logical
    // id, or hand-edited state). The guard must still fire on parentStack,
    // and the message should omit the "(parent's logical id: ...)" tail
    // rather than render `undefined`.
    mockSynthesize.mockRejectedValue(new Error('synth unavailable'));
    mockListStacks.mockResolvedValue([
      { stackName: 'NestedStackExample~Child', region: 'us-east-1' },
    ]);
    const childStateNoLogicalId = makeChildStackState(
      'NestedStackExample~Child',
      'NestedStackExample',
      'placeholder'
    );
    // Strip the logical id to simulate the missing-field case.
    delete (childStateNoLogicalId as { parentLogicalId?: string }).parentLogicalId;
    mockGetState.mockResolvedValue({ state: childStateNoLogicalId, etag: '"x"' });

    await expect(
      runDestroy(['NestedStackExample~Child', '--yes'])
    ).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(2);

    const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(messages).toMatch(/nested child of 'NestedStackExample'/);
    expect(messages).not.toMatch(/parent's logical id/);
    expect(messages).not.toMatch(/undefined/);
  });
});

describe('cdkd destroy: empty selection names a Stage that failed to load (go-to-k/cdkd#3507)', () => {
  const failedStages = [{ stagePath: 'MyStage', reason: 'ENOENT reading assembly-MyStage' }];
  const note = 'Stage MyStage failed to load, so stacks under it are missing from this list';
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockListStacks.mockReset();
    mockSynthesize.mockReset();
    // The previous describe leaves nested-child state behind; a leaked
    // `parentStack` would refuse a stack before it could ever reach the runner.
    mockGetState.mockReset();
    mockGetState.mockImplementation(async (name: string) => ({
      state: makeStackState(name),
      etag: '"x"',
    }));
    mockRunDestroyForStack.mockReset();
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
    infoSpy.mockReset();
    errorSpy.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit-mock');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  const infoText = (): string => infoSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');

  it('names the Stage a display-path pattern targets when the stack exists in state', async () => {
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Other')],
      failedStages,
    });
    mockListStacks.mockResolvedValue([
      { stackName: 'Other', region: 'us-east-1' },
      { stackName: 'MyStage-MyStack', region: 'us-east-1' },
    ]);

    await runDestroy(['MyStage/MyStack', '--yes']);

    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
    expect(infoText()).toContain(`No matching stacks found in state. ${note}`);
  });

  it('hedges the Stage when the pattern does not target it', async () => {
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Other')],
      failedStages,
    });
    mockListStacks.mockResolvedValue([{ stackName: 'Other', region: 'us-east-1' }]);

    await runDestroy(['Nope*', '--yes']);

    expect(infoText()).toContain(`No matching stacks found in state. Possibly unrelated: ${note}`);
  });

  it('keeps the bare message when synth fails, so no Stage can be named', async () => {
    mockSynthesize.mockRejectedValue(new Error('synth unavailable'));
    mockListStacks.mockResolvedValue([{ stackName: 'Other', region: 'us-east-1' }]);

    await runDestroy(['MyStage/MyStack', '--yes']);

    expect(infoSpy.mock.calls.map((c) => c[0])).toContain('No matching stacks found in state');
  });

  it('refuses --all or a wildcard over an app that synthesized no stacks instead of taking every stack in state', async () => {
    // [argv, selector named in the refusal, hedge before the note]. A pattern
    // without `/` cannot be attributed to a Stage, so its note is hedged.
    for (const [args, selector, hedge] of [
      [['--all'], '--all', ''],
      [['*'], '*', 'Possibly unrelated: '],
      [['Cdkd*'], 'Cdkd*', 'Possibly unrelated: '],
      [['--stack', 'Cdkd*'], 'Cdkd*', 'Possibly unrelated: '],
      [['MyStage/*'], 'MyStage/*', ''],
      // An exact name beside a wildcard does not rescue the command.
      [['MyStage-MyStack', 'Cdkd*', 'MyStage/*'], 'Cdkd*, MyStage/*', ''],
      // `?` is literal to matchStacks and no CFn name contains one; it is
      // refused anyway, fail-closed, like the nested-child check's wildcard test.
      [['MyStage-?yStack'], 'MyStage-?yStack', 'Possibly unrelated: '],
    ] as const) {
      for (const stages of [failedStages, []]) {
        errorSpy.mockClear();
        exitSpy.mockClear();
        mockGetState.mockClear();
        mockRunDestroyForStack.mockClear();
        mockSynthesize.mockResolvedValue({
          manifest: {},
          assemblyDir: '/tmp/cdk.out',
          stacks: [],
          failedStages: stages,
        });
        mockListStacks.mockResolvedValue([
          { stackName: 'MyStage-MyStack', region: 'us-east-1' },
          { stackName: 'CdkdOtherApp', region: 'us-east-1' },
        ]);

        mockListStacks.mockClear();
        await expect(runDestroy([...args, '--yes']), selector).rejects.toThrow('process.exit-mock');
        expect(exitSpy, selector).toHaveBeenCalledWith(1);
        // Refused before the bucket is even listed, let alone destroyed.
        expect(mockListStacks, selector).not.toHaveBeenCalled();
        expect(mockGetState, selector).not.toHaveBeenCalled();
        expect(mockRunDestroyForStack, selector).not.toHaveBeenCalled();
        const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
        expect(messages, selector).toContain(
          `${selector} selects among the stacks this app synthesizes, and it synthesized none; refusing to fall back to every stack in state`
        );
        if (stages.length > 0) {
          expect(messages, selector).toContain(`every stack in state. ${hedge}${note}`);
        } else {
          expect(messages, selector).toMatch(/every stack in state\.$/m);
        }
      }
    }
  });

  it('still resolves an exact physical name through the state fallback when the app synthesized no stacks', async () => {
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [],
      failedStages,
    });
    mockListStacks.mockResolvedValue([
      { stackName: 'MyStage-MyStack', region: 'us-east-1' },
      { stackName: 'CdkdOtherApp', region: 'us-east-1' },
    ]);

    await runDestroy(['MyStage-MyStack', '--yes']);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
    expect(mockRunDestroyForStack.mock.calls[0]?.[0]).toBe('MyStage-MyStack');
  });

  it('refuses --all when SOME stacks synthesized beside a Stage that failed to load', async () => {
    // Destroying the survivors and exiting 0 left the Stage's stacks running
    // with the Stage warning as the only signal (go-to-k/cdkd#3507).
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Other')],
      failedStages,
    });
    mockListStacks.mockResolvedValue([
      { stackName: 'Other', region: 'us-east-1' },
      { stackName: 'MyStage-MyStack', region: 'us-east-1' },
    ]);

    await expect(runDestroy(['--all', '--yes'])).rejects.toThrow('process.exit-mock');

    expect(exitSpy).toHaveBeenCalledWith(1);
    // Refused before the bucket is even listed, let alone destroyed.
    expect(mockListStacks).not.toHaveBeenCalled();
    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
    const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(messages).toContain(
      `--all would destroy only part of this app; refusing. Synthesized: Other. ${note}`
    );
    expect(messages).toContain('or name the stacks to destroy explicitly.');
  });

  it('still destroys every app stack with --all when every Stage loaded', async () => {
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Other')],
      failedStages: [],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'Other', region: 'us-east-1' }]);

    await runDestroy(['--all', '--yes']);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
    expect(mockRunDestroyForStack.mock.calls[0]?.[0]).toBe('Other');
  });

  // A bare `cdkd destroy` auto-selected the one deployed survivor as if the
  // app held only that stack (go-to-k/cdkd#3507).
  it('refuses the single-stack auto-pick when a Stage failed to load', async () => {
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Other')],
      failedStages,
    });
    mockListStacks.mockResolvedValue([
      { stackName: 'Other', region: 'us-east-1' },
      { stackName: 'MyStage-MyStack', region: 'us-east-1' },
    ]);

    await expect(runDestroy(['--yes'])).rejects.toThrow('process.exit-mock');

    expect(exitSpy).toHaveBeenCalledWith(1);
    // Refused before the bucket is even listed, as --all is.
    expect(mockListStacks).not.toHaveBeenCalled();
    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
    const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(messages).toContain(
      `With no stack named, cdkd would destroy only part of this app; refusing. Synthesized: Other. ${note}`
    );
  });

  it('refuses a bare run with SEVERAL synthesized stacks beside a failed Stage, before listing the bucket', async () => {
    // Was "Multiple stacks found" after listing the bucket; now the same
    // partial-app refusal as one survivor, since no stack is named either way.
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Other'), makeStackInfo('Second')],
      failedStages,
    });
    mockListStacks.mockResolvedValue([
      { stackName: 'Other', region: 'us-east-1' },
      { stackName: 'Second', region: 'us-east-1' },
    ]);

    await expect(runDestroy(['--yes'])).rejects.toThrow('process.exit-mock');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockListStacks).not.toHaveBeenCalled();
    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
    const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(messages).toContain(
      `With no stack named, cdkd would destroy only part of this app; refusing. Synthesized: Other, Second. ${note}`
    );
    expect(messages).not.toContain('Multiple stacks found');
  });

  it('still destroys a NAMED survivor beside a failed Stage', async () => {
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Other')],
      failedStages,
    });
    mockListStacks.mockResolvedValue([{ stackName: 'Other', region: 'us-east-1' }]);

    await runDestroy(['Other', '--yes']);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
    expect(mockRunDestroyForStack.mock.calls[0]?.[0]).toBe('Other');
  });

  it('still auto-picks the single deployed stack when every Stage loaded', async () => {
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Other')],
      failedStages: [],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'Other', region: 'us-east-1' }]);

    await runDestroy(['--yes']);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
    expect(mockRunDestroyForStack.mock.calls[0]?.[0]).toBe('Other');
  });

  it('control: with every Stage loaded, a bare run whose app stack has no state record still ends clean', async () => {
    // The `No stacks found in state` arm (exit 0) stays for a WHOLE app: no
    // Stage failed, so "nothing deployed" is a verdict over every stack.
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('NeverDeployed')],
      failedStages: [],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'SomeOtherApp', region: 'us-east-1' }]);

    await runDestroy(['--yes']);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
    expect(infoText()).toContain('No stacks found in state');
  });

  it('refuses, rather than exiting 0, when the only deployed stack sat under the failed Stage', async () => {
    // The synthesized survivor has no state record, so the bare run used to end
    // with "No stacks found in state" and exit 0 -- deciding "nothing to
    // destroy" from part of the app (go-to-k/cdkd#3507).
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('NeverDeployed')],
      failedStages,
    });
    mockListStacks.mockResolvedValue([{ stackName: 'MyStage-MyStack', region: 'us-east-1' }]);

    await expect(runDestroy(['--yes'])).rejects.toThrow('process.exit-mock');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockListStacks).not.toHaveBeenCalled();
    const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(messages).toContain(
      `With no stack named, cdkd would destroy only part of this app; refusing. Synthesized: NeverDeployed. ${note}`
    );
    expect(infoText()).not.toContain('No stacks found in state');
  });

  it('names the Stage when the whole app sat under it and no stack was named', async () => {
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [],
      failedStages,
    });
    mockListStacks.mockResolvedValue([{ stackName: 'MyStage-MyStack', region: 'us-east-1' }]);

    await expect(runDestroy(['--yes'])).rejects.toThrow('process.exit-mock');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(messages).toContain(`ensure --app / cdk.json is configured. ${note}`);
    // --all is refused once synth succeeded, so it is not offered as advice.
    expect(messages).toContain('Specify stack names explicitly, or ensure --app');
    expect(messages).not.toContain('use --all');
  });

  it('no longer advises --all when synth failed and no stack was named, and says why synth failed', async () => {
    // --all is refused without a synthesized app too (go-to-k/cdkd#3839).
    mockSynthesize.mockRejectedValue(new Error('synth unavailable'));
    mockListStacks.mockResolvedValue([{ stackName: 'MyStage-MyStack', region: 'us-east-1' }]);

    await expect(runDestroy(['--yes'])).rejects.toThrow('process.exit-mock');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(messages).toMatch(
      /Specify stack names explicitly, or ensure --app \/ cdk\.json is configured\.$/m
    );
    expect(messages).not.toContain('use --all');
    expect(messages).toMatch(/^Caused by: synth unavailable$/m);
    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
  });

  it('keeps the bare message when no Stage failed', async () => {
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Other')],
      failedStages: [],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'Other', region: 'us-east-1' }]);

    await runDestroy(['MyStage/MyStack', '--yes']);

    expect(infoSpy.mock.calls.map((c) => c[0])).toContain('No matching stacks found in state');

    // The refusal keeps its own full stop when there is no note to append.
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [],
      failedStages: [],
    });
    await expect(runDestroy(['--yes'])).rejects.toThrow('process.exit-mock');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(messages).toMatch(/ensure --app \/ cdk\.json is configured\.$/m);
  });
});

describe('cdkd destroy: no synthesized app means no app scope for --all or a wildcard (go-to-k/cdkd#3839)', () => {
  // Two stacks in state, from two apps. Without a synthesized app there is no
  // way to tell them apart, so a selector that means "the app's stacks" must
  // refuse rather than take both.
  const stateRefs = [
    { stackName: 'CdkdThisApp', region: 'us-east-1' },
    { stackName: 'CdkdOtherApp', region: 'us-east-1' },
  ];
  // [argv, the selector the refusal names]. Every shape `--all` or a wildcard
  // can take, including a wildcard beside an exact name (which does not rescue
  // the command) and a display-path wildcard.
  const selections = [
    [['--all'], '--all'],
    [['*'], '*'],
    [['Cdkd*'], 'Cdkd*'],
    [['--stack', 'Cdkd*'], 'Cdkd*'],
    [['CdkdThisApp', 'Cdkd*'], 'Cdkd*'],
    [['MyStage/*'], 'MyStage/*'],
    [['CdkdThisAp?'], 'CdkdThisAp?'],
  ] as const;
  // The three ways the command can be told not to prompt, plus none at all:
  // the refusal must fire before the per-stack prompt in every one.
  const promptFlags = [['--yes'], ['--force'], ['-f'], []] as const;
  // Synth failed, and no app configured at all (resolveApp finds nothing).
  const noApp = [
    {
      label: 'synth failed',
      setup: () => {
        mockSynthesize.mockRejectedValue(new Error('Cannot find module ./bin/app.js'));
      },
      reason: 'the app could not be synthesized',
      hint: 'Fix the app so it synthesizes',
      cause: /^Caused by: Cannot find module \.\/bin\/app\.js$/m,
    },
    {
      label: 'no app configured',
      setup: () => {
        vi.mocked(resolveApp).mockReturnValue(undefined);
      },
      reason: 'no app is configured',
      hint: 'Configure the app with --app or cdk.json',
      cause: undefined,
    },
  ] as const;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockListStacks.mockReset();
    mockListStacks.mockResolvedValue(stateRefs);
    mockSynthesize.mockReset();
    mockGetState.mockReset();
    mockGetState.mockImplementation(async (name: string) => ({
      state: makeStackState(name),
      etag: '"x"',
    }));
    mockRunDestroyForStack.mockReset();
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
    vi.mocked(resolveApp).mockReset();
    vi.mocked(resolveApp).mockReturnValue('fake-app-cmd');
    infoSpy.mockReset();
    errorSpy.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit-mock');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.mocked(resolveApp).mockReset();
    vi.mocked(resolveApp).mockReturnValue('fake-app-cmd');
    vi.clearAllMocks();
  });

  const errorText = (): string => errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');

  it('refuses --all and every wildcard shape, before any state listing or prompt, naming why', async () => {
    let cases = 0;
    for (const arm of noApp) {
      for (const [args, selector] of selections) {
        for (const flags of promptFlags) {
          const label = `${arm.label}: ${[...args, ...flags].join(' ')}`;
          errorSpy.mockClear();
          exitSpy.mockClear();
          mockListStacks.mockClear();
          mockGetState.mockClear();
          mockRunDestroyForStack.mockClear();
          mockSynthesize.mockReset();
          vi.mocked(resolveApp).mockReturnValue('fake-app-cmd');
          arm.setup();

          await expect(runDestroy([...args, ...flags]), label).rejects.toThrow('process.exit-mock');
          expect(exitSpy, label).toHaveBeenCalledWith(1);
          // Nothing listed, read, locked or destroyed. The per-stack prompt
          // lives in the (mocked) runner, so an uncalled runner is also a
          // prompt that was never reached.
          expect(mockListStacks, label).not.toHaveBeenCalled();
          expect(mockGetState, label).not.toHaveBeenCalled();
          expect(mockRunDestroyForStack, label).not.toHaveBeenCalled();
          const messages = errorText();
          expect(messages, label).toContain(
            `${selector} selects among the stacks this app synthesizes, and ${arm.reason}; ` +
              'refusing to fall back to every stack in state, which spans every app sharing this state bucket. ' +
              `${arm.hint}, or name each stack exactly: cdkd destroy '<stack>', or cdkd state destroy '<stack>', which needs no app.`
          );
          // The synth error is surfaced, and only when there is one.
          if (arm.cause) {
            expect(messages, label).toMatch(arm.cause);
          } else {
            expect(messages, label).not.toContain('Caused by:');
          }
          // No cross-app batch is offered as the way out.
          expect(messages, label).not.toContain('state destroy --all');
          expect(messages, label).not.toContain('use --all');
          cases++;
        }
      }
    }
    expect(cases).toBe(noApp.length * selections.length * promptFlags.length);
  });

  it('still resolves an exact physical name from state, positional or --stack, under each confirm flag', async () => {
    let cases = 0;
    for (const arm of noApp) {
      for (const name of [['CdkdOtherApp'], ['--stack', 'CdkdOtherApp']] as const) {
        for (const flags of [['--yes'], ['--force'], ['-f']] as const) {
          const label = `${arm.label}: ${[...name, ...flags].join(' ')}`;
          exitSpy.mockClear();
          mockRunDestroyForStack.mockClear();
          mockSynthesize.mockReset();
          vi.mocked(resolveApp).mockReturnValue('fake-app-cmd');
          arm.setup();

          await runDestroy([...name, ...flags]);

          expect(exitSpy, label).not.toHaveBeenCalled();
          expect(mockRunDestroyForStack, label).toHaveBeenCalledTimes(1);
          expect(mockRunDestroyForStack.mock.calls[0]?.[0], label).toBe('CdkdOtherApp');
          cases++;
        }
      }
    }
    expect(cases).toBe(noApp.length * 2 * 3);
  });

  it('renders a wildcard carrying a newline on one line of the refusal', async () => {
    mockSynthesize.mockRejectedValue(new Error('Cannot find module ./bin/app.js'));

    await expect(runDestroy(['Cdkd*\nForged: cdkd destroy --all', '--force'])).rejects.toThrow(
      'process.exit-mock'
    );
    const messages = errorText();
    // Positive control: the refusal fired for this pattern.
    expect(messages).toContain('selects among the stacks this app synthesizes');
    expect(messages).toContain('Cdkd*');
    expect(messages.split('\n').some((l) => l.startsWith('Forged:'))).toBe(false);
    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
  });

  it('codes the refusals by what is missing: an app scope, or any stack selection', async () => {
    passErrorsThrough.on = true;
    try {
      const cases: Array<[string, () => void, string[], string]> = [
        // --all / a wildcard with no synthesized app.
        ['synth failed, --all', () => mockSynthesize.mockRejectedValue(new Error('boom')), ['--all'], 'DESTROY_NO_APP_SCOPE'],
        ['no app, wildcard', () => vi.mocked(resolveApp).mockReturnValue(undefined), ['Cdkd*'], 'DESTROY_NO_APP_SCOPE'],
        // No stack named at all: the selection is what is missing, whether or
        // not an app synthesized.
        ['synth failed, nothing named', () => mockSynthesize.mockRejectedValue(new Error('boom')), [], 'DESTROY_NO_STACK_SELECTED'],
        ['no app, nothing named', () => vi.mocked(resolveApp).mockReturnValue(undefined), [], 'DESTROY_NO_STACK_SELECTED'],
        [
          'zero-stack app, nothing named',
          () =>
            mockSynthesize.mockResolvedValue({
              manifest: {},
              assemblyDir: '/tmp/cdk.out',
              stacks: [],
              failedStages: [],
            }),
          [],
          'DESTROY_NO_STACK_SELECTED',
        ],
      ];
      for (const [label, setup, args, code] of cases) {
        mockSynthesize.mockReset();
        vi.mocked(resolveApp).mockReturnValue('fake-app-cmd');
        setup();
        await expect(runDestroy([...args, '--force']), label).rejects.toMatchObject({ code });
        expect(mockRunDestroyForStack, label).not.toHaveBeenCalled();
      }
    } finally {
      passErrorsThrough.on = false;
    }
  });

  it('still resolves several exact names from state when synth failed', async () => {
    mockSynthesize.mockRejectedValue(new Error('Cannot find module ./bin/app.js'));

    await runDestroy(['CdkdThisApp', 'CdkdOtherApp', '--force']);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockRunDestroyForStack.mock.calls.map((c) => c[0]).sort()).toEqual([
      'CdkdOtherApp',
      'CdkdThisApp',
    ]);
  });

  it('keeps --all and wildcards scoped to the synthesized app when synth succeeds', async () => {
    // Positive control for the arm above: the same argv, with an app that
    // synthesizes CdkdThisApp only, destroys that one stack and never the other
    // app's.
    let cases = 0;
    for (const [args] of [[['--all']], [['*']], [['Cdkd*']], [['--stack', 'Cdkd*']]] as const) {
      const label = args.join(' ');
      exitSpy.mockClear();
      mockRunDestroyForStack.mockClear();
      mockSynthesize.mockResolvedValue({
        manifest: {},
        assemblyDir: '/tmp/cdk.out',
        stacks: [makeStackInfo('CdkdThisApp')],
        failedStages: [],
      });

      await runDestroy([...args, '--force']);

      expect(exitSpy, label).not.toHaveBeenCalled();
      expect(mockRunDestroyForStack.mock.calls.map((c) => c[0]), label).toEqual(['CdkdThisApp']);
      cases++;
    }
    expect(cases).toBe(4);
  });
});
