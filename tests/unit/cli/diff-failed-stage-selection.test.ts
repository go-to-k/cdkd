/**
 * `cdkd diff` and a CDK Stage that failed to load (issue go-to-k/cdkd#3507):
 * synthesis fails, as in the AWS CDK CLI, so no selection diffs the stacks
 * that did load. Drives the REAL commander command and reads the message the
 * user would be shown.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockLoggerError = vi.hoisted(() => vi.fn());
const mockLoggerInfo = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: mockLoggerInfo,
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
import { stageLoadError } from '../../../src/synthesis/failed-stages.js';

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

describe('cdkd diff fails on a Stage that failed to load (issue #3507)', () => {
  beforeEach(() => {
    mockSynthesize.mockReset();
    mockLoggerError.mockReset();
    mockExpandMacros.mockClear();
  });

  it('fails with the synthesis error for every selection, before anything is diffed', async () => {
    // Each selection spelled as its own literal call, so the commander-parse
    // convention fence can count its operands.
    const expectFatal = (reported: string, label: string): void => {
      expect(lastExitCode, label).toBe(1);
      expect(reported, label).toContain(
        'Stage MyStage failed to load: ENOENT reading assembly-MyStage/manifest.json'
      );
      expect(mockExpandMacros, label).not.toHaveBeenCalled();
      mockLoggerError.mockReset();
    };
    mockSynthesize.mockRejectedValue(
      stageLoadError('MyStage', 'ENOENT reading assembly-MyStage/manifest.json')
    );

    expectFatal(await runDiff(['--all']), '--all');
    expectFatal(await runDiff([]), 'bare');
    expectFatal(await runDiff(['Top*']), 'wildcard');
    expectFatal(await runDiff(['TopStack']), 'exact');
  });

  it('reports a pattern that matched nothing with the stacks the app has', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [makeStack('TopStack')],
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
    });

    const reported = await runDiff(['MyStage/Api']);

    expect(lastExitCode).toBe(1);
    expect(reported).toContain(
      'No stacks matching MyStage/Api found in assembly. Available: TopStack'
    );
  });

  it('control: --all and the single-stack auto-pick diff when synthesis succeeds', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [makeStack('TopStack')],
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
    });

    await runDiff(['--all']);
    await runDiff([]);

    expect(mockExpandMacros).toHaveBeenCalledTimes(2);
    expect(mockExpandMacros).toHaveBeenCalledWith(
      [expect.objectContaining({ stackName: 'TopStack' })],
      expect.anything()
    );
  });
});

// go-to-k/cdkd#4474: `--all` diffs the app's top-level stacks only, as the
// AWS CDK CLI selects for a bare `cdk diff`, and names what it left out.
describe('cdkd diff --all selects top-level stacks only (issue #4474)', () => {
  beforeEach(() => {
    mockSynthesize.mockReset();
    mockLoggerError.mockReset();
    mockLoggerInfo.mockReset();
    mockExpandMacros.mockClear();
  });

  const stageStack = { ...makeStack('Prod-Api'), displayName: 'Prod/Api', stagePath: 'Prod' };

  it('diffs the top-level stack and names the Stage stack it left out', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [makeStack('TopStack'), stageStack],
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
    });

    await runDiff(['--all']);

    expect(mockExpandMacros).toHaveBeenCalledWith(
      [expect.objectContaining({ stackName: 'TopStack' })],
      expect.anything()
    );
    expect(mockLoggerInfo.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      '--all selects top-level stacks only; 1 stack inside a CDK Stage was left out'
    );
  });

  it('refuses --all over a stage-only app', async () => {
    mockSynthesize.mockResolvedValue({ stacks: [stageStack], manifest: {}, assemblyDir: '/tmp/cdk.out' });

    const reported = await runDiff(['--all']);

    expect(lastExitCode).toBe(1);
    expect(reported).toContain('--all selects top-level stacks only, and this app has none');
    expect(mockExpandMacros).not.toHaveBeenCalled();
  });
});
