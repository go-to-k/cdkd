/**
 * go-to-k/cdkd#5380: a rollback revert hands `update()` the keys a failed
 * deploy left unsettled (`UpdateContext.unsettledProperties`), since the
 * record it builds clears them: the provider converges them against AWS even
 * when the two bags agree there. A failed revert leaves the record, and its
 * names, as they were.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  replayRollback,
  replayFailedOperations,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import type { ResourceState } from '../../../src/types/state.js';
import type { UpdateContext } from '../../../src/types/resource.js';

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const TYPE = 'AWS::KinesisFirehose::DeliveryStream';
const ENC = 'DeliveryStreamEncryptionConfigurationInput';

function res(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys',
    resourceType: TYPE,
    properties: { DeliveryStreamName: 'phys' },
    attributes: {},
    dependencies: [],
    ...overrides,
  };
}

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setLevel: vi.fn(),
  child: () => silentLogger,
} as unknown as RollbackExecutorContext['logger'];

function ctxWith(update: unknown, hooks: Record<string, unknown> = {}): RollbackExecutorContext {
  return {
    region: 'us-east-1',
    logger: silentLogger,
    providerRegistry: {
      getProviderFor: () => ({ provider: { update, ...hooks } }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
    recordEvent: vi.fn(),
  };
}

const failedOp = (): FailedOperation[] => [
  {
    logicalId: 'S',
    changeType: 'UPDATE',
    resourceType: TYPE,
    physicalId: 'phys',
    previousState: res(),
    // The failed convergence's attempted bag equals the restored one.
    attemptedProperties: { DeliveryStreamName: 'phys' },
  } as unknown as FailedOperation,
];

describe('--revert-failed converges what a failed deploy left unsettled (go-to-k/cdkd#5380)', () => {
  it('hands the carried key to update() and clears it once the revert succeeded', async () => {
    let seen: UpdateContext | undefined;
    const update = vi.fn(async (...args: unknown[]) => {
      seen = args[5] as UpdateContext;
      return { physicalId: 'phys', wasReplaced: false };
    });
    const state = { S: res({ unsettledProperties: [ENC] }) };
    const result = await replayFailedOperations(failedOp(), state, 'stack', ctxWith(update));
    expect(result.failures).toBe(0);
    expect(update).toHaveBeenCalledOnce();
    expect([...(seen?.unsettledProperties ?? [])]).toEqual([ENC]);
    expect(state.S).not.toHaveProperty('unsettledProperties');
  });

  it('a revert that fails keeps the key on the record', async () => {
    const update = vi.fn(async () => {
      throw new Error('AccessDenied');
    });
    const state = { S: res({ unsettledProperties: [ENC] }) };
    await replayFailedOperations(failedOp(), state, 'stack', ctxWith(update));
    expect(update).toHaveBeenCalled();
    expect(state.S.unsettledProperties).toEqual([ENC]);
  });

  it('a record with nothing unsettled hands no unsettledProperties', async () => {
    let seen: UpdateContext | undefined;
    const update = vi.fn(async (...args: unknown[]) => {
      seen = args[5] as UpdateContext;
      return { physicalId: 'phys', wasReplaced: false };
    });
    await replayFailedOperations(failedOp(), { S: res() }, 'stack', ctxWith(update));
    expect(update).toHaveBeenCalledOnce();
    expect(seen).not.toHaveProperty('unsettledProperties');
  });
});

describe('the revert of a completed UPDATE converges what its previous record names unsettled', () => {
  it('hands the previous record\'s key to update()', async () => {
    let seen: UpdateContext | undefined;
    const update = vi.fn(async (...args: unknown[]) => {
      seen = args[5] as UpdateContext;
      return { physicalId: 'phys', wasReplaced: false };
    });
    const ops = [
      {
        logicalId: 'S',
        changeType: 'UPDATE',
        resourceType: TYPE,
        physicalId: 'phys',
        previousState: res({ properties: { DeliveryStreamName: 'phys', Note: 'a' }, unsettledProperties: [ENC] }),
      } as unknown as CompletedOperation,
    ];
    const state = { S: res({ properties: { DeliveryStreamName: 'phys', Note: 'b' } }) };
    const result = await replayRollback(ops, state, 'stack', ctxWith(update));
    expect(result.failures).toBe(0);
    expect([...(seen?.unsettledProperties ?? [])]).toEqual([ENC]);
    expect(state.S).not.toHaveProperty('unsettledProperties');
  });
});

describe('--revert-failed takes the convergence step before the removal step (go-to-k/cdkd#5487)', () => {
  it('hands update() the live value of an unsettled key as the previous side', async () => {
    let previous: Record<string, unknown> | undefined;
    const update = vi.fn(async (...args: unknown[]) => {
      previous = args[4] as Record<string, unknown>;
      return { physicalId: 'phys', wasReplaced: false };
    });
    const state = { S: res({ unsettledProperties: [ENC] }) };
    await replayFailedOperations(
      failedOp(),
      state,
      'stack',
      ctxWith(update, {
        readCurrentState: async () => ({ DeliveryStreamName: 'phys', [ENC]: { KeyType: 'AWS_OWNED_CMK' } }),
      })
    );
    expect(previous?.[ENC]).toEqual({ KeyType: 'AWS_OWNED_CMK' });
  });

  it('refuses the revert while the key is in transition, keeping the name', async () => {
    const update = vi.fn(async () => ({ physicalId: 'phys', wasReplaced: false }));
    const state = { S: res({ unsettledProperties: [ENC] }) };
    await replayFailedOperations(
      failedOp(),
      state,
      'stack',
      ctxWith(update, {
        unsettledInTransition: async (_p: string, _l: string, _t: string, n: ReadonlySet<string>) => n,
      })
    );
    expect(update).not.toHaveBeenCalled();
    expect(state.S.unsettledProperties).toEqual([ENC]);
  });
});
