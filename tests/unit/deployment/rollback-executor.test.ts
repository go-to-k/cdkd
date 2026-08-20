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

function makeCtx(provider: {
  delete?: unknown;
  update?: unknown;
  create?: unknown;
  disableOuterRetry?: boolean;
}): {
  ctx: RollbackExecutorContext;
  events: Array<{ eventType: string; logicalId?: string; provisionedBy?: 'sdk' | 'cc-api' }>;
} {
  // `provisionedBy` is captured so the #1366 cases can assert the event
  // reports the route the delete actually took.
  const events: Array<{
    eventType: string;
    logicalId?: string;
    provisionedBy?: 'sdk' | 'cc-api';
  }> = [];
  const ctx: RollbackExecutorContext = {
    region: 'us-east-1',
    logger: silentLogger,
    providerRegistry: {
      getProviderFor: () => ({ provider }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
    recordEvent: (e) =>
      events.push({
        eventType: e.eventType,
        logicalId: e.logicalId,
        provisionedBy: e.provisionedBy,
      }),
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
  // `withRetry` is module-mocked ONCE for the file, so its call history
  // accumulates across tests in this block — and two tests below index into it
  // positionally (`calls[0]` = the initial create wrap, `calls.at(-1)` = the
  // post-delete re-create wrap). Clear it per test so those indices mean what
  // they say; without this, ANY new withRetry call site reached by an earlier
  // test in the block silently shifts `calls[0]` (which is exactly what issue
  // #1461's rollback-path retry wrapping did).
  beforeEach(() => {
    vi.mocked(withRetry).mockClear();
  });

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
    // 6th arg: the `UpdateContext` issue #1932 item 3 added, carrying the
    // masker so a provider warn cannot echo a re-resolved secret. Matched by
    // shape so this stays an assertion about the five that were here before.
    expect(update).toHaveBeenCalledWith(
      'B',
      'phys-B',
      'AWS::S3::Bucket',
      { a: 1 },
      { a: 2 },
      { maskSecrets: expect.any(Function) }
    );
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
    // `replayingState` must survive the spread that adds the per-op masker
    // (issue #1932 item 3) -- dropping it would stop a provider's pre-flight
    // refusal downgrading to a warning and leave the old resource unrestorable.
    expect(create).toHaveBeenCalledWith('B', 'AWS::SQS::Queue', { a: 1 }, {
      replayingState: true,
      maskSecrets: expect.any(Function),
    });
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

  it('reverse-replacement passes CreateContext.replayingState at BOTH create arms (#1463)', async () => {
    // `prev.properties` is a cdkd STATE record, not the template, so a
    // provider pre-flight refusal has no template-side remedy and must
    // downgrade to a warning. The executor is what tells the provider — and
    // it has TWO create sites (create-first, and the delete-new-first retry
    // after a name collision), so both are pinned here. Missing the second
    // would leave the bug alive for exactly the collision case.
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('Queue already exists'))
      .mockResolvedValue({ physicalId: 'phys-old' });
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ create, delete: del });
    const prev = res({ physicalId: 'phys-old', properties: { a: 1 } });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'B',
        changeType: 'UPDATE',
        resourceType: 'AWS::SQS::Queue',
        physicalId: 'phys-new',
        previousState: prev,
      },
    ];
    const state: Record<string, ResourceState> = {
      B: res({ physicalId: 'phys-new', properties: { a: 2 } }),
    };

    const result = await replayRollback(ops, state, 'S', ctx, { isInterrupted: () => false });

    expect(result.failures).toBe(0);
    expect(create).toHaveBeenCalledTimes(2);
    for (const call of create.mock.calls) {
      // Exact key set, so a future field added to the rollback create context
      // still trips this fence -- but `maskSecrets` is admitted, since issue
      // #1932 item 3 makes it universal across every create call site.
      expect(call[3]).toEqual({ replayingState: true, maskSecrets: expect.any(Function) });
    }
  });

  it("the 'revert' arm wraps provider.update in withRetry (issue #1461)", async () => {
    // Deploy (`deploy-engine.ts`) and `drift --revert` (`drift.ts`) have always
    // wrapped their provider.update() calls; this arm did not. That became a
    // REGRESSION once a provider's update() started issuing a read of its own
    // (Glue's pre-update GetTable): a throttle would fail the op, and the
    // best-effort catch in this executor counts that as a failure and moves on,
    // leaving the resource unreverted. A transient failure on a recovery path
    // is the worst place to give up on the first attempt.
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    const { ctx } = makeCtx({ update });
    const prev = res({ physicalId: 'phys-B', properties: { a: 1 } });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'T', physicalId: 'phys-B', previousState: prev },
    ];
    const state: Record<string, ResourceState> = {
      B: res({ physicalId: 'phys-B', properties: { a: 2 } }),
    };

    const result = await replayRollback(ops, state, 'S', ctx);

    expect(result.failures).toBe(0);
    expect(update).toHaveBeenCalledWith('B', 'phys-B', 'T', { a: 1 }, { a: 2 }, { maskSecrets: expect.any(Function) });
    // The update went THROUGH withRetry, not around it.
    expect(vi.mocked(withRetry)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(withRetry).mock.calls[0]![1]).toBe('B');
  });

  it("the 'revert' arm records the provider's effectiveProperties (issue #1644)", async () => {
    // `effectiveProperties` is how a provider says "this is what I actually
    // SENT" — the narrowing loop breaker (#1591 / #1633). The engine honours it
    // via `propertiesToRecord`; this arm wrote `previousState` back verbatim,
    // so the record described a value AWS does not hold and the next deploy
    // read it as the previous side.
    const update = vi
      .fn()
      .mockResolvedValue({ physicalId: 'phys-B', effectiveProperties: { a: 1, b: 'tcp' } });
    const { ctx } = makeCtx({ update });
    const prev = res({ physicalId: 'phys-B', properties: { a: 1, b: 6 } });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'T', physicalId: 'phys-B', previousState: prev },
    ];
    const state: Record<string, ResourceState> = {
      B: res({ physicalId: 'phys-B', properties: { a: 2, b: 6 } }),
    };

    const result = await replayRollback(ops, state, 'S', ctx);

    expect(result.failures).toBe(0);
    expect(state['B']!.properties).toEqual({ a: 1, b: 'tcp' });
    // Everything else on the restored record survives.
    expect(state['B']!.physicalId).toBe('phys-B');
    // The caller's `previousState` object is not mutated in place.
    expect(prev.properties).toEqual({ a: 1, b: 6 });
  });

  it("the 'revert' arm REPLACES properties rather than merging, so a dropped key is gone (issue #1644)", async () => {
    // The only real producer narrows by DROPPING a key (an `AWS::EC2::Route`
    // losing destination). A merge (`{...restored.properties, ...effective}`)
    // is indistinguishable from a replace when every key is echoed back, so
    // this is the case that pins the contract.
    const update = vi.fn().mockResolvedValue({
      physicalId: 'phys-B',
      effectiveProperties: { DestinationCidrBlock: '10.0.0.0/16' },
    });
    const { ctx } = makeCtx({ update });
    const prev = res({
      physicalId: 'phys-B',
      properties: { DestinationCidrBlock: '10.0.0.0/16', DestinationIpv6CidrBlock: '::/0' },
    });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'AWS::EC2::Route', physicalId: 'phys-B', previousState: prev },
    ];
    const state: Record<string, ResourceState> = {
      B: res({ physicalId: 'phys-B', properties: { DestinationCidrBlock: '10.9.0.0/16' } }),
    };

    await replayRollback(ops, state, 'S', ctx);

    expect('DestinationIpv6CidrBlock' in state['B']!.properties).toBe(false);
    expect(state['B']!.properties).toEqual({ DestinationCidrBlock: '10.0.0.0/16' });
  });

  it("the 'revert' arm copies the provider's bag instead of aliasing it (issue #1644)", async () => {
    // The record outlives the call; a provider is free to keep mutating the
    // object it handed back.
    const effective: Record<string, unknown> = { a: 1 };
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B', effectiveProperties: effective });
    const { ctx } = makeCtx({ update });
    const prev = res({ physicalId: 'phys-B', properties: { a: 1, b: 2 } });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'T', physicalId: 'phys-B', previousState: prev },
    ];
    const state: Record<string, ResourceState> = {
      B: res({ physicalId: 'phys-B', properties: { a: 9 } }),
    };

    await replayRollback(ops, state, 'S', ctx);
    effective['a'] = 'MUTATED AFTER THE CALL';

    expect(state['B']!.properties).toEqual({ a: 1 });
  });

  it("the 'revert' arm keeps previousState verbatim when the provider reports no narrowing (issue #1644)", async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    const { ctx } = makeCtx({ update });
    const prev = res({ physicalId: 'phys-B', properties: { a: 1 } });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'T', physicalId: 'phys-B', previousState: prev },
    ];
    const state: Record<string, ResourceState> = {
      B: res({ physicalId: 'phys-B', properties: { a: 2 } }),
    };

    await replayRollback(ops, state, 'S', ctx);

    expect(state['B']).toBe(prev);
  });

  it("the 'revert' arm honors provider.disableOuterRetry (issue #1461)", async () => {
    // CustomResourceProvider and NestedStackProvider both set the flag AND
    // implement update(). Re-invoking a Custom Resource derives a FRESH
    // RequestId + pre-signed response URL, so the first attempt's response
    // lands at an S3 key nobody polls — the hang the flag exists to prevent.
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    const { ctx } = makeCtx({ update, disableOuterRetry: true });
    const prev = res({ physicalId: 'phys-B', properties: { a: 1 } });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'Custom::X', physicalId: 'phys-B', previousState: prev },
    ];
    const state: Record<string, ResourceState> = {
      B: res({ physicalId: 'phys-B', properties: { a: 2 } }),
    };

    const result = await replayRollback(ops, state, 'S', ctx);

    expect(result.failures).toBe(0);
    // The update still ran — exactly once, and NOT through withRetry.
    expect(update).toHaveBeenCalledTimes(1);
    expect(vi.mocked(withRetry)).not.toHaveBeenCalled();
  });

  it("the 'revert' arm threads isInterrupted into the retry (issue #1461)", async () => {
    // replayRollback polls interrupts only BETWEEN ops, so an un-threaded
    // isInterrupted leaves Ctrl-C dead for the whole backoff schedule.
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    const { ctx } = makeCtx({ update });
    const prev = res({ physicalId: 'phys-B', properties: { a: 1 } });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'T', physicalId: 'phys-B', previousState: prev },
    ];
    const state: Record<string, ResourceState> = {
      B: res({ physicalId: 'phys-B', properties: { a: 2 } }),
    };
    // Must return false: replayRollback polls interrupts BETWEEN ops, so a
    // permanently-true probe stops the replay before the op runs and withRetry
    // is never reached. What is under test is that the reference is THREADED.
    const isInterrupted = () => false;

    await replayRollback(ops, state, 'S', ctx, { isInterrupted });

    const opts = vi.mocked(withRetry).mock.calls[0]?.[2] as
      | { isInterrupted?: () => boolean; onInterrupted?: () => Error }
      | undefined;
    expect(opts?.isInterrupted).toBe(isInterrupted);
    expect(opts?.onInterrupted?.()).toBeInstanceOf(Error);
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

    // The last OUTER withRetry call is the post-delete re-create retry: it must
    // wait out the late name release AND the SQS same-name cooldown (the
    // delete-new-first path deterministically starts the 60s window).
    //
    // Selected by "carries a custom classifier" rather than by `.at(-1)`
    // (issue #2032): each outer call now NESTS an inner default-schedule
    // `withRetry` that passes neither a schedule nor an `isRetryable` — that is
    // exactly what re-arms the dense IAM-propagation path — so the literally
    // last call is the inner one and reading it would assert nothing.
    const outerCalls = vi
      .mocked(withRetry)
      .mock.calls.filter(
        (c) => (c[2] as { isRetryable?: unknown } | undefined)?.isRetryable !== undefined
      );
    expect(outerCalls).toHaveLength(2);
    const retryOpts = outerCalls.at(-1)?.[2] as
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

  it("reverse-replacement records the provider's effectiveProperties (issue #1682)", async () => {
    // The replay-CREATE arm is the one caller that needs this most: the bag it
    // hands `create()` is a STATE record, so it can carry a malformed block
    // that the provider warns about and SUBSTITUTES (the #1544 replayWarn
    // downgrade). Pre-fix the record was rebuilt from prev.properties
    // unconditionally, so the substitution was announced into a void and the
    // phantom drift it exists to close survived the rollback.
    const effective = { a: 1, StreamSpecification: { StreamEnabled: true } };
    const create = vi.fn().mockResolvedValue({
      physicalId: 'phys-old-2',
      attributes: { Arn: 'arn:old' },
      effectiveProperties: effective,
    });
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ create, delete: del });
    const prev = res({
      physicalId: 'phys-old',
      properties: { a: 1, StreamSpecification: 'not-an-object' },
    });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'AWS::SQS::Queue', physicalId: 'phys-new', previousState: prev },
    ];
    const state: Record<string, ResourceState> = {
      B: res({ physicalId: 'phys-new', properties: { a: 2 } }),
    };
    await replayRollback(ops, state, 'S', ctx);
    // The bag the provider SENT, not the malformed one state carried.
    expect(state.B!.properties).toEqual(effective);
    // Copied, not aliased — the record outlives the call.
    expect(state.B!.properties).not.toBe(effective);
    // Everything else on the fresh record is unchanged by the wiring.
    expect(state.B).toMatchObject({ physicalId: 'phys-old-2', attributes: { Arn: 'arn:old' } });
  });

  it('reverse-replacement keeps prev.properties when the provider reports NO effectiveProperties (issue #1682 default polarity)', async () => {
    const create = vi.fn().mockResolvedValue({ physicalId: 'phys-old-2' });
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ create, delete: del });
    const prev = res({ physicalId: 'phys-old', properties: { a: 1, b: 'keep' } });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'AWS::SQS::Queue', physicalId: 'phys-new', previousState: prev },
    ];
    const state: Record<string, ResourceState> = {
      B: res({ physicalId: 'phys-new', properties: { a: 2 } }),
    };
    await replayRollback(ops, state, 'S', ctx);
    // The overwhelmingly common case: no report means "record the intended
    // post-rollback bag", NOT a blanked record.
    expect(state.B!.properties).toEqual({ a: 1, b: 'keep' });
    // Pass-through BY REFERENCE, which the helper's comment calls load-bearing:
    // it is what makes the fallback byte-identical to the pre-#1682 spread of
    // `prevRecord`. A copy here would be a behavior change smuggled in under a
    // no-op, and `toEqual` alone cannot tell the two apart.
    expect(state.B!.properties).toBe(prev.properties);
  });

  it('reverse-replacement honours an EMPTY effectiveProperties as a complete answer (issue #1682)', async () => {
    // `{}` is a legitimate "I sent nothing" answer and must not be confused
    // with "reported nothing" — the gate is presence, not emptiness.
    const create = vi
      .fn()
      .mockResolvedValue({ physicalId: 'phys-old-2', effectiveProperties: {} });
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ create, delete: del });
    const prev = res({ physicalId: 'phys-old', properties: { a: 1 } });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'AWS::SQS::Queue', physicalId: 'phys-new', previousState: prev },
    ];
    const state: Record<string, ResourceState> = {
      B: res({ physicalId: 'phys-new', properties: { a: 2 } }),
    };
    await replayRollback(ops, state, 'S', ctx);
    expect(state.B!.properties).toEqual({});
  });

  it('reverse-replacement delete-new-first retry records the retried create\'s effectiveProperties (issue #1682)', async () => {
    // The collision fallback is the SECOND create attempt; it must honour the
    // report too, or the arm that runs on a name collision keeps the void.
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('Queue already exists'))
      .mockResolvedValue({ physicalId: 'phys-old', effectiveProperties: { a: 1, fixed: true } });
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ create, delete: del });
    const prev = res({ physicalId: 'phys-old', properties: { a: 1, fixed: 'malformed' } });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'AWS::SQS::Queue', physicalId: 'phys-new', previousState: prev },
    ];
    const state: Record<string, ResourceState> = {
      B: res({ physicalId: 'phys-new', properties: { a: 2 } }),
    };
    await replayRollback(ops, state, 'S', ctx);
    expect(create).toHaveBeenCalledTimes(2);
    expect(state.B!.properties).toEqual({ a: 1, fixed: true });
  });

  it('reverse-replacement same-id ADOPT path records effectiveProperties too (issue #1682 x #1247)', async () => {
    // The adopt warning says state records "the pre-replacement properties" —
    // and it still does: a substitution repairs an unusable field of that same
    // bag, it does not swap in the new generation's values.
    const create = vi
      .fn()
      .mockResolvedValue({ physicalId: 'phys-new', effectiveProperties: { a: 1, fixed: true } });
    const del = vi.fn();
    const { ctx } = makeCtx({ create, delete: del });
    const prev = res({ physicalId: 'phys-old', properties: { a: 1, fixed: 'malformed' } });
    const ops: CompletedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'AWS::Some::NamedType', physicalId: 'phys-new', previousState: prev },
    ];
    const state: Record<string, ResourceState> = {
      B: res({ physicalId: 'phys-new', properties: { a: 2 } }),
    };
    const result = await replayRollback(ops, state, 'S', ctx);
    expect(del).not.toHaveBeenCalled();
    expect(result.warnings).toBe(1);
    expect(state.B).toMatchObject({ physicalId: 'phys-new', properties: { a: 1, fixed: true } });
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
  // Same latent cross-test leak the `replayRollback` block has: `withRetry` is
  // module-mocked ONCE for the file, so its call history accumulates and any
  // positional assertion silently reads an earlier test's calls.
  beforeEach(() => {
    vi.mocked(withRetry).mockClear();
  });

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
    expect(update).toHaveBeenCalledWith(
      'B',
      'phys-B',
      'AWS::S3::Bucket',
      { a: 1 },
      { a: 2 },
      { maskSecrets: expect.any(Function) }
    );
    expect(state.B).toBe(prev);
    expect(result.failures).toBe(0);
    expect(afterOp).toHaveBeenCalledWith('B');
    expect(events.map((e) => e.eventType)).toContain('ROLLBACK_RESOURCE_SUCCEEDED');
  });

  it("the 'revert-failed-update' arm wraps provider.update in withRetry (issue #1461)", async () => {
    // Twin of the `revert`-arm guard in the replayRollback block: same
    // best-effort catch, same newly-read-issuing provider update.
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    const { ctx } = makeCtx({ update });
    const prev = res({ physicalId: 'phys-B', properties: { a: 1 } });
    const failedOps: FailedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'T', physicalId: 'phys-B', previousState: prev, attemptedProperties: { a: 2 } },
    ];
    const state = { B: res({ physicalId: 'phys-B', properties: { a: 1 } }) };

    const result = await replayFailedOperations(failedOps, state, 'S', ctx);

    expect(result.failures).toBe(0);
    expect(update).toHaveBeenCalledWith('B', 'phys-B', 'T', { a: 1 }, { a: 2 }, { maskSecrets: expect.any(Function) });
    expect(vi.mocked(withRetry)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(withRetry).mock.calls[0]![1]).toBe('B');
  });

  it("the 'revert-failed-update' arm records the provider's effectiveProperties (issue #1644)", async () => {
    // Twin of the `revert`-arm pin: this arm wrote `op.previousState` back
    // verbatim too, so a narrowing announced on the force-revert path was
    // dropped exactly the same way.
    const update = vi
      .fn()
      .mockResolvedValue({ physicalId: 'phys-B', effectiveProperties: { a: 1, b: 'tcp' } });
    const { ctx } = makeCtx({ update });
    const prev = res({ physicalId: 'phys-B', properties: { a: 1, b: 6 } });
    const failedOps: FailedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'T', physicalId: 'phys-B', previousState: prev, attemptedProperties: { a: 2, b: 6 } },
    ];
    const state = { B: res({ physicalId: 'phys-B', properties: { a: 2, b: 6 } }) };

    const result = await replayFailedOperations(failedOps, state, 'S', ctx);

    expect(result.failures).toBe(0);
    expect(state['B']!.properties).toEqual({ a: 1, b: 'tcp' });
    expect(state['B']!.physicalId).toBe('phys-B');
    expect(prev.properties).toEqual({ a: 1, b: 6 });
  });

  it("the 'revert-failed-update' arm keeps previousState verbatim without a narrowing (issue #1644)", async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    const { ctx } = makeCtx({ update });
    const prev = res({ physicalId: 'phys-B', properties: { a: 1 } });
    const failedOps: FailedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'T', physicalId: 'phys-B', previousState: prev, attemptedProperties: { a: 2 } },
    ];
    const state = { B: res({ physicalId: 'phys-B', properties: { a: 2 } }) };

    await replayFailedOperations(failedOps, state, 'S', ctx);

    expect(state['B']).toBe(prev);
  });

  it("the 'revert-failed-update' arm honors disableOuterRetry and threads isInterrupted (issue #1461)", async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    const { ctx } = makeCtx({ update, disableOuterRetry: true });
    const prev = res({ physicalId: 'phys-B', properties: { a: 1 } });
    const failedOps: FailedOperation[] = [
      { logicalId: 'B', changeType: 'UPDATE', resourceType: 'Custom::X', physicalId: 'phys-B', previousState: prev, attemptedProperties: { a: 2 } },
    ];
    const state = { B: res({ physicalId: 'phys-B', properties: { a: 1 } }) };

    await replayFailedOperations(failedOps, state, 'S', ctx);
    expect(update).toHaveBeenCalledTimes(1);
    expect(vi.mocked(withRetry)).not.toHaveBeenCalled();

    // And the retrying (non-opt-out) path carries the interrupt hook.
    vi.mocked(withRetry).mockClear();
    const { ctx: retryCtx } = makeCtx({ update: vi.fn().mockResolvedValue({}) });
    const isInterrupted = () => false;
    await replayFailedOperations(
      failedOps,
      { B: res({ physicalId: 'phys-B', properties: { a: 1 } }) },
      'S',
      retryCtx,
      { isInterrupted }
    );
    const opts = vi.mocked(withRetry).mock.calls[0]?.[2] as
      | { isInterrupted?: () => boolean; onInterrupted?: () => Error }
      | undefined;
    expect(opts?.isInterrupted).toBe(isInterrupted);
    expect(opts?.onInterrupted?.()).toBeInstanceOf(Error);
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
    expect(update).toHaveBeenCalledWith('B', 'phys-B', 'T', { a: 1 }, { a: 1 }, { maskSecrets: expect.any(Function) });
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

/**
 * `DeletionPolicy` on a FAILED in-flight CREATE — `cdkd rollback
 * --revert-failed`'s `delete-failed-create` (issue #1362, the sibling path
 * #1358 deliberately left out of scope).
 *
 * Before the fix this branch read NO policy at all: a `Snapshot` resource
 * whose CREATE failed after AWS had already provisioned it (physical id
 * recorded — the precondition `classifyFailedOp` requires) was deleted with
 * no final snapshot and no refusal, and a `Retain` one was deleted outright.
 * Each case pins the CALL SITE, not just the classifier.
 */
describe('replayFailedOperations — DeletionPolicy on a FAILED CREATE (#1362)', () => {
  const fakeClients = {
    ec2: {},
    redshift: {},
    elastiCache: {},
  } as unknown as NonNullable<RollbackExecutorContext['finalSnapshotClients']>;

  beforeEach(() => {
    vi.mocked(createPreDeleteFinalSnapshot).mockReset();
    vi.mocked(createPreDeleteFinalSnapshot).mockResolvedValue('snap-1');
    // The logger is shared across the file; the refusal cases below assert on
    // its text, so drain it per-test.
    (silentLogger.warn as ReturnType<typeof vi.fn>).mockClear();
    (silentLogger.info as ReturnType<typeof vi.fn>).mockClear();
  });

  /** Every `logger.<level>` line emitted by the replay under test. */
  function loggedLines(level: 'info' | 'warn' = 'warn'): string[] {
    return (silentLogger[level] as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
  }

  function failedCreate(resourceType: string, provisionedBy?: 'sdk' | 'cc-api'): FailedOperation {
    return {
      logicalId: 'Res',
      changeType: 'CREATE',
      resourceType,
      physicalId: 'phys-res',
      attemptedProperties: { Size: 1 },
      ...(provisionedBy && { provisionedBy }),
    };
  }

  function stateWithPolicy(
    resourceType: string,
    deletionPolicy: ResourceState['deletionPolicy'],
    provisionedBy?: 'sdk' | 'cc-api'
  ): Record<string, ResourceState> {
    return {
      Res: res({
        physicalId: 'phys-res',
        resourceType,
        ...(deletionPolicy && { deletionPolicy }),
        ...(provisionedBy && { provisionedBy }),
      }),
    };
  }

  describe('classifyFailedOp', () => {
    it('Retain → orphan-failed-create-retain', () => {
      expect(
        classifyFailedOp(
          failedCreate('AWS::EC2::Volume'),
          stateWithPolicy('AWS::EC2::Volume', 'Retain')
        )
      ).toBe('orphan-failed-create-retain');
    });

    it('Snapshot → delete-failed-create-with-final-snapshot', () => {
      expect(
        classifyFailedOp(
          failedCreate('AWS::EC2::Volume'),
          stateWithPolicy('AWS::EC2::Volume', 'Snapshot')
        )
      ).toBe('delete-failed-create-with-final-snapshot');
    });

    it('RetainExceptOnCreate → delete-failed-create (this IS the on-create case it opts out of)', () => {
      expect(
        classifyFailedOp(
          failedCreate('AWS::EC2::Volume'),
          stateWithPolicy('AWS::EC2::Volume', 'RetainExceptOnCreate')
        )
      ).toBe('delete-failed-create');
    });

    it('Delete → delete-failed-create (default polarity unchanged)', () => {
      expect(
        classifyFailedOp(
          failedCreate('AWS::EC2::Volume'),
          stateWithPolicy('AWS::EC2::Volume', 'Delete')
        )
      ).toBe('delete-failed-create');
    });

    it('no recorded physical id wins over the policy (nothing was provisioned)', () => {
      // The reachability precondition for the whole matrix: no physical id
      // means AWS may never have created anything, so a Retain record must
      // NOT turn into an "orphan" of a resource that might not exist.
      const op: FailedOperation = {
        logicalId: 'Res',
        changeType: 'CREATE',
        resourceType: 'AWS::EC2::Volume',
      };
      expect(classifyFailedOp(op, stateWithPolicy('AWS::EC2::Volume', 'Retain'))).toBe(
        'skip-failed-unknown'
      );
    });

    it('an EMPTY physical id is treated as none, not as a delete target', () => {
      // `''` is falsy but not `undefined`; an `=== undefined` guard would let
      // it through to `buildFinalSnapshotIdentifier('')` and a delete against
      // an empty id. Unreachable from today's deploy engine, guarded anyway.
      const op: FailedOperation = {
        logicalId: 'Res',
        changeType: 'CREATE',
        resourceType: 'AWS::EC2::Volume',
        physicalId: '',
      };
      expect(classifyFailedOp(op, stateWithPolicy('AWS::EC2::Volume', 'Snapshot'))).toBe(
        'skip-failed-unknown'
      );
    });

    it('a policy on a record whose physical id does NOT match is never consulted', () => {
      // The mismatch guard runs FIRST: a Retain record for a DIFFERENT
      // physical resource must not turn into an orphan of that resource.
      const state = stateWithPolicy('AWS::EC2::Volume', 'Retain');
      state['Res']!.physicalId = 'other-phys';
      expect(classifyFailedOp(failedCreate('AWS::EC2::Volume'), state)).toBe('skip-failed-noop');
    });
  });

  it('Retain: leaves the resource in AWS and drops the record (no delete)', async () => {
    const del = vi.fn();
    const { ctx, events } = makeCtx({ delete: del });
    ctx.finalSnapshotClients = fakeClients;
    const state = stateWithPolicy('AWS::EC2::Volume', 'Retain');
    const result = await replayFailedOperations(
      [failedCreate('AWS::EC2::Volume')],
      state,
      'S',
      ctx
    );
    expect(del).not.toHaveBeenCalled();
    expect(vi.mocked(createPreDeleteFinalSnapshot)).not.toHaveBeenCalled();
    expect(result.failures).toBe(0);
    expect(result.remainingFailedOps).toEqual([]);
    expect(state['Res']).toBeUndefined();
    expect(events.map((e) => e.eventType)).toContain('ROLLBACK_RESOURCE_SUCCEEDED');
  });

  it('Snapshot on an atomic SDK-routed type: threads the identifier into the delete', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ delete: del });
    ctx.finalSnapshotClients = fakeClients;
    const state = stateWithPolicy('AWS::RDS::DBInstance', 'Snapshot');
    const result = await replayFailedOperations(
      [failedCreate('AWS::RDS::DBInstance')],
      state,
      'S',
      ctx
    );
    expect(result.failures).toBe(0);
    expect(del).toHaveBeenCalledOnce();
    expect(del.mock.calls[0]![4]).toEqual(
      expect.objectContaining({
        finalSnapshotIdentifier: expect.stringMatching(/^phys-res-final-\d{8}-\d{6}$/),
      })
    );
    // The attempted properties keep flowing (issue #1340 data-guard opt-ins).
    expect(del.mock.calls[0]![3]).toEqual({ Size: 1 });
    expect(vi.mocked(createPreDeleteFinalSnapshot)).not.toHaveBeenCalled();
    expect(state['Res']).toBeUndefined();
  });

  it('Snapshot on a pre-delete type: snapshots FIRST with the context clients, then deletes', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ delete: del });
    ctx.finalSnapshotClients = fakeClients;
    const state = stateWithPolicy('AWS::EC2::Volume', 'Snapshot', 'cc-api');
    const result = await replayFailedOperations(
      [failedCreate('AWS::EC2::Volume')],
      state,
      'S',
      ctx
    );
    expect(result.failures).toBe(0);
    expect(vi.mocked(createPreDeleteFinalSnapshot)).toHaveBeenCalledWith(
      'AWS::EC2::Volume',
      'phys-res',
      'Res',
      fakeClients,
      expect.anything()
    );
    expect(
      vi.mocked(createPreDeleteFinalSnapshot).mock.invocationCallOrder[0]!
    ).toBeLessThan(del.mock.invocationCallOrder[0]!);
    expect(
      (del.mock.calls[0]![4] as Record<string, unknown>)['finalSnapshotIdentifier']
    ).toBeUndefined();
    expect(state['Res']).toBeUndefined();
  });

  it('Snapshot: a snapshot failure ABORTS the delete and keeps the op for a re-run', async () => {
    // The load-bearing property of the strict option: a half-created
    // resource that is not snapshot-capable YET becomes snapshot-able once
    // it settles, so refusing preserves the data a plain delete would lose.
    vi.mocked(createPreDeleteFinalSnapshot).mockRejectedValueOnce(new Error('still creating'));
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx, events } = makeCtx({ delete: del });
    ctx.finalSnapshotClients = fakeClients;
    const state = stateWithPolicy('AWS::EC2::Volume', 'Snapshot', 'cc-api');
    const op = failedCreate('AWS::EC2::Volume');
    const result = await replayFailedOperations([op], state, 'S', ctx);
    expect(vi.mocked(createPreDeleteFinalSnapshot)).toHaveBeenCalledOnce();
    expect(del).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
    expect(state['Res']).toBeDefined();
    // Kept in the journal so `cdkd rollback --revert-failed` can retry once
    // the resource settles (or with --skip-final-snapshot).
    expect(result.remainingFailedOps).toEqual([op]);
    expect(events.map((e) => e.eventType)).toContain('ROLLBACK_RESOURCE_FAILED');
  });

  it('Snapshot on a cc-api-routed atomic type: REFUSES (Cloud Control cannot snapshot)', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ delete: del });
    ctx.finalSnapshotClients = fakeClients;
    const state = stateWithPolicy('AWS::RDS::DBInstance', 'Snapshot', 'cc-api');
    const op = failedCreate('AWS::RDS::DBInstance');
    const result = await replayFailedOperations([op], state, 'S', ctx);
    expect(del).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
    expect(state['Res']).toBeDefined();
    expect(result.remainingFailedOps).toEqual([op]);
    // Pin WHICH refusal fired: without this the case also passes via the
    // unsupported-shape arm below (same failures/kept-record/no-delete
    // outcome), so a matrix that collapsed to always-refuse would look green.
    expect(loggedLines().some((l) => /cc-api/.test(l))).toBe(true);
  });

  it('Snapshot on a shape cdkd cannot snapshot: REFUSES instead of plain-deleting', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ delete: del });
    ctx.finalSnapshotClients = fakeClients;
    const state = stateWithPolicy('AWS::S3::Bucket', 'Snapshot');
    const result = await replayFailedOperations([failedCreate('AWS::S3::Bucket')], state, 'S', ctx);
    expect(del).not.toHaveBeenCalled();
    expect(vi.mocked(createPreDeleteFinalSnapshot)).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
    expect(state['Res']).toBeDefined();
    // The OTHER refusal (see the cc-api case above): this shape has no
    // snapshot mechanism at all, so the message names the type, not a route.
    expect(loggedLines().some((l) => /does not implement final snapshots/.test(l))).toBe(true);
    expect(loggedLines().some((l) => /cc-api/.test(l))).toBe(false);
  });

  it('--skip-final-snapshot: plain delete, including the otherwise-refused shapes', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ delete: del });
    ctx.finalSnapshotClients = fakeClients;
    ctx.skipFinalSnapshot = true;
    const state = stateWithPolicy('AWS::S3::Bucket', 'Snapshot');
    const result = await replayFailedOperations([failedCreate('AWS::S3::Bucket')], state, 'S', ctx);
    expect(result.failures).toBe(0);
    expect(vi.mocked(createPreDeleteFinalSnapshot)).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledOnce();
    expect(
      (del.mock.calls[0]![4] as Record<string, unknown>)['finalSnapshotIdentifier']
    ).toBeUndefined();
    expect(state['Res']).toBeUndefined();
    // The outcome above is byte-identical to the PRE-#1362 policy-blind
    // delete, so it cannot bind on its own. The audit line is what says a
    // Snapshot-policy resource was destroyed WITHOUT its snapshot on purpose.
    expect(
      loggedLines('info').some((l) =>
        /DeletionPolicy: Snapshot NOT taken \(--skip-final-snapshot\)/.test(l)
      )
    ).toBe(true);
  });

  it('--skip-final-snapshot does NOT override Retain (that policy is not about snapshots)', async () => {
    const del = vi.fn();
    const { ctx } = makeCtx({ delete: del });
    ctx.skipFinalSnapshot = true;
    const state = stateWithPolicy('AWS::EC2::Volume', 'Retain');
    const result = await replayFailedOperations(
      [failedCreate('AWS::EC2::Volume')],
      state,
      'S',
      ctx
    );
    expect(del).not.toHaveBeenCalled();
    expect(result.failures).toBe(0);
    expect(state['Res']).toBeUndefined();
  });

  it('judges the snapshot gate against the SAME routing the delete uses', async () => {
    // The state record wins over the journaled op, for both the gate and the
    // provider lookup — a record that says SDK cannot be refused by a gate
    // reading a stale cc-api journal entry (and vice versa).
    const del = vi.fn().mockResolvedValue(undefined);
    const getProviderFor = vi.fn().mockReturnValue({ provider: { delete: del } });
    const { ctx } = makeCtx({ delete: del });
    ctx.providerRegistry = {
      getProviderFor,
    } as unknown as RollbackExecutorContext['providerRegistry'];
    ctx.finalSnapshotClients = fakeClients;
    const state = stateWithPolicy('AWS::RDS::DBInstance', 'Snapshot', 'sdk');
    const result = await replayFailedOperations(
      [failedCreate('AWS::RDS::DBInstance', 'cc-api')],
      state,
      'S',
      ctx
    );
    expect(result.failures).toBe(0);
    expect(getProviderFor).toHaveBeenCalledWith(expect.objectContaining({ provisionedBy: 'sdk' }));
    expect(
      (del.mock.calls[0]![4] as Record<string, unknown>)['finalSnapshotIdentifier']
    ).toMatch(/^phys-res-final-\d{8}-\d{6}$/);
  });

  it('no policy: unchanged plain delete with the attempted properties', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ delete: del });
    const state = stateWithPolicy('AWS::EC2::Volume', undefined);
    const result = await replayFailedOperations(
      [failedCreate('AWS::EC2::Volume')],
      state,
      'S',
      ctx
    );
    expect(result.failures).toBe(0);
    expect(del).toHaveBeenCalledWith('Res', 'phys-res', 'AWS::EC2::Volume', { Size: 1 }, {
      expectedRegion: 'us-east-1',
    });
    expect(state['Res']).toBeUndefined();
  });
});

/**
 * Issue #1366: the rollback event must report the route the delete ACTUALLY
 * took, and the plan must carry that route so the CLI's preview can consult
 * the same mechanism matrix the replay runs.
 *
 * Both are only observable when the journaled op and the state record
 * DISAGREE — which is exactly the legacy-journal shape `effectiveProvisionedBy`
 * exists for, and why every case below sets the two to different values.
 */
describe('rollback route reporting + plan route stamping (#1366)', () => {
  function createOp(provisionedBy?: 'sdk' | 'cc-api'): CompletedOperation {
    return {
      logicalId: 'Res',
      changeType: 'CREATE',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'phys-res',
      ...(provisionedBy && { provisionedBy }),
    };
  }

  function recordWith(
    provisionedBy: 'sdk' | 'cc-api',
    deletionPolicy?: ResourceState['deletionPolicy']
  ): Record<string, ResourceState> {
    return {
      Res: res({
        physicalId: 'phys-res',
        resourceType: 'AWS::S3::Bucket',
        provisionedBy,
        ...(deletionPolicy && { deletionPolicy }),
      }),
    };
  }

  it('a completed-CREATE delete event reports the state record route, not the journaled one', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx, events } = makeCtx({ delete: del });
    // Journal says sdk; the record (authoritative) says cc-api.
    await replayRollback([createOp('sdk')], recordWith('cc-api'), 'S', ctx);
    expect(events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED')?.provisionedBy).toBe(
      'cc-api'
    );
  });

  it('an orphan-retain event reports the record route, resolved BEFORE the record is dropped', async () => {
    // The orphan arm deletes the state record first, so a naive read after
    // the mutation would silently fall back to the journaled value.
    const { ctx, events } = makeCtx({ delete: vi.fn() });
    const state = recordWith('cc-api', 'Retain');
    await replayRollback([createOp('sdk')], state, 'S', ctx);
    expect(state['Res']).toBeUndefined();
    expect(events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED')?.provisionedBy).toBe(
      'cc-api'
    );
  });

  it('a failed-CREATE delete event reports the record route (--revert-failed)', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx, events } = makeCtx({ delete: del });
    const failed: FailedOperation = {
      logicalId: 'Res',
      changeType: 'CREATE',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'phys-res',
      provisionedBy: 'sdk',
    };
    await replayFailedOperations([failed], recordWith('cc-api'), 'S', ctx);
    expect(events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED')?.provisionedBy).toBe(
      'cc-api'
    );
  });

  it('a failed-CREATE orphan event reports the record route, resolved before the drop', async () => {
    const { ctx, events } = makeCtx({ delete: vi.fn() });
    const state = recordWith('cc-api', 'Retain');
    const failed: FailedOperation = {
      logicalId: 'Res',
      changeType: 'CREATE',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'phys-res',
      provisionedBy: 'sdk',
    };
    await replayFailedOperations([failed], state, 'S', ctx);
    expect(state['Res']).toBeUndefined();
    expect(events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED')?.provisionedBy).toBe(
      'cc-api'
    );
  });

  it('planRollback stamps the record-first effective route onto each item', () => {
    const [item] = planRollback([createOp('sdk')], recordWith('cc-api'));
    expect(item!.effectiveProvisionedBy).toBe('cc-api');
  });

  it('planFailedOps stamps the record-first effective route onto each item', () => {
    const failed: FailedOperation = {
      logicalId: 'Res',
      changeType: 'CREATE',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'phys-res',
      provisionedBy: 'sdk',
    };
    const [item] = planFailedOps([failed], recordWith('cc-api'));
    expect(item!.effectiveProvisionedBy).toBe('cc-api');
  });

  it('falls back to the journaled route when the record carries none (legacy state)', () => {
    const state = { Res: res({ physicalId: 'phys-res', resourceType: 'AWS::S3::Bucket' }) };
    expect(planRollback([createOp('cc-api')], state)[0]!.effectiveProvisionedBy).toBe('cc-api');
  });
});

/**
 * The FAILED half of the same field (#1366). A Snapshot refusal is the most
 * likely rollback failure for this feature, and its event carried the
 * journaled route too.
 */
describe('ROLLBACK_RESOURCE_FAILED route reporting (#1366)', () => {
  it('a refused Snapshot delete reports the route the delete WOULD have taken', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx, events } = makeCtx({ delete: del });
    // Journal says sdk (which would NOT be refused); the record says cc-api,
    // which is both why it is refused and what the event must name.
    const state: Record<string, ResourceState> = {
      Res: res({
        physicalId: 'phys-res',
        resourceType: 'AWS::RDS::DBInstance',
        deletionPolicy: 'Snapshot',
        provisionedBy: 'cc-api',
      }),
    };
    const result = await replayRollback(
      [
        {
          logicalId: 'Res',
          changeType: 'CREATE',
          resourceType: 'AWS::RDS::DBInstance',
          physicalId: 'phys-res',
          provisionedBy: 'sdk',
        },
      ],
      state,
      'S',
      ctx
    );
    expect(result.failures).toBe(1);
    expect(del).not.toHaveBeenCalled();
    expect(events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED')?.provisionedBy).toBe(
      'cc-api'
    );
  });

  it('a refused --revert-failed Snapshot delete reports it too', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx, events } = makeCtx({ delete: del });
    const state: Record<string, ResourceState> = {
      Res: res({
        physicalId: 'phys-res',
        resourceType: 'AWS::RDS::DBInstance',
        deletionPolicy: 'Snapshot',
        provisionedBy: 'cc-api',
      }),
    };
    const result = await replayFailedOperations(
      [
        {
          logicalId: 'Res',
          changeType: 'CREATE',
          resourceType: 'AWS::RDS::DBInstance',
          physicalId: 'phys-res',
          provisionedBy: 'sdk',
        },
      ],
      state,
      'S',
      ctx
    );
    expect(result.failures).toBe(1);
    expect(events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED')?.provisionedBy).toBe(
      'cc-api'
    );
  });

  it('the --orphan CREATE arm reports the record route too (parity with orphan-retain)', async () => {
    // Its own comment promises the two orphan triggers emit the SAME event,
    // so they must resolve `provisionedBy` the same way.
    const { ctx, events } = makeCtx({ delete: vi.fn() });
    const state: Record<string, ResourceState> = {
      Res: res({ physicalId: 'phys-res', resourceType: 'AWS::S3::Bucket', provisionedBy: 'cc-api' }),
    };
    await replayRollback(
      [
        {
          logicalId: 'Res',
          changeType: 'CREATE',
          resourceType: 'AWS::S3::Bucket',
          physicalId: 'phys-res',
          provisionedBy: 'sdk',
        },
      ],
      state,
      'S',
      ctx,
      { orphanLogicalIds: new Set(['Res']) }
    );
    expect(state['Res']).toBeUndefined();
    expect(events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED')?.provisionedBy).toBe(
      'cc-api'
    );
  });

  it('an UPDATE-arm failure keeps the journaled route (that arm resolves its own routing)', async () => {
    const update = vi.fn().mockRejectedValue(new Error('boom'));
    const { ctx, events } = makeCtx({ update });
    const prev = res({ physicalId: 'phys-res', properties: { a: 1 } });
    // The record must DISAGREE with the journal, else the assertion below
    // holds under record-first resolution too and pins nothing.
    const state = {
      Res: res({ physicalId: 'phys-res', properties: { a: 2 }, provisionedBy: 'cc-api' }),
    };
    await replayRollback(
      [
        {
          logicalId: 'Res',
          changeType: 'UPDATE',
          resourceType: 'AWS::S3::Bucket',
          physicalId: 'phys-res',
          provisionedBy: 'sdk',
          previousState: prev,
        },
      ],
      state,
      'S',
      ctx
    );
    expect(events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED')?.provisionedBy).toBe(
      'sdk'
    );
  });
});
