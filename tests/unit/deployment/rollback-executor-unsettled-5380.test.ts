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

describe('a rollback revert settles an unsettled name only on proof (go-to-k/cdkd#5487)', () => {
  /** AWS holds `before` until update() runs, then `after`. */
  function aws(before: Record<string, unknown>, after: Record<string, unknown>) {
    let live = before;
    return {
      update: vi.fn(async () => {
        live = after;
        return { physicalId: 'phys', wasReplaced: false };
      }),
      hooks: { readCurrentState: async () => ({ ...live }) },
    };
  }
  const failedNote = (): FailedOperation[] => [
    {
      logicalId: 'S',
      changeType: 'UPDATE',
      resourceType: TYPE,
      physicalId: 'phys',
      previousState: res({ properties: { DeliveryStreamName: 'phys', Note: 'a' } }),
      attemptedProperties: { DeliveryStreamName: 'phys', Note: 'b' },
    } as unknown as FailedOperation,
  ];
  const record = () => res({ properties: { DeliveryStreamName: 'phys', Note: 'b' }, unsettledProperties: ['Note'] });

  it('--revert-failed: cleared once AWS holds the restored value', async () => {
    const f = aws({ DeliveryStreamName: 'phys', Note: 'b' }, { DeliveryStreamName: 'phys', Note: 'a' });
    const state = { S: record() };
    await replayFailedOperations(failedNote(), state, 'stack', ctxWith(f.update, f.hooks));
    expect(f.update).toHaveBeenCalledOnce();
    expect(state.S).not.toHaveProperty('unsettledProperties');
  });

  it('--revert-failed: kept when AWS still shows another value after a successful call', async () => {
    const f = aws({ DeliveryStreamName: 'phys', Note: 'b' }, { DeliveryStreamName: 'phys', Note: 'b' });
    const state = { S: record() };
    await replayFailedOperations(failedNote(), state, 'stack', ctxWith(f.update, f.hooks));
    expect(f.update).toHaveBeenCalledOnce();
    expect(state.S.unsettledProperties).toEqual(['Note']);
  });

  it.each([
    ['cleared once AWS holds the restored value', { Note: 'a' }, undefined],
    ['kept when AWS still shows another value', { Note: 'b' }, ['Note']],
  ])('revert of a completed UPDATE: %s', async (_l, after, expected) => {
    const f = aws({ DeliveryStreamName: 'phys', Note: 'b' }, { DeliveryStreamName: 'phys', ...after });
    const ops = [
      {
        logicalId: 'S',
        changeType: 'UPDATE',
        resourceType: TYPE,
        physicalId: 'phys',
        previousState: res({ properties: { DeliveryStreamName: 'phys', Note: 'a' }, unsettledProperties: ['Note'] }),
      } as unknown as CompletedOperation,
    ];
    const state = { S: res({ properties: { DeliveryStreamName: 'phys', Note: 'b' } }) };
    await replayRollback(ops, state, 'stack', ctxWith(f.update, f.hooks));
    expect(f.update).toHaveBeenCalledOnce();
    expect(state.S.unsettledProperties).toEqual(expected);
  });
});

describe('a rollback revert carries attempted items (go-to-k/cdkd#5498)', () => {
  const failedNote = (previousState: ResourceState): FailedOperation[] => [
    {
      logicalId: 'S',
      changeType: 'UPDATE',
      resourceType: TYPE,
      physicalId: 'phys',
      previousState,
      attemptedProperties: { DeliveryStreamName: 'phys', Note: 'b' },
    } as unknown as FailedOperation,
  ];
  const recorded = () =>
    res({
      properties: { DeliveryStreamName: 'phys', Note: 'b' },
      unsettledProperties: ['Note'],
      unsettledItems: { Note: ['x'] },
    });
  /** AWS holds `before` until update(), then `after`; readUnsettled sees the items. */
  function aws(after: Record<string, unknown>) {
    let live: Record<string, unknown> = { DeliveryStreamName: 'phys', Note: 'b' };
    const seen: Array<ReadonlyMap<string, ReadonlySet<string>> | undefined> = [];
    return {
      seen,
      update: vi.fn(async () => {
        live = { DeliveryStreamName: 'phys', ...after };
        return { physicalId: 'phys', wasReplaced: false };
      }),
      hooks: {
        readUnsettled: async (...args: unknown[]) => {
          seen.push(args[6] as ReadonlyMap<string, ReadonlySet<string>> | undefined);
          return { ...live };
        },
      },
    };
  }
  const items = (m: ReadonlyMap<string, ReadonlySet<string>> | undefined) =>
    Object.fromEntries([...(m ?? [])].map(([k, v]) => [k, [...v]]));

  it('--revert-failed hands the items to the convergence read and keeps them while unproven', async () => {
    const f = aws({ Note: 'b' });
    const state = { S: recorded() };
    await replayFailedOperations(failedNote(res({ properties: { DeliveryStreamName: 'phys', Note: 'a' } })), state, 'stack', ctxWith(f.update, f.hooks));
    expect(f.update).toHaveBeenCalledOnce();
    expect(f.seen.length).toBeGreaterThan(0);
    for (const m of f.seen) expect(items(m)).toEqual({ Note: ['x'] });
    expect(state.S.unsettledProperties).toEqual(['Note']);
    expect(state.S.unsettledItems).toEqual({ Note: ['x'] });
  });

  it('--revert-failed drops the items once proven', async () => {
    const f = aws({ Note: 'a' });
    const state = { S: recorded() };
    await replayFailedOperations(failedNote(res({ properties: { DeliveryStreamName: 'phys', Note: 'a' } })), state, 'stack', ctxWith(f.update, f.hooks));
    expect(state.S).not.toHaveProperty('unsettledProperties');
    expect(state.S).not.toHaveProperty('unsettledItems');
  });

  it.each([
    ['kept while unproven', { Note: 'b' }, { Note: ['x'] }],
    ['dropped once proven', { Note: 'a' }, undefined],
  ])('revert of a completed UPDATE: the previous record\'s items are %s', async (_l, after, expected) => {
    const f = aws(after);
    const ops = [
      {
        logicalId: 'S',
        changeType: 'UPDATE',
        resourceType: TYPE,
        physicalId: 'phys',
        previousState: res({
          properties: { DeliveryStreamName: 'phys', Note: 'a' },
          unsettledProperties: ['Note'],
          unsettledItems: { Note: ['x'] },
        }),
      } as unknown as CompletedOperation,
    ];
    const state = { S: res({ properties: { DeliveryStreamName: 'phys', Note: 'b' } }) };
    await replayRollback(ops, state, 'stack', ctxWith(f.update, f.hooks));
    for (const m of f.seen) expect(items(m)).toEqual({ Note: ['x'] });
    expect(f.seen.length).toBeGreaterThan(0);
    expect(state.S.unsettledItems).toEqual(expected);
  });
});
