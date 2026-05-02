import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock AWS clients before importing the provider
const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sns: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { SNSTopicPolicyProvider } from '../../../src/provisioning/providers/sns-topic-policy-provider.js';

describe('SNSTopicPolicyProvider', () => {
  let provider: SNSTopicPolicyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SNSTopicPolicyProvider();
  });

  describe('import (explicit-override only)', () => {
    function makeInput(overrides: Partial<{ knownPhysicalId: string }> = {}) {
      return {
        logicalId: 'MyTopicPolicy',
        resourceType: 'AWS::SNS::TopicPolicy',
        cdkPath: 'MyStack/MyTopicPolicy',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {
          Topics: ['arn:aws:sns:us-east-1:123456789012:my-topic'],
          PolicyDocument: { Version: '2012-10-17', Statement: [] },
        },
        ...overrides,
      };
    }

    it('returns physicalId when knownPhysicalId is supplied (no AWS calls)', async () => {
      const physicalId = 'arn:aws:sns:us-east-1:123456789012:my-topic';
      const result = await provider.import(makeInput({ knownPhysicalId: physicalId }));

      expect(result).toEqual({ physicalId, attributes: {} });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns null when knownPhysicalId is not supplied (no auto lookup)', async () => {
      const result = await provider.import(makeInput());

      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
