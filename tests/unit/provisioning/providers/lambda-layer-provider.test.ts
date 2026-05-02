import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GetLayerVersionByArnCommand, ListLayersCommand } from '@aws-sdk/client-lambda';

const mockSend = vi.fn();
vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockSend, config: { region: () => 'us-east-1' } },
  }),
}));
vi.mock('../../../../src/utils/logger.js', () => {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() };
  return { getLogger: () => ({ child: () => child, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) };
});

import { LambdaLayerVersionProvider } from '../../../../src/provisioning/providers/lambda-layer-provider.js';

describe('LambdaLayerVersionProvider — import', () => {
  let provider: LambdaLayerVersionProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LambdaLayerVersionProvider();
  });

  const ARN = 'arn:aws:lambda:us-east-1:123456789012:layer:my-layer:3';

  function makeInput(overrides: Record<string, unknown> = {}) {
    return {
      logicalId: 'MyLayer',
      resourceType: 'AWS::Lambda::LayerVersion',
      cdkPath: 'MyStack/MyLayer',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: {} as Record<string, unknown>,
      ...overrides,
    };
  }

  it('verifies explicit ARN via GetLayerVersionByArn', async () => {
    mockSend.mockResolvedValueOnce({ LayerVersionArn: ARN });
    const result = await provider.import!(makeInput({ knownPhysicalId: ARN }));
    expect(result).toEqual({ physicalId: ARN, attributes: {} });
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(GetLayerVersionByArnCommand);
  });

  it('finds latest layer version by aws:cdk:path tag (Lambda map shape)', async () => {
    const layerArn = 'arn:aws:lambda:us-east-1:123:layer:my-layer';
    mockSend
      .mockResolvedValueOnce({
        Layers: [
          {
            LayerArn: layerArn,
            LatestMatchingVersion: { LayerVersionArn: ARN },
          },
        ],
        IsTruncated: false,
      })
      // ListTags returns a Record<string, string> map for Lambda
      .mockResolvedValueOnce({ Tags: { 'aws:cdk:path': 'MyStack/MyLayer' } });
    const result = await provider.import!(makeInput());
    expect(result).toEqual({ physicalId: ARN, attributes: {} });
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(ListLayersCommand);
  });

  it('returns null when no layer matches', async () => {
    mockSend
      .mockResolvedValueOnce({
        Layers: [
          {
            LayerArn: 'arn:aws:lambda:us-east-1:123:layer:other',
            LatestMatchingVersion: { LayerVersionArn: 'other-arn' },
          },
        ],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({ Tags: { 'aws:cdk:path': 'OtherStack/X' } });
    const result = await provider.import!(makeInput());
    expect(result).toBeNull();
  });
});
