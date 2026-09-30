import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * Issue #4111: a `DeletionPolicy: Snapshot` delete of an atomic-final-snapshot
 * type must not print the final-snapshot identifier, nor the physical id it is
 * built from, through the provider's own (unmasked) logger — the physical id
 * may come from a `{{resolve:secretsmanager:...}}` value. Both polarities:
 * each line is still emitted, naming the logical id.
 */

const mockSend = vi.hoisted(() => vi.fn());
const childLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

function clientMock(actualModule: string, clientName: string) {
  return async () => {
    const actual = await vi.importActual<Record<string, unknown>>(actualModule);
    return {
      ...actual,
      [clientName]: vi.fn().mockImplementation(() => ({
        send: mockSend,
        config: { region: () => Promise.resolve('us-east-1') },
      })),
    };
  };
}

vi.mock('@aws-sdk/client-rds', clientMock('@aws-sdk/client-rds', 'RDSClient'));
vi.mock('@aws-sdk/client-neptune', clientMock('@aws-sdk/client-neptune', 'NeptuneClient'));
vi.mock('@aws-sdk/client-docdb', clientMock('@aws-sdk/client-docdb', 'DocDBClient'));
vi.mock(
  '@aws-sdk/client-elasticache',
  clientMock('@aws-sdk/client-elasticache', 'ElastiCacheClient')
);

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => ({ ...childLogger, child: () => childLogger }),
    ...childLogger,
  }),
}));

import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import { NeptuneProvider } from '../../../src/provisioning/providers/neptune-provider.js';
import { DocDBProvider } from '../../../src/provisioning/providers/docdb-provider.js';
import { ElastiCacheProvider } from '../../../src/provisioning/providers/elasticache-provider.js';
import { buildFinalSnapshotIdentifier } from '../../../src/provisioning/final-snapshot.js';

/** The sanitized spelling a secret `Alice@Example.com` takes as an identifier. */
const SECRET_ID = 'alice-example-com';
const SECRET_WORD = 'alice';

interface Arm {
  label: string;
  make: () => {
    delete: (
      logicalId: string,
      physicalId: string,
      resourceType: string,
      properties: Record<string, unknown>,
      context: Record<string, unknown>
    ) => Promise<unknown>;
  };
  resourceType: string;
  subject: string;
  deleteCommand: string;
  describeCommand: string;
  describeKey: string;
  /** The status field the wait-for-deleted poll reads. */
  statusKey: string;
  /** The describe input field naming the resource. */
  idKey: string;
  notFound: string;
  /** Whether `--remove-protection` flips a DeletionProtection guard here. */
  protection: boolean;
}

const ARMS: Arm[] = [
  {
    label: 'RDS DBInstance',
    make: () => new RDSProvider(),
    resourceType: 'AWS::RDS::DBInstance',
    subject: 'DBInstance',
    deleteCommand: 'DeleteDBInstanceCommand',
    describeCommand: 'DescribeDBInstancesCommand',
    describeKey: 'DBInstances',
    statusKey: 'DBInstanceStatus',
    idKey: 'DBInstanceIdentifier',
    notFound: 'DBInstanceNotFoundFault',
    protection: true,
  },
  {
    label: 'RDS DBCluster',
    make: () => new RDSProvider(),
    resourceType: 'AWS::RDS::DBCluster',
    subject: 'DBCluster',
    deleteCommand: 'DeleteDBClusterCommand',
    describeCommand: 'DescribeDBClustersCommand',
    describeKey: 'DBClusters',
    statusKey: 'Status',
    idKey: 'DBClusterIdentifier',
    notFound: 'DBClusterNotFoundFault',
    protection: true,
  },
  {
    label: 'DocDB DBCluster',
    make: () => new DocDBProvider(),
    resourceType: 'AWS::DocDB::DBCluster',
    subject: 'DocDB DBCluster',
    deleteCommand: 'DeleteDBClusterCommand',
    describeCommand: 'DescribeDBClustersCommand',
    describeKey: 'DBClusters',
    statusKey: 'Status',
    idKey: 'DBClusterIdentifier',
    notFound: 'DBClusterNotFoundFault',
    protection: true,
  },
  {
    label: 'Neptune DBCluster',
    make: () => new NeptuneProvider(),
    resourceType: 'AWS::Neptune::DBCluster',
    subject: 'Neptune DBCluster',
    deleteCommand: 'DeleteDBClusterCommand',
    describeCommand: 'DescribeDBClustersCommand',
    describeKey: 'DBClusters',
    statusKey: 'Status',
    idKey: 'DBClusterIdentifier',
    notFound: 'DBClusterNotFoundFault',
    protection: true,
  },
  {
    label: 'ElastiCache CacheCluster',
    make: () => new ElastiCacheProvider(),
    resourceType: 'AWS::ElastiCache::CacheCluster',
    subject: 'CacheCluster',
    deleteCommand: 'DeleteCacheClusterCommand',
    describeCommand: 'DescribeCacheClustersCommand',
    describeKey: 'CacheClusters',
    statusKey: 'CacheClusterStatus',
    idKey: 'CacheClusterId',
    notFound: 'CacheClusterNotFoundFault',
    protection: false,
  },
];

type Scenario = 'deleted' | 'already-gone' | 'protection-flip-fails' | 'wait-times-out';

function stubAws(arm: Arm, scenario: Scenario): void {
  let deleted = false;
  let pollsAfterDelete = 0;
  mockSend.mockImplementation(
    (cmd: { constructor: { name: string }; input?: Record<string, unknown> }) => {
    const name = cmd.constructor.name;
    const notFound = () =>
      Promise.reject(Object.assign(new Error('not found'), { name: arm.notFound }));
    if (name === arm.deleteCommand) {
      if (scenario === 'already-gone') return notFound();
      deleted = true;
      return Promise.resolve({});
    }
    if (name === arm.describeCommand) {
      // Only the resource itself exists: a describe naming anything else
      // (the logical id passed where the physical id belongs) reads NotFound.
      if (cmd.input?.[arm.idKey] !== SECRET_ID) return notFound();
      if (deleted) {
        // Real AWS reads `deleting` on the first poll after the delete, which
        // is what makes the wait loop log its status line.
        pollsAfterDelete++;
        if (scenario === 'wait-times-out' || pollsAfterDelete === 1) {
          return Promise.resolve({ [arm.describeKey]: [{ [arm.statusKey]: 'deleting' }] });
        }
        return notFound();
      }
      if (scenario !== 'protection-flip-fails') return notFound();
      return Promise.resolve({
        [arm.describeKey]: [{ DeletionProtection: true, Status: 'available' }],
      });
    }
    if (name.startsWith('Modify')) {
      return Promise.reject(
        Object.assign(new Error('not authorized to perform this action'), {
          name: 'AccessDenied',
        })
      );
    }
    return Promise.resolve({});
  }
  );
}

/** Every post-delete describe named the physical id, and at least one ran. */
function expectWaitPolledPhysicalId(arm: Arm): void {
  const calls = mockSend.mock.calls.map((c) => c[0]);
  const deleteAt = calls.findIndex((c) => c.constructor.name === arm.deleteCommand);
  const polls = calls
    .slice(deleteAt + 1)
    .filter((c) => c.constructor.name === arm.describeCommand);
  expect(polls.length).toBeGreaterThan(0);
  for (const poll of polls) expect(poll.input[arm.idKey]).toBe(SECRET_ID);
}

function logLines(): string[] {
  return [childLogger.debug, childLogger.info, childLogger.warn, childLogger.error].flatMap(
    (fn) => fn.mock.calls.map((call) => call.map(String).join(' '))
  );
}

function expectNoIdentifierLogged(snap: string): void {
  const lines = logLines();
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(line).not.toContain(snap);
    expect(line).not.toContain(SECRET_ID);
    expect(line).not.toContain(SECRET_WORD);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const provider of [RDSProvider, DocDBProvider, NeptuneProvider, ElastiCacheProvider]) {
    vi.spyOn(
      provider.prototype as unknown as { sleep: (ms: number) => Promise<void> },
      'sleep'
    ).mockResolvedValue(undefined);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(ARMS)('$label Snapshot-policy delete log lines (#4111)', (arm) => {
  const snap = buildFinalSnapshotIdentifier(SECRET_ID, arm.resourceType);

  it('says a final snapshot is taken, under the logical id, without the identifier', async () => {
    stubAws(arm, 'deleted');
    await arm
      .make()
      .delete('MyRes', SECRET_ID, arm.resourceType, {}, { finalSnapshotIdentifier: snap });

    // The identifier still reaches AWS: only the log line changed.
    const del = mockSend.mock.calls.find((c) => c[0].constructor.name === arm.deleteCommand);
    expect(JSON.stringify(del?.[0].input)).toContain(snap);

    expect(childLogger.info).toHaveBeenCalledWith(
      `Deleting ${arm.subject} MyRes with a final snapshot (DeletionPolicy: Snapshot)`
    );
    expect(childLogger.debug).toHaveBeenCalledWith(`Deleting ${arm.subject} MyRes`);
    expect(childLogger.debug).toHaveBeenCalledWith(`${arm.subject} MyRes status: deleting`);
    expectWaitPolledPhysicalId(arm);
    expectNoIdentifierLogged(snap);
  });

  it('names the logical id when the wait for the delete times out', async () => {
    stubAws(arm, 'wait-times-out');
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 5 * 60 * 1000));

    const failure = await arm
      .make()
      .delete('MyRes', SECRET_ID, arm.resourceType, {}, { finalSnapshotIdentifier: snap })
      .then(
        () => undefined,
        (error: unknown) => error
      );

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain(`Timed out waiting for ${arm.subject} MyRes to be deleted`);
    // The loop polled before giving up, so its status line is covered here too.
    expect(childLogger.debug).toHaveBeenCalledWith(`${arm.subject} MyRes status: deleting`);
    expect(message).not.toContain(SECRET_WORD);
    expect(message).not.toContain(snap);
    expectNoIdentifierLogged(snap);
  });

  it('logs no final-snapshot line when the delete carries no identifier', async () => {
    stubAws(arm, 'deleted');
    await arm.make().delete('MyRes', SECRET_ID, arm.resourceType, {}, {});

    expect(childLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining('with a final snapshot')
    );
    expect(childLogger.debug).toHaveBeenCalledWith(`Deleting ${arm.subject} MyRes`);
    expectNoIdentifierLogged(snap);
  });

  it('names the logical id when the resource is already gone', async () => {
    stubAws(arm, 'already-gone');
    await arm
      .make()
      .delete('MyRes', SECRET_ID, arm.resourceType, {}, { finalSnapshotIdentifier: snap });

    expect(childLogger.debug).toHaveBeenCalledWith(
      `${arm.subject} MyRes does not exist, skipping deletion`
    );
    expectNoIdentifierLogged(snap);
  });

  it.runIf(arm.protection)(
    'names the logical id when --remove-protection cannot turn the guard off',
    async () => {
      stubAws(arm, 'protection-flip-fails');
      await arm.make().delete('MyRes', SECRET_ID, arm.resourceType, {}, {
        finalSnapshotIdentifier: snap,
        removeProtection: true,
      });

      expect(childLogger.debug).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(`^Could not disable deletion protection for ${arm.subject} MyRes: `)
        )
      );
      expectNoIdentifierLogged(snap);
    }
  );
});
