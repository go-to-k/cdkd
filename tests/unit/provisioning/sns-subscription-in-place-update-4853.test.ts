/**
 * go-to-k/cdkd#4853: an edit to a MUTABLE attribute of an `AWS::SNS::Subscription`
 * (`RawMessageDelivery`, `FilterPolicy`, ...) is applied IN PLACE with
 * `SetSubscriptionAttributes`, keeping the subscription ARN, as CloudFormation
 * does. It used to unsubscribe and subscribe again: a new ARN, messages lost in
 * the gap, and an email / http(s) endpoint back to `PendingConfirmation`.
 *
 * The plan is computed against what AWS holds (`GetSubscriptionAttributes`), not
 * against `previousProperties`, so a `cdkd drift --revert` (desired equal to the
 * record, AWS drifted) still converges. A change cdkd cannot apply in place (a
 * create-only field differing from AWS, an attribute with no proven reset, a
 * `FilterPolicy` and `FilterPolicyScope` changing together, an unreadable
 * subscription) keeps the delete-first replacement and its #1778 / #1967 abort.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetSubscriptionAttributesCommand,
  NotFoundException,
  SetSubscriptionAttributesCommand,
  SubscribeCommand,
  UnsubscribeCommand,
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

const TYPE = 'AWS::SNS::Subscription';
const TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:orders';
const QUEUE_ARN = 'arn:aws:sqs:us-east-1:123456789012:orders-queue';
const DLQ_ARN = 'arn:aws:sqs:us-east-1:123456789012:orders-dlq';
const SUB_ARN = `${TOPIC_ARN}:5f2c0b44-0000-4000-8000-000000000001`;
const NEW_SUB_ARN = `${TOPIC_ARN}:9a1d7e30-0000-4000-8000-000000000002`;
const BASE = { TopicArn: TOPIC_ARN, Protocol: 'sqs', Endpoint: QUEUE_ARN };

/** What `GetSubscriptionAttributes` reports: the identity fields plus `extra`. */
function live(extra: Record<string, string> = {}): Record<string, string> {
  return {
    SubscriptionArn: SUB_ARN,
    TopicArn: TOPIC_ARN,
    Protocol: 'sqs',
    Endpoint: QUEUE_ARN,
    Owner: '123456789012',
    PendingConfirmation: 'false',
    ConfirmationWasAuthenticated: 'true',
    RawMessageDelivery: 'false',
    ...extra,
  };
}

/** Route each command class to a responder, recording the order of commands sent. */
function route(handlers: {
  get?: () => unknown;
  set?: (input: { AttributeName?: string; AttributeValue?: string }) => unknown;
  subscribe?: () => unknown;
  unsubscribe?: () => unknown;
}): void {
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof GetSubscriptionAttributesCommand) {
      return Promise.resolve(handlers.get?.());
    }
    if (command instanceof SetSubscriptionAttributesCommand) {
      return Promise.resolve(handlers.set?.(command.input) ?? {});
    }
    if (command instanceof SubscribeCommand) {
      return Promise.resolve(handlers.subscribe?.() ?? { SubscriptionArn: NEW_SUB_ARN });
    }
    if (command instanceof UnsubscribeCommand) {
      return Promise.resolve(handlers.unsubscribe?.() ?? {});
    }
    return Promise.reject(new Error(`unexpected command ${String(command)}`));
  });
}

const sent = (): unknown[] => mockSend.mock.calls.map((c) => c[0] as unknown);
const setCalls = (): Array<[string | undefined, string | undefined]> =>
  sent()
    .filter((c): c is SetSubscriptionAttributesCommand => c instanceof SetSubscriptionAttributesCommand)
    .map((c) => [c.input.AttributeName, c.input.AttributeValue]);
const replaced = (): boolean =>
  sent().some((c) => c instanceof UnsubscribeCommand || c instanceof SubscribeCommand);

describe('SNSSubscriptionProvider.update applies a mutable attribute edit in place (go-to-k/cdkd#4853)', () => {
  let provider: SNSSubscriptionProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new SNSSubscriptionProvider();
  });

  it('turns RawMessageDelivery on with SetSubscriptionAttributes, keeping the subscription', async () => {
    route({ get: () => ({ Attributes: live() }) });
    const result = await provider.update(
      'Sub',
      SUB_ARN,
      TYPE,
      { ...BASE, RawMessageDelivery: true },
      { ...BASE, RawMessageDelivery: false }
    );
    expect(setCalls()).toEqual([['RawMessageDelivery', 'true']]);
    expect(replaced()).toBe(false);
    expect(result).toEqual({ physicalId: SUB_ARN, wasReplaced: false, attributes: { Arn: SUB_ARN } });
  });

  it('sets a changed FilterPolicy as JSON, and leaves an unchanged attribute alone', async () => {
    route({
      get: () => ({
        Attributes: live({ FilterPolicy: '{"kind":["a"]}', FilterPolicyScope: 'MessageAttributes' }),
      }),
    });
    await provider.update(
      'Sub',
      SUB_ARN,
      TYPE,
      { ...BASE, FilterPolicy: { kind: ['b'] }, RawMessageDelivery: false },
      { ...BASE, FilterPolicy: { kind: ['a'] }, RawMessageDelivery: false }
    );
    expect(setCalls()).toEqual([['FilterPolicy', '{"kind":["b"]}']]);
    expect(replaced()).toBe(false);
  });

  it('compares against AWS, not previousProperties: a drift revert with equal bags still converges', async () => {
    // `cdkd drift --revert`: desired is the record, AWS was changed by hand.
    route({ get: () => ({ Attributes: live({ RawMessageDelivery: 'true' }) }) });
    const desired = { ...BASE, RawMessageDelivery: false };
    await provider.update('Sub', SUB_ARN, TYPE, desired, desired);
    expect(setCalls()).toEqual([['RawMessageDelivery', 'false']]);
    expect(replaced()).toBe(false);
  });

  it('sends nothing when AWS already holds every desired value', async () => {
    route({
      get: () => ({ Attributes: live({ RawMessageDelivery: 'true', FilterPolicy: '{"kind": ["a"]}' }) }),
    });
    const result = await provider.update(
      'Sub',
      SUB_ARN,
      TYPE,
      { ...BASE, RawMessageDelivery: true, FilterPolicy: { kind: ['a'] } },
      { ...BASE }
    );
    expect(setCalls()).toEqual([]);
    expect(replaced()).toBe(false);
    expect(result.physicalId).toBe(SUB_ARN);
  });

  it('resets an attribute dropped from the template to its default', async () => {
    route({
      get: () => ({
        Attributes: live({
          RawMessageDelivery: 'true',
          FilterPolicy: '{"kind":["a"]}',
          FilterPolicyScope: 'MessageBody',
          RedrivePolicy: `{"deadLetterTargetArn":"${DLQ_ARN}"}`,
        }),
      }),
    });
    await provider.update('Sub', SUB_ARN, TYPE, { ...BASE }, {
      ...BASE,
      RawMessageDelivery: true,
      FilterPolicy: { kind: ['a'] },
      FilterPolicyScope: 'MessageBody',
      RedrivePolicy: { deadLetterTargetArn: DLQ_ARN },
    });
    // The policy is cleared BEFORE its scope returns to the default, so the
    // scope never applies to a policy written for the other one.
    expect(setCalls()).toEqual([
      ['RawMessageDelivery', 'false'],
      ['FilterPolicy', ''],
      ['FilterPolicyScope', 'MessageAttributes'],
      ['RedrivePolicy', ''],
    ]);
    expect(replaced()).toBe(false);
  });

  it('treats an attribute AWS omits as its default (RawMessageDelivery on an email subscription)', async () => {
    const email = { TopicArn: TOPIC_ARN, Protocol: 'email', Endpoint: 'ops@example.com' };
    const { RawMessageDelivery: _omitted, ...attributes } = live({
      Protocol: 'email',
      Endpoint: 'ops@example.com',
    });
    route({ get: () => ({ Attributes: attributes }) });
    await provider.update('Sub', SUB_ARN, TYPE, { ...email, RawMessageDelivery: false }, { ...email });
    // Setting it would be refused: it is valid on sqs / lambda / firehose / http(s) only.
    expect(setCalls()).toEqual([]);
    expect(replaced()).toBe(false);
  });

  it("does not reset FilterPolicyScope that AWS reports at its default", async () => {
    route({ get: () => ({ Attributes: live({ FilterPolicyScope: 'MessageAttributes' }) }) });
    await provider.update('Sub', SUB_ARN, TYPE, { ...BASE, RawMessageDelivery: false }, { ...BASE });
    expect(setCalls()).toEqual([]);
    expect(replaced()).toBe(false);
  });

  it('sets a changed DeliveryPolicy / ReplayPolicy / SubscriptionRoleArn in place', async () => {
    route({
      get: () => ({
        Attributes: live({
          Protocol: 'firehose',
          Endpoint: 'arn:aws:firehose:us-east-1:123456789012:deliverystream/s',
          SubscriptionRoleArn: 'arn:aws:iam::123456789012:role/old',
        }),
      }),
    });
    const props = {
      TopicArn: TOPIC_ARN,
      Protocol: 'firehose',
      Endpoint: 'arn:aws:firehose:us-east-1:123456789012:deliverystream/s',
      SubscriptionRoleArn: 'arn:aws:iam::123456789012:role/new',
    };
    await provider.update('Sub', SUB_ARN, TYPE, props, props);
    expect(setCalls()).toEqual([['SubscriptionRoleArn', 'arn:aws:iam::123456789012:role/new']]);
    expect(replaced()).toBe(false);
  });

  describe('keeps the delete-first replacement where an in-place edit is not proven', () => {
    it('a create-only field that differs from AWS (DescribeType degraded it into an update)', async () => {
      route({ get: () => ({ Attributes: live() }) });
      const result = await provider.update(
        'Sub',
        SUB_ARN,
        TYPE,
        { ...BASE, Endpoint: DLQ_ARN },
        { ...BASE }
      );
      expect(replaced()).toBe(true);
      expect(setCalls()).toEqual([]);
      expect(result).toMatchObject({ physicalId: NEW_SUB_ARN, wasReplaced: true });
    });

    it('an attribute dropped from the template that has no proven reset (DeliveryPolicy)', async () => {
      route({
        get: () => ({ Attributes: live({ DeliveryPolicy: '{"healthyRetryPolicy":{"numRetries":3}}' }) }),
      });
      await provider.update('Sub', SUB_ARN, TYPE, { ...BASE }, { ...BASE });
      expect(replaced()).toBe(true);
      expect(setCalls()).toEqual([]);
    });

    it('FilterPolicy and FilterPolicyScope both changing (Subscribe sets them together)', async () => {
      route({ get: () => ({ Attributes: live({ FilterPolicy: '{"kind":["a"]}' }) }) });
      await provider.update(
        'Sub',
        SUB_ARN,
        TYPE,
        { ...BASE, FilterPolicy: { body: { kind: ['a'] } }, FilterPolicyScope: 'MessageBody' },
        { ...BASE }
      );
      expect(replaced()).toBe(true);
      expect(setCalls()).toEqual([]);
    });

    it('the PendingConfirmation placeholder id, which has no attributes to set', async () => {
      route({});
      await provider.update('Sub', 'PendingConfirmation', TYPE, { ...BASE }, { ...BASE });
      expect(sent().some((c) => c instanceof GetSubscriptionAttributesCommand)).toBe(false);
      expect(sent().some((c) => c instanceof SubscribeCommand)).toBe(true);
    });

    it('a subscription AWS no longer has (NotFound): it is created again, as before', async () => {
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof GetSubscriptionAttributesCommand || command instanceof UnsubscribeCommand) {
          return Promise.reject(new NotFoundException({ message: 'gone', $metadata: {} }));
        }
        if (command instanceof SubscribeCommand) return Promise.resolve({ SubscriptionArn: NEW_SUB_ARN });
        return Promise.reject(new Error('unexpected'));
      });
      const result = await provider.update('Sub', SUB_ARN, TYPE, { ...BASE }, { ...BASE });
      expect(result).toMatchObject({ physicalId: NEW_SUB_ARN, wasReplaced: true });
    });

    it('a readback with no attributes, even for a bag naming no create-only field', async () => {
      route({ get: () => ({}) });
      // The replacement's create then refuses the bag, as it did before.
      await expect(
        provider.update('Sub', SUB_ARN, TYPE, { RawMessageDelivery: true }, {})
      ).rejects.toThrow(/TopicArn is required/);
      expect(setCalls()).toEqual([]);
    });
  });

  it('fails without replacing when the readback fails for another reason', async () => {
    mockSend.mockImplementation((command: unknown) =>
      command instanceof GetSubscriptionAttributesCommand
        ? Promise.reject(Object.assign(new Error('User is not authorized to perform: SNS:GetSubscriptionAttributes'), { name: 'AuthorizationErrorException' }))
        : Promise.reject(new Error('unexpected'))
    );
    await expect(
      provider.update('Sub', SUB_ARN, TYPE, { ...BASE, RawMessageDelivery: true }, { ...BASE })
    ).rejects.toThrow(/Failed to update SNS subscription Sub/);
    expect(replaced()).toBe(false);
  });

  it('fails without replacing when SetSubscriptionAttributes fails, masking the message', async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof GetSubscriptionAttributesCommand) return Promise.resolve({ Attributes: live() });
      if (command instanceof SetSubscriptionAttributesCommand) {
        return Promise.reject(new Error('Invalid parameter: FilterPolicy s3cr3t-token-value'));
      }
      return Promise.reject(new Error('unexpected'));
    });
    const error = await provider
      .update('Sub', SUB_ARN, TYPE, { ...BASE, FilterPolicy: { k: ['s3cr3t-token-value'] } }, { ...BASE }, {
        maskSecrets: (t: string) => t.split('s3cr3t-token-value').join('***'),
      })
      .then(
        () => new Error('resolved'),
        (e: unknown) => e as Error
      );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/Failed to update SNS subscription Sub/);
    expect(error.message).not.toContain('s3cr3t-token-value');
    expect(replaced()).toBe(false);
  });
});
