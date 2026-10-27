// issue #5417: the AWS::RDS::DBCluster port-change path (#1160 / #5314). After
// the port applies, the member instances it moved to `modifying` / `rebooting`
// are waited out; under `--no-wait` the port sent is recorded, not a stale
// readback; and a terminal status or a vanished cluster fails the wait at once.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-rds', async () => {
  const actual = await vi.importActual('@aws-sdk/client-rds');
  return {
    ...actual,
    RDSClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

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

const TYPE = 'AWS::RDS::DBCluster';
const ENGINE = 'aurora-postgresql';

function cluster(
  port: number,
  status = 'available',
  extra: { groups?: string[]; members?: string[] } = {}
) {
  return {
    DBClusters: [
      {
        DBClusterIdentifier: 'my-cluster',
        Port: port,
        Status: status,
        ...(extra.groups && {
          VpcSecurityGroups: extra.groups.map((id) => ({ VpcSecurityGroupId: id, Status: 'active' })),
        }),
        ...(extra.members && {
          DBClusterMembers: extra.members.map((id) => ({ DBInstanceIdentifier: id })),
        }),
      },
    ],
  };
}

function instance(status: string) {
  return { DBInstances: [{ DBInstanceStatus: status }] };
}

function commandNames(): string[] {
  return mockSend.mock.calls.map((call) => (call[0] as object).constructor.name);
}

describe('RDSProvider DBCluster port change (issue #5417)', () => {
  let provider: RDSProvider;
  const savedNoWait = process.env['CDKD_NO_WAIT'];

  beforeEach(() => {
    mockSend.mockReset();
    delete process.env['CDKD_NO_WAIT'];
    provider = new RDSProvider();
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
  });

  afterEach(() => {
    if (savedNoWait === undefined) delete process.env['CDKD_NO_WAIT'];
    else process.env['CDKD_NO_WAIT'] = savedNoWait;
  });

  it('waits out member instances the port change moved to modifying / rebooting', async () => {
    mockSend
      .mockResolvedValueOnce({}) // ModifyDBCluster
      .mockResolvedValueOnce(cluster(5432, 'available', { members: ['member-1'] })) // port wait
      .mockResolvedValueOnce(cluster(5432, 'available', { members: ['member-1'] })) // final describe
      .mockResolvedValueOnce(instance('modifying'))
      .mockResolvedValueOnce(instance('rebooting'))
      .mockResolvedValueOnce(instance('available'));

    await provider.update('MyCluster', 'my-cluster', TYPE, { Engine: ENGINE }, { Engine: ENGINE, Port: 5433 });

    expect(mockSend.mock.calls[0][0].input.Port).toBe(5432);
    expect(commandNames()).toEqual([
      'ModifyDBClusterCommand',
      'DescribeDBClustersCommand',
      'DescribeDBClustersCommand',
      'DescribeDBInstancesCommand',
      'DescribeDBInstancesCommand',
      'DescribeDBInstancesCommand',
    ]);
    expect(mockSend.mock.calls[3][0].input.DBInstanceIdentifier).toBe('member-1');
  });

  it('waits out every member, a newly declared Port included', async () => {
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(cluster(5440, 'available', { members: ['writer', 'reader'] }))
      .mockResolvedValueOnce(cluster(5440, 'available', { members: ['writer', 'reader'] }))
      .mockResolvedValueOnce(instance('rebooting'))
      .mockResolvedValueOnce(instance('available'))
      .mockResolvedValueOnce(instance('available'));

    await provider.update(
      'MyCluster',
      'my-cluster',
      TYPE,
      { Engine: ENGINE, Port: 5440 },
      { Engine: ENGINE }
    );

    expect(
      mockSend.mock.calls.slice(3).map((call) => call[0].input.DBInstanceIdentifier)
    ).toEqual(['writer', 'writer', 'reader']);
  });

  it('reads no member instance when the port did not change', async () => {
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(cluster(5433, 'available', { members: ['member-1'] }));

    await provider.update(
      'MyCluster',
      'my-cluster',
      TYPE,
      { Engine: ENGINE, Port: 5433 },
      { Engine: ENGINE, Port: 5433 }
    );

    expect(commandNames()).toEqual(['ModifyDBClusterCommand', 'DescribeDBClustersCommand']);
  });

  it('a security-group change waits out a modifying member but not a rebooting one', async () => {
    // Port unchanged, groups changed: Modify, final describe, the group wait's
    // describe, then the member reads.
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(cluster(5433, 'available', { groups: ['sg-2'], members: ['m'] }))
      .mockResolvedValueOnce(cluster(5433, 'available', { groups: ['sg-2'], members: ['m'] }))
      .mockResolvedValueOnce(instance('modifying'))
      .mockResolvedValueOnce(instance('rebooting'));

    await provider.update(
      'MyCluster',
      'my-cluster',
      TYPE,
      { Engine: ENGINE, Port: 5433, VpcSecurityGroupIds: ['sg-2'] },
      { Engine: ENGINE, Port: 5433, VpcSecurityGroupIds: ['sg-1'] }
    );

    // `rebooting` is not the group change's transition, so the second read ends it.
    expect(commandNames()).toEqual([
      'ModifyDBClusterCommand',
      'DescribeDBClustersCommand',
      'DescribeDBClustersCommand',
      'DescribeDBInstancesCommand',
      'DescribeDBInstancesCommand',
    ]);
  });

  it('a port and security-group change in one update runs both waits, the port first', async () => {
    const settled = cluster(5432, 'available', { groups: ['sg-2'], members: ['m'] });
    mockSend
      .mockResolvedValueOnce({}) // ModifyDBCluster
      .mockResolvedValueOnce(settled) // port wait
      .mockResolvedValueOnce(settled) // final describe
      .mockResolvedValueOnce(instance('rebooting')) // port member wait
      .mockResolvedValueOnce(instance('available'))
      .mockResolvedValueOnce(settled) // group wait
      .mockResolvedValueOnce(instance('available')); // group member wait

    await provider.update(
      'MyCluster',
      'my-cluster',
      TYPE,
      { Engine: ENGINE, VpcSecurityGroupIds: ['sg-2'] },
      { Engine: ENGINE, Port: 5433, VpcSecurityGroupIds: ['sg-1'] }
    );

    expect(commandNames()).toEqual([
      'ModifyDBClusterCommand',
      'DescribeDBClustersCommand',
      'DescribeDBClustersCommand',
      'DescribeDBInstancesCommand',
      'DescribeDBInstancesCommand',
      'DescribeDBClustersCommand',
      'DescribeDBInstancesCommand',
    ]);
  });

  it('skips every wait under --no-wait and records the port it sent, not the stale readback', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(cluster(5433, 'modifying', { members: ['member-1'] }));

    const result = await provider.update(
      'MyCluster',
      'my-cluster',
      TYPE,
      { Engine: ENGINE },
      { Engine: ENGINE, Port: 5433 }
    );

    expect(mockSend.mock.calls[0][0].input.Port).toBe(5432);
    expect(commandNames()).toEqual(['ModifyDBClusterCommand', 'DescribeDBClustersCommand']);
    expect(result.attributes?.['Endpoint.Port']).toBe('5432');
  });

  it('under --no-wait keeps the readback Port when the port did not change', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce(cluster(5433));

    const result = await provider.update(
      'MyCluster',
      'my-cluster',
      TYPE,
      { Engine: ENGINE, Port: 5433 },
      { Engine: ENGINE, Port: 5433 }
    );

    expect(result.attributes?.['Endpoint.Port']).toBe('5433');
  });

  it('fails at once when the cluster enters a terminal status during the port wait', async () => {
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(cluster(5433, 'incompatible-parameters'));

    await expect(
      provider.update('MyCluster', 'my-cluster', TYPE, { Engine: ENGINE }, { Engine: ENGINE, Port: 5433 })
    ).rejects.toThrow('DBCluster MyCluster entered status incompatible-parameters while applying its new port');
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('fails at once when DescribeDBClusters returns no cluster during the port wait', async () => {
    mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({ DBClusters: [] });

    await expect(
      provider.update('MyCluster', 'my-cluster', TYPE, { Engine: ENGINE }, { Engine: ENGINE, Port: 5433 })
    ).rejects.toThrow(
      'DescribeDBClusters returned no cluster for DBCluster MyCluster while waiting for its new port'
    );
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('fails at once when the cluster enters a terminal status during the security-group wait', async () => {
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(cluster(5433, 'available', { groups: ['sg-1'] })) // final describe
      .mockResolvedValueOnce(cluster(5433, 'inaccessible-encryption-credentials'));

    await expect(
      provider.update(
        'MyCluster',
        'my-cluster',
        TYPE,
        { Engine: ENGINE, Port: 5433, VpcSecurityGroupIds: ['sg-2'] },
        { Engine: ENGINE, Port: 5433, VpcSecurityGroupIds: ['sg-1'] }
      )
    ).rejects.toThrow(
      'DBCluster MyCluster entered status inaccessible-encryption-credentials while applying its new VPC security groups'
    );
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it('fails at once when DescribeDBClusters returns no cluster during the security-group wait', async () => {
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(cluster(5433, 'available', { groups: ['sg-1'] }))
      .mockResolvedValueOnce({ DBClusters: [] });

    await expect(
      provider.update(
        'MyCluster',
        'my-cluster',
        TYPE,
        { Engine: ENGINE, Port: 5433, VpcSecurityGroupIds: ['sg-2'] },
        { Engine: ENGINE, Port: 5433, VpcSecurityGroupIds: ['sg-1'] }
      )
    ).rejects.toThrow(
      'DescribeDBClusters returned no cluster for DBCluster MyCluster while waiting for its new VPC security groups'
    );
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it('passes each member id and the cluster logical id, in that order, from both call sites', async () => {
    const memberWait = vi.spyOn(
      provider as unknown as {
        waitForMemberAfterClusterChange: (...args: unknown[]) => Promise<void>;
      },
      'waitForMemberAfterClusterChange'
    );
    const settled = cluster(5432, 'available', { groups: ['sg-2'], members: ['member-1'] });
    mockSend
      .mockResolvedValueOnce({}) // ModifyDBCluster
      .mockResolvedValueOnce(settled) // port wait
      .mockResolvedValueOnce(settled) // final describe
      .mockResolvedValueOnce(instance('available')) // port member wait
      .mockResolvedValueOnce(settled) // group wait
      .mockResolvedValueOnce(instance('available')); // group member wait

    await provider.update(
      'MyCluster',
      'my-cluster',
      TYPE,
      { Engine: ENGINE, VpcSecurityGroupIds: ['sg-2'] },
      { Engine: ENGINE, Port: 5433, VpcSecurityGroupIds: ['sg-1'] }
    );

    expect(memberWait.mock.calls.map((call) => [call[0], call[1], call[3]])).toEqual([
      ['member-1', 'MyCluster', 'port'],
      ['member-1', 'MyCluster', 'VPC security groups'],
    ]);
  });

  it('times out naming the stalled member, its cluster and the change', async () => {
    mockSend.mockResolvedValue(instance('rebooting'));
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
        'member-2',
        'MyCluster',
        new Set(['rebooting']),
        'port',
        0
      )
    ).rejects.toThrow(
      'Timed out waiting for member instance member-2 of DBCluster MyCluster to finish applying its new port'
    );
  });

  it('flattens a line break in the member id inside the timeout message', async () => {
    mockSend.mockResolvedValue(instance('modifying'));
    const waiter = provider as unknown as {
      waitForMemberAfterClusterChange: (
        id: string,
        clusterLogicalId: string,
        transitional: ReadonlySet<string>,
        change: string,
        maxWaitMs: number
      ) => Promise<void>;
    };

    const error = await waiter
      .waitForMemberAfterClusterChange(
        'member\nforged',
        'MyCluster',
        new Set(['modifying']),
        'VPC security groups',
        0
      )
      .catch((e: unknown) => e as Error);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('\n');
    expect((error as Error).message).toContain('of DBCluster MyCluster to finish applying its new VPC security groups');
  });
});
