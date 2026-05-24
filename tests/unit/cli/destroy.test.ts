import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

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
    acquireLock: vi.fn(),
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

// Mock the synthesizer so we can return arbitrary StackInfo[] (including
// with terminationProtection set on individual stacks).
const mockSynthesize = vi.hoisted(() => vi.fn());
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: mockSynthesize,
  })),
}));

import { createDestroyCommand } from '../../../src/cli/commands/destroy.js';

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
    mockRunDestroyForStack.mockResolvedValue({
      stackName: '',
      cancelled: false,
      skippedEmpty: false,
      deletedCount: 1,
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

  it('refuses to destroy a single protected stack and exits with code 2', async () => {
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Protected', 'us-east-1', true)],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'Protected', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({ state: makeStackState('Protected'), etag: '"x"' });

    await expect(runDestroy(['destroy', 'Protected', '--yes'])).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(2);

    // Per-stack guard fires BEFORE the runner is invoked.
    expect(mockRunDestroyForStack).not.toHaveBeenCalled();

    // The error message names the stack and the bypass workflow.
    const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(messages).toMatch(/Protected/);
    expect(messages).toMatch(/terminationProtection: false/);
    expect(messages).toMatch(/redeploy/);
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

    await runDestroy(['destroy', '--all', '--yes']);

    // Both stacks flow through the runner — guard does not fire.
    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(2);
    const dispatched = new Set(
      mockRunDestroyForStack.mock.calls.map((c) => c[0] as string)
    );
    expect(dispatched).toEqual(new Set(['Plain', 'Unguarded']));
    // No partial-failure exit on the happy path.
    expect(exitSpy).not.toHaveBeenCalled();
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

    await runDestroy(['destroy', 'Protected', '--yes', '--remove-protection']);

    // The runner runs (bypass) and the runner gets removeProtection=true.
    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
    expect(mockRunDestroyForStack.mock.calls[0]?.[2].removeProtection).toBe(true);

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

    await expect(runDestroy(['destroy', '--all', '--yes'])).rejects.toThrow();

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
    mockRunDestroyForStack.mockReset();
    mockRunDestroyForStack.mockResolvedValue({
      stackName: '',
      cancelled: false,
      skippedEmpty: false,
      deletedCount: 1,
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
      runDestroy(['destroy', 'NestedStackExample~Child', '--yes'])
    ).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(2);

    // Guard fires BEFORE runDestroyForStack — no per-resource deletes attempted.
    expect(mockRunDestroyForStack).not.toHaveBeenCalled();

    const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(messages).toMatch(/NestedStackExample~Child/);
    expect(messages).toMatch(/nested child of 'NestedStackExample'/);
    // Error suggests both bypass paths: parent destroy AND state destroy escape hatch.
    expect(messages).toMatch(/cdkd destroy NestedStackExample/);
    expect(messages).toMatch(/cdkd state destroy NestedStackExample~Child/);
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

    await runDestroy(['destroy', 'Plain', '--yes']);

    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
    expect(mockRunDestroyForStack.mock.calls[0]?.[0]).toBe('Plain');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('--all with a parent + a nested child surfaced from state: parent destroys, child counts as failure (exit 2)', async () => {
    // Synth fails so the fallback path includes the nested child in
    // candidateStacks. The parent has no parentStack and proceeds; the
    // child is refused.
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

    await expect(runDestroy(['destroy', '--all', '--yes'])).rejects.toThrow();

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

    await runDestroy(['destroy', '--all', '--yes']);

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
      runDestroy(['destroy', 'NestedStackExample~Child', '--yes'])
    ).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(2);

    // Refusal surfaced, no per-resource delete attempted.
    expect(mockRunDestroyForStack).not.toHaveBeenCalled();

    const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(messages).toMatch(/nested child of 'NestedStackExample'/);
    expect(messages).toMatch(/cdkd destroy NestedStackExample/);
    expect(messages).toMatch(/cdkd state destroy NestedStackExample~Child/);
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
    await runDestroy(['destroy', 'Nope~*', '--yes']);

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
      runDestroy(['destroy', 'NestedStackExample~Child', '--yes'])
    ).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(2);

    const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(messages).toMatch(/nested child of 'NestedStackExample'/);
    expect(messages).not.toMatch(/parent's logical id/);
    expect(messages).not.toMatch(/undefined/);
  });
});
