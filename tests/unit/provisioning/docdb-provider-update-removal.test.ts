// issues #1160 / #5004 (docdb): absent-field removal semantics.
// ModifyDBCluster uses merge semantics (an omitted field is "no change"). A
// real CloudFormation A/B (#5004) showed CloudFormation KEEPS the live value
// of a removed DeletionProtection / BackupRetentionPeriod, so cdkd sends NO
// reset for them. DBSubnetGroupDescription (a separate provider) keeps its
// create-time-fallback reset.
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

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

import { prepareRemovalForUpdate } from '../../../src/provisioning/update-removal.js';
import type { ResourceProvider } from '../../../src/types/resource.js';
import { DocDBProvider } from '../../../src/provisioning/providers/docdb-provider.js';
import { DocDBSubnetGroupProvider } from '../../../src/provisioning/providers/docdb-subnet-group-provider.js';

describe('DocDBProvider removal semantics (issues #1160 / #5004)', () => {
  let provider: DocDBProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DocDBProvider();
  });

  describe('removal declaration (what deploy / rollback inject)', () => {
    it('declares no removalDefaults for DBCluster, so nothing is injected on removal (#5004)', () => {
      expect((provider as ResourceProvider).removalDefaults?.get('AWS::DocDB::DBCluster')).toBeUndefined();
      const prep = prepareRemovalForUpdate(
        provider,
        'AWS::DocDB::DBCluster',
        {},
        { DeletionProtection: true, BackupRetentionPeriod: 7 }
      );
      expect(prep.injected).toEqual([]);
      expect(prep.properties).not.toHaveProperty('DeletionProtection');
      expect(prep.properties).not.toHaveProperty('BackupRetentionPeriod');
    });
  });

  describe('DBCluster update (ModifyDBCluster)', () => {
    const mockClusterUpdate = () => {
      // updateDBCluster does 2 sends: ModifyDBCluster + final describe.
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({ DBClusters: [{}] });
    };

    it('sends NO reset for removed fields CloudFormation keeps (#5004)', async () => {
      mockClusterUpdate();

      await provider.update(
        'MyCluster',
        'my-cluster',
        'AWS::DocDB::DBCluster',
        {},
        {
          DeletionProtection: true,
          BackupRetentionPeriod: 7,
          // Deliberately NOT reset on removal — must stay absent.
          EngineVersion: '5.0.0',
          DBClusterParameterGroupName: 'my-cluster-params',
          PreferredBackupWindow: '03:00-04:00',
          PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
          VpcSecurityGroupIds: ['sg-1'],
          MasterUserPassword: 'TempPass1234!',
          // Already the default a removed Port resets to, so nothing is sent
          // (a non-default one: docdb-provider-port-removal-1160.test.ts).
          Port: 27017,
        }
      );

      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.constructor.name).toBe('ModifyDBClusterCommand');
      // #5004: CloudFormation keeps the live value, so each stays absent
      // (no change) rather than being reset to false / 1.
      expect(modifyCall.input.DeletionProtection).toBeUndefined();
      expect(modifyCall.input.BackupRetentionPeriod).toBeUndefined();
      // Other deliberate non-resets: removal must NOT synthesize any value.
      expect(modifyCall.input.EngineVersion).toBeUndefined();
      expect(modifyCall.input.DBClusterParameterGroupName).toBeUndefined();
      expect(modifyCall.input.PreferredBackupWindow).toBeUndefined();
      expect(modifyCall.input.PreferredMaintenanceWindow).toBeUndefined();
      expect(modifyCall.input.VpcSecurityGroupIds).toBeUndefined();
      expect(modifyCall.input.MasterUserPassword).toBeUndefined();
      expect(modifyCall.input.Port).toBeUndefined();
    });

    it('leaves a never-present field absent (no spurious reset value)', async () => {
      mockClusterUpdate();

      await provider.update('MyCluster', 'my-cluster', 'AWS::DocDB::DBCluster', {}, {});

      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.input.DeletionProtection).toBeUndefined();
      expect(modifyCall.input.BackupRetentionPeriod).toBeUndefined();
    });

    it('passes changed fields through unchanged', async () => {
      mockClusterUpdate();

      await provider.update(
        'MyCluster',
        'my-cluster',
        'AWS::DocDB::DBCluster',
        {
          DeletionProtection: true,
          // CFn number props may arrive as strings — coercion preserved.
          BackupRetentionPeriod: '14',
        },
        {
          DeletionProtection: true,
          BackupRetentionPeriod: 7,
        }
      );

      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.input.DeletionProtection).toBe(true);
      expect(modifyCall.input.BackupRetentionPeriod).toBe(14);
    });
  });

  describe('DBInstance update (ModifyDBInstance)', () => {
    const mockInstanceUpdate = () => {
      // updateDBInstance does 2 sends: ModifyDBInstance + final describe.
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({ DBInstances: [{}] });
    };

    it('deliberately leaves removed instance fields absent (per-field deferrals)', async () => {
      mockInstanceUpdate();

      await provider.update(
        'MyInstance',
        'my-instance',
        'AWS::DocDB::DBInstance',
        {
          DBInstanceClass: 'db.t3.medium',
        },
        {
          DBInstanceClass: 'db.t3.medium',
          // Deliberately NOT reset on removal — must stay absent. Pins the
          // per-field rationale comment in updateDBInstance:
          // AutoMinorVersionUpgrade is inert on DocDB (SDK doc: "does not
          // apply to Amazon DocumentDB"), PreferredMaintenanceWindow has no
          // reset sentinel (AWS assigns a random window at create).
          AutoMinorVersionUpgrade: true,
          PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
        }
      );

      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.constructor.name).toBe('ModifyDBInstanceCommand');
      expect(modifyCall.input.AutoMinorVersionUpgrade).toBeUndefined();
      expect(modifyCall.input.PreferredMaintenanceWindow).toBeUndefined();
    });

    it('passes kept fields through unchanged', async () => {
      mockInstanceUpdate();

      await provider.update(
        'MyInstance',
        'my-instance',
        'AWS::DocDB::DBInstance',
        { DBInstanceClass: 'db.t3.medium', AutoMinorVersionUpgrade: false },
        { DBInstanceClass: 'db.t3.medium', AutoMinorVersionUpgrade: true }
      );

      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.input.AutoMinorVersionUpgrade).toBe(false);
    });
  });

  describe('DBSubnetGroup update (ModifyDBSubnetGroup)', () => {
    // The subnet group has its own provider (issue #3866).
    const subnetGroupProvider = new DocDBSubnetGroupProvider();
    const mockSubnetGroupUpdate = () => {
      // update() does 2 sends: ModifyDBSubnetGroup + describe.
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({ DBSubnetGroups: [{}] });
    };

    it('resets a removed description to the create-time fallback', async () => {
      mockSubnetGroupUpdate();

      await subnetGroupProvider.update(
        'MySG',
        'my-subnet-group',
        'AWS::DocDB::DBSubnetGroup',
        { SubnetIds: ['subnet-1', 'subnet-2'] },
        { SubnetIds: ['subnet-1', 'subnet-2'], DBSubnetGroupDescription: 'custom description' }
      );

      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.constructor.name).toBe('ModifyDBSubnetGroupCommand');
      // Same fallback createDBSubnetGroup synthesizes for an absent
      // description — create/update parity.
      expect(modifyCall.input.DBSubnetGroupDescription).toBe('Subnet group for MySG');
    });

    it('leaves a never-present description absent and passes a kept one through', async () => {
      mockSubnetGroupUpdate();

      await subnetGroupProvider.update(
        'MySG',
        'my-subnet-group',
        'AWS::DocDB::DBSubnetGroup',
        { SubnetIds: ['subnet-1', 'subnet-2'] },
        { SubnetIds: ['subnet-1', 'subnet-2'] }
      );

      let modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.input.DBSubnetGroupDescription).toBeUndefined();

      vi.clearAllMocks();
      mockSubnetGroupUpdate();

      await subnetGroupProvider.update(
        'MySG',
        'my-subnet-group',
        'AWS::DocDB::DBSubnetGroup',
        { SubnetIds: ['subnet-1', 'subnet-2'], DBSubnetGroupDescription: 'kept' },
        { SubnetIds: ['subnet-1', 'subnet-2'], DBSubnetGroupDescription: 'old' }
      );

      modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.input.DBSubnetGroupDescription).toBe('kept');
    });
  });
});

describe('DocDBSubnetGroupProvider update region guard (issue #2613)', () => {
  let provider: DocDBSubnetGroupProvider;
  const desired = { DBSubnetGroupDescription: 'new', SubnetIds: ['subnet-a', 'subnet-b'] };
  const previous = { DBSubnetGroupDescription: 'old', SubnetIds: ['subnet-a', 'subnet-b'] };

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DocDBSubnetGroupProvider();
  });

  it('refuses an update from a wrong-region client before any call', async () => {
    await expect(
      provider.update('MySubnetGroup', 'my-subnet-group', 'AWS::DocDB::DBSubnetGroup', desired, previous, {
        expectedRegion: 'us-west-2',
      })
    ).rejects.toThrow(/Refusing to update MySubnetGroup .*does not match stack state region us-west-2/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('updates when the client region matches the recorded one', async () => {
    mockSend.mockResolvedValue({ DBSubnetGroups: [] });
    await provider.update('MySubnetGroup', 'my-subnet-group', 'AWS::DocDB::DBSubnetGroup', desired, previous, {
      expectedRegion: 'us-east-1',
    });
    expect(mockSend.mock.calls[0]![0].constructor.name).toBe('ModifyDBSubnetGroupCommand');
  });

  it('without a recorded region proceeds and never resolves the client region', async () => {
    const region = vi.fn(() => Promise.resolve('us-west-2'));
    (provider as unknown as { getClient(): { config: { region: unknown } } }).getClient().config.region = region;
    mockSend.mockResolvedValue({ DBSubnetGroups: [] });
    await provider.update('MySubnetGroup', 'my-subnet-group', 'AWS::DocDB::DBSubnetGroup', desired, previous);
    expect(region).not.toHaveBeenCalled();
    expect(mockSend.mock.calls[0]![0].constructor.name).toBe('ModifyDBSubnetGroupCommand');
  });
});
