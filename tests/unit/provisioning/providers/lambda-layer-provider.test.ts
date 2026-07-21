import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { GetLayerVersionByArnCommand } from '@aws-sdk/client-lambda';

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

  // Issue #1134: the aws:cdk:path tag walk is removed. AWS rejects
  // aws:-prefixed tag writes, so that tag never exists on a real resource and
  // the walk could not match. Without an explicit ARN, import() returns null
  // with no AWS call.
  it('returns null without any AWS call when no explicit ARN is given', async () => {
    const result = await provider.import!(makeInput());
    expect(result).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
