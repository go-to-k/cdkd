import { describe, it, expect, vi } from 'vite-plus/test';
import {
  classifyRollbackOp,
  classifyFailedOp,
  planRollback,
  planFailedOps,
  replayRollback,
  replayFailedOperations,
  sortRollbackCreates,
  isReplacementOp,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import type { ResourceState } from '../../../src/types/state.js';

// Single-attempt pass-through for withRetry so the reverse-replacement
// collision-retry tests do not sleep through the real 2-10s backoff schedule.
vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return {
    ...actual,
    withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
  };
});

function res(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys',
    resourceType: 'AWS::S3::Bucket',
    properties: {},
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

function makeCtx(provider: { delete?: unknown; update?: unknown; create?: unknown }): {
  ctx: RollbackExecutorContext;
  events: Array<{ eventType: string; logicalId?: string }>;
} {
  const events: Array<{ eventType: string; logicalId?: string }> = [];
  const ctx: RollbackExecutorContext = {
    region: 'us-east-1',
    logger: silentLogger,
    providerRegistry: {
      getProviderFor: () => ({ provider }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
    recordEvent: (e) => events.push({ eventType: e.eventType, logicalId: e.logicalId }),
  };
  return { ctx, events };
}

describe('classifyRollbackOp', () => {
  it('CREATE present with matching physicalId + default policy → delete', () => {
    const op: CompletedOperation = {
      logicalId: 'B',
      changeType: 'CREATE',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'phys-B',
    };
    const state = { B: res({ physicalId: 'phys-B' }) };
    expect(classifyRollbackOp(op, state, new Set())).toBe('delete');
  });

  it('CREATE with Retain / Snapshot policy → orphan-retain', () => {
    const op: CompletedOperation = {
      logicalId: 'B',
      changeType: 'CREATE',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'phys-B',
    };
    for (const policy of ['Retain', 'Snapshot'] as const) {
      const state = { B: res({ physicalId: 'phys-B', deletionPolicy: policy }) };
      expect(classifyRollbackOp(op, state, new Set())).toBe('orphan-retain');
    }
  });

  it('CREATE with RetainExceptOnCreate policy → delete (cleanup of failed create)', () => {
    const op: CompletedOperation = {
      logicalId: 'B',
      changeType: 'CREATE',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'phys-B',
    };
    const state = { B: res({ physicalId: 'phys-B', deletionPolicy: 'RetainExceptOnCreate' }) };
    expect(classifyRollbackOp(op, state, new Set())).toBe('delete');
  });

  it('CREATE absent from state → skip-already-done', () => {
    const op: CompletedOperation = {
      logicalId: 'B',
      changeType: 'CREATE',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'phys-B',
    };
    expect(classifyRollbackOp(op, {}, new Set())).toBe('skip-already-done');
  });

  it('CREATE with mismatched physicalId → skip-mismatch', () => {
    const op: CompletedOperation = {
      logicalId: 'B',
      changeType: 'CREATE',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'phys-old',
    };
    const state = { B: res({ physicalId: 'phys-new' }) };
    expect(classifyRollbackOp(op, state, new Set())).toBe('skip-mismatch');
  });

  it('UPDATE absent from state → skip-absent', () => {
    const op: CompletedOperation = {
      logicalId: 'B',
      changeType: 'UPDATE',
      resourceType: 'AWS::S3::Bucket',
      previousState: res({ properties: { a: 1 } }),
    };
    expect(classifyRollbackOp(op, {}, new Set())).toBe('skip-absent');
  });

  it('UPDATE already reverted (props deep-equal) → skip-already-done', () => {
    const op: CompletedOperation = {
      logicalId: 'B',
      changeType: 'UPDATE',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'phys-B',
      previousState: res({ physicalId: 'phys-B', properties: { a: 1 } }),
    };
    const state = { B: res({ physicalId: 'phys-B', properties: { a: 1 } }) };
    expect(classifyRollbackOp(op, state, new Set())).toBe('skip-already-done');
  });

  it('UPDATE with changed props → revert', () => {
    const op: CompletedOperation = {
      logicalId: 'B',
      changeType: 'UPDATE',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'phys-B',
      previousState: res({ physicalId: 'phys-B', properties: { a: 1 } }),
    };
    const state = { B: res({ physicalId: 'phys-B', properties: { a: 2 } }) };
    expect(classifyRollbackOp(op, state, new Set())).toBe('revert');
  });

  it('DELETE → unrecoverable-delete', () => {
    const op: CompletedOperation = {
      logicalId: 'B',
      changeType: 'DELETE',
      resourceType: 'AWS::S3::Bucket',
    };
    expect(classifyRollbackOp(op, {}, new Set())).toBe('unrecoverable-delete');
  });

  it('--orphan wins over delete/revert → orphan-flag', () => {
    const create: CompletedOperation = {
      logicalId: 'B',
      changeType: 'CREATE',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'phys-B',
    };
    const state = { B: res({ physicalId: 'phys-B' }) };
    expect(classifyRollbackOp(create, state, new Set(['B']))).toBe('orphan-flag');
  });

  it('replacement UPDATE → reverse-replacement (#1199), never deep-equal-skips', () => {
    const op: CompletedOperation = {
      logicalId: 'B',
      changeType: 'UPDATE',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'phys-new',
      previousState: res({ physicalId: 'phys-old', properties: { a: 1 } }),
    };
    // Even if current props match previous, a replacement still attempts.
    const state = { B: res({ physicalId: 'phys-new', properties: { a: 1 } }) };
    expect(isReplacementOp(op)).toBe(true);
    expect(classifyRollbackOp(op, state, new Set())).toBe('reverse-replacement');
  });

  it('replacement with UpdateReplacePolicy: Retain on previousState → readopt (#1199)', () => {
    const op: CompletedOperation = {
      logicalId: 'B',
      changeType: 'UPDATE',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'phys-new',
      previousState: res({
        physicalId: 'phys-old',
        properties: { a: 1 },
        updateReplacePolicy: 'Retain',
      }),
    };
    const state = { B: res({ physicalId: 'phys-new', properties: { a: 2 } }) };
    expect(classifyRollbackOp(op, state, new Set())).toBe('reverse-replacement-readopt');
  });

  it('replacement with Snapshot policy re-creates (NOT readopt — old was deleted)', () => {
    const op: CompletedOperation = {
      logicalId: 'B',
      changeType: 'UPDATE',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'phys-new',
      previousState: res({
        physicalId: 'phys-old',
        properties: { a: 1 },
        updateReplacePolicy: 'Snapshot',
      }),
    };
    const state = { B: res({ physicalId: 'phys-new' }) };
    expect(classifyRollbackOp(op, state, new Set())).toBe('reverse-replacement');
  });

  it('replacement already reverted (state points at old physical id) → skip-already-done', () => {
    const op: CompletedOperation = {
      logicalId: 'B',
      changeType: 'UPDATE',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'phys-new',
      previousState: res({ physicalId: 'phys-old', properties: { a: 1 } }),
    };
    const state = { B: res({ physicalId: 'phys-old', properties: { a: 1 } }) };
    expect(classifyRollbackOp(op, state, new Set())).toBe('skip-already-done');
  });

  it('replacement whose state id is neither old nor new → skip-mismatch', () => {
    const op: CompletedOperation = {
      logicalId: 'B',
      changeType: 'UPDATE',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'phys-new',
      previousState: res({ physicalId: 'phys-old', properties: { a: 1 } }),
    };
    const state = { B: res({ physicalId: 'phys-even-newer', properties: { a: 2 } }) };
    expect(classifyRollbackOp(op, state, new Set())).toBe('skip-mismatch');
  });

  it('replacement re-run after an AUTO-NAMED reverse-replacement (fresh id, prev props) → skip-already-done', () => {
    // A prior reverse-replacement re-created the old resource; auto-naming
    // gave it a FRESH physical id (neither old nor new), but its properties
    // are the previous state's — recognize as already reverted, not mismatch.
    const op: CompletedOperation = {
      logicalId: 'B',
      changeType: 'UPDATE',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'phys-new',
      previousState: res({ physicalId: 'phys-old', properties: { a: 1 } }),
    };
    const state = { B: res({ physicalId: 'phys-old-recreated', properties: { a: 1 } }) };
    expect(classifyRollbackOp(op, state, new Set())).toBe('skip-already-done');
  });
});

describe('classifyFailedOp (#1198)', () => {
  it('failed DELETE → skip-failed-noop (resource still in place)', () => {
    const op: FailedOperation = {
      logicalId: 'B',
      changeType: 'DELETE',
      resourceType: 'AWS::S3::Bucket',
      previousState: res(),
      physicalId: 'phys',
    };
    expect(classifyFailedOp(op, { B: res() })).toBe('skip-failed-noop');
  });

  it('failed CREATE with no physical id → skip-failed-unknown', () => {
    const op: FailedOperation = {
      logicalId: 'B',
      changeType: 'CREATE',
      resourceType: 'AWS::S3::Bucket',
    };
    expect(classifyFailedOp(op, {})).toBe('skip-failed-unknown');
  });

  it('failed CREATE with matching state record → delete-failed-create', () => {
    const op: FailedOperation = {
      logicalId: 'B',
      changeType: 'CREATE',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'phys-B',
    };
    expect(classifyFailedOp(op, { B: res({ physicalId: 'phys-B' }) })).toBe('delete-failed-create');
  });

  it('failed CREATE with recorded id already gone from state → skip-failed-noop', () => {
    const op: FailedOperation = {
      logicalId: 'B',
      changeType: 'CREATE',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'phys-B',
    };
    expect(classifyFailedOp(op, {})).toBe('skip-failed-noop');
  });

  it('failed CREATE whose state record has a DIFFERENT physical id → skip-failed-noop', () => {
    const op: FailedOperation = {
      logicalId: 'B',
      changeType: 'CREATE',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'phys-B',
    };
    expect(classifyFailedOp(op, { B: res({ physicalId: 'phys-other' }) })).toBe(
      'skip-failed-noop'
    );
  });

  it('failed UPDATE with previousState → revert-failed-update', () => {
    const op: FailedOperation = {
      logicalId: 'B',
      changeType: 'UPDATE',
      resourceType: 'AWS::S3::Bucket',
      previousState: res({ properties: { a: 1 } }),
      physicalId: 'phys-B',
      attemptedProperties: { a: 2 },
    };
    expect(classifyFailedOp(op, { B: res({ physicalId: 'phys-B' }) })).toBe('revert-failed-update');
  });

  it('failed UPDATE without previousState / state entry → skip-failed-absent', () => {
    const op: FailedOperation = {
      logicalId: 'B',
      changeType: 'UPDATE',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'phys-B',
    };
    expect(classifyFailedOp(op, { B: res() })).toBe('skip-failed-absent');
    expect(
      classifyFailedOp({ ...op, previousState: res({ properties: { a: 1 } }) }, {})
    ).toBe('skip-failed-absent');
  });

  it('planFailedOps maps each failed op to its action', () => {
    const ops: FailedOperation[] = [
      { logicalId: 'U', changeType: 'UPDATE', resourceType: 'T', previousState: res(), physicalId: 'p' },
      { logicalId: 'C', changeType: 'CREATE', resourceType: 'T' },
    ];
    const plan = planFailedOps(ops, { U: res({ physicalId: 'p' }) });
    expect(plan.map((i) => i.action)).toEqual(['revert-failed-update', 'skip-failed-unknown']);
  });
});

describe('sortRollbackCreates', () => {
  it('deletes dependents before dependencies', () => {
    const ops: CompletedOperation[] = [
      { logicalId: 'Role', changeType: 'CREATE', resourceType: 'AWS::IAM::Role' },
      { logicalId: 'Policy', changeType: 'CREATE', resourceType: 'AWS::IAM::Policy' },
    ];
    const state = {
      Role: res({ dependencies: [] }),
      Policy: res({ dependencies: ['Role'] }),
    };
    const sorted = sortRollbackCreates(ops, state).map((o) => o.logicalId);
    expect(sorted.indexOf('Policy')).toBeLessThan(sorted.indexOf('Role'));
  });
});

describe('planRollback ordering', () => {
  it('UPDATE/DELETE (reverse completion order) precede CREATE deletions', () => {
    const ops: CompletedOperation[] = [
      { logicalId: 'U1', changeType: 'UPDATE', resourceType: 'T', previousState: res() },
      { logicalId: 'C1', changeType: 'CREATE', resourceType: 'T', physicalId: 'p' },
      { logicalId: 'U2', changeType: 'UPDATE', resourceType: 'T', previousState: res() },
    ];
    const state = { U1: res(), U2: res(), C1: res({ physicalId: 'p' }) };
    const order = planRollback(ops, state).map((i) => i.op.logicalId);
    // reverse completion → U2 before U1, then creates last
    expect(order).toEqual(['U2', 'U1', 'C1']);
  });
});

describe('replayRollback', () => {
  it('deletes a CREATE and removes it from state, emits SUCCEEDED', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx, events } = makeCtx({ delete: del });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'CREATE', resourceType: 'AWS::S3::Bucket', physicalId: 'phys-B' },
    ];
    const state = { B: res({ physicalId: 'phys-B' }) };
    const result = await replayRollback(ops, state, 'S', ctx);
    expect(del).toHaveBeenCalledOnce();
    expect(state.B).toBeUndefined();
    expect(result.failures).toBe(0);
    expect(events.map((e) => e.eventType)).toContain('ROLLBACK_RESOURCE_SUCCEEDED');
  });

  it('reverts an UPDATE by calling provider.update with previous props', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    const { ctx } = makeCtx({ update });
    const prev = res({ physicalId: 'phys-B', properties: { a: 1 } });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'AWS::S3::Bucket', physicalId: 'phys-B', previousState: prev },
    ];
    const state: Record<string, ResourceState> = { B: res({ physicalId: 'phys-B', properties: { a: 2 } }) };
    await replayRollback(ops, state, 'S', ctx);
    expect(update).toHaveBeenCalledWith('B', 'phys-B', 'AWS::S3::Bucket', { a: 1 }, { a: 2 });
    expect(state.B).toBe(prev);
  });

  it('orphans a Retain CREATE without calling delete', async () => {
    const del = vi.fn();
    const { ctx } = makeCtx({ delete: del });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'CREATE', resourceType: 'AWS::S3::Bucket', physicalId: 'phys-B' },
    ];
    const state = { B: res({ physicalId: 'phys-B', deletionPolicy: 'Retain' as const }) };
    await replayRollback(ops, state, 'S', ctx);
    expect(del).not.toHaveBeenCalled();
    expect(state.B).toBeUndefined();
  });

  it('--orphan on a CREATE leaves the resource, drops it from state', async () => {
    const del = vi.fn();
    const { ctx, events } = makeCtx({ delete: del });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'CREATE', resourceType: 'AWS::S3::Bucket', physicalId: 'phys-B' },
    ];
    const state = { B: res({ physicalId: 'phys-B' }) };
    await replayRollback(ops, state, 'S', ctx, { orphanLogicalIds: new Set(['B']) });
    expect(del).not.toHaveBeenCalled();
    expect(state.B).toBeUndefined();
    // Parity with orphan-retain: the orphaned CREATE surfaces in events.
    expect(events.map((e) => e.eventType)).toContain('ROLLBACK_RESOURCE_SUCCEEDED');
  });

  it('--orphan on an UPDATE leaves state as-is (no provider.update, no event)', async () => {
    const update = vi.fn();
    const { ctx, events } = makeCtx({ update });
    const cur = res({ physicalId: 'phys-B', properties: { a: 2 } });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'AWS::S3::Bucket', physicalId: 'phys-B', previousState: res({ properties: { a: 1 } }) },
    ];
    const state = { B: cur };
    await replayRollback(ops, state, 'S', ctx, { orphanLogicalIds: new Set(['B']) });
    expect(update).not.toHaveBeenCalled();
    expect(state.B).toBe(cur);
    // An orphaned UPDATE changes nothing in state/AWS → no event.
    expect(events.map((e) => e.eventType)).not.toContain('ROLLBACK_RESOURCE_SUCCEEDED');
  });

  it('per-op failure is caught, counted, and does not abort remaining ops', async () => {
    const del = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const { ctx, events } = makeCtx({ delete: del });
    const ops: CompletedOperation[] = [
      { logicalId: 'A', changeType: 'CREATE', resourceType: 'T', physicalId: 'pA' },
      { logicalId: 'B', changeType: 'CREATE', resourceType: 'T', physicalId: 'pB' },
    ];
    const state = { A: res({ physicalId: 'pA' }), B: res({ physicalId: 'pB' }) };
    const result = await replayRollback(ops, state, 'S', ctx);
    expect(del).toHaveBeenCalledTimes(2);
    expect(result.failures).toBe(1);
    expect(events.map((e) => e.eventType)).toContain('ROLLBACK_RESOURCE_FAILED');
  });

  it('DELETE op counts as a warning (unrecoverable), no provider call', async () => {
    const del = vi.fn();
    const { ctx } = makeCtx({ delete: del });
    const ops: CompletedOperation[] = [
      { logicalId: 'D', changeType: 'DELETE', resourceType: 'T' },
    ];
    const result = await replayRollback(ops, {}, 'S', ctx);
    expect(del).not.toHaveBeenCalled();
    expect(result.warnings).toBe(1);
  });

  it('invokes afterOp after each mutating op', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ delete: del });
    const afterOp = vi.fn().mockResolvedValue(undefined);
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'CREATE', resourceType: 'T', physicalId: 'pB' },
    ];
    const state = { B: res({ physicalId: 'pB' }) };
    await replayRollback(ops, state, 'S', ctx, { afterOp });
    expect(afterOp).toHaveBeenCalledWith('B');
  });

  it('a CREATE with no physicalId is a warning, not a provider call', async () => {
    const del = vi.fn();
    const { ctx } = makeCtx({ delete: del });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'CREATE', resourceType: 'T' }, // no physicalId
    ];
    const state = { B: res({ physicalId: 'phys-B' }) };
    const result = await replayRollback(ops, state, 'S', ctx);
    expect(del).not.toHaveBeenCalled();
    expect(result.warnings).toBe(1);
    expect(result.failures).toBe(0);
  });

  it('deletes dependent CREATEs before their dependencies (reverse dep order)', async () => {
    const order: string[] = [];
    const del = vi.fn().mockImplementation((logicalId: string) => {
      order.push(logicalId);
      return Promise.resolve(undefined);
    });
    const { ctx } = makeCtx({ delete: del });
    const ops: CompletedOperation[] = [
      { logicalId: 'Role', changeType: 'CREATE', resourceType: 'AWS::IAM::Role', physicalId: 'r' },
      { logicalId: 'Policy', changeType: 'CREATE', resourceType: 'AWS::IAM::Policy', physicalId: 'p' },
    ];
    const state = {
      Role: res({ physicalId: 'r', dependencies: [] }),
      Policy: res({ physicalId: 'p', dependencies: ['Role'] }),
    };
    await replayRollback(ops, state, 'S', ctx);
    expect(order.indexOf('Policy')).toBeLessThan(order.indexOf('Role'));
  });

  it('reverse-replacement: re-creates the old resource, deletes the new (#1199)', async () => {
    const create = vi.fn().mockResolvedValue({ physicalId: 'phys-old-2', attributes: { Arn: 'arn:old' } });
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx, events } = makeCtx({ create, delete: del });
    const prev = res({ physicalId: 'phys-old', properties: { a: 1 } });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'AWS::SQS::Queue', physicalId: 'phys-new', previousState: prev },
    ];
    const state: Record<string, ResourceState> = {
      B: res({ physicalId: 'phys-new', properties: { a: 2 } }),
    };
    const afterOp = vi.fn();
    const result = await replayRollback(ops, state, 'S', ctx, { afterOp });
    expect(create).toHaveBeenCalledWith('B', 'AWS::SQS::Queue', { a: 1 });
    expect(del).toHaveBeenCalledWith('B', 'phys-new', 'AWS::SQS::Queue', { a: 2 }, { expectedRegion: 'us-east-1' });
    expect(state.B).toMatchObject({ physicalId: 'phys-old-2', properties: { a: 1 }, attributes: { Arn: 'arn:old' } });
    expect(result.failures).toBe(0);
    expect(afterOp).toHaveBeenCalledWith('B');
    expect(events.map((e) => e.eventType)).toContain('ROLLBACK_RESOURCE_SUCCEEDED');
  });

  it('reverse-replacement warns on a stateful type but does NOT count a warning (exit stays 0)', async () => {
    const create = vi.fn().mockResolvedValue({ physicalId: 'tbl-old-2' });
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ create, delete: del });
    const prev = res({
      physicalId: 'tbl-old',
      resourceType: 'AWS::DynamoDB::Table',
      properties: { a: 1 },
    });
    const ops: CompletedOperation[] = [
      { logicalId: 'T', changeType: 'UPDATE', resourceType: 'AWS::DynamoDB::Table', physicalId: 'tbl-new', previousState: prev },
    ];
    const state = { T: res({ physicalId: 'tbl-new', resourceType: 'AWS::DynamoDB::Table' }) };
    const result = await replayRollback(ops, state, 'S', ctx);
    // Advisory data-loss warn is logged loudly but the op succeeded — no
    // warning count (warnings map to exit code 2).
    expect(silentLogger.warn).toHaveBeenCalledWith(expect.stringContaining('stateful type'));
    expect(result.warnings).toBe(0);
    expect(result.failures).toBe(0);
    expect(create).toHaveBeenCalled();
  });

  it('reverse-replacement name collision: deletes new first, persists the gap, retries create', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('Queue already exists'))
      .mockResolvedValue({ physicalId: 'phys-old' });
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ create, delete: del });
    const afterOp = vi.fn();
    const prev = res({ physicalId: 'phys-old', properties: { a: 1 } });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'AWS::SQS::Queue', physicalId: 'phys-new', previousState: prev },
    ];
    const state: Record<string, ResourceState> = {
      B: res({ physicalId: 'phys-new', properties: { a: 2 } }),
    };
    const result = await replayRollback(ops, state, 'S', ctx, { afterOp });
    expect(create).toHaveBeenCalledTimes(2);
    // The new resource is deleted exactly once (before the create retry).
    expect(del).toHaveBeenCalledTimes(1);
    expect(state.B!.physicalId).toBe('phys-old');
    expect(result.failures).toBe(0);
    // Load-bearing re-run safety: the resource-absent intermediate state is
    // persisted after deleting the new resource, then again after re-create.
    expect(afterOp).toHaveBeenCalledTimes(2);
    expect(afterOp).toHaveBeenNthCalledWith(1, 'B');
    expect(afterOp).toHaveBeenNthCalledWith(2, 'B');
  });

  it('reverse-replacement collision-retry exhaustion: resource absent, actionable failure', async () => {
    // The delete-new-first fallback already deleted the new resource; the
    // re-create keeps colliding (withRetry is a single-attempt pass-through
    // in this file) — worst case: resource gone from AWS AND state.
    const create = vi.fn().mockRejectedValue(new Error('Queue already exists'));
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ create, delete: del });
    const prev = res({ physicalId: 'phys-old', properties: { a: 1 } });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'AWS::SQS::Queue', physicalId: 'phys-new', previousState: prev },
    ];
    const state: Record<string, ResourceState> = {
      B: res({ physicalId: 'phys-new', properties: { a: 2 } }),
    };
    const result = await replayRollback(ops, state, 'S', ctx);
    expect(result.failures).toBe(1);
    expect(state.B).toBeUndefined(); // truthfully absent
    // The user's only guidance for this worst case:
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("fix forward with 'cdkd deploy'")
    );
  });

  it('reverse-replacement non-collision create failure leaves the new resource untouched', async () => {
    const create = vi.fn().mockRejectedValue(new Error('AccessDenied'));
    const del = vi.fn();
    const { ctx } = makeCtx({ create, delete: del });
    const prev = res({ physicalId: 'phys-old', properties: { a: 1 } });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'AWS::SQS::Queue', physicalId: 'phys-new', previousState: prev },
    ];
    const cur = res({ physicalId: 'phys-new', properties: { a: 2 } });
    const state: Record<string, ResourceState> = { B: cur };
    const result = await replayRollback(ops, state, 'S', ctx);
    expect(del).not.toHaveBeenCalled();
    expect(state.B).toBe(cur); // state untouched — new resource still live
    expect(result.failures).toBe(1);
  });

  it('reverse-replacement drops stale attributes/observedProperties from the re-created record', async () => {
    const create = vi.fn().mockResolvedValue({ physicalId: 'phys-old-2' }); // no attributes
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ create, delete: del });
    const prev = res({
      physicalId: 'phys-old',
      properties: { a: 1 },
      attributes: { Arn: 'arn:stale-old' },
      observedProperties: { a: 1 },
    });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'AWS::SQS::Queue', physicalId: 'phys-new', previousState: prev },
    ];
    const state: Record<string, ResourceState> = {
      B: res({ physicalId: 'phys-new', properties: { a: 2 } }),
    };
    await replayRollback(ops, state, 'S', ctx);
    // Old resource's cached ARN etc. must NOT survive onto the fresh record.
    expect(state.B!.attributes).toEqual({});
    expect(state.B!.observedProperties).toBeUndefined();
    expect(state.B!.physicalId).toBe('phys-old-2');
  });

  it('reverse-replacement-readopt: deletes new, restores state to the retained old', async () => {
    const create = vi.fn();
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx, events } = makeCtx({ create, delete: del });
    const prev = res({
      physicalId: 'phys-old',
      properties: { a: 1 },
      updateReplacePolicy: 'Retain' as const,
    });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'AWS::S3::Bucket', physicalId: 'phys-new', previousState: prev },
    ];
    const state: Record<string, ResourceState> = {
      B: res({ physicalId: 'phys-new', properties: { a: 2 } }),
    };
    const result = await replayRollback(ops, state, 'S', ctx);
    expect(create).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith('B', 'phys-new', 'AWS::S3::Bucket', { a: 2 }, { expectedRegion: 'us-east-1' });
    expect(state.B).toBe(prev);
    expect(result.failures).toBe(0);
    expect(events.map((e) => e.eventType)).toContain('ROLLBACK_RESOURCE_SUCCEEDED');
  });

  it('reverse-replacement: delete-new failure after re-create is a warning, old is restored', async () => {
    const create = vi.fn().mockResolvedValue({ physicalId: 'phys-old-2' });
    const del = vi.fn().mockRejectedValue(new Error('delete boom'));
    const { ctx } = makeCtx({ create, delete: del });
    const prev = res({ physicalId: 'phys-old', properties: { a: 1 } });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'AWS::SQS::Queue', physicalId: 'phys-new', previousState: prev },
    ];
    const state: Record<string, ResourceState> = {
      B: res({ physicalId: 'phys-new', properties: { a: 2 } }),
    };
    const result = await replayRollback(ops, state, 'S', ctx);
    expect(state.B!.physicalId).toBe('phys-old-2');
    expect(result.failures).toBe(0);
    expect(result.warnings).toBeGreaterThan(0);
  });

  it('stops early when isInterrupted flips true', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ delete: del });
    const ops: CompletedOperation[] = [
      { logicalId: 'A', changeType: 'UPDATE', resourceType: 'T', previousState: res(), physicalId: 'pA' },
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'T', previousState: res(), physicalId: 'pB' },
    ];
    const state = { A: res({ physicalId: 'pA', properties: { x: 1 } }), B: res({ physicalId: 'pB', properties: { x: 1 } }) };
    const result = await replayRollback(ops, state, 'S', ctx, { isInterrupted: () => true });
    expect(result.interrupted).toBe(true);
  });
});

describe('replayFailedOperations (#1198)', () => {
  it('force-reverts a failed UPDATE with previous-vs-attempted diff sides', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    const { ctx, events } = makeCtx({ update });
    const prev = res({ physicalId: 'phys-B', properties: { a: 1 } });
    const failedOps: FailedOperation[] = [
      {
        logicalId: 'B',
        changeType: 'UPDATE',
        resourceType: 'AWS::S3::Bucket',
        physicalId: 'phys-B',
        previousState: prev,
        attemptedProperties: { a: 2 },
      },
    ];
    // A failed UPDATE leaves state at the pre-op values (props equal prev) —
    // the revert must STILL run (remote state unknown), unlike the completed
    // path's deep-equal skip.
    const state: Record<string, ResourceState> = {
      B: res({ physicalId: 'phys-B', properties: { a: 1 } }),
    };
    const afterOp = vi.fn();
    const result = await replayFailedOperations(failedOps, state, 'S', ctx, { afterOp });
    // Diff sides: desired = previous props, previous = ATTEMPTED props, so a
    // patch-based provider generates ops undoing the half-applied update.
    expect(update).toHaveBeenCalledWith('B', 'phys-B', 'AWS::S3::Bucket', { a: 1 }, { a: 2 });
    expect(state.B).toBe(prev);
    expect(result.failures).toBe(0);
    expect(afterOp).toHaveBeenCalledWith('B');
    expect(events.map((e) => e.eventType)).toContain('ROLLBACK_RESOURCE_SUCCEEDED');
  });

  it('falls back to current props as the previous side when attemptedProperties absent', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    const { ctx } = makeCtx({ update });
    const prev = res({ physicalId: 'phys-B', properties: { a: 1 } });
    const failedOps: FailedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'T', physicalId: 'phys-B', previousState: prev },
    ];
    const state = { B: res({ physicalId: 'phys-B', properties: { a: 1 } }) };
    await replayFailedOperations(failedOps, state, 'S', ctx);
    expect(update).toHaveBeenCalledWith('B', 'phys-B', 'T', { a: 1 }, { a: 1 });
  });

  it('deletes a partially-recorded failed CREATE and drops it from state', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ delete: del });
    const failedOps: FailedOperation[] = [
      { logicalId: 'C', changeType: 'CREATE', resourceType: 'T', physicalId: 'pC' },
    ];
    const state: Record<string, ResourceState> = { C: res({ physicalId: 'pC' }) };
    const result = await replayFailedOperations(failedOps, state, 'S', ctx);
    expect(del).toHaveBeenCalledWith('C', 'pC', 'T', undefined, { expectedRegion: 'us-east-1' });
    expect(state.C).toBeUndefined();
    expect(result.failures).toBe(0);
  });

  it('failed CREATE with nothing recorded warns; failed DELETE is a silent noop', async () => {
    const { ctx } = makeCtx({});
    const failedOps: FailedOperation[] = [
      { logicalId: 'C', changeType: 'CREATE', resourceType: 'T' },
      { logicalId: 'D', changeType: 'DELETE', resourceType: 'T', previousState: res(), physicalId: 'pD' },
    ];
    const result = await replayFailedOperations(failedOps, { D: res({ physicalId: 'pD' }) }, 'S', ctx);
    expect(result.warnings).toBe(1); // only the CREATE-unknown warns
    expect(result.failures).toBe(0);
  });

  it('a revert failure is caught, counted, and emits ROLLBACK_RESOURCE_FAILED', async () => {
    const update = vi.fn().mockRejectedValue(new Error('boom'));
    const { ctx, events } = makeCtx({ update });
    const failedOps: FailedOperation[] = [
      {
        logicalId: 'B',
        changeType: 'UPDATE',
        resourceType: 'T',
        physicalId: 'phys-B',
        previousState: res({ physicalId: 'phys-B', properties: { a: 1 } }),
        attemptedProperties: { a: 2 },
      },
    ];
    const state = { B: res({ physicalId: 'phys-B', properties: { a: 1 } }) };
    const result = await replayFailedOperations(failedOps, state, 'S', ctx);
    expect(result.failures).toBe(1);
    expect(events.map((e) => e.eventType)).toContain('ROLLBACK_RESOURCE_FAILED');
  });

  it('stops early when isInterrupted flips true', async () => {
    const update = vi.fn().mockResolvedValue({});
    const { ctx } = makeCtx({ update });
    const failedOps: FailedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'T', physicalId: 'p', previousState: res() },
    ];
    const result = await replayFailedOperations(failedOps, { B: res() }, 'S', ctx, {
      isInterrupted: () => true,
    });
    expect(update).not.toHaveBeenCalled();
    expect(result.interrupted).toBe(true);
  });

  it('emitEnvelope wraps a failed-only replay in ROLLBACK_STARTED/FINISHED', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'p' });
    const { ctx, events } = makeCtx({ update });
    const failedOps: FailedOperation[] = [
      {
        logicalId: 'B',
        changeType: 'UPDATE',
        resourceType: 'T',
        physicalId: 'p',
        previousState: res({ physicalId: 'p', properties: { a: 1 } }),
        attemptedProperties: { a: 2 },
      },
    ];
    await replayFailedOperations(failedOps, { B: res({ physicalId: 'p' }) }, 'S', ctx, {
      emitEnvelope: true,
    });
    const types = events.map((e) => e.eventType);
    expect(types[0]).toBe('ROLLBACK_STARTED');
    expect(types[types.length - 1]).toBe('ROLLBACK_FINISHED');
    // Default (no emitEnvelope): no envelope events.
    const { ctx: ctx2, events: events2 } = makeCtx({ update });
    await replayFailedOperations(failedOps, { B: res({ physicalId: 'p' }) }, 'S', ctx2);
    expect(events2.map((e) => e.eventType)).not.toContain('ROLLBACK_STARTED');
  });
});
