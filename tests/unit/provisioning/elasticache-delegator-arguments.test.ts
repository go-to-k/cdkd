/**
 * The `ElastiCacheProvider` class keeps one delegator per method whose body
 * moved into `src/provisioning/providers/elasticache/` (go-to-k/cdkd#5835):
 * each is `return f.call(this, <its own parameters>)`. A delegator that swaps
 * two same-typed arguments, drops one, calls a sibling's body, or drops the
 * result still type-checks.
 *
 * Every companion module is replaced by spies here, so each case observes the
 * hand-off itself: the moved function is called once, on the instance, with
 * every argument in order, and the delegator returns what it returned. The
 * arity in the table is the moved function's own parameter count (minus
 * `this`), not the delegator's, so a delegator that drops its last parameter
 * fails here instead of shrinking the call.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/** Every exported function of a companion module, replaced by a spy. */
async function spyAll(load: () => Promise<Record<string, unknown>>) {
  const actual = await load();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
}

vi.mock('../../../src/provisioning/providers/elasticache/core.js', (io) =>
  spyAll(io as () => Promise<Record<string, unknown>>)
);
vi.mock('../../../src/provisioning/providers/elasticache/subnet-group.js', (io) =>
  spyAll(io as () => Promise<Record<string, unknown>>)
);
vi.mock('../../../src/provisioning/providers/elasticache/cache-cluster.js', (io) =>
  spyAll(io as () => Promise<Record<string, unknown>>)
);
vi.mock('../../../src/provisioning/providers/elasticache/cache-cluster-update.js', (io) =>
  spyAll(io as () => Promise<Record<string, unknown>>)
);
vi.mock('../../../src/provisioning/providers/elasticache/read-state.js', (io) =>
  spyAll(io as () => Promise<Record<string, unknown>>)
);
vi.mock('../../../src/provisioning/providers/elasticache/import.js', (io) =>
  spyAll(io as () => Promise<Record<string, unknown>>)
);

import { ElastiCacheProvider } from '../../../src/provisioning/providers/elasticache-provider.js';
import * as core from '../../../src/provisioning/providers/elasticache/core.js';
import * as subnetGroup from '../../../src/provisioning/providers/elasticache/subnet-group.js';
import * as cacheCluster from '../../../src/provisioning/providers/elasticache/cache-cluster.js';
import * as cacheClusterUpdate from '../../../src/provisioning/providers/elasticache/cache-cluster-update.js';
import * as readState from '../../../src/provisioning/providers/elasticache/read-state.js';
import * as imp from '../../../src/provisioning/providers/elasticache/import.js';

type Module = Record<string, unknown>;

/** [class method, companion module, moved function, the moved function's arity]. */
const DELEGATORS: ReadonlyArray<readonly [string, Module, string, number]> = [
  ['wrapCaughtError', core, 'wrapCaughtError', 3],
  ['wrapDeleteError', core, 'wrapDeleteError', 3],
  ['create', core, 'create', 4],
  ['update', core, 'update', 6],
  ['delete', core, 'deleteImpl', 5],
  ['isNotFoundError', core, 'isNotFoundError', 2],
  ['createSubnetGroup', subnetGroup, 'createSubnetGroup', 4],
  ['updateSubnetGroup', subnetGroup, 'updateSubnetGroup', 6],
  ['deleteSubnetGroup', subnetGroup, 'deleteSubnetGroup', 4],
  ['applySubnetGroupTagDiff', subnetGroup, 'applySubnetGroupTagDiff', 6],
  ['createCacheCluster', cacheCluster, 'createCacheCluster', 4],
  ['deleteCacheCluster', cacheCluster, 'deleteCacheCluster', 4],
  ['describeCacheCluster', cacheCluster, 'describeCacheCluster', 1],
  ['waitForClusterAvailable', cacheCluster, 'waitForClusterAvailable', 4],
  ['waitForClusterDeleted', cacheCluster, 'waitForClusterDeleted', 3],
  ['updateCacheCluster', cacheClusterUpdate, 'updateCacheCluster', 7],
  ['warnTransitEncryptionNotApplied', cacheClusterUpdate, 'warnTransitEncryptionNotApplied', 4],
  ['planNodeChanges', cacheClusterUpdate, 'planNodeChanges', 5],
  ['warnNotAppliedInPlace', cacheClusterUpdate, 'warnNotAppliedInPlace', 4],
  ['warnRemovalsLeftInPlace', cacheClusterUpdate, 'warnRemovalsLeftInPlace', 4],
  [
    'buildLogDeliveryConfigurationsForUpdate',
    cacheClusterUpdate,
    'buildLogDeliveryConfigurationsForUpdate',
    2,
  ],
  ['applyTagDiff', cacheClusterUpdate, 'applyTagDiff', 5],
  ['readCurrentState', readState, 'readCurrentState', 3],
  ['readCacheCluster', readState, 'readCacheCluster', 1],
  ['readSubnetGroup', readState, 'readSubnetGroup', 1],
  ['attachTags', readState, 'attachTags', 2],
  ['import', imp, 'importImpl', 1],
  ['importCacheCluster', imp, 'importCacheCluster', 1],
  ['importSubnetGroup', imp, 'importSubnetGroup', 1],
];

const allSpies = (): ReturnType<typeof vi.fn>[] =>
  [core, subnetGroup, cacheCluster, cacheClusterUpdate, readState, imp].flatMap((m) =>
    Object.values(m as Module).filter((v): v is ReturnType<typeof vi.fn> => vi.isMockFunction(v))
  );

describe('ElastiCacheProvider delegators hand every argument to the moved body', () => {
  beforeEach(() => {
    for (const spy of allSpies()) spy.mockReset();
  });

  it('covers every delegator the class has', () => {
    // A method whose body is a `.call(this, ...)` hand-off is a delegator; a
    // new one must be added to the table above.
    const own = Object.getOwnPropertyNames(ElastiCacheProvider.prototype).filter(
      (name) =>
        name !== 'constructor' &&
        /\breturn [\w$.]+\.call\(\s*this\b/.test(
          String((ElastiCacheProvider.prototype as unknown as Module)[name])
        )
    );
    // The class's own non-delegator methods stay in the class.
    expect(Object.getOwnPropertyNames(ElastiCacheProvider.prototype).length).toBe(
      own.length + 5 // constructor, getClient, getCreateClient, sleep, getDriftUnknownPaths
    );
    expect(own.sort()).toEqual(DELEGATORS.map(([name]) => name).sort());
  });

  for (const [method, mod, fn, arity] of DELEGATORS) {
    it(`${method} forwards ${arity} argument(s) in order to ${fn} and returns its result`, () => {
      const provider = new ElastiCacheProvider();
      const target = mod[fn] as ReturnType<typeof vi.fn>;
      const result = Symbol(`${fn} result`);
      target.mockReturnValue(result);
      const args = Array.from({ length: arity }, (_, i) => Symbol(`${method} arg ${i}`));

      const returned = (provider as unknown as Record<string, (...a: unknown[]) => unknown>)[
        method
      ]!(...args);

      expect(returned).toBe(result);
      expect(target).toHaveBeenCalledTimes(1);
      expect(target.mock.calls[0]).toEqual(args);
      expect(target.mock.contexts[0]).toBe(provider);
      // No other moved body ran: the delegator reached its own function only.
      for (const spy of allSpies()) if (spy !== target) expect(spy).not.toHaveBeenCalled();
    });
  }
});
