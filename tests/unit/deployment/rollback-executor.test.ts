import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
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
import { withRetry } from '../../../src/deployment/retry.js';
import { createPreDeleteFinalSnapshot } from '../../../src/provisioning/final-snapshot.js';

// Single-attempt pass-through for withRetry so the reverse-replacement
// collision-retry tests do not sleep through the real 2-10s backoff schedule.
vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return {
    ...actual,
    withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
  };
});

// Only the AWS-touching pre-delete snapshot dispatcher is stubbed; the type
// sets / identifier builder / refusal factories stay REAL so the tests pin
// the actual routing matrix (issue #1358).
vi.mock('../../../src/provisioning/final-snapshot.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/provisioning/final-snapshot.js')>();
  return {
    ...actual,
    createPreDeleteFinalSnapshot: vi.fn(async () => 'snap-1'),
  };
});

// The process-global the executor falls back to when the context pins no
// clients (`ctx.finalSnapshotClients ?? getAwsClients()`). Distinct object
// identity so the fallback and the pinned-clients cases cannot be confused
// for one another (issue #1363).
const processGlobalClients = { tag: 'process-global' };
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => processGlobalClients,
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

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

  it('CREATE with Retain policy → orphan-retain', () => {
    const op: CompletedOperation = {
      logicalId: 'B',
      changeType: 'CREATE',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'phys-B',
    };
    const state = { B: res({ physicalId: 'phys-B', deletionPolicy: 'Retain' as const }) };
    expect(classifyRollbackOp(op, state, new Set())).toBe('orphan-retain');
  });

  it('CREATE with Snapshot policy → delete-with-final-snapshot (#1358, NOT orphan)', () => {
    const op: CompletedOperation = {
      logicalId: 'Db',
      changeType: 'CREATE',
      resourceType: 'AWS::RDS::DBInstance',
      physicalId: 'phys-db',
    };
    const state = {
      Db: res({
        physicalId: 'phys-db',
        resourceType: 'AWS::RDS::DBInstance',
        deletionPolicy: 'Snapshot' as const,
      }),
    };
    expect(classifyRollbackOp(op, state, new Set())).toBe('delete-with-final-snapshot');
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

  it('reverse-replacement delete-new threads a final snapshot id under UpdateReplacePolicy: Snapshot (#1354)', async () => {
    // Pins the CALL SITE, not just the pure helper: deleting the
    // `rollbackFinalSnapshotId(...)` argument here must fail this test.
    const del = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn().mockResolvedValue({ physicalId: 'old-db', attributes: {} });
    const { ctx } = makeCtx({ delete: del, create });
    const prev = res({
      physicalId: 'old-db',
      resourceType: 'AWS::RDS::DBInstance',
      properties: { a: 1 },
    });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Db',
        changeType: 'UPDATE',
        resourceType: 'AWS::RDS::DBInstance',
        physicalId: 'new-db',
        previousState: prev,
      },
    ];
    const state: Record<string, ResourceState> = {
      Db: res({
        physicalId: 'new-db',
        resourceType: 'AWS::RDS::DBInstance',
        properties: { a: 2 },
        updateReplacePolicy: 'Snapshot' as const,
      }),
    };
    await replayRollback(ops, state, 'S', ctx);
    expect(del).toHaveBeenCalledOnce();
    expect(del.mock.calls[0][4]).toEqual(
      expect.objectContaining({
        finalSnapshotIdentifier: expect.stringMatching(/^new-db-final-\d{8}-\d{6}$/),
      })
    );
  });

  it('reverse-replacement delete-new passes NO snapshot id without the policy (default polarity)', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn().mockResolvedValue({ physicalId: 'old-db', attributes: {} });
    const { ctx } = makeCtx({ delete: del, create });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Db',
        changeType: 'UPDATE',
        resourceType: 'AWS::RDS::DBInstance',
        physicalId: 'new-db',
        previousState: res({
          physicalId: 'old-db',
          resourceType: 'AWS::RDS::DBInstance',
          properties: { a: 1 },
        }),
      },
    ];
    const state: Record<string, ResourceState> = {
      Db: res({
        physicalId: 'new-db',
        resourceType: 'AWS::RDS::DBInstance',
        properties: { a: 2 },
      }),
    };
    await replayRollback(ops, state, 'S', ctx);
    expect(del).toHaveBeenCalledOnce();
    expect(
      (del.mock.calls[0][4] as Record<string, unknown>)['finalSnapshotIdentifier']
    ).toBeUndefined();
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
    const result = await replayRollback(ops, state, 'S', ctx, {
      afterOp,
      isInterrupted: () => false,
    });
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
    // The name-release retry must honor SIGINT: the caller's isInterrupted is
    // threaded into withRetry (binding for the interrupt-wiring fix).
    const retryOpts = vi.mocked(withRetry).mock.calls.at(-1)?.[2] as
      | { isInterrupted?: () => boolean; onInterrupted?: () => Error }
      | undefined;
    expect(retryOpts?.isInterrupted).toBeTypeOf('function');
    expect(retryOpts?.onInterrupted).toBeTypeOf('function');
  });

  it('reverse-replacement initial re-create retries ONLY the SQS name cooldown (issue #1206)', async () => {
    // The initial create-first attempt is wrapped in withRetry with a
    // cooldown-only filter: QueueDeletedRecently is waited out (the forward
    // replacement deleted the old name moments ago), but a genuine collision
    // must NOT be retried there — it falls through to delete-new-first.
    const create = vi.fn().mockResolvedValue({ physicalId: 'phys-old' });
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ create, delete: del });
    const prev = res({ physicalId: 'phys-old', properties: { a: 1 } });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'AWS::SQS::Queue', physicalId: 'phys-new', previousState: prev },
    ];
    const state: Record<string, ResourceState> = {
      B: res({ physicalId: 'phys-new', properties: { a: 2 } }),
    };
    const result = await replayRollback(ops, state, 'S', ctx, { isInterrupted: () => false });
    expect(result.failures).toBe(0);

    // The FIRST withRetry call is the initial create wrap.
    const initialOpts = vi.mocked(withRetry).mock.calls[0]?.[2] as
      | { maxRetries?: number; isRetryable?: (m: string) => boolean }
      | undefined;
    expect(initialOpts?.maxRetries).toBe(8);
    expect(
      initialOpts?.isRetryable?.(
        'You must wait 60 seconds after deleting a queue before you can create another with the same name.'
      )
    ).toBe(true);
    expect(initialOpts?.isRetryable?.('QueueDeletedRecently')).toBe(true);
    // Collisions are deliberately NOT retried at the initial attempt.
    expect(initialOpts?.isRetryable?.('Queue already exists')).toBe(false);
  });

  it('reverse-replacement delete-new-first retry accepts BOTH collision and cooldown (issue #1206)', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('Queue already exists'))
      .mockResolvedValue({ physicalId: 'phys-old' });
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
    expect(result.failures).toBe(0);

    // The LAST withRetry call is the post-delete re-create retry: it must
    // wait out the late name release AND the SQS same-name cooldown (the
    // delete-new-first path deterministically starts the 60s window).
    const retryOpts = vi.mocked(withRetry).mock.calls.at(-1)?.[2] as
      | { maxRetries?: number; isRetryable?: (m: string) => boolean }
      | undefined;
    expect(retryOpts?.maxRetries).toBe(8);
    expect(retryOpts?.isRetryable?.('Queue already exists')).toBe(true);
    expect(
      retryOpts?.isRetryable?.(
        'You must wait 60 seconds after deleting a queue before you can create another with the same name.'
      )
    ).toBe(true);
    expect(retryOpts?.isRetryable?.('AccessDenied')).toBe(false);
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

  it('reverse-replacement same-id (issue #1247): name-idempotent create returns the LIVE new resource — no delete, warn-and-adopt', async () => {
    // The re-create silently returns the NEW resource's physicalId (the
    // Create API is name-idempotent and the new resource still holds the
    // same user-supplied name). Pre-fix, the delete-new step then deleted
    // the very resource just recorded in state.
    const create = vi.fn().mockResolvedValue({ physicalId: 'phys-new', attributes: {} });
    const del = vi.fn();
    const { ctx, events } = makeCtx({ create, delete: del });
    const afterOp = vi.fn();
    const prev = res({ physicalId: 'phys-old', properties: { a: 1 } });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'AWS::Some::NamedType', physicalId: 'phys-new', previousState: prev },
    ];
    const state: Record<string, ResourceState> = {
      B: res({ physicalId: 'phys-new', properties: { a: 2 } }),
    };
    const result = await replayRollback(ops, state, 'S', ctx, { afterOp });
    // The delete-new step must NOT run — it would delete the live resource.
    expect(del).not.toHaveBeenCalled();
    // Warn-and-adopt: op is replayed with an exit-2 warning, not failed —
    // rollback is a recovery flow and a hard fail would strand the user in a
    // replay loop that can never succeed.
    expect(result.failures).toBe(0);
    expect(result.warnings).toBe(1);
    expect(silentLogger.warn).toHaveBeenCalledWith(expect.stringContaining('name-idempotent'));
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('may NOT have been re-applied')
    );
    // State records the intended post-rollback record (prev properties) with
    // the live physical id, so drift / the next deploy can reconcile.
    expect(state.B).toMatchObject({ physicalId: 'phys-new', properties: { a: 1 } });
    expect(afterOp).toHaveBeenCalledWith('B');
    expect(events.map((e) => e.eventType)).toContain('ROLLBACK_RESOURCE_SUCCEEDED');
  });

  it('reverse-replacement same-id after delete-new-first is the EXPECTED outcome — no warning (issue #1247 exemption)', async () => {
    // Collision → delete-new-first fallback → the re-create legitimately
    // re-acquires the same physical id under the same name (the new resource
    // is already gone). The #1247 guard must NOT fire on this path.
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('Resource already exists'))
      .mockResolvedValue({ physicalId: 'phys-new' });
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ create, delete: del });
    const prev = res({ physicalId: 'phys-old', properties: { a: 1 } });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'AWS::Some::NamedType', physicalId: 'phys-new', previousState: prev },
    ];
    const state: Record<string, ResourceState> = {
      B: res({ physicalId: 'phys-new', properties: { a: 2 } }),
    };
    // silentLogger.warn accumulates across tests in this file (no global
    // mock clearing) — snapshot the call count so the negative assertion
    // below only inspects THIS test's calls.
    const warnCallsBefore = vi.mocked(silentLogger.warn).mock.calls.length;
    const result = await replayRollback(ops, state, 'S', ctx);
    // The new resource WAS deleted (delete-first), then re-created.
    expect(del).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(result.failures).toBe(0);
    expect(result.warnings).toBe(0);
    const newWarns = vi
      .mocked(silentLogger.warn)
      .mock.calls.slice(warnCallsBefore)
      .map((c) => String(c[0]));
    expect(newWarns.some((m) => m.includes('name-idempotent'))).toBe(false);
    expect(state.B!.physicalId).toBe('phys-new');
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
    // Skips are HANDLED (warning shown once) — nothing remains pending.
    expect(result.remainingFailedOps).toEqual([]);
  });

  it('partial success: only the failed / unprocessed ops remain pending (per-op strip)', async () => {
    // Two failed UPDATEs; the revert of A succeeds, the revert of B throws.
    const update = vi
      .fn()
      .mockImplementation((logicalId: string) =>
        logicalId === 'B'
          ? Promise.reject(new Error('boom'))
          : Promise.resolve({ physicalId: 'pA' })
      );
    const { ctx } = makeCtx({ update });
    const opA: FailedOperation = {
      logicalId: 'A',
      changeType: 'UPDATE',
      resourceType: 'T',
      physicalId: 'pA',
      previousState: res({ physicalId: 'pA', properties: { a: 1 } }),
      attemptedProperties: { a: 2 },
    };
    const opB: FailedOperation = {
      logicalId: 'B',
      changeType: 'UPDATE',
      resourceType: 'T',
      physicalId: 'pB',
      previousState: res({ physicalId: 'pB', properties: { b: 1 } }),
      attemptedProperties: { b: 2 },
    };
    const state = {
      A: res({ physicalId: 'pA', properties: { a: 1 } }),
      B: res({ physicalId: 'pB', properties: { b: 1 } }),
    };
    const result = await replayFailedOperations([opA, opB], state, 'S', ctx);
    expect(result.failures).toBe(1);
    // A was reverted — it must NOT be re-issued on a re-run; B stays.
    expect(result.remainingFailedOps).toEqual([opB]);
  });

  it('interrupt mid-replay keeps the unprocessed ops pending', async () => {
    // Reverse iteration: B (last) replays first, then the interrupt fires
    // before A is reached — A must remain pending.
    let calls = 0;
    const update = vi.fn().mockImplementation(() => {
      calls++;
      return Promise.resolve({ physicalId: 'p' });
    });
    const { ctx } = makeCtx({ update });
    const opA: FailedOperation = {
      logicalId: 'A',
      changeType: 'UPDATE',
      resourceType: 'T',
      physicalId: 'pA',
      previousState: res({ physicalId: 'pA', properties: { a: 1 } }),
    };
    const opB: FailedOperation = {
      logicalId: 'B',
      changeType: 'UPDATE',
      resourceType: 'T',
      physicalId: 'pB',
      previousState: res({ physicalId: 'pB', properties: { b: 1 } }),
    };
    const state = {
      A: res({ physicalId: 'pA' }),
      B: res({ physicalId: 'pB' }),
    };
    const result = await replayFailedOperations([opA, opB], state, 'S', ctx, {
      isInterrupted: () => calls >= 1,
    });
    expect(result.interrupted).toBe(true);
    expect(result.remainingFailedOps).toEqual([opA]);
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

/**
 * `DeletionPolicy: Snapshot` on a rolled-back CREATE (issue #1358). Before
 * the fix this whole matrix ORPHANED the resource — untracked and billing.
 * Each case pins the CALL SITE, not just the classifier.
 */
describe('replayRollback — DeletionPolicy: Snapshot on a rolled-back CREATE (#1358)', () => {
  const fakeClients = {
    ec2: {},
    redshift: {},
    elastiCache: {},
  } as unknown as NonNullable<RollbackExecutorContext['finalSnapshotClients']>;

  beforeEach(() => {
    // mockReset (not mockClear): a `mockRejectedValueOnce` queued by a test
    // that never consumed it would otherwise leak into the next one.
    vi.mocked(createPreDeleteFinalSnapshot).mockReset();
    vi.mocked(createPreDeleteFinalSnapshot).mockResolvedValue('snap-1');
  });

  function snapshotOp(
    resourceType: string,
    provisionedBy?: 'sdk' | 'cc-api'
  ): CompletedOperation {
    return {
      logicalId: 'Res',
      changeType: 'CREATE',
      resourceType,
      physicalId: 'phys-res',
      ...(provisionedBy && { provisionedBy }),
    };
  }

  function snapshotState(
    resourceType: string,
    provisionedBy?: 'sdk' | 'cc-api'
  ): Record<string, ResourceState> {
    return {
      Res: res({
        physicalId: 'phys-res',
        resourceType,
        deletionPolicy: 'Snapshot' as const,
        ...(provisionedBy && { provisionedBy }),
      }),
    };
  }

  it('atomic type on the SDK route: threads finalSnapshotIdentifier into the delete', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx, events } = makeCtx({ delete: del });
    ctx.finalSnapshotClients = fakeClients;
    const state = snapshotState('AWS::RDS::DBInstance');
    const result = await replayRollback(
      [snapshotOp('AWS::RDS::DBInstance')],
      state,
      'S',
      ctx
    );
    expect(result.failures).toBe(0);
    expect(del).toHaveBeenCalledOnce();
    expect(del.mock.calls[0][4]).toEqual(
      expect.objectContaining({
        finalSnapshotIdentifier: expect.stringMatching(/^phys-res-final-\d{8}-\d{6}$/),
      })
    );
    // No pre-delete snapshot for an atomic type — the delete API takes it.
    expect(vi.mocked(createPreDeleteFinalSnapshot)).not.toHaveBeenCalled();
    expect(state['Res']).toBeUndefined();
    expect(events.map((e) => e.eventType)).toContain('ROLLBACK_RESOURCE_SUCCEEDED');
  });

  it('atomic type routed via cc-api: REFUSES (no delete, counted as a failure, stays in state)', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx, events } = makeCtx({ delete: del });
    ctx.finalSnapshotClients = fakeClients;
    const state = snapshotState('AWS::RDS::DBInstance', 'cc-api');
    const result = await replayRollback(
      [snapshotOp('AWS::RDS::DBInstance')],
      state,
      'S',
      ctx
    );
    expect(del).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
    // NOT orphaned — the record survives so a re-run (or --skip-final-snapshot)
    // can finish the job.
    expect(state['Res']).toBeDefined();
    expect(events.map((e) => e.eventType)).toContain('ROLLBACK_RESOURCE_FAILED');
  });

  it("atomic type falls back to the op's routing when the state record has none", async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ delete: del });
    ctx.finalSnapshotClients = fakeClients;
    const result = await replayRollback(
      [snapshotOp('AWS::RDS::DBInstance', 'cc-api')],
      snapshotState('AWS::RDS::DBInstance'),
      'S',
      ctx
    );
    expect(del).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
  });

  it('judges the snapshot gate against the SAME routing the delete uses', async () => {
    // The cc-api refusal is only meaningful if it judges the route the delete
    // will actually take. Both now resolve through `effectiveProvisionedBy`
    // (state record first, journaled op as the legacy fallback), so a record
    // that says cc-api cannot be refused-by-the-gate while the delete quietly
    // routes to the SDK provider (or vice versa).
    const del = vi.fn().mockResolvedValue(undefined);
    const getProviderFor = vi.fn().mockReturnValue({ provider: { delete: del } });
    const { ctx } = makeCtx({ delete: del });
    ctx.providerRegistry = {
      getProviderFor,
    } as unknown as RollbackExecutorContext['providerRegistry'];
    // Plain (non-Snapshot) delete so the run reaches the provider lookup.
    const state = {
      Res: res({ physicalId: 'phys-res', resourceType: 'AWS::S3::Bucket', provisionedBy: 'cc-api' }),
    };
    const result = await replayRollback(
      // The journaled op carries NO routing (legacy journal shape).
      [
        {
          logicalId: 'Res',
          changeType: 'CREATE' as const,
          resourceType: 'AWS::S3::Bucket',
          physicalId: 'phys-res',
        },
      ],
      state,
      'S',
      ctx
    );
    expect(result.failures).toBe(0);
    expect(getProviderFor).toHaveBeenCalledWith(
      expect.objectContaining({ provisionedBy: 'cc-api' })
    );
  });

  it('pre-delete type: snapshots FIRST with the context clients, then plain-deletes', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ delete: del });
    ctx.finalSnapshotClients = fakeClients;
    const state = snapshotState('AWS::ElastiCache::ReplicationGroup', 'cc-api');
    const result = await replayRollback(
      [snapshotOp('AWS::ElastiCache::ReplicationGroup')],
      state,
      'S',
      ctx
    );
    expect(result.failures).toBe(0);
    expect(vi.mocked(createPreDeleteFinalSnapshot)).toHaveBeenCalledWith(
      'AWS::ElastiCache::ReplicationGroup',
      'phys-res',
      'Res',
      fakeClients,
      expect.anything()
    );
    expect(del).toHaveBeenCalledOnce();
    // Pre-delete types have no atomic delete parameter.
    expect(
      (del.mock.calls[0][4] as Record<string, unknown>)['finalSnapshotIdentifier']
    ).toBeUndefined();
    // Snapshot before delete, never after.
    expect(
      vi.mocked(createPreDeleteFinalSnapshot).mock.invocationCallOrder[0]!
    ).toBeLessThan(del.mock.invocationCallOrder[0]!);
    expect(state['Res']).toBeUndefined();
  });

  it('pre-delete type with NO context clients: falls back to the process-global set (#1363)', async () => {
    // The `ctx.finalSnapshotClients ?? getAwsClients()` fallback arm — taken
    // by any caller that does not pin a region-scoped set (a legacy embedder,
    // or the engine before #1358 threaded its own). Untested until #1363, so
    // a fallback that silently resolved to `undefined` would have gone
    // unnoticed until it reached AWS.
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ delete: del });
    expect(ctx.finalSnapshotClients).toBeUndefined();
    const state = snapshotState('AWS::EC2::Volume', 'cc-api');
    const result = await replayRollback([snapshotOp('AWS::EC2::Volume')], state, 'S', ctx);
    expect(result.failures).toBe(0);
    expect(vi.mocked(createPreDeleteFinalSnapshot).mock.calls[0]![3]).toBe(processGlobalClients);
    expect(del).toHaveBeenCalledOnce();
    expect(state['Res']).toBeUndefined();
  });

  it('state record wins over the journaled op in BOTH directions (record sdk, op cc-api) (#1363)', async () => {
    // The sibling case above pins record-absent -> op-wins. This is the
    // inverse: the record says the resource is SDK-routed while a stale
    // journal entry says cc-api. The record is what state says AWS holds
    // right now, so the snapshot gate must NOT refuse and the delete must
    // take the SDK route — one routing source for both.
    const del = vi.fn().mockResolvedValue(undefined);
    const getProviderFor = vi.fn().mockReturnValue({ provider: { delete: del } });
    const { ctx } = makeCtx({ delete: del });
    ctx.providerRegistry = {
      getProviderFor,
    } as unknown as RollbackExecutorContext['providerRegistry'];
    ctx.finalSnapshotClients = fakeClients;
    const state = snapshotState('AWS::RDS::DBInstance', 'sdk');
    const result = await replayRollback(
      [snapshotOp('AWS::RDS::DBInstance', 'cc-api')],
      state,
      'S',
      ctx
    );
    expect(result.failures).toBe(0);
    expect(getProviderFor).toHaveBeenCalledWith(expect.objectContaining({ provisionedBy: 'sdk' }));
    expect(
      (del.mock.calls[0]![4] as Record<string, unknown>)['finalSnapshotIdentifier']
    ).toMatch(/^phys-res-final-\d{8}-\d{6}$/);
    expect(state['Res']).toBeUndefined();
  });

  it('pre-delete snapshot failure aborts the delete (resource kept, failure counted)', async () => {
    vi.mocked(createPreDeleteFinalSnapshot).mockRejectedValueOnce(new Error('snapshot boom'));
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ delete: del });
    ctx.finalSnapshotClients = fakeClients;
    const state = snapshotState('AWS::EC2::Volume', 'cc-api');
    const result = await replayRollback([snapshotOp('AWS::EC2::Volume')], state, 'S', ctx);
    // Assert the SNAPSHOT branch is what failed. Without this the test also
    // passes via the unsupported-refusal branch (same `failures: 1`, same
    // un-called delete) if EC2 Volume ever left PRE_DELETE_SNAPSHOT_TYPES.
    expect(vi.mocked(createPreDeleteFinalSnapshot)).toHaveBeenCalledOnce();
    expect(del).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
    expect(state['Res']).toBeDefined();
  });

  it('Snapshot-tagged type cdkd cannot snapshot: REFUSES instead of orphaning', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ delete: del });
    ctx.finalSnapshotClients = fakeClients;
    const state = snapshotState('AWS::S3::Bucket');
    const result = await replayRollback([snapshotOp('AWS::S3::Bucket')], state, 'S', ctx);
    expect(del).not.toHaveBeenCalled();
    expect(vi.mocked(createPreDeleteFinalSnapshot)).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
    expect(state['Res']).toBeDefined();
  });

  it('--skip-final-snapshot: plain delete, no snapshot, no identifier', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ delete: del });
    ctx.finalSnapshotClients = fakeClients;
    ctx.skipFinalSnapshot = true;
    const state = snapshotState('AWS::RDS::DBInstance');
    const result = await replayRollback(
      [snapshotOp('AWS::RDS::DBInstance')],
      state,
      'S',
      ctx
    );
    expect(result.failures).toBe(0);
    expect(vi.mocked(createPreDeleteFinalSnapshot)).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledOnce();
    expect(
      (del.mock.calls[0][4] as Record<string, unknown>)['finalSnapshotIdentifier']
    ).toBeUndefined();
    expect(state['Res']).toBeUndefined();
  });

  it('--skip-final-snapshot ALSO covers the otherwise-refused shapes', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ delete: del });
    ctx.finalSnapshotClients = fakeClients;
    ctx.skipFinalSnapshot = true;
    const state = snapshotState('AWS::RDS::DBInstance', 'cc-api');
    const result = await replayRollback(
      [snapshotOp('AWS::RDS::DBInstance')],
      state,
      'S',
      ctx
    );
    expect(result.failures).toBe(0);
    expect(del).toHaveBeenCalledOnce();
    expect(state['Res']).toBeUndefined();
  });

  it('Retain still ORPHANS (unchanged) — the policy says keep the resource', async () => {
    const del = vi.fn();
    const { ctx } = makeCtx({ delete: del });
    ctx.finalSnapshotClients = fakeClients;
    const state: Record<string, ResourceState> = {
      Res: res({
        physicalId: 'phys-res',
        resourceType: 'AWS::RDS::DBInstance',
        deletionPolicy: 'Retain' as const,
      }),
    };
    const result = await replayRollback(
      [snapshotOp('AWS::RDS::DBInstance')],
      state,
      'S',
      ctx
    );
    expect(del).not.toHaveBeenCalled();
    expect(vi.mocked(createPreDeleteFinalSnapshot)).not.toHaveBeenCalled();
    expect(result.failures).toBe(0);
    expect(state['Res']).toBeUndefined();
  });

  it('RetainExceptOnCreate still DELETES plainly (unchanged)', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ delete: del });
    ctx.finalSnapshotClients = fakeClients;
    const state: Record<string, ResourceState> = {
      Res: res({
        physicalId: 'phys-res',
        resourceType: 'AWS::RDS::DBInstance',
        deletionPolicy: 'RetainExceptOnCreate' as const,
      }),
    };
    const result = await replayRollback(
      [snapshotOp('AWS::RDS::DBInstance')],
      state,
      'S',
      ctx
    );
    expect(result.failures).toBe(0);
    expect(vi.mocked(createPreDeleteFinalSnapshot)).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledOnce();
    expect(
      (del.mock.calls[0][4] as Record<string, unknown>)['finalSnapshotIdentifier']
    ).toBeUndefined();
    expect(state['Res']).toBeUndefined();
  });
});
