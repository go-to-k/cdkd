import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * go-to-k/cdkd#6147, through the `local run-task` command body: which STS
 * `--assume-task-role` asks under `--aws-emulator` and in mixed mode, and which
 * channel the result reaches. The helpers have their own tests
 * (`tests/unit/local/run-task-assume-task-role-emulator.test.ts`); this file
 * pins the WIRING between them, which those cannot see.
 */

const runEcsTaskMock = vi.fn();
const stsSendMock = vi.fn();
const stsConfigs: Array<Record<string, unknown>> = [];
const activeWiring = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation((config: Record<string, unknown>) => {
    stsConfigs.push(config);
    return { send: stsSendMock, destroy: vi.fn() };
  }),
  AssumeRoleCommand: vi.fn().mockImplementation((input: unknown) => ({ kind: 'AssumeRole', input })),
  GetCallerIdentityCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ kind: 'GetCallerIdentity', input })),
}));

vi.mock('cdk-local/internal', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveHostDefaultCredentials: vi
    .fn()
    .mockResolvedValue({ accessKeyId: 'caller-key', secretAccessKey: 'caller-secret' }),
}));

vi.mock('../../../src/local/local-aws-wiring.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/local/local-aws-wiring.js')>();
  const { setActiveWorkloadAwsWiring } = await import('cdk-local/internal');
  const { setAwsEndpointOverrideSource } = await import('../../../src/utils/aws-client-defaults.js');
  return {
    ...actual,
    // The real activation probes a live emulator; this installs the wiring a
    // case chose, plus the endpoint override cdkd's own clients follow.
    activateLocalAwsAndRoleArn: vi.fn(async () => {
      const wiring = activeWiring.current as Parameters<typeof setActiveWorkloadAwsWiring>[0];
      setActiveWorkloadAwsWiring(wiring);
      setAwsEndpointOverrideSource(
        wiring ? () => ({ endpoint: EMULATOR_URL, credentials: EMULATOR_KEYS }) : undefined
      );
    }),
  };
});

vi.mock('../../../src/local/docker-runner.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ensureDockerAvailable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/local/docker-version.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveHostGatewayExtraHosts: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../src/cli/config-loader.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveApp: vi.fn().mockReturnValue('node app.js'),
}));
vi.mock('../../../src/synthesis/synthesizer.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: vi.fn().mockResolvedValue({ stacks: [] }),
  })),
}));
vi.mock('../../../src/cli/commands/local-state-source.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createLocalStateProvider: vi.fn().mockReturnValue(undefined),
}));
vi.mock('../../../src/local/ecs-task-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  parseEcsTarget: vi.fn().mockReturnValue({ stackPattern: undefined }),
  pickCandidateStack: vi.fn().mockReturnValue(undefined),
  resolveEcsTaskTarget: vi.fn().mockReturnValue({
    stack: { stackName: 'CdkdUnitStack', region: 'us-east-1' },
    taskDefinitionLogicalId: 'TaskDef',
    family: 'cdkd-unit-family',
    containers: [
      { name: 'api', environment: {}, image: { kind: 'cdk-asset' } },
      { name: 'web', environment: {}, image: { kind: 'cdk-asset' } },
    ],
    taskRoleArn: 'arn:aws:iam::${AWS::AccountId}:role/CdkdUnitTaskRole',
  }),
  detectEcsImageResolutionNeeds: vi.fn().mockReturnValue({ needsCrossStackResolver: false }),
}));
vi.mock('../../../src/local/ecs-task-runner.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createEcsRunState: vi.fn().mockReturnValue({ containers: [], entries: new Map() }),
  cleanupEcsRun: vi.fn().mockResolvedValue(undefined),
  runEcsTask: runEcsTaskMock,
}));

const EMULATOR_URL = 'https://127.0.0.1:9297';
const EMULATOR_KEYS = { accessKeyId: 'emulator-key', secretAccessKey: 'emulator-secret' };

const { createLocalRunTaskCommand } = await import('../../../src/cli/commands/local-run-task.js');
const { setActiveWorkloadAwsWiring } = await import('cdk-local/internal');
const { resetAwsClientDefaults, setAwsEndpointOverrideSource } = await import(
  '../../../src/utils/aws-client-defaults.js'
);
const { getLogger } = await import('../../../src/utils/logger.js');

function emulatorWiring(): unknown {
  return {
    mode: 'emulator',
    emulatorEndpoint: { url: EMULATOR_URL, hostname: '127.0.0.1', port: 9297, loopback: true },
    env: { AWS_ENDPOINT_URL: EMULATOR_URL },
    scrubEnvKeys: [],
    mounts: [],
    loopbackPorts: [9297],
    probeHealth: true,
    emulatorCredentials: EMULATOR_KEYS,
    dispose: () => {},
  };
}

function mixedWiring(): unknown {
  return {
    mode: 'forward',
    env: { AWS_ENDPOINT_URL: 'https://127.0.0.1:47297' },
    scrubEnvKeys: [],
    mounts: [],
    loopbackPorts: [9297, 47297],
    probeHealth: true,
    mixed: {
      realServices: ['STS', 'SECRETS_MANAGER'],
      emulatorEndpoint: { url: EMULATOR_URL, hostname: '127.0.0.1', port: 9297, loopback: true },
      resignPort: 47297,
      resignEndpoint: 'https://127.0.0.1:47297',
      emulatorCredentials: EMULATOR_KEYS,
      region: 'us-east-1',
      resignConfigHostPath: '/tmp/cdkd-unit-resign/resign.json',
      emulatorClientOverride: { endpoint: EMULATOR_URL, credentials: EMULATOR_KEYS },
    },
    dispose: () => {},
  };
}

interface CapturedRunOpts {
  taskCredentials?: { accessKeyId: string };
  emulatorTaskCredentials?: { accessKeyId: string };
  mixedModeRealTaskCredentials?: { accessKeyId: string };
  mixedModeRealCredentials?: { accessKeyId: string };
  taskRoleArn?: string;
}

let tmp: string;

async function runTask(args: string[]): Promise<CapturedRunOpts | undefined> {
  const cmd = createLocalRunTaskCommand();
  cmd.exitOverride();
  await cmd.parseAsync(['CdkdUnitStack/TaskDef', ...args], { from: 'user' });
  return runEcsTaskMock.mock.calls[0]?.[1] as CapturedRunOpts | undefined;
}

function envVarsFile(body: unknown): string {
  const p = nodePath.join(tmp, 'env.json');
  writeFileSync(p, JSON.stringify(body));
  return p;
}

const sentKinds = (): string[] =>
  stsSendMock.mock.calls.map((c) => (c[0] as { kind: string }).kind);

beforeEach(() => {
  tmp = mkdtempSync(nodePath.join(tmpdir(), 'cdkd-6147-'));
  stsConfigs.length = 0;
  runEcsTaskMock.mockReset().mockResolvedValue({
    state: { network: { networkName: 'cdkd-unit-net' } },
    exitCode: 0,
    essentialContainerName: undefined,
  });
  stsSendMock.mockReset().mockImplementation(async (cmd: { kind: string }) =>
    cmd.kind === 'GetCallerIdentity'
      ? { Account: '000000000000' }
      : {
          Credentials: {
            AccessKeyId: 'role-key',
            SecretAccessKey: 'role-secret',
            SessionToken: 'role-token',
          },
        }
  );
  resetAwsClientDefaults();
  process.env['CDKD_APP'] = 'node app.js';
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  activeWiring.current = undefined;
  setActiveWorkloadAwsWiring(undefined);
  setAwsEndpointOverrideSource(undefined);
  resetAwsClientDefaults();
  delete process.env['CDKD_APP'];
  vi.restoreAllMocks();
});

describe('local run-task --assume-task-role routing (go-to-k/cdkd#6147)', () => {
  it('--aws-emulator: the account and the role come from the emulator STS; the role reaches the sidecar and the containers', async () => {
    activeWiring.current = emulatorWiring();
    const runOpts = await runTask(['--assume-task-role']);
    expect(sentKinds()).toEqual(['GetCallerIdentity', 'AssumeRole']);
    expect(stsConfigs.map((c) => c['endpoint'])).toEqual([EMULATOR_URL, EMULATOR_URL]);
    expect(runOpts?.emulatorTaskCredentials?.accessKeyId).toBe('role-key');
    expect(runOpts?.taskCredentials?.accessKeyId).toBe('role-key');
    expect(runOpts?.mixedModeRealTaskCredentials).toBeUndefined();
    expect(runOpts?.taskRoleArn).toBe('arn:aws:iam::000000000000:role/CdkdUnitTaskRole');
  });

  it('mixed mode with a per-container STS exception: real STS for both calls; the real role, plus the caller for the other excepting container', async () => {
    activeWiring.current = mixedWiring();
    const file = envVarsFile({
      api: { AWS_ENDPOINT_URL_STS: 'real-aws' },
      web: { AWS_ENDPOINT_URL_SECRETS_MANAGER: 'real-aws' },
    });
    const runOpts = await runTask(['--assume-task-role', '--env-vars', file]);
    expect(sentKinds()).toEqual(['GetCallerIdentity', 'AssumeRole']);
    expect(stsConfigs.map((c) => c['endpoint'])).toEqual([undefined, undefined]);
    expect(runOpts?.mixedModeRealTaskCredentials?.accessKeyId).toBe('role-key');
    expect(runOpts?.mixedModeRealCredentials?.accessKeyId).toBe('caller-key');
    expect(runOpts?.emulatorTaskCredentials).toBeUndefined();
    expect(runOpts?.taskCredentials?.accessKeyId).toBe(EMULATOR_KEYS.accessKeyId);
  });

  it('mixed mode with the only STS-excepting container: the caller identity is not looked up', async () => {
    activeWiring.current = mixedWiring();
    const { resolveHostDefaultCredentials } = await import('cdk-local/internal');
    vi.mocked(resolveHostDefaultCredentials).mockClear();
    const file = envVarsFile({ Parameters: { AWS_ENDPOINT_URL_STS: 'real-aws' } });
    const runOpts = await runTask(['--assume-task-role', '--env-vars', file]);
    expect(runOpts?.mixedModeRealTaskCredentials?.accessKeyId).toBe('role-key');
    expect(runOpts?.mixedModeRealCredentials).toBeUndefined();
    expect(resolveHostDefaultCredentials).not.toHaveBeenCalled();
  });

  it('mixed mode with no STS exception: no STS call, a warning, and no TaskRoleArn needed', async () => {
    activeWiring.current = mixedWiring();
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const file = envVarsFile({ web: { AWS_ENDPOINT_URL_SECRETS_MANAGER: 'real-aws' } });
    const runOpts = await runTask(['--assume-task-role', '--env-vars', file]);
    expect(stsSendMock).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      '--assume-task-role has no effect in AWS Emulator mixed mode'
    );
    expect(runOpts?.taskRoleArn).toBeUndefined();
    expect(runOpts?.mixedModeRealTaskCredentials).toBeUndefined();
  });

  it('mixed mode with no STS exception: a task without a TaskRoleArn still runs (the ignored flag refuses nothing)', async () => {
    activeWiring.current = mixedWiring();
    vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const { resolveEcsTaskTarget } = await import('../../../src/local/ecs-task-resolver.js');
    const base = vi.mocked(resolveEcsTaskTarget).getMockImplementation()?.(
      ...([] as unknown as Parameters<typeof resolveEcsTaskTarget>)
    ) as unknown as Record<string, unknown>;
    vi.mocked(resolveEcsTaskTarget).mockReturnValueOnce({
      ...base,
      taskRoleArn: undefined,
    } as never);
    const file = envVarsFile({ web: { AWS_ENDPOINT_URL_SECRETS_MANAGER: 'real-aws' } });
    const runOpts = await runTask(['--assume-task-role', '--env-vars', file]);
    expect(runEcsTaskMock).toHaveBeenCalledTimes(1);
    expect(runOpts?.taskRoleArn).toBeUndefined();
  });
});
