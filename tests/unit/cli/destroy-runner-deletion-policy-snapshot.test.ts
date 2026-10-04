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

const runnerWarn = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: runnerWarn,
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
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

const mockCreatePreDeleteFinalSnapshot = vi.hoisted(() => vi.fn());
const mockCcRoutedFinalSnapshotError = vi.hoisted(() => vi.fn());
vi.mock('../../../src/provisioning/final-snapshot.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/provisioning/final-snapshot.js')
  >('../../../src/provisioning/final-snapshot.js');
  // The real refusal, observed: a case can pin WHICH error refused the delete.
  mockCcRoutedFinalSnapshotError.mockImplementation(actual.ccRoutedFinalSnapshotError);
  return {
    ...actual,
    createPreDeleteFinalSnapshot: mockCreatePreDeleteFinalSnapshot,
    ccRoutedFinalSnapshotError: mockCcRoutedFinalSnapshotError,
  };
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

import { TRANSIENT_RESOLUTION_MESSAGE } from '../../../src/provisioning/secret-principal-resolution.js';
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
        acquireLock: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn(),
      } as unknown as LockManager,
      providerRegistry: {
        getProviderFor: () => ({ provider: { delete: mockProviderDelete } }),
      } as unknown as ProviderRegistry,
      // The runner sources the EBS-snapshot client from the active
      // region-scoped clients ((destroyAwsClients ?? baseAwsClients).ec2).
      baseAwsClients: { ec2: mockEc2Client } as unknown as AwsClients,
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
    mockCreatePreDeleteFinalSnapshot.mockResolvedValue('snap-unit');
  });

  // go-to-k/cdkd#4150: the secret-principal opt-in reaches the provider only
  // when the CALLER (cdkd destroy / state destroy) sets it, carrying the
  // stack's producer-region evidence plus any a parent passed down.
  it('ctx.resolveSecretDerivedPrincipals: the DeleteContext carries own + inherited producer regions', async () => {
    const state = {
      ...makeState({ Q: res({ resourceType: 'AWS::SQS::Queue' }) }),
      outputReads: [{ sourceStack: 'Producer', sourceRegion: 'us-west-2', outputKey: 'K' }],
    } as unknown as StackState;
    await runDestroyForStack(
      'TestStack',
      state,
      makeCtx({ resolveSecretDerivedPrincipals: { inheritedProducerRegions: ['eu-west-1'] } })
    );
    expect(deleteContextArg()['resolveSecretDerivedPrincipals']).toEqual({
      importedProducerRegions: ['us-west-2', 'eu-west-1'],
      retryMemo: { detached: new Set() },
    });
  });

  it('go-to-k/cdkd#4156: a destroy of an AWS::IAM::Policy is handed no inline-policy claim predicate', async () => {
    await runDestroyForStack(
      'TestStack',
      makeState({ P: res({ resourceType: 'AWS::IAM::Policy' }) }),
      makeCtx()
    );
    expect(Object.keys(deleteContextArg())).not.toContain('inlinePolicyClaimed');
  });

  it('a transient secret-resolution failure is retried, and when retries run out the record stays', async () => {
    const transient = () =>
      new Error(TRANSIENT_RESOLUTION_MESSAGE, {
        cause: Object.assign(new Error("Key 'k' does not exist"), {
          name: 'ThrottlingException',
          $metadata: {},
        }),
      });
    mockProviderDelete.mockImplementation(() => Promise.reject(transient()));
    vi.useFakeTimers();
    let result: Awaited<ReturnType<typeof runDestroyForStack>>;
    try {
      const run = runDestroyForStack(
        'TestStack',
        makeState({ Pol: res({ resourceType: 'AWS::IAM::Policy' }) }),
        makeCtx({ resolveSecretDerivedPrincipals: {} })
      );
      await vi.advanceTimersByTimeAsync(5000 + 10000 + 20000);
      result = await run;
    } finally {
      vi.useRealTimers();
    }
    // Retried (a throttle in the cause), then an ERROR: the cause's
    // "does not exist" never reads as already deleted.
    expect(mockProviderDelete).toHaveBeenCalledTimes(4);
    expect(result.errorCount).toBe(1);
    const saved = mockSaveState.mock.calls.at(-1)?.[2] as StackState | undefined;
    expect(saved?.resources['Pol']).toBeDefined();
  });

  it('every retry of ONE delete shares the same opt-in object (and so its retryMemo)', async () => {
    vi.useFakeTimers();
    try {
      mockProviderDelete
        .mockRejectedValueOnce(new Error('Failed to delete Pol: Too Many Requests'))
        .mockResolvedValueOnce(undefined);
      const run = runDestroyForStack(
        'TestStack',
        makeState({ Pol: res({ resourceType: 'AWS::IAM::Policy' }) }),
        makeCtx({ resolveSecretDerivedPrincipals: {} })
      );
      await vi.advanceTimersByTimeAsync(5000);
      await run;
    } finally {
      vi.useRealTimers();
    }
    expect(mockProviderDelete).toHaveBeenCalledTimes(2);
    const [first, second] = mockProviderDelete.mock.calls.map(
      (c) => (c[4] as Record<string, unknown>)['resolveSecretDerivedPrincipals']
    );
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it('a nested child destroyed ON ITS OWN (no inherited regions) resolves nothing; through its parent it does', async () => {
    const child = {
      ...makeState({
        Q: res({
          resourceType: 'AWS::IAM::Policy',
          properties: { PolicyName: 'p', Roles: ['{{resolve:secretsmanager:n:SecretString:r::}}'] },
        }),
      }),
      parentStack: 'Parent',
    } as unknown as StackState;
    const hint = "this nested child's secret-derived principal records resolve when destroyed through its parent stack";
    const hinted = () => runnerWarn.mock.calls.some((c) => String(c[0]).includes(hint));
    await runDestroyForStack('Parent~Child', child, makeCtx({ resolveSecretDerivedPrincipals: {} }));
    expect(deleteContextArg()).not.toHaveProperty('resolveSecretDerivedPrincipals');
    expect(hinted()).toBe(true);
    // No opt-in (a deploy's nested removal): no hint, even with the record.
    vi.clearAllMocks();
    mockSaveState.mockResolvedValue('"etag"');
    mockProviderDelete.mockResolvedValue(undefined);
    await runDestroyForStack('Parent~Child', child, makeCtx());
    expect(hinted()).toBe(false);
    // No such record: no hint.
    vi.clearAllMocks();
    mockSaveState.mockResolvedValue('"etag"');
    mockProviderDelete.mockResolvedValue(undefined);
    await runDestroyForStack(
      'Parent~Child',
      { ...makeState({ Q: res({ resourceType: 'AWS::SQS::Queue' }) }), parentStack: 'Parent' } as unknown as StackState,
      makeCtx({ resolveSecretDerivedPrincipals: {} })
    );
    expect(hinted()).toBe(false);
    vi.clearAllMocks();
    mockSaveState.mockResolvedValue('"etag"');
    mockProviderDelete.mockResolvedValue(undefined);
    await runDestroyForStack(
      'Parent~Child',
      child,
      makeCtx({ resolveSecretDerivedPrincipals: { inheritedProducerRegions: [] } })
    );
    expect(deleteContextArg()['resolveSecretDerivedPrincipals']).toMatchObject({
      importedProducerRegions: [],
    });
    // Through the parent: no hint.
    expect(hinted()).toBe(false);
  });

  it('without the runner option the DeleteContext carries no opt-in', async () => {
    const state = makeState({ Q: res({ resourceType: 'AWS::SQS::Queue' }) });
    await runDestroyForStack('TestStack', state, makeCtx());
    expect(deleteContextArg()).not.toHaveProperty('resolveSecretDerivedPrincipals');
  });

  it('a malformed imports / outputReads contributes nothing and fails no delete', async () => {
    const state = {
      ...makeState({ Q: res({ resourceType: 'AWS::SQS::Queue' }) }),
      imports: {},
      outputReads: [null, 7, { sourceRegion: 5 }],
    } as unknown as StackState;
    const result = await runDestroyForStack(
      'TestStack',
      state,
      makeCtx({ resolveSecretDerivedPrincipals: {} })
    );
    expect(result.errorCount).toBe(0);
    expect(deleteContextArg()['resolveSecretDerivedPrincipals']).toMatchObject({
      importedProducerRegions: [],
    });
  });

  it('a skipped secret-derived principal record keeps the producer evidence in the persisted snapshot', async () => {
    // The first destroy read the reference `ambiguous` and skipped: a re-run
    // must still see the cross-region read, or it classifies it `local`.
    mockProviderDelete.mockResolvedValue({ outcome: 'skipped', reason: 'x' });
    const imports = [
      { sourceStack: 'Producer', sourceRegion: 'us-west-2', exportName: 'E' },
    ];
    const state = {
      ...makeState({
        Pol: res({
          resourceType: 'AWS::IAM::Policy',
          properties: { PolicyName: 'p', Roles: ['{{resolve:secretsmanager:n:SecretString:r::}}'] },
        }),
      }),
      imports,
    } as unknown as StackState;
    await runDestroyForStack('TestStack', state, makeCtx({ resolveSecretDerivedPrincipals: {} }));
    const saved = mockSaveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.resources['Pol']).toBeDefined();
    expect(saved.imports).toEqual(imports);
  });

  it('a remaining NESTED STACK row keeps the producer evidence too (its child inherits it)', async () => {
    mockProviderDelete.mockResolvedValue({ outcome: 'skipped', reason: 'x' });
    const outputReads = [
      { sourceStack: 'Producer', sourceRegion: 'us-west-2', outputKey: 'K' },
    ];
    const state = {
      ...makeState({ Child: res({ resourceType: 'AWS::CloudFormation::Stack' }) }),
      outputReads,
    } as unknown as StackState;
    await runDestroyForStack('TestStack', state, makeCtx({ resolveSecretDerivedPrincipals: {} }));
    const saved = mockSaveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.outputReads).toEqual(outputReads);
    expect(saved).not.toHaveProperty('imports');
  });

  it('a remaining nested stack row on a NON-resolving run (a deploy) strips the evidence', async () => {
    // Only a resolving destroy hands its regions down to a child; without the
    // option, keeping them would refuse the producer's destroy for nothing.
    mockProviderDelete.mockResolvedValue({ outcome: 'skipped', reason: 'x' });
    const state = {
      ...makeState({ Child: res({ resourceType: 'AWS::CloudFormation::Stack' }) }),
      outputReads: [{ sourceStack: 'Producer', sourceRegion: 'us-west-2', outputKey: 'K' }],
    } as unknown as StackState;
    await runDestroyForStack('TestStack', state, makeCtx());
    const saved = mockSaveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.resources['Child']).toBeDefined();
    expect(saved).not.toHaveProperty('outputReads');
  });

  it('a DELETED secret-derived record beside a skipped row: the evidence is stripped', async () => {
    mockProviderDelete.mockImplementation((id: string) =>
      Promise.resolve(id === 'Q' ? { outcome: 'skipped', reason: 'x' } : undefined)
    );
    const state = {
      ...makeState({
        Q: res({ resourceType: 'AWS::SQS::Queue' }),
        Pol: res({
          resourceType: 'AWS::IAM::Policy',
          properties: { PolicyName: 'p', Roles: ['{{resolve:secretsmanager:n:SecretString:r::}}'] },
        }),
      }),
      imports: [{ sourceStack: 'Producer', sourceRegion: 'us-west-2', exportName: 'E' }],
    } as unknown as StackState;
    await runDestroyForStack('TestStack', state, makeCtx({ resolveSecretDerivedPrincipals: {} }));
    const saved = mockSaveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.resources['Pol']).toBeUndefined();
    expect(saved.resources['Q']).toBeDefined();
    expect(saved).not.toHaveProperty('imports');
  });

  it('once no such record remains, the snapshot strips the evidence as before', async () => {
    mockProviderDelete.mockImplementation((id: string) =>
      Promise.resolve(id === 'Q' ? { outcome: 'skipped', reason: 'x' } : undefined)
    );
    const state = {
      ...makeState({ Q: res({ resourceType: 'AWS::SQS::Queue' }) }),
      imports: [{ sourceStack: 'Producer', sourceRegion: 'us-west-2', exportName: 'E' }],
    } as unknown as StackState;
    await runDestroyForStack('TestStack', state, makeCtx({ resolveSecretDerivedPrincipals: {} }));
    const saved = mockSaveState.mock.calls.at(-1)![2] as StackState;
    expect(saved).not.toHaveProperty('imports');
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

  it('policy absent on a type whose CFn default is Delete — plain delete, no snapshot machinery', async () => {
    const state = makeState({ Q: res({ resourceType: 'AWS::SQS::Queue' }) });
    await runDestroyForStack('TestStack', state, makeCtx());
    expect(deleteContextArg()['finalSnapshotIdentifier']).toBeUndefined();
    expect(mockCreatePreDeleteFinalSnapshot).not.toHaveBeenCalled();
  });

  describe('issue #4030: an absent policy is CloudFormation default Snapshot for RDS', () => {
    it.each([
      ['a standalone DBInstance', res()],
      ['a DBCluster', res({ resourceType: 'AWS::RDS::DBCluster' })],
    ])('%s: threads a generated finalSnapshotIdentifier', async (_label, resource) => {
      const state = makeState({ Db: resource });
      const result = await runDestroyForStack('TestStack', state, makeCtx());
      expect(result.errorCount).toBe(0);
      expect(deleteContextArg()['finalSnapshotIdentifier']).toMatch(/^phys-id-final-/);
    });

    it('a cluster-member DBInstance keeps the plain delete (its CFn default is Delete)', async () => {
      const state = makeState({ Db: res({ properties: { DBClusterIdentifier: 'c1' } }) });
      await runDestroyForStack('TestStack', state, makeCtx());
      expect(deleteContextArg()['finalSnapshotIdentifier']).toBeUndefined();
    });

    it('an explicit Delete keeps the plain delete', async () => {
      const state = makeState({ Db: res({ deletionPolicy: 'Delete' }) });
      await runDestroyForStack('TestStack', state, makeCtx());
      expect(deleteContextArg()['finalSnapshotIdentifier']).toBeUndefined();
    });

    it('--skip-final-snapshot opts out, and says so to the provider (issue #4029)', async () => {
      const state = makeState({ Db: res() });
      await runDestroyForStack('TestStack', state, makeCtx({ skipFinalSnapshot: true }));
      expect(deleteContextArg()['finalSnapshotIdentifier']).toBeUndefined();
      expect(deleteContextArg()['skipFinalSnapshot']).toBe(true);
    });

    it('without --skip-final-snapshot the context carries no opt-out', async () => {
      const state = makeState({ Db: res() });
      await runDestroyForStack('TestStack', state, makeCtx());
      expect(deleteContextArg()).not.toHaveProperty('skipFinalSnapshot');
    });

    it('cc-api-routed: refused with the Cloud Control final-snapshot error, no delete', async () => {
      const state = makeState({ Db: res({ provisionedBy: 'cc-api' }) });
      const result = await runDestroyForStack('TestStack', state, makeCtx());
      expect(result.errorCount).toBe(1);
      expect(mockProviderDelete).not.toHaveBeenCalled();
      expect(mockCcRoutedFinalSnapshotError).toHaveBeenCalledWith(
        'Db',
        'AWS::RDS::DBInstance',
        '--skip-final-snapshot'
      );
    });
  });

  it('issue #3993: threads the recorded DeletionPolicy into the DeleteContext', async () => {
    const state = makeState({ Db: res({ deletionPolicy: 'Delete' }) });
    await runDestroyForStack('TestStack', state, makeCtx());
    expect(deleteContextArg()['deletionPolicy']).toBe('Delete');
  });

  it("issue #4157: threads the deleted record's attributes into the DeleteContext", async () => {
    const attributes = { RepositoryId: 'id-recorded-4157' };
    const state = makeState({ Db: res({ deletionPolicy: 'Delete', attributes }) });
    await runDestroyForStack('TestStack', state, makeCtx());
    expect(deleteContextArg()['recordedAttributes']).toEqual(attributes);
  });

  it.each([
    // A standalone RDS instance: CloudFormation's absent default is Snapshot.
    ['AWS::RDS::DBInstance', 'Snapshot'],
    // Issue #4029: every other type's absent default is Delete, which lets a
    // Cloud Control-routed Neptune cluster avoid its handler's snapshot.
    ['AWS::Neptune::DBCluster', 'Delete'],
    ['AWS::SQS::Queue', 'Delete'],
  ])('an absent recorded policy on %s reaches the provider as %s', async (resourceType, expected) => {
    const state = makeState({ Db: res({ resourceType }) });
    await runDestroyForStack('TestStack', state, makeCtx({ skipFinalSnapshot: true }));
    expect(deleteContextArg()['deletionPolicy']).toBe(expected);
  });

  it('AWS::EC2::Volume: pre-delete snapshot dispatcher runs before the plain delete', async () => {
    const state = makeState({
      Vol: res({ resourceType: 'AWS::EC2::Volume', deletionPolicy: 'Snapshot' }),
    });
    const ctx = makeCtx();
    const result = await runDestroyForStack('TestStack', state, ctx);
    expect(result.errorCount).toBe(0);
    expect(mockCreatePreDeleteFinalSnapshot).toHaveBeenCalledWith(
      'AWS::EC2::Volume',
      'phys-id',
      'Vol',
      ctx.baseAwsClients,
      expect.anything()
    );
    expect(deleteContextArg()['finalSnapshotIdentifier']).toBeUndefined();
  });

  it('AWS::ElastiCache::ReplicationGroup: routed through the dispatcher (#1353)', async () => {
    const state = makeState({
      Cache: res({
        resourceType: 'AWS::ElastiCache::ReplicationGroup',
        deletionPolicy: 'Snapshot',
      }),
    });
    const result = await runDestroyForStack('TestStack', state, makeCtx());
    expect(result.errorCount).toBe(0);
    expect(mockCreatePreDeleteFinalSnapshot).toHaveBeenCalledWith(
      'AWS::ElastiCache::ReplicationGroup',
      'phys-id',
      'Cache',
      expect.anything(),
      expect.anything()
    );
  });

  it('unsupported Snapshot-tagged type: per-resource error, resource preserved in state', async () => {
    const state = makeState({
      Cluster: res({ resourceType: 'AWS::S3::Bucket', deletionPolicy: 'Snapshot' }),
    });
    const result = await runDestroyForStack('TestStack', state, makeCtx());
    expect(result.errorCount).toBe(1);
    expect(mockProviderDelete).not.toHaveBeenCalled();
    // State file NOT deleted — the resource is still live in AWS.
    expect(mockDeleteState).not.toHaveBeenCalled();
  });

  it('cc-api-routed atomic type: per-resource refusal, no delete, state preserved', async () => {
    const state = makeState({
      Db: res({ deletionPolicy: 'Snapshot', provisionedBy: 'cc-api' }),
    });
    const result = await runDestroyForStack('TestStack', state, makeCtx());
    expect(result.errorCount).toBe(1);
    expect(mockProviderDelete).not.toHaveBeenCalled();
    expect(mockDeleteState).not.toHaveBeenCalled();
  });

  it('cc-api-routed atomic type + skipFinalSnapshot: true — deletes plainly (opt-out)', async () => {
    const state = makeState({
      Db: res({ deletionPolicy: 'Snapshot', provisionedBy: 'cc-api' }),
    });
    const result = await runDestroyForStack(
      'TestStack',
      state,
      makeCtx({ skipFinalSnapshot: true })
    );
    expect(result.errorCount).toBe(0);
    expect(deleteContextArg()['finalSnapshotIdentifier']).toBeUndefined();
  });

  it('EBS snapshot failure whose message contains "does not exist" is NOT read as already-deleted', async () => {
    // The snapshot-wait wrapper (issue #1352 reviewer catch): a raw
    // InvalidSnapshot.NotFound from the wait poll must surface as a
    // per-resource FAILURE — the runner's "not found = already deleted"
    // heuristic would otherwise drop the live, un-snapshotted volume from
    // state without deleting it.
    const { CdkdError } = await import('../../../src/utils/error-handler.js');
    mockCreatePreDeleteFinalSnapshot.mockRejectedValueOnce(
      new CdkdError(
        'Failed while waiting for final snapshot snap-x of Vol (vol-1): The snapshot does not exist.',
        'FINAL_SNAPSHOT_FAILED'
      )
    );
    const state = makeState({
      Vol: res({ resourceType: 'AWS::EC2::Volume', deletionPolicy: 'Snapshot' }),
    });
    const result = await runDestroyForStack('TestStack', state, makeCtx());
    expect(result.errorCount).toBe(1);
    expect(result.deletedCount).toBe(0);
    expect(mockProviderDelete).not.toHaveBeenCalled();
    expect(mockDeleteState).not.toHaveBeenCalled();
  });

  it('unsupported type + skipFinalSnapshot: true — deletes plainly (explicit opt-out)', async () => {
    const state = makeState({
      Cluster: res({ resourceType: 'AWS::S3::Bucket', deletionPolicy: 'Snapshot' }),
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

describe('nested-stack --skip-final-snapshot threading (source pin)', () => {
  // `cdkd deploy --skip-final-snapshot` reaches a whole-nested-stack removal
  // only through ctx.options (the parent DeployEngineOptions); destroy paths
  // thread ctx.destroyOptions. Pin BOTH reads on live (uncommented) lines so
  // neither direction silently regresses (reviewer catch, issue #1352).
  it('NestedStackProvider.delete reads the flag from destroyOptions AND options', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL(
        '../../../src/provisioning/providers/nested-stack-provider.ts',
        import.meta.url
      ),
      'utf8'
    );
    const liveLines = src.split('\n').filter((l) => !l.trim().startsWith('//'));
    expect(
      liveLines.some((l) => l.includes('ctx.destroyOptions?.skipFinalSnapshot === true'))
    ).toBe(true);
    expect(liveLines.some((l) => l.includes('ctx.options?.skipFinalSnapshot === true'))).toBe(
      true
    );
  });
});
