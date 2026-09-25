/**
 * Issue #3573: on a MULTI-region GlobalTable, `readCurrentState` left the
 * local (deploy-region) replica out of `Replicas`, because the list
 * `DescribeTable` returns in the deploy region names the other regions only.
 *
 * Two halves ship together, and each is pinned here in both polarities:
 *
 * - the READBACK now appends the local entry (and every member homed on it);
 * - `canonicalizeDriftPair` completes a LEGACY `observedProperties` baseline,
 *   written before the fix without that entry, with the readback's local
 *   entry -- and only such a baseline. The AWS side is never touched, so
 *   `--accept` persists the full readback and `--revert` (which runs the same
 *   pass on its desired bag) sends the live local entry back unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { localSend, remoteSend } = vi.hoisted(() => ({
  localSend: vi.fn(),
  remoteSend: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: localSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...logger, child: () => logger }) };
});

import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';

const TYPE = 'AWS::DynamoDB::GlobalTable';
const LOCAL_ARN = 'arn:aws:dynamodb:us-east-1:123456789012:table/table-1';

/**
 * Dispatch by command name for one region's client. `tags` is what
 * `ListTagsOfResource` answers, so the local and remote entries are told apart
 * by content, not only by `Region`.
 */
function regionStub(
  replicas: Array<Record<string, unknown>> | undefined,
  tags: Array<{ Key: string; Value: string }>
) {
  return (command: { constructor: { name: string } }) => {
    switch (command.constructor.name) {
      case 'DescribeTableCommand':
        return Promise.resolve({
          Table: {
            TableName: 'table-1',
            TableArn: LOCAL_ARN,
            BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
            OnDemandThroughput: { MaxReadRequestUnits: 50 },
            ...(replicas && { Replicas: replicas }),
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
        return Promise.resolve({ Tags: tags });
      case 'DescribeTimeToLiveCommand':
        return Promise.resolve({ TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' } });
      default:
        return Promise.resolve({});
    }
  };
}

function makeProvider(): DynamoDBGlobalTableProvider {
  const provider = new DynamoDBGlobalTableProvider();
  // The cross-region replica's client, pre-seeded so no real client is built.
  (
    provider as unknown as { regionalClientCache: Map<string, unknown> }
  ).regionalClientCache.set('eu-west-1', {
    send: remoteSend,
    config: { region: () => Promise.resolve('eu-west-1') },
  });
  return provider;
}

/** The local client answering no region, as an unconfigured SDK chain can. */
function withUnresolvedRegion(provider: DynamoDBGlobalTableProvider): DynamoDBGlobalTableProvider {
  (provider as unknown as { dynamoDBClient: unknown }).dynamoDBClient = {
    send: localSend,
    config: { region: () => Promise.resolve(undefined) },
  };
  return provider;
}

async function readReplicas(
  provider: DynamoDBGlobalTableProvider
): Promise<Array<Record<string, unknown>>> {
  const state = await provider.readCurrentState('table-1', 'GlobalTable', TYPE);
  return state!['Replicas'] as Array<Record<string, unknown>>;
}

const LOCAL_TAGS = [{ Key: 'side', Value: 'local' }];
const REMOTE_TAGS = [{ Key: 'side', Value: 'remote' }];

describe('readCurrentState: the local replica on a multi-region table (issue #3573)', () => {
  beforeEach(() => {
    localSend.mockReset();
    remoteSend.mockReset();
    remoteSend.mockImplementation(regionStub(undefined, REMOTE_TAGS));
  });

  it('appends the local entry, read through the LOCAL client, after the listed replicas', async () => {
    // What DescribeTable returns in the deploy region: the OTHER region only.
    localSend.mockImplementation(
      regionStub([{ RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' }], LOCAL_TAGS)
    );

    const replicas = await readReplicas(makeProvider());

    expect(replicas.map((entry) => entry['Region'])).toEqual(['eu-west-1', 'us-east-1']);
    const [remote, local] = replicas;
    expect(local!['Tags']).toEqual(LOCAL_TAGS);
    expect(remote!['Tags']).toEqual(REMOTE_TAGS);
    // A member homed ONLY on the local entry now has somewhere to land.
    expect(local!['ReadOnDemandThroughputSettings']).toEqual({ MaxReadRequestUnits: 50 });
    expect(remote!['ReadOnDemandThroughputSettings']).toBeUndefined();
    expect(local!['PointInTimeRecoverySpecification']).toEqual({
      PointInTimeRecoveryEnabled: false,
    });
  });

  it('does not duplicate the local entry when DescribeTable already lists it', async () => {
    localSend.mockImplementation(
      regionStub(
        [
          { RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' },
          { RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' },
        ],
        LOCAL_TAGS
      )
    );

    const replicas = await readReplicas(makeProvider());

    expect(replicas.map((entry) => entry['Region'])).toEqual(['us-east-1', 'eu-west-1']);
  });

  it('appends nothing when the client region does not resolve', async () => {
    localSend.mockImplementation(
      regionStub([{ RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' }], LOCAL_TAGS)
    );
    const provider = withUnresolvedRegion(makeProvider());

    const replicas = await readReplicas(provider);

    expect(replicas.map((entry) => entry['Region'])).toEqual(['eu-west-1']);
  });

  it('keeps the single-region synthesis unchanged', async () => {
    localSend.mockImplementation(regionStub(undefined, LOCAL_TAGS));

    const replicas = await readReplicas(makeProvider());

    expect(replicas.map((entry) => entry['Region'])).toEqual(['us-east-1']);
    expect(replicas[0]!['Tags']).toEqual(LOCAL_TAGS);
  });
});

describe('canonicalizeDriftPair: completing a legacy baseline (issue #3573)', () => {
  let provider: DynamoDBGlobalTableProvider;
  let unorderedPaths: string[];
  beforeEach(() => {
    provider = makeProvider();
    unorderedPaths = provider.getDriftUnorderedPaths(TYPE);
  });
  /** What `drift.ts` passes for an `observedProperties` baseline. */
  const compare = (baseline: Record<string, unknown>, aws: Record<string, unknown>) =>
    calculateResourceDrift(baseline, aws, { unionWalkObjects: true, unorderedPaths });

  const remote = { Region: 'eu-west-1', Tags: [] };
  const local = { Region: 'us-east-1', Tags: LOCAL_TAGS };
  const legacy = { TableName: 't', Replicas: [remote] };
  const current = { TableName: 't', Replicas: [remote, local] };

  it('completes the baseline with the LIVE local entry and leaves the AWS side alone', async () => {
    const { baseline, aws } = await provider.canonicalizeDriftPair(TYPE, legacy, current);

    expect(aws).toBe(current);
    expect(baseline['Replicas']).toEqual([remote, local]);
    expect(compare(baseline, aws)).toEqual([]);
  });

  it('that same pair drifts without the hook, which is the upgrade phantom it absorbs', () => {
    expect(compare(legacy, current)).not.toEqual([]);
  });

  it('compares a CURRENT-shape baseline in full, so local-replica drift is reported', async () => {
    const recorded = { ...current, Replicas: [remote, { ...local, Tags: [] }] };

    const { baseline, aws } = await provider.canonicalizeDriftPair(TYPE, recorded, current);

    expect(baseline).toBe(recorded);
    expect(aws).toBe(current);
    expect(compare(baseline, aws).map((change) => change.path)).toContain('Replicas');
  });

  it('still reports a replica added out of band against a legacy baseline, with the local entry on the AWS side', async () => {
    const added = { ...current, Replicas: [remote, { Region: 'ap-northeast-1', Tags: [] }, local] };

    const { baseline, aws } = await provider.canonicalizeDriftPair(TYPE, legacy, added);

    const changes = compare(baseline, aws);
    expect(changes.map((change) => change.path)).toEqual(['Replicas']);
    // What `--accept` writes and what `--revert` diffs against: the full
    // readback, local entry included, so an accept heals the record.
    // Both are the set-canonicalized arrays, so compare as sets.
    const awsValue = changes[0]!.awsValue as unknown[];
    expect(awsValue).toHaveLength(3);
    expect(awsValue).toEqual(expect.arrayContaining(added['Replicas']));
    // The desired side a revert would send keeps the live local entry.
    const stateValue = changes[0]!.stateValue as unknown[];
    expect(stateValue).toHaveLength(2);
    expect(stateValue).toEqual(expect.arrayContaining([remote, local]));
  });

  it('returns both inputs by identity when it does not apply', async () => {
    for (const [type, baseline, aws] of [
      ['AWS::DynamoDB::Table', legacy, current],
      [TYPE, { TableName: 't' }, current],
      [TYPE, legacy, { TableName: 't', Replicas: 'not-a-list' }],
      [TYPE, legacy, legacy],
      [TYPE, current, current],
    ] as const) {
      const result = await provider.canonicalizeDriftPair(type, baseline, aws);
      expect(result.baseline).toBe(baseline);
      expect(result.aws).toBe(aws);
    }
  });

  it('leaves the pair alone when the client region does not resolve', async () => {
    // An entry for region '' is what the single-region synthesis emits under
    // the same condition, so it is the entry an unguarded rule would copy.
    const aws = { TableName: 't', Replicas: [remote, { Region: '' }] };

    const result = await withUnresolvedRegion(provider).canonicalizeDriftPair(TYPE, legacy, aws);

    expect(result.baseline).toBe(legacy);
    expect(result.aws).toBe(aws);
  });

  it('copies the live entry rather than aliasing it', async () => {
    const { baseline } = await provider.canonicalizeDriftPair(TYPE, legacy, current);
    const copied = (baseline['Replicas'] as unknown[])[1];

    expect(copied).toEqual(local);
    expect(copied).not.toBe(local);
  });

  it('compares a local-FIRST template record against the local-LAST readback as equal', async () => {
    // The post-rollback case: `properties` is the baseline, and a hand-written
    // CfnGlobalTable lists the deploy region first. `Replicas` is a set.
    const template = { TableName: 't', Replicas: [local, remote] };

    const { baseline, aws } = await provider.canonicalizeDriftPair(TYPE, template, current);

    expect(calculateResourceDrift(baseline, aws, { unorderedPaths })).toEqual([]);
    // Without the declaration the same pair drifts on position alone.
    expect(calculateResourceDrift(baseline, aws, {})).not.toEqual([]);
    // Still a set comparison, not a blindfold: a changed entry is reported.
    const changed = { ...current, Replicas: [remote, { ...local, Tags: [] }] };
    expect(
      calculateResourceDrift(template, changed, { unorderedPaths }).map((change) => change.path)
    ).toContain('Replicas');
  });

  it('sorts Replicas LEAF-only: an order-significant list inside an entry still reports a reorder', () => {
    // A replica's per-index KeySchema is HASH-then-RANGE. A subtree
    // declaration would sort it too and hide the swap.
    const keyed = (order: 'hash-first' | 'range-first') => ({
      Replicas: [
        {
          Region: 'us-east-1',
          KeySchema:
            order === 'hash-first'
              ? [
                  { AttributeName: 'pk', KeyType: 'HASH' },
                  { AttributeName: 'sk', KeyType: 'RANGE' },
                ]
              : [
                  { AttributeName: 'sk', KeyType: 'RANGE' },
                  { AttributeName: 'pk', KeyType: 'HASH' },
                ],
        },
      ],
    });

    expect(
      calculateResourceDrift(keyed('hash-first'), keyed('range-first'), { unorderedPaths }).map(
        (change) => change.path
      )
    ).toContain('Replicas');
  });

  it('does not mutate either bag', async () => {
    const baseline = structuredClone(legacy);
    const aws = structuredClone(current);

    await provider.canonicalizeDriftPair(TYPE, baseline, aws);

    expect(baseline).toEqual(legacy);
    expect(aws).toEqual(current);
  });
});

/**
 * The write path the pair hook also guards: `drift --revert` sends its
 * DESIRED bag (the recorded baseline, passed through the same pair pass)
 * against the raw readback as the previous side. A legacy record missing the
 * local entry would make `update()` read the local tags as REMOVED.
 */
describe('update() with a revert built from a legacy baseline (issue #3573)', () => {
  const REMOTE_ARN = 'arn:aws:dynamodb:eu-west-1:123456789012:table/table-1';
  const OOB = [{ Key: 'oob', Value: 'x' }];
  const readback = {
    TableName: 'table-1',
    Replicas: [
      { Region: 'eu-west-1', Tags: OOB },
      { Region: 'us-east-1', Tags: LOCAL_TAGS },
    ],
  };
  const legacy = { TableName: 'table-1', Replicas: [{ Region: 'eu-west-1', Tags: [] }] };

  function stubWrites(): void {
    const answer = (command: { constructor: { name: string } }) =>
      command.constructor.name === 'DescribeTableCommand'
        ? Promise.resolve({
            Table: {
              TableName: 'table-1',
              TableStatus: 'ACTIVE',
              TableArn: LOCAL_ARN,
              Replicas: [{ RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' }],
            },
          })
        : Promise.resolve({});
    localSend.mockReset();
    remoteSend.mockReset();
    localSend.mockImplementation(answer);
    remoteSend.mockImplementation(answer);
  }
  const untagsOn = (send: typeof localSend) =>
    send.mock.calls
      .map(([command]) => command as { constructor: { name: string }; input: unknown })
      .filter((command) => command.constructor.name === 'UntagResourceCommand')
      .map((command) => command.input);

  it('reverts the other replica and leaves the local table tags alone', async () => {
    stubWrites();
    const provider = makeProvider();
    const { baseline: desired } = await provider.canonicalizeDriftPair(TYPE, legacy, readback);

    await provider.update('GlobalTable', 'table-1', TYPE, desired, readback, {
      desiredFromAwsReadback: true,
    });

    expect(untagsOn(localSend)).toEqual([]);
    expect(untagsOn(remoteSend)).toEqual([{ ResourceArn: REMOTE_ARN, TagKeys: ['oob'] }]);
  });

  it('untags the LOCAL table when the legacy record is sent as is -- the defect the pass prevents', async () => {
    stubWrites();
    const provider = makeProvider();

    await provider.update('GlobalTable', 'table-1', TYPE, legacy, readback, {
      desiredFromAwsReadback: true,
    });

    expect(untagsOn(localSend)).toEqual([{ ResourceArn: LOCAL_ARN, TagKeys: ['side'] }]);
  });
});
