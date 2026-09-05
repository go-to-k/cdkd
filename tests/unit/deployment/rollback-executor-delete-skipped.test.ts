/**
 * Rollback-executor consumption of `{ outcome: 'skipped' }` (issue
 * https://github.com/go-to-k/cdkd/issues/1762).
 *
 * A rollback delete that the provider refused to issue is a rollback op that
 * did NOT happen. Before #1762 every arm read it as a successful revert:
 * `delete stateResources[op.logicalId]` ran, `ROLLBACK_RESOURCE_SUCCEEDED` was
 * emitted, `failures` stayed 0 — so the journal segment popped and `cdkd
 * rollback` reported a clean revert over a resource that is still alive.
 *
 * Each case here fails against pre-#1762 code, because the skip is a plain
 * resolved value the old arms walked straight past.
 */

import { describe, it, expect, vi } from 'vite-plus/test';
import {
  replayRollback,
  replayFailedOperations,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import type { ResourceState } from '../../../src/types/state.js';
import type { ResourceDeleteResult } from '../../../src/types/resource.js';

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const SKIP: ResourceDeleteResult = {
  outcome: 'skipped',
  reason: 'malformed physicalId in state — no delete issued',
};

function res(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys',
    resourceType: 'AWS::S3::Bucket',
    properties: {},
    attributes: {},
    dependencies: [],
    ...overrides,
  };
}

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setLevel: vi.fn(),
  child: () => silentLogger,
} as unknown as RollbackExecutorContext['logger'];

function makeCtx(provider: { delete?: unknown; create?: unknown }): {
  ctx: RollbackExecutorContext;
  events: string[];
} {
  const events: string[] = [];
  const ctx: RollbackExecutorContext = {
    region: 'us-east-1',
    logger: silentLogger,
    providerRegistry: {
      getProviderFor: () => ({ provider }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
    recordEvent: (e) => events.push(e.eventType),
  };
  return { ctx, events };
}

describe('rollback executor — a provider-reported delete skip (#1762)', () => {
  it('rollback-of-a-CREATE: counted as a failure, state record KEPT', async () => {
    const del = vi.fn().mockResolvedValue(SKIP);
    const { ctx, events } = makeCtx({ delete: del });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'B',
        changeType: 'CREATE',
        resourceType: 'AWS::S3::Bucket',
        physicalId: 'phys-B',
      },
    ];
    const state: Record<string, ResourceState> = { B: res({ physicalId: 'phys-B' }) };

    const result = await replayRollback(ops, state, 'S', ctx);

    expect(del).toHaveBeenCalledOnce();
    // A failure (not a warning): failures BLOCK the journal-segment pop, so
    // the user can re-run `cdkd rollback` once the state record is repaired.
    expect(result.failures).toBe(1);
    // The resource is still in AWS — dropping the record would leave it
    // untracked, which is the deploy-side half of the same data loss.
    expect(state['B']).toBeDefined();
    expect(events).toContain('ROLLBACK_RESOURCE_FAILED');
    expect(events).not.toContain('ROLLBACK_RESOURCE_SUCCEEDED');
  });

  it('control: a `void` return still reverts the CREATE and drops the record', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx, events } = makeCtx({ delete: del });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'B',
        changeType: 'CREATE',
        resourceType: 'AWS::S3::Bucket',
        physicalId: 'phys-B',
      },
    ];
    const state: Record<string, ResourceState> = { B: res({ physicalId: 'phys-B' }) };

    const result = await replayRollback(ops, state, 'S', ctx);

    expect(result.failures).toBe(0);
    expect(state['B']).toBeUndefined();
    expect(events).toContain('ROLLBACK_RESOURCE_SUCCEEDED');
  });

  it('reverse-replacement re-adopt: the state re-point does NOT happen on a skip', async () => {
    // `UpdateReplacePolicy: Retain` orphaned the OLD resource, so the revert
    // is "delete the new one, re-adopt the old". A skip that still re-pointed
    // state would leave TWO live resources with state describing one.
    const del = vi.fn().mockResolvedValue(SKIP);
    const { ctx } = makeCtx({ delete: del });
    const prev = res({ physicalId: 'old-b', updateReplacePolicy: 'Retain' as const });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'B',
        changeType: 'UPDATE',
        resourceType: 'AWS::S3::Bucket',
        physicalId: 'new-b',
        previousState: prev,
        // The FIELD a current binary stamps (issue #2603) -- without it this
        // case reached the readopt arm through the pre-#2603 previous-state
        // FALLBACK, so it pinned the legacy path rather than the one every new
        // journal takes. The COMBINATION is still hand-edited, deliberately:
        // the current record below omits `updateReplacePolicy: 'Retain'`,
        // which a current binary would always co-stamp from the same template
        // read, and omitting it is what keeps the delete being ISSUED so this
        // case can pin the provider-reported SKIP it exists for.
        oldResourceRetained: true,
      },
    ];
    // NO `updateReplacePolicy` on the CURRENT record, deliberately since issue
    // #2598: the two records now answer two DIFFERENT questions. `prev`'s
    // policy is about the OLD resource (it is why this op re-adopts rather
    // than re-creates); `current`'s is about the NEW copy, and a `Retain`
    // there makes the executor SKIP this delete on purpose — which would take
    // the case away from the provider-reported skip it exists to pin.
    const current = res({ physicalId: 'new-b' });
    const state: Record<string, ResourceState> = { B: current };

    const result = await replayRollback(ops, state, 'S', ctx);

    expect(result.failures).toBe(1);
    expect(state['B']).toBe(current);
    expect(state['B']?.physicalId).toBe('new-b');
  });

  it('reverse-replacement delete-new-first: the collision path fails the op', async () => {
    // Reached when the create-first re-create COLLIDES with the new resource's
    // name: the executor deletes the new resource to release it, then retries.
    // A skip there means the retry collides again, so the op must fail now.
    const del = vi.fn().mockResolvedValue(SKIP);
    const create = vi
      .fn()
      .mockRejectedValue(new Error("Resource of type 'AWS::S3::Bucket' already exists."));
    const { ctx } = makeCtx({ delete: del, create });
    const prev = res({ physicalId: 'old-b', properties: { a: 1 } });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'B',
        changeType: 'UPDATE',
        resourceType: 'AWS::S3::Bucket',
        physicalId: 'new-b',
        previousState: prev,
      },
    ];
    const state: Record<string, ResourceState> = { B: res({ physicalId: 'new-b' }) };

    const result = await replayRollback(ops, state, 'S', ctx);

    expect(del).toHaveBeenCalledOnce();
    expect(result.failures).toBe(1);
    // The DISCRIMINATOR: `failures === 1` alone is satisfied by the create
    // rejection itself, so it would pass with a clean delete too. What the
    // skip changes is that the post-delete RETRY never runs — a clean delete
    // releases the name and the executor creates again.
    expect(create).toHaveBeenCalledTimes(1);
    // The state record still names the NEW resource — the revert did not happen.
    expect(state['B']?.physicalId).toBe('new-b');
  });

  it('reverse-replacement delete-new AFTER the re-create: a WARNING, not a failure', async () => {
    // The one arm whose policy diverges, and the reason it needs its own case:
    // the old resource is already re-created and state already points at it,
    // so the revert SUCCEEDED. A skip here only leaks the new resource, which
    // is the same outcome that arm's pre-existing catch gives a failed delete —
    // hence `warnings`, a kept `ROLLBACK_RESOURCE_SUCCEEDED`, and a POPPED
    // journal segment (`cdkd rollback` exits 2 but does not re-attempt).
    const del = vi.fn().mockResolvedValue(SKIP);
    const create = vi.fn().mockResolvedValue({ physicalId: 'old-b', attributes: {} });
    const { ctx, events } = makeCtx({ delete: del, create });
    const prev = res({ physicalId: 'old-b', properties: { a: 1 } });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'B',
        changeType: 'UPDATE',
        resourceType: 'AWS::S3::Bucket',
        physicalId: 'new-b',
        previousState: prev,
      },
    ];
    const state: Record<string, ResourceState> = { B: res({ physicalId: 'new-b' }) };

    const result = await replayRollback(ops, state, 'S', ctx);

    expect(create).toHaveBeenCalledOnce();
    expect(del).toHaveBeenCalledOnce();
    expect(result.failures).toBe(0);
    expect(result.warnings).toBe(1);
    expect(events).toContain('ROLLBACK_RESOURCE_SUCCEEDED');
    // The revert itself stands: state names the re-created OLD resource.
    expect(state['B']?.physicalId).toBe('old-b');
  });

  it('--revert-failed partially-created delete: the op stays outstanding', async () => {
    const del = vi.fn().mockResolvedValue(SKIP);
    const { ctx } = makeCtx({ delete: del });
    const failed: FailedOperation[] = [
      {
        logicalId: 'B',
        changeType: 'CREATE',
        resourceType: 'AWS::S3::Bucket',
        physicalId: 'phys-B',
        attemptedProperties: {},
      },
    ];
    const state: Record<string, ResourceState> = { B: res({ physicalId: 'phys-B' }) };

    const result = await replayFailedOperations(failed, state, 'S', ctx, {});

    expect(result.failures).toBe(1);
    // Kept for a re-run: a successfully-reverted op must never be re-issued,
    // and an unreverted one must never be dropped.
    expect(result.remainingFailedOps.map((op) => op.logicalId)).toEqual(['B']);
    expect(state['B']).toBeDefined();
  });
});
