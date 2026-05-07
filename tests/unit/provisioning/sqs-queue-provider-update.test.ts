import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';

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

describe('SQSQueueProvider.update', () => {
  let provider: SQSQueueProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SQSQueueProvider();
  });

  it('translates RedrivePolicy: {} to "" so SQS clears the DLQ instead of rejecting', async () => {
    // Regression for the user-reported `cdkd drift --revert` failure:
    // "Value {} for parameter RedrivePolicy is invalid. Reason:
    // Redrive policy does not contain mandatory attribute:
    // maxReceiveCount." — readCurrentState always-emits
    // RedrivePolicy: {} as a placeholder for queues without a DLQ,
    // and --revert round-trips that value through update(). The
    // fix translates the empty placeholder to "" (the documented SQS
    // way to clear RedrivePolicy on the queue).
    mockSend.mockResolvedValueOnce({}); // SetQueueAttributes
    mockSend.mockResolvedValueOnce({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:0:q' } });

    await provider.update(
      'L',
      QUEUE_URL,
      'AWS::SQS::Queue',
      { VisibilityTimeout: 30, RedrivePolicy: {} },
      { VisibilityTimeout: 130, RedrivePolicy: {} }
    );

    const setAttrsCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof SetQueueAttributesCommand
    );
    expect(setAttrsCall).toBeDefined();
    const input = setAttrsCall![0].input as { Attributes: Record<string, string> };
    // Empty object placeholder -> "" (clear DLQ), not "{}" (which AWS rejects).
    expect(input.Attributes['RedrivePolicy']).toBe('');
    expect(input.Attributes['VisibilityTimeout']).toBe('30');
  });

  it('serialises a real RedrivePolicy object to canonical JSON', async () => {
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:0:q' } });

    const redrive = {
      deadLetterTargetArn: 'arn:aws:sqs:us-east-1:0:dlq',
      maxReceiveCount: 5,
    };

    await provider.update(
      'L',
      QUEUE_URL,
      'AWS::SQS::Queue',
      { RedrivePolicy: redrive },
      {}
    );

    const setAttrsCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof SetQueueAttributesCommand
    );
    expect(setAttrsCall).toBeDefined();
    const input = setAttrsCall![0].input as { Attributes: Record<string, string> };
    expect(input.Attributes['RedrivePolicy']).toBe(JSON.stringify(redrive));
  });

  it('issues GetQueueAttributes for the QueueArn after the update', async () => {
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:0:q' } });

    const result = await provider.update(
      'L',
      QUEUE_URL,
      'AWS::SQS::Queue',
      { VisibilityTimeout: 30 },
      {}
    );

    expect(result.attributes?.['Arn']).toBe('arn:aws:sqs:us-east-1:0:q');
    expect(mockSend.mock.calls.some((c) => c[0] instanceof GetQueueAttributesCommand)).toBe(true);
  });
});
