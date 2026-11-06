import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-v6';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { NeptuneClient } from '@aws-sdk/client-neptune';
import { EC2Client } from '@aws-sdk/client-ec2';

/**
 * `NeptuneProvider` keeps one delegator per method whose body moved into its
 * companion directory (`src/provisioning/providers/neptune/`): `method(...)`
 * is `return fn.call(this, ...)`. Each companion module's functions are
 * mocked here, so a delegator call reaches the mock and the HAND-OFF itself
 * is what is pinned: the same instance as `this` (not a fresh provider: each
 * one owns its own clients and `protectionFlips` registry), every declared
 * argument in order (none dropped, none swapped), and the callee's own return
 * value.
 *
 * Each body's behavior stays pinned by the per-feature suites; those reach
 * most delegators but not every argument of every one (a dropped
 * `maxWaitMs`, a swapped `logicalId` / `physicalId`), which is what this file
 * adds. `neptune/shared.ts` holds no method body and is not mocked.
 */

vi.mock('../../../src/provisioning/providers/neptune/core.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});
vi.mock('../../../src/provisioning/providers/neptune/subnet-group.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});
vi.mock('../../../src/provisioning/providers/neptune/cluster-create.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});
vi.mock('../../../src/provisioning/providers/neptune/cluster-update.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});
vi.mock('../../../src/provisioning/providers/neptune/cluster-delete.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});
vi.mock('../../../src/provisioning/providers/neptune/instance.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});
vi.mock('../../../src/provisioning/providers/neptune/waits.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});
vi.mock('../../../src/provisioning/providers/neptune/read-state.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});
vi.mock('../../../src/provisioning/providers/neptune/import.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});

import { NeptuneProvider } from '../../../src/provisioning/providers/neptune-provider.js';
import * as core from '../../../src/provisioning/providers/neptune/core.js';
import * as subnetGroup from '../../../src/provisioning/providers/neptune/subnet-group.js';
import * as clusterCreate from '../../../src/provisioning/providers/neptune/cluster-create.js';
import * as clusterUpdate from '../../../src/provisioning/providers/neptune/cluster-update.js';
import * as clusterDelete from '../../../src/provisioning/providers/neptune/cluster-delete.js';
import * as instance from '../../../src/provisioning/providers/neptune/instance.js';
import * as waits from '../../../src/provisioning/providers/neptune/waits.js';
import * as readState from '../../../src/provisioning/providers/neptune/read-state.js';
import * as importModule from '../../../src/provisioning/providers/neptune/import.js';

type Module =
  | 'core'
  | 'subnet-group'
  | 'cluster-create'
  | 'cluster-update'
  | 'cluster-delete'
  | 'instance'
  | 'waits'
  | 'read-state'
  | 'import';

const MODULE_EXPORTS: Record<Module, Record<string, unknown>> = {
  core: core,
  'subnet-group': subnetGroup,
  'cluster-create': clusterCreate,
  'cluster-update': clusterUpdate,
  'cluster-delete': clusterDelete,
  instance: instance,
  waits: waits,
  'read-state': readState,
  import: importModule,
};

/** [delegator, companion module, function it calls, declared parameter count] */
const DELEGATORS: ReadonlyArray<readonly [string, Module, string, number]> = [
  ['getClient', 'core', 'getClient', 0],
  ['getEc2Client', 'core', 'getEc2Client', 0],
  ['getCreateClient', 'core', 'getCreateClient', 0],
  ['create', 'core', 'create', 4],
  ['update', 'core', 'update', 6],
  ['delete', 'core', 'deleteImpl', 5],
  ['createDBSubnetGroup', 'subnet-group', 'createDBSubnetGroup', 4],
  ['updateDBSubnetGroup', 'subnet-group', 'updateDBSubnetGroup', 6],
  ['deleteDBSubnetGroup', 'subnet-group', 'deleteDBSubnetGroup', 4],
  ['createDBCluster', 'cluster-create', 'createDBCluster', 5],
  ['sendRestoreFollowUp', 'cluster-create', 'sendRestoreFollowUp', 5],
  ['warnIgnoredRestoreProperties', 'cluster-create', 'warnIgnoredRestoreProperties', 4],
  ['updateDBCluster', 'cluster-update', 'updateDBCluster', 6],
  ['deleteDBCluster', 'cluster-delete', 'deleteDBCluster', 4],
  ['deleteDBClusterOnce', 'cluster-delete', 'deleteDBClusterOnce', 5],
  ['createDBInstance', 'instance', 'createDBInstance', 5],
  ['updateDBInstance', 'instance', 'updateDBInstance', 6],
  ['deleteDBInstance', 'instance', 'deleteDBInstance', 4],
  ['deleteDBInstanceOnce', 'instance', 'deleteDBInstanceOnce', 5],
  ['wrapCaughtError', 'core', 'wrapCaughtError', 3],
  ['wrapDeleteError', 'core', 'wrapDeleteError', 3],
  ['applyTagDiff', 'core', 'applyTagDiff', 5],
  ['isNotFoundError', 'core', 'isNotFoundError', 2],
  ['isSameResource', 'core', 'isSameResource', 4],
  ['resourceIdentity', 'core', 'resourceIdentity', 3],
  ['readDbResourceIdIfExists', 'core', 'readDbResourceIdIfExists', 2],
  ['readClusterBlocks', 'cluster-update', 'readClusterBlocks', 4],
  ['applyClusterRoles', 'cluster-update', 'applyClusterRoles', 6],
  ['waitForClusterRolesSettled', 'cluster-update', 'waitForClusterRolesSettled', 5],
  ['waitForApplied', 'waits', 'waitForApplied', 3],
  ['pollUntilSettled', 'waits', 'pollUntilSettled', 1],
  ['describeDBCluster', 'waits', 'describeDBCluster', 1],
  ['warnKeptRemovals', 'cluster-update', 'warnKeptRemovals', 7],
  ['readPublicAccess', 'cluster-update', 'readPublicAccess', 5],
  ['warnPublicAccessKept', 'cluster-update', 'warnPublicAccessKept', 5],
  ['dbClusterSecurityGroupsToSend', 'cluster-update', 'dbClusterSecurityGroupsToSend', 6],
  ['describeDBInstance', 'waits', 'describeDBInstance', 1],
  ['waitForMemberAfterSecurityGroupChange', 'waits', 'waitForMemberAfterSecurityGroupChange', 3],
  ['requireClusterWhileWaiting', 'waits', 'requireClusterWhileWaiting', 2],
  ['waitForSecurityGroupsApplied', 'waits', 'waitForSecurityGroupsApplied', 4],
  ['deleteAfterProtectionFlip', 'cluster-delete', 'deleteAfterProtectionFlip', 3],
  ['waitForClusterAvailable', 'waits', 'waitForClusterAvailable', 4],
  ['waitForClusterDeleted', 'waits', 'waitForClusterDeleted', 3],
  ['waitForInstanceAvailable', 'waits', 'waitForInstanceAvailable', 3],
  ['waitForInstanceDeleted', 'waits', 'waitForInstanceDeleted', 2],
  ['sleep', 'waits', 'sleep', 1],
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
  ['readCurrentStateDBSubnetGroup', 'read-state', 'readCurrentStateDBSubnetGroup', 1],
  ['attachTags', 'read-state', 'attachTags', 2],
  ['importDBInstance', 'import', 'importDBInstance', 1],
  ['importDBCluster', 'import', 'importDBCluster', 1],
  ['importDBSubnetGroup', 'import', 'importDBSubnetGroup', 1],
];

const NEPTUNE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../src/provisioning/providers/neptune'
);

/** [delegator, companion module, arguments a caller must pass, the defaults forwarded] */
const DEFAULTED: ReadonlyArray<readonly [string, Module, number, readonly unknown[]]> = [
  ['warnKeptRemovals', 'cluster-update', 6, [true]],
  ['waitForMemberAfterSecurityGroupChange', 'waits', 2, [1_800_000]],
  ['waitForSecurityGroupsApplied', 'waits', 3, [1_800_000]],
  ['waitForClusterAvailable', 'waits', 2, ['being created', 1_800_000]],
  ['waitForClusterDeleted', 'waits', 2, [1_800_000]],
  ['waitForInstanceAvailable', 'waits', 2, [1_800_000]],
  ['waitForInstanceDeleted', 'waits', 1, [1_800_000]],
];

describe('NeptuneProvider delegators hand off to their companion functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(DELEGATORS)('%s -> neptune/%s.ts %s (%i arguments)', (method, module, target, arity) => {
    const fn = MODULE_EXPORTS[module][target] as ReturnType<typeof vi.fn>;
    const returned = Symbol(`returned by ${target}`);
    fn.mockReturnValue(returned);
    const provider = new NeptuneProvider({ region: 'us-east-1' });
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
    '%s: the row arity is neptune/%s.ts %s’s declared parameter count',
    (_method, module, target, arity) => {
      const path = join(NEPTUNE_DIR, `${module}.ts`);
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest);
      const declared = source.statements.find(
        (s): s is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(s) && s.body !== undefined && s.name?.text === target
      );
      expect(declared, `${target} in neptune/${module}.ts`).toBeDefined();
      const params = declared!.parameters.map((p) => p.name.getText(source));
      expect(params[0]).toBe('this');
      expect(params.length - 1).toBe(arity);
    }
  );

  // A caller omitting a defaulted argument gets the DELEGATOR's default, which
  // is what reaches the companion function: pin each default's value.
  it.each(DEFAULTED)(
    '%s forwards its defaults when the caller omits them',
    (method, module, required, defaults) => {
      const fn = MODULE_EXPORTS[module][method] as ReturnType<typeof vi.fn>;
      const provider = new NeptuneProvider({ region: 'us-east-1' });
      const args = Array.from({ length: required }, (_, i) => Symbol(`arg ${i}`));

      (provider as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!(...args);

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn.mock.calls[0]).toStrictEqual([...args, ...defaults]);
    }
  );

  it('lists every prototype method that delegates', () => {
    const delegating = Object.getOwnPropertyNames(NeptuneProvider.prototype).filter(
      (name) =>
        name !== 'constructor' &&
        /\.call\(this\b/.test(
          String((NeptuneProvider.prototype as unknown as Record<string, unknown>)[name])
        )
    );
    expect(delegating.sort()).toEqual(DELEGATORS.map(([name]) => name).sort());
  });
});

// The client getters moved with the SDK wiring: pin the client CLASS each
// builds and the region it is pinned to, through the real (unmocked) bodies.
describe('NeptuneProvider client getters (neptune/core.ts)', () => {
  it('builds a NeptuneClient, a separate create client, and an EC2Client in the pinned region', async () => {
    const actual = await vi.importActual<typeof import('../../../src/provisioning/providers/neptune/core.js')>(
      '../../../src/provisioning/providers/neptune/core.js'
    );
    const provider = new NeptuneProvider({ region: 'eu-west-2' });
    const client = actual.getClient.call(provider);
    expect(client).toBeInstanceOf(NeptuneClient);
    expect(await client.config.region()).toBe('eu-west-2');
    expect(actual.getClient.call(provider)).toBe(client);

    const createClient = actual.getCreateClient.call(provider);
    expect(createClient).toBeInstanceOf(NeptuneClient);
    expect(createClient).not.toBe(client);
    expect(await createClient.config.region()).toBe('eu-west-2');

    const ec2 = actual.getEc2Client.call(provider);
    expect(ec2).toBeInstanceOf(EC2Client);
    expect(await ec2.config.region()).toBe('eu-west-2');
  });
});
