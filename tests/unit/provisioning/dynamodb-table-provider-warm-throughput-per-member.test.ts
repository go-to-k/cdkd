import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DescribeContinuousBackupsCommand,
  DescribeContributorInsightsCommand,
  DescribeKinesisStreamingDestinationCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  GetResourcePolicyCommand,
  ListTagsOfResourceCommand,
  UpdateTableCommand,
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
import { buildRevertNewProperties } from '../../../src/cli/commands/drift.js';

const TABLE_NAME = 'my-table';
const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:123:table/my-table';
const RESOURCE_TYPE = 'AWS::DynamoDB::Table';

/** AWS reports BOTH members for every table and index (measured, issue #1760). */
const LIVE_WARM = { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000, Status: 'ACTIVE' };

/** `WriteUnitsPerSecond` does not coerce, so cdkd sends `ReadUnitsPerSecond` alone. */
const HALF_RESOLVABLE = { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 'abc' };

const GSI_KEY = [{ AttributeName: 'gsipk', KeyType: 'HASH' }];
const GSI_PROJECTION = { ProjectionType: 'ALL' };

function primeDescribeTable(table: Record<string, unknown>): void {
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof DescribeTableCommand) {
      return Promise.resolve({ Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, ...table } });
    }
    if (cmd instanceof ListTagsOfResourceCommand) return Promise.resolve({ Tags: [] });
    if (cmd instanceof DescribeContinuousBackupsCommand) return Promise.resolve({});
    if (cmd instanceof DescribeTimeToLiveCommand) return Promise.resolve({});
    if (cmd instanceof GetResourcePolicyCommand) return Promise.resolve({});
    if (cmd instanceof DescribeKinesisStreamingDestinationCommand) return Promise.resolve({});
    if (cmd instanceof DescribeContributorInsightsCommand) return Promise.resolve({});
    return Promise.resolve({});
  });
}

function gsiDescription(warm: Record<string, unknown>): Record<string, unknown> {
  return {
    IndexName: 'gsi1',
    KeySchema: GSI_KEY,
    Projection: GSI_PROJECTION,
    IndexStatus: 'ACTIVE',
    WarmThroughput: warm,
  };
}

function gsiTemplate(warm: unknown): Record<string, unknown> {
  return {
    IndexName: 'gsi1',
    KeySchema: GSI_KEY,
    Projection: GSI_PROJECTION,
    WarmThroughput: warm,
  };
}

/**
 * Issue #3777 — the readback emitted AWS's value for BOTH `WarmThroughput`
 * members whenever the declared block had ONE usable member, so the member cdkd
 * never sent was compared against the baseline forever.
 */
describe('DynamoDBTableProvider WarmThroughput per-member readback (issue #3777)', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new DynamoDBTableProvider();
  });

  async function readback(
    desired: Record<string, unknown> | undefined,
    table: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    primeDescribeTable(table);
    const result = await provider.readCurrentState(TABLE_NAME, 'L', RESOURCE_TYPE, desired);
    expect(result).toBeDefined();
    return result!;
  }

  /** The drift pipeline's provider hooks, in `cdkd drift`'s order. */
  async function drift(
    baseline: Record<string, unknown>,
    aws: Record<string, unknown>,
    declared: Record<string, unknown>,
    unionWalkObjects: boolean
  ): Promise<string[]> {
    const paired = await provider.canonicalizeDriftPair(
      RESOURCE_TYPE,
      provider.canonicalizeDriftProperties(RESOURCE_TYPE, baseline),
      provider.canonicalizeDriftProperties(RESOURCE_TYPE, aws),
      declared
    );
    return calculateResourceDrift(paired.baseline, paired.aws, {
      ignorePaths: provider.getDriftUnknownPaths(RESOURCE_TYPE, declared),
      unorderedPaths: provider.getDriftUnorderedPaths(RESOURCE_TYPE),
      unionWalkObjects,
    }).map((d) => d.path);
  }

  describe('readCurrentState, table level', () => {
    it('emits only the member cdkd sends when the other does not resolve', async () => {
      const result = await readback(
        { TableName: TABLE_NAME, WarmThroughput: HALF_RESOLVABLE },
        { WarmThroughput: LIVE_WARM }
      );
      expect(result['WarmThroughput']).toEqual({ ReadUnitsPerSecond: 12000 });
    });

    it('emits the WRITE member alone when only it resolves, a numeric string included', async () => {
      const result = await readback(
        {
          TableName: TABLE_NAME,
          WarmThroughput: { ReadUnitsPerSecond: { Ref: 'Unset' }, WriteUnitsPerSecond: '4000' },
        },
        { WarmThroughput: LIVE_WARM }
      );
      expect(result['WarmThroughput']).toEqual({ WriteUnitsPerSecond: 4000 });
    });

    it('emits only the declared member of a ONE-member block', async () => {
      // The common shape: a template naming one member, the other simply absent.
      const result = await readback(
        { TableName: TABLE_NAME, WarmThroughput: { ReadUnitsPerSecond: 6000 } },
        { WarmThroughput: LIVE_WARM }
      );
      expect(result['WarmThroughput']).toEqual({ ReadUnitsPerSecond: 12000 });
    });

    it('emits BOTH members when the template sends both', async () => {
      const result = await readback(
        {
          TableName: TABLE_NAME,
          WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
        },
        { WarmThroughput: LIVE_WARM }
      );
      expect(result['WarmThroughput']).toEqual({
        ReadUnitsPerSecond: 12000,
        WriteUnitsPerSecond: 4000,
      });
    });

    it('emits BOTH members for an uninformative bag, the pre-#1760 fallback', async () => {
      for (const desired of [undefined, {}]) {
        const result = await readback(desired, { WarmThroughput: LIVE_WARM });
        expect(result['WarmThroughput']).toEqual({
          ReadUnitsPerSecond: 12000,
          WriteUnitsPerSecond: 4000,
        });
      }
    });

    it('emits nothing when the sent member is one AWS did not report', async () => {
      const result = await readback(
        { TableName: TABLE_NAME, WarmThroughput: HALF_RESOLVABLE },
        { WarmThroughput: { WriteUnitsPerSecond: 4000, Status: 'ACTIVE' } }
      );
      expect(result).not.toHaveProperty('WarmThroughput');
    });
  });

  describe('readCurrentState, per GSI', () => {
    it('emits only the member cdkd sends for that index', async () => {
      const result = await readback(
        {
          TableName: TABLE_NAME,
          GlobalSecondaryIndexes: [
            gsiTemplate({ ReadUnitsPerSecond: 'abc', WriteUnitsPerSecond: 5000 }),
          ],
        },
        { GlobalSecondaryIndexes: [gsiDescription(LIVE_WARM)] }
      );
      const [gsi] = result['GlobalSecondaryIndexes'] as Record<string, unknown>[];
      expect(gsi?.['WarmThroughput']).toEqual({ WriteUnitsPerSecond: 4000 });
    });

    it('emits BOTH members when the index declares both, and for an uninformative bag', async () => {
      const declared = await readback(
        {
          TableName: TABLE_NAME,
          GlobalSecondaryIndexes: [
            gsiTemplate({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 }),
          ],
        },
        { GlobalSecondaryIndexes: [gsiDescription(LIVE_WARM)] }
      );
      const uninformative = await readback(undefined, {
        GlobalSecondaryIndexes: [gsiDescription(LIVE_WARM)],
      });
      for (const result of [declared, uninformative]) {
        const [gsi] = result['GlobalSecondaryIndexes'] as Record<string, unknown>[];
        expect(gsi?.['WarmThroughput']).toEqual({
          ReadUnitsPerSecond: 12000,
          WriteUnitsPerSecond: 4000,
        });
      }
    });
  });

  describe('canonicalizeDriftPair: baselines captured before the per-member readback', () => {
    const DECLARED = { TableName: TABLE_NAME, WarmThroughput: HALF_RESOLVABLE };

    it('compares a LEGACY observed baseline clean after AWS grew the unsent member', async () => {
      const legacyObserved = {
        TableName: TABLE_NAME,
        WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
      };
      const current = await readback(DECLARED, {
        WarmThroughput: { ...LIVE_WARM, WriteUnitsPerSecond: 9000 },
      });
      expect(await drift(legacyObserved, current, DECLARED, true)).toEqual([]);
    });

    it('compares a TEMPLATE baseline clean, the unresolvable member included', async () => {
      const current = await readback(DECLARED, { WarmThroughput: LIVE_WARM });
      expect(await drift(DECLARED, current, DECLARED, false)).toEqual([]);
    });

    it('still reports a real change to the member cdkd SENT', async () => {
      const legacyObserved = {
        TableName: TABLE_NAME,
        WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
      };
      const current = await readback(DECLARED, {
        WarmThroughput: { ...LIVE_WARM, ReadUnitsPerSecond: 15000 },
      });
      expect(await drift(legacyObserved, current, DECLARED, true)).toEqual([
        'WarmThroughput.ReadUnitsPerSecond',
      ]);
    });

    it('still reports both members of a block the template sends in full', async () => {
      const both = { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 };
      const declared = { TableName: TABLE_NAME, WarmThroughput: both };
      const current = await readback(declared, {
        WarmThroughput: { ReadUnitsPerSecond: 13000, WriteUnitsPerSecond: 5000, Status: 'ACTIVE' },
      });
      expect(
        await drift({ TableName: TABLE_NAME, WarmThroughput: both }, current, declared, true)
      ).toEqual(['WarmThroughput.ReadUnitsPerSecond', 'WarmThroughput.WriteUnitsPerSecond']);
    });

    it('compares a legacy per-GSI baseline clean, and still reports its sent member', async () => {
      const declared = {
        TableName: TABLE_NAME,
        GlobalSecondaryIndexes: [gsiTemplate(HALF_RESOLVABLE)],
      };
      const legacyObserved = {
        TableName: TABLE_NAME,
        GlobalSecondaryIndexes: [
          gsiTemplate({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 }),
        ],
      };
      const grewUnsent = await readback(declared, {
        GlobalSecondaryIndexes: [gsiDescription({ ...LIVE_WARM, WriteUnitsPerSecond: 9000 })],
      });
      expect(await drift(legacyObserved, grewUnsent, declared, true)).toEqual([]);
      expect(await drift(declared, grewUnsent, declared, false)).toEqual([]);

      const grewSent = await readback(declared, {
        GlobalSecondaryIndexes: [gsiDescription({ ...LIVE_WARM, ReadUnitsPerSecond: 15000 })],
      });
      expect(await drift(legacyObserved, grewSent, declared, true)).toEqual([
        'GlobalSecondaryIndexes',
      ]);
    });
  });

  describe('a member RECORDED as a dynamic reference was sent, and stays compared', () => {
    // `cdkd drift` hands `readCurrentState` the RECORDED bag, where a member the
    // deploy resolved and sent is still its `{{resolve:...}}` token (or the
    // state mask). Reading it as unsendable would hide a change to it.
    const TOKEN = '{{resolve:ssm:/warm/write}}';

    it('reads back and reports a token or masked member, table level', async () => {
      for (const recorded of [TOKEN, '***']) {
        const declared = {
          TableName: TABLE_NAME,
          WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: recorded },
        };
        const current = await readback(declared, {
          WarmThroughput: { ...LIVE_WARM, WriteUnitsPerSecond: 9000 },
        });
        expect(current['WarmThroughput']).toEqual({
          ReadUnitsPerSecond: 12000,
          WriteUnitsPerSecond: 9000,
        });
        const observed = {
          TableName: TABLE_NAME,
          WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
        };
        expect(await drift(observed, current, declared, true)).toEqual([
          'WarmThroughput.WriteUnitsPerSecond',
        ]);
      }
    });

    it('keeps a block whose EVERY member is a token compared, not ignored', async () => {
      const declared = {
        TableName: TABLE_NAME,
        WarmThroughput: { ReadUnitsPerSecond: TOKEN, WriteUnitsPerSecond: TOKEN },
      };
      expect(provider.getDriftUnknownPaths(RESOURCE_TYPE, declared)).not.toContain(
        'WarmThroughput'
      );
      const current = await readback(declared, { WarmThroughput: LIVE_WARM });
      expect(current['WarmThroughput']).toEqual({
        ReadUnitsPerSecond: 12000,
        WriteUnitsPerSecond: 4000,
      });
    });

    it('reads back and reports a token member, per GSI', async () => {
      const declared = {
        TableName: TABLE_NAME,
        GlobalSecondaryIndexes: [
          gsiTemplate({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: TOKEN }),
        ],
      };
      const current = await readback(declared, {
        GlobalSecondaryIndexes: [gsiDescription({ ...LIVE_WARM, WriteUnitsPerSecond: 9000 })],
      });
      const [gsi] = current['GlobalSecondaryIndexes'] as Record<string, unknown>[];
      expect(gsi?.['WarmThroughput']).toEqual({
        ReadUnitsPerSecond: 12000,
        WriteUnitsPerSecond: 9000,
      });
      const observed = {
        TableName: TABLE_NAME,
        GlobalSecondaryIndexes: [
          gsiTemplate({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 }),
        ],
      };
      expect(await drift(observed, current, declared, true)).toEqual(['GlobalSecondaryIndexes']);
    });

    it('keeps a GSI block whose every member is a token read back', async () => {
      const current = await readback(
        {
          TableName: TABLE_NAME,
          GlobalSecondaryIndexes: [
            gsiTemplate({ ReadUnitsPerSecond: TOKEN, WriteUnitsPerSecond: TOKEN }),
          ],
        },
        { GlobalSecondaryIndexes: [gsiDescription(LIVE_WARM)] }
      );
      const [gsi] = current['GlobalSecondaryIndexes'] as Record<string, unknown>[];
      expect(gsi?.['WarmThroughput']).toEqual({
        ReadUnitsPerSecond: 12000,
        WriteUnitsPerSecond: 4000,
      });
    });

    it('counts a token EMBEDDED in a longer string as sent, and reports a change to it', async () => {
      // `'{{resolve:ssm:p}}000'` resolves at deploy to a number that WAS sent;
      // the recorded bag still holds the string, so drift must not read it as
      // unsent and hide it.
      const declared = {
        TableName: TABLE_NAME,
        WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: `${TOKEN}000` },
      };
      const current = await readback(declared, {
        WarmThroughput: { ...LIVE_WARM, WriteUnitsPerSecond: 9000 },
      });
      expect(current['WarmThroughput']).toEqual({
        ReadUnitsPerSecond: 12000,
        WriteUnitsPerSecond: 9000,
      });
      const observed = {
        TableName: TABLE_NAME,
        WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
      };
      expect(await drift(observed, current, declared, true)).toEqual([
        'WarmThroughput.WriteUnitsPerSecond',
      ]);
    });

    it('still treats a plain non-numeric string as unsent', async () => {
      const current = await readback(
        {
          TableName: TABLE_NAME,
          WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: '{{resolve:' },
        },
        { WarmThroughput: LIVE_WARM }
      );
      expect(current['WarmThroughput']).toEqual({ ReadUnitsPerSecond: 12000 });
    });
  });

  describe('a SENT member AWS transiently omits stays reported', () => {
    // The trim is keyed on the declaration, never on what the live block
    // omitted: a member cdkd sent must not vanish from the baseline because one
    // DescribeTable (an index mid-transition) left it out.
    it('table level', async () => {
      const both = { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 };
      const declared = { TableName: TABLE_NAME, WarmThroughput: both };
      const current = await readback(declared, {
        WarmThroughput: { ReadUnitsPerSecond: 12000, Status: 'UPDATING' },
      });
      expect(current['WarmThroughput']).toEqual({ ReadUnitsPerSecond: 12000 });
      const observed = { TableName: TABLE_NAME, WarmThroughput: both };
      expect(await drift(observed, current, declared, true)).toEqual([
        'WarmThroughput.WriteUnitsPerSecond',
      ]);
    });

    it('per GSI', async () => {
      const both = { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 };
      const declared = { TableName: TABLE_NAME, GlobalSecondaryIndexes: [gsiTemplate(both)] };
      const current = await readback(declared, {
        GlobalSecondaryIndexes: [gsiDescription({ ReadUnitsPerSecond: 12000 })],
      });
      const observed = { TableName: TABLE_NAME, GlobalSecondaryIndexes: [gsiTemplate(both)] };
      expect(await drift(observed, current, declared, true)).toEqual(['GlobalSecondaryIndexes']);
    });
  });

  describe('drift --revert sends the trimmed baseline (the pair hook\'s write consumer)', () => {
    // `runRevert` passes its DESIRED bag (the recorded baseline) through the
    // pair hook against the RAW readback, overlays the drifted subtrees onto
    // that readback, and hands the result to `update()` with the readback as
    // the previous side. The member the hook drops must not reach the wire.
    it('reverts only the SENT member of a legacy two-member capture', async () => {
      const declared = { TableName: TABLE_NAME, WarmThroughput: { ReadUnitsPerSecond: 6000 } };
      // A legacy capture: the sent member recorded ABOVE what AWS reports now
      // (so reverting it is a raise the wire carries), and the unsent member
      // recorded at a value cdkd never asked for.
      const legacyObserved = {
        TableName: TABLE_NAME,
        WarmThroughput: { ReadUnitsPerSecond: 13000, WriteUnitsPerSecond: 9000 },
      };
      const aws = await readback(declared, { WarmThroughput: LIVE_WARM });
      const paired = await provider.canonicalizeDriftPair(
        RESOURCE_TYPE,
        legacyObserved,
        aws,
        declared
      );
      const changes = calculateResourceDrift(paired.baseline, paired.aws, {
        ignorePaths: provider.getDriftUnknownPaths(RESOURCE_TYPE, declared),
        unionWalkObjects: true,
      });
      expect(changes.map((c) => c.path)).toEqual(['WarmThroughput.ReadUnitsPerSecond']);

      const desired = (
        await provider.canonicalizeDriftPair(RESOURCE_TYPE, legacyObserved, aws, declared)
      ).baseline;
      const newProperties = buildRevertNewProperties(changes, desired, aws);
      expect(newProperties['WarmThroughput']).toEqual({ ReadUnitsPerSecond: 13000 });

      mockSend.mockReset();
      primeDescribeTable({ TableStatus: 'ACTIVE', WarmThroughput: LIVE_WARM });
      await provider.update('L', TABLE_NAME, RESOURCE_TYPE, newProperties, aws);
      const sent = mockSend.mock.calls
        .map((c) => c[0] as unknown)
        .filter((cmd): cmd is UpdateTableCommand => cmd instanceof UpdateTableCommand)
        .map((cmd) => cmd.input.WarmThroughput)
        .filter((warm) => warm !== undefined);
      expect(sent).toEqual([{ ReadUnitsPerSecond: 13000 }]);
    });
  });

  describe('canonicalizeDriftPair: shape rules', () => {
    const LEGACY = { ReadUnitsPerSecond: 1, WriteUnitsPerSecond: 2 };
    const AWS = { WarmThroughput: { ReadUnitsPerSecond: 1 } };

    it('trims by the DECLARATION, matched per GSI by IndexName, and leaves AWS by identity', async () => {
      const baseline = {
        WarmThroughput: LEGACY,
        GlobalSecondaryIndexes: [
          { IndexName: 'gsi1', WarmThroughput: LEGACY },
          { IndexName: 'gsi2', WarmThroughput: LEGACY },
        ],
      };
      const properties = {
        TableName: TABLE_NAME,
        WarmThroughput: { WriteUnitsPerSecond: 2 },
        GlobalSecondaryIndexes: [
          { IndexName: 'gsi2', WarmThroughput: LEGACY },
          { IndexName: 'gsi1', WarmThroughput: { ReadUnitsPerSecond: 1, WriteUnitsPerSecond: 'x' } },
        ],
      };
      const snapshot = structuredClone(baseline);
      // The AWS side is not consulted: an empty readback trims the same way.
      const aws = {};
      const out = await provider.canonicalizeDriftPair(RESOURCE_TYPE, baseline, aws, properties);
      expect(out.aws).toBe(aws);
      expect(out.baseline).toEqual({
        WarmThroughput: { WriteUnitsPerSecond: 2 },
        GlobalSecondaryIndexes: [
          { IndexName: 'gsi1', WarmThroughput: { ReadUnitsPerSecond: 1 } },
          { IndexName: 'gsi2', WarmThroughput: LEGACY },
        ],
      });
      const outIndexes = out.baseline['GlobalSecondaryIndexes'] as unknown[];
      expect(outIndexes[1]).toBe(baseline.GlobalSecondaryIndexes[1]);
      expect(baseline).toEqual(snapshot);
    });

    it('returns a current-shape baseline by identity', async () => {
      const baseline = {
        WarmThroughput: { ReadUnitsPerSecond: 1 },
        GlobalSecondaryIndexes: [{ IndexName: 'gsi1', WarmThroughput: { ReadUnitsPerSecond: 1 } }],
      };
      const properties = {
        TableName: TABLE_NAME,
        WarmThroughput: { ReadUnitsPerSecond: 6000 },
        GlobalSecondaryIndexes: [{ IndexName: 'gsi1', WarmThroughput: { ReadUnitsPerSecond: 1 } }],
      };
      const out = await provider.canonicalizeDriftPair(RESOURCE_TYPE, baseline, AWS, properties);
      expect(out.baseline).toBe(baseline);
      expect(out.aws).toBe(AWS);
    });

    it('trims nothing without an informative declaration, or where it sends nothing', async () => {
      const baseline = {
        WarmThroughput: LEGACY,
        GlobalSecondaryIndexes: [{ IndexName: 'gsi1', WarmThroughput: LEGACY }],
      };
      for (const properties of [
        undefined,
        {},
        { TableName: TABLE_NAME },
        { TableName: TABLE_NAME, WarmThroughput: {} },
        { TableName: TABLE_NAME, WarmThroughput: 'x' },
        {
          TableName: TABLE_NAME,
          GlobalSecondaryIndexes: [{ IndexName: 'other', WarmThroughput: { ReadUnitsPerSecond: 1 } }],
        },
      ]) {
        const out = await provider.canonicalizeDriftPair(RESOURCE_TYPE, baseline, AWS, properties);
        expect(out.baseline).toBe(baseline);
      }
    });

    it('passes a malformed baseline and another resource type through', async () => {
      const malformed = { WarmThroughput: 'x', GlobalSecondaryIndexes: 'y' };
      const properties = { TableName: TABLE_NAME, WarmThroughput: { ReadUnitsPerSecond: 1 } };
      expect(
        (await provider.canonicalizeDriftPair(RESOURCE_TYPE, malformed, AWS, properties)).baseline
      ).toBe(malformed);
      const legacy = { WarmThroughput: LEGACY };
      const other = await provider.canonicalizeDriftPair(
        'AWS::DynamoDB::GlobalTable',
        legacy,
        AWS,
        properties
      );
      expect(other.baseline).toBe(legacy);
      expect(other.aws).toBe(AWS);
    });
  });
});
