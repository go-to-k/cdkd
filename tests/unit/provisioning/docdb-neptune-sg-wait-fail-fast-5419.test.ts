// issue #5419: the DocDB and Neptune DBCluster security-group waits (#1160)
// fail at once when the cluster enters a terminal status or DescribeDBClusters
// returns no cluster, instead of spinning for the 30-minute budget. Their
// member-instance waits time out naming the member and the cluster.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const dbSend = vi.fn();

function dbClientMock(name: string) {
  return async (importOriginal: () => Promise<unknown>) => {
    const orig = (await importOriginal()) as Record<string, unknown>;
    return {
      ...orig,
      [name]: vi.fn().mockImplementation(() => ({
        send: dbSend,
        config: { region: () => Promise.resolve('us-east-1') },
      })),
    };
  };
}

vi.mock('@aws-sdk/client-neptune', dbClientMock('NeptuneClient'));
vi.mock('@aws-sdk/client-docdb', dbClientMock('DocDBClient'));

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

import { DocDBProvider } from '../../../src/provisioning/providers/docdb-provider.js';
import { NeptuneProvider } from '../../../src/provisioning/providers/neptune-provider.js';

type Cluster = Record<string, unknown> | undefined;

function cluster(status: string, groups: string[] = ['sg-2']): Cluster {
  return {
    DBClusterIdentifier: 'my-cluster',
    Status: status,
    VpcSecurityGroups: groups.map((id) => ({ VpcSecurityGroupId: id, Status: 'active' })),
    DBClusterMembers: [{ DBInstanceIdentifier: 'member-1' }],
  };
}

/**
 * Answer every command by name. Cluster reads BEFORE ModifyDBCluster see the
 * old groups; reads after it take `afterModify` in order, the last one repeating.
 */
function routeCalls(afterModify: Cluster[]): void {
  let modified = false;
  let read = 0;
  dbSend.mockImplementation(async (command: object) => {
    const name = command.constructor.name;
    if (name === 'ModifyDBClusterCommand') {
      modified = true;
      return {};
    }
    if (name === 'DescribeDBClustersCommand') {
      if (!modified) return { DBClusters: [cluster('available', ['sg-1'])] };
      const next = afterModify[Math.min(read, afterModify.length - 1)];
      read += 1;
      return { DBClusters: next === undefined ? [] : [next] };
    }
    if (name === 'DescribeDBInstancesCommand') {
      return { DBInstances: [{ DBInstanceStatus: 'available' }] };
    }
    throw new Error(`unexpected command ${name}`);
  });
}

function clusterReadsAfterModify(): number {
  const names = dbSend.mock.calls.map((call) => (call[0] as object).constructor.name);
  const modifyAt = names.indexOf('ModifyDBClusterCommand');
  return names.slice(modifyAt + 1).filter((n) => n === 'DescribeDBClustersCommand').length;
}

const cases = [
  {
    label: 'DocDB',
    type: 'AWS::DocDB::DBCluster',
    make: () => new DocDBProvider(),
  },
  {
    label: 'Neptune',
    type: 'AWS::Neptune::DBCluster',
    make: () => new NeptuneProvider(),
  },
] as const;

describe.each(cases)('$label DBCluster security-group wait fail-fast (issue #5419)', (c) => {
  const savedNoWait = process.env['CDKD_NO_WAIT'];
  let provider: DocDBProvider | NeptuneProvider;

  beforeEach(() => {
    dbSend.mockReset();
    delete process.env['CDKD_NO_WAIT'];
    provider = c.make();
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
  });

  afterEach(() => {
    if (savedNoWait === undefined) delete process.env['CDKD_NO_WAIT'];
    else process.env['CDKD_NO_WAIT'] = savedNoWait;
  });

  const update = () =>
    provider.update(
      'MyCluster',
      'my-cluster',
      c.type,
      { VpcSecurityGroupIds: ['sg-2'] },
      { VpcSecurityGroupIds: ['sg-1'] }
    );

  it('fails at once when the cluster enters a terminal status during the wait', async () => {
    // The final describe reads the cluster still settling; the wait's first
    // read sees the terminal status.
    routeCalls([cluster('modifying'), cluster('incompatible-network')]);

    await expect(update()).rejects.toThrow(
      `${c.label} DBCluster MyCluster entered status incompatible-network while applying its new VPC security groups`
    );
    // The final describe plus ONE wait read: no second poll.
    expect(clusterReadsAfterModify()).toBe(2);
  });

  it('fails at once on a prefix-matched terminal status too', async () => {
    routeCalls([cluster('modifying'), cluster('inaccessible-encryption-credentials')]);

    await expect(update()).rejects.toThrow(
      'entered status inaccessible-encryption-credentials while applying its new VPC security groups'
    );
    expect(clusterReadsAfterModify()).toBe(2);
  });

  it('fails at once when DescribeDBClusters returns no cluster during the wait', async () => {
    routeCalls([cluster('modifying'), undefined]);

    await expect(update()).rejects.toThrow(
      `DescribeDBClusters returned no cluster for ${c.label} DBCluster MyCluster while waiting for its new VPC security groups`
    );
    expect(clusterReadsAfterModify()).toBe(2);
  });

  it('keeps waiting through modifying and settles (negative control)', async () => {
    routeCalls([cluster('modifying'), cluster('modifying'), cluster('available')]);

    await update();

    expect(clusterReadsAfterModify()).toBe(3);
  });

  it('a lasting non-terminal status with the groups applied ends the wait', async () => {
    routeCalls([cluster('modifying'), cluster('backing-up')]);

    await update();

    expect(clusterReadsAfterModify()).toBe(2);
  });

  it('times out naming the cluster when the groups never settle', async () => {
    dbSend.mockResolvedValue({ DBClusters: [cluster('modifying')] });
    const waiter = provider as unknown as {
      waitForSecurityGroupsApplied: (
        id: string,
        logicalId: string,
        expected: readonly string[],
        maxWaitMs: number
      ) => Promise<void>;
    };

    await expect(
      waiter.waitForSecurityGroupsApplied('my-cluster', 'MyCluster', ['sg-2'], 0)
    ).rejects.toThrow(
      `Timed out waiting for ${c.label} DBCluster MyCluster to apply its new VPC security groups`
    );
  });
});

describe('member-instance wait timeout names the member and the cluster (issue #5419)', () => {
  beforeEach(() => {
    dbSend.mockReset();
    dbSend.mockResolvedValue({ DBInstances: [{ DBInstanceStatus: 'modifying' }] });
  });

  it('DocDB', async () => {
    const provider = new DocDBProvider();
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
    const waiter = provider as unknown as {
      waitForMemberAfterClusterChange: (
        id: string,
        clusterLogicalId: string,
        transitional: ReadonlySet<string>,
        change: string,
        maxWaitMs: number
      ) => Promise<void>;
    };

    await expect(
      waiter.waitForMemberAfterClusterChange(
        'member-1',
        'MyCluster',
        new Set(['modifying']),
        'VPC security groups',
        0
      )
    ).rejects.toThrow(
      'Timed out waiting for member instance member-1 of DocDB DBCluster MyCluster to finish applying its new VPC security groups'
    );
  });

  it('Neptune', async () => {
    const provider = new NeptuneProvider();
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
    const waiter = provider as unknown as {
      waitForMemberAfterSecurityGroupChange: (
        id: string,
        clusterLogicalId: string,
        maxWaitMs: number
      ) => Promise<void>;
    };

    await expect(
      waiter.waitForMemberAfterSecurityGroupChange('member-1', 'MyCluster', 0)
    ).rejects.toThrow(
      'Timed out waiting for member instance member-1 of Neptune DBCluster MyCluster to finish applying its new VPC security groups'
    );
  });

  it.each(cases)('$label update() passes the cluster logicalId to the member wait', async (c) => {
    // Wiring: a member stuck in `modifying` through update() must time out with
    // the TEMPLATE logical id. Shrink the member wait's budget via a wrapper.
    const provider = c.make();
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
    const p = provider as unknown as Record<string, (...args: unknown[]) => Promise<void>>;
    const memberWait =
      c.label === 'DocDB' ? 'waitForMemberAfterClusterChange' : 'waitForMemberAfterSecurityGroupChange';
    const original = p[memberWait].bind(provider);
    // Neptune: (id, clusterLogicalId, maxWaitMs); DocDB: (id, clusterLogicalId, set, change, maxWaitMs).
    p[memberWait] = (...args: unknown[]) =>
      c.label === 'DocDB' ? original(args[0], args[1], args[2], args[3], 0) : original(args[0], args[1], 0);
    let modified = false;
    dbSend.mockReset();
    dbSend.mockImplementation(async (command: object) => {
      const name = command.constructor.name;
      if (name === 'ModifyDBClusterCommand') {
        modified = true;
        return {};
      }
      if (name === 'DescribeDBClustersCommand') {
        return { DBClusters: [cluster('available', modified ? ['sg-2'] : ['sg-1'])] };
      }
      return { DBInstances: [{ DBInstanceStatus: 'modifying' }] };
    });

    await expect(
      provider.update(
        'MyCluster',
        'my-cluster',
        c.type,
        { VpcSecurityGroupIds: ['sg-2'] },
        { VpcSecurityGroupIds: ['sg-1'] }
      )
    ).rejects.toThrow(`member instance member-1 of ${c.label} DBCluster MyCluster`);
  });
});
