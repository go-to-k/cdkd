/**
 * The `EFSProvider` method bodies live in `src/provisioning/providers/efs/*.ts`;
 * the class keeps one `return f.call(this, ...)` delegator per moved method,
 * and each argument a delegator hands on is a hand-off the split introduced.
 *
 * Every companion function is a pass-through spy on the real one. The first
 * block stubs each spy once and pins, for EVERY delegator, that it calls its
 * own function with the provider as `this`, every argument in declared order,
 * and returns that function's result. The second block runs real bodies end to
 * end and pins the SDK command each sends, by class and input.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-efs', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-efs')>('@aws-sdk/client-efs');
  return {
    ...actual,
    EFSClient: vi.fn().mockImplementation(() => ({
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

vi.mock('../../../src/provisioning/providers/efs/core.js', () =>
  spied('../../../src/provisioning/providers/efs/core.js')
);
vi.mock('../../../src/provisioning/providers/efs/file-system.js', () =>
  spied('../../../src/provisioning/providers/efs/file-system.js')
);
vi.mock('../../../src/provisioning/providers/efs/file-system-create.js', () =>
  spied('../../../src/provisioning/providers/efs/file-system-create.js')
);
vi.mock('../../../src/provisioning/providers/efs/mount-target.js', () =>
  spied('../../../src/provisioning/providers/efs/mount-target.js')
);
vi.mock('../../../src/provisioning/providers/efs/access-point.js', () =>
  spied('../../../src/provisioning/providers/efs/access-point.js')
);
vi.mock('../../../src/provisioning/providers/efs/read-state.js', () =>
  spied('../../../src/provisioning/providers/efs/read-state.js')
);

import {
  DeleteAccessPointCommand,
  DescribeAccessPointsCommand,
  DescribeFileSystemsCommand,
} from '@aws-sdk/client-efs';
import { EFSProvider } from '../../../src/provisioning/providers/efs-provider.js';
import * as core from '../../../src/provisioning/providers/efs/core.js';
import * as fileSystem from '../../../src/provisioning/providers/efs/file-system.js';
import * as fileSystemCreate from '../../../src/provisioning/providers/efs/file-system-create.js';
import * as mountTarget from '../../../src/provisioning/providers/efs/mount-target.js';
import * as accessPoint from '../../../src/provisioning/providers/efs/access-point.js';
import * as readState from '../../../src/provisioning/providers/efs/read-state.js';

const MODULES: Record<string, Record<string, unknown>> = {
  core,
  'file-system': fileSystem,
  'file-system-create': fileSystemCreate,
  'mount-target': mountTarget,
  'access-point': accessPoint,
  'read-state': readState,
};

/** [class method, companion module, companion function, declared parameter count] */
const DELEGATORS: ReadonlyArray<readonly [string, string, string, number]> = [
  ['getClient', 'core', 'getClient', 0],
  ['getMountTargetCreateClient', 'core', 'getMountTargetCreateClient', 0],
  ['wrapMaskedError', 'core', 'wrapMaskedError', 3],
  ['wrapDeleteError', 'core', 'wrapDeleteError', 3],
  ['create', 'core', 'create', 4],
  ['update', 'core', 'update', 6],
  ['applyTagDiff', 'core', 'applyTagDiff', 6],
  ['updateAccessPoint', 'access-point', 'updateAccessPoint', 6],
  ['updateFileSystem', 'file-system', 'updateFileSystem', 7],
  ['updateMountTarget', 'mount-target', 'updateMountTarget', 5],
  ['delete', 'core', 'deleteImpl', 5],
  ['warnOfPreLedgerHolder', 'file-system-create', 'warnOfPreLedgerHolder', 3],
  ['createFileSystem', 'file-system-create', 'createFileSystem', 4],
  ['sendCreateFileSystem', 'file-system-create', 'sendCreateFileSystem', 4],
  ['foreignHolderMessage', 'file-system-create', 'foreignHolderMessage', 4],
  ['applyLifecyclePolicies', 'file-system', 'applyLifecyclePolicies', 4],
  ['applyBackupPolicy', 'file-system', 'applyBackupPolicy', 3],
  ['applyFileSystemPolicy', 'file-system', 'applyFileSystemPolicy', 4],
  ['deleteFileSystemPolicy', 'file-system', 'deleteFileSystemPolicy', 2],
  ['applyFileSystemProtection', 'file-system', 'applyFileSystemProtection', 3],
  ['retryOnTransientControlPlane', 'core', 'retryOnTransientControlPlane', 4],
  ['deleteFileSystem', 'file-system', 'deleteFileSystem', 4],
  ['waitForFileSystemAvailable', 'file-system-create', 'waitForFileSystemAvailable', 4],
  ['createMountTarget', 'mount-target', 'createMountTarget', 5],
  ['optionalMountTargetString', 'mount-target', 'optionalMountTargetString', 4],
  ['waitForMountTargetAvailable', 'mount-target', 'waitForMountTargetAvailable', 4],
  ['deleteMountTarget', 'mount-target', 'deleteMountTarget', 4],
  ['waitForMountTargetDeleted', 'mount-target', 'waitForMountTargetDeleted', 2],
  ['createAccessPoint', 'access-point', 'createAccessPoint', 4],
  ['createOrAdoptAccessPoint', 'access-point', 'createOrAdoptAccessPoint', 4],
  ['deleteAccessPoint', 'access-point', 'deleteAccessPoint', 4],
  ['readCurrentState', 'core', 'readCurrentState', 3],
  ['readFileSystem', 'read-state', 'readFileSystem', 1],
  ['readAccessPoint', 'read-state', 'readAccessPoint', 1],
  ['readMountTarget', 'read-state', 'readMountTarget', 1],
  ['import', 'core', 'importImpl', 1],
  ['importFileSystem', 'read-state', 'importFileSystem', 1],
  ['importMountTarget', 'read-state', 'importMountTarget', 1],
  ['importAccessPoint', 'read-state', 'importAccessPoint', 1],
];

/** Methods whose bodies stay on the class. */
const KEPT_ON_CLASS = new Set(['constructor']);

type Callable = (...args: unknown[]) => unknown;
type Spy = ReturnType<typeof vi.fn>;

describe('EFSProvider delegators hand every argument and the result on', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the table names every method the class delegates', () => {
    const methods = Object.getOwnPropertyNames(EFSProvider.prototype).filter(
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
      const provider = new EFSProvider();
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

describe('EFSProvider moved bodies send the SDK command the delegator names', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
  });

  it('readCurrentState describes the file system the physical id names', async () => {
    mockSend.mockResolvedValue({ FileSystems: [] });
    await new EFSProvider().readCurrentState('fs-12345678', 'MyFs', 'AWS::EFS::FileSystem');
    const command = mockSend.mock.calls[0]![0] as DescribeFileSystemsCommand;
    expect(command).toBeInstanceOf(DescribeFileSystemsCommand);
    expect(command.input).toEqual({ FileSystemId: 'fs-12345678' });
  });

  it('readCurrentState describes the access point the physical id names', async () => {
    mockSend.mockResolvedValue({ AccessPoints: [] });
    await new EFSProvider().readCurrentState('fsap-12345678', 'MyAp', 'AWS::EFS::AccessPoint');
    const command = mockSend.mock.calls[0]![0] as DescribeAccessPointsCommand;
    expect(command).toBeInstanceOf(DescribeAccessPointsCommand);
    expect(command.input).toEqual({ AccessPointId: 'fsap-12345678' });
  });

  it('delete deletes the access point the physical id names', async () => {
    mockSend.mockResolvedValue({});
    await new EFSProvider().delete('MyAp', 'fsap-12345678', 'AWS::EFS::AccessPoint');
    const deletes = mockSend.mock.calls
      .map(([c]) => c as { input: unknown })
      .filter((c) => c instanceof DeleteAccessPointCommand);
    expect(deletes.map((c) => c.input)).toEqual([{ AccessPointId: 'fsap-12345678' }]);
  });
});
