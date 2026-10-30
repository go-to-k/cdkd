/**
 * go-to-k/cdkd#2762 — `AWS::DynamoDB::Table.VectorIndexes`: see the describe block.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend, warnSpy, debugSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
  debugSpy: vi.fn(),
}));
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
  const child = { debug: debugSpy, info: vi.fn(), warn: warnSpy, error: vi.fn(), child: vi.fn() };
  child.child.mockReturnValue(child);
  return { getLogger: () => ({ ...child, child: () => child }) };
});

import { DynamoDBTableProvider } from '../../../../src/provisioning/providers/dynamodb-table-provider.js';
import { ProvisioningError } from '../../../../src/utils/error-handler.js';
import { canonicalizeUnorderedArraysAtPaths } from '../../../../src/analyzer/drift-normalize.js';

const TYPE = 'AWS::DynamoDB::Table';
const ARN = 'arn:aws:dynamodb:us-east-1:123456789012:table/t';

const vector = (name: string, dimensions: unknown = 3): Record<string, unknown> => ({
  IndexName: name,
  VectorAttribute: { AttributeName: 'embedding' },
  Dimensions: dimensions,
  DistanceFunction: 'COSINE',
  Projection: { ProjectionType: 'KEYS_ONLY' },
  SearchSchema: [{ AttributeName: 'tenant', SearchSchemaElementType: 'HASH' }],
});
const props = (...indexes: Record<string, unknown>[]): Record<string, unknown> => ({
  TableName: 't',
  BillingMode: 'PAY_PER_REQUEST',
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [
    { AttributeName: 'pk', AttributeType: 'S' },
    { AttributeName: 'tenant', AttributeType: 'S' },
  ],
  ...(indexes.length > 0 && { VectorIndexes: indexes }),
});

type Cmd = { constructor: { name: string }; input: Record<string, any> };

/**
 * A PAY_PER_REQUEST table whose live vector indexes are `live`. Each
 * `statuses` entry answers one DescribeTable with that status on every live
 * vector index; once exhausted, every index reads ACTIVE.
 */
function serve(
  live: Record<string, unknown>[],
  statuses: string[] = [],
  opts: { statusOf?: Record<string, string>; noTableFirst?: boolean } = {}
): void {
  const queue = [...statuses];
  let describes = 0;
  mockSend.mockImplementation(async (cmd: Cmd) => {
    switch (cmd.constructor.name) {
      case 'CreateTableCommand':
        return { TableDescription: { TableId: 'id' } };
      case 'DescribeTableCommand': {
        const status = queue.shift() ?? 'ACTIVE';
        describes += 1;
        if (opts.noTableFirst === true && describes === 1) return {};
        return {
          Table: {
            TableName: 't',
            TableArn: ARN,
            TableId: 'id',
            TableStatus: 'ACTIVE',
            KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
            AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
            BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
            DeletionProtectionEnabled: false,
            ...(live.length > 0 && {
              VectorIndexes: live.map((v) => ({
                ...v,
                IndexStatus: opts.statusOf?.[v['IndexName'] as string] ?? status,
                Backfilling: false,
                IndexSizeBytes: 0,
              })),
            }),
          },
        };
      }
      case 'DescribeContinuousBackupsCommand':
        return {
          ContinuousBackupsDescription: {
            PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'DISABLED' },
          },
        };
      case 'DescribeTimeToLiveCommand':
        return { TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' } };
      case 'ListTagsOfResourceCommand':
        return { Tags: [] };
      case 'DescribeKinesisStreamingDestinationCommand':
        return { KinesisDataStreamDestinations: [] };
      case 'DescribeContributorInsightsCommand':
        return { ContributorInsightsStatus: 'DISABLED' };
      default:
        return {};
    }
  });
}

const sent = (name: string): Cmd[] =>
  mockSend.mock.calls.map((c) => c[0] as Cmd).filter((c) => c.constructor.name === name);
const vectorOps = (): Array<Record<string, any>> =>
  sent('UpdateTableCommand').flatMap((c) => (c.input['VectorIndexUpdates'] ?? []) as Array<Record<string, any>>);

/**
 * go-to-k/cdkd#2762: `VectorIndexes` used to be absent from
 * `handledProperties`, so a table declaring them was routed to Cloud Control.
 * The SDK route now sends them on `CreateTable`, adds / removes them one per
 * `UpdateTable` (`VectorIndexUpdates`, Create / Delete only), refuses an
 * in-place definition change before any call, and reads them back.
 */
describe('DynamoDB table VectorIndexes (go-to-k/cdkd#2762)', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    debugSpy.mockReset();
    provider = new DynamoDBTableProvider();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('declares VectorIndexes handled', () => {
    expect(provider.handledProperties.get(TYPE)?.has('VectorIndexes')).toBe(true);
  });

  it('sends VectorIndexes on CreateTable, Dimensions on the CFn Integer grammar', async () => {
    serve([]);
    await provider.create('L', TYPE, props(vector('v1', '1024')));
    const [create] = sent('CreateTableCommand');
    expect(create!.input['VectorIndexes']).toEqual([vector('v1', 1024)]);
  });

  it('adds each new vector index in its own UpdateTable, carrying AttributeDefinitions', async () => {
    serve([]);
    await provider.update('L', 't', TYPE, props(vector('v1'), vector('v2')), props());
    const updates = sent('UpdateTableCommand');
    expect(updates.map((u) => u.input['VectorIndexUpdates'])).toEqual([
      [{ Create: vector('v1') }],
      [{ Create: vector('v2') }],
    ]);
    for (const u of updates) {
      expect(u.input['AttributeDefinitions']).toEqual(props()['AttributeDefinitions']);
    }
  });

  it('deletes a removed vector index, with no AttributeDefinitions', async () => {
    serve([vector('v1')]);
    await provider.update('L', 't', TYPE, props(), props(vector('v1')));
    const updates = sent('UpdateTableCommand');
    expect(updates.map((u) => u.input)).toEqual([
      { TableName: 't', VectorIndexUpdates: [{ Delete: { IndexName: 'v1' } }] },
    ]);
  });

  it('sends nothing for an unchanged list, nor for a reordered SearchSchema / spelled Dimensions', async () => {
    serve([vector('v1')]);
    await provider.update('L', 't', TYPE, props(vector('v1')), props(vector('v1')));
    expect(vectorOps()).toEqual([]);
    const reordered = {
      ...vector('v1', '3'),
      Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['b', 'a'] },
      SearchSchema: [
        { AttributeName: 'f', SearchSchemaElementType: 'INLINE_FILTER' },
        { AttributeName: 'tenant', SearchSchemaElementType: 'HASH' },
      ],
    };
    const original = {
      ...vector('v1'),
      Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['a', 'b'] },
      SearchSchema: [...reordered.SearchSchema].reverse(),
    };
    serve([original]);
    mockSend.mockClear();
    await provider.update('L', 't', TYPE, props(reordered), props(original));
    expect(vectorOps()).toEqual([]);
  });

  it('refuses a same-name definition change before any mutating call, masking the name', async () => {
    serve([vector('v1')]);
    const error = await provider
      .update('L', 't', TYPE, props(vector('v1', 4)), props(vector('v1')), {
        maskSecrets: (text: string) => text.replaceAll('v1', '****'),
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as Error).message).toMatch(
      /VectorIndexes \*\*\*\* changed definition, which DynamoDB cannot modify in place\. Nothing was applied/
    );
    expect((error as Error).message).not.toContain('v1');
    expect(
      mockSend.mock.calls.map((c) => (c[0] as Cmd).constructor.name).filter((n) => !/^(Describe|List|Get)/.test(n))
    ).toEqual([]);
  });

  it('does not refuse a change AWS already holds (a record that lags AWS)', async () => {
    serve([vector('v1', 4)]);
    await provider.update('L', 't', TYPE, props(vector('v1', 4)), props(vector('v1')));
    expect(vectorOps()).toEqual([]);
  });

  it('warns instead of refusing on a state replay, and applies the rest', async () => {
    serve([vector('v1')]);
    await provider.update('L', 't', TYPE, props(vector('v1', 4), vector('v2')), props(vector('v1')), {
      replayingState: true,
    });
    expect(vectorOps()).toEqual([{ Create: vector('v2') }]);
    expect(warnSpy.mock.calls.flat().join('\n')).toMatch(/v1 changed definition.*that change was not applied/);
  });

  it('skips the Create of an index AWS already holds as declared, with a warning', async () => {
    serve([vector('v1')]);
    await provider.update('L', 't', TYPE, props(vector('v1')), props());
    expect(vectorOps()).toEqual([]);
    expect(warnSpy.mock.calls.flat().join('\n')).toMatch(/vector index v1 .* already exists in AWS/);
  });

  it('refuses an added name AWS already holds with another definition', async () => {
    serve([vector('v1', 8)]);
    await expect(provider.update('L', 't', TYPE, props(vector('v1')), props())).rejects.toThrow(
      /VectorIndexes v1 changed definition/
    );
    expect(vectorOps()).toEqual([]);
  });

  it('skips the Delete of an index AWS no longer has', async () => {
    serve([]);
    await provider.update('L', 't', TYPE, props(), props(vector('v1')));
    expect(vectorOps()).toEqual([]);
  });

  it('waits for a building vector index before the next op', async () => {
    vi.useFakeTimers();
    // The pre-op wait reads `v0` ACTIVE; the wait after v1's Create reads it
    // CREATING twice before it settles, and v2's Create must come after.
    serve([vector('v0')], ['ACTIVE', 'ACTIVE', 'CREATING', 'CREATING']);
    const done = provider.update(
      'L',
      't',
      TYPE,
      props(vector('v0'), vector('v1'), vector('v2')),
      props(vector('v0'))
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(vectorOps()).toEqual([{ Create: vector('v1') }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(vectorOps()).toEqual([{ Create: vector('v1') }]);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(vectorOps()).toEqual([{ Create: vector('v1') }, { Create: vector('v2') }]);
  });

  it('removes one index and adds another in the same update: Delete first, then Create', async () => {
    serve([vector('v1')]);
    await provider.update('L', 't', TYPE, props(vector('v2', 4)), props(vector('v1')));
    expect(sent('UpdateTableCommand').map((u) => u.input)).toEqual([
      { TableName: 't', VectorIndexUpdates: [{ Delete: { IndexName: 'v1' } }] },
      {
        TableName: 't',
        VectorIndexUpdates: [{ Create: vector('v2', 4) }],
        AttributeDefinitions: props()['AttributeDefinitions'],
      },
    ]);
  });

  it('does not re-send the Delete of an index AWS is already deleting', async () => {
    vi.useFakeTimers();
    // v1 reads DELETING on the snapshot and the next read, then is gone: a
    // re-sent Delete would be issued after the pre-op wait settles.
    let reads = 0;
    serve([vector('v1')], [], { statusOf: { v1: 'DELETING' } });
    const base = mockSend.getMockImplementation()!;
    mockSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'DescribeTableCommand' && ++reads > 2) {
        const out = (await base(cmd)) as { Table: Record<string, unknown> };
        return { Table: { ...out.Table, VectorIndexes: undefined } };
      }
      return base(cmd);
    });
    const done = provider.update('L', 't', TYPE, props(), props(vector('v1')));
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(vectorOps()).toEqual([]);
  });

  it('re-creates an added index AWS is still deleting, rather than adopting it', async () => {
    vi.useFakeTimers();
    // The pre-op wait reads v1 DELETING, then gone.
    let reads = 0;
    serve([vector('v1')], [], { statusOf: { v1: 'DELETING' } });
    const base = mockSend.getMockImplementation()!;
    mockSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'DescribeTableCommand' && ++reads > 2) {
        const out = (await base(cmd)) as { Table: Record<string, unknown> };
        return { Table: { ...out.Table, VectorIndexes: undefined } };
      }
      return base(cmd);
    });
    const done = provider.update('L', 't', TYPE, props(vector('v1')), props());
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(vectorOps()).toEqual([{ Create: vector('v1') }]);
    expect(warnSpy.mock.calls.flat().join('\n')).not.toMatch(/already exists in AWS/);
  });

  it('refuses a changed definition when AWS holds the desired one only as DELETING', async () => {
    serve([vector('v1', 4)], [], { statusOf: { v1: 'DELETING' } });
    await expect(
      provider.update('L', 't', TYPE, props(vector('v1', 4)), props(vector('v1')))
    ).rejects.toThrow(/VectorIndexes v1 changed definition/);
    expect(vectorOps()).toEqual([]);
  });

  it('waits out a DELETING or UPDATING index between ops, not only a CREATING one', async () => {
    vi.useFakeTimers();
    serve([vector('v0')], ['ACTIVE', 'ACTIVE', 'DELETING', 'UPDATING']);
    const done = provider.update(
      'L',
      't',
      TYPE,
      props(vector('v0'), vector('v1'), vector('v2')),
      props(vector('v0'))
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(vectorOps()).toEqual([{ Create: vector('v1') }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(vectorOps()).toEqual([{ Create: vector('v1') }]);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(vectorOps()).toEqual([{ Create: vector('v1') }, { Create: vector('v2') }]);
  });

  it('waits on create for a vector index still building after the table reads ACTIVE', async () => {
    vi.useFakeTimers();
    let reads = 0;
    serve([vector('v1')]);
    const base = mockSend.getMockImplementation()!;
    mockSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name !== 'DescribeTableCommand') return base(cmd);
      const out = (await base(cmd)) as { Table: Record<string, any> };
      reads += 1;
      const status = reads <= 2 ? 'CREATING' : 'ACTIVE';
      return {
        Table: { ...out.Table, VectorIndexes: out.Table['VectorIndexes'].map((v: object) => ({ ...v, IndexStatus: status })) },
      };
    });
    // PITR is declared so its post-ACTIVE call shows WHEN create() moves on:
    // not while the index builds, only after it settles.
    const done = provider.create('L', TYPE, {
      ...props(vector('v1')),
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent('UpdateContinuousBackupsCommand')).toEqual([]);
    expect(sent('DescribeTableCommand').length).toBeGreaterThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(3000);
    await done;
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(sent('UpdateContinuousBackupsCommand')).toHaveLength(1);
  });

  it('with no DescribeTable snapshot, sends the Delete rather than reading the index as gone', async () => {
    serve([], [], { noTableFirst: true });
    await provider.update('L', 't', TYPE, props(), props(vector('v1')));
    expect(vectorOps()).toEqual([{ Delete: { IndexName: 'v1' } }]);
  });

  it('warns instead of refusing on a drift --revert readback, too', async () => {
    serve([vector('v1')]);
    await provider.update('L', 't', TYPE, props(vector('v1', 4)), props(vector('v1')), {
      desiredFromAwsReadback: true,
    });
    expect(vectorOps()).toEqual([]);
    expect(warnSpy.mock.calls.flat().join('\n')).toMatch(/v1 changed definition.*that change was not applied/);
  });

  it('reads back no SearchSchema key for an empty live search schema', async () => {
    serve([{ ...vector('v1'), SearchSchema: [] }]);
    const state = (await provider.readCurrentState('t', 'L', TYPE, props(vector('v1')))) as Record<
      string,
      unknown
    >;
    expect((state['VectorIndexes'] as Record<string, unknown>[])[0]).not.toHaveProperty('SearchSchema');
  });

  it('keeps an attempted live index on the unsettled previous side, and drops an unattempted one', async () => {
    serve([vector('v1'), vector('v2')]);
    const run = (attempted?: Map<string, Set<string>>) =>
      provider.readUnsettled('t', 'L', TYPE, new Set(['VectorIndexes']), props(), props(), attempted) as Promise<
        Record<string, unknown>
      >;
    expect((await run(new Map([['VectorIndexes', new Set(['v1'])]])))['VectorIndexes']).toEqual([vector('v1')]);
    expect('VectorIndexes' in (await run())).toBe(false);
  });

  it('adds an index declared with Dimensions "1024" on update, sent as the integer', async () => {
    serve([]);
    await provider.update('L', 't', TYPE, props(vector('v1', '1024')), props());
    expect(vectorOps()).toEqual([{ Create: vector('v1', 1024) }]);
  });

  it('reads an empty SearchSchema / NonKeyAttributes as absent, so a retry adopts rather than refuses', async () => {
    const declared = { ...vector('v1'), Projection: { ProjectionType: 'KEYS_ONLY' } };
    delete (declared as Record<string, unknown>)['SearchSchema'];
    serve([{ ...declared, SearchSchema: [], Projection: { ProjectionType: 'KEYS_ONLY', NonKeyAttributes: [] } }]);
    await provider.update('L', 't', TYPE, props(declared), props());
    expect(vectorOps()).toEqual([]);
    expect(warnSpy.mock.calls.flat().join('\n')).toMatch(/already exists in AWS/);
  });

  it('masks each index name on its own in the refusal, adopt, already-gone and created lines', async () => {
    // A masker with only the WHOLE-VALUE arm: a short name inside a finished
    // sentence is not masked by it, so only a per-name mask hides it.
    const maskSecrets = (text: string): string => (text === 'v1' || text === 'v9' ? '****' : text);
    const all = (): string =>
      [...warnSpy.mock.calls, ...debugSpy.mock.calls].flat().map(String).join('\n');
    serve([vector('v1')]);
    const error = await provider
      .update('L', 't', TYPE, props(vector('v1', 4)), props(vector('v1')), { maskSecrets })
      .catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/VectorIndexes \*\*\*\* changed definition/);
    serve([vector('v1')]);
    await provider.update('L', 't', TYPE, props(vector('v1')), props(vector('v9')), { maskSecrets });
    serve([]);
    await provider.update('L', 't', TYPE, props(vector('v1')), props(), { maskSecrets });
    expect(all()).toMatch(/vector index \*\*\*\* .* already exists in AWS/);
    expect(all()).toMatch(/vector index \*\*\*\* .* is recorded in cdkd state but not live/);
    expect(all()).toMatch(/created vector index \*\*\*\*/);
    expect(all()).not.toMatch(/\bv[19]\b/);
  });

  it('masks the table name in the index-settle timeout', async () => {
    vi.useFakeTimers();
    serve([vector('v1')], [], { statusOf: { v1: 'CREATING' } });
    const done = provider
      .create('L', TYPE, { ...props(vector('v1')), TableName: 'secret-table' }, {
        // WHOLE-VALUE arm only: the name must be masked on its own.
        maskSecrets: (t: string) => (t === 'secret-table' ? '****' : t),
      })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_801_000);
    const error = (await done) as Error;
    expect(error.message).toMatch(/did not reach ACTIVE within 1800 seconds after CreateTable/);
    expect(error.message).not.toContain('secret-table');
  });

  it('masks the table name in the update-path index-settle timeout, naming UpdateTable', async () => {
    vi.useFakeTimers();
    // v0 stays CREATING, so the wait before v1's Create never settles.
    serve([vector('v0')], [], { statusOf: { v0: 'CREATING' } });
    const done = provider
      .update('L', 'secret-table', TYPE, props(vector('v0'), vector('v1')), props(vector('v0')), {
        maskSecrets: (t: string) => (t === 'secret-table' ? '****' : t),
      })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_801_000);
    const error = (await done) as Error;
    expect(error.message).toMatch(/did not reach ACTIVE within 1800 seconds after UpdateTable/);
    expect(error.message).not.toContain('secret-table');
    expect(vectorOps()).toEqual([]);
  });

  describe('every index-settle wait masks the table name on its own (GSI callers too)', () => {
    const SECRET = 'secret-table';
    const maskSecrets = (t: string): string => (t === SECRET ? '****' : t);
    /** DescribeTable answers ACTIVE until `afterSends` mutating calls, then `UPDATING` forever. */
    function serveStuck(afterSends: number, table: Record<string, unknown> = {}): void {
      let sends = 0;
      mockSend.mockImplementation(async (cmd: Cmd) => {
        const n = cmd.constructor.name;
        if (!/^(Describe|List|Get)/.test(n)) sends += 1;
        if (n === 'DescribeTableCommand') {
          return {
            Table: {
              TableName: SECRET,
              TableArn: ARN,
              TableStatus: sends >= afterSends ? 'UPDATING' : 'ACTIVE',
              KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
              AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
              BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
              DeletionProtectionEnabled: false,
              ...table,
            },
          };
        }
        if (n === 'DescribeContinuousBackupsCommand') {
          return { ContinuousBackupsDescription: { PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'DISABLED' } } };
        }
        if (n === 'DescribeTimeToLiveCommand') return { TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' } };
        if (n === 'DescribeContributorInsightsCommand') return { ContributorInsightsStatus: 'DISABLED' };
        if (n === 'DescribeKinesisStreamingDestinationCommand') return { KinesisDataStreamDestinations: [] };
        if (n === 'ListTagsOfResourceCommand') return { Tags: [] };
        return {};
      });
    }
    async function timeoutOf(run: () => Promise<unknown>): Promise<Error> {
      vi.useFakeTimers();
      const done = run().catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(2_000_000);
      return (await done) as Error;
    }
    const gsi = (name: string, extra: Record<string, unknown> = {}) => ({
      IndexName: name,
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      Projection: { ProjectionType: 'KEYS_ONLY' },
      ...extra,
    });

    it('the vector-index scope line masks the table name', async () => {
      serve([]);
      await provider.update('L', SECRET, TYPE, props(), props(vector('v1')), { maskSecrets });
      const lines = [...warnSpy.mock.calls, ...debugSpy.mock.calls].flat().map(String).join('\n');
      expect(lines).toMatch(/vector index v1 on DynamoDB table \*\*\*\* is recorded/);
    });

    it('after a GSI Create (runGsiOps)', async () => {
      serveStuck(1);
      const error = await timeoutOf(() =>
        provider.update('L', SECRET, TYPE, { ...props(), GlobalSecondaryIndexes: [gsi('g1')] }, props(), {
          maskSecrets,
        })
      );
      expect(error.message).toMatch(/did not reach ACTIVE within \d+ seconds after UpdateTable/);
      expect(error.message).not.toContain(SECRET);
    });

    it('before a per-index Contributor Insights change', async () => {
      serveStuck(0, {
        GlobalSecondaryIndexes: [{ ...gsi('g1'), IndexStatus: 'ACTIVE' }],
      });
      const error = await timeoutOf(() =>
        provider.update(
          'L',
          SECRET,
          TYPE,
          { ...props(), GlobalSecondaryIndexes: [gsi('g1', { ContributorInsightsSpecification: { Enabled: true } })] },
          { ...props(), GlobalSecondaryIndexes: [gsi('g1')] },
          { maskSecrets }
        )
      );
      expect(error.message).toMatch(/did not reach ACTIVE within \d+ seconds after UpdateTable/);
      expect(error.message).not.toContain(SECRET);
    });

    it('after a BillingMode flip', async () => {
      serveStuck(1);
      const error = await timeoutOf(() =>
        provider.update(
          'L',
          SECRET,
          TYPE,
          {
            ...props(),
            BillingMode: 'PROVISIONED',
            ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
          },
          props(),
          { maskSecrets }
        )
      );
      expect(error.message).toMatch(/did not reach ACTIVE within \d+ seconds after UpdateTable/);
      expect(error.message).not.toContain(SECRET);
    });
  });

  it('on a failed second op: the error propagates, only the accepted Create is attempted, unsettled is marked first', async () => {
    serve([]);
    const base = mockSend.getMockImplementation()!;
    const events: string[] = [];
    mockSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'UpdateTableCommand') {
        const name = cmd.input['VectorIndexUpdates']?.[0]?.Create?.IndexName;
        events.push(`send:${name}`);
        if (name === 'v2') throw new Error('LimitExceededException');
      }
      return base(cmd);
    });
    const attempted: string[] = [];
    await expect(
      provider.update('L', 't', TYPE, props(vector('v1'), vector('v2')), props(), {
        markUnsettled: (key: string) => events.push(`unsettled:${key}`),
        markAttempted: (_path: string, items: readonly string[]) => attempted.push(...items),
      })
    ).rejects.toThrow(/LimitExceededException/);
    expect(events.filter((e) => e === 'unsettled:VectorIndexes' || e.startsWith('send:'))).toEqual([
      'unsettled:VectorIndexes',
      'send:v1',
      'send:v2',
    ]);
    expect(attempted).toEqual(['v1']);
  });

  it('marks VectorIndexes unsettled before the first op and each accepted Create attempted', async () => {
    serve([]);
    const unsettled: string[] = [];
    const attempted: Array<[string, readonly string[]]> = [];
    await provider.update('L', 't', TYPE, props(vector('v1')), props(), {
      markUnsettled: (key: string) => unsettled.push(key),
      markAttempted: (path: string, items: readonly string[]) => attempted.push([path, items]),
    });
    expect(unsettled).toContain('VectorIndexes');
    expect(attempted).toEqual([['VectorIndexes', ['v1']]]);
  });

  it('reads VectorIndexes back in their CFn shape, dropping the AWS-managed members', async () => {
    serve([vector('v1')]);
    const state = (await provider.readCurrentState('t', 'L', TYPE, props(vector('v1')))) as Record<
      string,
      unknown
    >;
    expect(state['VectorIndexes']).toEqual([vector('v1')]);
  });

  it('reads no VectorIndexes placeholder for a table without any', async () => {
    serve([]);
    const state = (await provider.readCurrentState('t', 'L', TYPE, props())) as Record<string, unknown>;
    expect('VectorIndexes' in state).toBe(false);
  });

  it('compares VectorIndexes as an unordered list, its inner lists included', () => {
    const paths = provider.getDriftUnorderedPaths(TYPE);
    const index = (order: 'a' | 'b', name: string) => ({
      ...vector(name),
      Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: order === 'a' ? ['x', 'y'] : ['y', 'x'] },
      SearchSchema:
        order === 'a'
          ? [
              { AttributeName: 'tenant', SearchSchemaElementType: 'HASH' },
              { AttributeName: 'f', SearchSchemaElementType: 'INLINE_FILTER' },
            ]
          : [
              { AttributeName: 'f', SearchSchemaElementType: 'INLINE_FILTER' },
              { AttributeName: 'tenant', SearchSchemaElementType: 'HASH' },
            ],
    });
    const declared = { VectorIndexes: [index('a', 'v1'), index('a', 'v2')] };
    const live = { VectorIndexes: [index('b', 'v2'), index('b', 'v1')] };
    expect(canonicalizeUnorderedArraysAtPaths(live, paths)).toEqual(
      canonicalizeUnorderedArraysAtPaths(declared, paths)
    );
  });

  it('projects the live list onto the declared names when VectorIndexes is unsettled', async () => {
    serve([vector('v1'), vector('other')]);
    const out = (await provider.readUnsettled(
      't',
      'L',
      TYPE,
      new Set(['VectorIndexes']),
      props(vector('v1')),
      props(vector('v1'))
    )) as Record<string, unknown>;
    expect(out['VectorIndexes']).toEqual([vector('v1')]);
  });
});
