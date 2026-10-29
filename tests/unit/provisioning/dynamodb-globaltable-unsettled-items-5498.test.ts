/**
 * go-to-k/cdkd#5498 — see the describe block.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));
vi.mock('@aws-sdk/client-dynamodb', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-dynamodb')>('@aws-sdk/client-dynamodb');
  return {
    ...actual,
    DynamoDBClient: vi.fn().mockImplementation((cfg: { region?: string } | undefined) => ({
      send: (command: unknown) => mockSend(command, cfg?.region ?? 'us-east-1'),
      config: { region: () => Promise.resolve(cfg?.region ?? 'us-east-1') },
    })),
  };
});
vi.mock('@aws-sdk/client-application-auto-scaling', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-application-auto-scaling')>(
    '@aws-sdk/client-application-auto-scaling'
  );
  return { ...actual, ApplicationAutoScalingClient: vi.fn().mockImplementation(() => ({ send: vi.fn(async () => ({})) })) };
});
vi.mock('../../../src/utils/logger.js', () => {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  child.child.mockReturnValue(child);
  return { getLogger: () => ({ ...child, child: () => child }) };
});

import { ResourceNotFoundException } from '@aws-sdk/client-dynamodb';
import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { getLogger } from '../../../src/utils/logger.js';

const warned = (): string[] =>
  (getLogger().warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));

const TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE = 'gt';
const ARN = `arn:aws:dynamodb:us-east-1:123456789012:table/${TABLE}`;

interface Live {
  /** Throw on an UpdateTable carrying a GSI Create / a replica Create, or on TagResource. */
  failCreateIndex?: boolean;
  failCreateReplica?: boolean;
  failTag?: boolean;
  status?: string;
  replicaStatus?: string;
  gsiStatus?: string;
  sse?: string;
  ttl?: string;
  tags?: Array<{ Key: string; Value: string }>;
  failInsights?: boolean;
  failTtl?: boolean;
  /** A live replica entry with no RegionName (an unkeyable entry). */
  replicaUnnamed?: boolean;
  /** The live index's key attribute. */
  gsiKey?: string;
  /** The local replica's live CMK (with `sse: 'ENABLED'`). */
  kmsKey?: string;
  billing?: 'PAY_PER_REQUEST' | 'PROVISIONED';
  /** A cross-region replica, and what its own region answers. */
  remote?: { status: string; notFound?: boolean; regionError?: boolean; deletionProtection?: boolean };
  localDeletionProtection?: boolean;
}

function serve(live: Live): void {
  mockSend.mockImplementation(async (cmd: { constructor: { name: string } }, region = 'us-east-1') => {
    if (region === 'eu-west-1' && live.remote?.notFound === true) {
      throw new ResourceNotFoundException({ message: 'not found', $metadata: {} });
    }
    if (region === 'eu-west-1' && live.remote?.regionError === true) {
      throw Object.assign(new Error('The security token included in the request is invalid'), {
        name: 'UnrecognizedClientException',
      });
    }
    const input = (cmd as unknown as { input?: Record<string, any> }).input ?? {};
    switch (cmd.constructor.name) {
      case 'UpdateTableCommand':
        if (live.failCreateIndex === true && input['GlobalSecondaryIndexUpdates']?.[0]?.Create) {
          throw new Error('LimitExceededException');
        }
        if (live.failCreateReplica === true && input['ReplicaUpdates']?.[0]?.Create) {
          throw new Error('LimitExceededException');
        }
        return {};
      case 'TagResourceCommand':
        if (live.failTag === true) throw new Error('AccessDenied');
        return {};
      case 'DescribeTableCommand':
        if (region === 'eu-west-1') {
          return {
            Table: {
              TableName: TABLE,
              TableArn: ARN.replace('us-east-1', 'eu-west-1'),
              TableStatus: 'ACTIVE',
              DeletionProtectionEnabled: live.remote?.deletionProtection ?? false,
            },
          };
        }
        return {
          Table: {
            TableName: TABLE,
            TableArn: ARN,
            TableStatus: live.status ?? 'ACTIVE',
            KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
            AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
            BillingModeSummary: { BillingMode: live.billing ?? 'PAY_PER_REQUEST' },
            DeletionProtectionEnabled: live.localDeletionProtection ?? false,
            Replicas: [
              { RegionName: 'us-east-1', ReplicaStatus: live.replicaStatus ?? 'ACTIVE' },
              ...(live.remote !== undefined
                ? [{ RegionName: 'eu-west-1', ReplicaStatus: live.remote.status }]
                : []),
              ...(live.replicaUnnamed === true ? [{ ReplicaStatus: 'ACTIVE' }] : []),
            ],
            ...(live.gsiStatus !== undefined && {
              GlobalSecondaryIndexes: [
                {
                  IndexName: 'g',
                  IndexStatus: live.gsiStatus,
                  KeySchema: [{ AttributeName: live.gsiKey ?? 'pk', KeyType: 'HASH' }],
                  Projection: { ProjectionType: 'ALL' },
                  // A per-replica read ceiling, which the readback lists in the
                  // local replica's own index entries.
                  OnDemandThroughput: { MaxReadRequestUnits: 10 },
                },

              ],
            }),
            ...(live.sse !== undefined && {
              SSEDescription: {
                Status: live.sse,
                ...(live.kmsKey !== undefined && { SSEType: 'KMS', KMSMasterKeyArn: live.kmsKey }),
              },
            }),
          },
        };
      case 'ListTagsOfResourceCommand':
        return { Tags: live.tags ?? [] };
      case 'DescribeTimeToLiveCommand':
        if (live.failTtl === true) throw new Error('ttl throttled');
        return { TimeToLiveDescription: { TimeToLiveStatus: live.ttl ?? 'DISABLED' } };
      case 'DescribeContributorInsightsCommand':
        if (live.failInsights === true) throw new Error('throttled');
        return { ContributorInsightsStatus: 'DISABLED' };
      case 'DescribeContinuousBackupsCommand':
        return { ContinuousBackupsDescription: { PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'DISABLED' } } };
      case 'DescribeKinesisStreamingDestinationCommand':
        return { KinesisDataStreamDestinations: [] };
      default:
        return {};
    }
  });
}

const sent = (name: string) =>
  mockSend.mock.calls.map((c) => c[0]).filter((c) => c.constructor.name === name);
const WRITE = /^(Update|Tag|Untag|Put|Delete|Enable|Disable|Register|Deregister)/;
const writes = () => mockSend.mock.calls.filter((c) => WRITE.test(c[0].constructor.name)).length;

const props = (extra: Record<string, unknown> = {}, replica: Record<string, unknown> = {}) => ({
  TableName: TABLE,
  BillingMode: 'PAY_PER_REQUEST',
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  Replicas: [{ Region: 'us-east-1', ...replica }],
  ...extra,
});

const GSI = 'GlobalSecondaryIndexes';
const sink = () => {
  const items: Array<[string, string[]]> = [];
  const writesAt: number[] = [];
  return {
    items,
    writesAt,
    markAttempted: (path: string, names: readonly string[]) => {
      items.push([path, [...names]]);
      writesAt.push(writes());
    },
  };
};
const read = async (
  provider: DynamoDBGlobalTableProvider,
  names: string[],
  recorded: Record<string, unknown>,
  desired: Record<string, unknown>,
  attempted?: ReadonlyMap<string, ReadonlySet<string>>
) =>
  (await provider.readUnsettled(TABLE, 'T', TYPE, new Set(names), recorded, desired, attempted)) as Record<
    string,
    any
  >;

/**
 * go-to-k/cdkd#5498: the GlobalTable records the replica Regions, index names
 * and replica tag keys its accepted calls added (`markAttempted`, after the
 * send), and `readUnsettled` puts a live entry named EXACTLY there on the
 * previous side, so the template's omission removes it.
 */
describe('GlobalTable attempted items (go-to-k/cdkd#5498)', () => {
  let provider: DynamoDBGlobalTableProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DynamoDBGlobalTableProvider();
  });

  it('a live replica Region named as attempted joins the previous side; a redacted or other spelling does not', async () => {
    serve({ remote: { status: 'ACTIVE' } });
    const recorded = props();
    const regions = async (names: string[]) =>
      (await read(provider, ['Replicas'], recorded, recorded, new Map([['Replicas', new Set(names)]])))[
        'Replicas'
      ].map((r: any) => r.Region);
    expect(await regions(['eu-west-1'])).toEqual(['us-east-1', 'eu-west-1']);
    expect(await regions([])).toEqual(['us-east-1']);
    expect(await regions(['EU-WEST-1', '***', '{{resolve:ssm:r}}', 'eu-west'])).toEqual(['us-east-1']);
  });

  it('a live index named as attempted joins the previous side, never another', async () => {
    serve({ gsiStatus: 'ACTIVE' });
    const recorded = props();
    const withG = await read(provider, [GSI], recorded, recorded, new Map([[GSI, new Set(['g'])]]));
    expect(withG[GSI].map((g: any) => g.IndexName)).toEqual(['g']);
    const without = await read(provider, [GSI], recorded, recorded, new Map([[GSI, new Set(['other'])]]));
    expect((without[GSI] ?? []).map((g: any) => g.IndexName)).toEqual([]);
  });

  it('a replica tag key named as attempted joins the record tags; a live-only or redacted key does not', async () => {
    serve({ tags: [{ Key: 'a', Value: '1' }, { Key: 'b', Value: '2' }, { Key: 'op', Value: 'x' }, { Key: '***', Value: 'y' }] });
    const recorded = props({}, { Tags: [{ Key: 'a', Value: '1' }] });
    const tagsWith = async (keys: string[]) =>
      (
        await read(provider, ['Replicas'], recorded, recorded, new Map([['Replicas[us-east-1].Tags', new Set(keys)]]))
      )['Replicas'][0]['Tags'];
    expect(await tagsWith(['b', '***', 'missing'])).toEqual([
      { Key: 'a', Value: '1' },
      { Key: 'b', Value: '2' },
    ]);
    expect(await tagsWith([])).toEqual([{ Key: 'a', Value: '1' }]);
  });

  it('records the tag keys an accepted TagResource added that the record lacked, after the call', async () => {
    serve({});
    const s = sink();
    await provider.update(
      'T',
      TABLE,
      TYPE,
      props({}, { Tags: [{ Key: 'a', Value: '1' }, { Key: 'b', Value: '2' }] }),
      props({}, { Tags: [{ Key: 'a', Value: '1' }] }),
      { markUnsettled: () => undefined, markAttempted: s.markAttempted }
    );
    expect(s.items).toEqual([['Replicas[us-east-1].Tags', ['b']]]);
    expect(s.writesAt[0]).toBe(writes());
  });

  it('an unsettled re-send of every template tag records only the keys the record lacked', async () => {
    serve({});
    const s = sink();
    await provider.update(
      'T',
      TABLE,
      TYPE,
      props({}, { Tags: [{ Key: 'a', Value: '1' }, { Key: 'b', Value: '2' }] }),
      props({}, { Tags: [{ Key: 'a', Value: '1' }] }),
      {
        markUnsettled: () => undefined,
        markAttempted: s.markAttempted,
        unsettledProperties: new Set(['Replicas']),
      }
    );
    expect(sent('TagResourceCommand').flatMap((c) => c.input.Tags.map((t: any) => t.Key))).toEqual(['a', 'b']);
    expect(s.items).toEqual([['Replicas[us-east-1].Tags', ['b']]]);
  });

  it('records no tag key when TagResource throws, or when the recorded tags are malformed', async () => {
    serve({ failTag: true });
    const s = sink();
    await provider
      .update('T', TABLE, TYPE, props({}, { Tags: [{ Key: 'b', Value: '2' }] }), props(), {
        markUnsettled: () => undefined,
        markAttempted: s.markAttempted,
      })
      .catch(() => undefined);
    expect(s.items).toEqual([]);
    vi.clearAllMocks();
    serve({});
    await provider.update(
      'T',
      TABLE,
      TYPE,
      props({}, { Tags: [{ Key: 'b', Value: '2' }] }),
      props({}, { Tags: 'not-a-list' }),
      { markUnsettled: () => undefined, markAttempted: s.markAttempted }
    );
    expect(sent('TagResourceCommand').length).toBeGreaterThan(0);
    expect(s.items).toEqual([]);
  });

  const withIndex = (name: string) =>
    props({
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'gk', AttributeType: 'S' },
      ],
      GlobalSecondaryIndexes: [
        { IndexName: name, KeySchema: [{ AttributeName: 'gk', KeyType: 'HASH' }], Projection: { ProjectionType: 'ALL' } },
      ],
    });

  it('records an index after its Create is accepted, and none when the Create throws', async () => {
    serve({});
    const s = sink();
    await provider.update('T', TABLE, TYPE, withIndex('g2'), props(), {
      markUnsettled: () => undefined,
      markAttempted: s.markAttempted,
    });
    expect(s.items).toEqual([[GSI, ['g2']]]);
    const creates = sent('UpdateTableCommand').filter((c) => c.input.GlobalSecondaryIndexUpdates?.[0]?.Create);
    expect(creates).toHaveLength(1);
    expect(s.writesAt[0]).toBeGreaterThanOrEqual(1);
    vi.clearAllMocks();
    serve({ failCreateIndex: true });
    const f = sink();
    await expect(
      provider.update('T', TABLE, TYPE, withIndex('g2'), props(), {
        markUnsettled: () => undefined,
        markAttempted: f.markAttempted,
      })
    ).rejects.toThrow();
    expect(f.items).toEqual([]);
  });

  it('records no replica when its Create throws', async () => {
    serve({ failCreateReplica: true });
    const f = sink();
    await expect(
      provider.update(
        'T',
        TABLE,
        TYPE,
        { ...props(), Replicas: [{ Region: 'us-east-1' }, { Region: 'eu-west-1' }] },
        props(),
        { markUnsettled: () => undefined, markAttempted: f.markAttempted }
      )
    ).rejects.toThrow();
    expect(f.items.filter(([p]) => p === 'Replicas')).toEqual([]);
  });

  it('records a replica Region after its Create is accepted', async () => {
    serve({ remote: { status: 'ACTIVE' } });
    const s = sink();
    await provider
      .update(
        'T',
        TABLE,
        TYPE,
        { ...props(), Replicas: [{ Region: 'us-east-1' }, { Region: 'eu-west-1' }] },
        props(),
        { markUnsettled: () => undefined, markAttempted: s.markAttempted }
      )
      .catch(() => undefined);
    const replicaCreates = sent('UpdateTableCommand').filter((c) => c.input.ReplicaUpdates?.[0]?.Create);
    expect(replicaCreates).toHaveLength(1);
    expect(s.items).toContainEqual(['Replicas', ['eu-west-1']]);
  });
});
