/**
 * go-to-k/cdkd#6759: a SUB-read of `AWS::DynamoDB::Table.readCurrentState`
 * (one extra call for one property) that fails with anything but its own
 * not-found code rejects the whole read, so `cdkd drift` reports the table
 * `readFailed` instead of leaving the property out of the comparison. The
 * not-found code still omits the property, as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { ResourceNotFoundException, TableNotFoundException } from '@aws-sdk/client-dynamodb';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...logger, child: () => logger }) };
});

import { DynamoDBTableProvider } from '../../../src/provisioning/providers/dynamodb-table-provider.js';

const TYPE = 'AWS::DynamoDB::Table';
const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:123456789012:table/t1';
const STREAM_ARN = `${TABLE_ARN}/stream/2026-01-01T00:00:00.000`;

const denied = (): Error => Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
const rnf = (): Error => new ResourceNotFoundException({ message: 'gone', $metadata: {} });
const tnf = (): Error => new TableNotFoundException({ message: 'gone', $metadata: {} });

/** Every call answers a configured table, except `failing`, which rejects with `error()`. */
function stub(failing: string, error: () => Error, failIndexOnly = false) {
  mockSend.mockImplementation((command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    const isIndexRead = name === 'DescribeContributorInsightsCommand' && command.input['IndexName'] !== undefined;
    const isStreamRead = command.input['ResourceArn'] === STREAM_ARN;
    if (
      name === failing &&
      (failing !== 'DescribeContributorInsightsCommand' || isIndexRead === failIndexOnly) &&
      (failing !== 'GetResourcePolicyCommand' || isStreamRead === failIndexOnly) &&
      (failing !== 'ListTagsOfResourceCommand' || isStreamRead === failIndexOnly)
    ) {
      return Promise.reject(error());
    }
    switch (name) {
      case 'DescribeTableCommand':
        return Promise.resolve({
          Table: {
            TableName: 't1',
            TableArn: TABLE_ARN,
            TableStatus: 'ACTIVE',
            LatestStreamArn: STREAM_ARN,
            StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_IMAGE' },
            KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
            GlobalSecondaryIndexes: [
              { IndexName: 'gsi1', KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }] },
            ],
          },
        });
      case 'ListTagsOfResourceCommand':
        return Promise.resolve({ Tags: [{ Key: 'team', Value: 'a' }] });
      case 'DescribeContinuousBackupsCommand':
        return Promise.resolve({
          ContinuousBackupsDescription: {
            PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'ENABLED' },
          },
        });
      case 'DescribeTimeToLiveCommand':
        return Promise.resolve({
          TimeToLiveDescription: { TimeToLiveStatus: 'ENABLED', AttributeName: 'ttl' },
        });
      case 'GetResourcePolicyCommand':
        return Promise.resolve({ Policy: '{"Version":"2012-10-17","Statement":[]}' });
      case 'DescribeKinesisStreamingDestinationCommand':
        return Promise.resolve({
          KinesisDataStreamDestinations: [
            { StreamArn: 'arn:aws:kinesis:us-east-1:123456789012:stream/k', DestinationStatus: 'ACTIVE' },
          ],
        });
      case 'DescribeContributorInsightsCommand':
        return Promise.resolve({ ContributorInsightsStatus: 'ENABLED' });
      default:
        return Promise.resolve({});
    }
  });
}

/** A desired bag that declares the gated members, so every sub-read runs. */
const DESIRED = {
  TableName: 't1',
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  GlobalSecondaryIndexes: [
    {
      IndexName: 'gsi1',
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      ContributorInsightsSpecification: { Enabled: true },
    },
  ],
  StreamSpecification: {
    StreamViewType: 'NEW_IMAGE',
    ResourcePolicy: { PolicyDocument: { Version: '2012-10-17', Statement: [] } },
    Tags: [{ Key: 'stream', Value: 's' }],
  },
};

async function read(): Promise<Record<string, unknown>> {
  const provider = new DynamoDBTableProvider();
  // No re-ask waits: the stream members are read once.
  (provider as unknown as { streamMemberRereadDelaysMs: number[] }).streamMemberRereadDelaysMs = [];
  return (await provider.readCurrentState('t1', 'T', TYPE, DESIRED)) as Record<string, unknown>;
}

describe('DynamoDB Table readCurrentState sub-read failures (go-to-k/cdkd#6759)', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  const cases: Array<{
    what: string;
    command: string;
    notFound: () => Error;
    absent: (r: Record<string, unknown>) => unknown;
    indexOrStream?: boolean;
  }> = [
    {
      what: 'PointInTimeRecoverySpecification',
      command: 'DescribeContinuousBackupsCommand',
      notFound: tnf,
      absent: (r) => r['PointInTimeRecoverySpecification'],
    },
    {
      what: 'TimeToLiveSpecification',
      command: 'DescribeTimeToLiveCommand',
      notFound: rnf,
      absent: (r) => r['TimeToLiveSpecification'],
    },
    {
      what: 'ResourcePolicy',
      command: 'GetResourcePolicyCommand',
      notFound: rnf,
      absent: (r) => r['ResourcePolicy'],
    },
    {
      what: 'KinesisStreamSpecification',
      command: 'DescribeKinesisStreamingDestinationCommand',
      notFound: rnf,
      absent: (r) => r['KinesisStreamSpecification'],
    },
    {
      what: 'ContributorInsightsSpecification (table)',
      command: 'DescribeContributorInsightsCommand',
      notFound: rnf,
      absent: (r) => r['ContributorInsightsSpecification'],
    },
    {
      what: 'ContributorInsightsSpecification (index)',
      command: 'DescribeContributorInsightsCommand',
      notFound: rnf,
      absent: (r) =>
        (r['GlobalSecondaryIndexes'] as Array<Record<string, unknown>>)[0]![
          'ContributorInsightsSpecification'
        ],
      indexOrStream: true,
    },
    {
      what: 'StreamSpecification.ResourcePolicy',
      command: 'GetResourcePolicyCommand',
      notFound: rnf,
      absent: (r) => (r['StreamSpecification'] as Record<string, unknown>)['ResourcePolicy'],
      indexOrStream: true,
    },
    {
      what: 'StreamSpecification.Tags',
      command: 'ListTagsOfResourceCommand',
      notFound: rnf,
      absent: (r) => (r['StreamSpecification'] as Record<string, unknown>)['Tags'],
      indexOrStream: true,
    },
  ];

  for (const c of cases) {
    it(`${c.what}: AccessDenied rejects the read`, async () => {
      stub(c.command, denied, c.indexOrStream === true);
      await expect(read()).rejects.toThrow('not authorized');
    });

    it(`${c.what}: the not-found code still omits it`, async () => {
      stub(c.command, c.notFound, c.indexOrStream === true);
      const result = await read();
      expect(c.absent(result)).toBeUndefined();
      // The rest of the read is still there.
      expect(result['TableName']).toBe('t1');
    });
  }

  it('reads every member when no sub-read fails (the fixture reaches each one)', async () => {
    stub('none', denied);
    const result = await read();
    for (const c of cases) expect(c.absent(result)).toBeDefined();
  });
});
