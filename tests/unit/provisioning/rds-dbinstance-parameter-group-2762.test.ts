// go-to-k/cdkd#2762: the AWS::RDS::DBInstance DBParameterGroupName. It rides
// CreateDBInstance and, when changed, ModifyDBInstance, as CloudFormation's
// handler sends it (`Translator.modifyDbInstanceRequest`: `diff(previous,
// desired)`), and an update that leaves the group `pending-reboot` reboots the
// instance and waits for it to come back `in-sync`, as the handler's
// `UpdateHandler.shouldReboot` / `rebootAwait` do.
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

const TYPE = 'AWS::RDS::DBInstance';

/** A DBInstance read listing one parameter group in `status`. */
function read(group: string, status: string, instanceStatus = 'available'): Input {
  return {
    DBInstanceStatus: instanceStatus,
    DBParameterGroups: [{ DBParameterGroupName: group, ParameterApplyStatus: status }],
  };
}

/**
 * Each DescribeDBInstances answers the next of `reads` (the last one repeats),
 * CreateDBInstance the instance, every other call `{}`.
 */
function arm(reads: Input[]): void {
  let next = 0;
  mockSend.mockImplementation((command: { constructor: { name: string } }) => {
    if (command.constructor.name === 'DescribeDBInstancesCommand') {
      const live = reads[Math.min(next, reads.length - 1)]!;
      next += 1;
      return Promise.resolve({
        DBInstances: [
          {
            DBInstanceIdentifier: 'db-1',
            DBInstanceArn: 'arn:aws:rds:us-east-1:123456789012:db:db-1',
            DBInstanceStatus: 'available',
            ...live,
          },
        ],
      });
    }
    if (command.constructor.name === 'CreateDBInstanceCommand') {
      return Promise.resolve({ DBInstance: { DBInstanceIdentifier: 'db-1' } });
    }
    return Promise.resolve({});
  });
}

function sent(name: string): Input[] {
  return mockSend.mock.calls
    .map(([command]) => command as { constructor: { name: string }; input: Input })
    .filter((command) => command.constructor.name === name)
    .map((command) => command.input);
}

/** The command names sent, in order. */
function order(): string[] {
  return mockSend.mock.calls.map(
    ([command]) => (command as { constructor: { name: string } }).constructor.name
  );
}

const BASE: Input = {
  DBInstanceIdentifier: 'db-1',
  DBInstanceClass: 'db.t4g.micro',
  Engine: 'postgres',
  EngineVersion: '17.6',
  MasterUsername: 'admin',
  AllocatedStorage: '20',
};

describe('RDSProvider DBInstance DBParameterGroupName (go-to-k/cdkd#2762)', () => {
  let provider: RDSProvider;
  let sleeps: number;

  beforeEach(() => {
    mockSend.mockReset();
    delete process.env['CDKD_NO_WAIT'];
    provider = new RDSProvider();
    sleeps = 0;
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {
      sleeps += 1;
    };
  });

  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
  });

  const update = (next: Input, prev: Input, context?: Record<string, unknown>) =>
    provider.update('Db', 'db-1', TYPE, next, prev, context);
  const modify = (): Input => {
    const calls = sent('ModifyDBInstanceCommand');
    expect(calls).toHaveLength(1);
    return calls[0]!;
  };

  it('is a handled property, so a template declaring it keeps the SDK route', () => {
    expect(provider.handledProperties.get(TYPE)?.has('DBParameterGroupName')).toBe(true);
  });

  describe('create', () => {
    it('sends the declared group and reboots nothing', async () => {
      arm([read('pg-a', 'in-sync')]);
      await provider.create('Db', TYPE, { ...BASE, DBParameterGroupName: 'pg-a' });
      expect(sent('CreateDBInstanceCommand')[0]!['DBParameterGroupName']).toBe('pg-a');
      expect(sent('RebootDBInstanceCommand')).toHaveLength(0);
    });

    it('an undeclared group is not sent', async () => {
      arm([read('default.postgres17', 'in-sync')]);
      await provider.create('Db', TYPE, { ...BASE });
      expect(sent('CreateDBInstanceCommand')[0]).not.toHaveProperty('DBParameterGroupName');
    });
  });

  describe('update', () => {
    it('a changed group is sent, waited out of `applying`, rebooted, and waited back to `in-sync`', async () => {
      arm([
        read('pg-a', 'in-sync'), // the post-modify read: RDS has not started yet
        read('pg-a', 'in-sync'), // settle: still the old group listed
        read('pg-b', 'applying', 'modifying'),
        read('pg-b', 'pending-reboot'), // settled: reboot
        read('pg-b', 'pending-reboot', 'rebooting'),
        read('pg-b', 'in-sync'),
      ]);
      await update(
        { ...BASE, DBParameterGroupName: 'pg-b' },
        { ...BASE, DBParameterGroupName: 'pg-a' }
      );
      expect(modify()['DBParameterGroupName']).toBe('pg-b');
      expect(sent('RebootDBInstanceCommand')).toEqual([{ DBInstanceIdentifier: 'db-1' }]);
      const names = order();
      expect(names.indexOf('ModifyDBInstanceCommand')).toBeLessThan(
        names.indexOf('RebootDBInstanceCommand')
      );
      // Every scripted read was taken: the reboot waited for `in-sync`.
      expect(sent('DescribeDBInstancesCommand').length).toBeGreaterThanOrEqual(6);
      expect(sleeps).toBe(3);
    });

    it('the settle wait matches the sent group case-insensitively (RDS lower-cases it)', async () => {
      arm([
        read('pg-mixed', 'pending-reboot'),
        read('pg-mixed', 'pending-reboot'),
        read('pg-mixed', 'in-sync'),
      ]);
      await update(
        { ...BASE, DBParameterGroupName: 'PG-Mixed' },
        { ...BASE, DBParameterGroupName: 'pg-a' }
      );
      expect(modify()['DBParameterGroupName']).toBe('PG-Mixed');
      expect(sent('RebootDBInstanceCommand')).toHaveLength(1);
    });

    it('a changed group that applies without a reboot is not rebooted', async () => {
      arm([read('pg-b', 'in-sync')]);
      await update(
        { ...BASE, DBParameterGroupName: 'pg-b' },
        { ...BASE, DBParameterGroupName: 'pg-a' }
      );
      expect(modify()['DBParameterGroupName']).toBe('pg-b');
      expect(sent('RebootDBInstanceCommand')).toHaveLength(0);
    });

    it('an unchanged group is not re-sent, and an in-sync instance is neither waited on nor rebooted', async () => {
      arm([read('pg-a', 'in-sync')]);
      await update(
        { ...BASE, DBParameterGroupName: 'pg-a', BackupRetentionPeriod: 7 },
        { ...BASE, DBParameterGroupName: 'pg-a', BackupRetentionPeriod: 3 }
      );
      expect(modify()).not.toHaveProperty('DBParameterGroupName');
      expect(sent('RebootDBInstanceCommand')).toHaveLength(0);
      expect(sent('DescribeDBInstancesCommand')).toHaveLength(1);
      expect(sleeps).toBe(0);
    });

    it('an unchanged group already `pending-reboot` (a static parameter edited in it) is rebooted on any update, as the handler checks every update', async () => {
      arm([read('pg-a', 'pending-reboot'), read('pg-a', 'pending-reboot'), read('pg-a', 'in-sync')]);
      await update(
        { ...BASE, DBParameterGroupName: 'pg-a', BackupRetentionPeriod: 7 },
        { ...BASE, DBParameterGroupName: 'pg-a', BackupRetentionPeriod: 3 }
      );
      expect(modify()).not.toHaveProperty('DBParameterGroupName');
      expect(sent('RebootDBInstanceCommand')).toHaveLength(1);
    });

    it('a removed group sends nothing, so RDS keeps the live one, as CloudFormation does', async () => {
      arm([read('pg-a', 'in-sync')]);
      await update({ ...BASE }, { ...BASE, DBParameterGroupName: 'pg-a' });
      expect(modify()).not.toHaveProperty('DBParameterGroupName');
      expect(sent('RebootDBInstanceCommand')).toHaveLength(0);
    });

    it('an added group is sent', async () => {
      arm([read('pg-b', 'pending-reboot'), read('pg-b', 'pending-reboot'), read('pg-b', 'in-sync')]);
      await update({ ...BASE, DBParameterGroupName: 'pg-b' }, { ...BASE });
      expect(modify()['DBParameterGroupName']).toBe('pg-b');
      expect(sent('RebootDBInstanceCommand')).toHaveLength(1);
    });

    it('changedProperties decides for a recorded stand-in', async () => {
      arm([read('pg-a', 'in-sync')]);
      await update(
        { ...BASE, DBParameterGroupName: 'pg-a', BackupRetentionPeriod: 7 },
        {
          ...BASE,
          DBParameterGroupName: '{{resolve:ssm:/db/pg}}',
          BackupRetentionPeriod: 3,
        },
        { changedProperties: new Set(['BackupRetentionPeriod']) }
      );
      expect(modify()).not.toHaveProperty('DBParameterGroupName');
    });

    it('a rollback replay reverting the group alone sends it and reboots', async () => {
      arm([read('pg-a', 'pending-reboot'), read('pg-a', 'pending-reboot'), read('pg-a', 'in-sync')]);
      await update(
        { ...BASE, DBParameterGroupName: 'pg-a' },
        { ...BASE, DBParameterGroupName: 'pg-b' },
        { replayingState: true }
      );
      expect(modify()['DBParameterGroupName']).toBe('pg-a');
      expect(sent('RebootDBInstanceCommand')).toHaveLength(1);
    });

    it('a rollback replay reverting the group beside EngineVersion sends neither: the old family does not fit the version still running', async () => {
      arm([read('pg-18', 'in-sync')]);
      await update(
        { ...BASE, EngineVersion: '17.6', DBParameterGroupName: 'pg-17' },
        { ...BASE, EngineVersion: '18.1', DBParameterGroupName: 'pg-18' },
        { replayingState: true }
      );
      expect(modify()).not.toHaveProperty('DBParameterGroupName');
      expect(modify()).not.toHaveProperty('EngineVersion');
      expect(sent('RebootDBInstanceCommand')).toHaveLength(0);
    });

    it('a template-path update changing both sends both', async () => {
      arm([read('pg-18', 'pending-reboot'), read('pg-18', 'in-sync')]);
      await update(
        { ...BASE, EngineVersion: '18.1', DBParameterGroupName: 'pg-18' },
        { ...BASE, EngineVersion: '17.6', DBParameterGroupName: 'pg-17' }
      );
      expect(modify()).toMatchObject({ EngineVersion: '18.1', DBParameterGroupName: 'pg-18' });
    });

    it('under --no-wait the group is still settled and rebooted, but the reboot is not waited for', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      arm([
        read('pg-b', 'pending-reboot'),
        read('pg-b', 'pending-reboot'),
        read('pg-b', 'pending-reboot', 'rebooting'),
      ]);
      await update(
        { ...BASE, DBParameterGroupName: 'pg-b' },
        { ...BASE, DBParameterGroupName: 'pg-a' }
      );
      expect(sent('RebootDBInstanceCommand')).toHaveLength(1);
      // The post-modify read and the settle read; none after the reboot.
      expect(sent('DescribeDBInstancesCommand')).toHaveLength(2);
      expect(order().at(-1)).toBe('RebootDBInstanceCommand');
    });

    it('the reboot waits for every option group to be in-sync too', async () => {
      arm([
        read('pg-b', 'pending-reboot'),
        read('pg-b', 'pending-reboot'),
        {
          ...read('pg-b', 'in-sync'),
          OptionGroupMemberships: [{ OptionGroupName: 'og-a', Status: 'pending-apply' }],
        },
        {
          ...read('pg-b', 'in-sync'),
          OptionGroupMemberships: [{ OptionGroupName: 'og-a', Status: 'in-sync' }],
        },
      ]);
      await update(
        { ...BASE, DBParameterGroupName: 'pg-b' },
        { ...BASE, DBParameterGroupName: 'pg-a' }
      );
      expect(sent('DescribeDBInstancesCommand')).toHaveLength(4);
      expect(sleeps).toBe(1);
    });

    it('a terminal status during the wait fails the update at once', async () => {
      arm([read('pg-b', 'applying', 'incompatible-parameters')]);
      await expect(
        update({ ...BASE, DBParameterGroupName: 'pg-b' }, { ...BASE, DBParameterGroupName: 'pg-a' })
      ).rejects.toThrow(/entered status incompatible-parameters/);
      expect(sent('RebootDBInstanceCommand')).toHaveLength(0);
    });
  });

  describe('readCurrentState', () => {
    it('reads the first listed group back', async () => {
      arm([read('pg-a', 'in-sync')]);
      const state = await provider.readCurrentState('db-1', 'Db', TYPE);
      expect(state).toMatchObject({ DBParameterGroupName: 'pg-a' });
    });

    it('an instance listing no group reads none back', async () => {
      arm([{}]);
      const state = await provider.readCurrentState('db-1', 'Db', TYPE);
      expect(state).not.toHaveProperty('DBParameterGroupName');
    });
  });
});
