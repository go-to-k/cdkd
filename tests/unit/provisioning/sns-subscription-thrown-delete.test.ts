import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { NotFoundException, SubscribeCommand, UnsubscribeCommand } from '@aws-sdk/client-sns';

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
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
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

function unsubscribeCalls(): unknown[] {
  return mockSend.mock.calls.filter((call) => call[0] instanceof UnsubscribeCommand);
}

describe('SNSSubscriptionProvider.update: a THROWN delete (issue #1967)', () => {
  let provider: SNSSubscriptionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SNSSubscriptionProvider();
  });

  /** Every SNS call succeeds except `Unsubscribe`, which fails the way AWS does. */
  function wireFailingUnsubscribe(message: string): void {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof UnsubscribeCommand) {
        return Promise.reject(Object.assign(new Error(message), { name: 'AuthorizationError' }));
      }
      if (cmd instanceof SubscribeCommand) {
        return Promise.resolve({ SubscriptionArn: NEW_SUB_ARN });
      }
      return Promise.resolve({ Attributes: {} });
    });
  }

  it('does NOT create the replacement — the duplicate is what the create would ADD', async () => {
    // THE discriminator. Before the fix the `Subscribe` went out anyway and
    // both subscriptions delivered every message on the topic.
    wireFailingUnsubscribe('User is not authorized to perform: SNS:Unsubscribe');

    await expect(
      provider.update('Sub', OLD_SUB_ARN, 'AWS::SNS::Subscription', PROPERTIES, PROPERTIES)
    ).rejects.toThrow();

    expect(unsubscribeCalls()).toHaveLength(1);
    expect(subscribeCalls()).toHaveLength(0);
  });

  it('DOES create the replacement when the delete succeeded', async () => {
    // The polarity. Without it the case above is satisfied by a provider that
    // never replaces a subscription at all.
    mockSend.mockImplementation((cmd: unknown) => {
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
    mockSend.mockImplementation(() => Promise.resolve({ SubscriptionArn: NEW_SUB_ARN }));

    await expect(
      skipping.update('Sub', OLD_SUB_ARN, 'AWS::SNS::Subscription', PROPERTIES, PROPERTIES)
    ).rejects.toThrow(/could not delete the old subscription/);

    expect(subscribeCalls()).toHaveLength(0);
  });
});
