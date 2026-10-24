/**
 * Issue go-to-k/cdkd#5220: `runDestroyForStack` re-reads the stack's record
 * under its lock and refuses (`STATE_CHANGED`, nothing deleted) unless the
 * record still names every resource the pre-prompt snapshot names under the
 * same ids -- another command may have written it while the confirmation
 * prompt waited. Harness from `destroy-pending-moves.test.ts`.
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

import { holdsSameResourcesAs, runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';
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

describe('runDestroyForStack re-reads its record under the lock (go-to-k/cdkd#5220)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRefactorMarkerReadsForTest();
  });

  async function destroyWith(snapshot: StackState, current: StackState | null) {
    const h = makeCtx();
    (h.ctx.stateBackend.getState as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      current === null ? null : { state: current, etag: 'e' }
    );
    const thrown = await runDestroyForStack(STACK, snapshot, h.ctx).catch((e: unknown) => e);
    return { h, thrown };
  }

  it.each([
    ['a resource gone from the record (moved to another stack)', stateWith({ A: RES_A })],
    ['a resource re-pointed to another physical id (replaced)', stateWith({ A: RES_A, B: { ...RES_B, physicalId: 'p-b2' } })],
    ['a resource ADDED since (the record would be deleted with it)', stateWith({ A: RES_A, B: RES_B, C: { ...RES_A, physicalId: 'p-c' } })],
    ['a resource whose deletion policy changed in place', stateWith({ A: RES_A, B: { ...RES_B, deletionPolicy: 'Retain' } })],
    ['a superseded resource added since', stateWith({ A: RES_A, B: RES_B }, { supersededResources: [{ logicalId: 'B', physicalId: 'p-old', resourceType: 'AWS::SSM::Parameter' }] })],
    ['the record deleted', null],
  ])('refuses when the record shows %s, deleting nothing', async (_label, current) => {
    const { h, thrown } = await destroyWith(stateWith({ A: RES_A, B: RES_B }), current);
    expect(thrown).toBeInstanceOf(CdkdError);
    expect((thrown as CdkdError).code).toBe('STATE_CHANGED');
    expect(h.getProviderFor, 'no provider delete must be chosen').not.toHaveBeenCalled();
    expect(h.deleteState).not.toHaveBeenCalled();
    expect(h.releaseLock).toHaveBeenCalledWith(STACK, REGION);
  });

  it('refuses termination protection a deploy turned on while the prompt waited (go-to-k/cdkd#5238)', async () => {
    const { h, thrown } = await destroyWith(
      stateWith({ A: RES_A, B: RES_B }),
      stateWith({ A: RES_A, B: RES_B }, { terminationProtection: true })
    );
    expect((thrown as CdkdError).code).toBe('STACK_TERMINATION_PROTECTION');
    expect(h.getProviderFor).not.toHaveBeenCalled();
    expect(h.deleteState).not.toHaveBeenCalled();
    expect(h.releaseLock).toHaveBeenCalledWith(STACK, REGION);
  });

  it('CONTROL: with --remove-protection that protection does not stop it', async () => {
    const h = makeCtx();
    (h.ctx as unknown as { removeProtection: boolean }).removeProtection = true;
    (h.ctx.stateBackend.getState as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: stateWith({ A: RES_A, B: RES_B }, { terminationProtection: true }),
      etag: 'e',
    });
    await runDestroyForStack(STACK, stateWith({ A: RES_A, B: RES_B }), h.ctx).catch(() => undefined);
    expect(h.getProviderFor, 'the destroy reaches the delete path').toHaveBeenCalled();
  });

  it('refuses a source mark that appeared while the prompt waited', async () => {
    const { h, thrown } = await destroyWith(
      stateWith({ A: RES_A, B: RES_B }),
      stateWith({ A: RES_A, B: RES_B }, { pendingMovesOut: [{ from: 'B', toStack: 'D', toRegion: REGION, to: 'X', startedAt: 1 }] })
    );
    expect((thrown as CdkdError).code).toBe('REFACTOR_UNFINISHED');
    expect(h.getProviderFor).not.toHaveBeenCalled();
  });

  it('CONTROL: the same record, read again as a fresh copy, destroys', async () => {
    const { h, thrown } = await destroyWith(
      stateWith({ A: RES_A, B: RES_B }),
      structuredClone(stateWith({ A: RES_A, B: RES_B }, { lastModified: 2 }))
    );
    expect((thrown as CdkdError | undefined)?.code).not.toBe('STATE_CHANGED');
    expect(h.getProviderFor, 'the destroy reaches the delete path').toHaveBeenCalled();
  });
});

describe('holdsSameResourcesAs', () => {
  it('holds for an equal copy in any key order, and fails on any added, removed or changed row', () => {
    const snap = stateWith({ A: RES_A, B: RES_B });
    expect(holdsSameResourcesAs(snap, stateWith({ B: { ...RES_B }, A: { ...RES_A } }))).toBe(true);
    expect(holdsSameResourcesAs(snap, stateWith({ A: RES_A, B: RES_B, C: RES_A }))).toBe(false);
    expect(holdsSameResourcesAs(snap, stateWith({ A: RES_A }))).toBe(false);
    expect(holdsSameResourcesAs(snap, stateWith({ A: RES_A, B: { ...RES_B, physicalId: 'x' } }))).toBe(false);
    expect(holdsSameResourcesAs(snap, stateWith({ A: RES_A, B: { ...RES_B, properties: { V: 1 } } }))).toBe(false);
    expect(holdsSameResourcesAs(snap, stateWith({ A: RES_A, B: null }))).toBe(false);
  });

  it('compares supersededResources too, and ignores fields the delete does not act on', () => {
    const snap = stateWith({ A: RES_A });
    expect(holdsSameResourcesAs(snap, stateWith({ A: RES_A }, { supersededResources: [] }))).toBe(false);
    expect(holdsSameResourcesAs(snap, stateWith({ A: RES_A }, { lastModified: 9, outputs: { O: 'v' } }))).toBe(true);
  });
});
