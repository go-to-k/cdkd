// go-to-k/cdkd#5640: `AdditionalStorageVolumes` on the SDK route for
// AWS::RDS::DBInstance, wired to what CloudFormation's handler was MEASURED to
// send (CloudTrail A/B, SQL Server SE, us-east-1, 2026-11-11): the list rides
// CreateDBInstance; an update sends one ModifyDBInstance with only the changed
// and new volumes in full, and `{ VolumeName, SetForDelete: true }` for each
// one removed (every previous one when the property goes), then waits for the
// instance to settle.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend, warn } = vi.hoisted(() => ({ mockSend: vi.fn(), warn: vi.fn() }));

// A short resource deadline: a wait that never settles fails its test at once
// instead of spinning (the provider's sleep is stubbed below).
vi.mock('../../../src/deployment/resource-deadline.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  enclosingDeadlineRemainingMs: () => 300,
}));

vi.mock('@aws-sdk/client-rds', async () => {
  const actual = await vi.importActual('@aws-sdk/client-rds');
  return {
    ...actual,
    RDSClient: vi.fn().mockImplementation(() => ({
      send: (command: unknown) => mockSend(command),
      destroy: vi.fn(),
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
      warn,
      error: vi.fn(),
    }),
  };
});

import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import { findSdkUnwiredProperties } from '../../../src/provisioning/property-coverage.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';
import type { UpdateContext } from '../../../src/types/resource.js';

type Input = Record<string, unknown>;

const INSTANCE = 'AWS::RDS::DBInstance';
const ARN = 'arn:aws:rds:us-east-1:123456789012:db:db-1';
const SOURCE_ARN = 'arn:aws:rds:us-east-1:123456789012:db:source-1';

/** What the A/B template declared (CFn spells AllocatedStorage as a string). */
const vol = (name: string, size: string): Input => ({
  VolumeName: name,
  StorageType: 'gp3',
  AllocatedStorage: size,
});
/** The same volume on the wire. */
const wire = (name: string, size: number): Input => ({
  VolumeName: name,
  StorageType: 'gp3',
  AllocatedStorage: size,
});
/** A live volume as DescribeDBInstances lists it (defaults and status included). */
const live = (name: string, size: number): Input => ({
  VolumeName: name,
  StorageVolumeStatus: 'Not-in-use',
  AllocatedStorage: size,
  IOPS: 3000,
  StorageThroughput: 125,
  StorageType: 'gp3',
});

const BASE: Input = {
  DBInstanceIdentifier: 'db-1',
  DBInstanceClass: 'db.m6i.large',
  Engine: 'sqlserver-se',
  LicenseModel: 'license-included',
  AllocatedStorage: '20',
  MasterUsername: 'admin',
  MasterUserPassword: 'password-1',
};

interface Live {
  /** The instance's DescribeDBInstances fields, read after read. */
  reads?: Input[];
  /** The instance ModifyDBInstance returns, if any. */
  modified?: Input;
}

let reads: Input[] = [];

/** DescribeDBInstances answers each queued read in turn (the last repeats). */
function arm(state: Live = {}): void {
  reads = state.reads ?? [{}];
  mockSend.mockImplementation((command: { constructor: { name: string }; input: Input }) => {
    switch (command.constructor.name) {
      case 'DescribeDBInstancesCommand': {
        const next = reads.length > 1 ? reads.shift()! : reads[0]!;
        if (command.input['DBInstanceIdentifier'] === SOURCE_ARN) {
          return Promise.resolve({
            DBInstances: [
              {
                DBInstanceIdentifier: 'source-1',
                Engine: 'sqlserver-se',
                DBInstanceStatus: 'available',
              },
            ],
          });
        }
        return Promise.resolve({
          DBInstances: [
            {
              DBInstanceIdentifier: 'db-1',
              DBInstanceArn: ARN,
              DBInstanceStatus: 'available',
              Engine: 'sqlserver-se',
              ...next,
            },
          ],
        });
      }
      case 'CreateDBInstanceCommand':
      case 'CreateDBInstanceReadReplicaCommand':
        return Promise.resolve({
          DBInstance: { DBInstanceIdentifier: 'db-1', Engine: 'sqlserver-se' },
        });
      case 'ModifyDBInstanceCommand':
        return Promise.resolve(state.modified === undefined ? {} : { DBInstance: state.modified });
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

function describes(): number {
  return sent('DescribeDBInstancesCommand').length;
}

describe('RDS DBInstance AdditionalStorageVolumes (go-to-k/cdkd#5640)', () => {
  let provider: RDSProvider;

  beforeEach(() => {
    mockSend.mockReset();
    warn.mockReset();
    provider = new RDSProvider();
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
    arm();
  });

  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
  });

  const update = (next: Input, prev: Input, context?: UpdateContext) =>
    provider.update('L', 'db-1', INSTANCE, { ...next }, { ...prev }, context);

  it('routes a template declaring it to the SDK provider', () => {
    expect(
      findSdkUnwiredProperties(INSTANCE, {
        ...BASE,
        AdditionalStorageVolumes: [vol('rdsdbdata2', '20')],
      })
    ).toEqual([]);
  });

  describe('create', () => {
    it('sends the list on CreateDBInstance itself, sizes as numbers, Iops as IOPS, and no modify', async () => {
      await provider.create('L', INSTANCE, {
        ...BASE,
        AdditionalStorageVolumes: [
          vol('rdsdbdata2', '20'),
          {
            VolumeName: 'rdsdbdata3',
            StorageType: 'io2',
            AllocatedStorage: 100,
            Iops: '1000',
            MaxAllocatedStorage: 200,
          },
        ],
      });
      expect(sent('CreateDBInstanceCommand')[0]?.['AdditionalStorageVolumes']).toEqual([
        wire('rdsdbdata2', 20),
        {
          VolumeName: 'rdsdbdata3',
          StorageType: 'io2',
          AllocatedStorage: 100,
          IOPS: 1000,
          MaxAllocatedStorage: 200,
        },
      ]);
      expect(sent('ModifyDBInstanceCommand')).toEqual([]);
    });

    it('sends nothing when the template declares nothing', async () => {
      await provider.create('L', INSTANCE, { ...BASE });
      expect(sent('CreateDBInstanceCommand')[0]).not.toHaveProperty('AdditionalStorageVolumes');
    });

    it("sends the list on a read replica's create", async () => {
      await provider.create('L', INSTANCE, {
        DBInstanceIdentifier: 'db-1',
        DBInstanceClass: 'db.m6i.large',
        SourceDBInstanceIdentifier: SOURCE_ARN,
        AdditionalStorageVolumes: [vol('rdsdbdata2', '20')],
      });
      expect(sent('CreateDBInstanceReadReplicaCommand')[0]?.['AdditionalStorageVolumes']).toEqual(
        [wire('rdsdbdata2', 20)]
      );
    });

    it.each([
      ['a non-list', { VolumeName: 'rdsdbdata2' }],
      ['an entry without a VolumeName', [{ AllocatedStorage: '20' }]],
      ['an empty VolumeName', [{ VolumeName: '', AllocatedStorage: '20' }]],
      ['a repeated VolumeName', [vol('rdsdbdata2', '20'), vol('rdsdbdata2', '30')]],
      ['a non-numeric size', [vol('rdsdbdata2', '20GiB')]],
      ['a fractional size', [{ VolumeName: 'rdsdbdata2', AllocatedStorage: 20.5 }]],
      ['a non-string StorageType', [{ VolumeName: 'rdsdbdata2', StorageType: 3 }]],
      ['a null entry', [null]],
    ])('refuses %s before any call, on a rollback replay create too', async (_name, value) => {
      for (const context of [undefined, { replayingState: true }]) {
        await expect(
          provider.create('L', INSTANCE, { ...BASE, AdditionalStorageVolumes: value }, context)
        ).rejects.toThrow(/AdditionalStorageVolumes must be a list/);
      }
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    const TWO = { ...BASE, AdditionalStorageVolumes: [vol('rdsdbdata2', '20'), vol('rdsdbdata3', '20')] };

    it('sends only the grown and the new volume, applied immediately, and waits until both read back', async () => {
      arm({
        reads: [
          { DBInstanceStatus: 'modifying', AdditionalStorageVolumes: [live('rdsdbdata3', 20)] },
          // Every volume already listed at its sent size, but a change still pending.
          {
            DBInstanceStatus: 'available',
            AdditionalStorageVolumes: [
              live('rdsdbdata3', 20),
              live('rdsdbdata4', 20),
              live('rdsdbdata2', 25),
            ],
            PendingModifiedValues: { AdditionalStorageVolumes: [wire('rdsdbdata2', 25)] },
          },
          // Settled, but the new volume is not listed yet.
          {
            DBInstanceStatus: 'available',
            AdditionalStorageVolumes: [live('rdsdbdata3', 20), live('rdsdbdata2', 25)],
          },
          {
            DBInstanceStatus: 'available',
            AdditionalStorageVolumes: [
              live('rdsdbdata3', 20),
              live('rdsdbdata4', 20),
              live('rdsdbdata2', 25),
            ],
          },
        ],
      });
      await update(
        {
          ...BASE,
          AdditionalStorageVolumes: [
            vol('rdsdbdata2', '25'),
            vol('rdsdbdata3', '20'),
            vol('rdsdbdata4', '20'),
          ],
        },
        TWO
      );
      const modifies = sent('ModifyDBInstanceCommand');
      expect(modifies).toHaveLength(1);
      expect(modifies[0]?.['AdditionalStorageVolumes']).toEqual([
        wire('rdsdbdata2', 25),
        wire('rdsdbdata4', 20),
      ]);
      expect(modifies[0]?.['ApplyImmediately']).toBe(true);
      // The primary volume is unchanged, so it is not re-sent.
      expect(modifies[0]).not.toHaveProperty('AllocatedStorage');
      // Four wait reads, then the attribute read.
      expect(describes()).toBe(5);
    });

    it('sends a volume dropped from the list as set for delete, alone', async () => {
      arm({ reads: [{ AdditionalStorageVolumes: [live('rdsdbdata2', 20)] }], modified: { DBInstanceStatus: 'modifying' } });
      await update({ ...BASE, AdditionalStorageVolumes: [vol('rdsdbdata2', '20')] }, TWO);
      expect(sent('ModifyDBInstanceCommand')[0]?.['AdditionalStorageVolumes']).toEqual([
        { VolumeName: 'rdsdbdata3', SetForDelete: true },
      ]);
      // The answer showed the change under way: one wait read, then the attribute read.
      expect(describes()).toBe(2);
    });

    it.each([
      ['removed', undefined],
      ['emptied', []],
    ])('sends every previous volume as set for delete when the property is %s', async (_n, value) => {
      arm({ reads: [{ DBInstanceStatus: 'available' }] });
      await update({ ...BASE, AdditionalStorageVolumes: value }, TWO);
      expect(sent('ModifyDBInstanceCommand')[0]?.['AdditionalStorageVolumes']).toEqual([
        { VolumeName: 'rdsdbdata2', SetForDelete: true },
        { VolumeName: 'rdsdbdata3', SetForDelete: true },
      ]);
    });

    it('keeps waiting while a volume set for delete is still listed', async () => {
      arm({ reads: [{ AdditionalStorageVolumes: [live('rdsdbdata2', 20), live('rdsdbdata3', 20)] }] });
      await expect(
        update({ ...BASE, AdditionalStorageVolumes: [vol('rdsdbdata2', '20')] }, TWO)
      ).rejects.toThrow(/Timed out waiting for DBInstance L's additional storage volumes change/);
    });

    it('counts a volume autoscaling grew past the sent size as applied, never a smaller one', async () => {
      const grown = { ...BASE, AdditionalStorageVolumes: [vol('rdsdbdata2', '25'), vol('rdsdbdata3', '20')] };
      arm({
        reads: [{ AdditionalStorageVolumes: [live('rdsdbdata2', 30), live('rdsdbdata3', 20)] }],
        modified: { DBInstanceStatus: 'modifying' },
      });
      await update(grown, TWO);
      expect(describes()).toBe(2);
      mockSend.mockReset();
      arm({ reads: [{ AdditionalStorageVolumes: [live('rdsdbdata2', 20), live('rdsdbdata3', 20)] }] });
      await expect(update(grown, TWO)).rejects.toThrow(/Timed out waiting/);
    });

    it('a change no read shows under way settles after a run of quiet reads', async () => {
      arm({ reads: [{ AdditionalStorageVolumes: [live('rdsdbdata2', 25), live('rdsdbdata3', 20)] }] });
      await update(
        { ...BASE, AdditionalStorageVolumes: [vol('rdsdbdata2', '25'), vol('rdsdbdata3', '20')] },
        TWO
      );
      // Three quiet wait reads, then the attribute read.
      expect(describes()).toBe(4);
    });

    it('keeps waiting while a volume reads its old storage type', async () => {
      arm({
        reads: [{ AdditionalStorageVolumes: [live('rdsdbdata2', 20), live('rdsdbdata3', 20)] }],
        modified: { DBInstanceStatus: 'modifying' },
      });
      await expect(
        update(
          {
            ...BASE,
            AdditionalStorageVolumes: [
              { ...vol('rdsdbdata2', '20'), StorageType: 'io2', Iops: 1000 },
              vol('rdsdbdata3', '20'),
            ],
          },
          TWO
        )
      ).rejects.toThrow(/Timed out waiting for DBInstance L's additional storage volumes change/);
    });

    it('refuses a malformed desired list before the security group lookup, the first call an update can make', async () => {
      const lookup = vi.spyOn(provider, 'securityGroupsToSend');
      await expect(
        update({ ...BASE, AdditionalStorageVolumes: [{ AllocatedStorage: '20' }] }, TWO)
      ).rejects.toThrow(/AdditionalStorageVolumes must be a list/);
      expect(lookup).not.toHaveBeenCalled();
    });

    it.each([
      ['a template update', undefined],
      ['a drift revert', { desiredFromAwsReadback: true }],
    ] as const)('refuses a case-only volume rename before any call on %s', async (_n, context) => {
      await expect(
        update(
          { ...BASE, AdditionalStorageVolumes: [vol('RDSDBDATA2', '20'), vol('rdsdbdata3', '20')] },
          TWO,
          context as UpdateContext | undefined
        )
      ).rejects.toThrow(/renames volume rdsdbdata2 to RDSDBDATA2 by case only/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('a rollback replay meeting a case-only rename warns and sends no volume change', async () => {
      await update(
        {
          ...BASE,
          BackupRetentionPeriod: 7,
          AdditionalStorageVolumes: [vol('RDSDBDATA2', '20'), vol('rdsdbdata3', '20')],
        },
        { ...TWO, BackupRetentionPeriod: 1 },
        { replayingState: true }
      );
      const [modify] = sent('ModifyDBInstanceCommand');
      expect(modify?.['BackupRetentionPeriod']).toBe(7);
      expect(modify).not.toHaveProperty('AdditionalStorageVolumes');
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/rollback leaves AdditionalStorageVolumes as it is.*rdsdbdata2 to RDSDBDATA2/)
      );
    });

    it('a case variant ADDED beside the kept name is no rename: it goes out as a new volume', async () => {
      arm({
        reads: [
          {
            AdditionalStorageVolumes: [
              live('rdsdbdata2', 20),
              live('rdsdbdata3', 20),
              live('RDSDBDATA2', 20),
            ],
          },
        ],
      });
      await update(
        {
          ...BASE,
          AdditionalStorageVolumes: [
            vol('rdsdbdata2', '20'),
            vol('rdsdbdata3', '20'),
            vol('RDSDBDATA2', '20'),
          ],
        },
        TWO
      );
      // RDS decides whether it takes the name; cdkd deletes nothing.
      expect(sent('ModifyDBInstanceCommand')[0]?.['AdditionalStorageVolumes']).toEqual([
        wire('RDSDBDATA2', 20),
      ]);
    });

    it('a different name beside a removed one is no rename', async () => {
      arm({ reads: [{ AdditionalStorageVolumes: [live('rdsdbdata3', 20), live('rdsdbdata4', 20)] }] });
      await update(
        { ...BASE, AdditionalStorageVolumes: [vol('rdsdbdata3', '20'), vol('rdsdbdata4', '20')] },
        TWO
      );
      expect(sent('ModifyDBInstanceCommand')[0]?.['AdditionalStorageVolumes']).toEqual([
        wire('rdsdbdata4', 20),
        { VolumeName: 'rdsdbdata2', SetForDelete: true },
      ]);
    });

    it('reads the live volumes once for a malformed record and a same-size lift together', async () => {
      arm({
        reads: [{ AdditionalStorageVolumes: [live('rdsdbdata2', 40)] }],
        modified: { DBInstanceStatus: 'modifying' },
      });
      await update(
        { ...BASE, AdditionalStorageVolumes: [{ ...vol('rdsdbdata2', '40'), Iops: 4000 }] },
        { ...BASE, AdditionalStorageVolumes: 'rdsdbdata2' }
      );
      // One read before the send (shared), one settle read, one attribute read.
      expect(describes()).toBe(3);
    });

    it('waits out a storage type RDS answers in lower case as applied', async () => {
      arm({
        reads: [{ AdditionalStorageVolumes: [{ ...live('rdsdbdata2', 20), StorageType: 'io2' }, live('rdsdbdata3', 20)] }],
        modified: { DBInstanceStatus: 'modifying' },
      });
      await update(
        {
          ...BASE,
          AdditionalStorageVolumes: [
            { ...vol('rdsdbdata2', '20'), StorageType: 'IO2', Iops: 1000 },
            vol('rdsdbdata3', '20'),
          ],
        },
        TWO
      );
      // The same-size lift's read, one settle read, the attribute read.
      expect(describes()).toBe(3);
    });

    it('does not wait under --no-wait', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      arm({ reads: [{ DBInstanceStatus: 'modifying' }] });
      await update({ ...BASE, AdditionalStorageVolumes: [vol('rdsdbdata2', '20')] }, TWO);
      expect(sent('ModifyDBInstanceCommand')[0]?.['AdditionalStorageVolumes']).toHaveLength(1);
      expect(describes()).toBe(1);
    });

    it('sends nothing and waits for nothing when no volume changed (reordered, a size as a number)', async () => {
      await update(
        {
          ...BASE,
          BackupRetentionPeriod: 7,
          AdditionalStorageVolumes: [
            { VolumeName: 'rdsdbdata3', AllocatedStorage: 20, StorageType: 'gp3' },
            vol('rdsdbdata2', '20'),
          ],
        },
        TWO
      );
      const [modify] = sent('ModifyDBInstanceCommand');
      expect(modify?.['BackupRetentionPeriod']).toBe(7);
      expect(modify).not.toHaveProperty('AdditionalStorageVolumes');
      expect(describes()).toBe(1);
    });

    it('a member removed from an entry is no change: RDS keeps the live value', async () => {
      const prev = {
        ...BASE,
        AdditionalStorageVolumes: [{ ...vol('rdsdbdata2', '20'), Iops: 4000 }],
      };
      await update(
        { ...BASE, BackupRetentionPeriod: 7, AdditionalStorageVolumes: [vol('rdsdbdata2', '20')] },
        prev
      );
      expect(sent('ModifyDBInstanceCommand')[0]).not.toHaveProperty('AdditionalStorageVolumes');
    });

    it('a storage type spelled in another case is no change', async () => {
      await update(
        {
          ...BASE,
          BackupRetentionPeriod: 7,
          AdditionalStorageVolumes: [{ ...vol('rdsdbdata2', '20'), StorageType: 'GP3' }],
        },
        { ...BASE, AdditionalStorageVolumes: [vol('rdsdbdata2', '20')] }
      );
      expect(sent('ModifyDBInstanceCommand')[0]).not.toHaveProperty('AdditionalStorageVolumes');
    });

    it('a changed member of an autoscaled volume carries the live size, never a shrink', async () => {
      arm({
        reads: [
          // The pre-send read, then the settle read.
          { AdditionalStorageVolumes: [live('rdsdbdata2', 40)] },
          { AdditionalStorageVolumes: [{ ...live('rdsdbdata2', 40), IOPS: 4000 }] },
        ],
        modified: { DBInstanceStatus: 'modifying' },
      });
      await update(
        { ...BASE, AdditionalStorageVolumes: [{ ...vol('rdsdbdata2', '20'), Iops: 4000 }] },
        { ...BASE, AdditionalStorageVolumes: [vol('rdsdbdata2', '20')] }
      );
      expect(sent('ModifyDBInstanceCommand')[0]?.['AdditionalStorageVolumes']).toEqual([
        { ...wire('rdsdbdata2', 40), IOPS: 4000 },
      ]);
    });

    it('a changed size is sent as declared, even below the live size (RDS decides)', async () => {
      arm({
        reads: [{ AdditionalStorageVolumes: [live('rdsdbdata2', 40)] }],
        modified: { DBInstanceStatus: 'modifying' },
      });
      await update(
        { ...BASE, AdditionalStorageVolumes: [vol('rdsdbdata2', '30')] },
        { ...BASE, AdditionalStorageVolumes: [vol('rdsdbdata2', '20')] }
      );
      expect(sent('ModifyDBInstanceCommand')[0]?.['AdditionalStorageVolumes']).toEqual([
        wire('rdsdbdata2', 30),
      ]);
    });

    describe('rollback replay', () => {
      const GROWN = {
        ...BASE,
        AdditionalStorageVolumes: [vol('rdsdbdata2', '25'), vol('rdsdbdata4', '20')],
      };

      it('never undoes a grow; deletes the volume the failed update added; restores one it removed', async () => {
        const restored = {
          ...BASE,
          AdditionalStorageVolumes: [vol('rdsdbdata2', '20'), vol('rdsdbdata3', '20')],
        };
        arm({
          reads: [
            // Before the send: the failed update's volume exists.
            {
              AdditionalStorageVolumes: [live('rdsdbdata2', 25), live('rdsdbdata4', 20)],
            },
            {
              AdditionalStorageVolumes: [live('rdsdbdata2', 25), live('rdsdbdata3', 20)],
            },
          ],
          modified: { DBInstanceStatus: 'modifying' },
        });
        await update(restored, GROWN, { replayingState: true });
        expect(sent('ModifyDBInstanceCommand')[0]?.['AdditionalStorageVolumes']).toEqual([
          wire('rdsdbdata3', 20),
          { VolumeName: 'rdsdbdata4', SetForDelete: true },
        ]);
      });

      it('deletes no volume the live instance does not list (the failed update never created it)', async () => {
        arm({
          reads: [{ AdditionalStorageVolumes: [live('rdsdbdata2', 25)] }],
          modified: { DBInstanceStatus: 'modifying' },
        });
        await update(
          { ...BASE, AdditionalStorageVolumes: [vol('rdsdbdata2', '25')] },
          GROWN,
          { replayingState: true }
        );
        expect(sent('ModifyDBInstanceCommand')[0]).not.toHaveProperty('AdditionalStorageVolumes');
        expect(warn).toHaveBeenCalledWith(
          expect.stringMatching(/rollback sends no delete for additional storage volume rdsdbdata4/)
        );
      });

      it('a template update deletes a removed volume without reading the live list', async () => {
        arm({ reads: [{ AdditionalStorageVolumes: [live('rdsdbdata2', 25)] }] });
        await update({ ...BASE, AdditionalStorageVolumes: [vol('rdsdbdata2', '25')] }, GROWN);
        expect(sent('ModifyDBInstanceCommand')[0]?.['AdditionalStorageVolumes']).toEqual([
          { VolumeName: 'rdsdbdata4', SetForDelete: true },
        ]);
      });

      it('a changed member beside an undone grow carries the larger size', async () => {
        arm({
          reads: [{ AdditionalStorageVolumes: [{ ...live('rdsdbdata2', 25), IOPS: 3000 }] }],
          modified: { DBInstanceStatus: 'modifying' },
        });
        await update(
          { ...BASE, AdditionalStorageVolumes: [{ ...vol('rdsdbdata2', '20'), Iops: 3000 }] },
          { ...BASE, AdditionalStorageVolumes: [{ ...vol('rdsdbdata2', '25'), Iops: 4000 }] },
          { replayingState: true }
        );
        expect(sent('ModifyDBInstanceCommand')[0]?.['AdditionalStorageVolumes']).toEqual([
          { ...wire('rdsdbdata2', 25), IOPS: 3000 },
        ]);
      });

      it('a size the previous entry did not declare carries the live one when larger', async () => {
        arm({
          reads: [{ AdditionalStorageVolumes: [live('rdsdbdata2', 40)] }],
          modified: { DBInstanceStatus: 'modifying' },
        });
        await update(
          { ...BASE, AdditionalStorageVolumes: [vol('rdsdbdata2', '20')] },
          { ...BASE, AdditionalStorageVolumes: [{ VolumeName: 'rdsdbdata2', StorageType: 'gp3' }] },
          { replayingState: true }
        );
        expect(sent('ModifyDBInstanceCommand')[0]?.['AdditionalStorageVolumes']).toEqual([
          wire('rdsdbdata2', 40),
        ]);
      });

      it('a template update shrinking the same way sends the declared size', async () => {
        arm({ reads: [{ AdditionalStorageVolumes: [live('rdsdbdata2', 20)] }] });
        await update(
          { ...BASE, AdditionalStorageVolumes: [vol('rdsdbdata2', '20')] },
          { ...BASE, AdditionalStorageVolumes: [vol('rdsdbdata2', '25')] }
        );
        expect(sent('ModifyDBInstanceCommand')[0]?.['AdditionalStorageVolumes']).toEqual([
          wire('rdsdbdata2', 20),
        ]);
      });
    });

    describe('drift --revert (previous side: the live readback)', () => {
      const READBACK = (volumes: Input[]): Input => ({
        ...BASE,
        AdditionalStorageVolumes: volumes.map((v) => ({
          VolumeName: v['VolumeName'],
          StorageType: v['StorageType'],
          AllocatedStorage: v['AllocatedStorage'],
          Iops: v['IOPS'],
          StorageThroughput: v['StorageThroughput'],
        })),
      });

      it('sends nothing for volumes whose readback defaults the baseline does not declare', async () => {
        await update(
          { ...BASE, BackupRetentionPeriod: 7, AdditionalStorageVolumes: [vol('rdsdbdata2', '20')] },
          { ...READBACK([live('rdsdbdata2', 20)]), BackupRetentionPeriod: 1 },
          { desiredFromAwsReadback: true }
        );
        expect(sent('ModifyDBInstanceCommand')[0]).not.toHaveProperty('AdditionalStorageVolumes');
      });

      it('leaves a volume added outside cdkd in place, with a warning, and reverts the rest', async () => {
        arm({
          reads: [{ AdditionalStorageVolumes: [live('rdsdbdata2', 25), live('rdsdbdata3', 20)] }],
          modified: { DBInstanceStatus: 'modifying' },
        });
        await update(
          { ...BASE, AdditionalStorageVolumes: [vol('rdsdbdata2', '25')] },
          READBACK([live('rdsdbdata2', 20), live('rdsdbdata3', 20)]),
          { desiredFromAwsReadback: true }
        );
        expect(sent('ModifyDBInstanceCommand')[0]?.['AdditionalStorageVolumes']).toEqual([
          wire('rdsdbdata2', 25),
        ]);
        expect(warn).toHaveBeenCalledWith(
          expect.stringMatching(/drift --revert leaves additional storage volume\(s\) rdsdbdata3 in place/)
        );
      });
    });

    it.each([
      ['a template update', undefined],
      ['a rollback replay', { replayingState: true }],
      ['a drift revert', { desiredFromAwsReadback: true }],
    ] as const)('refuses a malformed desired list before any call on %s', async (_name, context) => {
      await expect(
        update(
          { ...BASE, AdditionalStorageVolumes: [vol('rdsdbdata2', 'x')] },
          TWO,
          context as UpdateContext | undefined
        )
      ).rejects.toThrow(/AdditionalStorageVolumes must be a list/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('a malformed list the record holds unchanged sends nothing and fails nothing', async () => {
      const junk = { AdditionalStorageVolumes: 'rdsdbdata2' };
      await update(
        { ...BASE, ...junk, BackupRetentionPeriod: 7 },
        { ...BASE, ...junk, BackupRetentionPeriod: 1 },
        { replayingState: true }
      );
      const [modify] = sent('ModifyDBInstanceCommand');
      expect(modify?.['BackupRetentionPeriod']).toBe(7);
      expect(modify).not.toHaveProperty('AdditionalStorageVolumes');
    });

    it('a malformed recorded list is read from the live volumes, add-only: nothing is deleted', async () => {
      arm({
        reads: [
          {
            AdditionalStorageVolumes: [
              live('rdsdbdata2', 20),
              live('rdsdbdata3', 20),
              live('rdsdbdata4', 20),
            ],
          },
          // After the modify: rdsdbdata3 grown.
          {
            AdditionalStorageVolumes: [
              live('rdsdbdata2', 20),
              live('rdsdbdata3', 30),
              live('rdsdbdata4', 20),
            ],
          },
        ],
        modified: { DBInstanceStatus: 'modifying' },
      });
      await update(
        {
          ...BASE,
          AdditionalStorageVolumes: [
            { ...vol('rdsdbdata2', '20'), Iops: 3000, StorageThroughput: 125 },
            vol('rdsdbdata3', '30'),
          ],
        },
        { ...BASE, AdditionalStorageVolumes: 'rdsdbdata2' }
      );
      // rdsdbdata2 matches the live volume; rdsdbdata3 grew; rdsdbdata4 is kept.
      expect(sent('ModifyDBInstanceCommand')[0]?.['AdditionalStorageVolumes']).toEqual([
        wire('rdsdbdata3', 30),
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/rdsdbdata4 .*left in place/));
    });
  });

  describe('readCurrentState and drift', () => {
    it('reads the volumes back without their status members', async () => {
      arm({
        reads: [
          {
            AdditionalStorageVolumes: [
              {
                ...live('rdsdbdata2', 25),
                StorageOperationStatus: 'Optimizing',
                StorageOperationPercentProgress: 40,
                MaxAllocatedStorage: 100,
              },
            ],
          },
        ],
      });
      const readback = (await provider.readCurrentState('db-1', 'L', INSTANCE)) as Input;
      expect(readback['AdditionalStorageVolumes']).toEqual([
        {
          VolumeName: 'rdsdbdata2',
          StorageType: 'gp3',
          AllocatedStorage: 25,
          Iops: 3000,
          MaxAllocatedStorage: 100,
          StorageThroughput: 125,
        },
      ]);
    });

    it('reads nothing back for an instance without volumes', async () => {
      arm({ reads: [{ AdditionalStorageVolumes: [] }] });
      expect(await provider.readCurrentState('db-1', 'L', INSTANCE)).not.toHaveProperty(
        'AdditionalStorageVolumes'
      );
    });

    const drift = async (baseline: Input, aws: Input): Promise<number> => {
      const pair = await provider.canonicalizeDriftPair(
        INSTANCE,
        provider.canonicalizeDriftProperties(INSTANCE, baseline),
        provider.canonicalizeDriftProperties(INSTANCE, aws)
      );
      return calculateResourceDrift(pair.baseline, pair.aws, {
        ignorePaths: provider.getDriftUnknownPaths(INSTANCE, baseline),
        unorderedPaths: provider.getDriftUnorderedPaths(INSTANCE),
      }).length;
    };
    const readback = async (volumes: Input[]): Promise<Input> => {
      arm({ reads: [{ AdditionalStorageVolumes: volumes }] });
      return (await provider.readCurrentState('db-1', 'L', INSTANCE)) as Input;
    };

    it('compares a template baseline by VolumeName in any order, by the members it declares', async () => {
      const aws = await readback([live('rdsdbdata3', 20), live('rdsdbdata2', 25)]);
      const declared = [vol('rdsdbdata2', '25'), vol('rdsdbdata3', '20')];
      expect(await drift({ AdditionalStorageVolumes: declared }, aws)).toBe(0);
      expect(
        await drift({ AdditionalStorageVolumes: [vol('rdsdbdata2', '30'), vol('rdsdbdata3', '20')] }, aws)
      ).toBeGreaterThan(0);
      // A declared Iops differing from the live one drifts.
      expect(
        await drift(
          { AdditionalStorageVolumes: [{ ...vol('rdsdbdata2', '25'), Iops: 4000 }, vol('rdsdbdata3', '20')] },
          aws
        )
      ).toBeGreaterThan(0);
      // A volume added outside the template drifts.
      expect(await drift({ AdditionalStorageVolumes: [vol('rdsdbdata2', '25')] }, aws)).toBeGreaterThan(0);
      // ...and is compared whole, not narrowed to nothing.
      const pair = await provider.canonicalizeDriftPair(
        INSTANCE,
        { AdditionalStorageVolumes: [vol('rdsdbdata2', '25')] },
        aws
      );
      expect(pair.aws['AdditionalStorageVolumes']).toContainEqual({
        VolumeName: 'rdsdbdata3',
        StorageType: 'gp3',
        AllocatedStorage: 20,
        Iops: 3000,
        StorageThroughput: 125,
      });
    });

    it('compares an observed baseline (a readback) with a reordered readback as equal', async () => {
      const first = await readback([live('rdsdbdata2', 25), live('rdsdbdata3', 20)]);
      const second = await readback([live('rdsdbdata3', 20), live('rdsdbdata2', 25)]);
      expect(await drift(first, second)).toBe(0);
    });

    it('compares the list only where the bag declares a non-empty one, never with no bag', () => {
      expect(provider.getDriftUnknownPaths(INSTANCE, { ...BASE })).toContain(
        'AdditionalStorageVolumes'
      );
      expect(
        provider.getDriftUnknownPaths(INSTANCE, { ...BASE, AdditionalStorageVolumes: [] })
      ).toContain('AdditionalStorageVolumes');
      expect(provider.getDriftUnknownPaths(INSTANCE)).toContain('AdditionalStorageVolumes');
      expect(
        provider.getDriftUnknownPaths(INSTANCE, {
          ...BASE,
          AdditionalStorageVolumes: [vol('rdsdbdata2', '20')],
        })
      ).not.toContain('AdditionalStorageVolumes');
      expect(provider.getDriftUnorderedPaths(INSTANCE)).toContain('AdditionalStorageVolumes');
    });

    it('compares a storage type in any case', async () => {
      const aws = await readback([live('rdsdbdata2', 20)]);
      expect(
        await drift({ AdditionalStorageVolumes: [{ ...vol('rdsdbdata2', '20'), StorageType: 'GP3' }] }, aws)
      ).toBe(0);
      expect(
        await drift({ AdditionalStorageVolumes: [{ ...vol('rdsdbdata2', '20'), StorageType: 'io2' }] }, aws)
      ).toBeGreaterThan(0);
    });

    it('keeps a live entry that is not an object as it is', async () => {
      const aws = { AdditionalStorageVolumes: ['junk', null, live('rdsdbdata2', 20)] };
      const pair = await provider.canonicalizeDriftPair(
        INSTANCE,
        { AdditionalStorageVolumes: [vol('rdsdbdata2', '20')] },
        aws
      );
      expect((pair.aws['AdditionalStorageVolumes'] as unknown[])[0]).toBe('junk');
      expect((pair.aws['AdditionalStorageVolumes'] as unknown[])[1]).toBeNull();
      expect((pair.aws['AdditionalStorageVolumes'] as unknown[])[2]).toEqual(wire('rdsdbdata2', 20));
    });

    it('leaves the live list whole for a baseline it cannot read', async () => {
      const aws = { AdditionalStorageVolumes: [live('rdsdbdata2', 20)] };
      const broken = { AdditionalStorageVolumes: ['x'] };
      expect((await provider.canonicalizeDriftPair(INSTANCE, broken, aws)).aws).toBe(aws);
    });
  });
});
