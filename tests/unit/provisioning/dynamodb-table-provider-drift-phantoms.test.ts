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
const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:123:table/my-table';
const RESOURCE_TYPE = 'AWS::DynamoDB::Table';

/**
 * The order `DescribeTable` actually returned in us-east-1 on 2026-08-13 for a
 * table whose CreateTable input declared `[{pk,S}, {gsipk,S}]` — AWS re-ordered
 * the set on the create response and on every later describe.
 */
const AWS_ATTRIBUTE_DEFINITIONS = [
  { AttributeName: 'gsipk', AttributeType: 'S' },
  { AttributeName: 'pk', AttributeType: 'S' },
];
const TEMPLATE_ATTRIBUTE_DEFINITIONS = [
  { AttributeName: 'pk', AttributeType: 'S' },
  { AttributeName: 'gsipk', AttributeType: 'S' },
];

/**
 * The `WarmThroughput` AWS reports for a table that never declared one
 * (measured us-east-1, 2026-08-13 — `Status` is AWS-managed and never surfaced
 * by `readCurrentState`).
 */
const AWS_COMPUTED_WARM_THROUGHPUT = {
  ReadUnitsPerSecond: 12000,
  WriteUnitsPerSecond: 4000,
  Status: 'ACTIVE',
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
 * Issue #1760 — the `AWS::DynamoDB::Table` twin of the two `AWS::DynamoDB::
 * GlobalTable` phantom drifts in issue #1742.
 *
 * Both defects are only reachable when the drift baseline is the template
 * `properties` rather than `observedProperties` (after a reverse-replacement
 * rollback, which strips `observedProperties`, or on a resource deployed before
 * observed-capture existed) — on the ordinary path both comparison sides come
 * from the same readback and already agree. The `calculateResourceDrift` cases
 * below therefore compare a TEMPLATE-shaped baseline against the AWS-shaped
 * readback, which is the shape that actually fires.
 */
describe('DynamoDBTableProvider drift phantoms (issue #1760)', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new DynamoDBTableProvider();
  });

  describe('defect 1: AttributeDefinitions ordering', () => {
    it('declares AttributeDefinitions as an unordered set', () => {
      expect(provider.getDriftUnorderedPaths(RESOURCE_TYPE)).toEqual(['AttributeDefinitions']);
    });

    it('does NOT declare KeySchema — it is order-significant (HASH before RANGE)', () => {
      const paths = provider.getDriftUnorderedPaths(RESOURCE_TYPE);
      expect(paths).not.toContain('KeySchema');
      expect(paths.some((p) => p.endsWith('KeySchema'))).toBe(false);
    });

    it('declares nothing for another resource type', () => {
      expect(provider.getDriftUnorderedPaths('AWS::DynamoDB::GlobalTable')).toEqual([]);
    });

    it('reports a REORDERED AttributeDefinitions as clean', () => {
      const drifts = calculateResourceDrift(
        { AttributeDefinitions: TEMPLATE_ATTRIBUTE_DEFINITIONS },
        { AttributeDefinitions: AWS_ATTRIBUTE_DEFINITIONS },
        { unorderedPaths: provider.getDriftUnorderedPaths(RESOURCE_TYPE) }
      );
      expect(drifts).toEqual([]);
    });

    it('still reports a CHANGED AttributeDefinitions as drifted (different member set)', () => {
      const drifts = calculateResourceDrift(
        { AttributeDefinitions: TEMPLATE_ATTRIBUTE_DEFINITIONS },
        {
          AttributeDefinitions: [
            { AttributeName: 'gsipk', AttributeType: 'S' },
            { AttributeName: 'renamed', AttributeType: 'S' },
          ],
        },
        { unorderedPaths: provider.getDriftUnorderedPaths(RESOURCE_TYPE) }
      );
      expect(drifts.map((d) => d.path)).toEqual(['AttributeDefinitions']);
    });

    it('still reports a CHANGED AttributeDefinitions as drifted (same name, different type)', () => {
      const drifts = calculateResourceDrift(
        { AttributeDefinitions: TEMPLATE_ATTRIBUTE_DEFINITIONS },
        {
          AttributeDefinitions: [
            { AttributeName: 'gsipk', AttributeType: 'N' },
            { AttributeName: 'pk', AttributeType: 'S' },
          ],
        },
        { unorderedPaths: provider.getDriftUnorderedPaths(RESOURCE_TYPE) }
      );
      expect(drifts.map((d) => d.path)).toEqual(['AttributeDefinitions']);
    });

    it('reports a REORDERED KeySchema as drifted — a swapped HASH/RANGE is a real change', () => {
      const drifts = calculateResourceDrift(
        {
          KeySchema: [
            { AttributeName: 'pk', KeyType: 'HASH' },
            { AttributeName: 'sk', KeyType: 'RANGE' },
          ],
        },
        {
          KeySchema: [
            { AttributeName: 'sk', KeyType: 'RANGE' },
            { AttributeName: 'pk', KeyType: 'HASH' },
          ],
        },
        { unorderedPaths: provider.getDriftUnorderedPaths(RESOURCE_TYPE) }
      );
      expect(drifts.map((d) => d.path)).toEqual(['KeySchema']);
    });

    it('emits AttributeDefinitions verbatim — the sort belongs to the comparator, not the read', async () => {
      primeDescribeTable({
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        AttributeDefinitions: AWS_ATTRIBUTE_DEFINITIONS,
      });

      const result = await provider.readCurrentState(TABLE_NAME, 'L', RESOURCE_TYPE, {
        AttributeDefinitions: TEMPLATE_ATTRIBUTE_DEFINITIONS,
      });

      expect(result?.['AttributeDefinitions']).toEqual(AWS_ATTRIBUTE_DEFINITIONS);
    });
  });

  describe('defect 2: AWS-computed table-level WarmThroughput', () => {
    it('omits WarmThroughput when the desired bag does not declare it', async () => {
      primeDescribeTable({
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        WarmThroughput: AWS_COMPUTED_WARM_THROUGHPUT,
      });

      const result = await provider.readCurrentState(TABLE_NAME, 'L', RESOURCE_TYPE, {
        TableName: TABLE_NAME,
        AttributeDefinitions: TEMPLATE_ATTRIBUTE_DEFINITIONS,
      });

      expect(result).toBeDefined();
      expect(result).not.toHaveProperty('WarmThroughput');
    });

    it('emits WarmThroughput when the desired bag DOES declare it', async () => {
      primeDescribeTable({
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        WarmThroughput: { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000, Status: 'ACTIVE' },
      });

      const result = await provider.readCurrentState(TABLE_NAME, 'L', RESOURCE_TYPE, {
        WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
      });

      expect(result?.['WarmThroughput']).toEqual({
        ReadUnitsPerSecond: 24000,
        WriteUnitsPerSecond: 8000,
      });
    });

    it('keeps emitting WarmThroughput when the caller supplies no bag at all', async () => {
      primeDescribeTable({
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        WarmThroughput: AWS_COMPUTED_WARM_THROUGHPUT,
      });

      const result = await provider.readCurrentState(TABLE_NAME, 'L', RESOURCE_TYPE);

      expect(result?.['WarmThroughput']).toEqual({
        ReadUnitsPerSecond: 12000,
        WriteUnitsPerSecond: 4000,
      });
    });

    it('keeps emitting WarmThroughput for an EMPTY bag (nothing to decide with)', async () => {
      primeDescribeTable({
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        WarmThroughput: AWS_COMPUTED_WARM_THROUGHPUT,
      });

      const result = await provider.readCurrentState(TABLE_NAME, 'L', RESOURCE_TYPE, {});

      expect(result?.['WarmThroughput']).toEqual({
        ReadUnitsPerSecond: 12000,
        WriteUnitsPerSecond: 4000,
      });
    });

    it('declares WarmThroughput unknown when the template does not declare it', () => {
      expect(
        provider.getDriftUnknownPaths(RESOURCE_TYPE, { TableName: TABLE_NAME })
      ).toEqual(['WarmThroughput']);
    });

    it('declares nothing when the template DOES declare WarmThroughput', () => {
      expect(
        provider.getDriftUnknownPaths(RESOURCE_TYPE, {
          TableName: TABLE_NAME,
          WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
        })
      ).toEqual([]);
    });

    it('treats a FALSY declaration as undeclared, matching what the write path sends', async () => {
      // `create()` / `update()` gate on truthiness (`if (properties['WarmThroughput'])`),
      // so a declared `null` sends NOTHING while AWS still computes 12000/4000.
      // Spelling the drift-side gate `!== undefined` would emit that computed
      // value as though the template had asked for it — the same permanent
      // phantom drift, one value over, and `--revert` could never clear it
      // because the write gate skips a falsy value.
      primeDescribeTable({
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        WarmThroughput: AWS_COMPUTED_WARM_THROUGHPUT,
      });

      const declared = { TableName: TABLE_NAME, WarmThroughput: null };
      const result = await provider.readCurrentState(TABLE_NAME, 'L', RESOURCE_TYPE, declared);

      expect(result).not.toHaveProperty('WarmThroughput');
      expect(provider.getDriftUnknownPaths(RESOURCE_TYPE, declared)).toEqual(['WarmThroughput']);
    });

    it('keeps the emit gate and the ignore path in agreement for every bag shape', async () => {
      // The two consumers must never disagree: a bag whose readback EMITS the
      // key must have it COMPARED, and one whose readback OMITS it must have
      // it IGNORED. Either mismatch manufactures the one-sided difference the
      // pair exists to remove — an emitted-but-ignored key hides a real
      // change, an omitted-but-compared key is the upgrade phantom.
      //
      // Both consumers are DRIVEN here rather than re-implemented: asserting
      // one side against a local copy of the predicate would only prove two
      // hand-written expressions agree with each other.
      const bags: Array<Record<string, unknown> | undefined> = [
        undefined,
        {},
        { TableName: TABLE_NAME },
        { TableName: TABLE_NAME, WarmThroughput: null },
        { TableName: TABLE_NAME, WarmThroughput: undefined },
        { TableName: TABLE_NAME, WarmThroughput: '' },
        { TableName: TABLE_NAME, WarmThroughput: { ReadUnitsPerSecond: 12000 } },
      ];
      const observed: Array<{ bag: unknown; emitted: boolean; ignored: boolean }> = [];
      for (const bag of bags) {
        primeDescribeTable({
          TableName: TABLE_NAME,
          TableArn: TABLE_ARN,
          WarmThroughput: AWS_COMPUTED_WARM_THROUGHPUT,
        });
        const result = await provider.readCurrentState(TABLE_NAME, 'L', RESOURCE_TYPE, bag);
        observed.push({
          bag,
          emitted: result !== undefined && 'WarmThroughput' in result,
          ignored: provider
            .getDriftUnknownPaths(RESOURCE_TYPE, bag)
            .includes('WarmThroughput'),
        });
      }

      // Exact expected table, written out rather than derived, so a change to
      // the rule has to be re-stated here instead of following along silently.
      expect(observed).toEqual([
        { bag: undefined, emitted: true, ignored: false },
        { bag: {}, emitted: true, ignored: false },
        { bag: { TableName: TABLE_NAME }, emitted: false, ignored: true },
        { bag: { TableName: TABLE_NAME, WarmThroughput: null }, emitted: false, ignored: true },
        { bag: { TableName: TABLE_NAME, WarmThroughput: undefined }, emitted: false, ignored: true },
        { bag: { TableName: TABLE_NAME, WarmThroughput: '' }, emitted: false, ignored: true },
        {
          bag: { TableName: TABLE_NAME, WarmThroughput: { ReadUnitsPerSecond: 12000 } },
          emitted: true,
          ignored: false,
        },
      ]);
      // And the invariant itself, stated once over the measured pairs.
      for (const row of observed) {
        expect({ bag: row.bag, agree: row.emitted === !row.ignored }).toEqual({
          bag: row.bag,
          agree: true,
        });
      }
    });

    it('falls back to COMPARING for an absent / empty bag and for another type', () => {
      expect(provider.getDriftUnknownPaths(RESOURCE_TYPE)).toEqual([]);
      expect(provider.getDriftUnknownPaths(RESOURCE_TYPE, {})).toEqual([]);
      expect(
        provider.getDriftUnknownPaths('AWS::DynamoDB::GlobalTable', { TableName: TABLE_NAME })
      ).toEqual([]);
    });

    it('reports no drift for a stale observed baseline carrying the computed value', () => {
      // A state record written before this fix: the deploy-time capture froze
      // AWS's computed WarmThroughput into observedProperties, and the AWS side
      // no longer emits it. Without the ignore path this is a one-sided drift on
      // every table in the account.
      const declared = { TableName: TABLE_NAME };
      const drifts = calculateResourceDrift(
        { TableName: TABLE_NAME, WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 } },
        { TableName: TABLE_NAME },
        { ignorePaths: provider.getDriftUnknownPaths(RESOURCE_TYPE, declared) }
      );
      expect(drifts).toEqual([]);
    });

    it('still reports drift on a WarmThroughput the template DOES declare', () => {
      const declared = {
        TableName: TABLE_NAME,
        WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
      };
      const drifts = calculateResourceDrift(
        declared,
        {
          TableName: TABLE_NAME,
          WarmThroughput: { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 4000 },
        },
        { ignorePaths: provider.getDriftUnknownPaths(RESOURCE_TYPE, declared) }
      );
      expect(drifts.map((d) => d.path)).toEqual(['WarmThroughput.ReadUnitsPerSecond']);
    });
  });
});
