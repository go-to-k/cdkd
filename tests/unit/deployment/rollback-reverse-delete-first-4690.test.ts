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
import type { FailedOperation } from '../../../src/deployment/rollback-executor/types.js';
import { awsSdkError } from '../_aws-sdk-error.js';
import { withRetry } from '../../../src/deployment/retry.js';
import { markDeleteFirstBlocked, deleteFirstBlocker } from '../../../src/deployment/rollback-executor/plan.js';
import { RollbackInlinePolicyWriters } from '../../../src/deployment/inline-policy-claims.js';

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

  it('deletes through the new layer and re-creates through the old one', async () => {
    const m = portModel();
    const byLayer = {
      sdk: { create: vi.fn(), delete: vi.fn(async (_l: string, _p: string) => undefined) },
      'cc-api': { create: vi.fn(async () => ({ physicalId: 'listener-old-2', attributes: {} })), delete: vi.fn() },
    };
    (m.ctx.providerRegistry as unknown as { getProviderFor: unknown }).getProviderFor = (r: {
      provisionedBy: 'sdk' | 'cc-api';
    }) => ({ provider: byLayer[r.provisionedBy], provisionedBy: r.provisionedBy });
    const state: Record<string, ResourceState> = { Listener: rec('listener-new', { provisionedBy: 'sdk' }) };
    const result = await replayRollback([op(true)], state, 'S', m.ctx);
    expect(result.failures).toBe(0);
    expect(byLayer.sdk.delete).toHaveBeenCalledTimes(1);
    expect(byLayer.sdk.delete.mock.calls[0]![1]).toBe('listener-new');
    expect(byLayer.sdk.create).not.toHaveBeenCalled();
    expect(byLayer['cc-api'].create).toHaveBeenCalledTimes(1);
    expect(byLayer['cc-api'].delete).not.toHaveBeenCalled();
    expect(byLayer.sdk.delete.mock.invocationCallOrder[0]!).toBeLessThan(
      byLayer['cc-api'].create.mock.invocationCallOrder[0]!
    );
  });

  // The re-create waits out a late release: an async delete frees the slot
  // late, and a named SQS queue's 60s same-name cooldown starts at the delete.
  it('retries the re-create on a collision or a name cooldown', async () => {
    vi.mocked(withRetry).mockClear();
    const m = portModel();
    const state: Record<string, ResourceState> = { Listener: rec('listener-new', { provisionedBy: 'sdk' }) };
    await replayRollback([op(true)], state, 'S', m.ctx);
    const outer = vi
      .mocked(withRetry)
      .mock.calls.filter((c) => (c[2] as { isRetryable?: unknown } | undefined)?.isRetryable !== undefined);
    // One outer loop: the delete-first route makes no create-first attempt.
    expect(outer).toHaveLength(1);
    const isRetryable = (outer[0]![2] as { isRetryable: (m: string) => boolean }).isRetryable;
    expect(isRetryable('Queue already exists')).toBe(true);
    expect(
      isRetryable(
        'You must wait 60 seconds after deleting a queue before you can create another with the same name.'
      )
    ).toBe(true);
    expect(isRetryable('AccessDenied')).toBe(false);
  });

  // A re-create that returns the id the new resource had: after the new one
  // was deleted that is the old name coming back, not a name-idempotent
  // hand-back of a live resource, so it is neither adopted nor deleted again.
  it("a re-create returning the deleted new resource's id is not adopted and not deleted again", async () => {
    const del = vi.fn(async () => undefined);
    const create = vi.fn(async () => ({ physicalId: 'q-new', attributes: {} }));
    const warns: string[] = [];
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn((w: string) => warns.push(w)),
      error: vi.fn(),
      setLevel: vi.fn(),
      child: () => logger,
    } as unknown as RollbackExecutorContext['logger'];
    const ctx: RollbackExecutorContext = {
      region: 'us-east-1',
      logger,
      providerRegistry: {
        getProviderFor: () => ({ provider: { create, delete: del } }),
      } as unknown as RollbackExecutorContext['providerRegistry'],
    };
    const queue = (physicalId: string, props: Record<string, unknown>): ResourceState => ({
      physicalId,
      resourceType: 'AWS::SQS::Queue',
      properties: { QueueName: 'q', ...props },
      attributes: {},
      dependencies: [],
    });
    const state: Record<string, ResourceState> = { Q: queue('q-new', { a: 2 }) };
    const result = await replayRollback(
      [
        {
          logicalId: 'Q',
          changeType: 'UPDATE',
          resourceType: 'AWS::SQS::Queue',
          physicalId: 'q-new',
          previousState: queue('q-old', { a: 1 }),
          oldResourceRetained: false,
          oldDeletedBeforeCreate: true,
        },
      ],
      state,
      'S',
      ctx
    );
    expect(warns, warns.join('|')).toEqual([]);
    expect(result.failures).toBe(0);
    expect(result.warnings).toBe(0);
    expect(del).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(state['Q']).toMatchObject({ physicalId: 'q-new', properties: { a: 1 } });
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

// The real retry loop, minus its sleeps, for the cases that drive it.
const actualRetry = await vi.importActual<typeof import('../../../src/deployment/retry.js')>(
  '../../../src/deployment/retry.js'
);
function driveRealRetry(): void {
  vi.mocked(withRetry).mockImplementation(((fn: () => Promise<unknown>, label: string, opts?: object) =>
    actualRetry.withRetry(fn, label, { ...(opts ?? {}), sleep: async () => undefined })) as never);
}
function restoreSinglePassRetry(): void {
  vi.mocked(withRetry).mockImplementation(((fn: () => Promise<unknown>) => fn()) as never);
}

const TG_TYPE = 'AWS::ElasticLoadBalancingV2::TargetGroup';
const TG_OLD = 'arn:aws:elasticloadbalancing:us-east-1:111122223333:targetgroup/tg/0123456789abcdef';
const TG_NEW = 'arn:aws:elasticloadbalancing:us-east-1:111122223333:targetgroup/tg/fedcba9876543210';

/** A listener op whose OLD properties forward to `targetGroupArn`. */
function listenerOp(targetGroupArn: string): CompletedOperation {
  const o = op(true);
  o.previousState = rec('listener-old', {
    provisionedBy: 'cc-api',
    properties: {
      ...PROPS,
      DefaultActions: [{ Type: 'forward', TargetGroupArn: targetGroupArn }],
    },
  });
  return o;
}

/** The target group's op: replaced create-first in the same deploy. */
function targetGroupOp(over: Partial<CompletedOperation> = {}): CompletedOperation {
  return {
    logicalId: 'Tg',
    changeType: 'UPDATE',
    resourceType: TG_TYPE,
    provisionedBy: 'sdk',
    physicalId: TG_NEW,
    previousState: {
      physicalId: TG_OLD,
      resourceType: TG_TYPE,
      properties: { Port: 80 },
      attributes: {},
      dependencies: [],
    },
    oldResourceRetained: false,
    ...over,
  };
}

describe('a delete-first reversal whose old properties name a resource the deploy took away (go-to-k/cdkd#4690)', () => {
  /** The listener's calls only: the target group's op runs through its own provider. */
  function model() {
    const m = portModel();
    const tgProvider = {
      create: vi.fn(async () => ({ physicalId: 'tg-recreated', attributes: {} })),
      delete: vi.fn(async () => undefined),
      update: vi.fn(),
    };
    const warns: string[] = [];
    (m.ctx.logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn.mockImplementation(
      (w: string) => warns.push(w)
    );
    (m.ctx.providerRegistry as unknown as { getProviderFor: unknown }).getProviderFor = (r: {
      resourceType: string;
    }) => ({ provider: r.resourceType === TG_TYPE ? tgProvider : m.provider });
    return { ...m, tgProvider, warns };
  }
  const state = (): Record<string, ResourceState> => ({
    Listener: rec('listener-new', {
      provisionedBy: 'sdk',
      properties: { ...PROPS, DefaultActions: [{ Type: 'forward', TargetGroupArn: TG_NEW }] },
    }),
    Tg: {
      physicalId: TG_NEW,
      resourceType: TG_TYPE,
      properties: { Port: 81 },
      attributes: {},
      dependencies: [],
    },
  });

  it('keeps create-first, so the failed re-create keeps the new listener', async () => {
    const m = model();
    const s = state();
    // Completion order: the target group, then the listener; reversed listener first.
    const result = await replayRollback([targetGroupOp(), listenerOp(TG_OLD)], s, 'S', m.ctx);
    expect(m.calls).toEqual(['create']);
    expect(s['Listener']!.physicalId).toBe('listener-new');
    expect(result.failures).toBeGreaterThanOrEqual(1);
    expect(m.warns.join('\n')).toContain('not deleting the new Listener first');
    expect(m.warns.join('\n')).toContain('name the resource Tg had before the same deploy');
  });

  it('control: an old target group the deploy left alone keeps delete-first', async () => {
    const m = model();
    const s = state();
    const result = await replayRollback(
      [targetGroupOp(), listenerOp('arn:aws:elasticloadbalancing:us-east-1:111122223333:targetgroup/other/0000000000000000')],
      s,
      'S',
      m.ctx
    );
    expect(m.calls).toEqual(['delete listener-new', 'create']);
    expect(result.failures).toBe(0);
  });

  it('a replacement that KEPT its old copy does not block', async () => {
    const m = model();
    const result = await replayRollback(
      [targetGroupOp({ oldResourceRetained: true }), listenerOp(TG_OLD)],
      state(),
      'S',
      m.ctx
    );
    expect(m.calls).toEqual(['delete listener-new', 'create']);
    expect(result.failures).toBe(0);
  });

  it("a DELETE op's old id blocks", async () => {
    const m = model();
    const s = state();
    delete s['Tg'];
    await replayRollback(
      [
        listenerOp(TG_OLD),
        {
          logicalId: 'Tg',
          changeType: 'DELETE',
          resourceType: TG_TYPE,
          provisionedBy: 'sdk',
          previousState: {
            physicalId: TG_OLD,
            resourceType: TG_TYPE,
            properties: { Port: 80 },
            attributes: {},
            dependencies: [],
          },
        },
      ],
      s,
      'S',
      m.ctx
    );
    expect(m.calls[0]).toBe('create');
    expect(m.calls).not.toContain('delete listener-new');
    expect(s['Listener']!.physicalId).toBe('listener-new');
  });

  it('matches an id embedded in a longer string, and never a short id by substring', () => {
    const embedded = listenerOp('ignored');
    embedded.previousState!.properties = { Doc: `{"Resource":"${TG_OLD}/*"}` };
    const short = listenerOp('ignored');
    short.previousState!.properties = { Name: 'q-old-suffix' };
    const shortGone: CompletedOperation = {
      ...targetGroupOp(),
      logicalId: 'Q',
      physicalId: 'q-new',
      previousState: { ...targetGroupOp().previousState!, physicalId: 'q-old' },
    };
    markDeleteFirstBlocked([targetGroupOp(), embedded]);
    markDeleteFirstBlocked([shortGone, short]);
    expect(deleteFirstBlocker(embedded)).toEqual({ logicalId: 'Tg', physicalId: TG_OLD });
    expect(deleteFirstBlocker(short)).toBeUndefined();
  });

  it("never blocks on the op's own old id", () => {
    const self = listenerOp('listener-old');
    markDeleteFirstBlocked([self]);
    expect(deleteFirstBlocker(self)).toBeUndefined();
  });
});

describe('the delete-first route, further shapes (go-to-k/cdkd#4690)', () => {
  it('a Type change deletes through the new type and re-creates through the old one', async () => {
    const byType: Record<string, { create: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> }> = {
      'AWS::SNS::Topic': {
        create: vi.fn(async () => ({ physicalId: 'topic-old-2', attributes: {} })),
        delete: vi.fn(),
      },
      'AWS::SQS::Queue': { create: vi.fn(), delete: vi.fn(async () => undefined) },
    };
    const m = portModel();
    (m.ctx.providerRegistry as unknown as { getProviderFor: unknown }).getProviderFor = (r: {
      resourceType: string;
    }) => ({ provider: byType[r.resourceType] });
    const state: Record<string, ResourceState> = {
      R: { physicalId: 'queue-new', resourceType: 'AWS::SQS::Queue', properties: { a: 2 }, attributes: {}, dependencies: [] },
    };
    const result = await replayRollback(
      [
        {
          logicalId: 'R',
          changeType: 'UPDATE',
          resourceType: 'AWS::SQS::Queue',
          previousResourceType: 'AWS::SNS::Topic',
          physicalId: 'queue-new',
          previousState: { physicalId: 'topic-old', resourceType: 'AWS::SNS::Topic', properties: { a: 1 }, attributes: {}, dependencies: [] },
          oldResourceRetained: false,
          oldDeletedBeforeCreate: true,
        },
      ],
      state,
      'S',
      m.ctx
    );
    expect(result.failures).toBe(0);
    expect(byType['AWS::SQS::Queue']!.delete).toHaveBeenCalledTimes(1);
    expect(byType['AWS::SQS::Queue']!.delete.mock.calls[0]![2]).toBe('AWS::SQS::Queue');
    expect(byType['AWS::SNS::Topic']!.create).toHaveBeenCalledTimes(1);
    expect(byType['AWS::SNS::Topic']!.create.mock.calls[0]![1]).toBe('AWS::SNS::Topic');
    expect(byType['AWS::SQS::Queue']!.delete.mock.invocationCallOrder[0]!).toBeLessThan(
      byType['AWS::SNS::Topic']!.create.mock.invocationCallOrder[0]!
    );
    expect(state['R']).toMatchObject({ physicalId: 'topic-old-2', resourceType: 'AWS::SNS::Topic' });
  });

  it('the re-create loop retries a late release and then succeeds', async () => {
    driveRealRetry();
    try {
      const m = portModel();
      // The port is released only after the delete returns: one collision first.
      let released = false;
      m.provider.delete.mockImplementation(async (_l: string, physicalId: string) => {
        m.calls.push(`delete ${physicalId}`);
      });
      m.provider.create.mockImplementation(async () => {
        m.calls.push('create');
        if (!released) {
          released = true;
          throw awsSdkError(
            'A listener already exists on this port for this load balancer',
            'DuplicateListenerException'
          );
        }
        return { physicalId: 'listener-old-2', attributes: {} };
      });
      const state: Record<string, ResourceState> = { Listener: rec('listener-new', { provisionedBy: 'sdk' }) };
      const result = await replayRollback([op(true)], state, 'S', m.ctx);
      expect(m.calls).toEqual(['delete listener-new', 'create', 'create']);
      expect(result.failures).toBe(0);
      expect(state['Listener']!.physicalId).toBe('listener-old-2');
    } finally {
      restoreSinglePassRetry();
    }
  });
});

describe('the collision route through the shared helpers (go-to-k/cdkd#4690)', () => {
  /** A queue named `q` replaced by a copy that still holds the name: the proven collision. */
  function collision() {
    const queue = (physicalId: string, a: number): ResourceState => ({
      physicalId,
      resourceType: 'AWS::SQS::Queue',
      properties: { QueueName: 'q', a },
      attributes: {},
      dependencies: [],
    });
    const create = vi
      .fn()
      .mockRejectedValueOnce(awsSdkError('Queue already exists', 'QueueNameExists'))
      .mockResolvedValue({ physicalId: 'q-old-2', attributes: {} });
    const del = vi.fn(async () => undefined);
    const ctx: RollbackExecutorContext = {
      region: 'us-east-1',
      logger: portModel().ctx.logger,
      providerRegistry: {
        getProviderFor: () => ({ provider: { create, delete: del } }),
      } as unknown as RollbackExecutorContext['providerRegistry'],
    };
    const opQ: CompletedOperation = {
      logicalId: 'Q',
      changeType: 'UPDATE',
      resourceType: 'AWS::SQS::Queue',
      physicalId: 'q-new',
      previousState: queue('q-old', 1),
      oldResourceRetained: false,
    };
    return { create, del, ctx, opQ, state: { Q: queue('q-new', 2) } as Record<string, ResourceState> };
  }

  it('hands the inline-policy claim to the delete it runs first', async () => {
    const c = collision();
    const writers = new RollbackInlinePolicyWriters();
    const claim = (): boolean => false;
    vi.spyOn(writers, 'claimedFor').mockReturnValue(claim as never);
    const result = await replayRollback([c.opQ], c.state, 'S', c.ctx, { inlinePolicyWriters: writers });
    expect(result.failures).toBe(0);
    expect(c.del).toHaveBeenCalledTimes(1);
    expect((c.del.mock.calls[0] as unknown[])[4]).toMatchObject({ inlinePolicyClaimed: claim });
  });

  it('names the release it waits for when interrupted', async () => {
    vi.mocked(withRetry).mockClear();
    const c = collision();
    await replayRollback([c.opQ], c.state, 'S', c.ctx, { isInterrupted: () => false });
    const outer = vi
      .mocked(withRetry)
      .mock.calls.filter((call) => (call[2] as { isRetryable?: unknown } | undefined)?.isRetryable !== undefined);
    const onInterrupted = (outer.at(-1)![2] as { onInterrupted: () => Error }).onInterrupted;
    expect(onInterrupted().message).toBe(
      'Rollback interrupted while waiting for the new resource to release its name or slot'
    );
  });
});

describe('what the delete-first guard counts as naming a gone resource (go-to-k/cdkd#4690)', () => {
  /** A delete-first op `X` whose old properties are `props`. */
  const dependent = (props: Record<string, unknown>): CompletedOperation => {
    const o = listenerOp('ignored');
    o.logicalId = 'X';
    o.previousState!.properties = props;
    return o;
  };
  /** A replacement of `logicalId` that took away `physicalId` (with `attributes`). */
  const goneBy = (
    logicalId: string,
    physicalId: string,
    attributes: Record<string, unknown> = {},
    over: Partial<CompletedOperation> = {}
  ): CompletedOperation => ({
    ...targetGroupOp(),
    logicalId,
    physicalId: `${physicalId}-replacement`,
    previousState: { physicalId, resourceType: 'AWS::Test::Thing', properties: {}, attributes, dependencies: [] },
    ...over,
  });
  const blocker = (ops: CompletedOperation[], failed: FailedOperation[] = []) => {
    markDeleteFirstBlocked(ops, failed);
    return deleteFirstBlocker(ops.at(-1)!);
  };

  it('an exact match of a short id blocks', () => {
    expect(blocker([goneBy('Q', 'q-old'), dependent({ Name: 'q-old' })])).toEqual({
      logicalId: 'Q',
      physicalId: 'q-old',
    });
    // A short id that itself holds a separator matches only exactly.
    expect(blocker([goneBy('Ns', 'ns/name'), dependent({ Path: 'ns/name' })])).toEqual({
      logicalId: 'Ns',
      physicalId: 'ns/name',
    });
  });

  it('a short-named function referenced by its ARN blocks', () => {
    expect(
      blocker([goneBy('Fn', 'my-func'), dependent({ Target: 'arn:aws:lambda:us-east-1:123456789012:function:my-func' })])
    ).toMatchObject({ logicalId: 'Fn' });
    expect(
      blocker([goneBy('Fn', 'my-func'), dependent({ Target: 'arn:aws:lambda:us-east-1:123456789012:function:my-func:live' })])
    ).toMatchObject({ logicalId: 'Fn' });
  });

  it('an IAM role referenced by its ARN blocks', () => {
    expect(blocker([goneBy('Role', 'AppRole'), dependent({ Role: 'arn:aws:iam::123:role/AppRole' })])).toMatchObject({
      logicalId: 'Role',
    });
  });

  it('an SQS queue (URL id) referenced by its ARN attribute blocks', () => {
    const url = 'https://sqs.us-east-1.amazonaws.com/123456789012/jobs';
    const arn = 'arn:aws:sqs:us-east-1:123456789012:jobs';
    expect(
      blocker([goneBy('Queue', url, { Arn: arn }), dependent({ RedrivePolicy: { deadLetterTargetArn: arn } })])
    ).toEqual({ logicalId: 'Queue', physicalId: url });
  });

  it('a non-id attribute (a load balancer DNS name) blocks', () => {
    expect(
      blocker([
        goneBy('Lb', TG_OLD, { DNSName: 'my-lb-123.us-east-1.elb.amazonaws.com', CanonicalHostedZoneID: 'Z35SXDOTRQ7X7K' }),
        dependent({ AliasTarget: { DNSName: 'my-lb-123.us-east-1.elb.amazonaws.com' } }),
      ])
    ).toMatchObject({ logicalId: 'Lb' });
  });

  it('a name that is only a prefix of a segment does not block', () => {
    expect(blocker([goneBy('Role', 'App'), dependent({ Role: 'arn:aws:iam::123:role/AppRole' })])).toBeUndefined();
  });

  it('an UPDATE that kept its physical id, or that was not a replacement, does not block', () => {
    expect(
      blocker([goneBy('Q', 'q-old', {}, { physicalId: 'q-old' }), dependent({ Name: 'q-old' })])
    ).toBeUndefined();
    expect(
      blocker([goneBy('Q', 'q-old', {}, { wasReplaced: false }), dependent({ Name: 'q-old' })])
    ).toBeUndefined();
  });

  it('a FAILED replacement that deleted its old resource first blocks', () => {
    const failed = (over: Partial<FailedOperation>): FailedOperation => ({
      logicalId: 'Q',
      changeType: 'UPDATE',
      resourceType: 'AWS::Test::Thing',
      physicalId: 'q-old',
      previousState: { physicalId: 'q-old', resourceType: 'AWS::Test::Thing', properties: {}, attributes: {}, dependencies: [] },
      ...over,
    });
    expect(blocker([dependent({ Name: 'q-old' })], [failed({ oldDeletedBeforeCreate: true })])).toMatchObject({
      logicalId: 'Q',
    });
    expect(blocker([dependent({ Name: 'q-old' })], [failed({ replacementOrphaned: 'delete-first' })])).toMatchObject({
      logicalId: 'Q',
    });
    expect(
      blocker(
        [dependent({ Name: 'q-old' })],
        [
          {
            logicalId: 'Q',
            changeType: 'CREATE',
            resourceType: 'AWS::Test::Thing',
            physicalId: 'q-new',
            replacedPhysicalId: 'q-old',
            replacedResourceDeleted: true,
          },
        ]
      )
    ).toMatchObject({ logicalId: 'Q' });
    // A create-first failure left the old resource alone.
    expect(blocker([dependent({ Name: 'q-old' })], [failed({ replacementOrphaned: 'create-first' })])).toBeUndefined();
    expect(blocker([dependent({ Name: 'q-old' })], [failed({})])).toBeUndefined();
  });
});

describe('a blocked delete-first op, end to end (go-to-k/cdkd#4690)', () => {
  it('a failed delete-first sibling seeds the block through replayRollback', async () => {
    const m = portModel();
    const warns: string[] = [];
    (m.ctx.logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn.mockImplementation((w: string) =>
      warns.push(w)
    );
    const state: Record<string, ResourceState> = { Listener: rec('listener-new', { provisionedBy: 'sdk' }) };
    const failedTg: FailedOperation = {
      logicalId: 'Tg',
      changeType: 'UPDATE',
      resourceType: TG_TYPE,
      physicalId: TG_OLD,
      previousState: { physicalId: TG_OLD, resourceType: TG_TYPE, properties: {}, attributes: {}, dependencies: [] },
      oldDeletedBeforeCreate: true,
    };
    await replayRollback([listenerOp(TG_OLD)], state, 'S', m.ctx, { failedOperations: [failedTg] });
    expect(m.calls).toEqual(['create']);
    expect(state['Listener']!.physicalId).toBe('listener-new');
    expect(warns.join('\n')).toContain('not deleting the new Listener first');
  });

  it("never prints the blocker's physical id, which may spell a secret-derived name", async () => {
    const m = portModel();
    const warns: string[] = [];
    (m.ctx.logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn.mockImplementation((w: string) =>
      warns.push(w)
    );
    const secretName = 'prod-db-hunter2-credentials-arn-tail';
    const state: Record<string, ResourceState> = { Listener: rec('listener-new', { provisionedBy: 'sdk' }) };
    await replayRollback(
      [
        { ...targetGroupOp(), logicalId: 'Secret', physicalId: 'other', previousState: { ...targetGroupOp().previousState!, physicalId: secretName } },
        listenerOp(secretName),
      ],
      state,
      'S',
      m.ctx
    );
    const text = warns.join('\n');
    expect(text).toContain('name the resource Secret had before');
    expect(text).not.toContain(secretName);
  });

  it('the collision route keeps the new resource when the holder is proven', async () => {
    const queue = (physicalId: string, dlq: string): ResourceState => ({
      physicalId,
      resourceType: 'AWS::SQS::Queue',
      properties: { QueueName: 'q', RedrivePolicy: { deadLetterTargetArn: dlq } },
      attributes: {},
      dependencies: [],
    });
    const DLQ_OLD = 'arn:aws:sqs:us-east-1:123456789012:dlq-old';
    const create = vi.fn().mockRejectedValue(awsSdkError('Queue already exists', 'QueueNameExists'));
    const del = vi.fn(async () => undefined);
    const ctx: RollbackExecutorContext = {
      region: 'us-east-1',
      logger: portModel().ctx.logger,
      providerRegistry: {
        getProviderFor: () => ({ provider: { create, delete: del } }),
      } as unknown as RollbackExecutorContext['providerRegistry'],
    };
    const state: Record<string, ResourceState> = {
      Q: queue('q-new', 'arn:aws:sqs:us-east-1:123456789012:dlq-new'),
    };
    const dlqOp: CompletedOperation = {
      logicalId: 'Dlq',
      changeType: 'UPDATE',
      resourceType: 'AWS::SQS::Queue',
      physicalId: 'https://sqs.us-east-1.amazonaws.com/123456789012/dlq-new',
      previousState: {
        physicalId: 'https://sqs.us-east-1.amazonaws.com/123456789012/dlq-old',
        resourceType: 'AWS::SQS::Queue',
        properties: { QueueName: 'dlq-old' },
        attributes: { Arn: DLQ_OLD },
        dependencies: [],
      },
      oldResourceRetained: false,
    };
    const qOp: CompletedOperation = {
      logicalId: 'Q',
      changeType: 'UPDATE',
      resourceType: 'AWS::SQS::Queue',
      physicalId: 'q-new',
      previousState: queue('q-old', DLQ_OLD),
      oldResourceRetained: false,
      oldDeletedBeforeCreate: true,
    };
    // Reversed newest first: Q only (Dlq's own create fails too, but Q runs first).
    const result = await replayRollback([dlqOp, qOp], state, 'S', ctx);
    expect(del.mock.calls.map((c) => (c as unknown[])[0])).not.toContain('Q');
    expect(state['Q']!.physicalId).toBe('q-new');
    expect(result.failures).toBeGreaterThanOrEqual(1);
  });
});
