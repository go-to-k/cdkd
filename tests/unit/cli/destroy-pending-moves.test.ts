/**
 * Issue go-to-k/cdkd#5212: an unfinished `cdkd refactor` leaves
 * `StackState.pendingMovesOut` on the SOURCE stack while the moving
 * resource's record is still in `resources`. `runDestroyForStack` must refuse
 * before any provider delete and before `deleteState` — the destination may
 * already hold the resource, so deleting it here could delete another
 * stack's resource. Two call sites: the top-level entry read (above the
 * delete loop) and the empty-stack fast path's under-lock `recheck`.
 *
 * Harness reused from `destroy-runner-malformed-entries.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/logger.js')>();
  const quiet = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    setLevel: vi.fn(),
    child: (): unknown => quiet,
  };
  return { ...actual, getLogger: () => quiet };
});
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(() => ({ getProviderFor: vi.fn() })),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(() => ({ destroy: vi.fn() })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));
vi.mock('../../../src/utils/live-renderer.js', () => {
  const renderer = {
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  };
  return { getLiveRenderer: () => renderer };
});

import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';
import { CdkdError } from '../../../src/utils/error-handler.js';
import { resetRefactorMarkerReadsForTest } from '../../../src/state/refactor-marker.js';

const REGION = 'us-east-1';
const STACK = 'TestStack';

const RES_A = { physicalId: 'p-a', resourceType: 'AWS::SSM::Parameter', properties: {} };
const RES_B = { physicalId: 'p-b', resourceType: 'AWS::SSM::Parameter', properties: {} };

const PENDING_MOVE = {
  from: 'Moving',
  toStack: 'D',
  toRegion: REGION,
  to: 'Moved',
  startedAt: 1,
};

function stateWith(resources: unknown, extra: Record<string, unknown> = {}): StackState {
  return {
    version: 13,
    stackName: STACK,
    region: REGION,
    resources: resources as StackState['resources'],
    outputs: {},
    lastModified: 1,
    ...extra,
  };
}

function makeCtx() {
  const deleteState = vi.fn().mockResolvedValue(undefined);
  const acquireLock = vi.fn().mockResolvedValue(true);
  const releaseLock = vi.fn().mockResolvedValue(undefined);
  const getProviderFor = vi.fn();
  return {
    deleteState,
    acquireLock,
    releaseLock,
    getProviderFor,
    ctx: {
      stateBackend: {
        getState: vi.fn().mockResolvedValue(null),
        deleteState,
        saveState: vi.fn(),
        listStacks: vi.fn().mockResolvedValue([]),
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock,
        releaseLock,
        getLockInfo: vi.fn().mockResolvedValue(null),
      } as unknown as LockManager,
      providerRegistry: { getProviderFor } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
    } as unknown as Parameters<typeof runDestroyForStack>[2],
  };
}

describe('runDestroyForStack refuses an unfinished cdkd refactor move (go-to-k/cdkd#5212)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRefactorMarkerReadsForTest();
  });

  it('refuses with REFACTOR_UNFINISHED, naming cdkd destroy, and touches nothing', async () => {
    const h = makeCtx();
    const state = stateWith(
      { A: RES_A, B: RES_B },
      { pendingMovesOut: [PENDING_MOVE] }
    );

    const thrown = await runDestroyForStack(STACK, state, h.ctx).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(CdkdError);
    const err = thrown as CdkdError;
    expect(err.code).toBe('REFACTOR_UNFINISHED');
    expect(err.message).toContain('cdkd destroy');
    expect(h.getProviderFor, 'no provider delete must be chosen').not.toHaveBeenCalled();
    expect(h.deleteState, 'the record must not be removed').not.toHaveBeenCalled();
  });

  it('refuses when the shared marker (not the record) lists a move whose destination is this stack', async () => {
    const h = makeCtx();
    const state = stateWith({ A: RES_A, B: RES_B });
    // Under-lock re-read (#5220): the record itself did not change, only the
    // shared marker this case is about -- it must not pre-empt that refusal.
    (h.ctx.stateBackend.getState as ReturnType<typeof vi.fn>).mockResolvedValue({
      state,
      etag: 'e',
    });
    (h.ctx.stateBackend as unknown as Record<string, unknown>)['refactorMarkerKey'] = () =>
      'cdkd/_refactor/pending.json';
    (h.ctx.stateBackend as unknown as Record<string, unknown>)['getRefactorMarker'] = vi
      .fn()
      .mockResolvedValue({
        body: {
          moves: [
            {
              fromStack: 'Src',
              fromRegion: REGION,
              from: 'X',
              toStack: STACK,
              toRegion: REGION,
              to: 'Moved',
              startedAt: 1,
            },
          ],
        },
        etag: '"e"',
      });

    const thrown = await runDestroyForStack(STACK, state, h.ctx).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(CdkdError);
    const err = thrown as CdkdError;
    expect(err.code).toBe('REFACTOR_UNFINISHED');
    expect(h.getProviderFor, 'no provider delete must be chosen').not.toHaveBeenCalled();
    expect(h.deleteState, 'the record must not be removed').not.toHaveBeenCalled();
    // The refusal runs under the lock, which it must release.
    expect(h.releaseLock).toHaveBeenCalledWith(STACK, REGION);
  });

  it('CONTROL: the same record minus pendingMovesOut destroys normally', async () => {
    const h = makeCtx();
    const state = stateWith({ A: RES_A, B: RES_B });
    (h.ctx.stateBackend.getState as ReturnType<typeof vi.fn>).mockResolvedValue({
      state,
      etag: 'e',
    });

    await runDestroyForStack(STACK, state, h.ctx).catch(() => undefined);

    expect(h.getProviderFor, 'a healthy record reaches the delete path').toHaveBeenCalled();
  });

  it('refuses via the empty-stack fast path when the under-lock recheck record carries the field', async () => {
    const h = makeCtx();
    // The pre-lock snapshot is empty, so the run takes the fast path; the
    // re-read under the lock is where the pending move now shows up (a
    // concurrent `cdkd refactor` wrote it between the entry read and the
    // lock acquire).
    (h.ctx.stateBackend.getState as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: stateWith({}, { pendingMovesOut: [PENDING_MOVE] }),
      etag: 'e',
    });

    const thrown = await runDestroyForStack(STACK, stateWith({}), h.ctx).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(CdkdError);
    const err = thrown as CdkdError;
    expect(err.code).toBe('REFACTOR_UNFINISHED');
    expect(err.message).toContain('cdkd destroy');
    expect(h.deleteState, 'the record must not be removed').not.toHaveBeenCalled();
    // The lock was taken (and must be released) to reach the recheck at all.
    expect(h.acquireLock).toHaveBeenCalled();
    expect(h.releaseLock).toHaveBeenCalledWith(STACK, REGION);
  });

  it('refuses to destroy an EMPTY stack a listed move targets, keeping its record', async () => {
    const h = makeCtx();
    (h.ctx.stateBackend.getState as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: stateWith({}),
      etag: 'e',
    });
    (h.ctx.stateBackend as unknown as Record<string, unknown>)['refactorMarkerKey'] = () =>
      'cdkd/_refactor/pending.json';
    (h.ctx.stateBackend as unknown as Record<string, unknown>)['getRefactorMarker'] = vi
      .fn()
      .mockResolvedValue({
        body: {
          moves: [
            { fromStack: 'Src', fromRegion: REGION, from: 'X', toStack: STACK, toRegion: REGION, to: 'Moved', startedAt: 1 },
          ],
        },
        etag: '"m"',
      });

    const thrown = await runDestroyForStack(STACK, stateWith({}), h.ctx).catch((e: unknown) => e);

    expect((thrown as CdkdError).code).toBe('REFACTOR_UNFINISHED');
    expect(h.deleteState, 'the destination record must survive').not.toHaveBeenCalled();
    expect(h.releaseLock).toHaveBeenCalledWith(STACK, REGION);
  });
});
