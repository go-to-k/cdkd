import { describe, it, expect, vi } from 'vite-plus/test';

/**
 * go-to-k/cdkd#5789: `readCurrentState` writes each replica's `TableClass`
 * (`STANDARD` when AWS reports none) and boolean `DeletionProtectionEnabled`
 * into its `Replicas[]` entry (#5397). A record with no `observedProperties`
 * (a rollback's reverse-replacement re-create, a pre-v3 record) is compared
 * through its template bag, which never declared them, and arrays compare
 * whole: every such table reported `Replicas` drift. `canonicalizeDriftPair`
 * now completes the two keys at their AWS default only.
 */

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: vi.fn(), config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('@aws-sdk/client-dynamodb', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-dynamodb')>('@aws-sdk/client-dynamodb');
  return {
    ...actual,
    DynamoDBClient: vi.fn().mockImplementation((cfg: { region?: string } | undefined) => ({
      send: vi.fn(),
      config: { region: () => Promise.resolve(cfg?.region ?? 'us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() };
  return {
    getLogger: () => ({ child: () => childLogger, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  };
});

import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';

const TYPE = 'AWS::DynamoDB::GlobalTable';
const provider = new DynamoDBGlobalTableProvider();

/** The template bag: replicas declare Region and Tags only. */
const templateBag = (): Record<string, unknown> => ({
  TableName: 'T',
  Replicas: [
    { Region: 'us-east-1', Tags: [{ Key: 'k', Value: 'v' }] },
    // Tags omitted too: the read-back's `[]` is the default.
    { Region: 'eu-west-1' },
  ],
});

/** What the read-back emits for that table left at its defaults. */
const readback = (
  edits: Record<string, Record<string, unknown>> = {}
): Record<string, unknown> => ({
  TableName: 'T',
  Replicas: [
    {
      Region: 'us-east-1',
      Tags: [{ Key: 'k', Value: 'v' }],
      TableClass: 'STANDARD',
      DeletionProtectionEnabled: false,
      ContributorInsightsSpecification: { Enabled: false },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
      ...edits['us-east-1'],
    },
    {
      Region: 'eu-west-1',
      Tags: [],
      TableClass: 'STANDARD',
      DeletionProtectionEnabled: false,
      ContributorInsightsSpecification: { Enabled: false },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
      ...edits['eu-west-1'],
    },
  ],
});

const driftPaths = async (baseline: Record<string, unknown>, aws: Record<string, unknown>) => {
  const paired = await provider.canonicalizeDriftPair(TYPE, baseline, aws);
  return calculateResourceDrift(paired.baseline, paired.aws, {
    unionWalkObjects: true,
    unorderedPaths: provider.getDriftUnorderedPaths(TYPE),
  }).map((d) => d.path);
};

describe('replica class / protection defaults on a template-bag baseline (go-to-k/cdkd#5789)', () => {
  it('reports no drift for a table left at its defaults, and did without the hook', async () => {
    expect(await driftPaths(templateBag(), readback())).toEqual([]);
    expect(
      calculateResourceDrift(templateBag(), readback(), {
        unionWalkObjects: true,
        unorderedPaths: provider.getDriftUnorderedPaths(TYPE),
      }).map((d) => d.path)
    ).toEqual(['Replicas']);
  });

  it('still reports a non-default class or an enabled protection the template never declared', async () => {
    expect(
      await driftPaths(templateBag(), readback({ 'eu-west-1': { TableClass: 'STANDARD_INFREQUENT_ACCESS' } }))
    ).toEqual(['Replicas']);
    expect(
      await driftPaths(templateBag(), readback({ 'us-east-1': { DeletionProtectionEnabled: true } }))
    ).toEqual(['Replicas']);
  });

  it('still reports enabled insights, enabled recovery or a live tag the template never declared', async () => {
    for (const edit of [
      { ContributorInsightsSpecification: { Enabled: true } },
      { PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 35 } },
      { PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false, RecoveryPeriodInDays: 7 } },
      { Tags: [{ Key: 'oob', Value: '1' }] },
    ]) {
      expect(await driftPaths(templateBag(), readback({ 'eu-west-1': edit }))).toEqual(['Replicas']);
    }
  });

  it('never overrides a declared value, and leaves the AWS side and the input untouched', async () => {
    const baseline = templateBag();
    (baseline['Replicas'] as Array<Record<string, unknown>>)[0]!['TableClass'] =
      'STANDARD_INFREQUENT_ACCESS';
    expect(await driftPaths(baseline, readback())).toEqual(['Replicas']);
    const aws = readback();
    const input = templateBag();
    const paired = await provider.canonicalizeDriftPair(TYPE, input, aws);
    expect(paired.aws).toBe(aws);
    expect(input).toEqual(templateBag());
  });

  it('is identity for a current read-back baseline and for an unmatched region', async () => {
    const current = readback();
    expect((await provider.canonicalizeDriftPair(TYPE, current, readback())).baseline).toBe(current);
    // A baseline replica with no live counterpart takes nothing.
    const orphanRegion = { TableName: 'T', Replicas: [{ Region: 'ap-south-1' }] };
    const out = (await provider.canonicalizeDriftPair(TYPE, orphanRegion, readback())).baseline;
    const apSouth = (out['Replicas'] as Array<Record<string, unknown>>).find(
      (r) => r['Region'] === 'ap-south-1'
    );
    expect(apSouth).toEqual({ Region: 'ap-south-1' });
  });
});
