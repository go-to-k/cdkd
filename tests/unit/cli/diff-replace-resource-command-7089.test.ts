/**
 * go-to-k/cdkd#7089: the `cdkd diff --replace-resource` command wiring. Drives
 * the REAL commander command: the run-level checks `cdkd deploy` makes refuse
 * an id no selected stack declares, and a top-level stack's own targets reach
 * its diff, which then counts the replacement as destructive.
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
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn(() => ({
    synthesize: mockSynthesize,
    expandMacrosForStacks: vi.fn(async () => undefined),
  })),
  synthesisStatusMessage: (_app: unknown, msg: string) => msg,
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  loadCdkJson: vi.fn(() => null),
  resolveApp: vi.fn(() => 'node app.ts'),
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
  resolveUpdatePolicy: vi.fn(() => undefined),
  resolveUseCdkBootstrapAssets: vi.fn(() => false),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(() => ({ s3: {}, destroy: vi.fn() })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(() => ({ destroy: vi.fn() })),
}));

vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));

const STACK = 'TopStack';
const OLD_ID = 'stack-Fn-OLD';
const PERMISSION_PROPS = {
  Action: 'lambda:InvokeFunction',
  FunctionName: OLD_ID,
  Principal: 'sns.amazonaws.com',
};
const record = (
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  dependencies: string[]
) => ({
  physicalId,
  resourceType,
  properties,
  observedProperties: properties,
  attributes: {},
  dependencies,
  provisionedBy: 'sdk',
});
const state = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn(() => ({
    destroyClient: vi.fn(),
    getState: vi.fn(async (name: string) =>
      name === 'TopStack' && state.current !== null ? { state: state.current, etag: 'e' } : null
    ),
    listStacks: vi.fn(async () => []),
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));

vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(() => ({
    getProvider: vi.fn(),
    getProviderFor: vi.fn(() => ({ provider: {}, provisionedBy: 'sdk' })),
    ccRouteUnavailableReason: vi.fn(() => undefined),
  })),
}));

import { createDiffCommand } from '../../../src/cli/commands/diff.js';

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

describe('cdkd diff --replace-resource command wiring (go-to-k/cdkd#7089)', () => {
  beforeEach(() => {
    mockLoggerError.mockReset();
    state.current = {
      version: 16,
      region: 'us-east-1',
      stackName: STACK,
      resources: {
        Fn: record(OLD_ID, 'AWS::Lambda::Function', { Runtime: 'nodejs22.x', MemorySize: 128 }, []),
        Perm: record('stack-Perm-OLD', 'AWS::Lambda::Permission', PERMISSION_PROPS, ['Fn']),
      },
      outputs: {},
      lastModified: 0,
    };
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: STACK,
          displayName: STACK,
          artifactId: STACK,
          template: {
            Resources: {
              Fn: {
                Type: 'AWS::Lambda::Function',
                Properties: { Runtime: 'nodejs22.x', MemorySize: 256 },
              },
              Perm: {
                Type: 'AWS::Lambda::Permission',
                Properties: { ...PERMISSION_PROPS, FunctionName: { Ref: 'Fn' } },
              },
            },
          },
          dependencyNames: [],
          region: 'us-east-1',
        },
      ],
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
    });
  });

  it('refuses an id no selected stack declares, as cdkd deploy does', async () => {
    const reported = await runDiff(['--replace-resource', 'Nope']);
    expect(lastExitCode).toBe(1);
    expect(reported).toContain('--replace-resource must name exactly one resource of this deploy');
    expect(reported).toContain('Nope: no stack of this deploy declares it');
  });

  it("hands the stack's target to its diff, which replaces it and its create-only reader", async () => {
    const reported = await runDiff(['--replace-resource', 'Fn', '--fail-on', 'destructive']);
    expect(lastExitCode).toBe(1);
    expect(reported).toContain('Found 2 destructive change(s)');
  });

  it('control: without the flag nothing is destructive', async () => {
    const reported = await runDiff(['--fail-on', 'destructive']);
    expect(lastExitCode).toBeUndefined();
    expect(reported).toBe('');
  });
});
