import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GetQueueAttributesCommand,
  QueueDoesNotExist,
} from '@aws-sdk/client-sqs';

// Mock AWS clients before importing the provider
const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sqs: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    sts: { send: vi.fn() },
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

import { SQSQueueProvider } from '../../../src/provisioning/providers/sqs-queue-provider.js';

const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/my-queue';

describe('SQSQueueProvider.getAttribute', () => {
  let provider: SQSQueueProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SQSQueueProvider();
  });

  it('returns QueueUrl from physicalId without an AWS call', async () => {
    const result = await provider.getAttribute(QUEUE_URL, 'AWS::SQS::Queue', 'QueueUrl');
    expect(result).toBe(QUEUE_URL);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns QueueName derived from URL tail', async () => {
    const result = await provider.getAttribute(QUEUE_URL, 'AWS::SQS::Queue', 'QueueName');
    expect(result).toBe('my-queue');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns Arn from GetQueueAttributes', async () => {
    mockSend.mockResolvedValueOnce({
      Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:123456789012:my-queue' },
    });

    const result = await provider.getAttribute(QUEUE_URL, 'AWS::SQS::Queue', 'Arn');

    expect(result).toBe('arn:aws:sqs:us-east-1:123456789012:my-queue');
    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetQueueAttributesCommand);
  });

  it('returns undefined when queue not found', async () => {
    mockSend.mockRejectedValueOnce(
      new QueueDoesNotExist({ message: 'not found', $metadata: {} })
    );

    const result = await provider.getAttribute(QUEUE_URL, 'AWS::SQS::Queue', 'Arn');
    expect(result).toBeUndefined();
  });

  it('returns undefined for unknown attribute', async () => {
    const result = await provider.getAttribute(QUEUE_URL, 'AWS::SQS::Queue', 'Unknown');
    expect(result).toBeUndefined();
  });
});
