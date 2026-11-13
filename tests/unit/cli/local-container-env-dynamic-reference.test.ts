import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LocalStateProvider, LocalStateRecord } from 'cdk-local';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

/**
 * Issue [#2056](https://github.com/go-to-k/cdkd/issues/2056): cdkd's OWN
 * container-env builders for `local invoke-agentcore` (`buildContainerEnv`)
 * and `local start-api` (`buildContainerSpec`) resolve CloudFormation dynamic
 * references (`{{resolve:...}}`) before the container starts, mirroring
 * cdk-local's builders of the same names (go-to-k/cdk-local#784). cdkd does
 * not call those, so the cdk-local bump alone does not reach these commands.
 *
 * cdk-local's resolver runs for real, with its AWS clients injected through
 * the client-factory seam so each case reads which region a lookup used.
 */

const PLAINTEXT = 'plain-2056-env-91c2';
const SAME_STACK_REF = '{{resolve:secretsmanager:same-stack-secret:SecretString:password::}}';
const PRODUCER_REF = '{{resolve:secretsmanager:producer-secret:SecretString:password::}}';

const h = vi.hoisted(() => ({
  smSend: vi.fn(),
  ssmSend: vi.fn(),
  destroy: vi.fn(),
  profiles: [] as Array<string | undefined>,
  workloads: [] as unknown[],
}));

// Only the caller-identity helper is doubled: a site that bypassed it would
// build real SDK clients and trip the AWS fence.
// cdk-local's state-source hint (go-to-k/cdkd#6150) is gated once per PROCESS;
// answer every ask here, so each case reads its own call site.
vi.mock('cdk-local/internal', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  takeAwsEmulatorStateSourceHint: () => 'AWS-EMULATOR-STATE-SOURCE-HINT',
}));

vi.mock('../../../src/local/dynamic-reference.js', async () =>
  (await import('../_caller-resolver-double.js')).callerResolverModule(h)
);

vi.mock('../../../src/local/ecr-puller.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  pullEcrImage: vi.fn(async (uri: string) => uri),
}));

const stateSource = vi.hoisted(() => ({ createLocalStateProvider: vi.fn() }));
vi.mock('../../../src/cli/commands/local-state-source.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createLocalStateProvider: stateSource.createLocalStateProvider,
}));

import { buildContainerEnv } from '../../../src/cli/commands/local-invoke-agentcore.js';
import {
  buildContainerSpec,
  dynamicReferenceSpecOptions,
  loadStateForRoutedStacks,
} from '../../../src/cli/commands/local-start-api.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'cdkd-2056-env-'));
  h.smSend.mockReset();
  h.smSend.mockResolvedValue({ SecretString: JSON.stringify({ password: PLAINTEXT }) });
  h.profiles.length = 0;
  h.workloads.length = 0;
  h.destroy.mockReset();
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});


/** Run `fn` under a full `--aws-emulator` wiring, returning the warn lines it logged. */
async function underEmulator(fn: () => Promise<unknown>): Promise<string[]> {
  const { setActiveWorkloadAwsWiring } = await import('cdk-local/internal');
  const { getLogger } = await import('../../../src/utils/logger.js');
  setActiveWorkloadAwsWiring({
    mode: 'emulator',
    env: {},
    scrubEnvKeys: [],
    mounts: [],
    loopbackPorts: [],
    probeHealth: false,
    dispose: () => {},
  } as never);
  const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
  try {
    await fn();
    return warn.mock.calls.map((c) => String(c[0]));
  } finally {
    warn.mockRestore();
    setActiveWorkloadAwsWiring(undefined);
  }
}

const HINT = 'AWS-EMULATOR-STATE-SOURCE-HINT';

// ---------------------------------------------------------------------------
// local invoke-agentcore — buildContainerEnv
// ---------------------------------------------------------------------------

function agentCoreRuntime(env: Record<string, unknown>) {
  return {
    logicalId: 'Runtime',
    environmentVariables: env,
    resource: { Type: 'AWS::BedrockAgentCore::Runtime', Properties: {} },
    stack: { stackName: 'AgentStack', region: 'us-east-1' },
  } as unknown as Parameters<typeof buildContainerEnv>[0];
}

function agentCoreState(storedOutput: string) {
  const resolveImport = vi.fn().mockResolvedValue(storedOutput);
  const resolveGetStackOutput = vi.fn().mockResolvedValue(storedOutput);
  const provider = {
    label: '--from-state',
    buildCrossStackResolver: vi.fn().mockResolvedValue({ resolveImport, resolveGetStackOutput }),
  } as unknown as LocalStateProvider;
  const loaded = { region: 'eu-west-1', resources: {}, outputs: {} } as unknown as LocalStateRecord;
  return { provider, loaded, resolveImport, resolveGetStackOutput };
}

describe('local invoke-agentcore buildContainerEnv: container region (go-to-k/cdkd#6200)', () => {
  it('an env-agnostic runtime under a loaded state record runs in the record region', async () => {
    const s = agentCoreState('unused');
    const runtime = agentCoreRuntime({});
    (runtime as unknown as { stack: { region?: string } }).stack.region = undefined;
    const out = await buildContainerEnv(
      runtime,
      {} as never,
      undefined,
      undefined,
      s.provider,
      s.loaded,
      undefined
    );
    expect(out.env['AWS_REGION']).toBe('eu-west-1');
  });

  it("the runtime stack's own region reaches the container", async () => {
    const out = await buildContainerEnv(
      agentCoreRuntime({}),
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    );
    expect(out.env['AWS_REGION']).toBe('us-east-1');
  });
});

describe('local invoke-agentcore buildContainerEnv resolves dynamic references (#2056)', () => {
  it('--aws-emulator with no state source: ONE hint after the dropped-variable warnings (go-to-k/cdkd#6150)', async () => {
    const lines = await underEmulator(() =>
      buildContainerEnv(
        agentCoreRuntime({ TABLE: { Ref: 'Table' }, QUEUE: { Ref: 'Queue' } }),
        {} as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined
      )
    );
    const hints = lines.filter((l) => l.startsWith(HINT));
    expect(hints).toHaveLength(1);
    expect(lines.indexOf(hints[0]!)).toBe(lines.length - 1);
    expect(lines.filter((l) => l.includes('was dropped. Override it with --env-vars'))).toHaveLength(2);
  });

  it('same stack: resolved, marked sensitive, in the synth region without state', async () => {
    const out = await buildContainerEnv(
      agentCoreRuntime({ DB_PASSWORD: SAME_STACK_REF, GREETING: 'hi' }),
      { profile: 'dev' } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    );
    expect(out.env['DB_PASSWORD']).toBe(PLAINTEXT);
    expect(out.env['GREETING']).toBe('hi');
    expect([...out.sensitiveEnvKeys]).toEqual(['DB_PASSWORD']);
    expect(h.smSend.mock.calls.map((c) => c[0])).toEqual(['us-east-1']);
    expect(h.profiles).toEqual(['dev']);
  });

  it('mixed mode: the lookup is routed for THIS runtime, by its aws:cdk:path too (go-to-k/cdkd#6150)', async () => {
    const runtime = agentCoreRuntime({ DB_PASSWORD: SAME_STACK_REF });
    (runtime.resource as { Metadata?: unknown }).Metadata = {
      'aws:cdk:path': 'AgentStack/Runtime/Resource',
    };
    await buildContainerEnv(runtime, {} as never, undefined, undefined, undefined, undefined, undefined);
    expect(h.workloads).toEqual([{ logicalId: 'Runtime', cdkPath: 'AgentStack/Runtime/Resource' }]);
  });

  it('cross stack: a redacted producer output resolves against the PRODUCER region', async () => {
    const s = agentCoreState(PRODUCER_REF);
    const out = await buildContainerEnv(
      agentCoreRuntime({
        FROM_OUTPUT: {
          'Fn::GetStackOutput': {
            StackName: 'Producer',
            OutputName: 'Secret',
            Region: 'ap-northeast-1',
          },
        },
      }),
      {} as never,
      undefined,
      undefined,
      s.provider,
      s.loaded,
      undefined
    );
    expect(out.env['FROM_OUTPUT']).toBe(PLAINTEXT);
    expect([...out.sensitiveEnvKeys]).toEqual(['FROM_OUTPUT']);
    expect(h.smSend.mock.calls.map((c) => c[0])).toEqual(['ap-northeast-1']);
  });

  it('a value resolved at the cross-stack boundary is never re-scanned', async () => {
    const s = agentCoreState(PRODUCER_REF);
    const tokenShaped = `${PLAINTEXT}-${SAME_STACK_REF}`;
    h.smSend.mockResolvedValue({ SecretString: JSON.stringify({ password: tokenShaped }) });
    const out = await buildContainerEnv(
      agentCoreRuntime({ IMPORTED: { 'Fn::ImportValue': 'ProducerSecret' } }),
      {} as never,
      undefined,
      undefined,
      s.provider,
      s.loaded,
      undefined
    );
    expect(out.env['IMPORTED']).toBe(tokenShaped);
    expect(h.smSend).toHaveBeenCalledTimes(1);
    expect([...out.sensitiveEnvKeys]).toEqual(['IMPORTED']);
  });

  it('the resolver is disposed after success', async () => {
    await buildContainerEnv(
      agentCoreRuntime({ DB_PASSWORD: SAME_STACK_REF }),
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    );
    expect(h.destroy).toHaveBeenCalledWith('secretsmanager', 'us-east-1');
  });

  it('no state record: --stack-region beats the synth region', async () => {
    await buildContainerEnv(
      agentCoreRuntime({ DB_PASSWORD: SAME_STACK_REF }),
      { stackRegion: 'sa-east-1' } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    );
    expect(h.smSend.mock.calls.map((c) => c[0])).toEqual(['sa-east-1']);
  });

  it('same stack under a loaded state record: the record region', async () => {
    const s = agentCoreState('unused');
    await buildContainerEnv(
      agentCoreRuntime({ DB_PASSWORD: SAME_STACK_REF }),
      { stackRegion: 'sa-east-1' } as never,
      undefined,
      undefined,
      s.provider,
      s.loaded,
      undefined
    );
    expect(h.smSend.mock.calls.map((c) => c[0])).toEqual(['eu-west-1']);
  });

  it('an --env-vars override skips the cross-stack lookup', async () => {
    const s = agentCoreState(PRODUCER_REF);
    const envFile = join(workDir, 'env.json');
    writeFileSync(envFile, JSON.stringify({ Parameters: { IMPORTED: 'local-literal' } }));
    const out = await buildContainerEnv(
      agentCoreRuntime({ IMPORTED: { 'Fn::ImportValue': 'ProducerSecret' } }),
      { envVars: envFile } as never,
      undefined,
      undefined,
      s.provider,
      s.loaded,
      undefined
    );
    expect(out.env['IMPORTED']).toBe('local-literal');
    expect(s.resolveImport).not.toHaveBeenCalled();
    expect(h.smSend).not.toHaveBeenCalled();
    expect(out.sensitiveEnvKeys.size).toBe(0);
  });

  it('a failed lookup throws, naming the reference and the consumer', async () => {
    h.smSend.mockRejectedValue(
      Object.assign(new Error('not authorized'), {
        name: 'AccessDeniedException',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      })
    );
    await expect(
      buildContainerEnv(
        agentCoreRuntime({ DB_PASSWORD: SAME_STACK_REF }),
        {} as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined
      )
    ).rejects.toThrow(/same-stack-secret[\s\S]*AgentCore Runtime Runtime env var DB_PASSWORD/);
    expect(h.destroy).toHaveBeenCalledWith('secretsmanager', 'us-east-1');
  });
});

// ---------------------------------------------------------------------------
// local start-api — buildContainerSpec
// ---------------------------------------------------------------------------

function apiStack(env: Record<string, unknown>): StackInfo {
  return {
    stackName: 'ApiStack',
    displayName: 'ApiStack',
    artifactId: 'ApiStack',
    template: {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            Code: { ZipFile: 'exports.handler = async () => ({});' },
            Environment: { Variables: env },
          },
        },
      },
    },
    dependencyNames: [],
    region: 'us-east-1',
  } as unknown as StackInfo;
}

async function spec(
  env: Record<string, unknown>,
  over: Partial<Parameters<typeof buildContainerSpec>[0]> = {}
) {
  return buildContainerSpec({
    logicalId: 'Fn',
    stacks: [apiStack(env)],
    overrides: undefined,
    assumeRole: undefined,
    containerHost: '127.0.0.1',
    stsRegion: undefined,
    inlineTmpDirs: new Set([workDir]),
    layerTmpDirs: new Set(),
    stateByStack: new Map(),
    skipPull: true,
    ...over,
  });
}

describe('local start-api buildContainerSpec resolves dynamic references (#2056)', () => {
  it('mixed mode: the lookup is routed for THIS function (go-to-k/cdkd#6150)', async () => {
    const stack = apiStack({ DB_PASSWORD: SAME_STACK_REF });
    (stack.template.Resources!['Fn'] as { Metadata?: unknown }).Metadata = {
      'aws:cdk:path': 'ApiStack/Fn/Resource',
    };
    await spec({ DB_PASSWORD: SAME_STACK_REF }, { stacks: [stack] });
    expect(h.workloads).toEqual([{ logicalId: 'Fn', cdkPath: 'ApiStack/Fn/Resource' }]);
  });

  it('--aws-emulator with no state source: ONE hint after the dropped-variable warnings, and none with a state source (go-to-k/cdkd#6150)', async () => {
    const env = { TABLE: { Ref: 'Table' }, QUEUE: { Ref: 'Queue' } };
    const lines = await underEmulator(() => spec(env));
    const hints = lines.filter((l) => l.startsWith(HINT));
    expect(hints).toHaveLength(1);
    expect(lines.indexOf(hints[0]!)).toBe(lines.length - 1);
    expect(lines.filter((l) => l.includes('contains a CloudFormation intrinsic and was dropped'))).toHaveLength(2);
    const withState = await underEmulator(() => spec(env, { stateSourceActive: true }));
    expect(withState.filter((l) => l === 'AWS-EMULATOR-STATE-SOURCE-HINT')).toEqual([]);
  });

  it('resolves a same-stack token at boot and marks it sensitive on the spec', async () => {
    const s = await spec({ DB_PASSWORD: SAME_STACK_REF, GREETING: 'hi' }, { profile: 'dev' });
    expect(s.env['DB_PASSWORD']).toBe(PLAINTEXT);
    expect(s.env['GREETING']).toBe('hi');
    expect([...(s.sensitiveEnvKeys ?? [])]).toEqual(['DB_PASSWORD']);
    expect(h.smSend.mock.calls.map((c) => c[0])).toEqual(['us-east-1']);
    expect(h.profiles).toEqual(['dev']);
  });

  it('the resolver is disposed after success and after a failed lookup', async () => {
    await spec({ DB_PASSWORD: SAME_STACK_REF });
    expect(h.destroy).toHaveBeenCalledTimes(1);
    h.smSend.mockRejectedValue(
      Object.assign(new Error('not authorized'), {
        name: 'AccessDeniedException',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      })
    );
    await expect(spec({ DB_PASSWORD: SAME_STACK_REF })).rejects.toThrow(/same-stack-secret/);
    expect(h.destroy).toHaveBeenCalledTimes(2);
  });

  it('the server boot forwards --profile and --stack-region to every spec', () => {
    expect(dynamicReferenceSpecOptions({ profile: 'dev', stackRegion: 'sa-east-1' })).toEqual({
      profile: 'dev',
      stackRegionOverride: 'sa-east-1',
    });
    expect(dynamicReferenceSpecOptions({})).toEqual({});
  });

  it('control: no token, no lookup, no sensitive set', async () => {
    const s = await spec({ GREETING: 'hi' });
    expect(s.sensitiveEnvKeys).toBeUndefined();
    expect(h.smSend).not.toHaveBeenCalled();
  });

  it('region: the loaded state record, then --stack-region, then the synth region', async () => {
    await spec(
      { DB_PASSWORD: SAME_STACK_REF },
      {
        stateByStack: new Map([
          ['ApiStack', { state: { resources: {} } as never, region: 'eu-west-1' }],
        ]),
        stackRegionOverride: 'sa-east-1',
      }
    );
    await spec({ DB_PASSWORD: SAME_STACK_REF }, { stackRegionOverride: 'sa-east-1' });
    expect(h.smSend.mock.calls.map((c) => c[0])).toEqual(['eu-west-1', 'sa-east-1']);
  });

  it('an --env-vars override is the developer literal, never resolved', async () => {
    const s = await spec(
      { DB_PASSWORD: SAME_STACK_REF },
      { overrides: { Parameters: { DB_PASSWORD: PRODUCER_REF } } }
    );
    expect(s.env['DB_PASSWORD']).toBe(PRODUCER_REF);
    expect(h.smSend).not.toHaveBeenCalled();
  });
});

describe('local start-api: the IMAGE branch and the state bundle (#2056)', () => {
  it('an image Lambda spec carries the resolved key as sensitive too', async () => {
    const stack = apiStack({});
    stack.template.Resources!['Fn'] = {
      Type: 'AWS::Lambda::Function',
      Properties: {
        PackageType: 'Image',
        Code: { ImageUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/repo:tag' },
        Environment: { Variables: { DB_PASSWORD: SAME_STACK_REF } },
      },
    };
    const s = await spec({}, { stacks: [stack] });
    expect(s.kind).toBe('image');
    expect(s.env['DB_PASSWORD']).toBe(PLAINTEXT);
    expect([...(s.sensitiveEnvKeys ?? [])]).toEqual(['DB_PASSWORD']);
  });

  it('the loaded state bundle records the record region the lookup uses first', async () => {
    stateSource.createLocalStateProvider.mockReturnValue({
      label: '--from-state',
      load: vi.fn().mockResolvedValue({ region: 'eu-west-1', resources: {}, outputs: {} }),
      dispose: vi.fn(),
    });
    const stack = apiStack({ GREETING: 'hi' });
    const bundles = await loadStateForRoutedStacks(
      [stack],
      [{ lambdaLogicalId: 'Fn' } as never],
      [],
      { fromState: true } as never
    );
    expect(bundles.get('ApiStack')?.region).toBe('eu-west-1');
  });
});

describe('local start-api buildContainerSpec: the container region (go-to-k/cdkd#6132 live run)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    restoreProcessEnv(saved);
  });

  it('hands the container stsRegion (--region first) when the host sets no AWS_REGION', async () => {
    delete process.env['AWS_REGION'];
    delete process.env['AWS_DEFAULT_REGION'];
    const s = await spec({ GREETING: 'hi' }, { stsRegion: 'ap-northeast-1' });
    expect(s.env['AWS_REGION']).toBe('ap-northeast-1');
  });

  it('stsRegion (--region first) wins over the host region in BOTH variables (host us-east-1, --region us-west-2)', async () => {
    process.env['AWS_REGION'] = 'us-east-1';
    process.env['AWS_DEFAULT_REGION'] = 'us-east-1';
    const s = await spec({ GREETING: 'hi' }, { stsRegion: 'us-west-2' });
    expect(s.env['AWS_REGION']).toBe('us-west-2');
    expect(s.env['AWS_DEFAULT_REGION']).toBe('us-west-2');
  });

  it("falls back to the stack's own region when nothing names one", async () => {
    delete process.env['AWS_REGION'];
    delete process.env['AWS_DEFAULT_REGION'];
    const s = await spec({ GREETING: 'hi' });
    expect(s.env['AWS_REGION']).toBe('us-east-1');
  });
});

/** Restore the environment IN PLACE: replacing `process.env` unlinks it from the real one. */
function restoreProcessEnv(snapshot: Record<string, string | undefined>): void {
  for (const k of Object.keys(process.env)) if (!(k in snapshot)) delete process.env[k];
  for (const [k, v] of Object.entries(snapshot)) if (v !== undefined) process.env[k] = v;
}
