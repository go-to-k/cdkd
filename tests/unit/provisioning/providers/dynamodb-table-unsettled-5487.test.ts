/**
 * go-to-k/cdkd#5487: the DynamoDB table `update()` marks each key just before
 * the call that changes it (`UpdateContext.markUnsettled`), `readUnsettled`
 * reports the template-shaped values the engine's convergence step compares
 * (no 0/0 ProvisionedThroughput on PAY_PER_REQUEST, strict reads of the
 * separately-applied settings), and `unsettledInTransition` reports what AWS
 * is still changing (table / index / SSE / TTL / Kinesis).
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-dynamodb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-dynamodb')>();
  return {
    ...actual,
    DynamoDBClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});
vi.mock('../../../../src/utils/logger.js', () => {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  child.child.mockReturnValue(child);
  return { getLogger: () => ({ ...child, child: () => child }) };
});

import { PolicyNotFoundException } from '@aws-sdk/client-dynamodb';
import { DynamoDBTableProvider } from '../../../../src/provisioning/providers/dynamodb-table-provider.js';
import { ProvisioningError } from '../../../../src/utils/error-handler.js';

const TYPE = 'AWS::DynamoDB::Table';
const ARN = 'arn:aws:dynamodb:us-east-1:123456789012:table/t';
const KEYS = {
  TableName: 't',
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
};

interface Live {
  status?: string;
  billing?: 'PROVISIONED' | 'PAY_PER_REQUEST';
  gsiStatus?: string;
  sse?: string;
  ttl?: string;
  failPitr?: boolean;
  tags?: Array<{ Key: string; Value: string }>;
  deletionProtection?: boolean;
  noArn?: boolean;
  /** GetResourcePolicy answers PolicyNotFoundException (the table has none). */
  noPolicy?: boolean;
}

function serve(live: Live): void {
  mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
    switch (cmd.constructor.name) {
      case 'DescribeTableCommand':
        return {
          Table: {
            TableName: 't',
            ...(live.noArn !== true && { TableArn: ARN }),
            TableStatus: live.status ?? 'ACTIVE',
            KeySchema: KEYS.KeySchema,
            AttributeDefinitions: KEYS.AttributeDefinitions,
            BillingModeSummary: { BillingMode: live.billing ?? 'PAY_PER_REQUEST' },
            ProvisionedThroughput:
              (live.billing ?? 'PAY_PER_REQUEST') === 'PAY_PER_REQUEST'
                ? { ReadCapacityUnits: 0, WriteCapacityUnits: 0 }
                : { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
            DeletionProtectionEnabled: live.deletionProtection ?? false,
            ...(live.gsiStatus !== undefined && {
              GlobalSecondaryIndexes: [
                {
                  IndexName: 'g',
                  IndexStatus: live.gsiStatus,
                  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
                  Projection: { ProjectionType: 'ALL' },
                },
              ],
            }),
            ...(live.sse !== undefined && { SSEDescription: { Status: live.sse, SSEType: 'KMS' } }),
          },
        };
      case 'DescribeContinuousBackupsCommand':
        if (live.failPitr === true) throw new Error('throttled');
        return {
          ContinuousBackupsDescription: {
            PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'DISABLED' },
          },
        };
      case 'DescribeTimeToLiveCommand':
        return { TimeToLiveDescription: { TimeToLiveStatus: live.ttl ?? 'DISABLED' } };
      case 'ListTagsOfResourceCommand':
        return { Tags: live.tags ?? [] };
      case 'DescribeKinesisStreamingDestinationCommand':
        return { KinesisDataStreamDestinations: [] };
      case 'DescribeContributorInsightsCommand':
        return { ContributorInsightsStatus: 'DISABLED' };
      case 'GetResourcePolicyCommand':
        if (live.noPolicy === true) {
          throw new PolicyNotFoundException({ message: 'no policy', $metadata: {} });
        }
        return { Policy: '{"Version":"2012-10-17","Statement":[]}' };
      default:
        return {};
    }
  });
}

const sent = (name: string) =>
  mockSend.mock.calls.map((c) => c[0]).filter((c) => c.constructor.name === name);
const writes = () =>
  mockSend.mock.calls.filter((c) => !/^(Describe|List|Get)/.test(c[0].constructor.name)).length;

function marker(): { marks: string[]; writesAt: number[]; markUnsettled: (k: string) => void } {
  const marks: string[] = [];
  const writesAt: number[] = [];
  return {
    marks,
    writesAt,
    markUnsettled: (k: string) => {
      marks.push(k);
      writesAt.push(writes());
    },
  };
}

describe('DynamoDB table unsettled properties (go-to-k/cdkd#5487)', () => {
  let provider: DynamoDBTableProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DynamoDBTableProvider();
  });

  it('a billing flip marks BillingMode and ProvisionedThroughput before its UpdateTable', async () => {
    serve({ billing: 'PROVISIONED' });
    const m = marker();
    await provider.update(
      'T',
      't',
      TYPE,
      { ...KEYS, BillingMode: 'PAY_PER_REQUEST' },
      { ...KEYS, BillingMode: 'PROVISIONED', ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 } },
      { markUnsettled: m.markUnsettled }
    );
    expect(sent('UpdateTableCommand').length).toBeGreaterThan(0);
    expect(m.marks).toEqual(expect.arrayContaining(['BillingMode', 'ProvisionedThroughput']));
    expect(m.writesAt.every((n) => n === 0)).toBe(true);
  });

  it('DeletionProtectionEnabled and PITR are marked before their own calls', async () => {
    serve({});
    const m = marker();
    await provider.update(
      'T',
      't',
      TYPE,
      {
        ...KEYS,
        BillingMode: 'PAY_PER_REQUEST',
        DeletionProtectionEnabled: true,
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      },
      { ...KEYS, BillingMode: 'PAY_PER_REQUEST' },
      { markUnsettled: m.markUnsettled }
    );
    expect(m.marks).toEqual(['DeletionProtectionEnabled', 'PointInTimeRecoverySpecification']);
    expect(m.writesAt).toEqual([0, 1]);
  });

  it.each([
    ['TimeToLiveSpecification', { AttributeName: 'ttl', Enabled: true }],
    ['ContributorInsightsSpecification', { Enabled: true }],
    ['ResourcePolicy', { PolicyDocument: { Version: '2012-10-17', Statement: [] } }],
  ])('%s is marked before its own call', async (key, value) => {
    serve({});
    const m = marker();
    await provider.update(
      'T',
      't',
      TYPE,
      { ...KEYS, BillingMode: 'PAY_PER_REQUEST', [key]: value },
      { ...KEYS, BillingMode: 'PAY_PER_REQUEST' },
      { markUnsettled: m.markUnsettled }
    );
    expect(m.marks).toEqual([key]);
    expect(m.writesAt).toEqual([0]);
    expect(writes()).toBeGreaterThan(0);
  });

  it('a per-index Contributor Insights change marks GlobalSecondaryIndexes before its call; an unchanged one marks nothing', async () => {
    const gsi = (insights?: boolean) => ({
      IndexName: 'g',
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      Projection: { ProjectionType: 'ALL' },
      ...(insights !== undefined && { ContributorInsightsSpecification: { Enabled: insights } }),
    });
    serve({ gsiStatus: 'ACTIVE' });
    const m = marker();
    await provider.update(
      'T',
      't',
      TYPE,
      { ...KEYS, BillingMode: 'PAY_PER_REQUEST', GlobalSecondaryIndexes: [gsi(true)] },
      { ...KEYS, BillingMode: 'PAY_PER_REQUEST', GlobalSecondaryIndexes: [gsi(false)] },
      { markUnsettled: m.markUnsettled }
    );
    const ci = sent('UpdateContributorInsightsCommand').filter((c) => c.input.IndexName === 'g');
    expect(ci).toHaveLength(1);
    // Once at the index block's gate, and again immediately before the
    // per-index insights call itself, with no write between the two.
    expect(m.marks.filter((k) => k === 'GlobalSecondaryIndexes')).toHaveLength(2);
    expect(m.writesAt[m.marks.lastIndexOf('GlobalSecondaryIndexes')]).toBe(writes() - 1);
    vi.clearAllMocks();
    serve({ gsiStatus: 'ACTIVE' });
    const unchanged = marker();
    await provider.update(
      'T',
      't',
      TYPE,
      { ...KEYS, BillingMode: 'PAY_PER_REQUEST', GlobalSecondaryIndexes: [gsi(true)] },
      { ...KEYS, BillingMode: 'PAY_PER_REQUEST', GlobalSecondaryIndexes: [gsi(true)] },
      { markUnsettled: unchanged.markUnsettled }
    );
    expect(sent('UpdateContributorInsightsCommand')).toHaveLength(0);
    expect(unchanged.marks).toEqual([]);
  });

  it('marks nothing for an update that sends nothing, and Tags only when the tag plan writes', async () => {
    serve({});
    const m = marker();
    await provider.update(
      'T',
      't',
      TYPE,
      { ...KEYS, BillingMode: 'PAY_PER_REQUEST', Tags: [{ Key: 'a', Value: '1' }] },
      { ...KEYS, BillingMode: 'PAY_PER_REQUEST', Tags: [{ Value: '1', Key: 'a' }] },
      { markUnsettled: m.markUnsettled }
    );
    expect(m.marks).toEqual([]);
    expect(writes()).toBe(0);
  });

  it('unsettled Tags re-send every template tag and remove only recorded tags the template dropped', async () => {
    serve({ tags: [{ Key: 'operator', Value: 'keep' }] });
    await provider.update(
      'T',
      't',
      TYPE,
      { ...KEYS, BillingMode: 'PAY_PER_REQUEST', Tags: [{ Key: 'a', Value: '1' }] },
      {
        ...KEYS,
        BillingMode: 'PAY_PER_REQUEST',
        Tags: [
          { Key: 'a', Value: '1' },
          { Key: 'gone', Value: 'x' },
        ],
      },
      { unsettledProperties: new Set(['Tags']) }
    );
    expect(sent('TagResourceCommand').map((c) => c.input.Tags)).toEqual([[{ Key: 'a', Value: '1' }]]);
    expect(sent('UntagResourceCommand').map((c) => c.input.TagKeys)).toEqual([['gone']]);
  });

  it('readUnsettled: no ProvisionedThroughput on a PAY_PER_REQUEST table, the live one on PROVISIONED', async () => {
    serve({ billing: 'PAY_PER_REQUEST' });
    const ppr = (await provider.readUnsettled('t', 'T', TYPE, new Set(['BillingMode']), KEYS)) as Record<
      string,
      unknown
    >;
    expect(ppr['BillingMode']).toBe('PAY_PER_REQUEST');
    expect(ppr).not.toHaveProperty('ProvisionedThroughput');
    // readCurrentState itself keeps AWS's 0/0 (the drift snapshot).
    const snapshot = (await provider.readCurrentState('t', 'T', TYPE, KEYS)) as Record<string, unknown>;
    expect(snapshot['ProvisionedThroughput']).toEqual({ ReadCapacityUnits: 0, WriteCapacityUnits: 0 });
    serve({ billing: 'PROVISIONED' });
    const prov = (await provider.readUnsettled('t', 'T', TYPE, new Set(['BillingMode']), KEYS)) as Record<
      string,
      unknown
    >;
    expect(prov['ProvisionedThroughput']).toEqual({ ReadCapacityUnits: 5, WriteCapacityUnits: 5 });
  });

  it('readUnsettled reads an unsettled separately-applied setting strictly', async () => {
    serve({ failPitr: true });
    await expect(
      provider.readUnsettled('t', 'T', TYPE, new Set(['PointInTimeRecoverySpecification']), KEYS)
    ).rejects.toThrow('throttled');
    // Not unsettled: readCurrentState's tolerance stands.
    await expect(provider.readUnsettled('t', 'T', TYPE, new Set(['BillingMode']), KEYS)).resolves.toBeDefined();
  });

  it('unsettledInTransition: each moving part names its key, a settled table none, a failed read all', async () => {
    const all = new Set([
      'BillingMode',
      'GlobalSecondaryIndexes',
      'SSESpecification',
      'TimeToLiveSpecification',
      'Tags',
      'PointInTimeRecoverySpecification',
    ]);
    serve({ status: 'UPDATING' });
    expect([...(await provider.unsettledInTransition('t', 'T', TYPE, all))].sort()).toEqual([
      'BillingMode',
      'GlobalSecondaryIndexes',
      'SSESpecification',
    ]);
    serve({ gsiStatus: 'CREATING' });
    expect([...(await provider.unsettledInTransition('t', 'T', TYPE, all))]).toEqual(['GlobalSecondaryIndexes']);
    serve({ sse: 'UPDATING' });
    expect([...(await provider.unsettledInTransition('t', 'T', TYPE, all))]).toEqual(['SSESpecification']);
    serve({ ttl: 'ENABLING' });
    expect([...(await provider.unsettledInTransition('t', 'T', TYPE, all))]).toEqual(['TimeToLiveSpecification']);
    serve({ gsiStatus: 'ACTIVE', sse: 'ENABLED' });
    expect((await provider.unsettledInTransition('t', 'T', TYPE, all)).size).toBe(0);
    mockSend.mockRejectedValue(new Error('throttled'));
    expect((await provider.unsettledInTransition('t', 'T', TYPE, all)).size).toBe(all.size);
  });

  it('readUnsettled: an unsettled ResourcePolicy on a table with none reads as absent, not a refusal', async () => {
    serve({ noPolicy: true });
    const live = (await provider.readUnsettled('t', 'T', TYPE, new Set(['ResourcePolicy']), KEYS)) as Record<
      string,
      unknown
    >;
    expect(live).not.toHaveProperty('ResourcePolicy');
    serve({});
    const held = (await provider.readUnsettled('t', 'T', TYPE, new Set(['ResourcePolicy']), KEYS)) as Record<
      string,
      unknown
    >;
    expect(held).toHaveProperty('ResourcePolicy');
  });

  it('readUnsettled: a table with no TableArn refuses the ResourcePolicy read as a ProvisioningError', async () => {
    serve({ noArn: true });
    await expect(
      provider.readUnsettled('t', 'T', TYPE, new Set(['ResourcePolicy']), KEYS)
    ).rejects.toBeInstanceOf(ProvisioningError);
  });

  it.each(['CREATING', 'UPDATING', 'DELETING'])('a table %s is moving', async (status) => {
    serve({ status });
    expect([...(await provider.unsettledInTransition('t', 'T', TYPE, new Set(['BillingMode'])))]).toEqual([
      'BillingMode',
    ]);
  });

  it.each(['INACCESSIBLE_ENCRYPTION_CREDENTIALS', 'ARCHIVING', 'ARCHIVED', 'REPLICATION_NOT_AUTHORIZED'])(
    'a table %s is at rest: the update runs, so AWS names the cause',
    async (status) => {
      serve({ status });
      expect((await provider.unsettledInTransition('t', 'T', TYPE, new Set(['BillingMode']))).size).toBe(0);
    }
  );

  it.each([
    ['DELETING', true],
    ['UPDATING', true],
    ['ACTIVE', false],
  ])('an index %s moves GlobalSecondaryIndexes: %s', async (gsiStatus, moving) => {
    serve({ gsiStatus });
    expect(
      (await provider.unsettledInTransition('t', 'T', TYPE, new Set(['GlobalSecondaryIndexes']))).size
    ).toBe(moving ? 1 : 0);
  });

  it('a TTL DISABLING is not moving, and reads as its destination (no TTL)', async () => {
    serve({ ttl: 'DISABLING' });
    expect((await provider.unsettledInTransition('t', 'T', TYPE, new Set(['TimeToLiveSpecification']))).size).toBe(0);
    const live = (await provider.readUnsettled('t', 'T', TYPE, new Set(['TimeToLiveSpecification']), KEYS)) as Record<
      string,
      unknown
    >;
    expect(live).not.toHaveProperty('TimeToLiveSpecification');
  });

  it('a refused TTL attribute-name change marks nothing', async () => {
    mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'DescribeTimeToLiveCommand') {
        return { TimeToLiveDescription: { TimeToLiveStatus: 'ENABLED', AttributeName: 'old' } };
      }
      if (cmd.constructor.name === 'DescribeTableCommand') {
        return { Table: { TableName: 't', TableArn: ARN, TableStatus: 'ACTIVE', BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' } } };
      }
      return {};
    });
    const m = marker();
    await provider
      .update(
        'T',
        't',
        TYPE,
        { ...KEYS, BillingMode: 'PAY_PER_REQUEST', TimeToLiveSpecification: { AttributeName: 'new', Enabled: true } },
        { ...KEYS, BillingMode: 'PAY_PER_REQUEST', TimeToLiveSpecification: { AttributeName: 'old', Enabled: true } },
        { markUnsettled: m.markUnsettled }
      )
      .catch(() => undefined);
    expect(m.marks).not.toContain('TimeToLiveSpecification');
    expect(sent('UpdateTimeToLiveCommand')).toHaveLength(0);
  });

  it('a ResourcePolicy change on a table with no TableArn marks nothing', async () => {
    serve({ noArn: true });
    const m = marker();
    await provider
      .update(
        'T',
        't',
        TYPE,
        { ...KEYS, BillingMode: 'PAY_PER_REQUEST', ResourcePolicy: { PolicyDocument: { Statement: [] } } },
        { ...KEYS, BillingMode: 'PAY_PER_REQUEST' },
        { markUnsettled: m.markUnsettled }
      )
      .catch(() => undefined);
    expect(m.marks).not.toContain('ResourcePolicy');
  });
});
