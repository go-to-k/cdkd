import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const mockResolve = vi.fn();
vi.mock('cdk-local/internal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('cdk-local/internal')>();
  return { ...actual, resolveWorkloadAwsWiring: (...a: unknown[]) => mockResolve(...a) };
});

import {
  getAwsEndpointOverride,
  setActiveWorkloadAwsWiring,
  setAwsEndpointOverride,
} from 'cdk-local/internal';
import { activateAwsEmulatorForCommand } from '../../../src/cli/aws-emulator-activation.js';
import { CdkdError } from '../../../src/utils/error-handler.js';
import { getLogger } from '../../../src/utils/logger.js';

/**
 * go-to-k/cdkd#6138: a NON-local command's `--aws-emulator` activation —
 * its own error code and wording, never `cdkd local`'s.
 */
afterEach(() => {
  mockResolve.mockReset();
  setAwsEndpointOverride(undefined);
  setActiveWorkloadAwsWiring(undefined);
});

describe('activateAwsEmulatorForCommand', () => {
  it('installs the endpoint, CA and keys as the override, and says so without "workload container"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-emu-act-'));
    const ca = join(dir, 'ca.pem');
    writeFileSync(ca, 'PEM');
    mockResolve.mockResolvedValueOnce({
      mode: 'emulator',
      emulatorEndpoint: { url: 'https://127.0.0.1:9331', port: 9331 },
      caHostPath: ca,
      emulatorCredentials: { accessKeyId: 'EMU', secretAccessKey: 's' },
      env: {},
      scrubEnvKeys: [],
      mounts: [],
      loopbackPorts: [],
      probeHealth: true,
      dispose: () => {},
    });
    const info = vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
    try {
      await activateAwsEmulatorForCommand('https://127.0.0.1:9331');
      expect(mockResolve).toHaveBeenCalledWith(
        expect.objectContaining({ awsEmulator: 'https://127.0.0.1:9331', skipPull: true })
      );
      expect(getAwsEndpointOverride()).toEqual({
        endpoint: 'https://127.0.0.1:9331',
        caPem: 'PEM',
        credentials: { accessKeyId: 'EMU', secretAccessKey: 's' },
      });
      const lines = info.mock.calls.map((c) => String(c[0]));
      expect(lines).toEqual(['Using AWS Emulator at https://127.0.0.1:9331 for every AWS call.']);
    } finally {
      info.mockRestore();
    }
  });

  it('an unreachable emulator is AWS_EMULATOR_UNAVAILABLE, not the cdkd local code', async () => {
    mockResolve.mockRejectedValueOnce(new Error('--aws-emulator https://127.0.0.1:1: no AWS Emulator answers'));
    const err = await activateAwsEmulatorForCommand('https://127.0.0.1:1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CdkdError);
    expect((err as CdkdError).code).toBe('AWS_EMULATOR_UNAVAILABLE');
    expect((err as CdkdError).message).toMatch(/no AWS Emulator answers/);
    expect(getAwsEndpointOverride()).toBeUndefined();
  });
});
