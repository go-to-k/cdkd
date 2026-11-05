// go-to-k/cdkd#5639 / #5640: `EnableCloudwatchLogsExports` on the SDK route
// for AWS::RDS::DBCluster and AWS::RDS::DBInstance. Create sends the declared
// list; an update sends ModifyDB*'s `CloudwatchLogsExportConfiguration` delta
// between the previous and the desired template, as CloudFormation's handlers
// build it (a removal disables what the previous template declared), and
// waits for it to apply; the readback reports `EnabledCloudwatchLogsExports`
// with any pending change folded in.
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

type Input = Record<string, unknown>;

const CLUSTER = 'AWS::RDS::DBCluster';
const INSTANCE = 'AWS::RDS::DBInstance';

/**
 * Each DescribeDBClusters / DescribeDBInstances answers the next of `reads`
 * (the last one repeats), merged over an `available` resource; the creates
 * answer the resource, every other call `{}`.
 */
function arm(reads: Input[]): void {
  let next = 0;
  const take = (): Input => {
    const live = reads[Math.min(next, reads.length - 1)] ?? {};
    next += 1;
    return live;
  };
  mockSend.mockImplementation((command: { constructor: { name: string } }) => {
    switch (command.constructor.name) {
      case 'DescribeDBClustersCommand':
        return Promise.resolve({
          DBClusters: [
            {
              DBClusterIdentifier: 'c-1',
              DBClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:c-1',
              Status: 'available',
              DBClusterMembers: [],
              ...take(),
            },
          ],
        });
      case 'DescribeDBInstancesCommand':
        return Promise.resolve({
          DBInstances: [
            {
              DBInstanceIdentifier: 'db-1',
              DBInstanceArn: 'arn:aws:rds:us-east-1:123456789012:db:db-1',
              DBInstanceStatus: 'available',
              ...take(),
            },
          ],
        });
      case 'CreateDBClusterCommand':
        return Promise.resolve({ DBCluster: { DBClusterIdentifier: 'c-1' } });
      case 'CreateDBInstanceCommand':
        return Promise.resolve({ DBInstance: { DBInstanceIdentifier: 'db-1' } });
      case 'ListTagsForResourceCommand':
        return Promise.resolve({ TagList: [] });
      default:
        return Promise.resolve({});
    }
  });
}

function sent(name: string): Input[] {
  return mockSend.mock.calls
    .map(([command]) => command as { constructor: { name: string }; input: Input })
    .filter((command) => command.constructor.name === name)
    .map((command) => command.input);
}

const CLUSTER_BASE: Input = {
  DBClusterIdentifier: 'c-1',
  Engine: 'aurora-postgresql',
  MasterUsername: 'admin',
};

const INSTANCE_BASE: Input = {
  DBInstanceIdentifier: 'db-1',
  DBInstanceClass: 'db.t4g.micro',
  Engine: 'postgres',
  MasterUsername: 'admin',
  AllocatedStorage: '20',
};

const SIDES = [
  {
    type: CLUSTER,
    base: CLUSTER_BASE,
    id: 'c-1',
    create: 'CreateDBClusterCommand',
    modify: 'ModifyDBClusterCommand',
    describe: 'DescribeDBClustersCommand',
  },
  {
    type: INSTANCE,
    base: INSTANCE_BASE,
    id: 'db-1',
    create: 'CreateDBInstanceCommand',
    modify: 'ModifyDBInstanceCommand',
    describe: 'DescribeDBInstancesCommand',
  },
] as const;

describe.each(SIDES)('RDSProvider $type EnableCloudwatchLogsExports', (side) => {
  let provider: RDSProvider;
  let sleeps: number;

  beforeEach(() => {
    mockSend.mockReset();
    delete process.env['CDKD_NO_WAIT'];
    provider = new RDSProvider();
    sleeps = 0;
    // A wait that never settles fails the case instead of spinning.
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {
      sleeps += 1;
      if (sleeps > 20) throw new Error('test sleep budget exceeded: a wait never settled');
    };
  });

  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
  });

  const update = (next: Input, prev: Input) =>
    provider.update('L', side.id, side.type, { ...side.base, ...next }, { ...side.base, ...prev });
  const modify = (): Input => {
    const calls = sent(side.modify);
    expect(calls).toHaveLength(1);
    return calls[0]!;
  };

  it('is a handled property, so a template declaring it keeps the SDK route', () => {
    expect(provider.handledProperties.get(side.type)?.has('EnableCloudwatchLogsExports')).toBe(
      true
    );
  });

  it('is compared order-insensitively by drift', () => {
    expect(provider.getDriftUnorderedPaths(side.type)).toContain('EnableCloudwatchLogsExports');
  });

  describe('create', () => {
    it('sends the declared list, without repeats', async () => {
      arm([{}]);
      await provider.create('L', side.type, {
        ...side.base,
        EnableCloudwatchLogsExports: ['postgresql', 'upgrade', 'postgresql'],
      });
      expect(sent(side.create)[0]!['EnableCloudwatchLogsExports']).toEqual([
        'postgresql',
        'upgrade',
      ]);
    });

    it('sends nothing for an absent or empty list', async () => {
      arm([{}]);
      await provider.create('L', side.type, { ...side.base });
      await provider.create('L', side.type, { ...side.base, EnableCloudwatchLogsExports: [] });
      for (const input of sent(side.create)) {
        expect(input).not.toHaveProperty('EnableCloudwatchLogsExports');
      }
    });

    it('refuses a malformed list before any call', async () => {
      arm([{}]);
      await expect(
        provider.create('L', side.type, { ...side.base, EnableCloudwatchLogsExports: 'postgresql' })
      ).rejects.toThrow(/EnableCloudwatchLogsExports must be a list of log type names/);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('an added log type is enabled, and the update waits until it is listed', async () => {
      arm([
        {
          EnabledCloudwatchLogsExports: ['postgresql'],
          PendingModifiedValues: { PendingCloudwatchLogsExports: { LogTypesToEnable: ['upgrade'] } },
        },
        { EnabledCloudwatchLogsExports: ['postgresql', 'upgrade'] },
      ]);
      await update(
        { EnableCloudwatchLogsExports: ['postgresql', 'upgrade'] },
        { EnableCloudwatchLogsExports: ['postgresql'] }
      );
      expect(modify()['CloudwatchLogsExportConfiguration']).toEqual({
        EnableLogTypes: ['upgrade'],
      });
      expect(sleeps).toBe(1);
    });

    it('a dropped log type is disabled', async () => {
      arm([{ EnabledCloudwatchLogsExports: ['postgresql'] }]);
      await update(
        { EnableCloudwatchLogsExports: ['postgresql'] },
        { EnableCloudwatchLogsExports: ['postgresql', 'upgrade'] }
      );
      expect(modify()['CloudwatchLogsExportConfiguration']).toEqual({
        DisableLogTypes: ['upgrade'],
      });
    });

    it('a swap enables the new type and disables the old one in one call', async () => {
      arm([{ EnabledCloudwatchLogsExports: ['upgrade'] }]);
      await update(
        { EnableCloudwatchLogsExports: ['upgrade'] },
        { EnableCloudwatchLogsExports: ['postgresql'] }
      );
      expect(modify()['CloudwatchLogsExportConfiguration']).toEqual({
        EnableLogTypes: ['upgrade'],
        DisableLogTypes: ['postgresql'],
      });
    });

    it('a removed property disables every log type the previous template declared, as CloudFormation does', async () => {
      arm([{ EnabledCloudwatchLogsExports: [] }]);
      await update({}, { EnableCloudwatchLogsExports: ['postgresql', 'upgrade'] });
      expect(modify()['CloudwatchLogsExportConfiguration']).toEqual({
        DisableLogTypes: ['postgresql', 'upgrade'],
      });
    });

    it('a reorder or an unchanged list sends no configuration and waits for nothing', async () => {
      arm([{ EnabledCloudwatchLogsExports: ['postgresql'] }]);
      await update(
        { EnableCloudwatchLogsExports: ['upgrade', 'postgresql'] },
        { EnableCloudwatchLogsExports: ['postgresql', 'upgrade'] }
      );
      expect(modify()).not.toHaveProperty('CloudwatchLogsExportConfiguration');
      expect(sleeps).toBe(0);
    });

    it('a malformed recorded list only enables, never disabling a declared type', async () => {
      arm([{ EnabledCloudwatchLogsExports: ['postgresql'] }]);
      await update(
        { EnableCloudwatchLogsExports: ['postgresql'] },
        { EnableCloudwatchLogsExports: 'upgrade' }
      );
      expect(modify()['CloudwatchLogsExportConfiguration']).toEqual({
        EnableLogTypes: ['postgresql'],
      });
    });

    it('refuses a malformed desired list before any call: read as empty it would disable every recorded type', async () => {
      arm([{}]);
      await expect(
        update(
          { EnableCloudwatchLogsExports: { postgresql: true } },
          { EnableCloudwatchLogsExports: ['postgresql'] }
        )
      ).rejects.toThrow(/EnableCloudwatchLogsExports must be a list of log type names/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('a change still pending keeps the wait polling until nothing is pending', async () => {
      arm([
        {
          EnabledCloudwatchLogsExports: ['postgresql', 'upgrade'],
          PendingModifiedValues: {
            PendingCloudwatchLogsExports: { LogTypesToDisable: ['upgrade'] },
          },
        },
        {
          EnabledCloudwatchLogsExports: ['postgresql', 'upgrade'],
          PendingModifiedValues: {
            PendingCloudwatchLogsExports: { LogTypesToDisable: ['upgrade'] },
          },
        },
        { EnabledCloudwatchLogsExports: ['postgresql'] },
      ]);
      await update(
        { EnableCloudwatchLogsExports: ['postgresql'] },
        { EnableCloudwatchLogsExports: ['postgresql', 'upgrade'] }
      );
      expect(sleeps).toBe(2);
    });

    it('a list already reading the change still waits while RDS lists it pending', async () => {
      arm([
        {
          EnabledCloudwatchLogsExports: ['postgresql', 'upgrade'],
          PendingModifiedValues: { PendingCloudwatchLogsExports: { LogTypesToEnable: ['upgrade'] } },
        },
        { EnabledCloudwatchLogsExports: ['postgresql', 'upgrade'] },
      ]);
      await update(
        { EnableCloudwatchLogsExports: ['postgresql', 'upgrade'] },
        { EnableCloudwatchLogsExports: ['postgresql'] }
      );
      expect(sleeps).toBe(1);
    });

    it('under --no-wait the update does not poll for the change', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      arm([{ EnabledCloudwatchLogsExports: ['postgresql'] }]);
      await update(
        { EnableCloudwatchLogsExports: ['postgresql', 'upgrade'] },
        { EnableCloudwatchLogsExports: ['postgresql'] }
      );
      expect(modify()['CloudwatchLogsExportConfiguration']).toEqual({
        EnableLogTypes: ['upgrade'],
      });
      expect(sleeps).toBe(0);
    });
  });

  describe('readCurrentState', () => {
    it('reports the enabled log types', async () => {
      arm([{ EnabledCloudwatchLogsExports: ['upgrade', 'postgresql'] }]);
      const state = (await provider.readCurrentState(side.id, 'L', side.type)) as Input;
      expect(state['EnableCloudwatchLogsExports']).toEqual(['upgrade', 'postgresql']);
    });

    it('folds a pending change in, so a capture right after the update records the new list', async () => {
      arm([
        {
          EnabledCloudwatchLogsExports: ['postgresql', 'upgrade'],
          PendingModifiedValues: {
            PendingCloudwatchLogsExports: {
              LogTypesToEnable: ['iam-db-auth-error'],
              LogTypesToDisable: ['upgrade'],
            },
          },
        },
      ]);
      const state = (await provider.readCurrentState(side.id, 'L', side.type)) as Input;
      expect(state['EnableCloudwatchLogsExports']).toEqual(['postgresql', 'iam-db-auth-error']);
    });

    it("omits a cluster member's list: RDS reports the cluster's, which the cluster owns", async () => {
      arm([{ DBClusterIdentifier: 'c-1', EnabledCloudwatchLogsExports: ['postgresql'] }]);
      const state = (await provider.readCurrentState(side.id, 'L', side.type)) as Input;
      if (side.type === INSTANCE) {
        expect(state).not.toHaveProperty('EnableCloudwatchLogsExports');
      } else {
        // A cluster's own read is unaffected by the field.
        expect(state['EnableCloudwatchLogsExports']).toEqual(['postgresql']);
      }
    });

    it('omits the key when nothing is exported', async () => {
      arm([{ EnabledCloudwatchLogsExports: [] }]);
      const empty = (await provider.readCurrentState(side.id, 'L', side.type)) as Input;
      expect(empty).not.toHaveProperty('EnableCloudwatchLogsExports');
      arm([{}]);
      const absent = (await provider.readCurrentState(side.id, 'L', side.type)) as Input;
      expect(absent).not.toHaveProperty('EnableCloudwatchLogsExports');
    });
  });
});
