/**
 * COMMAND level for issue
 * [go-to-k/cdkd#3456](https://github.com/go-to-k/cdkd/issues/3456): `cdkd diff`
 * re-reads a stale attribute map the way `cdkd deploy` does, so its preview of
 * a `Fn::GetAtt` over one matches what the deploy resolves — and writes
 * nothing.
 *
 * The case is the maintainer's live one from the issue thread (2026-09-24): an
 * `AWS::Lambda::Url` imported by `--migrate-from-cloudformation` with
 * `attributes: {}`, and an `AWS::SSM::Parameter` whose `Value` is
 * `Fn::GetAtt [Url, FunctionUrl]` and whose record holds that raw intrinsic.
 * `cdkd diff` printed `No changes detected` there while `cdkd deploy` healed
 * the Url record and UPDATED the parameter.
 *
 * The harness is `diff-deploy-refusal-exit.test.ts`'s (`createDiffCommand`
 * driven with `{ from: 'user' }`), with the provider registry and the AWS
 * scope mocked so the read is observable: which region it was bound to, what
 * it was asked, and that no state write followed.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
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
const currentScope = vi.hoisted(() => ({ region: undefined as string | undefined }));
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
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: mockSynthesize,
    expandMacrosForStacks: vi.fn(async () => undefined),
  })),
  synthesisStatusMessage: (_app: unknown, msg: string) => msg,
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveApp: vi.fn(() => 'node app.ts'),
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
  resolveUseCdkBootstrapAssets: vi.fn(() => false),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation((opts?: { region?: string; profile?: string }) => {
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
    (clients: { configuredRegion?: string }, fn: () => unknown): unknown => {
      const previous = currentScope.region;
      currentScope.region = clients.configuredRegion;
      try {
        return fn();
      } finally {
        currentScope.region = previous;
      }
    }
  ),
}));

vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    getState: vi.fn(async () =>
      stateForDiff.value ? { state: stateForDiff.value, etag: 'fake' } : null
    ),
    saveState,
    listStacks: vi.fn(async () => []),
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  // Records which registry was populated, and in which AWS scope: a provider
  // takes its clients at construction, which `registerAllProviders` does.
  registerAllProviders: vi.fn((registry: { builtIn?: string }) => {
    registrations.push({ builtIn: registry.builtIn, scope: currentScope.region });
  }),
}));

vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => {
    // The scope the registry was BUILT in: a provider takes its clients at
    // construction, so this is the region its reads would go to.
    const builtIn = currentScope.region;
    registryRegions.push(builtIn);
    return {
      builtIn,
      getProvider: vi.fn(),
      getProviderFor: vi.fn((routed: unknown) => ({
        provisionedBy: 'sdk',
        provider: {
          import: async (input: Record<string, unknown>) => {
            routingInputs.push(routed);
            importCalls.push({ ...input, registryRegion: builtIn, scopeRegion: currentScope.region });
            return importImpl.fn!(input);
          },
        },
      })),
    };
  }),
}));

import { createDiffCommand } from '../../../src/cli/commands/diff.js';

const URL = 'https://abc123.lambda-url.eu-west-1.on.aws/';
const FUNCTION_ARN = 'arn:aws:lambda:eu-west-1:123456789012:function:fn';

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

/** A FRESH record per case: the read-only repairs mutate records in place. */
function migratedRecord(): StackState {
  return {
    stackName: 'UrlStack',
    region: 'eu-west-1',
    version: 10,
    resources: {
      Url: {
        physicalId: FUNCTION_ARN,
        resourceType: 'AWS::Lambda::Url',
        properties: { TargetFunctionArn: FUNCTION_ARN, AuthType: 'NONE' },
        // What `--migrate-from-cloudformation` left before #3624: nothing.
        attributes: {},
        // A routing input the read must carry; explicit, so dropping it shows.
        provisionedBy: 'sdk',
        dependencies: [],
      },
      UrlParam: {
        physicalId: '/app/url',
        resourceType: 'AWS::SSM::Parameter',
        // The imported record holds the raw intrinsic, not a URL.
        properties: {
          Name: '/app/url',
          Type: 'String',
          Value: { 'Fn::GetAtt': ['Url', 'FunctionUrl'] },
        },
        attributes: { Type: 'String' },
        dependencies: ['Url'],
      },
    },
    outputs: {},
    lastModified: 0,
  };
}

interface ChangeJson {
  logicalId: string;
  changeType: string;
  propertyChanges?: Array<{ path: string; oldValue: unknown; newValue: unknown }>;
}

function changesOf(json: unknown): ChangeJson[] {
  const [tree] = json as Array<{ changes: ChangeJson[] }>;
  return tree.changes;
}

describe('cdkd diff heals a stale attribute map read-only (go-to-k/cdkd#3456)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    importCalls.length = 0;
    clientRegions.length = 0;
    scopeRegions.length = 0;
    registryRegions.length = 0;
    routingInputs.length = 0;
    clientDestroys.length = 0;
    clientProfiles.length = 0;
    registrations.length = 0;
    importImpl.fn = async (input) => ({
      physicalId: input['knownPhysicalId'],
      attributes: { FunctionUrl: URL, FunctionArn: FUNCTION_ARN },
    });
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'UrlStack',
          displayName: 'UrlStack',
          artifactId: 'UrlStack',
          // A region OTHER than the command's (`us-east-1` by default).
          region: 'eu-west-1',
          template: {
            Resources: {
              Url: {
                Type: 'AWS::Lambda::Url',
                Properties: { TargetFunctionArn: FUNCTION_ARN, AuthType: 'NONE' },
              },
              UrlParam: {
                Type: 'AWS::SSM::Parameter',
                Properties: {
                  Name: '/app/url',
                  Type: 'String',
                  Value: { 'Fn::GetAtt': ['Url', 'FunctionUrl'] },
                },
              },
            },
          },
          dependencyNames: [],
          assets: [],
        },
      ],
    });
    stateForDiff.value = migratedRecord();
  });

  it('previews the UPDATE the deploy makes, with the URL the re-read serves', async () => {
    const { code, json } = await runDiffJson(['UrlStack', '--state-bucket', 'b']);
    expect(code).toBeUndefined();
    const param = changesOf(json).find((c) => c.logicalId === 'UrlParam');
    // Before the fix: NO_CHANGE — the unresolved intrinsic equalled the record's.
    expect(param?.changeType).toBe('UPDATE');
    expect(param?.propertyChanges).toEqual([
      expect.objectContaining({
        path: 'Value',
        oldValue: { 'Fn::GetAtt': ['Url', 'FunctionUrl'] },
        newValue: URL,
      }),
    ]);
  }, 30_000);

  it('renders the same UPDATE in the human report', async () => {
    let code: number | undefined;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
      code = c;
      throw new Error('__process_exit__');
    }) as never);
    try {
      await createDiffCommand().parseAsync(['UrlStack', '--state-bucket', 'b'], { from: 'user' });
    } catch (err) {
      if (!(err instanceof Error) || err.message !== '__process_exit__') throw err;
    } finally {
      exitSpy.mockRestore();
    }
    expect(code).toBeUndefined();
    const said = mockLoggerInfo.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).not.toContain('No changes detected');
    expect(said).toContain('[~] UrlParam (AWS::SSM::Parameter)');
    expect(said).toContain(JSON.stringify(URL));
  }, 30_000);

  it('reads the record once, by its physical id, through clients bound to the STACK region', async () => {
    await runDiffJson(['UrlStack', '--state-bucket', 'b']);
    expect(importCalls).toHaveLength(1);
    expect(importCalls[0]).toMatchObject({
      logicalId: 'Url',
      resourceType: 'AWS::Lambda::Url',
      stackName: 'UrlStack',
      region: 'eu-west-1',
      knownPhysicalId: FUNCTION_ARN,
      // Both halves: the provider was BUILT under the stack region's clients
      // (a provider takes them at construction) and the read RAN in that scope.
      registryRegion: 'eu-west-1',
      scopeRegion: 'eu-west-1',
    });
    // Routed as `DeployEngine.readStaleAttributes` routes it: by the record's
    // own type and `provisionedBy`, the record as its own baseline (#3713).
    expect(routingInputs).toEqual([
      {
        resourceType: 'AWS::Lambda::Url',
        properties: { TargetFunctionArn: FUNCTION_ARN, AuthType: 'NONE' },
        provisionedBy: 'sdk',
        previousProperties: { TargetFunctionArn: FUNCTION_ARN, AuthType: 'NONE' },
      },
    ]);
    // Its providers were REGISTERED under the stack region's clients.
    expect(registrations).toContainEqual({ builtIn: 'eu-west-1', scope: 'eu-west-1' });
    // The stack-region clients the heal built are released with the command's.
    expect(clientDestroys).toContain('eu-west-1');
  }, 30_000);

  it("builds ONE client set and registry per stack region, with the command's profile", async () => {
    // Two stale records in one stack: two reads, one region scope.
    const record = migratedRecord();
    record.resources['Url2'] = {
      ...record.resources['Url']!,
      physicalId: `${FUNCTION_ARN}-2`,
      attributes: {},
    };
    // Recorded, so its row diffs as an UPDATE, the path that resolves.
    record.resources['UrlParam2'] = {
      ...record.resources['UrlParam']!,
      physicalId: '/app/url2',
      properties: { Name: '/app/url', Type: 'String', Value: { 'Fn::GetAtt': ['Url2', 'FunctionUrl'] } },
      dependencies: ['Url2'],
    };
    stateForDiff.value = record;
    const [stack] = (await mockSynthesize()).stacks;
    const template = structuredClone(stack.template);
    template.Resources.Url2 = structuredClone(template.Resources.Url);
    template.Resources.UrlParam2 = structuredClone(template.Resources.UrlParam);
    template.Resources.UrlParam2.Properties.Value = { 'Fn::GetAtt': ['Url2', 'FunctionUrl'] };
    mockSynthesize.mockResolvedValue({ stacks: [{ ...stack, template }] });
    clientRegions.length = 0;
    clientProfiles.length = 0;

    await runDiffJson(['UrlStack', '--state-bucket', 'b', '--profile', 'dev']);
    expect(importCalls.map((c) => c['logicalId']).sort()).toEqual(['Url', 'Url2']);
    expect(clientRegions.filter((r) => r === 'eu-west-1')).toHaveLength(1);
    expect(registryRegions.filter((r) => r === 'eu-west-1')).toHaveLength(1);
    expect(clientProfiles[clientRegions.indexOf('eu-west-1')]).toBe('dev');
  }, 30_000);

  it("runs the rollback-orphan adoption check in the STACK's region too", async () => {
    // The sibling provider read on this path: the same wrong-region hazard.
    const record = migratedRecord();
    record.orphans = [
      {
        logicalId: 'Bucket',
        orphanedAt: 1,
        state: {
          physicalId: 'orphan-bucket',
          resourceType: 'AWS::S3::Bucket',
          properties: { BucketName: 'orphan-bucket' },
          attributes: {},
          provisionedBy: 'sdk',
        },
      },
    ];
    stateForDiff.value = record;
    const [stack] = (await mockSynthesize()).stacks;
    const template = structuredClone(stack.template);
    template.Resources.Bucket = {
      Type: 'AWS::S3::Bucket',
      Properties: { BucketName: 'orphan-bucket' },
    };
    mockSynthesize.mockResolvedValue({ stacks: [{ ...stack, template }] });

    await runDiffJson(['UrlStack', '--state-bucket', 'b']);
    const adoptionRead = importCalls.find((c) => c['logicalId'] === 'Bucket');
    expect(adoptionRead).toMatchObject({
      knownPhysicalId: 'orphan-bucket',
      region: 'eu-west-1',
      registryRegion: 'eu-west-1',
      scopeRegion: 'eu-west-1',
    });
  }, 30_000);

  it('writes nothing: no state save, and the loaded record keeps its empty attributes', async () => {
    const loaded = migratedRecord();
    stateForDiff.value = loaded;
    await runDiffJson(['UrlStack', '--state-bucket', 'b']);
    expect(importCalls).toHaveLength(1);
    expect(saveState).not.toHaveBeenCalled();
    // `toEqual`, not `toStrictEqual`: the read-only repairs may rebuild bags.
    expect(loaded.resources['Url']?.attributes).toEqual({});
  }, 30_000);

  it('falls back to the pre-fix preview when the read fails, without failing the diff', async () => {
    importImpl.fn = async () => {
      throw Object.assign(new Error('User is not authorized'), { name: 'AccessDeniedException' });
    };
    const { code, json } = await runDiffJson(['UrlStack', '--state-bucket', 'b']);
    expect(code).toBeUndefined();
    expect(importCalls).toHaveLength(1);
    // `--json` lists only changed rows: the parameter is absent, as before the
    // fix. This is also the case's negative control — the same template and
    // record with no usable read previews no update.
    expect(changesOf(json).map((c) => c.logicalId)).not.toContain('UrlParam');
  }, 30_000);
});
