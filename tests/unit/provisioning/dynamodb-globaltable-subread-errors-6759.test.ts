/**
 * go-to-k/cdkd#6759: a SUB-read of `AWS::DynamoDB::GlobalTable.readCurrentState`
 * that fails with anything but its own not-found code rejects the whole read,
 * so `cdkd drift` reports `readFailed` instead of leaving the property out —
 * or, for replica tags, recording `Tags: []` (a false removal). The not-found
 * code keeps today's answer, and a replica AWS is not serving keeps the
 * tolerant reads.
 */
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { ResourceNotFoundException, TableNotFoundException } from '@aws-sdk/client-dynamodb';

const { localSend, remoteSend, autoScalingSend } = vi.hoisted(() => ({
  localSend: vi.fn(),
  remoteSend: vi.fn(),
  autoScalingSend: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: localSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('@aws-sdk/client-application-auto-scaling', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-application-auto-scaling')>();
  return {
    ...actual,
    ApplicationAutoScalingClient: vi.fn((config?: { region?: string }) => ({
      send: (command: unknown) => autoScalingSend(command, config?.region),
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...logger, child: () => logger }) };
});

import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';

const TYPE = 'AWS::DynamoDB::GlobalTable';
const LOCAL_ARN = 'arn:aws:dynamodb:us-east-1:123456789012:table/t1';

const denied = (): Error =>
  Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
const rnf = (): Error => new ResourceNotFoundException({ message: 'gone', $metadata: {} });
const tnf = (): Error => new TableNotFoundException({ message: 'gone', $metadata: {} });

type Command = { constructor: { name: string } };

/** One region's answers; `failing` rejects with `error()`. */
function regionStub(
  failing: string | undefined,
  error: () => Error,
  replicaStatus = 'ACTIVE'
): (command: Command) => Promise<unknown> {
  return (command) => {
    const name = command.constructor.name;
    if (name === failing) return Promise.reject(error());
    switch (name) {
      case 'DescribeTableCommand':
        return Promise.resolve({
          Table: {
            TableName: 't1',
            TableArn: LOCAL_ARN,
            BillingModeSummary: { BillingMode: 'PROVISIONED' },
            ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
            DeletionProtectionEnabled: false,
            Replicas: [{ RegionName: 'eu-west-1', ReplicaStatus: replicaStatus }],
          },
        });
      case 'DescribeContributorInsightsCommand':
        return Promise.resolve({ ContributorInsightsStatus: 'ENABLED' });
      case 'DescribeContinuousBackupsCommand':
        return Promise.resolve({
          ContinuousBackupsDescription: {
            PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'ENABLED' },
          },
        });
      case 'DescribeKinesisStreamingDestinationCommand':
        return Promise.resolve({
          KinesisDataStreamDestinations: [
            { StreamArn: 'arn:aws:kinesis:us-east-1:1:stream/k', DestinationStatus: 'ACTIVE' },
          ],
        });
      case 'ListTagsOfResourceCommand':
        return Promise.resolve({ Tags: [{ Key: 'team', Value: 'a' }] });
      case 'DescribeTimeToLiveCommand':
        return Promise.resolve({
          TimeToLiveDescription: { TimeToLiveStatus: 'ENABLED', AttributeName: 'ttl' },
        });
      case 'GetResourcePolicyCommand':
        return Promise.resolve({ Policy: '{"Version":"2012-10-17","Statement":[]}' });
      default:
        return Promise.resolve({});
    }
  };
}

/** Application Auto Scaling: a registered target with a target-tracking policy. */
function autoScalingStub(failing: boolean): (command: Command) => Promise<unknown> {
  return (command) => {
    if (failing) return Promise.reject(denied());
    if (command.constructor.name === 'DescribeScalableTargetsCommand') {
      return Promise.resolve({ ScalableTargets: [{ MinCapacity: 1, MaxCapacity: 10 }] });
    }
    return Promise.resolve({
      ScalingPolicies: [
        {
          PolicyType: 'TargetTrackingScaling',
          TargetTrackingScalingPolicyConfiguration: { TargetValue: 70 },
        },
      ],
    });
  };
}

const DESIRED = {
  TableName: 't1',
  Replicas: [
    {
      Region: 'us-east-1',
      ResourcePolicy: { PolicyDocument: { Version: '2012-10-17', Statement: [] } },
    },
    {
      Region: 'eu-west-1',
      ResourcePolicy: { PolicyDocument: { Version: '2012-10-17', Statement: [] } },
    },
  ],
};

function makeProvider(): DynamoDBGlobalTableProvider {
  const provider = new DynamoDBGlobalTableProvider();
  const internals = provider as unknown as {
    regionalClientCache: Map<string, unknown>;
    regionalAutoScalingClientCache?: Map<string, unknown>;
  };
  internals.regionalClientCache.set('eu-west-1', {
    send: remoteSend,
    config: { region: () => Promise.resolve('eu-west-1') },
  });
  return provider;
}

async function read(): Promise<Record<string, unknown>> {
  return (await makeProvider().readCurrentState('t1', 'G', TYPE, DESIRED)) as Record<
    string,
    unknown
  >;
}

function replica(result: Record<string, unknown>, region: string): Record<string, unknown> {
  return (result['Replicas'] as Array<Record<string, unknown>>).find(
    (r) => r['Region'] === region
  )!;
}

describe('DynamoDB GlobalTable readCurrentState sub-read failures (go-to-k/cdkd#6759)', () => {
  beforeEach(() => {
    localSend.mockReset();
    remoteSend.mockReset();
    autoScalingSend.mockReset();
    localSend.mockImplementation(regionStub(undefined, denied));
    remoteSend.mockImplementation(regionStub(undefined, denied));
    autoScalingSend.mockImplementation(autoScalingStub(false));
  });

  const replicaCases: Array<{
    command: string;
    key: string;
    notFound: () => Error;
  }> = [
    {
      command: 'DescribeContributorInsightsCommand',
      key: 'ContributorInsightsSpecification',
      notFound: rnf,
    },
    {
      command: 'DescribeContinuousBackupsCommand',
      key: 'PointInTimeRecoverySpecification',
      notFound: tnf,
    },
    {
      command: 'DescribeKinesisStreamingDestinationCommand',
      key: 'KinesisStreamSpecification',
      notFound: rnf,
    },
    {
      command: 'DescribeContinuousBackupsCommand',
      key: 'PointInTimeRecoverySpecification',
      notFound: rnf,
    },
    { command: 'GetResourcePolicyCommand', key: 'ResourcePolicy', notFound: rnf },
    { command: 'DescribeTableCommand', key: 'DeletionProtectionEnabled', notFound: rnf },
  ];

  for (const c of replicaCases) {
    it(`a served replica's ${c.key}: AccessDenied rejects the read`, async () => {
      remoteSend.mockImplementation(regionStub(c.command, denied));
      await expect(read()).rejects.toThrow('not authorized');
    });

    it(`a served replica's ${c.key}: the not-found code omits it`, async () => {
      remoteSend.mockImplementation(regionStub(c.command, c.notFound));
      const result = await read();
      expect(replica(result, 'eu-west-1')[c.key]).toBeUndefined();
      expect(replica(result, 'eu-west-1')['Tags']).toEqual([{ Key: 'team', Value: 'a' }]);
    });
  }

  it("a served replica's Tags: AccessDenied rejects the read (it used to record Tags: [])", async () => {
    remoteSend.mockImplementation(regionStub('ListTagsOfResourceCommand', denied));
    await expect(read()).rejects.toThrow('not authorized');
  });

  it("a served cross-region replica's Tags: the not-found code still reads as []", async () => {
    remoteSend.mockImplementation(regionStub('ListTagsOfResourceCommand', rnf));
    const result = await read();
    expect(replica(result, 'eu-west-1')['Tags']).toEqual([]);
  });

  it('a replica AWS is not serving keeps the tolerant reads', async () => {
    localSend.mockImplementation(regionStub(undefined, denied, 'REGION_DISABLED'));
    remoteSend.mockImplementation(() => Promise.reject(denied()));
    // The replica's own region's Application Auto Scaling fails too.
    autoScalingSend.mockImplementation((command: Command, region?: string) =>
      region === 'eu-west-1' ? Promise.reject(denied()) : autoScalingStub(false)(command)
    );
    const result = await read();
    const remote = replica(result, 'eu-west-1');
    expect(remote['ContributorInsightsSpecification']).toBeUndefined();
    expect(remote['ReadProvisionedThroughputSettings']).toBeUndefined();
    expect(remote['Tags']).toEqual([]);
  });

  it('a replica that is UPDATING is served: its failed sub-read rejects the read', async () => {
    localSend.mockImplementation(regionStub(undefined, denied, 'UPDATING'));
    remoteSend.mockImplementation(regionStub('ListTagsOfResourceCommand', denied, 'UPDATING'));
    await expect(read()).rejects.toThrow('not authorized');
  });

  it('TimeToLiveSpecification: AccessDenied rejects the read', async () => {
    localSend.mockImplementation(regionStub('DescribeTimeToLiveCommand', denied));
    await expect(read()).rejects.toThrow('not authorized');
  });

  it('TimeToLiveSpecification: the not-found code omits it', async () => {
    localSend.mockImplementation(regionStub('DescribeTimeToLiveCommand', rnf));
    const result = await read();
    expect(result['TimeToLiveSpecification']).toBeUndefined();
    expect(result['TableName']).toBe('t1');
  });

  it('an Application Auto Scaling failure rejects the read (it used to read as not autoscaled)', async () => {
    autoScalingSend.mockImplementation(autoScalingStub(true));
    await expect(read()).rejects.toThrow('not authorized');
  });

  it('reads every member when no sub-read fails (the fixture reaches each one)', async () => {
    const result = await read();
    const remote = replica(result, 'eu-west-1');
    for (const c of replicaCases) expect(remote[c.key]).toBeDefined();
    expect(result['TimeToLiveSpecification']).toBeDefined();
    expect(result['WriteProvisionedThroughputSettings']).toEqual({
      WriteCapacityAutoScalingSettings: {
        MinCapacity: 1,
        MaxCapacity: 10,
        TargetTrackingScalingPolicyConfiguration: { TargetValue: 70 },
      },
    });
  });
});
