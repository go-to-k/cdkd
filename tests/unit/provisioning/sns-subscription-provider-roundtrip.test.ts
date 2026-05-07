import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SubscribeCommand,
  UnsubscribeCommand,
  GetSubscriptionAttributesCommand,
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

import { SNSSubscriptionProvider } from '../../../src/provisioning/providers/sns-subscription-provider.js';

const SUB_ARN_OLD = 'arn:aws:sns:us-east-1:1:my-topic:abcd-efgh';
const SUB_ARN_NEW = 'arn:aws:sns:us-east-1:1:my-topic:wxyz-1234';
const TOPIC_ARN = 'arn:aws:sns:us-east-1:1:my-topic';
const QUEUE_ARN = 'arn:aws:sqs:us-east-1:1:queue';
const RESOURCE_TYPE = 'AWS::SNS::Subscription';

describe('SNSSubscriptionProvider read-update round-trip', () => {
  let provider: SNSSubscriptionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SNSSubscriptionProvider();
  });

  it('Class 1 — email subscription (no RawMessageDelivery / RedrivePolicy / DeliveryPolicy on AWS) round-trip does not push protocol-only attrs', async () => {
    // SNS attributes RawMessageDelivery (sqs/lambda/firehose/http(s)),
    // DeliveryPolicy (http/https), RedrivePolicy (sqs/lambda),
    // SubscriptionRoleArn (firehose), ReplayPolicy (firehose) are
    // protocol-discriminated. AWS does not return them on
    // GetSubscriptionAttributes for incompatible protocols, so
    // readCurrentState should NOT emit them. Round-tripping the
    // resulting snapshot through update() must not push any of them
    // into the Subscribe call.
    mockSend.mockResolvedValueOnce({
      Attributes: {
        TopicArn: TOPIC_ARN,
        Protocol: 'email',
        Endpoint: 'me@example.com',
        // No RawMessageDelivery / DeliveryPolicy / RedrivePolicy / etc.
        Owner: '1',
        SubscriptionArn: SUB_ARN_OLD,
      },
    });
    const observed = await provider.readCurrentState(SUB_ARN_OLD, 'L', RESOURCE_TYPE);

    // Pre-condition: observed has no protocol-only keys.
    expect(observed).toBeDefined();
    expect(observed).not.toHaveProperty('RawMessageDelivery');
    expect(observed).not.toHaveProperty('RedrivePolicy');
    expect(observed).not.toHaveProperty('DeliveryPolicy');
    expect(observed).not.toHaveProperty('SubscriptionRoleArn');
    expect(observed).not.toHaveProperty('ReplayPolicy');

    // update() is delete + create. Mock both mock.send calls.
    vi.clearAllMocks();
    mockSend.mockResolvedValueOnce({}); // Unsubscribe
    mockSend.mockResolvedValueOnce({ SubscriptionArn: SUB_ARN_NEW }); // Subscribe

    await provider.update('L', SUB_ARN_OLD, RESOURCE_TYPE, observed!, observed!);

    const subscribeCall = mockSend.mock.calls.find((c) => c[0] instanceof SubscribeCommand);
    expect(subscribeCall).toBeDefined();
    const input = subscribeCall![0].input as {
      TopicArn?: string;
      Protocol?: string;
      Endpoint?: string;
      Attributes?: Record<string, string>;
    };
    // Class 1 guard: no protocol-only attribute is shipped on an email
    // protocol subscription. AWS would reject these as "is only valid
    // on sqs/lambda/firehose/http(s) protocols".
    const attrs = input.Attributes ?? {};
    expect(attrs).not.toHaveProperty('RawMessageDelivery');
    expect(attrs).not.toHaveProperty('RedrivePolicy');
    expect(attrs).not.toHaveProperty('DeliveryPolicy');
    expect(attrs).not.toHaveProperty('SubscriptionRoleArn');
    expect(attrs).not.toHaveProperty('ReplayPolicy');
  });

  it('Class 2 — readCurrentState does not emit empty-object placeholders for RedrivePolicy / DeliveryPolicy', async () => {
    // Class 2 vulnerability: emitting `RedrivePolicy: {}` would round-
    // trip into `JSON.stringify({}) === '{}'` on the Subscribe call,
    // which AWS rejects ("Redrive policy does not contain mandatory
    // attribute: deadLetterTargetArn"). The provider sidesteps this
    // class by NOT emitting the key when AWS returns it as undefined
    // (the field is also protocol-discriminated, so even on sqs/lambda
    // a subscription without a DLQ has no RedrivePolicy on the wire).
    mockSend.mockResolvedValueOnce({
      Attributes: {
        TopicArn: TOPIC_ARN,
        Protocol: 'sqs',
        Endpoint: QUEUE_ARN,
        RawMessageDelivery: 'false',
        // No RedrivePolicy / DeliveryPolicy on the wire.
        Owner: '1',
        SubscriptionArn: SUB_ARN_OLD,
      },
    });
    const observed = await provider.readCurrentState(SUB_ARN_OLD, 'L', RESOURCE_TYPE);

    expect(observed).not.toHaveProperty('RedrivePolicy');
    expect(observed).not.toHaveProperty('DeliveryPolicy');
  });

  it('truthy gate — empty FilterPolicy reaches Subscribe (placeholder survives round-trip)', async () => {
    // Truthy-gate regression guard. Pre-fix code used
    // `if (filterPolicy)`, which silently drops `''` and the parsed
    // empty-object placeholder is technically truthy ({}), but a
    // string `''` (returned for an explicit "match all" filter cleared
    // via console) would have been dropped. Post-fix the gate is
    // `!== undefined`, so the explicit empty value reaches AWS as the
    // documented way to clear FilterPolicy.
    const observed: Record<string, unknown> = {
      TopicArn: TOPIC_ARN,
      Protocol: 'sqs',
      Endpoint: QUEUE_ARN,
      RawMessageDelivery: false,
      FilterPolicy: '', // explicit empty (cleared on AWS side)
    };

    mockSend.mockResolvedValueOnce({}); // Unsubscribe
    mockSend.mockResolvedValueOnce({ SubscriptionArn: SUB_ARN_NEW }); // Subscribe

    await provider.update('L', SUB_ARN_OLD, RESOURCE_TYPE, observed, observed);

    const subscribeCall = mockSend.mock.calls.find((c) => c[0] instanceof SubscribeCommand);
    expect(subscribeCall).toBeDefined();
    const attrs = (subscribeCall![0].input as { Attributes?: Record<string, string> }).Attributes;
    // The empty FilterPolicy must NOT be silently dropped — AWS uses
    // the empty placeholder as the documented "clear filter" signal.
    expect(attrs).toBeDefined();
    expect(attrs!['FilterPolicy']).toBe('');
  });

  it('round-trip happy path — sqs subscription with FilterPolicy survives readCurrentState → update() without rejection-shape inputs', async () => {
    // End-to-end round-trip test (the structural guard documented in
    // docs/provider-development.md § 3b). Read AWS-current shape, feed
    // it back through update(), assert the Subscribe call shape would
    // not be rejected by AWS.
    mockSend.mockResolvedValueOnce({
      Attributes: {
        TopicArn: TOPIC_ARN,
        Protocol: 'sqs',
        Endpoint: QUEUE_ARN,
        RawMessageDelivery: 'true',
        FilterPolicy: '{"foo":["bar"]}',
        Owner: '1',
        SubscriptionArn: SUB_ARN_OLD,
      },
    });
    const observed = await provider.readCurrentState(SUB_ARN_OLD, 'L', RESOURCE_TYPE);
    expect(observed).toEqual({
      TopicArn: TOPIC_ARN,
      Protocol: 'sqs',
      Endpoint: QUEUE_ARN,
      RawMessageDelivery: true,
      FilterPolicy: { foo: ['bar'] },
    });

    vi.clearAllMocks();
    mockSend.mockResolvedValueOnce({}); // Unsubscribe (delete in update)
    mockSend.mockResolvedValueOnce({ SubscriptionArn: SUB_ARN_NEW }); // Subscribe

    const result = await provider.update('L', SUB_ARN_OLD, RESOURCE_TYPE, observed!, observed!);

    expect(result.wasReplaced).toBe(true);
    expect(result.physicalId).toBe(SUB_ARN_NEW);

    // Unsubscribe + Subscribe were called.
    expect(mockSend.mock.calls.filter((c) => c[0] instanceof UnsubscribeCommand)).toHaveLength(1);
    const subscribeCall = mockSend.mock.calls.find((c) => c[0] instanceof SubscribeCommand);
    expect(subscribeCall).toBeDefined();

    const input = subscribeCall![0].input as {
      TopicArn?: string;
      Protocol?: string;
      Endpoint?: string;
      Attributes?: Record<string, string>;
    };
    expect(input.TopicArn).toBe(TOPIC_ARN);
    expect(input.Protocol).toBe('sqs');
    expect(input.Endpoint).toBe(QUEUE_ARN);
    // FilterPolicy was JSON.stringify-ed back to the wire form.
    expect(input.Attributes?.['FilterPolicy']).toBe('{"foo":["bar"]}');
    // Class 2 guard: no '{}' placeholder shipped.
    expect(input.Attributes?.['FilterPolicy']).not.toBe('{}');
    expect(input.Attributes?.['RedrivePolicy']).toBeUndefined();
  });

  it('returns no-undefined readCurrentState that survives JSON serialization (state save round-trip)', async () => {
    // Defensive: make sure readCurrentState produces only JSON-safe
    // values so saveState doesn't trip on undefined.
    mockSend.mockResolvedValueOnce({
      Attributes: {
        TopicArn: TOPIC_ARN,
        Protocol: 'lambda',
        Endpoint: 'arn:aws:lambda:us-east-1:1:function:f',
        Owner: '1',
        SubscriptionArn: SUB_ARN_OLD,
      },
    });
    const observed = await provider.readCurrentState(SUB_ARN_OLD, 'L', RESOURCE_TYPE);
    expect(observed).toBeDefined();
    expect(JSON.parse(JSON.stringify(observed))).toEqual(observed);

    // Sanity: GetSubscriptionAttributes was the only call.
    expect(mockSend.mock.calls).toHaveLength(1);
    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetSubscriptionAttributesCommand);
  });
});
