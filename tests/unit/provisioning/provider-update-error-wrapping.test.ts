import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Issue #1267: these four providers wrapped their create()/delete() SDK errors
// in ProvisioningError but left update() unwrapped, so an AWS SDK error from an
// update surfaced raw and bypassed cdkd's typed error formatting / exit-code
// handling. Each provider now wraps at the update() boundary.
//
// One shared client mock per service — every provider reads its client off
// getAwsClients() in the constructor.
const mockEventBridgeSend = vi.fn();
const mockSnsSend = vi.fn();
const mockLambdaSend = vi.fn();
const mockLogsSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    eventBridge: {
      send: mockEventBridgeSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
    sns: { send: mockSnsSend, config: { region: () => Promise.resolve('us-east-1') } },
    lambda: { send: mockLambdaSend, config: { region: () => Promise.resolve('us-east-1') } },
    cloudWatchLogs: { send: mockLogsSend, config: { region: () => Promise.resolve('us-east-1') } },
    sts: {
      send: vi.fn(() => Promise.resolve({ Account: '123456789012' })),
      config: { region: () => Promise.resolve('us-east-1') },
    },
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

import { EventBridgeBusProvider } from '../../../src/provisioning/providers/eventbridge-bus-provider.js';
import { SNSTopicProvider } from '../../../src/provisioning/providers/sns-topic-provider.js';
import { LambdaEventSourceMappingProvider } from '../../../src/provisioning/providers/lambda-eventsource-provider.js';
import { LogsLogGroupProvider } from '../../../src/provisioning/providers/logs-loggroup-provider.js';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../src/utils/error-handler.js';
import {
  isRetryableTransientError,
  isThrottlingError,
} from '../../../src/deployment/retryable-errors.js';

/**
 * Each case drives its provider's update() into at least one AWS `send` by
 * changing a mutable property, with the mocked client rejecting.
 */
const CASES = [
  {
    name: 'EventBridgeBusProvider',
    resourceType: 'AWS::Events::EventBus',
    logicalId: 'MyBus',
    physicalId: 'my-bus',
    expectedPrefix: 'Failed to update EventBus MyBus',
    mock: () => mockEventBridgeSend,
    make: () => new EventBridgeBusProvider(),
    next: { Name: 'my-bus', Description: 'after' },
    prev: { Name: 'my-bus', Description: 'before' },
  },
  {
    name: 'SNSTopicProvider',
    resourceType: 'AWS::SNS::Topic',
    logicalId: 'MyTopic',
    physicalId: 'arn:aws:sns:us-east-1:123456789012:my-topic',
    expectedPrefix: 'Failed to update SNS topic MyTopic',
    mock: () => mockSnsSend,
    make: () => new SNSTopicProvider(),
    next: { TopicName: 'my-topic', DisplayName: 'after' },
    prev: { TopicName: 'my-topic', DisplayName: 'before' },
  },
  {
    name: 'LambdaEventSourceMappingProvider',
    resourceType: 'AWS::Lambda::EventSourceMapping',
    logicalId: 'MyEsm',
    physicalId: '00000000-1111-2222-3333-444444444444',
    expectedPrefix: 'Failed to update event source mapping MyEsm',
    mock: () => mockLambdaSend,
    make: () => new LambdaEventSourceMappingProvider(),
    next: { FunctionName: 'fn', BatchSize: 20 },
    prev: { FunctionName: 'fn', BatchSize: 10 },
  },
  {
    name: 'LogsLogGroupProvider',
    resourceType: 'AWS::Logs::LogGroup',
    logicalId: 'MyLg',
    physicalId: '/cdkd/my-lg',
    expectedPrefix: 'Failed to update log group MyLg',
    mock: () => mockLogsSend,
    make: () => new LogsLogGroupProvider(),
    next: { LogGroupName: '/cdkd/my-lg', RetentionInDays: 30 },
    prev: { LogGroupName: '/cdkd/my-lg', RetentionInDays: 7 },
  },
] as const;

describe('SDK provider update() error wrapping (issue #1267)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const c of CASES) {
    describe(c.name, () => {
      it('wraps an AWS SDK update failure in ProvisioningError', async () => {
        const sdkError = new Error('AWS said no');
        c.mock().mockRejectedValue(sdkError);

        const provider = c.make();
        const promise = provider.update(
          c.logicalId,
          c.physicalId,
          c.resourceType,
          { ...c.next },
          { ...c.prev }
        );

        await expect(promise).rejects.toThrow(ProvisioningError);
        await expect(promise).rejects.toThrow(`${c.expectedPrefix}: AWS said no`);
        await expect(promise).rejects.toMatchObject({
          resourceType: c.resourceType,
          logicalId: c.logicalId,
          physicalId: c.physicalId,
          cause: sdkError,
        });
        // Sanity: the case actually reached an AWS call, so the assertion above
        // is not passing vacuously on some earlier throw.
        expect(c.mock()).toHaveBeenCalled();
      });

      it('wraps a non-Error rejection with a stringified message and no cause', async () => {
        c.mock().mockRejectedValue('boom');

        const provider = c.make();
        const promise = provider.update(
          c.logicalId,
          c.physicalId,
          c.resourceType,
          { ...c.next },
          { ...c.prev }
        );

        await expect(promise).rejects.toThrow(ProvisioningError);
        await expect(promise).rejects.toThrow(`${c.expectedPrefix}: boom`);
        const caught = await promise.catch((e: unknown) => e);
        expect((caught as Error).cause).toBeUndefined();
      });
    });
  }

  // Wrapping is exactly the change that historically breaks throttle
  // classification: the deploy engine's withRetry decides whether to back off
  // by inspecting the error, and a wrapper that hid the SDK error would turn a
  // retryable throttle into a hard failure. `isThrottlingError` walks the
  // `.cause` chain, and the wrapper message embeds the original message, so
  // both detection routes must still fire through the wrap.
  it('keeps a wrapped throttle classifiable as a retryable transient error', async () => {
    const throttle = Object.assign(new Error('Rate exceeded'), {
      name: 'ThrottlingException',
      $metadata: { httpStatusCode: 400 },
    });
    mockEventBridgeSend.mockRejectedValue(throttle);

    const provider = new EventBridgeBusProvider();
    const caught = await provider
      .update(
        'MyBus',
        'my-bus',
        'AWS::Events::EventBus',
        { Name: 'my-bus', Description: 'after' },
        { Name: 'my-bus', Description: 'before' }
      )
      .catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(ProvisioningError);
    expect(isThrottlingError(caught)).toBe(true);
    expect(isRetryableTransientError(caught, (caught as Error).message)).toBe(true);
  });

  // Every case above fails on the FIRST send. This one fails on a LATER send
  // (the tags diff, after UpdateEventBus and DescribeEventBus both succeed) so
  // the wrap is proven to cover non-first calls and the otherwise-untouched
  // tags-diff sub-path.
  it('wraps a mid-sequence failure after earlier sends succeeded', async () => {
    const tagFailure = new Error('Tagging blew up');
    mockEventBridgeSend.mockImplementation((command: unknown) => {
      const name = (command as object).constructor.name;
      if (name === 'UpdateEventBusCommand') return Promise.resolve({});
      if (name === 'DescribeEventBusCommand') {
        return Promise.resolve({ Arn: 'arn:aws:events:us-east-1:123456789012:event-bus/my-bus' });
      }
      if (name === 'TagResourceCommand' || name === 'UntagResourceCommand') {
        return Promise.reject(tagFailure);
      }
      return Promise.resolve({});
    });

    const provider = new EventBridgeBusProvider();
    const promise = provider.update(
      'MyBus',
      'my-bus',
      'AWS::Events::EventBus',
      { Name: 'my-bus', Description: 'after', Tags: [{ Key: 'a', Value: '2' }] },
      { Name: 'my-bus', Description: 'before', Tags: [{ Key: 'a', Value: '1' }] }
    );

    await expect(promise).rejects.toThrow(ProvisioningError);
    await expect(promise).rejects.toThrow('Failed to update EventBus MyBus: Tagging blew up');
    await expect(promise).rejects.toMatchObject({ cause: tagFailure });
    // Prove the earlier sends really did run before the failing one.
    const sent = mockEventBridgeSend.mock.calls.map((c) => (c[0] as object).constructor.name);
    expect(sent).toContain('UpdateEventBusCommand');
    expect(sent.length).toBeGreaterThan(1);
  });

  // The load-bearing case: LogsLogGroupProvider.update() throws the typed
  // ResourceUpdateNotSupportedError on a LogGroupClass change, and the deploy
  // engine matches it BY CLASS to fall back to replacement. If the new wrap
  // swallowed it into a ProvisioningError, a recoverable class change would
  // become a hard failure. (logs-loggroup-provider-class-guard.test.ts covers
  // the guard itself; this pins that the wrap does not re-classify it.)
  it('does not re-wrap ResourceUpdateNotSupportedError from the LogGroupClass guard', async () => {
    mockLogsSend.mockResolvedValue({});
    const provider = new LogsLogGroupProvider();

    const promise = provider.update(
      'ClassLg',
      '/cdkd/class-lg',
      'AWS::Logs::LogGroup',
      { LogGroupName: '/cdkd/class-lg', LogGroupClass: 'INFREQUENT_ACCESS' },
      { LogGroupName: '/cdkd/class-lg', LogGroupClass: 'STANDARD' }
    );

    await expect(promise).rejects.toThrow(ResourceUpdateNotSupportedError);
    await expect(promise).rejects.not.toThrow(ProvisioningError);
    // The guard runs before any mutation.
    expect(mockLogsSend).not.toHaveBeenCalled();
  });
});
