/**
 * go-to-k/cdkd#5487: the GlobalTable `update()` marks each key just before the
 * call that changes it (through an async-local scope, so only the running
 * update's sends mark), `readUnsettled` reports template-shaped values read
 * strictly (no `{}` write settings on PAY_PER_REQUEST; each replica keeps the
 * RECORD's tags), and `unsettledInTransition` counts only moving states.
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

const TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE = 'gt';
const ARN = `arn:aws:dynamodb:us-east-1:123456789012:table/${TABLE}`;

interface Live {
  status?: string;
  replicaStatus?: string;
  gsiStatus?: string;
  sse?: string;
  ttl?: string;
  tags?: Array<{ Key: string; Value: string }>;
  failInsights?: boolean;
  failTtl?: boolean;
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
    switch (cmd.constructor.name) {
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
            ],
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

function marker() {
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

describe('GlobalTable unsettled properties (go-to-k/cdkd#5487)', () => {
  let provider: DynamoDBGlobalTableProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DynamoDBGlobalTableProvider();
  });

  it('a replica tag change marks Replicas before its TagResource; a reordered tag list marks nothing', async () => {
    serve({});
    const m = marker();
    await provider.update(
      'T',
      TABLE,
      TYPE,
      props({}, { Tags: [{ Key: 'a', Value: '2' }] }),
      props({}, { Tags: [{ Key: 'a', Value: '1' }] }),
      { markUnsettled: m.markUnsettled }
    );
    expect(sent('TagResourceCommand')).toHaveLength(1);
    expect(m.marks).toContain('Replicas');
    expect(m.writesAt[m.marks.indexOf('Replicas')]).toBe(0);
    vi.clearAllMocks();
    serve({});
    const quiet = marker();
    await provider.update(
      'T',
      TABLE,
      TYPE,
      props({}, { Tags: [{ Key: 'a', Value: '1' }] }),
      props({}, { Tags: [{ Value: '1', Key: 'a' }] }),
      { markUnsettled: quiet.markUnsettled }
    );
    expect(quiet.marks).toEqual([]);
  });

  it('a local replica DeletionProtectionEnabled change marks Replicas before the flat UpdateTable', async () => {
    serve({});
    const m = marker();
    await provider.update(
      'T',
      TABLE,
      TYPE,
      props({}, { DeletionProtectionEnabled: true }),
      props({}, { DeletionProtectionEnabled: false }),
      { markUnsettled: m.markUnsettled }
    );
    const flat = sent('UpdateTableCommand').filter((c) => c.input.DeletionProtectionEnabled === true);
    expect(flat).toHaveLength(1);
    expect(m.marks).toContain('Replicas');
    expect(m.writesAt[m.marks.indexOf('Replicas')]).toBe(0);
  });

  it('a TTL change marks TimeToLiveSpecification before UpdateTimeToLive', async () => {
    serve({});
    const m = marker();
    await provider.update(
      'T',
      TABLE,
      TYPE,
      props({ TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true } }),
      props(),
      { markUnsettled: m.markUnsettled }
    );
    expect(sent('UpdateTimeToLiveCommand')).toHaveLength(1);
    const at = m.marks.indexOf('TimeToLiveSpecification');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(m.writesAt[at]).toBe(writes() - 1);
  });

  it('marks reach only the running update (concurrent updates never share a scope)', async () => {
    serve({});
    const a = marker();
    const b = marker();
    await Promise.all([
      provider.update('A', TABLE, TYPE, props({}, { Tags: [{ Key: 'a', Value: '2' }] }), props(), {
        markUnsettled: a.markUnsettled,
      }),
      provider.update('B', TABLE, TYPE, props(), props(), { markUnsettled: b.markUnsettled }),
    ]);
    expect(a.marks).toContain('Replicas');
    expect(b.marks).toEqual([]);
  });

  it('unsettled Replicas re-send every template tag and remove only recorded tags the template dropped', async () => {
    serve({ tags: [{ Key: 'operator', Value: 'keep' }] });
    await provider.update(
      'T',
      TABLE,
      TYPE,
      props({}, { Tags: [{ Key: 'a', Value: '1' }] }),
      props({}, { Tags: [{ Key: 'a', Value: '1' }, { Key: 'gone', Value: 'x' }] }),
      { unsettledProperties: new Set(['Replicas']) }
    );
    expect(sent('TagResourceCommand').map((c) => c.input.Tags)).toEqual([[{ Key: 'a', Value: '1' }]]);
    expect(sent('UntagResourceCommand').map((c) => c.input.TagKeys)).toEqual([['gone']]);
  });

  it('readUnsettled: replicas keep the RECORD tags, PAY_PER_REQUEST drops the {} write settings', async () => {
    serve({ tags: [{ Key: 'operator', Value: 'keep' }] });
    const recorded = props({}, { Tags: [{ Key: 'a', Value: '1' }] });
    const live = (await provider.readUnsettled(TABLE, 'T', TYPE, new Set(['Replicas']), recorded)) as Record<
      string,
      any
    >;
    expect(live['Replicas'][0]['Tags']).toEqual([{ Key: 'a', Value: '1' }]);
    expect(live).not.toHaveProperty('WriteProvisionedThroughputSettings');
    // readCurrentState itself reports the live tags (the drift snapshot).
    const snapshot = (await provider.readCurrentState(TABLE, 'T', TYPE, recorded)) as Record<string, any>;
    expect(snapshot['Replicas'][0]['Tags']).toEqual([{ Key: 'operator', Value: 'keep' }]);
  });

  it('readUnsettled reads strictly: a failed sub-read throws instead of omitting the key', async () => {
    serve({ failInsights: true });
    const recorded = props({}, { ContributorInsightsSpecification: { Enabled: true } });
    await expect(provider.readCurrentState(TABLE, 'T', TYPE, recorded)).resolves.toBeDefined();
    await expect(provider.readUnsettled(TABLE, 'T', TYPE, new Set(['Replicas']), recorded)).rejects.toThrow(
      'throttled'
    );
  });

  it.each([
    [{ status: 'UPDATING' }, ['GlobalSecondaryIndexes', 'Replicas', 'SSESpecification']],
    [{ replicaStatus: 'CREATING' }, ['Replicas']],
    [{ replicaStatus: 'DELETING' }, ['Replicas']],
    [{ gsiStatus: 'CREATING' }, ['GlobalSecondaryIndexes']],
    [{ sse: 'UPDATING' }, ['SSESpecification']],
    [{ ttl: 'ENABLING' }, ['TimeToLiveSpecification']],
    [{ ttl: 'DISABLING' }, []],
    [{ replicaStatus: 'INACCESSIBLE_ENCRYPTION_CREDENTIALS' }, []],
    [{ replicaStatus: 'REGION_DISABLED' }, []],
    [{ status: 'ARCHIVED' }, []],
    [{}, []],
  ])('unsettledInTransition %o -> %o', async (live, expected) => {
    serve(live as Live);
    const names = new Set(['Replicas', 'GlobalSecondaryIndexes', 'SSESpecification', 'TimeToLiveSpecification']);
    expect([...(await provider.unsettledInTransition(TABLE, 'T', TYPE, names))].sort()).toEqual(expected);
  });

  it('unsettledInTransition: a failed read keeps every name', async () => {
    mockSend.mockRejectedValue(new Error('throttled'));
    expect((await provider.unsettledInTransition(TABLE, 'T', TYPE, new Set(['Replicas', 'BillingMode']))).size).toBe(2);
  });

  describe('readUnsettled never removes or resets what neither the record nor the template names', () => {
    it('a live-only replica region is left out of the previous side (never deleted)', async () => {
      serve({ remote: { status: 'ACTIVE' } });
      const recorded = props();
      const live = (await provider.readUnsettled(TABLE, 'T', TYPE, new Set(['Replicas']), recorded, recorded)) as Record<string, any>;
      expect(live['Replicas'].map((r: any) => r.Region)).toEqual(['us-east-1']);
      // A region the template names is kept.
      const wanted = { ...recorded, Replicas: [{ Region: 'us-east-1' }, { Region: 'eu-west-1' }] };
      const both = (await provider.readUnsettled(TABLE, 'T', TYPE, new Set(['Replicas']), recorded, wanted)) as Record<string, any>;
      expect(both['Replicas'].map((r: any) => r.Region)).toEqual(['us-east-1', 'eu-west-1']);
    });

    it('a live-only DeletionProtectionEnabled=true is not on the previous side; a named one is', async () => {
      serve({ localDeletionProtection: true });
      const recorded = props();
      const unnamed = (await provider.readUnsettled(TABLE, 'T', TYPE, new Set(['Replicas']), recorded, recorded)) as Record<string, any>;
      expect(unnamed['Replicas'][0]).not.toHaveProperty('DeletionProtectionEnabled');
      const declared = props({}, { DeletionProtectionEnabled: false });
      const named = (await provider.readUnsettled(TABLE, 'T', TYPE, new Set(['Replicas']), recorded, declared)) as Record<string, any>;
      expect(named['Replicas'][0]['DeletionProtectionEnabled']).toBe(true);
    });

    it('a live-only CMK is not on the previous side unless the record or template names the key', async () => {
      const KEY = 'arn:aws:kms:us-east-1:123456789012:key/k';
      serve({ sse: 'ENABLED', kmsKey: KEY });
      const recorded = props();
      const unnamed = (await provider.readUnsettled(TABLE, 'T', TYPE, new Set(['Replicas']), recorded, recorded)) as Record<string, any>;
      expect(unnamed['Replicas'][0]).not.toHaveProperty('SSESpecification');
      // A replica SSESpecification object that names no key keeps the key out too.
      const emptyBlock = props({}, { SSESpecification: {} });
      const nested = (await provider.readUnsettled(TABLE, 'T', TYPE, new Set(['Replicas']), emptyBlock, emptyBlock)) as Record<string, any>;
      expect(nested['Replicas'][0]['SSESpecification']).toEqual({});
      const declared = props({}, { SSESpecification: { KMSMasterKeyId: 'other' } });
      const named = (await provider.readUnsettled(TABLE, 'T', TYPE, new Set(['Replicas']), recorded, declared)) as Record<string, any>;
      expect(named['Replicas'][0]['SSESpecification']).toEqual({ KMSMasterKeyId: KEY });
    });

    it('a CREATION_FAILED replica whose region answers not-found does not refuse the converging read', async () => {
      serve({ remote: { status: 'CREATION_FAILED', notFound: true } });
      const recorded = { ...props(), Replicas: [{ Region: 'us-east-1' }, { Region: 'eu-west-1' }] };
      const read = await provider.readUnsettled(TABLE, 'T', TYPE, new Set(['Replicas']), recorded, recorded);
      // A read (not the gone sentinel), with both replicas on it.
      expect(typeof read).toBe('object');
      expect((read as Record<string, any>)['Replicas'].map((r: any) => r.Region)).toEqual(['us-east-1', 'eu-west-1']);
    });

    it('an ACTIVE replica whose region answers not-found (the RNF-omit arm) does not refuse', async () => {
      serve({ remote: { status: 'ACTIVE', notFound: true } });
      const recorded = { ...props(), Replicas: [{ Region: 'us-east-1' }, { Region: 'eu-west-1' }] };
      const read = await provider.readUnsettled(TABLE, 'T', TYPE, new Set(['Replicas']), recorded, recorded);
      // A read (not the gone sentinel), with both replicas on it.
      expect(typeof read).toBe('object');
      expect((read as Record<string, any>)['Replicas'].map((r: any) => r.Region)).toEqual(['us-east-1', 'eu-west-1']);
    });

    it.each(['CREATION_FAILED', 'REGION_DISABLED', 'INACCESSIBLE_ENCRYPTION_CREDENTIALS'])(
      'a %s replica whose region errors keeps the tolerant reads; an ACTIVE one refuses',
      async (status) => {
        const recorded = { ...props(), Replicas: [{ Region: 'us-east-1' }, { Region: 'eu-west-1' }] };
        serve({ remote: { status, regionError: true } });
        const read = await provider.readUnsettled(TABLE, 'T', TYPE, new Set(['Replicas']), recorded, recorded);
        expect(typeof read).toBe('object');
        serve({ remote: { status: 'ACTIVE', regionError: true } });
        await expect(
          provider.readUnsettled(TABLE, 'T', TYPE, new Set(['Replicas']), recorded, recorded)
        ).rejects.toThrow('security token');
      }
    );

    it('strictness is per unsettled key: a TTL read failure throws only when TTL is unsettled', async () => {
      serve({ failTtl: true });
      const recorded = props();
      const read = await provider.readUnsettled(TABLE, 'T', TYPE, new Set(['Replicas']), recorded, recorded);
      // A read (not the gone sentinel), with both replicas on it.
      expect(typeof read).toBe('object');
      expect((read as Record<string, any>)['Replicas'].map((r: any) => r.Region)).toEqual(['us-east-1']);
      await expect(
        provider.readUnsettled(TABLE, 'T', TYPE, new Set(['TimeToLiveSpecification']), recorded, recorded)
      ).rejects.toThrow('ttl throttled');
    });
  });
});
