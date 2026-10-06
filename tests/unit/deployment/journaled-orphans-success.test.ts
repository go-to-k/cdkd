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
  attemptedProperties: {},
  ...extra,
});

function setup(journal: unknown) {
  const provider = { delete: vi.fn().mockResolvedValue(undefined) };
  const stateBackend = {
    loadRollbackJournal: vi.fn(async () => structuredClone(journal)),
    reduceRollbackJournalToFailedOperations: vi.fn().mockResolvedValue(1),
    markRollbackJournalSuperseded: vi.fn().mockResolvedValue(undefined),
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
  it('an interrupted deploy deletes nothing and keeps the entry', async () => {
    const t = setup(journalOf(failedSeg([orphan()])));

    const left = await settleJournaledOrphansOnSuccess({
      stateBackend: t.stateBackend as never,
      stackName: 'S',
      region: REGION,
      stateResources: {},
      rollbackOrphans: undefined,
      newerOperations: [],
      foreignHolder: async () => undefined,
      ctx: t.ctx,
      isInterrupted: () => true,
      logger: t.logger as never,
    });

    expect(t.provider.delete).not.toHaveBeenCalled();
    expect(left).toBe(1);
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
    expect(left).toBe(1);
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

    expect(left).toBe(1);
    const [, , keep, , demote] = t.stateBackend.reduceRollbackJournalToFailedOperations.mock.calls[0]!;
    const seg = failedSeg([orphan()]);
    expect(keep(orphan(), seg)).toBe(true);
    expect(demote(orphan(), seg)).toBe(true);
  });

  it("a nested child's pending segment of THIS run counts as physical-id evidence only", async () => {
    const pending = {
      runId: 'run-1',
      timestamp: 2,
      reason: 'nested-pending-parent',
      initialDeploy: false,
      operations: [{ logicalId: 'Orphan', changeType: 'CREATE', resourceType: 'AWS::Kinesis::Stream', physicalId: 'new' }],
    };
    const run = async (deployRunId: string | undefined) => {
      const t = setup(journalOf(failedSeg([orphan()]), pending));
      await settleJournaledOrphansOnSuccess({
        stateBackend: t.stateBackend as never,
        stackName: 'S~Child',
        region: REGION,
        stateResources: {
          Orphan: { physicalId: 'new', resourceType: 'AWS::Kinesis::Stream', properties: {} } as never,
        },
        rollbackOrphans: undefined,
        newerOperations: [],
        deployRunId,
        foreignHolder: async () => undefined,
        ctx: t.ctx,
        logger: t.logger as never,
      });
      return t.provider.delete.mock.calls.filter((c) => c[1] === 'orphan-stream').length;
    };
    expect(await run('run-1')).toBe(1);
    // Another run's pending segment is a real journal entry: the type rule holds.
    expect(await run('run-2')).toBe(0);
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
    const scan = makeForeignHolderScan(stateBackend as never, REGION);
    const ask = scan({ stackName: 'Self', region: REGION });

    expect(await ask('AWS::IAM::Role', 'own')).toBeUndefined();
    expect(await ask('AWS::IAM::Role', 'global-name')).toContain('Self');
    expect(await ask('AWS::IAM::Role', 'global-name')).toContain('eu-west-1');
    expect(await ask('AWS::SQS::Queue', 'global-name')).toBeUndefined();
    expect(stateBackend.listStacks).toHaveBeenCalledTimes(1);
  });

  it('a listing or a record it cannot read answers for every question (fail closed)', async () => {
    const unlisted = makeForeignHolderScan(
      { listStacks: vi.fn().mockRejectedValue(new Error('denied')), getState: vi.fn() } as never,
      REGION
    )({ stackName: 'Self', region: REGION });
    expect(await unlisted('AWS::Kinesis::Stream', 'x')).toBeDefined();

    const malformed = makeForeignHolderScan(
      {
        listStacks: vi.fn().mockResolvedValue([{ stackName: 'Other', region: REGION }]),
        getState: vi.fn().mockResolvedValue({ state: { resources: 'abc' } }),
      } as never,
      REGION
    )({ stackName: 'Self', region: REGION });
    expect(await malformed('AWS::Kinesis::Stream', 'x')).toContain('Other');
  });
});
