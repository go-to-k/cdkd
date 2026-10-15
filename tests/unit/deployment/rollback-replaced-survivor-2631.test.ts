/**
 * go-to-k/cdkd#2631: the reverse replacement of an op journaled
 * `oldResourceMaySurvive: true` reads AWS for the old resource before it
 * re-creates it: still there, it is re-adopted (no duplicate, no collision);
 * reported gone, it is re-created; unreadable, the op is refused with the
 * journal kept and nothing sent. An op without the flag sends no read.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';
import {
  probeReplacedSurvivor,
  replacedDeleteFailureVerdict,
} from '../../../src/deployment/rollback-executor/replaced-survivor.js';
import { PASTE_PAYLOADS, expectNoCommandBesideDisplay } from '../utils/paste-harness.js';

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ tag: 'process-global' }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const TYPE = 'AWS::SNS::Topic';

function rec(physicalId: string, overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId,
    resourceType: TYPE,
    properties: { DisplayName: physicalId === 'topic-old' ? 'old' : 'new' },
    attributes: {},
    dependencies: [],
    provisionedBy: 'sdk',
    ...overrides,
  };
}

function op(extra: Partial<CompletedOperation> = {}): CompletedOperation {
  return {
    logicalId: 'Topic',
    changeType: 'UPDATE',
    resourceType: TYPE,
    provisionedBy: 'sdk',
    physicalId: 'topic-new',
    previousState: rec('topic-old', { provisionedBy: 'cc-api' }),
    oldResourceRetained: false,
    oldResourceMaySurvive: 'kept',
    ...extra,
  };
}

describe('reverse replacement of an old resource that may survive (#2631)', () => {
  let live: Set<string>;
  let read: ReturnType<typeof vi.fn>;
  let provider: Record<string, unknown> & {
    create: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let routed: Array<{ resourceType: string; provisionedBy?: string }>;
  let warns: string[];
  let infos: string[];
  let ctx: RollbackExecutorContext;

  beforeEach(() => {
    live = new Set(['topic-old', 'topic-new']);
    read = vi.fn(async (physicalId: string) =>
      live.has(physicalId) ? { DisplayName: 'old' } : RESOURCE_NOT_FOUND
    );
    provider = {
      create: vi.fn(async () => {
        live.add('topic-old-2');
        return { physicalId: 'topic-old-2', attributes: {} };
      }),
      delete: vi.fn(async (_l: string, physicalId: string) => {
        live.delete(physicalId);
      }),
      readCurrentState: read,
    };
    routed = [];
    warns = [];
    infos = [];
    const logger = {
      debug: vi.fn(),
      info: vi.fn((m: string) => infos.push(m)),
      warn: vi.fn((m: string) => warns.push(m)),
      error: vi.fn(),
      setLevel: vi.fn(),
      child: () => logger,
    } as unknown as RollbackExecutorContext['logger'];
    ctx = {
      region: 'us-east-1',
      logger,
      providerRegistry: {
        getProviderFor: (r: { resourceType: string; provisionedBy?: string }) => {
          routed.push(r);
          return { provider, provisionedBy: r.provisionedBy ?? 'sdk' };
        },
      } as unknown as RollbackExecutorContext['providerRegistry'],
    };
  });

  const state = (): Record<string, ResourceState> => ({ Topic: rec('topic-new') });

  it('re-adopts a survivor: deletes the new copy, no re-create, state names the old one', async () => {
    const s = state();
    const result = await replayRollback([op()], s, 'S', ctx);

    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![0]).toBe('topic-old');
    // Read through the OLD record's route.
    expect(routed[0]).toEqual({ resourceType: TYPE, provisionedBy: 'cc-api' });
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(provider.delete.mock.calls[0]![1]).toBe('topic-new');
    expect([...live]).toEqual(['topic-old']);
    expect(s['Topic']!.physicalId).toBe('topic-old');
    expect(result.failures).toBe(0);
    expect(result.warnings).toBe(1);
    expect(warns.join('\n')).toContain(
      'the old resource of Topic (topic-old) still exists — the deploy\'s delete of it was not confirmed — so it is re-adopted instead of re-created'
    );
  });

  it('records the re-adopt reason on the success event and names the old resource surviving', async () => {
    const events: Array<Record<string, unknown>> = [];
    ctx.recordEvent = (e) => events.push(e as Record<string, unknown>);
    await replayRollback([op()], state(), 'S', ctx);
    const ok = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED');
    expect(ok?.reason).toContain('re-adopted instead of re-created');
    expect(ok?.reason).toContain('check it with cdkd drift');
    // The deleted new copy's id does not ride as a survivor.
    expect(ok && 'physicalId' in ok).toBe(false);
    expect(infos.join('\n')).toContain('Rollback: Topic restored to the surviving old resource');
    expect(infos.join('\n')).not.toContain('retained old');
  });

  it('records both reasons when the new copy is itself retained', async () => {
    const events: Array<Record<string, unknown>> = [];
    ctx.recordEvent = (e) => events.push(e as Record<string, unknown>);
    await replayRollback([op()], { Topic: rec('topic-new', { updateReplacePolicy: 'Retain' }) }, 'S', ctx);
    const ok = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED');
    expect(ok?.physicalId).toBe('topic-new');
    expect(String(ok?.reason)).toMatch(/; the old resource survived a delete/);
  });

  it('re-creates an old resource AWS reports gone, as before', async () => {
    live.delete('topic-old');
    const s = state();
    const result = await replayRollback([op()], s, 'S', ctx);

    expect(read).toHaveBeenCalledTimes(1);
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(s['Topic']!.physicalId).toBe('topic-old-2');
    expect(live.has('topic-new')).toBe(false);
    expect(result.failures).toBe(0);
    expect(result.warnings).toBe(0);
    expect(infos.join('\n')).toContain('the old resource of Topic (topic-old) is gone — re-creating it');
  });

  it('sends no read for an op without the flag (an ordinary reverse replacement)', async () => {
    const s = state();
    await replayRollback([op({ oldResourceMaySurvive: undefined })], s, 'S', ctx);
    expect(read).not.toHaveBeenCalled();
    expect(provider.create).toHaveBeenCalledTimes(1);
  });

  const refusalCases: Array<[string, () => void, string]> = [
    [
      'the provider has no read',
      () => {
        delete provider['readCurrentState'];
      },
      'cdkd has no read for this resource type that can tell whether it does.',
    ],
    [
      'the read answers an empty bag',
      () => {
        read.mockResolvedValue({});
      },
      'cdkd has no read for this resource type that can tell whether it does.',
    ],
    [
      'the read answers undefined',
      () => {
        read.mockResolvedValue(undefined);
      },
      'cdkd has no read for this resource type that can tell whether it does.',
    ],
    [
      'the read answers a non-object',
      () => {
        read.mockResolvedValue(['DisplayName']);
      },
      'cdkd could not read whether it does',
    ],
    [
      'the old type cannot be routed for the read',
      () => {
        const route = ctx.providerRegistry.getProviderFor;
        let calls = 0;
        (ctx.providerRegistry as unknown as { getProviderFor: unknown }).getProviderFor = (
          r: never
        ) => {
          if (++calls === 1) throw new Error('no provider for this type');
          return route(r);
        };
      },
      'cdkd could not read whether it does',
    ],
    [
      'the read throws',
      () => {
        read.mockRejectedValue(new Error('AccessDenied'));
      },
      'cdkd could not read whether it does (the read failed or did not answer in time); re-running cdkd rollback reads it again.',
    ],
  ];
  for (const [name, arrange, why] of refusalCases) {
    it(`refuses, sending nothing, when ${name}`, async () => {
      arrange();
      const s = state();
      const failed: Array<Record<string, unknown>> = [];
      ctx.recordEvent = (e) => {
        if (e.eventType === 'ROLLBACK_RESOURCE_FAILED') failed.push(e as Record<string, unknown>);
      };
      const result = await replayRollback([op()], s, 'S', ctx);

      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.delete).not.toHaveBeenCalled();
      expect(s['Topic']!.physicalId).toBe('topic-new');
      expect(result.failures).toBe(1);
      const text = warns.join('\n');
      expect(text).toContain(
        'Cannot reverse the replacement of Topic (AWS::SNS::Topic): the deploy did not confirm that it deleted the old resource (topic-old), so it may still exist, and ' +
          why
      );
      expect(text).toContain('Nothing was sent and the journal is kept.');
      expect(text).toContain('--orphan Topic');
      expect(failed).toHaveLength(1);
    });
  }

  // Both lines name a `cdkd` command, so a non-plain old id is described.
  for (const payload of PASTE_PAYLOADS) {
    it(`shows no ${payload.label} old id beside a command, on the re-adopt and refusal lines`, async () => {
      const prev = rec(payload.value, { provisionedBy: 'cc-api' });
      live.add(payload.value);
      await replayRollback([op({ previousState: prev })], state(), 'S', ctx);
      read.mockRejectedValue(new Error('AccessDenied'));
      await replayRollback([op({ previousState: prev })], state(), 'S', ctx);
      const survivorLines = warns.filter((w) => w.includes('the old resource') || w.includes('old resource ('));
      expect(survivorLines.length).toBeGreaterThanOrEqual(2);
      for (const line of survivorLines) expectNoCommandBesideDisplay(line, payload.value);
    });
  }

  it('refuses, naming the interruption, when the rollback is interrupted during the read', async () => {
    let interrupted = false;
    read.mockImplementation(
      () =>
        new Promise(() => {
          interrupted = true;
        })
    );
    const s = state();
    const result = await replayRollback([op()], s, 'S', ctx, { isInterrupted: () => interrupted });
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
    expect(s['Topic']!.physicalId).toBe('topic-new');
    expect(result.failures).toBe(1);
    expect(warns.join('\n')).toContain(
      'the rollback was interrupted before cdkd could read whether it does'
    );
  });

  it('refuses an alive old resource whose delete may still be running, sending nothing', async () => {
    const s = state();
    const result = await replayRollback([op({ oldResourceMaySurvive: 'unconfirmed' })], s, 'S', ctx);
    expect(read).toHaveBeenCalledTimes(1);
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
    expect(s['Topic']!.physicalId).toBe('topic-new');
    expect(result.failures).toBe(1);
    expect(warns.join('\n')).toContain(
      'so it may still exist, and AWS still reports it, but the failed delete may have been accepted and still be running.'
    );
  });

  it('re-creates an unconfirmed old resource AWS reports gone', async () => {
    live.delete('topic-old');
    const s = state();
    const result = await replayRollback([op({ oldResourceMaySurvive: 'unconfirmed' })], s, 'S', ctx);
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(s['Topic']!.physicalId).toBe('topic-old-2');
    expect(result.failures).toBe(0);
  });

  it('names no id, rather than "undefined", when the old record has none', async () => {
    const result = await replayRollback(
      [op({ previousState: { ...rec('topic-old', { provisionedBy: 'cc-api' }), physicalId: '' } })],
      state(),
      'S',
      ctx
    );
    expect(result.failures).toBe(1);
    const text = warns.join('\n');
    expect(text).toContain('deleted the old resource (no recorded id)');
    expect(text).not.toContain('(undefined)');
  });

  it('reads a Type-changed old resource through its OLD type', async () => {
    const OLD = 'AWS::SNS::OldTopic';
    const s = state();
    const result = await replayRollback(
      [op({ previousResourceType: OLD, previousState: rec('topic-old', { provisionedBy: 'cc-api', resourceType: OLD }) })],
      s,
      'S',
      ctx
    );
    expect(routed[0]).toEqual({ resourceType: OLD, provisionedBy: 'cc-api' });
    expect(read.mock.calls[0]![2]).toBe(OLD);
    // The readopt deletes the NEW copy through the new type.
    expect(routed.some((r) => r.resourceType === TYPE)).toBe(true);
    expect(provider.delete.mock.calls[0]![2]).toBe(TYPE);
    expect(s['Topic']!.resourceType).toBe(OLD);
    expect(result.failures).toBe(0);
  });

  it('re-adopts without deleting a new copy that is itself retained', async () => {
    const s = { Topic: rec('topic-new', { updateReplacePolicy: 'Retain' }) };
    const result = await replayRollback([op()], s, 'S', ctx);
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
    expect(s['Topic']!.physicalId).toBe('topic-old');
    expect(result.failures).toBe(0);
  });
});

describe('probeReplacedSurvivor', () => {
  const scope = (provider: unknown, isInterrupted?: () => boolean) => ({
    op: op(),
    ctx: {
      region: 'us-east-1',
      logger: {} as never,
      providerRegistry: { getProviderFor: () => ({ provider }) } as never,
    },
    secrets: new Map(),
    isInterrupted,
  });

  it('sends no read once the rollback is interrupted', async () => {
    const readCurrentState = vi.fn();
    expect(await probeReplacedSurvivor(scope({ readCurrentState }, () => true), TYPE)).toBe(
      'interrupted'
    );
    expect(readCurrentState).not.toHaveBeenCalled();
  });

  it('stops waiting for a read when the rollback is interrupted mid-read', async () => {
    let interrupted = false;
    const provider = { readCurrentState: () => new Promise(() => undefined) };
    const started = Date.now();
    const pending = probeReplacedSurvivor(scope(provider, () => interrupted), TYPE, 60_000);
    setTimeout(() => {
      interrupted = true;
    }, 50);
    expect(await pending).toBe('interrupted');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('leaves no timer or interrupt poll behind once the read answers', async () => {
    vi.useFakeTimers();
    try {
      const provider = { readCurrentState: async () => ({ DisplayName: 'old' }) };
      expect(await probeReplacedSurvivor(scope(provider, () => false), TYPE)).toBe('exists');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers unknown when the read does not answer in time', async () => {
    const provider = { readCurrentState: () => new Promise(() => undefined) };
    const verdict = await probeReplacedSurvivor(
      {
        op: op(),
        ctx: {
          region: 'us-east-1',
          logger: {} as never,
          providerRegistry: { getProviderFor: () => ({ provider }) } as never,
        },
        secrets: new Map(),
        isInterrupted: undefined,
      },
      TYPE,
      5
    );
    expect(verdict).toBe('unknown');
  });

  it('answers unknown for an old record with no usable physical id, without routing', async () => {
    const getProviderFor = vi.fn();
    const verdict = await probeReplacedSurvivor(
      {
        op: op({ previousState: rec('', { provisionedBy: 'cc-api' }) }),
        ctx: {
          region: 'us-east-1',
          logger: {} as never,
          providerRegistry: { getProviderFor } as never,
        },
        secrets: new Map(),
        isInterrupted: undefined,
      },
      TYPE
    );
    expect(verdict).toBe('unknown');
    expect(getProviderFor).not.toHaveBeenCalled();
  });
});

describe('replacedDeleteFailureVerdict', () => {
  const named = (name: string, extra: Record<string, unknown> = {}): Error =>
    Object.assign(new Error('x'), { name }, extra);

  it('is kept only for an outright AWS refusal, by name, Code or code, through causes', () => {
    for (const name of ['AccessDenied', 'AccessDeniedException', 'UnauthorizedOperation', 'AuthorizationError', 'DependencyViolation', 'DeleteConflict', 'DeleteConflictException']) {
      expect(replacedDeleteFailureVerdict(named(name))).toBe('kept');
    }
    expect(replacedDeleteFailureVerdict(Object.assign(new Error('x'), { Code: 'AccessDenied' }))).toBe('kept');
    expect(replacedDeleteFailureVerdict(Object.assign(new Error('x'), { code: 'UnauthorizedOperation' }))).toBe('kept');
    expect(
      replacedDeleteFailureVerdict(new Error('wrapped', { cause: new Error('mid', { cause: named('AccessDenied') }) }))
    ).toBe('kept');
  });

  it('is unconfirmed for anything that may leave a delete running', () => {
    expect(replacedDeleteFailureVerdict(new Error('Timed out waiting for DBInstance to be deleted'))).toBe('unconfirmed');
    expect(replacedDeleteFailureVerdict(named('ConflictException'))).toBe('unconfirmed');
    // DynamoDB / Kinesis answer it for a resource already DELETING.
    expect(replacedDeleteFailureVerdict(named('ResourceInUseException'))).toBe('unconfirmed');
    expect(replacedDeleteFailureVerdict(named('ResourceInUse'))).toBe('unconfirmed');
    expect(replacedDeleteFailureVerdict(named('InvalidDBInstanceState'))).toBe('unconfirmed');
    // Read off the NAME, never the message.
    expect(replacedDeleteFailureVerdict(new Error('AccessDenied: in the message only'))).toBe('unconfirmed');
    expect(replacedDeleteFailureVerdict('AccessDenied')).toBe('unconfirmed');
    expect(replacedDeleteFailureVerdict(undefined)).toBe('unconfirmed');
  });
});
