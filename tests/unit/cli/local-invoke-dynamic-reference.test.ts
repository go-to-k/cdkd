import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { ResolvedZipLambda } from '../../../src/local/lambda-resolver.js';

/**
 * Issue [#2056](https://github.com/go-to-k/cdkd/issues/2056): `cdkd local
 * invoke` resolves CloudFormation dynamic references (`{{resolve:...}}`)
 * before the container starts, the way cdk-local's `resolveLambdaContainerEnv`
 * does since go-to-k/cdk-local#784 — cdkd's invoke builds its own env, so it
 * wires the same `cdk-local/internal` helpers itself.
 *
 * Two routes reach a token: a SAME-stack env value, and a CROSS-stack value
 * whose producer output cdkd persists REDACTED back to its token (#1899),
 * which `--from-state`'s resolver returns verbatim.
 *
 * Everything between the template and `runDetached` runs unmocked — the state
 * substitution, `resolveEnvVars`, and cdk-local's resolver — except the AWS
 * clients the resolver builds, injected through its client-factory seam so
 * each case can read WHICH region a lookup went to. The state source is a
 * fake provider standing in for `--from-state`.
 */

const PLAINTEXT = 'plain-2056-d41c';
const SECRET_JSON = JSON.stringify({ password: PLAINTEXT });

const mocks = vi.hoisted(() => ({
  synthesize: vi.fn(),
  resolveApp: vi.fn(),
  resolveLambdaTarget: vi.fn(),
  ensureDockerAvailable: vi.fn(),
  pullImage: vi.fn(),
  pickFreePort: vi.fn(),
  runDetached: vi.fn(),
  followContainerLogs: vi.fn(),
  killAndDrainContainerLogs: vi.fn(),
  removeContainer: vi.fn(),
  resolveHostGatewayExtraHosts: vi.fn(),
  waitForRieReady: vi.fn(),
  invokeRie: vi.fn(),
  createLocalStateProvider: vi.fn(),
  /** Every Secrets Manager `send`: the client's region and the command input. */
  smSend: vi.fn(),
  /** Every SSM `send`. */
  ssmSend: vi.fn(),
  /** Every fake client `destroy` (the resolver's `dispose`). */
  destroy: vi.fn(),
  /** The `profile` each site handed the caller-identity helper. */
  profiles: [] as Array<string | undefined>,
}));

// Only the caller-identity helper is doubled: a site that bypassed it would
// build real SDK clients and trip the AWS fence.
vi.mock('../../../src/local/dynamic-reference.js', async () =>
  (await import('../_caller-resolver-double.js')).callerResolverModule(mocks)
);

// `--from-state` with an intrinsic env asks STS for `${AWS::AccountId}`.
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn(() => ({
    send: async () => ({ Account: '111111111111' }),
    destroy: () => undefined,
  })),
  GetCallerIdentityCommand: vi.fn((input: unknown) => ({ input })),
}));

vi.mock('../../../src/cli/commands/local-state-source.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/cli/commands/local-state-source.js')>();
  return { ...actual, createLocalStateProvider: mocks.createLocalStateProvider };
});

vi.mock('../../../src/synthesis/synthesizer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/synthesis/synthesizer.js')>();
  return {
    ...actual,
    Synthesizer: vi.fn().mockImplementation(() => ({ synthesize: mocks.synthesize })),
  };
});

vi.mock('../../../src/cli/config-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/config-loader.js')>();
  return { ...actual, resolveApp: (cliApp?: string) => mocks.resolveApp(cliApp) };
});

vi.mock('../../../src/local/lambda-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/local/lambda-resolver.js')>();
  return { ...actual, resolveLambdaTarget: mocks.resolveLambdaTarget };
});

vi.mock('../../../src/local/docker-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/local/docker-runner.js')>();
  return {
    ...actual,
    ensureDockerAvailable: mocks.ensureDockerAvailable,
    pullImage: mocks.pullImage,
    pickFreePort: mocks.pickFreePort,
    runDetached: mocks.runDetached,
    followContainerLogs: mocks.followContainerLogs,
    killAndDrainContainerLogs: mocks.killAndDrainContainerLogs,
    removeContainer: mocks.removeContainer,
  };
});

vi.mock('../../../src/local/docker-version.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/local/docker-version.js')>();
  return { ...actual, resolveHostGatewayExtraHosts: mocks.resolveHostGatewayExtraHosts };
});

vi.mock('../../../src/local/rie-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/local/rie-client.js')>();
  return { ...actual, waitForRieReady: mocks.waitForRieReady, invokeRie: mocks.invokeRie };
});

import { createLocalCommand } from '../../../src/cli/commands/local-invoke.js';
import { releaseStdoutForPayload } from '../../../src/utils/logger.js';

const PAYLOAD = '{"ok":true}';
const SYNTH_REGION = 'us-east-1';
const STATE_REGION = 'eu-west-1';
const SAME_STACK_REF = '{{resolve:secretsmanager:same-stack-secret:SecretString:password::}}';
const PRODUCER_REF = '{{resolve:secretsmanager:producer-secret:SecretString:password::}}';

let workDir: string;
let env: Record<string, unknown>;

function makeStack(): StackInfo {
  return {
    artifactId: 'ConsumerStack',
    stackName: 'ConsumerStack',
    displayName: 'ConsumerStack',
    template: { Resources: {} },
    dependencyNames: [],
    region: SYNTH_REGION,
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
      Properties: { Environment: { Variables: env } },
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

/** A `--from-state` provider whose producer output is stored as its token. */
function fakeStateProvider(storedOutput: string) {
  const resolveImport = vi.fn().mockResolvedValue(storedOutput);
  const resolveGetStackOutput = vi.fn().mockResolvedValue(storedOutput);
  return {
    resolveImport,
    resolveGetStackOutput,
    provider: {
      label: '--from-state',
      load: vi.fn().mockResolvedValue({ region: STATE_REGION, resources: {}, outputs: {} }),
      buildCrossStackResolver: vi.fn().mockResolvedValue({ resolveImport, resolveGetStackOutput }),
      dispose: vi.fn(),
    },
  };
}

interface RunResult {
  env: Record<string, string> | undefined;
  sensitiveEnvKeys: ReadonlySet<string> | undefined;
  /** Every line any console channel received. */
  output: string;
  /** The exit code `handleError` asked for, when the command failed. */
  exitCode: number | undefined;
}

async function invoke(extraArgs: string[]): Promise<RunResult> {
  const lines: string[] = [];
  const capture = (...args: unknown[]): void => {
    lines.push(args.map(String).join(' '));
  };
  const quiet = [
    vi.spyOn(console, 'log').mockImplementation(capture),
    vi.spyOn(console, 'info').mockImplementation(capture),
    vi.spyOn(console, 'warn').mockImplementation(capture),
    vi.spyOn(console, 'error').mockImplementation(capture),
    vi.spyOn(console, 'debug').mockImplementation(capture),
  ];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  let exitCode: number | undefined;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error(`process.exit(${code})`);
  }) as never);
  try {
    const local = createLocalCommand();
    local.exitOverride();
    for (const sub of local.commands) sub.exitOverride();
    await local
      .parseAsync(['invoke', 'ConsumerStack/Consumer', '--no-pull', ...extraArgs], {
        from: 'user',
      })
      .catch((err: unknown) => {
        if (exitCode === undefined) throw err;
      });
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    exitSpy.mockRestore();
    for (const spy of quiet) spy.mockRestore();
  }
  const call = mocks.runDetached.mock.calls[0]?.[0] as
    | { env: Record<string, string>; sensitiveEnvKeys?: ReadonlySet<string> }
    | undefined;
  return {
    env: call?.env,
    sensitiveEnvKeys: call?.sensitiveEnvKeys,
    output: lines.join('\n'),
    exitCode,
  };
}

describe('local invoke resolves CloudFormation dynamic references (#2056)', () => {
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'cdkd-2056-dynref-'));
    writeFileSync(join(workDir, 'index.js'), 'exports.handler = async () => ({});\n');
    for (const m of Object.values(mocks)) {
      if (typeof m === 'function') m.mockReset();
    }
    mocks.profiles.length = 0;
    env = {};
    mocks.resolveApp.mockReturnValue('node app.js');
    mocks.synthesize.mockResolvedValue({ stacks: [makeStack()], assemblyDir: 'cdk.out' });
    mocks.resolveLambdaTarget.mockImplementation(() => makeZipLambda());
    mocks.ensureDockerAvailable.mockResolvedValue(undefined);
    mocks.pullImage.mockResolvedValue(undefined);
    mocks.pickFreePort.mockResolvedValue(19056);
    mocks.runDetached.mockResolvedValue('cdkd-local-2056');
    mocks.followContainerLogs.mockReturnValue({ stop: () => undefined, drain: async () => true });
    mocks.killAndDrainContainerLogs.mockResolvedValue(undefined);
    mocks.removeContainer.mockResolvedValue(undefined);
    mocks.resolveHostGatewayExtraHosts.mockResolvedValue([]);
    mocks.waitForRieReady.mockResolvedValue(undefined);
    mocks.invokeRie.mockResolvedValue({ payload: JSON.parse(PAYLOAD), raw: PAYLOAD });
    mocks.createLocalStateProvider.mockReturnValue(undefined);
    mocks.smSend.mockResolvedValue({ SecretString: SECRET_JSON });
    mocks.ssmSend.mockResolvedValue({ Parameter: { Type: 'String', Value: PLAINTEXT } });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    releaseStdoutForPayload();
  });

  it('same stack: the container gets the resolved value, off the docker argv', async () => {
    env = { DB_PASSWORD: SAME_STACK_REF, GREETING: 'hello' };
    const r = await invoke([]);

    expect(r.env?.['DB_PASSWORD']).toBe(PLAINTEXT);
    expect(r.env?.['GREETING']).toBe('hello');
    // A resolved key reaches `runDetached` as sensitive, which renders it as a
    // value-less `-e KEY`; the literal stays inline.
    expect([...(r.sensitiveEnvKeys ?? [])]).toEqual(['DB_PASSWORD']);
    // No state record: the synth region of the stack that owns the env.
    expect(mocks.smSend).toHaveBeenCalledTimes(1);
    expect(mocks.smSend.mock.calls[0]![0]).toBe(SYNTH_REGION);
    expect(mocks.smSend.mock.calls[0]![1]).toMatchObject({ SecretId: 'same-stack-secret' });
  });

  it('the resolver is disposed after a successful invoke', async () => {
    env = { DB_PASSWORD: SAME_STACK_REF };
    await invoke([]);
    expect(mocks.destroy).toHaveBeenCalledWith('secretsmanager', SYNTH_REGION);
  });

  it('no state record: --stack-region beats the synth region', async () => {
    env = { DB_PASSWORD: SAME_STACK_REF };
    await invoke(['--stack-region', 'sa-east-1']);
    expect(mocks.smSend.mock.calls.map((c) => c[0])).toEqual(['sa-east-1']);
  });

  it('bare --assume-role with --from-state still sees the loaded state (no "no state" fallback)', async () => {
    env = { DB_PASSWORD: SAME_STACK_REF };
    mocks.createLocalStateProvider.mockReturnValue(fakeStateProvider('unused').provider);
    const r = await invoke(['--from-state', '--assume-role']);
    // The invoke ran to the container, so the --assume-role branch was reached.
    expect(r.exitCode).toBeUndefined();
    expect(mocks.runDetached).toHaveBeenCalled();
    expect(r.output).not.toContain('no cdkd state was loaded');
    // The control: the same flag WITHOUT a state source does print it.
    mocks.createLocalStateProvider.mockReturnValue(undefined);
    const control = await invoke(['--assume-role']);
    expect(control.output).toContain('no cdkd state was loaded');
  });

  it('control: no token, no lookup and no sensitive key', async () => {
    env = { GREETING: 'hello' };
    const r = await invoke([]);

    expect(r.env?.['GREETING']).toBe('hello');
    expect(r.sensitiveEnvKeys).toBeUndefined();
    expect(mocks.smSend).not.toHaveBeenCalled();
  });

  it('same stack under --from-state: the lookup uses the state record region', async () => {
    env = { DB_PASSWORD: SAME_STACK_REF };
    mocks.createLocalStateProvider.mockReturnValue(fakeStateProvider('unused').provider);
    const r = await invoke(['--from-state']);

    expect(r.env?.['DB_PASSWORD']).toBe(PLAINTEXT);
    expect(mocks.smSend.mock.calls[0]![0]).toBe(STATE_REGION);
  });

  it('cross stack (Fn::ImportValue): a redacted producer output is resolved in the consumer region', async () => {
    env = { IMPORTED: { 'Fn::ImportValue': 'ProducerSecretPassword' } };
    const state = fakeStateProvider(PRODUCER_REF);
    mocks.createLocalStateProvider.mockReturnValue(state.provider);
    const r = await invoke(['--from-state']);

    expect(state.resolveImport).toHaveBeenCalledWith('ProducerSecretPassword');
    expect(r.env?.['IMPORTED']).toBe(PLAINTEXT);
    expect([...(r.sensitiveEnvKeys ?? [])]).toEqual(['IMPORTED']);
    // An export is regional, so its producer shares the consumer's region.
    expect(mocks.smSend).toHaveBeenCalledTimes(1);
    expect(mocks.smSend.mock.calls[0]![0]).toBe(STATE_REGION);
    expect(mocks.smSend.mock.calls[0]![1]).toMatchObject({ SecretId: 'producer-secret' });
  });

  it('a value resolved at the cross-stack boundary is never re-scanned, even when it looks like a token', async () => {
    env = { IMPORTED: { 'Fn::ImportValue': 'ProducerSecretPassword' } };
    mocks.createLocalStateProvider.mockReturnValue(fakeStateProvider(PRODUCER_REF).provider);
    const tokenShaped = `${PLAINTEXT}-${SAME_STACK_REF}`;
    mocks.smSend.mockResolvedValue({ SecretString: JSON.stringify({ password: tokenShaped }) });
    const r = await invoke(['--from-state']);

    expect(r.env?.['IMPORTED']).toBe(tokenShaped);
    expect(mocks.smSend).toHaveBeenCalledTimes(1);
  });

  it('cross stack (Fn::GetStackOutput): the lookup goes to the PRODUCER region', async () => {
    env = {
      FROM_OUTPUT: {
        'Fn::GetStackOutput': {
          StackName: 'ProducerStack',
          OutputName: 'SecretPassword',
          Region: 'ap-northeast-1',
        },
      },
    };
    const state = fakeStateProvider(PRODUCER_REF);
    mocks.createLocalStateProvider.mockReturnValue(state.provider);
    const r = await invoke(['--from-state']);

    expect(state.resolveGetStackOutput).toHaveBeenCalledWith(
      'ProducerStack',
      'ap-northeast-1',
      'SecretPassword'
    );
    expect(r.env?.['FROM_OUTPUT']).toBe(PLAINTEXT);
    expect([...(r.sensitiveEnvKeys ?? [])]).toEqual(['FROM_OUTPUT']);
    // Neither the consumer's state region nor its synth region.
    expect(mocks.smSend.mock.calls.map((c) => c[0])).toEqual(['ap-northeast-1']);
  });

  it('an --env-vars override skips the cross-stack lookup entirely', async () => {
    env = { IMPORTED: { 'Fn::ImportValue': 'ProducerSecretPassword' }, OTHER: 'kept' };
    const state = fakeStateProvider(PRODUCER_REF);
    mocks.createLocalStateProvider.mockReturnValue(state.provider);
    const envFile = join(workDir, 'env.json');
    writeFileSync(envFile, JSON.stringify({ Parameters: { IMPORTED: 'local-literal' } }));
    const r = await invoke(['--from-state', '--env-vars', envFile]);

    expect(r.env?.['IMPORTED']).toBe('local-literal');
    expect(r.env?.['OTHER']).toBe('kept');
    expect(state.resolveImport).not.toHaveBeenCalled();
    expect(mocks.smSend).not.toHaveBeenCalled();
    expect(r.sensitiveEnvKeys).toBeUndefined();
  });

  it('an --env-vars override carrying a token is the developer literal, never resolved', async () => {
    env = { DB_PASSWORD: SAME_STACK_REF };
    const envFile = join(workDir, 'env.json');
    writeFileSync(envFile, JSON.stringify({ Parameters: { DB_PASSWORD: PRODUCER_REF } }));
    const r = await invoke(['--env-vars', envFile]);

    expect(r.env?.['DB_PASSWORD']).toBe(PRODUCER_REF);
    expect(mocks.smSend).not.toHaveBeenCalled();
  });

  it('--profile reaches the resolver, which is built once per invoke', async () => {
    env = { DB_PASSWORD: SAME_STACK_REF };
    // `--profile` resolves credentials through STS before synth; that path is
    // covered elsewhere, so drop straight to the resolver construction here.
    const { resolveInvokeTemplateEnv } = await import('../../../src/cli/commands/local-invoke.js');
    const out = await resolveInvokeTemplateEnv(makeZipLambda(), {
      output: 'cdk.out',
      verbose: false,
      profile: 'dev-profile',
    } as never);

    expect(out.env['DB_PASSWORD']).toBe(PLAINTEXT);
    expect(mocks.profiles).toEqual(['dev-profile']);
  });

  it('a failed lookup fails the invoke before any container starts, naming the reference, never the plaintext', async () => {
    env = { IMPORTED: { 'Fn::ImportValue': 'ProducerSecretPassword' } };
    const state = fakeStateProvider(PRODUCER_REF);
    mocks.createLocalStateProvider.mockReturnValue(state.provider);
    mocks.smSend.mockRejectedValue(
      Object.assign(new Error('User is not authorized to read the secret'), {
        name: 'AccessDeniedException',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      })
    );
    const r = await invoke(['--from-state', '--verbose']);

    expect(r.exitCode).toBe(1);
    expect(mocks.runDetached).not.toHaveBeenCalled();
    expect(r.output).not.toContain(PLAINTEXT);
    expect(r.output).toContain('producer-secret');
    expect(r.output).toContain('secretsmanager:GetSecretValue');
    expect(r.output).toContain('Lambda Consumer');
    // The state source is still released on the failure path.
    expect(state.provider.dispose).toHaveBeenCalled();
    // The resolver's clients are destroyed on the failure path too.
    expect(mocks.destroy).toHaveBeenCalledWith('secretsmanager', STATE_REGION);
  });

  it('--verbose output never carries the resolved plaintext', async () => {
    env = {
      DB_PASSWORD: SAME_STACK_REF,
      IMPORTED: { 'Fn::ImportValue': 'ProducerSecretPassword' },
    };
    mocks.createLocalStateProvider.mockReturnValue(fakeStateProvider(PRODUCER_REF).provider);
    const r = await invoke(['--from-state', '--verbose']);

    expect(r.env?.['DB_PASSWORD']).toBe(PLAINTEXT);
    expect(r.env?.['IMPORTED']).toBe(PLAINTEXT);
    expect(new Set(r.sensitiveEnvKeys)).toEqual(new Set(['DB_PASSWORD', 'IMPORTED']));
    // The debug channel did run (so the absence below is not a muted logger).
    expect(r.output).toContain('substituted env var IMPORTED');
    expect(r.output).not.toContain(PLAINTEXT);
  });
});
