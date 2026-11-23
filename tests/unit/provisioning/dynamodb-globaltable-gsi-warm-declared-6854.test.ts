/**
 * go-to-k/cdkd#6854: `AWS::DynamoDB::GlobalTable` compares a per-index
 * `WarmThroughput` the template DECLARES (only the declared members), as
 * `AWS::DynamoDB::Table` does, and keeps stripping it for an index that
 * declares none, or when there is no recorded template to decide with.
 *
 * Also pinned: `drift --revert` of a value AWS grew skips the decrease AWS
 * would refuse (the shared #1857 guard) instead of failing, and the readback
 * reads a declared value as where an `UPDATING` raise is heading (#5606).
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DescribeTableCommand, UpdateTableCommand } from '@aws-sdk/client-dynamodb';

const { mockSend, mockAutoScalingSend, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockAutoScalingSend: vi.fn(),
  warnSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('@aws-sdk/client-dynamodb', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-dynamodb')>(
    '@aws-sdk/client-dynamodb'
  );
  return {
    ...actual,
    DynamoDBClient: vi.fn().mockImplementation((cfg: { region?: string } | undefined) => ({
      send: mockSend,
      config: { region: () => Promise.resolve(cfg?.region ?? 'us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-application-auto-scaling', async () => {
  const actual = await vi.importActual<
    typeof import('@aws-sdk/client-application-auto-scaling')
  >('@aws-sdk/client-application-auto-scaling');
  return {
    ...actual,
    ApplicationAutoScalingClient: vi.fn().mockImplementation(() => ({
      send: mockAutoScalingSend,
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';

const T = 'AWS::DynamoDB::GlobalTable';
const TABLE_NAME = 'warm-table';
const TABLE_ARN = `arn:aws:dynamodb:us-east-1:123:table/${TABLE_NAME}`;

type Bag = Record<string, unknown>;

const gsi = (warm?: Bag): Bag => ({
  IndexName: 'gsi1',
  KeySchema: [{ AttributeName: 'g1pk', KeyType: 'HASH' }],
  Projection: { ProjectionType: 'ALL' },
  ...(warm !== undefined && { WarmThroughput: warm }),
});

/** A recorded template bag whose one index declares `warm` (or nothing). */
function template(warm?: Bag): Bag {
  return {
    TableName: TABLE_NAME,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'g1pk', AttributeType: 'S' },
    ],
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [gsi(warm)],
    Replicas: [{ Region: 'us-east-1' }],
  };
}

const COMPUTED = { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 };
const GROWN = { ReadUnitsPerSecond: 20000, WriteUnitsPerSecond: 4000 };

describe('GlobalTable per-index WarmThroughput declaration gate (#6854)', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    mockAutoScalingSend.mockReset();
    warnSpy.mockReset();
    mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
    provider = new DynamoDBGlobalTableProvider();
  });

  async function driftPaths(baseline: Bag, aws: Bag, properties?: Bag): Promise<string[]> {
    const pair = await provider.canonicalizeDriftPair(T, baseline, aws, properties);
    return calculateResourceDrift(pair.baseline, pair.aws, {
      unorderedPaths: provider.getDriftUnorderedPaths(T),
    }).map((d) => d.path.split('.')[0]!);
  }

  it('reports a declared per-index value that differs from live, such as one AWS grew', async () => {
    const declared = template({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 });
    expect(
      await driftPaths(
        { GlobalSecondaryIndexes: [gsi(COMPUTED)] },
        { GlobalSecondaryIndexes: [gsi(GROWN)] },
        declared
      )
    ).toEqual(['GlobalSecondaryIndexes']);
  });

  it('compares only the declared members', async () => {
    const readOnly = template({ ReadUnitsPerSecond: 12000 });
    // The undeclared write member moved: not reported.
    expect(
      await driftPaths(
        { GlobalSecondaryIndexes: [gsi(COMPUTED)] },
        { GlobalSecondaryIndexes: [gsi({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 9000 })] },
        readOnly
      )
    ).toEqual([]);
    // The declared read member moved: reported.
    expect(
      await driftPaths(
        { GlobalSecondaryIndexes: [gsi(COMPUTED)] },
        { GlobalSecondaryIndexes: [gsi({ ReadUnitsPerSecond: 15000, WriteUnitsPerSecond: 4000 })] },
        readOnly
      )
    ).toEqual(['GlobalSecondaryIndexes']);
  });

  it('a template baseline declaring a quoted number equals the same live number', async () => {
    const quoted = template({ ReadUnitsPerSecond: '12000' });
    expect(
      await driftPaths(
        { GlobalSecondaryIndexes: [gsi({ ReadUnitsPerSecond: 12000 })] },
        { GlobalSecondaryIndexes: [gsi(COMPUTED)] },
        quoted
      )
    ).toEqual([]);
  });

  it('keeps stripping an index that declares none, and every index with no recorded template', async () => {
    expect(
      await driftPaths(
        { GlobalSecondaryIndexes: [gsi()] },
        { GlobalSecondaryIndexes: [gsi(GROWN)] },
        template()
      )
    ).toEqual([]);
    expect(
      await driftPaths(
        { GlobalSecondaryIndexes: [gsi(COMPUTED)] },
        { GlobalSecondaryIndexes: [gsi(GROWN)] },
        undefined
      )
    ).toEqual([]);
  });

  it('still reports another member of an index that declares no warm throughput', async () => {
    expect(
      await driftPaths(
        { GlobalSecondaryIndexes: [gsi()] },
        {
          GlobalSecondaryIndexes: [
            { ...gsi(GROWN), Projection: { ProjectionType: 'KEYS_ONLY' } },
          ],
        },
        template()
      )
    ).toEqual(['GlobalSecondaryIndexes']);
  });

  describe('drift --revert of a value AWS grew', () => {
    function stubLive(live: Bag): void {
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof DescribeTableCommand) {
          return Promise.resolve({
            Table: {
              TableName: TABLE_NAME,
              TableArn: TABLE_ARN,
              TableId: 'tid-1',
              TableStatus: 'ACTIVE',
              BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
              GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'ACTIVE', WarmThroughput: live }],
              Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
            },
          });
        }
        return Promise.resolve({});
      });
    }

    it('skips the decrease with a warning instead of failing', async () => {
      stubLive({ ...GROWN, Status: 'ACTIVE' });
      const properties = template({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 });
      const aws = { ...template(GROWN) };
      // What `runRevert` sends: the recorded baseline through the pair hook,
      // against the raw readback as the previous side.
      const desired = (
        await provider.canonicalizeDriftPair(T, template(COMPUTED), aws, properties)
      ).baseline;
      expect((desired['GlobalSecondaryIndexes'] as Bag[])[0]!['WarmThroughput']).toEqual(COMPUTED);

      await expect(provider.update('Warm', TABLE_NAME, T, desired, aws)).resolves.toBeDefined();

      const gsiUpdates = mockSend.mock.calls
        .map((c) => c[0])
        .filter(
          (c): c is UpdateTableCommand =>
            c instanceof UpdateTableCommand &&
            (c.input.GlobalSecondaryIndexUpdates ?? []).some((u) => u.Update !== undefined)
        );
      expect(gsiUpdates).toHaveLength(0);
      expect(
        warnSpy.mock.calls.map((c) => String(c[0])).filter((w) => w.includes('WarmThroughput was NOT sent'))
      ).toHaveLength(1);
    });
  });

  describe('readback while a declared raise is UPDATING (#5606)', () => {
    function stubDescribe(warm: Bag): void {
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        switch (command.constructor.name) {
          case 'DescribeTableCommand':
            return Promise.resolve({
              Table: {
                TableName: TABLE_NAME,
                TableArn: TABLE_ARN,
                BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
                Replicas: [{ RegionName: 'us-east-1' }],
                GlobalSecondaryIndexes: [{ ...gsi(), WarmThroughput: warm }],
              },
            });
          case 'DescribeContributorInsightsCommand':
            return Promise.resolve({ ContributorInsightsStatus: 'DISABLED' });
          case 'DescribeContinuousBackupsCommand':
            return Promise.resolve({
              ContinuousBackupsDescription: {
                ContinuousBackupsStatus: 'ENABLED',
                PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'DISABLED' },
              },
            });
          case 'DescribeKinesisStreamingDestinationCommand':
            return Promise.resolve({ KinesisDataStreamDestinations: [] });
          case 'ListTagsOfResourceCommand':
            return Promise.resolve({ Tags: [] });
          case 'DescribeTimeToLiveCommand':
            return Promise.resolve({ TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' } });
          default:
            return Promise.resolve({});
        }
      });
    }

    async function readWarm(properties: Bag | undefined): Promise<unknown> {
      const bag = (await provider.readCurrentState(TABLE_NAME, 'Warm', T, properties)) as Bag;
      return (bag['GlobalSecondaryIndexes'] as Bag[])[0]!['WarmThroughput'];
    }

    it('reads a declared value as where the raise is heading', async () => {
      stubDescribe({ ReadUnitsPerSecond: 8000, WriteUnitsPerSecond: 4000, Status: 'UPDATING' });
      expect(await readWarm(template({ ReadUnitsPerSecond: 12000 }))).toEqual({
        ReadUnitsPerSecond: 12000,
        WriteUnitsPerSecond: 4000,
      });
    });

    it('reads the live value once settled, and for an index that declares none', async () => {
      stubDescribe({ ReadUnitsPerSecond: 8000, WriteUnitsPerSecond: 4000, Status: 'ACTIVE' });
      expect(await readWarm(template({ ReadUnitsPerSecond: 12000 }))).toEqual({
        ReadUnitsPerSecond: 8000,
        WriteUnitsPerSecond: 4000,
      });
      stubDescribe({ ReadUnitsPerSecond: 8000, WriteUnitsPerSecond: 4000, Status: 'UPDATING' });
      expect(await readWarm(template())).toEqual({
        ReadUnitsPerSecond: 8000,
        WriteUnitsPerSecond: 4000,
      });
    });
  });
});
