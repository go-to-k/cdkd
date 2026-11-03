// go-to-k/cdkd#5628: `AWS::DocDB::DBCluster` restores through the SDK provider.
// Each expectation is a measured CloudFormation behavior (us-east-1, engine
// 5.0.0, the handler's calls read from CloudTrail): which call a template's
// keys select, what rides the restore and what a follow-up ModifyDBCluster
// sends, what CloudFormation refuses, and what it leaves unused.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mockSend = vi.fn();
const warn = vi.hoisted(() => vi.fn());
const debug = vi.hoisted(() => vi.fn());

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

// What the engine's per-resource deadline leaves; Infinity outside a deploy.
const remainingMs = vi.hoisted(() => ({ value: Number.POSITIVE_INFINITY }));
vi.mock('../../../src/deployment/resource-deadline.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  enclosingDeadlineRemainingMs: () => remainingMs.value,
}));

vi.mock('../../../src/utils/logger.js', () => {
  const logger = { debug, info: vi.fn(), warn, error: vi.fn(), child: () => logger };
  return { getLogger: () => logger };
});

import { DocDBProvider } from '../../../src/provisioning/providers/docdb-provider.js';
import { refuseRestoreFromItself } from '../../../src/provisioning/restore-source-guard.js';
import { PROPERTY_COVERAGE_BY_TYPE } from '../../../src/provisioning/property-coverage.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  createdBeforeFailure,
  createdResourceIdentityBeforeFailure,
} from '../../../src/provisioning/auxiliary-failure.js';

const CLUSTER = 'AWS::DocDB::DBCluster';
const PASSWORD = 'FAKE-not-a-real-password';
const SNAPSHOT = { DBClusterIdentifier: 'c', SnapshotIdentifier: 'snap' };
const LATEST = {
  DBClusterIdentifier: 'c',
  SourceDBClusterIdentifier: 'src',
  UseLatestRestorableTime: true,
};

type Bag = Record<string, unknown>;

function sent(command: string): Bag[] {
  return mockSend.mock.calls
    .filter(([cmd]) => (cmd as { constructor: { name: string } }).constructor.name === command)
    .map(([cmd]) => (cmd as { input: Bag }).input);
}

function commands(): string[] {
  return mockSend.mock.calls.map(
    ([cmd]) => (cmd as { constructor: { name: string } }).constructor.name
  );
}

interface Arm {
  /** What the restore call answers as the new cluster. */
  restored?: Bag;
  /** Whether the snapshot or source cluster is encrypted; `'absent'` leaves the field out. */
  sourceEncrypted?: boolean | 'absent';
  /** What the source describe answers instead: none listed, or a failure. */
  source?: 'missing' | Error;
  /** A ModifyDBCluster carrying this key fails with this error. */
  refuse?: { key: string; error: Error };
}

function arm({ restored = {}, sourceEncrypted = false, source, refuse }: Arm = {}): void {
  mockSend.mockImplementation((cmd: { constructor: { name: string }; input: Bag }) => {
    const isSource = cmd.input['DBClusterIdentifier'] === 'src';
    switch (cmd.constructor.name) {
      case 'DescribeDBClustersCommand':
        if (isSource && source instanceof Error) return Promise.reject(source);
        if (isSource && source === 'missing') return Promise.resolve({ DBClusters: [] });
        return Promise.resolve({
          DBClusters: [
            {
              DBClusterIdentifier: cmd.input['DBClusterIdentifier'],
              Status: 'available',
              ...(sourceEncrypted !== 'absent' && { StorageEncrypted: sourceEncrypted }),
              DBClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:c',
            },
          ],
        });
      case 'DescribeDBClusterSnapshotsCommand':
        if (source instanceof Error) return Promise.reject(source);
        return Promise.resolve({
          DBClusterSnapshots:
            source === 'missing'
              ? []
              : [sourceEncrypted === 'absent' ? {} : { StorageEncrypted: sourceEncrypted }],
        });
      case 'CreateDBClusterCommand':
      case 'RestoreDBClusterFromSnapshotCommand':
      case 'RestoreDBClusterToPointInTimeCommand':
        return Promise.resolve({
          DBCluster: { DbClusterResourceId: 'r', Status: 'creating', ...restored },
        });
      case 'ModifyDBClusterCommand':
        if (refuse !== undefined && cmd.input[refuse.key] !== undefined) {
          return Promise.reject(refuse.error);
        }
        return Promise.resolve({});
      default:
        return Promise.resolve({});
    }
  });
}

function awsError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe('DocDBProvider restore (go-to-k/cdkd#5628)', () => {
  let provider: DocDBProvider;

  beforeEach(() => {
    mockSend.mockReset();
    warn.mockReset();
    debug.mockReset();
    provider = new DocDBProvider();
    (provider as unknown as { sleep: () => Promise<void> }).sleep = () => Promise.resolve();
  });

  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
    remainingMs.value = Number.POSITIVE_INFINITY;
  });

  const create = (properties: Bag, context?: Bag) =>
    provider.create('L', CLUSTER, properties, context as never);

  it('leaves the real coverage map no SDK-unwired property on the cluster', () => {
    expect(PROPERTY_COVERAGE_BY_TYPE.get(CLUSTER)).toBeDefined();
    expect([...(PROPERTY_COVERAGE_BY_TYPE.get(CLUSTER)?.sdkUnwired.keys() ?? [])]).toEqual([]);
  });

  describe('which call the keys select', () => {
    it('restores from a snapshot with what CloudFormation sends on the call', async () => {
      arm();
      await create({
        ...SNAPSHOT,
        EngineVersion: '5.0.0',
        MasterUsername: 'u',
        VpcSecurityGroupIds: ['sg-1'],
        DBSubnetGroupName: 'subnets',
        KmsKeyId: 'alias/aws/rds',
        StorageEncrypted: true,
        DeletionProtection: true,
        CopyTagsToSnapshot: true,
        AvailabilityZones: ['us-east-1a'],
        EnableCloudwatchLogsExports: ['profiler'],
        StorageType: 'iopt1',
        NetworkType: 'IPV4',
        ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 1 },
        Tags: [{ Key: 'k', Value: 'v' }],
      });
      expect(sent('CreateDBClusterCommand')).toEqual([]);
      expect(sent('RestoreDBClusterFromSnapshotCommand')).toEqual([
        {
          DBClusterIdentifier: 'c',
          SnapshotIdentifier: 'snap',
          Engine: 'docdb',
          EngineVersion: '5.0.0',
          // The type's port, not the source's, which AWS would default to.
          Port: 27017,
          AvailabilityZones: ['us-east-1a'],
          VpcSecurityGroupIds: ['sg-1'],
          DBSubnetGroupName: 'subnets',
          KmsKeyId: 'alias/aws/rds',
          DeletionProtection: true,
          CopyTagsToSnapshot: true,
          NetworkType: 'IPV4',
          StorageType: 'iopt1',
          EnableCloudwatchLogsExports: ['profiler'],
          ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 1 },
          Tags: [{ Key: 'k', Value: 'v' }],
        },
      ]);
      // Nothing left for a follow-up.
      expect(sent('ModifyDBClusterCommand')).toEqual([]);
    });

    it('restores a source cluster to its latest time, with a declared port', async () => {
      arm();
      await create({ ...LATEST, RestoreType: 'copy-on-write', Port: 27018 });
      const [input] = sent('RestoreDBClusterToPointInTimeCommand');
      expect(input).toMatchObject({
        DBClusterIdentifier: 'c',
        SourceDBClusterIdentifier: 'src',
        RestoreType: 'copy-on-write',
        UseLatestRestorableTime: true,
        Port: 27018,
      });
      expect(input).not.toHaveProperty('RestoreToTime');
    });

    it('restores to a declared time, read with its zone', async () => {
      arm();
      await create({
        DBClusterIdentifier: 'c',
        SourceDBClusterIdentifier: 'src',
        RestoreToTime: '2026-11-02T15:45:00+09:00',
        UseLatestRestorableTime: false,
      });
      const [input] = sent('RestoreDBClusterToPointInTimeCommand');
      expect((input!['RestoreToTime'] as Date).toISOString()).toBe('2026-11-02T06:45:00.000Z');
      expect(input).not.toHaveProperty('UseLatestRestorableTime');

      // A space for the `T`: not refused unmeasured.
      mockSend.mockClear();
      await create({ ...LATEST, UseLatestRestorableTime: false, RestoreToTime: '2026-11-02 15:45:00Z' });
      expect(
        (sent('RestoreDBClusterToPointInTimeCommand')[0]!['RestoreToTime'] as Date).toISOString()
      ).toBe('2026-11-02T15:45:00.000Z');
    });

    it('reads an empty identifier as none, as CloudFormation does', async () => {
      arm();
      await create({ ...SNAPSHOT, SourceDBClusterIdentifier: '' });
      expect(commands()[0]).toBe('RestoreDBClusterFromSnapshotCommand');

      mockSend.mockClear();
      await create({ DBClusterIdentifier: 'c', SnapshotIdentifier: '', MasterUsername: 'u' });
      expect(commands()[0]).toBe('CreateDBClusterCommand');
    });

    it('reads an empty RestoreToTime as none, as it reads an empty identifier', async () => {
      arm();
      await create({ ...LATEST, RestoreToTime: '' });
      const [input] = sent('RestoreDBClusterToPointInTimeCommand');
      expect(input!['UseLatestRestorableTime']).toBe(true);
      expect(input).not.toHaveProperty('RestoreToTime');
    });

    it('creates, warning by name, when only point-in-time keys are declared', async () => {
      arm();
      await create({
        DBClusterIdentifier: 'c',
        MasterUsername: 'u',
        RestoreType: 'full-copy',
        RestoreToTime: 'not read',
        UseLatestRestorableTime: true,
      });
      const [input] = sent('CreateDBClusterCommand');
      expect(input).not.toHaveProperty('RestoreType');
      expect(input!['Port']).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'this create does not use RestoreType, RestoreToTime, UseLatestRestorableTime, as in CloudFormation'
        )
      );
    });

    it('names the keys a restore leaves unused, a false UseLatestRestorableTime aside', async () => {
      arm();
      await create({
        ...SNAPSHOT,
        RestoreType: 'full-copy',
        UseLatestRestorableTime: false,
        GlobalClusterIdentifier: 'g',
      });
      expect(sent('RestoreDBClusterFromSnapshotCommand')[0]).not.toHaveProperty(
        'GlobalClusterIdentifier'
      );
      expect(warn.mock.calls.flat().join('\n')).toContain(
        'this snapshot restore does not use RestoreType, GlobalClusterIdentifier'
      );

      warn.mockReset();
      await create({ ...LATEST, AvailabilityZones: ['us-east-1a'] });
      expect(sent('RestoreDBClusterToPointInTimeCommand')[0]).not.toHaveProperty(
        'AvailabilityZones'
      );
      expect(warn.mock.calls.flat().join('\n')).toContain(
        'this point-in-time restore does not use AvailabilityZones'
      );
    });
  });

  describe('what CloudFormation refuses, refused before any call', () => {
    it.each([
      [
        'both identifiers',
        { ...SNAPSHOT, SourceDBClusterIdentifier: 'src' },
        /cannot both be set/,
      ],
      [
        'a source with no time',
        { DBClusterIdentifier: 'c', SourceDBClusterIdentifier: 'src' },
        /needs RestoreToTime or UseLatestRestorableTime: true/,
      ],
      [
        'a source with UseLatestRestorableTime false',
        { ...LATEST, UseLatestRestorableTime: false },
        /needs RestoreToTime or UseLatestRestorableTime: true/,
      ],
      [
        'both a time and the latest time',
        { ...LATEST, RestoreToTime: '2026-11-02T15:45:00Z' },
        /RestoreToTime and UseLatestRestorableTime: true cannot both be set/,
      ],
      [
        'a time with no zone',
        { DBClusterIdentifier: 'c', SourceDBClusterIdentifier: 'src', RestoreToTime: '2026-11-02T15:45:00' },
        /RestoreToTime must be a timestamp with a time zone/,
      ],
      [
        'a time that is no timestamp',
        { DBClusterIdentifier: 'c', SourceDBClusterIdentifier: 'src', RestoreToTime: 'yesterdayZ' },
        /RestoreToTime must be a timestamp with a time zone/,
      ],
      [
        // `Date` would read this as the year 99.
        'a zone after no timestamp',
        { DBClusterIdentifier: 'c', SourceDBClusterIdentifier: 'src', RestoreToTime: 'garbage+0100' },
        /RestoreToTime must be a timestamp with a time zone/,
      ],
      ['a non-string identifier', { DBClusterIdentifier: 'c', SnapshotIdentifier: 7 }, /SnapshotIdentifier must be a string/],
      ['a non-string RestoreType', { ...LATEST, RestoreType: 1 }, /RestoreType must be a string/],
      ['an unreadable UseLatestRestorableTime', { ...LATEST, UseLatestRestorableTime: 'yes' }, /UseLatestRestorableTime must be a boolean/],
    ])('%s', async (_name, properties, says) => {
      arm();
      const error = (await create(properties).catch((e: unknown) => e)) as Error;
      expect(error.message).toMatch(says);
      expect(error.message).toContain('nothing was changed');
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuses on a state replay too: AWS refuses each shape outright', async () => {
      arm();
      const error = (await create(
        { ...SNAPSHOT, SourceDBClusterIdentifier: 'src' },
        { replayingState: true }
      ).catch((e: unknown) => e)) as Error;
      expect(error.message).toMatch(/cannot both be set/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it.each([
      ['snapshot', SNAPSHOT, 'DescribeDBClusterSnapshotsCommand'],
      ['point-in-time', LATEST, 'DescribeDBClustersCommand'],
    ])(
      'refuses StorageEncrypted with no key from an unencrypted %s source',
      async (_kind, restore, describe) => {
        arm({ sourceEncrypted: false });
        const error = (await create({ ...restore, StorageEncrypted: true }).catch(
          (e: unknown) => e
        )) as Error;
        expect(error.message).toMatch(/restore source does not read as encrypted and no KmsKeyId is set/);
        expect(isMarkedNonRetryable(error)).toBe(true);
        expect(commands()).toEqual([describe]);
      }
    );

    it('refuses a source whose encryption it cannot read off a listed one', async () => {
      arm({ sourceEncrypted: 'absent' });
      await expect(create({ ...SNAPSHOT, StorageEncrypted: true })).rejects.toThrow(
        /restore source does not read as encrypted/
      );
      expect(sent('RestoreDBClusterFromSnapshotCommand')).toEqual([]);
    });

    it.each([
      ['listed nowhere', 'missing' as const],
      ['not found', awsError('DBClusterSnapshotNotFoundFault', 'DBClusterSnapshot not found')],
    ])('leaves a snapshot %s to the restore call', async (_how, source) => {
      arm({ source });
      await create({ ...SNAPSHOT, StorageEncrypted: true });
      expect(commands().slice(0, 2)).toEqual([
        'DescribeDBClusterSnapshotsCommand',
        'RestoreDBClusterFromSnapshotCommand',
      ]);
    });

    it('leaves a source cluster listed nowhere to the restore call', async () => {
      arm({ source: 'missing' });
      await create({ ...LATEST, StorageEncrypted: true });
      expect(commands().slice(0, 2)).toEqual([
        'DescribeDBClustersCommand',
        'RestoreDBClusterToPointInTimeCommand',
      ]);
    });

    it('fails, masked and before any write, when the source cannot be read', async () => {
      arm({ source: awsError('AccessDenied', `not allowed for ${PASSWORD}`) });
      const error = (await create(
        { ...LATEST, StorageEncrypted: true },
        { maskSecrets: (text: string) => text.split(PASSWORD).join('***') }
      ).catch((e: unknown) => e)) as Error;
      expect(error.message).toMatch(/reading whether the restore source is encrypted failed/);
      expect(JSON.stringify([error.message, ...debug.mock.calls])).not.toContain(PASSWORD);
      expect(commands()).toEqual(['DescribeDBClustersCommand']);
    });

    it('restores an encrypted source with no key, and reads no source for a declared key', async () => {
      arm({ sourceEncrypted: true });
      await create({ ...SNAPSHOT, StorageEncrypted: 'true' });
      expect(commands().slice(0, 2)).toEqual([
        'DescribeDBClusterSnapshotsCommand',
        'RestoreDBClusterFromSnapshotCommand',
      ]);
      // A shared or public snapshot is read too: a public one is never encrypted.
      expect(sent('DescribeDBClusterSnapshotsCommand')).toEqual([
        { DBClusterSnapshotIdentifier: 'snap', IncludeShared: true, IncludePublic: true },
      ]);

      mockSend.mockClear();
      await create({ ...SNAPSHOT, StorageEncrypted: true, KmsKeyId: 'alias/aws/rds' });
      expect(commands()[0]).toBe('RestoreDBClusterFromSnapshotCommand');
    });
  });

  describe('the follow-up ModifyDBCluster', () => {
    it('sends what CloudFormation sets after a snapshot restore, then the password it drops', async () => {
      arm();
      await create({
        ...SNAPSHOT,
        DBClusterParameterGroupName: 'params',
        BackupRetentionPeriod: 3,
        PreferredBackupWindow: '05:00-05:30',
        PreferredMaintenanceWindow: 'sun:06:00-sun:06:30',
        MasterUserPassword: PASSWORD,
      });
      expect(sent('RestoreDBClusterFromSnapshotCommand')[0]).not.toHaveProperty(
        'DBClusterParameterGroupName'
      );
      expect(sent('ModifyDBClusterCommand')).toEqual([
        {
          DBClusterIdentifier: 'c',
          DBClusterParameterGroupName: 'params',
          BackupRetentionPeriod: 3,
          PreferredBackupWindow: '05:00-05:30',
          PreferredMaintenanceWindow: 'sun:06:00-sun:06:30',
          ApplyImmediately: true,
        },
        { DBClusterIdentifier: 'c', MasterUserPassword: PASSWORD, ApplyImmediately: true },
      ]);
      // `available` before the follow-up, and again after it, then the final read.
      expect(commands()).toEqual([
        'RestoreDBClusterFromSnapshotCommand',
        'DescribeDBClustersCommand',
        'ModifyDBClusterCommand',
        'ModifyDBClusterCommand',
        'DescribeDBClustersCommand',
        'DescribeDBClustersCommand',
      ]);
    });

    it('sends the point-in-time keys CloudFormation drops, and the group this SDK cannot put on the call', async () => {
      arm();
      await create({
        ...LATEST,
        DBClusterParameterGroupName: 'params',
        BackupRetentionPeriod: 5,
        PreferredBackupWindow: '05:00-05:30',
        ManageMasterUserPassword: true,
        MasterUserSecretKmsKeyId: 'alias/secret-key',
      });
      expect(sent('RestoreDBClusterToPointInTimeCommand')[0]).not.toHaveProperty(
        'DBClusterParameterGroupName'
      );
      expect(sent('ModifyDBClusterCommand')).toEqual([
        { DBClusterIdentifier: 'c', DBClusterParameterGroupName: 'params', ApplyImmediately: true },
        {
          DBClusterIdentifier: 'c',
          BackupRetentionPeriod: 5,
          PreferredBackupWindow: '05:00-05:30',
          PreferredMaintenanceWindow: undefined,
          ManageMasterUserPassword: true,
          MasterUserSecretKmsKeyId: 'alias/secret-key',
          ApplyImmediately: true,
        },
      ]);
    });

    it('warns by key, never by value, when AWS refuses a dropped value, and keeps the cluster', async () => {
      arm({
        refuse: {
          key: 'PreferredBackupWindow',
          error: awsError('InvalidParameterValue', `window overlaps; ${PASSWORD}`),
        },
      });
      const result = await create(
        { ...LATEST, BackupRetentionPeriod: 5, PreferredBackupWindow: '05:00-05:30' },
        { maskSecrets: (text: string) => text.split(PASSWORD).join('***') }
      );
      expect(result.physicalId).toBe('c');
      // The combined call, then each group alone.
      expect(sent('ModifyDBClusterCommand').map((input) => Object.keys(input).sort())).toEqual([
        [
          'ApplyImmediately',
          'BackupRetentionPeriod',
          'DBClusterIdentifier',
          'PreferredBackupWindow',
          'PreferredMaintenanceWindow',
        ],
        ['ApplyImmediately', 'BackupRetentionPeriod', 'DBClusterIdentifier'],
        [
          'ApplyImmediately',
          'DBClusterIdentifier',
          'PreferredBackupWindow',
          'PreferredMaintenanceWindow',
        ],
      ]);
      const warned = warn.mock.calls.flat().join('\n');
      expect(warned).toContain('AWS refused PreferredBackupWindow after the restore');
      expect(warned).not.toContain('BackupRetentionPeriod,');
      expect(warned).not.toContain('05:00');
      expect(JSON.stringify([...warn.mock.calls, ...debug.mock.calls])).not.toContain(PASSWORD);
    });

    it.each([
      [
        'AWS refuses what CloudFormation sends too',
        { key: 'DBClusterParameterGroupName', error: awsError('InvalidParameterCombination', 'x') },
        { DBClusterParameterGroupName: 'params' },
      ],
      [
        'any other follow-up failure',
        { key: 'MasterUserPassword', error: awsError('AccessDenied', 'no') },
        { MasterUserPassword: PASSWORD },
      ],
    ])('fails the create on %s, marking the restored cluster', async (_name, refuse, declared) => {
      arm({ refuse });
      const error = await create({ ...SNAPSHOT, ...declared }).catch((e: unknown) => e);
      expect((error as Error).message).toMatch(/Failed to create DocDB DBCluster L/);
      expect(createdBeforeFailure(error, 'L', CLUSTER)).toBe('c');
      expect(createdResourceIdentityBeforeFailure(error, 'L', CLUSTER)).toBe('r');
    });

    it('sends a lone refused group once, and warns of nothing when each group alone passes', async () => {
      arm({
        refuse: { key: 'MasterUserPassword', error: awsError('InvalidParameterValue', 'bad') },
      });
      await create({ ...SNAPSHOT, MasterUserPassword: PASSWORD });
      expect(sent('ModifyDBClusterCommand')).toHaveLength(1);
      expect(warn.mock.calls.flat().join('\n')).toContain(
        'AWS refused MasterUserPassword after the restore'
      );

      mockSend.mockReset();
      warn.mockReset();
      // The combined call is refused, each group alone is accepted.
      let calls = 0;
      arm();
      const base = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((cmd: { constructor: { name: string }; input: Bag }) => {
        if (cmd.constructor.name === 'ModifyDBClusterCommand' && calls++ === 0) {
          return Promise.reject(awsError('InvalidParameterCombination', 'together'));
        }
        return base(cmd);
      });
      await create({ ...LATEST, BackupRetentionPeriod: 5, PreferredBackupWindow: '05:00-05:30' });
      expect(sent('ModifyDBClusterCommand')).toHaveLength(3);
      expect(warn).not.toHaveBeenCalled();
    });

    it('waits for a restore as long as the resource deadline allows', async () => {
      arm();
      remainingMs.value = 3_600_000;
      const wait = vi.spyOn(
        provider as unknown as { waitForClusterAvailable: (...args: unknown[]) => Promise<void> },
        'waitForClusterAvailable'
      );
      await create({ ...SNAPSHOT, BackupRetentionPeriod: 3 });
      // The 30-minute create cap, lifted to what the deadline leaves minus its margin.
      expect(wait.mock.calls.map((call) => call[2])).toEqual([3_570_000, 3_570_000]);

      wait.mockClear();
      await create({ DBClusterIdentifier: 'c', MasterUsername: 'u' });
      expect(wait.mock.calls.map((call) => call[2])).toEqual([undefined]);
    });

    it('under --no-wait waits only when a follow-up needs the cluster available', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      arm();
      await create(SNAPSHOT);
      expect(commands()).toEqual(['RestoreDBClusterFromSnapshotCommand', 'DescribeDBClustersCommand']);

      mockSend.mockClear();
      await create({ ...SNAPSHOT, BackupRetentionPeriod: 3 });
      expect(commands()).toEqual([
        'RestoreDBClusterFromSnapshotCommand',
        'DescribeDBClustersCommand',
        'ModifyDBClusterCommand',
        'DescribeDBClustersCommand',
      ]);
    });
  });

  it('warns when the restored cluster keeps its source user name or engine', async () => {
    arm({ restored: { MasterUsername: 'srcadmin', EngineVersion: '5.0.0' } });
    await create({ ...LATEST, MasterUsername: 'other', EngineVersion: '8.0.0' });
    expect(warn.mock.calls.flat().join('\n')).toContain(
      "the restored cluster keeps its source's MasterUsername, EngineVersion, not the template's, as in CloudFormation: a restore does not set them. cdkd drift does not report the difference: its baseline is the readback taken at deploy."
    );

    warn.mockReset();
    await create({ ...SNAPSHOT, MasterUsername: 'srcadmin', EngineVersion: '8.0.0' });
    expect(warn).not.toHaveBeenCalled();

    // A snapshot restore names a differing user name, but not the engine it sets.
    await create({ ...SNAPSHOT, MasterUsername: 'other', EngineVersion: '8.0.0' });
    expect(warn.mock.calls.flat().join('\n')).toContain(
      "keeps its source's MasterUsername, not the template's"
    );
  });

  describe('a source naming the cluster itself', () => {
    it('is refused before any call, the name compared in any case', async () => {
      arm();
      const error = (await create({ ...LATEST, SourceDBClusterIdentifier: 'C' }).catch(
        (e: unknown) => e
      )) as Error;
      expect(error.message).toMatch(
        /SourceDBClusterIdentifier must be another cluster than the one this creates or replaces/
      );
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('is refused for a delete-first replacement, before its delete', () => {
      expect(() =>
        refuseRestoreFromItself(CLUSTER, { SourceDBClusterIdentifier: 'c' }, 'c', 'L', {
          region: 'us-east-1',
        })
      ).toThrow(/must be another cluster/);
    });

    it.each([
      ['its name', 'rds:c-2026-11-02-03-00', CLUSTER],
      ['its ARN', 'arn:aws:rds:us-east-1:123456789012:cluster-snapshot:rds:C-2026-11-02-03-00', CLUSTER],
      ['a Neptune name', 'rds:c-2026-11-02-03-00', 'AWS::Neptune::DBCluster'],
    ])('refuses an automated snapshot of the cluster itself by %s', (_how, snapshot, type) => {
      expect(() =>
        refuseRestoreFromItself(type, { SnapshotIdentifier: snapshot }, 'c', 'L', {
          region: 'us-east-1',
          account: '123456789012',
        })
      ).toThrow(/names an automated snapshot of the cluster this creates or replaces/);
    });

    it.each([
      ['a manual snapshot, which survives the delete', 'c-manual'],
      ['another cluster\'s automated snapshot', 'rds:c-other-2026-11-02-03-00'],
      ['one in another region', 'arn:aws:rds:eu-west-1:123456789012:cluster-snapshot:rds:c-2026-11-02-03-00'],
      ['one in another account', 'arn:aws:rds:us-east-1:999999999999:cluster-snapshot:rds:c-2026-11-02-03-00'],
    ])('leaves %s alone', (_how, snapshot) => {
      expect(() =>
        refuseRestoreFromItself(CLUSTER, { SnapshotIdentifier: snapshot }, 'c', 'L', {
          region: 'us-east-1',
          account: '123456789012',
        })
      ).not.toThrow();
    });

    it('refuses a create restoring an automated snapshot of its own name before any call', async () => {
      arm();
      await expect(
        create({ DBClusterIdentifier: 'c', SnapshotIdentifier: 'rds:c-2026-11-02-03-00' })
      ).rejects.toThrow(/names an automated snapshot/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('leaves an ARN to AWS at create: no account is known there', async () => {
      arm();
      await create({
        ...LATEST,
        SourceDBClusterIdentifier: 'arn:aws:rds:us-east-1:123456789012:cluster:c',
      });
      expect(commands()[0]).toBe('RestoreDBClusterToPointInTimeCommand');
    });
  });

  it('a later update of a point-in-time key sends nothing for it, as CloudFormation', async () => {
    arm();
    await provider.update(
      'L',
      'c',
      CLUSTER,
      { ...LATEST, RestoreType: 'copy-on-write' },
      { ...LATEST, RestoreType: 'full-copy', UseLatestRestorableTime: false }
    );
    const [input] = sent('ModifyDBClusterCommand');
    expect(input).toBeDefined();
    for (const key of ['RestoreType', 'UseLatestRestorableTime', 'SourceDBClusterIdentifier']) {
      expect(input).not.toHaveProperty(key);
    }
    expect(warn).not.toHaveBeenCalled();
  });
});
