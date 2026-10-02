/**
 * `cdkd diff`'s half of issue go-to-k/cdkd#3482: a Stage that failed to load
 * dropped every stack under it, so selection answered "no stacks matching" —
 * a different problem than the one that occurred.
 *
 * `diff` was the one replaced call site with no wiring test. The renderer's
 * own tests say nothing about whether this command reaches it with the
 * synthesis result its own synthesis produced, and the argument being required
 * only fences the SHAPE — a stale or empty list typechecks. So this drives the
 * REAL commander command and reads the message the user would be shown.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockLoggerError = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLoggerError,
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

const mockSynthesize = vi.hoisted(() => vi.fn());
const mockExpandMacros = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: mockSynthesize,
    expandMacrosForStacks: mockExpandMacros,
  })),
  synthesisStatusMessage: (_app: unknown, msg: string) => msg,
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveApp: vi.fn(() => 'node app.ts'),
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
  resolveUseCdkBootstrapAssets: vi.fn(() => false),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({ s3: {}, destroy: vi.fn() })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(() => ({ destroy: vi.fn() })),
}));

vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    getState: vi.fn(async () => null),
    listStacks: vi.fn(async () => []),
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));

vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({ getProvider: vi.fn() })),
}));

import { createDiffCommand } from '../../../src/cli/commands/diff.js';

/** Drive the real command and return what the user was told. */
let lastExitCode: number | undefined;
async function runDiff(argv: string[]): Promise<string> {
  lastExitCode = undefined;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    lastExitCode = code;
    throw new Error('__process_exit__');
  }) as never);
  try {
    await createDiffCommand().parseAsync(argv, { from: 'user' });
  } catch (err) {
    if (!(err instanceof Error) || err.message !== '__process_exit__') throw err;
  } finally {
    exitSpy.mockRestore();
  }
  return mockLoggerError.mock.calls.map((c) => String(c[0])).join('\n');
}

function makeStack(stackName: string) {
  return {
    stackName,
    displayName: stackName,
    artifactId: stackName,
    template: { Resources: {} },
    dependencyNames: [],
    region: 'us-east-1',
  };
}

describe('cdkd diff names a Stage that failed to load (issue #3482)', () => {
  beforeEach(() => {
    mockSynthesize.mockReset();
    mockLoggerError.mockReset();
  });

  it('names the failed Stage when the pattern targets one', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [makeStack('TopStack')],
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      failedStages: [{ stagePath: 'MyStage', reason: 'ENOENT reading assembly-MyStage' }],
    });

    const reported = await runDiff(['MyStage/Api']);

    expect(reported).toContain('No stacks matching MyStage/Api found in assembly');
    expect(reported).toContain('Stage MyStage failed to load');
  });

  it('leaves the message untouched when every Stage loaded', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [makeStack('TopStack')],
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      failedStages: [],
    });

    const reported = await runDiff(['MyStage/Api']);

    expect(reported).toContain('No stacks matching MyStage/Api found in assembly');
    expect(reported).not.toContain('failed to load');
  });

  it('names the failed Stage with NO pattern, where the branch chain used to answer "Multiple stacks found: ."', async () => {
    // The headline case: an app whose only stacks live in an unsynthesized
    // Stage, run with no arguments. Zero stacks fell through to the
    // multiple-stacks arm, which printed an empty list and never reached the
    // renderer at all.
    mockSynthesize.mockResolvedValue({
      stacks: [],
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      failedStages: [{ stagePath: 'MyStage', reason: 'ENOENT reading assembly-MyStage' }],
    });

    const reported = await runDiff([]);

    expect(reported).not.toContain('Multiple stacks found');
    expect(reported).toContain('No stacks found in assembly');
    expect(reported).toContain('Stage MyStage failed to load');
  });
});

describe('cdkd diff --all refuses a partial app when a Stage failed to load (issue #3507)', () => {
  beforeEach(() => {
    mockSynthesize.mockReset();
    mockLoggerError.mockReset();
    mockExpandMacros.mockClear();
  });

  it('refuses --all with surviving stacks, naming the Stage and the survivors', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [makeStack('TopStack')],
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      failedStages: [{ stagePath: 'MyStage', reason: 'ENOENT reading assembly-MyStage' }],
    });

    const reported = await runDiff(['--all']);

    expect(reported).toContain('--all would diff only part of this app; refusing.');
    expect(reported).toContain('Synthesized: TopStack');
    expect(reported).toContain('Stage MyStage failed to load');
    // Refused, not merely logged: nothing was selected for diffing.
    expect(mockExpandMacros).not.toHaveBeenCalled();
  });

  it('still selects every stack with --all when every Stage loaded', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [makeStack('TopStack')],
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      failedStages: [],
    });

    const reported = await runDiff(['--all']);

    expect(reported).not.toContain('refusing');
    expect(mockExpandMacros).toHaveBeenCalledWith(
      [expect.objectContaining({ stackName: 'TopStack' })],
      expect.anything()
    );
  });

  // A bare `cdkd diff` auto-selected the one survivor as if the app held only
  // that stack.
  it('refuses the single-stack auto-pick when a Stage failed to load', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [makeStack('TopStack')],
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      failedStages: [{ stagePath: 'MyStage', reason: 'ENOENT reading assembly-MyStage' }],
    });

    const reported = await runDiff([]);

    expect(lastExitCode).toBe(1);
    expect(reported).toContain(
      'With no stack named, cdkd would diff only part of this app; refusing. ' +
        'Synthesized: TopStack. Stage MyStage failed to load'
    );
    expect(mockExpandMacros).not.toHaveBeenCalled();
  });

  it('still diffs a NAMED survivor beside a failed Stage', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [makeStack('TopStack')],
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      failedStages: [{ stagePath: 'MyStage', reason: 'ENOENT reading assembly-MyStage' }],
    });

    const reported = await runDiff(['TopStack']);

    expect(reported).not.toContain('refusing');
    expect(mockExpandMacros).toHaveBeenCalledWith(
      [expect.objectContaining({ stackName: 'TopStack' })],
      expect.anything()
    );
  });

  it('still auto-picks the single stack when every Stage loaded', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [makeStack('TopStack')],
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      failedStages: [],
    });

    const reported = await runDiff([]);

    expect(reported).not.toContain('refusing');
    expect(mockExpandMacros).toHaveBeenCalledWith(
      [expect.objectContaining({ stackName: 'TopStack' })],
      expect.anything()
    );
  });
});
