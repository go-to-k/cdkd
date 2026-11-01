// go-to-k/cdkd#2762: the AWS::RDS::DBInstance network type, license model,
// promotion tier, Database Insights mode, dedicated log volume,
// AllowMajorVersionUpgrade and CertificateRotationRestart, and EngineVersion,
// which an update now sends only when it changed, never on a rollback replay.
// Each follows CloudFormation's handler (`Translator.modifyDbInstanceRequest`).
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

const BASE: Input = {
  DBInstanceIdentifier: 'db-1',
  DBInstanceClass: 'db.m6g.large',
  Engine: 'postgres',
  EngineVersion: '17.6',
  MasterUsername: 'admin',
  AllocatedStorage: '400',
};

/** The members CreateDBInstance and ModifyDBInstance both carry. */
const BOTH: Input = {
  NetworkType: 'DUAL',
  LicenseModel: 'postgresql-license',
  PromotionTier: 3,
  DatabaseInsightsMode: 'advanced',
  DedicatedLogVolume: true,
};
const BOTH_MEMBERS = Object.keys(BOTH);

/** ModifyDBInstance-only flags. */
const FLAGS: Input = { AllowMajorVersionUpgrade: true, CertificateRotationRestart: false };

describe('RDSProvider DBInstance EngineVersion and backfill (go-to-k/cdkd#2762)', () => {
  let provider: RDSProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new RDSProvider();
  });

  const update = (next: Input, prev: Input, context?: Record<string, unknown>) =>
    provider.update('Db', 'db-1', 'AWS::RDS::DBInstance', next, prev, context);
  const modify = (): Input => {
    const calls = sent('ModifyDBInstanceCommand');
    expect(calls).toHaveLength(1);
    return calls[0]!;
  };

  describe('create', () => {
    it('sends each member under its CFn name, the tier as a number', async () => {
      armLive({});
      await provider.create('Db', 'AWS::RDS::DBInstance', {
        ...BASE,
        ...BOTH,
        ...FLAGS,
        PromotionTier: '3',
      });
      const [input] = sent('CreateDBInstanceCommand');
      expect(input).toMatchObject(BOTH);
      // Not CreateDBInstance members; CloudFormation's create sends neither.
      expect(input).not.toHaveProperty('AllowMajorVersionUpgrade');
      expect(input).not.toHaveProperty('CertificateRotationRestart');
    });

    it('an undeclared member is not sent', async () => {
      armLive({});
      await provider.create('Db', 'AWS::RDS::DBInstance', { ...BASE });
      const [input] = sent('CreateDBInstanceCommand');
      for (const key of BOTH_MEMBERS) expect(input, key).not.toHaveProperty(key);
    });
  });

  describe('EngineVersion', () => {
    it('an unchanged EngineVersion is not re-sent, so a version AWS auto-upgraded since is not refused as a downgrade', async () => {
      armLive({ EngineVersion: '17.7' });
      await update({ ...BASE, BackupRetentionPeriod: 7 }, { ...BASE, BackupRetentionPeriod: 3 });
      expect(modify()).not.toHaveProperty('EngineVersion');
      expect(modify()).not.toHaveProperty('AllowMajorVersionUpgrade');
      expect(modify()['BackupRetentionPeriod']).toBe(7);
    });

    it('a changed EngineVersion is sent', async () => {
      armLive({});
      await update({ ...BASE, EngineVersion: '17.7' }, { ...BASE });
      expect(modify()['EngineVersion']).toBe('17.7');
    });

    it('a numeric EngineVersion recorded as a string is unchanged', async () => {
      armLive({});
      await update({ ...BASE, EngineVersion: 8 }, { ...BASE, EngineVersion: '8' });
      expect(modify()).not.toHaveProperty('EngineVersion');
    });

    it('a removed EngineVersion sends nothing, so RDS keeps the live version', async () => {
      armLive({});
      const next = { ...BASE };
      delete next['EngineVersion'];
      await update(next, { ...BASE });
      expect(modify()).not.toHaveProperty('EngineVersion');
    });

    it('a rollback replay sends no EngineVersion (RDS refuses a downgrade), nor the flag beside it', async () => {
      armLive({});
      await update(
        { ...BASE, EngineVersion: '16.4', AllowMajorVersionUpgrade: true },
        { ...BASE, EngineVersion: '17.6', AllowMajorVersionUpgrade: true },
        { replayingState: true }
      );
      expect(modify()).not.toHaveProperty('EngineVersion');
      expect(modify()).not.toHaveProperty('AllowMajorVersionUpgrade');
    });

    it('changedProperties decides for a recorded stand-in', async () => {
      armLive({});
      await update(
        { ...BASE, EngineVersion: '17.6', BackupRetentionPeriod: 7 },
        { ...BASE, EngineVersion: '{{resolve:ssm:/db/version}}', BackupRetentionPeriod: 3 },
        { changedProperties: new Set(['BackupRetentionPeriod']) }
      );
      expect(modify()).not.toHaveProperty('EngineVersion');
    });

    it('a declared AllowMajorVersionUpgrade rides a changed EngineVersion as declared', async () => {
      armLive({});
      await update(
        { ...BASE, EngineVersion: '18.1', AllowMajorVersionUpgrade: false },
        { ...BASE, AllowMajorVersionUpgrade: false }
      );
      expect(modify()).toMatchObject({ EngineVersion: '18.1', AllowMajorVersionUpgrade: false });
    });

    it('an undeclared AllowMajorVersionUpgrade is not inferred from a major version change', async () => {
      armLive({});
      await update({ ...BASE, EngineVersion: '18.1' }, { ...BASE });
      expect(modify()['EngineVersion']).toBe('18.1');
      expect(modify()).not.toHaveProperty('AllowMajorVersionUpgrade');
    });

    it('a changed AllowMajorVersionUpgrade is sent on its own', async () => {
      armLive({});
      await update({ ...BASE, AllowMajorVersionUpgrade: true }, { ...BASE });
      expect(modify()['AllowMajorVersionUpgrade']).toBe(true);
      expect(modify()).not.toHaveProperty('EngineVersion');
    });
  });

  describe('update', () => {
    it('an unchanged template sends none of the members', async () => {
      armLive({});
      await update({ ...BASE, ...BOTH, ...FLAGS }, { ...BASE, ...BOTH, ...FLAGS });
      for (const key of [...BOTH_MEMBERS, ...Object.keys(FLAGS)]) {
        expect(modify(), key).not.toHaveProperty(key);
      }
    });

    it.each([
      ['NetworkType', 'IPV4', 'IPV4'],
      ['LicenseModel', 'bring-your-own-license', 'bring-your-own-license'],
      ['PromotionTier', '5', 5],
      ['DatabaseInsightsMode', 'standard', 'standard'],
      ['DedicatedLogVolume', false, false],
    ])('a changed %s is sent alone', async (key, value, wire) => {
      armLive({});
      await update({ ...BASE, ...BOTH, [key]: value }, { ...BASE, ...BOTH });
      const input = modify();
      expect(input[key]).toEqual(wire);
      for (const other of BOTH_MEMBERS.filter((k) => k !== key)) {
        expect(input, other).not.toHaveProperty(other);
      }
    });

    it.each(BOTH_MEMBERS)('a removed %s sends nothing, so RDS keeps the live value', async (key) => {
      armLive({});
      const next = { ...BASE, ...BOTH };
      delete next[key];
      await update(next, { ...BASE, ...BOTH });
      for (const member of BOTH_MEMBERS) expect(modify(), member).not.toHaveProperty(member);
    });

    it('CertificateRotationRestart rides a changed CACertificateIdentifier', async () => {
      armLive({});
      await update(
        { ...BASE, CACertificateIdentifier: 'rds-ca-ecc384-g1', CertificateRotationRestart: false },
        { ...BASE, CACertificateIdentifier: 'rds-ca-rsa2048-g1', CertificateRotationRestart: false }
      );
      expect(modify()).toMatchObject({
        CACertificateIdentifier: 'rds-ca-ecc384-g1',
        CertificateRotationRestart: false,
      });
    });

    it('a changed CertificateRotationRestart alone sends nothing: it only says how a CA rotation restarts', async () => {
      armLive({});
      await update(
        { ...BASE, CACertificateIdentifier: 'rds-ca-rsa2048-g1', CertificateRotationRestart: true },
        { ...BASE, CACertificateIdentifier: 'rds-ca-rsa2048-g1', CertificateRotationRestart: false }
      );
      expect(modify()).not.toHaveProperty('CertificateRotationRestart');
      expect(modify()).not.toHaveProperty('CACertificateIdentifier');
    });

    it('a changed CACertificateIdentifier with no declared CertificateRotationRestart sends no flag', async () => {
      armLive({});
      await update(
        { ...BASE, CACertificateIdentifier: 'rds-ca-ecc384-g1' },
        { ...BASE, CACertificateIdentifier: 'rds-ca-rsa2048-g1' }
      );
      expect(modify()).not.toHaveProperty('CertificateRotationRestart');
    });
  });

  describe('readCurrentState and drift', () => {
    it('reads each member back under its CFn name', async () => {
      armLive(BOTH);
      const state = await provider.readCurrentState('db-1', 'Db', 'AWS::RDS::DBInstance');
      expect(state).toMatchObject(BOTH);
    });

    it('the two ModifyDBInstance-only flags are paths drift cannot compare; the members are compared', () => {
      const paths = provider.getDriftUnknownPaths('AWS::RDS::DBInstance', {
        ...BASE,
        ...BOTH,
        ...FLAGS,
      });
      expect([...paths].sort()).toEqual(['AllowMajorVersionUpgrade', 'CertificateRotationRestart']);
    });
  });
});
