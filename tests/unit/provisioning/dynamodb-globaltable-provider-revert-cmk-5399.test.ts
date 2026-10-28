import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DescribeContinuousBackupsCommand,
  DescribeContributorInsightsCommand,
  DescribeKinesisStreamingDestinationCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  GetResourcePolicyCommand,
  LimitExceededException,
  ListTagsOfResourceCommand,
  PolicyNotFoundException,
  UpdateTableCommand,
} from '@aws-sdk/client-dynamodb';

/**
 * go-to-k/cdkd#5399: a GlobalTable whose drift baseline was captured on the
 * AWS owned key has no `SSESpecification` (the read-back omits the block
 * unless encryption is ENABLED). Moved out of band to a customer managed key,
 * `drift --revert` kept the live block, so `update()` saw no encryption
 * change and the table stayed on the key. The provider now names
 * `SSESpecification` as a key whose absence records the default: detection
 * compares it, and the revert sends it absent, which `update()` resets to the
 * AWS owned key (`Enabled: false`) as for a template removal.
 *
 * These cases run the real read-back, comparator, revert overlay and
 * `update()` over a two-region double.
 */

const { mockSend, regionalSend, mockAutoScalingSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  regionalSend: vi.fn(),
  mockAutoScalingSend: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('@aws-sdk/client-dynamodb', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-dynamodb')>('@aws-sdk/client-dynamodb');
  return {
    ...actual,
    DynamoDBClient: vi.fn().mockImplementation((cfg: { region?: string } | undefined) => ({
      send: cfg?.region === 'eu-west-1' ? regionalSend : mockSend,
      config: { region: () => Promise.resolve(cfg?.region ?? 'us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-application-auto-scaling', async () => {
  const actual = await vi.importActual<
    typeof import('@aws-sdk/client-application-auto-scaling')
  >('@aws-sdk/client-application-auto-scaling');
  return {
    ...actual,
    ApplicationAutoScalingClient: vi.fn().mockImplementation(() => ({
      send: mockAutoScalingSend,
    })),
  };
});

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

import {
  DynamoDBGlobalTableProvider,
  relayedEncryptionChangeLimit,
} from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';
import {
  buildRevertNewProperties,
  driftAbsentMeansDefaultKeys,
  withAbsentDefaultKeys,
} from '../../../src/cli/commands/drift.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE = 'gt-5399';
const LOCAL_ARN = `arn:aws:dynamodb:us-east-1:123456789012:table/${TABLE}`;
const REMOTE_ARN = `arn:aws:dynamodb:eu-west-1:123456789012:table/${TABLE}`;
const LOCAL_KEY = 'arn:aws:kms:us-east-1:123456789012:key/local';
const REMOTE_KEY = 'arn:aws:kms:eu-west-1:123456789012:key/remote';

type Sent = { constructor: { name: string }; input: Record<string, any> };
const calls = (fn: ReturnType<typeof vi.fn>, ctor: { name: string }): Array<Record<string, any>> =>
  fn.mock.calls
    .map((c) => c[0] as Sent)
    .filter((c) => c.constructor.name === ctor.name)
    .map((c) => c.input);

/** Region doubles; `onCmk` puts both regions on their customer managed key. */
const setLive = (onCmk: boolean): void => {
  const double =
    (arn: string, table: Record<string, unknown>) =>
    async (command: Sent): Promise<unknown> => {
      switch (command.constructor.name) {
        case DescribeTableCommand.name:
          return {
            Table: {
              TableName: TABLE,
              TableArn: arn,
              TableStatus: 'ACTIVE',
              BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
              KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
              AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
              StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' },
              LatestStreamArn: `${arn}/stream/x`,
              DeletionProtectionEnabled: false,
              ...table,
            },
          };
        case DescribeContinuousBackupsCommand.name:
          return {
            ContinuousBackupsDescription: {
              PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'DISABLED' },
            },
          };
        case DescribeContributorInsightsCommand.name:
          return { ContributorInsightsStatus: 'DISABLED' };
        case DescribeKinesisStreamingDestinationCommand.name:
          return { KinesisDataStreamDestinations: [] };
        case ListTagsOfResourceCommand.name:
          return { Tags: [] };
        case DescribeTimeToLiveCommand.name:
          return { TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' } };
        case GetResourcePolicyCommand.name:
          throw new PolicyNotFoundException({ message: 'no policy', $metadata: {} });
        default:
          return {};
      }
    };
  mockSend.mockImplementation(
    double(LOCAL_ARN, {
      ...(onCmk && {
        SSEDescription: { Status: 'ENABLED', SSEType: 'KMS', KMSMasterKeyArn: LOCAL_KEY },
      }),
      Replicas: [
        {
          RegionName: 'eu-west-1',
          ReplicaStatus: 'ACTIVE',
          ...(onCmk && { KMSMasterKeyId: REMOTE_KEY }),
        },
      ],
    })
  );
  regionalSend.mockImplementation(
    double(REMOTE_ARN, {
      ...(onCmk && {
        SSEDescription: { Status: 'ENABLED', SSEType: 'KMS', KMSMasterKeyArn: REMOTE_KEY },
      }),
    })
  );
};

/** CDK's `TableV2` with no `encryption`: no `SSESpecification` anywhere. */
const declared: Record<string, unknown> = {
  TableName: TABLE,
  BillingMode: 'PAY_PER_REQUEST',
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
  Replicas: [{ Region: 'eu-west-1' }, { Region: 'us-east-1' }],
};

let provider: DynamoDBGlobalTableProvider;
beforeEach(() => {
  mockSend.mockReset();
  regionalSend.mockReset();
  mockAutoScalingSend.mockReset();
  provider = new DynamoDBGlobalTableProvider();
});

const read = async (): Promise<Record<string, unknown>> =>
  (await provider.readCurrentState(TABLE, 'T', RESOURCE_TYPE, declared)) as Record<
    string,
    unknown
  >;

/** `cdkd drift`'s comparison of an observed baseline, as `drift.ts` runs it. */
const detect = async (
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>,
  properties: Record<string, unknown> = declared
) => {
  const paired = await provider.canonicalizeDriftPair(RESOURCE_TYPE, baseline, aws);
  return calculateResourceDrift(
    withAbsentDefaultKeys(
      paired.baseline,
      paired.aws,
      driftAbsentMeansDefaultKeys(provider, RESOURCE_TYPE, properties)
    ),
    paired.aws,
    { unionWalkObjects: true, unorderedPaths: provider.getDriftUnorderedPaths(RESOURCE_TYPE) }
  );
};

/** Every call but a read, in either region, as `[command, input]`. */
const writes = (): Array<[string, Record<string, any>]> =>
  [...mockSend.mock.calls, ...regionalSend.mock.calls]
    .map((c) => c[0] as Sent)
    .filter((c) => !/^(Describe|List|Get)/.test(c.constructor.name))
    .map((c) => [c.constructor.name, c.input]);

/** The UpdateTable calls that change encryption, in either region. */
const sseCalls = (): Array<Record<string, any>> =>
  [...calls(mockSend, UpdateTableCommand), ...calls(regionalSend, UpdateTableCommand)].filter(
    (i) =>
      'SSESpecification' in i ||
      (Array.isArray(i['ReplicaUpdates']) &&
        i['ReplicaUpdates'].some(
          (u: Record<string, any>) => u['Update']?.['KMSMasterKeyId'] !== undefined
        ))
  );

describe('drift --revert of a GlobalTable recorded on the AWS owned key (go-to-k/cdkd#5399)', () => {
  it('reports the out-of-band key at the top level, and the revert resets it to the AWS owned key', async () => {
    setLive(false);
    const baseline = await read();
    expect(baseline).not.toHaveProperty('SSESpecification');
    setLive(true);
    const aws = await read();

    const changes = await detect(baseline, aws);
    expect(changes.map((c) => c.path).sort()).toEqual(['Replicas', 'SSESpecification']);
    expect(changes.find((c) => c.path === 'SSESpecification')).toEqual({
      path: 'SSESpecification',
      stateValue: undefined,
      awsValue: { SSEEnabled: true, SSEType: 'KMS' },
    });

    const sent = buildRevertNewProperties(changes, baseline, aws, {
      absentMeansDefault: driftAbsentMeansDefaultKeys(provider, RESOURCE_TYPE, declared),
    });
    expect(sent).not.toHaveProperty('SSESpecification');

    mockSend.mockClear();
    regionalSend.mockClear();
    await provider.update('T', TABLE, RESOURCE_TYPE, sent, aws, {
      desiredFromAwsReadback: true,
    } as never);

    // One table-level reset, and no other write: DynamoDB moves every replica
    // with it, and the replicas' dropped keys need no call of their own.
    expect(writes()).toEqual([
      [UpdateTableCommand.name, { TableName: TABLE, SSESpecification: { Enabled: false } }],
    ]);
  });

  it('sends no encryption change when the revert keeps the live block (the pre-fix overlay)', async () => {
    setLive(false);
    const baseline = await read();
    setLive(true);
    const aws = await read();
    const changes = await detect(baseline, aws);

    mockSend.mockClear();
    regionalSend.mockClear();
    await provider.update(
      'T',
      TABLE,
      RESOURCE_TYPE,
      buildRevertNewProperties(changes, baseline, aws),
      aws,
      { desiredFromAwsReadback: true } as never
    );

    expect(sseCalls()).toEqual([]);
  });

  it('reports nothing on an untouched table', async () => {
    setLive(false);
    const baseline = await read();
    expect(await detect(baseline, await read())).toEqual([]);
  });
});

describe('getDriftAbsentMeansDefaultKeys (go-to-k/cdkd#5399)', () => {
  it.each([
    ['no block (CDK default)', {}],
    ['SSEEnabled: false (dynamoOwnedKey)', { SSESpecification: { SSEEnabled: false } }],
    ["SSEEnabled: 'false'", { SSESpecification: { SSEEnabled: 'false' } }],
  ])('names SSESpecification for a template on the AWS owned key: %s', (_l, properties) => {
    expect(provider.getDriftAbsentMeansDefaultKeys(RESOURCE_TYPE, properties)).toEqual([
      'SSESpecification',
    ]);
  });

  it.each([
    ['a customer managed key', { SSESpecification: { SSEEnabled: true, SSEType: 'KMS' } }],
    ['a block without SSEEnabled', { SSESpecification: {} }],
    ['an unparsable SSEEnabled', { SSESpecification: { SSEEnabled: 'maybe' } }],
    ['a non-object block', { SSESpecification: 'x' }],
  ])('names nothing for a template declaring %s', (_l, properties) => {
    expect(provider.getDriftAbsentMeansDefaultKeys(RESOURCE_TYPE, properties)).toEqual([]);
  });

  it.each([undefined, null, 'x', ['SSESpecification']])(
    'names nothing for a record whose properties is not an object (%s), where `{}` would read as the default',
    (properties) => {
      expect(driftAbsentMeansDefaultKeys(provider, RESOURCE_TYPE, properties)).toEqual([]);
      expect(driftAbsentMeansDefaultKeys(provider, RESOURCE_TYPE, {})).toEqual(['SSESpecification']);
    }
  );

  it('drops a dotted name a provider returns, keeping the top-level ones', () => {
    const hook = { getDriftAbsentMeansDefaultKeys: () => ['SSESpecification', 'Replicas.SSESpecification'] };
    expect(driftAbsentMeansDefaultKeys(hook, RESOURCE_TYPE, {})).toEqual(['SSESpecification']);
  });

  it('names nothing for another type', () => {
    expect(provider.getDriftAbsentMeansDefaultKeys('AWS::DynamoDB::Table', {})).toEqual([]);
  });

  it('keeps a declared encryption on even when the baseline lacks the block', async () => {
    // A baseline that disagrees with its template (captured mid-transition,
    // say) must not turn declared encryption off.
    setLive(false);
    const baseline = await read();
    setLive(true);
    const aws = await read();
    const onTemplate = { ...declared, SSESpecification: { SSEEnabled: true, SSEType: 'KMS' } };
    const changes = await detect(baseline, aws, onTemplate);
    expect(changes.map((c) => c.path)).toEqual(['Replicas']);
    const sent = buildRevertNewProperties(changes, baseline, aws, {
      absentMeansDefault: driftAbsentMeansDefaultKeys(provider, RESOURCE_TYPE, onTemplate),
    });
    expect(sent['SSESpecification']).toEqual(aws['SSESpecification']);
  });
});

describe('a refused encryption change names the quota (go-to-k/cdkd#5399 integ)', () => {
  // AWS's text, as measured (us-east-1, 2026-10-28).
  const QUOTA_TEXT =
    'Subscriber limit exceeded: Encryption mode changes are limited in the 24h window ending at ' +
    '2026-10-28T20:13:44.484Z. After the first 4 change, each subsequent change in the same window ' +
    'can be performed at most once every 21600 seconds. Number of updates today: 4.';

  it('relays the quota for its text only', () => {
    expect(relayedEncryptionChangeLimit(QUOTA_TEXT)).toMatch(
      /^ AWS limits a table to 4 encryption changes in 24 hours, then one every 6 hours/
    );
    expect(relayedEncryptionChangeLimit('Subscriber limit exceeded: too many tables')).toBe('');
  });

  it('a drift --revert refused by the quota says why, not just the class', async () => {
    setLive(false);
    const baseline = await read();
    setLive(true);
    const aws = await read();
    const changes = await detect(baseline, aws);
    const live = mockSend.getMockImplementation()!;
    mockSend.mockImplementation(async (command: Sent) => {
      if (command.constructor.name === UpdateTableCommand.name && 'SSESpecification' in command.input) {
        throw new LimitExceededException({ message: QUOTA_TEXT, $metadata: {} });
      }
      return live(command);
    });

    const err = await provider
      .update(
        'T',
        TABLE,
        RESOURCE_TYPE,
        buildRevertNewProperties(changes, baseline, aws, {
          absentMeansDefault: driftAbsentMeansDefaultKeys(provider, RESOURCE_TYPE, declared),
        }),
        aws,
        { desiredFromAwsReadback: true } as never
      )
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );

    expect(err?.message).toContain('LimitExceededException');
    expect(err?.message).toContain('AWS limits a table to 4 encryption changes in 24 hours');
  });
});
