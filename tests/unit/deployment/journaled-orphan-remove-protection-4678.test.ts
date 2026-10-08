import { describe, it, expect, vi } from 'vite-plus/test';

import {
  replayFailedOperations,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { rollbackExecutorContext } from '../../../src/deployment/deploy-engine/rollback.js';
import { isTerminalDeleteFailure } from '../../../src/provisioning/providers/deletion-protection-compensation.js';
import type { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { StackState } from '../../../src/types/state.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

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
 * go-to-k/cdkd#4678: `cdkd destroy --remove-protection` reaches a journaled
 * failed-CREATE orphan's delete through `RollbackExecutorContext.removeProtection`.
 * A deploy's automatic rollback and its success settle build their context in
 * `rollbackExecutorContext`, which must never carry it.
 */

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setLevel: vi.fn(),
  child: () => logger,
} as unknown as RollbackExecutorContext['logger'];

const orphan = (): FailedOperation => ({
  logicalId: 'OrphanLb',
  changeType: 'CREATE',
  resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
  physicalId: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/o/1',
  provisionedBy: 'sdk',
  physicalIdRecoveredFromError: true,
  attemptedProperties: {
    LoadBalancerAttributes: [{ Key: 'deletion_protection.enabled', Value: 'true' }],
  },
});

function throttle(): Error {
  return Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
}

/** A delete recording its context and whether a throttle there is terminal. */
function recordingDelete() {
  const seen: Array<{ context: Record<string, unknown>; throttleTerminal: boolean }> = [];
  const del = vi.fn(async (...args: unknown[]) => {
    seen.push({
      context: args[4] as Record<string, unknown>,
      throttleTerminal: isTerminalDeleteFailure(throttle()),
    });
  });
  return { del, seen };
}

function ctxWith(
  del: ReturnType<typeof vi.fn>,
  extra: Partial<RollbackExecutorContext> = {}
): RollbackExecutorContext {
  return {
    region: 'us-east-1',
    logger,
    providerRegistry: {
      getProviderFor: () => ({ provider: { delete: del }, provisionedBy: 'sdk' }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
    // `cdkd rollback` and `cdkd destroy` always supply the scan
    // (go-to-k/cdkd#4696); no other stack holds the orphan here.
    foreignHolder: async () => undefined,
    ...extra,
  };
}

describe('failed-CREATE orphan delete under --remove-protection (go-to-k/cdkd#4678)', () => {
  it('forwards removeProtection to the delete, as its single and final attempt', async () => {
    const { del, seen } = recordingDelete();
    const result = await replayFailedOperations(
      [orphan()],
      {},
      'Stack',
      ctxWith(del, { removeProtection: true }),
      {}
    );
    expect(del).toHaveBeenCalledOnce();
    expect(seen[0]!.context['removeProtection']).toBe(true);
    // No outer loop re-enters this delete: a retryable refusal is the last
    // one, so a protection flip is compensated rather than left off.
    expect(seen[0]!.throttleTerminal).toBe(true);
    expect(result.failures).toBe(0);
    expect(result.remainingFailedOps).toEqual([]);
  });

  it('passes no removeProtection, and no attempt scope, without the flag', async () => {
    const { del, seen } = recordingDelete();
    await replayFailedOperations([orphan()], {}, 'Stack', ctxWith(del), {});
    expect(del).toHaveBeenCalledOnce();
    expect(seen[0]!.context).not.toHaveProperty('removeProtection');
    expect(seen[0]!.throttleTerminal).toBe(false);
  });

  it('reads only `true`: a false flag strips nothing', async () => {
    const { del, seen } = recordingDelete();
    await replayFailedOperations(
      [orphan()],
      {},
      'Stack',
      ctxWith(del, { removeProtection: false }),
      {}
    );
    expect(seen[0]!.context).not.toHaveProperty('removeProtection');
  });

  it.each([
    ['without', {}],
    ['with', { removeProtection: true }],
  ])('keeps the op for a re-run when the delete is refused %s the flag', async (_, extra) => {
    const del = vi.fn().mockRejectedValue(
      Object.assign(new Error('Load balancer cannot be deleted: deletion protection is enabled'), {
        name: 'OperationNotPermittedException',
      })
    );
    const op = orphan();
    const result = await replayFailedOperations([op], {}, 'Stack', ctxWith(del, extra), {});
    expect(del).toHaveBeenCalledOnce();
    expect(result.failures).toBe(1);
    expect(result.remainingFailedOps).toEqual([op]);
  });
});

describe('an orphan the delete checks never ran on keeps its protection (go-to-k/cdkd#4678)', () => {
  // No production caller sets `removeProtection` without the scan; the flag
  // still fails closed if one does.
  it('withholds the flag, and warns, without a foreignHolder', async () => {
    const { del, seen } = recordingDelete();
    const warn = vi.fn();
    await replayFailedOperations(
      [orphan()],
      {},
      'Stack',
      ctxWith(del, {
        removeProtection: true,
        foreignHolder: undefined,
        logger: { ...logger, warn } as unknown as RollbackExecutorContext['logger'],
      }),
      {}
    );
    expect(del).toHaveBeenCalledOnce();
    expect(seen[0]!.context).not.toHaveProperty('removeProtection');
    expect(String(warn.mock.calls.map((c) => c[0]))).toContain(
      'leaving deletion protection on partially-created OrphanLb'
    );
  });
  // Nothing to keep on: withheld silently.
  it('withholds it without a warning when the attempt turned no protection on', async () => {
    const { del, seen } = recordingDelete();
    const warn = vi.fn();
    await replayFailedOperations(
      [{ ...orphan(), attemptedProperties: {} }],
      {},
      'Stack',
      ctxWith(del, {
        removeProtection: true,
        foreignHolder: undefined,
        logger: { ...logger, warn } as unknown as RollbackExecutorContext['logger'],
      }),
      {}
    );
    expect(del).toHaveBeenCalledOnce();
    expect(seen[0]!.context).not.toHaveProperty('removeProtection');
    expect(String(warn.mock.calls.map((c) => c[0]))).not.toContain('leaving deletion protection');
  });
});

describe('an orphan another stack holds is kept, protection and all (go-to-k/cdkd#4678, #4696)', () => {
  function heldCtx(del: ReturnType<typeof vi.fn>, holding: unknown) {
    const warn = vi.fn();
    const foreignHolder = vi.fn(async () => holding);
    const ctx = ctxWith(del, {
      removeProtection: true,
      foreignHolder: foreignHolder as unknown as RollbackExecutorContext['foreignHolder'],
      logger: { ...logger, warn } as unknown as RollbackExecutorContext['logger'],
    });
    const warned = (): string => warn.mock.calls.map((c) => String(c[0])).join('\n');
    return { ctx, warned, foreignHolder };
  }

  // E.g. a later `cdkd import` adopted the instance into stack B: destroying A
  // must neither delete it nor strip B's protection.
  it('sends no delete, and warns, when another stack holds it', async () => {
    const { del } = recordingDelete();
    const { ctx, warned, foreignHolder } = heldCtx(del, {
      kind: 'held',
      by: 'the state record of stack B (us-east-1)',
    });
    const result = await replayFailedOperations([orphan()], {}, 'Stack', ctx, {});
    expect(foreignHolder).toHaveBeenCalledWith(orphan().resourceType, orphan().physicalId);
    expect(del).not.toHaveBeenCalled();
    expect(warned()).toContain('Skipping failed CREATE of OrphanLb');
    expect(warned()).toContain('the state record of stack B (us-east-1) holds');
    expect(result.skipped).toBe(1);
  });

  it('sends no delete, and warns, when a record cannot be read', async () => {
    const { del } = recordingDelete();
    const { ctx, warned } = heldCtx(del, { kind: 'unreadable', what: 'the state record of stack C' });
    await replayFailedOperations([orphan()], {}, 'Stack', ctx, {});
    expect(del).not.toHaveBeenCalled();
    expect(warned()).toContain('the state record of stack C leaves open whether');
  });

  it('sends no delete when the scan itself throws', async () => {
    const { del } = recordingDelete();
    const { ctx, foreignHolder } = heldCtx(del, undefined);
    foreignHolder.mockRejectedValue(new Error('boom'));
    await replayFailedOperations([orphan()], {}, 'Stack', ctx, {});
    expect(del).not.toHaveBeenCalled();
  });

  it('passes the flag when no other stack holds it', async () => {
    const { del, seen } = recordingDelete();
    const { ctx, warned } = heldCtx(del, undefined);
    await replayFailedOperations([orphan()], {}, 'Stack', ctx, {});
    expect(seen[0]!.context['removeProtection']).toBe(true);
    expect(warned()).not.toContain('leaving deletion protection');
  });

  // Nothing to keep on: kept without the protection line.
  it('keeps it without the protection line when the attempt turned no protection on', async () => {
    const { del } = recordingDelete();
    const { ctx, warned } = heldCtx(del, { kind: 'held', by: 'stack B' });
    const op = { ...orphan(), attemptedProperties: {} };
    await replayFailedOperations([op], {}, 'Stack', ctx, {});
    expect(del).not.toHaveBeenCalled();
    expect(warned()).not.toContain('leaving deletion protection');
  });
});

describe('a name-keyed orphan is deleted, and gets the flag, only when its identity is proven (go-to-k/cdkd#4678, #4658)', () => {
  // A table's physical id is the name the user chose: after a hand delete,
  // another table can take it.
  const tableOrphan = (over: Partial<FailedOperation> = {}): FailedOperation => ({
    logicalId: 'Table',
    changeType: 'CREATE',
    resourceType: 'AWS::DynamoDB::Table',
    physicalId: 'orders',
    provisionedBy: 'sdk',
    physicalIdRecoveredFromError: true,
    attemptedProperties: { TableName: 'orders', DeletionProtectionEnabled: true },
    ...over,
  });

  function tableCtx(del: ReturnType<typeof vi.fn>, live: unknown) {
    const warn = vi.fn();
    const resourceIdentity = vi.fn(async () => live);
    const ctx: RollbackExecutorContext = {
      region: 'us-east-1',
      logger: { ...logger, warn } as unknown as RollbackExecutorContext['logger'],
      providerRegistry: {
        getProviderFor: () => ({ provider: { delete: del, resourceIdentity }, provisionedBy: 'sdk' }),
      } as unknown as RollbackExecutorContext['providerRegistry'],
      removeProtection: true,
      foreignHolder: async () => undefined,
    };
    const warned = (): string => warn.mock.calls.map((c) => String(c[0])).join('\n');
    return { ctx, warned, resourceIdentity };
  }

  it('passes it when the live identity equals the journaled one, with one read', async () => {
    const { del, seen } = recordingDelete();
    const { ctx, warned, resourceIdentity } = tableCtx(del, 'tok-1');
    await replayFailedOperations(
      [tableOrphan({ createdResourceIdentity: 'tok-1' })],
      {},
      'Stack',
      ctx,
      {}
    );
    expect(seen[0]!.context['removeProtection']).toBe(true);
    expect(resourceIdentity).toHaveBeenCalledOnce();
    expect(warned()).not.toContain('leaving deletion protection');
  });

  it('sends no delete, and warns, when the live identity is another', async () => {
    const { del } = recordingDelete();
    const { ctx, warned } = tableCtx(del, 'tok-2');
    await replayFailedOperations(
      [tableOrphan({ createdResourceIdentity: 'tok-1' })],
      {},
      'Stack',
      ctx,
      {}
    );
    expect(del).not.toHaveBeenCalled();
    expect(warned()).toContain('Skipping failed CREATE of Table');
    expect(warned()).toContain('its name was reused');
  });

  it('sends no delete, and warns, when no identity was journaled', async () => {
    const { del } = recordingDelete();
    const { ctx, warned } = tableCtx(del, 'tok-1');
    await replayFailedOperations([tableOrphan()], {}, 'Stack', ctx, {});
    expect(del).not.toHaveBeenCalled();
    expect(warned()).toContain('nothing proves the resource now under that id');
  });

  // A partially-recorded CREATE: state holds the id, so the record owns it,
  // as it would a state-tracked delete's.
  it('passes it, with no identity read, for a state-recorded failed CREATE', async () => {
    const { del, seen } = recordingDelete();
    const { ctx, resourceIdentity } = tableCtx(del, 'tok-2');
    await replayFailedOperations(
      [tableOrphan({ physicalIdRecoveredFromError: undefined })],
      {
        Table: {
          physicalId: 'orders',
          resourceType: 'AWS::DynamoDB::Table',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
      'Stack',
      ctx,
      {}
    );
    expect(del).toHaveBeenCalledOnce();
    expect(seen[0]!.context['removeProtection']).toBe(true);
    expect(resourceIdentity).not.toHaveBeenCalled();
  });

  // The record is the stack's own: no foreign scan is asked, so a `held`
  // answer (the record's own stack would read as another) cannot withhold it.
  it('passes it, with no foreign scan, for a state-recorded failed CREATE', async () => {
    const { del, seen } = recordingDelete();
    const { ctx } = tableCtx(del, 'tok-2');
    const foreignHolder = vi.fn(async () => ({ kind: 'held' as const, by: 'stack B' }));
    await replayFailedOperations(
      [tableOrphan({ physicalIdRecoveredFromError: undefined })],
      {
        Table: {
          physicalId: 'orders',
          resourceType: 'AWS::DynamoDB::Table',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
      'Stack',
      { ...ctx, foreignHolder },
      {}
    );
    expect(seen[0]!.context['removeProtection']).toBe(true);
    expect(foreignHolder).not.toHaveBeenCalled();
  });

  it('sends no delete when the live read gives no answer', async () => {
    const { del } = recordingDelete();
    const { ctx, resourceIdentity } = tableCtx(del, undefined);
    await replayFailedOperations(
      [tableOrphan({ createdResourceIdentity: 'tok-1' })],
      {},
      'Stack',
      ctx,
      {}
    );
    expect(resourceIdentity).toHaveBeenCalledOnce();
    expect(del).not.toHaveBeenCalled();
  });

  // A queue has no deletion protection: the flag would strip nothing.
  it('deletes it without the flag on a name-keyed type with no protection', async () => {
    const { del, seen } = recordingDelete();
    const { ctx, warned } = tableCtx(del, 'tok-1');
    await replayFailedOperations(
      [
        tableOrphan({
          logicalId: 'Queue',
          resourceType: 'AWS::SQS::Queue',
          physicalId: 'https://sqs.us-east-1.amazonaws.com/123456789012/q',
          attemptedProperties: { QueueName: 'q' },
          createdResourceIdentity: 'tok-1',
        }),
      ],
      {},
      'Stack',
      ctx,
      {}
    );
    expect(del).toHaveBeenCalledOnce();
    expect(seen[0]!.context).not.toHaveProperty('removeProtection');
    expect(warned()).not.toContain('leaving deletion protection');
  });

  it('settles it with no delete when the resource is gone', async () => {
    const { del } = recordingDelete();
    const { ctx, warned } = tableCtx(del, RESOURCE_NOT_FOUND);
    const result = await replayFailedOperations(
      [tableOrphan({ createdResourceIdentity: 'tok-1' })],
      {},
      'Stack',
      ctx,
      {}
    );
    expect(del).not.toHaveBeenCalled();
    expect(result.remainingFailedOps).toEqual([]);
    expect(result.warnings).toBe(0);
    expect(warned()).toBe('');
  });
});

describe("no context but an explicit --remove-protection's strips protection (go-to-k/cdkd#4678)", () => {
  // A deploy's automatic rollback and its success settle (its own and a nested
  // child's) take their context from `rollbackExecutorContext`.
  it('rollbackExecutorContext carries no removeProtection', () => {
    const engine = {
      producerRegionEvidence: () => ({ regions: [], complete: true }),
      providerRegistry: {},
      stackRegion: 'us-east-1',
      logger,
      recordEvent: vi.fn(),
      options: { skipFinalSnapshot: true },
      perResourceSecrets: new Map(),
    } as unknown as DeployEngine;
    const state = {
      version: 10,
      stackName: 'Stack',
      region: 'us-east-1',
      resources: {},
      outputs: {},
      lastModified: 1,
    } as unknown as StackState;
    const ctx = rollbackExecutorContext.call(engine, state, 'Stack');
    expect(ctx.region).toBe('us-east-1');
    expect(ctx).not.toHaveProperty('removeProtection');
  });

  // `cdkd rollback` sets it only under its explicit flag
  // (`tests/unit/cli/rollback-remove-protection-4678.test.ts`). A nested
  // child's journal revert (`nested-child-journal.ts`) reads it only from the
  // `destroyOptions` that flag sets, never from a deploy's context
  // (`tests/unit/deployment/nested-child-remove-protection-4703.test.ts`).
  it.each([
    'src/deployment/deploy-engine/rollback.ts',
  ])('%s builds a RollbackExecutorContext with no removeProtection', (file) => {
    const text = readFileSync(join(REPO_ROOT, file), 'utf8');
    expect(text).toContain('RollbackExecutorContext');
    expect(text).not.toContain('removeProtection');
  });
});
