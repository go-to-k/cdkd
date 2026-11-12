import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// go-to-k/cdkd#6129 / #6130 / #6131 / #6132: the AWS endpoint / trust /
// credential wiring applied at cdkd's own docker-run layer (`runDetached`)
// and in the ECS task runner's `buildDockerRunArgs`. The wiring OBJECT is
// cdk-local's; these tests install one by hand and assert what reaches the
// `docker run` argv and the spawn env.

vi.mock('../../../src/utils/logger.js', () => {
  const leaf = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    getLevel: () => 'info',
    child: () => leaf,
  };
  return { getLogger: () => leaf };
});

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  hostDefaults: vi.fn(),
  attach: vi.fn(),
  ensureImage: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: (...allArgs: unknown[]) => {
      const cb = allArgs[allArgs.length - 1] as (err: unknown, out?: { stdout: string }) => void;
      mocks.execFile(allArgs[0], allArgs[1], allArgs.length === 4 ? allArgs[2] : undefined);
      cb(null, { stdout: 'container-id\n' });
    },
  };
});

vi.mock('cdk-local/internal', async () => {
  const actual = await vi.importActual<typeof import('cdk-local/internal')>('cdk-local/internal');
  return {
    ...actual,
    resolveHostDefaultCredentials: mocks.hostDefaults,
    attachLoopbackForwarder: mocks.attach,
    ensureForwarderImage: mocks.ensureImage,
  };
});

import {
  setActiveWorkloadAwsWiring,
  type WorkloadAwsWiring,
} from 'cdk-local/internal';
import { runDetached } from '../../../src/local/docker-runner.js';
import {
  activateLocalAwsWiring,
  applyLocalAwsWiring,
  getActiveWorkloadAwsWiring,
  prepareLocalLoopbackForwarder,
  profileCredentialsForWorkload,
} from '../../../src/local/local-aws-wiring.js';
import { resolveWorkloadAwsWiring } from 'cdk-local/internal';
import { resolveHostCredentialsForSigV4 } from '../../../src/cli/commands/local-invoke-agentcore/sigv4.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDockerRunArgs } from '../../../src/local/ecs-task-runner/docker-run-args.js';
import { resolveSidecarCredentials } from '../../../src/cli/commands/local-run-task/credentials.js';
import { CONTAINER_AWS_CREDENTIALS_PATH } from '../../../src/cli/commands/local-profile-credentials-file.js';
import { CdkdError } from '../../../src/utils/error-handler.js';
import type {
  ResolvedEcsContainer,
  ResolvedEcsTask,
} from '../../../src/local/ecs-task-resolver.js';

const CA_PATH = '/cdkd-aws/ca-bundle.pem';
const EMULATOR_KEYS = { accessKeyId: 'EMULATORKEY000000000', secretAccessKey: 'emulator-secret' };
const HOST_KEYS = { accessKeyId: 'HOSTCHAINKEYID000000', secretAccessKey: 'host-chain-secret' };

function forwardWiring(over: Partial<WorkloadAwsWiring> = {}): WorkloadAwsWiring {
  return {
    mode: 'forward',
    env: {
      AWS_ENDPOINT_URL: 'https://127.0.0.1:4566',
      AWS_CA_BUNDLE: CA_PATH,
      NODE_EXTRA_CA_CERTS: CA_PATH,
      REQUESTS_CA_BUNDLE: CA_PATH,
      SSL_CERT_FILE: CA_PATH,
    },
    scrubEnvKeys: [],
    mounts: [{ hostPath: '/tmp/cdkd-ca-x/ca-bundle.pem', containerPath: CA_PATH }],
    loopbackPorts: [4566],
    probeHealth: false,
    caHostPath: '/tmp/cdkd-ca-x/ca-bundle.pem',
    dispose: () => {},
    ...over,
  };
}

function emulatorWiring(): WorkloadAwsWiring {
  return {
    mode: 'emulator',
    emulatorEndpoint: {
      url: 'https://127.0.0.1:9297',
      hostname: '127.0.0.1',
      port: 9297,
      loopback: true,
    },
    env: {
      AWS_ENDPOINT_URL: 'https://127.0.0.1:9297',
      AWS_EC2_METADATA_DISABLED: 'true',
      AWS_DISABLE_HOST_PREFIX_INJECTION: 'true',
      AWS_CA_BUNDLE: CA_PATH,
      NODE_EXTRA_CA_CERTS: CA_PATH,
      REQUESTS_CA_BUNDLE: CA_PATH,
      SSL_CERT_FILE: CA_PATH,
    },
    scrubEnvKeys: ['AWS_PROFILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE'],
    mounts: [{ hostPath: '/tmp/cdkd-ca-y/ca-bundle.pem', containerPath: CA_PATH }],
    loopbackPorts: [9297],
    probeHealth: true,
    caHostPath: '/tmp/cdkd-ca-y/ca-bundle.pem',
    emulatorCredentials: EMULATOR_KEYS,
    dispose: () => {},
  };
}

function lastRun(): { args: string[]; env: Record<string, string> } {
  const calls = mocks.execFile.mock.calls.filter((c) => (c[1] as string[])[0] === 'run');
  expect(calls.length).toBeGreaterThan(0);
  const last = calls[calls.length - 1]!;
  return {
    args: last[1] as string[],
    env: ((last[2] as { env?: Record<string, string> }) ?? {}).env ?? {},
  };
}

/** The `-e` flags of an argv, as `KEY` or `KEY=value`. */
function envFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) if (args[i] === '-e') out.push(args[i + 1]!);
  return out;
}

beforeEach(() => {
  mocks.execFile.mockReset();
  mocks.hostDefaults.mockReset();
  mocks.attach.mockReset();
  mocks.ensureImage.mockReset();
  mocks.attach.mockResolvedValue(undefined);
  mocks.ensureImage.mockResolvedValue(undefined);
});
afterEach(() => {
  setActiveWorkloadAwsWiring(undefined);
});

describe('runDetached with no wiring active', () => {
  it('adds nothing: no default-chain lookup, no forwarder, no CA mount', async () => {
    setActiveWorkloadAwsWiring(undefined);
    await runDetached({ image: 'img', mounts: [], env: { A: '1' }, cmd: [], hostPort: 9000 });
    const { args } = lastRun();
    expect(envFlags(args)).toEqual(['A=1']);
    expect(args.join(' ')).not.toContain(CA_PATH);
    expect(mocks.hostDefaults).not.toHaveBeenCalled();
    expect(mocks.attach).not.toHaveBeenCalled();
  });
});

describe('runDetached under forward mode (#6129, #6130, #6131)', () => {
  it('fills the default-chain credentials into an env with none, off the argv', async () => {
    setActiveWorkloadAwsWiring(forwardWiring());
    mocks.hostDefaults.mockResolvedValue(HOST_KEYS);
    await runDetached({ image: 'img', mounts: [], env: {}, cmd: [], hostPort: 9000 });
    const { args, env } = lastRun();
    expect(envFlags(args)).toContain('AWS_ACCESS_KEY_ID');
    expect(args.join(' ')).not.toContain(HOST_KEYS.secretAccessKey);
    expect(args.join(' ')).not.toContain(HOST_KEYS.accessKeyId);
    expect(env['AWS_ACCESS_KEY_ID']).toBe(HOST_KEYS.accessKeyId);
    expect(env['AWS_SECRET_ACCESS_KEY']).toBe(HOST_KEYS.secretAccessKey);
  });

  it('keeps the credentials the command already set (--assume-role / --profile win)', async () => {
    setActiveWorkloadAwsWiring(forwardWiring());
    mocks.hostDefaults.mockResolvedValue(HOST_KEYS);
    await runDetached({
      image: 'img',
      mounts: [],
      env: { AWS_ACCESS_KEY_ID: 'ASIAFLAG', AWS_SECRET_ACCESS_KEY: 'flag-secret' },
      cmd: [],
      hostPort: 9000,
    });
    expect(mocks.hostDefaults).not.toHaveBeenCalled();
    expect(lastRun().env['AWS_ACCESS_KEY_ID']).toBe('ASIAFLAG');
  });

  it('forwards the endpoint, mounts the CA read-only with the trust variables, and attaches the forwarder', async () => {
    setActiveWorkloadAwsWiring(forwardWiring());
    mocks.hostDefaults.mockResolvedValue(undefined);
    await runDetached({ image: 'img', mounts: [], env: {}, cmd: [], hostPort: 9000 });
    const { args } = lastRun();
    expect(envFlags(args)).toEqual(
      expect.arrayContaining([
        'AWS_ENDPOINT_URL=https://127.0.0.1:4566',
        `AWS_CA_BUNDLE=${CA_PATH}`,
        `NODE_EXTRA_CA_CERTS=${CA_PATH}`,
        `REQUESTS_CA_BUNDLE=${CA_PATH}`,
        `SSL_CERT_FILE=${CA_PATH}`,
      ])
    );
    expect(args).toContain(`/tmp/cdkd-ca-x/ca-bundle.pem:${CA_PATH}:ro`);
    expect(mocks.ensureImage).toHaveBeenCalledTimes(1);
    expect(mocks.attach).toHaveBeenCalledWith('container-id', expect.anything(), [4566]);
  });

  it('lets a template / --env-vars endpoint win, and then starts no forwarder for the port', async () => {
    setActiveWorkloadAwsWiring(forwardWiring());
    mocks.hostDefaults.mockResolvedValue(undefined);
    await runDetached({
      image: 'img',
      mounts: [],
      env: { AWS_ENDPOINT_URL: 'http://172.17.0.1:8000' },
      cmd: [],
      hostPort: 9000,
    });
    expect(envFlags(lastRun().args)).toContain('AWS_ENDPOINT_URL=http://172.17.0.1:8000');
    expect(mocks.ensureImage).not.toHaveBeenCalled();
    expect(mocks.attach).toHaveBeenCalledWith('container-id', expect.anything(), []);
  });

  it('starts no forwarder on the host network, where 127.0.0.1 is the host', async () => {
    setActiveWorkloadAwsWiring(forwardWiring());
    mocks.hostDefaults.mockResolvedValue(undefined);
    await runDetached({
      image: 'img',
      mounts: [],
      env: {},
      cmd: [],
      hostPort: 9000,
      network: 'host',
    });
    expect(mocks.attach).toHaveBeenCalledWith('container-id', expect.anything(), []);
  });

  it('does not shadow a mount the caller already has at the CA path', async () => {
    setActiveWorkloadAwsWiring(forwardWiring());
    mocks.hostDefaults.mockResolvedValue(undefined);
    await runDetached({
      image: 'img',
      mounts: [{ hostPath: '/user/ca', containerPath: CA_PATH, readOnly: true }],
      env: {},
      cmd: [],
      hostPort: 9000,
    });
    expect(lastRun().args).not.toContain(`/tmp/cdkd-ca-x/ca-bundle.pem:${CA_PATH}:ro`);
  });
});

describe('runDetached under --aws-emulator (#6132)', () => {
  it('replaces every real credential with the emulator keys and scrubs profile variables', async () => {
    setActiveWorkloadAwsWiring(emulatorWiring());
    await runDetached({
      image: 'img',
      mounts: [],
      extraMounts: [
        { hostPath: '/tmp/creds', containerPath: CONTAINER_AWS_CREDENTIALS_PATH, readOnly: true },
      ],
      env: {
        AWS_ACCESS_KEY_ID: 'AKIAREALHOST',
        AWS_SECRET_ACCESS_KEY: 'real-host-secret',
        AWS_SESSION_TOKEN: 'real-token',
        AWS_PROFILE: 'prod',
        AWS_SHARED_CREDENTIALS_FILE: CONTAINER_AWS_CREDENTIALS_PATH,
        AWS_REGION: 'us-east-1',
      },
      cmd: [],
      hostPort: 9000,
    });
    const { args, env } = lastRun();
    const joined = args.join(' ');
    expect(mocks.hostDefaults).not.toHaveBeenCalled();
    expect(env['AWS_ACCESS_KEY_ID']).toBe(EMULATOR_KEYS.accessKeyId);
    expect(env['AWS_SECRET_ACCESS_KEY']).toBe(EMULATOR_KEYS.secretAccessKey);
    expect(env['AWS_SESSION_TOKEN']).toBeUndefined();
    expect(envFlags(args)).not.toContain('AWS_SESSION_TOKEN');
    for (const leaked of ['AKIAREALHOST', 'real-host-secret', 'real-token', 'prod']) {
      expect(joined).not.toContain(leaked);
    }
    expect(envFlags(args).some((f) => f.startsWith('AWS_PROFILE'))).toBe(false);
    expect(envFlags(args).some((f) => f.startsWith('AWS_SHARED_CREDENTIALS_FILE'))).toBe(false);
    expect(joined).not.toContain(`/tmp/creds:${CONTAINER_AWS_CREDENTIALS_PATH}`);
    expect(envFlags(args)).toEqual(
      expect.arrayContaining([
        'AWS_ENDPOINT_URL=https://127.0.0.1:9297',
        'AWS_EC2_METADATA_DISABLED=true',
        'AWS_DISABLE_HOST_PREFIX_INJECTION=true',
        'AWS_DEFAULT_REGION=us-east-1',
      ])
    );
    expect(mocks.attach).toHaveBeenCalledWith('container-id', expect.anything(), [9297]);
  });

  it('fails the run when the forwarder image cannot be pulled', async () => {
    setActiveWorkloadAwsWiring(emulatorWiring());
    mocks.ensureImage.mockRejectedValue(new Error('pull denied'));
    await expect(
      runDetached({ image: 'img', mounts: [], env: {}, cmd: [], hostPort: 9000 })
    ).rejects.toThrow(/loopback forwarder image could not be pulled: pull denied/);
    expect(mocks.execFile.mock.calls.filter((c) => (c[1] as string[])[0] === 'run')).toEqual([]);
  });

  it('turns a forwarder failure into a CdkdError', async () => {
    setActiveWorkloadAwsWiring(emulatorWiring());
    mocks.attach.mockRejectedValue(new Error('--aws-emulator https://127.0.0.1:9297: unreachable'));
    await expect(
      runDetached({ image: 'img', mounts: [], env: {}, cmd: [], hostPort: 9000 })
    ).rejects.toBeInstanceOf(CdkdError);
  });
});

describe('forward mode tolerates a forwarder image pull failure', () => {
  it('still starts the workload', async () => {
    setActiveWorkloadAwsWiring(forwardWiring());
    mocks.hostDefaults.mockResolvedValue(undefined);
    mocks.ensureImage.mockRejectedValue(new Error('offline'));
    await expect(
      runDetached({ image: 'img', mounts: [], env: {}, cmd: [], hostPort: 9000 })
    ).resolves.toBe('container-id');
  });
});

describe('prepareLocalLoopbackForwarder honours --no-pull (go-to-k/cdkd#6142)', () => {
  it('passes the wiring skipPull to the image check, so --no-pull pulls nothing', async () => {
    await prepareLocalLoopbackForwarder({ ...forwardWiring(), skipPull: true });
    expect(mocks.ensureImage).toHaveBeenCalledWith(true);
  });

  it('checks / pulls the image without --no-pull', async () => {
    await prepareLocalLoopbackForwarder(forwardWiring());
    expect(mocks.ensureImage).toHaveBeenCalledWith(false);
  });
});

describe('applyLocalAwsWiring', () => {
  it('keeps the --profile credentials-file mount under forward mode', async () => {
    mocks.hostDefaults.mockResolvedValue(undefined);
    const mount = { hostPath: '/tmp/creds', containerPath: CONTAINER_AWS_CREDENTIALS_PATH };
    const out = await applyLocalAwsWiring(forwardWiring({ mounts: [] }), {}, [mount], []);
    expect(out.extraMounts).toEqual([mount]);
  });
});

describe('activateLocalAwsWiring', () => {
  it('reports an unusable --aws-emulator value as a CdkdError naming the flag', async () => {
    const err = await activateLocalAwsWiring({ awsEmulator: 'not a url' }).catch((e) => e);
    expect(err).toBeInstanceOf(CdkdError);
    expect((err as CdkdError).code).toBe('LOCAL_AWS_WIRING_FAILED');
    expect((err as Error).message).toMatch(/--aws-emulator/);
  });
});

describe('ECS buildDockerRunArgs with the wiring', () => {
  const task = {
    family: 'fam',
    containers: [],
    volumes: [],
  } as unknown as ResolvedEcsTask;
  const container = {
    name: 'app',
    environment: { AWS_ENDPOINT_URL: 'https://127.0.0.1:9297' },
    secrets: [],
    portMappings: [],
    mountPoints: [],
    ulimits: [],
    links: [],
  } as unknown as ResolvedEcsContainer;
  const base = {
    task,
    container,
    image: 'img',
    network: 'net',
    volumeByName: new Map(),
    secrets: [],
    containerHost: '127.0.0.1',
    region: 'us-east-1',
    envOverrides: undefined,
    roleArn: undefined,
    platformOverride: undefined,
    profileCredentialsFile: {
      hostPath: '/tmp/creds',
      containerPath: CONTAINER_AWS_CREDENTIALS_PATH,
      profileName: 'dev',
    },
  };

  it('under --aws-emulator: emulator keys only, no profile file, CA mounted, port to forward', () => {
    setActiveWorkloadAwsWiring(emulatorWiring());
    const built = buildDockerRunArgs(base as Parameters<typeof buildDockerRunArgs>[0]);
    const joined = built.args.join(' ');
    expect(joined).not.toContain('/tmp/creds');
    expect(envFlags(built.args).some((f) => f.startsWith('AWS_PROFILE'))).toBe(false);
    expect(envFlags(built.args)).toContain('AWS_ACCESS_KEY_ID');
    expect(built.sensitiveEnv['AWS_ACCESS_KEY_ID']).toBe(EMULATOR_KEYS.accessKeyId);
    expect(joined).not.toContain(EMULATOR_KEYS.secretAccessKey);
    expect(built.args).toContain(`/tmp/cdkd-ca-y/ca-bundle.pem:${CA_PATH}:ro`);
    expect(built.loopbackPorts).toEqual([9297]);
  });

  it('under forward mode: the template endpoint wins over the forwarded one', () => {
    setActiveWorkloadAwsWiring(
      forwardWiring({ env: { AWS_ENDPOINT_URL: 'https://127.0.0.1:4566' }, loopbackPorts: [4566] })
    );
    const built = buildDockerRunArgs(base as Parameters<typeof buildDockerRunArgs>[0]);
    expect(envFlags(built.args)).toContain('AWS_ENDPOINT_URL=https://127.0.0.1:9297');
    expect(built.args.join(' ')).toContain(`/tmp/creds:${CONTAINER_AWS_CREDENTIALS_PATH}:ro`);
    expect(built.loopbackPorts).toEqual([]);
  });

  it('with no wiring: no extra env, no forwarder ports', () => {
    setActiveWorkloadAwsWiring(undefined);
    const built = buildDockerRunArgs(base as Parameters<typeof buildDockerRunArgs>[0]);
    expect(built.loopbackPorts).toEqual([]);
    expect(built.args.join(' ')).not.toContain(CA_PATH);
  });
});

describe('run-task resolveSidecarCredentials', () => {
  it('serves the emulator keys under --aws-emulator, over --assume-task-role', async () => {
    setActiveWorkloadAwsWiring(emulatorWiring());
    await expect(
      resolveSidecarCredentials({}, { accessKeyId: 'ASIAROLE', secretAccessKey: 's' })
    ).resolves.toEqual(EMULATOR_KEYS);
    expect(mocks.hostDefaults).not.toHaveBeenCalled();
  });

  it('falls back to the host default chain with no credential flag (#6129)', async () => {
    mocks.hostDefaults.mockResolvedValue(HOST_KEYS);
    await expect(resolveSidecarCredentials({}, undefined)).resolves.toEqual(HOST_KEYS);
  });

  it('keeps --assume-task-role ahead of the default chain', async () => {
    const role = { accessKeyId: 'ASIAROLE', secretAccessKey: 's' };
    await expect(resolveSidecarCredentials({}, role)).resolves.toBe(role);
    expect(mocks.hostDefaults).not.toHaveBeenCalled();
  });
});

describe('ECS buildDockerRunArgs: forward entries and the CA mount', () => {
  const plain = {
    name: 'app',
    environment: {},
    secrets: [],
    portMappings: [],
    mountPoints: [],
    ulimits: [],
    links: [],
  } as unknown as ResolvedEcsContainer;
  const args = (container: ResolvedEcsContainer) =>
    buildDockerRunArgs({
      task: { family: 'fam', containers: [], volumes: [] } as unknown as ResolvedEcsTask,
      container,
      image: 'img',
      network: 'net',
      volumeByName: new Map(),
      secrets: [],
      containerHost: '127.0.0.1',
      region: 'us-east-1',
      envOverrides: undefined,
      roleArn: undefined,
      platformOverride: undefined,
    } as Parameters<typeof buildDockerRunArgs>[0]);

  it('injects the forwarded endpoint and trust variables, and forwards the loopback port', () => {
    setActiveWorkloadAwsWiring(forwardWiring());
    const built = args(plain);
    expect(envFlags(built.args)).toEqual(
      expect.arrayContaining([
        'AWS_ENDPOINT_URL=https://127.0.0.1:4566',
        `AWS_CA_BUNDLE=${CA_PATH}`,
        `SSL_CERT_FILE=${CA_PATH}`,
        'AWS_DEFAULT_REGION=us-east-1',
      ])
    );
    expect(built.args).toContain(`/tmp/cdkd-ca-x/ca-bundle.pem:${CA_PATH}:ro`);
    expect(built.loopbackPorts).toEqual([4566]);
  });

  it('does not mount the CA over a task MountPoint at the same path', () => {
    setActiveWorkloadAwsWiring(forwardWiring());
    const built = args({
      ...plain,
      mountPoints: [{ sourceVolume: 'v', containerPath: CA_PATH, readOnly: true }],
    } as unknown as ResolvedEcsContainer);
    expect(built.args).not.toContain(`/tmp/cdkd-ca-x/ca-bundle.pem:${CA_PATH}:ro`);
  });
});

describe('the REAL cdk-local wiring under --aws-emulator, end to end through runDetached', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cdkd-6132-home-'));
    const run = join(home, '.aws', 'emulator', '9297');
    mkdirSync(run, { recursive: true });
    writeFileSync(
      join(run, 'emulator_credentials'),
      '[default]\naws_access_key_id = EMULATORFILEKEY00000\naws_secret_access_key = emulator-file-secret\n'
    );
    writeFileSync(
      join(run, 'ca.pem'),
      '-----BEGIN CERTIFICATE-----\nMIIBemulator\n-----END CERTIFICATE-----\n'
    );
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('scrubs every real-credential variable, hands the run keys, mounts its CA', async () => {
    const wiring = await resolveWorkloadAwsWiring({
      awsEmulator: true,
      homeDir: home,
      env: {},
      probeHealth: async () => undefined,
    });
    setActiveWorkloadAwsWiring(wiring);
    await runDetached({
      image: 'img',
      mounts: [],
      env: {
        AWS_ACCESS_KEY_ID: 'REALHOSTKEYID0000000',
        AWS_SECRET_ACCESS_KEY: 'real-host-secret',
        AWS_ROLE_ARN: 'arn:aws:iam::111111111111:role/real',
        AWS_WEB_IDENTITY_TOKEN_FILE: '/real/token',
        AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.2/real',
        AWS_CONTAINER_AUTHORIZATION_TOKEN: 'real-auth-token',
        AWS_CONFIG_FILE: '/real/config',
      },
      cmd: [],
      hostPort: 9000,
    });
    const { args, env } = lastRun();
    const joined = args.join(' ');
    for (const leaked of [
      'REALHOSTKEYID0000000',
      'real-host-secret',
      'role/real',
      '/real/token',
      '169.254.170.2/real',
      'real-auth-token',
      '/real/config',
    ]) {
      expect(joined).not.toContain(leaked);
      expect(Object.values(env).join(' ')).not.toContain(leaked);
    }
    expect(env['AWS_ACCESS_KEY_ID']).toBe('EMULATORFILEKEY00000');
    const ca = wiring.mounts[0]!;
    expect(args).toContain(`${ca.hostPath}:${ca.containerPath}:ro`);
    expect(envFlags(args)).toContain(`AWS_CA_BUNDLE=${ca.containerPath}`);
    expect(envFlags(args)).toContain('AWS_ENDPOINT_URL=https://127.0.0.1:9297');
    wiring.dispose();
  });

  it('a --profile endpoint_url reaches the forward-mode wiring through activateLocalAwsWiring', async () => {
    const saved = { ...process.env };
    try {
      for (const k of Object.keys(process.env)) {
        if (k.startsWith('AWS_ENDPOINT_URL') || k === 'CDKD_AWS_EMULATOR' || k === 'AWS_CA_BUNDLE')
          delete process.env[k];
      }
      const config = join(home, 'config');
      writeFileSync(config, '[profile emu6132]\nendpoint_url = https://127.0.0.1:4566\n');
      process.env['AWS_CONFIG_FILE'] = config;
      await activateLocalAwsWiring({ profile: 'emu6132' });
      expect(getActiveWorkloadAwsWiring()?.env['AWS_ENDPOINT_URL']).toBe('https://127.0.0.1:4566');
    } finally {
      restoreProcessEnv(saved);
    }
  });
});

describe('local invoke-agentcore --sigv4 under --aws-emulator', () => {
  it('signs with the emulator keys, never a real identity', async () => {
    setActiveWorkloadAwsWiring(emulatorWiring());
    const creds = await resolveHostCredentialsForSigV4(
      { profile: 'real-profile' } as never,
      {} as never,
      undefined,
      'us-east-1'
    );
    expect(creds).toEqual(EMULATOR_KEYS);
  });
});

describe('profileCredentialsForWorkload (the --profile gate of invoke / start-api / invoke-agentcore)', () => {
  it('never resolves the real profile under --aws-emulator', async () => {
    setActiveWorkloadAwsWiring(emulatorWiring());
    const resolve = vi.fn(async () => HOST_KEYS);
    await expect(profileCredentialsForWorkload('dev', resolve)).resolves.toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('resolves it otherwise, and nothing without --profile', async () => {
    setActiveWorkloadAwsWiring(forwardWiring());
    const resolve = vi.fn(async () => HOST_KEYS);
    await expect(profileCredentialsForWorkload('dev', resolve)).resolves.toBe(HOST_KEYS);
    await expect(profileCredentialsForWorkload(undefined, resolve)).resolves.toBeUndefined();
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});

/** Restore the environment IN PLACE: replacing `process.env` unlinks it from the real one. */
function restoreProcessEnv(snapshot: Record<string, string | undefined>): void {
  for (const k of Object.keys(process.env)) if (!(k in snapshot)) delete process.env[k];
  for (const [k, v] of Object.entries(snapshot)) if (v !== undefined) process.env[k] = v;
}
