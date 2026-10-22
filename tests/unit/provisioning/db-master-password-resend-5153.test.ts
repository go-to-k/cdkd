// go-to-k/cdkd#5153: an update re-sent the template's MasterUserPassword on
// every ModifyDBCluster / ModifyDBInstance, and AWS treats a supplied password
// as a master-credential reset (DocDB entered `resetting-master-credentials`
// after a PreferredMaintenanceWindow-only change). CloudFormation sends only a
// changed password, so cdkd must too.
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, loggerCalls } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  loggerCalls: [] as unknown[][],
}));

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

vi.mock('@aws-sdk/client-rds', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    RDSClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const record =
    () =>
    (...args: unknown[]) => {
      loggerCalls.push(args);
    };
  const logger = {
    debug: record(),
    info: record(),
    warn: record(),
    error: record(),
    child: () => logger,
  };
  return { getLogger: () => logger };
});

import type { ResourceProvider, UpdateContext } from '../../../src/types/resource.js';
import { DocDBProvider } from '../../../src/provisioning/providers/docdb-provider.js';
import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';

const PASSWORD = 'TempPass1234!';
const NEW_PASSWORD = 'OtherPass5678!';
const SECRET_REF = '{{resolve:secretsmanager:db-secret:SecretString:password::}}';

interface Target {
  name: string;
  resourceType: string;
  modifyCommand: string;
  make: () => ResourceProvider;
}

const TARGETS: Target[] = [
  {
    name: 'DocDB DBCluster',
    resourceType: 'AWS::DocDB::DBCluster',
    modifyCommand: 'ModifyDBClusterCommand',
    make: () => new DocDBProvider(),
  },
  {
    name: 'RDS DBCluster',
    resourceType: 'AWS::RDS::DBCluster',
    modifyCommand: 'ModifyDBClusterCommand',
    make: () => new RDSProvider(),
  },
  {
    name: 'RDS DBInstance',
    resourceType: 'AWS::RDS::DBInstance',
    modifyCommand: 'ModifyDBInstanceCommand',
    make: () => new RDSProvider(),
  },
];

describe.each(TARGETS)('$name update: MasterUserPassword only when it changed (#5153)', (target) => {
  beforeEach(() => {
    mockSend.mockReset();
    loggerCalls.length = 0;
    mockSend.mockImplementation((command: { constructor: { name: string } }) => {
      switch (command.constructor.name) {
        case 'DescribeDBClustersCommand':
          return Promise.resolve({ DBClusters: [{}] });
        case 'DescribeDBInstancesCommand':
          return Promise.resolve({ DBInstances: [{}] });
        default:
          return Promise.resolve({});
      }
    });
  });

  /** The Modify* input the update sent, asserting exactly one was sent. */
  const sentPassword = async (
    desired: Record<string, unknown>,
    previous: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<{ present: boolean; value: unknown }> => {
    mockSend.mockClear();
    await target
      .make()
      .update('Db', 'db-1', target.resourceType, desired, previous, context);
    const modifies = mockSend.mock.calls
      .map((call) => call[0] as { constructor: { name: string }; input: Record<string, unknown> })
      .filter((command) => command.constructor.name === target.modifyCommand);
    expect(modifies).toHaveLength(1);
    const input = modifies[0]!.input;
    return { present: input['MasterUserPassword'] !== undefined, value: input['MasterUserPassword'] };
  };

  describe('without changedProperties (rollback revert, drift --revert, direct call)', () => {
    it('omits an unchanged literal password', async () => {
      const sent = await sentPassword(
        { MasterUserPassword: PASSWORD, PreferredMaintenanceWindow: 'wed:05:00-wed:05:30' },
        { MasterUserPassword: PASSWORD, PreferredMaintenanceWindow: 'tue:05:00-tue:05:30' }
      );
      expect(sent.present).toBe(false);
    });

    it('sends a changed password', async () => {
      const sent = await sentPassword(
        { MasterUserPassword: NEW_PASSWORD },
        { MasterUserPassword: PASSWORD }
      );
      expect(sent.value).toBe(NEW_PASSWORD);
    });

    it('sends a password declared for the first time', async () => {
      const sent = await sentPassword({ MasterUserPassword: PASSWORD }, {});
      expect(sent.value).toBe(PASSWORD);
    });

    it('sends nothing for a removed password, as CloudFormation does', async () => {
      const sent = await sentPassword({}, { MasterUserPassword: PASSWORD });
      expect(sent.present).toBe(false);
    });

    it('sends the password when the record holds a dynamic reference it cannot compare', async () => {
      const sent = await sentPassword(
        { MasterUserPassword: PASSWORD },
        { MasterUserPassword: SECRET_REF }
      );
      expect(sent.value).toBe(PASSWORD);
    });

    it('never reads a recorded dynamic reference as equal, even spelled identically', async () => {
      const sent = await sentPassword(
        { MasterUserPassword: SECRET_REF },
        { MasterUserPassword: SECRET_REF }
      );
      expect(sent.present).toBe(true);
    });

    it('never reads a recorded mask as equal, even spelled identically', async () => {
      const sent = await sentPassword({ MasterUserPassword: '***' }, { MasterUserPassword: '***' });
      expect(sent.present).toBe(true);
    });

    it('omits an unchanged literal password that merely contains the mask characters', async () => {
      // The mask stands for a WHOLE leaf; a literal embedding `***` is a value.
      const sent = await sentPassword(
        { MasterUserPassword: 'Pa***word1234' },
        { MasterUserPassword: 'Pa***word1234' }
      );
      expect(sent.present).toBe(false);
    });
  });

  describe("with the deploy's changedProperties (template-to-template)", () => {
    it('omits a password the templates did not change, though the record holds its reference', async () => {
      const sent = await sentPassword(
        { MasterUserPassword: PASSWORD, PreferredMaintenanceWindow: 'wed:05:00-wed:05:30' },
        { MasterUserPassword: SECRET_REF, PreferredMaintenanceWindow: 'tue:05:00-tue:05:30' },
        { changedProperties: new Set(['PreferredMaintenanceWindow']) }
      );
      expect(sent.present).toBe(false);
    });

    it('sends a password the set names, though the recorded value is equal', async () => {
      // e.g. a NoEcho parameter value AWS could not confirm holding.
      const sent = await sentPassword(
        { MasterUserPassword: PASSWORD },
        { MasterUserPassword: PASSWORD },
        { changedProperties: new Set(['MasterUserPassword']) }
      );
      expect(sent.value).toBe(PASSWORD);
    });

    it('sends nothing for a removed password the set names', async () => {
      const sent = await sentPassword(
        {},
        { MasterUserPassword: PASSWORD },
        { changedProperties: new Set(['MasterUserPassword']) }
      );
      expect(sent.present).toBe(false);
    });
  });

  it('logs no password value on any path', async () => {
    await sentPassword({ MasterUserPassword: NEW_PASSWORD }, { MasterUserPassword: PASSWORD });
    await sentPassword(
      { MasterUserPassword: NEW_PASSWORD },
      { MasterUserPassword: PASSWORD },
      { changedProperties: new Set(['MasterUserPassword']) }
    );
    expect(loggerCalls.length).toBeGreaterThan(0);
    const logged = JSON.stringify(loggerCalls);
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain(NEW_PASSWORD);
  });
});

describe.each(TARGETS.filter((t) => t.resourceType.startsWith('AWS::RDS::')))(
  '$name update: managed-password settings ride only a credential change (#5153)',
  (target) => {
    beforeEach(() => {
      mockSend.mockReset();
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        switch (command.constructor.name) {
          case 'DescribeDBClustersCommand':
            return Promise.resolve({ DBClusters: [{}] });
          case 'DescribeDBInstancesCommand':
            return Promise.resolve({ DBInstances: [{}] });
          default:
            return Promise.resolve({});
        }
      });
    });

    const modifyInput = async (
      desired: Record<string, unknown>,
      previous: Record<string, unknown>,
      context?: UpdateContext
    ): Promise<Record<string, unknown>> => {
      await target
        .make()
        .update('Db', 'db-1', target.resourceType, desired, previous, context);
      const modifies = mockSend.mock.calls
        .map((call) => call[0] as { constructor: { name: string }; input: Record<string, unknown> })
        .filter((command) => command.constructor.name === target.modifyCommand);
      expect(modifies).toHaveLength(1);
      return modifies[0]!.input;
    };

    const credentialKeys = (input: Record<string, unknown>): string[] =>
      ['MasterUserPassword', 'ManageMasterUserPassword', 'MasterUserSecretKmsKeyId'].filter(
        (key) => input[key] !== undefined
      );

    it('sends no lone ManageMasterUserPassword: false beside an unchanged password', async () => {
      const bag = { MasterUserPassword: PASSWORD, ManageMasterUserPassword: false };
      const viaSet = await modifyInput(
        { ...bag, PreferredMaintenanceWindow: 'wed:05:00-wed:05:30' },
        { ...bag, PreferredMaintenanceWindow: 'tue:05:00-tue:05:30' },
        { changedProperties: new Set(['PreferredMaintenanceWindow']) }
      );
      expect(credentialKeys(viaSet)).toEqual([]);
      mockSend.mockClear();
      const viaFallback = await modifyInput(bag, { ...bag });
      expect(credentialKeys(viaFallback)).toEqual([]);
    });

    it('sends an unchanged managed setting and KMS key nowhere', async () => {
      const bag = {
        ManageMasterUserPassword: true,
        MasterUserSecret: { KmsKeyId: 'alias/aws/secretsmanager' },
      };
      const input = await modifyInput(bag, structuredClone(bag));
      expect(credentialKeys(input)).toEqual([]);
    });

    it('sends the managed setting with the newly declared password when management is turned off', async () => {
      const input = await modifyInput(
        { ManageMasterUserPassword: false, MasterUserPassword: PASSWORD },
        { ManageMasterUserPassword: true },
        { changedProperties: new Set(['ManageMasterUserPassword', 'MasterUserPassword']) }
      );
      expect(input['ManageMasterUserPassword']).toBe(false);
      expect(input['MasterUserPassword']).toBe(PASSWORD);
    });

    it('sends the managed setting and KMS key together when only the key changed', async () => {
      const input = await modifyInput(
        { ManageMasterUserPassword: true, MasterUserSecret: { KmsKeyId: 'key-2' } },
        { ManageMasterUserPassword: true, MasterUserSecret: { KmsKeyId: 'key-1' } }
      );
      expect(input['ManageMasterUserPassword']).toBe(true);
      expect(input['MasterUserSecretKmsKeyId']).toBe('key-2');
      expect(input['MasterUserPassword']).toBeUndefined();
    });

    it.each(['***', '{{resolve:ssm:/db/kms-key}}'])(
      'never reads a recorded stand-in nested in MasterUserSecret (%s) as equal',
      async (standIn) => {
        const bag = { ManageMasterUserPassword: true, MasterUserSecret: { KmsKeyId: standIn } };
        const input = await modifyInput(bag, structuredClone(bag));
        expect(input['ManageMasterUserPassword']).toBe(true);
      }
    );
  }
);

it('RDS DBInstance leaves the MasterUserPassword key out of the input when not sending it (#5153)', async () => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({ DBInstances: [{}] });
  await new RDSProvider().update(
    'Db',
    'db-1',
    'AWS::RDS::DBInstance',
    { MasterUserPassword: PASSWORD },
    { MasterUserPassword: PASSWORD }
  );
  const modify = mockSend.mock.calls
    .map((call) => call[0] as { constructor: { name: string }; input: Record<string, unknown> })
    .find((command) => command.constructor.name === 'ModifyDBInstanceCommand');
  expect(modify).toBeDefined();
  expect(Object.hasOwn(modify!.input, 'MasterUserPassword')).toBe(false);
});
