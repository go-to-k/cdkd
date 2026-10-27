import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DescribeContinuousBackupsCommand,
  DescribeContributorInsightsCommand,
  DescribeKinesisStreamingDestinationCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  GetResourcePolicyCommand,
  ListTagsOfResourceCommand,
  PolicyNotFoundException,
  UpdateContinuousBackupsCommand,
  UpdateKinesisStreamingDestinationCommand,
  UpdateTableCommand,
} from '@aws-sdk/client-dynamodb';

/**
 * go-to-k/cdkd#5381: `readCurrentState` read a replica's KMS key as a flat
 * `Replicas[].KMSMasterKeyId`, put the local table's class and protection at
 * the top level and never read a cross-region replica's, never read the two
 * resource policies, and dropped `RecoveryPeriodInDays` and `Mode`. The
 * read-back now uses the CFn spellings `create()` / `update()` read, and
 * `canonicalizeDriftPair` brings a baseline the old read-back wrote to the
 * same shape.
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

import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import {
  canonicalizePre5381ReplicaBaseline,
  keepUnreadReplicaMembers,
  planReplicaSettingOps,
  reverseMapReplicaContributorInsights,
  reverseMapReplicaPitr,
} from '../../../src/provisioning/dynamodb-replica-settings.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE = 'gt-5381';
const LOCAL_ARN = `arn:aws:dynamodb:us-east-1:123456789012:table/${TABLE}`;
const REMOTE_ARN = `arn:aws:dynamodb:eu-west-1:123456789012:table/${TABLE}`;
const LOCAL_STREAM = `${LOCAL_ARN}/stream/2026-10-27T00:00:00.000`;
const REMOTE_STREAM = `${REMOTE_ARN}/stream/2026-10-27T00:00:00.000`;
const LOCAL_KEY = 'arn:aws:kms:us-east-1:123456789012:key/local';
const REMOTE_KEY = 'arn:aws:kms:eu-west-1:123456789012:key/remote';

const policy = (action: string): Record<string, unknown> => ({
  Version: '2012-10-17',
  Statement: [
    { Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::123456789012:root' }, Action: action, Resource: '*' },
  ],
});

type Sent = { constructor: { name: string }; input: Record<string, any> };
const calls = (fn: ReturnType<typeof vi.fn>, ctor: { name: string }): Array<Record<string, any>> =>
  fn.mock.calls
    .map((c) => c[0] as Sent)
    .filter((c) => c.constructor.name === ctor.name)
    .map((c) => c.input);

interface RegionLive {
  pitr?: { status: string; period?: number };
  ci?: { status: string; mode?: string };
  tablePolicy?: string;
  streamPolicy?: string;
  /** Successive answers for the TABLE policy (an Error is thrown), overriding `tablePolicy`. */
  tablePolicyReads?: Array<string | Error | undefined>;
  protection?: boolean;
  describeFails?: boolean;
}

const regionDouble =
  (arn: string, stream: string, live: RegionLive, table: Record<string, unknown>) =>
  async (command: Sent): Promise<unknown> => {
    switch (command.constructor.name) {
      case DescribeTableCommand.name:
        if (live.describeFails) throw Object.assign(new Error('AccessDenied'), { name: 'AccessDeniedException' });
        return {
          Table: {
            TableName: TABLE,
            TableArn: arn,
            TableStatus: 'ACTIVE',
            LatestStreamArn: stream,
            ...(live.protection !== undefined && { DeletionProtectionEnabled: live.protection }),
            ...table,
          },
        };
      case DescribeContinuousBackupsCommand.name:
        return {
          ContinuousBackupsDescription: {
            PointInTimeRecoveryDescription: {
              PointInTimeRecoveryStatus: live.pitr?.status ?? 'DISABLED',
              ...(live.pitr?.period !== undefined && { RecoveryPeriodInDays: live.pitr.period }),
            },
          },
        };
      case DescribeContributorInsightsCommand.name:
        return {
          ContributorInsightsStatus: live.ci?.status ?? 'DISABLED',
          ...(live.ci?.mode !== undefined && { ContributorInsightsMode: live.ci.mode }),
        };
      case DescribeKinesisStreamingDestinationCommand.name:
        return { KinesisDataStreamDestinations: [] };
      case ListTagsOfResourceCommand.name:
        return { Tags: [] };
      case DescribeTimeToLiveCommand.name:
        return { TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' } };
      case GetResourcePolicyCommand.name: {
        if (command.input['ResourceArn'] !== stream && live.tablePolicyReads !== undefined) {
          const next = live.tablePolicyReads.shift();
          if (next instanceof Error) throw next;
          if (next !== undefined) return { Policy: next };
          throw new PolicyNotFoundException({ message: 'no policy', $metadata: {} });
        }
        const doc = command.input['ResourceArn'] === stream ? live.streamPolicy : live.tablePolicy;
        if (doc !== undefined) return { Policy: doc };
        throw new PolicyNotFoundException({ message: 'no policy', $metadata: {} });
      }
      case UpdateTableCommand.name:
        if (typeof command.input['DeletionProtectionEnabled'] === 'boolean') {
          live.protection = command.input['DeletionProtectionEnabled'];
        }
        return {};
      default:
        return {};
    }
  };

/** A two-region table: us-east-1 (the deploy region) and eu-west-1. */
const setLive = (
  local: RegionLive,
  remote: RegionLive,
  sourceTable: Record<string, unknown> = {}
): void => {
  mockSend.mockImplementation(
    regionDouble(LOCAL_ARN, LOCAL_STREAM, local, {
      Replicas: [{ RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' }],
      ...sourceTable,
    })
  );
  regionalSend.mockImplementation(regionDouble(REMOTE_ARN, REMOTE_STREAM, remote, {}));
};

const replicaOf = (bag: unknown, region: string): Record<string, unknown> =>
  ((bag as Record<string, unknown>)['Replicas'] as Array<Record<string, unknown>>).find(
    (r) => r['Region'] === region
  )!;

const declared = (
  local: Record<string, unknown> = {},
  remote: Record<string, unknown> = {}
): Record<string, unknown> => ({
  TableName: TABLE,
  BillingMode: 'PAY_PER_REQUEST',
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
  Replicas: [
    { Region: 'eu-west-1', ...remote },
    { Region: 'us-east-1', ...local },
  ],
});

let provider: DynamoDBGlobalTableProvider;
beforeEach(() => {
  mockSend.mockReset();
  regionalSend.mockReset();
  mockAutoScalingSend.mockReset();
  provider = new DynamoDBGlobalTableProvider();
  (provider as unknown as { policyRereadDelaysMs: number[] }).policyRereadDelaysMs = [];
});

describe('read-back reverse maps (go-to-k/cdkd#5381)', () => {
  it('reads RecoveryPeriodInDays, and ENABLING as enabled at the declared period', () => {
    expect(reverseMapReplicaPitr('ENABLED', 10, undefined)).toEqual({
      PointInTimeRecoveryEnabled: true,
      RecoveryPeriodInDays: 10,
    });
    expect(
      reverseMapReplicaPitr('ENABLING', undefined, {
        PointInTimeRecoveryEnabled: true,
        RecoveryPeriodInDays: 7,
      })
    ).toEqual({ PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 7 });
    // An ENABLING read as `false` became an explicit disable under drift --revert.
    // Nothing declared: the default an enable without a period gets, which
    // every later read reports (a baseline without it drifted forever).
    expect(reverseMapReplicaPitr('ENABLING', undefined, undefined)).toEqual({
      PointInTimeRecoveryEnabled: true,
      RecoveryPeriodInDays: 35,
    });
    // Only ENABLING borrows the declared period.
    expect(
      reverseMapReplicaPitr('ENABLED', undefined, {
        PointInTimeRecoveryEnabled: true,
        RecoveryPeriodInDays: 7,
      })
    ).toEqual({ PointInTimeRecoveryEnabled: true });
    expect(reverseMapReplicaPitr('DISABLED', 35, undefined)).toEqual({
      PointInTimeRecoveryEnabled: false,
    });
    expect(reverseMapReplicaPitr(undefined, undefined, undefined)).toBeUndefined();
  });

  it('reads Contributor Insights Mode only when declared, and ENABLING as enabled', () => {
    // AWS reports a mode for every enabled rule set (measured: no Mode sent,
    // ACCESSED_AND_THROTTLED_KEYS read back).
    expect(reverseMapReplicaContributorInsights('ENABLED', 'ACCESSED_AND_THROTTLED_KEYS', { Enabled: true })).toEqual({
      Enabled: true,
    });
    expect(
      reverseMapReplicaContributorInsights('ENABLED', 'ACCESSED_AND_THROTTLED_KEYS', {
        Enabled: true,
        Mode: 'THROTTLED_KEYS',
      })
    ).toEqual({ Enabled: true, Mode: 'ACCESSED_AND_THROTTLED_KEYS' });
    expect(
      reverseMapReplicaContributorInsights('ENABLING', undefined, {
        Enabled: true,
        Mode: 'THROTTLED_KEYS',
      })
    ).toEqual({ Enabled: true, Mode: 'THROTTLED_KEYS' });
    expect(reverseMapReplicaContributorInsights('DISABLING', undefined, undefined)).toEqual({
      Enabled: false,
    });
    expect(reverseMapReplicaContributorInsights('FAILED', undefined, undefined)).toBeUndefined();
  });
});

describe('readCurrentState replica members (go-to-k/cdkd#5381)', () => {
  it('emits each replica key, class and protection in the CFn spelling, none top-level', async () => {
    setLive(
      { protection: false },
      { protection: true },
      {
        SSEDescription: { Status: 'ENABLED', SSEType: 'KMS', KMSMasterKeyArn: LOCAL_KEY },
        TableClassSummary: { TableClass: 'STANDARD_INFREQUENT_ACCESS' },
        Replicas: [
          {
            RegionName: 'eu-west-1',
            ReplicaStatus: 'ACTIVE',
            KMSMasterKeyId: REMOTE_KEY,
            ReplicaTableClassSummary: { TableClass: 'STANDARD' },
          },
        ],
      }
    );
    const bag = (await provider.readCurrentState(TABLE, 'T', RESOURCE_TYPE, declared())) as Record<
      string,
      unknown
    >;
    expect(bag).not.toHaveProperty('TableClass');
    expect(bag).not.toHaveProperty('DeletionProtectionEnabled');
    const local = replicaOf(bag, 'us-east-1');
    const remote = replicaOf(bag, 'eu-west-1');
    expect(local).toMatchObject({
      SSESpecification: { KMSMasterKeyId: LOCAL_KEY },
      TableClass: 'STANDARD_INFREQUENT_ACCESS',
      DeletionProtectionEnabled: false,
    });
    expect(remote).toMatchObject({
      SSESpecification: { KMSMasterKeyId: REMOTE_KEY },
      TableClass: 'STANDARD',
      DeletionProtectionEnabled: true,
    });
    expect(remote).not.toHaveProperty('KMSMasterKeyId');
    // The remote protection is read in the replica's own region.
    expect(calls(regionalSend, DescribeTableCommand)).toEqual([{ TableName: TABLE }]);
  });

  it('reads a class AWS does not summarize as the source table class, then STANDARD', async () => {
    setLive({}, {}, { TableClassSummary: { TableClass: 'STANDARD_INFREQUENT_ACCESS' } });
    const inherited = await provider.readCurrentState(TABLE, 'T', RESOURCE_TYPE, declared());
    expect(replicaOf(inherited, 'eu-west-1')['TableClass']).toBe('STANDARD_INFREQUENT_ACCESS');
    setLive({}, {});
    const unset = await provider.readCurrentState(TABLE, 'T', RESOURCE_TYPE, declared());
    expect(replicaOf(unset, 'eu-west-1')['TableClass']).toBe('STANDARD');
    expect(replicaOf(unset, 'us-east-1')['TableClass']).toBe('STANDARD');
  });

  it('omits a cross-region protection whose regional read failed, keeping the rest', async () => {
    setLive({ protection: true }, { describeFails: true, pitr: { status: 'ENABLED', period: 10 } });
    const bag = await provider.readCurrentState(TABLE, 'T', RESOURCE_TYPE, declared());
    expect(replicaOf(bag, 'eu-west-1')).not.toHaveProperty('DeletionProtectionEnabled');
    expect(replicaOf(bag, 'eu-west-1')['PointInTimeRecoverySpecification']).toEqual({
      PointInTimeRecoveryEnabled: true,
      RecoveryPeriodInDays: 10,
    });
    expect(replicaOf(bag, 'us-east-1')['DeletionProtectionEnabled']).toBe(true);
  });

  it('reads the period and a declared mode', async () => {
    setLive(
      { pitr: { status: 'ENABLED', period: 35 }, ci: { status: 'ENABLED', mode: 'THROTTLED_KEYS' } },
      { pitr: { status: 'ENABLED', period: 10 }, ci: { status: 'ENABLED', mode: 'ACCESSED_AND_THROTTLED_KEYS' } }
    );
    const bag = await provider.readCurrentState(
      TABLE,
      'T',
      RESOURCE_TYPE,
      declared({ ContributorInsightsSpecification: { Enabled: true, Mode: 'THROTTLED_KEYS' } }, {
        ContributorInsightsSpecification: { Enabled: true },
      })
    );
    expect(replicaOf(bag, 'us-east-1')).toMatchObject({
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 35 },
      ContributorInsightsSpecification: { Enabled: true, Mode: 'THROTTLED_KEYS' },
    });
    expect(replicaOf(bag, 'eu-west-1')['ContributorInsightsSpecification']).toEqual({ Enabled: true });
  });

  it('reads each declared resource policy on its own region, table and stream arn', async () => {
    const tableDoc = policy('dynamodb:GetItem');
    const streamDoc = policy('dynamodb:GetRecords');
    setLive(
      { streamPolicy: JSON.stringify(streamDoc) },
      { tablePolicy: JSON.stringify(tableDoc), streamPolicy: JSON.stringify(streamDoc) }
    );
    const bag = await provider.readCurrentState(
      TABLE,
      'T',
      RESOURCE_TYPE,
      declared(
        { ReplicaStreamSpecification: { ResourcePolicy: { PolicyDocument: streamDoc } } },
        {
          ResourcePolicy: { PolicyDocument: tableDoc },
          ReplicaStreamSpecification: { ResourcePolicy: { PolicyDocument: streamDoc } },
        }
      )
    );
    expect(replicaOf(bag, 'eu-west-1')['ResourcePolicy']).toEqual({ PolicyDocument: tableDoc });
    expect(replicaOf(bag, 'eu-west-1')['ReplicaStreamSpecification']).toEqual({
      ResourcePolicy: { PolicyDocument: streamDoc },
    });
    expect(replicaOf(bag, 'us-east-1')['ReplicaStreamSpecification']).toEqual({
      ResourcePolicy: { PolicyDocument: streamDoc },
    });
    // Undeclared: the local table policy is never asked for.
    expect(replicaOf(bag, 'us-east-1')).not.toHaveProperty('ResourcePolicy');
    expect(calls(mockSend, GetResourcePolicyCommand)).toEqual([{ ResourceArn: LOCAL_STREAM }]);
    expect(calls(regionalSend, GetResourcePolicyCommand)).toEqual([
      { ResourceArn: REMOTE_ARN },
      { ResourceArn: REMOTE_STREAM },
    ]);
  });

  it('reports a declared policy removed out of band as absent on the first answer of a drift read', async () => {
    (provider as unknown as { policyRereadDelaysMs: number[] }).policyRereadDelaysMs = [0, 0];
    setLive({}, {});
    const decl = declared({}, { ResourcePolicy: { PolicyDocument: policy('dynamodb:GetItem') } });
    const bag = await provider.readCurrentState(TABLE, 'T', RESOURCE_TYPE, decl);
    expect(replicaOf(bag, 'eu-west-1')).not.toHaveProperty('ResourcePolicy');
    expect(calls(regionalSend, GetResourcePolicyCommand)).toHaveLength(1);
  });

  it('re-asks a lagging policy read only on the capture after its own write', async () => {
    (provider as unknown as { policyRereadDelaysMs: number[] }).policyRereadDelaysMs = [0, 0];
    const doc = policy('dynamodb:GetItem');
    setLive({}, { tablePolicyReads: [undefined, JSON.stringify(doc)] });
    const bag = await provider.readCurrentState(
      TABLE,
      'T',
      RESOURCE_TYPE,
      declared({}, { ResourcePolicy: { PolicyDocument: doc } }),
      { afterOwnWrite: true }
    );
    expect(replicaOf(bag, 'eu-west-1')['ResourcePolicy']).toEqual({ PolicyDocument: doc });
    expect(calls(regionalSend, GetResourcePolicyCommand)).toHaveLength(2);
  });

  it('keeps a declared policy a read right after its own write still finds absent', async () => {
    setLive({}, {});
    const doc = policy('dynamodb:GetItem');
    const bag = await provider.readCurrentState(
      TABLE,
      'T',
      RESOURCE_TYPE,
      declared({}, { ResourcePolicy: { PolicyDocument: doc } }),
      { afterOwnWrite: true }
    );
    expect(replicaOf(bag, 'eu-west-1')['ResourcePolicy']).toEqual({ PolicyDocument: doc });
  });
});

/** What the pre-#5381 read-back wrote for the two-region table. */
const legacyBaseline = (): Record<string, unknown> => ({
  TableName: TABLE,
  TableClass: 'STANDARD_INFREQUENT_ACCESS',
  DeletionProtectionEnabled: false,
  Replicas: [
    {
      Region: 'eu-west-1',
      KMSMasterKeyId: REMOTE_KEY,
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      ContributorInsightsSpecification: { Enabled: true },
      Tags: [],
    },
    {
      Region: 'us-east-1',
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
      ContributorInsightsSpecification: { Enabled: false },
      Tags: [],
    },
  ],
});

/** The current read-back of the same, untouched table. */
const currentReadback = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  TableName: TABLE,
  Replicas: [
    {
      Region: 'eu-west-1',
      SSESpecification: { KMSMasterKeyId: REMOTE_KEY },
      TableClass: 'STANDARD_INFREQUENT_ACCESS',
      DeletionProtectionEnabled: true,
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 10 },
      ContributorInsightsSpecification: { Enabled: true },
      ResourcePolicy: { PolicyDocument: policy('dynamodb:GetItem') },
      Tags: [],
      ...overrides,
    },
    {
      Region: 'us-east-1',
      SSESpecification: { KMSMasterKeyId: LOCAL_KEY },
      TableClass: 'STANDARD_INFREQUENT_ACCESS',
      DeletionProtectionEnabled: false,
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
      ContributorInsightsSpecification: { Enabled: false },
      Tags: [],
    },
  ],
});

const drift = async (baseline: Record<string, unknown>, aws: Record<string, unknown>) => {
  const paired = await provider.canonicalizeDriftPair(RESOURCE_TYPE, baseline, aws);
  return calculateResourceDrift(paired.baseline, paired.aws, {
    unionWalkObjects: true,
    unorderedPaths: provider.getDriftUnorderedPaths(RESOURCE_TYPE),
  });
};

describe('canonicalizeDriftPair on a pre-#5381 baseline (go-to-k/cdkd#5381)', () => {
  it('reports no drift for an untouched table, and does report it without the hook', async () => {
    expect(await drift(legacyBaseline(), currentReadback())).toEqual([]);
    expect(
      calculateResourceDrift(legacyBaseline(), currentReadback(), {
        unionWalkObjects: true,
        unorderedPaths: provider.getDriftUnorderedPaths(RESOURCE_TYPE),
      }).map((d) => d.path)
    ).toEqual(expect.arrayContaining(['TableClass', 'DeletionProtectionEnabled', 'Replicas']));
  });

  it('keeps what the old baseline DID record: a changed local class and key still drift', async () => {
    const aws = currentReadback();
    const local = replicaOf(aws, 'us-east-1');
    local['TableClass'] = 'STANDARD';
    expect((await drift(legacyBaseline(), aws)).map((d) => d.path)).toEqual(['Replicas']);
    const rekeyed = currentReadback({ SSESpecification: { KMSMasterKeyId: 'arn:other' } });
    expect((await drift(legacyBaseline(), rekeyed)).map((d) => d.path)).toEqual(['Replicas']);
  });

  it('compares a current-shape baseline in full', async () => {
    const baseline = currentReadback();
    expect(canonicalizePre5381ReplicaBaseline(baseline, currentReadback(), 'us-east-1')).toBe(baseline);
    const changed = currentReadback({
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 20 },
    });
    expect((await drift(currentReadback(), changed)).map((d) => d.path)).toEqual(['Replicas']);
    const unpolicied = currentReadback();
    delete replicaOf(unpolicied, 'eu-west-1')['ResourcePolicy'];
    expect((await drift(currentReadback(), unpolicied)).map((d) => d.path)).toEqual(['Replicas']);
  });

  it('never gives a disabled block an enabled-only member', () => {
    const baseline = legacyBaseline();
    const aws = currentReadback({
      ContributorInsightsSpecification: { Enabled: false },
    });
    const local = replicaOf(aws, 'us-east-1');
    local['PointInTimeRecoverySpecification'] = {
      PointInTimeRecoveryEnabled: true,
      RecoveryPeriodInDays: 35,
    };
    const out = canonicalizePre5381ReplicaBaseline(baseline, aws, 'us-east-1');
    expect(replicaOf(out, 'us-east-1')['PointInTimeRecoverySpecification']).toEqual({
      PointInTimeRecoveryEnabled: false,
    });
    expect(baseline).toEqual(legacyBaseline());
  });
});

describe('member removals and drift --revert (go-to-k/cdkd#5381)', () => {
  const ks = 'arn:aws:kinesis:eu-west-1:123456789012:stream/s';
  it('resets a removed Kinesis precision to MILLISECOND, as CloudFormation does', () => {
    const ops = planReplicaSettingOps(
      { KinesisStreamSpecification: { StreamArn: ks } },
      { KinesisStreamSpecification: { StreamArn: ks, ApproximateCreationDateTimePrecision: 'MICROSECOND' } },
      { fresh: false },
      () => undefined
    );
    expect(ops).toEqual([{ kind: 'kinesisPrecision', streamArn: ks, precision: 'MILLISECOND' }]);
    expect(
      planReplicaSettingOps(
        { KinesisStreamSpecification: { StreamArn: ks } },
        { KinesisStreamSpecification: { StreamArn: ks, ApproximateCreationDateTimePrecision: 'MILLISECOND' } },
        { fresh: false },
        () => undefined
      )
    ).toEqual([]);
    expect(
      planReplicaSettingOps(
        { KinesisStreamSpecification: { StreamArn: ks } },
        { KinesisStreamSpecification: { StreamArn: ks, ApproximateCreationDateTimePrecision: 'MICROSECOND' } },
        { fresh: false, keepOnRemoval: new Set(['kinesis']) },
        () => undefined
      )
    ).toEqual([]);
  });

  it('sends a removed period as an enable without one (CloudFormation leaves the 35-day default), a rollback replay included', () => {
    const prev = { PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 10 } };
    const desired = { PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } };
    expect(planReplicaSettingOps(desired, prev, { fresh: false }, () => undefined)).toEqual([
      { kind: 'pitr', enabled: true },
    ]);
    // A replay keeps recovery ON, but a longer window destroys nothing.
    expect(
      planReplicaSettingOps(desired, prev, { fresh: false, keepOnRemoval: new Set(['pitr']) }, () => undefined)
    ).toEqual([{ kind: 'pitr', enabled: true }]);
  });

  it('plans no precision call when neither side declares one', () => {
    expect(
      planReplicaSettingOps(
        { KinesisStreamSpecification: { StreamArn: ks } },
        { KinesisStreamSpecification: { StreamArn: ks } },
        { fresh: false },
        () => undefined
      )
    ).toEqual([]);
  });

  it('keeps the live period on drift --revert when the recorded side holds none', async () => {
    setLive({}, { pitr: { status: 'ENABLED', period: 10 } });
    await provider.update(
      'T',
      TABLE,
      RESOURCE_TYPE,
      declared({}, { PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } }),
      declared({}, { PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 10 } }),
      { desiredFromAwsReadback: true } as never
    );
    expect(calls(regionalSend, UpdateContinuousBackupsCommand)).toEqual([]);
  });

  it('keeps the local protection and class on a drift --revert of a record with no read-back (template desired side)', async () => {
    setLive({ protection: true }, {}, { TableClassSummary: { TableClass: 'STANDARD_INFREQUENT_ACCESS' } });
    await provider.update(
      'T',
      TABLE,
      RESOURCE_TYPE,
      declared({}, {}),
      declared(
        { DeletionProtectionEnabled: true, TableClass: 'STANDARD_INFREQUENT_ACCESS' },
        { TableClass: 'STANDARD_INFREQUENT_ACCESS' }
      ),
      { desiredFromAwsReadback: true } as never
    );
    const sentChange = calls(mockSend, UpdateTableCommand).filter(
      (i) => 'DeletionProtectionEnabled' in i || 'TableClass' in i || 'ReplicaUpdates' in i
    );
    expect(sentChange).toEqual([]);
  });

  it('re-sends the recorded period on drift --revert', async () => {
    setLive({}, { pitr: { status: 'ENABLED', period: 35 } });
    await provider.update(
      'T',
      TABLE,
      RESOURCE_TYPE,
      declared({}, { PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 10 } }),
      declared({}, { PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 35 } }),
      { desiredFromAwsReadback: true } as never
    );
    expect(calls(regionalSend, UpdateContinuousBackupsCommand)).toEqual([
      {
        TableName: TABLE,
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 10 },
      },
    ]);
    expect(calls(regionalSend, UpdateKinesisStreamingDestinationCommand)).toEqual([]);
  });

  it('never unprotects a replica whose protection the drift --revert read-back omitted', async () => {
    setLive({}, { protection: true });
    await provider.update(
      'T',
      TABLE,
      RESOURCE_TYPE,
      declared({}, {}),
      declared({}, { DeletionProtectionEnabled: true }),
      { desiredFromAwsReadback: true } as never
    );
    const unprotect = (fn: ReturnType<typeof vi.fn>) =>
      calls(fn, UpdateTableCommand).filter((i) => 'DeletionProtectionEnabled' in i);
    expect(unprotect(regionalSend)).toEqual([]);
    expect(unprotect(mockSend)).toEqual([]);
  });

  it('still unprotects on a template that removed the member', async () => {
    setLive({}, { protection: true });
    await provider.update(
      'T',
      TABLE,
      RESOURCE_TYPE,
      declared({}, {}),
      declared({}, { DeletionProtectionEnabled: true })
    );
    expect(
      calls(regionalSend, UpdateTableCommand).filter((i) => i['DeletionProtectionEnabled'] === false)
    ).toHaveLength(1);
  });
});

describe('read-back edges (go-to-k/cdkd#5381 review)', () => {
  const doc = policy('dynamodb:GetItem');
  const decl = () => declared({}, { ResourcePolicy: { PolicyDocument: doc } });
  const throttle = () => Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
  const denied = () => Object.assign(new Error('denied'), { name: 'AccessDeniedException' });

  it('reads insights without a mode as declared-mode-less when AWS reports none while ENABLED', () => {
    expect(
      reverseMapReplicaContributorInsights('ENABLED', undefined, { Enabled: true, Mode: 'THROTTLED_KEYS' })
    ).toEqual({ Enabled: true });
  });

  it('keeps the declared policy after its own write when the read fails transiently', async () => {
    setLive({}, { tablePolicyReads: [throttle()] });
    const bag = await provider.readCurrentState(TABLE, 'T', RESOURCE_TYPE, decl(), { afterOwnWrite: true });
    expect(replicaOf(bag, 'eu-west-1')['ResourcePolicy']).toEqual({ PolicyDocument: doc });
  });

  it('omits the policy after its own write when the read fails for good', async () => {
    setLive({}, { tablePolicyReads: [denied()] });
    const bag = await provider.readCurrentState(TABLE, 'T', RESOURCE_TYPE, decl(), { afterOwnWrite: true });
    expect(replicaOf(bag, 'eu-west-1')).not.toHaveProperty('ResourcePolicy');
  });

  it('omits the policy on a drift read that fails transiently', async () => {
    setLive({}, { tablePolicyReads: [throttle()] });
    const bag = await provider.readCurrentState(TABLE, 'T', RESOURCE_TYPE, decl());
    expect(replicaOf(bag, 'eu-west-1')).not.toHaveProperty('ResourcePolicy');
  });

  it('records a present answer a later re-ask failed on, after its own write', async () => {
    (provider as unknown as { policyRereadDelaysMs: number[] }).policyRereadDelaysMs = [0];
    const other = policy('dynamodb:PutItem');
    setLive({}, { tablePolicyReads: [JSON.stringify(other), throttle()] });
    const bag = await provider.readCurrentState(TABLE, 'T', RESOURCE_TYPE, decl(), { afterOwnWrite: true });
    expect(replicaOf(bag, 'eu-west-1')['ResourcePolicy']).toEqual({ PolicyDocument: other });
  });

  it('believes a different live policy after its own write', async () => {
    const other = policy('dynamodb:PutItem');
    setLive({}, { tablePolicyReads: [JSON.stringify(other)] });
    const bag = await provider.readCurrentState(TABLE, 'T', RESOURCE_TYPE, decl(), { afterOwnWrite: true });
    expect(replicaOf(bag, 'eu-west-1')['ResourcePolicy']).toEqual({ PolicyDocument: other });
  });

  it('reads no local key while SSE is not ENABLED', async () => {
    setLive({}, {}, { SSEDescription: { Status: 'UPDATING', SSEType: 'KMS', KMSMasterKeyArn: LOCAL_KEY } });
    const bag = await provider.readCurrentState(TABLE, 'T', RESOURCE_TYPE, declared());
    expect(replicaOf(bag, 'us-east-1')).not.toHaveProperty('SSESpecification');
  });

  it('asks for no stream policy when the regional read that names the stream failed', async () => {
    const streamDoc = policy('dynamodb:GetRecords');
    setLive({}, { describeFails: true, streamPolicy: JSON.stringify(streamDoc) });
    const bag = await provider.readCurrentState(
      TABLE,
      'T',
      RESOURCE_TYPE,
      declared({}, { ReplicaStreamSpecification: { ResourcePolicy: { PolicyDocument: streamDoc } } })
    );
    expect(replicaOf(bag, 'eu-west-1')).not.toHaveProperty('ReplicaStreamSpecification');
    expect(calls(regionalSend, GetResourcePolicyCommand)).toEqual([]);
  });

  it('keeps the recorded top-level protection on a baseline that predates #3573 too', async () => {
    const baseline = legacyBaseline();
    baseline['Replicas'] = (baseline['Replicas'] as Array<Record<string, unknown>>).filter(
      (r) => r['Region'] !== 'us-east-1'
    );
    const aws = currentReadback();
    replicaOf(aws, 'us-east-1')['DeletionProtectionEnabled'] = true;
    expect((await drift(baseline, aws)).map((d) => d.path)).toEqual(['Replicas']);
    replicaOf(aws, 'us-east-1')['DeletionProtectionEnabled'] = false;
    expect(await drift(baseline, aws)).toEqual([]);
  });
});

describe('keepUnreadReplicaMembers (go-to-k/cdkd#5381 review round 2)', () => {
  const live = {
    SSESpecification: { SSEEnabled: true, SSEType: 'KMS' },
    Replicas: [{ Region: 'us-east-1', SSESpecification: { KMSMasterKeyId: LOCAL_KEY }, TableClass: 'STANDARD' }],
  };
  it('fills an unread key only while the desired side has KMS encryption on', () => {
    const on = keepUnreadReplicaMembers(
      { SSESpecification: { SSEEnabled: true, SSEType: 'KMS' }, Replicas: [{ Region: 'us-east-1' }] },
      live
    );
    expect(replicaOf(on, 'us-east-1')['SSESpecification']).toEqual({ KMSMasterKeyId: LOCAL_KEY });
    // A baseline recorded on the AWS owned key: no key IS the recorded value,
    // so a customer managed key set out of band stays revertible.
    const off = keepUnreadReplicaMembers({ Replicas: [{ Region: 'us-east-1' }] }, live);
    expect(replicaOf(off, 'us-east-1')).not.toHaveProperty('SSESpecification');
    expect(replicaOf(off, 'us-east-1')['TableClass']).toBe('STANDARD');
  });

  it('never touches a member the desired side records', () => {
    const desired = {
      Replicas: [{ Region: 'us-east-1', TableClass: 'STANDARD_INFREQUENT_ACCESS', DeletionProtectionEnabled: false }],
    };
    const out = keepUnreadReplicaMembers(desired, {
      Replicas: [{ Region: 'us-east-1', TableClass: 'STANDARD', DeletionProtectionEnabled: true }],
    });
    expect(out).toBe(desired);
  });
});
