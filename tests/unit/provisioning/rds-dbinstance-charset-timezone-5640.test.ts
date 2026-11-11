// go-to-k/cdkd#5640: `CharacterSetName`, `NcharCharacterSetName` and
// `Timezone` on the SDK route for AWS::RDS::DBInstance. All three are
// create-only in the registry schema: they ride CreateDBInstance as declared,
// as CloudFormation's create translation sends them, never ModifyDBInstance
// (a change replaces the instance), and never CreateDBInstanceReadReplica,
// whose CloudFormation translation carries none of them either. The readback
// reports each one RDS lists, as CloudFormation's read handler does.
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

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
import { PROPERTY_COVERAGE_BY_TYPE } from '../../../src/provisioning/property-coverage.generated.js';

type Input = Record<string, unknown>;

const INSTANCE = 'AWS::RDS::DBInstance';
const KEYS = ['CharacterSetName', 'NcharCharacterSetName', 'Timezone'] as const;
const SOURCE_ARN = 'arn:aws:rds:us-east-1:123456789012:db:source-db';

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
      case 'CreateDBInstanceReadReplicaCommand':
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

const ORACLE: Input = {
  DBInstanceIdentifier: 'db-1',
  DBInstanceClass: 'db.t3.small',
  Engine: 'oracle-se2',
  LicenseModel: 'license-included',
  MasterUsername: 'admin',
  AllocatedStorage: '20',
  CharacterSetName: 'WE8ISO8859P1',
  NcharCharacterSetName: 'UTF8',
};

const SQL_SERVER: Input = {
  DBInstanceIdentifier: 'db-1',
  DBInstanceClass: 'db.t3.small',
  Engine: 'sqlserver-ex',
  LicenseModel: 'license-included',
  MasterUsername: 'admin',
  AllocatedStorage: '20',
  Timezone: 'Tokyo Standard Time',
};

describe('RDS DBInstance CharacterSetName, NcharCharacterSetName and Timezone (go-to-k/cdkd#5640)', () => {
  let provider: RDSProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new RDSProvider();
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
    arm();
  });

  describe('routing', () => {
    it('declares all three handled, so a template naming one keeps the SDK route', () => {
      for (const key of KEYS) expect(provider.handledProperties.get(INSTANCE)?.has(key)).toBe(true);
      const coverage = PROPERTY_COVERAGE_BY_TYPE.get(INSTANCE)!;
      for (const key of KEYS) {
        expect(coverage.handled.has(key), key).toBe(true);
        expect(coverage.sdkUnwired.has(key), key).toBe(false);
      }
    });
  });

  describe('create', () => {
    it('sends both character sets as declared', async () => {
      await provider.create('L', INSTANCE, { ...ORACLE });
      expect(sent('CreateDBInstanceCommand')[0]).toMatchObject({
        CharacterSetName: 'WE8ISO8859P1',
        NcharCharacterSetName: 'UTF8',
      });
      expect(sent('CreateDBInstanceCommand')[0]).not.toHaveProperty('Timezone');
    });

    it('sends the time zone as declared', async () => {
      await provider.create('L', INSTANCE, { ...SQL_SERVER });
      const input = sent('CreateDBInstanceCommand')[0]!;
      expect(input['Timezone']).toBe('Tokyo Standard Time');
      expect(input).not.toHaveProperty('CharacterSetName');
      expect(input).not.toHaveProperty('NcharCharacterSetName');
    });

    it('sends none when the template declares none', async () => {
      const bag = { ...ORACLE };
      for (const key of KEYS) delete bag[key];
      await provider.create('L', INSTANCE, bag);
      const input = sent('CreateDBInstanceCommand')[0]!;
      for (const key of KEYS) expect(input).not.toHaveProperty(key);
    });

    it('a read replica sends none of them: it inherits its source, as under CloudFormation', async () => {
      arm({ Engine: 'oracle-ee' });
      await provider.create('L', INSTANCE, {
        DBInstanceIdentifier: 'db-1',
        DBInstanceClass: 'db.t3.small',
        SourceDBInstanceIdentifier: SOURCE_ARN,
        // Fires the after-create ModifyDBInstance, so its input is checked too.
        EngineVersion: '19.0.0.0.ru-2024-01.rur-2024-01.r1',
        CharacterSetName: 'AL32UTF8',
        NcharCharacterSetName: 'AL16UTF16',
        Timezone: 'UTC',
      });
      expect(sent('CreateDBInstanceCommand')).toHaveLength(0);
      const input = sent('CreateDBInstanceReadReplicaCommand')[0]!;
      for (const key of KEYS) expect(input).not.toHaveProperty(key);
      const modify = sent('ModifyDBInstanceCommand');
      expect(modify).toHaveLength(1);
      for (const key of KEYS) expect(modify[0]).not.toHaveProperty(key);
    });
  });

  describe('update', () => {
    it('never sends them to ModifyDBInstance (create-only: a change replaces)', async () => {
      const prev = { ...ORACLE, Timezone: 'UTC', BackupRetentionPeriod: 1 };
      await provider.update(
        'L',
        'db-1',
        INSTANCE,
        { ...prev, BackupRetentionPeriod: 7 },
        { ...prev }
      );
      const modify = sent('ModifyDBInstanceCommand');
      expect(modify).toHaveLength(1);
      expect(modify[0]!['BackupRetentionPeriod']).toBe(7);
      for (const key of KEYS) expect(modify[0]).not.toHaveProperty(key);
    });
  });

  describe('readCurrentState', () => {
    it('reports each one RDS lists under its CFn name', async () => {
      arm({
        CharacterSetName: 'WE8ISO8859P1',
        NcharCharacterSetName: 'UTF8',
        Timezone: 'Tokyo Standard Time',
      });
      const state = (await provider.readCurrentState('db-1', 'L', INSTANCE)) as Input;
      expect(state).toMatchObject({
        CharacterSetName: 'WE8ISO8859P1',
        NcharCharacterSetName: 'UTF8',
        Timezone: 'Tokyo Standard Time',
      });
    });

    it('omits each one RDS does not list', async () => {
      arm({});
      const state = (await provider.readCurrentState('db-1', 'L', INSTANCE)) as Input;
      for (const key of KEYS) expect(state).not.toHaveProperty(key);
    });

    it('none of them is a path drift cannot compare', () => {
      const paths = provider.getDriftUnknownPaths(INSTANCE, { ...ORACLE, ...SQL_SERVER });
      for (const key of KEYS) expect(paths).not.toContain(key);
    });
  });
});
