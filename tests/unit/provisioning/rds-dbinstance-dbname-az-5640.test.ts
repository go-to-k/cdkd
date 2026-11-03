// go-to-k/cdkd#5640: `DBName` and `AvailabilityZone` on the SDK route for
// AWS::RDS::DBInstance. Both ride CreateDBInstance as declared, as
// CloudFormation's create sends them. `DBName` is create-only (the engine
// replaces). `AvailabilityZone` is not, but ModifyDBInstance has no such
// member, and CloudFormation's update handler refuses a changed zone ("Resource
// is immutable") unless the template drops it beside `MultiAZ: true`; cdkd
// refuses the same update before any call. The readback reports both, the zone
// only for a single-AZ instance.
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, warn } = vi.hoisted(() => ({ mockSend: vi.fn(), warn: vi.fn() }));

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
    warn,
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
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
import { UNNAMEABLE_ID_CLAUSE } from '../../../src/provisioning/replacement-protection-advice.js';
import type { UpdateContext } from '../../../src/types/resource.js';

type Input = Record<string, unknown>;

const INSTANCE = 'AWS::RDS::DBInstance';

/** Every DescribeDBInstances answers `live` over an available instance. */
function arm(live: Input = {}): void {
  mockSend.mockImplementation((command: { constructor: { name: string } }) => {
    switch (command.constructor.name) {
      case 'DescribeDBInstancesCommand':
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

const BASE: Input = {
  DBInstanceIdentifier: 'db-1',
  DBInstanceClass: 'db.t4g.micro',
  Engine: 'postgres',
  MasterUsername: 'admin',
  AllocatedStorage: '20',
};

describe('RDS DBInstance DBName and AvailabilityZone (go-to-k/cdkd#5640)', () => {
  let provider: RDSProvider;

  beforeEach(() => {
    mockSend.mockReset();
    warn.mockReset();
    provider = new RDSProvider();
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
    arm();
  });

  const update = (next: Input, prev: Input, context?: UpdateContext) =>
    provider.update('L', 'db-1', INSTANCE, { ...next }, { ...prev }, context);

  describe('create', () => {
    it('sends both as declared', async () => {
      await provider.create('L', INSTANCE, {
        ...BASE,
        DBName: 'appdb',
        AvailabilityZone: 'us-east-1b',
      });
      expect(sent('CreateDBInstanceCommand')[0]).toMatchObject({
        DBName: 'appdb',
        AvailabilityZone: 'us-east-1b',
      });
    });

    it('sends neither when the template declares neither', async () => {
      await provider.create('L', INSTANCE, { ...BASE });
      const input = sent('CreateDBInstanceCommand')[0]!;
      expect(input).not.toHaveProperty('DBName');
      expect(input).not.toHaveProperty('AvailabilityZone');
    });
  });

  describe('update: the zone', () => {
    it('an unchanged zone updates in place and sends no zone', async () => {
      const prev = { ...BASE, AvailabilityZone: 'us-east-1a', Port: '5432' };
      const result = await update({ ...prev, Port: '5433' }, prev);
      const modify = sent('ModifyDBInstanceCommand');
      expect(modify).toHaveLength(1);
      expect(modify[0]).not.toHaveProperty('AvailabilityZone');
      expect(result.effectiveProperties).toBeUndefined();
    });

    it.each([
      ['changed', { AvailabilityZone: 'us-east-1a' }, { AvailabilityZone: 'us-east-1b' }],
      ['added', {}, { AvailabilityZone: 'us-east-1b' }],
      ['removed on a single-AZ instance', { AvailabilityZone: 'us-east-1a' }, {}],
      [
        'removed beside MultiAZ: false',
        { AvailabilityZone: 'us-east-1a' },
        { MultiAZ: false },
      ],
      [
        'changed beside MultiAZ: true',
        { AvailabilityZone: 'us-east-1a' },
        { AvailabilityZone: 'us-east-1b', MultiAZ: true },
      ],
    ])('a zone %s is refused before any change', async (_name, prevZone, nextZone) => {
      // The live instance sits in neither declared zone.
      arm({ AvailabilityZone: 'us-east-1c' });
      const error = await update({ ...BASE, ...nextZone }, { ...BASE, ...prevZone }).catch(
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
      const message = (error as Error).message;
      expect(message).toContain('AvailabilityZone cannot change on an existing DB instance');
      // The no-data-loss remedy comes first, the destructive one after it.
      expect(message).toContain('To keep the instance where it is');
      expect(message).toContain('cdkd deploy --replace --force-stateful-recreation');
      expect(message.indexOf('To keep the instance')).toBeLessThan(message.indexOf('--replace'));
      expect(message).not.toContain('could not read');
      // At most a read of the live zone; nothing that changes the instance.
      const names = mockSend.mock.calls.map(
        ([command]) => (command as { constructor: { name: string } }).constructor.name
      );
      expect(names.every((name) => name === 'DescribeDBInstancesCommand')).toBe(true);
    });

    it('a zone the record lacks but the live instance already holds is no change', async () => {
      // Deployed while `--prefer-sdk-route` kept the zone out of the record.
      arm({ AvailabilityZone: 'us-east-1b' });
      const result = await update(
        { ...BASE, AvailabilityZone: 'us-east-1b', Port: '5433' },
        { ...BASE, Port: '5432' }
      );
      const modify = sent('ModifyDBInstanceCommand');
      expect(modify).toHaveLength(1);
      expect(modify[0]).not.toHaveProperty('AvailabilityZone');
      expect(result.effectiveProperties).toBeUndefined();
    });

    it('a rollback replay to a zone the live instance holds records it, without a warning', async () => {
      // The forward deploy dropped the zone beside MultiAZ: true; the instance stayed put.
      arm({ AvailabilityZone: 'us-east-1a' });
      const result = await update(
        { ...BASE, AvailabilityZone: 'us-east-1a', MultiAZ: false },
        { ...BASE, MultiAZ: true },
        { replayingState: true }
      );
      expect(result.effectiveProperties).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    });

    it('a rollback replay restoring a record with no zone records none, without a warning', async () => {
      // Forward: the record lacked the zone, the template added the live one
      // (accepted, recorded); a sibling failed, so the replay restores the
      // old record. CloudFormation reverts to the old model.
      const restored = { ...BASE, Port: '5432' };
      const result = await update(
        restored,
        { ...BASE, AvailabilityZone: 'us-east-1a', Port: '5433' },
        { replayingState: true }
      );
      expect(result.effectiveProperties).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
      expect(sent('ModifyDBInstanceCommand')[0]).not.toHaveProperty('AvailabilityZone');
    });

    it('a template update dropping the zone (no MultiAZ) is still refused', async () => {
      arm({ AvailabilityZone: 'us-east-1a' });
      await expect(
        update({ ...BASE }, { ...BASE, AvailabilityZone: 'us-east-1a' })
      ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    });

    it('an instance deleted outside cdkd is named as such, not as unreadable', async () => {
      mockSend.mockImplementation((command: { constructor: { name: string } }) =>
        command.constructor.name === 'DescribeDBInstancesCommand'
          ? Promise.reject(Object.assign(new Error('DBInstance db-1 not found.'), {
              name: 'DBInstanceNotFoundFault',
            }))
          : Promise.resolve({})
      );
      const error = (await update({ ...BASE, AvailabilityZone: 'us-east-1b' }, { ...BASE }).catch(
        (e: unknown) => e
      )) as Error;
      expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect(error.message).toContain('it was deleted outside cdkd');
      expect(error.message).not.toContain('a re-run may succeed');
    });

    it('the replace advice says the flags apply to the whole deploy', async () => {
      arm({ AvailabilityZone: 'us-east-1c' });
      const error = (await update(
        { ...BASE, AvailabilityZone: 'us-east-1b' },
        { ...BASE, AvailabilityZone: 'us-east-1a' }
      ).catch((e: unknown) => e)) as Error;
      expect(error.message).toContain('apply to the WHOLE deploy');
    });

    it('an unreadable instance keeps the refusal', async () => {
      mockSend.mockImplementation((command: { constructor: { name: string } }) =>
        command.constructor.name === 'DescribeDBInstancesCommand'
          ? Promise.reject(new Error('throttled'))
          : Promise.resolve({})
      );
      const error = (await update({ ...BASE, AvailabilityZone: 'us-east-1b' }, { ...BASE }).catch(
        (e: unknown) => e
      )) as Error;
      expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
      // Says the read failed, rather than implying the instance is elsewhere.
      expect(error.message).toContain("could not read the instance's live zone");
      expect(error.message).not.toContain('deleted outside cdkd');
      expect(sent('ModifyDBInstanceCommand')).toHaveLength(0);
    });

    it('a secret-derived instance name is masked in the refusal and its command withheld', async () => {
      const error = (await update(
        {
          ...BASE,
          DBInstanceIdentifier: 'rotated-secret-name',
          AvailabilityZone: 'us-east-1b',
          DeletionProtection: true,
        },
        {
          ...BASE,
          DBInstanceIdentifier: '{{resolve:secretsmanager:db-name}}',
          AvailabilityZone: 'us-east-1a',
          DeletionProtection: true,
        }
      ).catch((e: unknown) => e)) as Error;
      expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
      // `db-1` is the physical id: the pre-rotation name.
      expect(error.message).not.toMatch(/\bdb-1\b/);
      expect(error.message).not.toContain('--db-instance-identifier db-1');
      // Withheld, not pasted with a masked id.
      expect(error.message).toContain(UNNAMEABLE_ID_CLAUSE);
      expect(error.message).not.toContain('aws rds modify-db-instance');
    });

    it('a zone dropped beside MultiAZ: true updates in place, as CloudFormation allows', async () => {
      await update(
        { ...BASE, MultiAZ: true },
        { ...BASE, AvailabilityZone: 'us-east-1a' }
      );
      const modify = sent('ModifyDBInstanceCommand');
      expect(modify).toHaveLength(1);
      expect(modify[0]).toMatchObject({ MultiAZ: true });
      expect(modify[0]).not.toHaveProperty('AvailabilityZone');
    });

    it('MultiAZ declared as the string "true" counts as true', async () => {
      await expect(
        update({ ...BASE, MultiAZ: 'true' }, { ...BASE, AvailabilityZone: 'us-east-1a' })
      ).resolves.toMatchObject({ wasReplaced: false });
    });

    it('a protected instance is told how to lift DeletionProtection first', async () => {
      const error = (await update(
        { ...BASE, AvailabilityZone: 'us-east-1b', DeletionProtection: true },
        { ...BASE, AvailabilityZone: 'us-east-1a', DeletionProtection: true }
      ).catch((e: unknown) => e)) as Error;
      expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect(error.message).toContain('DeletionProtection: true');
      expect(error.message).toContain(
        'aws rds modify-db-instance --db-instance-identifier db-1 --no-deletion-protection --apply-immediately'
      );
    });

    it('an unprotected instance is not told to lift protection', async () => {
      const error = (await update(
        { ...BASE, AvailabilityZone: 'us-east-1b' },
        { ...BASE, AvailabilityZone: 'us-east-1a' }
      ).catch((e: unknown) => e)) as Error;
      expect(error.message).not.toContain('--no-deletion-protection');
    });

    it('a rollback replay warns, sends no zone and records the zone the instance kept', async () => {
      const prev = { ...BASE, AvailabilityZone: 'us-east-1a', Port: '5432' };
      const result = await update(
        { ...BASE, AvailabilityZone: 'us-east-1b', Port: '5433' },
        prev,
        { replayingState: true }
      );
      expect(sent('ModifyDBInstanceCommand')[0]).not.toHaveProperty('AvailabilityZone');
      expect(result.effectiveProperties).toEqual({
        ...BASE,
        AvailabilityZone: 'us-east-1a',
        Port: '5433',
      });
      expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
        'AvailabilityZone cannot change in place'
      );
    });

    it('a rollback replay over a record with no zone records none', async () => {
      const result = await update({ ...BASE, AvailabilityZone: 'us-east-1b' }, { ...BASE }, {
        replayingState: true,
      });
      expect(result.effectiveProperties).toEqual({ ...BASE });
      expect(result.effectiveProperties).not.toHaveProperty('AvailabilityZone');
    });

    it('a drift --revert bag is the live readback: no refusal, no warning, nothing recorded', async () => {
      const result = await update({ ...BASE, AvailabilityZone: 'us-east-1b' }, { ...BASE }, {
        desiredFromAwsReadback: true,
      });
      expect(result.effectiveProperties).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
      expect(sent('ModifyDBInstanceCommand')[0]).not.toHaveProperty('AvailabilityZone');
    });
  });

  describe('readCurrentState', () => {
    it('reports DBName and the zone of a single-AZ instance', async () => {
      arm({ DBName: 'appdb', AvailabilityZone: 'us-east-1a', MultiAZ: false });
      const state = (await provider.readCurrentState('db-1', 'L', INSTANCE)) as Input;
      expect(state['DBName']).toBe('appdb');
      expect(state['AvailabilityZone']).toBe('us-east-1a');
    });

    it('omits the zone of a Multi-AZ instance, which moves on failover', async () => {
      arm({ DBName: 'appdb', AvailabilityZone: 'us-east-1a', MultiAZ: true });
      const state = (await provider.readCurrentState('db-1', 'L', INSTANCE)) as Input;
      expect(state['DBName']).toBe('appdb');
      expect(state).not.toHaveProperty('AvailabilityZone');
    });

    it('omits both when RDS reports neither', async () => {
      arm({});
      const state = (await provider.readCurrentState('db-1', 'L', INSTANCE)) as Input;
      expect(state).not.toHaveProperty('DBName');
      expect(state).not.toHaveProperty('AvailabilityZone');
    });
  });
});
