/**
 * go-to-k/cdkd#5503: converging an unsettled `GlobalSecondaryIndexes` must
 * never delete an index that neither the state record nor the template names
 * (one another tool added). The convergence step makes the provider's live
 * read the previous side, and `applyGsiUpdates` deletes every previous index
 * the template lacks. CloudFormation diffs recorded models, so it never
 * touches such an index. `readUnsettled` therefore projects the live list
 * onto record ∪ template.
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
function serve(liveNames: string[]): void {
  mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
    switch (cmd.constructor.name) {
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

const indexOps = (): Array<Record<string, unknown>> =>
  mockSend.mock.calls
    .map((c) => c[0] as { constructor: { name: string }; input: Record<string, any> })
    .filter((c) => c.constructor.name === 'UpdateTableCommand')
    .flatMap((c) => (c.input['GlobalSecondaryIndexUpdates'] ?? []) as Array<Record<string, unknown>>);

const NAMES = new Set(['GlobalSecondaryIndexes']);

describe('converging an unsettled GlobalSecondaryIndexes (go-to-k/cdkd#5503)', () => {
  let provider: DynamoDBTableProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DynamoDBTableProvider();
  });

  /** The deploy's convergence step, then update(), as `update-in-place.ts` runs them. */
  const converge = async (
    recorded: Record<string, unknown>,
    desired: Record<string, unknown>
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
    });
    await provider.update('T', 't', TYPE, desired, previous, {
      unsettledProperties: NAMES,
    });
  };

  it('leaves an index neither the record nor the template names (no Delete), and says how to remove it', async () => {
    serve(['g1', 'gext']);
    await converge(props('g1'), props('g1'));
    expect(indexOps()).toEqual([]);
    const warned = warnSpy.mock.calls.flat().join('\n');
    expect(warned).toContain('GSI gext on DynamoDB table t is live, but neither');
    expect(warned).toContain(
      `aws dynamodb update-table --table-name t --global-secondary-index-updates '[{"Delete":{"IndexName":"gext"}}]'`
    );
    // Only the undeclared index is named.
    expect(warned).not.toContain('GSI g1 ');
  });

  it('warns nothing when every live index is declared, and nothing outside convergence', async () => {
    serve(['g1']);
    await converge(props('g1'), props('g1'));
    expect(warnSpy.mock.calls.flat().join('\n')).not.toMatch(/neither cdkd's record/);
    serve(['g1', 'gext']);
    await provider.update('T', 't', TYPE, props('g1', 'g2'), props('g1'));
    expect(warnSpy.mock.calls.flat().join('\n')).not.toMatch(/neither cdkd's record/);
  });

  it('still deletes a recorded index the template dropped, and only that one', async () => {
    serve(['g1', 'g2', 'gext']);
    await converge(props('g1', 'g2'), props('g1'));
    expect(indexOps()).toEqual([{ Delete: { IndexName: 'g2' } }]);
  });

  it('keeps the live value of an index only the template names (a failed update created it)', async () => {
    serve(['g1', 'gnew', 'gext']);
    const live = (await provider.readUnsettled('t', 'T', TYPE, NAMES, props('g1'), props('g1', 'gnew'))) as Record<
      string,
      unknown
    >;
    expect((live['GlobalSecondaryIndexes'] as Array<{ IndexName: string }>).map((g) => g.IndexName)).toEqual([
      'g1',
      'gnew',
    ]);
    await converge(props('g1'), props('g1', 'gnew'));
    // Already live: neither re-created nor deleted.
    expect(indexOps()).toEqual([]);
  });

  it('reads no index key at all when none of the live indexes is named', async () => {
    serve(['gext']);
    const live = (await provider.readUnsettled('t', 'T', TYPE, NAMES, props(), props())) as Record<
      string,
      unknown
    >;
    expect(live).not.toHaveProperty('GlobalSecondaryIndexes');
    await converge(props(), props());
    expect(indexOps()).toEqual([]);
  });

  it('the post-update proof is not held open by an index nobody declares', async () => {
    serve(['g1', 'gext']);
    const kept = await unsettledAfterUpdate({
      provider,
      logicalId: 'T',
      physicalId: 't',
      resourceType: TYPE,
      recordedProperties: props('g1'),
      names: NAMES,
      desired: props('g1'),
    });
    expect(kept).toEqual([]);
  });

  it('the post-update proof sees an index only the template names, so it settles', async () => {
    serve(['g1', 'gnew']);
    const kept = await unsettledAfterUpdate({
      provider,
      logicalId: 'T',
      physicalId: 't',
      resourceType: TYPE,
      recordedProperties: props('g1'),
      names: NAMES,
      desired: props('g1', 'gnew'),
    });
    expect(kept).toEqual([]);
  });

  it('projects by IndexName over record ∪ template, dropping unnamed entries', () => {
    const live = [index('a'), index('b'), index('c'), { Projection: {} }, 'x'];
    expect(projectIndexesOnto(live, [index('a')], [index('c')])).toEqual([index('a'), index('c')]);
    expect(projectIndexesOnto(live, undefined, undefined)).toBeUndefined();
    expect(projectIndexesOnto(undefined, [index('a')], [index('a')])).toBeUndefined();
  });
});
