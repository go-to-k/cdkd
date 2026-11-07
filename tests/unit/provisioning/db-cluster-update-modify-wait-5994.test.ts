// issue #5994: an RDS-family DBCluster update whose ModifyDBCluster AWS
// refuses because the cluster is in a status that ends on its own
// (`backing-up` right after create) waits for `available` and resends the same
// input, as CloudFormation waits it out. A terminal status, and any other
// refusal, still fails at once.
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

function sdkClientMock(clientName: string) {
  return async (importOriginal: () => Promise<unknown>) => ({
    ...((await importOriginal()) as Record<string, unknown>),
    [clientName]: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  });
}

vi.mock('@aws-sdk/client-rds', sdkClientMock('RDSClient'));
vi.mock('@aws-sdk/client-docdb', sdkClientMock('DocDBClient'));
vi.mock('@aws-sdk/client-neptune', sdkClientMock('NeptuneClient'));

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
import { DocDBProvider } from '../../../src/provisioning/providers/docdb-provider.js';
import { NeptuneProvider } from '../../../src/provisioning/providers/neptune-provider.js';
import { isModifyNotAvailableRefusal } from '../../../src/provisioning/providers/db-instance-modify-retry.js';

function awsError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** The refusal read off CloudTrail on the rds-aurora integ (#5994). */
const BACKING_UP = "DB cluster isn't available for modification with status backing-up.";

describe('isModifyNotAvailableRefusal: the "available for modification" wording (#5994)', () => {
  it.each([
    BACKING_UP,
    'DB cluster isn’t available for modification with status backing-up.',
    'DB cluster is not available for modification with status maintenance.',
    // The wording it matched before stays matched.
    "DB cluster isn't currently in the available state",
  ])('matches InvalidDBClusterStateFault "%s"', (message) => {
    expect(isModifyNotAvailableRefusal(awsError('InvalidDBClusterStateFault', message))).toBe(
      true
    );
  });

  it.each([
    ['InvalidDBClusterStateFault', 'Cannot modify engine version without a healthy primary instance'],
    ['InvalidDBClusterStateFault', 'This cluster could not be modified. Please try again'],
    ['InvalidParameterValue', BACKING_UP],
    // The new wording is matched for the CLUSTER fault only.
    ['InvalidDBInstanceStateFault', BACKING_UP],
  ])('does not match %s "%s"', (name, message) => {
    expect(isModifyNotAvailableRefusal(awsError(name, message))).toBe(false);
  });
});

type Provider = {
  update: (
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ) => Promise<unknown>;
};

const cases: Array<{
  name: string;
  type: string;
  make: () => Provider;
  properties: Record<string, unknown>;
  previous: Record<string, unknown>;
}> = [
  {
    name: 'RDS',
    type: 'AWS::RDS::DBCluster',
    make: () => new RDSProvider() as unknown as Provider,
    properties: { Engine: 'aurora-mysql', BacktrackWindow: 7200 },
    previous: { Engine: 'aurora-mysql', BacktrackWindow: 3600 },
  },
  {
    name: 'DocDB',
    type: 'AWS::DocDB::DBCluster',
    make: () => new DocDBProvider() as unknown as Provider,
    properties: { BackupRetentionPeriod: 7 },
    previous: { BackupRetentionPeriod: 1 },
  },
  {
    name: 'Neptune',
    type: 'AWS::Neptune::DBCluster',
    make: () => new NeptuneProvider() as unknown as Provider,
    properties: { BackupRetentionPeriod: 7 },
    previous: { BackupRetentionPeriod: 1 },
  },
];

/**
 * Answers by command: ModifyDBCluster rejects with each of `refusals` in turn,
 * then succeeds; DescribeDBClusters reads each of `statuses` in turn, then
 * `available`; anything else answers `{}`.
 */
function arm(refusals: Error[], statuses: string[]): void {
  const pendingRefusals = [...refusals];
  const pendingStatuses = [...statuses];
  mockSend.mockImplementation(async (command: object) => {
    const name = command.constructor.name;
    if (name === 'ModifyDBClusterCommand') {
      const refusal = pendingRefusals.shift();
      if (refusal !== undefined) throw refusal;
      return {};
    }
    if (name === 'DescribeDBClustersCommand') {
      return {
        DBClusters: [
          {
            DBClusterIdentifier: 'my-cluster',
            DBClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:my-cluster',
            Status: pendingStatuses.shift() ?? 'available',
          },
        ],
      };
    }
    return {};
  });
}

function modifyInputs(): unknown[] {
  return mockSend.mock.calls
    .filter((call) => (call[0] as object).constructor.name === 'ModifyDBClusterCommand')
    .map((call) => (call[0] as { input: unknown }).input);
}

describe.each(cases)('$name DBCluster update waits out a busy cluster (#5994)', (c) => {
  let provider: Provider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = c.make();
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
  });

  it('resends the same ModifyDBCluster once a backing-up cluster reads available', async () => {
    arm([awsError('InvalidDBClusterStateFault', BACKING_UP)], ['backing-up', 'available']);

    await provider.update('MyCluster', 'my-cluster', c.type, c.properties, c.previous);

    const inputs = modifyInputs();
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toEqual(inputs[0]);
    expect(inputs[0]).toMatchObject({ DBClusterIdentifier: 'my-cluster', ApplyImmediately: true });
  });

  it('fails at once, without a resend, when the cluster reads a terminal status', async () => {
    arm([awsError('InvalidDBClusterStateFault', BACKING_UP)], ['inaccessible-encryption-credentials']);

    await expect(
      provider.update('MyCluster', 'my-cluster', c.type, c.properties, c.previous)
    ).rejects.toThrow(/does not end on its own/);
    expect(modifyInputs()).toHaveLength(1);
  });

  it('does not resend after a refusal no wait ends', async () => {
    arm(
      [
        awsError(
          'InvalidDBClusterStateFault',
          'Cannot modify engine version without a healthy primary instance'
        ),
      ],
      []
    );

    await expect(
      provider.update('MyCluster', 'my-cluster', c.type, c.properties, c.previous)
    ).rejects.toThrow(/healthy primary instance/);
    expect(modifyInputs()).toHaveLength(1);
  });

  it('waits out "could not be modified. Please try again" on RDS only', async () => {
    arm(
      [awsError('InvalidDBClusterStateFault', 'This cluster could not be modified. Please try again')],
      ['available']
    );

    const run = provider.update('MyCluster', 'my-cluster', c.type, c.properties, c.previous);
    if (c.name === 'RDS') {
      await run;
      expect(modifyInputs()).toHaveLength(2);
    } else {
      await expect(run).rejects.toThrow(/could not be modified/);
      expect(modifyInputs()).toHaveLength(1);
    }
  });

  it('sends one ModifyDBCluster when AWS accepts it', async () => {
    arm([], []);

    await provider.update('MyCluster', 'my-cluster', c.type, c.properties, c.previous);

    expect(modifyInputs()).toHaveLength(1);
  });
});
