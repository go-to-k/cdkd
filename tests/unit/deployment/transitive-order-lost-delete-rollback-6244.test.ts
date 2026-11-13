/**
 * go-to-k/cdkd#6244, the orders beside the create/update phase that walk
 * through records outside their own set:
 *
 * - the update-failure fallback's re-created children (`enqueueLostChildren`),
 *   both their own edges and those of pending readers that reach them;
 * - the DELETE phase (`buildDeletionDependencies`) and the rollback order of
 *   CREATEs (`sortRollbackCreates`). `DependsOn` is not diffed, so a NO_CHANGE
 *   record can sit between two deleted (or two created) ones.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import { DagExecutor } from '../../../src/deployment/dag-executor.js';
import { buildDeletionDependencies } from '../../../src/deployment/deploy-engine/dependencies.js';
import { sortRollbackCreates } from '../../../src/deployment/rollback-executor/plan.js';
import type { CompletedOperation } from '../../../src/deployment/rollback-executor/types.js';

const lostIdsToReturn: { ids: string[] } = { ids: [] };
vi.mock('../../../src/deployment/child-of-recreated-parent.js', () => ({
  noChangeChildrenOfRecreatedParents: () => lostIdsToReturn.ids,
  survivesParent: () => false,
}));

import { enqueueLostChildren } from '../../../src/deployment/deploy-engine/execute/lost-children.js';

const change = (id: string, changeType: ResourceChange['changeType']): ResourceChange =>
  ({ logicalId: id, changeType, resourceType: 'AWS::SSM::Parameter' }) as ResourceChange;

/**
 * Enqueue `lost` into an executor holding `nodes` (id -> state), over a DAG
 * whose direct dependencies are `edges`. Returns each node's dependencies.
 */
function enqueue(
  edges: Record<string, string[]>,
  nodes: Record<string, 'pending' | 'completed'>,
  lost: string[]
): Map<string, string[]> {
  const ids = new Set([...Object.keys(edges), ...Object.values(edges).flat()]);
  const changes = new Map<string, ResourceChange>();
  for (const id of ids) changes.set(id, change(id, id in nodes ? 'UPDATE' : 'NO_CHANGE'));
  const executor = new DagExecutor<ResourceChange>();
  for (const [id, state] of Object.entries(nodes)) {
    executor.add({ id, dependencies: new Set(), state, data: changes.get(id)! });
  }
  lostIdsToReturn.ids = lost;
  const run = {
    engine: {
      dagBuilder: { getDirectDependencies: (_dag: unknown, id: string) => edges[id] ?? [] },
      replacementRun: { recreatedUnderSameId: new Set() },
      logger: { info: vi.fn(), debug: vi.fn() },
    },
    changes,
    deleteChanges: new Set<string>(),
    template: { Resources: {} },
    newResources: {},
    conditions: {},
    progress: undefined,
    dag: {},
  };
  enqueueLostChildren(run as never, executor);
  const out = new Map<string, string[]>();
  for (const node of executor.values()) out.set(node.id, [...node.dependencies].sort());
  return out;
}

describe('enqueueLostChildren orders through NO_CHANGE rows (go-to-k/cdkd#6244)', () => {
  it('a pending reader behind an unchanged row waits for the lost child', () => {
    // Reader (changed, pending) -> U (unchanged) -> Lost -> Parent (re-created)
    const deps = enqueue(
      { Reader: ['U'], U: ['Lost'], Lost: ['Parent'] },
      { Parent: 'completed', Reader: 'pending' },
      ['Lost']
    );
    expect(deps.get('Lost')).toEqual(['Parent']);
    expect(deps.get('Reader')).toContain('Lost');
  });

  it('a lost child behind another one through an unchanged row waits for it', () => {
    // L2 -> U -> L1 -> Parent, with L2 enqueued first.
    const deps = enqueue(
      { L2: ['U'], U: ['L1'], L1: ['Parent'] },
      { Parent: 'completed' },
      ['L2', 'L1']
    );
    expect(deps.get('L2')).toEqual(['L1']);
  });

  it('a lost child directly reading a later-enqueued one waits for it', () => {
    const deps = enqueue({ L2: ['L1'], L1: ['Parent'] }, { Parent: 'completed' }, ['L2', 'L1']);
    expect(deps.get('L2')).toEqual(['L1']);
  });
});

const record = (dependencies: string[]): ResourceState =>
  ({
    physicalId: 'p',
    resourceType: 'AWS::SSM::Parameter',
    properties: {},
    attributes: {},
    dependencies,
  }) as ResourceState;

describe('delete and rollback orders walk through kept records (go-to-k/cdkd#6244)', () => {
  // N1 DependsOn U (kept, NO_CHANGE), U DependsOn N2, plus an unrelated Free.
  const resources: Record<string, ResourceState> = {
    N1: record(['U']),
    U: record(['N2']),
    N2: record([]),
    Free: record([]),
  };

  it('deletes N1 before N2 when a kept record sits between them', () => {
    const state: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      stackName: 's',
      region: 'us-east-1',
      resources,
      outputs: {},
      lastModified: 0,
    };
    const deps = buildDeletionDependencies(new Set(['N1', 'N2', 'Free']), state, { debug: vi.fn() });
    // N2's deletion waits for N1's.
    expect([...deps.get('N2')!]).toEqual(['N1']);
    expect([...deps.get('N1')!]).toEqual([]);
    expect([...deps.get('Free')!]).toEqual([]);
  });

  it('rolls back the CREATE of N1 before that of N2 when a non-created record sits between them', () => {
    const op = (logicalId: string): CompletedOperation =>
      ({ logicalId, changeType: 'CREATE', resourceType: 'AWS::SSM::Parameter' }) as CompletedOperation;
    // N2 listed first, so an order that missed the edge would keep it first.
    const sorted = sortRollbackCreates([op('N2'), op('N1')], resources).map((o) => o.logicalId);
    expect(sorted).toEqual(['N1', 'N2']);
  });
});
