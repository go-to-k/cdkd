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

import { SNSTopicProvider } from '../../../src/provisioning/providers/sns-topic-provider.js';

describe('SNSTopicProvider.getAttribute', () => {
  let provider: SNSTopicProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SNSTopicProvider();
  });

  it('returns TopicArn from physicalId without an AWS call', async () => {
    const arn = 'arn:aws:sns:us-east-1:123456789012:my-topic';
    const result = await provider.getAttribute(arn, 'AWS::SNS::Topic', 'TopicArn');
    expect(result).toBe(arn);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns TopicName derived from ARN tail', async () => {
    const arn = 'arn:aws:sns:us-east-1:123456789012:my-topic';
    const result = await provider.getAttribute(arn, 'AWS::SNS::Topic', 'TopicName');
    expect(result).toBe('my-topic');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns undefined for unknown attribute', async () => {
    const arn = 'arn:aws:sns:us-east-1:123456789012:my-topic';
    const result = await provider.getAttribute(arn, 'AWS::SNS::Topic', 'Unknown');
    expect(result).toBeUndefined();
  });
});
