import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, appAutoScalingSend, childLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  appAutoScalingSend: vi.fn(),
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
    applicationAutoScaling: { send: appAutoScalingSend },
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

import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { canonicalizeUnorderedArraysAtPaths } from '../../../src/analyzer/drift-normalize.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE_NAME = 'my-test-table-xxx';

/**
 * The two PERMANENT phantom drifts issue #1742 measured on an UNTOUCHED table
 * (us-east-1, 2026-08-13, `tests/integration/rollback-replay-effective-props`).
 *
 * Both are reachable whenever the drift baseline is `properties` rather than
 * `observedProperties` — i.e. after any reverse-replacement rollback, which
 * `rollback-executor.ts` strips `observedProperties` on. That is also why
 * neither had been seen: on the ordinary path both comparison sides come from
 * the same `readCurrentState` call, so they already agree.
 */
describe('DynamoDBGlobalTableProvider drift phantoms (issue #1742)', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    appAutoScalingSend.mockReset();
    childLogger.warn.mockReset();
    provider = new DynamoDBGlobalTableProvider();
    appAutoScalingSend.mockResolvedValue({ ScalableTargets: [] });
  });

  // ─── defect 1: AttributeDefinitions is an unordered SET ────────────────

  describe('AttributeDefinitions ordering', () => {
    it('declares AttributeDefinitions as an unordered path', () => {
      expect(provider.getDriftUnorderedPaths(RESOURCE_TYPE)).toContain('AttributeDefinitions');
    });

    it('does NOT declare KeySchema, which is order-SIGNIFICANT', () => {
      // HASH must precede RANGE, so sorting it would silently hide a real key
      // change — the failure direction the provider rules call the worse one.
      const paths = provider.getDriftUnorderedPaths(RESOURCE_TYPE);
      expect(paths).not.toContain('KeySchema');
      expect(paths.some((p) => p.includes('KeySchema'))).toBe(false);
    });

    it('collapses the measured readback reordering through the normalizer', () => {
      // The end-to-end proof: run the declared path through the SAME helper
      // `drift-calculator.ts` applies, using the exact two orders the live run
      // produced. Asserting only the declaration would pass even if the path
      // string were inert (a path that crosses an array is meaningful here but
      // NOT as an ignore-path, so the two lists are not interchangeable).
      const declared = [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'gsipk', AttributeType: 'S' },
      ];
      const readBack = [
        { AttributeName: 'gsipk', AttributeType: 'S' },
        { AttributeName: 'pk', AttributeType: 'S' },
      ];
      const paths = provider.getDriftUnorderedPaths(RESOURCE_TYPE);

      expect(
        canonicalizeUnorderedArraysAtPaths({ AttributeDefinitions: declared }, paths)
      ).toEqual(canonicalizeUnorderedArraysAtPaths({ AttributeDefinitions: readBack }, paths));
    });

    it('still reports a REAL AttributeDefinitions change after canonicalization', () => {
      // The sort must not make the pass vacuous: a retyped attribute is a
      // genuine difference and has to survive it.
      const paths = provider.getDriftUnorderedPaths(RESOURCE_TYPE);
      const before = canonicalizeUnorderedArraysAtPaths(
        { AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }] },
        paths
      );
      const after = canonicalizeUnorderedArraysAtPaths(
        { AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'N' }] },
        paths
      );
      expect(before).not.toEqual(after);
    });
  });

  // ─── defect 2: WarmThroughput is AWS-computed ──────────────────────────

  describe('GlobalSecondaryIndexes[].WarmThroughput', () => {
    /** A live table AWS reports a computed WarmThroughput for — which, as of
     *  the measured run, is EVERY index. */
    const describeWithWarmThroughput = () => {
      mockSend.mockResolvedValue({
        Table: {
          TableName: TABLE_NAME,
          TableStatus: 'ACTIVE',
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
          Replicas: [{ RegionName: 'us-east-1' }],
          GlobalSecondaryIndexes: [
            {
              IndexName: 'gsi1',
              KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'ALL' },
              WarmThroughput: {
                ReadUnitsPerSecond: 12000,
                WriteUnitsPerSecond: 4000,
                Status: 'ACTIVE',
              },
            },
          ],
        },
      });
    };

    const readIndexes = async (
      properties?: Record<string, unknown>
    ): Promise<Record<string, unknown>[]> => {
      const state = await provider.readCurrentState(
        TABLE_NAME,
        'MyTable',
        RESOURCE_TYPE,
        properties
      );
      return state?.['GlobalSecondaryIndexes'] as Record<string, unknown>[];
    };

    it('OMITS the computed value when the desired side declares none', async () => {
      describeWithWarmThroughput();

      // The desired side is a properties-only baseline that declares the index
      // but never asked for a warm throughput. AWS reports a default the
      // baseline can never carry, so emitting it is a one-sided difference
      // forever.
      const indexes = await readIndexes({
        GlobalSecondaryIndexes: [
          {
            IndexName: 'gsi1',
            KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
      });

      expect(indexes[0]).toBeDefined();
      expect('WarmThroughput' in indexes[0]!).toBe(false);
      // The rest of the reverse map is untouched — the gate is per-KEY.
      expect(indexes[0]!['IndexName']).toBe('gsi1');
      expect(indexes[0]!['Projection']).toEqual({ ProjectionType: 'ALL' });
    });

    it('EMITS it when the desired side declares one, so a real change still drifts', async () => {
      describeWithWarmThroughput();

      // The CFn type does accept an explicit WarmThroughput, so an
      // unconditional drop would hide a genuine difference for the users who
      // set one. This is the assertion that keeps the gate from being a
      // blanket removal.
      const indexes = await readIndexes({
        GlobalSecondaryIndexes: [
          {
            IndexName: 'gsi1',
            KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
            Projection: { ProjectionType: 'ALL' },
            WarmThroughput: { ReadUnitsPerSecond: 500, WriteUnitsPerSecond: 100 },
          },
        ],
      });

      // Reverse-mapped to the CFn shape: AWS's `Status` member must NOT survive.
      // The CFn type declares only the two unit members, so passing the
      // description through would hand a user who DID declare `WarmThroughput`
      // a difference their template can never match — the same permanent
      // phantom drift this gate exists to remove, one key down.
      expect(indexes[0]!['WarmThroughput']).toEqual({
        ReadUnitsPerSecond: 12000,
        WriteUnitsPerSecond: 4000,
      });
      expect('Status' in (indexes[0]!['WarmThroughput'] as Record<string, unknown>)).toBe(false);
    });

    it('treats an ABSENT desired bag as "not declared"', async () => {
      describeWithWarmThroughput();

      // Every production caller supplies the bag, so this is the defensive
      // arm. It takes the direction that cannot manufacture drift.
      const indexes = await readIndexes(undefined);

      expect('WarmThroughput' in indexes[0]!).toBe(false);
    });

    it('reports the ONE-TIME transition against a stale observedProperties baseline', async () => {
      describeWithWarmThroughput();

      // The documented, deliberate cost of the gate, pinned so it is a known
      // behavior rather than a surprise. The ordinary drift baseline is
      // `observedProperties ?? properties`, and an observed bag captured by an
      // EARLIER binary carries the computed member. Against the new readback,
      // which omits it, the comparator reads the whole array as different.
      const declaredSide = {
        GlobalSecondaryIndexes: [
          {
            IndexName: 'gsi1',
            KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
      };
      const staleObserved = {
        GlobalSecondaryIndexes: [
          {
            IndexName: 'gsi1',
            KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
            Projection: { ProjectionType: 'ALL' },
            WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
          },
        ],
      };
      const aws = (await provider.readCurrentState(
        TABLE_NAME,
        'MyTable',
        RESOURCE_TYPE,
        declaredSide
      ))!;

      const unordered = provider.getDriftUnorderedPaths(RESOURCE_TYPE);
      const stale = calculateResourceDrift(staleObserved, aws, { unorderedPaths: unordered });
      expect(stale.map((d) => d.path)).toContain('GlobalSecondaryIndexes');

      // ...and it CLEARS after one `cdkd drift --accept` / any deploy that
      // re-captures, which is what makes it one-time rather than permanent.
      // Without this half the test would not distinguish the transition from
      // the permanent drift the gate exists to remove.
      const refreshed = calculateResourceDrift(
        { GlobalSecondaryIndexes: aws['GlobalSecondaryIndexes'] },
        aws,
        { unorderedPaths: unordered }
      );
      expect(refreshed).toEqual([]);
    });

    it('gates per INDEX, not per table', async () => {
      mockSend.mockResolvedValue({
        Table: {
          TableName: TABLE_NAME,
          TableStatus: 'ACTIVE',
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
          Replicas: [{ RegionName: 'us-east-1' }],
          GlobalSecondaryIndexes: [
            {
              IndexName: 'declared',
              Projection: { ProjectionType: 'ALL' },
              WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
            },
            {
              IndexName: 'undeclared',
              Projection: { ProjectionType: 'ALL' },
              WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
            },
          ],
        },
      });

      const indexes = await readIndexes({
        GlobalSecondaryIndexes: [
          { IndexName: 'declared', WarmThroughput: { ReadUnitsPerSecond: 500 } },
          { IndexName: 'undeclared' },
        ],
      });

      const byName = new Map(indexes.map((i) => [i['IndexName'] as string, i]));
      expect('WarmThroughput' in byName.get('declared')!).toBe(true);
      expect('WarmThroughput' in byName.get('undeclared')!).toBe(false);
    });
  });
});
