// Issue #5543 (umbrella #1160): DocDB cluster EngineVersion /
// PreferredBackupWindow / PreferredMaintenanceWindow /
// DBClusterParameterGroupName and DB instance PreferredMaintenanceWindow
// REMOVED from the template.
//
// A real CloudFormation A/B (us-east-1, 2026-10-30, stacks
// `cdkd-ab-5543-alone` / `cdkd-ab-5543-beside`) set all five to non-default
// values (EngineVersion 5.0.0 against a default of 8.0.2, a custom docdb5.0
// parameter group, explicit windows), then removed them, alone and beside a
// BackupRetentionPeriod change that landed. Every value read back unchanged
// for eight minutes after UPDATE_COMPLETE: CloudFormation KEEPS them. So cdkd
// sends nothing for a removed one, says so in one warning per resource, and
// registers both types in `removalHandledInUpdate`, so the shared caller's
// "CloudFormation would reset it" line names none of them.
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const dbSend = vi.fn();

vi.mock('@aws-sdk/client-docdb', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    DocDBClient: vi.fn().mockImplementation(() => ({
      send: dbSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

const loggerWarn = vi.fn();
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => loggerWarn(...args),
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

import { DocDBProvider } from '../../../src/provisioning/providers/docdb-provider.js';
import { prepareRemovalForUpdate } from '../../../src/provisioning/update-removal.js';

const CLUSTER = 'AWS::DocDB::DBCluster';
const INSTANCE = 'AWS::DocDB::DBInstance';

const CLUSTER_PREVIOUS = {
  EngineVersion: '5.0.0',
  PreferredBackupWindow: '07:00-08:00',
  PreferredMaintenanceWindow: 'sun:10:00-sun:10:30',
  DBClusterParameterGroupName: 'custom-docdb50',
  BackupRetentionPeriod: 2,
};
const CLUSTER_KEPT = [
  'EngineVersion',
  'PreferredBackupWindow',
  'PreferredMaintenanceWindow',
  'DBClusterParameterGroupName',
];

const INSTANCE_PREVIOUS = {
  DBClusterIdentifier: 'my-cluster',
  DBInstanceClass: 'db.t3.medium',
  PreferredMaintenanceWindow: 'mon:11:00-mon:11:30',
};

function routeDbSends(): void {
  dbSend.mockImplementation(async (command: { constructor: { name: string } }) => {
    switch (command.constructor.name) {
      case 'DescribeDBClustersCommand':
        return {
          DBClusters: [
            {
              DBClusterIdentifier: 'my-cluster',
              DBClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:my-cluster',
              Status: 'available',
              Port: 27017,
              DBClusterMembers: [],
            },
          ],
        };
      case 'DescribeDBInstancesCommand':
        return {
          DBInstances: [
            {
              DBInstanceIdentifier: 'my-instance',
              DBInstanceArn: 'arn:aws:rds:us-east-1:123456789012:db:my-instance',
              DBInstanceStatus: 'available',
            },
          ],
        };
      default:
        return {};
    }
  });
}

/** The single input of the named command sent. */
function sentInput(name: string): Record<string, unknown> {
  const calls = dbSend.mock.calls.filter((c) => c[0].constructor.name === name);
  expect(calls).toHaveLength(1);
  return (calls[0]![0] as { input: Record<string, unknown> }).input;
}

/** Runs the update the way the deploy engine does: removal prep, then update(). */
async function deployUpdate(
  type: string,
  physicalId: string,
  desired: Record<string, unknown>,
  previous: Record<string, unknown>
): Promise<readonly string[]> {
  const provider = new DocDBProvider();
  const prep = prepareRemovalForUpdate(provider, type, desired, previous);
  await provider.update('L', physicalId, type, prep.properties, previous, { ...prep.context });
  return prep.unhandled;
}

function warnings(): string[] {
  return loggerWarn.mock.calls.map((c) => String(c[0]));
}

describe('DocDBProvider removal of CloudFormation-kept properties (#5543)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeDbSends();
  });

  it('removalHandledInUpdate covers every handled property of both types', () => {
    const provider = new DocDBProvider();
    for (const type of [CLUSTER, INSTANCE]) {
      expect([...provider.removalHandledInUpdate.get(type)!].sort()).toEqual(
        [...provider.handledProperties.get(type)!].sort()
      );
    }
  });

  it('a removed cluster EngineVersion / windows / parameter group sends nothing and is warned about once', async () => {
    const unhandled = await deployUpdate(
      CLUSTER,
      'my-cluster',
      { BackupRetentionPeriod: 2 },
      CLUSTER_PREVIOUS
    );

    expect(unhandled).toEqual([]);
    const input = sentInput('ModifyDBClusterCommand');
    for (const key of CLUSTER_KEPT) expect(input[key], key).toBeUndefined();
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain(
      'L (AWS::DocDB::DBCluster): properties EngineVersion, PreferredBackupWindow, PreferredMaintenanceWindow, DBClusterParameterGroupName were removed from the template; cdkd leaves the current AWS values in place, as CloudFormation does.'
    );
  });

  it('also keeps them when another property changes in the same update', async () => {
    await deployUpdate(CLUSTER, 'my-cluster', { BackupRetentionPeriod: 3 }, CLUSTER_PREVIOUS);

    const input = sentInput('ModifyDBClusterCommand');
    expect(input['BackupRetentionPeriod']).toBe(3);
    for (const key of CLUSTER_KEPT) expect(input[key], key).toBeUndefined();
    expect(warnings()).toHaveLength(1);
  });

  it('a present value is still sent, with no warning (the other polarity)', async () => {
    await deployUpdate(
      CLUSTER,
      'my-cluster',
      { ...CLUSTER_PREVIOUS, PreferredBackupWindow: '08:00-09:00' },
      CLUSTER_PREVIOUS
    );

    const input = sentInput('ModifyDBClusterCommand');
    expect(input['EngineVersion']).toBe('5.0.0');
    expect(input['PreferredBackupWindow']).toBe('08:00-09:00');
    expect(input['PreferredMaintenanceWindow']).toBe('sun:10:00-sun:10:30');
    expect(input['DBClusterParameterGroupName']).toBe('custom-docdb50');
    expect(warnings()).toEqual([]);
  });

  it('a never-declared value stays absent, with no warning', async () => {
    await deployUpdate(
      CLUSTER,
      'my-cluster',
      { BackupRetentionPeriod: 3 },
      { BackupRetentionPeriod: 2 }
    );

    const input = sentInput('ModifyDBClusterCommand');
    for (const key of CLUSTER_KEPT) expect(input[key], key).toBeUndefined();
    expect(warnings()).toEqual([]);
  });

  it('names only the one removed key, in the singular', async () => {
    const { PreferredBackupWindow: _dropped, ...desired } = CLUSTER_PREVIOUS;
    await deployUpdate(CLUSTER, 'my-cluster', desired, CLUSTER_PREVIOUS);

    expect(warnings()).toEqual([
      expect.stringContaining(
        'property PreferredBackupWindow was removed from the template; cdkd leaves the current AWS value in place, as CloudFormation does.'
      ),
    ]);
  });

  it('warns on a direct call (no removedProperties) by comparing the two bags', async () => {
    await new DocDBProvider().update(
      'L',
      'my-cluster',
      CLUSTER,
      { BackupRetentionPeriod: 2 },
      CLUSTER_PREVIOUS
    );

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('DBClusterParameterGroupName');
  });

  it('does not warn on a drift --revert bag (an empty removedProperties)', async () => {
    await new DocDBProvider().update(
      'L',
      'my-cluster',
      CLUSTER,
      { BackupRetentionPeriod: 2 },
      CLUSTER_PREVIOUS,
      { removedProperties: new Set() }
    );

    expect(warnings()).toEqual([]);
  });

  it('a removed instance PreferredMaintenanceWindow sends nothing and is warned about', async () => {
    const { PreferredMaintenanceWindow: _dropped, ...desired } = INSTANCE_PREVIOUS;
    const unhandled = await deployUpdate(INSTANCE, 'my-instance', desired, INSTANCE_PREVIOUS);

    expect(unhandled).toEqual([]);
    expect(sentInput('ModifyDBInstanceCommand')['PreferredMaintenanceWindow']).toBeUndefined();
    expect(warnings()).toEqual([
      expect.stringContaining(
        'L (AWS::DocDB::DBInstance): property PreferredMaintenanceWindow was removed from the template; cdkd leaves the current AWS value in place, as CloudFormation does.'
      ),
    ]);
  });

  it('a present instance PreferredMaintenanceWindow is still sent, with no warning', async () => {
    const desired = { ...INSTANCE_PREVIOUS, PreferredMaintenanceWindow: 'tue:11:00-tue:11:30' };
    await deployUpdate(INSTANCE, 'my-instance', desired, INSTANCE_PREVIOUS);

    expect(sentInput('ModifyDBInstanceCommand')['PreferredMaintenanceWindow']).toBe(
      'tue:11:00-tue:11:30'
    );
    expect(warnings()).toEqual([]);
  });
});
