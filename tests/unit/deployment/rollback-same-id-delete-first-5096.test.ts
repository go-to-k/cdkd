/**
 * go-to-k/cdkd#5096: a replacement that deleted the old resource first and
 * re-created it under the SAME physical id (`--replace` delete-first, a
 * fixed-name `--recreate-via-*`, the update-not-supported fallback) was
 * reverted IN PLACE: the provider's `update()` cannot change a create-only
 * property, so the live resource kept the new value while the rollback wrote
 * the old record over it and reported success. It is now reversed like any
 * delete-first replacement: delete the re-created resource, re-create the old.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import {
  classifyRollbackOp,
  isReplacementOp,
} from '../../../src/deployment/rollback-executor/plan.js';
import type { ResourceState } from '../../../src/types/state.js';

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ tag: 'process-global' }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const TYPE = 'AWS::DynamoDB::Table';
const NAME = 'X-tbl';
const keyed = (key: string) => ({
  TableName: NAME,
  KeySchema: [{ AttributeName: key, KeyType: 'HASH' }],
  AttributeDefinitions: [{ AttributeName: key, AttributeType: 'S' }],
  BillingMode: 'PAY_PER_REQUEST',
});
const rec = (key: string): ResourceState => ({
  physicalId: NAME,
  resourceType: TYPE,
  properties: keyed(key),
  attributes: {},
  dependencies: [],
  provisionedBy: 'sdk',
});

/** `X-tbl` (key pk) deleted first and re-created as `X-tbl` (key id). */
function op(extra: Partial<CompletedOperation> = {}): CompletedOperation {
  return {
    logicalId: 'Table',
    changeType: 'UPDATE',
    resourceType: TYPE,
    provisionedBy: 'sdk',
    physicalId: NAME,
    properties: keyed('id'),
    previousState: rec('pk'),
    oldResourceRetained: false,
    oldDeletedBeforeCreate: true,
    ...extra,
  };
}

/** The one live table and its key; every call in order. */
function tableModel() {
  let liveKey: string | undefined = 'id';
  const calls: string[] = [];
  const provider = {
    create: vi.fn(async (_l: string, _t: string, props: Record<string, unknown>) => {
      const key = (props['KeySchema'] as Array<{ AttributeName: string }>)[0]!.AttributeName;
      calls.push(`create ${key}`);
      if (liveKey !== undefined) throw new Error(`Table already exists: ${NAME}`);
      liveKey = key;
      return { physicalId: NAME, attributes: {} };
    }),
    delete: vi.fn(async (_l: string, physicalId: string) => {
      calls.push(`delete ${physicalId}`);
      liveKey = undefined;
    }),
    // What the DynamoDB provider does with a KeySchema change: nothing.
    update: vi.fn(async (_l: string, physicalId: string) => {
      calls.push('update');
      return { physicalId, wasReplaced: false };
    }),
  };
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => logger,
  } as unknown as RollbackExecutorContext['logger'];
  const ctx: RollbackExecutorContext = {
    region: 'us-east-1',
    logger,
    providerRegistry: {
      getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
  };
  return { ctx, provider, calls, liveKey: () => liveKey };
}

describe('reversing a same-id delete-first replacement (go-to-k/cdkd#5096)', () => {
  it('is a replacement, not an in-place revert', () => {
    expect(isReplacementOp(op())).toBe(true);
    expect(classifyRollbackOp(op(), { Table: rec('id') }, new Set())).toBe('reverse-replacement');
  });

  it('deletes the re-created resource, re-creates the old one, and records what AWS holds', async () => {
    const m = tableModel();
    const state: Record<string, ResourceState> = { Table: rec('id') };
    const result = await replayRollback([op()], state, 'X', m.ctx);
    expect(result.failures).toBe(0);
    expect(m.calls).toEqual([`delete ${NAME}`, 'create pk']);
    expect(m.provider.update).not.toHaveBeenCalled();
    expect(m.liveKey()).toBe('pk');
    expect(state['Table']!.physicalId).toBe(NAME);
    expect(
      (state['Table']!.properties['KeySchema'] as Array<{ AttributeName: string }>)[0]!.AttributeName
    ).toBe('pk');
  });

  it('a re-run after the reversal is a no-op: the record already says the old one', async () => {
    const m = tableModel();
    const state: Record<string, ResourceState> = { Table: rec('id') };
    await replayRollback([op()], state, 'X', m.ctx);
    // The record the replay itself wrote, not a synthetic one.
    expect(classifyRollbackOp(op(), state, new Set())).toBe('skip-already-done');
    const again = await replayRollback([op()], state, 'X', m.ctx);
    expect(again.failures).toBe(0);
    expect(m.calls).toEqual([`delete ${NAME}`, 'create pk']);
  });

  it('a re-run is a no-op too when the replayed create returned its own bag', async () => {
    const m = tableModel();
    const effective = { ...keyed('pk'), StreamSpecification: { StreamEnabled: false } };
    m.provider.create.mockImplementationOnce(async () => {
      m.calls.push('create pk');
      return { physicalId: NAME, attributes: {}, effectiveProperties: effective };
    });
    const state: Record<string, ResourceState> = { Table: rec('id') };
    // The model's table is deleted first, so the create above meets no holder.
    await replayRollback([op()], state, 'X', m.ctx);
    expect(state['Table']!.properties).toEqual(effective);
    expect(classifyRollbackOp(op(), state, new Set())).toBe('skip-already-done');
    await replayRollback([op()], state, 'X', m.ctx);
    expect(m.calls).toEqual([`delete ${NAME}`, 'create pk']);
  });

  it('refuses to reverse a parent whose re-create would take a recorded child with it', async () => {
    const m = tableModel();
    const fn = (extra: Partial<CompletedOperation> = {}): CompletedOperation =>
      op({ logicalId: 'Fn', resourceType: 'AWS::Lambda::Function', ...extra });
    const child = (dependencies: string[]): ResourceState => ({
      physicalId: 'perm-1',
      resourceType: 'AWS::Lambda::Permission',
      properties: { FunctionName: NAME, Action: 'lambda:InvokeFunction' },
      attributes: {},
      dependencies,
      provisionedBy: 'sdk',
    });
    const fnRecord = { ...rec('id'), resourceType: 'AWS::Lambda::Function' };
    const state: Record<string, ResourceState> = { Fn: fnRecord, Perm: child(['Fn']) };
    const result = await replayRollback([fn()], state, 'X', m.ctx);
    expect(result.failures).toBe(1);
    expect(m.calls).toEqual([]);
    expect(state['Fn']).toEqual(fnRecord);
    const error = vi.mocked(m.ctx.logger.warn).mock.calls.flat().join('\n');
    expect(error).toMatch(/Cannot reverse the replacement of .*Fn/);
    expect(error).toContain('Perm');
    expect(error).toContain('cdkd deploy --replace');
    // A child naming ANOTHER resource does not block it.
    const free = tableModel();
    const freeState: Record<string, ResourceState> = {
      Fn: { ...fnRecord },
      Perm: child(['Other']),
    };
    expect((await replayRollback([fn()], freeState, 'X', free.ctx)).failures).toBe(0);
    expect(free.calls).toEqual([`delete ${NAME}`, 'create pk']);
  });

  it('a same-id op the engine did not stamp delete-first keeps the in-place revert', () => {
    const inPlace = op({ oldDeletedBeforeCreate: false });
    expect(isReplacementOp(inPlace)).toBe(false);
    expect(classifyRollbackOp(inPlace, { Table: rec('id') }, new Set())).toBe('revert');
    // The provider's own word that it updated in place wins too.
    const reported = op({ wasReplaced: false });
    expect(isReplacementOp(reported)).toBe(false);
  });
});
