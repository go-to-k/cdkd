/**
 * COMMAND level for go-to-k/cdkd#7057: `cdkd diff` wires the deploy's zone
 * heal, so a zone-less DBInstance record whose instance runs in the declared
 * zone previews no change, through ONE `DescribeDBInstances` bound to the
 * STACK's region (not the command's). The harness is
 * `diff-stale-attribute-heal-3456.test.ts`'s, with `@aws-sdk/client-rds` faked.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const liveZone = vi.hoisted(() => ({ value: 'eu-west-1a' }));
const rdsSent = vi.hoisted(() => [] as Array<{ input: unknown; clientRegion: unknown; scopeRegion: unknown }>);
import type { StackState } from '../../../src/types/state.js';

const mockLoggerError = vi.hoisted(() => vi.fn());
const mockLoggerInfo = vi.hoisted(() => vi.fn());
const stateForDiff = vi.hoisted(() => ({ value: null as StackState | null }));
const saveState = vi.hoisted(() => vi.fn());
const importCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const importImpl = vi.hoisted(() => ({
  fn: null as null | ((input: Record<string, unknown>) => Promise<unknown>),
}));
// The region each `AwsClients` was built for, and the region the scope was
// entered with around each read.
const clientRegions = vi.hoisted(() => [] as Array<string | undefined>);
const scopeRegions = vi.hoisted(() => [] as string[]);
const registryRegions = vi.hoisted(() => [] as Array<string | undefined>);
// The AWS scope as `AsyncLocalStorage`, like the real `runWithStackAwsClients`
// (`src/utils/stack-aws-scope.ts`): a scope held in a plain variable would be
// gone after the first `await`, so a provider building its clients later, or a
// second read in the same scope, would read no region.
const currentScope = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const store = new AsyncLocalStorage<string | undefined>();
  return {
    store,
    get region(): string | undefined {
      return store.getStore();
    },
  };
});
const routingInputs = vi.hoisted(() => [] as unknown[]);
const clientDestroys = vi.hoisted(() => [] as Array<string | undefined>);
const clientProfiles = vi.hoisted(() => [] as Array<string | undefined>);
const registrations = vi.hoisted(
  () => [] as Array<{ builtIn: string | undefined; scope: string | undefined }>
);

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
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn(() => ({
    synthesize: mockSynthesize,
    expandMacrosForStacks: vi.fn(async () => undefined),
  })),
  synthesisStatusMessage: (_app: unknown, msg: string) => msg,
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  // No cdk.json "tags" (go-to-k/cdkd#6886).
  loadCdkJson: vi.fn(() => null),
  resolveApp: vi.fn(() => 'node app.ts'),
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
  resolveUpdatePolicy: vi.fn(() => undefined),
  resolveUseCdkBootstrapAssets: vi.fn(() => false),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn((opts?: { region?: string; profile?: string }) => {
    clientRegions.push(opts?.region);
    clientProfiles.push(opts?.profile);
    return {
      s3: {},
      configuredRegion: opts?.region,
      destroy: vi.fn(() => clientDestroys.push(opts?.region)),
    };
  }),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(() => ({ destroy: vi.fn() })),
  runWithStackAwsClients: vi.fn(
    (clients: { configuredRegion?: string }, fn: () => unknown): unknown =>
      currentScope.store.run(clients.configuredRegion, fn)
  ),
}));

vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn(() => ({
    destroyClient: vi.fn(),
    getState: vi.fn(async () =>
      stateForDiff.value ? { state: stateForDiff.value, etag: 'fake' } : null
    ),
    saveState,
    listStacks: vi.fn(async () => []),
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  // Records which registry was populated, and in which AWS scope: a provider
  // takes its clients at construction, which `registerAllProviders` does.
  registerAllProviders: vi.fn((registry: { builtIn?: string }) => {
    registrations.push({ builtIn: registry.builtIn, scope: currentScope.region });
  }),
}));

vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(() => {
    // The scope the registry was BUILT in: a provider takes its clients at
    // construction, so this is the region its reads would go to.
    const builtIn = currentScope.region;
    registryRegions.push(builtIn);
    return {
      builtIn,
      getProvider: vi.fn(),
      ccRouteUnavailableReason: vi.fn(),
      getProviderFor: vi.fn((routed: unknown) => ({
        provisionedBy: 'sdk',
        provider: {
          import: async (input: Record<string, unknown>) => {
            // Read the scope AFTER an await, as a provider's lazily built
            // client does: only a scope that survives the await answers.
            await Promise.resolve();
            routingInputs.push(routed);
            importCalls.push({ ...input, registryRegion: builtIn, scopeRegion: currentScope.region });
            return importImpl.fn!(input);
          },
        },
      })),
    };
  }),
}));


vi.mock('@aws-sdk/client-rds', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-rds')>();
  class FakeRDSClient {
    constructor(private readonly config: { region?: unknown }) {}
    async send(command: { input: { DBInstanceIdentifier: string } }): Promise<unknown> {
      await Promise.resolve();
      rdsSent.push({
        input: command.input,
        clientRegion: this.config.region,
        scopeRegion: currentScope.region,
      });
      return {
        DBInstances: [
          { DBInstanceIdentifier: command.input.DBInstanceIdentifier, AvailabilityZone: liveZone.value },
        ],
      };
    }
    destroy(): void {}
  }
  return { ...actual, RDSClient: FakeRDSClient };
});

import { createDiffCommand } from '../../../src/cli/commands/diff.js';

async function runDiffJson(argv: string[]): Promise<{ code: number | undefined; json: unknown }> {
  let code: number | undefined;
  let out = '';
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c;
    throw new Error('__process_exit__');
  }) as never);
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    out += String(chunk);
    return true;
  }) as never);
  try {
    await createDiffCommand().parseAsync([...argv, '--json'], { from: 'user' });
  } catch (err) {
    if (!(err instanceof Error) || err.message !== '__process_exit__') throw err;
  } finally {
    exitSpy.mockRestore();
    writeSpy.mockRestore();
  }
  return { code, json: out.trim() === '' ? undefined : JSON.parse(out) };
}

const BASE = { Engine: 'mysql', DBInstanceClass: 'db.t4g.micro' };

function record(zone?: string): StackState {
  return {
    stackName: 'DbStack',
    region: 'eu-west-1',
    version: 16,
    resources: {
      Db: {
        physicalId: 'db-legacy',
        resourceType: 'AWS::RDS::DBInstance',
        properties: zone === undefined ? { ...BASE } : { ...BASE, AvailabilityZone: zone },
        attributes: {},
        provisionedBy: 'sdk',
        dependencies: [],
      },
    },
    outputs: {},
    lastModified: 0,
  };
}

interface ChangeJson {
  logicalId: string;
  changeType: string;
}

const changesOf = (json: unknown): ChangeJson[] => (json as Array<{ changes: ChangeJson[] }>)[0]!.changes;

describe('the cdkd diff command runs the zone heal (go-to-k/cdkd#7057)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rdsSent.length = 0;
    liveZone.value = 'eu-west-1a';
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'DbStack',
          displayName: 'DbStack',
          artifactId: 'DbStack',
          // A region OTHER than the command's (`us-east-1` by default).
          region: 'eu-west-1',
          template: {
            Resources: {
              Db: {
                Type: 'AWS::RDS::DBInstance',
                Properties: { ...BASE, AvailabilityZone: 'eu-west-1a' },
              },
            },
          },
          dependencyNames: [],
          assets: [],
        },
      ],
    });
  });

  it('a zone-less record whose instance runs in the declared zone: no change, one read in the stack region, nothing saved', async () => {
    stateForDiff.value = record();
    const { code, json } = await runDiffJson(['DbStack', '--state-bucket', 'b']);
    expect(code).toBeUndefined();
    // A NO_CHANGE row is left out of the JSON.
    expect(changesOf(json).find((c) => c.logicalId === 'Db')).toBeUndefined();
    expect(rdsSent).toEqual([
      {
        input: { DBInstanceIdentifier: 'db-legacy' },
        clientRegion: 'eu-west-1',
        scopeRegion: 'eu-west-1',
      },
    ]);
    expect(saveState).not.toHaveBeenCalled();
  }, 30_000);

  it('a record holding the zone: no read (#6438)', async () => {
    stateForDiff.value = record('eu-west-1a');
    const { json } = await runDiffJson(['DbStack', '--state-bucket', 'b']);
    // A NO_CHANGE row is left out of the JSON.
    expect(changesOf(json).find((c) => c.logicalId === 'Db')).toBeUndefined();
    expect(rdsSent).toEqual([]);
  }, 30_000);

  it('CONTROL: the instance runs in another zone: the row shows (a replacement)', async () => {
    stateForDiff.value = record();
    liveZone.value = 'eu-west-1b';
    const { json } = await runDiffJson(['DbStack', '--state-bucket', 'b']);
    expect(changesOf(json).find((c) => c.logicalId === 'Db')?.changeType).toBe('UPDATE');
    expect(rdsSent).toHaveLength(1);
  }, 30_000);
});
