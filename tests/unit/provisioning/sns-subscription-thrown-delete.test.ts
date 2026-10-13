import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetSubscriptionAttributesCommand,
  InvalidParameterException,
  NotFoundException,
  SubscribeCommand,
  UnsubscribeCommand,
} from '@aws-sdk/client-sns';

// Issue #1967: `SNSSubscriptionProvider.update` replaces DELETE-first, and its
// skip arm already ABORTS — creating while the old subscription is still live
// puts two subscriptions on the topic and delivers every message twice. The
// THROWN delete fell through that guard: warn, then `create()` anyway, i.e.
// exactly the duplicate the skip arm exists to prevent.
//
// The discriminator throughout is that `create()` was NOT reached. A test
// asserting only "update rejected" would also pass against a provider that
// creates the duplicate and then throws.
const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sns: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

const warnSpy = vi.fn();
const debugSpy = vi.fn();
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: (...args: unknown[]) => debugSpy(...args),
    info: vi.fn(),
    warn: (...args: unknown[]) => warnSpy(...args),
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

import {
  SNSSubscriptionProvider,
  SNS_SUBSCRIPTION_DELETE_THREW_REASON,
} from '../../../src/provisioning/providers/sns-subscription-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { RETRYABLE_ERROR_MESSAGE_PATTERNS } from '../../../src/deployment/retryable-errors.js';

const TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:my-topic';
const OLD_SUB_ARN = `${TOPIC_ARN}:11111111-1111-1111-1111-111111111111`;
const NEW_SUB_ARN = `${TOPIC_ARN}:22222222-2222-2222-2222-222222222222`;

const PROPERTIES = {
  TopicArn: TOPIC_ARN,
  Protocol: 'sqs',
  Endpoint: 'arn:aws:sqs:us-east-1:123456789012:my-queue',
};

function subscribeCalls(): unknown[] {
  return mockSend.mock.calls.filter((call) => call[0] instanceof SubscribeCommand);
}

function readbackCalls(): unknown[] {
  return mockSend.mock.calls.filter((call) => call[0] instanceof GetSubscriptionAttributesCommand);
}

/**
 * The readback `update()` takes first (go-to-k/cdkd#4853): AWS holds ANOTHER
 * endpoint, a create-only difference, so the change takes the DELETE-first
 * replacement this file pins. An attribute-only edit is applied in place.
 */
const REPLACING_READBACK = {
  Attributes: { ...PROPERTIES, Endpoint: 'arn:aws:sqs:us-east-1:123456789012:old-queue' },
};

function unsubscribeCalls(): unknown[] {
  return mockSend.mock.calls.filter((call) => call[0] instanceof UnsubscribeCommand);
}

describe('SNSSubscriptionProvider.update: a THROWN delete (issue #1967)', () => {
  let provider: SNSSubscriptionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SNSSubscriptionProvider();
  });

  /**
   * The readback reports a create-only difference (the replacement path), and
   * every other SNS call succeeds except `Unsubscribe`, which fails the way
   * AWS does.
   */
  function wireFailingUnsubscribe(message: string): void {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetSubscriptionAttributesCommand) return Promise.resolve(REPLACING_READBACK);
      if (cmd instanceof UnsubscribeCommand) {
        return Promise.reject(Object.assign(new Error(message), { name: 'AuthorizationError' }));
      }
      if (cmd instanceof SubscribeCommand) {
        return Promise.resolve({ SubscriptionArn: NEW_SUB_ARN });
      }
      return Promise.reject(new Error('unexpected SNS call'));
    });
  }

  it('does NOT create the replacement — the duplicate is what the create would ADD', async () => {
    // THE discriminator. Before the fix the `Subscribe` went out anyway and
    // both subscriptions delivered every message on the topic.
    wireFailingUnsubscribe('User is not authorized to perform: SNS:Unsubscribe');

    await expect(
      provider.update('Sub', OLD_SUB_ARN, 'AWS::SNS::Subscription', PROPERTIES, PROPERTIES)
    ).rejects.toThrow();

    expect(readbackCalls()).toHaveLength(1);
    expect(unsubscribeCalls()).toHaveLength(1);
    expect(subscribeCalls()).toHaveLength(0);
  });

  it('DOES create the replacement when the delete succeeded', async () => {
    // The polarity. Without it the case above is satisfied by a provider that
    // never replaces a subscription at all.
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetSubscriptionAttributesCommand) return Promise.resolve(REPLACING_READBACK);
      if (cmd instanceof SubscribeCommand) return Promise.resolve({ SubscriptionArn: NEW_SUB_ARN });
      return Promise.resolve({});
    });

    const result = await provider.update(
      'Sub',
      OLD_SUB_ARN,
      'AWS::SNS::Subscription',
      PROPERTIES,
      PROPERTIES
    );

    expect(unsubscribeCalls()).toHaveLength(1);
    expect(subscribeCalls()).toHaveLength(1);
    expect(result).toMatchObject({ physicalId: NEW_SUB_ARN, wasReplaced: true });
  });

  it('reports the abort as ONE rule with the skip arm, naming the duplicate', async () => {
    wireFailingUnsubscribe('Rate exceeded');

    await expect(
      provider.update('Sub', OLD_SUB_ARN, 'AWS::SNS::Subscription', PROPERTIES, PROPERTIES)
    ).rejects.toThrow(/deliver every message[\s\S]*twice/);

    const warnings = warnSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warnings).toContain('was not deleted');
    expect(warnings).toContain(SNS_SUBSCRIPTION_DELETE_THREW_REASON);
    // The AWS text is diagnosable, on its own line.
    expect(warnings).toContain('Rate exceeded');
  });

  it('marks the refusal NON-RETRYABLE, so a rollback caller cannot replay it', async () => {
    // `rollback-executor.ts` / `drift --revert` wrap `update()` in `withRetry`
    // with the default classifier, and that classifier matches by SUBSTRING —
    // an ordinary composite logical id already carries a retryable pattern
    // (measured on `DependencyViolation`). The marker is consulted first.
    wireFailingUnsubscribe('Rate exceeded');

    const error = await provider
      .update('MyDependencyViolationSub', OLD_SUB_ARN, 'AWS::SNS::Subscription', PROPERTIES, PROPERTIES)
      .catch((e: unknown) => e);

    expect(isMarkedNonRetryable(error)).toBe(true);
  });

  it('keeps the AWS message OUT of the thrown error, where a classifier reads it', async () => {
    // Same rule the skip arm follows: a message is what the retry and
    // already-deleted classifiers match on, so an AWS text carrying `does not
    // exist` / `Rate exceeded` must not be interpolated into it.
    wireFailingUnsubscribe('Rate exceeded because the subscription does not exist');

    const error = await provider
      .update('Sub', OLD_SUB_ARN, 'AWS::SNS::Subscription', PROPERTIES, PROPERTIES)
      .catch((e: unknown) => e);

    const message = (error as Error).message;
    expect(message).not.toContain('Rate exceeded');
    expect(message).not.toContain('does not exist');
    expect(message).toContain('Sub');
  });

  it('keeps the recorded reason clear of every retryable pattern the callers match on', () => {
    for (const pattern of RETRYABLE_ERROR_MESSAGE_PATTERNS) {
      expect(SNS_SUBSCRIPTION_DELETE_THREW_REASON.toLowerCase()).not.toContain(
        pattern.toLowerCase()
      );
    }
  });

  it('treats an ALREADY-GONE subscription as deleted, and still creates the replacement', async () => {
    // Load-bearing since #1967, and unfenced before it: `delete()` answers
    // `NotFoundException` with SUCCESS, and that arm is now the ONLY way a
    // partially-replaced subscription converges. Making it throw leaves every
    // other SNS test in the tree green (measured), because the abort above
    // then swallows the difference — this case is what tells the two apart.
    //
    // The realistic shape: a previous run's Unsubscribe DID land but cdkd
    // failed before recording it, so the re-run finds the subscription gone
    // and must go on to create the new one rather than refusing forever.
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetSubscriptionAttributesCommand) return Promise.resolve(REPLACING_READBACK);
      if (cmd instanceof UnsubscribeCommand) {
        return Promise.reject(
          new NotFoundException({ message: 'Subscription does not exist', $metadata: {} })
        );
      }
      if (cmd instanceof SubscribeCommand) return Promise.resolve({ SubscriptionArn: NEW_SUB_ARN });
      return Promise.resolve({});
    });

    const result = await provider.update(
      'Sub',
      OLD_SUB_ARN,
      'AWS::SNS::Subscription',
      PROPERTIES,
      PROPERTIES
    );

    expect(unsubscribeCalls()).toHaveLength(1);
    expect(subscribeCalls()).toHaveLength(1);
    expect(result).toMatchObject({ physicalId: NEW_SUB_ARN, wasReplaced: true });
  });

  it('still aborts on a SKIPPED delete — the arm this one was made to match', async () => {
    // Pins that unifying the two arms did not drop the original guard. The
    // skip family has no producer in this provider today, so the outcome is
    // injected directly.
    const skipping = new SNSSubscriptionProvider();
    vi.spyOn(skipping, 'delete').mockResolvedValue({
      outcome: 'skipped',
      reason: 'malformed physicalId in state',
    });
    mockSend.mockImplementation((cmd: unknown) =>
      Promise.resolve(
        cmd instanceof GetSubscriptionAttributesCommand
          ? REPLACING_READBACK
          : { SubscriptionArn: NEW_SUB_ARN }
      )
    );

    await expect(
      skipping.update('Sub', OLD_SUB_ARN, 'AWS::SNS::Subscription', PROPERTIES, PROPERTIES)
    ).rejects.toThrow(/could not delete the old subscription/);

    expect(subscribeCalls()).toHaveLength(0);
  });
});

// go-to-k/cdkd#2007: the replacement's inner delete gets the update's masker,
// and the delete masks the subscription ARN (it embeds the topic name).
describe('SNSSubscriptionProvider delete masking (go-to-k/cdkd#2007)', () => {
  const maskSecrets = (text: string): string => text.split('my-topic').join('***');

  beforeEach(() => vi.clearAllMocks());

  it("forwards update()'s masker into the replacement's inner delete", async () => {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetSubscriptionAttributesCommand) return Promise.resolve(REPLACING_READBACK);
      if (cmd instanceof SubscribeCommand) return Promise.resolve({ SubscriptionArn: NEW_SUB_ARN });
      return Promise.resolve({});
    });
    const provider = new SNSSubscriptionProvider();
    const del = vi.spyOn(provider, 'delete');

    await provider.update('Sub', OLD_SUB_ARN, 'AWS::SNS::Subscription', PROPERTIES, PROPERTIES, {
      maskSecrets,
    });

    const forwarded = del.mock.calls[0]![4]?.maskSecrets;
    expect(forwarded).toBeTypeOf('function');
    expect(forwarded!(OLD_SUB_ARN)).not.toContain('my-topic');
  });

  it('masks the topic name in the failure the delete throws', async () => {
    mockSend.mockRejectedValue(
      Object.assign(new Error(`${OLD_SUB_ARN} cannot be removed`), { name: 'AuthorizationError' })
    );
    const error = await new SNSSubscriptionProvider()
      .delete('Sub', OLD_SUB_ARN, 'AWS::SNS::Subscription', undefined, { maskSecrets })
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );
    expect(error?.message).toContain('cannot be removed');
    expect(error?.message).not.toContain('my-topic');
  });

  function lines(): string {
    return [...debugSpy.mock.calls, ...warnSpy.mock.calls].map((c) => String(c[0])).join('\n');
  }

  it('masks the ARN on the deleting and already-gone lines', async () => {
    mockSend.mockRejectedValue(new NotFoundException({ message: 'gone', $metadata: {} }));
    await new SNSSubscriptionProvider().delete('Sub', OLD_SUB_ARN, 'AWS::SNS::Subscription', undefined, {
      maskSecrets,
    });
    expect(lines()).toContain('Deleting SNS subscription Sub');
    expect(lines()).toContain('does not exist');
    expect(lines()).not.toContain('my-topic');
  });

  it('masks the ARN on the pending-confirmation skip warning', async () => {
    mockSend.mockRejectedValue(
      new InvalidParameterException({
        message: 'Cannot unsubscribe a subscription that is pending confirmation',
        $metadata: {},
      })
    );
    await new SNSSubscriptionProvider().delete('Sub', OLD_SUB_ARN, 'AWS::SNS::Subscription', undefined, {
      maskSecrets,
    });
    expect(lines()).toContain('pending confirmation');
    expect(lines()).not.toContain('my-topic');
  });
});
