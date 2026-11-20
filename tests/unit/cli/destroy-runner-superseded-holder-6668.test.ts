import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type {
  ResourceState,
  StackState,
  SupersededResourceRecord,
} from '../../../src/types/state.js';
import { journaledHolderRead } from '../../../src/deployment/journaled-holder.js';
import type { SurvivorIdentityRead } from '../../../src/types/resource.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

// go-to-k/cdkd#6668: `cdkd destroy` compares the holder of a superseded
// entry's name with the generation it recorded (`identity`) before deleting
// it: a holder proven not the stack's is left alone and the entry dropped;
// one that cannot be proven keeps the state.

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

const snapshotSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/provisioning/final-snapshot.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPreDeleteFinalSnapshot: snapshotSpy,
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

const D1 = '2026-11-01T00:00:00.000Z';
const D2 = '2026-11-20T00:00:00.000Z';

const entry: SupersededResourceRecord = {
  logicalId: 'Bucket',
  supersededAt: 1,
  state: { physicalId: 'bucket-old', resourceType: 'AWS::S3::Bucket', properties: {} },
  identity: `us-east-1|${D1}`,
};

describe('runDestroyForStack compares a superseded entry holder first (#6668)', () => {
  const mockSaveState = vi.fn();
  const mockDeleteState = vi.fn();
  const mockProviderDelete = vi.fn();
  let holder: () => Promise<SurvivorIdentityRead>;
  const saved = { ...journaledHolderRead };

  function makeCtx(current: StackState) {
    return {
      stateBackend: {
        saveState: mockSaveState,
        deleteState: mockDeleteState,
        getState: vi.fn(async () => ({ state: current, etag: 'e' })),
        listStacks: vi.fn().mockResolvedValue([]),
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn(),
      } as unknown as LockManager,
      providerRegistry: {
        getProviderFor: () => ({ provider: { delete: mockProviderDelete } }),
        getProvider: () => ({ replacedSurvivorIdentity: () => holder() }),
      } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
    };
  }

  beforeEach(() => {
    mockSaveState.mockReset().mockResolvedValue('"etag"');
    mockDeleteState.mockReset().mockResolvedValue(undefined);
    mockProviderDelete.mockReset().mockResolvedValue(undefined);
    warnSpy.mockReset();
    journaledHolderRead.delayMs = 0;
    holder = async () => ({ kind: 'owned', identity: `us-east-1|${D1}` });
  });
  afterEach(() => {
    Object.assign(journaledHolderRead, saved);
  });

  const warned = () => warnSpy.mock.calls.map((c) => String(c[0])).join('\n');

  it('deletes the generation the entry recorded', async () => {
    const state = makeState({}, { supersededResources: [entry] });
    const result = await runDestroyForStack('TestStack', state, makeCtx(state));
    expect(mockProviderDelete).toHaveBeenCalledTimes(1);
    expect(result.deletedCount).toBe(1);
    expect(mockDeleteState).toHaveBeenCalledTimes(1);
  });

  it("leaves another account's bucket alone and drops the entry", async () => {
    holder = async () => ({ kind: 'foreign', seen: 'other-account' });
    const state = makeState({}, { supersededResources: [entry] });
    const result = await runDestroyForStack('TestStack', state, makeCtx(state));
    expect(mockProviderDelete).not.toHaveBeenCalled();
    expect(result.errorCount).toBe(0);
    expect(mockDeleteState).toHaveBeenCalledTimes(1);
    expect(warned()).toContain('its owning account differs');
    expect(warned()).toContain('that resource was left alone');
  });

  it('sends nothing when the name is free and finishes the destroy', async () => {
    holder = async () => ({ kind: 'gone' });
    const state = makeState({}, { supersededResources: [entry] });
    const result = await runDestroyForStack('TestStack', state, makeCtx(state));
    expect(mockProviderDelete).not.toHaveBeenCalled();
    expect(result.errorCount).toBe(0);
    expect(mockDeleteState).toHaveBeenCalledTimes(1);
  });

  it('leaves another us-east-1 generation alone and drops the entry', async () => {
    holder = async () => ({ kind: 'owned', identity: `us-east-1|${D2}` });
    const state = makeState({}, { supersededResources: [entry] });
    const result = await runDestroyForStack('TestStack', state, makeCtx(state));
    expect(mockProviderDelete).not.toHaveBeenCalled();
    expect(result.errorCount).toBe(0);
    expect(mockDeleteState).toHaveBeenCalledTimes(1);
    expect(warned()).toContain('its creation time differs');
    expect(warned()).not.toContain(D1);
    expect(warned()).not.toContain(D2);
  });

  it('deletes by name, warning, an entry whose identity can never be compared', async () => {
    const malformed = { ...entry, identity: 'not-a-token' };
    const state = makeState({}, { supersededResources: [malformed] });
    const result = await runDestroyForStack('TestStack', state, makeCtx(state));
    expect(mockProviderDelete).toHaveBeenCalledTimes(1);
    expect(result.errorCount).toBe(0);
    expect(mockDeleteState).toHaveBeenCalledTimes(1);
    expect(warned()).toContain("names another region than the stack's");
  });

  it('keeps the state, unsent, and reports an error when the holder cannot be read', async () => {
    holder = async () => ({ kind: 'unknown' });
    const state = makeState({}, { supersededResources: [entry] });
    const result = await runDestroyForStack('TestStack', state, makeCtx(state));
    expect(mockProviderDelete).not.toHaveBeenCalled();
    expect(result.errorCount).toBe(1);
    expect(mockDeleteState).not.toHaveBeenCalled();
    const last = mockSaveState.mock.calls.at(-1)![2] as StackState;
    expect(last.supersededResources).toEqual([entry]);
    expect(warned()).not.toContain('..');
  });
});
