import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue #1778, caller-side coverage for the SNS DELETE-first replacement abort.
 *
 * The abort itself is pinned at the `update()` entry point by
 * `replace-path-delete-skip-outcome.test.ts`. None of `update()`'s three
 * callers was exercised there, and the one that matters is the rollback
 * executor's `revert` arm: it wraps `provider.update()` in `withRetry`
 * (`updateWithRollbackRetry`), so a deterministic abort would be re-attempted
 * through the full backoff schedule unless the thrown message is rejected by
 * `isRetryableTransientError`. The in-code comment on the abort asserts it is
 * right for every caller; this suite is what backs that assertion for the
 * caller whose retry wrapper could have falsified it.
 *
 * It drives the REAL `replayRollback` against the REAL provider, with only the
 * inner `delete` / `create` mocked, so the retry wrapper, the classifier and
 * the executor's best-effort accounting are all the shipped ones.
 */

const warnSpy = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sns: { send, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => child,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import {
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { SNSSubscriptionProvider } from '../../../src/provisioning/providers/sns-subscription-provider.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { ResourceState } from '../../../src/types/state.js';

const TOPIC = 'arn:aws:sns:us-east-1:123456789012:MyTopic';
const ARN = `${TOPIC}:11111111-1111-1111-1111-111111111111`;
const NEW_ARN = `${TOPIC}:22222222-2222-2222-2222-222222222222`;
const SKIP_REASON = 'malformed physicalId in state — no delete issued';

const OLD_PROPS = { TopicArn: TOPIC, Protocol: 'sqs', Endpoint: 'arn:aws:sqs:us-east-1:1:old' };
const NEW_PROPS = { TopicArn: TOPIC, Protocol: 'sqs', Endpoint: 'arn:aws:sqs:us-east-1:1:new' };

const rollbackLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function resourceState(properties: Record<string, unknown>): ResourceState {
  return {
    physicalId: ARN,
    resourceType: 'AWS::SNS::Subscription',
    properties,
    attributes: {},
    dependencies: [],
  };
}

/** An in-place UPDATE op — same physicalId on both sides, so it classifies `revert`. */
function updateOp(): CompletedOperation {
  return {
    logicalId: 'MySub',
    changeType: 'UPDATE',
    resourceType: 'AWS::SNS::Subscription',
    physicalId: ARN,
    previousState: resourceState(OLD_PROPS),
  };
}

function contextFor(provider: SNSSubscriptionProvider): RollbackExecutorContext {
  return {
    providerRegistry: {
      getProviderFor: () => ({ provider, provisionedBy: 'sdk' as const }),
    } as unknown as ProviderRegistry,
    region: 'us-east-1',
    logger: rollbackLogger as unknown as RollbackExecutorContext['logger'],
  };
}

describe("the SNS replacement abort surfaces ONCE through the rollback executor's revert arm (issue #1778)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    send.mockReset();
  });

  /**
   * The HOSTILE row is the one with teeth: `does not exist` is a real entry in
   * `RETRYABLE_ERROR_MESSAGE_PATTERNS`, so interpolating the provider-supplied
   * `reason` into the thrown message would make this exact abort classify as
   * transient and take all 9 attempts here.
   */
  it.each([
    ['benign', SKIP_REASON],
    ['hostile', 'malformed physicalId in state — the recorded subscription does not exist'],
  ])(
    'a %s skip reason surfaces after ONE attempt and is counted as one failure',
    async (_kind, reason) => {
      const provider = new SNSSubscriptionProvider();
      const updateSpy = vi.spyOn(provider, 'update');
      const createSpy = vi.spyOn(provider, 'create');
      vi.spyOn(provider, 'delete').mockResolvedValue({ outcome: 'skipped', reason });

      const stateResources: Record<string, ResourceState> = { MySub: resourceState(NEW_PROPS) };

      const result = await replayRollback(
        [updateOp()],
        stateResources,
        'MyStack',
        contextFor(provider)
      );

      // ONE attempt. `withRetry`'s default schedule is 8 retries (9 attempts),
      // so anything above 1 means the abort was classified transient.
      expect(updateSpy).toHaveBeenCalledTimes(1);
      // No duplicate subscription was created on the rollback path either.
      expect(createSpy).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();

      // The executor's best-effort handler counts it and keeps going.
      expect(result.failures).toBe(1);
      expect(result.interrupted).toBe(false);

      // The rollback warning names the resource and the consequence...
      const rollbackWarnings = rollbackLogger.warn.mock.calls.map((call) => String(call[0]));
      expect(rollbackWarnings.some((m) => m.includes('Rollback failed for MySub'))).toBe(true);
      expect(rollbackWarnings.some((m) => m.includes('deliver every message twice'))).toBe(true);
      // ...and the state record is NOT rewritten to the reverted properties,
      // so the subscription stays traceable.
      expect(stateResources['MySub']?.properties).toEqual(NEW_PROPS);
    }
  );

  it('INVERTED CONTROL — a successful delete lets the same revert complete', async () => {
    const provider = new SNSSubscriptionProvider();
    const updateSpy = vi.spyOn(provider, 'update');
    vi.spyOn(provider, 'delete').mockResolvedValue(undefined);
    vi.spyOn(provider, 'create').mockResolvedValue({ physicalId: NEW_ARN, attributes: {} });

    const stateResources: Record<string, ResourceState> = { MySub: resourceState(NEW_PROPS) };

    const result = await replayRollback(
      [updateOp()],
      stateResources,
      'MyStack',
      contextFor(provider)
    );

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(result.failures).toBe(0);
    expect(stateResources['MySub']?.properties).toEqual(OLD_PROPS);
  });
});
