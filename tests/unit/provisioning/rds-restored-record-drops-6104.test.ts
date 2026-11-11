// go-to-k/cdkd#6104: a DBCluster record written under `--prefer-sdk-route`
// before the SDK route wired restores (#6096 / #6098) can hold a restore
// source key only as an `acceptedCreateOnlyDrops` entry: cdkd ran a plain
// CreateDBCluster over it. The delete / update callers thread the record's
// list as `recordedCreateOnlyDrops`, and such a record is not a restore's.
// No list (or a malformed one) keeps the pre-#6104 reading.
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const rdsSend = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-rds', async () => {
  const actual = await vi.importActual('@aws-sdk/client-rds');
  return {
    ...actual,
    RDSClient: vi.fn().mockImplementation(() => ({
      send: rdsSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => child,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import {
  isRestoredRecord,
  recordedCreateOnlyDropsOf,
} from '../../../src/provisioning/providers/rds/cluster-restore.js';

type Input = Record<string, unknown>;

const TYPE = 'AWS::RDS::DBCluster';
const ID = 'db-1';
const ARN = `arn:aws:rds:us-east-1:111122223333:cluster:${ID}`;
const WRITER = `${ID}-instance-1`;
const SNAPSHOT = 'manual-snap-1';

const awsError = (name: string, message = name): Error =>
  Object.assign(new Error(message), { name });

interface Live {
  /** The global cluster the live cluster is a member of (undefined: none). */
  member?: string;
  /** DescribeDBClusterSnapshots answers no snapshot. */
  noSnapshot?: boolean;
  /** DescribeDBClusterSnapshots fails with this. */
  snapshotError?: Error;
}

function arm(live: Live = {}): void {
  let deleted = false;
  let member = live.member;
  rdsSend.mockImplementation((cmd: { constructor: { name: string }; input: Input }) => {
    const name = cmd.constructor.name;
    if (name === 'DeleteDBClusterCommand') {
      deleted = true;
      return Promise.resolve({});
    }
    if (name === 'DescribeDBClustersCommand') {
      if (deleted) return Promise.reject(awsError('DBClusterNotFoundFault'));
      return Promise.resolve({
        DBClusters: [
          {
            DBClusterIdentifier: ID,
            DBClusterArn: ARN,
            Status: 'available',
            DeletionProtection: false,
            DBClusterMembers: [{ DBInstanceIdentifier: WRITER, IsClusterWriter: true }],
          },
        ],
      });
    }
    if (name === 'DescribeDBInstancesCommand') {
      return Promise.reject(awsError('DBInstanceNotFoundFault'));
    }
    if (name === 'DescribeGlobalClustersCommand') {
      const wanted = cmd.input['GlobalClusterIdentifier'];
      const all =
        member === undefined
          ? []
          : [
              {
                GlobalClusterIdentifier: member,
                GlobalClusterMembers: [{ DBClusterArn: ARN, IsWriter: true }],
              },
            ];
      return Promise.resolve({
        GlobalClusters:
          wanted === undefined ? all : all.filter((g) => g.GlobalClusterIdentifier === wanted),
      });
    }
    if (name === 'RemoveFromGlobalClusterCommand') {
      member = undefined;
      return Promise.resolve({});
    }
    if (name === 'DescribeDBClusterSnapshotsCommand') {
      if (live.snapshotError !== undefined) return Promise.reject(live.snapshotError);
      return Promise.resolve({
        DBClusterSnapshots: live.noSnapshot === true ? [] : [{ EngineVersion: '16.4' }],
      });
    }
    if (name === 'DescribeDBClusterAutomatedBackupsCommand') {
      return Promise.resolve({
        DBClusterAutomatedBackups: [{ StorageEncrypted: true, Status: 'active' }],
      });
    }
    return Promise.resolve({});
  });
}

const sent = (name: string): Input[] =>
  rdsSend.mock.calls
    .filter(([cmd]) => (cmd as { constructor: { name: string } }).constructor.name === name)
    .map(([cmd]) => (cmd as { input: Input }).input);

const BASE: Input = { DBClusterIdentifier: ID, Engine: 'aurora-postgresql' };

/** Each restore source key, as the record holds it. */
const SOURCES: Array<[string, Input]> = [
  ['SourceDBClusterIdentifier', { SourceDBClusterIdentifier: 'source-1' }],
  ['SourceDbClusterResourceId', { SourceDbClusterResourceId: 'cluster-SOURCEID123' }],
  ['SnapshotIdentifier', { SnapshotIdentifier: SNAPSHOT }],
];

describe('DBCluster records holding a restore source key only as an accepted drop (go-to-k/cdkd#6104)', () => {
  let provider: RDSProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    rdsSend.mockReset();
    provider = new RDSProvider();
    vi.spyOn(
      provider as unknown as { sleep: (ms: number) => Promise<void> },
      'sleep'
    ).mockResolvedValue(undefined);
    arm();
  });

  describe('isRestoredRecord', () => {
    it.each(SOURCES)('ignores %s when the record lists it as a drop', (key, source) => {
      expect(isRestoredRecord(source, new Set([key]))).toBe(false);
      expect(isRestoredRecord(source, new Set())).toBe(true);
      // Another key's drop does not hide this one.
      expect(isRestoredRecord(source, new Set(['WithExpressConfiguration']))).toBe(true);
    });

    it('stays a restore when an undropped source key remains', () => {
      expect(
        isRestoredRecord(
          { SourceDBClusterIdentifier: 'source-1', SnapshotIdentifier: SNAPSHOT },
          new Set(['SourceDBClusterIdentifier'])
        )
      ).toBe(true);
    });

    it('reads an absent or malformed list as no drops', () => {
      expect(recordedCreateOnlyDropsOf(undefined).size).toBe(0);
      expect(recordedCreateOnlyDropsOf({}).size).toBe(0);
      expect(recordedCreateOnlyDropsOf({ recordedCreateOnlyDrops: 'SnapshotIdentifier' }).size).toBe(0);
      expect([
        ...recordedCreateOnlyDropsOf({ recordedCreateOnlyDrops: ['SnapshotIdentifier', 7] }),
      ]).toEqual(['SnapshotIdentifier']);
    });
  });

  describe('delete, express writer', () => {
    const del = (properties: Input, context?: Input) =>
      provider.delete('Cluster', ID, TYPE, { ...BASE, WithExpressConfiguration: true, ...properties }, context);

    it.each(SOURCES)(
      'deletes the writer of a plain create whose %s is a recorded drop',
      async (key, source) => {
        await del(source, { recordedCreateOnlyDrops: [key] });
        expect(sent('DeleteDBInstanceCommand')).toEqual([
          { DBInstanceIdentifier: WRITER, SkipFinalSnapshot: true },
        ]);
        expect(sent('DeleteDBClusterCommand')).toHaveLength(1);
      }
    );

    it.each(SOURCES)('deletes no writer by name for a genuine %s restore', async (_key, source) => {
      await del(source, { recordedCreateOnlyDrops: [] });
      expect(sent('DeleteDBInstanceCommand')).toHaveLength(0);
      expect(sent('DeleteDBClusterCommand')).toHaveLength(1);
    });

    it.each([
      ['no context', undefined],
      ['no list', {}],
      ['a malformed list', { recordedCreateOnlyDrops: 'SourceDBClusterIdentifier' }],
    ])('with %s, reads a source key as a restore, as before', async (_label, context) => {
      await del({ SourceDBClusterIdentifier: 'source-1' }, context);
      expect(sent('DeleteDBInstanceCommand')).toHaveLength(0);
    });

    it('deletes no instance by name when WithExpressConfiguration itself was a recorded drop', async () => {
      // RDS made no writer: an instance under that name is not one cdkd created.
      await del({}, { recordedCreateOnlyDrops: ['WithExpressConfiguration'] });
      expect(sent('DeleteDBInstanceCommand')).toHaveLength(0);
      expect(sent('DeleteDBClusterCommand')).toHaveLength(1);
    });

    it('still deletes the writer of a plain express create with no drops', async () => {
      await del({}, { recordedCreateOnlyDrops: [] });
      expect(sent('DeleteDBInstanceCommand')).toHaveLength(1);
    });
  });

  describe('delete, global cluster detach', () => {
    it('detaches a plain create whose source key is a recorded drop through the by-name read', async () => {
      arm({ member: 'g-1' });
      await provider.delete(
        'Cluster',
        ID,
        TYPE,
        { ...BASE, SourceDBClusterIdentifier: 'source-1', GlobalClusterIdentifier: 'g-1' },
        { recordedCreateOnlyDrops: ['SourceDBClusterIdentifier'] }
      );
      // The restored arm's membership listing (no identifier) is not asked first.
      expect(sent('DescribeGlobalClustersCommand')[0]).toEqual({ GlobalClusterIdentifier: 'g-1' });
      expect(sent('RemoveFromGlobalClusterCommand')).toHaveLength(1);
    });

    it('asks a genuine restore for its membership first', async () => {
      arm({ member: 'g-1' });
      await provider.delete(
        'Cluster',
        ID,
        TYPE,
        { ...BASE, SourceDBClusterIdentifier: 'source-1', GlobalClusterIdentifier: 'g-1' },
        { recordedCreateOnlyDrops: [] }
      );
      expect(sent('DescribeGlobalClustersCommand')[0]).toEqual({});
      expect(sent('RemoveFromGlobalClusterCommand')).toHaveLength(1);
    });
  });

  describe('update, global cluster on a state-borne replay', () => {
    const replay = (previous: Input, context: Input) =>
      provider.update(
        'Cluster',
        ID,
        TYPE,
        { ...BASE, ...previous },
        { ...BASE, ...previous },
        { replayingState: true, ...context }
      );

    it.each(SOURCES)(
      'drops a lost membership from a plain create whose %s is a recorded drop',
      async (key, source) => {
        // The live cluster is in no global cluster.
        const result = await replay(
          { ...source, GlobalClusterIdentifier: 'g-1' },
          { recordedCreateOnlyDrops: [key] }
        );
        expect(result.effectiveProperties).toBeDefined();
        expect(result.effectiveProperties).not.toHaveProperty('GlobalClusterIdentifier');
        expect(warn.mock.calls.flat().join('\n')).toMatch(/no longer a member of global cluster g-1/);
      }
    );

    it.each(SOURCES)('keeps the key of a genuine %s restore', async (_key, source) => {
      const result = await replay(
        { ...source, GlobalClusterIdentifier: 'g-1' },
        { recordedCreateOnlyDrops: [] }
      );
      expect(result.effectiveProperties?.['GlobalClusterIdentifier'] ?? 'g-1').toBe('g-1');
      expect(warn.mock.calls.flat().join('\n')).not.toMatch(/no longer a member/);
    });

    it('keeps the key with no list, as before', async () => {
      const result = await replay(
        { SourceDBClusterIdentifier: 'source-1', GlobalClusterIdentifier: 'g-1' },
        {}
      );
      expect(result.effectiveProperties?.['GlobalClusterIdentifier'] ?? 'g-1').toBe('g-1');
    });
  });

  describe('update, template-path removal of GlobalClusterIdentifier', () => {
    const update = (context: Input) =>
      provider.update(
        'Cluster',
        ID,
        TYPE,
        { ...BASE, SourceDBClusterIdentifier: 'source-1' },
        { ...BASE, SourceDBClusterIdentifier: 'source-1', GlobalClusterIdentifier: 'g-1' },
        context
      );

    it('detaches a plain create whose source key is a recorded drop without the restored pre-check', async () => {
      arm({ member: 'g-1' });
      await update({ recordedCreateOnlyDrops: ['SourceDBClusterIdentifier'] });
      expect(sent('DescribeGlobalClustersCommand')[0]).toEqual({ GlobalClusterIdentifier: 'g-1' });
      expect(sent('RemoveFromGlobalClusterCommand')).toHaveLength(1);
    });

    it('pre-checks a genuine restore, and detaches nothing it is not a member of', async () => {
      await update({ recordedCreateOnlyDrops: [] });
      expect(sent('DescribeGlobalClustersCommand')[0]).toEqual({});
      expect(sent('RemoveFromGlobalClusterCommand')).toHaveLength(0);
    });
  });

  describe("readRestoreSnapshot's wording", () => {
    const create = (properties: Input) => provider.create('Cluster', TYPE, { ...BASE, ...properties });

    it('a snapshot restore says there is nothing to restore', async () => {
      arm({ noSnapshot: true });
      await expect(create({ SnapshotIdentifier: SNAPSHOT })).rejects.toThrow(
        /does not name a DB cluster snapshot this account can read, so there is nothing to restore; nothing was changed\./
      );
    });

    it('a point-in-time restore names the snapshot as unused, never "nothing to restore"', async () => {
      arm({ noSnapshot: true });
      const error = (await create({
        SourceDbClusterResourceId: 'cluster-SOURCEID123',
        UseLatestRestorableTime: true,
        SnapshotIdentifier: SNAPSHOT,
      }).catch((e: unknown) => e)) as Error;
      expect(error.message).toMatch(
        /does not name a DB cluster snapshot this account can read\. The point-in-time restore does not use it, but CloudFormation reads a declared snapshot first and fails the create, so nothing was changed/
      );
      expect(error.message).not.toMatch(/nothing to restore/);
      expect(sent('RestoreDBClusterToPointInTimeCommand')).toHaveLength(0);
    });

    it('names the read that failed on each path', async () => {
      arm({ snapshotError: awsError('InternalFailure', 'boom') });
      await expect(create({ SnapshotIdentifier: SNAPSHOT })).rejects.toThrow(
        /reading the restore snapshot failed/
      );
      await expect(
        create({
          SourceDbClusterResourceId: 'cluster-SOURCEID123',
          UseLatestRestorableTime: true,
          SnapshotIdentifier: SNAPSHOT,
        })
      ).rejects.toThrow(/reading the declared SnapshotIdentifier failed/);
    });
  });
});
