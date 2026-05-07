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

  it('round-trip: readCurrentState placeholders survive update() without AWS-invalid inputs', async () => {
    // Mechanical guard for Class 2 placeholder regression. See
    // docs/provider-development.md § 3b "Read-update round-trip test".
    //
    // 1. AWS-minimum response (queue with no DLQ, no KMS, no tags)
    //    triggers the always-emit placeholders that BIT us in PR #161.
    mockSend.mockResolvedValueOnce({
      Attributes: { VisibilityTimeout: '30', DelaySeconds: '0' },
    });
    mockSend.mockResolvedValueOnce({ Tags: {} });

    const observed = await provider.readCurrentState(QUEUE_URL, 'L', 'AWS::SQS::Queue');
    // Spot-check the Class 2 placeholder is present (the always-emit
    // contract — see § 3b "emits placeholders for every user-controllable
    // top-level key").
    expect(observed?.['RedrivePolicy']).toEqual({});
    expect(observed?.['KmsMasterKeyId']).toBe('');

    // 2. Round-trip the snapshot through update(). No drift → AWS
    //    state should not change.
    vi.clearAllMocks();
    mockSend.mockResolvedValueOnce({}); // SetQueueAttributesCommand
    mockSend.mockResolvedValueOnce({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:0:q' } });

    await provider.update('L', QUEUE_URL, 'AWS::SQS::Queue', observed!, observed!);

    // 3. Assert no AWS-rejection-shaped values reached the SDK.
    const setAttrsCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof SetQueueAttributesCommand
    );
    expect(setAttrsCall).toBeDefined();
    const attrs = (setAttrsCall![0].input as { Attributes: Record<string, string> }).Attributes;
    // Class 2: empty-object RedrivePolicy must NEVER be sent as "{}"
    // — AWS rejects with "Redrive policy does not contain mandatory
    // attribute: maxReceiveCount". `serializeRedrivePolicy` translates
    // {} -> "" (the documented "clear" form).
    if (attrs['RedrivePolicy'] !== undefined) {
      expect(attrs['RedrivePolicy']).not.toBe('{}');
    }
  });
});
