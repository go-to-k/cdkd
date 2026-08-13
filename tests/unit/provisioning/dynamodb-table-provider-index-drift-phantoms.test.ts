import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DescribeContinuousBackupsCommand,
  DescribeContributorInsightsCommand,
  DescribeKinesisStreamingDestinationCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  GetResourcePolicyCommand,
  ListTagsOfResourceCommand,
} from '@aws-sdk/client-dynamodb';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

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

import { DynamoDBTableProvider } from '../../../src/provisioning/providers/dynamodb-table-provider.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';

const TABLE_NAME = 'my-table';
const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:111111111111:table/my-table';
const RESOURCE_TYPE = 'AWS::DynamoDB::Table';

/**
 * The GSI description `DescribeTable` ACTUALLY returned, measured us-east-1 on
 * 2026-08-13 for a PAY_PER_REQUEST table created with no capacity settings and
 * one GSI added via `UpdateTable`. `Backfilling` is in the shape and is NOT in
 * issue #1767's quoted sample — which is the reason the reverse-mapper is an
 * ALLOW-LIST: a deny-list written from the issue would have forwarded it.
 */
const AWS_GSI_DESCRIPTION = {
  IndexName: 'gsi1',
  KeySchema: [{ AttributeName: 'gsipk', KeyType: 'HASH' }],
  Projection: { ProjectionType: 'ALL' },
  IndexStatus: 'ACTIVE',
  Backfilling: false,
  ProvisionedThroughput: {
    NumberOfDecreasesToday: 0,
    ReadCapacityUnits: 0,
    WriteCapacityUnits: 0,
  },
  IndexSizeBytes: 0,
  ItemCount: 0,
  IndexArn: `${TABLE_ARN}/index/gsi1`,
  WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000, Status: 'ACTIVE' },
};

/** The same index after the table has taken write traffic. */
const AWS_GSI_DESCRIPTION_IN_USE = {
  ...AWS_GSI_DESCRIPTION,
  IndexSizeBytes: 82_310_400,
  ItemCount: 41_233,
};

const AWS_LSI_DESCRIPTION = {
  IndexName: 'lsi1',
  KeySchema: [
    { AttributeName: 'pk', KeyType: 'HASH' },
    { AttributeName: 'lsisk', KeyType: 'RANGE' },
  ],
  Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['a', 'b'] },
  IndexSizeBytes: 1234,
  ItemCount: 7,
  IndexArn: `${TABLE_ARN}/index/lsi1`,
};

/** What a CDK / CFn template declares for the same GSI. */
const TEMPLATE_GSI = {
  IndexName: 'gsi1',
  KeySchema: [{ AttributeName: 'gsipk', KeyType: 'HASH' }],
  Projection: { ProjectionType: 'ALL' },
};

const TEMPLATE_LSI = {
  IndexName: 'lsi1',
  KeySchema: [
    { AttributeName: 'pk', KeyType: 'HASH' },
    { AttributeName: 'lsisk', KeyType: 'RANGE' },
  ],
  Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['a', 'b'] },
};

/**
 * Dispatch by COMMAND rather than priming `*Once` responses: `readCurrentState`
 * issues seven calls whose count is not the subject of these tests, and a
 * surplus primer would leak into the next test (see `.claude/rules/testing.md`).
 */
function primeDescribeTable(table: Record<string, unknown>): void {
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof DescribeTableCommand) return Promise.resolve({ Table: table });
    if (cmd instanceof ListTagsOfResourceCommand) return Promise.resolve({ Tags: [] });
    if (cmd instanceof DescribeContinuousBackupsCommand) return Promise.resolve({});
    if (cmd instanceof DescribeTimeToLiveCommand) return Promise.resolve({});
    if (cmd instanceof GetResourcePolicyCommand) return Promise.resolve({});
    if (cmd instanceof DescribeKinesisStreamingDestinationCommand) return Promise.resolve({});
    if (cmd instanceof DescribeContributorInsightsCommand) return Promise.resolve({});
    return Promise.resolve({});
  });
}

/**
 * Issue #1767 — the GSI / LSI readback was forwarded VERBATIM off the SDK
 * response, so every AWS-managed member of an index description took part in
 * the drift comparison. Unlike a top-level key the baseline lacks (which
 * `calculateResourceDrift`'s state-keys-only walk simply never reaches), these
 * are members of an ARRAY the baseline DOES carry, and `deepEqual` compares
 * arrays positionally.
 *
 * Two failures, and the second is the one the whole array shape turns on:
 *  1. a `properties` (template) baseline can never equal the readback;
 *  2. `ItemCount` / `IndexSizeBytes` MOVE with write traffic, so a normal
 *     untouched in-use table with any GSI drifts against its own
 *     `observedProperties` on a schedule set by its own traffic.
 */
describe('DynamoDBTableProvider secondary-index drift phantoms (issue #1767)', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new DynamoDBTableProvider();
  });

  /** Drive the real readback for a table AWS describes with these indexes. */
  async function readback(
    desired: Record<string, unknown> | undefined,
    table: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    primeDescribeTable({ TableName: TABLE_NAME, TableArn: TABLE_ARN, ...table });
    return provider.readCurrentState(TABLE_NAME, 'L', RESOURCE_TYPE, desired);
  }

  describe('readCurrentState reverse-maps the index description', () => {
    it('drops every AWS-managed member of a GSI', async () => {
      const result = await readback(
        { TableName: TABLE_NAME, GlobalSecondaryIndexes: [TEMPLATE_GSI] },
        { GlobalSecondaryIndexes: [AWS_GSI_DESCRIPTION] }
      );

      // The whole entry, not a member-by-member probe: an allow-list mapper is
      // only sound if nothing ELSE survives, and a `not.toHaveProperty` list
      // written from the issue would have missed `Backfilling`.
      expect(result?.['GlobalSecondaryIndexes']).toEqual([
        {
          IndexName: 'gsi1',
          KeySchema: [{ AttributeName: 'gsipk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
        },
      ]);
    });

    it('drops every AWS-managed member of an LSI', async () => {
      const result = await readback(
        { TableName: TABLE_NAME, LocalSecondaryIndexes: [TEMPLATE_LSI] },
        { LocalSecondaryIndexes: [AWS_LSI_DESCRIPTION] }
      );

      expect(result?.['LocalSecondaryIndexes']).toEqual([TEMPLATE_LSI]);
    });

    it('emits the per-index ProvisionedThroughput when the template declares it, trimmed of AWS bookkeeping', async () => {
      const declared = {
        TableName: TABLE_NAME,
        GlobalSecondaryIndexes: [
          { ...TEMPLATE_GSI, ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 } },
        ],
      };
      const result = await readback(declared, {
        GlobalSecondaryIndexes: [
          {
            ...AWS_GSI_DESCRIPTION,
            ProvisionedThroughput: {
              NumberOfDecreasesToday: 2,
              ReadCapacityUnits: 5,
              WriteCapacityUnits: 5,
              LastIncreaseDateTime: new Date('2026-08-13T00:00:00Z'),
            },
          },
        ],
      });

      expect(result?.['GlobalSecondaryIndexes']).toEqual([
        {
          ...TEMPLATE_GSI,
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        },
      ]);
    });

    it('emits the per-index WarmThroughput / OnDemandThroughput only when the template declares each', async () => {
      const declared = {
        TableName: TABLE_NAME,
        GlobalSecondaryIndexes: [
          {
            ...TEMPLATE_GSI,
            WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
          },
        ],
      };
      const result = await readback(declared, {
        GlobalSecondaryIndexes: [
          {
            ...AWS_GSI_DESCRIPTION,
            OnDemandThroughput: { MaxReadRequestUnits: 100, MaxWriteRequestUnits: 50 },
            WarmThroughput: {
              ReadUnitsPerSecond: 24000,
              WriteUnitsPerSecond: 8000,
              // AWS-managed, never surfaced.
              Status: 'ACTIVE',
            },
          },
        ],
      });

      expect(result?.['GlobalSecondaryIndexes']).toEqual([
        {
          ...TEMPLATE_GSI,
          WarmThroughput: { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000 },
        },
      ]);
    });

    it('emits the per-index OnDemandThroughput when the template declares it', async () => {
      // The third throughput block has its own gate, and deleting the whole
      // block used to leave every other case green — a template-declared key
      // silently missing from the readback is phantom drift on every run.
      const declared = {
        TableName: TABLE_NAME,
        GlobalSecondaryIndexes: [
          {
            ...TEMPLATE_GSI,
            OnDemandThroughput: { MaxReadRequestUnits: 100, MaxWriteRequestUnits: 50 },
          },
        ],
      };
      const result = await readback(declared, {
        GlobalSecondaryIndexes: [
          {
            ...AWS_GSI_DESCRIPTION,
            OnDemandThroughput: { MaxReadRequestUnits: 100, MaxWriteRequestUnits: 50 },
          },
        ],
      });

      expect(result?.['GlobalSecondaryIndexes']).toEqual([
        {
          ...TEMPLATE_GSI,
          OnDemandThroughput: { MaxReadRequestUnits: 100, MaxWriteRequestUnits: 50 },
        },
      ]);
    });

    it('emits only the members AWS actually reports for a declared block', async () => {
      const declared = {
        TableName: TABLE_NAME,
        GlobalSecondaryIndexes: [
          { ...TEMPLATE_GSI, OnDemandThroughput: { MaxReadRequestUnits: 100 } },
        ],
      };
      const result = await readback(declared, {
        GlobalSecondaryIndexes: [
          { ...AWS_GSI_DESCRIPTION, OnDemandThroughput: { MaxReadRequestUnits: 100 } },
        ],
      });

      expect(result?.['GlobalSecondaryIndexes']).toEqual([
        { ...TEMPLATE_GSI, OnDemandThroughput: { MaxReadRequestUnits: 100 } },
      ]);
    });

    it('copies KeySchema rather than aliasing the SDK response array', async () => {
      // Every other member is a fresh object; handing back a live reference into
      // the SDK response would let a mutation of the emitted snapshot reach into
      // it (and vice versa).
      const live = { ...AWS_GSI_DESCRIPTION };
      const result = await readback(
        { TableName: TABLE_NAME, GlobalSecondaryIndexes: [TEMPLATE_GSI] },
        { GlobalSecondaryIndexes: [live] }
      );

      const emitted = (result?.['GlobalSecondaryIndexes'] as Array<Record<string, unknown>>)[0]!;
      expect(emitted['KeySchema']).toEqual(live.KeySchema);
      expect(emitted['KeySchema']).not.toBe(live.KeySchema);
      expect((emitted['KeySchema'] as unknown[])[0]).not.toBe(live.KeySchema[0]);
    });

    it('copies NonKeyAttributes rather than aliasing it', async () => {
      // The sibling of the KeySchema case: `Projection` is rebuilt member by
      // member, but the array INSIDE it was handed straight back.
      const live = { ...AWS_LSI_DESCRIPTION };
      const result = await readback(
        { TableName: TABLE_NAME, LocalSecondaryIndexes: [TEMPLATE_LSI] },
        { LocalSecondaryIndexes: [live] }
      );

      const projection = (
        (result?.['LocalSecondaryIndexes'] as Array<Record<string, unknown>>)[0] as Record<
          string,
          Record<string, unknown>
        >
      )['Projection']!;
      expect(projection['NonKeyAttributes']).toEqual(live.Projection.NonKeyAttributes);
      expect(projection['NonKeyAttributes']).not.toBe(live.Projection.NonKeyAttributes);
    });

    it('emits OnDemand + Warm for a description with NO ProvisionedThroughput key', async () => {
      // The ordinary PAY_PER_REQUEST-with-caps readback: AWS omits the
      // `ProvisionedThroughput` key entirely. A single
      // `if (!('ProvisionedThroughput' in live)) return out;` guard ahead of
      // all three blocks type-checks the same and drops BOTH declared blocks
      // here — permanent one-sided drift, i.e. the defect this mapper exists
      // to remove (PR review round 4). Every member is SDK-optional, so the
      // narrowing has to be per block.
      const declared = {
        TableName: TABLE_NAME,
        GlobalSecondaryIndexes: [
          {
            ...TEMPLATE_GSI,
            OnDemandThroughput: { MaxReadRequestUnits: 100, MaxWriteRequestUnits: 50 },
            WarmThroughput: { ReadUnitsPerSecond: 12001, WriteUnitsPerSecond: 4000 },
          },
        ],
      };
      const result = await readback(declared, {
        GlobalSecondaryIndexes: [
          {
            IndexName: 'gsi1',
            KeySchema: [{ AttributeName: 'gsipk', KeyType: 'HASH' }],
            Projection: { ProjectionType: 'ALL' },
            IndexStatus: 'ACTIVE',
            // No ProvisionedThroughput KEY at all — not `undefined`, absent.
            OnDemandThroughput: { MaxReadRequestUnits: 100, MaxWriteRequestUnits: 50 },
            WarmThroughput: {
              ReadUnitsPerSecond: 12001,
              WriteUnitsPerSecond: 4000,
              Status: 'ACTIVE',
            },
            IndexArn: `${TABLE_ARN}/index/gsi1`,
          },
        ],
      });

      expect(result?.['GlobalSecondaryIndexes']).toEqual([
        {
          ...TEMPLATE_GSI,
          OnDemandThroughput: { MaxReadRequestUnits: 100, MaxWriteRequestUnits: 50 },
          WarmThroughput: { ReadUnitsPerSecond: 12001, WriteUnitsPerSecond: 4000 },
        },
      ]);
    });

    it('still drops the AWS-managed members on that same shape', async () => {
      // The other half: dropping the coupling must not weaken the allow-list.
      const result = await readback(
        { TableName: TABLE_NAME, GlobalSecondaryIndexes: [TEMPLATE_GSI] },
        {
          GlobalSecondaryIndexes: [
            {
              IndexName: 'gsi1',
              KeySchema: [{ AttributeName: 'gsipk', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'ALL' },
              IndexStatus: 'ACTIVE',
              Backfilling: false,
              ItemCount: 41_233,
              IndexSizeBytes: 82_310_400,
              IndexArn: `${TABLE_ARN}/index/gsi1`,
              OnDemandThroughput: { MaxReadRequestUnits: 100 },
              WarmThroughput: { ReadUnitsPerSecond: 12001, Status: 'ACTIVE' },
            },
          ],
        }
      );

      expect(result?.['GlobalSecondaryIndexes']).toEqual([TEMPLATE_GSI]);
    });

    it('matches the desired entry by IndexName, never by position', async () => {
      // The declared order is the REVERSE of the AWS order, and only `gsi2`
      // declares capacity — so a positional match would attach the capacity
      // gate to the wrong index and the assertion below would swap.
      const declared = {
        TableName: TABLE_NAME,
        GlobalSecondaryIndexes: [
          {
            IndexName: 'gsi2',
            KeySchema: [{ AttributeName: 'other', KeyType: 'HASH' }],
            Projection: { ProjectionType: 'KEYS_ONLY' },
            ProvisionedThroughput: { ReadCapacityUnits: 7, WriteCapacityUnits: 7 },
          },
          TEMPLATE_GSI,
        ],
      };
      const result = await readback(declared, {
        GlobalSecondaryIndexes: [
          AWS_GSI_DESCRIPTION,
          {
            IndexName: 'gsi2',
            KeySchema: [{ AttributeName: 'other', KeyType: 'HASH' }],
            Projection: { ProjectionType: 'KEYS_ONLY' },
            IndexStatus: 'ACTIVE',
            ProvisionedThroughput: {
              NumberOfDecreasesToday: 0,
              ReadCapacityUnits: 7,
              WriteCapacityUnits: 7,
            },
            IndexArn: `${TABLE_ARN}/index/gsi2`,
          },
        ],
      });

      expect(result?.['GlobalSecondaryIndexes']).toEqual([
        TEMPLATE_GSI,
        {
          IndexName: 'gsi2',
          KeySchema: [{ AttributeName: 'other', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'KEYS_ONLY' },
          ProvisionedThroughput: { ReadCapacityUnits: 7, WriteCapacityUnits: 7 },
        },
      ]);
    });

    it('emits the throughput blocks for an UNINFORMATIVE bag, still trimmed of AWS-managed members', async () => {
      // The `WarmThroughput` gate's own rule (issue #1760), one level down: an
      // absent / empty bag is "the caller supplied nothing to decide with", so
      // the pre-gate behavior is kept for the blocks — but the read-only
      // members are dropped unconditionally, because no bag can ever declare
      // them.
      for (const bag of [undefined, {}]) {
        const result = await readback(bag, { GlobalSecondaryIndexes: [AWS_GSI_DESCRIPTION] });
        expect({ bag, entries: result?.['GlobalSecondaryIndexes'] }).toEqual({
          bag,
          entries: [
            {
              ...TEMPLATE_GSI,
              ProvisionedThroughput: { ReadCapacityUnits: 0, WriteCapacityUnits: 0 },
              WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
            },
          ],
        });
      }
    });

    it('treats an index AWS has and the template does not as declaring nothing', async () => {
      // An out-of-band index: an INFORMATIVE bag that names no entry for it,
      // so no block cdkd sent can explain its throughput.
      const result = await readback(
        { TableName: TABLE_NAME, GlobalSecondaryIndexes: [] },
        { GlobalSecondaryIndexes: [AWS_GSI_DESCRIPTION] }
      );

      expect(result?.['GlobalSecondaryIndexes']).toEqual([TEMPLATE_GSI]);
    });

    it('treats a NON-ARRAY desired index list as declaring nothing rather than throwing', async () => {
      const result = await readback(
        { TableName: TABLE_NAME, GlobalSecondaryIndexes: { Ref: 'Unresolved' } },
        { GlobalSecondaryIndexes: [AWS_GSI_DESCRIPTION] }
      );

      expect(result?.['GlobalSecondaryIndexes']).toEqual([TEMPLATE_GSI]);
    });

    it('omits the key entirely when AWS reports no indexes', async () => {
      const result = await readback({ TableName: TABLE_NAME }, {});

      expect(result).toBeDefined();
      expect(result).not.toHaveProperty('GlobalSecondaryIndexes');
      expect(result).not.toHaveProperty('LocalSecondaryIndexes');
    });
  });

  describe('the comparator end (what the fix is actually for)', () => {
    it('failure 2: an in-use table whose ItemCount moved compares CLEAN against its own capture', async () => {
      // The ORDINARY path, and the reason this outranks failure 1: both sides
      // are produced by the REAL `readCurrentState` — a deploy-time capture,
      // then a later drift read of the same table after write traffic — rather
      // than by two hand-written literals that could only agree with each
      // other.
      const declared = { TableName: TABLE_NAME, GlobalSecondaryIndexes: [TEMPLATE_GSI] };
      const captured = await readback(declared, {
        GlobalSecondaryIndexes: [AWS_GSI_DESCRIPTION],
      });
      const current = await readback(declared, {
        GlobalSecondaryIndexes: [AWS_GSI_DESCRIPTION_IN_USE],
      });

      const drifts = calculateResourceDrift(captured!, current!, {
        ignorePaths: provider.getDriftUnknownPaths(RESOURCE_TYPE, declared),
        unorderedPaths: provider.getDriftUnorderedPaths(RESOURCE_TYPE),
        unionWalkObjects: true,
      });
      expect(drifts).toEqual([]);
    });

    it('failure 1: a TEMPLATE baseline compares CLEAN against the readback', async () => {
      const declared = {
        TableName: TABLE_NAME,
        GlobalSecondaryIndexes: [TEMPLATE_GSI],
        LocalSecondaryIndexes: [TEMPLATE_LSI],
      };
      const current = await readback(declared, {
        GlobalSecondaryIndexes: [AWS_GSI_DESCRIPTION_IN_USE],
        LocalSecondaryIndexes: [AWS_LSI_DESCRIPTION],
      });

      const drifts = calculateResourceDrift(declared, current!, {
        ignorePaths: provider.getDriftUnknownPaths(RESOURCE_TYPE, declared),
        unorderedPaths: provider.getDriftUnorderedPaths(RESOURCE_TYPE),
      });
      expect(drifts).toEqual([]);
    });

    it('still reports a REAL out-of-band index removal', async () => {
      const declared = { TableName: TABLE_NAME, GlobalSecondaryIndexes: [TEMPLATE_GSI] };
      const captured = await readback(declared, {
        GlobalSecondaryIndexes: [AWS_GSI_DESCRIPTION],
      });
      const current = await readback(declared, {});

      const drifts = calculateResourceDrift(captured!, current!, {
        ignorePaths: provider.getDriftUnknownPaths(RESOURCE_TYPE, declared),
        unorderedPaths: provider.getDriftUnorderedPaths(RESOURCE_TYPE),
        unionWalkObjects: true,
      });
      expect(drifts.map((d) => d.path)).toEqual(['GlobalSecondaryIndexes']);
    });

    it('still reports a REAL per-index capacity change the template declared', async () => {
      const declared = {
        TableName: TABLE_NAME,
        BillingMode: 'PROVISIONED',
        GlobalSecondaryIndexes: [
          { ...TEMPLATE_GSI, ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 } },
        ],
      };
      const current = await readback(declared, {
        BillingModeSummary: { BillingMode: 'PROVISIONED' },
        GlobalSecondaryIndexes: [
          {
            ...AWS_GSI_DESCRIPTION,
            ProvisionedThroughput: {
              NumberOfDecreasesToday: 0,
              ReadCapacityUnits: 25,
              WriteCapacityUnits: 5,
            },
          },
        ],
      });

      const drifts = calculateResourceDrift(declared, current!, {
        ignorePaths: provider.getDriftUnknownPaths(RESOURCE_TYPE, declared),
        unorderedPaths: provider.getDriftUnorderedPaths(RESOURCE_TYPE),
      });
      expect(drifts.map((d) => d.path)).toEqual(['GlobalSecondaryIndexes']);
    });
  });

  describe('the getDriftUnknownPaths companion (existing baselines)', () => {
    it('ignores both index lists when the template declares neither', () => {
      expect(provider.getDriftUnknownPaths(RESOURCE_TYPE, { TableName: TABLE_NAME })).toEqual([
        'WarmThroughput',
        'GlobalSecondaryIndexes',
        'LocalSecondaryIndexes',
      ]);
    });

    it('keeps comparing a list the template DOES declare', () => {
      expect(
        provider.getDriftUnknownPaths(RESOURCE_TYPE, {
          TableName: TABLE_NAME,
          WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
          GlobalSecondaryIndexes: [TEMPLATE_GSI],
        })
      ).toEqual(['LocalSecondaryIndexes']);
    });

    it('falls back to COMPARING for an absent / empty bag and for another type', () => {
      expect(provider.getDriftUnknownPaths(RESOURCE_TYPE)).toEqual([]);
      expect(provider.getDriftUnknownPaths(RESOURCE_TYPE, {})).toEqual([]);
      expect(
        provider.getDriftUnknownPaths('AWS::DynamoDB::GlobalTable', { TableName: TABLE_NAME })
      ).toEqual([]);
    });

    it('reports no drift for a STALE observed baseline on a table the template declares no index for', async () => {
      // A record written by an earlier binary: the deploy-time capture froze
      // the whole SDK description into observedProperties, and the AWS side no
      // longer emits its AWS-managed members. Without the companion this is a
      // one-sided drift on the first `cdkd drift` after the upgrade.
      const declared = { TableName: TABLE_NAME };
      const staleObserved = {
        TableName: TABLE_NAME,
        GlobalSecondaryIndexes: [AWS_GSI_DESCRIPTION],
      };
      const current = await readback(declared, {
        GlobalSecondaryIndexes: [AWS_GSI_DESCRIPTION],
      });

      const drifts = calculateResourceDrift(staleObserved, current!, {
        ignorePaths: provider.getDriftUnknownPaths(RESOURCE_TYPE, declared),
        unorderedPaths: provider.getDriftUnorderedPaths(RESOURCE_TYPE),
        unionWalkObjects: true,
      });
      expect(drifts).toEqual([]);
    });

    it('CARRIES the residual for a table that DOES declare indexes (issue #1784)', async () => {
      // Pinned so the accepted trade is visible rather than discovered: the
      // comparator is never asked about a path that crosses an array, so the
      // only expressible suppression here is the WHOLE list — which would mean
      // never detecting an out-of-band index change again. The stranded report
      // is one-sided, non-mutating, and cleared by the next deploy or by
      // `cdkd drift --accept`.
      const declared = { TableName: TABLE_NAME, GlobalSecondaryIndexes: [TEMPLATE_GSI] };
      const staleObserved = {
        TableName: TABLE_NAME,
        GlobalSecondaryIndexes: [AWS_GSI_DESCRIPTION],
      };
      const current = await readback(declared, {
        GlobalSecondaryIndexes: [AWS_GSI_DESCRIPTION],
      });

      const drifts = calculateResourceDrift(staleObserved, current!, {
        ignorePaths: provider.getDriftUnknownPaths(RESOURCE_TYPE, declared),
        unorderedPaths: provider.getDriftUnorderedPaths(RESOURCE_TYPE),
        unionWalkObjects: true,
      });
      expect(drifts.map((d) => d.path)).toEqual(['GlobalSecondaryIndexes']);
    });
  });

  describe('the emit gate and the ignore path answer the same question', () => {
    it('agrees for every index-list shape a template can carry', async () => {
      // The two consumers must never disagree: a bag whose list the MAPPER
      // treats as declaring nothing must also have the path IGNORED, or the
      // readback strips the throughput blocks while the comparison still
      // demands them — a one-sided difference manufactured by the pair. Both
      // consumers are DRIVEN here rather than re-implemented.
      const bags: Array<Record<string, unknown> | undefined> = [
        undefined,
        {},
        { TableName: TABLE_NAME },
        { TableName: TABLE_NAME, GlobalSecondaryIndexes: [] },
        { TableName: TABLE_NAME, GlobalSecondaryIndexes: { 'Fn::If': ['C', [], []] } },
        { TableName: TABLE_NAME, GlobalSecondaryIndexes: null },
        { TableName: TABLE_NAME, GlobalSecondaryIndexes: [TEMPLATE_GSI] },
        // The ENTRY declares WarmThroughput with no usable member. The write
        // path refuses it, so the readback must not emit AWS's computed value
        // as though the template had asked — the #1760 phantom one nesting
        // level down. Widening `indexDeclares` back to `Boolean(value)` was
        // GREEN across every other row here, because they vary only the LIST
        // shape (PR review).
        {
          TableName: TABLE_NAME,
          GlobalSecondaryIndexes: [{ ...TEMPLATE_GSI, WarmThroughput: {} }],
        },
      ];
      const observed: Array<{ bag: unknown; strippedThroughput: boolean; ignored: boolean }> = [];
      for (const bag of bags) {
        const result = await readback(bag, { GlobalSecondaryIndexes: [AWS_GSI_DESCRIPTION] });
        const entry = (result?.['GlobalSecondaryIndexes'] as Array<Record<string, unknown>>)[0]!;
        observed.push({
          bag,
          strippedThroughput: !('WarmThroughput' in entry) && !('ProvisionedThroughput' in entry),
          ignored: provider
            .getDriftUnknownPaths(RESOURCE_TYPE, bag)
            .includes('GlobalSecondaryIndexes'),
        });
      }

      // Exact expected table, written out rather than derived, so a change to
      // the rule has to be re-stated here instead of following along silently.
      expect(observed).toEqual([
        { bag: undefined, strippedThroughput: false, ignored: false },
        { bag: {}, strippedThroughput: false, ignored: false },
        { bag: { TableName: TABLE_NAME }, strippedThroughput: true, ignored: true },
        {
          bag: { TableName: TABLE_NAME, GlobalSecondaryIndexes: [] },
          strippedThroughput: true,
          ignored: true,
        },
        {
          bag: { TableName: TABLE_NAME, GlobalSecondaryIndexes: { 'Fn::If': ['C', [], []] } },
          strippedThroughput: true,
          ignored: true,
        },
        {
          bag: { TableName: TABLE_NAME, GlobalSecondaryIndexes: null },
          strippedThroughput: true,
          ignored: true,
        },
        {
          bag: { TableName: TABLE_NAME, GlobalSecondaryIndexes: [TEMPLATE_GSI] },
          strippedThroughput: true,
          ignored: false,
        },
        {
          bag: {
            TableName: TABLE_NAME,
            GlobalSecondaryIndexes: [{ ...TEMPLATE_GSI, WarmThroughput: {} }],
          },
          strippedThroughput: true,
          ignored: false,
        },
      ]);
      // The invariant itself, stated once over the measured pairs: a list whose
      // members were stripped for lack of a declaration is a list that must not
      // be compared. (The last row strips because the DECLARED entry names no
      // throughput block, which is a per-member answer, not a per-list one.)
      for (const row of observed.slice(0, 6)) {
        expect({ bag: row.bag, agree: row.strippedThroughput === row.ignored }).toEqual({
          bag: row.bag,
          agree: true,
        });
      }
    });

    it('uses the LAST entry when a template declares one IndexName twice', async () => {
      // Not a shape AWS accepts, but a template can carry it and the mapper must
      // be deterministic rather than order-dependent-by-accident.
      const result = await readback(
        {
          TableName: TABLE_NAME,
          GlobalSecondaryIndexes: [
            TEMPLATE_GSI,
            {
              ...TEMPLATE_GSI,
              WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
            },
          ],
        },
        { GlobalSecondaryIndexes: [AWS_GSI_DESCRIPTION] }
      );

      expect(result?.['GlobalSecondaryIndexes']).toEqual([
        { ...TEMPLATE_GSI, WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 } },
      ]);
    });
  });

  describe('getDriftUnorderedPaths', () => {
    it('does NOT declare the index lists — the subtree rule would sort per-index KeySchema (issue #1783)', () => {
      const paths = provider.getDriftUnorderedPaths(RESOURCE_TYPE);
      expect(paths).toEqual(['AttributeDefinitions']);
      expect(paths).not.toContain('GlobalSecondaryIndexes');
      expect(paths).not.toContain('LocalSecondaryIndexes');
    });

    it('a per-index KeySchema is left ORDER-SIGNIFICANT by that decision', () => {
      // The mechanism the decision turns on: `canonicalizeUnorderedArraysAtPaths`
      // descends into array ELEMENTS with the parent path, so a
      // `GlobalSecondaryIndexes` entry would also match
      // `GlobalSecondaryIndexes.KeySchema`. This drives the real comparator to
      // show the per-index key schema is still compared positionally.
      const withOrder = (keySchema: unknown) => ({
        GlobalSecondaryIndexes: [{ IndexName: 'gsi1', KeySchema: keySchema }],
      });
      const drifts = calculateResourceDrift(
        withOrder([
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ]),
        withOrder([
          { AttributeName: 'sk', KeyType: 'RANGE' },
          { AttributeName: 'pk', KeyType: 'HASH' },
        ]),
        { unorderedPaths: provider.getDriftUnorderedPaths(RESOURCE_TYPE) }
      );
      expect(drifts.map((d) => d.path)).toEqual(['GlobalSecondaryIndexes']);
    });
  });
});
