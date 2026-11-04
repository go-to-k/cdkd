// go-to-k/cdkd#5639 / #5640: `EngineLifecycleSupport` and
// `MasterUserAuthenticationType` on AWS::RDS::DBCluster and AWS::RDS::DBInstance,
// plus the DBCluster's `DatabaseInsightsMode`, on the SDK route.
//
// Measured against CloudFormation (us-east-1, 2026-11-04):
// - EngineLifecycleSupport: a change, an addition (even of the value the live
//   resource holds) and a removal are all refused ("EngineLifecycleSupport
//   cannot be modified."), on both types.
// - MasterUserAuthenticationType: a change is sent, a removal sends nothing
//   (CloudTrail); RDS ties it to the managed-password setting in the same call.
// - DBCluster DatabaseInsightsMode: a change is sent beside the Performance
//   Insights members, a removal sends nothing and the mode stays.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockSend = vi.fn();
// Every logger call's arguments, so a test can assert a secret never reaches one.
const logged = vi.hoisted(() => [] as unknown[][]);

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
  const record = (...args: unknown[]): void => {
    logged.push(args);
  };
  const childLogger = {
    debug: record,
    info: record,
    warn: record,
    error: record,
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

const CLUSTER = 'AWS::RDS::DBCluster';
const INSTANCE = 'AWS::RDS::DBInstance';
const DISABLED = 'open-source-rds-extended-support-disabled';
const ENABLED = 'open-source-rds-extended-support';
const KMS = 'arn:aws:kms:us-east-1:123456789012:key/k1';

/**
 * Every Describe answers an available cluster / instance merged with `live`;
 * `describeFails` makes them throw instead. Creates answer the resource, the
 * rest `{}`.
 */
function arm(options: { live?: Input; describeFails?: boolean; notFound?: boolean } = {}): void {
  mockSend.mockImplementation((command: { constructor: { name: string } }) => {
    switch (command.constructor.name) {
      case 'DescribeDBClustersCommand':
        if (options.notFound) {
          return Promise.reject(Object.assign(new Error('not found'), { name: 'DBClusterNotFoundFault' }));
        }
        if (options.describeFails) {
          return Promise.reject(Object.assign(new Error('Throttling'), { name: 'Throttling' }));
        }
        return Promise.resolve({
          DBClusters: [
            {
              DBClusterIdentifier: 'c-1',
              DBClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:c-1',
              Status: 'available',
              DBClusterMembers: [],
              ...options.live,
            },
          ],
        });
      case 'DescribeDBInstancesCommand':
        if (options.notFound) {
          return Promise.reject(Object.assign(new Error('not found'), { name: 'DBInstanceNotFoundFault' }));
        }
        if (options.describeFails) {
          return Promise.reject(Object.assign(new Error('Throttling'), { name: 'Throttling' }));
        }
        return Promise.resolve({
          DBInstances: [
            {
              DBInstanceIdentifier: 'i-1',
              DBInstanceArn: 'arn:aws:rds:us-east-1:123456789012:db:i-1',
              DBInstanceStatus: 'available',
              ...options.live,
            },
          ],
        });
      case 'CreateDBClusterCommand':
        return Promise.resolve({ DBCluster: { DBClusterIdentifier: 'c-1' } });
      case 'CreateDBInstanceCommand':
        return Promise.resolve({ DBInstance: { DBInstanceIdentifier: 'i-1' } });
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

function names(): string[] {
  return mockSend.mock.calls.map(
    ([command]) => (command as { constructor: { name: string } }).constructor.name
  );
}

const CLUSTER_BASE: Input = {
  DBClusterIdentifier: 'c-1',
  Engine: 'aurora-postgresql',
  MasterUsername: 'admin',
};
const INSTANCE_BASE: Input = {
  DBInstanceIdentifier: 'i-1',
  DBInstanceClass: 'db.t4g.micro',
  Engine: 'postgres',
  AllocatedStorage: '20',
  MasterUsername: 'admin',
};

const TYPES = [
  {
    type: CLUSTER,
    kind: 'DB cluster',
    base: CLUSTER_BASE,
    id: 'c-1',
    create: 'CreateDBClusterCommand',
    modify: 'ModifyDBClusterCommand',
  },
  {
    type: INSTANCE,
    kind: 'DB instance',
    base: INSTANCE_BASE,
    id: 'i-1',
    create: 'CreateDBInstanceCommand',
    modify: 'ModifyDBInstanceCommand',
  },
] as const;

describe('RDSProvider EngineLifecycleSupport / MasterUserAuthenticationType / DatabaseInsightsMode (go-to-k/cdkd#5639, #5640)', () => {
  let provider: RDSProvider;

  beforeEach(() => {
    mockSend.mockReset();
    logged.length = 0;
    delete process.env['CDKD_NO_WAIT'];
    provider = new RDSProvider();
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {
      throw new Error('a wait never settled');
    };
  });

  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
  });

  it.each([
    [CLUSTER, 'EngineLifecycleSupport'],
    [CLUSTER, 'MasterUserAuthenticationType'],
    [CLUSTER, 'DatabaseInsightsMode'],
    [INSTANCE, 'EngineLifecycleSupport'],
    [INSTANCE, 'MasterUserAuthenticationType'],
  ])('%s %s is a handled property, so a template declaring it keeps the SDK route', (type, key) => {
    expect(provider.handledProperties.get(type)?.has(key)).toBe(true);
  });

  describe.each(TYPES)('$type', ({ type, kind, base, id, create, modify }) => {
    const update = (next: Input, prev: Input, context?: Record<string, unknown>) =>
      provider.update('L', id, type, { ...base, ...next }, { ...base, ...prev }, context);

    it('create sends both declared values', async () => {
      arm();
      await provider.create('L', type, {
        ...base,
        EngineLifecycleSupport: DISABLED,
        MasterUserAuthenticationType: 'iam-db-auth',
      });
      expect(sent(create)[0]).toMatchObject({
        EngineLifecycleSupport: DISABLED,
        MasterUserAuthenticationType: 'iam-db-auth',
      });
    });

    it('create sends neither when the template declares neither (an empty lifecycle included)', async () => {
      arm();
      await provider.create('L', type, { ...base, EngineLifecycleSupport: '' });
      expect(sent(create)[0]).not.toHaveProperty('EngineLifecycleSupport');
      expect(sent(create)[0]).not.toHaveProperty('MasterUserAuthenticationType');
    });

    describe('EngineLifecycleSupport on update', () => {
      it('an unchanged value is not sent and reads nothing extra', async () => {
        arm();
        await update({ EngineLifecycleSupport: DISABLED }, { EngineLifecycleSupport: DISABLED });
        expect(sent(modify)[0]).not.toHaveProperty('EngineLifecycleSupport');
      });

      it.each([
        ['changed', { EngineLifecycleSupport: ENABLED }, { EngineLifecycleSupport: DISABLED }],
        ['added', { EngineLifecycleSupport: ENABLED }, {}],
      ])(
        'a %s value the live resource does not hold is refused before any change',
        async (_label, next, prev) => {
          arm({ live: { EngineLifecycleSupport: DISABLED } });
          const err = (await update(next, prev).then(
            () => undefined,
            (e: unknown) => e
          )) as Error;
          expect(err).toBeInstanceOf(Error);
          expect(err.message).toContain(
            `EngineLifecycleSupport cannot change on an existing ${kind}`
          );
          expect(err.message).toContain('EngineLifecycleSupport cannot be modified.');
          expect(err.message).not.toContain('could not read the live setting');
          // At most the live read; nothing that changes the resource.
          expect(names().every((name) => name.startsWith('Describe'))).toBe(true);
        }
      );

      it('a removal is refused before any call, as CloudFormation refuses it', async () => {
        arm({ live: { EngineLifecycleSupport: DISABLED } });
        await expect(update({}, { EngineLifecycleSupport: DISABLED })).rejects.toThrow(
          `EngineLifecycleSupport cannot change on an existing ${kind}`
        );
        expect(mockSend).not.toHaveBeenCalled();
      });

      it('a declared value the live resource already holds is no change and is not sent', async () => {
        arm({ live: { EngineLifecycleSupport: ENABLED } });
        await update({ EngineLifecycleSupport: ENABLED }, {});
        expect(sent(modify)).toHaveLength(1);
        expect(sent(modify)[0]).not.toHaveProperty('EngineLifecycleSupport');
      });

      it('an unreadable live resource keeps the refusal and says so', async () => {
        arm({ describeFails: true });
        await expect(
          update({ EngineLifecycleSupport: ENABLED }, { EngineLifecycleSupport: DISABLED })
        ).rejects.toThrow(/could not read the live setting/);
        expect(sent(modify)).toHaveLength(0);
      });

      it('a resource deleted outside cdkd keeps the refusal and says so', async () => {
        arm({ notFound: true });
        const err = (await update(
          { EngineLifecycleSupport: ENABLED },
          { EngineLifecycleSupport: DISABLED }
        ).then(
          () => undefined,
          (e: unknown) => e
        )) as Error;
        expect(err.message).toContain(`RDS reports no such ${kind}`);
        expect(err.message).not.toContain('could not read the live setting');
        expect(sent(modify)).toHaveLength(0);
      });

      it.each([
        ['the live read answers', {}],
        ['the live read fails', { describeFails: true }],
      ])(
        'a secret-derived identifier is masked in the refusal when %s',
        async (_label, options) => {
          arm({ live: { EngineLifecycleSupport: DISABLED }, ...options });
          const idKey = type === CLUSTER ? 'DBClusterIdentifier' : 'DBInstanceIdentifier';
          const err = (await update(
            { EngineLifecycleSupport: ENABLED, [idKey]: 'rotated-secret-name' },
            {
              EngineLifecycleSupport: DISABLED,
              [idKey]: '{{resolve:secretsmanager:db-name}}',
            }
          ).then(
            () => undefined,
            (e: unknown) => e
          )) as Error;
          expect(err.message).toContain('EngineLifecycleSupport cannot change');
          // The physical id is the pre-rotation, secret-derived name.
          expect(err.message).not.toMatch(new RegExp(`\\b${id}\\b`));
        }
      );

      it('a rollback replay sends nothing and refuses nothing', async () => {
        arm();
        await update(
          { EngineLifecycleSupport: DISABLED },
          { EngineLifecycleSupport: ENABLED },
          { replayingState: true }
        );
        expect(sent(modify)[0]).not.toHaveProperty('EngineLifecycleSupport');
      });

      it('drift --revert restores the recorded value', async () => {
        arm();
        await update(
          { EngineLifecycleSupport: DISABLED },
          { EngineLifecycleSupport: ENABLED },
          { desiredFromAwsReadback: true }
        );
        expect(sent(modify)[0]).toMatchObject({ EngineLifecycleSupport: DISABLED });
      });
    });

    describe('MasterUserAuthenticationType on update', () => {
      it('a changed type is sent with the declared managed-password setting beside it', async () => {
        arm();
        await update(
          { MasterUserAuthenticationType: 'password', ManageMasterUserPassword: true },
          { MasterUserAuthenticationType: 'iam-db-auth', ManageMasterUserPassword: true }
        );
        expect(sent(modify)[0]).toMatchObject({
          MasterUserAuthenticationType: 'password',
          ManageMasterUserPassword: true,
        });
      });

      it('a switch to password with the managed password declared carries the declared secret KMS key: that call creates the secret', async () => {
        arm();
        const settings = { ManageMasterUserPassword: true, MasterUserSecret: { KmsKeyId: KMS } };
        await update(
          { ...settings, MasterUserAuthenticationType: 'password' },
          { ...settings, MasterUserAuthenticationType: 'iam-db-auth' }
        );
        expect(sent(modify)[0]).toMatchObject({
          MasterUserAuthenticationType: 'password',
          ManageMasterUserPassword: true,
          MasterUserSecretKmsKeyId: KMS,
        });
      });

      it('a switch away from password never re-sends the managed secret KMS key, which RDS takes only while turning management on', async () => {
        arm();
        const settings = { ManageMasterUserPassword: true, MasterUserSecret: { KmsKeyId: KMS } };
        await update(
          { ...settings, MasterUserAuthenticationType: 'iam-db-auth' },
          { ...settings, MasterUserAuthenticationType: 'password' }
        );
        expect(sent(modify)[0]).toMatchObject({ MasterUserAuthenticationType: 'iam-db-auth' });
        expect(sent(modify)[0]).not.toHaveProperty('MasterUserSecretKmsKeyId');
      });

      it.each([
        ['a template update', undefined],
        ['a rollback replay', { replayingState: true }],
      ])(
        'a switch to password on a literal-password resource carries the unchanged declared password (%s)',
        async (_label, context) => {
          arm();
          const secret = 'Unchanged-Secret-9';
          await update(
            { MasterUserAuthenticationType: 'password', MasterUserPassword: secret },
            { MasterUserAuthenticationType: 'iam-db-auth', MasterUserPassword: secret },
            context
          );
          expect(sent(modify)[0]).toMatchObject({
            MasterUserAuthenticationType: 'password',
            MasterUserPassword: secret,
          });
          expect(JSON.stringify(logged)).not.toContain(secret);
        }
      );

      it('an unchanged type does not re-send an unchanged password', async () => {
        arm();
        await update(
          { MasterUserAuthenticationType: 'password', MasterUserPassword: 'x-1' },
          { MasterUserAuthenticationType: 'password', MasterUserPassword: 'x-1' }
        );
        expect(sent(modify)[0]!['MasterUserPassword']).toBeUndefined();
      });

      it('a rollback replay with no password declared leaves the type, warns, and reverts the other members', async () => {
        arm();
        await update(
          { MasterUserAuthenticationType: 'password', AutoMinorVersionUpgrade: true },
          { MasterUserAuthenticationType: 'iam-db-auth', AutoMinorVersionUpgrade: false },
          { replayingState: true }
        );
        const input = sent(modify)[0]!;
        expect(input['AutoMinorVersionUpgrade']).toBe(true);
        expect(input).not.toHaveProperty('MasterUserAuthenticationType');
        expect(input['MasterUserPassword']).toBeUndefined();
        expect(JSON.stringify(logged)).toContain(
          'the rollback leaves MasterUserAuthenticationType as it is'
        );
      });

      it('that replay sends no lone ManageMasterUserPassword: false either, which RDS refuses', async () => {
        arm();
        await update(
          {
            MasterUserAuthenticationType: 'password',
            ManageMasterUserPassword: false,
            AutoMinorVersionUpgrade: true,
          },
          {
            MasterUserAuthenticationType: 'iam-db-auth',
            ManageMasterUserPassword: false,
            AutoMinorVersionUpgrade: false,
          },
          { replayingState: true }
        );
        const input = sent(modify)[0]!;
        expect(input['AutoMinorVersionUpgrade']).toBe(true);
        expect(input).not.toHaveProperty('MasterUserAuthenticationType');
        expect(input).not.toHaveProperty('ManageMasterUserPassword');
      });

      it('an added password type on a resource already managed does not re-send the secret KMS key', async () => {
        arm();
        const settings = { ManageMasterUserPassword: true, MasterUserSecret: { KmsKeyId: KMS } };
        await update({ ...settings, MasterUserAuthenticationType: 'password' }, { ...settings });
        expect(sent(modify)[0]).toMatchObject({ MasterUserAuthenticationType: 'password' });
        expect(sent(modify)[0]).not.toHaveProperty('MasterUserSecretKmsKeyId');
      });

      it.each([['a template update', undefined]])(
        'a switch to password with no password declared is refused before any call (%s)',
        async (_label, context) => {
          arm();
          const err = (await update(
            { MasterUserAuthenticationType: 'password' },
            { MasterUserAuthenticationType: 'iam-db-auth' },
            context
          ).then(
            () => undefined,
            (e: unknown) => e
          )) as Error;
          expect(err).toBeInstanceOf(Error);
          expect(err.message).toContain(
            'MasterUserAuthenticationType changes to password, which RDS accepts only beside a master password'
          );
          expect(mockSend).not.toHaveBeenCalled();
        }
      );

      it('a switch to iam-db-auth carries the declared ManageMasterUserPassword: false', async () => {
        arm();
        await update(
          { MasterUserAuthenticationType: 'iam-db-auth', ManageMasterUserPassword: false },
          { ManageMasterUserPassword: false }
        );
        expect(sent(modify)[0]).toMatchObject({
          MasterUserAuthenticationType: 'iam-db-auth',
          ManageMasterUserPassword: false,
        });
      });

      it('an unchanged type is not sent, nor the managed-password setting', async () => {
        arm();
        await update(
          { MasterUserAuthenticationType: 'password', ManageMasterUserPassword: true },
          { MasterUserAuthenticationType: 'password', ManageMasterUserPassword: true }
        );
        expect(sent(modify)[0]).not.toHaveProperty('MasterUserAuthenticationType');
        expect(sent(modify)[0]).not.toHaveProperty('ManageMasterUserPassword');
      });

      it('a removal sends nothing: RDS keeps the live type, as under CloudFormation', async () => {
        arm();
        await update({}, { MasterUserAuthenticationType: 'iam-db-auth' });
        expect(sent(modify)[0]).not.toHaveProperty('MasterUserAuthenticationType');
      });
    });
  });

  describe('DBCluster DatabaseInsightsMode', () => {
    const update = (next: Input, prev: Input) =>
      provider.update('L', 'c-1', CLUSTER, { ...CLUSTER_BASE, ...next }, { ...CLUSTER_BASE, ...prev });
    const PI = {
      PerformanceInsightsEnabled: true,
      PerformanceInsightsKmsKeyId: KMS,
      PerformanceInsightsRetentionPeriod: 465,
    };

    it('create sends the declared mode', async () => {
      arm();
      await provider.create('L', CLUSTER, { ...CLUSTER_BASE, ...PI, DatabaseInsightsMode: 'advanced' });
      expect(sent('CreateDBClusterCommand')[0]).toMatchObject({
        DatabaseInsightsMode: 'advanced',
        EnablePerformanceInsights: true,
        PerformanceInsightsRetentionPeriod: 465,
      });
    });

    it('a changed mode is sent with the declared Performance Insights members', async () => {
      arm();
      await update(
        { ...PI, DatabaseInsightsMode: 'advanced' },
        { ...PI, DatabaseInsightsMode: 'standard' }
      );
      expect(sent('ModifyDBClusterCommand')[0]).toMatchObject({
        DatabaseInsightsMode: 'advanced',
        EnablePerformanceInsights: true,
        PerformanceInsightsKMSKeyId: KMS,
        PerformanceInsightsRetentionPeriod: 465,
      });
    });

    it('an unchanged mode sends neither it nor the trio', async () => {
      arm();
      await update(
        { ...PI, DatabaseInsightsMode: 'advanced' },
        { ...PI, DatabaseInsightsMode: 'advanced' }
      );
      const input = sent('ModifyDBClusterCommand')[0]!;
      expect(input).not.toHaveProperty('DatabaseInsightsMode');
      expect(input).not.toHaveProperty('EnablePerformanceInsights');
    });

    it('a removal sends no mode: the live one stays, as under CloudFormation', async () => {
      arm();
      await update({ ...PI }, { ...PI, DatabaseInsightsMode: 'advanced' });
      expect(sent('ModifyDBClusterCommand')[0]).not.toHaveProperty('DatabaseInsightsMode');
    });
  });

  describe('--remove-protection flip on a busy resource', () => {
    /**
     * The first flip is refused as `refusal`; the next is accepted. Describe
     * answers the resource `available` with its guard until the delete, then
     * not-found.
     */
    function armBusy(kind: 'cluster' | 'instance', refusal: { name: string; message: string }) {
      let flips = 0;
      let deleted = false;
      let guard = true;
      const notFound = (name: string) =>
        Promise.reject(Object.assign(new Error('not found'), { name }));
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        switch (command.constructor.name) {
          case 'DescribeDBClustersCommand':
            return deleted
              ? notFound('DBClusterNotFoundFault')
              : Promise.resolve({
                  DBClusters: [{ DBClusterIdentifier: 'c-1', Status: 'available', DeletionProtection: guard }],
                });
          case 'DescribeDBInstancesCommand':
            return deleted
              ? notFound('DBInstanceNotFoundFault')
              : Promise.resolve({
                  DBInstances: [
                    { DBInstanceIdentifier: 'i-1', DBInstanceStatus: 'available', DeletionProtection: guard },
                  ],
                });
          case 'ModifyDBClusterCommand':
          case 'ModifyDBInstanceCommand':
            flips += 1;
            if (flips === 1) return Promise.reject(Object.assign(new Error(refusal.message), { name: refusal.name }));
            guard = false;
            return Promise.resolve({});
          case 'DeleteDBClusterCommand':
          case 'DeleteDBInstanceCommand':
            if (guard) {
              return Promise.reject(
                Object.assign(new Error('Cannot delete protected Cluster'), {
                  name: 'InvalidParameterCombination',
                })
              );
            }
            deleted = true;
            return Promise.resolve({});
          default:
            return Promise.resolve({});
        }
      });
      void kind;
    }

    beforeEach(() => {
      (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
    });

    it('a cluster flip refused as "could not be modified" is waited out and resent before the delete', async () => {
      armBusy('cluster', {
        name: 'InvalidDBClusterStateFault',
        message: 'This cluster could not be modified. Please try again',
      });
      await provider.delete('L', 'c-1', CLUSTER, {}, { removeProtection: true });
      const flips = sent('ModifyDBClusterCommand');
      expect(flips).toHaveLength(2);
      expect(flips.every((input) => input['DeletionProtection'] === false)).toBe(true);
      expect(sent('DeleteDBClusterCommand')).toHaveLength(1);
      expect(names().indexOf('DeleteDBClusterCommand')).toBeGreaterThan(
        names().lastIndexOf('ModifyDBClusterCommand')
      );
    });

    it.each([
      {
        type: CLUSTER,
        id: 'c-1',
        modify: 'ModifyDBClusterCommand',
        del: 'DeleteDBClusterCommand',
        describe: 'DescribeDBClustersCommand',
        busy: { name: 'InvalidDBClusterStateFault', message: 'This cluster could not be modified. Please try again' },
        refusal: { name: 'InvalidDBClusterStateFault', message: 'Cluster cannot be deleted, it still contains DB instances in non-deleting state.' },
      },
      {
        type: INSTANCE,
        id: 'i-1',
        modify: 'ModifyDBInstanceCommand',
        del: 'DeleteDBInstanceCommand',
        describe: 'DescribeDBInstancesCommand',
        busy: { name: 'InvalidDBInstanceStateFault', message: 'Database instance is not in available state.' },
        refusal: { name: 'InvalidParameterCombination', message: 'Cannot delete the instance for a reason no wait ends.' },
      },
    ])(
      '$type: a terminal delete failure re-enables the guard even when the first re-enable is refused as busy',
      async ({ type, id, modify, del, describe: describeName, busy, refusal }) => {
        let guard = true;
        let reEnables = 0;
        mockSend.mockImplementation((command: { constructor: { name: string }; input: Input }) => {
          const name = command.constructor.name;
          if (name === describeName) {
            return Promise.resolve(
              type === CLUSTER
                ? { DBClusters: [{ DBClusterIdentifier: id, Status: 'available', DeletionProtection: guard }] }
                : { DBInstances: [{ DBInstanceIdentifier: id, DBInstanceStatus: 'available', DeletionProtection: guard }] }
            );
          }
          if (name === modify) {
            if (command.input['DeletionProtection'] === true) {
              reEnables += 1;
              if (reEnables === 1) return Promise.reject(Object.assign(new Error(busy.message), { name: busy.name }));
            }
            guard = command.input['DeletionProtection'] === true;
            return Promise.resolve({});
          }
          if (name === del) {
            return Promise.reject(Object.assign(new Error(refusal.message), { name: refusal.name }));
          }
          return Promise.resolve({});
        });
        await expect(
          provider.delete('L', id, type, {}, { removeProtection: true })
        ).rejects.toThrow();
        expect(reEnables).toBe(2);
        expect(guard).toBe(true);
      }
    );

    it('an instance flip refused as not available is waited out and resent before the delete', async () => {
      armBusy('instance', {
        name: 'InvalidDBInstanceStateFault',
        message: 'Database instance is not in available state.',
      });
      await provider.delete('L', 'i-1', INSTANCE, {}, { removeProtection: true });
      expect(sent('ModifyDBInstanceCommand')).toHaveLength(2);
      expect(sent('DeleteDBInstanceCommand')).toHaveLength(1);
    });
  });

  describe('readCurrentState', () => {
    it('a DB cluster reports its mode and lifecycle, never an authentication type', async () => {
      arm({ live: { DatabaseInsightsMode: 'advanced', EngineLifecycleSupport: DISABLED } });
      const state = (await provider.readCurrentState('c-1', 'L', CLUSTER)) as Input;
      expect(state).toMatchObject({
        DatabaseInsightsMode: 'advanced',
        EngineLifecycleSupport: DISABLED,
      });
      expect(state).not.toHaveProperty('MasterUserAuthenticationType');
    });

    it('a standalone DB instance reports its lifecycle', async () => {
      arm({ live: { EngineLifecycleSupport: DISABLED } });
      const state = (await provider.readCurrentState('i-1', 'L', INSTANCE)) as Input;
      expect(state['EngineLifecycleSupport']).toBe(DISABLED);
      expect(state).not.toHaveProperty('MasterUserAuthenticationType');
    });

    it("a cluster member does not report the cluster's lifecycle as its own", async () => {
      arm({ live: { EngineLifecycleSupport: DISABLED, DBClusterIdentifier: 'c-1' } });
      const state = (await provider.readCurrentState('i-1', 'L', INSTANCE)) as Input;
      expect(state).not.toHaveProperty('EngineLifecycleSupport');
    });
  });
});
