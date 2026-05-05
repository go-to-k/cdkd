import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GetLayerVersionByArnCommand, ResourceNotFoundException } from '@aws-sdk/client-lambda';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { LambdaLayerVersionProvider } from '../../../src/provisioning/providers/lambda-layer-provider.js';

describe('LambdaLayerVersionProvider.readCurrentState', () => {
  let provider: LambdaLayerVersionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LambdaLayerVersionProvider();
  });

  it('returns CFn-shaped properties from GetLayerVersionByArn (happy path)', async () => {
    mockSend.mockResolvedValueOnce({
      LayerVersionArn: 'arn:aws:lambda:us-east-1:123:layer:my-layer:5',
      Description: 'utility layer',
      CompatibleRuntimes: ['nodejs20.x', 'nodejs18.x'],
      CompatibleArchitectures: ['x86_64'],
      LicenseInfo: 'MIT',
      Content: { Location: 'https://...', CodeSha256: 'abc' }, // not surfaced
      CreatedDate: '2026-01-01T00:00:00.000+0000',
    });

    const arn = 'arn:aws:lambda:us-east-1:123:layer:my-layer:5';
    const result = await provider.readCurrentState(arn, 'Logical', 'AWS::Lambda::LayerVersion');

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetLayerVersionByArnCommand);
    expect(result).toEqual({
      LayerName: 'my-layer',
      Description: 'utility layer',
      CompatibleRuntimes: ['nodejs20.x', 'nodejs18.x'],
      CompatibleArchitectures: ['x86_64'],
      LicenseInfo: 'MIT',
    });
  });

  it('returns undefined when layer version gone', async () => {
    mockSend.mockRejectedValueOnce(
      new ResourceNotFoundException({ message: 'gone', $metadata: {} })
    );

    const arn = 'arn:aws:lambda:us-east-1:123:layer:my-layer:5';
    const result = await provider.readCurrentState(arn, 'Logical', 'AWS::Lambda::LayerVersion');
    expect(result).toBeUndefined();
  });

  it('omits empty Description / LicenseInfo / arrays', async () => {
    mockSend.mockResolvedValueOnce({
      LayerVersionArn: 'arn:aws:lambda:us-east-1:123:layer:my-layer:5',
      Description: '',
      LicenseInfo: '',
      CompatibleRuntimes: [],
      CompatibleArchitectures: [],
    });

    const arn = 'arn:aws:lambda:us-east-1:123:layer:my-layer:5';
    const result = await provider.readCurrentState(arn, 'Logical', 'AWS::Lambda::LayerVersion');
    expect(result).toEqual({ LayerName: 'my-layer' });
  });
});
