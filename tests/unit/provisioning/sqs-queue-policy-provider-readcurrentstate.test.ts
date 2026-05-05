import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';

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

describe('SQSQueuePolicyProvider.readCurrentState', () => {
  let provider: SQSQueuePolicyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SQSQueuePolicyProvider();
  });

  it('returns Queues + JSON-parsed PolicyDocument (happy path)', async () => {
    const policy = {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: '*', Action: 'sqs:SendMessage' }],
    };
    mockSend.mockResolvedValueOnce({ Attributes: { Policy: JSON.stringify(policy) } });

    const queueUrl = 'https://sqs.us-east-1.amazonaws.com/123/my-queue';
    const result = await provider.readCurrentState(
      queueUrl,
      'Logical',
      'AWS::SQS::QueuePolicy'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetQueueAttributesCommand);
    expect(result).toEqual({
      Queues: [queueUrl],
      PolicyDocument: policy,
    });
  });

  it('returns undefined when queue gone', async () => {
    const err = new Error('not found');
    (err as { name?: string }).name = 'QueueDoesNotExist';
    mockSend.mockRejectedValueOnce(err);

    const result = await provider.readCurrentState(
      'https://sqs.us-east-1.amazonaws.com/123/my-queue',
      'Logical',
      'AWS::SQS::QueuePolicy'
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when queue has no policy attached', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: {} });

    const result = await provider.readCurrentState(
      'https://sqs.us-east-1.amazonaws.com/123/my-queue',
      'Logical',
      'AWS::SQS::QueuePolicy'
    );
    expect(result).toBeUndefined();
  });
});
