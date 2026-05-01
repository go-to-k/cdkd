import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCloudControlSend = vi.fn();
const mockCloudControlConfigRegion = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: {
      send: mockCloudControlSend,
      // config.region is consulted by region-check.ts before treating
      // ResourceNotFoundException as idempotent delete success.
      config: { region: mockCloudControlConfigRegion },
    },
    dynamoDB: { send: vi.fn() },
    apiGateway: { send: vi.fn() },
    cloudFront: { send: vi.fn() },
    lambda: { send: vi.fn() },
  }),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: () =>
    Promise.resolve({ partition: 'aws', region: 'us-east-1', accountId: '123456789012' }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => {
    const child = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(() => child),
    };
    return {
      child: () => child,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  },
}));

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';

describe('CloudControlProvider delete region verification', () => {
  let provider: CloudControlProvider;

  beforeEach(() => {
    mockCloudControlSend.mockReset();
    mockCloudControlConfigRegion.mockReset();
    mockCloudControlConfigRegion.mockResolvedValue('us-east-1');
    provider = new CloudControlProvider();
  });

  it('treats ResourceNotFoundException as success when client region matches expectedRegion', async () => {
    mockCloudControlSend.mockRejectedValueOnce(
      Object.assign(new Error('Resource not found'), { name: 'ResourceNotFoundException' })
    );

    await expect(
      provider.delete(
        'MyTopic',
        'arn:aws:sns:us-east-1:123:t',
        'AWS::SNS::Topic',
        {},
        { expectedRegion: 'us-east-1' }
      )
    ).resolves.toBeUndefined();
  });

  it('throws ProvisioningError on ResourceNotFoundException when client region differs from expectedRegion', async () => {
    mockCloudControlSend.mockRejectedValueOnce(
      Object.assign(new Error('Resource not found'), { name: 'ResourceNotFoundException' })
    );

    await expect(
      provider.delete(
        'MyTopic',
        'arn:aws:sns:us-east-1:123:t',
        'AWS::SNS::Topic',
        {},
        { expectedRegion: 'us-west-2' }
      )
    ).rejects.toThrow(/us-east-1.*us-west-2|us-west-2.*us-east-1/);
  });

  it('preserves existing idempotent NotFound behavior when context is omitted', async () => {
    mockCloudControlSend.mockRejectedValueOnce(
      Object.assign(new Error('Resource not found'), { name: 'ResourceNotFoundException' })
    );

    await expect(
      provider.delete('MyTopic', 'arn:aws:sns:us-east-1:123:t', 'AWS::SNS::Topic', {})
    ).resolves.toBeUndefined();
  });

  it('also accepts message-pattern NotFound matches with region check', async () => {
    // CC API surfaces some not-found cases via message rather than name.
    mockCloudControlSend.mockRejectedValueOnce(new Error('Topic does not exist'));

    await expect(
      provider.delete(
        'MyTopic',
        'arn:aws:sns:us-east-1:123:t',
        'AWS::SNS::Topic',
        {},
        { expectedRegion: 'eu-west-1' }
      )
    ).rejects.toThrow(/eu-west-1/);
  });
});
