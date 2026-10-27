// issue #5426: the CREATE-path `available` waits of the RDS, DocDB and Neptune
// DBCluster / DBInstance providers fail at once when the new resource enters a
// terminal status (`isTerminalDbWaitStatus`), naming the template logical id
// and the status, instead of polling for the 30-minute budget. The
// `inaccessible-encryption-credentials-recoverable` status keeps the wait
// polling, as do the update-path cluster waits (#5411 / #5417 / #5419).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend, mockWarn } = vi.hoisted(() => ({ mockSend: vi.fn(), mockWarn: vi.fn() }));

function clientMock(name: string) {
  return async (importOriginal: () => Promise<unknown>) => {
    const orig = (await importOriginal()) as Record<string, unknown>;
    return {
      ...orig,
      [name]: vi.fn().mockImplementation(() => ({
        send: mockSend,
        config: { region: () => Promise.resolve('us-east-1') },
      })),
    };
  };
}

vi.mock('@aws-sdk/client-rds', clientMock('RDSClient'));
vi.mock('@aws-sdk/client-docdb', clientMock('DocDBClient'));
vi.mock('@aws-sdk/client-neptune', clientMock('NeptuneClient'));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import { DocDBProvider } from '../../../src/provisioning/providers/docdb-provider.js';
import { NeptuneProvider } from '../../../src/provisioning/providers/neptune-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

type Provider = RDSProvider | DocDBProvider | NeptuneProvider;

interface Site {
  readonly name: string;
  /** The message's resource label, e.g. `DocDB DBCluster`. */
  readonly label: string;
  readonly type: string;
  readonly kind: 'cluster' | 'instance';
  readonly make: () => Provider;
  readonly props: Record<string, unknown>;
}

const CLUSTER_ID = 'my-cluster-physical';
const INSTANCE_ID = 'my-db-physical';

const sites: Site[] = [
  {
    name: 'RDS DBCluster',
    label: 'DBCluster',
    type: 'AWS::RDS::DBCluster',
    kind: 'cluster',
    make: () => new RDSProvider(),
    props: { DBClusterIdentifier: CLUSTER_ID, Engine: 'aurora-mysql' },
  },
  {
    name: 'RDS DBInstance',
    label: 'DBInstance',
    type: 'AWS::RDS::DBInstance',
    kind: 'instance',
    make: () => new RDSProvider(),
    props: { DBInstanceIdentifier: INSTANCE_ID, DBInstanceClass: 'db.t3.micro', Engine: 'mysql' },
  },
  {
    name: 'DocDB DBCluster',
    label: 'DocDB DBCluster',
    type: 'AWS::DocDB::DBCluster',
    kind: 'cluster',
    make: () => new DocDBProvider(),
    props: { DBClusterIdentifier: CLUSTER_ID },
  },
  {
    name: 'DocDB DBInstance',
    label: 'DocDB DBInstance',
    type: 'AWS::DocDB::DBInstance',
    kind: 'instance',
    make: () => new DocDBProvider(),
    props: {
      DBInstanceIdentifier: INSTANCE_ID,
      DBInstanceClass: 'db.r5.large',
      DBClusterIdentifier: CLUSTER_ID,
    },
  },
  {
    name: 'Neptune DBCluster',
    label: 'Neptune DBCluster',
    type: 'AWS::Neptune::DBCluster',
    kind: 'cluster',
    make: () => new NeptuneProvider(),
    props: { DBClusterIdentifier: CLUSTER_ID },
  },
  {
    name: 'Neptune DBInstance',
    label: 'Neptune DBInstance',
    type: 'AWS::Neptune::DBInstance',
    kind: 'instance',
    make: () => new NeptuneProvider(),
    props: {
      DBInstanceIdentifier: INSTANCE_ID,
      DBInstanceClass: 'db.r5.large',
      DBClusterIdentifier: CLUSTER_ID,
    },
  },
];

const LOGICAL_ID = 'TheResource';

/**
 * Route the create, then answer each describe with the next of `statuses`
 * (the last one repeating). Every other command (the RDS cluster's own
 * created-before-failure cleanup) answers `{}`.
 */
function route(site: Site, statuses: string[]): { describes: () => number } {
  let read = 0;
  mockSend.mockImplementation(async (command: object) => {
    const name = command.constructor.name;
    if (name === 'CreateDBClusterCommand') {
      return { DBCluster: { DBClusterIdentifier: CLUSTER_ID } };
    }
    if (name === 'CreateDBInstanceCommand') {
      return { DBInstance: { DBInstanceIdentifier: INSTANCE_ID } };
    }
    const status = statuses[Math.min(read, statuses.length - 1)];
    if (name === 'DescribeDBClustersCommand' && site.kind === 'cluster') {
      read += 1;
      return { DBClusters: [{ DBClusterIdentifier: CLUSTER_ID, Status: status }] };
    }
    if (name === 'DescribeDBInstancesCommand' && site.kind === 'instance') {
      read += 1;
      return { DBInstances: [{ DBInstanceIdentifier: INSTANCE_ID, DBInstanceStatus: status }] };
    }
    if (name.startsWith('Describe')) throw new Error(`unexpected ${name}`);
    return {};
  });
  return { describes: () => read };
}

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

describe.each(sites)('$name create-path available wait (issue #5426)', (site) => {
  const savedNoWait = process.env['CDKD_NO_WAIT'];
  let provider: Provider;
  let sleeps: number;

  beforeEach(() => {
    mockSend.mockReset();
    delete process.env['CDKD_NO_WAIT'];
    provider = site.make();
    sleeps = 0;
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {
      sleeps += 1;
    };
  });

  afterEach(() => {
    if (savedNoWait === undefined) delete process.env['CDKD_NO_WAIT'];
    else process.env['CDKD_NO_WAIT'] = savedNoWait;
  });

  const create = () => provider.create(LOGICAL_ID, site.type, site.props);

  it.each(['incompatible-parameters', 'inaccessible-encryption-credentials', 'failed'])(
    'fails at once on the terminal status %s, naming the logical id and the status',
    async (status) => {
      const { describes } = route(site, ['creating', status, 'available']);

      const error = await caught(create());

      expect(error.message).toContain(
        `${site.label} ${LOGICAL_ID} entered status ${status} while being created`
      );
      // The template logical id, never the physical identifier.
      expect(error.message).not.toContain(
        site.kind === 'cluster' ? CLUSTER_ID : INSTANCE_ID
      );
      // `creating`, then the terminal read: one sleep, no further poll.
      expect(describes()).toBe(2);
      expect(sleeps).toBe(1);
      // What the create materialized is still retired, only sooner: the RDS
      // cluster deletes it in its own catch (#376), the others hand it to the
      // engine's created-before-failure cleanup (#4583).
      if (site.name === 'RDS DBCluster') {
        const deletes = mockSend.mock.calls
          .map((call) => call[0] as { constructor: { name: string }; input: unknown })
          .filter((command) => command.constructor.name === 'DeleteDBClusterCommand');
        expect(deletes.map((command) => command.input)).toEqual([
          { DBClusterIdentifier: CLUSTER_ID, SkipFinalSnapshot: true },
        ]);
      } else {
        expect(createdBeforeFailure(error, LOGICAL_ID, site.type)).toBe(
          site.kind === 'cluster' ? CLUSTER_ID : INSTANCE_ID
        );
      }
    }
  );

  it('keeps polling through inaccessible-encryption-credentials-recoverable', async () => {
    const { describes } = route(site, [
      'creating',
      'inaccessible-encryption-credentials-recoverable',
      'available',
    ]);

    const result = await create();

    expect(result.physicalId).toBe(site.kind === 'cluster' ? CLUSTER_ID : INSTANCE_ID);
    // Three wait reads plus the final attribute describe.
    expect(describes()).toBe(4);
    expect(sleeps).toBe(2);
  });

  it('keeps polling through creating and returns once available (negative control)', async () => {
    const { describes } = route(site, ['creating', 'backing-up', 'available']);

    await create();

    expect(describes()).toBe(4);
  });
});

describe.each([
  { name: 'RDS', make: () => new RDSProvider() as Provider },
  { name: 'DocDB', make: () => new DocDBProvider() as Provider },
  { name: 'Neptune', make: () => new NeptuneProvider() as Provider },
])('$name update-path cluster wait and -recoverable (issue #5426)', ({ make }) => {
  const require = (status: string) =>
    (
      make() as unknown as {
        requireClusterWhileWaiting: (c: unknown, logicalId: string, change: string) => unknown;
      }
    ).requireClusterWhileWaiting({ Status: status }, 'MyCluster', 'VPC security groups');

  it('keeps waiting on inaccessible-encryption-credentials-recoverable', () => {
    expect(require('inaccessible-encryption-credentials-recoverable')).toEqual({
      Status: 'inaccessible-encryption-credentials-recoverable',
    });
  });

  it('still fails at once on inaccessible-encryption-credentials', () => {
    expect(() => require('inaccessible-encryption-credentials')).toThrow(
      'MyCluster entered status inaccessible-encryption-credentials'
    );
  });
});

describe('RDS DBCluster create cleanup after a terminal status (issue #5426)', () => {
  const savedNoWait = process.env['CDKD_NO_WAIT'];
  let provider: RDSProvider;

  beforeEach(() => {
    mockSend.mockReset();
    mockWarn.mockReset();
    delete process.env['CDKD_NO_WAIT'];
    provider = new RDSProvider();
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
  });

  afterEach(() => {
    if (savedNoWait === undefined) delete process.env['CDKD_NO_WAIT'];
    else process.env['CDKD_NO_WAIT'] = savedNoWait;
  });

  /** `statuses` answer the describes in order (the last repeating); DeleteDBCluster answers `deleteResult`. */
  function routeCleanup(statuses: Array<string | Error>, deleteResult: () => unknown): void {
    let read = 0;
    mockSend.mockImplementation(async (command: object) => {
      const name = command.constructor.name;
      if (name === 'CreateDBClusterCommand') return { DBCluster: { DBClusterIdentifier: CLUSTER_ID } };
      if (name === 'DescribeDBClustersCommand') {
        const next = statuses[Math.min(read, statuses.length - 1)];
        read += 1;
        if (next instanceof Error) throw next;
        return { DBClusters: [{ DBClusterIdentifier: CLUSTER_ID, Status: next }] };
      }
      if (name === 'DeleteDBClusterCommand') return deleteResult();
      if (name === 'ModifyDBClusterCommand') return {};
      throw new Error(`unexpected ${name}`);
    });
  }

  const refused = () => {
    throw Object.assign(new Error('DB cluster is already being deleted.'), {
      name: 'InvalidDBClusterStateFault',
    });
  };
  const warnings = () => mockWarn.mock.calls.map((call) => String(call[0]));
  const create = (props: Record<string, unknown> = {}) =>
    provider.create(LOGICAL_ID, 'AWS::RDS::DBCluster', {
      DBClusterIdentifier: CLUSTER_ID,
      Engine: 'aurora-mysql',
      ...props,
    });

  it('turns DeletionProtection off before the cleanup delete when the template declared it', async () => {
    routeCleanup(['incompatible-parameters'], () => ({}));

    const error = await caught(create({ DeletionProtection: true }));

    expect(error.message).toContain(`DBCluster ${LOGICAL_ID} entered status incompatible-parameters`);
    const sent = mockSend.mock.calls
      .map((call) => (call[0] as { constructor: { name: string } }).constructor.name)
      .filter((name) => name === 'ModifyDBClusterCommand' || name === 'DeleteDBClusterCommand');
    expect(sent).toEqual(['ModifyDBClusterCommand', 'DeleteDBClusterCommand']);
  });

  it('a refused cleanup on a cluster already deleting says so, not that it is still billing', async () => {
    routeCleanup(['deleting'], refused);

    const error = await caught(create());

    expect(error.message).toContain(`DBCluster ${LOGICAL_ID} entered status deleting`);
    expect(warnings()).toEqual([
      `Partially-created DBCluster ${LOGICAL_ID} (${CLUSTER_ID}) is already in status 'deleting'; cdkd did not delete it again`,
    ]);
    // Still journaled: a delete in progress can fail.
    expect(createdBeforeFailure(error, LOGICAL_ID, 'AWS::RDS::DBCluster')).toBe(CLUSTER_ID);
  });

  it('a refused cleanup on a cluster already gone drops the created-before-failure mark', async () => {
    const gone = Object.assign(new Error('DBCluster not found'), { name: 'DBClusterNotFoundFault' });
    routeCleanup(['deleting', gone], refused);

    const error = await caught(create());

    expect(warnings()).toEqual([
      `Partially-created DBCluster ${LOGICAL_ID} (${CLUSTER_ID}) is already deleted; cdkd did not delete it again`,
    ]);
    expect(createdBeforeFailure(error, LOGICAL_ID, 'AWS::RDS::DBCluster')).toBeUndefined();
  });

  it.each([
    ['a status other than deleting', ['incompatible-parameters']],
    ['a not-found MESSAGE under another class', ['incompatible-parameters', new Error('cluster not found')]],
  ])('keeps the billing warning on %s', async (_label, statuses) => {
    routeCleanup(statuses as Array<string | Error>, refused);

    const error = await caught(create());

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('THE CLUSTER IS STILL RUNNING AND BILLING');
    expect(createdBeforeFailure(error, LOGICAL_ID, 'AWS::RDS::DBCluster')).toBe(CLUSTER_ID);
  });
});
