import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { UpdateTableCommand } from '@aws-sdk/client-dynamodb';

const { mockSend, childLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  childLogger.child.mockReturnValue(childLogger);
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

const TABLE_NAME = 'my-table';
const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:111111111111:table/my-table';
const RESOURCE_TYPE = 'AWS::DynamoDB::Table';

const KEY_SCHEMA = [{ AttributeName: 'gsipk', KeyType: 'HASH' }];
const PROJECTION = { ProjectionType: 'ALL' };

function findCalls<T>(ctor: new (...args: never[]) => T): T[] {
  return mockSend.mock.calls.filter((c) => c[0] instanceof ctor).map((c) => c[0] as T);
}

function gsiUpdates(): unknown[] {
  return findCalls(UpdateTableCommand).flatMap((c) => c.input.GlobalSecondaryIndexUpdates ?? []);
}

function warnText(): string {
  return childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
}

/** Answer EVERY DescribeTable with one snapshot: the counts are not the subject. */
function primeLiveTable(table: Record<string, unknown>): void {
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof UpdateTableCommand) return Promise.resolve({});
    return Promise.resolve({
      Table: {
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        TableStatus: 'ACTIVE',
        ...table,
      },
    });
  });
}

let provider: DynamoDBTableProvider;

beforeEach(() => {
  // `mockReset`, not just `clearAllMocks` (issue #1618): the latter leaves the
  // `*Once` queue, so a surplus primer shifts every later test in the file.
  mockSend.mockReset();
  vi.clearAllMocks();
  childLogger.child.mockReturnValue(childLogger);
  provider = new DynamoDBTableProvider();
});

/**
 * The GSI WRITE path's two residuals, both found by the review of the #1767 /
 * #1768 PR:
 *
 *  - a per-index `ProvisionedThroughput` of `{0, 0}` — AWS's on-demand
 *    placeholder — reaching `UpdateTable` as a capacity request AWS refuses.
 *    Newly REACHABLE because of #1767: it arrives from a pre-#1767
 *    `observedProperties` blob via `cdkd drift --revert`, and before #1767 both
 *    comparison sides carried that blob, so no revert was ever offered.
 *  - a per-index `WarmThroughput` that `readCurrentState` emits and
 *    `applyGsiUpdates` never SENT, so the property was silently dropped and
 *    `--revert` exited 0 claiming success — the #1768 dead end one level down,
 *    silent instead of loud.
 */
describe('DynamoDBTableProvider GSI write path (issues #1767 / #1768)', () => {
  describe('the {0, 0} capacity placeholder is never sent', () => {
    /** The stale shape: a pre-#1767 observedProperties index entry. */
    const staleIndexEntry = {
      IndexName: 'gsi1',
      KeySchema: KEY_SCHEMA,
      Projection: PROJECTION,
      IndexStatus: 'ACTIVE',
      ProvisionedThroughput: {
        NumberOfDecreasesToday: 0,
        ReadCapacityUnits: 0,
        WriteCapacityUnits: 0,
      },
      IndexSizeBytes: 0,
      ItemCount: 0,
      IndexArn: `${TABLE_ARN}/index/gsi1`,
    };
    /** What #1767's readback now emits for the same index. */
    const trimmedIndexEntry = { IndexName: 'gsi1', KeySchema: KEY_SCHEMA, Projection: PROJECTION };

    it('skips the capacity Update a --revert of a stale blob would emit, and says why', async () => {
      // Exactly the `drift --revert` call shape: the stale baseline as the
      // DESIRED side, the trimmed readback as the previous side, on a
      // PAY_PER_REQUEST table (where the #1630 idempotency skip is disabled, so
      // nothing else stands between this value and AWS).
      primeLiveTable({
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        GlobalSecondaryIndexes: [staleIndexEntry],
      });

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        { GlobalSecondaryIndexes: [staleIndexEntry] },
        { GlobalSecondaryIndexes: [trimmedIndexEntry] }
      );

      expect(gsiUpdates()).toEqual([]);
      expect(warnText()).toContain('on-demand placeholder');
      expect(warnText()).toContain('cdkd drift --revert');
    });

    it('skips it on a PROVISIONED table too — AWS refuses capacity 0 in either mode', async () => {
      primeLiveTable({
        BillingModeSummary: { BillingMode: 'PROVISIONED' },
        GlobalSecondaryIndexes: [
          {
            ...staleIndexEntry,
            ProvisionedThroughput: {
              NumberOfDecreasesToday: 0,
              ReadCapacityUnits: 5,
              WriteCapacityUnits: 5,
            },
          },
        ],
      });

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        { BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [staleIndexEntry] },
        {
          BillingMode: 'PROVISIONED',
          GlobalSecondaryIndexes: [
            {
              ...trimmedIndexEntry,
              ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
            },
          ],
        }
      );

      expect(gsiUpdates()).toEqual([]);
    });

    it('skips the STRING-spelled placeholder too — a state record re-serialized as YAML', async () => {
      // `capacityNumber` accepts a numeric string on purpose, and a probe that
      // removed that coercion left every test in the tree green: the inputs
      // were all numeric `0`. A `{"0", "0"}` is exactly what a pre-#1767 state
      // record looks like once it has been through a YAML round-trip or an
      // `Fn::Sub`, and it is refused by AWS identically.
      primeLiveTable({
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        GlobalSecondaryIndexes: [staleIndexEntry],
      });

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          GlobalSecondaryIndexes: [
            {
              ...trimmedIndexEntry,
              ProvisionedThroughput: { ReadCapacityUnits: '0', WriteCapacityUnits: '0' },
            },
          ],
        },
        { GlobalSecondaryIndexes: [trimmedIndexEntry] }
      );

      expect(gsiUpdates()).toEqual([]);
      expect(warnText()).toContain('on-demand placeholder');
    });

    it('skips it on the ADOPTED-index arm too (empty recorded previous)', async () => {
      // Every other {0, 0} row here drives the SAME-NAME arm. The adopted arm
      // is reached when AWS already HAS the index and cdkd's recorded previous
      // does not — an earlier deploy that created it and then threw — so the
      // Create is skipped and the capacity is REPAIRED instead. That repair
      // path has its own `skipZeroCapacityIndexUpdate` call, and removing it
      // was GREEN across the whole suite until this row (PR review round 4).
      primeLiveTable({
        BillingModeSummary: { BillingMode: 'PROVISIONED' },
        GlobalSecondaryIndexes: [
          {
            IndexName: 'gsi1',
            KeySchema: KEY_SCHEMA,
            Projection: PROJECTION,
            IndexStatus: 'ACTIVE',
            ProvisionedThroughput: {
              NumberOfDecreasesToday: 0,
              ReadCapacityUnits: 5,
              WriteCapacityUnits: 5,
            },
          },
        ],
      });

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          BillingMode: 'PROVISIONED',
          GlobalSecondaryIndexes: [
            {
              ...trimmedIndexEntry,
              ProvisionedThroughput: { ReadCapacityUnits: 0, WriteCapacityUnits: 0 },
            },
          ],
        },
        // EMPTY recorded previous: the index is absent from cdkd state, which
        // is what routes this through the adopted arm rather than the
        // same-name one.
        { BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [] }
      );

      expect(gsiUpdates()).toEqual([]);
      expect(warnText()).toContain('on-demand placeholder');
    });

    it('still SENDS the INVERSE half-zero capacity {7, 0}', async () => {
      // The mirror of the `{0, 7}` row below: a guard written as "either member
      // is 0" would refuse both, and only one of the two orders would catch it.
      primeLiveTable({
        BillingModeSummary: { BillingMode: 'PROVISIONED' },
        GlobalSecondaryIndexes: [
          {
            ...staleIndexEntry,
            ProvisionedThroughput: {
              NumberOfDecreasesToday: 0,
              ReadCapacityUnits: 5,
              WriteCapacityUnits: 5,
            },
          },
        ],
      });

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          BillingMode: 'PROVISIONED',
          GlobalSecondaryIndexes: [
            {
              ...trimmedIndexEntry,
              ProvisionedThroughput: { ReadCapacityUnits: 7, WriteCapacityUnits: 0 },
            },
          ],
        },
        {
          BillingMode: 'PROVISIONED',
          GlobalSecondaryIndexes: [
            {
              ...trimmedIndexEntry,
              ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
            },
          ],
        }
      );

      expect(gsiUpdates()).toEqual([
        {
          Update: {
            IndexName: 'gsi1',
            ProvisionedThroughput: { ReadCapacityUnits: 7, WriteCapacityUnits: 0 },
          },
        },
      ]);
    });

    it('still SENDS a half-zero capacity — only the exact placeholder is refused', async () => {
      // Fail OPEN on anything that is not the placeholder: AWS answers a
      // malformed capacity by name, which is the pre-fix behavior and better
      // than cdkd guessing.
      primeLiveTable({
        BillingModeSummary: { BillingMode: 'PROVISIONED' },
        GlobalSecondaryIndexes: [
          {
            ...staleIndexEntry,
            ProvisionedThroughput: {
              NumberOfDecreasesToday: 0,
              ReadCapacityUnits: 5,
              WriteCapacityUnits: 5,
            },
          },
        ],
      });

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          BillingMode: 'PROVISIONED',
          GlobalSecondaryIndexes: [
            {
              ...trimmedIndexEntry,
              ProvisionedThroughput: { ReadCapacityUnits: 0, WriteCapacityUnits: 7 },
            },
          ],
        },
        {
          BillingMode: 'PROVISIONED',
          GlobalSecondaryIndexes: [
            {
              ...trimmedIndexEntry,
              ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
            },
          ],
        }
      );

      expect(gsiUpdates()).toEqual([
        {
          Update: {
            IndexName: 'gsi1',
            ProvisionedThroughput: { ReadCapacityUnits: 0, WriteCapacityUnits: 7 },
          },
        },
      ]);
    });
  });

  describe('one Update action per index', () => {
    it('carries capacity AND warm throughput on the SAME action when both change', async () => {
      // Two ops meant two `UpdateTable` calls PLUS two full index-ACTIVE waits
      // against the 1800s budget, for one index (PR review).
      // `UpdateGlobalSecondaryIndexAction` takes both members, both optional.
      primeLiveTable({
        BillingModeSummary: { BillingMode: 'PROVISIONED' },
        GlobalSecondaryIndexes: [
          {
            IndexName: 'gsi1',
            KeySchema: KEY_SCHEMA,
            Projection: PROJECTION,
            IndexStatus: 'ACTIVE',
            ProvisionedThroughput: {
              NumberOfDecreasesToday: 0,
              ReadCapacityUnits: 5,
              WriteCapacityUnits: 5,
            },
            WarmThroughput: {
              ReadUnitsPerSecond: 12000,
              WriteUnitsPerSecond: 4000,
              Status: 'ACTIVE',
            },
          },
        ],
      });

      const index = (read: number, warm: number) => ({
        IndexName: 'gsi1',
        KeySchema: KEY_SCHEMA,
        Projection: PROJECTION,
        ProvisionedThroughput: { ReadCapacityUnits: read, WriteCapacityUnits: 5 },
        WarmThroughput: { ReadUnitsPerSecond: warm, WriteUnitsPerSecond: 4000 },
      });

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        { BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [index(25, 24000)] },
        { BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [index(5, 12000)] }
      );

      expect(gsiUpdates()).toEqual([
        {
          Update: {
            IndexName: 'gsi1',
            ProvisionedThroughput: { ReadCapacityUnits: 25, WriteCapacityUnits: 5 },
            WarmThroughput: { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 4000 },
          },
        },
      ]);
    });
  });

  describe('the ADOPTED-index arm merges its repairs too', () => {
    it('repairs capacity AND warm throughput on ONE action for an adopted index', async () => {
      // Every other adopted-arm row is PAY_PER_REQUEST, where
      // `liveCapacityComparable` is false so the capacity half never
      // co-populates — splitting the action back into two ops was invisible to
      // all of them (PR review round 7). A PROVISIONED adopted index needing
      // both repairs is reachable: AWS has the index (an earlier deploy created
      // it and then threw), cdkd's recorded previous does not, so the Create is
      // skipped and both members are repaired in place.
      primeLiveTable({
        BillingModeSummary: { BillingMode: 'PROVISIONED' },
        GlobalSecondaryIndexes: [
          {
            IndexName: 'gsi1',
            KeySchema: KEY_SCHEMA,
            Projection: PROJECTION,
            IndexStatus: 'ACTIVE',
            ProvisionedThroughput: {
              NumberOfDecreasesToday: 0,
              ReadCapacityUnits: 5,
              WriteCapacityUnits: 5,
            },
            WarmThroughput: {
              ReadUnitsPerSecond: 12000,
              WriteUnitsPerSecond: 4000,
              Status: 'ACTIVE',
            },
          },
        ],
      });

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          BillingMode: 'PROVISIONED',
          GlobalSecondaryIndexes: [
            {
              IndexName: 'gsi1',
              KeySchema: KEY_SCHEMA,
              Projection: PROJECTION,
              ProvisionedThroughput: { ReadCapacityUnits: 25, WriteCapacityUnits: 5 },
              WarmThroughput: { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000 },
            },
          ],
        },
        // No recorded previous entry for gsi1 -> the adopted arm.
        { BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [] }
      );

      expect(gsiUpdates()).toEqual([
        {
          Update: {
            IndexName: 'gsi1',
            ProvisionedThroughput: { ReadCapacityUnits: 25, WriteCapacityUnits: 5 },
            WarmThroughput: { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000 },
          },
        },
      ]);
    });
  });

  describe('per-index WarmThroughput reaches the wire (issue #1768)', () => {
    const declaredIndex = (warm?: Record<string, number>) => ({
      IndexName: 'gsi1',
      KeySchema: KEY_SCHEMA,
      Projection: PROJECTION,
      ...(warm ? { WarmThroughput: warm } : {}),
    });
    const liveIndex = (warm?: Record<string, unknown>) => ({
      IndexName: 'gsi1',
      KeySchema: KEY_SCHEMA,
      Projection: PROJECTION,
      IndexStatus: 'ACTIVE',
      ...(warm ? { WarmThroughput: warm } : {}),
    });

    it('rides the Create action when a NEW index declares it', async () => {
      // `create()` already forwards a declared per-index WarmThroughput on the
      // CreateTable path; this arm — adding an index to an existing table — was
      // the one dropping it.
      primeLiveTable({ BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' } });

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          GlobalSecondaryIndexes: [
            declaredIndex({ ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000 }),
          ],
        },
        {}
      );

      expect(gsiUpdates()).toEqual([
        {
          Create: {
            IndexName: 'gsi1',
            KeySchema: KEY_SCHEMA,
            Projection: PROJECTION,
            WarmThroughput: { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000 },
          },
        },
      ]);
    });

    it('issues its own Update action when it INCREASES on an existing index', async () => {
      primeLiveTable({
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        GlobalSecondaryIndexes: [
          liveIndex({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000, Status: 'ACTIVE' }),
        ],
      });

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          GlobalSecondaryIndexes: [
            declaredIndex({ ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000 }),
          ],
        },
        {
          GlobalSecondaryIndexes: [
            declaredIndex({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 }),
          ],
        }
      );

      expect(gsiUpdates()).toEqual([
        {
          Update: {
            IndexName: 'gsi1',
            WarmThroughput: { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000 },
          },
        },
      ]);
    });

    it('COERCES a quoted value on the Create action (not just on Update)', async () => {
      // The Create-action arm had only an already-numeric row, where coercion
      // is the identity — forwarding `gsi.WarmThroughput` verbatim there left
      // all 126 tests green (PR review round 6).
      primeLiveTable({ BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' } });

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          GlobalSecondaryIndexes: [
            { ...declaredIndex(), WarmThroughput: { ReadUnitsPerSecond: '24000' } },
          ],
        },
        {}
      );

      expect(gsiUpdates()).toEqual([
        {
          Create: {
            IndexName: 'gsi1',
            KeySchema: KEY_SCHEMA,
            Projection: PROJECTION,
            WarmThroughput: { ReadUnitsPerSecond: 24000 },
          },
        },
      ]);
    });

    it('SKIPS a decrease and says why, instead of emitting a doomed op or none at all', async () => {
      primeLiveTable({
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        GlobalSecondaryIndexes: [
          liveIndex({ ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000, Status: 'ACTIVE' }),
        ],
      });

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          GlobalSecondaryIndexes: [
            declaredIndex({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 }),
          ],
        },
        {
          GlobalSecondaryIndexes: [
            declaredIndex({ ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000 }),
          ],
        }
      );

      expect(gsiUpdates()).toEqual([]);
      expect(warnText()).toContain('decreasing WarmThroughput is not supported');
      expect(warnText()).toContain('24000');
    });

    it('treats an already-matching value as matching even when a SIBLING member is junk', async () => {
      // The gates read the coerced spec, so `{Read: 12000, Write: 'abc'}` is
      // analysed as the `{Read: 12000}` actually sent — which AWS already
      // holds, so nothing goes out. Reading the RAW bag made both gates bail on
      // the unusable member and fail open, costing a redundant per-index
      // UpdateTable plus a full index-ACTIVE wait (PR review round 6).
      primeLiveTable({
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        GlobalSecondaryIndexes: [
          liveIndex({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000, Status: 'ACTIVE' }),
        ],
      });

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          GlobalSecondaryIndexes: [
            {
              ...declaredIndex(),
              WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 'abc' },
            },
          ],
        },
        { GlobalSecondaryIndexes: [declaredIndex()] }
      );

      expect(gsiUpdates()).toEqual([]);
      // The already-matches arm is the SECOND gate that can swallow the send —
      // the dropped-member announcement has to survive it too (PR review round
      // 8), and it is the only place that member is named.
      expect(warnText()).toContain('were dropped from the request');
    });

    it('SKIPS a decrease computed from the COERCED remainder, not the raw bag', async () => {
      // The decrease twin of the already-matches row above. Reading the raw bag
      // fails open on the unusable member and emits a per-index `UpdateTable`
      // carrying `{ReadUnitsPerSecond: 6000}` — a decrease against the live
      // `{12000, 4000}`, which AWS rejects by name.
      primeLiveTable({
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        GlobalSecondaryIndexes: [
          liveIndex({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000, Status: 'ACTIVE' }),
        ],
      });

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          GlobalSecondaryIndexes: [
            {
              ...declaredIndex(),
              WarmThroughput: { ReadUnitsPerSecond: 6000, WriteUnitsPerSecond: 'abc' },
            },
          ],
        },
        { GlobalSecondaryIndexes: [declaredIndex()] }
      );

      expect(gsiUpdates()).toEqual([]);
      // Per MESSAGE, not against the joined blob: the decrease warning prints
      // both member names in its own live-side JSON, so a blob-level check for
      // a member name fences nothing (PR review round 8).
      const messages = childLogger.warn.mock.calls.map((c) => String(c[0]));
      const decrease = messages.find((m) =>
        m.includes('decreasing WarmThroughput is not supported')
      );
      const announcement = messages.find((m) => m.includes('were dropped from the request'));
      expect(decrease).toBeDefined();
      expect(decrease).toContain('{"ReadUnitsPerSecond":6000}');
      // The announcement must survive this skip too, and it is the only place
      // the dropped member is named.
      expect(announcement).toBeDefined();
      expect(announcement).toContain('WriteUnitsPerSecond');
    });

    it('issues NOTHING when the declared value did not change', async () => {
      primeLiveTable({
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        GlobalSecondaryIndexes: [
          liveIndex({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000, Status: 'ACTIVE' }),
        ],
      });

      const props = {
        GlobalSecondaryIndexes: [
          declaredIndex({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 }),
        ],
        // A sibling change so `applyGsiUpdates` actually runs: the outer gate is
        // a JSON diff of the whole index list, and an identical list skips it.
        BillingMode: 'PAY_PER_REQUEST',
      };
      await provider.update('L', TABLE_NAME, RESOURCE_TYPE, props, props);

      expect(gsiUpdates()).toEqual([]);
    });

    it('repairs it on an ADOPTED index, where nothing else would ever send it', async () => {
      // The #1630 recovery arm: AWS already has the index, cdkd's recorded
      // previous side does not, so the Create is skipped. Without this repair
      // the declared WarmThroughput would never reach AWS at all.
      primeLiveTable({
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        GlobalSecondaryIndexes: [
          liveIndex({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000, Status: 'ACTIVE' }),
        ],
      });

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          GlobalSecondaryIndexes: [
            declaredIndex({ ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000 }),
          ],
        },
        {}
      );

      expect(gsiUpdates()).toEqual([
        {
          Update: {
            IndexName: 'gsi1',
            WarmThroughput: { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000 },
          },
        },
      ]);
    });

    it('issues NOTHING when AWS already holds the requested value (issue #1630 twin)', async () => {
      // The per-index twin of `liveCapacityAlreadyMatches`. Without it a
      // `--revert` of a pre-#1767 state blob — whose index entry carries the
      // whole DescribeTable description, WarmThroughput included — emits one
      // pure re-assert UpdateTable PLUS a full index-ACTIVE wait per GSI.
      // Compared member by member: the live side carries an AWS-managed
      // `Status`, so a structural compare could never match.
      primeLiveTable({
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        GlobalSecondaryIndexes: [
          liveIndex({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000, Status: 'ACTIVE' }),
        ],
      });

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          GlobalSecondaryIndexes: [
            declaredIndex({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 }),
          ],
        },
        { GlobalSecondaryIndexes: [declaredIndex()] }
      );

      expect(gsiUpdates()).toEqual([]);
    });

    it('the carried #1767 residual applies NOTHING: a --revert of a stale blob emits no op at all', async () => {
      // The end-to-end shape the residual note in `getDriftUnknownPaths` claims
      // is harmless. It is harmless because of THREE skips, and this drives all
      // of them at once: names match (no Create / Delete), the blob's {0, 0}
      // capacity is refused, and its WarmThroughput already matches live.
      // Delete any one of them and this row goes red — which is what makes the
      // note checkable rather than a promise.
      const staleBlob = {
        IndexName: 'gsi1',
        KeySchema: KEY_SCHEMA,
        Projection: PROJECTION,
        IndexStatus: 'ACTIVE',
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
      primeLiveTable({
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        GlobalSecondaryIndexes: [
          liveIndex({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000, Status: 'ACTIVE' }),
        ],
      });

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        { GlobalSecondaryIndexes: [staleBlob] },
        { GlobalSecondaryIndexes: [declaredIndex()] }
      );

      expect(gsiUpdates()).toEqual([]);
    });

    it('names BOTH remedies when the template may not declare the property at all', async () => {
      // The warning is reached by a template that declares a per-index
      // WarmThroughput AND by a --revert / rollback replaying a state blob for
      // an index whose template declares none. "Set it to the value AWS holds"
      // is advice about a property the second user does not have.
      primeLiveTable({
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        GlobalSecondaryIndexes: [
          liveIndex({ ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000, Status: 'ACTIVE' }),
        ],
      });

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          GlobalSecondaryIndexes: [
            declaredIndex({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 }),
          ],
        },
        { GlobalSecondaryIndexes: [declaredIndex()] }
      );

      const message = warnText();
      // The deploy-path caveat the table-level twin already carried.
      expect(message).toContain('may be the only signal');
      // Both audiences, named.
      expect(message).toContain('If your template declares');
      expect(message).toContain("cdkd drift --accept");
    });

    it('sends nothing for an EMPTY or NON-OBJECT WarmThroughput', async () => {
      // Bare truthiness used to put `WarmThroughput: {}` and
      // `WarmThroughput: 'nonsense'` on the wire — calls AWS can only reject,
      // repeated on every deploy, and newly once PER INDEX.
      for (const junk of [{}, 'nonsense', []]) {
        mockSend.mockReset();
        vi.clearAllMocks();
        provider = new DynamoDBTableProvider();
        primeLiveTable({
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
          GlobalSecondaryIndexes: [
            liveIndex({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000, Status: 'ACTIVE' }),
          ],
        });

        await provider.update(
          'L',
          TABLE_NAME,
          RESOURCE_TYPE,
          { GlobalSecondaryIndexes: [{ ...declaredIndex(), WarmThroughput: junk }] },
          {
            GlobalSecondaryIndexes: [
              declaredIndex({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 }),
            ],
          }
        );

        expect({ junk, ops: gsiUpdates() }).toEqual({ junk, ops: [] });
      }
    });

    it('WARNS when it refuses a declared value, at the Update action', async () => {
      // Tightening the send rule closed a doomed-call class SILENTLY: a member
      // typo / junk value used to reach AWS and be REJECTED BY NAME, and then
      // vanished with no warning, no debug line and a green deploy — the "loud
      // failure for a quiet lie" trade this file's adopted-index arm forbids,
      // and out of step with every other skip here (PR review).
      primeLiveTable({
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        GlobalSecondaryIndexes: [
          liveIndex({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000, Status: 'ACTIVE' }),
        ],
      });

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          GlobalSecondaryIndexes: [
            // The motivating shape: a MISSPELLED member name.
            { ...declaredIndex(), WarmThroughput: { ReadUnitsPerSecnd: 20000 } },
          ],
        },
        {
          GlobalSecondaryIndexes: [
            declaredIndex({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 }),
          ],
        }
      );

      expect(gsiUpdates()).toEqual([]);
      const message = warnText();
      expect(message).toContain('carries no usable');
      // Names the INDEX, so a table with several GSIs says which one.
      expect(message).toContain('GSI gsi1');
      // Echoes the value, so the typo is visible without a re-run.
      expect(message).toContain('ReadUnitsPerSecnd');
    });

    it('WARNS at the Create action too — the value vanishes there independently', async () => {
      primeLiveTable({ BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' } });

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        { GlobalSecondaryIndexes: [{ ...declaredIndex(), WarmThroughput: 'nonsense' }] },
        {}
      );

      // The index is still created — only the unusable block is dropped.
      expect(gsiUpdates()).toEqual([
        { Create: { IndexName: 'gsi1', KeySchema: KEY_SCHEMA, Projection: PROJECTION } },
      ]);
      expect(warnText()).toContain('carries no usable');
    });

    it('stays SILENT for an ABSENT block — the ordinary case', async () => {
      primeLiveTable({ BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' } });

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        { GlobalSecondaryIndexes: [declaredIndex()] },
        {}
      );

      expect(warnText()).toBe('');
    });

    it('stays SILENT for a FALSY block — its outcome did not change', async () => {
      // `null` / `''` were skipped silently BEFORE the send rule was tightened
      // (`Boolean(value)` was the whole rule), so warning about them would be a
      // new noise source rather than a restored signal.
      primeLiveTable({
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        GlobalSecondaryIndexes: [
          liveIndex({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000, Status: 'ACTIVE' }),
        ],
      });

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        { GlobalSecondaryIndexes: [{ ...declaredIndex(), WarmThroughput: null }] },
        {
          GlobalSecondaryIndexes: [
            declaredIndex({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 }),
          ],
        }
      );

      expect(warnText()).toBe('');
    });

    it('COERCES a YAML-borne numeric STRING to a number on the wire', async () => {
      primeLiveTable({
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        GlobalSecondaryIndexes: [
          liveIndex({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000, Status: 'ACTIVE' }),
        ],
      });

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          GlobalSecondaryIndexes: [
            { ...declaredIndex(), WarmThroughput: { ReadUnitsPerSecond: '24000' } },
          ],
        },
        { GlobalSecondaryIndexes: [declaredIndex()] }
      );

      // This row used to assert the STRING was forwarded verbatim, which is
      // exactly the defect the send-rule tightening was supposed to close: the
      // predicate blessed `'24000'` while the send path forwarded it into a
      // Long field, and DynamoDB rejects that body (PR review round 5). The
      // fix coerces, so a stringly-typed template WORKS rather than warning.
      expect(gsiUpdates()).toEqual([
        { Update: { IndexName: 'gsi1', WarmThroughput: { ReadUnitsPerSecond: 24000 } } },
      ]);
      // Nothing was dropped, so the drop warning must NOT fire.
      expect(warnText()).toBe('');
    });

    it('drops only the UNUSABLE member, sends the rest, and says which it dropped', async () => {
      // A bad member must not take a good one with it, and it must never reach
      // the wire as `NaN`.
      primeLiveTable({
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        GlobalSecondaryIndexes: [
          liveIndex({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000, Status: 'ACTIVE' }),
        ],
      });

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          GlobalSecondaryIndexes: [
            {
              ...declaredIndex(),
              WarmThroughput: { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: { Ref: 'Unset' } },
            },
          ],
        },
        { GlobalSecondaryIndexes: [declaredIndex()] }
      );

      expect(gsiUpdates()).toEqual([
        { Update: { IndexName: 'gsi1', WarmThroughput: { ReadUnitsPerSecond: 24000 } } },
      ]);
      expect(warnText()).toContain('WriteUnitsPerSecond');
      // A phrase unique to the dropped-member ANNOUNCEMENT — not a member name,
      // which the other warnings also print (PR review round 8).
      expect(warnText()).toContain('were dropped from the request');
    });

    it('does NOT re-warn for an UNCHANGED unsendable value when another index changed', async () => {
      // The placement fence. `applyGsiUpdates` runs whenever the index LIST
      // changed, and then calls `warmThroughputOpFor` for EVERY desired index —
      // so with the refusal warn above the unchanged gate, an index carrying a
      // junk WarmThroughput nobody touched re-warns on every deploy that edits
      // any other index. That is the noise the table-level placement was
      // deliberately written to avoid (PR review round 5), and moving the warn
      // back above the gate is invisible to every other row here because they
      // all CHANGE the value under test.
      const junk = { ...declaredIndex(), IndexName: 'gsi1', WarmThroughput: {} };
      const other = (read: number) => ({
        IndexName: 'gsi2',
        KeySchema: KEY_SCHEMA,
        Projection: PROJECTION,
        ProvisionedThroughput: { ReadCapacityUnits: read, WriteCapacityUnits: 5 },
      });
      primeLiveTable({
        BillingModeSummary: { BillingMode: 'PROVISIONED' },
        GlobalSecondaryIndexes: [
          { ...liveIndex(), IndexName: 'gsi1' },
          {
            IndexName: 'gsi2',
            KeySchema: KEY_SCHEMA,
            Projection: PROJECTION,
            IndexStatus: 'ACTIVE',
            ProvisionedThroughput: {
              NumberOfDecreasesToday: 0,
              ReadCapacityUnits: 5,
              WriteCapacityUnits: 5,
            },
          },
        ],
      });

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        { BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [junk, other(25)] },
        // gsi1's junk WarmThroughput is IDENTICAL on both sides — only gsi2
        // changed, which is what makes applyGsiUpdates run at all.
        { BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [junk, other(5)] }
      );

      // gsi2's real change still goes out...
      expect(gsiUpdates()).toEqual([
        {
          Update: {
            IndexName: 'gsi2',
            ProvisionedThroughput: { ReadCapacityUnits: 25, WriteCapacityUnits: 5 },
          },
        },
      ]);
      // ...and gsi1's untouched junk says nothing.
      expect(warnText()).toBe('');
    });

    it('sends nothing for a FALSY declaration, matching the table-level send rule', async () => {
      primeLiveTable({
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        GlobalSecondaryIndexes: [
          liveIndex({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000, Status: 'ACTIVE' }),
        ],
      });

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        { GlobalSecondaryIndexes: [{ ...declaredIndex(), WarmThroughput: null }] },
        {
          GlobalSecondaryIndexes: [
            declaredIndex({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 }),
          ],
        }
      );

      expect(gsiUpdates()).toEqual([]);
    });
  });
});
