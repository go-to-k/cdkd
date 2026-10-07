import { describe, it, expect, vi } from 'vite-plus/test';
import {
  makeForeignHolderScan,
  settleJournaledOrphansOnSuccess,
} from '../../../src/deployment/rollback-executor/journaled-orphans.js';
import type { RollbackExecutorContext } from '../../../src/deployment/rollback-executor.js';

// go-to-k/cdkd#4600: the success-path settle's fail-closed arms, driven
// directly (the engine cases live in deploy-engine-rollback-journal.test.ts).

const REGION = 'us-east-1';

const orphan = (extra: Record<string, unknown> = {}) => ({
  logicalId: 'Orphan',
  changeType: 'CREATE',
  resourceType: 'AWS::Kinesis::Stream',
  physicalId: 'orphan-stream',
  provisionedBy: 'sdk',
  physicalIdRecoveredFromError: true,
  // go-to-k/cdkd#4655: the live read below answers the same token.
  createdResourceIdentity: 'created-token',
  attemptedProperties: {},
  ...extra,
});

function setup(journal: unknown) {
  const provider = {
    delete: vi.fn().mockResolvedValue(undefined),
    resourceIdentity: vi.fn().mockResolvedValue('created-token'),
  };
  const stateBackend = {
    loadRollbackJournal: vi.fn(async () => structuredClone(journal)),
    reduceRollbackJournalToFailedOperations: vi.fn().mockResolvedValue(1),
    markRollbackJournalSuperseded: vi.fn().mockResolvedValue(undefined),
    dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(1),
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx = {
    providerRegistry: {
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getProvider: vi.fn().mockReturnValue(provider),
    },
    region: REGION,
    logger,
  } as unknown as RollbackExecutorContext;
  return { provider, stateBackend, logger, ctx };
}

const journalOf = (...segments: unknown[]) => ({ journalVersion: 1, stackName: 'S', region: REGION, segments });
const failedSeg = (ops: unknown[], extra: Record<string, unknown> = {}) => ({
  timestamp: 1,
  reason: 'no-rollback-failure',
  initialDeploy: false,
  operations: [],
  failedOperations: ops,
  ...extra,
});

describe('settleJournaledOrphansOnSuccess (go-to-k/cdkd#4600)', () => {
  it('an interrupted deploy deletes nothing, asks the scan nothing, and keeps the entry', async () => {
    const t = setup(journalOf(failedSeg([orphan()])));
    const foreignHolder = vi.fn(async () => undefined);

    const left = await settleJournaledOrphansOnSuccess({
      stateBackend: t.stateBackend as never,
      stackName: 'S',
      region: REGION,
      stateResources: {},
      rollbackOrphans: undefined,
      newerOperations: [],
      foreignHolder,
      ctx: t.ctx,
      isInterrupted: () => true,
      logger: t.logger as never,
    });

    expect(t.provider.delete).not.toHaveBeenCalled();
    expect(foreignHolder).not.toHaveBeenCalled();
    expect(left).toEqual({ unaddressed: 1, keepJournal: true });
    expect(t.stateBackend.reduceRollbackJournalToFailedOperations).toHaveBeenCalledTimes(1);
  });

  it('a throw while acting on the orphans fails closed: kept and counted', async () => {
    const t = setup(journalOf(failedSeg([orphan()])));
    const throwing = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('boom');
        },
      }
    );

    const left = await settleJournaledOrphansOnSuccess({
      stateBackend: t.stateBackend as never,
      stackName: 'S',
      region: REGION,
      stateResources: throwing as never,
      rollbackOrphans: undefined,
      newerOperations: [],
      foreignHolder: async () => undefined,
      ctx: t.ctx,
      logger: t.logger as never,
    });

    expect(t.provider.delete).not.toHaveBeenCalled();
    expect(left).toEqual({ unaddressed: 1, keepJournal: true });
    expect(t.stateBackend.reduceRollbackJournalToFailedOperations).toHaveBeenCalledTimes(1);
  });

  it('a kept entry the supersede pass demoted is written back demoted (its evidence is dropped)', async () => {
    const t = setup(
      journalOf(
        failedSeg([orphan()]),
        // A newer segment's completed CREATE of the type demotes it.
        {
          timestamp: 2,
          reason: 'no-rollback-failure',
          initialDeploy: false,
          operations: [{ logicalId: 'Other', changeType: 'CREATE', resourceType: 'AWS::Kinesis::Stream', physicalId: 'x' }],
        }
      )
    );

    const left = await settleJournaledOrphansOnSuccess({
      stateBackend: t.stateBackend as never,
      stackName: 'S',
      region: REGION,
      // Unreadable record: nothing is acted on, every entry is kept.
      stateResources: undefined,
      rollbackOrphans: undefined,
      newerOperations: [],
      foreignHolder: async () => undefined,
      ctx: t.ctx,
      logger: t.logger as never,
    });

    expect(left).toEqual({ unaddressed: 1, keepJournal: true });
    const [, , keep, , demote] = t.stateBackend.reduceRollbackJournalToFailedOperations.mock.calls[0]!;
    const seg = failedSeg([orphan()]);
    expect(keep(orphan(), seg)).toBe(true);
    expect(demote(orphan(), seg)).toBe(true);
  });

  it("a nested child's pending segment of THIS run counts as physical-id evidence only", async () => {
    // This run CREATEd another stream of the type: its record is in state.
    const pending = {
      runId: 'run-1',
      timestamp: 2,
      reason: 'nested-pending-parent',
      initialDeploy: false,
      operations: [{ logicalId: 'Other', changeType: 'CREATE', resourceType: 'AWS::Kinesis::Stream', physicalId: 'new' }],
    };
    const run = async (deployRunId: string | undefined) => {
      const t = setup(journalOf(failedSeg([orphan()]), pending));
      const out = await settleJournaledOrphansOnSuccess({
        stateBackend: t.stateBackend as never,
        stackName: 'S~Child',
        region: REGION,
        stateResources: {
          Other: { physicalId: 'new', resourceType: 'AWS::Kinesis::Stream', properties: {} } as never,
        },
        rollbackOrphans: undefined,
        newerOperations: [],
        deployRunId,
        foreignHolder: async () => undefined,
        ctx: t.ctx,
        logger: t.logger as never,
      });
      return {
        deletes: t.provider.delete.mock.calls.filter((c) => c[1] === 'orphan-stream').length,
        out: { unaddressed: out.unaddressed, keepJournal: out.keepJournal },
      };
    };
    expect(await run('run-1')).toEqual({ deletes: 1, out: { unaddressed: 0, keepJournal: false } });
    // Another run's pending segment is a real journal entry: the type rule holds.
    expect(await run('run-2')).toEqual({ deletes: 0, out: { unaddressed: 1, keepJournal: false } });
  });

  it("this run's pending segment holding an op under the orphan's own logical id demotes it", async () => {
    const t = setup(
      journalOf(failedSeg([orphan()]), {
        runId: 'run-1',
        timestamp: 2,
        reason: 'nested-pending-parent',
        initialDeploy: false,
        operations: [{ logicalId: 'Orphan', changeType: 'DELETE', resourceType: 'AWS::Kinesis::Stream', physicalId: 'gone' }],
      })
    );
    const out = await settleJournaledOrphansOnSuccess({
      stateBackend: t.stateBackend as never,
      stackName: 'S~Child',
      region: REGION,
      stateResources: {},
      rollbackOrphans: undefined,
      newerOperations: [],
      deployRunId: 'run-1',
      foreignHolder: async () => undefined,
      ctx: t.ctx,
      logger: t.logger as never,
    });
    expect(t.provider.delete).not.toHaveBeenCalled();
    expect(out).toMatchObject({ unaddressed: 1, keepJournal: false });
  });

  it('a foreign holder demotes and clears; an unreadable scan keeps; no holder deletes', async () => {
    const run = async (holding: Awaited<ReturnType<Parameters<typeof settleJournaledOrphansOnSuccess>[0]['foreignHolder']>>) => {
      const t = setup(journalOf(failedSeg([orphan()])));
      const out = await settleJournaledOrphansOnSuccess({
        stateBackend: t.stateBackend as never,
        stackName: 'S',
        region: REGION,
        stateResources: {},
        rollbackOrphans: undefined,
        newerOperations: [],
        foreignHolder: async () => holding,
        ctx: t.ctx,
        logger: t.logger as never,
      });
      return {
        deletes: t.provider.delete.mock.calls.length,
        out: { unaddressed: out.unaddressed, keepJournal: out.keepJournal },
        reduced: t.stateBackend.reduceRollbackJournalToFailedOperations.mock.calls.length,
      };
    };
    expect(await run({ kind: 'held', by: 'stack X' })).toEqual({
      deletes: 0,
      out: { unaddressed: 1, keepJournal: false },
      reduced: 0,
    });
    expect(await run({ kind: 'unreadable', what: 'stack Y' })).toEqual({
      deletes: 0,
      out: { unaddressed: 1, keepJournal: true },
      reduced: 1,
    });
    expect(await run(undefined)).toEqual({ deletes: 1, out: { unaddressed: 0, keepJournal: false }, reduced: 0 });
  });
});

describe('makeForeignHolderScan (go-to-k/cdkd#4600)', () => {
  it('names another record holding the type and id, never the asking stack itself, and scans once', async () => {
    const stateBackend = {
      listStacks: vi.fn().mockResolvedValue([
        { stackName: 'Self', region: REGION },
        { stackName: 'Self', region: 'eu-west-1' },
      ]),
      getState: vi.fn(async (name: string, region: string) => ({
        state: {
          resources: {
            R: { resourceType: 'AWS::IAM::Role', physicalId: region === REGION ? 'own' : 'global-name' },
          },
        },
        name,
      })),
    };
    const scan = makeForeignHolderScan(stateBackend as never);
    const ask = scan({ stackName: 'Self', region: REGION });

    expect(await ask('AWS::IAM::Role', 'own')).toBeUndefined();
    const held = await ask('AWS::IAM::Role', 'global-name');
    expect(held?.kind).toBe('held');
    expect(held && held.kind === 'held' ? held.by : '').toContain('Self');
    expect(held && held.kind === 'held' ? held.by : '').toContain('eu-west-1');
    expect(await ask('AWS::SQS::Queue', 'global-name')).toBeUndefined();
    expect(stateBackend.listStacks).toHaveBeenCalledTimes(1);
  });

  it("counts another record's rollback-orphan records as holders", async () => {
    const ask = makeForeignHolderScan({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'Other', region: REGION }]),
      getState: vi.fn().mockResolvedValue({
        state: {
          resources: {},
          orphans: [
            {
              logicalId: 'Kept',
              orphanedAt: 1,
              state: { physicalId: 'x', resourceType: 'AWS::Kinesis::Stream', properties: {}, attributes: {} },
            },
          ],
        },
      }),
    } as never)({ stackName: 'Self', region: REGION });
    expect((await ask('AWS::Kinesis::Stream', 'x'))?.kind).toBe('held');
    expect(await ask('AWS::Kinesis::Stream', 'y')).toBeUndefined();
  });

  it.each([
    ['a non-list orphans container', { resources: {}, orphans: 'abc' }],
    ['an unreadable orphans row', { resources: {}, orphans: [{ logicalId: 'Bad' }] }],
  ])('%s makes every answer unreadable', async (_what, state) => {
    const ask = makeForeignHolderScan({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'Other', region: REGION }]),
      getState: vi.fn().mockResolvedValue({ state }),
    } as never)({ stackName: 'Self', region: REGION });
    expect((await ask('AWS::Kinesis::Stream', 'z'))?.kind).toBe('unreadable');
  });

  it('a legacy key with no readable region makes every answer unreadable', async () => {
    const getState = vi.fn();
    const ask = makeForeignHolderScan({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'Legacy' }]),
      getState,
    } as never)({ stackName: 'Self', region: REGION });
    const answer = await ask('AWS::Kinesis::Stream', 'z');
    expect(answer?.kind).toBe('unreadable');
    expect(answer && answer.kind === 'unreadable' ? answer.what : '').toContain('Legacy');
    expect(getState).not.toHaveBeenCalled();
  });

  it('skips a record entry without a string type or physical id', async () => {
    const ask = makeForeignHolderScan(
      {
        listStacks: vi.fn().mockResolvedValue([{ stackName: 'Other', region: REGION }]),
        getState: vi.fn().mockResolvedValue({
          state: {
            resources: {
              NoType: { physicalId: 'x' },
              NumericType: { resourceType: 7, physicalId: 'x' },
              NoId: { resourceType: 'AWS::Kinesis::Stream' },
              Null: null,
            },
          },
        }),
      } as never
    )({ stackName: 'Self', region: REGION });
    expect(await ask('AWS::Kinesis::Stream', 'x')).toBeUndefined();
  });

  it('a listing or a record it cannot read answers for every question (fail closed)', async () => {
    const unlisted = makeForeignHolderScan(
      { listStacks: vi.fn().mockRejectedValue(new Error('denied')), getState: vi.fn() } as never
    )({ stackName: 'Self', region: REGION });
    expect((await unlisted('AWS::Kinesis::Stream', 'x'))?.kind).toBe('unreadable');

    const malformed = makeForeignHolderScan(
      {
        listStacks: vi.fn().mockResolvedValue([{ stackName: 'Other', region: REGION }]),
        getState: vi.fn().mockResolvedValue({ state: { resources: 'abc' } }),
      } as never
    )({ stackName: 'Self', region: REGION });
    const answer = await malformed('AWS::Kinesis::Stream', 'x');
    expect(answer?.kind).toBe('unreadable');
    expect(answer && answer.kind === 'unreadable' ? answer.what : '').toContain('Other');
  });
});
