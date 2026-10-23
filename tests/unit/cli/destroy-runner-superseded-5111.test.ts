import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type {
  ResourceState,
  StackState,
  SupersededResourceRecord,
} from '../../../src/types/state.js';
import { supersededInUseRetry } from '../../../src/deployment/superseded-resources.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

// go-to-k/cdkd#5111: `cdkd destroy` deletes the superseded resources a
// replacement left to delete (`StackState.supersededResources`), AFTER the
// stack's own resources (one of which may still use it), and keeps the state
// while one of them fails, rather than dropping the only record of a live
// resource.

const warnSpy = vi.hoisted(() => vi.fn());
const debugSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: debugSpy,
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

// Keep the import graph light: the runner only touches these for the
// cross-region path, which these tests never exercise.
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
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

// Live renderer is TTY plumbing — replace with inert stubs.
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

const REGION = 'us-east-1';

function res(dependencies: string[] = [], extra: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys-id',
    resourceType: 'AWS::S3::Bucket',
    properties: {},
    attributes: {},
    dependencies,
    ...extra,
  };
}

function makeState(
  resources: Record<string, ResourceState>,
  extra: Partial<StackState> = {}
): StackState {
  return {
    version: 8,
    stackName: 'TestStack',
    region: REGION,
    resources,
    outputs: {},
    lastModified: 1,
    ...extra,
  };
}

const OLD_TG = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/Tg-gen1/aaa';

const entry: SupersededResourceRecord = {
  logicalId: 'Tg',
  supersededAt: 1,
  state: {
    physicalId: OLD_TG,
    resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup',
    properties: {},
    attributes: {},
  },
};

describe('runDestroyForStack deletes the superseded resources too (#5111)', () => {
  const mockSaveState = vi.fn();
  const mockDeleteState = vi.fn();
  const mockProviderDelete = vi.fn();

  // `current` is what the under-lock re-read (#5220) sees. Pass the same
  // StackState the case hands to `runDestroyForStack` so the re-read matches
  // it (nothing changed); omit it only for a case that takes the EMPTY
  // fast path, which has its own separate re-read untouched by #5220.
  function makeCtx(current?: StackState) {
    return {
      stateBackend: {
        saveState: mockSaveState,
        deleteState: mockDeleteState,
        getState: vi.fn(async () => (current ? { state: current, etag: 'e' } : null)),
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
    };
  }

  const retryDefaults = { ...supersededInUseRetry };
  beforeEach(() => {
    mockSaveState.mockReset().mockResolvedValue('"etag"');
    mockDeleteState.mockReset().mockResolvedValue(undefined);
    mockProviderDelete.mockReset();
    warnSpy.mockReset();
    debugSpy.mockReset();
    supersededInUseRetry.delayMs = 0;
  });
  afterEach(() => {
    Object.assign(supersededInUseRetry, retryDefaults);
  });

  it("deletes it after the stack's own resources, then the state file", async () => {
    const order: string[] = [];
    mockProviderDelete.mockImplementation(async (_logicalId: string, physicalId: string) => {
      order.push(physicalId);
    });
    const state = makeState({ Listener: res([], { physicalId: 'listener-arn' }) }, {
      supersededResources: [entry],
    });

    const result = await runDestroyForStack('TestStack', state, makeCtx(state));

    expect(order).toEqual(['listener-arn', OLD_TG]);
    expect(result.errorCount).toBe(0);
    expect(result.deletedCount).toBe(2);
    expect(mockDeleteState).toHaveBeenCalledTimes(1);
  });

  it('keeps the state, and the entry, when its delete fails', async () => {
    supersededInUseRetry.attempts = 2;
    mockProviderDelete.mockImplementation(async (_logicalId: string, physicalId: string) => {
      if (physicalId === OLD_TG) {
        const error = new Error('Target group is currently in use by a listener or a rule');
        error.name = 'ResourceInUseException';
        throw error;
      }
    });
    const state = makeState({ Listener: res([], { physicalId: 'listener-arn' }) }, {
      supersededResources: [entry],
    });

    const result = await runDestroyForStack('TestStack', state, makeCtx(state));

    expect(result.errorCount).toBe(1);
    expect(mockDeleteState).not.toHaveBeenCalled();
    // The in-use wait, then the failure.
    expect(mockProviderDelete.mock.calls.filter((c) => c[1] === OLD_TG)).toHaveLength(2);
    const last = mockSaveState.mock.calls.at(-1)![2] as StackState;
    expect(Object.keys(last.resources)).toEqual([]);
    expect(last.supersededResources).toEqual([entry]);
  });

  it('a record holding ONLY superseded resources is not deleted unacted on', async () => {
    mockProviderDelete.mockResolvedValue(undefined);
    const state = makeState({}, { supersededResources: [entry] });

    const result = await runDestroyForStack('TestStack', state, makeCtx(state));

    expect(mockProviderDelete).toHaveBeenCalledTimes(1);
    expect(mockProviderDelete.mock.calls[0]![1]).toBe(OLD_TG);
    expect(result.deletedCount).toBe(1);
    expect(mockDeleteState).toHaveBeenCalledTimes(1);
  });

  // A row cdkd cannot read may still name a live resource: it never makes the
  // record "empty", and the destroy that cannot act on it keeps the state.
  it.each([
    ['a malformed row', [{ logicalId: 'Tg' }]],
    ['a non-list field', 'garbage'],
  ])('a record holding only %s keeps its state, as a skip', async (_label, rows) => {
    const state = makeState({}, { supersededResources: rows as never });

    const result = await runDestroyForStack('TestStack', state, makeCtx(state));

    expect(mockDeleteState).not.toHaveBeenCalled();
    expect(mockProviderDelete).not.toHaveBeenCalled();
    expect(result.skippedCount).toBe(1);
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /1 superseded resource entry in state could not be read/
    );
  });

  it('deletes a well-formed entry beside a malformed one, and keeps the malformed one recorded', async () => {
    mockProviderDelete.mockResolvedValue(undefined);
    const bad = { logicalId: 'Tg' };
    const state = makeState({}, { supersededResources: [entry, bad] as never });

    const result = await runDestroyForStack('TestStack', state, makeCtx(state));

    expect(mockProviderDelete.mock.calls.map((c) => c[1])).toEqual([OLD_TG]);
    expect(result.deletedCount).toBe(1);
    expect(mockDeleteState).not.toHaveBeenCalled();
    const last = mockSaveState.mock.calls.at(-1)![2] as StackState;
    expect(last.supersededResources).toEqual([bad]);
  });

  it('an empty record that gained only a malformed row under the lock is not deleted', async () => {
    const ctx = makeCtx();
    (ctx.stateBackend as unknown as { getState: ReturnType<typeof vi.fn> }).getState = vi.fn(
      async () => ({
        state: makeState({}, { supersededResources: [{ logicalId: 'Tg' }] as never }),
        etag: '"e"',
      })
    );

    await expect(runDestroyForStack('TestStack', makeState({}), ctx)).rejects.toThrow(
      /another cdkd process wrote to it/
    );
    expect(mockDeleteState).not.toHaveBeenCalled();
  });

  it('does not delete twice an entry a record holds again (a rollback took it back)', async () => {
    mockProviderDelete.mockResolvedValue(undefined);
    const state = makeState(
      { Tg: res([], { physicalId: OLD_TG, resourceType: entry.state.resourceType }) },
      { supersededResources: [entry] }
    );

    const result = await runDestroyForStack('TestStack', state, makeCtx(state));

    expect(mockProviderDelete.mock.calls.map((c) => [c[0], c[1]])).toEqual([['Tg', OLD_TG]]);
    expect(result.deletedCount).toBe(1);
    expect(mockDeleteState).toHaveBeenCalledTimes(1);
  });

  it('drops, with a warning, an entry the provider will not address', async () => {
    mockProviderDelete.mockImplementation(async (_l: string, physicalId: string) => {
      if (physicalId === OLD_TG) return { outcome: 'skipped', reason: 'malformed physicalId in state' };
      throw new Error('boom'); // a failing sibling keeps the state
    });
    const state = makeState(
      { Failing: res([], { physicalId: 'failing-id' }) },
      { supersededResources: [entry] }
    );

    const result = await runDestroyForStack('TestStack', state, makeCtx(state));

    expect(result.skippedCount).toBe(1);
    expect(mockDeleteState).not.toHaveBeenCalled();
    // Not kept: a re-run would refuse it forever.
    const last = mockSaveState.mock.calls.at(-1)![2] as StackState;
    expect(Object.keys(last.resources)).toEqual(['Failing']);
    expect(last.supersededResources).toBeUndefined();
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('no longer tracked'))).toBe(true);
  });

  it('passes --remove-protection to the delete', async () => {
    mockProviderDelete.mockResolvedValue(undefined);
    const state = makeState({}, { supersededResources: [entry] });

    await runDestroyForStack('TestStack', state, { ...makeCtx(state), removeProtection: true });

    expect(mockProviderDelete.mock.calls[0]![4]).toHaveProperty('removeProtection', true);
  });

  it('never deletes an entry another TYPE of record names, and warns', async () => {
    mockProviderDelete.mockResolvedValue(undefined);
    const state = makeState(
      { Fn: res([], { physicalId: OLD_TG, resourceType: 'AWS::Lambda::Function' }) },
      { supersededResources: [entry] }
    );

    await runDestroyForStack('TestStack', state, makeCtx(state));

    expect(mockProviderDelete.mock.calls.map((c) => c[1])).toEqual([OLD_TG]);
    expect(mockProviderDelete.mock.calls[0]![0]).toBe('Fn');
    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).includes('record of this stack has the same physical id'))
    ).toBe(true);
  });
});
