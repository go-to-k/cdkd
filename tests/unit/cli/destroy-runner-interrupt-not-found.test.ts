import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

/**
 * Issues #2053 / #1952 — a USER ABORT must never be read as "already deleted".
 *
 * `destroy-runner.ts` decides a failed delete means the resource is already
 * gone by SUBSTRING-matching the error message for `not found` / `NoSuchEntity`
 * / `NotFoundException`. An interrupt's message embeds a name the USER chose —
 * `DynamoDB auto-scaling for ${tableName}`, `Custom resource ${logicalId}` — so
 * a logical id containing one of those needles made an interrupted delete read
 * as a success and DROPPED a live resource's state row.
 *
 * The typed `isInterruptedWaitError` check therefore runs AHEAD of the
 * substring match, mirroring the `isFinalSnapshotError` guard already there for
 * the same class of mistake. The substring match cannot be made safe on its
 * own: any needle can appear in a user-chosen name.
 */

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

// Keep the import graph light: the runner only touches these on the
// cross-region path, which these tests never exercise.
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));
vi.mock('../../../src/utils/live-renderer.js', () => ({
  getLiveRenderer: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  }),
}));

import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';
import { InterruptedWaitError } from '../../../src/provisioning/interrupt-watch.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const REGION = 'us-east-1';

/**
 * A logical id carrying the classifier's own needle.
 *
 * Not a contrived name: `HandleNotFoundException` is an ordinary thing to call
 * a construct, and the interrupt message interpolates it verbatim.
 */
const NEEDLE_LOGICAL_ID = 'HandleNotFoundException';

function makeState(logicalId: string): StackState {
  const resource: ResourceState = {
    physicalId: 'phys-id',
    resourceType: 'AWS::DynamoDB::Table',
    properties: {},
    attributes: {},
    dependencies: [],
  };
  return {
    version: 8,
    stackName: 'TestStack',
    region: REGION,
    resources: { [logicalId]: resource },
    outputs: {},
    lastModified: 1,
  };
}

function makeCtx(mockProviderDelete: ReturnType<typeof vi.fn>) {
  const saveState = vi.fn().mockResolvedValue('"etag"');
  const deleteState = vi.fn().mockResolvedValue(undefined);
  return {
    saveState,
    deleteState,
    ctx: {
      stateBackend: {
        saveState,
        deleteState,
        listStacks: vi.fn().mockResolvedValue([]),
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn(),
      } as unknown as LockManager,
      providerRegistry: {
        getProviderFor: () => ({ provider: { delete: mockProviderDelete } }),
      } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
    },
  };
}

describe('an interrupted delete is never read as "already deleted"', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the state row when the interrupt message carries the needle', async () => {
    // The interrupt error is what `onInterrupted()` builds, with the user's
    // logical id in it. Pre-fix the substring arm matched `NotFoundException`,
    // reported the delete a success, and removed a LIVE table from state.
    const interrupt = new InterruptedWaitError(`DynamoDB Table ${NEEDLE_LOGICAL_ID} delete`);
    expect(interrupt.message).toContain('NotFoundException');

    const mockProviderDelete = vi.fn().mockRejectedValue(interrupt);
    const { ctx, deleteState } = makeCtx(mockProviderDelete);

    const result = await runDestroyForStack(
      'TestStack',
      makeState(NEEDLE_LOGICAL_ID),
      ctx
    );

    expect(result.deletedCount).toBe(0);
    expect(result.errorCount).toBe(1);
    // The state row survives, so a re-run still knows about the table.
    expect(deleteState).not.toHaveBeenCalled();
  });

  it('...and when the interrupt is WRAPPED, which is the normal shape', async () => {
    // Every provider catch re-wraps as a `ProvisioningError` threading the
    // original as `cause` (issue #2040), so the classifier has to walk it.
    const wrapped = new ProvisioningError(
      `Failed to delete DynamoDB table ${NEEDLE_LOGICAL_ID}: interrupted`,
      'AWS::DynamoDB::Table',
      NEEDLE_LOGICAL_ID,
      'phys-id',
      new InterruptedWaitError(`DynamoDB Table ${NEEDLE_LOGICAL_ID} delete`)
    );

    const mockProviderDelete = vi.fn().mockRejectedValue(wrapped);
    const { ctx, deleteState } = makeCtx(mockProviderDelete);

    const result = await runDestroyForStack('TestStack', makeState(NEEDLE_LOGICAL_ID), ctx);

    expect(result.errorCount).toBe(1);
    expect(deleteState).not.toHaveBeenCalled();
  });

  it('INVERTED CONTROL — a genuine not-found IS still read as already deleted', async () => {
    // The guard must not disable the arm it fences. Without this the first two
    // cases pass with the whole substring match deleted.
    const mockProviderDelete = vi
      .fn()
      .mockRejectedValue(new Error('Requested resource not found'));
    const { ctx, deleteState } = makeCtx(mockProviderDelete);

    const result = await runDestroyForStack('TestStack', makeState('Table'), ctx);

    expect(result.deletedCount).toBe(1);
    expect(result.errorCount).toBe(0);
    expect(deleteState).toHaveBeenCalled();
  });

  it('INVERTED CONTROL — a needle-named resource with a REAL not-found still passes', async () => {
    // ...and the guard is on the ERROR TYPE, not on the name: the same logical
    // id whose name defeated the matcher must still take the already-deleted
    // arm when AWS really says not found.
    const mockProviderDelete = vi
      .fn()
      .mockRejectedValue(new Error('Requested resource not found'));
    const { ctx, deleteState } = makeCtx(mockProviderDelete);

    const result = await runDestroyForStack('TestStack', makeState(NEEDLE_LOGICAL_ID), ctx);

    expect(result.deletedCount).toBe(1);
    expect(deleteState).toHaveBeenCalled();
  });
});
