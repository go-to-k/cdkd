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

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ tag: 'process-global' }),
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
