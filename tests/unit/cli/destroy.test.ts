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
import { stageLoadError } from '../../../src/synthesis/failed-stages.js';
import { TemplateNoEchoReresolver } from '../../../src/deployment/noecho-delete-reresolution.js';

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

  it('the protected-stack retry carries --profile, the bucket and the prefix (go-to-k/cdkd#4648 review)', async () => {
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Protected', 'us-east-1', true)],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'Protected', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({ state: makeStackState('Protected'), etag: '"x"' });
    await expect(
      runDestroy(['Protected', '--yes', '--profile', 'prod', '--state-prefix', 'team-a'])
    ).rejects.toThrow();
    const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(messages).toMatch(
      /^Retry with: cdkd destroy Protected --profile prod --state-bucket test-bucket --state-prefix team-a$/m
    );
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
      "Remove one record with: cdkd state orphan Multi --stack-region '<region>' --state-bucket test-bucket",
    ]);
    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
  });

  it('the multi-region drop carries --profile and the prefix too (go-to-k/cdkd#4648)', async () => {
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Multi', 'eu-west-2')],
    });
    mockListStacks.mockResolvedValue([
      { stackName: 'Multi', region: 'us-east-1' },
      { stackName: 'Multi', region: 'eu-west-1' },
    ]);
    await expect(
      runDestroy(['Multi', '--yes', '--profile', 'prod', '--state-prefix', 'team-a'])
    ).rejects.toThrow();
    const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(messages.split('\n').filter((l) => l.startsWith('Remove one record with:'))).toEqual([
      "Remove one record with: cdkd state orphan Multi --stack-region '<region>' --profile prod --state-bucket test-bucket --state-prefix team-a",
    ]);
  });

  it('a refused --profile on the multi-region drop is a described hole (go-to-k/cdkd#4648)', async () => {
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Multi', 'eu-west-2')],
    });
    mockListStacks.mockResolvedValue([
      { stackName: 'Multi', region: 'us-east-1' },
      { stackName: 'Multi', region: 'eu-west-1' },
    ]);
    await expect(runDestroy(['Multi', '--yes', '--profile', 'my profile'])).rejects.toThrow();
    const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(messages).toMatch(/^Remove one record with: .* --profile '<profile>' --state-bucket test-bucket$/m);
    expect(messages).not.toContain('my profile');
    expect(messages).toContain("The '--profile' value this run was given is not a plain identifier");
    const reason = messages.indexOf('so the command below prints a quoted hole in its place');
    expect(reason).toBeGreaterThan(-1);
    expect(reason).toBeLessThan(messages.indexOf('Remove one record with:'));
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
        "Remove one record with: cdkd state orphan '<stack>' --stack-region '<region>' --state-bucket test-bucket",
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
    expect(plain).toMatch(/^Remove one record with: cdkd state orphan Multi --stack-region '<region>' --state-bucket test-bucket$/m);
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

    // go-to-k/cdkd#4705 (review R4-3): every target stack's scan starts before
    // the first stack's destroy, through the run's one cache.
    const { CrossPrefixScanCache } = await import('../../../src/state/cross-prefix-stack-scan.js');
    const order: string[] = [];
    const fullSpy = vi
      .spyOn(CrossPrefixScanCache.prototype, 'full')
      .mockImplementation(async (name: string) => {
        order.push(`scan:${name}`);
        return { kind: 'clear' };
      });
    mockRunDestroyForStack.mockImplementation(async (name: string) => {
      order.push(`destroy:${name}`);
      return { stackName: name, cancelled: false, deletedCount: 0, errorCount: 0, skippedCount: 0, retainedCount: 0, guardIndeterminateCount: 0, skippedEmpty: false, interrupted: false };
    });

    await runDestroy(['--all', '--yes']);
    fullSpy.mockRestore();

    // Present (a removed pre-start loop leaves -1, which is "less than" too).
    expect(order.filter((o) => o.startsWith('scan:'))).toEqual(['scan:Plain', 'scan:Unguarded']);
    expect(order.indexOf('scan:Plain')).toBeLessThan(order.findIndex((o) => o.startsWith('destroy:')));
    expect(order.indexOf('scan:Unguarded')).toBeLessThan(order.findIndex((o) => o.startsWith('destroy:')));
    const caches = new Set(mockRunDestroyForStack.mock.calls.map((c) => c[2].crossPrefixCheck?.cache));
    expect(caches.size).toBe(1);
    // Review R5-8: the command's finally destroys the client of the backend
    // the destroys (and the scans) ran on, once.
    const backends = new Set(mockRunDestroyForStack.mock.calls.map((c) => c[2].stateBackend));
    expect(backends.size).toBe(1);
    expect([...backends][0].destroyClient).toHaveBeenCalledTimes(1);

    // Both stacks flow through the runner — guard does not fire.
    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(2);
    const dispatched = new Set(
      mockRunDestroyForStack.mock.calls.map((c) => c[0] as string)
    );
    expect(dispatched).toEqual(new Set(['Plain', 'Unguarded']));
    // No partial-failure exit on the happy path.
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('pre-starts a scan only in the region the run destroys, and none for a protected stack (go-to-k/cdkd#4705 review R5-5)', async () => {
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [
        makeStackInfo('Multi', 'eu-west-1'),
        makeStackInfo('Guarded', 'us-east-1', true),
      ],
    });
    mockListStacks.mockResolvedValue([
      { stackName: 'Multi', region: 'us-east-1' },
      { stackName: 'Multi', region: 'eu-west-1' },
      { stackName: 'Guarded', region: 'us-east-1' },
    ]);
    mockGetState.mockImplementation(async (name: string) => ({
      state: makeStackState(name),
      etag: '"x"',
    }));
    const { CrossPrefixScanCache } = await import('../../../src/state/cross-prefix-stack-scan.js');
    const fullSpy = vi
      .spyOn(CrossPrefixScanCache.prototype, 'full')
      .mockResolvedValue({ kind: 'clear' });
    mockRunDestroyForStack.mockImplementation(async (name: string) => ({
      stackName: name,
      cancelled: false,
      deletedCount: 0,
      errorCount: 0,
      skippedCount: 0,
      retainedCount: 0,
      guardIndeterminateCount: 0,
      skippedEmpty: false,
      interrupted: false,
    }));

    await runDestroy(['--all', '--yes']).catch(() => undefined);
    const calls = fullSpy.mock.calls.map((c) => [c[0], c[1]]);
    fullSpy.mockRestore();

    expect(calls).toEqual([['Multi', 'eu-west-1']]);
  });

  it('plannedDestroyRegion: the only region, the CLI region for a legacy record, the synth region among several, else none', async () => {
    const { plannedDestroyRegion } = await import('../../../src/cli/commands/destroy.js');
    expect(plannedDestroyRegion([{ region: 'eu-west-1' }], 'us-east-1', 'ap-1')).toBe('eu-west-1');
    expect(plannedDestroyRegion([{}], undefined, 'ap-1')).toBe('ap-1');
    expect(
      plannedDestroyRegion([{ region: 'us-east-1' }, { region: 'eu-west-1' }], 'eu-west-1', 'ap-1')
    ).toBe('eu-west-1');
    expect(
      plannedDestroyRegion([{ region: 'us-east-1' }, { region: 'eu-west-1' }], 'ap-1', 'ap-1')
    ).toBeUndefined();
    expect(plannedDestroyRegion([], 'us-east-1', 'ap-1')).toBeUndefined();
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
    const getLoggerSpy = vi.spyOn(loggerModule, 'getLogger').mockReturnValue({
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
    // go-to-k/cdkd#2115: a top-level destroy is a whole-stack teardown.
    expect(mockRunDestroyForStack.mock.calls[0]?.[2].stackDestroy).toBe(true);
    // go-to-k/cdkd#4705: a top-level destroy checks the bucket's other state prefixes.
    expect(mockRunDestroyForStack.mock.calls[0]?.[2].crossPrefixCheck?.cache).toBeDefined();

    // No exit-2 on the bypass path.
    expect(exitSpy).not.toHaveBeenCalled();

    // The bypass is announced via WARN so it shows in CI logs.
    const warnMessages = warnSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(warnMessages).toMatch(/Protected/);
    expect(warnMessages).toMatch(/--remove-protection/);
    // Restored, so later cases see the file-level logger mock again.
    getLoggerSpy.mockRestore();
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

  // go-to-k/cdkd#4682: the synthesized template reaches the runner as the
  // NoEcho re-resolution source; a macro-carrying one does not (never expanded
  // here), and `cdkd state destroy` holds none (pinned in state-destroy.test.ts).
  it.each([
    ['a plain template', {}, true],
    ['a template a macro rewrites', { Transform: 'AWS::Serverless-2016-10-31' }, false],
    ['a template synthesized for another region', { region: 'eu-west-1' }, false],
  ])('threads the NoEcho re-resolution source for %s', async (_what, extra, threaded) => {
    const { region: synthRegion, ...templateExtra } = extra as Record<string, unknown>;
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [
        {
          ...makeStackInfo('Plain', (synthRegion as string | undefined) ?? 'us-east-1'),
          template: { Resources: {}, ...templateExtra },
          nestedTemplates: { Child: '/tmp/cdk.out/child.template.json' },
        },
      ],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'Plain', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({ state: makeStackState('Plain'), etag: '"x"' });

    await runDestroy(['Plain', '--yes']);

    const ctx = mockRunDestroyForStack.mock.calls[0]?.[2] as Record<string, unknown>;
    if (threaded) {
      expect(ctx['noEchoReresolver']).toBeInstanceOf(TemplateNoEchoReresolver);
      // The child template index rides along, so a nested row's child re-resolves too.
      expect(
        (ctx['noEchoReresolver'] as unknown as { options: { nestedTemplates?: unknown } }).options
          .nestedTemplates
      ).toEqual({ Child: '/tmp/cdk.out/child.template.json' });
    } else {
      expect(ctx).not.toHaveProperty('noEchoReresolver');
    }
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
      /^Destroy the child alone with: cdkd state destroy 'NestedStackExample~Child' --state-bucket test-bucket$/m
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

  // go-to-k/cdkd#4648: both commands of the refusal (`cdkd destroy <parent>`
  // and the DESTRUCTIVE `cdkd state destroy <child>`) carry the run's account
  // flags, on both refusal sites, so a paste acts on the bucket this run read.
  const childOnly = async (synthOk: boolean, extra: string[]): Promise<string> => {
    if (synthOk) {
      mockSynthesize.mockResolvedValue({
        manifest: {},
        assemblyDir: '/tmp/cdk.out',
        stacks: [makeStackInfo('NestedStackExample', 'us-east-1')],
      });
    } else {
      mockSynthesize.mockRejectedValue(new Error('synth unavailable'));
    }
    mockListStacks.mockResolvedValue([
      ...(synthOk ? [{ stackName: 'NestedStackExample', region: 'us-east-1' }] : []),
      { stackName: 'NestedStackExample~Child', region: 'us-east-1' },
    ]);
    mockGetState.mockImplementation(async (name: string) =>
      name === 'NestedStackExample~Child'
        ? {
            state: makeChildStackState('NestedStackExample~Child', 'NestedStackExample', 'Child'),
            etag: '"x"',
          }
        : null
    );
    await expect(runDestroy(['NestedStackExample~Child', '--yes', ...extra])).rejects.toThrow();
    return errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
  };
  for (const synthOk of [false, true]) {
    const site = synthOk ? 'synth-success site' : 'state-only site';
    it(`${site}: both commands carry --profile, the resolved bucket and the prefix (go-to-k/cdkd#4648)`, async () => {
      const messages = await childOnly(synthOk, ['--profile', 'prod', '--state-prefix', 'team-a']);
      const flags = '--profile prod --state-bucket test-bucket --state-prefix team-a';
      expect(messages).toMatch(
        new RegExp(`^Cascade-delete with: cdkd destroy NestedStackExample ${flags}$`, 'm')
      );
      expect(messages).toMatch(
        new RegExp(`^Destroy the child alone with: cdkd state destroy 'NestedStackExample~Child' ${flags}$`, 'm')
      );
    });
  }

  it('a refused --profile is a described hole on both commands, never echoed (go-to-k/cdkd#4648)', async () => {
    const messages = await childOnly(false, ['--profile', 'my profile']);
    expect(messages).toMatch(/^Cascade-delete with: cdkd destroy NestedStackExample --profile '<profile>' --state-bucket test-bucket$/m);
    expect(messages).toMatch(/^Destroy the child alone with: .* --profile '<profile>' --state-bucket test-bucket$/m);
    expect(messages).not.toContain('my profile');
    // Explained before the labelled lines.
    const reason = messages.indexOf("The '--profile' value this run was given is not a plain identifier");
    expect(reason).toBeGreaterThan(-1);
    expect(reason).toBeLessThan(messages.indexOf('Cascade-delete with:'));
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
    // The child IS in state, so no unmatched-pattern warning contradicts the
    // refusal (go-to-k/cdkd#3507).
    expect(warnSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n')).not.toContain(
      'matched no stack'
    );
    // The labelled line, whole (go-to-k/cdkd#3436): a loose match accepts the
    // command back inside the sentence, which is the shape that pastes as shell.
    // The label says what the command DOES: `cdkd state destroy` deletes the
    // child's AWS resources and then its record — it is the synth-free destroy,
    // not a record-only drop (delta round 2 on go-to-k/cdkd#3436).
    expect(messages).toMatch(
      /^Destroy the child alone with: cdkd state destroy 'NestedStackExample~Child' --state-bucket test-bucket$/m
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

describe('cdkd destroy: a Stage that failed to load fails synthesis (go-to-k/cdkd#3507)', () => {
  const stageError = (): Error =>
    stageLoadError('MyStage', 'ENOENT reading assembly-MyStage/manifest.json');
  const failure = 'Stage MyStage failed to load: ENOENT reading assembly-MyStage/manifest.json';
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
  const warnText = (): string => warnSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');

  it('fails every selection with the synthesis error, before the state bucket is listed', async () => {
    // Even an EXACT name: unlike an app that cannot be synthesized at all
    // (#3839), the app is there but incomplete, and the AWS CDK CLI refuses
    // it outright. `cdkd state destroy` needs no app.
    for (const args of [['--all'], [], ['*'], ['MyStage/*'], ['Other'], ['--stack', 'Other']]) {
      errorSpy.mockClear();
      exitSpy.mockClear();
      mockListStacks.mockClear();
      mockSynthesize.mockRejectedValue(stageError());
      mockListStacks.mockResolvedValue([
        { stackName: 'Other', region: 'us-east-1' },
        { stackName: 'MyStage-MyStack', region: 'us-east-1' },
      ]);

      await expect(runDestroy([...args, '--yes']), args.join(' ')).rejects.toThrow(
        'process.exit-mock'
      );

      expect(exitSpy, args.join(' ')).toHaveBeenCalledWith(1);
      expect(mockListStacks, args.join(' ')).not.toHaveBeenCalled();
      expect(mockGetState, args.join(' ')).not.toHaveBeenCalled();
      expect(mockRunDestroyForStack, args.join(' ')).not.toHaveBeenCalled();
      const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
      expect(messages, args.join(' ')).toContain(failure);
      // The escape hatch that needs no app.
      expect(messages, args.join(' ')).toContain(
        "To destroy a deployed stack without the app: cdkd state destroy '<stack>'."
      );
    }
  });

  it("keeps the reader's frames under the re-raised error, for --verbose", async () => {
    const original = stageError();
    original.stack = `${original.name}: ${original.message}\n    at readerFrame (assembly-reader.ts:1:1)`;
    mockSynthesize.mockRejectedValue(original);
    mockListStacks.mockResolvedValue([{ stackName: 'Other', region: 'us-east-1' }]);
    const debugSpy = vi.fn();
    const loggerModule = await import('../../../src/utils/logger.js');
    const getLoggerSpy = vi.spyOn(loggerModule, 'getLogger').mockReturnValue({
      setLevel: vi.fn(),
      debug: debugSpy,
      info: infoSpy,
      warn: warnSpy,
      error: errorSpy,
      child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    } as unknown as ReturnType<typeof loggerModule.getLogger>);

    try {
      await expect(runDestroy(['Other', '--yes'])).rejects.toThrow('process.exit-mock');
    } finally {
      getLoggerSpy.mockRestore();
    }

    const traces = debugSpy.mock.calls
      .filter((c) => c[0] === 'Stack trace:')
      .map((c) => String(c[1]));
    expect(traces.join('\n')).toContain('at readerFrame (assembly-reader.ts:1:1)');
    // Under the NEW header, which names the escape hatch.
    expect(traces.join('\n')).toContain('cdkd state destroy');
  });

  it('names another app\'s stack in state when it is the only name given', async () => {
    // Synthesis succeeded and nothing matched; the stack IS in state, just
    // not this app's, so "No matching stacks found in state" alone was false.
    warnSpy.mockClear();
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Other')],
    });
    mockListStacks.mockResolvedValue([
      { stackName: 'Other', region: 'us-east-1' },
      { stackName: 'OtherAppStack', region: 'us-east-1' },
    ]);

    await runDestroy(['OtherAppStack', '--yes']);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.map((c) => String(c[0] ?? ''))).toContainEqual(
      expect.stringContaining('OtherAppStack is in state but is not a stack of this app and was skipped.')
    );
  });

  // go-to-k/cdkd#4474: `--all` destroys the app's top-level stacks only, as
  // the AWS CDK CLI's `destroy --all` does. The Stage stacks it now leaves
  // running are named, so the narrower run is never silent.
  it('destroys --all for the top-level stack only and names the Stage stack it left running', async () => {
    const prod = { ...makeStackInfo('Prod-Api'), displayName: 'Prod/Api', stagePath: 'Prod' };
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Other'), prod],
    });
    mockListStacks.mockResolvedValue([
      { stackName: 'Other', region: 'us-east-1' },
      { stackName: 'Prod-Api', region: 'us-east-1' },
    ]);

    await runDestroy(['--all', '--yes']);

    expect(mockRunDestroyForStack.mock.calls.map((c) => c[0])).toEqual(['Other']);
    // At warn level: a destroy that used to reach these stacks leaves them running.
    expect(warnText()).toContain(
      '--all selects top-level stacks only; 1 stack inside a CDK Stage was left out (Prod-Api (Prod/Api)).'
    );

    // `'**'` reaches it.
    mockRunDestroyForStack.mockClear();
    await runDestroy(['**', '--yes']);
    expect(mockRunDestroyForStack.mock.calls.map((c) => c[0]).sort()).toEqual(['Other', 'Prod-Api']);
  });

  // The CDK path decides first: a pattern naming one stack's construct id
  // must not also destroy a different stack whose physical name it equals.
  it("destroys only the stack whose path matches, not another whose physical name does", async () => {
    const byPath = { ...makeStackInfo('api-v2'), displayName: 'Api' };
    const byName = { ...makeStackInfo('Api'), displayName: 'Legacy' };
    mockSynthesize.mockResolvedValue({ manifest: {}, assemblyDir: '/tmp/cdk.out', stacks: [byPath, byName] });
    mockListStacks.mockResolvedValue([
      { stackName: 'api-v2', region: 'us-east-1' },
      { stackName: 'Api', region: 'us-east-1' },
    ]);

    await runDestroy(['Api', '--yes']);

    expect(mockRunDestroyForStack.mock.calls.map((c) => c[0])).toEqual(['api-v2']);
  });

  // Precedence is decided over the whole app, not only what is deployed: with
  // the id-matching stack undeployed, the stack whose physical name spells
  // the pattern is still not the one it names, so it is left alone.
  it('leaves a deployed stack alone when the pattern is an undeployed stack\'s id', async () => {
    const byPath = { ...makeStackInfo('api-v2'), displayName: 'Api' };
    const byName = { ...makeStackInfo('Api'), displayName: 'Legacy' };
    mockSynthesize.mockResolvedValue({ manifest: {}, assemblyDir: '/tmp/cdk.out', stacks: [byPath, byName] });
    mockListStacks.mockResolvedValue([{ stackName: 'Api', region: 'us-east-1' }]);
    warnSpy.mockClear();

    await runDestroy(['Api', '--yes']);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
    const warned = warnSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(warned).toContain('Api matched no stack in state and was skipped.');
    expect(warned).not.toContain('is in state but is not a stack of this app');
  });

  // A pattern without `/` used to be a glob over the PHYSICAL name, so
  // `cdkd destroy '*'` reached the Stage stacks too. Now it matches the CDK
  // path; a deployed stack it no longer selects is named at warn level.
  const NO_LONGER = 'now matches the CDK path, with * inside one segment, and no longer selects';
  const prodApi = () => ({ ...makeStackInfo('Prod-Api'), displayName: 'Prod/Api', stagePath: 'Prod' });

  it("names the deployed Stage stack `'*'` used to destroy and no longer does", async () => {
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Other'), prodApi()],
    });
    mockListStacks.mockResolvedValue([
      { stackName: 'Other', region: 'us-east-1' },
      { stackName: 'Prod-Api', region: 'us-east-1' },
    ]);
    warnSpy.mockClear();

    await runDestroy(['*', '--yes']);

    expect(mockRunDestroyForStack.mock.calls.map((c) => c[0])).toEqual(['Other']);
    expect(warnText()).toContain(
      `"*" ${NO_LONGER} 1 stack it used to ` +
        "(Prod-Api (Prod/Api)). Name them with 'Prod/*', or select every stack with '**'."
    );
  });

  it("points to the Stage stacks when `'*'` matches only undeployed stacks", async () => {
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Other'), prodApi()],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'Prod-Api', region: 'us-east-1' }]);
    warnSpy.mockClear();

    await runDestroy(['*', '--yes']);

    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
    expect(warnText()).toContain('"*" matched no stack in state and was skipped.');
    expect(warnText()).toContain(`"*" ${NO_LONGER}`);
    expect(warnText()).toContain("or select every stack with '**'.");
  });

  it('names the deployed stack a physical-name wildcard no longer reaches', async () => {
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Other'), prodApi()],
    });
    mockListStacks.mockResolvedValue([
      { stackName: 'Other', region: 'us-east-1' },
      { stackName: 'Prod-Api', region: 'us-east-1' },
    ]);
    warnSpy.mockClear();

    await runDestroy(['Prod-*', '--yes']);

    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
    expect(warnText()).toContain(`"Prod-*" ${NO_LONGER}`);
  });

  it("names the deeper Stage stack `'Prod/*'` used to destroy and no longer does", async () => {
    const deep = { ...makeStackInfo('ProdParentChild'), displayName: 'Prod/Parent/Child', stagePath: 'Prod' };
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [prodApi(), deep],
    });
    mockListStacks.mockResolvedValue([
      { stackName: 'Prod-Api', region: 'us-east-1' },
      { stackName: 'ProdParentChild', region: 'us-east-1' },
    ]);
    warnSpy.mockClear();

    await runDestroy(['Prod/*', '--yes']);

    expect(mockRunDestroyForStack.mock.calls.map((c) => c[0])).toEqual(['Prod-Api']);
    expect(warnText()).toContain(`"Prod/*" ${NO_LONGER} 1 stack it used to (ProdParentChild (Prod/Parent/Child)).`);
  });

  it('says nothing more when the pattern selects what the old rule did', async () => {
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Other'), prodApi()],
    });
    mockListStacks.mockResolvedValue([
      { stackName: 'Other', region: 'us-east-1' },
      { stackName: 'Prod-Api', region: 'us-east-1' },
    ]);
    warnSpy.mockClear();

    await runDestroy(['Prod-Api', '--yes']);
    await runDestroy(['**', '--yes']);

    expect(warnText()).not.toContain(NO_LONGER);
  });

  it('refuses --all over a stage-only app', async () => {
    const prod = { ...makeStackInfo('Prod-Api'), displayName: 'Prod/Api', stagePath: 'Prod' };
    mockSynthesize.mockResolvedValue({ manifest: {}, assemblyDir: '/tmp/cdk.out', stacks: [prod] });
    mockListStacks.mockResolvedValue([{ stackName: 'Prod-Api', region: 'us-east-1' }]);

    await expect(runDestroy(['--all', '--yes'])).rejects.toThrow('process.exit-mock');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockListStacks).not.toHaveBeenCalled();
    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n')).toContain(
      '--all selects top-level stacks only, and this app has none'
    );
  });

  it('selects nothing, with the hint, when only the Stage stacks are deployed', async () => {
    const prod = { ...makeStackInfo('Prod-Api'), displayName: 'Prod/Api', stagePath: 'Prod' };
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Other'), prod],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'Prod-Api', region: 'us-east-1' }]);

    await runDestroy(['--all', '--yes']);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
    expect(warnText()).toContain('--all selects top-level stacks only; 1 stack inside a CDK Stage was left out');
  });

  it('still falls back to state for an exact name when synthesis fails for another reason (#3839)', async () => {
    mockSynthesize.mockRejectedValue(new Error('synth unavailable'));
    mockListStacks.mockResolvedValue([{ stackName: 'Other', region: 'us-east-1' }]);

    await runDestroy(['Other', '--yes']);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
    expect(mockRunDestroyForStack.mock.calls[0]?.[0]).toBe('Other');
  });

  it('control: --all and the single-stack auto-pick destroy when synthesis succeeds', async () => {
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Other')],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'Other', region: 'us-east-1' }]);

    await runDestroy(['--all', '--yes']);
    await runDestroy(['--yes']);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(2);
  });

  it('refuses --all or a wildcard over an app that synthesized no stacks', async () => {
    for (const [args, selector] of [
      [['--all'], '--all'],
      [['*'], '*'],
      [['--stack', 'Cdkd*'], 'Cdkd*'],
      // An exact name beside a wildcard does not rescue the command.
      [['MyStage-MyStack', 'Cdkd*', 'MyStage/*'], 'Cdkd*, MyStage/*'],
      // `?` is literal to matchStacks and no CFn name contains one; it is
      // refused anyway, fail-closed.
      [['MyStage-?yStack'], 'MyStage-?yStack'],
    ] as const) {
      errorSpy.mockClear();
      exitSpy.mockClear();
      mockListStacks.mockClear();
      mockSynthesize.mockResolvedValue({ manifest: {}, assemblyDir: '/tmp/cdk.out', stacks: [] });

      await expect(runDestroy([...args, '--yes']), selector).rejects.toThrow('process.exit-mock');

      expect(exitSpy, selector).toHaveBeenCalledWith(1);
      expect(mockListStacks, selector).not.toHaveBeenCalled();
      const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
      expect(messages, selector).toContain(
        `${selector} selects among the stacks this app synthesizes, and it synthesized none; ` +
          'refusing to fall back to every stack in state.'
      );
    }
  });

  it('still resolves an exact physical name through the state fallback when the app synthesized no stacks', async () => {
    mockSynthesize.mockResolvedValue({ manifest: {}, assemblyDir: '/tmp/cdk.out', stacks: [] });
    mockListStacks.mockResolvedValue([
      { stackName: 'MyStage-MyStack', region: 'us-east-1' },
      { stackName: 'CdkdOtherApp', region: 'us-east-1' },
    ]);

    await runDestroy(['MyStage-MyStack', '--yes']);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
    expect(mockRunDestroyForStack.mock.calls[0]?.[0]).toBe('MyStage-MyStack');
  });

  it('refuses a bare run over an app that synthesized no stacks, without advising --all', async () => {
    mockSynthesize.mockResolvedValue({ manifest: {}, assemblyDir: '/tmp/cdk.out', stacks: [] });
    mockListStacks.mockResolvedValue([{ stackName: 'MyStage-MyStack', region: 'us-east-1' }]);

    await expect(runDestroy(['--yes'])).rejects.toThrow('process.exit-mock');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(messages).toMatch(
      /Specify stack names explicitly, or ensure --app \/ cdk\.json is configured\.$/m
    );
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

  it('answers a name that matched nothing in state with the plain message', async () => {
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Other')],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'Other', region: 'us-east-1' }]);

    await runDestroy(['MyStage/MyStack', '--yes']);

    expect(infoSpy.mock.calls.map((c) => c[0])).toContain('No matching stacks found in state');
  });

  // The AWS CDK CLI's destroy warns per pattern that matched nothing; deploy
  // and the rest stay silent unless the whole union is empty.
  it('warns about a pattern that matched nothing in state beside one that matched', async () => {
    warnSpy.mockClear();
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Other')],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'Other', region: 'us-east-1' }]);

    await runDestroy(['Other', 'Typo', '--yes']);

    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls.map((c) => String(c[0] ?? ''))).toContain(
      'Typo matched no stack in state and was skipped.'
    );
  });

  // A name in state that is not one of this app's stacks, beside one that
  // matched: the by-name special case never runs (something matched), so
  // without a warning the name would be dropped silently and destroy exit 0.
  it('warns, distinctly, about a nested child named beside its parent', async () => {
    warnSpy.mockClear();
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('NestedStackExample')],
    });
    mockListStacks.mockResolvedValue([
      { stackName: 'NestedStackExample', region: 'us-east-1' },
      { stackName: 'NestedStackExample~Child', region: 'us-east-1' },
    ]);

    await runDestroy(['NestedStackExample', 'NestedStackExample~Child', '--yes']);

    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
    expect(mockRunDestroyForStack.mock.calls[0]?.[0]).toBe('NestedStackExample');
    const warned = warnSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(warned).toContain(
      'NestedStackExample~Child is in state but is not a stack of this app and was skipped.'
    );
    expect(warned).not.toContain('matched no stack');
  });

  it('warns, distinctly, about another app sharing the bucket named beside this one', async () => {
    warnSpy.mockClear();
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Other')],
    });
    mockListStacks.mockResolvedValue([
      { stackName: 'Other', region: 'us-east-1' },
      { stackName: 'OtherAppStack', region: 'us-east-1' },
    ]);

    await runDestroy(['Other', 'OtherAppStack', '--yes']);

    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
    expect(mockRunDestroyForStack.mock.calls[0]?.[0]).toBe('Other');
    expect(warnSpy.mock.calls.map((c) => String(c[0] ?? ''))).toContainEqual(
      expect.stringContaining('OtherAppStack is in state but is not a stack of this app and was skipped.')
    );
  });

  it('names a repeated unmatched pattern once', async () => {
    warnSpy.mockClear();
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Other')],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'Other', region: 'us-east-1' }]);

    await runDestroy(['Other', 'Typo', 'Typo', '--yes']);

    expect(warnSpy.mock.calls.map((c) => String(c[0] ?? ''))).toContain(
      'Typo matched no stack in state and was skipped.'
    );
  });

  it('does not warn when every pattern matched, and warns per pattern when none did', async () => {
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Other')],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'Other', region: 'us-east-1' }]);

    warnSpy.mockClear();
    await runDestroy(['Other', '--yes']);
    expect(warnSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n')).not.toContain(
      'matched no stack'
    );

    // CDK's destroy warns per unmatched pattern whether or not another
    // matched, then says nothing matched.
    warnSpy.mockClear();
    await runDestroy(['Typo', 'Nope', '--yes']);
    expect(infoText()).toContain('No matching stacks found in state');
    expect(warnSpy.mock.calls.map((c) => String(c[0] ?? ''))).toContain(
      'Typo, Nope matched no stack in state and were skipped.'
    );
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
      });

      await runDestroy([...args, '--force']);

      expect(exitSpy, label).not.toHaveBeenCalled();
      expect(mockRunDestroyForStack.mock.calls.map((c) => c[0]), label).toEqual(['CdkdThisApp']);
      cases++;
    }
    expect(cases).toBe(4);
  });
});
