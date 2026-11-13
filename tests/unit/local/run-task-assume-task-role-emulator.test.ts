/**
 * go-to-k/cdkd#6147: `local run-task --assume-task-role` under `--aws-emulator`.
 *
 * The metadata sidecar (`amazon-ecs-local-container-endpoints`) serves
 * credentials carrying a session token as they are, but trades long-lived keys
 * for a session through `sts:GetSessionToken` on REAL STS, which refuses the
 * emulator's keys: `/creds` answered 500. The fix assumes the task role in the
 * emulator and serves THAT (a session) to the sidecar and the containers; in
 * mixed mode the role is assumed in real AWS for a container that excepts STS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  hostDefaults: vi.fn(),
  profileCreds: vi.fn(),
  stsConfigs: [] as Array<Record<string, unknown>>,
}));

vi.mock('cdk-local/internal', async () => {
  const actual = await vi.importActual<typeof import('cdk-local/internal')>('cdk-local/internal');
  return { ...actual, resolveHostDefaultCredentials: mocks.hostDefaults };
});

vi.mock('../../../src/cli/commands/local-start-api.js', () => ({
  resolveProfileCredentials: mocks.profileCreds,
}));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn(function STSClient(this: unknown, config: Record<string, unknown>) {
    mocks.stsConfigs.push(config);
    return {
      send: vi.fn(async () => ({
        Credentials: { AccessKeyId: 'ASIAROLE', SecretAccessKey: 'role-secret', SessionToken: 'role-token' },
      })),
      destroy: vi.fn(),
    };
  }),
  AssumeRoleCommand: vi.fn(function AssumeRoleCommand(this: unknown) {}),
  GetCallerIdentityCommand: vi.fn(function GetCallerIdentityCommand(this: unknown) {}),
}));

import { setActiveWorkloadAwsWiring, type WorkloadAwsWiring } from 'cdk-local/internal';
import {
  planTaskRoleCredentials,
  resolveSidecarCredentials,
  resolveTaskCredentialChannels,
} from '../../../src/cli/commands/local-run-task/credentials.js';
import { assumeTaskRole } from '../../../src/cli/commands/local-run-task/stack-account.js';
import { buildDockerRunArgs } from '../../../src/local/ecs-task-runner/docker-run-args.js';
import { taskRoleAssumedInRealAws } from '../../../src/local/local-aws-wiring.js';
import {
  resetAwsClientDefaults,
  setAwsEndpointOverrideSource,
} from '../../../src/utils/aws-client-defaults.js';
import type { ResolvedEcsContainer, ResolvedEcsTask } from '../../../src/local/ecs-task-resolver.js';

const CA_PATH = '/cdkd-aws/ca-bundle.pem';
const EMULATOR_KEYS = { accessKeyId: 'EMULATORKEY000000000', secretAccessKey: 'emulator-secret' };
const HOST_KEYS = { accessKeyId: 'HOSTCHAINKEYID000000', secretAccessKey: 'host-chain-secret' };
const EMULATOR_ROLE = {
  accessKeyId: 'emulator-role-key',
  secretAccessKey: 'emulator-role-secret',
  sessionToken: 'emulator-role-token',
};
const REAL_ROLE = {
  accessKeyId: 'real-role-key',
  secretAccessKey: 'real-role-secret',
  sessionToken: 'real-role-token',
};

function emulatorWiring(): WorkloadAwsWiring {
  return {
    mode: 'emulator',
    emulatorEndpoint: { url: 'https://127.0.0.1:9297', hostname: '127.0.0.1', port: 9297, loopback: true },
    env: { AWS_ENDPOINT_URL: 'https://127.0.0.1:9297', AWS_CA_BUNDLE: CA_PATH },
    scrubEnvKeys: ['AWS_PROFILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE'],
    mounts: [],
    loopbackPorts: [9297],
    probeHealth: true,
    emulatorCredentials: EMULATOR_KEYS,
    dispose: () => {},
  };
}

function mixedWiring(): WorkloadAwsWiring {
  return {
    mode: 'forward',
    env: { AWS_ENDPOINT_URL: 'https://127.0.0.1:47297', AWS_CA_BUNDLE: CA_PATH },
    scrubEnvKeys: [],
    mounts: [],
    loopbackPorts: [9297, 47297],
    probeHealth: true,
    mixed: {
      realServices: ['SECRETS_MANAGER', 'STS'],
      emulatorEndpoint: { url: 'https://127.0.0.1:9297', hostname: '127.0.0.1', port: 9297, loopback: true },
      resignPort: 47297,
      resignEndpoint: 'https://127.0.0.1:47297',
      emulatorCredentials: EMULATOR_KEYS,
      region: 'us-east-1',
      resignConfigHostPath: '/tmp/cdkd-resign-test/resign.json',
      emulatorClientOverride: { endpoint: 'https://127.0.0.1:9297', credentials: EMULATOR_KEYS },
    },
    dispose: () => {},
  } as WorkloadAwsWiring;
}

const container = (name: string): ResolvedEcsContainer =>
  ({
    name,
    environment: { AWS_REGION: 'us-east-1' },
    secrets: [],
    portMappings: [],
    mountPoints: [],
    ulimits: [],
    links: [],
  }) as unknown as ResolvedEcsContainer;

const STS_EXCEPTED = {
  api: { AWS_ENDPOINT_URL_STS: 'real-aws', AWS_ENDPOINT_URL_SECRETS_MANAGER: 'real-aws' },
  web: { AWS_ENDPOINT_URL_SECRETS_MANAGER: 'real-aws' },
};

function build(
  name: string,
  extra: Partial<Parameters<typeof buildDockerRunArgs>[0]> = {}
): ReturnType<typeof buildDockerRunArgs> {
  return buildDockerRunArgs({
    task: { family: 'fam', containers: [], volumes: [] } as unknown as ResolvedEcsTask,
    container: container(name),
    image: 'img',
    network: 'net',
    volumeByName: new Map(),
    secrets: [],
    containerHost: '127.0.0.1',
    region: 'us-east-1',
    roleArn: 'arn:aws:iam::000000000000:role/TaskRole',
    platformOverride: undefined,
    ...extra,
  } as Parameters<typeof buildDockerRunArgs>[0]);
}

const envFlags = (args: string[]): string[] =>
  args.flatMap((a, i) => (args[i - 1] === '-e' ? [a] : []));

beforeEach(() => {
  mocks.hostDefaults.mockReset().mockResolvedValue(HOST_KEYS);
  mocks.profileCreds.mockReset().mockResolvedValue(HOST_KEYS);
  mocks.stsConfigs.length = 0;
});

afterEach(() => {
  setActiveWorkloadAwsWiring(undefined);
  setAwsEndpointOverrideSource(undefined);
  resetAwsClientDefaults();
});

describe('taskRoleAssumedInRealAws', () => {
  it('real AWS without --aws-emulator, never under it, per-container STS exception in mixed mode', () => {
    expect(taskRoleAssumedInRealAws({}, undefined)).toBe(true);
    expect(taskRoleAssumedInRealAws({ AWS_ENDPOINT_URL_STS: 'real-aws' }, emulatorWiring())).toBe(false);
    expect(taskRoleAssumedInRealAws({}, mixedWiring())).toBe(false);
    expect(taskRoleAssumedInRealAws({ AWS_ENDPOINT_URL_SSM: 'real-aws' }, mixedWiring())).toBe(false);
    expect(taskRoleAssumedInRealAws({ AWS_ENDPOINT_URL_STS: 'real-aws' }, mixedWiring())).toBe(true);
  });
});

describe('planTaskRoleCredentials', () => {
  const two = [container('api'), container('web')];

  it('assumes in real AWS only, without --aws-emulator', () => {
    expect(planTaskRoleCredentials(two, undefined, true)).toMatchObject({
      assumeInRealAws: true,
      assumeInEmulator: false,
      ignoredInMixedMode: false,
    });
  });

  it('assumes in the emulator only, under --aws-emulator, whatever --env-vars says', () => {
    setActiveWorkloadAwsWiring(emulatorWiring());
    expect(planTaskRoleCredentials(two, STS_EXCEPTED, true)).toMatchObject({
      assumeInRealAws: false,
      assumeInEmulator: true,
      ignoredInMixedMode: false,
    });
  });

  it('mixed mode: real AWS for an STS exception; the caller still needed by a container excepting other services', () => {
    setActiveWorkloadAwsWiring(mixedWiring());
    expect(planTaskRoleCredentials(two, STS_EXCEPTED, true)).toEqual({
      assumeInRealAws: true,
      assumeInEmulator: false,
      ignoredInMixedMode: false,
      callerIdentityNeeded: true,
    });
    expect(planTaskRoleCredentials([container('api')], STS_EXCEPTED, true).callerIdentityNeeded).toBe(
      false
    );
  });

  it('mixed mode with no STS exception: the role is ignored', () => {
    setActiveWorkloadAwsWiring(mixedWiring());
    expect(planTaskRoleCredentials(two, { web: STS_EXCEPTED.web }, true)).toEqual({
      assumeInRealAws: false,
      assumeInEmulator: false,
      ignoredInMixedMode: true,
      callerIdentityNeeded: true,
    });
  });

  it('nothing is assumed without --assume-task-role', () => {
    setActiveWorkloadAwsWiring(emulatorWiring());
    expect(planTaskRoleCredentials(two, undefined, false)).toMatchObject({
      assumeInRealAws: false,
      assumeInEmulator: false,
      ignoredInMixedMode: false,
    });
  });
});

describe('assumeTaskRole: the STS it asks', () => {
  it('the emulator under --aws-emulator, real AWS on request', async () => {
    setAwsEndpointOverrideSource(() => ({
      endpoint: 'https://127.0.0.1:9297',
      credentials: EMULATOR_KEYS,
    }));
    await assumeTaskRole('arn:aws:iam::000000000000:role/TaskRole', 'us-east-1', { realAws: false });
    await assumeTaskRole('arn:aws:iam::000000000000:role/TaskRole', 'us-east-1', { realAws: true });
    expect(mocks.stsConfigs[0]).toMatchObject({ endpoint: 'https://127.0.0.1:9297' });
    expect(mocks.stsConfigs[0]!['credentials']).toEqual(EMULATOR_KEYS);
    expect(mocks.stsConfigs[1]!['endpoint']).toBeUndefined();
  });
});

describe('the metadata sidecar under --aws-emulator', () => {
  it('serves the emulator-assumed task role (a session, which the sidecar passes through)', async () => {
    setActiveWorkloadAwsWiring(emulatorWiring());
    await expect(resolveSidecarCredentials({}, undefined, EMULATOR_ROLE)).resolves.toBe(
      EMULATOR_ROLE
    );
  });

  it('never serves a real task role', async () => {
    setActiveWorkloadAwsWiring(emulatorWiring());
    await expect(resolveSidecarCredentials({}, REAL_ROLE)).resolves.toEqual(EMULATOR_KEYS);
    setActiveWorkloadAwsWiring(mixedWiring());
    await expect(resolveSidecarCredentials({}, REAL_ROLE)).resolves.toEqual(EMULATOR_KEYS);
  });
});

describe('resolveTaskCredentialChannels', () => {
  it('--aws-emulator: carries the emulator-assumed role, no file, no real identity', async () => {
    setActiveWorkloadAwsWiring(emulatorWiring());
    const channels = await resolveTaskCredentialChannels({ profile: 'dev' }, undefined, {
      emulatorTaskCredentials: EMULATOR_ROLE,
    });
    expect(channels).toEqual({
      sidecarCredentials: EMULATOR_ROLE,
      profileCredsFile: undefined,
      emulatorTaskCredentials: EMULATOR_ROLE,
    });
    expect(mocks.profileCreds).not.toHaveBeenCalled();
  });

  it('mixed mode: the real task role and the caller, separately; the caller skipped when unneeded', async () => {
    setActiveWorkloadAwsWiring(mixedWiring());
    const channels = await resolveTaskCredentialChannels({}, REAL_ROLE);
    expect(channels.mixedModeRealTaskCredentials).toBe(REAL_ROLE);
    expect(channels.mixedModeRealCredentials).toEqual(HOST_KEYS);
    expect(channels.sidecarCredentials).toEqual(EMULATOR_KEYS);
    mocks.hostDefaults.mockClear();
    const skipped = await resolveTaskCredentialChannels({}, REAL_ROLE, {
      callerIdentityNeeded: false,
    });
    expect(skipped.mixedModeRealCredentials).toBeUndefined();
    expect(mocks.hostDefaults).not.toHaveBeenCalled();
  });
});

describe('ECS buildDockerRunArgs: the task role in the container env', () => {
  it('--aws-emulator: the emulator-assumed role replaces the emulator keys, and /creds stays', () => {
    setActiveWorkloadAwsWiring(emulatorWiring());
    const built = build('app', { emulatorTaskCredentials: EMULATOR_ROLE });
    expect(built.sensitiveEnv['AWS_ACCESS_KEY_ID']).toBe(EMULATOR_ROLE.accessKeyId);
    expect(built.sensitiveEnv['AWS_SECRET_ACCESS_KEY']).toBe(EMULATOR_ROLE.secretAccessKey);
    expect(built.sensitiveEnv['AWS_SESSION_TOKEN']).toBe(EMULATOR_ROLE.sessionToken);
    expect(envFlags(built.args)).toContain('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=/creds');
    expect(Object.values(built.sensitiveEnv)).not.toContain(EMULATOR_KEYS.secretAccessKey);
  });

  it('--aws-emulator without a task role: the emulator keys, as before', () => {
    setActiveWorkloadAwsWiring(emulatorWiring());
    const built = build('app');
    expect(built.sensitiveEnv['AWS_ACCESS_KEY_ID']).toBe(EMULATOR_KEYS.accessKeyId);
    expect(built.sensitiveEnv['AWS_SESSION_TOKEN']).toBeUndefined();
  });

  it('mixed mode: the real task role only to a container excepting STS; the caller to one excepting others; emulator keys elsewhere', () => {
    setActiveWorkloadAwsWiring(mixedWiring());
    const opts = {
      envOverrides: STS_EXCEPTED,
      mixedModeRealCredentials: HOST_KEYS,
      mixedModeRealTaskCredentials: REAL_ROLE,
    };
    const api = build('api', opts);
    expect(api.sensitiveEnv['AWS_ACCESS_KEY_ID']).toBe(REAL_ROLE.accessKeyId);
    expect(api.sensitiveEnv['AWS_SESSION_TOKEN']).toBe(REAL_ROLE.sessionToken);
    const web = build('web', opts);
    expect(web.sensitiveEnv['AWS_ACCESS_KEY_ID']).toBe(HOST_KEYS.accessKeyId);
    expect(web.sensitiveEnv['AWS_SESSION_TOKEN']).toBeUndefined();
    const worker = build('worker', opts);
    expect(worker.sensitiveEnv['AWS_ACCESS_KEY_ID']).toBe(EMULATOR_KEYS.accessKeyId);
    expect(Object.values(worker.sensitiveEnv)).not.toContain(REAL_ROLE.secretAccessKey);
  });

  it('mixed mode: an emulator-assumed role never reaches a container (the re-signing sidecar signs with the emulator keys)', () => {
    setActiveWorkloadAwsWiring(mixedWiring());
    const worker = build('worker', { emulatorTaskCredentials: EMULATOR_ROLE });
    expect(worker.sensitiveEnv['AWS_ACCESS_KEY_ID']).toBe(EMULATOR_KEYS.accessKeyId);
  });
});
