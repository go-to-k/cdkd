import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import {
  planFailedOps,
  recheckFailedPlan,
  replayFailedOperations,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { recheckMismatchedFailedCreate } from '../../../src/deployment/rollback-executor/plan.js';
import type { ResourceState } from '../../../src/types/state.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';

// go-to-k/cdkd#4754: a fix-forward's settle keeps a journaled failed-CREATE
// orphan it could not finish (a failed delete, an S3 bucket it never empties).
// Its "proven distinct from the record under this id" verdict lives only in
// that settle, so a later `cdkd destroy` / `cdkd rollback` replay classified
// the entry `skip-failed-mismatch` unchecked: "manual attention" for an orphan
// that may be gone, exit 2, and one still there left untracked. The replay of
// an earlier run's journal now asks the settle's question again.

const REGION = 'us-east-1';
const TYPE = 'AWS::Kinesis::Stream';

const orphan = (extra: Record<string, unknown> = {}): FailedOperation =>
  ({
    logicalId: 'Orphan',
    changeType: 'CREATE',
    resourceType: TYPE,
    physicalId: 'orphan-stream',
    provisionedBy: 'sdk',
    physicalIdRecoveredFromError: true,
    deletionPolicy: 'Delete',
    createdResourceIdentity: 'created-token',
    attemptedProperties: { Name: 'orphan-stream' },
    ...extra,
  }) as unknown as FailedOperation;

/** The fix-forward's record under `Orphan`: another stream. */
const fixForwardRecord = (): ResourceState =>
  ({
    physicalId: 'orphan-stream-b',
    resourceType: TYPE,
    provisionedBy: 'sdk',
    properties: { Name: 'orphan-stream-b' },
  }) as unknown as ResourceState;

interface Provider {
  isSameResource?: ReturnType<typeof vi.fn>;
  resourceIdentity?: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function provider(opts: {
  verdict?: 'same' | 'different' | 'unknown' | Error | 'absent' | 'hang';
  identity?: string | typeof RESOURCE_NOT_FOUND;
} = {}): Provider {
  const verdict = opts.verdict ?? 'different';
  return {
    ...(verdict !== 'absent' && {
      isSameResource: vi.fn(() =>
        verdict instanceof Error
          ? Promise.reject(verdict)
          : verdict === 'hang'
            ? new Promise(() => {})
            : Promise.resolve(verdict)
      ),
    }),
    resourceIdentity: vi.fn().mockResolvedValue(opts.identity ?? 'created-token'),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function ctxFor(
  p: Provider,
  opts: { earlierRun?: boolean } = {}
): RollbackExecutorContext & { logger: Record<string, ReturnType<typeof vi.fn>> } {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    region: REGION,
    logger,
    providerRegistry: {
      getProviderFor: vi.fn(() => ({ provider: p, provisionedBy: 'sdk' })),
      getProvider: () => p,
    },
    // A replay of an earlier run's journal (`cdkd destroy` / `cdkd rollback`)
    // supplies the holder scan; the automatic rollback does not.
    ...(opts.earlierRun !== false && { foreignHolder: vi.fn().mockResolvedValue(undefined) }),
  } as unknown as RollbackExecutorContext & {
    logger: Record<string, ReturnType<typeof vi.fn>>;
  };
}

const warned = (ctx: { logger: Record<string, ReturnType<typeof vi.fn>> }): string =>
  ctx.logger['warn']!.mock.calls.map((c) => String(c[0])).join('\n');
const MANUAL = 'which is not the resource state tracks under this id';

describe('replay of a kept fix-forward orphan (go-to-k/cdkd#4754)', () => {
  it("deletes it once the provider proves it another resource and its identity still matches", async () => {
    const p = provider();
    const held = fixForwardRecord();
    const state: Record<string, ResourceState> = { Orphan: held };
    const ctx = ctxFor(p);

    const result = await replayFailedOperations([orphan()], state, 'S', ctx, {});

    expect(p.isSameResource).toHaveBeenCalledWith(
      'orphan-stream',
      { physicalId: 'orphan-stream-b', provisionedBy: 'sdk' },
      TYPE,
      { expectedRegion: REGION }
    );
    expect(p.delete).toHaveBeenCalledOnce();
    expect(p.delete.mock.calls[0]![1]).toBe('orphan-stream');
    // The record is the fix-forward's own: neither read nor dropped.
    expect(state['Orphan']).toBe(held);
    expect(result.remainingFailedOps).toEqual([]);
    expect(result.skipped).toBe(0);
    expect(warned(ctx)).not.toContain(MANUAL);
  });

  it('settles a GONE orphan with no delete, no skip and no "manual attention"', async () => {
    const p = provider({ identity: RESOURCE_NOT_FOUND });
    const state: Record<string, ResourceState> = { Orphan: fixForwardRecord() };
    const ctx = ctxFor(p);

    const result = await replayFailedOperations([orphan()], state, 'S', ctx, {});

    expect(p.delete).not.toHaveBeenCalled();
    expect(result.remainingFailedOps).toEqual([]);
    expect(result.skipped).toBe(0);
    expect(warned(ctx)).not.toContain(MANUAL);
    const info = ctx.logger['info'] as unknown as ReturnType<typeof vi.fn>;
    expect(info.mock.calls.map((c) => String(c[0])).join('\n')).toContain('is already gone');
  });

  it('keeps one whose identity no longer matches (its name reused): no delete', async () => {
    const p = provider({ identity: 'another-token' });
    const state: Record<string, ResourceState> = { Orphan: fixForwardRecord() };
    const ctx = ctxFor(p);

    const result = await replayFailedOperations([orphan()], state, 'S', ctx, {});

    expect(p.delete).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it.each([
    ["'unknown'", 'unknown'],
    ["'same'", 'same'],
    ['a provider without the method', 'absent'],
    ['a throwing read', new Error('Throttling')],
  ] as const)('keeps the unchecked skip on %s', async (_label, verdict) => {
    const p = provider({ verdict });
    const state: Record<string, ResourceState> = { Orphan: fixForwardRecord() };
    const ctx = ctxFor(p);

    const result = await replayFailedOperations([orphan()], state, 'S', ctx, {});

    expect(p.delete).not.toHaveBeenCalled();
    expect(p.resourceIdentity).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(warned(ctx)).toContain(MANUAL);
    // A throw is named by its class only, never its text.
    const debug = (ctx.logger['debug'] as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('Re-check of the kept orphan Orphan failed'));
    expect(debug).toEqual(verdict instanceof Error ? [expect.stringContaining('(Error)')] : []);
    expect(debug.join('')).not.toContain('Throttling');
  });

  it('asks nothing in the automatic rollback (no holder scan, so no identity check either)', async () => {
    const p = provider();
    const state: Record<string, ResourceState> = { Orphan: fixForwardRecord() };
    const ctx = ctxFor(p, { earlierRun: false });

    const result = await replayFailedOperations([orphan()], state, 'S', ctx, {});

    expect(p.isSameResource).not.toHaveBeenCalled();
    expect(p.delete).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });
});

describe('recheckMismatchedFailedCreate (go-to-k/cdkd#4754)', () => {
  const ctx = (p: Provider) => ctxFor(p);

  it('asks nothing for another action, an UPDATE, a demoted orphan or a record of another type', async () => {
    const p = provider();
    const held = fixForwardRecord();
    const state = { Orphan: held };

    await expect(
      recheckMismatchedFailedCreate(orphan(), 'delete-failed-create', state, [], ctx(p))
    ).resolves.toBe('delete-failed-create');
    await expect(
      recheckMismatchedFailedCreate(
        orphan({ changeType: 'UPDATE' }),
        'skip-failed-mismatch',
        state,
        [],
        ctx(p)
      )
    ).resolves.toBe('skip-failed-mismatch');
    await expect(
      recheckMismatchedFailedCreate(
        orphan({ physicalIdRecoveredFromError: false }),
        'skip-failed-mismatch',
        state,
        [],
        ctx(p)
      )
    ).resolves.toBe('skip-failed-mismatch');
    await expect(
      recheckMismatchedFailedCreate(
        orphan(),
        'skip-failed-mismatch',
        { Orphan: { ...held, resourceType: 'AWS::SQS::Queue' } },
        [],
        ctx(p)
      )
    ).resolves.toBe('skip-failed-mismatch');
    expect(p.isSameResource).not.toHaveBeenCalled();
  });

  it('keeps the skip when the read does not answer in time', async () => {
    const p = provider({ verdict: 'hang' });

    await expect(
      recheckMismatchedFailedCreate(
        orphan(),
        'skip-failed-mismatch',
        { Orphan: fixForwardRecord() },
        [],
        ctx(p),
        20
      )
    ).resolves.toBe('skip-failed-mismatch');
  });
});

describe('the `cdkd rollback` preview agrees with the replay (go-to-k/cdkd#4754)', () => {
  it("shows the delete exactly when the replay deletes, and the skip when the re-check fails", async () => {
    for (const [verdict, want] of [
      ['different', 'delete-failed-create'],
      [new Error('AccessDenied'), 'skip-failed-mismatch'],
      ['unknown', 'skip-failed-mismatch'],
    ] as const) {
      const state: Record<string, ResourceState> = { Orphan: fixForwardRecord() };
      const previewOp = orphan();
      const preview = await recheckFailedPlan(
        planFailedOps([previewOp], state),
        state,
        ctxFor(provider({ verdict }))
      );
      expect(preview[0]!.action).toBe(want);

      const p = provider({ verdict });
      const result = await replayFailedOperations([orphan()], state, 'S', ctxFor(p), {});
      expect(p.delete.mock.calls.length > 0).toBe(want === 'delete-failed-create');
      expect(result.skipped).toBe(want === 'delete-failed-create' ? 0 : 1);
    }
  });
});

describe('a re-check that proves the orphan re-classifies it on its own policy (go-to-k/cdkd#4754)', () => {
  it('Retain: left in AWS, the record untouched, nothing orphaned from state', async () => {
    const p = provider();
    const held = fixForwardRecord();
    const state: Record<string, ResourceState> = { Orphan: held };

    const result = await replayFailedOperations(
      [orphan({ deletionPolicy: 'Retain' })],
      state,
      'S',
      ctxFor(p),
      {}
    );

    expect(p.isSameResource).toHaveBeenCalledOnce();
    expect(p.delete).not.toHaveBeenCalled();
    expect(state['Orphan']).toBe(held);
    expect(result.orphaned).toEqual([]);
    expect(result.skipped).toBe(0);
  });

  it('Snapshot on a snapshot-capable type: the final-snapshot delete', async () => {
    const TYPE_RDS = 'AWS::RDS::DBCluster';
    const state: Record<string, ResourceState> = {
      Orphan: { ...fixForwardRecord(), resourceType: TYPE_RDS },
    };
    const plan = await recheckFailedPlan(
      planFailedOps([orphan({ resourceType: TYPE_RDS, deletionPolicy: 'Snapshot' })], state),
      state,
      ctxFor(provider())
    );
    expect(plan[0]!.action).toBe('delete-failed-create-with-final-snapshot');
  });

  it("routes the re-classified item on the op's own route, not the record's", async () => {
    const state: Record<string, ResourceState> = {
      Orphan: { ...fixForwardRecord(), provisionedBy: 'cc-api' },
    };
    const plan = await recheckFailedPlan(planFailedOps([orphan()], state), state, ctxFor(provider()));
    expect(plan[0]!.action).toBe('delete-failed-create');
    expect(plan[0]!.effectiveProvisionedBy).toBe('sdk');
  });
});

describe('the re-check leaves no timer behind (go-to-k/cdkd#4754)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['different', 'unknown'] as const)('after a %s answer', async (verdict) => {
    vi.useFakeTimers();
    await recheckMismatchedFailedCreate(
      orphan(),
      'skip-failed-mismatch',
      { Orphan: fixForwardRecord() },
      [],
      ctxFor(provider({ verdict }))
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the replay never deletes what the preview showed as a skip (go-to-k/cdkd#4754)', () => {
  it('keeps an op the preview could not prove, even when the replay would', async () => {
    const op = orphan();
    const state: Record<string, ResourceState> = { Orphan: fixForwardRecord() };
    const atPreview = provider({ verdict: new Error('Throttling') });
    const preview = await recheckFailedPlan(planFailedOps([op], state), state, ctxFor(atPreview));
    expect(preview[0]!.action).toBe('skip-failed-mismatch');

    const p = provider({ verdict: 'different' });
    const result = await replayFailedOperations([op], state, 'S', ctxFor(p), {});

    expect(p.isSameResource).not.toHaveBeenCalled();
    expect(p.delete).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('carries a proof the preview reached to the replay of the same op, asking once', async () => {
    const op = orphan();
    const state: Record<string, ResourceState> = { Orphan: fixForwardRecord() };
    const p = provider();
    await recheckFailedPlan(planFailedOps([op], state), state, ctxFor(p));
    const result = await replayFailedOperations([op], state, 'S', ctxFor(p), {});

    expect(p.isSameResource).toHaveBeenCalledOnce();
    expect(p.delete).toHaveBeenCalledOnce();
    expect(result.skipped).toBe(0);
  });

  it('a replay with no preview still asks', async () => {
    const op = orphan();
    const state: Record<string, ResourceState> = { Orphan: fixForwardRecord() };
    await recheckMismatchedFailedCreate(op, 'skip-failed-mismatch', state, [], ctxFor(provider({ verdict: 'unknown' })));
    const p = provider();
    await replayFailedOperations([op], state, 'S', ctxFor(p), {});
    expect(p.isSameResource).toHaveBeenCalledOnce();
    expect(p.delete).toHaveBeenCalledOnce();
  });
});
