import { describe, it, expect, vi } from 'vite-plus/test';

import {
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { isTerminalDeleteFailure } from '../../../src/provisioning/providers/deletion-protection-compensation.js';
import type { ResourceState } from '../../../src/types/state.js';

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
 * go-to-k/cdkd#4678: `cdkd rollback --remove-protection` reaches the delete of
 * a resource the rolled-back deploy CREATED and completed (`replayDelete`), not
 * only a failed CREATE's. The resource's identity is this stack's own state
 * record, matched to the journaled id; a mismatched record sends no delete.
 */

const TYPE = 'AWS::ElasticLoadBalancingV2::LoadBalancer';
const LB_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/c/1';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setLevel: vi.fn(),
  child: () => logger,
} as unknown as RollbackExecutorContext['logger'];

const PROPS = {
  LoadBalancerAttributes: [{ Key: 'deletion_protection.enabled', Value: 'true' }],
};

const createdOp = (): CompletedOperation => ({
  logicalId: 'Lb',
  changeType: 'CREATE',
  resourceType: TYPE,
  physicalId: LB_ARN,
  provisionedBy: 'sdk',
  properties: PROPS,
});

const record = (overrides: Partial<ResourceState> = {}): ResourceState => ({
  physicalId: LB_ARN,
  resourceType: TYPE,
  provisionedBy: 'sdk',
  properties: PROPS,
  attributes: {},
  dependencies: [],
  ...overrides,
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

describe('completed-CREATE delete under --remove-protection (go-to-k/cdkd#4678)', () => {
  it('forwards removeProtection to the delete, as its single and final attempt', async () => {
    const { del, seen } = recordingDelete();
    const state: Record<string, ResourceState> = { Lb: record() };
    const result = await replayRollback(
      [createdOp()],
      state,
      'Stack',
      ctxWith(del, { removeProtection: true })
    );
    expect(del).toHaveBeenCalledOnce();
    expect(del.mock.calls[0]![1]).toBe(LB_ARN);
    expect(seen[0]!.context['removeProtection']).toBe(true);
    // No outer loop re-enters this delete: a retryable refusal is the last
    // one, so a protection flip is compensated rather than left off.
    expect(seen[0]!.throttleTerminal).toBe(true);
    expect(result.failures).toBe(0);
    expect(state).not.toHaveProperty('Lb');
  });

  it('passes no removeProtection, and no attempt scope, without the flag', async () => {
    const { del, seen } = recordingDelete();
    await replayRollback([createdOp()], { Lb: record() }, 'Stack', ctxWith(del));
    expect(del).toHaveBeenCalledOnce();
    expect(seen[0]!.context).not.toHaveProperty('removeProtection');
    expect(seen[0]!.throttleTerminal).toBe(false);
  });

  it('reads only `true`: a false flag strips nothing', async () => {
    const { del, seen } = recordingDelete();
    await replayRollback(
      [createdOp()],
      { Lb: record() },
      'Stack',
      ctxWith(del, { removeProtection: false })
    );
    expect(seen[0]!.context).not.toHaveProperty('removeProtection');
  });

  it('carries the flag beside a DeletionPolicy Snapshot delete', async () => {
    const { del, seen } = recordingDelete();
    await replayRollback(
      [createdOp()],
      { Lb: record({ deletionPolicy: 'Snapshot' }) },
      'Stack',
      ctxWith(del, { removeProtection: true, skipFinalSnapshot: true })
    );
    expect(del).toHaveBeenCalledOnce();
    expect(seen[0]!.context['removeProtection']).toBe(true);
    expect(seen[0]!.context['deletionPolicy']).toBe('Snapshot');
  });

  it.each([
    ['without', {}],
    ['with', { removeProtection: true }],
  ])('keeps the record when the delete is refused %s the flag', async (_, extra) => {
    const del = vi.fn().mockRejectedValue(
      Object.assign(new Error('Load balancer cannot be deleted: deletion protection is enabled'), {
        name: 'OperationNotPermittedException',
      })
    );
    const state: Record<string, ResourceState> = { Lb: record() };
    const result = await replayRollback([createdOp()], state, 'Stack', ctxWith(del, extra));
    expect(del).toHaveBeenCalledOnce();
    expect(result.failures).toBe(1);
    expect(state['Lb']?.physicalId).toBe(LB_ARN);
  });

  it('sends no delete when the state record names another id (identity not proven)', async () => {
    const { del } = recordingDelete();
    const state: Record<string, ResourceState> = {
      Lb: record({ physicalId: `${LB_ARN}-later` }),
    };
    await replayRollback([createdOp()], state, 'Stack', ctxWith(del, { removeProtection: true }));
    expect(del).not.toHaveBeenCalled();
    expect(state['Lb']?.physicalId).toBe(`${LB_ARN}-later`);
  });

  it('sends no delete under DeletionPolicy Retain, whatever the flag', async () => {
    const { del } = recordingDelete();
    await replayRollback(
      [createdOp()],
      { Lb: record({ deletionPolicy: 'Retain' }) },
      'Stack',
      ctxWith(del, { removeProtection: true })
    );
    expect(del).not.toHaveBeenCalled();
  });
});
