// Issue #5155: `cdkd destroy --remove-protection` turns DeletionProtection off
// and then deletes. When that delete takes a final snapshot (the
// DeletionPolicy default for a DB cluster / standalone DB instance), AWS
// refuses it while the resource is still `modifying` from the flip ("Can't
// create a snapshot because the database cluster ... isn't currently in the
// available state"). The delete now waits for protection OFF and `available`
// first, but ONLY when this run flipped the guard AND a snapshot is requested.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());

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
vi.mock('@aws-sdk/client-neptune', clientMock('NeptuneClient'));
vi.mock('@aws-sdk/client-docdb', clientMock('DocDBClient'));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
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
import { NeptuneProvider } from '../../../src/provisioning/providers/neptune-provider.js';
import { DocDBProvider } from '../../../src/provisioning/providers/docdb-provider.js';
import type { DeleteContext } from '../../../src/provisioning/region-check.js';

const SNAP = 'my-res-final-20261022-000000';

interface Scenario {
  /** DeletionProtection before the destroy. */
  protectionOn: boolean;
  /** Statuses the resource reports after the flip, one per describe. */
  afterFlip: string[];
}

/**
 * A cluster or instance whose guard the flip turns off; after the flip it
 * reports `afterFlip` statuses in turn (then `available`), and after the
 * delete it is gone. Records the order of every command name.
 */
function route(kind: 'cluster' | 'instance', scenario: Scenario) {
  let protection = scenario.protectionOn;
  let flipped = false;
  let deleted = false;
  const queue = [...scenario.afterFlip];
  const order: string[] = [];
  mockSend.mockImplementation(async (command: { constructor: { name: string }; input?: any }) => {
    const name = command.constructor.name;
    order.push(name);
    if (/^ModifyDB(Cluster|Instance)Command$/.test(name) && command.input?.DeletionProtection === false) {
      protection = false;
      flipped = true;
      return {};
    }
    if (/^ModifyDB(Cluster|Instance)Command$/.test(name)) {
      protection = command.input?.DeletionProtection === true ? true : protection;
      return {};
    }
    if (/^DeleteDB(Cluster|Instance)Command$/.test(name)) {
      deleted = true;
      return {};
    }
    if (name === 'DescribeDBClustersCommand' || name === 'DescribeDBInstancesCommand') {
      if (deleted) {
        throw Object.assign(new Error('not found'), {
          name: kind === 'cluster' ? 'DBClusterNotFoundFault' : 'DBInstanceNotFound',
        });
      }
      const status = flipped ? (queue.shift() ?? 'available') : 'available';
      return kind === 'cluster'
        ? { DBClusters: [{ DBClusterIdentifier: 'res', DeletionProtection: protection, Status: status }] }
        : {
            DBInstances: [
              { DBInstanceIdentifier: 'res', DeletionProtection: protection, DBInstanceStatus: status },
            ],
          };
    }
    return {};
  });
  return order;
}

/** Describes sent after the flip and before the delete. */
function describesBetweenFlipAndDelete(order: string[]): number {
  const flip = order.findIndex((n) => /^ModifyDB(Cluster|Instance)Command$/.test(n));
  const del = order.findIndex((n) => /^DeleteDB(Cluster|Instance)Command$/.test(n));
  if (flip < 0 || del < 0) return 0;
  return order.slice(flip + 1, del).filter((n) => /^DescribeDB(Clusters|Instances)Command$/.test(n))
    .length;
}

function withoutSleep<T extends object>(provider: T): T {
  (provider as unknown as { sleep: () => Promise<void> }).sleep = vi.fn().mockResolvedValue(undefined);
  return provider;
}

const CASES = [
  {
    label: 'RDS DBCluster',
    kind: 'cluster' as const,
    type: 'AWS::RDS::DBCluster',
    make: () => withoutSleep(new RDSProvider()),
    properties: {},
  },
  {
    label: 'RDS DBInstance (standalone)',
    kind: 'instance' as const,
    type: 'AWS::RDS::DBInstance',
    make: () => withoutSleep(new RDSProvider()),
    properties: { Engine: 'postgres' },
  },
  {
    label: 'DocDB DBCluster',
    kind: 'cluster' as const,
    type: 'AWS::DocDB::DBCluster',
    make: () => withoutSleep(new DocDBProvider()),
    properties: {},
  },
  {
    label: 'Neptune DBCluster',
    kind: 'cluster' as const,
    type: 'AWS::Neptune::DBCluster',
    make: () => withoutSleep(new NeptuneProvider()),
    properties: {},
  },
];

describe.each(CASES)('$label: --remove-protection then a final snapshot (#5155)', (c) => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('waits for available after the flip when a final snapshot is requested', async () => {
    const order = route(c.kind, { protectionOn: true, afterFlip: ['modifying', 'modifying'] });
    const context: DeleteContext = { removeProtection: true, finalSnapshotIdentifier: SNAP };

    await c.make().delete('Res', 'res', c.type, c.properties, context);

    // modifying, modifying, then available: three reads before the delete.
    expect(describesBetweenFlipAndDelete(order)).toBe(3);
  });

  it('does not wait without a final snapshot', async () => {
    const order = route(c.kind, { protectionOn: true, afterFlip: ['modifying'] });

    await c.make().delete('Res', 'res', c.type, c.properties, { removeProtection: true });

    expect(describesBetweenFlipAndDelete(order)).toBe(0);
  });

  it('does not wait when this run flipped nothing (the guard was already off)', async () => {
    const order = route(c.kind, { protectionOn: false, afterFlip: ['modifying'] });
    const context: DeleteContext = { removeProtection: true, finalSnapshotIdentifier: SNAP };

    await c.make().delete('Res', 'res', c.type, c.properties, context);

    expect(describesBetweenFlipAndDelete(order)).toBe(0);
  });

  it('fails closed on a timeout: no delete is sent, and the message names the next step', async () => {
    const order = route(c.kind, { protectionOn: true, afterFlip: Array(1000).fill('modifying') });
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 60_000));
    const context: DeleteContext = { removeProtection: true, finalSnapshotIdentifier: SNAP };

    const error = await c
      .make()
      .delete('Res', 'res', c.type, c.properties, context)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("did not return to 'available'");
    expect((error as Error).message).toContain('re-run the destroy');
    expect(order.some((n) => /^DeleteDB(Cluster|Instance)Command$/.test(n))).toBe(false);
  });
});
