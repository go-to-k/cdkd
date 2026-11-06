import { describe, it, expect, vi, beforeEach, type Mock } from 'vite-plus/test';
import { DocDBProvider } from '../../../src/provisioning/providers/docdb-provider.js';
import * as core from '../../../src/provisioning/providers/docdb/core.js';
import * as clusterCreate from '../../../src/provisioning/providers/docdb/cluster-create.js';
import * as clusterUpdate from '../../../src/provisioning/providers/docdb/cluster-update.js';
import * as clusterDelete from '../../../src/provisioning/providers/docdb/cluster-delete.js';
import * as instance from '../../../src/provisioning/providers/docdb/instance.js';
import * as wait from '../../../src/provisioning/providers/docdb/wait.js';
import * as readState from '../../../src/provisioning/providers/docdb/read-state.js';
import * as importModule from '../../../src/provisioning/providers/docdb/import.js';

// The DocDB method bodies live in `src/provisioning/providers/docdb/*.ts`; the
// class keeps one `return f.call(this, ...)` delegator per method. Every
// companion function is replaced by a stub here, so each case observes the
// hand-off alone: the provider as `this`, every argument in its position, and
// the stub's result returned unchanged.

const { stubAll } = vi.hoisted(() => ({
  stubAll: (mod: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(mod).map(([name, value]) => [
        name,
        typeof value === 'function' ? vi.fn() : value,
      ])
    ),
}));

vi.mock('../../../src/provisioning/providers/docdb/core.js', async (orig) =>
  stubAll(await orig())
);
vi.mock('../../../src/provisioning/providers/docdb/cluster-create.js', async (orig) =>
  stubAll(await orig())
);
vi.mock('../../../src/provisioning/providers/docdb/cluster-update.js', async (orig) =>
  stubAll(await orig())
);
vi.mock('../../../src/provisioning/providers/docdb/cluster-delete.js', async (orig) =>
  stubAll(await orig())
);
vi.mock('../../../src/provisioning/providers/docdb/instance.js', async (orig) =>
  stubAll(await orig())
);
vi.mock('../../../src/provisioning/providers/docdb/wait.js', async (orig) =>
  stubAll(await orig())
);
vi.mock('../../../src/provisioning/providers/docdb/read-state.js', async (orig) =>
  stubAll(await orig())
);
vi.mock('../../../src/provisioning/providers/docdb/import.js', async (orig) =>
  stubAll(await orig())
);

const MODULES: Record<string, Record<string, unknown>> = {
  core,
  'cluster-create': clusterCreate,
  'cluster-update': clusterUpdate,
  'cluster-delete': clusterDelete,
  instance,
  wait,
  'read-state': readState,
  import: importModule,
};

/** [class method, companion module, companion function, parameter count]. */
const DELEGATORS: ReadonlyArray<readonly [string, string, string, number]> = [
  ['getClient', 'core', 'getClient', 0],
  ['getCreateClient', 'core', 'getCreateClient', 0],
  ['create', 'core', 'create', 4],
  ['update', 'core', 'update', 6],
  ['delete', 'core', 'deleteImpl', 5],
  ['wrapCaughtError', 'core', 'wrapCaughtError', 3],
  ['wrapDeleteError', 'core', 'wrapDeleteError', 3],
  ['createDBCluster', 'cluster-create', 'createDBCluster', 5],
  ['refuseUnencryptedRestoreSource', 'cluster-create', 'refuseUnencryptedRestoreSource', 5],
  ['sendRestoreFollowUp', 'cluster-create', 'sendRestoreFollowUp', 5],
  ['warnRestoredDifferences', 'cluster-create', 'warnRestoredDifferences', 5],
  ['updateDBCluster', 'cluster-update', 'updateDBCluster', 6],
  ['deleteDBCluster', 'cluster-delete', 'deleteDBCluster', 5],
  ['deleteDBClusterOnce', 'cluster-delete', 'deleteDBClusterOnce', 6],
  ['wrapGlobalClusterDetachError', 'cluster-delete', 'wrapGlobalClusterDetachError', 3],
  ['detachFromGlobalCluster', 'cluster-delete', 'detachFromGlobalCluster', 6],
  ['createDBInstance', 'instance', 'createDBInstance', 5],
  ['updateDBInstance', 'instance', 'updateDBInstance', 6],
  ['deleteDBInstance', 'instance', 'deleteDBInstance', 4],
  ['markChangedUnsettled', 'core', 'markChangedUnsettled', 4],
  ['refuseBlock', 'core', 'refuseBlock', 4],
  ['planGlobalClusterUpdate', 'cluster-update', 'planGlobalClusterUpdate', 7],
  ['liveGlobalClusterMatches', 'cluster-update', 'liveGlobalClusterMatches', 2],
  ['readClusterBlocks', 'cluster-update', 'readClusterBlocks', 5],
  ['planMasterCredentials', 'cluster-update', 'planMasterCredentials', 7],
  ['readBooleanProperty', 'core', 'readBooleanProperty', 5],
  ['passwordBesideManaged', 'core', 'passwordBesideManaged', 6],
  ['waitForApplied', 'wait', 'waitForApplied', 4],
  ['describeDBCluster', 'wait', 'describeDBCluster', 1],
  ['describeDBInstance', 'wait', 'describeDBInstance', 1],
  ['isSameResource', 'core', 'isSameResource', 4],
  ['resourceIdentity', 'core', 'resourceIdentity', 3],
  ['readDbResourceIdIfExists', 'core', 'readDbResourceIdIfExists', 2],
  ['waitForMemberAfterClusterChange', 'wait', 'waitForMemberAfterClusterChange', 5],
  ['requireClusterWhileWaiting', 'wait', 'requireClusterWhileWaiting', 3],
  ['waitForClusterPortApplied', 'wait', 'waitForClusterPortApplied', 4],
  ['waitForSecurityGroupsApplied', 'wait', 'waitForSecurityGroupsApplied', 4],
  ['deleteAfterProtectionFlip', 'wait', 'deleteAfterProtectionFlip', 3],
  ['waitForClusterAvailable', 'wait', 'waitForClusterAvailable', 3],
  ['waitForClusterDeleted', 'wait', 'waitForClusterDeleted', 3],
  ['waitForInstanceAvailable', 'wait', 'waitForInstanceAvailable', 3],
  ['waitForInstanceDeleted', 'wait', 'waitForInstanceDeleted', 2],
  ['sleep', 'core', 'sleep', 1],
  ['getDriftUnknownPaths', 'read-state', 'getDriftUnknownPaths', 1],
  ['getDriftUnorderedPaths', 'read-state', 'getDriftUnorderedPaths', 1],
  ['canonicalizeDriftProperties', 'read-state', 'canonicalizeDriftProperties', 2],
  ['canonicalizeUnsettledProperties', 'read-state', 'canonicalizeUnsettledProperties', 2],
  ['readUnsettled', 'read-state', 'readUnsettled', 7],
  ['unsettledInTransition', 'read-state', 'unsettledInTransition', 6],
  ['import', 'import', 'importImpl', 1],
  ['readCurrentState', 'read-state', 'readCurrentState', 3],
  ['readCurrentStateDBInstance', 'read-state', 'readCurrentStateDBInstance', 1],
  ['readCurrentStateDBCluster', 'read-state', 'readCurrentStateDBCluster', 1],
  ['importDBInstance', 'import', 'importDBInstance', 1],
  ['importDBCluster', 'import', 'importDBCluster', 1],
];

describe('DocDBProvider delegators hand each argument to the moved body', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('every method on the class is a delegator listed here', () => {
    const methods = Object.getOwnPropertyNames(DocDBProvider.prototype).filter(
      (name) => name !== 'constructor'
    );
    expect(methods.sort()).toEqual(DELEGATORS.map(([method]) => method).sort());
  });

  for (const [method, mod, fn, arity] of DELEGATORS) {
    it(`${method} forwards its ${arity} arguments, in order, and the result of ${mod}/${fn}`, () => {
      const provider = new DocDBProvider();
      const stub = MODULES[mod]![fn] as Mock;
      expect(vi.isMockFunction(stub)).toBe(true);
      const result = Symbol('result');
      stub.mockReturnValueOnce(result);
      const args = Array.from({ length: arity }, (_, i) => Symbol(`arg${i}`));
      const delegator = (provider as unknown as Record<string, (...a: unknown[]) => unknown>)[
        method
      ]!;
      expect(delegator.length).toBe(arity);
      expect(delegator.call(provider, ...args)).toBe(result);
      expect(stub).toHaveBeenCalledTimes(1);
      expect(stub.mock.calls[0]).toHaveLength(arity);
      stub.mock.calls[0]!.forEach((arg, i) => expect(arg).toBe(args[i]));
      expect(stub.mock.contexts[0]).toBe(provider);
    });
  }
});
