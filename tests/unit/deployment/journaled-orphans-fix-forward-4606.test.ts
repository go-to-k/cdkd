import { describe, it, expect, vi } from 'vite-plus/test';
import { settleJournaledOrphansOnSuccess } from '../../../src/deployment/rollback-executor/journaled-orphans.js';
import {
  classifyFailedOp,
  markProvenDistinctFromRecord,
  replayFailedOperations,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import type { ResourceState } from '../../../src/types/state.js';
import { RollbackInlinePolicyWriters } from '../../../src/deployment/inline-policy-claims.js';
import type { ResourceIdentityVerdict } from '../../../src/types/resource.js';
import type { ForeignHolding } from '../../../src/deployment/rollback-executor/journaled-orphans.js';

// go-to-k/cdkd#4606: the fix-forward. A `--no-rollback` deploy failed after
// AWS created `orphan-stream` under `Orphan`; the fixed deploy created
// `orphan-stream-b` under the same logical id and succeeded. The earlier
// stream is deleted only on the provider's live `'different'`.

const REGION = 'us-east-1';
const TYPE = 'AWS::Kinesis::Stream';

const orphan = (extra: Record<string, unknown> = {}) => ({
  logicalId: 'Orphan',
  changeType: 'CREATE',
  resourceType: TYPE,
  physicalId: 'orphan-stream',
  provisionedBy: 'sdk',
  physicalIdRecoveredFromError: true,
  deletionPolicy: 'Delete',
  attemptedProperties: { Name: 'orphan-stream' },
  ...extra,
});

const journal = (ops: unknown[]) => ({
  journalVersion: 1,
  stackName: 'S',
  region: REGION,
  segments: [
    { timestamp: 1, reason: 'no-rollback-failure', initialDeploy: false, operations: [], failedOperations: ops },
  ],
});

/** The fix-forward's record under `Orphan`, and this deploy's CREATE of it. */
const fixForwardRecord = (extra: Record<string, unknown> = {}) => ({
  physicalId: 'orphan-stream-b',
  resourceType: TYPE,
  provisionedBy: 'sdk',
  properties: { Name: 'orphan-stream-b' },
  attributes: { Arn: 'arn:aws:kinesis:us-east-1:123456789012:stream/orphan-stream-b' },
  ...extra,
});
const fixForwardCreate = { logicalId: 'Orphan', changeType: 'CREATE', resourceType: TYPE, physicalId: 'orphan-stream-b' };

interface RunOptions {
  verdict?: ResourceIdentityVerdict | Error | 'absent';
  record?: Record<string, unknown> | undefined;
  newerOperations?: unknown[];
  ops?: unknown[];
  holding?: ForeignHolding;
  deleteFails?: boolean;
  /** Route `cc-api` to a second provider whose read would answer `same`. */
  ccProvider?: boolean;
}

async function run(opts: RunOptions = {}) {
  const verdict = opts.verdict ?? 'different';
  const provider: Record<string, unknown> = {
    delete: vi.fn(async () => {
      if (opts.deleteFails) throw new Error('throttled');
    }),
  };
  const isSameResource = vi.fn(async () => {
    if (verdict instanceof Error) throw verdict;
    return verdict;
  });
  if (verdict !== 'absent') provider['isSameResource'] = isSameResource;
  const stateBackend = {
    loadRollbackJournal: vi.fn(async () => structuredClone(journal(opts.ops ?? [orphan()]))),
    reduceRollbackJournalToFailedOperations: vi.fn().mockResolvedValue(1),
    markRollbackJournalSuperseded: vi.fn().mockResolvedValue(undefined),
    dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(1),
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ccProvider = { delete: vi.fn(), isSameResource: vi.fn(async () => 'same') };
  const getProviderFor = vi.fn((input: { provisionedBy?: string }) =>
    opts.ccProvider === true && input.provisionedBy === 'cc-api'
      ? { provider: ccProvider, provisionedBy: 'cc-api' }
      : { provider, provisionedBy: 'sdk' }
  );
  const ctx = {
    providerRegistry: { getProviderFor, getProvider: vi.fn().mockReturnValue(provider) },
    region: REGION,
    logger,
  } as unknown as RollbackExecutorContext;
  const record = 'record' in opts ? opts.record : fixForwardRecord();
  const stateResources = (record === undefined ? {} : { Orphan: record }) as never;
  const foreignHolder = vi.fn(async () => opts.holding);
  const out = await settleJournaledOrphansOnSuccess({
    stateBackend: stateBackend as never,
    stackName: 'S',
    region: REGION,
    stateResources,
    rollbackOrphans: undefined,
    newerOperations: (opts.newerOperations ?? [fixForwardCreate]) as never,
    foreignHolder,
    ctx,
    logger: logger as never,
  });
  const deletes = (provider['delete'] as ReturnType<typeof vi.fn>).mock.calls;
  const warned = logger.warn.mock.calls.map(([m]) => String(m)).join('\n');
  const debugged = logger.debug.mock.calls.map(([m]) => String(m)).join('\n');
  return {
    out,
    deletes,
    isSameResource,
    foreignHolder,
    warned,
    debugged,
    stateResources,
    getProviderFor,
    stateBackend,
    ccProvider,
  };
}

describe('settleJournaledOrphansOnSuccess: the fix-forward (go-to-k/cdkd#4606)', () => {
  it("deletes the earlier stream on the provider's 'different', leaving the record and its stream", async () => {
    const r = await run();
    expect(r.isSameResource).toHaveBeenCalledWith(
      'orphan-stream',
      { physicalId: 'orphan-stream-b', provisionedBy: 'sdk' },
      TYPE,
      { expectedRegion: REGION }
    );
    // Asked through the route the orphan's delete takes.
    expect(r.getProviderFor).toHaveBeenCalledWith({ resourceType: TYPE, provisionedBy: 'sdk' });
    expect(r.deletes).toHaveLength(1);
    const [logicalId, physicalId, , , context] = r.deletes[0]!;
    expect([logicalId, physicalId]).toEqual(['Orphan', 'orphan-stream']);
    // The record is the fix-forward's: none of it reaches the orphan's delete.
    expect(context).toMatchObject({ failedCreateOrphan: true, deletionPolicy: 'Delete' });
    expect((context as { recordedAttributes?: unknown }).recordedAttributes).toBeUndefined();
    // Still asked about other stacks, as every delete is.
    expect(r.foreignHolder).toHaveBeenCalledWith(TYPE, 'orphan-stream');
    expect(r.out).toEqual({ unaddressed: 0, keepJournal: false, stripCleared: expect.any(Function) });
    expect(r.warned).toBe('');
    // The caller's record is untouched.
    expect(r.stateResources).toEqual({ Orphan: fixForwardRecord() });
  });

  it("'unknown', a provider without the method, a throwing read and an unrecognised answer all keep today's warn-and-skip", async () => {
    for (const verdict of ['unknown', 'absent', new Error('denied'), 'DIFFERENT' as never] as const) {
      const r = await run({ verdict });
      expect(r.deletes, String(verdict)).toHaveLength(0);
      expect(r.warned, String(verdict)).toContain('Skipping failed CREATE of Orphan');
      expect(r.warned, String(verdict)).toContain('orphan-stream');
      expect(r.out, String(verdict)).toMatchObject({ unaddressed: 1, keepJournal: false });
      // Only a read that threw is noted, by its error class (never its text).
      expect(r.debugged.includes('Could not compare'), String(verdict)).toBe(verdict instanceof Error);
      expect(r.debugged, String(verdict)).not.toContain('denied');
    }
  });

  it("'same' settles the entry silently as tracked: nothing deleted, nothing left", async () => {
    const r = await run({ verdict: 'same' });
    expect(r.deletes).toHaveLength(0);
    expect(r.warned).toBe('');
    expect(r.out).toMatchObject({ unaddressed: 0, keepJournal: false });
    expect(r.foreignHolder).not.toHaveBeenCalled();
  });

  it('a record under the very same name is tracked without asking (name reuse never deletes it)', async () => {
    const r = await run({
      record: fixForwardRecord({ physicalId: 'orphan-stream' }),
      newerOperations: [{ ...fixForwardCreate, physicalId: 'orphan-stream' }],
    });
    expect(r.isSameResource).not.toHaveBeenCalled();
    expect(r.deletes).toHaveLength(0);
    expect(r.out).toMatchObject({ unaddressed: 0, keepJournal: false });
  });

  it('a record of another type is never compared', async () => {
    const r = await run({ record: fixForwardRecord({ resourceType: 'AWS::SQS::Queue' }) });
    expect(r.isSameResource).not.toHaveBeenCalled();
    expect(r.deletes).toHaveLength(0);
    expect(r.out).toMatchObject({ unaddressed: 1 });
  });

  it('a malformed record under the id is never compared', async () => {
    for (const record of [{ resourceType: TYPE }, { resourceType: TYPE, physicalId: '' }]) {
      const r = await run({ record });
      expect(r.isSameResource).not.toHaveBeenCalled();
      expect(r.deletes).toHaveLength(0);
      expect(r.out).toMatchObject({ unaddressed: 1 });
    }
  });

  it('an op of this deploy under the id with no record left is not compared (nothing to compare with)', async () => {
    const r = await run({
      record: undefined,
      newerOperations: [{ logicalId: 'Orphan', changeType: 'DELETE', resourceType: TYPE, physicalId: 'x' }],
    });
    expect(r.isSameResource).not.toHaveBeenCalled();
    expect(r.deletes).toHaveLength(0);
    expect(r.out).toMatchObject({ unaddressed: 1 });
  });

  it("'different' still yields to another stack holding the stream", async () => {
    const r = await run({ holding: { kind: 'held', by: 'stack X' } });
    expect(r.deletes).toHaveLength(0);
    expect(r.out).toMatchObject({ unaddressed: 1, keepJournal: false });
  });

  it("a failed delete after 'different' keeps the entry for the next deploy, which asks again", async () => {
    const r = await run({ deleteFails: true });
    expect(r.deletes).toHaveLength(1);
    expect(r.out).toMatchObject({ unaddressed: 1, keepJournal: true });
    // Written back as a PROVEN orphan (keep, not demote): the verdict is not
    // journaled, so the next deploy reads the record live again.
    const [, , keep, , demote] = r.stateBackend.reduceRollbackJournalToFailedOperations.mock.calls[0]!;
    const seg = journal([]).segments[0]!;
    expect(keep(orphan(), seg)).toBe(true);
    expect(demote(orphan(), seg)).toBe(false);
  });

  it('a DeletionPolicy: Retain orphan proven different is kept in AWS, the record left alone', async () => {
    const r = await run({ ops: [orphan({ deletionPolicy: 'Retain' })] });
    expect(r.deletes).toHaveLength(0);
    expect(r.out).toMatchObject({ unaddressed: 0, keepJournal: false });
    expect(r.stateResources).toEqual({ Orphan: fixForwardRecord() });
  });
});

describe('the replay of an orphan proven distinct from the record under its id (go-to-k/cdkd#4606)', () => {
  const record = (): ResourceState => fixForwardRecord() as unknown as ResourceState;
  const op = (extra: Record<string, unknown> = {}): FailedOperation => orphan(extra) as unknown as FailedOperation;
  function replayCtx(provider: Record<string, unknown>): RollbackExecutorContext {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    return {
      region: REGION,
      logger,
      providerRegistry: {
        getProviderFor: vi.fn(() => ({ provider, provisionedBy: 'sdk' })),
        getProvider: () => provider,
      },
    } as unknown as RollbackExecutorContext;
  }

  it('classifies a delete only against the very record the verdict was read for', () => {
    const marked = op();
    const held = record();
    expect(classifyFailedOp(marked, { Orphan: held })).toBe('skip-failed-mismatch');
    markProvenDistinctFromRecord(marked, held);
    expect(classifyFailedOp(marked, { Orphan: held })).toBe('delete-failed-create');
    // A record that moved since carries no proof.
    expect(classifyFailedOp(marked, { Orphan: { ...held, physicalId: 'orphan-stream-c' } })).toBe(
      'skip-failed-mismatch'
    );
    expect(classifyFailedOp(marked, { Orphan: { ...held, resourceType: 'AWS::SQS::Queue' } })).toBe(
      'skip-failed-mismatch'
    );
    // The verdict belongs to the op object: a re-read of the entry has none.
    expect(classifyFailedOp(op(), { Orphan: held })).toBe('skip-failed-mismatch');
  });

  it('deletes the orphan without reading, dropping or orphaning the record', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const held = record();
    const state: Record<string, ResourceState> = { Orphan: held };
    const marked = op();
    markProvenDistinctFromRecord(marked, held);
    const result = await replayFailedOperations([marked], state, 'S', replayCtx({ delete: del }), {});
    expect(del).toHaveBeenCalledOnce();
    expect(del.mock.calls[0]![1]).toBe('orphan-stream');
    expect((del.mock.calls[0]![4] as { recordedAttributes?: unknown }).recordedAttributes).toBeUndefined();
    expect(state['Orphan']).toBe(held);
    expect(result.remainingFailedOps).toEqual([]);
  });

  it('keeps a Retain orphan in AWS without dropping or orphaning the record', async () => {
    const del = vi.fn();
    const held = record();
    const state: Record<string, ResourceState> = { Orphan: held };
    const marked = op({ deletionPolicy: 'Retain' });
    markProvenDistinctFromRecord(marked, held);
    const onOrphan = vi.fn();
    const result = await replayFailedOperations([marked], state, 'S', replayCtx({ delete: del }), {
      onOrphan,
    });
    expect(del).not.toHaveBeenCalled();
    expect(state['Orphan']).toBe(held);
    expect(result.orphaned).toEqual([]);
    expect(onOrphan).not.toHaveBeenCalled();
  });
});

describe('a settled proven-distinct orphan settles its logical id for the inline-policy put-back (go-to-k/cdkd#4606)', () => {
  const ROLE = 'AWS::IAM::Role';
  const role: ResourceState = {
    physicalId: 'role-b',
    resourceType: ROLE,
    properties: { Policies: [{ PolicyName: 'n', PolicyDocument: 'd' }] },
    attributes: {},
    dependencies: [],
  };

  it.each([
    ['deleted', undefined],
    ['kept under Retain', 'Retain'],
  ] as const)('leaves the record under its id no unsettled holder once the orphan is %s', async (_l, policy) => {
    const writers = new RollbackInlinePolicyWriters();
    const provider = { delete: vi.fn().mockResolvedValue(undefined) };
    const ctx = {
      region: REGION,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      providerRegistry: {
        getProviderFor: vi.fn(() => ({ provider, provisionedBy: 'sdk' })),
        getProvider: () => provider,
      },
    } as unknown as RollbackExecutorContext;
    const state: Record<string, ResourceState> = { R: role };
    const op = orphan({
      logicalId: 'R',
      resourceType: ROLE,
      physicalId: 'role-a',
      ...(policy && { deletionPolicy: policy }),
    }) as unknown as FailedOperation;
    markProvenDistinctFromRecord(op, role);
    await replayFailedOperations([op], state, 'Stack', ctx, { inlinePolicyWriters: writers });
    // Another revert of this rollback removes `n` from role-b, which R holds.
    writers.claimedFor('AWS::IAM::Policy', 'Remover', {})!('role', 'role-b', 'n');
    const [held] = writers.takeHeldRemovals(state);
    expect(held?.holders.map((h) => h.logicalId)).toEqual(['R']);
    expect(held?.unsettled).toEqual([]);
  });
});

describe('settleJournaledOrphansOnSuccess: who is asked (go-to-k/cdkd#4606)', () => {
  it("a #4604 replaced record under the id is never compared, even with this deploy's op there", async () => {
    // The record is the resource the failed replacement was replacing; this
    // deploy then completed an op under the id. Nothing proves the orphan is
    // not what that op made, so it is warned about, never asked or deleted.
    const r = await run({
      ops: [orphan({ replacedPhysicalId: 'orphan-stream-old', replacedResourceType: TYPE })],
      record: fixForwardRecord({ physicalId: 'orphan-stream-old' }),
      newerOperations: [{ ...fixForwardCreate, changeType: 'UPDATE', physicalId: 'orphan-stream-old' }],
    });
    expect(r.isSameResource).not.toHaveBeenCalled();
    expect(r.deletes).toHaveLength(0);
    expect(r.out).toMatchObject({ unaddressed: 1 });
  });

  it("asks the provider the ORPHAN's delete routes to, not the record's", async () => {
    const r = await run({ ccProvider: true, record: fixForwardRecord({ provisionedBy: 'cc-api' }) });
    expect(r.isSameResource).toHaveBeenCalledOnce();
    expect(r.ccProvider.isSameResource).not.toHaveBeenCalled();
    expect(r.deletes).toHaveLength(1);
  });
});
