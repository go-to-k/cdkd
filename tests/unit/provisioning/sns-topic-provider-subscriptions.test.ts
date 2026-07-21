import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTopicCommand,
  DeleteTopicCommand,
  SubscribeCommand,
  UnsubscribeCommand,
  ListSubscriptionsByTopicCommand,
} from '@aws-sdk/client-sns';

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

const TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:my-topic';
const QUEUE_ARN_A = 'arn:aws:sqs:us-east-1:123456789012:queue-a';
const QUEUE_ARN_B = 'arn:aws:sqs:us-east-1:123456789012:queue-b';

describe('SNSTopicProvider inline Subscription (issue #980)', () => {
  let provider: SNSTopicProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SNSTopicProvider();
  });

  it('create() Subscribes for each entry in the Subscription list', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd instanceof CreateTopicCommand) {
        return Promise.resolve({ TopicArn: TOPIC_ARN });
      }
      if (cmd instanceof SubscribeCommand) {
        return Promise.resolve({ SubscriptionArn: 'arn:...:sub' });
      }
      return Promise.resolve({});
    });

    await provider.create('MyTopic', 'AWS::SNS::Topic', {
      TopicName: 'my-topic',
      Subscription: [
        { Protocol: 'sqs', Endpoint: QUEUE_ARN_A },
        { Protocol: 'sqs', Endpoint: QUEUE_ARN_B, RawMessageDelivery: true },
      ],
    });

    const subCalls = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof SubscribeCommand);
    expect(subCalls).toHaveLength(2);
    expect(subCalls[0].input).toMatchObject({
      TopicArn: TOPIC_ARN,
      Protocol: 'sqs',
      Endpoint: QUEUE_ARN_A,
    });
    expect(subCalls[1].input).toMatchObject({
      TopicArn: TOPIC_ARN,
      Protocol: 'sqs',
      Endpoint: QUEUE_ARN_B,
      Attributes: { RawMessageDelivery: 'true' },
    });
  });

  it('create() deletes the topic when an inline Subscribe fails (no orphan)', async () => {
    // The subscribe loop runs INSIDE the create() wiring try/catch, so a
    // mid-subscribe failure best-effort-deletes the topic rather than leaving
    // it (with a partial subscription set) for the idempotent CreateTopic to
    // silently adopt on the next deploy. Regression guard for the PR #991 review.
    mockSend.mockImplementation((cmd) => {
      if (cmd instanceof CreateTopicCommand) {
        return Promise.resolve({ TopicArn: TOPIC_ARN });
      }
      if (cmd instanceof SubscribeCommand) {
        return Promise.reject(new Error('InvalidParameter: Endpoint'));
      }
      return Promise.resolve({});
    });

    await expect(
      provider.create('MyTopic', 'AWS::SNS::Topic', {
        TopicName: 'my-topic',
        Subscription: [{ Protocol: 'sqs', Endpoint: QUEUE_ARN_A }],
      })
    ).rejects.toThrow('InvalidParameter');

    const deleteCalls = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof DeleteTopicCommand);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].input).toMatchObject({ TopicArn: TOPIC_ARN });
  });

  it('create() does not Subscribe when no Subscription property is present', async () => {
    mockSend.mockResolvedValue({ TopicArn: TOPIC_ARN });

    await provider.create('MyTopic', 'AWS::SNS::Topic', { TopicName: 'my-topic' });

    const subCalls = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof SubscribeCommand);
    expect(subCalls).toHaveLength(0);
  });

  it('create() JSON-stringifies object-valued subscription attributes (FilterPolicy)', async () => {
    mockSend.mockImplementation((cmd) =>
      cmd instanceof CreateTopicCommand
        ? Promise.resolve({ TopicArn: TOPIC_ARN })
        : Promise.resolve({ SubscriptionArn: 'arn:...:sub' })
    );

    await provider.create('MyTopic', 'AWS::SNS::Topic', {
      TopicName: 'my-topic',
      Subscription: [
        {
          Protocol: 'sqs',
          Endpoint: QUEUE_ARN_A,
          FilterPolicy: { eventType: ['important'] },
        },
      ],
    });

    const subCall = mockSend.mock.calls
      .map((c) => c[0])
      .find((c) => c instanceof SubscribeCommand);
    expect(subCall!.input.Attributes!.FilterPolicy).toBe('{"eventType":["important"]}');
  });

  it('update() adds a newly-declared subscription via Subscribe', async () => {
    mockSend.mockResolvedValue({});

    await provider.update(
      'MyTopic',
      TOPIC_ARN,
      'AWS::SNS::Topic',
      {
        TopicName: 'my-topic',
        Subscription: [
          { Protocol: 'sqs', Endpoint: QUEUE_ARN_A },
          { Protocol: 'sqs', Endpoint: QUEUE_ARN_B },
        ],
      },
      {
        TopicName: 'my-topic',
        Subscription: [{ Protocol: 'sqs', Endpoint: QUEUE_ARN_A }],
      }
    );

    const subCalls = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof SubscribeCommand);
    expect(subCalls).toHaveLength(1);
    expect(subCalls[0].input).toMatchObject({
      TopicArn: TOPIC_ARN,
      Protocol: 'sqs',
      Endpoint: QUEUE_ARN_B,
    });
    // No unsubscribe when nothing removed.
    const unsubCalls = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UnsubscribeCommand);
    expect(unsubCalls).toHaveLength(0);
  });

  it('update() removing an entry ListSubscriptionsByTopic then Unsubscribe with resolved ARN', async () => {
    const SUB_ARN_B = 'arn:aws:sns:us-east-1:123456789012:my-topic:sub-b-uuid';
    mockSend.mockImplementation((cmd) => {
      if (cmd instanceof ListSubscriptionsByTopicCommand) {
        return Promise.resolve({
          Subscriptions: [
            { Protocol: 'sqs', Endpoint: QUEUE_ARN_A, SubscriptionArn: 'arn:...:sub-a' },
            { Protocol: 'sqs', Endpoint: QUEUE_ARN_B, SubscriptionArn: SUB_ARN_B },
          ],
        });
      }
      return Promise.resolve({});
    });

    await provider.update(
      'MyTopic',
      TOPIC_ARN,
      'AWS::SNS::Topic',
      {
        TopicName: 'my-topic',
        Subscription: [{ Protocol: 'sqs', Endpoint: QUEUE_ARN_A }],
      },
      {
        TopicName: 'my-topic',
        Subscription: [
          { Protocol: 'sqs', Endpoint: QUEUE_ARN_A },
          { Protocol: 'sqs', Endpoint: QUEUE_ARN_B },
        ],
      }
    );

    const listCalls = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof ListSubscriptionsByTopicCommand);
    expect(listCalls.length).toBeGreaterThanOrEqual(1);

    const unsubCalls = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UnsubscribeCommand);
    expect(unsubCalls).toHaveLength(1);
    expect(unsubCalls[0].input).toEqual({ SubscriptionArn: SUB_ARN_B });

    // No Subscribe when nothing added.
    const subCalls = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof SubscribeCommand);
    expect(subCalls).toHaveLength(0);
  });

  it('update() skips unsubscribe for a PendingConfirmation removed entry', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd instanceof ListSubscriptionsByTopicCommand) {
        return Promise.resolve({
          Subscriptions: [
            { Protocol: 'email', Endpoint: 'x@y.com', SubscriptionArn: 'PendingConfirmation' },
          ],
        });
      }
      return Promise.resolve({});
    });

    await provider.update(
      'MyTopic',
      TOPIC_ARN,
      'AWS::SNS::Topic',
      { TopicName: 'my-topic', Subscription: [] },
      { TopicName: 'my-topic', Subscription: [{ Protocol: 'email', Endpoint: 'x@y.com' }] }
    );

    const unsubCalls = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UnsubscribeCommand);
    expect(unsubCalls).toHaveLength(0);
  });

  it('update() does nothing when the Subscription list is unchanged', async () => {
    mockSend.mockResolvedValue({});
    const subs = [{ Protocol: 'sqs', Endpoint: QUEUE_ARN_A }];

    await provider.update(
      'MyTopic',
      TOPIC_ARN,
      'AWS::SNS::Topic',
      { TopicName: 'my-topic', Subscription: subs },
      { TopicName: 'my-topic', Subscription: subs }
    );

    const subCalls = mockSend.mock.calls
      .map((c) => c[0])
      .filter(
        (c) => c instanceof SubscribeCommand || c instanceof UnsubscribeCommand
      );
    expect(subCalls).toHaveLength(0);
  });
});
