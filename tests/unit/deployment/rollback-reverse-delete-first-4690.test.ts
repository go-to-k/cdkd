/**
 * go-to-k/cdkd#4690: a replacement that deleted the OLD resource before it
 * created the new one (`--recreate-via-*`, the UPDATE-unsupported fallback,
 * `--replace`'s delete-first fallback) is reversed in the same order: delete
 * the new resource, then re-create the old one. Re-creating first collided
 * with the new resource on a uniqueness constraint the name-holder proof
 * cannot attribute (an ELBv2 listener's port), so the rollback refused and
 * sent the user to `cdkd rollback --orphan`.
 *
 * The provider below models that constraint: a create fails while ANY
 * listener holds the port.
 */

import { describe, it, expect, vi } from 'vite-plus/test';
import {
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import type { ResourceState } from '../../../src/types/state.js';
import { awsSdkError } from '../_aws-sdk-error.js';

// Single-attempt pass-through so a retried create does not sleep.
vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ tag: 'process-global' }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const TYPE = 'AWS::ElasticLoadBalancingV2::Listener';
const PROPS = { LoadBalancerArn: 'arn:lb', Port: 80, Protocol: 'HTTP' };

function rec(physicalId: string, overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId,
    resourceType: TYPE,
    properties: { ...PROPS },
    attributes: {},
    dependencies: [],
    ...overrides,
  };
}

/** `listener-old` was replaced by `listener-new`. */
function op(oldDeletedBeforeCreate?: boolean): CompletedOperation {
  return {
    logicalId: 'Listener',
    changeType: 'UPDATE',
    resourceType: TYPE,
    provisionedBy: 'sdk',
    physicalId: 'listener-new',
    previousState: rec('listener-old', { provisionedBy: 'cc-api' }),
    oldResourceRetained: false,
    ...(oldDeletedBeforeCreate !== undefined && { oldDeletedBeforeCreate }),
  };
}

/** A port only one listener can hold, and the calls in order. */
function portModel(opts: { deleteError?: Error; createError?: Error } = {}) {
  const live = new Set<string>(['listener-new']);
  const calls: string[] = [];
  const provider = {
    create: vi.fn(async () => {
      calls.push('create');
      if (opts.createError) throw opts.createError;
      if (live.size > 0) {
        throw awsSdkError(
          'A listener already exists on this port for this load balancer',
          'DuplicateListenerException'
        );
      }
      live.add('listener-old-2');
      return { physicalId: 'listener-old-2', attributes: {} };
    }),
    delete: vi.fn(async (_logicalId: string, physicalId: string) => {
      calls.push(`delete ${physicalId}`);
      if (opts.deleteError) throw opts.deleteError;
      live.delete(physicalId);
    }),
  };
  const infos: string[] = [];
  const logger = {
    debug: vi.fn(),
    info: vi.fn((m: string) => infos.push(m)),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => logger,
  } as unknown as RollbackExecutorContext['logger'];
  const ctx: RollbackExecutorContext = {
    region: 'us-east-1',
    logger,
    providerRegistry: {
      getProviderFor: () => ({ provider }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
  };
  return { ctx, provider, calls, live, infos };
}

describe('reversing a delete-first replacement (go-to-k/cdkd#4690)', () => {
  it('deletes the new resource before re-creating the old one', async () => {
    const m = portModel();
    const state: Record<string, ResourceState> = { Listener: rec('listener-new', { provisionedBy: 'sdk' }) };
    const saved: Array<string | undefined> = [];

    const result = await replayRollback([op(true)], state, 'S', m.ctx, {
      afterOp: () => {
        saved.push(state['Listener']?.physicalId);
      },
    });

    expect(m.calls).toEqual(['delete listener-new', 'create']);
    expect(result.failures).toBe(0);
    expect(result.warnings).toBe(0);
    expect(state['Listener']!.physicalId).toBe('listener-old-2');
    expect(state['Listener']!.provisionedBy).toBe('cc-api');
    expect([...m.live]).toEqual(['listener-old-2']);
    // The intermediate truth (no record) is persisted between the two calls.
    expect(saved).toEqual([undefined, 'listener-old-2']);
    expect(m.infos.join('\n')).toContain(
      'Reversing replacement of Listener (AWS::ElasticLoadBalancingV2::Listener) — deleting the new resource and re-creating the old one'
    );
    expect(m.infos.join('\n')).toContain(
      'the replacement deleted the old resource before creating the new one — deleting the new resource (listener-new) first'
    );
  });

  it('routes the delete to the new layer and the create to the old one', async () => {
    const m = portModel();
    const routes: Array<{ resourceType: string; provisionedBy?: string }> = [];
    (m.ctx.providerRegistry as unknown as { getProviderFor: unknown }).getProviderFor = (r: {
      resourceType: string;
      provisionedBy?: string;
    }) => {
      routes.push(r);
      return { provider: m.provider, provisionedBy: r.provisionedBy };
    };
    const state: Record<string, ResourceState> = { Listener: rec('listener-new', { provisionedBy: 'sdk' }) };
    await replayRollback([op(true)], state, 'S', m.ctx);
    expect(routes.map((r) => r.provisionedBy)).toEqual(['cc-api', 'sdk']);
    expect(m.calls).toEqual(['delete listener-new', 'create']);
  });

  // Negative controls: the create-first reversal is unchanged without the flag.
  for (const flag of [false, undefined]) {
    it(`keeps create-first when oldDeletedBeforeCreate is ${String(flag)}`, async () => {
      const m = portModel();
      // No port conflict, so create-first completes and then deletes the new one.
      m.live.clear();
      m.live.add('elsewhere');
      m.provider.create.mockImplementationOnce(async () => {
        m.calls.push('create');
        return { physicalId: 'listener-old-2', attributes: {} };
      });
      const state: Record<string, ResourceState> = { Listener: rec('listener-new', { provisionedBy: 'sdk' }) };
      const result = await replayRollback([op(flag)], state, 'S', m.ctx);
      expect(m.calls).toEqual(['create', 'delete listener-new']);
      expect(result.failures).toBe(0);
      expect(m.infos.join('\n')).toContain('re-creating the old resource and deleting the new one');
    });
  }

  it('the create-first reversal of the same shape collides and refuses (the pre-#4690 outcome)', async () => {
    const m = portModel();
    const state: Record<string, ResourceState> = { Listener: rec('listener-new', { provisionedBy: 'sdk' }) };
    const result = await replayRollback([op()], state, 'S', m.ctx);
    expect(result.failures).toBe(1);
    expect(m.calls).toEqual(['create']);
    expect(state['Listener']!.physicalId).toBe('listener-new');
  });

  it('keeps the record on the live new resource when its delete fails, and never re-creates', async () => {
    const m = portModel({ deleteError: new Error('delete refused') });
    const state: Record<string, ResourceState> = { Listener: rec('listener-new', { provisionedBy: 'sdk' }) };
    const afterOp = vi.fn();
    const result = await replayRollback([op(true)], state, 'S', m.ctx, { afterOp });
    expect(result.failures).toBe(1);
    expect(m.calls).toEqual(['delete listener-new']);
    expect(state['Listener']!.physicalId).toBe('listener-new');
    expect(afterOp).not.toHaveBeenCalled();
  });

  it('keeps the record when the delete is skipped, and never re-creates', async () => {
    const m = portModel();
    m.provider.delete.mockImplementationOnce(async (_l: string, physicalId: string) => {
      m.calls.push(`delete ${physicalId}`);
      return { outcome: 'skipped', reason: 'test skip' } as never;
    });
    const state: Record<string, ResourceState> = { Listener: rec('listener-new', { provisionedBy: 'sdk' }) };
    const result = await replayRollback([op(true)], state, 'S', m.ctx);
    expect(result.failures).toBe(1);
    expect(m.calls).toEqual(['delete listener-new']);
    expect(state['Listener']!.physicalId).toBe('listener-new');
  });

  it('says the resource is absent when the re-create fails after the delete', async () => {
    const m = portModel({ createError: new Error('create rejected') });
    const state: Record<string, ResourceState> = { Listener: rec('listener-new', { provisionedBy: 'sdk' }) };
    const errors: string[] = [];
    (m.ctx.logger as unknown as { error: ReturnType<typeof vi.fn> }).error.mockImplementation(
      (msg: string) => errors.push(msg)
    );
    const events: Array<Record<string, unknown>> = [];
    m.ctx.recordEvent = (e) => {
      events.push(e as unknown as Record<string, unknown>);
    };
    const result = await replayRollback([op(true)], state, 'S', m.ctx);
    expect(result.failures).toBe(1);
    expect(m.calls).toEqual(['delete listener-new', 'create']);
    expect(state['Listener']).toBeUndefined();
    const failed = events.find((e) => e['eventType'] === 'ROLLBACK_RESOURCE_FAILED');
    expect(JSON.stringify(failed ?? errors)).toContain('The resource is now absent');
  });

  it('keeps create-first when UpdateReplacePolicy: Retain pins the new resource', async () => {
    const m = portModel();
    m.live.clear();
    const state: Record<string, ResourceState> = {
      Listener: rec('listener-new', { provisionedBy: 'sdk', updateReplacePolicy: 'Retain' }),
    };
    const result = await replayRollback([op(true)], state, 'S', m.ctx);
    // The retained copy is never deleted; the old one is still re-created.
    expect(m.calls).toEqual(['create']);
    expect(result.failures).toBe(0);
    expect(state['Listener']!.physicalId).toBe('listener-old-2');
  });
});
