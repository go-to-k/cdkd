// go-to-k/cdkd#5639: DBCluster `SourceDBClusterIdentifier`, `RestoreToTime`,
// `RestoreType` and `UseLatestRestorableTime`. A source makes the create a
// RestoreDBClusterToPointInTime, followed by the ModifyDBCluster CloudFormation's
// handler sends once the cluster is available (`modifyDbClusterAfterCreateRequest`).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockSend = vi.fn();
const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));

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
import { getPropertyCoverage } from '../../../src/provisioning/property-coverage.js';
import { parseZonedTimestamp } from '../../../src/provisioning/providers/rds/cluster-restore.js';
import { refuseRestoreFromItself } from '../../../src/provisioning/restore-source-guard.js';

type Input = Record<string, unknown>;
type Command = { constructor: { name: string }; input: Input };

const ACCOUNT = '123456789012';
const SOURCE = 'source-1';
const SOURCE_ARN = `arn:aws:rds:us-east-1:${ACCOUNT}:cluster:${SOURCE}`;
const CLUSTER = 'cluster-1';
const CLUSTER_ARN = `arn:aws:rds:us-east-1:${ACCOUNT}:cluster:${CLUSTER}`;
const KEYS = [
  'SourceDBClusterIdentifier',
  'RestoreToTime',
  'RestoreType',
  'UseLatestRestorableTime',
] as const;

interface Live {
  source?: Input | undefined;
  /** What the by-name read of the source throws instead of answering. */
  sourceError?: Error;
  shared?: Input[][];
  /** Markers of the shared pages after each one (default: the next index). */
  sharedMarkers?: Array<string | undefined>;
  sharedError?: Error;
  restored?: Input;
  failModify?: Error;
}

function arm(live: Live = {}): void {
  const source = 'source' in live ? live.source : { StorageEncrypted: true };
  let deleted = false;
  mockSend.mockImplementation((command: Command) => {
    const name = command.constructor.name;
    const input = command.input;
    if (name === 'DescribeDBClustersCommand') {
      if (input['IncludeShared'] === true) {
        if (live.sharedError !== undefined) return Promise.reject(live.sharedError);
        const pages = live.shared ?? [];
        const index = input['Marker'] === undefined ? 0 : Number(input['Marker']);
        const marker =
          live.sharedMarkers !== undefined
            ? live.sharedMarkers[index]
            : index + 1 < pages.length
              ? String(index + 1)
              : undefined;
        return Promise.resolve({
          DBClusters: pages[index] ?? [],
          ...(marker !== undefined && { Marker: marker }),
        });
      }
      if (input['DBClusterIdentifier'] === CLUSTER) {
        if (deleted) {
          const error = new Error(`DBCluster ${CLUSTER} not found`);
          error.name = 'DBClusterNotFoundFault';
          return Promise.reject(error);
        }
        return Promise.resolve({
          DBClusters: [
            {
              DBClusterIdentifier: CLUSTER,
              DBClusterArn: CLUSTER_ARN,
              DBClusterMembers: [],
              Status: 'available',
              HttpEndpointEnabled: true,
            },
          ],
        });
      }
      if (live.sourceError !== undefined) return Promise.reject(live.sourceError);
      if (source === undefined) {
        const error = new Error(`DBCluster ${String(input['DBClusterIdentifier'])} not found`);
        error.name = 'DBClusterNotFoundFault';
        return Promise.reject(error);
      }
      return Promise.resolve({
        DBClusters: [{ DBClusterIdentifier: SOURCE, DBClusterArn: SOURCE_ARN, ...source }],
      });
    }
    if (name === 'RestoreDBClusterToPointInTimeCommand' || name === 'CreateDBClusterCommand') {
      return Promise.resolve({
        DBCluster: { DBClusterIdentifier: CLUSTER, DBClusterArn: CLUSTER_ARN, ...live.restored },
      });
    }
    if (name === 'ModifyDBClusterCommand' && live.failModify !== undefined) {
      return Promise.reject(live.failModify);
    }
    if (name === 'DeleteDBClusterCommand') deleted = true;
    // No instance exists: a wait on one fails by name, never loops.
    if (name === 'DescribeDBInstancesCommand') {
      const error = new Error('DBInstance not found');
      error.name = 'DBInstanceNotFoundFault';
      return Promise.reject(error);
    }
    return Promise.resolve({});
  });
}

const commands = (): Command[] => mockSend.mock.calls.map(([command]) => command as Command);
const names = (): string[] => commands().map((command) => command.constructor.name);
const sent = (name: string): Input[] =>
  commands()
    .filter((command) => command.constructor.name === name)
    .map((command) => command.input);
const only = (name: string): Input => {
  const calls = sent(name);
  expect(calls, name).toHaveLength(1);
  return calls[0]!;
};
const warnings = (): string[] => mockWarn.mock.calls.map(([text]) => String(text));

const BASE: Input = {
  DBClusterIdentifier: CLUSTER,
  Engine: 'aurora-postgresql',
  SourceDBClusterIdentifier: SOURCE,
  UseLatestRestorableTime: true,
};

describe('RDSProvider DBCluster point-in-time restore (go-to-k/cdkd#5639)', () => {
  let provider: RDSProvider;

  beforeEach(() => {
    mockSend.mockReset();
    mockWarn.mockReset();
    provider = new RDSProvider();
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
    arm();
  });

  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
  });

  const create = (properties: Input) =>
    provider.create('Cluster', 'AWS::RDS::DBCluster', { ...BASE, ...properties });

  it('handles the four keys, so a template declaring them keeps the SDK route', () => {
    for (const key of KEYS) {
      expect(provider.handledProperties.get('AWS::RDS::DBCluster')?.has(key), key).toBe(true);
      expect(getPropertyCoverage('AWS::RDS::DBCluster')?.sdkUnwired.has(key), key).toBe(false);
    }
  });

  it('restores instead of creating, sending the members the handler puts on the restore call', async () => {
    await create({
      RestoreType: 'copy-on-write',
      Port: 5433,
      DBSubnetGroupName: 'subnets',
      VpcSecurityGroupIds: ['sg-1'],
      KmsKeyId: 'alias/aws/rds',
      StorageEncrypted: true,
      CopyTagsToSnapshot: true,
      StorageType: 'aurora-iopt1',
      NetworkType: 'IPV4',
      EnableCloudwatchLogsExports: ['postgresql'],
      ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 2 },
      EngineLifecycleSupport: 'open-source-rds-extended-support-disabled',
      Tags: [{ Key: 'k', Value: 'v' }],
      // Applied by the follow-up, or not at all.
      EngineVersion: '16.4',
      MasterUsername: 'postgres',
      DatabaseName: 'app',
      DBClusterParameterGroupName: 'params-1',
    });
    expect(sent('CreateDBClusterCommand')).toHaveLength(0);
    expect(only('RestoreDBClusterToPointInTimeCommand')).toEqual({
      DBClusterIdentifier: CLUSTER,
      SourceDBClusterIdentifier: SOURCE,
      RestoreType: 'copy-on-write',
      UseLatestRestorableTime: true,
      Port: 5433,
      DBSubnetGroupName: 'subnets',
      VpcSecurityGroupIds: ['sg-1'],
      KmsKeyId: 'alias/aws/rds',
      CopyTagsToSnapshot: true,
      StorageType: 'aurora-iopt1',
      NetworkType: 'IPV4',
      EnableCloudwatchLogsExports: ['postgresql'],
      ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 2 },
      EngineLifecycleSupport: 'open-source-rds-extended-support-disabled',
      Tags: [{ Key: 'k', Value: 'v' }],
    });
    // The source is read first, as the handler reads it.
    expect(names().indexOf('DescribeDBClustersCommand')).toBeLessThan(
      names().indexOf('RestoreDBClusterToPointInTimeCommand')
    );
    expect(sent('DescribeDBClustersCommand')[0]).toEqual({ DBClusterIdentifier: SOURCE });
  });

  it('follows the restore with the ModifyDBCluster the handler sends once the cluster is available', async () => {
    await create({
      DeletionProtection: true,
      MasterUserPassword: 'password-1',
      DBClusterParameterGroupName: 'params-1',
      PreferredBackupWindow: '03:00-03:30',
      PreferredMaintenanceWindow: 'sun:05:00-sun:05:30',
      EnableIAMDatabaseAuthentication: true,
      MonitoringInterval: 60,
      MonitoringRoleArn: `arn:aws:iam::${ACCOUNT}:role/monitoring`,
      PerformanceInsightsEnabled: true,
      AutoMinorVersionUpgrade: false,
      EnableCloudwatchLogsExports: ['postgresql'],
      StorageType: 'aurora-iopt1',
      CopyTagsToSnapshot: true,
      MasterUserAuthenticationType: 'password',
      EngineLifecycleSupport: 'open-source-rds-extended-support-disabled',
      AllocatedStorage: 100,
      BacktrackWindow: 3600,
    });
    const followUp = only('ModifyDBClusterCommand');
    expect(followUp).toEqual({
      DBClusterIdentifier: CLUSTER,
      ApplyImmediately: true,
      // Absent: 1, as `ModelAdapter.setDefaults` fills it.
      BackupRetentionPeriod: 1,
      DeletionProtection: true,
      MasterUserPassword: 'password-1',
      DBClusterParameterGroupName: 'params-1',
      PreferredBackupWindow: '03:00-03:30',
      PreferredMaintenanceWindow: 'sun:05:00-sun:05:30',
      EnableIAMDatabaseAuthentication: true,
      MonitoringInterval: 60,
      MonitoringRoleArn: `arn:aws:iam::${ACCOUNT}:role/monitoring`,
      EnablePerformanceInsights: true,
      AutoMinorVersionUpgrade: false,
      CloudwatchLogsExportConfiguration: { EnableLogTypes: ['postgresql'] },
      StorageType: 'aurora-iopt1',
      CopyTagsToSnapshot: true,
      AllocatedStorage: 100,
      BacktrackWindow: 3600,
    });
    expect(warnings().some((w) => /does not apply MasterUserAuthenticationType/.test(w))).toBe(true);
    expect(names().indexOf('RestoreDBClusterToPointInTimeCommand')).toBeLessThan(
      names().indexOf('ModifyDBClusterCommand')
    );
  });

  it('sends a declared BackupRetentionPeriod and a managed master password on the follow-up', async () => {
    await create({
      BackupRetentionPeriod: '7',
      ManageMasterUserPassword: true,
      MasterUserSecret: { KmsKeyId: 'key-2' },
    });
    expect(only('ModifyDBClusterCommand')).toMatchObject({
      BackupRetentionPeriod: 7,
      ManageMasterUserPassword: true,
      MasterUserSecretKmsKeyId: 'key-2',
    });
  });

  it.each([false, 'false'])(
    'sends no managed-password members for ManageMasterUserPassword %j',
    async (flag) => {
      await create({ ManageMasterUserPassword: flag, MasterUserSecret: { KmsKeyId: 'key-2' } });
      const followUp = only('ModifyDBClusterCommand');
      expect(followUp).not.toHaveProperty('ManageMasterUserPassword');
      expect(followUp).not.toHaveProperty('MasterUserSecretKmsKeyId');
    }
  );

  it("coerces a 'true' ManageMasterUserPassword", async () => {
    await create({ ManageMasterUserPassword: 'true' });
    expect(only('ModifyDBClusterCommand')['ManageMasterUserPassword']).toBe(true);
  });

  it('an Aurora Serverless v1 cluster takes the Data API flag on the follow-up instead', async () => {
    await create({
      EngineMode: 'serverless',
      EnableHttpEndpoint: true,
      AllocatedStorage: 100,
      BacktrackWindow: 3600,
      EnableIAMDatabaseAuthentication: true,
      PreferredBackupWindow: '03:00-03:30',
      PreferredMaintenanceWindow: 'sun:05:00-sun:05:30',
    });
    const followUp = only('ModifyDBClusterCommand');
    expect(followUp['EnableHttpEndpoint']).toBe(true);
    expect(followUp['PreferredMaintenanceWindow']).toBe('sun:05:00-sun:05:30');
    for (const key of [
      'AllocatedStorage',
      'BacktrackWindow',
      'EnableIAMDatabaseAuthentication',
      'PreferredBackupWindow',
    ]) {
      expect(followUp, key).not.toHaveProperty(key);
    }
    expect(sent('EnableHttpEndpointCommand')).toHaveLength(0);
  });

  it('sends no RestoreType for an empty one', async () => {
    await create({ RestoreType: '' });
    expect(only('RestoreDBClusterToPointInTimeCommand')).not.toHaveProperty('RestoreType');
  });

  it('waits for available before the follow-up even under --no-wait, and not after it', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    await create({});
    const order = names();
    const modify = order.indexOf('ModifyDBClusterCommand');
    expect(modify).toBeGreaterThan(-1);
    expect(order.slice(order.indexOf('RestoreDBClusterToPointInTimeCommand'), modify)).toContain(
      'DescribeDBClustersCommand'
    );
    // Only the attribute read follows: no second availability wait.
    expect(order.slice(modify + 1)).toEqual(['DescribeDBClustersCommand']);
  });

  it('turns the Data API on after the follow-up, as the handler does', async () => {
    await create({ EnableHttpEndpoint: true });
    expect(only('EnableHttpEndpointCommand')).toEqual({ ResourceArn: CLUSTER_ARN });
    expect(names().indexOf('ModifyDBClusterCommand')).toBeLessThan(
      names().indexOf('EnableHttpEndpointCommand')
    );
    expect(only('RestoreDBClusterToPointInTimeCommand')).not.toHaveProperty('EnableHttpEndpoint');
  });

  it('waits for the Data API to read on, as the handler stabilizes it', async () => {
    let reads = 0;
    const base = mockSend.getMockImplementation()!;
    mockSend.mockImplementation((command: Command) => {
      if (command.constructor.name === 'EnableHttpEndpointCommand') reads = 1;
      if (
        command.constructor.name === 'DescribeDBClustersCommand' &&
        command.input['DBClusterIdentifier'] === CLUSTER &&
        reads > 0
      ) {
        reads += 1;
        return Promise.resolve({
          DBClusters: [
            { DBClusterIdentifier: CLUSTER, Status: 'available', HttpEndpointEnabled: reads > 3 },
          ],
        });
      }
      return base(command);
    });
    await create({ EnableHttpEndpoint: true });
    expect(reads).toBeGreaterThan(3);
  });

  it('describes the restored cluster for its ARN when the restore answer has none', async () => {
    arm({ restored: { DBClusterArn: undefined } });
    await create({ EnableHttpEndpoint: true });
    expect(only('EnableHttpEndpointCommand')).toEqual({ ResourceArn: CLUSTER_ARN });
  });

  describe('RestoreToTime', () => {
    it('is sent as the instant it names when UseLatestRestorableTime is absent', async () => {
      await create({ UseLatestRestorableTime: undefined, RestoreToTime: '2026-11-10T09:30:00+09:00' });
      const input = only('RestoreDBClusterToPointInTimeCommand');
      expect(input['RestoreToTime']).toEqual(new Date('2026-11-10T00:30:00Z'));
      expect(input).not.toHaveProperty('UseLatestRestorableTime');
    });

    it('is left out, and named, when UseLatestRestorableTime is true', async () => {
      await create({ RestoreToTime: '2026-11-10T00:30:00Z' });
      const input = only('RestoreDBClusterToPointInTimeCommand');
      expect(input).not.toHaveProperty('RestoreToTime');
      expect(input['UseLatestRestorableTime']).toBe(true);
      expect(warnings().some((w) => /does not apply RestoreToTime/.test(w))).toBe(true);
    });

    it('is sent beside a declared false UseLatestRestorableTime', async () => {
      await create({ UseLatestRestorableTime: 'false', RestoreToTime: '2026-11-10T00:30:00Z' });
      expect(only('RestoreDBClusterToPointInTimeCommand')).toMatchObject({
        UseLatestRestorableTime: false,
        RestoreToTime: new Date('2026-11-10T00:30:00Z'),
      });
    });

    it.each([
      ['2026-11-10 00:30:00Z', 'a space separator'],
      ['2026-11-10T00:30:00', 'no zone'],
      ['2026-11-10T00:30:00+0900', 'an offset without a colon'],
      ['2026-02-30T00:30:00Z', 'a day the month lacks'],
      ['2026-11-10T24:00:00Z', 'hour 24'],
    ])('refuses %s (%s) before any call, on a plain create too', async (value) => {
      await expect(create({ RestoreToTime: value })).rejects.toThrow(
        /RestoreToTime must be an ISO 8601 timestamp with a time zone/
      );
      await expect(
        provider.create('Cluster', 'AWS::RDS::DBCluster', {
          DBClusterIdentifier: CLUSTER,
          Engine: 'aurora-postgresql',
          RestoreToTime: value,
        })
      ).rejects.toThrow(/RestoreToTime must be an ISO 8601/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('reads every shape ZonedDateTime.parse takes', () => {
      expect(parseZonedTimestamp('2026-11-10t00:30z')).toEqual(new Date('2026-11-10T00:30:00Z'));
      expect(parseZonedTimestamp('2026-11-10T00:30:00.123456789-05:30')).toEqual(
        new Date('2026-11-10T06:00:00.123Z')
      );
      expect(parseZonedTimestamp('2026-11-10T00:30:00+01:00[Europe/Paris]')).toEqual(
        new Date('2026-11-09T23:30:00Z')
      );
      expect(parseZonedTimestamp('2028-02-29T00:00:00Z')).toEqual(new Date('2028-02-29T00:00:00Z'));
      expect(parseZonedTimestamp('2027-02-29T00:00:00Z')).toBeUndefined();
      // ZoneOffset spans +-18:00 in all.
      expect(parseZonedTimestamp('2026-11-10T00:30:00+18:00')).toEqual(
        new Date('2026-11-09T06:30:00Z')
      );
      expect(parseZonedTimestamp('2026-11-10T00:30:00+18:01')).toBeUndefined();
      expect(parseZonedTimestamp('2026-11-10T00:30:00-18:00:01')).toBeUndefined();
    });
  });

  it.each([
    [{ UseLatestRestorableTime: 'yes' }, /UseLatestRestorableTime must be true or false/],
    [{ RestoreType: 1 }, /RestoreType must be a string/],
    [{ SourceDBClusterIdentifier: ['source-1'] }, /SourceDBClusterIdentifier must be a string/],
  ])('refuses a malformed key before any call: %j', async (properties, says) => {
    await expect(create(properties)).rejects.toThrow(says);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('creates as before with an empty source, naming the point-in-time keys it does not apply', async () => {
    await create({ SourceDBClusterIdentifier: '', RestoreType: 'full-copy' });
    expect(sent('RestoreDBClusterToPointInTimeCommand')).toHaveLength(0);
    expect(only('CreateDBClusterCommand')).not.toHaveProperty('RestoreType');
    expect(
      warnings().some((w) =>
        /this create does not apply RestoreType, UseLatestRestorableTime, as in CloudFormation/.test(w)
      )
    ).toBe(true);
  });

  it('names the keys a restore does not apply, and creates no express writer', async () => {
    await create({
      AvailabilityZones: ['us-east-1a'],
      GlobalClusterIdentifier: 'global-1',
      WithExpressConfiguration: true,
    });
    expect(
      warnings().some((w) =>
        /point-in-time restore does not apply AvailabilityZones, GlobalClusterIdentifier, WithExpressConfiguration/.test(
          w
        )
      )
    ).toBe(true);
    const restore = only('RestoreDBClusterToPointInTimeCommand');
    for (const key of ['AvailabilityZones', 'GlobalClusterIdentifier', 'WithExpressConfiguration']) {
      expect(restore).not.toHaveProperty(key);
    }
    expect(sent('DescribeDBInstancesCommand')).toHaveLength(0);
  });

  it('names what the restored cluster keeps from its source', async () => {
    arm({ restored: { EngineVersion: '15.8', MasterUsername: 'admin', Engine: 'aurora-postgresql' } });
    await create({ EngineVersion: '16.4', MasterUsername: 'admin' });
    expect(
      warnings().some((w) => /keeps its source's EngineVersion, not the template's/.test(w))
    ).toBe(true);
    expect(warnings().some((w) => /MasterUsername/.test(w))).toBe(false);
  });

  it('names no kept value the restore answer does not report, nor an empty declared one', async () => {
    arm({ restored: { EngineVersion: '15.8' } });
    await create({ DatabaseName: 'app', EngineVersion: '' });
    expect(warnings().some((w) => /keeps its source's/.test(w))).toBe(false);
  });

  it('names no unused key declared false or empty', async () => {
    await create({ WithExpressConfiguration: false, AvailabilityZones: [], GlobalClusterIdentifier: '' });
    expect(warnings().some((w) => /does not apply/.test(w))).toBe(false);
  });

  it('names ClusterScalabilityType and MasterUserAuthenticationType as not applied', async () => {
    await create({ ClusterScalabilityType: 'standard', MasterUserAuthenticationType: 'password' });
    expect(
      warnings().some((w) =>
        /does not apply ClusterScalabilityType, MasterUserAuthenticationType/.test(w)
      )
    ).toBe(true);
  });

  describe('the source cluster', () => {
    it('refuses a source name no cluster answers, before anything is made', async () => {
      arm({ source: undefined });
      await expect(create({})).rejects.toThrow(
        /SourceDBClusterIdentifier source-1 does not name a DB cluster this account can read/
      );
      expect(names()).toEqual(['DescribeDBClustersCommand']);
    });

    it('looks a not-found ARN up among the clusters shared with the account', async () => {
      const shared = `arn:aws:rds:us-east-1:210987654321:cluster:${SOURCE}`;
      arm({
        source: undefined,
        shared: [
          [{ DBClusterArn: 'arn:aws:rds:us-east-1:210987654321:cluster:other' }],
          [{ DBClusterArn: shared.toUpperCase(), StorageEncrypted: true }],
        ],
      });
      await create({ SourceDBClusterIdentifier: shared });
      expect(sent('DescribeDBClustersCommand').slice(0, 3)).toEqual([
        { DBClusterIdentifier: shared },
        { IncludeShared: true },
        { IncludeShared: true, Marker: '1' },
      ]);
      expect(only('RestoreDBClusterToPointInTimeCommand')['SourceDBClusterIdentifier']).toBe(shared);
    });

    it('stops the shared lookup at the page that holds the ARN', async () => {
      const shared = `arn:aws:rds:us-east-1:210987654321:cluster:${SOURCE}`;
      arm({
        source: undefined,
        shared: [[{ DBClusterArn: 'other' }], [{ DBClusterArn: shared }], [{ DBClusterArn: 'third' }]],
      });
      await create({ SourceDBClusterIdentifier: shared });
      expect(sent('DescribeDBClustersCommand').filter((i) => i['IncludeShared'] === true)).toHaveLength(2);
    });

    it('stops at an empty Marker, and refuses an ARN no shared cluster has', async () => {
      const shared = `arn:aws:rds:us-east-1:210987654321:cluster:${SOURCE}`;
      arm({
        source: undefined,
        shared: [[{ DBClusterArn: 'other' }], [{ DBClusterArn: 'never-read' }]],
        sharedMarkers: [''],
      });
      await expect(create({ SourceDBClusterIdentifier: shared })).rejects.toThrow(
        /does not name a DB cluster this account can read/
      );
      expect(sent('DescribeDBClustersCommand').filter((i) => i['IncludeShared'] === true)).toHaveLength(1);
      expect(sent('RestoreDBClusterToPointInTimeCommand')).toHaveLength(0);
    });

    it('takes the shared lookup when the by-name read refuses another account\'s ARN', async () => {
      const shared = `arn:aws:rds:us-east-1:210987654321:cluster:${SOURCE}`;
      const refused = new Error('Invalid database cluster identifier');
      refused.name = 'InvalidParameterValue';
      arm({ sourceError: refused, shared: [[{ DBClusterArn: shared }]] });
      await create({ SourceDBClusterIdentifier: shared });
      expect(only('RestoreDBClusterToPointInTimeCommand')['SourceDBClusterIdentifier']).toBe(shared);
    });

    it('fails a name the by-name read refuses as invalid, without the shared lookup', async () => {
      const refused = new Error('Invalid database cluster identifier');
      refused.name = 'InvalidParameterValue';
      arm({ sourceError: refused });
      await expect(create({})).rejects.toThrow(/reading the restore source failed/);
      expect(sent('DescribeDBClustersCommand').filter((i) => i['IncludeShared'] === true)).toHaveLength(0);
    });

    it('fails the create when a shared page cannot be read', async () => {
      const denied = new Error('denied');
      denied.name = 'AccessDenied';
      arm({ source: undefined, sharedError: denied });
      await expect(
        create({ SourceDBClusterIdentifier: `arn:aws:rds:us-east-1:210987654321:cluster:${SOURCE}` })
      ).rejects.toThrow(/reading the restore source failed, so nothing was changed/);
      expect(sent('RestoreDBClusterToPointInTimeCommand')).toHaveLength(0);
    });

    it('fails the create when the source cannot be read, before anything is made', async () => {
      mockSend.mockImplementation(() => {
        const error = new Error('denied');
        error.name = 'AccessDenied';
        return Promise.reject(error);
      });
      await expect(create({})).rejects.toThrow(/reading the restore source failed, so nothing was changed/);
      expect(names()).toEqual(['DescribeDBClustersCommand']);
    });

    it.each([
      [
        { StorageEncrypted: false },
        { StorageEncrypted: true },
        /restore source is not encrypted and no KmsKeyId is set/,
      ],
      [{ StorageEncrypted: true }, { StorageEncrypted: false }, /the restore source is encrypted/],
      [
        { StorageEncrypted: false },
        { StorageEncrypted: false, KmsKeyId: 'alias/aws/rds' },
        /a KmsKeyId is set while StorageEncrypted is false/,
      ],
    ])('refuses what CloudFormation refuses: source %j, template %j', async (source, template, says) => {
      arm({ source });
      await expect(create(template)).rejects.toThrow(says);
      expect(sent('RestoreDBClusterToPointInTimeCommand')).toHaveLength(0);
    });

    it('restores an unencrypted source encrypted with a KmsKeyId', async () => {
      arm({ source: { StorageEncrypted: false } });
      await create({ StorageEncrypted: true, KmsKeyId: 'alias/aws/rds' });
      expect(only('RestoreDBClusterToPointInTimeCommand')['KmsKeyId']).toBe('alias/aws/rds');
    });

    it('takes the limitless request shape from a limitless source', async () => {
      arm({ source: { StorageEncrypted: true, ClusterScalabilityType: 'limitless' } });
      await create({
        MonitoringInterval: 60,
        MonitoringRoleArn: 'role-m',
        PerformanceInsightsEnabled: true,
        PerformanceInsightsRetentionPeriod: 31,
        PerformanceInsightsKmsKeyId: 'key-pi',
        StorageType: 'aurora-iopt1',
        EnableCloudwatchLogsExports: ['postgresql'],
      });
      expect(only('RestoreDBClusterToPointInTimeCommand')).toMatchObject({
        MonitoringInterval: 60,
        MonitoringRoleArn: 'role-m',
        EnablePerformanceInsights: true,
        PerformanceInsightsRetentionPeriod: 31,
        PerformanceInsightsKMSKeyId: 'key-pi',
      });
      const followUp = only('ModifyDBClusterCommand');
      for (const key of [
        'StorageType',
        'EnablePerformanceInsights',
        'PerformanceInsightsKMSKeyId',
        'CloudwatchLogsExportConfiguration',
      ]) {
        expect(followUp, key).not.toHaveProperty(key);
      }
      expect(followUp).toMatchObject({ PerformanceInsightsRetentionPeriod: 31, MonitoringInterval: 60 });
    });

    it('a standard source keeps monitoring and Performance Insights off the restore call', async () => {
      await create({ MonitoringInterval: 60, PerformanceInsightsEnabled: true });
      const restore = only('RestoreDBClusterToPointInTimeCommand');
      expect(restore).not.toHaveProperty('MonitoringInterval');
      expect(restore).not.toHaveProperty('EnablePerformanceInsights');
    });
  });

  it('refuses restoring the cluster from itself before any call', async () => {
    await expect(create({ SourceDBClusterIdentifier: CLUSTER.toUpperCase() })).rejects.toThrow(
      /SourceDBClusterIdentifier must be another cluster/
    );
    expect(mockSend).not.toHaveBeenCalled();
    // The deploy engine's delete-first replacement asks the same guard.
    expect(() =>
      refuseRestoreFromItself('AWS::RDS::DBCluster', { SourceDBClusterIdentifier: CLUSTER }, CLUSTER, 'L', {})
    ).toThrow(/must be another cluster/);
  });

  it("leaves an ARN source to the restore's own refusal, as the guard cannot tell its account", async () => {
    await create({ SourceDBClusterIdentifier: SOURCE_ARN });
    expect(only('RestoreDBClusterToPointInTimeCommand')['SourceDBClusterIdentifier']).toBe(SOURCE_ARN);
  });

  it('a restored record deletes no writer instance by name and detaches from no global cluster', async () => {
    await provider.delete('Cluster', CLUSTER, 'AWS::RDS::DBCluster', {
      ...BASE,
      WithExpressConfiguration: true,
      GlobalClusterIdentifier: 'global-1',
    });
    expect(sent('DeleteDBInstanceCommand')).toHaveLength(0);
    expect(sent('RemoveFromGlobalClusterCommand')).toHaveLength(0);
    expect(sent('DescribeGlobalClustersCommand')).toHaveLength(0);
    expect(only('DeleteDBClusterCommand')['DBClusterIdentifier']).toBe(CLUSTER);
  });

  it('a created (not restored) record still deletes its express writer and detaches first', async () => {
    await provider
      .delete('Cluster', CLUSTER, 'AWS::RDS::DBCluster', {
        DBClusterIdentifier: CLUSTER,
        Engine: 'aurora-postgresql',
        WithExpressConfiguration: true,
        GlobalClusterIdentifier: 'global-1',
      })
      .catch(() => undefined);
    expect(sent('DescribeGlobalClustersCommand').length).toBeGreaterThan(0);
  });

  it('deletes the restored cluster when the follow-up fails, and rethrows', async () => {
    const refused = new Error('bad parameter group');
    refused.name = 'DBClusterParameterGroupNotFound';
    arm({ failModify: refused });
    await expect(create({ DBClusterParameterGroupName: 'missing' })).rejects.toThrow(
      /bad parameter group/
    );
    expect(only('DeleteDBClusterCommand')).toEqual({
      DBClusterIdentifier: CLUSTER,
      SkipFinalSnapshot: true,
    });
  });

  it('never reads the four keys back for drift', () => {
    const unknown = provider.getDriftUnknownPaths('AWS::RDS::DBCluster', { ...BASE });
    for (const key of KEYS) expect(unknown, key).toContain(key);
  });
});
