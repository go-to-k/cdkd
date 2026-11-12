/**
 * go-to-k/cdkd#5628: a rollback reversing a delete-first replacement deletes
 * the NEW cluster before it re-creates the old one. When the old record
 * restores from that very cluster (its `SourceDBClusterIdentifier`, or one of
 * its automated snapshots), the delete would lose the source, so it is refused
 * before the delete, as every forward delete-first replacement refuses it.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import type { ResourceState } from '../../../src/types/state.js';

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

// go-to-k/cdkd#5640: an `ssm` reference in the old record resolves through this.
const ssmSend = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ tag: 'process-global', ssm: { send: ssmSend } }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const TYPE = 'AWS::DocDB::DBCluster';

function rec(physicalId: string, properties: Record<string, unknown>): ResourceState {
  return {
    physicalId,
    resourceType: TYPE,
    provisionedBy: 'sdk',
    properties,
    attributes: {},
    dependencies: [],
  };
}

function harness() {
  const calls: string[] = [];
  const provider = {
    create: vi.fn(async () => {
      calls.push('create');
      return { physicalId: 'cluster-old-2', attributes: {} };
    }),
    delete: vi.fn(async (_logicalId: string, physicalId: string) => {
      calls.push(`delete ${physicalId}`);
    }),
  };
  const logged: string[] = [];
  const log = vi.fn((message: unknown) => {
    logged.push(String(message));
  });
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: log,
    error: log,
    setLevel: vi.fn(),
    child: () => logger,
  } as unknown as RollbackExecutorContext['logger'];
  const ctx: RollbackExecutorContext = {
    region: 'us-east-1',
    logger,
    providerRegistry: {
      getProviderFor: () => ({ provider }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
  };
  return { ctx, calls, logged };
}

/** `cluster-old` was replaced, delete-first, by `cluster-new`. */
function op(previous: Record<string, unknown>): CompletedOperation {
  return {
    logicalId: 'Cluster',
    changeType: 'UPDATE',
    resourceType: TYPE,
    provisionedBy: 'sdk',
    physicalId: 'cluster-new',
    previousState: rec('cluster-old', previous),
    oldResourceRetained: false,
    oldDeletedBeforeCreate: true,
  };
}

describe('reversing a delete-first replacement whose old record restores from the new cluster', () => {
  it.each([
    [
      'its SourceDBClusterIdentifier',
      { SourceDBClusterIdentifier: 'Cluster-New' },
      'SourceDBClusterIdentifier must be another cluster',
    ],
    [
      'an automated snapshot of it',
      { SnapshotIdentifier: 'rds:cluster-new-2026-11-02-03-00' },
      'SnapshotIdentifier names an automated snapshot',
    ],
  ])('refuses before deleting the new cluster: %s', async (_name, previous, reason) => {
    const m = harness();
    const state = { Cluster: rec('cluster-new', {}) };
    const result = await replayRollback([op(previous)], state, 'S', m.ctx);
    expect(m.calls).toEqual([]);
    expect(result.failures).toBe(1);
    expect(m.logged.join('\n')).toContain(reason);
    expect(state.Cluster.physicalId).toBe('cluster-new');
  });

  // go-to-k/cdkd#5639: an RDS point-in-time restore may name its source by the
  // resource id only the new cluster's record holds.
  it.each([
    ['the new cluster\'s recorded id', 'CLUSTER-NEWID', 'AWS::RDS::DBCluster', 0],
    ['another id', 'cluster-other', 'AWS::RDS::DBCluster', 1],
    ['the id on a type that never restores by it', 'cluster-newid', TYPE, 1],
    ['the id on a Neptune cluster', 'cluster-newid', 'AWS::Neptune::DBCluster', 1],
    ['an id, on a record holding none', 'cluster-newid', 'AWS::RDS::DBCluster', 1, {}],
  ] as const)('a SourceDbClusterResourceId naming %s', async (_name, id, type, deletes, attributes?) => {
    const m = harness();
    const current = { ...rec('cluster-new', {}), resourceType: type };
    current.attributes = attributes ?? { DBClusterResourceId: 'cluster-newid' };
    const state = { Cluster: current };
    const operation = op({ SourceDbClusterResourceId: id, UseLatestRestorableTime: true });
    operation.resourceType = type;
    operation.previousState = { ...operation.previousState!, resourceType: type };
    const result = await replayRollback([operation], state, 'S', m.ctx);
    expect(m.calls.filter((c) => c.startsWith('delete'))).toHaveLength(deletes);
    if (deletes === 0) {
      expect(result.failures).toBe(1);
      expect(m.logged.join('\n')).toContain("SourceDbClusterResourceId must be another cluster's");
    }
  });

  // go-to-k/cdkd#5640: the guard reads the RESOLVED bag the re-create sends,
  // so a snapshot named through a dynamic reference is compared by its value.
  it.each([
    ['its own automated snapshot', 'rds:db-new-2026-11-02-03-00', 0],
    ['a manual snapshot', 'manual-snap-1', 1],
  ] as const)(
    'a DB instance whose DBSnapshotIdentifier resolves (ssm) to %s',
    async (_name, resolved, deletes) => {
      ssmSend.mockReset().mockResolvedValue({ Parameter: { Value: resolved } });
      const m = harness();
      const instance = 'AWS::RDS::DBInstance';
      const state = { Cluster: { ...rec('db-new', {}), resourceType: instance } };
      const operation = op({ DBSnapshotIdentifier: '{{resolve:ssm:/cdkd/snap}}' });
      operation.resourceType = instance;
      operation.physicalId = 'db-new';
      operation.previousState = {
        ...operation.previousState!,
        physicalId: 'db-old',
        resourceType: instance,
      };
      const result = await replayRollback([operation], state, 'S', m.ctx);
      expect(ssmSend).toHaveBeenCalled();
      expect(m.calls.filter((c) => c.startsWith('delete'))).toHaveLength(deletes);
      if (deletes === 0) {
        expect(result.failures).toBe(1);
        expect(m.logged.join('\n')).toContain('DBSnapshotIdentifier names an automated snapshot');
      }
    }
  );

  // go-to-k/cdkd#5640: a point-in-time restore's source instance, read off the
  // same resolved bag, and the own-snapshot check it skips (the handler
  // restores to a point in time and reads no snapshot).
  it.each([
    ['the new instance', { SourceDBInstanceIdentifier: '{{resolve:ssm:/cdkd/src}}' }, 'db-new', 0],
    ['another instance', { SourceDBInstanceIdentifier: '{{resolve:ssm:/cdkd/src}}' }, 'db-src', 1],
    [
      'a time, beside its own automated snapshot',
      {
        RestoreTime: '2026-11-01T00:00:00Z',
        DBSnapshotIdentifier: '{{resolve:ssm:/cdkd/snap}}',
      },
      'rds:db-new-2026-11-02-03-00',
      1,
    ],
  ] as const)(
    'a DB instance restoring to a point in time from %s',
    async (_name, previous, resolved, deletes) => {
      ssmSend.mockReset().mockResolvedValue({ Parameter: { Value: resolved } });
      const m = harness();
      const instance = 'AWS::RDS::DBInstance';
      const state = { Cluster: { ...rec('db-new', {}), resourceType: instance } };
      const operation = op({ ...previous, UseLatestRestorableTime: true });
      operation.resourceType = instance;
      operation.physicalId = 'db-new';
      operation.previousState = {
        ...operation.previousState!,
        physicalId: 'db-old',
        resourceType: instance,
      };
      const result = await replayRollback([operation], state, 'S', m.ctx);
      expect(ssmSend).toHaveBeenCalled();
      expect(m.calls.filter((c) => c.startsWith('delete'))).toHaveLength(deletes);
      if (deletes === 0) {
        expect(result.failures).toBe(1);
        expect(m.logged.join('\n')).toContain(
          'SourceDBInstanceIdentifier names the DB instance this creates or replaces'
        );
      }
    }
  );

  it('deletes then re-creates for another source', async () => {
    const m = harness();
    const state: Record<string, ResourceState> = { Cluster: rec('cluster-new', {}) };
    const result = await replayRollback(
      [op({ SourceDBClusterIdentifier: 'cluster-src', SnapshotIdentifier: undefined })],
      state,
      'S',
      m.ctx
    );
    expect(m.calls).toEqual(['delete cluster-new', 'create']);
    expect(result.failures).toBe(0);
  });
});
