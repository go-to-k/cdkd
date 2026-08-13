import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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

import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { canonicalizeUnorderedArraysAtPaths } from '../../../src/analyzer/drift-normalize.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';

/**
 * Both PERMANENT phantom drifts issue #1742 measured on an UNTOUCHED table
 * (us-east-1, 2026-08-13, `tests/integration/rollback-replay-effective-props`):
 * the `AttributeDefinitions` ORDERING half (shipped by PR #1773, declared in
 * `getDriftUnorderedPaths`) and the AWS-computed per-index `WarmThroughput`
 * half, which needed the #1784 `canonicalizeDriftProperties` seam because the
 * member sits inside an ARRAY ELEMENT and no ignore-path can name one.
 *
 * It is reachable whenever the drift baseline is `properties` rather than
 * `observedProperties` — i.e. after any reverse-replacement rollback, which
 * `rollback-executor.ts` strips `observedProperties` on. That is also why
 * neither had been seen: on the ordinary path both comparison sides come from
 * the same `readCurrentState` call, so they already agree.
 */
describe('DynamoDBGlobalTableProvider drift phantoms (issue #1742)', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    provider = new DynamoDBGlobalTableProvider();
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

  // ─── defect 2: the AWS-computed per-index WarmThroughput ───────────────

  /**
   * The half #1773 left open, now shipped on the #1784
   * `canonicalizeDriftProperties` seam.
   *
   * The two candidate answers the issue proposed are both unusable and each is
   * pinned by a case below: declaring the path in `getDriftUnknownPaths` cannot
   * express a member of an ARRAY ELEMENT (the only suppression an ignore-path
   * can spell is the WHOLE index list), and gating the readback emission on the
   * desired side — the sibling `AWS::DynamoDB::Table` answer under #1760 —
   * trades this population's phantom drift for the far larger
   * `observedProperties` one. Stripping the member from BOTH comparison sides
   * converges them at once, which is what the transition case asserts.
   */
  describe('computed per-index WarmThroughput', () => {
    // AWS reports this for every index whether or not the template asked for
    // one — measured us-east-1, 2026-08-13.
    const AWS_COMPUTED_WARM = {
      ReadUnitsPerSecond: 12000,
      WriteUnitsPerSecond: 4000,
      Status: 'ACTIVE',
    };

    it('strips the member from an AWS-side readback bag', () => {
      const canonical = provider.canonicalizeDriftProperties(RESOURCE_TYPE, {
        GlobalSecondaryIndexes: [
          { IndexName: 'gsi1', KeySchema: [], WarmThroughput: AWS_COMPUTED_WARM },
        ],
      });

      expect(canonical['GlobalSecondaryIndexes']).toEqual([{ IndexName: 'gsi1', KeySchema: [] }]);
    });

    it('converges a STALE observedProperties baseline with a post-fix readback', () => {
      // The load-bearing case, and the one the reverted attempt failed: a bag
      // written by an EARLIER binary still carries the computed member (with
      // the SDK-only `Status`), while today's `readCurrentState` emits the CFn
      // shape and the canonicalizer removes it from both. Compared through the
      // real comparator, not by eyeballing the two bags.
      const staleObserved = {
        GlobalSecondaryIndexes: [
          { IndexName: 'gsi1', Projection: { ProjectionType: 'ALL' }, WarmThroughput: AWS_COMPUTED_WARM },
        ],
      };
      const freshReadback = {
        GlobalSecondaryIndexes: [
          {
            IndexName: 'gsi1',
            Projection: { ProjectionType: 'ALL' },
            WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
          },
        ],
      };

      const changes = calculateResourceDrift(
        provider.canonicalizeDriftProperties(RESOURCE_TYPE, staleObserved),
        provider.canonicalizeDriftProperties(RESOURCE_TYPE, freshReadback)
      );

      expect(changes).toEqual([]);
    });

    it('reports that same pair as drift WITHOUT the canonicalizer', () => {
      // Negative control: proves the clean result above comes from the hook and
      // not from the two bags already agreeing.
      const changes = calculateResourceDrift(
        {
          GlobalSecondaryIndexes: [{ IndexName: 'gsi1', WarmThroughput: AWS_COMPUTED_WARM }],
        },
        {
          GlobalSecondaryIndexes: [
            {
              IndexName: 'gsi1',
              WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
            },
          ],
        }
      );

      expect(changes).toHaveLength(1);
      expect(changes[0]!.path).toBe('GlobalSecondaryIndexes');
    });

    it('converges a template-only baseline, which never carried the member at all', () => {
      // The shape the issue was MEASURED on: a `properties`-only baseline (what
      // a reverse-replacement rollback leaves behind) against a readback AWS
      // always populates. One-sided, and permanent before this.
      const changes = calculateResourceDrift(
        { GlobalSecondaryIndexes: [{ IndexName: 'gsi1' }] },
        {
          GlobalSecondaryIndexes: [
            {
              IndexName: 'gsi1',
              WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
            },
          ],
        }
      );
      expect(changes).toHaveLength(1);

      const canonicalized = calculateResourceDrift(
        provider.canonicalizeDriftProperties(RESOURCE_TYPE, {
          GlobalSecondaryIndexes: [{ IndexName: 'gsi1' }],
        }),
        provider.canonicalizeDriftProperties(RESOURCE_TYPE, {
          GlobalSecondaryIndexes: [
            {
              IndexName: 'gsi1',
              WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
            },
          ],
        })
      );
      expect(canonicalized).toEqual([]);
    });

    it('keeps a REAL index change visible through canonicalization', () => {
      // The trade the whole mechanism exists to avoid — suppressing the array.
      // AWS also dropped an index here, which must still report.
      const changes = calculateResourceDrift(
        provider.canonicalizeDriftProperties(RESOURCE_TYPE, {
          GlobalSecondaryIndexes: [
            { IndexName: 'gsi1', WarmThroughput: AWS_COMPUTED_WARM },
            { IndexName: 'gsi2', WarmThroughput: AWS_COMPUTED_WARM },
          ],
        }),
        provider.canonicalizeDriftProperties(RESOURCE_TYPE, {
          GlobalSecondaryIndexes: [{ IndexName: 'gsi1', WarmThroughput: AWS_COMPUTED_WARM }],
        })
      );

      expect(changes).toHaveLength(1);
      expect(changes[0]!.path).toBe('GlobalSecondaryIndexes');
    });

    it('returns the input by IDENTITY when no index declares the member', () => {
      // The common case pays nothing: same object back, not a rebuilt copy.
      const bag = {
        GlobalSecondaryIndexes: [{ IndexName: 'gsi1', Projection: { ProjectionType: 'ALL' } }],
      };
      expect(provider.canonicalizeDriftProperties(RESOURCE_TYPE, bag)).toBe(bag);
    });

    it('strips a member declared as an explicit undefined, not just a present value', () => {
      // `member in entry` rather than a `!== undefined` / truthiness test, and
      // the difference is observable: `structuredClone` PRESERVES a
      // present-but-`undefined` key and the drift walk enumerates
      // `Object.keys`, so an entry carrying `WarmThroughput: undefined` and one
      // carrying no such key must come out with the SAME key set — otherwise
      // the two sides differ on a key neither of them has a value for (the
      // #1686 lesson, one member over).
      const withExplicitUndefined = {
        GlobalSecondaryIndexes: [{ IndexName: 'gsi1', WarmThroughput: undefined }],
      };
      const result = provider.canonicalizeDriftProperties(
        RESOURCE_TYPE,
        withExplicitUndefined
      ) as { GlobalSecondaryIndexes: Array<Record<string, unknown>> };

      expect(Object.keys(result.GlobalSecondaryIndexes[0]!)).toEqual(['IndexName']);
      // And it is a REBUILT bag, not the input by identity — the member was
      // present, so the strip genuinely applied.
      expect(result).not.toBe(withExplicitUndefined);
    });

    it('returns the input by IDENTITY for a bag with no index list, and for another type', () => {
      const noIndexes = { TableName: 't', AttributeDefinitions: [] };
      expect(provider.canonicalizeDriftProperties(RESOURCE_TYPE, noIndexes)).toBe(noIndexes);

      // The type guard is UNREACHABLE in production and this row pins it as a
      // shape guard only, not as a live path: `drift.ts` resolves the provider
      // by `(resourceType, provisionedBy)` and passes that same type back in,
      // and this provider is registered for exactly one type. An earlier
      // comment here cited the #1784 CC-API-fallback caveat as the reason —
      // that caveat is about the BAG SHAPE for a type with no
      // `readCurrentState` and never produces a foreign `resourceType`.
      const otherType = {
        GlobalSecondaryIndexes: [{ IndexName: 'gsi1', WarmThroughput: AWS_COMPUTED_WARM }],
      };
      expect(provider.canonicalizeDriftProperties('AWS::DynamoDB::Table', otherType)).toBe(
        otherType
      );
    });

    it('shape-guards a NON-ARRAY index list and a non-object element', () => {
      // A state record can carry a malformed `GlobalSecondaryIndexes` — that is
      // the whole premise of the #1544 replay downgrade — and an unresolved
      // intrinsic is an ordinary element shape. Neither may throw, and neither
      // is rewritten: the comparator can still report it, which is the honest
      // answer for a value cdkd could not read.
      const malformed = { GlobalSecondaryIndexes: 'not-an-array' };
      expect(provider.canonicalizeDriftProperties(RESOURCE_TYPE, malformed)).toBe(malformed);

      const intrinsicElement = { Ref: 'SomeParam' };
      const mixed = {
        GlobalSecondaryIndexes: [
          intrinsicElement,
          null,
          { IndexName: 'gsi1', WarmThroughput: AWS_COMPUTED_WARM },
        ],
      };
      const canonical = provider.canonicalizeDriftProperties(RESOURCE_TYPE, mixed);
      const list = canonical['GlobalSecondaryIndexes'] as unknown[];
      expect(list[0]).toBe(intrinsicElement);
      expect(list[1]).toBeNull();
      expect(list[2]).toEqual({ IndexName: 'gsi1' });
    });

    it('does NOT mutate the bag it is handed, at either level', () => {
      // The bag is the caller's state record / readback — `drift.ts` keeps the
      // raw AWS bag for `--revert` to diff against.
      const bag = {
        GlobalSecondaryIndexes: [{ IndexName: 'gsi1', WarmThroughput: { ...AWS_COMPUTED_WARM } }],
      };
      const before = JSON.parse(JSON.stringify(bag)) as unknown;

      provider.canonicalizeDriftProperties(RESOURCE_TYPE, bag);

      expect(bag).toEqual(before);
    });

    it('does NOT declare the index list as an unknown path (that would blind the whole array)', () => {
      // The rejected cheaper answer, pinned: an ignore-path never crosses an
      // array, so declaring it would switch drift off for every index add /
      // remove / capacity change.
      const paths = provider.getDriftUnknownPaths(RESOURCE_TYPE);
      expect(paths).not.toContain('GlobalSecondaryIndexes');
      expect(paths.some((p) => p.includes('WarmThroughput'))).toBe(false);
    });
  });

  // ─── the readback half: CFn-shaped WarmThroughput ──────────────────────

  describe('readCurrentState WarmThroughput reverse map', () => {
    beforeEach(() => {
      // This describe is the file's only `mockSend` user; each case installs
      // its own dispatching implementation.
      mockSend.mockReset();
    });

    /**
     * Command-name dispatch rather than a `*Once` queue: `readCurrentState`
     * issues six calls in an order the test does not care about, and a queue
     * that drifts from it silently answers the wrong call.
     */
    function stubDescribeTable(gsi: Record<string, unknown>): void {
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        switch (command.constructor.name) {
          case 'DescribeTableCommand':
            return Promise.resolve({
              Table: {
                TableName: 'table-1',
                TableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/table-1',
                BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
                Replicas: [{ RegionName: 'us-east-1' }],
                GlobalSecondaryIndexes: [gsi],
              },
            });
          case 'DescribeContributorInsightsCommand':
            return Promise.resolve({ ContributorInsightsStatus: 'DISABLED' });
          case 'DescribeContinuousBackupsCommand':
            return Promise.resolve({
              ContinuousBackupsDescription: {
                ContinuousBackupsStatus: 'ENABLED',
                PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'DISABLED' },
              },
            });
          case 'DescribeKinesisStreamingDestinationCommand':
            return Promise.resolve({ KinesisDataStreamDestinations: [] });
          case 'ListTagsOfResourceCommand':
            return Promise.resolve({ Tags: [] });
          case 'DescribeTimeToLiveCommand':
            return Promise.resolve({ TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' } });
          default:
            return Promise.resolve({});
        }
      });
    }

    it('drops the AWS-managed Status the CFn type has no concept of', async () => {
      stubDescribeTable({
        IndexName: 'gsi1',
        KeySchema: [{ AttributeName: 'gsipk', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
        WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000, Status: 'ACTIVE' },
      });

      const observed = await provider.readCurrentState('table-1', 'GlobalTable', RESOURCE_TYPE);

      const indexes = observed!['GlobalSecondaryIndexes'] as Array<Record<string, unknown>>;
      expect(indexes[0]!['WarmThroughput']).toEqual({
        ReadUnitsPerSecond: 12000,
        WriteUnitsPerSecond: 4000,
      });
    });

    it('omits the key entirely when AWS reports no warm throughput for the index', async () => {
      // The other polarity: an emit-when-present guard, not an always-emit
      // placeholder — a `{}` here would be a fresh one-sided difference.
      stubDescribeTable({
        IndexName: 'gsi1',
        KeySchema: [{ AttributeName: 'gsipk', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      });

      const observed = await provider.readCurrentState('table-1', 'GlobalTable', RESOURCE_TYPE);

      const indexes = observed!['GlobalSecondaryIndexes'] as Array<Record<string, unknown>>;
      expect(indexes[0]).not.toHaveProperty('WarmThroughput');
    });

    it('omits the key when AWS reports ONLY the managed Status, rather than emitting {}', async () => {
      // The emit-when-present guard is keyed on the SURVIVING members, not on
      // whether AWS sent a block at all. A transitioning index reports
      // `{Status: 'CREATING'}` with no units, and dropping `Status` empties the
      // object — emitting `{}` there would be the same one-sided difference the
      // absent case above avoids, just reached through a different AWS state.
      stubDescribeTable({
        IndexName: 'gsi1',
        KeySchema: [{ AttributeName: 'gsipk', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
        WarmThroughput: { Status: 'CREATING' },
      });

      const observed = await provider.readCurrentState('table-1', 'GlobalTable', RESOURCE_TYPE);

      const indexes = observed!['GlobalSecondaryIndexes'] as Array<Record<string, unknown>>;
      expect(indexes[0]).not.toHaveProperty('WarmThroughput');
    });

    it('keeps a PARTIAL unit pair rather than dropping the half AWS did report', async () => {
      // The guard drops an EMPTY block, not an incomplete one: a block carrying
      // one unit is real data, and omitting it would lose a value the CFn type
      // can express.
      stubDescribeTable({
        IndexName: 'gsi1',
        KeySchema: [{ AttributeName: 'gsipk', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
        WarmThroughput: { ReadUnitsPerSecond: 12000, Status: 'ACTIVE' },
      });

      const observed = await provider.readCurrentState('table-1', 'GlobalTable', RESOURCE_TYPE);

      const indexes = observed!['GlobalSecondaryIndexes'] as Array<Record<string, unknown>>;
      expect(indexes[0]!['WarmThroughput']).toEqual({ ReadUnitsPerSecond: 12000 });
    });
  });
});
