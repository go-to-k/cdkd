/**
 * go-to-k/cdkd#6445: which create-first replacement deletes wait for the
 * deploy's cleanup phase, and how. The maintainer's decisions, per case:
 *
 *   1. A record holding a NoEcho mask defers. Persisted in state when its
 *      delete reads no NoEcho value; in memory only when it is a custom
 *      resource whose delete needs this run's re-resolved values, which never
 *      go to state.
 *   2. An IAM inline policy is deleted right away.
 *   3. `UpdateReplacePolicy: Snapshot` defers where the delete call takes the
 *      snapshot (RDS); a type snapshotted before its delete defers with its
 *      snapshot moved into the deferred delete (go-to-k/cdkd#6463), and stays
 *      inline only when its snapshot was already taken.
 *   4. An old physical id another record holds defers in memory only, never
 *      recorded (go-to-k/cdkd#6712; it was deleted right away before).
 *
 * The engine-level runs (dependent ordering, rollback re-adopt) are in
 * `deploy-engine-cleanup-phase-delete-6374.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  deleteReplacedAfterCreate,
  retryDeferredReplacedDeletes,
  warnUnretriedReplacedDeletes,
} from '../../../src/deployment/deploy-engine/replacement.js';
import type { NoEchoDeleteValues } from '../../../src/deployment/noecho-delete-reresolution.js';
import { deleteSupersededEntry } from '../../../src/deployment/superseded-resources.js';
import type { ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';

const printed = vi.hoisted(() => ({ info: [] as string[], warn: [] as string[] }));
vi.mock('../../../src/utils/logger.js', async () => {
  const sink = (level: 'info' | 'warn') =>
    vi.fn((message: unknown) => {
      printed[level].push(String(message));
    });
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: sink('info'),
    warn: sink('warn'),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const SECRET = 'hunter2-6445-plaintext';

describe('which replaced deletes wait for the cleanup phase (go-to-k/cdkd#6445)', () => {
  let provider: ResourceProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    printed.info.length = 0;
    printed.warn.length = 0;
    provider = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(async () => undefined),
      getAttribute: vi.fn(),
    } as unknown as ResourceProvider;
  });

  function makeEngine(options: Record<string, unknown> = {}): DeployEngine {
    return new DeployEngine(
      {} as unknown as never,
      {} as unknown as never,
      {} as unknown as never,
      {} as unknown as never,
      {} as unknown as never,
      { concurrency: 1, ...options } as never,
      'us-east-1'
    );
  }

  /** An engine inside a deploy: the deferred map and the live state are set. */
  function inDeploy(options: Record<string, unknown> = {}) {
    const engine = makeEngine(options);
    const run = engine.replacementRun;
    run.deferredReplacedDeletes = new Map();
    const host: Pick<StackState, 'supersededResources'> = {};
    run.supersededHost = host;
    return { engine, run, host };
  }

  function replaceDelete(
    engine: DeployEngine,
    logicalId: string,
    old: ResourceState,
    extra: {
      finalSnapshotIdentifier?: string;
      updateReplacePolicy?: 'Snapshot' | 'Delete';
      noEchoDeleteValues?: NoEchoDeleteValues;
    } = {}
  ): Promise<void> {
    return deleteReplacedAfterCreate(
      engine.replacementRun,
      engine.replacementDeps(),
      logicalId,
      old.resourceType,
      old,
      provider,
      old.properties,
      extra.finalSnapshotIdentifier,
      extra.updateReplacePolicy,
      new Map(),
      'sdk',
      extra.noEchoDeleteValues
    );
  }

  const deletedIds = (): string[] => vi.mocked(provider.delete).mock.calls.map((c) => c[1]);

  const crRecord = (): ResourceState =>
    ({
      physicalId: 'cr-old',
      resourceType: 'Custom::Seeder',
      properties: { ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:h', Password: '***' },
      noEchoLeaves: [['Password']],
    }) as unknown as ResourceState;

  const reresolved = (): NoEchoDeleteValues => ({
    leaves: [{ coordinate: ['Password'], value: SECRET }],
    maskSecrets: (text: string) => text.split(SECRET).join('***'),
  });

  it('tier (a): a NoEcho-masked record whose delete reads no value is deferred and recorded', async () => {
    const { engine, run, host } = inDeploy();
    const old = {
      physicalId: 'db-old',
      resourceType: 'AWS::RDS::DBInstance',
      properties: { MasterUserPassword: '***' },
      noEchoLeaves: [['MasterUserPassword']],
    } as unknown as ResourceState;

    await replaceDelete(engine, 'Db', old);

    expect(provider.delete).not.toHaveBeenCalled();
    expect(run.deferredReplacedDeletes!.has('Db')).toBe(true);
    expect(run.replacedOldMaySurvive.get('Db')).toBe('deferred');
    expect(host.supersededResources?.map((e) => e.state)).toEqual([old]);
  });

  it('tier (b): a custom resource holding a NoEcho mask is deferred in memory only, and its values reach the deferred delete', async () => {
    const { engine, run, host } = inDeploy();
    const old = crRecord();

    await replaceDelete(engine, 'Seeder', old, { noEchoDeleteValues: reresolved() });

    expect(provider.delete).not.toHaveBeenCalled();
    expect(run.deferredReplacedDeletes!.get('Seeder')?.cleanupPhase).toBe(true);
    expect(run.replacedOldMaySurvive.get('Seeder')).toBe('deferred');
    // Never written to state: no entry, and nothing carrying the value.
    expect(host.supersededResources).toBeUndefined();
    expect(run.supersededEntries.has('Seeder')).toBe(false);
    expect(JSON.stringify(host)).not.toContain(SECRET);
    expect([...printed.info, ...printed.warn].join('\n')).not.toContain(SECRET);
    expect(
      printed.info.some((l) => l.includes('Old Seeder (cr-old) is deleted after the rest of the deploy succeeds'))
    ).toBe(true);

    await retryDeferredReplacedDeletes(run, engine.replacementDeps(), 'S', { updated: 1, updatePartial: 0 });

    expect(deletedIds()).toEqual(['cr-old']);
    const context = vi.mocked(provider.delete).mock.calls[0]![4] as Record<string, unknown>;
    expect((context['noEchoDeleteValues'] as NoEchoDeleteValues).leaves[0]!.value).toBe(SECRET);
    expect(context['recordedNoEchoLeaves']).toEqual([['Password']]);
    expect([...printed.info, ...printed.warn].join('\n')).not.toContain(SECRET);
  });

  it('tier (b) without re-resolved values still defers in memory only', async () => {
    const { engine, run, host } = inDeploy();

    await replaceDelete(engine, 'Seeder', crRecord());

    expect(provider.delete).not.toHaveBeenCalled();
    expect(run.deferredReplacedDeletes!.has('Seeder')).toBe(true);
    expect(host.supersededResources).toBeUndefined();
  });

  it('an unsent in-memory deferral says state no longer tracks the old copy', async () => {
    const { engine, run } = inDeploy();
    await replaceDelete(engine, 'Seeder', crRecord(), { noEchoDeleteValues: reresolved() });

    warnUnretriedReplacedDeletes(run, engine.replacementDeps(), 'interrupted');

    expect(provider.delete).not.toHaveBeenCalled();
    // A warning, not an info line: nothing tracks it without that rollback.
    expect(printed.warn).toContain(
      '  ⚠ Old Seeder (cr-old) was not deleted: the deploy was interrupted. A rollback of the deploy adopts it again; otherwise it is no longer tracked in state, so delete it manually'
    );
    expect(printed.info.some((l) => l.includes('Old Seeder (cr-old) was not deleted'))).toBe(false);
  });

  it('a Ctrl-C between cleanup waves warns about each unsent in-memory deferral, never a recorded one', async () => {
    const { engine, run } = inDeploy({ concurrency: 4 });
    // Seeder (in memory only) and Db (recorded) wait for Child, which depends on
    // both; the user presses Ctrl-C while Child's delete runs.
    await replaceDelete(engine, 'Seeder', crRecord(), { noEchoDeleteValues: reresolved() });
    await replaceDelete(engine, 'Db', {
      physicalId: 'db-old',
      resourceType: 'AWS::RDS::DBInstance',
      properties: {},
    } as unknown as ResourceState);
    expect(run.supersededEntries.has('Db')).toBe(true);
    run.deferredReplacedDeletes!.set('Child', {
      physicalId: 'child-old',
      resourceType: 'AWS::SQS::Queue',
      provisionedBy: 'sdk',
      failureMessage: undefined,
      cleanupPhase: true,
      dependencies: ['Seeder', 'Db'],
      retry: async () => {
        (engine as unknown as { interrupted: boolean }).interrupted = true;
      },
    });

    await retryDeferredReplacedDeletes(run, engine.replacementDeps(), 'S', { updated: 2, updatePartial: 0 });

    expect(provider.delete).not.toHaveBeenCalled();
    expect(printed.warn).toContain(
      '  ⚠ Old Seeder (cr-old) was not deleted: the deploy was interrupted. It is no longer tracked in state, so delete it manually'
    );
    // The recorded one stays in state for the next deploy: no warning.
    expect(printed.warn.some((l) => l.includes('db-old'))).toBe(false);
  });

  it('SEC: AWS::IAM::Policy is deleted right away even when handed NoEcho delete values', async () => {
    const { engine, run, host } = inDeploy();
    const old = {
      physicalId: 'old-policy',
      resourceType: 'AWS::IAM::Policy',
      properties: { PolicyName: 'old-policy', Roles: ['r'] },
      noEchoLeaves: [['PolicyName']],
    } as unknown as ResourceState;

    await replaceDelete(engine, 'Policy', old, { noEchoDeleteValues: reresolved() });

    expect(deletedIds()).toEqual(['old-policy']);
    expect(run.deferredReplacedDeletes!.size).toBe(0);
    expect(host.supersededResources).toBeUndefined();
  });

  it('a later run deletes a tier (a) entry with its mask and NoEcho positions (go-to-k/cdkd#6445)', async () => {
    const outcome = await deleteSupersededEntry(
      {
        logicalId: 'Db',
        supersededAt: 1,
        state: {
          physicalId: 'db-old',
          resourceType: 'AWS::RDS::DBInstance',
          properties: { DBInstanceIdentifier: 'db-old', MasterUserPassword: '***' },
          noEchoLeaves: [['MasterUserPassword']],
        } as unknown as ResourceState,
        updateReplacePolicy: 'Snapshot',
        finalSnapshotIdentifier: 'db-old-final-6445',
      },
      { provider, region: 'us-east-1', maskSecrets: (t) => t, stop: () => false, once: true }
    );

    expect(outcome).toEqual({ kind: 'deleted' });
    const [, physicalId, type, properties, context] = vi.mocked(provider.delete).mock.calls[0]!;
    expect([physicalId, type]).toEqual(['db-old', 'AWS::RDS::DBInstance']);
    expect(properties).toEqual({ DBInstanceIdentifier: 'db-old', MasterUserPassword: '***' });
    expect(context).toMatchObject({
      recordedNoEchoLeaves: [['MasterUserPassword']],
      finalSnapshotIdentifier: 'db-old-final-6445',
      deletionPolicy: 'Snapshot',
    });
    expect(context).not.toHaveProperty('noEchoDeleteValues');
  });

  // A Cloud Control-routed atomic type reaches the delete only when
  // `prepareFinalSnapshotForDelete` found a live read replica or cluster
  // member (go-to-k/cdkd#6047), whose delete takes no snapshot; any other
  // cc-api instance is refused there, before this delete. The deferred delete
  // sends the same context the inline one did.
  it('case 3: a cc-api-routed read replica under Snapshot defers, and its delete carries no identifier', async () => {
    const { engine, run } = inDeploy();
    const old = {
      physicalId: 'replica-old',
      resourceType: 'AWS::RDS::DBInstance',
      properties: {},
      provisionedBy: 'cc-api',
    } as unknown as ResourceState;

    await replaceDelete(engine, 'Replica', old, { updateReplacePolicy: 'Snapshot' });
    expect(provider.delete).not.toHaveBeenCalled();
    expect(run.deferredReplacedDeletes!.has('Replica')).toBe(true);

    await retryDeferredReplacedDeletes(run, engine.replacementDeps(), 'S', { updated: 1, updatePartial: 0 });
    const context = vi.mocked(provider.delete).mock.calls[0]![4] as Record<string, unknown>;
    expect(context['deletionPolicy']).toBe('Snapshot');
    expect(context).not.toHaveProperty('finalSnapshotIdentifier');
  });

  it('case 3: an atomic-snapshot type defers and hands the identifier to the deferred delete', async () => {
    const { engine, run, host } = inDeploy();
    const old = {
      physicalId: 'db-old',
      resourceType: 'AWS::RDS::DBInstance',
      properties: {},
    } as unknown as ResourceState;

    await replaceDelete(engine, 'Db', old, {
      updateReplacePolicy: 'Snapshot',
      finalSnapshotIdentifier: 'db-old-final-6445',
    });
    expect(provider.delete).not.toHaveBeenCalled();
    expect(host.supersededResources?.[0]).toMatchObject({
      finalSnapshotIdentifier: 'db-old-final-6445',
      updateReplacePolicy: 'Snapshot',
    });

    await retryDeferredReplacedDeletes(run, engine.replacementDeps(), 'S', { updated: 1, updatePartial: 0 });
    expect(vi.mocked(provider.delete).mock.calls[0]![4]).toMatchObject({
      finalSnapshotIdentifier: 'db-old-final-6445',
      deletionPolicy: 'Snapshot',
    });
  });

  it.each([
    ['AWS::EC2::Volume'],
    ['AWS::Redshift::Cluster'],
    ['AWS::ElastiCache::ReplicationGroup'],
  ])('case 3: %s, its snapshot already taken (no owed mark), is still deleted right away', async (type) => {
    // go-to-k/cdkd#6463: a create-first replacement now hands over an owed
    // mark and defers (`deploy-engine-predelete-snapshot-defer-6463.test.ts`);
    // a caller that took the snapshot itself passes none and stays inline.
    const { engine, run, host } = inDeploy();
    const old = { physicalId: 'vol-old', resourceType: type, properties: {} } as unknown as ResourceState;

    await replaceDelete(engine, 'Vol', old, { updateReplacePolicy: 'Snapshot' });

    expect(deletedIds()).toEqual(['vol-old']);
    expect(run.deferredReplacedDeletes!.size).toBe(0);
    expect(host.supersededResources).toBeUndefined();

    // Control: under --skip-final-snapshot no snapshot is taken, so it defers.
    vi.mocked(provider.delete).mockClear();
    const skip = inDeploy({ skipFinalSnapshot: true });
    await replaceDelete(skip.engine, 'Vol', old, { updateReplacePolicy: 'Snapshot' });
    expect(provider.delete).not.toHaveBeenCalled();
    expect(skip.run.deferredReplacedDeletes!.has('Vol')).toBe(true);
  });

  it.each([['AWS::IAM::RolePolicy'], ['AWS::IAM::UserPolicy'], ['AWS::IAM::GroupPolicy'], ['AWS::IAM::Policy']])(
    'case 2: an IAM inline policy (%s) is deleted right away',
    async (type) => {
      const { engine, run, host } = inDeploy();
      const old = {
        physicalId: 'old-policy',
        resourceType: type,
        properties: { PolicyName: 'old-policy', RoleName: 'r' },
      } as unknown as ResourceState;

      await replaceDelete(engine, 'Policy', old);

      expect(deletedIds()).toEqual(['old-policy']);
      expect(run.deferredReplacedDeletes!.size).toBe(0);
      expect(run.replacedOldMaySurvive.has('Policy')).toBe(false);
      expect(host.supersededResources).toBeUndefined();
    }
  );

  it.each([
    ['a plain record', {}],
    ['a custom resource with re-resolved NoEcho values', 'cr'],
  ] as const)(
    'case 4: an old physical id another record holds waits in memory only, and the cleanup phase deletes it (go-to-k/cdkd#6712, %s)',
    async (_l, shape) => {
      const { engine, run, host } = inDeploy();
      const old =
        shape === 'cr'
          ? crRecord()
          : ({ physicalId: 'cr-old', resourceType: 'AWS::SQS::Queue', properties: {} } as unknown as ResourceState);
      engine.deployStateResources = {
        Mine: old,
        Other: { physicalId: 'cr-old', resourceType: old.resourceType, properties: {} } as ResourceState,
      };

      await replaceDelete(engine, 'Mine', old, shape === 'cr' ? { noEchoDeleteValues: reresolved() } : {});

      // Nothing deleted before the deploy succeeds, so a failed deploy's
      // rollback finds the old copy whole.
      expect(provider.delete).not.toHaveBeenCalled();
      expect(run.deferredReplacedDeletes!.get('Mine')?.cleanupPhase).toBe(true);
      expect(run.replacedOldMaySurvive.get('Mine')).toBe('deferred');
      // Never recorded: a later run would delete the holder's resource.
      expect(host.supersededResources).toBeUndefined();
      expect(run.supersededEntries.has('Mine')).toBe(false);

      await retryDeferredReplacedDeletes(run, engine.replacementDeps(), 'S', { updated: 1, updatePartial: 0 });

      expect(deletedIds()).toEqual(['cr-old']);
    }
  );

  it('case 4: a queue held by its QueuePolicy record is not deleted when the deploy fails, and an interrupt names it (go-to-k/cdkd#6712)', async () => {
    const { engine, run, host } = inDeploy();
    const url = 'https://sqs.us-east-1.amazonaws.com/123456789012/q-a';
    const old = { physicalId: url, resourceType: 'AWS::SQS::Queue', properties: { QueueName: 'q-a' } } as unknown as ResourceState;
    engine.deployStateResources = {
      Q: old,
      QPolicy: { physicalId: url, resourceType: 'AWS::SQS::QueuePolicy', properties: {} } as ResourceState,
    };

    await replaceDelete(engine, 'Q', old);
    // The deploy fails: the cleanup pass never runs.
    warnUnretriedReplacedDeletes(run, engine.replacementDeps(), 'interrupted');

    expect(provider.delete).not.toHaveBeenCalled();
    expect(host.supersededResources).toBeUndefined();
    expect(printed.warn.some((l) => l.includes(`Old Q (${url}) was not deleted`))).toBe(true);
  });
});
