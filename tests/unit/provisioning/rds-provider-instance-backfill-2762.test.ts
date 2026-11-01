// go-to-k/cdkd#2762: the AWS::RDS::DBInstance storage, backup, maintenance,
// option group, certificate and Performance Insights properties. Create sends
// what the template declares; update sends what changed, as CloudFormation's
// handler sends `diff(previous, desired)`.
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

/** Every DescribeDBInstances answers `live`, CreateDBInstance the instance, every other call `{}`. */
function armLive(live: Input): void {
  mockSend.mockImplementation((command: { constructor: { name: string } }) =>
    Promise.resolve(
      command.constructor.name === 'DescribeDBInstancesCommand'
        ? {
            DBInstances: [
              {
                DBInstanceIdentifier: 'db-1',
                DBInstanceArn: 'arn:aws:rds:us-east-1:123456789012:db:db-1',
                DBInstanceStatus: 'available',
                ...live,
              },
            ],
          }
        : command.constructor.name === 'CreateDBInstanceCommand'
          ? { DBInstance: { DBInstanceIdentifier: 'db-1' } }
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

const KMS = 'arn:aws:kms:us-east-1:123456789012:key/k1';
const KMS_2 = 'arn:aws:kms:us-east-1:123456789012:key/k2';

const BASE: Input = {
  DBInstanceIdentifier: 'db-1',
  DBInstanceClass: 'db.m6g.large',
  Engine: 'postgres',
  MasterUsername: 'admin',
  AllocatedStorage: '400',
};

const BACKFILL: Input = {
  BackupRetentionPeriod: 7,
  PreferredBackupWindow: '03:00-04:00',
  PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
  StorageType: 'gp3',
  Iops: 12000,
  StorageThroughput: 500,
  MaxAllocatedStorage: 1000,
  MultiAZ: true,
  AutoMinorVersionUpgrade: false,
  CopyTagsToSnapshot: true,
  EnablePerformanceInsights: true,
  PerformanceInsightsKMSKeyId: KMS,
  PerformanceInsightsRetentionPeriod: 7,
  OptionGroupName: 'og-1',
  CACertificateIdentifier: 'rds-ca-rsa2048-g1',
};

const BACKFILL_MEMBERS = Object.keys(BACKFILL);

describe('RDSProvider DBInstance backfill (go-to-k/cdkd#2762)', () => {
  let provider: RDSProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new RDSProvider();
  });

  const update = (next: Input, prev: Input) =>
    provider.update('Db', 'db-1', 'AWS::RDS::DBInstance', next, prev);
  const modify = (): Input => {
    const calls = sent('ModifyDBInstanceCommand');
    expect(calls).toHaveLength(1);
    return calls[0]!;
  };

  describe('create', () => {
    it('sends every member under its CFn name, numbers coerced', async () => {
      armLive({});
      await provider.create('Db', 'AWS::RDS::DBInstance', {
        ...BASE,
        ...BACKFILL,
        Iops: '12000',
        BackupRetentionPeriod: '7',
      });
      const [input] = sent('CreateDBInstanceCommand');
      expect(input).toMatchObject({ ...BACKFILL, Iops: 12000, BackupRetentionPeriod: 7 });
    });

    it('a string "true" enables Performance Insights with its key', async () => {
      armLive({});
      await provider.create('Db', 'AWS::RDS::DBInstance', {
        ...BASE,
        EnablePerformanceInsights: 'true',
        PerformanceInsightsKMSKeyId: KMS,
      });
      const [input] = sent('CreateDBInstanceCommand');
      expect(input).toMatchObject({ EnablePerformanceInsights: true, PerformanceInsightsKMSKeyId: KMS });
    });

    it('sends the Performance Insights key only with Performance Insights enabled, as CloudFormation does; the retention always', async () => {
      armLive({});
      await provider.create('Db', 'AWS::RDS::DBInstance', {
        ...BASE,
        EnablePerformanceInsights: false,
        PerformanceInsightsKMSKeyId: KMS,
        PerformanceInsightsRetentionPeriod: 7,
      });
      const [input] = sent('CreateDBInstanceCommand');
      expect(input).not.toHaveProperty('EnablePerformanceInsights');
      expect(input).not.toHaveProperty('PerformanceInsightsKMSKeyId');
      expect(input!['PerformanceInsightsRetentionPeriod']).toBe(7);
    });
  });

  describe('update', () => {
    it('an unchanged template sends none of the members, AllocatedStorage included', async () => {
      armLive({ AllocatedStorage: 400 });
      await update({ ...BASE, ...BACKFILL }, { ...BASE, ...BACKFILL });
      const input = modify();
      for (const key of [...BACKFILL_MEMBERS, 'AllocatedStorage']) {
        expect(input, key).not.toHaveProperty(key);
      }
    });

    it('a CFn number recorded as a string and declared as a number is unchanged', async () => {
      armLive({ AllocatedStorage: 400 });
      await update(
        { ...BASE, BackupRetentionPeriod: 7, AllocatedStorage: 400 },
        { ...BASE, BackupRetentionPeriod: '7' }
      );
      expect(modify()).not.toHaveProperty('BackupRetentionPeriod');
      expect(modify()).not.toHaveProperty('AllocatedStorage');
    });

    it.each([
      ['BackupRetentionPeriod', 14, 14],
      ['PreferredBackupWindow', '05:00-06:00', '05:00-06:00'],
      ['PreferredMaintenanceWindow', 'mon:01:00-mon:02:00', 'mon:01:00-mon:02:00'],
      ['MultiAZ', false, false],
      ['AutoMinorVersionUpgrade', true, true],
      ['CopyTagsToSnapshot', false, false],
      ['MaxAllocatedStorage', '2000', 2000],
      ['OptionGroupName', 'og-2', 'og-2'],
      ['CACertificateIdentifier', 'rds-ca-ecc384-g1', 'rds-ca-ecc384-g1'],
    ])('a changed %s is sent alone', async (key, value, wire) => {
      armLive({ AllocatedStorage: 400 });
      await update({ ...BASE, ...BACKFILL, [key]: value }, { ...BASE, ...BACKFILL });
      const input = modify();
      expect(input[key]).toEqual(wire);
      for (const other of BACKFILL_MEMBERS.filter((k) => k !== key)) {
        expect(input, other).not.toHaveProperty(other);
      }
    });

    it.each(BACKFILL_MEMBERS.filter((key) => key !== 'MaxAllocatedStorage'))(
      'a removed %s sends nothing, so RDS keeps the live value',
      async (key) => {
        armLive({ AllocatedStorage: 400 });
        const next = { ...BASE, ...BACKFILL };
        delete next[key];
        await update(next, { ...BASE, ...BACKFILL });
        const input = modify();
        for (const member of BACKFILL_MEMBERS) {
          expect(input, member).not.toHaveProperty(member);
        }
      }
    );

    it('a removed MaxAllocatedStorage turns autoscaling off: the maximum is set to the LIVE allocated storage', async () => {
      // The live storage has grown past the template's 400 under autoscaling.
      armLive({ AllocatedStorage: 512 });
      const next = { ...BASE, ...BACKFILL };
      delete next['MaxAllocatedStorage'];
      await update(next, { ...BASE, ...BACKFILL });
      expect(modify()['MaxAllocatedStorage']).toBe(512);
      expect(modify()).not.toHaveProperty('AllocatedStorage');
    });

    it('a removed MaxAllocatedStorage with no readable allocated storage fails the update before ModifyDBInstance', async () => {
      armLive({});
      const next = { ...BASE, ...BACKFILL };
      delete next['MaxAllocatedStorage'];
      await expect(update(next, { ...BASE, ...BACKFILL })).rejects.toThrow(
        /MaxAllocatedStorage was removed/
      );
      expect(sent('ModifyDBInstanceCommand')).toHaveLength(0);
    });

    it.each([
      ['Iops', 16000],
      ['StorageThroughput', 1000],
    ])(
      'on gp3 a changed %s also sends Iops and the larger of the live and declared AllocatedStorage',
      async (key, value) => {
        armLive({ AllocatedStorage: 512 });
        await update({ ...BASE, ...BACKFILL, [key]: value }, { ...BASE, ...BACKFILL });
        const input = modify();
        expect(input[key]).toBe(value);
        expect(input['Iops']).toBe(key === 'Iops' ? value : 12000);
        expect(input['AllocatedStorage']).toBe(512);
      }
    );

    it('on gp3 a changed AllocatedStorage is sent as declared, with the declared Iops', async () => {
      armLive({ AllocatedStorage: 400 });
      await update(
        { ...BASE, ...BACKFILL, AllocatedStorage: '600' },
        { ...BASE, ...BACKFILL }
      );
      expect(modify()).toMatchObject({ AllocatedStorage: 600, Iops: 12000 });
    });

    it('a changed StorageType onto io1 sends the type, Iops and the larger AllocatedStorage', async () => {
      armLive({ AllocatedStorage: 300 });
      await update(
        { ...BASE, StorageType: 'io1', Iops: 3000 },
        { ...BASE, StorageType: 'gp2' }
      );
      expect(modify()).toMatchObject({ StorageType: 'io1', Iops: 3000, AllocatedStorage: 400 });
    });

    it('Iops declared with no StorageType is io1: a changed Iops sends the larger AllocatedStorage too', async () => {
      armLive({ AllocatedStorage: 450 });
      await update({ ...BASE, Iops: 3000 }, { ...BASE, Iops: 2000 });
      expect(modify()).toMatchObject({ Iops: 3000, AllocatedStorage: 450 });
    });

    it.each([
      ['no declared size', undefined],
      ['a declared stand-in', '***'],
    ])(
      'with no live size and %s, a changed Iops sends no AllocatedStorage',
      async (_label, allocated) => {
        armLive({});
        const next: Input = { ...BASE, StorageType: 'io1', Iops: 3000 };
        const prev: Input = { ...BASE, StorageType: 'io1', Iops: 2000 };
        if (allocated === undefined) {
          delete next['AllocatedStorage'];
          delete prev['AllocatedStorage'];
        } else {
          next['AllocatedStorage'] = allocated;
          prev['AllocatedStorage'] = allocated;
        }
        await update(next, prev);
        expect(modify()['Iops']).toBe(3000);
        expect(modify()).not.toHaveProperty('AllocatedStorage');
      }
    );

    it('off provisioned-IOPS storage a changed Iops goes alone and nothing is read', async () => {
      armLive({ AllocatedStorage: 400 });
      await update(
        { ...BASE, StorageType: 'gp2', Iops: 3000 },
        { ...BASE, StorageType: 'gp2', Iops: 1000 }
      );
      // gp2 is not provisioned-IOPS storage; RDS would refuse it, as it would
      // under CloudFormation, which sends the same.
      expect(modify()['Iops']).toBe(3000);
      expect(modify()).not.toHaveProperty('AllocatedStorage');
      // One describe only: the post-update attribute read.
      expect(sent('DescribeDBInstancesCommand')).toHaveLength(1);
    });

    it('a value the record holds as its dynamic reference is unchanged when changedProperties says so', async () => {
      armLive({ AllocatedStorage: 512 });
      await provider.update(
        'Db',
        'db-1',
        'AWS::RDS::DBInstance',
        { ...BASE, ...BACKFILL, AllocatedStorage: '400' },
        { ...BASE, ...BACKFILL, AllocatedStorage: '{{resolve:ssm:/db/size}}' },
        { changedProperties: new Set(['BackupRetentionPeriod']) }
      );
      expect(modify()).not.toHaveProperty('AllocatedStorage');
      expect(modify()).not.toHaveProperty('Iops');
      // The set wins over the value compare: a key it names is sent even
      // though the recorded value equals the desired one.
      expect(modify()['BackupRetentionPeriod']).toBe(7);
    });

    it('a forced update naming every key (reput) re-sends no unchanged storage member, and the rest as named', async () => {
      armLive({ AllocatedStorage: 512 });
      const bag = { ...BASE, ...BACKFILL };
      await provider.update('Db', 'db-1', 'AWS::RDS::DBInstance', bag, { ...bag }, {
        changedProperties: new Set(Object.keys(bag)),
      });
      for (const key of ['AllocatedStorage', 'Iops', 'StorageType', 'StorageThroughput']) {
        expect(modify(), key).not.toHaveProperty(key);
      }
      expect(modify()).toMatchObject({ OptionGroupName: 'og-1', BackupRetentionPeriod: 7 });
    });

    it('a storage member whose desired value is the recorded stand-in itself is never sent, even when changedProperties names it', async () => {
      armLive({ AllocatedStorage: 512 });
      const bag = { ...BASE, ...BACKFILL, AllocatedStorage: '***' };
      await provider.update('Db', 'db-1', 'AWS::RDS::DBInstance', bag, { ...bag }, {
        changedProperties: new Set(['AllocatedStorage', 'BackupRetentionPeriod']),
      });
      expect(modify()).not.toHaveProperty('AllocatedStorage');
      expect(modify()['BackupRetentionPeriod']).toBe(7);
    });

    it.each([['{{resolve:ssm:/db/window}}'], ['***']])(
      'without changedProperties a recorded stand-in %s counts as changed',
      async (recorded) => {
        armLive({});
        await update(
          { ...BASE, PreferredBackupWindow: '03:00-04:00' },
          { ...BASE, PreferredBackupWindow: recorded }
        );
        expect(modify()['PreferredBackupWindow']).toBe('03:00-04:00');
      }
    );

    it('a removed MaxAllocatedStorage beside a raised AllocatedStorage sets the maximum to the new size', async () => {
      armLive({ AllocatedStorage: 400 });
      const next: Input = { ...BASE, ...BACKFILL, AllocatedStorage: '600' };
      delete next['MaxAllocatedStorage'];
      await update(next, { ...BASE, ...BACKFILL });
      expect(modify()).toMatchObject({ MaxAllocatedStorage: 600, AllocatedStorage: 600 });
    });

    describe('a rollback replay never shrinks the storage (the handler rollback arm)', () => {
      const rollback = (next: Input, prev: Input) =>
        provider.update('Db', 'db-1', 'AWS::RDS::DBInstance', next, prev, {
          replayingState: true,
        });

      it('off provisioned-IOPS storage it sends neither AllocatedStorage nor Iops', async () => {
        armLive({ AllocatedStorage: 500 });
        await rollback(
          { ...BASE, StorageType: 'gp2', Iops: 1000 },
          { ...BASE, StorageType: 'gp2', Iops: 2000, AllocatedStorage: '500' }
        );
        expect(modify()).not.toHaveProperty('AllocatedStorage');
        expect(modify()).not.toHaveProperty('Iops');
      });

      it('on gp3 it sends the largest of the live, previous and declared size with the declared Iops', async () => {
        armLive({ AllocatedStorage: 450 });
        await rollback(
          { ...BASE, ...BACKFILL },
          { ...BASE, ...BACKFILL, AllocatedStorage: '500', Iops: 14000 }
        );
        expect(modify()).toMatchObject({ AllocatedStorage: 500, Iops: 12000 });
      });
    });

    describe('Performance Insights coupling (CloudFormation handler parity)', () => {
      const PI = {
        EnablePerformanceInsights: true,
        PerformanceInsightsKMSKeyId: KMS,
        PerformanceInsightsRetentionPeriod: 7,
      };
      const pi = (input: Input) => ({
        enable: input['EnablePerformanceInsights'],
        key: input['PerformanceInsightsKMSKeyId'],
        retention: input['PerformanceInsightsRetentionPeriod'],
      });

      it('turning it on sends the flag and the declared key', async () => {
        armLive({});
        await update({ ...BASE, ...PI }, { ...BASE, ...PI, EnablePerformanceInsights: false });
        expect(pi(modify())).toEqual({ enable: true, key: KMS, retention: undefined });
      });

      it('turning it off sends the flag alone', async () => {
        armLive({});
        await update({ ...BASE, ...PI, EnablePerformanceInsights: false }, { ...BASE, ...PI });
        expect(pi(modify())).toEqual({ enable: false, key: undefined, retention: undefined });
      });

      it('a changed key sends it with the declared flag', async () => {
        armLive({});
        await update({ ...BASE, ...PI, PerformanceInsightsKMSKeyId: KMS_2 }, { ...BASE, ...PI });
        expect(pi(modify())).toEqual({ enable: true, key: KMS_2, retention: undefined });
      });

      it('a changed retention sends it with the declared flag and key', async () => {
        armLive({});
        await update(
          { ...BASE, ...PI, PerformanceInsightsRetentionPeriod: 31 },
          { ...BASE, ...PI }
        );
        expect(pi(modify())).toEqual({ enable: true, key: KMS, retention: 31 });
      });
    });
  });

  describe('readCurrentState', () => {
    it.each([
      ['pending-apply', [{ OptionGroupName: 'og-old', Status: 'removing' }, { OptionGroupName: 'og-new', Status: 'pending-apply' }], 'og-new'],
      ['in-sync', [{ OptionGroupName: 'og-old', Status: 'pending-removal' }, { OptionGroupName: 'og-new', Status: 'in-sync' }], 'og-new'],
      ['no in-sync / pending-apply entry (first)', [{ OptionGroupName: 'og-a', Status: 'adding' }], 'og-a'],
    ])('reads the option group membership that is %s', async (_label, memberships, expected) => {
      armLive({ OptionGroupMemberships: memberships });
      const state = await provider.readCurrentState('db-1', 'Db', 'AWS::RDS::DBInstance');
      expect((state as Input)['OptionGroupName']).toBe(expected);
    });

    it('reads each member back under its CFn name', async () => {
      armLive({
        AllocatedStorage: 400,
        BackupRetentionPeriod: 7,
        PreferredBackupWindow: '03:00-04:00',
        PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
        StorageType: 'gp3',
        Iops: 12000,
        StorageThroughput: 500,
        MaxAllocatedStorage: 1000,
        MultiAZ: true,
        AutoMinorVersionUpgrade: false,
        CopyTagsToSnapshot: true,
        PerformanceInsightsEnabled: true,
        PerformanceInsightsKMSKeyId: KMS,
        PerformanceInsightsRetentionPeriod: 7,
        OptionGroupMemberships: [{ OptionGroupName: 'og-1', Status: 'in-sync' }],
        CACertificateIdentifier: 'rds-ca-rsa2048-g1',
      });
      const state = await provider.readCurrentState('db-1', 'Db', 'AWS::RDS::DBInstance');
      expect(state).toMatchObject(BACKFILL);
    });
  });
});
