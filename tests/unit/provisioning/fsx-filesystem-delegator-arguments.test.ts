/**
 * The `FSxFileSystemProvider` method bodies live in
 * `src/provisioning/providers/fsx-filesystem/*.ts`; the class keeps one
 * `return f.call(this, ...)` delegator per moved method, and each argument a
 * delegator hands on is a hand-off the split introduced.
 *
 * Every companion function is a pass-through spy on the real one. The first
 * block stubs each spy once and pins, for EVERY delegator, that it calls its
 * own function with the provider as `this`, every argument in declared order,
 * and returns that function's result. The second block runs real bodies end to
 * end and pins the SDK command each sends, by class and input.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-fsx', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-fsx')>('@aws-sdk/client-fsx');
  return {
    ...actual,
    FSxClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

/** Replace every function a module exports with a pass-through spy. */
async function spied(path: string): Promise<Record<string, unknown>> {
  const actual = await vi.importActual<Record<string, unknown>>(path);
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === 'function' ? vi.fn(v as (...a: unknown[]) => unknown) : v,
    ])
  );
}

vi.mock('../../../src/provisioning/providers/fsx-filesystem/core.js', () =>
  spied('../../../src/provisioning/providers/fsx-filesystem/core.js')
);
vi.mock('../../../src/provisioning/providers/fsx-filesystem/create.js', () =>
  spied('../../../src/provisioning/providers/fsx-filesystem/create.js')
);
vi.mock('../../../src/provisioning/providers/fsx-filesystem/mappers.js', () =>
  spied('../../../src/provisioning/providers/fsx-filesystem/mappers.js')
);
vi.mock('../../../src/provisioning/providers/fsx-filesystem/update.js', () =>
  spied('../../../src/provisioning/providers/fsx-filesystem/update.js')
);
vi.mock('../../../src/provisioning/providers/fsx-filesystem/variant-diff.js', () =>
  spied('../../../src/provisioning/providers/fsx-filesystem/variant-diff.js')
);
vi.mock('../../../src/provisioning/providers/fsx-filesystem/aliases.js', () =>
  spied('../../../src/provisioning/providers/fsx-filesystem/aliases.js')
);
vi.mock('../../../src/provisioning/providers/fsx-filesystem/delete.js', () =>
  spied('../../../src/provisioning/providers/fsx-filesystem/delete.js')
);
vi.mock('../../../src/provisioning/providers/fsx-filesystem/lifecycle.js', () =>
  spied('../../../src/provisioning/providers/fsx-filesystem/lifecycle.js')
);
vi.mock('../../../src/provisioning/providers/fsx-filesystem/read-state.js', () =>
  spied('../../../src/provisioning/providers/fsx-filesystem/read-state.js')
);

import { DeleteFileSystemCommand, DescribeFileSystemsCommand } from '@aws-sdk/client-fsx';
import { FSxFileSystemProvider } from '../../../src/provisioning/providers/fsx-filesystem-provider.js';
import * as core from '../../../src/provisioning/providers/fsx-filesystem/core.js';
import * as create from '../../../src/provisioning/providers/fsx-filesystem/create.js';
import * as mappers from '../../../src/provisioning/providers/fsx-filesystem/mappers.js';
import * as update from '../../../src/provisioning/providers/fsx-filesystem/update.js';
import * as variantDiff from '../../../src/provisioning/providers/fsx-filesystem/variant-diff.js';
import * as aliases from '../../../src/provisioning/providers/fsx-filesystem/aliases.js';
import * as del from '../../../src/provisioning/providers/fsx-filesystem/delete.js';
import * as lifecycle from '../../../src/provisioning/providers/fsx-filesystem/lifecycle.js';
import * as readState from '../../../src/provisioning/providers/fsx-filesystem/read-state.js';

const MODULES: Record<string, Record<string, unknown>> = {
  core,
  create,
  mappers,
  update,
  'variant-diff': variantDiff,
  aliases,
  delete: del,
  lifecycle,
  'read-state': readState,
};

/** [class method, companion module, companion function, declared parameter count] */
const DELEGATORS: ReadonlyArray<readonly [string, string, string, number]> = [
  ['wrapStatusReasonError', 'core', 'wrapStatusReasonError', 3],
  ['wrapCaughtError', 'core', 'wrapCaughtError', 3],
  ['cleanupFailureText', 'core', 'cleanupFailureText', 3],
  ['getClient', 'core', 'getClient', 0],
  ['create', 'create', 'create', 4],
  ['toCreateLustreConfiguration', 'create', 'toCreateLustreConfiguration', 1],
  ['toLustreLogConfiguration', 'create', 'toLustreLogConfiguration', 1],
  ['toCreateWindowsConfiguration', 'create', 'toCreateWindowsConfiguration', 1],
  ['toCreateOntapConfiguration', 'create', 'toCreateOntapConfiguration', 1],
  ['toCreateOpenZFSConfiguration', 'create', 'toCreateOpenZFSConfiguration', 1],
  ['toDiskIopsConfiguration', 'mappers', 'toDiskIopsConfiguration', 1],
  ['toSelfManagedAdConfiguration', 'mappers', 'toSelfManagedAdConfiguration', 1],
  ['toSelfManagedAdConfigurationUpdates', 'mappers', 'toSelfManagedAdConfigurationUpdates', 1],
  ['toWindowsAuditLogConfiguration', 'mappers', 'toWindowsAuditLogConfiguration', 1],
  ['toWindowsFsrmConfiguration', 'mappers', 'toWindowsFsrmConfiguration', 1],
  ['toOpenZFSRootVolumeConfiguration', 'mappers', 'toOpenZFSRootVolumeConfiguration', 1],
  ['toOpenZFSReadCacheConfiguration', 'mappers', 'toOpenZFSReadCacheConfiguration', 1],
  ['update', 'update', 'update', 6],
  ['detectVariantConfigKey', 'variant-diff', 'detectVariantConfigKey', 2],
  ['computeVariantConfigDiff', 'variant-diff', 'computeVariantConfigDiff', 5],
  ['unmappedMutableSubprop', 'variant-diff', 'unmappedMutableSubprop', 2],
  ['applyLustreUpdateField', 'variant-diff', 'applyLustreUpdateField', 4],
  ['applyWindowsUpdateField', 'variant-diff', 'applyWindowsUpdateField', 4],
  ['applyOntapUpdateField', 'variant-diff', 'applyOntapUpdateField', 5],
  ['applyOpenZFSUpdateField', 'variant-diff', 'applyOpenZFSUpdateField', 5],
  ['applyAliasDelta', 'aliases', 'applyAliasDelta', 5],
  ['describeAliases', 'aliases', 'describeAliases', 1],
  ['waitForNoAdministrativeAction', 'aliases', 'waitForNoAdministrativeAction', 4],
  ['sendAliasCall', 'aliases', 'sendAliasCall', 5],
  ['waitForAliases', 'aliases', 'waitForAliases', 6],
  ['applyTagDiff', 'aliases', 'applyTagDiff', 5],
  ['delete', 'delete', 'deleteImpl', 5],
  ['toDeleteOpenZFSOptions', 'delete', 'toDeleteOpenZFSOptions', 1],
  ['isSameResource', 'lifecycle', 'isSameResource', 4],
  ['readFileSystemForIdentity', 'lifecycle', 'readFileSystemForIdentity', 1],
  ['describeForPoll', 'lifecycle', 'describeForPoll', 3],
  ['waitForFileSystemAvailable', 'lifecycle', 'waitForFileSystemAvailable', 4],
  ['waitForUpdateActionComplete', 'lifecycle', 'waitForUpdateActionComplete', 7],
  ['waitForFileSystemDeleted', 'lifecycle', 'waitForFileSystemDeleted', 4],
  ['buildAttributes', 'read-state', 'buildAttributes', 1],
  ['getAttribute', 'read-state', 'getAttribute', 3],
  ['readLustreConfiguration', 'read-state', 'readLustreConfiguration', 1],
  ['readWindowsConfiguration', 'read-state', 'readWindowsConfiguration', 1],
  ['readOntapConfiguration', 'read-state', 'readOntapConfiguration', 1],
  ['readOpenZFSConfiguration', 'read-state', 'readOpenZFSConfiguration', 1],
  ['readDiskIopsConfiguration', 'read-state', 'readDiskIopsConfiguration', 1],
  ['canonicalizeDriftProperties', 'read-state', 'canonicalizeDriftProperties', 2],
  ['canonicalizeWindowsAliases', 'read-state', 'canonicalizeWindowsAliases', 1],
  ['getDriftUnknownPaths', 'read-state', 'getDriftUnknownPaths', 1],
  ['getDriftUnorderedPaths', 'read-state', 'getDriftUnorderedPaths', 1],
  ['readCurrentState', 'read-state', 'readCurrentState', 3],
  ['import', 'read-state', 'importImpl', 1],
];

/** Methods whose bodies stay on the class. */
const KEPT_ON_CLASS = new Set(['constructor', 'getMinResourceTimeoutMs']);

type Callable = (...args: unknown[]) => unknown;
type Spy = ReturnType<typeof vi.fn>;

const RESOURCE_TYPE = 'AWS::FSx::FileSystem';
const FS_ID = 'fs-0123456789abcdef0';

describe('FSxFileSystemProvider delegators hand every argument and the result on', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the table names every method the class delegates', () => {
    const methods = Object.getOwnPropertyNames(FSxFileSystemProvider.prototype).filter(
      (m) => !KEPT_ON_CLASS.has(m)
    );
    expect(methods.sort()).toEqual(DELEGATORS.map(([m]) => m).sort());
  });

  for (const [method, mod, fn, arity] of DELEGATORS) {
    it(`${method} calls ${mod}.${fn} with this, ${arity} argument(s) in order, and returns its result`, () => {
      const spy = MODULES[mod]![fn] as Spy;
      expect(vi.isMockFunction(spy), `${mod}.${fn} is not spied`).toBe(true);
      const result = { result: method };
      spy.mockImplementationOnce(() => result);
      const provider = new FSxFileSystemProvider();
      const args = Array.from({ length: arity }, (_, i) => ({ arg: i }));
      const returned = (provider as unknown as Record<string, Callable>)[method]!(...args);
      expect(returned).toBe(result);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]).toEqual(args);
      spy.mock.calls[0]!.forEach((a, i) => expect(a).toBe(args[i]));
      expect(spy.mock.contexts[0]).toBe(provider);
    });
  }
});

describe('FSxFileSystemProvider moved bodies send the SDK command the delegator names', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
  });

  it('readCurrentState describes the file system the physical id names', async () => {
    mockSend.mockResolvedValue({ FileSystems: [] });
    await new FSxFileSystemProvider().readCurrentState(FS_ID, 'MyFs', RESOURCE_TYPE);
    const command = mockSend.mock.calls[0]![0] as DescribeFileSystemsCommand;
    expect(command).toBeInstanceOf(DescribeFileSystemsCommand);
    expect(command.input).toEqual({ FileSystemIds: [FS_ID] });
  });

  it('delete deletes the file system the physical id names, with its recorded OpenZFS options', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeFileSystemsCommand) return { FileSystems: [] };
      return {};
    });
    await new FSxFileSystemProvider({ pollIntervalMs: 1 }).delete('MyFs', FS_ID, RESOURCE_TYPE, {
      FileSystemType: 'OPENZFS',
      OpenZFSConfiguration: { Options: ['DELETE_CHILD_VOLUMES_AND_SNAPSHOTS'] },
    });
    const deletes = mockSend.mock.calls
      .map(([c]) => c as { input: unknown })
      .filter((c) => c instanceof DeleteFileSystemCommand);
    expect(deletes.map((c) => c.input)).toEqual([
      {
        FileSystemId: FS_ID,
        OpenZFSConfiguration: { Options: ['DELETE_CHILD_VOLUMES_AND_SNAPSHOTS'] },
      },
    ]);
    expect(
      mockSend.mock.calls.some(([c]) => c instanceof DescribeFileSystemsCommand),
      'the delete waits for the file system to be gone'
    ).toBe(true);
  });
});
