/**
 * destroy-runner `DeletionPolicy: Snapshot` gating (issue #1352) — the
 * template-less twin of the deploy engine's DELETE-branch gating, covering
 * both `cdkd destroy` and `cdkd state destroy` (both route through
 * `runDestroyForStack`). Both polarities of `ctx.skipFinalSnapshot` pinned.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

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

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(),
}));

const mockEc2Client = { send: vi.fn() };
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(),
  setAwsClients: vi.fn(),
  getAwsClients: () => ({ ec2: mockEc2Client }),
}));

const mockCreateEbsFinalSnapshot = vi.hoisted(() => vi.fn());
vi.mock('../../../src/provisioning/final-snapshot.js', async () => {
  const actual = await vi.importActual('../../../src/provisioning/final-snapshot.js');
  return { ...actual, createEbsFinalSnapshot: mockCreateEbsFinalSnapshot };
});

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

function res(extra: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys-id',
    resourceType: 'AWS::RDS::DBInstance',
    properties: {},
    attributes: {},
    dependencies: [],
    ...extra,
  };
}

function makeState(resources: Record<string, ResourceState>): StackState {
  return {
    version: 8,
    stackName: 'TestStack',
    region: REGION,
    resources,
    outputs: {},
    lastModified: 1,
  };
}

describe('runDestroyForStack — DeletionPolicy: Snapshot (#1352)', () => {
  const mockSaveState = vi.fn();
  const mockDeleteState = vi.fn();
  const mockProviderDelete = vi.fn();

  function makeCtx(extra: Record<string, unknown> = {}) {
    return {
      stateBackend: {
        saveState: mockSaveState,
        deleteState: mockDeleteState,
        listStacks: vi.fn().mockResolvedValue([]),
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock: vi.fn(),
        releaseLock: vi.fn(),
      } as unknown as LockManager,
      providerRegistry: {
        getProviderFor: () => ({ provider: { delete: mockProviderDelete } }),
      } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
      ...extra,
    };
  }

  function deleteContextArg(): Record<string, unknown> {
    expect(mockProviderDelete).toHaveBeenCalledTimes(1);
    return mockProviderDelete.mock.calls[0][4] as Record<string, unknown>;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveState.mockResolvedValue('"etag"');
    mockDeleteState.mockResolvedValue(undefined);
    mockProviderDelete.mockResolvedValue(undefined);
    mockCreateEbsFinalSnapshot.mockResolvedValue('snap-unit');
  });

  it('Tier A type: threads a generated finalSnapshotIdentifier into the DeleteContext', async () => {
    const state = makeState({ Db: res({ deletionPolicy: 'Snapshot' }) });
    const result = await runDestroyForStack('TestStack', state, makeCtx());
    expect(result.errorCount).toBe(0);
    expect(deleteContextArg()['finalSnapshotIdentifier']).toMatch(
      /^phys-id-final-\d{8}-\d{6}$/
    );
  });

  it('ctx.skipFinalSnapshot: true — plain delete, no identifier (opt-out polarity)', async () => {
    const state = makeState({ Db: res({ deletionPolicy: 'Snapshot' }) });
    await runDestroyForStack('TestStack', state, makeCtx({ skipFinalSnapshot: true }));
    expect(deleteContextArg()['finalSnapshotIdentifier']).toBeUndefined();
  });

  it('policy absent (pre-v5 state) — plain delete, no snapshot machinery', async () => {
    const state = makeState({ Db: res() });
    await runDestroyForStack('TestStack', state, makeCtx());
    expect(deleteContextArg()['finalSnapshotIdentifier']).toBeUndefined();
    expect(mockCreateEbsFinalSnapshot).not.toHaveBeenCalled();
  });

  it('AWS::EC2::Volume: pre-delete EBS snapshot runs before the plain delete', async () => {
    const state = makeState({
      Vol: res({ resourceType: 'AWS::EC2::Volume', deletionPolicy: 'Snapshot' }),
    });
    const result = await runDestroyForStack('TestStack', state, makeCtx());
    expect(result.errorCount).toBe(0);
    expect(mockCreateEbsFinalSnapshot).toHaveBeenCalledWith(
      mockEc2Client,
      'phys-id',
      'Vol',
      expect.anything()
    );
    expect(deleteContextArg()['finalSnapshotIdentifier']).toBeUndefined();
  });

  it('unsupported Snapshot-tagged type: per-resource error, resource preserved in state', async () => {
    const state = makeState({
      Cluster: res({ resourceType: 'AWS::Redshift::Cluster', deletionPolicy: 'Snapshot' }),
    });
    const result = await runDestroyForStack('TestStack', state, makeCtx());
    expect(result.errorCount).toBe(1);
    expect(mockProviderDelete).not.toHaveBeenCalled();
    // State file NOT deleted — the resource is still live in AWS.
    expect(mockDeleteState).not.toHaveBeenCalled();
  });

  it('unsupported type + skipFinalSnapshot: true — deletes plainly (explicit opt-out)', async () => {
    const state = makeState({
      Cluster: res({ resourceType: 'AWS::Redshift::Cluster', deletionPolicy: 'Snapshot' }),
    });
    const result = await runDestroyForStack(
      'TestStack',
      state,
      makeCtx({ skipFinalSnapshot: true })
    );
    expect(result.errorCount).toBe(0);
    expect(deleteContextArg()['finalSnapshotIdentifier']).toBeUndefined();
  });
});
