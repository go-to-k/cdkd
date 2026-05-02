import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock AWS clients before importing the provider
const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sqs: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { SQSQueuePolicyProvider } from '../../../src/provisioning/providers/sqs-queue-policy-provider.js';

describe('SQSQueuePolicyProvider', () => {
  let provider: SQSQueuePolicyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SQSQueuePolicyProvider();
  });

  describe('import (explicit-override only)', () => {
    function makeInput(overrides: Partial<{ knownPhysicalId: string }> = {}) {
      return {
        logicalId: 'MyQueuePolicy',
        resourceType: 'AWS::SQS::QueuePolicy',
        cdkPath: 'MyStack/MyQueuePolicy',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {
          Queues: ['https://sqs.us-east-1.amazonaws.com/123456789012/my-queue'],
          PolicyDocument: { Version: '2012-10-17', Statement: [] },
        },
        ...overrides,
      };
    }

    it('returns physicalId when knownPhysicalId is supplied (no AWS calls)', async () => {
      const queueUrl = 'https://sqs.us-east-1.amazonaws.com/123456789012/my-queue';
      const result = await provider.import(makeInput({ knownPhysicalId: queueUrl }));

      expect(result).toEqual({ physicalId: queueUrl, attributes: {} });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns null when knownPhysicalId is not supplied (no auto lookup)', async () => {
      const result = await provider.import(makeInput());

      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
