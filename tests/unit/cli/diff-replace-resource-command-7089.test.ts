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
    warn: warned,
    error: mockLoggerError,
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: warned, error: vi.fn() }),
  }),
}));

const mockSynthesize = vi.hoisted(() => vi.fn());
const mockExpandMacros = vi.hoisted(() => vi.fn(async (_stacks: unknown[]) => undefined));
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn(() => ({
    synthesize: mockSynthesize,
    expandMacrosForStacks: mockExpandMacros,
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
const warned = vi.hoisted(() => vi.fn());

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

function topTemplate() {
  return {
    Resources: {
      Fn: { Type: 'AWS::Lambda::Function', Properties: { Runtime: 'nodejs22.x', MemorySize: 256 } },
      Perm: {
        Type: 'AWS::Lambda::Permission',
        Properties: { ...PERMISSION_PROPS, FunctionName: { Ref: 'Fn' } },
      },
    },
  };
}

function appStack(stackName: string, template: unknown, dependencyNames: string[] = []) {
  return { stackName, displayName: stackName, artifactId: stackName, template, dependencyNames, region: 'us-east-1' };
}

describe('cdkd diff --replace-resource command wiring (go-to-k/cdkd#7089)', () => {
  beforeEach(() => {
    mockLoggerError.mockReset();
    warned.mockReset();
    mockExpandMacros.mockReset();
    mockExpandMacros.mockImplementation(async () => undefined);
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

  const synthesized = (...stacks: unknown[]) =>
    mockSynthesize.mockResolvedValue({ stacks, manifest: {}, assemblyDir: '/tmp/cdk.out' });

  it('hands each stack only the targets its template declares', async () => {
    synthesized(appStack(STACK, topTemplate()), appStack('Other', { Resources: { Q: { Type: 'AWS::SQS::Queue' } } }));
    const reported = await runDiff(['--all', '--replace-resource', 'Fn', '--fail-on', 'destructive']);
    expect(reported).toContain('Found 2 destructive change(s)');
    expect(warned.mock.calls.map((c) => String(c[0])).filter((w) => w.includes('--replace-resource'))).toEqual([]);
  });

  it('refuses an id the selected stack and its dependency both declare, as the deploy does', async () => {
    synthesized(appStack(STACK, topTemplate(), ['Dep']), appStack('Dep', topTemplate()));
    const reported = await runDiff([STACK, '--replace-resource', 'Fn']);
    expect(lastExitCode).toBe(1);
    expect(reported).toContain('Fn: declared by TopStack, Dep');
  });

  it('names an id only a dependency declares, which the deploy replaces there', async () => {
    synthesized(
      appStack(STACK, { Resources: { Q: { Type: 'AWS::SQS::Queue' } } }, ['Dep']),
      appStack('Dep', topTemplate())
    );
    const reported = await runDiff([STACK, '--replace-resource', 'Fn']);
    expect(reported).toBe('');
    expect(warned.mock.calls.map((c) => String(c[0]))).toContain(
      '--replace-resource Fn: declared by Dep, a dependency stack the deploy includes unless -e is passed; diff that stack to preview its replacement.'
    );
    // The dependency's template is expanded, as the deploy expands it.
    expect(mockExpandMacros.mock.calls.flatMap((c) => (c[0] as Array<{ stackName: string }>).map((s) => s.stackName))).toContain('Dep');
  });

  it("walks a dependency's dependencies too, as the deploy does", async () => {
    const queue = { Resources: { Q: { Type: 'AWS::SQS::Queue' } } };
    synthesized(
      appStack(STACK, structuredClone(queue), ['Mid']),
      appStack('Mid', structuredClone(queue), ['Leaf']),
      appStack('Leaf', topTemplate())
    );
    await runDiff([STACK, '--replace-resource', 'Fn']);
    expect(warned.mock.calls.map((c) => String(c[0]))).toContain(
      '--replace-resource Fn: declared by Leaf, a dependency stack the deploy includes unless -e is passed; diff that stack to preview its replacement.'
    );
  });

  it('checks the macro-expanded template', async () => {
    synthesized(appStack(STACK, { Resources: {} }));
    mockExpandMacros.mockImplementation(async (stacks: unknown[]) => {
      for (const stack of stacks as Array<{ template: { Resources: Record<string, unknown> } }>) {
        Object.assign(stack.template.Resources, topTemplate().Resources);
      }
    });
    const reported = await runDiff(['--replace-resource', 'Fn', '--fail-on', 'destructive']);
    expect(reported).not.toContain('no stack of this deploy declares it');
    expect(reported).toContain('Found 2 destructive change(s)');
  });

  it('exits 3 for a target the deploy refuses at its plan', async () => {
    const unchanged = topTemplate();
    unchanged.Resources.Fn.Properties.MemorySize = 128;
    synthesized(appStack(STACK, unchanged));
    const reported = await runDiff(['--replace-resource', 'Fn']);
    expect(lastExitCode).toBe(3);
    // The reason itself is the unit file's (`blocking`); here, the exit.
    expect(reported).toContain('cdkd deploy would refuse to start: 1 blocking condition(s)');
  });

  it('control: without the flag nothing is destructive', async () => {
    const reported = await runDiff(['--fail-on', 'destructive']);
    expect(lastExitCode).toBeUndefined();
    expect(reported).toBe('');
  });
});
