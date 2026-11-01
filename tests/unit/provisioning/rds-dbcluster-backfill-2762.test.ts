// go-to-k/cdkd#2762: the AWS::RDS::DBCluster parameter group, backup and
// maintenance windows, snapshot tag copying and storage type. Create sends what
// the template declares; update sends what changed, and a removal sends
// nothing (RDS keeps the live value), as CloudFormation's handler does.
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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

/** Every DescribeDBClusters answers `live`, CreateDBCluster the cluster, every other call `{}`. */
function armLive(live: Input): void {
  mockSend.mockImplementation((command: { constructor: { name: string } }) =>
    Promise.resolve(
      command.constructor.name === 'DescribeDBClustersCommand'
        ? {
            DBClusters: [
              {
                DBClusterIdentifier: 'cluster-1',
                DBClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:cluster-1',
                Status: 'available',
                DBClusterMembers: [],
                ...live,
              },
            ],
          }
        : command.constructor.name === 'CreateDBClusterCommand'
          ? { DBCluster: { DBClusterIdentifier: 'cluster-1' } }
          : {}
    )
  );
}

function sent(name: string): Input[] {
  return mockSend.mock.calls
    .map(([command]) => command as { constructor: { name: string }; input: Input })
    .filter((command) => command.constructor.name === name)
    .map((command) => command.input);
}

const BASE: Input = {
  DBClusterIdentifier: 'cluster-1',
  Engine: 'aurora-postgresql',
  MasterUsername: 'postgres',
};

const BACKFILL: Input = {
  DBClusterParameterGroupName: 'params-1',
  PreferredBackupWindow: '03:00-03:30',
  PreferredMaintenanceWindow: 'sun:05:00-sun:05:30',
  CopyTagsToSnapshot: true,
  StorageType: 'aurora-iopt1',
};

const BACKFILL_MEMBERS = Object.keys(BACKFILL);

describe('RDSProvider DBCluster backfill (go-to-k/cdkd#2762)', () => {
  let provider: RDSProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new RDSProvider();
  });

  const update = (next: Input, prev: Input, context?: Parameters<RDSProvider['update']>[5]) =>
    provider.update('Cluster', 'cluster-1', 'AWS::RDS::DBCluster', next, prev, context);
  const modify = (): Input => {
    const calls = sent('ModifyDBClusterCommand');
    expect(calls).toHaveLength(1);
    return calls[0]!;
  };

  it('every member is a handled property, so a template declaring it keeps the SDK route', () => {
    const handled = provider.handledProperties.get('AWS::RDS::DBCluster');
    for (const key of BACKFILL_MEMBERS) expect(handled?.has(key), key).toBe(true);
  });

  describe('create', () => {
    it('sends every member under its CFn name', async () => {
      armLive({});
      await provider.create('Cluster', 'AWS::RDS::DBCluster', { ...BASE, ...BACKFILL });
      const [input] = sent('CreateDBClusterCommand');
      expect(input).toMatchObject(BACKFILL);
    });

    it('sends an explicit CopyTagsToSnapshot false', async () => {
      armLive({});
      await provider.create('Cluster', 'AWS::RDS::DBCluster', {
        ...BASE,
        CopyTagsToSnapshot: false,
      });
      const [input] = sent('CreateDBClusterCommand');
      expect(input!['CopyTagsToSnapshot']).toBe(false);
    });

    it('sends none of the members the template does not declare', async () => {
      armLive({});
      await provider.create('Cluster', 'AWS::RDS::DBCluster', { ...BASE });
      const [input] = sent('CreateDBClusterCommand');
      for (const key of BACKFILL_MEMBERS) expect(input, key).not.toHaveProperty(key);
    });
  });

  describe('update', () => {
    it('an unchanged template sends none of the members', async () => {
      armLive({});
      await update({ ...BASE, ...BACKFILL }, { ...BASE, ...BACKFILL });
      const input = modify();
      for (const key of BACKFILL_MEMBERS) expect(input, key).not.toHaveProperty(key);
    });

    it.each([
      ['DBClusterParameterGroupName', 'params-2'],
      ['PreferredBackupWindow', '05:00-05:30'],
      ['PreferredMaintenanceWindow', 'mon:06:00-mon:06:30'],
      ['CopyTagsToSnapshot', false],
      ['StorageType', 'aurora'],
    ])('a changed %s is sent alone', async (key, value) => {
      armLive({});
      await update({ ...BASE, ...BACKFILL, [key]: value }, { ...BASE, ...BACKFILL });
      const input = modify();
      expect(input[key]).toEqual(value);
      for (const other of BACKFILL_MEMBERS.filter((k) => k !== key)) {
        expect(input, other).not.toHaveProperty(other);
      }
    });

    it.each(BACKFILL_MEMBERS)('an added %s is sent', async (key) => {
      armLive({});
      await update({ ...BASE, [key]: BACKFILL[key] }, { ...BASE });
      expect(modify()[key]).toEqual(BACKFILL[key]);
    });

    it.each(BACKFILL_MEMBERS)(
      'a removed %s sends nothing, so RDS keeps the live value, as CloudFormation does',
      async (key) => {
        armLive({});
        const next = { ...BASE, ...BACKFILL };
        delete next[key];
        await update(next, { ...BASE, ...BACKFILL });
        const input = modify();
        for (const member of BACKFILL_MEMBERS) expect(input, member).not.toHaveProperty(member);
      }
    );

    it('a value the record holds as its dynamic reference is unchanged when changedProperties says so', async () => {
      armLive({});
      await update(
        { ...BASE, ...BACKFILL, DBClusterParameterGroupName: 'params-resolved' },
        { ...BASE, ...BACKFILL, DBClusterParameterGroupName: '{{resolve:ssm:/params}}' },
        { changedProperties: new Set(['PreferredBackupWindow']) }
      );
      expect(modify()).not.toHaveProperty('DBClusterParameterGroupName');
    });

    it('a forced update naming every key re-sends the members, but never an unchanged StorageType', async () => {
      armLive({});
      await update(
        { ...BASE, ...BACKFILL },
        { ...BASE, ...BACKFILL },
        { changedProperties: new Set([...Object.keys(BASE), ...BACKFILL_MEMBERS]) }
      );
      const input = modify();
      expect(input).toMatchObject({
        DBClusterParameterGroupName: 'params-1',
        PreferredBackupWindow: '03:00-03:30',
        PreferredMaintenanceWindow: 'sun:05:00-sun:05:30',
        CopyTagsToSnapshot: true,
      });
      expect(input).not.toHaveProperty('StorageType');
    });
  });

  describe('EngineVersion upgrades (AllowMajorVersionUpgrade)', () => {
    it.each([
      ['a major upgrade with the parameter group family', '16.4', '17.9', { DBClusterParameterGroupName: 'default.aurora-postgresql17' }],
      ['a minor upgrade, as CloudFormation sends it on any change', '17.4', '17.9', {}],
      ['a version recorded as a number', 16, '17.9', {}],
      ['an EngineVersion with none recorded, as CloudFormation compares null', undefined, '17.9', {}],
    ])('%s sends AllowMajorVersionUpgrade true', async (_label, previous, desired, extra) => {
      armLive({});
      await update(
        { ...BASE, EngineVersion: desired, ...extra },
        { ...BASE, EngineVersion: previous, DBClusterParameterGroupName: 'default.aurora-postgresql16' }
      );
      expect(modify()).toMatchObject({ EngineVersion: desired, AllowMajorVersionUpgrade: true });
    });

    it('a rollback replay sends no EngineVersion, as the handler rollback arm: RDS refuses the downgrade', async () => {
      armLive({});
      await update(
        { ...BASE, EngineVersion: '16.4', PreferredBackupWindow: '03:00-03:30' },
        { ...BASE, EngineVersion: '17.9', PreferredBackupWindow: '05:00-05:30' },
        { replayingState: true }
      );
      const input = modify();
      expect(input).not.toHaveProperty('EngineVersion');
      expect(input).not.toHaveProperty('AllowMajorVersionUpgrade');
      expect(input['PreferredBackupWindow']).toBe('03:00-03:30');
    });

    it('an unchanged EngineVersion beside another change is not sent: AWS may have auto-upgraded the minor version, and re-sending it reads as a downgrade', async () => {
      armLive({});
      await update(
        { ...BASE, EngineVersion: '17.4', PreferredBackupWindow: '05:00-05:30' },
        { ...BASE, EngineVersion: '17.4', PreferredBackupWindow: '03:00-03:30' }
      );
      const input = modify();
      expect(input).not.toHaveProperty('EngineVersion');
      expect(input).not.toHaveProperty('AllowMajorVersionUpgrade');
      expect(input['PreferredBackupWindow']).toBe('05:00-05:30');
    });

    it.each([
      ['an unchanged EngineVersion', { EngineVersion: '17.9' }, { EngineVersion: '17.9' }, undefined],
      ['an unchanged EngineVersion recorded as a number', { EngineVersion: '17' }, { EngineVersion: 17 }, undefined],
      ['a removed EngineVersion', {}, { EngineVersion: '17.9' }, undefined],
      ['a rollback replay', { EngineVersion: '16.4' }, { EngineVersion: '17.9' }, { replayingState: true }],
    ])('%s sends no AllowMajorVersionUpgrade', async (_label, next, prev, context) => {
      armLive({});
      await update({ ...BASE, ...next }, { ...BASE, ...prev }, context);
      expect(modify()).not.toHaveProperty('AllowMajorVersionUpgrade');
    });
  });

  describe('readCurrentState', () => {
    it('reads each member back under its CFn name', async () => {
      armLive({
        Engine: 'aurora-postgresql',
        DBClusterParameterGroup: 'params-1',
        PreferredBackupWindow: '03:00-03:30',
        PreferredMaintenanceWindow: 'sun:05:00-sun:05:30',
        CopyTagsToSnapshot: true,
        StorageType: 'aurora-iopt1',
      });
      const state = await provider.readCurrentState('cluster-1', 'Cluster', 'AWS::RDS::DBCluster');
      expect(state).toMatchObject(BACKFILL);
    });

    it('reads an Aurora cluster with no StorageType as aurora, as CloudFormation reads it', async () => {
      armLive({ Engine: 'aurora-mysql' });
      const state = await provider.readCurrentState('cluster-1', 'Cluster', 'AWS::RDS::DBCluster');
      expect((state as Input)['StorageType']).toBe('aurora');
    });

    it('reads a pending StorageType change as the storage type the cluster is moving to', async () => {
      armLive({
        Engine: 'aurora-postgresql',
        StorageType: 'aurora',
        PendingModifiedValues: { StorageType: 'aurora-iopt1' },
      });
      const state = await provider.readCurrentState('cluster-1', 'Cluster', 'AWS::RDS::DBCluster');
      expect((state as Input)['StorageType']).toBe('aurora-iopt1');
    });

    it('reads no StorageType for a non-Aurora cluster that reports none', async () => {
      armLive({ Engine: 'postgres' });
      const state = await provider.readCurrentState('cluster-1', 'Cluster', 'AWS::RDS::DBCluster');
      expect(state).not.toHaveProperty('StorageType');
    });
  });
});
