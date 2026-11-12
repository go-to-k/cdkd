import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mockCloudControlSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: { send: mockCloudControlSend, config: { region: async () => 'us-east-1' } },
  }),
}));

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import {
  resetAwsClientDefaults,
  setAwsEndpointOverrideSource,
} from '../../../src/utils/aws-client-defaults.js';

/**
 * go-to-k/cdkd#6138: the Cloud Control status poll uses a short FIXED interval
 * under `--aws-emulator` only; the real-AWS backoff is unchanged.
 */
describe('Cloud Control poll schedule', () => {
  let provider: CloudControlProvider;
  let sleeps: number[];

  beforeEach(() => {
    mockCloudControlSend.mockReset();
    provider = new CloudControlProvider();
    sleeps = [];
    vi.spyOn(
      provider as unknown as { sleep: (ms: number) => Promise<void> },
      'sleep'
    ).mockImplementation((ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    });
    // Six IN_PROGRESS answers, then SUCCESS.
    let poll = 0;
    mockCloudControlSend.mockImplementation(() =>
      Promise.resolve({
        ProgressEvent: { OperationStatus: poll++ < 6 ? 'IN_PROGRESS' : 'SUCCESS', Identifier: 'x' },
      })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setAwsEndpointOverrideSource(undefined);
    resetAwsClientDefaults();
  });

  async function waitAndRecord(): Promise<number[]> {
    await provider.waitForOperation('token', 'Res', 'CREATE', 'AWS::Logs::MetricFilter');
    return sleeps;
  }

  it('real AWS: the 1s x1.5 backoff, unchanged', async () => {
    expect(await waitAndRecord()).toEqual([1000, 1500, 2250, 3375, 5063, 7595]);
  });

  it('real AWS with a source registered but no emulator active: unchanged', async () => {
    setAwsEndpointOverrideSource(() => undefined);
    expect(await waitAndRecord()).toEqual([1000, 1500, 2250, 3375, 5063, 7595]);
  });

  it('--aws-emulator: a fixed short interval', async () => {
    setAwsEndpointOverrideSource(() => ({ endpoint: 'https://127.0.0.1:9297' }));
    const fixed = provider.EMULATOR_POLL_INTERVAL_MS;
    expect(fixed).toBeLessThan(provider.INITIAL_POLL_INTERVAL_MS);
    expect(await waitAndRecord()).toEqual([fixed, fixed, fixed, fixed, fixed, fixed]);
  });
});
