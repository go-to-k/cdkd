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

describe('CloudControlProvider import (CC API fallback)', () => {
  let provider: CloudControlProvider;

  beforeEach(() => {
    mockCloudControlSend.mockReset();
    mockCloudControlConfigRegion.mockReset();
    provider = new CloudControlProvider();
  });

  function makeInput(overrides: Partial<{ knownPhysicalId: string }> = {}) {
    return {
      logicalId: 'MyResource',
      resourceType: 'AWS::SES::EmailIdentity',
      cdkPath: 'MyStack/MyResource',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: {},
      ...overrides,
    };
  }

  it('returns null when no knownPhysicalId is supplied (no auto lookup)', async () => {
    // Even without sending a single CC API call, this returns null.
    const result = await provider.import(makeInput());

    expect(result).toBeNull();
    expect(mockCloudControlSend).not.toHaveBeenCalled();
  });

  it('with knownPhysicalId: GetResource succeeds and ResourceModel is parsed into attributes', async () => {
    mockCloudControlSend.mockResolvedValueOnce({
      ResourceDescription: {
        Identifier: 'user@example.com',
        Properties: JSON.stringify({
          EmailIdentity: 'user@example.com',
          DkimAttributes: { SigningEnabled: true },
          Arn: 'arn:aws:ses:us-east-1:123:identity/user@example.com',
        }),
      },
    });

    const result = await provider.import(makeInput({ knownPhysicalId: 'user@example.com' }));

    expect(result).toEqual({
      physicalId: 'user@example.com',
      attributes: {
        EmailIdentity: 'user@example.com',
        DkimAttributes: { SigningEnabled: true },
        Arn: 'arn:aws:ses:us-east-1:123:identity/user@example.com',
      },
    });
    expect(mockCloudControlSend).toHaveBeenCalledTimes(1);
  });

  it('with knownPhysicalId: ResourceNotFoundException -> null', async () => {
    const err = new Error('not found') as Error & { name: string };
    err.name = 'ResourceNotFoundException';
    mockCloudControlSend.mockRejectedValueOnce(err);

    const result = await provider.import(makeInput({ knownPhysicalId: 'missing-id' }));

    expect(result).toBeNull();
  });

  it('with knownPhysicalId: malformed ResourceModel JSON falls back to empty attributes', async () => {
    mockCloudControlSend.mockResolvedValueOnce({
      ResourceDescription: {
        Identifier: 'x',
        Properties: 'not-json{{{',
      },
    });

    const result = await provider.import(makeInput({ knownPhysicalId: 'x' }));

    // physicalId still returned — registering the resource is the
    // priority; missing attributes are reconstructed at deploy time.
    expect(result).toEqual({ physicalId: 'x', attributes: {} });
  });

  it('with knownPhysicalId: non-NotFound error is re-thrown', async () => {
    const err = new Error('AccessDenied') as Error & { name: string };
    err.name = 'AccessDeniedException';
    mockCloudControlSend.mockRejectedValueOnce(err);

    await expect(
      provider.import(makeInput({ knownPhysicalId: 'x' }))
    ).rejects.toThrow(/AccessDenied/);
  });
});
