/**
 * go-to-k/cdkd#4612: the failed-CREATE delete arm's `resolveAttemptedProperties`
 * re-resolves the journal's redacted attempted bag through the replay's
 * `resolveReplayProps` (here a stand-in that resolves every reference), so a
 * provider comparing it with AWS sees the RESOLVED document; and the success
 * settle counts a kept entry and a part-left one together. Plus the
 * `deleteLeftInPlace` reader's guards.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ tag: 'process-global' }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const resolveReplayProps = vi.hoisted(() =>
  vi.fn(async (props: unknown) =>
    props === undefined
      ? undefined
      : (JSON.parse(
          JSON.stringify(props).replace(/\{\{resolve:[^}]*\}\}/g, 'RESOLVED-SECRET')
        ) as Record<string, unknown>)
  )
);
vi.mock('../../../src/deployment/rollback-executor/replay-props.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/deployment/rollback-executor/replay-props.js')>();
  return { ...actual, resolveReplayProps };
});

import {
  replayFailedOperations,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { settleJournaledOrphansOnSuccess } from '../../../src/deployment/rollback-executor/journaled-orphans.js';
import { deleteLeftInPlace } from '../../../src/deployment/delete-outcome.js';

const TYPE = 'AWS::SQS::QueuePolicy';

function ctxWith(del: ReturnType<typeof vi.fn>): RollbackExecutorContext {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), setLevel: vi.fn(), child: () => logger };
  return {
    region: 'us-east-1',
    logger,
    providerRegistry: { getProviderFor: () => ({ provider: { delete: del }, provisionedBy: 'sdk' }) },
  } as unknown as RollbackExecutorContext;
}

const op = (extra: Partial<FailedOperation> = {}): FailedOperation => ({
  logicalId: 'Failed',
  changeType: 'CREATE',
  resourceType: TYPE,
  provisionedBy: 'sdk',
  physicalId: 'q1,q2',
  physicalIdRecoveredFromError: true,
  attemptedProperties: {
    Queues: ['q1', 'q2'],
    PolicyDocument: { Statement: [{ Sid: '{{resolve:secretsmanager:s:SecretString:sid}}' }] },
  },
  ...extra,
});

describe('the orphan delete re-resolves the redacted attempted bag (go-to-k/cdkd#4612)', () => {
  it('hands the provider a resolver returning the RESOLVED bag, never the redacted one', async () => {
    let seen: unknown;
    const del = vi.fn(async (_l: string, _p: string, _t: string, props: unknown, context: { resolveAttemptedProperties?: () => Promise<unknown> }) => {
      expect(props).toEqual(op().attemptedProperties);
      seen = await context.resolveAttemptedProperties!();
    });
    await replayFailedOperations([op()], {}, 'S', ctxWith(del));
    expect(del).toHaveBeenCalledOnce();
    expect(seen).toEqual({
      Queues: ['q1', 'q2'],
      PolicyDocument: { Statement: [{ Sid: 'RESOLVED-SECRET' }] },
    });
    expect(resolveReplayProps).toHaveBeenCalledWith(op().attemptedProperties, expect.anything(), expect.anything(), expect.anything(), 'Failed');
  });
});

describe('the success settle counts kept and part-left entries together (go-to-k/cdkd#4612)', () => {
  it('one delete failing (kept) plus one leaving part in place is two unaddressed', async () => {
    const del = vi.fn(async (logicalId: string) => {
      if (logicalId === 'Kept') throw new Error('throttled');
      return { outcome: 'deleted', leftInPlace: 'a queue was not cleared' };
    });
    const ctx = ctxWith(del);
    const out = await settleJournaledOrphansOnSuccess({
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
              failedOperations: [op({ logicalId: 'Kept', physicalId: 'q8' }), op({ logicalId: 'Left', physicalId: 'q9' })],
            },
          ],
        })),
        reduceRollbackJournalToFailedOperations: vi.fn().mockResolvedValue(1),
        markRollbackJournalSuperseded: vi.fn().mockResolvedValue(undefined),
        dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(1),
      } as never,
      stackName: 'S',
      region: 'us-east-1',
      stateResources: {},
      rollbackOrphans: undefined,
      newerOperations: [],
      foreignHolder: async () => undefined,
      ctx,
      logger: ctx.logger as never,
    });
    expect(del).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ unaddressed: 2, keepJournal: true });
  });
});

describe('deleteLeftInPlace (go-to-k/cdkd#4612)', () => {
  it.each([
    ['void', undefined, undefined],
    ['a plain delete', { outcome: 'deleted' }, undefined],
    ['an empty line', { outcome: 'deleted', leftInPlace: '' }, undefined],
    ['a skipped delete', { outcome: 'skipped', reason: 'r' }, undefined],
    ['a skipped delete carrying a stray leftInPlace', { outcome: 'skipped', reason: 'r', leftInPlace: 'x' }, undefined],
    ['a left part', { outcome: 'deleted', leftInPlace: 'a queue was not cleared' }, 'a queue was not cleared'],
  ])('%s', (_what, result, expected) => {
    expect(deleteLeftInPlace(result as never)).toBe(expected);
  });
});
