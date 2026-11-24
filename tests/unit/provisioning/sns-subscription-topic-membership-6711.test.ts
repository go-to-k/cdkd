import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  AuthorizationErrorException,
  GetSubscriptionAttributesCommand,
  ListSubscriptionsByTopicCommand,
  NotFoundException,
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
    child: vi.fn(function (this: unknown) { return this; }),
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

import { SNSSubscriptionProvider } from '../../../src/provisioning/providers/sns-subscription-provider.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import { membershipTiming } from '../../../src/provisioning/providers/sns-subscription/topic-membership.js';

const TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:my-topic';
const SUB_ARN = `${TOPIC_ARN}:11111111-2222-3333-4444-555555555555`;
const QUEUE_ARN = 'arn:aws:sqs:us-east-1:123456789012:queue';
const TYPE = 'AWS::SNS::Subscription';

/** The stale answer SNS gives for a subscription whose topic was deleted. */
function attributes(extra: Record<string, string> = {}): Record<string, string> {
  return {
    TopicArn: TOPIC_ARN,
    Protocol: 'sqs',
    Endpoint: QUEUE_ARN,
    PendingConfirmation: 'false',
    SubscriptionArn: SUB_ARN,
    ...extra,
  };
}

/**
 * Route `send` by command: `GetSubscriptionAttributes` answers `attrs`, and
 * `ListSubscriptionsByTopic` answers the pages in order (or throws `listError`).
 */
function route(
  attrs: Record<string, string>,
  pages: Array<{ Subscriptions: Array<Record<string, string>>; NextToken?: string }>,
  listError?: Error
): void {
  let page = 0;
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof GetSubscriptionAttributesCommand) {
      return Promise.resolve({ Attributes: attrs });
    }
    if (cmd instanceof ListSubscriptionsByTopicCommand) {
      if (listError) return Promise.reject(listError);
      return Promise.resolve(pages[page++]);
    }
    return Promise.reject(new Error(`unexpected command ${String(cmd)}`));
  });
}

function listCalls(): ListSubscriptionsByTopicCommand[] {
  return mockSend.mock.calls
    .map((c) => c[0] as unknown)
    .filter((c): c is ListSubscriptionsByTopicCommand => c instanceof ListSubscriptionsByTopicCommand);
}

describe('SNSSubscriptionProvider.readCurrentState: topic membership (go-to-k/cdkd#6711)', () => {
  let provider: SNSSubscriptionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new SNSSubscriptionProvider();
    membershipTiming.absentRecheckMs = 0;
  });

  it('reports a subscription its topic no longer lists as deleted', async () => {
    route(attributes(), [
      {
        Subscriptions: [
          { SubscriptionArn: `${TOPIC_ARN}:other`, Protocol: 'sqs', Endpoint: QUEUE_ARN },
        ],
      },
    ]);
    const result = await provider.readCurrentState(SUB_ARN, 'Sub', TYPE, {}, {});
    expect(result).toBe(RESOURCE_NOT_FOUND);
    expect(listCalls()[0]?.input).toEqual({ TopicArn: TOPIC_ARN });
  });

  it('reports a subscription whose topic is gone as deleted', async () => {
    route(attributes(), [], new NotFoundException({ message: 'Topic does not exist', $metadata: {} }));
    const result = await provider.readCurrentState(SUB_ARN, 'Sub', TYPE);
    expect(result).toBe(RESOURCE_NOT_FOUND);
  });

  it('reads a listed subscription as before, paging until its ARN and no further', async () => {
    route(attributes({ RawMessageDelivery: 'true' }), [
      { Subscriptions: [{ SubscriptionArn: `${TOPIC_ARN}:a` }], NextToken: 't1' },
      { Subscriptions: [{ SubscriptionArn: SUB_ARN }], NextToken: 't2' },
      { Subscriptions: [{ SubscriptionArn: `${TOPIC_ARN}:c` }] },
    ]);
    const result = await provider.readCurrentState(SUB_ARN, 'Sub', TYPE, {}, {});
    expect(result).toEqual({
      TopicArn: TOPIC_ARN,
      Protocol: 'sqs',
      Endpoint: QUEUE_ARN,
      RawMessageDelivery: true,
    });
    expect(listCalls().map((c) => c.input)).toEqual([
      { TopicArn: TOPIC_ARN },
      { TopicArn: TOPIC_ARN, NextToken: 't1' },
    ]);
  });

  it('re-reads an absent answer once, so a listing lagging a fresh Subscribe is not a deletion', async () => {
    route(attributes(), [{ Subscriptions: [] }, { Subscriptions: [{ SubscriptionArn: SUB_ARN }] }]);
    const result = await provider.readCurrentState(SUB_ARN, 'Sub', TYPE, {}, {});
    expect(result).toMatchObject({ TopicArn: TOPIC_ARN });
    expect(listCalls()).toHaveLength(2);
  });

  it('keeps the attribute answer when another account\'s topic refuses the subscriber the list', async () => {
    route(
      attributes({ Owner: '210987654321' }),
      [],
      new AuthorizationErrorException({ message: 'not authorized', $metadata: {} })
    );
    const result = await provider.readCurrentState(SUB_ARN, 'Sub', TYPE, {}, {});
    expect(result).toMatchObject({ TopicArn: TOPIC_ARN, Endpoint: QUEUE_ARN });
  });

  it('throws when membership cannot be read, never reporting the subscription clean', async () => {
    route(
      attributes({ Owner: '123456789012' }),
      [],
      new AuthorizationErrorException({ message: 'not authorized', $metadata: {} })
    );
    await expect(provider.readCurrentState(SUB_ARN, 'Sub', TYPE, {}, {})).rejects.toBeInstanceOf(
      AuthorizationErrorException
    );
  });

  it('makes no membership call on the capture right after its own write (no extra deploy call)', async () => {
    route(attributes(), [{ Subscriptions: [] }]);
    const result = await provider.readCurrentState(SUB_ARN, 'Sub', TYPE, {}, { afterOwnWrite: true });
    expect(result).toMatchObject({ TopicArn: TOPIC_ARN });
    expect(listCalls()).toHaveLength(0);
  });

  describe('a subscription still PendingConfirmation (listed under that literal, not its ARN)', () => {
    const pending = attributes({ PendingConfirmation: 'true', Protocol: 'https', Endpoint: 'https://e/x' });

    it('is read as before when the topic lists a pending entry with its protocol and endpoint', async () => {
      route(pending, [
        {
          Subscriptions: [
            { SubscriptionArn: 'PendingConfirmation', Protocol: 'https', Endpoint: 'https://e/x' },
          ],
        },
      ]);
      const result = await provider.readCurrentState(SUB_ARN, 'Sub', TYPE, {}, {});
      expect(result).toMatchObject({ Protocol: 'https', Endpoint: 'https://e/x' });
    });

    it('matches a basic-auth endpoint the list spells with its password masked', async () => {
      // Measured: GetSubscriptionAttributes returns the password in the clear,
      // ListSubscriptionsByTopic returns it as `****`.
      route(
        attributes({
          PendingConfirmation: 'true',
          Protocol: 'https',
          Endpoint: 'https://user:pw@e/x',
        }),
        [
          {
            Subscriptions: [
              { SubscriptionArn: 'PendingConfirmation', Protocol: 'https', Endpoint: 'https://user:****@e/x' },
            ],
          },
        ]
      );
      const result = await provider.readCurrentState(SUB_ARN, 'Sub', TYPE, {}, {});
      expect(result).toMatchObject({ Endpoint: 'https://user:pw@e/x' });
    });

    it('is deleted when the topic lists no pending entry for its endpoint', async () => {
      route(pending, [
        {
          Subscriptions: [
            { SubscriptionArn: 'PendingConfirmation', Protocol: 'https', Endpoint: 'https://e/other' },
          ],
        },
      ]);
      const result = await provider.readCurrentState(SUB_ARN, 'Sub', TYPE, {}, {});
      expect(result).toBe(RESOURCE_NOT_FOUND);
    });

    it('a confirmed subscription is NOT matched by a pending entry for its endpoint', async () => {
      route(attributes(), [
        {
          Subscriptions: [
            { SubscriptionArn: 'PendingConfirmation', Protocol: 'sqs', Endpoint: QUEUE_ARN },
          ],
        },
      ]);
      const result = await provider.readCurrentState(SUB_ARN, 'Sub', TYPE, {}, {});
      expect(result).toBe(RESOURCE_NOT_FOUND);
    });
  });
});
