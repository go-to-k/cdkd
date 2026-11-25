import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue #6975: `AWS::EMR::Cluster` has Cloud Control handlers, so a cluster can
 * be Cloud Control-routed. `TerminationProtected` makes `DeleteResource` fail,
 * so under `--remove-protection` the delete is handed to the SDK
 * `EMRClusterProvider` (which flips protection off, then terminates), and its
 * verdict is propagated. Without the flag the delete stays on Cloud Control.
 */

const mockCloudControlSend = vi.hoisted(() => vi.fn());
const mockEmrDelete = vi.hoisted(() => vi.fn());

vi.mock('../../../src/provisioning/providers/emr-cluster-provider.js', () => ({
  EMRClusterProvider: vi.fn(() => ({ delete: mockEmrDelete })),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: {
      send: mockCloudControlSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) {
      return this;
    }),
  };
  return { getLogger: () => ({ ...child, child: () => child }) };
});

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';

const TYPE = 'AWS::EMR::Cluster';
const ID = 'j-ABC123';

describe('a protected Cloud Control-routed EMR cluster is deleted through its SDK provider (#6975)', () => {
  let provider: CloudControlProvider;

  beforeEach(() => {
    provider = new CloudControlProvider();
  });

  it('hands the delete to EMRClusterProvider under --remove-protection, sending no Cloud Control call', async () => {
    mockEmrDelete.mockResolvedValue(undefined);
    const context = { removeProtection: true, expectedRegion: 'us-east-1' };

    await provider.delete('Cluster', ID, TYPE, { Name: 'c' }, context);

    expect(mockEmrDelete).toHaveBeenCalledWith('Cluster', ID, TYPE, { Name: 'c' }, context);
    expect(mockCloudControlSend).not.toHaveBeenCalled();
  });

  it("propagates the delegate's skip", async () => {
    const skipped = { outcome: 'skipped' as const, reason: 'not addressable' };
    mockEmrDelete.mockResolvedValue(skipped);

    await expect(
      provider.delete('Cluster', ID, TYPE, {}, { removeProtection: true, expectedRegion: 'us-east-1' })
    ).resolves.toEqual(skipped);
  });

  it('keeps the delete on Cloud Control without --remove-protection', async () => {
    mockCloudControlSend.mockRejectedValue(new Error('stop after the first Cloud Control call'));

    await provider
      .delete('Cluster', ID, TYPE, {}, { expectedRegion: 'us-east-1' })
      .catch(() => undefined);

    expect(mockEmrDelete).not.toHaveBeenCalled();
    expect(mockCloudControlSend).toHaveBeenCalled();
  });
});
