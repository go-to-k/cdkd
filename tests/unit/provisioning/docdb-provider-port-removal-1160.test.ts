// issue #1160 (docdb): a removed AWS::DocDB::DBCluster `Port` resets to 27017.
// A real CloudFormation A/B read a removed `Port: 27018` back as 27017 once the
// update completed, so cdkd sends the default on removal (nothing when the
// removed value already was the default) and waits for the new port before it
// reads the cluster's attributes, so a same-deploy `Fn::GetAtt <cluster>.Port`
// gets it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-docdb', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    DocDBClient: vi.fn().mockImplementation(() => ({
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

import { DocDBProvider } from '../../../src/provisioning/providers/docdb-provider.js';

const TYPE = 'AWS::DocDB::DBCluster';

function cluster(port: number, status = 'available') {
  return { DBClusters: [{ DBClusterIdentifier: 'my-cluster', Port: port, Status: status }] };
}

function commandNames(): string[] {
  return mockSend.mock.calls.map((call) => (call[0] as object).constructor.name);
}

describe('DocDBProvider DBCluster Port removal (issue #1160)', () => {
  let provider: DocDBProvider;
  const savedNoWait = process.env['CDKD_NO_WAIT'];

  beforeEach(() => {
    mockSend.mockReset();
    delete process.env['CDKD_NO_WAIT'];
    provider = new DocDBProvider();
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
  });

  afterEach(() => {
    if (savedNoWait === undefined) delete process.env['CDKD_NO_WAIT'];
    else process.env['CDKD_NO_WAIT'] = savedNoWait;
  });

  it('resets a removed non-default Port to 27017 and waits for it before reading attributes', async () => {
    mockSend
      .mockResolvedValueOnce({}) // ModifyDBCluster
      .mockResolvedValueOnce(cluster(27018, 'modifying')) // wait: old port, modifying
      .mockResolvedValueOnce(cluster(27017, 'modifying')) // wait: new port, still modifying
      .mockResolvedValueOnce(cluster(27017)) // wait: settled
      .mockResolvedValueOnce(cluster(27017)); // final describe

    const result = await provider.update('MyCluster', 'my-cluster', TYPE, {}, { Port: 27018 });

    expect(mockSend.mock.calls[0][0].input.Port).toBe(27017);
    expect(commandNames()).toEqual([
      'ModifyDBClusterCommand',
      'DescribeDBClustersCommand',
      'DescribeDBClustersCommand',
      'DescribeDBClustersCommand',
      'DescribeDBClustersCommand',
    ]);
    expect(result.attributes?.['Port']).toBe('27017');
  });

  it('reads a recorded string Port as a number', async () => {
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(cluster(27017))
      .mockResolvedValueOnce(cluster(27017));

    await provider.update('MyCluster', 'my-cluster', TYPE, {}, { Port: '27018' });

    expect(mockSend.mock.calls[0][0].input.Port).toBe(27017);
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it.each([[27017], ['27017']])(
    'sends nothing and waits for nothing when the removed Port %j already was the default',
    async (previous) => {
      mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce(cluster(27017));

      await provider.update('MyCluster', 'my-cluster', TYPE, {}, { Port: previous });

      expect(mockSend.mock.calls[0][0].input.Port).toBeUndefined();
      expect(mockSend).toHaveBeenCalledTimes(2);
    }
  );

  it('sends nothing when Port was never declared', async () => {
    mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce(cluster(27017));

    await provider.update('MyCluster', 'my-cluster', TYPE, {}, {});

    expect(mockSend.mock.calls[0][0].input.Port).toBeUndefined();
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('waits for a declared Port change too', async () => {
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(cluster(27018))
      .mockResolvedValueOnce(cluster(27019))
      .mockResolvedValueOnce(cluster(27019));

    const result = await provider.update(
      'MyCluster',
      'my-cluster',
      TYPE,
      { Port: 27019 },
      { Port: 27018 }
    );

    expect(mockSend.mock.calls[0][0].input.Port).toBe(27019);
    expect(mockSend).toHaveBeenCalledTimes(4);
    expect(result.attributes?.['Port']).toBe('27019');
  });

  it('waits for a newly declared Port (none recorded before)', async () => {
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(cluster(27017))
      .mockResolvedValueOnce(cluster(27018))
      .mockResolvedValueOnce(cluster(27018));

    await provider.update('MyCluster', 'my-cluster', TYPE, { Port: 27018 }, {});

    expect(mockSend.mock.calls[0][0].input.Port).toBe(27018);
    expect(mockSend).toHaveBeenCalledTimes(4);
  });

  it('re-sends an unchanged declared Port without waiting', async () => {
    mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce(cluster(27018));

    await provider.update('MyCluster', 'my-cluster', TYPE, { Port: '27018' }, { Port: 27018 });

    expect(mockSend.mock.calls[0][0].input.Port).toBe(27018);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('skips the port wait under --no-wait and records the port it sent, not the stale readback', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce(cluster(27018, 'modifying'));

    const result = await provider.update('MyCluster', 'my-cluster', TYPE, {}, { Port: 27018 });

    expect(mockSend.mock.calls[0][0].input.Port).toBe(27017);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(result.attributes?.['Port']).toBe('27017');
    expect(result.attributes?.['Endpoint.Port']).toBe('27017');
  });

  it('under --no-wait keeps the readback Port when the port did not change', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce(cluster(27018));

    const result = await provider.update(
      'MyCluster',
      'my-cluster',
      TYPE,
      { Port: 27018 },
      { Port: 27018 }
    );

    expect(result.attributes?.['Port']).toBe('27018');
  });

  it('waits out member instances the port change moved to modifying / rebooting', async () => {
    const withMember = {
      DBClusters: [
        {
          DBClusterIdentifier: 'my-cluster',
          Port: 27017,
          Status: 'available',
          DBClusterMembers: [{ DBInstanceIdentifier: 'member-1' }],
        },
      ],
    };
    mockSend
      .mockResolvedValueOnce({}) // ModifyDBCluster
      .mockResolvedValueOnce(withMember) // port wait: applied
      .mockResolvedValueOnce(withMember) // final describe
      .mockResolvedValueOnce({ DBInstances: [{ DBInstanceStatus: 'modifying' }] })
      .mockResolvedValueOnce({ DBInstances: [{ DBInstanceStatus: 'rebooting' }] })
      .mockResolvedValueOnce({ DBInstances: [{ DBInstanceStatus: 'available' }] });

    await provider.update('MyCluster', 'my-cluster', TYPE, {}, { Port: 27018 });

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

  it('reads no member instance when the port did not change', async () => {
    mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({
      DBClusters: [
        {
          DBClusterIdentifier: 'my-cluster',
          Port: 27018,
          Status: 'available',
          DBClusterMembers: [{ DBInstanceIdentifier: 'member-1' }],
        },
      ],
    });

    await provider.update('MyCluster', 'my-cluster', TYPE, { Port: 27018 }, { Port: 27018 });

    expect(commandNames()).toEqual(['ModifyDBClusterCommand', 'DescribeDBClustersCommand']);
  });

  it('fails at once when the cluster enters a terminal status during the port wait', async () => {
    mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce(cluster(27018, 'incompatible-parameters'));

    await expect(
      provider.update('MyCluster', 'my-cluster', TYPE, {}, { Port: 27018 })
    ).rejects.toThrow('entered status incompatible-parameters while applying its new port');
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('fails at once when DescribeDBClusters returns no cluster during the port wait', async () => {
    mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({ DBClusters: [] });

    await expect(
      provider.update('MyCluster', 'my-cluster', TYPE, {}, { Port: 27018 })
    ).rejects.toThrow('returned no cluster for DocDB DBCluster MyCluster while waiting for its new port');
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('times out naming the cluster when the port never applies', async () => {
    mockSend.mockResolvedValue(cluster(27018, 'modifying'));
    const waiter = provider as unknown as {
      waitForClusterPortApplied: (
        id: string,
        logicalId: string,
        port: number,
        maxWaitMs: number
      ) => Promise<void>;
    };

    await expect(
      waiter.waitForClusterPortApplied('my-cluster', 'MyCluster', 27017, 0)
    ).rejects.toThrow('Timed out waiting for DocDB DBCluster MyCluster to apply its new port');
  });
});
