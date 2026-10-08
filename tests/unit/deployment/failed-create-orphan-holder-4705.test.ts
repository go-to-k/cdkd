import { describe, it, expect, vi } from 'vite-plus/test';

import {
  replayFailedOperations,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import type { ForeignHolding } from '../../../src/deployment/rollback-executor/journaled-orphans.js';

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

/**
 * go-to-k/cdkd#4705 (review R5-1): the automatic rollback's delete of a
 * proven failed-CREATE orphan asks `createdResourceHolder` first, as its
 * delete of a completed CREATE does; a kept one stays in the journal.
 */

const warned: string[] = [];
const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn((m: string) => warned.push(String(m))),
  error: vi.fn(),
  setLevel: vi.fn(),
  child: () => logger,
} as unknown as RollbackExecutorContext['logger'];

const orphan = (): FailedOperation => ({
  logicalId: 'Queue',
  changeType: 'CREATE',
  resourceType: 'AWS::SQS::Queue',
  physicalId: 'https://sqs.us-east-1.amazonaws.com/123456789012/shared',
  provisionedBy: 'sdk',
  physicalIdRecoveredFromError: true,
  attemptedProperties: {},
});

function ctxWith(
  del: ReturnType<typeof vi.fn>,
  holder?: (type: string, id: string) => Promise<ForeignHolding>
): RollbackExecutorContext {
  return {
    region: 'us-east-1',
    logger,
    providerRegistry: {
      getProviderFor: () => ({ provider: { delete: del }, provisionedBy: 'sdk' }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
    ...(holder !== undefined && { createdResourceHolder: holder }),
  };
}

describe('failed-CREATE orphan under the automatic rollback (go-to-k/cdkd#4705)', () => {
  it('keeps an orphan another record holds: no delete, a warning, a skip, and the journal keeps it', async () => {
    warned.length = 0;
    const del = vi.fn(async () => undefined);
    const holder = vi.fn(async (): Promise<ForeignHolding> => ({
      kind: 'held',
      by: 'the state record of stack App under prefix team-a',
    }));
    const op = orphan();
    const result = await replayFailedOperations([op], {}, 'App', ctxWith(del, holder), {});
    expect(holder).toHaveBeenCalledWith('AWS::SQS::Queue', op.physicalId);
    expect(del).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(result.remainingFailedOps).toEqual([op]);
    expect(warned.filter((l) => l.includes('Keeping created resource Queue'))).toHaveLength(1);
    expect(warned.join('\n')).toContain('team-a');
  });

  it('deletes it when no record holds it', async () => {
    const del = vi.fn(async () => undefined);
    const result = await replayFailedOperations(
      [orphan()],
      {},
      'App',
      ctxWith(
        del,
        vi.fn(async () => undefined)
      ),
      {}
    );
    expect(del).toHaveBeenCalledOnce();
    expect(result.skipped).toBe(0);
    expect(result.remainingFailedOps).toEqual([]);
  });

  it('asks nothing without the field (cdkd rollback, destroy)', async () => {
    const del = vi.fn(async () => undefined);
    await replayFailedOperations([orphan()], {}, 'App', ctxWith(del), {});
    expect(del).toHaveBeenCalledOnce();
  });
});
