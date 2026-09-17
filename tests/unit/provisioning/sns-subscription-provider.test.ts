import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  InvalidParameterException,
  SubscribeCommand,
  UnsubscribeCommand,
} from '@aws-sdk/client-sns';

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

import { SNSSubscriptionProvider } from '../../../src/provisioning/providers/sns-subscription-provider.js';

describe('SNSSubscriptionProvider', () => {
  let provider: SNSSubscriptionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SNSSubscriptionProvider();
  });

  describe('the Arn attribute (issue #3329)', () => {
    const TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:my-topic';
    const QUEUE_ARN = 'arn:aws:sqs:us-east-1:123456789012:my-queue';
    const props = { TopicArn: TOPIC_ARN, Protocol: 'sqs', Endpoint: QUEUE_ARN };

    it('records the ARN the Subscribe response returned', async () => {
      // Before this issue the provider returned `attributes: {}` and a
      // cross-resource `Fn::GetAtt ...Arn` was answered by
      // `guardedPhysicalIdFallback`. That worked, which is why the type held
      // the tree's only `SDK_ATTR_ALLOW_LIST` entry; caching retires it.
      mockSend.mockResolvedValueOnce({ SubscriptionArn: `${TOPIC_ARN}:sub-id` });
      const result = await provider.create('L', 'AWS::SNS::Subscription', props);
      expect(result.physicalId).toBe(`${TOPIC_ARN}:sub-id`);
      expect(result.attributes).toEqual({ Arn: `${TOPIC_ARN}:sub-id` });
    });

    it('records NOTHING when the response carried no ARN — never the constructed fallback', async () => {
      // NEGATIVE ONE, and the SILENT half. `create` falls back to
      // `<topicArn>:<logicalId>` for the physical id, and that string is
      // ARN-SHAPED, so the resolver's guard passes it. Caching it would put a
      // FABRICATED ARN in state that nothing downstream can tell from a real
      // one — strictly worse than the fallback it would replace. The rule is
      // "cache the ARN AWS returned, or cache nothing".
      mockSend.mockResolvedValueOnce({});
      const result = await provider.create('L', 'AWS::SNS::Subscription', props);
      expect(result.physicalId).toBe(`${TOPIC_ARN}:L`);
      expect(result.attributes).toEqual({});
      expect(result.attributes).not.toHaveProperty('Arn');
    });

    it('records NOTHING when the response is the literal "pending confirmation"', async () => {
      // Review round 1. `Subscribe` can answer this for an unconfirmed
      // subscription; `ReturnSubscriptionArn: true` is meant to prevent it, but
      // `delete()` special-cases BOTH spellings, so this file does not treat it
      // as unreachable. UNCACHED it reaches `guardedPhysicalIdFallback`, which
      // THROWS for an `*Arn` without an `arn:` prefix — loud. CACHED it would
      // be served silently, because a cache hit short-circuits that guard and
      // this type has no `REF_RETURNS_ARN_FROM_STATE` entry. The shape test is
      // what keeps the loud behaviour.
      for (const literal of ['pending confirmation', 'PendingConfirmation']) {
        mockSend.mockResolvedValueOnce({ SubscriptionArn: literal });
        const result = await provider.create('L', 'AWS::SNS::Subscription', props);
        expect(result.physicalId, literal).toBe(literal);
        expect(result.attributes, literal).toEqual({});
        expect(result.attributes, literal).not.toHaveProperty('Arn');
      }
    });

    it('records NOTHING on import, where the id can be PendingConfirmation', async () => {
      // NEGATIVE TWO. An imported id is taken from the user verbatim and may be
      // the literal `PendingConfirmation` that `delete()` special-cases. A
      // CACHED attribute is served straight out of the record — this type has
      // no `REF_RETURNS_ARN_FROM_STATE` entry, so the resolver's placeholder
      // refusal never runs for it — and caching a non-ARN under an `*Arn` name
      // converts that path's LOUD refusal into a silent wrong value.
      const imported = await provider.import({
        logicalId: 'L',
        resourceType: 'AWS::SNS::Subscription',
        stackName: 'TestStack',
        region: 'us-east-1',
        properties: props,
        knownPhysicalId: 'PendingConfirmation',
      });
      expect(imported?.physicalId).toBe('PendingConfirmation');
      expect(imported?.attributes).toEqual({});
      // `toEqual({})` alone is VACUOUS — `{ Arn: undefined }` satisfies it
      // (measured in review). The companion is what discriminates, and the
      // create-negative above already carried it.
      expect(imported?.attributes).not.toHaveProperty('Arn');
    });

    it('carries the cached ARN through a replacement, since update delegates to create', async () => {
      // `update()` returns `createResult.attributes`, and the engine REPLACES
      // the attribute map rather than merging it — so a partial map here would
      // erase what create recorded.
      mockSend.mockResolvedValueOnce({}); // Unsubscribe
      mockSend.mockResolvedValueOnce({ SubscriptionArn: `${TOPIC_ARN}:new-sub` });
      const result = await provider.update(
        'L',
        `${TOPIC_ARN}:old-sub`,
        'AWS::SNS::Subscription',
        { ...props, Protocol: 'sqs' },
        { ...props, Protocol: 'email' }
      );
      expect(result.wasReplaced).toBe(true);
      expect(result.attributes).toEqual({ Arn: `${TOPIC_ARN}:new-sub` });
    });
  });

  describe('create — backfilled subscription attributes (issue #609)', () => {
    const TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:my-topic';
    const QUEUE_ARN = 'arn:aws:sqs:us-east-1:123456789012:my-queue';

    function subscribeInput() {
      const subscribeCall = mockSend.mock.calls.find((c) => c[0] instanceof SubscribeCommand);
      expect(subscribeCall).toBeDefined();
      return subscribeCall![0].input as { Attributes?: Record<string, string> };
    }

    it('coerces RawMessageDelivery boolean to the string "true" / "false"', async () => {
      mockSend.mockResolvedValueOnce({ SubscriptionArn: `${TOPIC_ARN}:sub` });

      await provider.create('L', 'AWS::SNS::Subscription', {
        TopicArn: TOPIC_ARN,
        Protocol: 'sqs',
        Endpoint: QUEUE_ARN,
        RawMessageDelivery: true,
      });

      expect(subscribeInput().Attributes?.['RawMessageDelivery']).toBe('true');
    });

    it('coerces RawMessageDelivery=false to the string "false" (not dropped by a truthy gate)', async () => {
      mockSend.mockResolvedValueOnce({ SubscriptionArn: `${TOPIC_ARN}:sub` });

      await provider.create('L', 'AWS::SNS::Subscription', {
        TopicArn: TOPIC_ARN,
        Protocol: 'sqs',
        Endpoint: QUEUE_ARN,
        RawMessageDelivery: false,
      });

      expect(subscribeInput().Attributes?.['RawMessageDelivery']).toBe('false');
    });

    it('JSON-stringifies object policies (RedrivePolicy / DeliveryPolicy / ReplayPolicy)', async () => {
      mockSend.mockResolvedValueOnce({ SubscriptionArn: `${TOPIC_ARN}:sub` });

      const redrive = { deadLetterTargetArn: 'arn:aws:sqs:us-east-1:0:dlq' };
      const delivery = { healthyRetryPolicy: { numRetries: 3 } };
      const replay = { pointType: 'TIMESTAMP' };

      await provider.create('L', 'AWS::SNS::Subscription', {
        TopicArn: TOPIC_ARN,
        Protocol: 'sqs',
        Endpoint: QUEUE_ARN,
        RedrivePolicy: redrive,
        DeliveryPolicy: delivery,
        ReplayPolicy: replay,
      });

      const attrs = subscribeInput().Attributes ?? {};
      expect(attrs['RedrivePolicy']).toBe(JSON.stringify(redrive));
      expect(attrs['DeliveryPolicy']).toBe(JSON.stringify(delivery));
      expect(attrs['ReplayPolicy']).toBe(JSON.stringify(replay));
    });

    it('passes policy strings through unchanged', async () => {
      mockSend.mockResolvedValueOnce({ SubscriptionArn: `${TOPIC_ARN}:sub` });

      const raw = '{"deadLetterTargetArn":"arn:aws:sqs:us-east-1:0:dlq"}';

      await provider.create('L', 'AWS::SNS::Subscription', {
        TopicArn: TOPIC_ARN,
        Protocol: 'sqs',
        Endpoint: QUEUE_ARN,
        RedrivePolicy: raw,
      });

      expect(subscribeInput().Attributes?.['RedrivePolicy']).toBe(raw);
    });

    it('passes FilterPolicyScope / SubscriptionRoleArn strings through', async () => {
      mockSend.mockResolvedValueOnce({ SubscriptionArn: `${TOPIC_ARN}:sub` });

      await provider.create('L', 'AWS::SNS::Subscription', {
        TopicArn: TOPIC_ARN,
        Protocol: 'firehose',
        Endpoint: 'arn:aws:firehose:us-east-1:0:deliverystream/ds',
        FilterPolicyScope: 'MessageBody',
        SubscriptionRoleArn: 'arn:aws:iam::0:role/sns-firehose',
      });

      const attrs = subscribeInput().Attributes ?? {};
      expect(attrs['FilterPolicyScope']).toBe('MessageBody');
      expect(attrs['SubscriptionRoleArn']).toBe('arn:aws:iam::0:role/sns-firehose');
    });

    it('omits every backfilled attribute when absent from the template', async () => {
      mockSend.mockResolvedValueOnce({ SubscriptionArn: `${TOPIC_ARN}:sub` });

      await provider.create('L', 'AWS::SNS::Subscription', {
        TopicArn: TOPIC_ARN,
        Protocol: 'sqs',
        Endpoint: QUEUE_ARN,
      });

      const subscribeCall = mockSend.mock.calls.find((c) => c[0] instanceof SubscribeCommand);
      expect(subscribeCall).toBeDefined();
      // No Attributes map at all when nothing was templated (matches the
      // existing FilterPolicy-only gating).
      const input = subscribeCall![0].input as { Attributes?: Record<string, string> };
      expect(input.Attributes).toBeUndefined();
    });
  });

  describe('delete — pending-confirmation subscriptions are skipped (issue #1301)', () => {
    const SUB_ARN = 'arn:aws:sns:us-east-1:123456789012:my-topic:4fd6eaeb-8427-411d-bb4a-cde03cb147cc';

    it('treats the pending-confirmation Unsubscribe rejection as delete success (CFn parity)', async () => {
      mockSend.mockRejectedValueOnce(
        new InvalidParameterException({
          message:
            'Invalid parameter: SubscriptionArn Reason: Cannot unsubscribe a subscription that is pending confirmation',
          $metadata: {},
        })
      );

      await expect(
        provider.delete('Sub', SUB_ARN, 'AWS::SNS::Subscription')
      ).resolves.toBeUndefined();
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('skips the Unsubscribe call entirely for the literal PendingConfirmation placeholder id', async () => {
      await expect(
        provider.delete('Sub', 'PendingConfirmation', 'AWS::SNS::Subscription')
      ).resolves.toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('skips the Unsubscribe call for the lowercase "pending confirmation" placeholder id', async () => {
      await expect(
        provider.delete('Sub', 'pending confirmation', 'AWS::SNS::Subscription')
      ).resolves.toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('readCurrentState returns undefined for the placeholder id without calling AWS (drift must not abort)', async () => {
      await expect(
        provider.readCurrentState('PendingConfirmation', 'Sub', 'AWS::SNS::Subscription')
      ).resolves.toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('still fails on unrelated InvalidParameterException errors', async () => {
      mockSend.mockRejectedValueOnce(
        new InvalidParameterException({
          message: 'Invalid parameter: SubscriptionArn Reason: An ARN must have at least 6 elements',
          $metadata: {},
        })
      );

      await expect(provider.delete('Sub', 'garbage', 'AWS::SNS::Subscription')).rejects.toThrow(
        'Failed to delete SNS subscription'
      );
    });
  });

  describe('update() re-creates the subscription', () => {
    // Why a policy-only flip must never reach this method (issue #2809, pinned
    // engine-side by tests/unit/deployment/deploy-engine-silent-drop-record.test.ts):
    // there is no in-place update, so ANY call replaces the subscription.
    it('update() unsubscribes the old subscription before subscribing a new one', async () => {
      const TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:orders';
      const QUEUE_ARN = 'arn:aws:sqs:us-east-1:123456789012:orders-queue';
      const OLD_ARN = `${TOPIC_ARN}:5f2c0b44-0000-4000-8000-000000000001`;
      const NEW_ARN = `${TOPIC_ARN}:9a1d7e30-0000-4000-8000-000000000002`;
      const properties = { TopicArn: TOPIC_ARN, Protocol: 'sqs', Endpoint: QUEUE_ARN };
      mockSend.mockResolvedValueOnce({}); // Unsubscribe
      mockSend.mockResolvedValueOnce({ SubscriptionArn: NEW_ARN }); // Subscribe

      const result = await provider.update(
        'L',
        OLD_ARN,
        'AWS::SNS::Subscription',
        properties,
        properties
      );

      const commands = mockSend.mock.calls.map((c) => c[0] as unknown);
      const unsubscribeAt = commands.findIndex((c) => c instanceof UnsubscribeCommand);
      const subscribeAt = commands.findIndex((c) => c instanceof SubscribeCommand);
      expect(unsubscribeAt).toBeGreaterThanOrEqual(0);
      expect(subscribeAt).toBeGreaterThan(unsubscribeAt);
      expect((commands[unsubscribeAt] as UnsubscribeCommand).input.SubscriptionArn).toBe(OLD_ARN);
      // Exactly the two primed calls, so neither primer can leak.
      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(result.physicalId).toBe(NEW_ARN);
      expect(result.wasReplaced).toBe(true);
    });
  });

  describe('import (explicit-override only)', () => {
    function makeInput(overrides: Partial<{ knownPhysicalId: string }> = {}) {
      return {
        logicalId: 'MySubscription',
        resourceType: 'AWS::SNS::Subscription',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {
          TopicArn: 'arn:aws:sns:us-east-1:123456789012:my-topic',
          Protocol: 'sqs',
          Endpoint: 'arn:aws:sqs:us-east-1:123456789012:my-queue',
        },
        ...overrides,
      };
    }

    it('returns physicalId when knownPhysicalId is supplied (no AWS calls)', async () => {
      const subArn =
        'arn:aws:sns:us-east-1:123456789012:my-topic:abcd1234-5678-90ab-cdef-1234567890ab';
      const result = await provider.import(makeInput({ knownPhysicalId: subArn }));

      expect(result).toEqual({ physicalId: subArn, attributes: {} });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns null when knownPhysicalId is not supplied (no auto lookup)', async () => {
      const result = await provider.import(makeInput());

      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
