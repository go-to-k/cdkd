import { describe, it, expect, vi } from 'vite-plus/test';
import {
  classifyRollbackOp,
  planRollback,
  replayRollback,
  sortRollbackCreates,
  isReplacementOp,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import type { ResourceState } from '../../../src/types/state.js';

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

function makeCtx(provider: { delete?: unknown; update?: unknown }): {
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

  it('replacement UPDATE never deep-equal-skips (physicalId differs)', () => {
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
    expect(classifyRollbackOp(op, state, new Set())).toBe('revert');
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
    const { ctx } = makeCtx({ delete: del });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'CREATE', resourceType: 'AWS::S3::Bucket', physicalId: 'phys-B' },
    ];
    const state = { B: res({ physicalId: 'phys-B' }) };
    await replayRollback(ops, state, 'S', ctx, { orphanLogicalIds: new Set(['B']) });
    expect(del).not.toHaveBeenCalled();
    expect(state.B).toBeUndefined();
  });

  it('--orphan on an UPDATE leaves state as-is (no provider.update)', async () => {
    const update = vi.fn();
    const { ctx } = makeCtx({ update });
    const cur = res({ physicalId: 'phys-B', properties: { a: 2 } });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'AWS::S3::Bucket', physicalId: 'phys-B', previousState: res({ properties: { a: 1 } }) },
    ];
    const state = { B: cur };
    await replayRollback(ops, state, 'S', ctx, { orphanLogicalIds: new Set(['B']) });
    expect(update).not.toHaveBeenCalled();
    expect(state.B).toBe(cur);
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
