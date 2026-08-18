/**
 * Rollback-executor consumption of `{ outcome: 'partial' }` (issue
 * [#1819](https://github.com/go-to-k/cdkd/issues/1819)) — the UPDATE-side twin
 * of `rollback-executor-delete-skipped.test.ts`.
 *
 * Both of this file's arms were entirely unfenced when the channel landed: the
 * whole partial branch could be deleted from either and the full suite stayed
 * green. That is the same silence the channel exists to end, and a rollback is
 * where it costs most — it runs during an already-failing deploy, so the user
 * is least able to go hunting for an untracked resource.
 *
 * The distinction pinned below: a partial revert is NOT a failure. The resource
 * IS back at its previous state, so `failures` stays 0 and the row still emits
 * `ROLLBACK_RESOURCE_SUCCEEDED` — what is in doubt is the thing the update was
 * supposed to retire, which rides out on `warnings` and the event's `reason`.
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
import type { ResourceUpdateResult } from '../../../src/types/resource.js';

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const PARTIAL_REASON = 'old certificate arn:aws:acm:…:certificate/old is still in use';

const PARTIAL: ResourceUpdateResult = {
  physicalId: 'phys',
  wasReplaced: true,
  outcome: 'partial',
  reason: PARTIAL_REASON,
};

const CLEAN: ResourceUpdateResult = { physicalId: 'phys', wasReplaced: false };

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

const warnings: string[] = [];
const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn((m: string) => warnings.push(String(m))),
  error: vi.fn(),
  setLevel: vi.fn(),
  child: () => silentLogger,
} as unknown as RollbackExecutorContext['logger'];

function makeCtx(provider: { update?: unknown; delete?: unknown; create?: unknown }): {
  ctx: RollbackExecutorContext;
  events: { eventType: string; reason?: string }[];
} {
  const events: { eventType: string; reason?: string }[] = [];
  const ctx: RollbackExecutorContext = {
    region: 'us-east-1',
    logger: silentLogger,
    providerRegistry: {
      getProviderFor: () => ({ provider }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
    recordEvent: (e) => events.push(e as { eventType: string; reason?: string }),
  };
  return { ctx, events };
}

// The previous properties must DIFFER from the live ones, or the revert arm
// short-circuits (nothing to restore) and `update()` is never called at all.
function updateOp(): CompletedOperation[] {
  return [
    {
      logicalId: 'B',
      changeType: 'UPDATE',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'phys',
      previousState: res({ properties: { Versioning: 'Enabled' } }),
    } as unknown as CompletedOperation,
  ];
}

function liveState(): Record<string, ResourceState> {
  return { B: res({ properties: { Versioning: 'Suspended' } }) };
}

describe('rollback executor — a provider-reported partial update (#1819)', () => {
  it('rollback-of-an-UPDATE: still SUCCEEDED, but warned and carried in the event', async () => {
    warnings.length = 0;
    const update = vi.fn().mockResolvedValue(PARTIAL);
    const { ctx, events } = makeCtx({ update });
    const state = liveState();

    const result = await replayRollback(updateOp(), state, 'S', ctx);

    expect(update).toHaveBeenCalledOnce();
    // The revert itself worked — the resource IS back at its previous state,
    // so this must NOT be counted as a failure or the journal segment would
    // stop popping over a rollback that actually happened.
    expect(result.failures).toBe(0);
    expect(events.map((e) => e.eventType)).toContain('ROLLBACK_RESOURCE_SUCCEEDED');
    // ...but the survivor is announced, counted, and DURABLE. A rollback runs
    // during a failing deploy, so the log line is the least likely thing the
    // user still has.
    expect(result.warnings).toBe(1);
    expect(warnings.join('\n')).toContain('partial (');
    expect(warnings.join('\n')).toContain(PARTIAL_REASON);
    expect(events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED')?.reason).toBe(
      PARTIAL_REASON
    );
  });

  it('control: a clean revert warns nothing and records no reason', async () => {
    warnings.length = 0;
    const update = vi.fn().mockResolvedValue(CLEAN);
    const { ctx, events } = makeCtx({ update });
    const state = liveState();

    const result = await replayRollback(updateOp(), state, 'S', ctx);

    expect(result.failures).toBe(0);
    expect(result.warnings).toBe(0);
    expect(warnings.join('\n')).not.toContain('partial (');
    expect(events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED')?.reason).toBeUndefined();
  });

  it('--revert-failed: the FOURTH update() call site reports it too', async () => {
    warnings.length = 0;
    const update = vi.fn().mockResolvedValue(PARTIAL);
    const { ctx, events } = makeCtx({ update });
    const failed: FailedOperation[] = [
      {
        logicalId: 'B',
        changeType: 'UPDATE',
        resourceType: 'AWS::S3::Bucket',
        physicalId: 'phys',
        previousState: res({ properties: { Versioning: 'Enabled' } }),
      } as unknown as FailedOperation,
    ];
    const state = liveState();

    const result = await replayFailedOperations(failed, state, 'S', ctx);

    // This arm was missed entirely when the channel landed, so `cdkd rollback
    // --revert-failed` printed "reverted successfully" over a stranded
    // resource -- on the command a user reaches for when things already broke.
    expect(warnings.join('\n')).toContain('partial (');
    expect(result.warnings).toBe(1);
    expect(events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED')?.reason).toBe(
      PARTIAL_REASON
    );
  });
});
