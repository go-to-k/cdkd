/**
 * go-to-k/cdkd#5498 — see the describe block.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, warnSpy } = vi.hoisted(() => ({ mockSend: vi.fn(), warnSpy: vi.fn() }));
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
  const child = { debug: vi.fn(), info: vi.fn(), warn: warnSpy, error: vi.fn(), child: vi.fn() };
  child.child.mockReturnValue(child);
  return { getLogger: () => ({ ...child, child: () => child }) };
});

import {
  DynamoDBTableProvider,
  projectIndexesOnto,
} from '../../../../src/provisioning/providers/dynamodb-table-provider.js';
import {
  settleUnsettledPrevious,
  unsettledAfterUpdate,
  withUnprovenUnsettled,
} from '../../../../src/deployment/unsettled-convergence.js';

const TYPE = 'AWS::DynamoDB::Table';
const ARN = 'arn:aws:dynamodb:us-east-1:123456789012:table/t';

const index = (name: string): Record<string, unknown> => ({
  IndexName: name,
  KeySchema: [{ AttributeName: `${name}pk`, KeyType: 'HASH' }],
  Projection: { ProjectionType: 'ALL' },
});
const props = (...names: string[]): Record<string, unknown> => ({
  TableName: 't',
  BillingMode: 'PAY_PER_REQUEST',
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [
    { AttributeName: 'pk', AttributeType: 'S' },
    ...names.map((n) => ({ AttributeName: `${n}pk`, AttributeType: 'S' })),
  ],
  ...(names.length > 0 && { GlobalSecondaryIndexes: names.map(index) }),
});

/** A PAY_PER_REQUEST table whose live indexes are `liveNames` (all ACTIVE). */
function serve(liveNames: string[], opts: { failCreate?: string; failTag?: boolean; liveTags?: string[] } = {}): void {
  mockSend.mockImplementation(async (cmd: { constructor: { name: string }; input: any }) => {
    switch (cmd.constructor.name) {
      case 'UpdateTableCommand': {
        const create = cmd.input?.GlobalSecondaryIndexUpdates?.[0]?.Create?.IndexName;
        if (create !== undefined && create === opts.failCreate) throw new Error('LimitExceeded');
        return {};
      }
      case 'TagResourceCommand':
        if (opts.failTag === true) throw new Error('AccessDenied');
        return {};
      case 'DescribeTableCommand':
        return {
          Table: {
            TableName: 't',
            TableArn: ARN,
            TableStatus: 'ACTIVE',
            KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
            AttributeDefinitions: [
              { AttributeName: 'pk', AttributeType: 'S' },
              ...liveNames.map((n) => ({ AttributeName: `${n}pk`, AttributeType: 'S' })),
            ],
            BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
            ProvisionedThroughput: { ReadCapacityUnits: 0, WriteCapacityUnits: 0 },
            DeletionProtectionEnabled: false,
            ...(liveNames.length > 0 && {
              GlobalSecondaryIndexes: liveNames.map((n) => ({
                ...index(n),
                IndexStatus: 'ACTIVE',
              })),
            }),
          },
        };
      case 'DescribeContinuousBackupsCommand':
        return {
          ContinuousBackupsDescription: {
            PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'DISABLED' },
          },
        };
      case 'DescribeTimeToLiveCommand':
        return { TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' } };
      case 'ListTagsOfResourceCommand':
        return { Tags: (opts.liveTags ?? []).map((k) => ({ Key: k, Value: 'v' })) };
      case 'DescribeKinesisStreamingDestinationCommand':
        return { KinesisDataStreamDestinations: [] };
      case 'DescribeContributorInsightsCommand':
        return { ContributorInsightsStatus: 'DISABLED' };
      default:
        return {};
    }
  });
}

const indexOps = (): Array<Record<string, unknown>> =>
  mockSend.mock.calls
    .map((c) => c[0] as { constructor: { name: string }; input: Record<string, any> })
    .filter((c) => c.constructor.name === 'UpdateTableCommand')
    .flatMap((c) => (c.input['GlobalSecondaryIndexUpdates'] ?? []) as Array<Record<string, unknown>>);

const NAMES = new Set(['GlobalSecondaryIndexes']);
const attempted = (...names: string[]) => new Map([['GlobalSecondaryIndexes', new Set(names)]]);

function sink(): {
  items: Array<[string, string[]]>;
  writesAt: number[];
  markAttempted: (path: string, items: readonly string[]) => void;
} {
  const items: Array<[string, string[]]> = [];
  const writesAt: number[] = [];
  return {
    items,
    writesAt,
    markAttempted: (path, names) => {
      items.push([path, [...names]]);
      writesAt.push(
        mockSend.mock.calls.filter((c) => !/^(Describe|List|Get)/.test(c[0].constructor.name)).length
      );
    },
  };
}

/**
 * go-to-k/cdkd#5498: the names a failed update's ACCEPTED calls added are
 * recorded (`UpdateContext.markAttempted`), so the next deploy removes an
 * index or tag the template no longer names — and only those, by exact name.
 */
describe('DynamoDB table attempted items (go-to-k/cdkd#5498)', () => {
  let provider: DynamoDBTableProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DynamoDBTableProvider();
  });

  it('records an index after its Create is accepted, never before, and not one whose Create throws', async () => {
    serve(['g1'], { failCreate: 'g3' });
    const s = sink();
    await expect(
      provider.update('T', 't', TYPE, props('g1', 'g2', 'g3'), props('g1'), {
        markUnsettled: () => undefined,
        markAttempted: s.markAttempted,
      })
    ).rejects.toThrow();
    expect(s.items).toEqual([['GlobalSecondaryIndexes', ['g2']]]);
    // After the g2 Create was sent (one write), not before it.
    expect(s.writesAt).toEqual([1]);
  });

  it('records nothing when the only Create throws', async () => {
    serve(['g1'], { failCreate: 'g2' });
    const s = sink();
    await expect(
      provider.update('T', 't', TYPE, props('g1', 'g2'), props('g1'), {
        markUnsettled: () => undefined,
        markAttempted: s.markAttempted,
      })
    ).rejects.toThrow();
    expect(s.items).toEqual([]);
  });

  it('records the tag keys an accepted TagResource added that the record lacked', async () => {
    serve([]);
    const s = sink();
    const tags = (...kv: string[]) => ({ ...props(), Tags: kv.map((k) => ({ Key: k, Value: 'v' })) });
    await provider.update('T', 't', TYPE, tags('a', 'b', 'c'), tags('a'), {
      markUnsettled: () => undefined,
      markAttempted: s.markAttempted,
    });
    expect(s.items).toEqual([['Tags', ['b', 'c']]]);
  });

  it('records no tag key when TagResource throws, or when the record\'s tags are malformed', async () => {
    serve([], { failTag: true });
    const s = sink();
    const tags = (...kv: string[]) => ({ ...props(), Tags: kv.map((k) => ({ Key: k, Value: 'v' })) });
    await expect(
      provider.update('T', 't', TYPE, tags('a', 'b'), tags('a'), {
        markUnsettled: () => undefined,
        markAttempted: s.markAttempted,
      })
    ).rejects.toThrow();
    expect(s.items).toEqual([]);
    vi.clearAllMocks();
    serve([]);
    await expect(
      provider.update('T', 't', TYPE, tags('a', 'b'), { ...props(), Tags: 'not-a-list' }, {
        markUnsettled: () => undefined,
        markAttempted: s.markAttempted,
      })
    ).resolves.toBeDefined();
    expect(mockSend.mock.calls.some((c) => c[0].constructor.name === 'TagResourceCommand')).toBe(true);
    expect(s.items).toEqual([]);
  });

  const converge = async (
    recorded: Record<string, unknown>,
    desired: Record<string, unknown>,
    items: ReadonlyMap<string, ReadonlySet<string>>
  ): Promise<void> => {
    const previous = await settleUnsettledPrevious({
      provider,
      logicalId: 'T',
      physicalId: 't',
      resourceType: TYPE,
      recordedProperties: recorded,
      desired,
      names: NAMES,
      previous: recorded,
      attemptedItems: items,
    });
    await provider.update('T', 't', TYPE, desired, previous, {
      unsettledProperties: NAMES,
      unsettledItems: items,
    });
  };

  it('deletes a live attempted index the template dropped — live ∩ attempted ∖ template', async () => {
    serve(['g1', 'gnew', 'gext']);
    await converge(props('g1'), props('g1'), attempted('gnew'));
    expect(indexOps()).toEqual([{ Delete: { IndexName: 'gnew' } }]);
  });

  it('without the attempted name the same index is kept (the v14 behaviour)', async () => {
    serve(['g1', 'gnew', 'gext']);
    await converge(props('g1'), props('g1'), new Map());
    expect(indexOps()).toEqual([]);
  });

  it('keeps an attempted index the template still names', async () => {
    serve(['g1', 'gnew']);
    await converge(props('g1'), props('g1', 'gnew'), attempted('gnew'));
    expect(indexOps()).toEqual([]);
  });

  it('an attempted name that is not live deletes nothing (no Delete for a missing index)', async () => {
    serve(['g1']);
    await converge(props('g1'), props('g1'), attempted('gone'));
    expect(indexOps()).toEqual([]);
  });

  it.each([
    ['a dynamic reference', '{{resolve:secretsmanager:s}}'],
    ['a masked name', '***'],
    ['a name that only contains the mask', 'gnew-***'],
    ['a case-variant of the live name', 'GNEW'],
    ['a prefix of the live name', 'gne'],
  ])('%s never matches the live index gnew', async (_label, name) => {
    serve(['g1', 'gnew']);
    await converge(props('g1'), props('g1'), attempted(name));
    expect(indexOps()).toEqual([]);
  });

  it('a redacted name never matches even a live index spelled the same', async () => {
    serve(['g1', '***']);
    await converge(props('g1'), props('g1'), attempted('***'));
    expect(indexOps()).toEqual([]);
  });

  it('removes a live attempted tag the template dropped, and never a live-only or redacted one', async () => {
    const TAGS = new Set(['Tags']);
    const withTags = (...keys: string[]) => ({
      ...props(),
      Tags: keys.map((k) => ({ Key: k, Value: 'v' })),
    });
    const run = async (items: ReadonlyMap<string, ReadonlySet<string>>): Promise<string[]> => {
      vi.clearAllMocks();
      serve([], { liveTags: ['a', 'b', 'ext', '***'] });
      const previous = await settleUnsettledPrevious({
        provider,
        logicalId: 'T',
        physicalId: 't',
        resourceType: TYPE,
        recordedProperties: withTags('a'),
        desired: withTags('a'),
        names: TAGS,
        previous: withTags('a'),
        attemptedItems: items,
      });
      await provider.update('T', 't', TYPE, withTags('a'), previous, {
        unsettledProperties: TAGS,
        unsettledItems: items,
      });
      return mockSend.mock.calls
        .map((c) => c[0] as { constructor: { name: string }; input: { TagKeys?: string[] } })
        .filter((c) => c.constructor.name === 'UntagResourceCommand')
        .flatMap((c) => c.input.TagKeys ?? []);
    };
    expect(await run(new Map([['Tags', new Set(['b', '***', 'missing'])]]))).toEqual(['b']);
    expect(await run(new Map())).toEqual([]);
  });

  it('a revert the proof does not settle keeps the kept key\'s items, and only its', async () => {
    serve(['g1']);
    const rebuilt = { physicalId: 't', resourceType: TYPE, properties: props('g1') } as never;
    const out = (await withUnprovenUnsettled(
      rebuilt,
      {
        provider,
        logicalId: 'T',
        physicalId: 't',
        resourceType: TYPE,
        recordedProperties: props('g1'),
        names: new Set(['GlobalSecondaryIndexes', 'Tags']),
        desired: props('g1', 'g2'),
        attemptedItems: new Map([
          ['GlobalSecondaryIndexes', new Set(['g2'])],
          ['Tags', new Set(['k'])],
        ]),
      },
      () => undefined
    )) as { unsettledProperties?: string[]; unsettledItems?: Record<string, string[]> };
    expect(out.unsettledProperties).toEqual(['GlobalSecondaryIndexes']);
    expect(out.unsettledItems).toEqual({ GlobalSecondaryIndexes: ['g2'] });
  });

  it('a revert the proof settles carries no items', async () => {
    serve(['g1']);
    const rebuilt = { physicalId: 't', resourceType: TYPE, properties: props('g1') } as never;
    const out = await withUnprovenUnsettled(
      rebuilt,
      {
        provider,
        logicalId: 'T',
        physicalId: 't',
        resourceType: TYPE,
        recordedProperties: props('g1'),
        names: NAMES,
        desired: props('g1'),
        attemptedItems: attempted('g2'),
      },
      () => undefined
    );
    expect(out).toBe(rebuilt);
  });

  it.each([
    ['throws', () => Promise.reject(new Error('throttled'))],
    ['is unreadable', () => Promise.resolve('garbage')],
  ])('only attempted Tags unsettled: a read that %s keeps the record\'s side, no refusal', async (_l, read) => {
    const withTags = { ...props(), Tags: [{ Key: 'a', Value: 'v' }] };
    const previous = await settleUnsettledPrevious({
      provider: { readUnsettled: read } as never,
      logicalId: 'T',
      physicalId: 't',
      resourceType: TYPE,
      recordedProperties: withTags,
      desired: withTags,
      names: new Set(['Tags']),
      previous: withTags,
      attemptedItems: new Map([['Tags', new Set(['b'])]]),
    });
    expect(previous).toEqual(withTags);
  });

  it('projectIndexesOnto adds only usable attempted names, and live-only names stay out', () => {
    const live = [index('a'), index('b'), index('***'), index('{{resolve:ssm:p}}'), index('ext')];
    expect(
      projectIndexesOnto(live, [index('a')], [], new Set(['b', '***', '{{resolve:ssm:p}}', 'missing']))
    ).toEqual([index('a'), index('b')]);
    expect(projectIndexesOnto(live, [index('a')], [])).toEqual([index('a')]);
  });
});
