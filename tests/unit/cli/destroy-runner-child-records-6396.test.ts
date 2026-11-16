/**
 * go-to-k/cdkd#6396: a nested child whose FIRST deploy failed rolls back to an
 * empty record at `cdkd/<Parent>~<Child>/<region>/state.json`, while the
 * parent's row recorded no physical id, so the parent's destroy never reached
 * the child and the record outlived it. The destroy now retires such a record
 * after deleting the parent's, through the same empty-record path (the child's
 * lock, the re-read, every guard), and keeps one that still holds anything.
 *
 * Driven through `runDestroyForStack`, so both the wiring and the real
 * `destroyEmptyStack` are exercised; harness from
 * `destroy-runner-empty-state-lock.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

const quiet = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  setLevel: vi.fn(),
  child: (): unknown => quiet,
}));
vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/logger.js')>();
  return { ...actual, getLogger: () => quiet };
});
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));
/** The provider every resource the runner deletes routes to: a delete that succeeds. */
const provider = vi.hoisted(() => ({ delete: vi.fn(async () => undefined) }));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(() => ({ getProviderFor: vi.fn(() => provider) })),
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

const REGION = 'us-east-1';
const PARENT = 'TestStack';
const CHILD = `${PARENT}~ChildNestedStackResource`;

function record(stackName: string, extra: Partial<StackState> = {}): StackState {
  return {
    version: 16,
    stackName,
    region: REGION,
    resources: {},
    outputs: {},
    lastModified: 1,
    ...extra,
  };
}

function childRecord(name: string, parent: string, extra: Partial<StackState> = {}): StackState {
  return record(name, { parentStack: parent, parentLogicalId: 'Row', parentRegion: REGION, ...extra });
}

const RESOURCE: ResourceState = {
  physicalId: 'phys-id',
  resourceType: 'AWS::SSM::Parameter',
  properties: {},
  attributes: {},
  dependencies: [],
};

/** A state bucket holding `records` (stack name -> record) in REGION, plus `elsewhere`. */
function makeCtx(records: Record<string, StackState>, elsewhere: string[] = []) {
  const store = new Map(Object.entries(records));
  const deleted: string[] = [];
  const listStacks = vi.fn(async (namePrefix = '') =>
    [
      ...[...store.keys()].map((stackName) => ({ stackName, region: REGION })),
      ...elsewhere.map((stackName) => ({ stackName, region: 'eu-west-1' })),
    ].filter((ref) => ref.stackName.startsWith(namePrefix))
  );
  const backend = {
    getState: vi.fn(async (name: string, region: string) => {
      const state = region === REGION ? store.get(name) : undefined;
      return state ? { state, etag: 'e' } : null;
    }),
    deleteState: vi.fn(async (name: string) => {
      deleted.push(name);
      store.delete(name);
    }),
    saveState: vi.fn(),
    listStacks,
    loadRollbackJournal: vi.fn(async () => null),
  };
  const ctx = {
    stateBackend: backend as unknown as S3StateBackend,
    lockManager: {
      acquireLock: vi.fn(async () => true),
      releaseLock: vi.fn(async () => undefined),
      getLockInfo: vi.fn(async () => null),
    } as unknown as LockManager,
    providerRegistry: {
      getProviderFor: vi.fn(() => ({ provider, provisionedBy: 'sdk' })),
    } as unknown as ProviderRegistry,
    baseAwsClients: {} as AwsClients,
    baseRegion: REGION,
    stateBucket: 'test-bucket',
    skipConfirmation: true,
  } as unknown as Parameters<typeof runDestroyForStack>[2];
  return { ctx, deleted, listStacks };
}

describe('destroy retires the nested-child records no parent row addresses (go-to-k/cdkd#6396)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes an empty child record that names the destroyed parent, after the parent', async () => {
    const h = makeCtx({ [PARENT]: record(PARENT), [CHILD]: childRecord(CHILD, PARENT) });
    const result = await runDestroyForStack(PARENT, record(PARENT), h.ctx);
    expect(result.stateDeleted).toBe(true);
    expect(h.deleted).toEqual([PARENT, CHILD]);
    // One prefix-scoped listing, never the whole bucket.
    expect(h.listStacks.mock.calls).toEqual([[`${PARENT}~`]]);
  });

  it('retires it after a parent that held resources too (the main destroy path)', async () => {
    const parent = record(PARENT, { resources: { P: RESOURCE } });
    const h = makeCtx({ [PARENT]: parent, [CHILD]: childRecord(CHILD, PARENT) });
    const result = await runDestroyForStack(PARENT, parent, h.ctx);
    expect(result.errorCount).toBe(0);
    expect(result.deletedCount).toBe(1);
    expect(h.deleted).toEqual([PARENT, CHILD]);
  });

  it('sweeps the empty parent path BEFORE the parent lock is released', async () => {
    const h = makeCtx({ [PARENT]: record(PARENT), [CHILD]: childRecord(CHILD, PARENT) });
    const order: string[] = [];
    const lm = h.ctx.lockManager as unknown as {
      acquireLock: ReturnType<typeof vi.fn>;
      releaseLock: ReturnType<typeof vi.fn>;
    };
    lm.acquireLock.mockImplementation(async (name: string) => {
      order.push(`acquire ${name}`);
      return true;
    });
    lm.releaseLock.mockImplementation(async (name: string) => {
      order.push(`release ${name}`);
    });
    const backend = h.ctx.stateBackend as unknown as { deleteState: ReturnType<typeof vi.fn> };
    const inner = backend.deleteState.getMockImplementation() as (name: string) => Promise<void>;
    backend.deleteState.mockImplementation(async (name: string) => {
      order.push(`delete ${name}`);
      return inner(name);
    });
    await runDestroyForStack(PARENT, record(PARENT), h.ctx);
    expect(order).toEqual([
      `acquire ${PARENT}`,
      `delete ${PARENT}`,
      `acquire ${CHILD}`,
      `delete ${CHILD}`,
      `release ${CHILD}`,
      `release ${PARENT}`,
    ]);
  });

  it("leaves a retained nested row's child alone, without a warning", async () => {
    const parent = record(PARENT, {
      resources: {
        ChildNestedStackResource: {
          physicalId: 'arn:aws:cloudformation:us-east-1:111122223333:stack/x/y',
          resourceType: 'AWS::CloudFormation::Stack',
          properties: {},
          deletionPolicy: 'Retain',
        },
      },
    });
    const h = makeCtx({
      [PARENT]: parent,
      [CHILD]: childRecord(CHILD, PARENT, { resources: { P: RESOURCE } }),
    });
    const result = await runDestroyForStack(PARENT, parent, h.ctx);
    expect(result.retainedCount).toBe(1);
    expect(h.deleted).toEqual([PARENT]);
    expect(quiet.warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(
      /Kept the nested-stack record/
    );
  });

  it("still sweeps what is left under a nested row the destroy DELETED (not retained)", async () => {
    const grand = `${CHILD}~Grand`;
    const parent = record(PARENT, {
      resources: {
        ChildNestedStackResource: {
          physicalId: 'arn:aws:cloudformation:us-east-1:111122223333:stack/x/y',
          resourceType: 'AWS::CloudFormation::Stack',
          properties: {},
        },
      },
    });
    // The row's own delete found no child record (already gone), leaving the grandchild.
    const h = makeCtx({ [PARENT]: parent, [grand]: childRecord(grand, CHILD) });
    await runDestroyForStack(PARENT, parent, h.ctx);
    expect(h.deleted).toEqual([PARENT, grand]);
  });

  it('retires a grandchild before its child', async () => {
    const grand = `${CHILD}~Grand`;
    const h = makeCtx({
      [PARENT]: record(PARENT),
      [CHILD]: childRecord(CHILD, PARENT),
      [grand]: childRecord(grand, CHILD),
    });
    await runDestroyForStack(PARENT, record(PARENT), h.ctx);
    expect(h.deleted).toEqual([PARENT, grand, CHILD]);
  });

  it('keeps a child record that still holds a resource, and the chain above it, warning', async () => {
    const grand = `${CHILD}~Grand`;
    const h = makeCtx({
      [PARENT]: record(PARENT),
      [CHILD]: childRecord(CHILD, PARENT),
      [grand]: childRecord(grand, CHILD, { resources: { P: RESOURCE } }),
    });
    await runDestroyForStack(PARENT, record(PARENT), h.ctx);
    expect(h.deleted).toEqual([PARENT]);
    expect(quiet.warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /Kept the nested-stack record .*Grand: it still records resources/
    );
  });

  it.each([
    ['rollback orphans', { orphans: [{ logicalId: 'X' }] as unknown as StackState['orphans'] }],
    ['an unreadable resources bag', { resources: [] as unknown as StackState['resources'] }],
  ])('keeps a child record holding %s', async (_l, extra) => {
    const h = makeCtx({ [PARENT]: record(PARENT), [CHILD]: childRecord(CHILD, PARENT, extra) });
    await runDestroyForStack(PARENT, record(PARENT), h.ctx);
    expect(h.deleted).toEqual([PARENT]);
  });

  it('keeps a child whose journal tracks a Cloud Control request, naming that reason', async () => {
    const h = makeCtx({ [PARENT]: record(PARENT), [CHILD]: childRecord(CHILD, PARENT) });
    const backend = h.ctx.stateBackend as unknown as {
      loadRollbackJournal: ReturnType<typeof vi.fn>;
    };
    backend.loadRollbackJournal.mockImplementation(async (name: string) =>
      name === CHILD
        ? {
            segments: [
              {
                reason: 'auto-rollback-clean',
                operations: [],
                failedOperations: [
                  {
                    logicalId: 'Q',
                    changeType: 'CREATE',
                    resourceType: 'AWS::SQS::Queue',
                    pendingCloudControlRequest: { requestToken: 't' },
                  },
                ],
              },
            ],
          }
        : null
    );
    await runDestroyForStack(PARENT, record(PARENT), h.ctx);
    expect(h.deleted).toEqual([PARENT]);
    expect(quiet.warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /tracks a Cloud Control request that may still be running/
    );
  });

  it('leaves a record whose body names another parent, or another region', async () => {
    const h = makeCtx({
      [PARENT]: record(PARENT),
      [CHILD]: childRecord(CHILD, 'SomeOtherStack'),
      [`${PARENT}~Other`]: childRecord(`${PARENT}~Other`, PARENT, { parentRegion: 'eu-west-1' }),
    });
    await runDestroyForStack(PARENT, record(PARENT), h.ctx);
    expect(h.deleted).toEqual([PARENT]);
  });

  it('never reads a record of another region or of a stack merely sharing the name start', async () => {
    const h = makeCtx({ [PARENT]: record(PARENT), [`${PARENT}Two`]: record(`${PARENT}Two`) }, [
      CHILD,
    ]);
    await runDestroyForStack(PARENT, record(PARENT), h.ctx);
    expect(h.deleted).toEqual([PARENT]);
    const backend = h.ctx.stateBackend as unknown as { getState: ReturnType<typeof vi.fn> };
    expect(backend.getState.mock.calls.map((c) => c[0])).not.toContain(CHILD);
  });

  it('keeps the records, warning, when the listing fails', async () => {
    const h = makeCtx({ [PARENT]: record(PARENT), [CHILD]: childRecord(CHILD, PARENT) });
    h.listStacks.mockRejectedValueOnce(new Error('AccessDenied'));
    const result = await runDestroyForStack(PARENT, record(PARENT), h.ctx);
    expect(result.stateDeleted).toBe(true);
    expect(h.deleted).toEqual([PARENT]);
    expect(quiet.warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /Could not list the nested-stack records under TestStack/
    );
  });
});
