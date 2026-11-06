/**
 * The `S3TablesProvider` method bodies live in
 * `src/provisioning/providers/s3-tables/*.ts`; the class keeps one
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

vi.mock('@aws-sdk/client-s3tables', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-s3tables')>(
    '@aws-sdk/client-s3tables'
  );
  return {
    ...actual,
    S3TablesClient: vi.fn().mockImplementation(() => ({
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

vi.mock('../../../src/provisioning/providers/s3-tables/core.js', () =>
  spied('../../../src/provisioning/providers/s3-tables/core.js')
);
vi.mock('../../../src/provisioning/providers/s3-tables/table-bucket.js', () =>
  spied('../../../src/provisioning/providers/s3-tables/table-bucket.js')
);
vi.mock('../../../src/provisioning/providers/s3-tables/namespace.js', () =>
  spied('../../../src/provisioning/providers/s3-tables/namespace.js')
);
vi.mock('../../../src/provisioning/providers/s3-tables/table.js', () =>
  spied('../../../src/provisioning/providers/s3-tables/table.js')
);
vi.mock('../../../src/provisioning/providers/s3-tables/read-state.js', () =>
  spied('../../../src/provisioning/providers/s3-tables/read-state.js')
);
vi.mock('../../../src/provisioning/providers/s3-tables/import.js', () =>
  spied('../../../src/provisioning/providers/s3-tables/import.js')
);
vi.mock('../../../src/provisioning/providers/s3-tables/tags.js', () =>
  spied('../../../src/provisioning/providers/s3-tables/tags.js')
);

import { DeleteNamespaceCommand, GetTableBucketCommand } from '@aws-sdk/client-s3tables';
import { S3TablesProvider } from '../../../src/provisioning/providers/s3-tables-provider.js';
import * as core from '../../../src/provisioning/providers/s3-tables/core.js';
import * as tableBucket from '../../../src/provisioning/providers/s3-tables/table-bucket.js';
import * as namespace from '../../../src/provisioning/providers/s3-tables/namespace.js';
import * as table from '../../../src/provisioning/providers/s3-tables/table.js';
import * as readState from '../../../src/provisioning/providers/s3-tables/read-state.js';
import * as imp from '../../../src/provisioning/providers/s3-tables/import.js';
import * as tags from '../../../src/provisioning/providers/s3-tables/tags.js';

const MODULES: Record<string, Record<string, unknown>> = {
  core,
  'table-bucket': tableBucket,
  namespace,
  table,
  'read-state': readState,
  import: imp,
  tags,
};

/** [class method, companion module, companion function, declared parameter count] */
const DELEGATORS: ReadonlyArray<readonly [string, string, string, number]> = [
  ['wrapCaughtError', 'core', 'wrapCaughtError', 3],
  ['getClient', 'core', 'getClient', 0],
  ['getCreateClient', 'core', 'getCreateClient', 0],
  ['create', 'core', 'create', 4],
  ['update', 'core', 'update', 6],
  ['applyUpdate', 'core', 'applyUpdate', 8],
  ['delete', 'core', 'deleteImpl', 5],
  ['createTableBucket', 'table-bucket', 'createTableBucket', 4],
  ['applyTableBucketConfigUpdate', 'table-bucket', 'applyTableBucketConfigUpdate', 6],
  ['applyTableMaintenanceUpdate', 'table-bucket', 'applyTableMaintenanceUpdate', 6],
  ['warnRemovalKept', 'table-bucket', 'warnRemovalKept', 2],
  ['deleteBucketConfig', 'table-bucket', 'deleteBucketConfig', 2],
  ['deleteTableBucket', 'table-bucket', 'deleteTableBucket', 4],
  ['emptyTableBucket', 'table-bucket', 'emptyTableBucket', 1],
  ['createNamespace', 'namespace', 'createNamespace', 4],
  ['deleteNamespace', 'namespace', 'deleteNamespace', 4],
  ['createTable', 'table', 'createTable', 4],
  ['readCurrentState', 'read-state', 'readCurrentState', 3],
  ['readTableBucketCurrentState', 'read-state', 'readTableBucketCurrentState', 1],
  ['readTableBucketConfigs', 'read-state', 'readTableBucketConfigs', 2],
  ['readConfig', 'read-state', 'readConfig', 5],
  ['readNamespaceCurrentState', 'read-state', 'readNamespaceCurrentState', 1],
  ['resolveTableParts', 'read-state', 'resolveTableParts', 1],
  ['readTableCurrentState', 'read-state', 'readTableCurrentState', 1],
  ['readTableMaintenance', 'read-state', 'readTableMaintenance', 3],
  ['readUnsettled', 'read-state', 'readUnsettled', 4],
  ['import', 'import', 'importImpl', 1],
  ['importTableBucket', 'import', 'importTableBucket', 1],
  ['importNamespace', 'import', 'importNamespace', 1],
  ['importTable', 'import', 'importTable', 1],
  ['deleteTable', 'table', 'deleteTable', 4],
  ['tagListToSdkMap', 'tags', 'tagListToSdkMap', 1],
  ['planTableRename', 'table', 'planTableRename', 5],
  ['renameAlreadyApplied', 'table', 'renameAlreadyApplied', 2],
  ['lookupTableArn', 'table', 'lookupTableArn', 3],
  ['readTagsBestEffort', 'tags', 'readTagsBestEffort', 1],
  ['applyTableTagsDiff', 'tags', 'applyTableTagsDiff', 6],
  ['applyTableBucketTagsDiff', 'tags', 'applyTableBucketTagsDiff', 6],
];

/** Methods whose bodies stay on the class. */
const KEPT_ON_CLASS = new Set([
  'constructor',
  'getDriftUnknownPaths',
  'getDriftAbsentMeansDefaultKeys',
]);

type Callable = (...args: unknown[]) => unknown;
type Spy = ReturnType<typeof vi.fn>;

const BUCKET_ARN = 'arn:aws:s3tables:us-east-1:123456789012:bucket/my-bucket';

describe('S3TablesProvider delegators hand every argument and the result on', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the table names every method the class delegates', () => {
    const methods = Object.getOwnPropertyNames(S3TablesProvider.prototype).filter(
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
      const provider = new S3TablesProvider();
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

describe('S3TablesProvider moved bodies send the SDK command the delegator names', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
  });

  it('readCurrentState reads the table bucket the physical id names', async () => {
    mockSend.mockResolvedValue({});
    await new S3TablesProvider().readCurrentState(
      BUCKET_ARN,
      'MyBucket',
      'AWS::S3Tables::TableBucket'
    );
    const command = mockSend.mock.calls[0]![0] as GetTableBucketCommand;
    expect(command).toBeInstanceOf(GetTableBucketCommand);
    expect(command.input).toEqual({ tableBucketARN: BUCKET_ARN });
  });

  it('delete deletes the namespace the physical id names', async () => {
    mockSend.mockResolvedValue({});
    await new S3TablesProvider().delete(
      'MyNamespace',
      `${BUCKET_ARN}|my_ns`,
      'AWS::S3Tables::Namespace'
    );
    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0]![0] as DeleteNamespaceCommand;
    expect(command).toBeInstanceOf(DeleteNamespaceCommand);
    expect(command.input).toEqual({ tableBucketARN: BUCKET_ARN, namespace: 'my_ns' });
  });
});
