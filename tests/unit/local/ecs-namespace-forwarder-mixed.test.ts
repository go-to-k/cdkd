import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// go-to-k/cdkd#6150: `run-task`'s namespace-owner forwarder in AWS Emulator
// mixed mode. A container whose env uses the re-signing sidecar's port gets
// the sidecar config instead of a TCP forward for that port, and a forwarder
// failure is then fatal (the container asked for the emulator); a container
// that does not use the sidecar keeps forward mode's warn-and-continue.

vi.mock('../../../src/utils/logger.js', () => {
  const leaf = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => leaf,
  };
  return { getLogger: () => leaf };
});

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  buildArgs: vi.fn(),
  status: vi.fn(),
  ensureImage: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: (...allArgs: unknown[]) => {
      const cb = allArgs[allArgs.length - 1] as (err: unknown, out?: { stdout: string }) => void;
      mocks.execFile(allArgs[0], allArgs[1]);
      cb(null, { stdout: 'fwd-id\n' });
    },
  };
});

vi.mock('cdk-local/internal', async () => {
  const actual = await vi.importActual<typeof import('cdk-local/internal')>('cdk-local/internal');
  return {
    ...actual,
    buildNamespaceOwnerForwarderDockerArgs: mocks.buildArgs,
    awaitLoopbackForwarderStatus: mocks.status,
    ensureForwarderImage: mocks.ensureImage,
  };
});

import type { WorkloadAwsWiring } from 'cdk-local/internal';
import { startNamespaceForwarder } from '../../../src/local/ecs-task-runner/loopback-forwarder.js';
import type { EcsRunState } from '../../../src/local/ecs-task-runner/types.js';

const RESIGN_CONFIG = '/tmp/cdkd-resign-x/resign.json';

function mixedWiring(): WorkloadAwsWiring {
  return {
    mode: 'forward',
    env: {},
    scrubEnvKeys: [],
    mounts: [],
    loopbackPorts: [9297, 47297],
    probeHealth: true,
    caHostPath: '/tmp/cdkd-ca-x/ca-bundle.pem',
    dispose: () => {},
    mixed: {
      realServices: ['DYNAMODB'],
      emulatorCredentials: { accessKeyId: 'EMULATORKEY000000000', secretAccessKey: 'e' },
      emulatorEndpoint: { url: 'https://127.0.0.1:9297', hostname: '127.0.0.1', port: 9297, loopback: true },
      resignPort: 47297,
      resignEndpoint: 'https://127.0.0.1:47297',
      resignConfigHostPath: RESIGN_CONFIG,
      emulatorClientOverride: { endpoint: 'https://127.0.0.1:9297' },
    },
  };
}

function freshState(): EcsRunState {
  return {
    network: undefined,
    dockerVolumeNames: [],
    startedContainers: [],
    forwarders: [],
  } as unknown as EcsRunState;
}

const forwarder = { name: 'fwd', container: 'app-1', namespace: { network: 'net' } };

beforeEach(() => {
  mocks.execFile.mockReset();
  mocks.buildArgs.mockReset();
  mocks.status.mockReset();
  mocks.ensureImage.mockReset();
  mocks.buildArgs.mockReturnValue(['run', '-d', 'fwd']);
  mocks.ensureImage.mockResolvedValue(undefined);
});

describe('startNamespaceForwarder in AWS Emulator mixed mode', () => {
  it('hands the sidecar config to the forwarder and forwards only the other ports over TCP', async () => {
    mocks.status.mockResolvedValue({ ok: true });
    const state = freshState();
    await expect(
      startNamespaceForwarder(state, forwarder, 'app', [9297, 47297], mixedWiring())
    ).resolves.toBe(true);
    expect(mocks.buildArgs).toHaveBeenCalledWith(
      expect.objectContaining({ ports: [9297], resignConfigHostPath: RESIGN_CONFIG })
    );
  });

  it('a container using the sidecar fails the run when its forwarder reports FAIL', async () => {
    mocks.status.mockResolvedValue({ ok: false, failedPort: 47297, reason: 'RESIGN_EADDRINUSE' });
    const err = await startNamespaceForwarder(
      freshState(),
      forwarder,
      'app',
      [9297, 47297],
      mixedWiring()
    ).catch((e: unknown) => e);
    expect((err as Error).message).toContain('--aws-emulator https://127.0.0.1:9297 (mixed mode)');
    expect((err as { code?: string }).code).toBe('LOCAL_AWS_EMULATOR_FORWARDER_FAILED');
  });

  it('a container using the sidecar fails the run when its forwarder never reports', async () => {
    mocks.status.mockRejectedValue(new Error('forwarder exited before reporting'));
    const err = await startNamespaceForwarder(
      freshState(),
      forwarder,
      'app',
      [9297, 47297],
      mixedWiring()
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('LOCAL_AWS_EMULATOR_FORWARDER_FAILED');
    expect((err as Error).message).toContain('(mixed mode)');
  });

  it('a container NOT using the sidecar gets no sidecar config and keeps warn-and-continue', async () => {
    mocks.status.mockResolvedValue({ ok: false, failedPort: 9297, reason: 'ECONNREFUSED' });
    await expect(
      startNamespaceForwarder(freshState(), forwarder, 'app', [9297], mixedWiring())
    ).resolves.toBe(false);
    const opts = mocks.buildArgs.mock.calls[0]![0] as { ports: number[]; resignConfigHostPath?: string };
    expect(opts.ports).toEqual([9297]);
    expect(opts.resignConfigHostPath).toBeUndefined();
  });

  it('full --aws-emulator mode with the SQS sidecar: the forwarder gets the sidecar config, never a TCP forward of its port (cdkd#6178)', async () => {
    mocks.status.mockResolvedValue({ ok: true });
    const wiring = {
      mode: 'emulator',
      env: {},
      scrubEnvKeys: [],
      mounts: [],
      loopbackPorts: [9297, 47297],
      probeHealth: true,
      caHostPath: '/tmp/cdkd-ca-x/ca-bundle.pem',
      dispose: () => {},
      emulatorEndpoint: { url: 'https://127.0.0.1:9297', hostname: '127.0.0.1', port: 9297, loopback: true },
      sidecar: {
        port: 47297,
        endpoint: 'https://127.0.0.1:47297',
        upstream: { url: 'https://127.0.0.1:9297', hostname: '127.0.0.1', port: 9297, loopback: true },
        configHostPath: '/tmp/cdkd-sqs-x/resign.json',
        passthrough: true,
      },
    } as unknown as WorkloadAwsWiring;
    await startNamespaceForwarder(freshState(), forwarder, 'app', [9297, 47297], wiring);
    expect(mocks.buildArgs).toHaveBeenCalledWith(
      expect.objectContaining({ ports: [9297], resignConfigHostPath: '/tmp/cdkd-sqs-x/resign.json' })
    );
  });
});
