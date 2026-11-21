import { describe, it, expect, vi } from 'vite-plus/test';
import {
  planRollback,
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { actionLabel } from '../../../src/cli/commands/rollback/render.js';
import { earlyDeletedOld } from '../../../src/deployment/rollback-executor/early-deleted-old.js';
import type { ResourceState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#6713: a reverse-replacement that re-creates an old resource the
 * failed deploy had ALREADY deleted gets back only its recorded properties —
 * an SQS queue's messages, an SNS topic's out-of-stack subscriptions are gone.
 * CloudFormation never reaches this (it deletes the old copy only after the
 * deploy succeeded), so both the replay and `cdkd rollback`'s plan say so, for
 * every type `STATEFUL_TYPES`' stronger line does not already cover.
 */

const QUEUE = 'AWS::SQS::Queue';
const NOTICE = 'does not come back';

function res(resourceType: string, physicalId: string): ResourceState {
  return {
    physicalId,
    resourceType,
    properties: { QueueName: 'q' },
    attributes: {},
    dependencies: [],
  };
}

function reverseOp(
  resourceType: string,
  extra: Partial<CompletedOperation> = {}
): { ops: CompletedOperation[]; state: Record<string, ResourceState> } {
  return {
    ops: [
      {
        logicalId: 'Target',
        changeType: 'UPDATE',
        resourceType,
        physicalId: 'phys-NEW',
        previousState: res(resourceType, 'phys-OLD'),
        ...extra,
      },
    ],
    state: { Target: res(resourceType, 'phys-NEW') },
  };
}

async function replay(
  resourceType: string,
  extra: Partial<CompletedOperation> = {}
): Promise<{
  warns: string[];
  calls: string[];
  result: Awaited<ReturnType<typeof replayRollback>>;
}> {
  const warns: string[] = [];
  const calls: string[] = [];
  const provider = {
    create: vi.fn(async () => {
      calls.push('create');
      return { physicalId: 'phys-OLD' };
    }),
    delete: vi.fn(async () => {
      calls.push('delete');
    }),
  };
  const logger = {
    debug: () => {},
    info: () => {},
    warn: (m: string) => warns.push(m),
    error: () => {},
    setLevel: vi.fn(),
    child: () => logger,
  } as unknown as RollbackExecutorContext['logger'];
  const ctx: RollbackExecutorContext = {
    region: 'us-east-1',
    logger,
    providerRegistry: {
      getProviderFor: () => ({ provider }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
    recordEvent: () => {},
  };
  const { ops, state } = reverseOp(resourceType, extra);
  const result = await replayRollback(ops, state, 'S', ctx);
  return { warns, calls, result };
}

describe('the rollback says a re-created early-deleted resource comes back empty (#6713)', () => {
  it('a delete-first reversal of a non-stateful type names the order and the loss, advisory only', async () => {
    const { warns, calls, result } = await replay(QUEUE, { oldDeletedBeforeCreate: true });
    // Non-vacuity: the delete-first reversal really ran (new deleted first).
    expect(calls).toEqual(['delete', 'create']);
    const line = warns.find((m) => m.includes(NOTICE));
    expect(line, JSON.stringify(warns)).toBe(
      `  ⚠ Target (${QUEUE}): the deploy deleted the old resource before creating its ` +
        `replacement, so this rollback re-creates it from its recorded properties — anything ` +
        `AWS held for it that the template does not declare (such as queued messages, or ` +
        `subscriptions made outside the stack) does not come back.`
    );
    // Exit code unchanged: the op succeeded.
    expect(result.warnings).toBe(0);
    expect(result.failures).toBe(0);
  });

  it('a create-first reversal whose old delete ran inline names the deploy, not an order', async () => {
    const { warns, calls } = await replay(QUEUE);
    expect(calls).toEqual(['create', 'delete']);
    const line = warns.find((m) => m.includes(NOTICE));
    expect(line).toContain('the deploy deleted the old resource before the deploy succeeded');
  });

  it('a stateful type keeps its own stronger line and gets no second one', async () => {
    const { warns } = await replay('AWS::DynamoDB::Table', { oldDeletedBeforeCreate: true });
    expect(warns.some((m) => m.includes('is a stateful type'))).toBe(true);
    expect(warns.filter((m) => m.includes(NOTICE))).toEqual([]);
  });

  it.each([
    ['an inline policy, whose record restores its document whole', 'AWS::IAM::Policy', {}],
    ['a delete the deploy left for its cleanup phase', QUEUE, { oldResourceMaySurvive: 'deferred' as const }],
    ['a delete the deploy did not confirm', QUEUE, { oldResourceMaySurvive: 'unconfirmed' as const }],
    ['a delete the deploy kept', QUEUE, { oldResourceMaySurvive: 'kept' as const }],
  ])('names no loss for %s', (_label, type, extra) => {
    expect(earlyDeletedOld({ oldDeletedBeforeCreate: true, ...extra }, type)).toBeUndefined();
  });

  describe('the cdkd rollback plan label', () => {
    const label = (extra: Partial<CompletedOperation>, policy?: 'Retain'): string => {
      const { ops, state } = reverseOp(QUEUE, extra);
      if (policy) state['Target'] = { ...state['Target']!, updateReplacePolicy: policy };
      const plan = planRollback(ops, state);
      expect(plan.map((p) => p.action)).toEqual(['reverse-replacement']);
      return actionLabel(plan[0]!, false);
    };

    it('a delete-first reversal names the order and that the contents are not restored', () => {
      expect(label({ oldDeletedBeforeCreate: true })).toBe(
        `  - reverse-replace Target (${QUEUE}) [re-create old resource, delete new — the deploy ` +
          `deleted the old resource before creating its replacement: what AWS held for it ` +
          `beyond its recorded properties is not restored]`
      );
    });

    it('an inline create-first delete says the same without an order', () => {
      expect(label({})).toContain(
        '— the deploy deleted the old resource before the deploy succeeded: what AWS held'
      );
    });

    it('the Retain arm carries it too, inside its bracket', () => {
      expect(label({ oldDeletedBeforeCreate: true }, 'Retain')).toMatch(
        /resource still holds — the deploy deleted the old resource before creating its replacement: .* is not restored\]$/
      );
    });

    it('a delete the deploy left for its cleanup phase keeps its own label', () => {
      expect(label({ oldResourceMaySurvive: 'deferred' })).not.toContain('is not restored');
    });
  });
});
