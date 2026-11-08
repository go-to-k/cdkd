import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-v6';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * `RDSProvider` keeps one delegator per method whose body moved into its
 * companion directory (`src/provisioning/providers/rds/`): `method(...)` is
 * `return fn.call(this, ...)`. Each companion module's functions are mocked
 * here, so a delegator call reaches the mock and the HAND-OFF itself is what
 * is pinned: the same instance as `this` (not a fresh provider: each one owns
 * its own clients and `protectionFlips` registry), every declared argument in
 * order (none dropped, none swapped), and the callee's own return value.
 *
 * Each body's behavior stays pinned by the per-feature suites; those reach
 * most delegators but not every argument of every one (a dropped
 * `maxWaitMs`, a swapped `logicalId` / `physicalId`), which is what this
 * file adds.
 */

vi.mock('../../../src/provisioning/providers/rds/dispatch.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});
vi.mock('../../../src/provisioning/providers/rds/subnet-group.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});
vi.mock('../../../src/provisioning/providers/rds/cluster-create.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});
vi.mock('../../../src/provisioning/providers/rds/cluster-update.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});
vi.mock('../../../src/provisioning/providers/rds/cluster-delete.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});
vi.mock('../../../src/provisioning/providers/rds/instance-create.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});
vi.mock('../../../src/provisioning/providers/rds/instance-update.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});
vi.mock('../../../src/provisioning/providers/rds/instance-delete.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});
vi.mock('../../../src/provisioning/providers/rds/calls.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});
vi.mock('../../../src/provisioning/providers/rds/waits.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});
vi.mock('../../../src/provisioning/providers/rds/associated-roles.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});
vi.mock('../../../src/provisioning/providers/rds/drift.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});
vi.mock('../../../src/provisioning/providers/rds/read-state.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});

import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import * as dispatch from '../../../src/provisioning/providers/rds/dispatch.js';
import * as subnetGroup from '../../../src/provisioning/providers/rds/subnet-group.js';
import * as clusterCreate from '../../../src/provisioning/providers/rds/cluster-create.js';
import * as clusterUpdate from '../../../src/provisioning/providers/rds/cluster-update.js';
import * as clusterDelete from '../../../src/provisioning/providers/rds/cluster-delete.js';
import * as instanceCreate from '../../../src/provisioning/providers/rds/instance-create.js';
import * as instanceUpdate from '../../../src/provisioning/providers/rds/instance-update.js';
import * as instanceDelete from '../../../src/provisioning/providers/rds/instance-delete.js';
import * as calls from '../../../src/provisioning/providers/rds/calls.js';
import * as waits from '../../../src/provisioning/providers/rds/waits.js';
import * as associatedRoles from '../../../src/provisioning/providers/rds/associated-roles.js';
import * as drift from '../../../src/provisioning/providers/rds/drift.js';
import * as readState from '../../../src/provisioning/providers/rds/read-state.js';

type Module = 'dispatch' | 'subnet-group' | 'cluster-create' | 'cluster-update' | 'cluster-delete' | 'instance-create' | 'instance-update' | 'instance-delete' | 'calls' | 'waits' | 'associated-roles' | 'drift' | 'read-state';

const MODULE_EXPORTS: Record<Module, Record<string, unknown>> = {
  'dispatch': dispatch,
  'subnet-group': subnetGroup,
  'cluster-create': clusterCreate,
  'cluster-update': clusterUpdate,
  'cluster-delete': clusterDelete,
  'instance-create': instanceCreate,
  'instance-update': instanceUpdate,
  'instance-delete': instanceDelete,
  'calls': calls,
  'waits': waits,
  'associated-roles': associatedRoles,
  'drift': drift,
  'read-state': readState,
};

/** [delegator, companion module, function it calls, declared parameter count] */
const DELEGATORS: ReadonlyArray<readonly [string, Module, string, number]> = [
  ['create', 'dispatch', 'create', 4],
  ['update', 'dispatch', 'update', 6],
  ['delete', 'dispatch', 'deleteImpl', 5],
  ['createDBSubnetGroup', 'subnet-group', 'createDBSubnetGroup', 4],
  ['updateDBSubnetGroup', 'subnet-group', 'updateDBSubnetGroup', 6],
  ['deleteDBSubnetGroup', 'subnet-group', 'deleteDBSubnetGroup', 4],
  ['createDBCluster', 'cluster-create', 'createDBCluster', 5],
  ['updateDBCluster', 'cluster-update', 'updateDBCluster', 6],
  ['deleteDBCluster', 'cluster-delete', 'deleteDBCluster', 5],
  ['deleteDBClusterOnce', 'cluster-delete', 'deleteDBClusterOnce', 6],
  ['createDBInstance', 'instance-create', 'createDBInstance', 5],
  ['updateDBInstance', 'instance-update', 'updateDBInstance', 6],
  ['deleteDBInstance', 'instance-delete', 'deleteDBInstance', 5],
  ['deleteDBInstanceOnce', 'instance-delete', 'deleteDBInstanceOnce', 6],
  ['applyTagDiff', 'calls', 'applyTagDiff', 5],
  ['partialClusterRetiring', 'cluster-delete', 'partialClusterRetiring', 1],
  ['isNotFoundError', 'calls', 'isNotFoundError', 2],
  ['wrapCaughtError', 'calls', 'wrapCaughtError', 3],
  ['wrapDeleteError', 'calls', 'wrapDeleteError', 3],
  ['wrapGlobalClusterDetachError', 'cluster-delete', 'wrapGlobalClusterDetachError', 3],
  ['detachFromGlobalCluster', 'cluster-delete', 'detachFromGlobalCluster', 6],
  ['engineLifecycleSupportToSend', 'calls', 'engineLifecycleSupportToSend', 7],
  ['describeDBCluster', 'calls', 'describeDBCluster', 1],
  ['securityGroupsToSend', 'calls', 'securityGroupsToSend', 7],
  ['describeDBInstance', 'calls', 'describeDBInstance', 1],
  ['waitForMemberAfterClusterChange', 'waits', 'waitForMemberAfterClusterChange', 5],
  ['requireClusterWhileWaiting', 'waits', 'requireClusterWhileWaiting', 3],
  ['waitForClusterPortApplied', 'waits', 'waitForClusterPortApplied', 4],
  ['waitForSecurityGroupsApplied', 'waits', 'waitForSecurityGroupsApplied', 4],
  ['waitForClusterState', 'waits', 'waitForClusterState', 4],
  ['sendHttpEndpointChange', 'calls', 'sendHttpEndpointChange', 4],
  ['deleteAfterProtectionFlip', 'cluster-delete', 'deleteAfterProtectionFlip', 3],
  ['deleteInstanceAfterProtectionFlip', 'instance-delete', 'deleteInstanceAfterProtectionFlip', 3],
  ['desiredAssociatedRoles', 'associated-roles', 'desiredAssociatedRoles', 5],
  ['applyAssociatedRoles', 'associated-roles', 'applyAssociatedRoles', 7],
  ['waitForClusterAvailable', 'waits', 'waitForClusterAvailable', 4],
  ['waitForClusterDeleted', 'waits', 'waitForClusterDeleted', 3],
  ['rebootForPendingParameterGroup', 'waits', 'rebootForPendingParameterGroup', 4],
  ['waitForInstanceState', 'waits', 'waitForInstanceState', 4],
  ['waitForInstanceAvailable', 'waits', 'waitForInstanceAvailable', 4],
  ['waitForInstanceDeleted', 'waits', 'waitForInstanceDeleted', 3],
  ['import', 'dispatch', 'importImpl', 1],
  ['getDriftUnorderedPaths', 'drift', 'getDriftUnorderedPaths', 1],
  ['getDriftUnknownPaths', 'drift', 'getDriftUnknownPaths', 2],
  ['canonicalizeDriftProperties', 'drift', 'canonicalizeDriftProperties', 2],
  ['canonicalizeDriftPair', 'drift', 'canonicalizeDriftPair', 3],
  ['canonicalizeUnsettledProperties', 'drift', 'canonicalizeUnsettledProperties', 2],
  ['readUnsettled', 'read-state', 'readUnsettled', 7],
  ['readCurrentState', 'read-state', 'readCurrentState', 3],
  ['isSameResource', 'read-state', 'isSameResource', 4],
  ['resourceIdentity', 'read-state', 'resourceIdentity', 3],
  ['readDbResourceIdIfExists', 'read-state', 'readDbResourceIdIfExists', 2],
  ['readCurrentStateDBInstance', 'read-state', 'readCurrentStateDBInstance', 1],
  ['readCurrentStateDBCluster', 'read-state', 'readCurrentStateDBCluster', 1],
  ['readCurrentStateDBSubnetGroup', 'subnet-group', 'readCurrentStateDBSubnetGroup', 1],
  ['attachTags', 'calls', 'attachTags', 2],
  ['importDBInstance', 'read-state', 'importDBInstance', 1],
  ['importDBCluster', 'read-state', 'importDBCluster', 1],
  ['importDBSubnetGroup', 'subnet-group', 'importDBSubnetGroup', 1],
];

const RDS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../src/provisioning/providers/rds'
);

/** [delegator, rds/waits.ts function, arguments a caller must pass, the defaults forwarded] */
const DEFAULTED: ReadonlyArray<readonly [string, string, number, readonly unknown[]]> = [
  ['waitForMemberAfterClusterChange', 'waitForMemberAfterClusterChange', 4, [1_800_000]],
  ['waitForClusterPortApplied', 'waitForClusterPortApplied', 3, [1_800_000]],
  ['waitForSecurityGroupsApplied', 'waitForSecurityGroupsApplied', 3, [1_800_000]],
  ['waitForClusterAvailable', 'waitForClusterAvailable', 2, [1_800_000, 'being created']],
  ['waitForClusterDeleted', 'waitForClusterDeleted', 2, [1_800_000]],
  ['waitForInstanceAvailable', 'waitForInstanceAvailable', 2, [1_800_000, 'being created']],
  ['waitForInstanceDeleted', 'waitForInstanceDeleted', 2, [1_800_000]],
];

describe('RDSProvider delegators hand off to their companion functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(DELEGATORS)('%s -> rds/%s.ts %s (%i arguments)', (method, module, target, arity) => {
    const fn = MODULE_EXPORTS[module][target] as ReturnType<typeof vi.fn>;
    const returned = Symbol(`returned by ${target}`);
    fn.mockReturnValue(returned);
    const provider = new RDSProvider({ region: 'us-east-1' });
    // One more argument than declared, so a delegator forwarding an extra
    // argument fails as well as one forwarding fewer than it declares.
    const args = Array.from({ length: arity + 1 }, (_, i) => Symbol(`arg ${i}`));

    const result = (provider as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!(
      ...args
    );

    expect(result).toBe(returned);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.contexts[0]).toBe(provider);
    expect(fn.mock.calls[0]).toStrictEqual(args.slice(0, arity));
  });

  it.each(DELEGATORS)(
    '%s: the row arity is rds/%s.ts %s’s declared parameter count',
    (_method, module, target, arity) => {
      const path = join(RDS_DIR, `${module}.ts`);
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest);
      const declared = source.statements.find(
        (s): s is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(s) && s.body !== undefined && s.name?.text === target
      );
      expect(declared, `${target} in rds/${module}.ts`).toBeDefined();
      const params = declared!.parameters.map((p) => p.name.getText(source));
      expect(params[0]).toBe('this');
      expect(params.length - 1).toBe(arity);
    }
  );

  // A caller omitting a defaulted argument gets the DELEGATOR's default, which
  // is what reaches the companion function: pin each default's value.
  it.each(DEFAULTED)(
    '%s forwards its defaults when the caller omits them',
    (method, target, required, defaults) => {
      const fn = waits[target as keyof typeof waits] as unknown as ReturnType<typeof vi.fn>;
      const provider = new RDSProvider({ region: 'us-east-1' });
      const args = Array.from({ length: required }, (_, i) => Symbol(`arg ${i}`));

      (provider as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!(...args);

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn.mock.calls[0]).toStrictEqual([...args, ...defaults]);
    }
  );

  it('lists every prototype method that delegates', () => {
    const delegating = Object.getOwnPropertyNames(RDSProvider.prototype).filter((name) => name !== 'constructor' &&
      /\.call\(this\b/.test(
        String((RDSProvider.prototype as unknown as Record<string, unknown>)[name])
      )
    );
    expect(delegating.sort()).toEqual(DELEGATORS.map(([name]) => name).sort());
  });
});
