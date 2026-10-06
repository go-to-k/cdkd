/**
 * go-to-k/cdkd#4612: the failed-CREATE delete arm tells the provider when the
 * resource is a proven orphan (`failedCreateOrphan`), so a policy attachment
 * clears only what still carries its attempted document; a record's own
 * delete never gets the flag.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  replayFailedOperations,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
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

const TYPE = 'AWS::SQS::QueuePolicy';

function ctxWith(del: ReturnType<typeof vi.fn>): RollbackExecutorContext {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => logger,
  };
  return {
    region: 'us-east-1',
    logger,
    providerRegistry: {
      getProviderFor: () => ({ provider: { delete: del }, provisionedBy: 'sdk' }),
    },
  } as unknown as RollbackExecutorContext;
}

const op = (extra: Partial<FailedOperation> = {}): FailedOperation => ({
  logicalId: 'Failed',
  changeType: 'CREATE',
  resourceType: TYPE,
  provisionedBy: 'sdk',
  physicalId: 'q1,q2',
  attemptedProperties: { Queues: ['q1', 'q2', 'q3'], PolicyDocument: {} },
  ...extra,
});

describe('the failed-CREATE delete arm flags a proven orphan (go-to-k/cdkd#4612)', () => {
  it('a proven orphan is deleted with failedCreateOrphan and its attempted bag', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const result = await replayFailedOperations(
      [op({ physicalIdRecoveredFromError: true })],
      {},
      'S',
      ctxWith(del)
    );
    expect(del).toHaveBeenCalledOnce();
    expect(del.mock.calls[0]![1]).toBe('q1,q2');
    expect(del.mock.calls[0]![3]).toEqual(op().attemptedProperties);
    expect(del.mock.calls[0]![4]).toMatchObject({ failedCreateOrphan: true });
    expect(result.remainingFailedOps).toEqual([]);
  });

  it("a failed CREATE whose record state still holds is the record's own delete: no flag", async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const record: ResourceState = {
      physicalId: 'q1',
      resourceType: TYPE,
      properties: {},
      attributes: {},
      dependencies: [],
    };
    await replayFailedOperations([op({ physicalId: 'q1' })], { Failed: record }, 'S', ctxWith(del));
    expect(del).toHaveBeenCalledOnce();
    expect(del.mock.calls[0]![4]).not.toHaveProperty('failedCreateOrphan');
  });

  it('hands the provider a lazy resolver of the redacted attempted bag', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    await replayFailedOperations(
      [op({ physicalIdRecoveredFromError: true, attemptedProperties: { Queues: ['q1'], PolicyDocument: { a: 1 } } })],
      {},
      'S',
      ctxWith(del)
    );
    const resolve = (del.mock.calls[0]![4] as { resolveAttemptedProperties?: () => Promise<unknown> })
      .resolveAttemptedProperties;
    expect(typeof resolve).toBe('function');
    // No reference in the bag: resolution returns it as it is.
    await expect(resolve!()).resolves.toEqual({ Queues: ['q1'], PolicyDocument: { a: 1 } });
  });

  it('a delete that left part in place is handled, warned and counted', async () => {
    const del = vi.fn().mockResolvedValue({ outcome: 'deleted', leftInPlace: 'a queue was not cleared' });
    const ctx = ctxWith(del);
    const proven = op({ physicalIdRecoveredFromError: true });
    const result = await replayFailedOperations([proven], {}, 'S', ctx);
    expect(result).toMatchObject({ failures: 0, warnings: 1 });
    expect(result.leftInPlace).toBe(1);
    expect(result.remainingFailedOps).toEqual([]);
    const warned = (ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('only in part — a queue was not cleared');
  });

  it('control: a plain delete is neither warned nor counted', async () => {
    const del = vi.fn().mockResolvedValue({ outcome: 'deleted' });
    const result = await replayFailedOperations([op({ physicalIdRecoveredFromError: true })], {}, 'S', ctxWith(del));
    expect(result).toMatchObject({ failures: 0, warnings: 0 });
    expect(result.leftInPlace).toBe(0);
  });

  it("a provider's skipped verdict keeps the entry for a re-run", async () => {
    const del = vi.fn().mockResolvedValue({ outcome: 'skipped', reason: 'unread' });
    const result = await replayFailedOperations(
      [op({ physicalIdRecoveredFromError: true })],
      {},
      'S',
      ctxWith(del)
    );
    expect(result.failures).toBe(1);
    expect(result.remainingFailedOps).toHaveLength(1);
  });
});

describe('the success settle counts a delete that left part in place (go-to-k/cdkd#4612)', () => {
  it('as unaddressed, while clearing the entry from the journal', async () => {
    const { settleJournaledOrphansOnSuccess } = await import(
      '../../../src/deployment/rollback-executor/journaled-orphans.js'
    );
    const run = async (verdict: unknown) => {
      const del = vi.fn().mockResolvedValue(verdict);
      const stateBackend = {
        loadRollbackJournal: vi.fn(async () => ({
          journalVersion: 1,
          stackName: 'S',
          region: 'us-east-1',
          segments: [
            {
              timestamp: 1,
              reason: 'no-rollback-failure',
              initialDeploy: false,
              operations: [],
              failedOperations: [op({ physicalIdRecoveredFromError: true })],
            },
          ],
        })),
        reduceRollbackJournalToFailedOperations: vi.fn().mockResolvedValue(1),
        markRollbackJournalSuperseded: vi.fn().mockResolvedValue(undefined),
        dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(1),
      };
      const ctx = ctxWith(del);
      const out = await settleJournaledOrphansOnSuccess({
        stateBackend: stateBackend as never,
        stackName: 'S',
        region: 'us-east-1',
        stateResources: {},
        rollbackOrphans: undefined,
        newerOperations: [],
        foreignHolder: async () => undefined,
        ctx,
        logger: ctx.logger as never,
      });
      return { deletes: del.mock.calls.length, unaddressed: out.unaddressed, keepJournal: out.keepJournal };
    };
    expect(await run({ outcome: 'deleted', leftInPlace: 'a queue was not cleared' })).toEqual({
      deletes: 1,
      unaddressed: 1,
      keepJournal: false,
    });
    expect(await run(undefined)).toEqual({ deletes: 1, unaddressed: 0, keepJournal: false });
  });

  it("hands the delete the final records of what this deploy wrote, and only those", async () => {
    const { settleJournaledOrphansOnSuccess } = await import(
      '../../../src/deployment/rollback-executor/journaled-orphans.js'
    );
    const del = vi.fn().mockResolvedValue(undefined);
    const ctx = ctxWith(del);
    const own = { physicalId: 'q1', resourceType: TYPE, properties: {}, attributes: { 'cdkd:WrittenQueues': 'q1' }, dependencies: [] };
    const untouched = { ...own, physicalId: 'q9' };
    await settleJournaledOrphansOnSuccess({
      stateBackend: {
        loadRollbackJournal: vi.fn(async () => ({
          journalVersion: 1,
          stackName: 'S',
          region: 'us-east-1',
          segments: [
            {
              timestamp: 1,
              reason: 'no-rollback-failure',
              initialDeploy: false,
              operations: [],
              failedOperations: [op({ physicalIdRecoveredFromError: true })],
            },
          ],
        })),
        reduceRollbackJournalToFailedOperations: vi.fn().mockResolvedValue(1),
        markRollbackJournalSuperseded: vi.fn().mockResolvedValue(undefined),
        dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(1),
      } as never,
      stackName: 'S',
      region: 'us-east-1',
      stateResources: { Own: own, Untouched: untouched } as never,
      rollbackOrphans: undefined,
      newerOperations: [{ logicalId: 'Own', changeType: 'CREATE', resourceType: TYPE, physicalId: 'q1' }] as never,
      foreignHolder: async () => undefined,
      ctx,
      logger: ctx.logger as never,
    });
    expect(del).toHaveBeenCalledOnce();
    expect(del.mock.calls[0]![4]).toMatchObject({ failedCreateOrphan: true, writtenThisRun: [own] });
  });

  it('control: a rollback (no settle) hands no writtenThisRun', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    await replayFailedOperations([op({ physicalIdRecoveredFromError: true })], {}, 'S', ctxWith(del));
    expect(del.mock.calls[0]![4]).not.toHaveProperty('writtenThisRun');
  });
});
