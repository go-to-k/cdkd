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

describe('a name-keyed orphan gets the flag only when its identity is proven (go-to-k/cdkd#4678)', () => {
  // A table's physical id is the name the user chose: after a hand delete,
  // another table can take it, and AWS's protection refusal is then the last
  // guard against deleting it.
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
    };
    const warned = (): string => warn.mock.calls.map((c) => String(c[0])).join('\n');
    return { ctx, warned, resourceIdentity };
  }

  it('passes it when the live identity equals the journaled one', async () => {
    const { del, seen } = recordingDelete();
    const { ctx, warned } = tableCtx(del, 'tok-1');
    await replayFailedOperations(
      [tableOrphan({ createdResourceIdentity: 'tok-1' })],
      {},
      'Stack',
      ctx,
      {}
    );
    expect(seen[0]!.context['removeProtection']).toBe(true);
    expect(warned()).not.toContain('leaving deletion protection');
  });

  it('withholds it, and warns, when the live identity is another', async () => {
    const { del, seen } = recordingDelete();
    const { ctx, warned } = tableCtx(del, 'tok-2');
    await replayFailedOperations(
      [tableOrphan({ createdResourceIdentity: 'tok-1' })],
      {},
      'Stack',
      ctx,
      {}
    );
    expect(del).toHaveBeenCalledOnce();
    expect(seen[0]!.context).not.toHaveProperty('removeProtection');
    expect(seen[0]!.throttleTerminal).toBe(false);
    expect(warned()).toContain('leaving deletion protection on partially-created Table');
  });

  it('withholds it, and warns, when no identity was journaled (no read is made)', async () => {
    const { del, seen } = recordingDelete();
    const { ctx, warned, resourceIdentity } = tableCtx(del, 'tok-1');
    await replayFailedOperations([tableOrphan()], {}, 'Stack', ctx, {});
    expect(seen[0]!.context).not.toHaveProperty('removeProtection');
    expect(resourceIdentity).not.toHaveBeenCalled();
    expect(warned()).toContain('leaving deletion protection on partially-created Table');
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

  it('withholds it silently when the resource is gone', async () => {
    const { del, seen } = recordingDelete();
    const { ctx, warned } = tableCtx(del, RESOURCE_NOT_FOUND);
    await replayFailedOperations(
      [tableOrphan({ createdResourceIdentity: 'tok-1' })],
      {},
      'Stack',
      ctx,
      {}
    );
    expect(seen[0]!.context).not.toHaveProperty('removeProtection');
    expect(warned()).not.toContain('leaving deletion protection');
  });
});

describe("a deploy's own rollback context never strips protection (go-to-k/cdkd#4678)", () => {
  // The automatic rollback, the success settle and a nested child's rollback
  // all take their context from this one builder.
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
});
