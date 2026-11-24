import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LocalStateProvider, LocalStateRecord } from 'cdk-local';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { ResolvedZipLambda } from '../../../src/local/lambda-resolver.js';
import type { JudgedValue, ProducerSecretVerdict } from '../../../src/local/cross-stack-secrets.js';

/**
 * go-to-k/cdkd#6341: `cdkd local invoke` and `cdkd local invoke-agentcore`
 * build their `--from-state` env through the cross-stack resolver
 * `buildCrossStackResolver` returns, whose judged variants say when a value
 * holds a PRODUCER stack's secret (go-to-k/cdkd#6337). Such a key, and one
 * whose producer cdkd could not check (`unreadable` / `stale`), still resolves
 * into the container, but travels value-less (`-e KEY`): its value reaches
 * docker through the spawn env, never the `docker run` argv.
 *
 * Each case reads the FULL argv `runDetached` spawned (`node:child_process`'s
 * `execFile` is the only double on that path), and the spawn env beside it.
 */

const SECRET = 'producer-secret-6341-9f3a7c';
const SECOND_SECRET = 'producer-secret-6341-b21e04';
const PLAIN = 'plain-export-6341';

const mocks = vi.hoisted(() => ({
  /** Every `execFile`: (cmd, args, opts). */
  execFile: vi.fn(),
  synthesize: vi.fn(),
  resolveApp: vi.fn(),
  resolveLambdaTarget: vi.fn(),
  createLocalStateProvider: vi.fn(),
  smSend: vi.fn(),
  ssmSend: vi.fn(),
  destroy: vi.fn(),
  profiles: [] as Array<string | undefined>,
  workloads: [] as unknown[],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (...all: unknown[]) => {
      const cb = all[all.length - 1] as (err: unknown, out?: { stdout: string }) => void;
      mocks.execFile(all[0], all[1], all.length === 4 ? all[2] : undefined);
      cb(null, { stdout: 'container-6341\n' });
    },
  };
});

vi.mock('cdk-local/internal', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  takeAwsEmulatorStateSourceHint: () => 'AWS-EMULATOR-STATE-SOURCE-HINT',
}));

vi.mock('../../../src/local/dynamic-reference.js', async () =>
  (await import('../_caller-resolver-double.js')).callerResolverModule(mocks)
);

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn(() => ({
    send: async () => ({ Account: '111111111111' }),
    destroy: () => undefined,
  })),
  GetCallerIdentityCommand: vi.fn((input: unknown) => ({ input })),
}));

vi.mock('../../../src/cli/commands/local-state-source.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createLocalStateProvider: mocks.createLocalStateProvider,
}));

vi.mock('../../../src/synthesis/synthesizer.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Synthesizer: vi.fn(() => ({ synthesize: mocks.synthesize })),
}));

vi.mock('../../../src/cli/config-loader.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveApp: (cliApp?: string) => mocks.resolveApp(cliApp),
}));

vi.mock('../../../src/local/lambda-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveLambdaTarget: mocks.resolveLambdaTarget,
}));

// `runDetached` stays REAL: it builds the argv under test.
vi.mock('../../../src/local/docker-runner.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ensureDockerAvailable: vi.fn(async () => undefined),
  pullImage: vi.fn(async () => undefined),
  followContainerLogs: vi.fn(() => ({ stop: () => undefined, drain: async () => true })),
  killAndDrainContainerLogs: vi.fn(async () => undefined),
  removeContainer: vi.fn(async () => undefined),
}));

vi.mock('../../../src/local/docker-version.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveHostGatewayExtraHosts: vi.fn(async () => []),
}));

vi.mock('../../../src/local/rie-client.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  waitForRieReady: vi.fn(async () => undefined),
  invokeRie: vi.fn(async () => ({ payload: { ok: true }, raw: '{"ok":true}' })),
}));

import { createLocalCommand } from '../../../src/cli/commands/local-invoke.js';
import { bootAgentCoreContainer } from '../../../src/cli/commands/local-invoke-agentcore/container.js';
import { resolveFromS3BucketIntrinsic } from '../../../src/cli/commands/local-invoke-agentcore.js';
import { getLogger, releaseStdoutForPayload } from '../../../src/utils/logger.js';
import { substituteEnvVarsJudgedAsync } from '../../../src/local/cross-stack-watch.js';

/** An export as the cdkd-built resolver serves it: a value and its producer's verdict. */
type Export = { value: string; verdict?: ProducerSecretVerdict };

const EXPORTS: Record<string, Export> = {
  SecretExport: { value: SECRET, verdict: 'secret' },
  SecondSecretExport: { value: SECOND_SECRET, verdict: 'secret' },
  PlainExport: { value: PLAIN },
  UnreadableExport: { value: SECRET, verdict: 'unreadable' },
  StaleExport: { value: SECRET, verdict: 'stale' },
};

/** A cdkd-built resolver: cdk-local's contract plus the judged variants. */
function judgedResolver(): Record<string, unknown> {
  const judged = (name: string): JudgedValue => {
    const e = EXPORTS[name];
    return e === undefined ? { value: undefined } : { ...e };
  };
  return {
    resolveImport: async (name: string) => judged(name).value,
    resolveGetStackOutput: async (_s: string, _r: string, output: string) => judged(output).value,
    resolveImportJudged: async (name: string) => judged(name),
    resolveGetStackOutputJudged: async (_s: string, _r: string, output: string) => judged(output),
  };
}

function stateProvider(resolver: Record<string, unknown> = judgedResolver()) {
  return {
    label: '--from-state',
    load: vi.fn().mockResolvedValue({ region: 'eu-west-1', resources: {}, outputs: {} }),
    buildCrossStackResolver: vi.fn().mockResolvedValue(resolver),
    dispose: vi.fn(),
  };
}

const importOf = (name: string) => ({ 'Fn::ImportValue': name });
const joinOf = (...names: string[]) => ({ 'Fn::Join': ['-', names.map(importOf)] });

/** The `docker run` call: its full argv and the env it was spawned with. */
function dockerRun(): { argv: string[]; spawnEnv: Record<string, string | undefined> } {
  const runs = mocks.execFile.mock.calls.filter((c) => (c[1] as string[])[0] === 'run');
  expect(runs).toHaveLength(1);
  const [, argv, opts] = runs[0]!;
  return {
    argv: argv as string[],
    spawnEnv: ((opts as { env?: Record<string, string> } | undefined)?.env ?? {}) as Record<
      string,
      string | undefined
    >,
  };
}

/** The `-e` operands of `argv`. */
function envFlags(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length - 1; i += 1) if (argv[i] === '-e') out.push(argv[i + 1]!);
  return out;
}

/** The plaintext secrets are nowhere on the argv, in any element. */
function expectNoSecretOnArgv(argv: string[]): void {
  for (const el of argv) {
    expect(el).not.toContain(SECRET);
    expect(el).not.toContain(SECOND_SECRET);
  }
}

let workDir: string;
let templateEnv: Record<string, unknown>;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'cdkd-6341-'));
  writeFileSync(join(workDir, 'index.js'), 'exports.handler = async () => ({});\n');
  for (const m of Object.values(mocks)) if (typeof m === 'function') m.mockReset();
  mocks.profiles.length = 0;
  mocks.workloads.length = 0;
  templateEnv = {};
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  releaseStdoutForPayload();
});

// ---------------------------------------------------------------------------
// cdkd local invoke
// ---------------------------------------------------------------------------

function makeStack(): StackInfo {
  return {
    artifactId: 'ConsumerStack',
    stackName: 'ConsumerStack',
    displayName: 'ConsumerStack',
    template: { Resources: {} },
    dependencyNames: [],
    region: 'us-east-1',
    account: '111111111111',
  } as unknown as StackInfo;
}

function makeZipLambda(): ResolvedZipLambda {
  return {
    kind: 'zip',
    stack: makeStack(),
    logicalId: 'Consumer',
    resource: {
      Type: 'AWS::Lambda::Function',
      Properties: { Environment: { Variables: templateEnv } },
    },
    memoryMb: 128,
    timeoutSec: 3,
    layers: [],
    runtime: 'nodejs20.x',
    handler: 'index.handler',
    codePath: workDir,
    architecture: 'x86_64',
  } as unknown as ResolvedZipLambda;
}

/** Every line any console or stream channel received during the last {@link invoke}. */
let invokeOutput: string[] = [];

async function invoke(provider = stateProvider()): Promise<void> {
  const lines: string[] = [];
  invokeOutput = lines;
  mocks.resolveApp.mockReturnValue('node app.js');
  mocks.synthesize.mockResolvedValue({ stacks: [makeStack()], assemblyDir: 'cdk.out' });
  mocks.resolveLambdaTarget.mockImplementation(() => makeZipLambda());
  mocks.createLocalStateProvider.mockReturnValue(provider);
  const quiet = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(' '));
    })
  );
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const sink = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = sink;
  process.stderr.write = sink;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  try {
    const local = createLocalCommand();
    local.exitOverride();
    for (const sub of local.commands) sub.exitOverride();
    await local.parseAsync(['invoke', 'ConsumerStack/Consumer', '--no-pull', '--from-state'], {
      from: 'user',
    });
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    exitSpy.mockRestore();
    for (const spy of quiet) spy.mockRestore();
  }
}

describe('local invoke --from-state: a producer secret stays off the docker argv (go-to-k/cdkd#6341)', () => {
  it('a secret import travels value-less; a non-secret import stays inline', async () => {
    templateEnv = { API_KEY: importOf('SecretExport'), TABLE: importOf('PlainExport') };
    await invoke();
    const { argv, spawnEnv } = dockerRun();
    expectNoSecretOnArgv(argv);
    const flags = envFlags(argv);
    expect(flags).toContain('API_KEY');
    expect(flags).toContain(`TABLE=${PLAIN}`);
    // The container still gets the value, through the spawn env.
    expect(spawnEnv['API_KEY']).toBe(SECRET);
  });

  it('a Fn::GetStackOutput read of a producer secret travels value-less', async () => {
    templateEnv = {
      API_KEY: {
        'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'SecretExport', Region: 'eu-west-1' },
      },
    };
    await invoke();
    const { argv, spawnEnv } = dockerRun();
    expectNoSecretOnArgv(argv);
    expect(envFlags(argv)).toContain('API_KEY');
    expect(spawnEnv['API_KEY']).toBe(SECRET);
  });

  it.each(['UnreadableExport', 'StaleExport'])(
    'a value cdkd could not check (%s) fails closed: value-less',
    async (name) => {
      templateEnv = { VALUE: importOf(name) };
      await invoke();
      const { argv, spawnEnv } = dockerRun();
      expectNoSecretOnArgv(argv);
      expect(envFlags(argv)).toContain('VALUE');
      expect(spawnEnv['VALUE']).toBe(SECRET);
    }
  );

  it.each([
    ['secret first', ['SecretExport', 'PlainExport']],
    ['secret last', ['PlainExport', 'SecretExport']],
  ])('a Join of a secret and a non-secret import keeps the secret verdict (%s)', async (_l, names) => {
    templateEnv = { JOINED: joinOf(...names) };
    await invoke();
    const { argv, spawnEnv } = dockerRun();
    expectNoSecretOnArgv(argv);
    expect(envFlags(argv)).toContain('JOINED');
    expect(spawnEnv['JOINED']).toBe(names.map((n) => EXPORTS[n]!.value).join('-'));
  });

  it("one key's verdict never marks another key", async () => {
    templateEnv = { API_KEY: importOf('SecretExport'), PLAIN_JOIN: joinOf('PlainExport', 'PlainExport') };
    await invoke();
    const flags = envFlags(dockerRun().argv);
    expect(flags).toContain('API_KEY');
    expect(flags).toContain(`PLAIN_JOIN=${PLAIN}-${PLAIN}`);
  });

  it('control: a resolver without the judged variants is not judged here', async () => {
    templateEnv = { API_KEY: importOf('SecretExport') };
    const { resolveImport, resolveGetStackOutput } = judgedResolver();
    await invoke(stateProvider({ resolveImport, resolveGetStackOutput }));
    expect(envFlags(dockerRun().argv)).toContain(`API_KEY=${SECRET}`);
  });
});

// ---------------------------------------------------------------------------
// cdkd local invoke-agentcore
// ---------------------------------------------------------------------------

function agentRuntime(): Parameters<typeof bootAgentCoreContainer>[0]['resolved'] {
  return {
    logicalId: 'Runtime',
    environmentVariables: templateEnv,
    resource: { Type: 'AWS::BedrockAgentCore::Runtime', Properties: {} },
    stack: { stackName: 'AgentStack', region: 'us-east-1' },
    containerUri: 'cdkd-test-agent-6341:latest',
  } as unknown as Parameters<typeof bootAgentCoreContainer>[0]['resolved'];
}

async function bootAgent(resolver: Record<string, unknown> = judgedResolver()): Promise<void> {
  const provider = stateProvider(resolver) as unknown as LocalStateProvider;
  const loaded = { region: 'eu-west-1', resources: {}, outputs: {} } as unknown as LocalStateRecord;
  await bootAgentCoreContainer({
    resolved: agentRuntime(),
    options: { pull: false } as never,
    assemblyDir: workDir,
    profileCredentials: undefined,
    profileCredsFile: undefined,
    stateProvider: provider,
    loadedState: loaded,
    imageContext: undefined,
    isMcp: false,
    isA2a: false,
  });
}

describe('local invoke-agentcore --from-state: a producer secret stays off the docker argv (go-to-k/cdkd#6341)', () => {
  it('a secret import travels value-less; a non-secret import stays inline', async () => {
    templateEnv = { API_KEY: importOf('SecretExport'), TABLE: importOf('PlainExport') };
    await bootAgent();
    const { argv, spawnEnv } = dockerRun();
    expectNoSecretOnArgv(argv);
    const flags = envFlags(argv);
    expect(flags).toContain('API_KEY');
    expect(flags).toContain(`TABLE=${PLAIN}`);
    expect(spawnEnv['API_KEY']).toBe(SECRET);
  });

  it.each(['UnreadableExport', 'StaleExport'])(
    'a value cdkd could not check (%s) fails closed: value-less',
    async (name) => {
      templateEnv = { VALUE: importOf(name) };
      await bootAgent();
      const { argv, spawnEnv } = dockerRun();
      expectNoSecretOnArgv(argv);
      expect(envFlags(argv)).toContain('VALUE');
      expect(spawnEnv['VALUE']).toBe(SECRET);
    }
  );

  it.each([
    ['secret first', ['SecretExport', 'PlainExport']],
    ['secret last', ['PlainExport', 'SecretExport']],
    ['two secrets', ['SecretExport', 'SecondSecretExport']],
  ])('a Join of two imports keeps the secret verdict (%s)', async (_l, names) => {
    templateEnv = { JOINED: joinOf(...names) };
    await bootAgent();
    const { argv, spawnEnv } = dockerRun();
    expectNoSecretOnArgv(argv);
    expect(envFlags(argv)).toContain('JOINED');
    expect(spawnEnv['JOINED']).toBe(names.map((n) => EXPORTS[n]!.value).join('-'));
  });

  it('control: a resolver without the judged variants is not judged here', async () => {
    templateEnv = { API_KEY: importOf('SecretExport') };
    const { resolveImport, resolveGetStackOutput } = judgedResolver();
    await bootAgent({ resolveImport, resolveGetStackOutput });
    expect(envFlags(dockerRun().argv)).toContain(`API_KEY=${SECRET}`);
  });
});

// ---------------------------------------------------------------------------
// finch on macOS / Windows: the value-less flag does not keep it off an argv
// ---------------------------------------------------------------------------

describe('under finch on macOS, a producer secret is refused before docker run (go-to-k/cdkd#6341)', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let savedDocker: string | undefined;

  beforeEach(() => {
    savedDocker = process.env['CDK_DOCKER'];
    process.env['CDK_DOCKER'] = 'finch';
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor);
    if (savedDocker === undefined) delete process.env['CDK_DOCKER'];
    else process.env['CDK_DOCKER'] = savedDocker;
  });

  const runs = () => mocks.execFile.mock.calls.filter((c) => (c[1] as string[])[0] === 'run');

  it.each(['SecretExport', 'UnreadableExport'])('local invoke: %s', async (name) => {
    templateEnv = { VALUE: importOf(name) };
    await expect(invoke()).rejects.toThrow(/process\.exit\(1\)/);
    expect(runs()).toHaveLength(0);
    expect(invokeOutput.join('\n')).toMatch(
      /refusing to forward secret\(s\) VALUE under CDK_DOCKER=finch/
    );
  });

  it('local invoke control: a non-secret import still runs', async () => {
    templateEnv = { TABLE: importOf('PlainExport') };
    await invoke();
    expect(envFlags(dockerRun().argv)).toContain(`TABLE=${PLAIN}`);
  });

  it.each(['SecretExport', 'UnreadableExport'])('local invoke-agentcore: %s', async (name) => {
    templateEnv = { VALUE: importOf(name) };
    await expect(bootAgent()).rejects.toThrow(/refusing to forward secret\(s\) VALUE under CDK_DOCKER=finch/);
    expect(runs()).toHaveLength(0);
  });

  it('local invoke-agentcore control: a non-secret import still runs', async () => {
    templateEnv = { TABLE: importOf('PlainExport') };
    await bootAgent();
    expect(envFlags(dockerRun().argv)).toContain(`TABLE=${PLAIN}`);
  });
});

// ---------------------------------------------------------------------------
// invoke-agentcore fromS3 Code.S3.Bucket: resolved, never logged when judged
// ---------------------------------------------------------------------------

describe('invoke-agentcore fromS3 bucket intrinsic: a judged value is not logged (go-to-k/cdkd#6341)', () => {
  async function resolveBucket(
    name: string
  ): Promise<{ bucket: unknown; judged: unknown; info: string }> {
    const resolved = {
      logicalId: 'Runtime',
      stack: { stackName: 'AgentStack', region: 'us-east-1' },
      codeArtifact: { s3Source: { bucketIntrinsic: importOf(name) } },
    };
    const info = vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
    try {
      await resolveFromS3BucketIntrinsic(
        resolved as never,
        stateProvider() as never,
        { region: 'eu-west-1', outputs: {}, resources: {} } as never,
        undefined
      );
      return {
        bucket: (resolved.codeArtifact.s3Source as { bucket?: unknown }).bucket,
        judged: (resolved.codeArtifact.s3Source as { bucketJudged?: unknown }).bucketJudged,
        info: info.mock.calls.map((c) => String(c[0])).join('\n'),
      };
    } finally {
      info.mockRestore();
    }
  }

  it.each(['SecretExport', 'UnreadableExport'])('%s: resolved for the download, absent from the log', async (name) => {
    const r = await resolveBucket(name);
    expect(r.bucket).toBe(SECRET);
    // Marked for the download, whose own log line cdkd does not yet control.
    expect(r.judged).toBe(true);
    expect(r.info).toContain('Resolved fromS3 Code.S3.Bucket from state');
    expect(r.info).not.toContain(SECRET);
  });

  it('control: a non-secret export is logged as resolved', async () => {
    const r = await resolveBucket('PlainExport');
    expect(r.bucket).toBe(PLAIN);
    expect(r.judged).toBeUndefined();
    expect(r.info).toContain(`resolved to ${PLAIN}`);
  });
});

// ---------------------------------------------------------------------------
// substituteEnvVarsJudgedAsync: only a RESOLVED key is marked
// ---------------------------------------------------------------------------

describe('substituteEnvVarsJudgedAsync (go-to-k/cdkd#6341)', () => {
  it('a key whose judged read did not resolve is unresolved, not marked sensitive', async () => {
    const { env, audit } = await substituteEnvVarsJudgedAsync(
      { BROKEN: joinOf('SecretExport', 'MissingExport'), OK: importOf('SecretExport') },
      { resources: {}, crossStackResolver: judgedResolver() as never }
    );
    expect(Object.hasOwn(env, 'BROKEN')).toBe(false);
    expect(audit.unresolved.map((u) => u.key)).toEqual(['BROKEN']);
    expect(audit.sensitiveKeys).toEqual(['OK']);
  });
});
