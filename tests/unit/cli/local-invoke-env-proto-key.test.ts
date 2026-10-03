import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { ResolvedZipLambda } from '../../../src/local/lambda-resolver.js';

/**
 * Issue [#3515](https://github.com/go-to-k/cdkd/issues/3515): an env var
 * literally named `__proto__` supplied through `--env-vars` must reach the
 * container `cdkd local invoke` starts. The env resolution is cdk-local's
 * `resolveEnvVars` (re-exported by `src/local/env-resolver.ts`), which assigned
 * each key onto a `{}` literal until go-to-k/cdk-local#769, so the key ran
 * `Object.prototype`'s setter and vanished.
 *
 * `resolveEnvVars` runs UNMOCKED here, from the installed cdk-local, as does
 * every cdkd-side step between it and `runDetached` (the `dockerEnv` spread,
 * the credential overlay). Only Docker, the RIE client, synthesis and target
 * resolution are stubbed, so the assertion is on the env the command hands to
 * `runDetached`. Its argv rendering of a `__proto__` key, sensitive
 * (value-less) and not (`-e __proto__=<value>`, this path), is pinned in
 * `tests/unit/utils/docker-cmd.test.ts` via `partitionSensitiveEnv`.
 */

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
}));

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

let workDir: string;

function makeStack(): StackInfo {
  return {
    artifactId: 'LocalStack',
    stackName: 'LocalStack',
    displayName: 'LocalStack',
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
    logicalId: 'EchoHandler',
    resource: {
      Type: 'AWS::Lambda::Function',
      Properties: { Environment: { Variables: { GREETING: 'hello' } } },
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

/** Runs `local invoke` with an `--env-vars` file and returns the env `runDetached` got. */
async function invokeWithEnvFile(envFileJson: string): Promise<Record<string, string>> {
  const envFile = join(workDir, 'env.json');
  writeFileSync(envFile, envFileJson);
  const quiet = [
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'info').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
  ];
  const origOut = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const local = createLocalCommand();
    local.exitOverride();
    for (const sub of local.commands) sub.exitOverride();
    await local.parseAsync(
      ['invoke', 'LocalStack/EchoHandler', '--no-pull', '--env-vars', envFile],
      { from: 'user' }
    );
  } finally {
    process.stdout.write = origOut;
    for (const spy of quiet) spy.mockRestore();
  }
  expect(mocks.runDetached).toHaveBeenCalledTimes(1);
  return (mocks.runDetached.mock.calls[0]![0] as { env: Record<string, string> }).env;
}

describe('local invoke delivers an --env-vars key named __proto__ (#3515)', () => {
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'cdkd-3515-proto-env-'));
    writeFileSync(join(workDir, 'index.js'), 'exports.handler = async () => ({});\n');
    for (const m of Object.values(mocks)) m.mockReset();
    mocks.resolveApp.mockReturnValue('node app.js');
    mocks.synthesize.mockResolvedValue({ stacks: [makeStack()], assemblyDir: 'cdk.out' });
    mocks.resolveLambdaTarget.mockImplementation(() => makeZipLambda());
    mocks.ensureDockerAvailable.mockResolvedValue(undefined);
    mocks.pullImage.mockResolvedValue(undefined);
    mocks.pickFreePort.mockResolvedValue(19515);
    mocks.runDetached.mockResolvedValue('cdkd-local-3515');
    mocks.followContainerLogs.mockReturnValue({
      stop: () => undefined,
      drain: async () => true,
    });
    mocks.killAndDrainContainerLogs.mockResolvedValue(undefined);
    mocks.removeContainer.mockResolvedValue(undefined);
    mocks.resolveHostGatewayExtraHosts.mockResolvedValue([]);
    mocks.waitForRieReady.mockResolvedValue(undefined);
    mocks.invokeRie.mockResolvedValue({ payload: JSON.parse(PAYLOAD), raw: PAYLOAD });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    releaseStdoutForPayload();
  });

  it('from the Parameters block', async () => {
    const env = await invokeWithEnvFile(
      '{"Parameters":{"GREETING":"overridden","__proto__":"proto-parameters"}}'
    );
    expect(Object.hasOwn(env, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(env, '__proto__')?.value).toBe('proto-parameters');
    // The sibling override in the same block still lands, so the case is not
    // passing on a file the resolver ignored.
    expect(env['GREETING']).toBe('overridden');
  });

  it('from a function-specific block', async () => {
    const env = await invokeWithEnvFile(
      '{"EchoHandler":{"GREETING":"fn-key","__proto__":"proto-fn-key"}}'
    );
    expect(Object.getOwnPropertyDescriptor(env, '__proto__')?.value).toBe('proto-fn-key');
    expect(env['GREETING']).toBe('fn-key');
  });

  it('control: no __proto__ key when the file names none', async () => {
    const env = await invokeWithEnvFile('{"Parameters":{"GREETING":"overridden"}}');
    expect(Object.hasOwn(env, '__proto__')).toBe(false);
    expect(env['GREETING']).toBe('overridden');
  });
});
