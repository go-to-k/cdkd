// go-to-k/cdkd#5640: `ProcessorFeatures` and `UseDefaultProcessorFeatures` on
// the SDK route for AWS::RDS::DBInstance, following CloudFormation's RDS
// handler (`Translator.createDbInstanceRequest`,
// `createDbInstanceReadReplicaRequest`, `modifyDbInstanceRequest` with
// `shouldSetProcessorFeatures`): the list rides CreateDBInstance, both ride a
// replica's create, and an update sends the desired values of both only when
// either changed, so a removed list leaves the live features as they are.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

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
import { findSdkUnwiredProperties } from '../../../src/provisioning/property-coverage.js';
import type { UpdateContext } from '../../../src/types/resource.js';

type Input = Record<string, unknown>;

const INSTANCE = 'AWS::RDS::DBInstance';
const ARN = 'arn:aws:rds:us-east-1:123456789012:db:db-1';
const SOURCE_ARN = 'arn:aws:rds:us-east-1:123456789012:db:source-1';

const FEATURES = [
  { Name: 'coreCount', Value: '2' },
  { Name: 'threadsPerCore', Value: '1' },
];

/** What a CDK `DatabaseInstance` on SQL Server Web with processor features emits. */
const BASE: Input = {
  DBInstanceIdentifier: 'db-1',
  DBInstanceClass: 'db.m7i.large',
  Engine: 'sqlserver-web',
  LicenseModel: 'license-included',
  AllocatedStorage: '20',
  MasterUsername: 'admin',
  MasterUserPassword: 'password-1',
};

interface Live {
  /** The instance's DescribeDBInstances fields, read after read. */
  reads?: Input[];
}

let reads: Input[] = [];

/**
 * DescribeDBInstances answers each queued read in turn (the last repeats);
 * a create or modify returns the instance.
 */
function arm(live: Live = {}): void {
  reads = live.reads ?? [{}];
  mockSend.mockImplementation((command: { constructor: { name: string }; input: Input }) => {
    switch (command.constructor.name) {
      case 'DescribeDBInstancesCommand': {
        const next = reads.length > 1 ? reads.shift()! : reads[0]!;
        if (command.input['DBInstanceIdentifier'] === SOURCE_ARN) {
          return Promise.resolve({
            DBInstances: [
              { DBInstanceIdentifier: 'source-1', Engine: 'sqlserver-web', DBInstanceStatus: 'available' },
            ],
          });
        }
        return Promise.resolve({
          DBInstances: [
            {
              DBInstanceIdentifier: 'db-1',
              DBInstanceArn: ARN,
              DBInstanceStatus: 'available',
              Engine: 'sqlserver-web',
              ...next,
            },
          ],
        });
      }
      case 'CreateDBInstanceCommand':
      case 'CreateDBInstanceReadReplicaCommand':
        return Promise.resolve({
          DBInstance: { DBInstanceIdentifier: 'db-1', Engine: 'sqlserver-web' },
        });
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

describe('RDS DBInstance processor features (go-to-k/cdkd#5640)', () => {
  let provider: RDSProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new RDSProvider();
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
    arm();
  });

  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
  });

  const update = (next: Input, prev: Input, context?: UpdateContext) =>
    provider.update('L', 'db-1', INSTANCE, { ...next }, { ...prev }, context);

  it('routes a template declaring both to the SDK provider', () => {
    expect(
      findSdkUnwiredProperties(INSTANCE, {
        ...BASE,
        ProcessorFeatures: FEATURES,
        UseDefaultProcessorFeatures: false,
      })
    ).toEqual([]);
  });

  describe('create', () => {
    it('sends the list on CreateDBInstance, a CFn number as a string, and never the flag', async () => {
      await provider.create('L', INSTANCE, {
        ...BASE,
        ProcessorFeatures: [
          { Name: 'coreCount', Value: 2 },
          { Name: 'threadsPerCore', Value: '1' },
        ],
        UseDefaultProcessorFeatures: false,
      });
      const [create] = sent('CreateDBInstanceCommand');
      expect(create?.['ProcessorFeatures']).toEqual(FEATURES);
      // Not a CreateDBInstance member: CloudFormation's create drops it too.
      expect(create).not.toHaveProperty('UseDefaultProcessorFeatures');
    });

    it('sends neither when the template declares neither', async () => {
      await provider.create('L', INSTANCE, { ...BASE });
      const [create] = sent('CreateDBInstanceCommand');
      expect(create).not.toHaveProperty('ProcessorFeatures');
      expect(create).not.toHaveProperty('UseDefaultProcessorFeatures');
    });

    it("sends both on a read replica's create, as CloudFormation's replica translation does", async () => {
      await provider.create('L', INSTANCE, {
        DBInstanceIdentifier: 'db-1',
        DBInstanceClass: 'db.m7i.large',
        SourceDBInstanceIdentifier: SOURCE_ARN,
        ProcessorFeatures: FEATURES,
        UseDefaultProcessorFeatures: false,
      });
      const [create] = sent('CreateDBInstanceReadReplicaCommand');
      expect(create?.['ProcessorFeatures']).toEqual(FEATURES);
      expect(create?.['UseDefaultProcessorFeatures']).toBe(false);
    });

    it('forwards an entry lacking a member as declared (neither is schema-required)', async () => {
      await provider.create('L', INSTANCE, { ...BASE, ProcessorFeatures: [{ Name: 'coreCount' }] });
      expect(sent('CreateDBInstanceCommand')[0]?.['ProcessorFeatures']).toEqual([
        { Name: 'coreCount' },
      ]);
    });

    it.each([
      ['a non-list', { ProcessorFeatures: { Name: 'coreCount', Value: '2' } }, /ProcessorFeatures must be a list/],
      ['a non-object entry', { ProcessorFeatures: ['coreCount=2'] }, /ProcessorFeatures must be a list/],
      ['an object member', { ProcessorFeatures: [{ Name: 'coreCount', Value: { n: 2 } }] }, /ProcessorFeatures must be a list/],
      ['a non-boolean flag', { UseDefaultProcessorFeatures: 'yes' }, /UseDefaultProcessorFeatures must be true or false/],
    ])('refuses %s before any call', async (_name, extra, says) => {
      await expect(provider.create('L', INSTANCE, { ...BASE, ...extra })).rejects.toThrow(says);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    const WITH = { ...BASE, ProcessorFeatures: FEATURES };
    const OTHER = [
      { Name: 'coreCount', Value: '1' },
      { Name: 'threadsPerCore', Value: '1' },
    ];

    it('sends the changed list and waits until the instance runs it', async () => {
      arm({
        reads: [
          // Right after the modify: still pending.
          { DBInstanceStatus: 'modifying', PendingModifiedValues: { ProcessorFeatures: OTHER } },
          { DBInstanceStatus: 'available', ProcessorFeatures: FEATURES },
          { DBInstanceStatus: 'available', ProcessorFeatures: OTHER },
        ],
      });
      await update({ ...BASE, ProcessorFeatures: OTHER }, WITH);
      const [modify] = sent('ModifyDBInstanceCommand');
      expect(modify?.['ProcessorFeatures']).toEqual(OTHER);
      expect(modify).not.toHaveProperty('UseDefaultProcessorFeatures');
      expect(modify?.['ApplyImmediately']).toBe(true);
      // Three wait reads, then the attribute read.
      expect(describes()).toBe(4);
    });

    it('does not wait under --no-wait', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      arm({ reads: [{ DBInstanceStatus: 'modifying' }] });
      await update({ ...BASE, ProcessorFeatures: OTHER }, WITH);
      expect(sent('ModifyDBInstanceCommand')[0]?.['ProcessorFeatures']).toEqual(OTHER);
      expect(describes()).toBe(1);
    });

    it('sends nothing for them when neither changed (a number and its string are the same)', async () => {
      await update(
        { ...WITH, UseDefaultProcessorFeatures: false, BackupRetentionPeriod: 7 },
        {
          ...BASE,
          ProcessorFeatures: [
            { Name: 'coreCount', Value: 2 },
            { Name: 'threadsPerCore', Value: 1 },
          ],
          UseDefaultProcessorFeatures: 'false',
          BackupRetentionPeriod: 1,
        }
      );
      const [modify] = sent('ModifyDBInstanceCommand');
      expect(modify?.['BackupRetentionPeriod']).toBe(7);
      expect(modify).not.toHaveProperty('ProcessorFeatures');
      expect(modify).not.toHaveProperty('UseDefaultProcessorFeatures');
    });

    it('a removed list sends neither, so the instance keeps its features, as under CloudFormation', async () => {
      await update({ ...BASE }, WITH);
      const [modify] = sent('ModifyDBInstanceCommand');
      expect(modify).not.toHaveProperty('ProcessorFeatures');
      expect(modify).not.toHaveProperty('UseDefaultProcessorFeatures');
    });

    it('UseDefaultProcessorFeatures: true in place of the list restores the class defaults', async () => {
      await update({ ...BASE, UseDefaultProcessorFeatures: true }, WITH);
      const [modify] = sent('ModifyDBInstanceCommand');
      expect(modify?.['UseDefaultProcessorFeatures']).toBe(true);
      expect(modify).not.toHaveProperty('ProcessorFeatures');
    });

    it('a changed flag alone sends the declared list beside it, as the handler sends both', async () => {
      arm({ reads: [{ ProcessorFeatures: FEATURES }] });
      await update({ ...WITH, UseDefaultProcessorFeatures: false }, WITH);
      const [modify] = sent('ModifyDBInstanceCommand');
      expect(modify?.['UseDefaultProcessorFeatures']).toBe(false);
      expect(modify?.['ProcessorFeatures']).toEqual(FEATURES);
    });

    it('a malformed recorded list counts as a change', async () => {
      arm({ reads: [{ ProcessorFeatures: FEATURES }] });
      await update(WITH, { ...BASE, ProcessorFeatures: 'coreCount=2' });
      expect(sent('ModifyDBInstanceCommand')[0]?.['ProcessorFeatures']).toEqual(FEATURES);
    });

    it.each([
      ['a template update', undefined],
      ['a rollback replay', { replayingState: true }],
    ] as const)('refuses a malformed desired list before any call on %s', async (_name, context) => {
      await expect(
        update({ ...BASE, ProcessorFeatures: [null] }, WITH, context as UpdateContext | undefined)
      ).rejects.toThrow(/ProcessorFeatures must be a list/);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('readCurrentState and drift', () => {
    it('reads the live features back, and never the write-only flag', async () => {
      arm({ reads: [{ ProcessorFeatures: FEATURES }] });
      const readback = await provider.readCurrentState('db-1', 'L', INSTANCE);
      expect(readback).toMatchObject({ ProcessorFeatures: FEATURES });
      expect(readback).not.toHaveProperty('UseDefaultProcessorFeatures');
    });

    it('reads a pending list as the one the instance will run', async () => {
      arm({
        reads: [
          { ProcessorFeatures: FEATURES, PendingModifiedValues: { ProcessorFeatures: [{ Name: 'coreCount', Value: '1' }] } },
        ],
      });
      // The pending feature replaces its live namesake; the other is kept.
      expect(await provider.readCurrentState('db-1', 'L', INSTANCE)).toMatchObject({
        ProcessorFeatures: [
          { Name: 'coreCount', Value: '1' },
          { Name: 'threadsPerCore', Value: '1' },
        ],
      });
    });

    it.each([
      ['an empty list', { ProcessorFeatures: [] }],
      ['no list', {}],
    ])('emits nothing for %s', async (_name, fields) => {
      arm({ reads: [fields] });
      expect(await provider.readCurrentState('db-1', 'L', INSTANCE)).not.toHaveProperty(
        'ProcessorFeatures'
      );
    });

    it('compares the live list only where the template declares it; the flag never', () => {
      expect(provider.getDriftUnknownPaths(INSTANCE, { ...BASE })).toEqual(
        expect.arrayContaining(['ProcessorFeatures', 'UseDefaultProcessorFeatures'])
      );
      const declared = provider.getDriftUnknownPaths(INSTANCE, {
        ...BASE,
        ProcessorFeatures: FEATURES,
      });
      expect(declared).toContain('UseDefaultProcessorFeatures');
      expect(declared).not.toContain('ProcessorFeatures');
    });
  });
});
