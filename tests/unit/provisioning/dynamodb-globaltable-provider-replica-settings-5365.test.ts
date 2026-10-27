import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTableCommand,
  DeleteResourcePolicyCommand,
  DescribeContinuousBackupsCommand,
  DescribeContributorInsightsCommand,
  DescribeKinesisStreamingDestinationCommand,
  DisableKinesisStreamingDestinationCommand,
  EnableKinesisStreamingDestinationCommand,
  GetResourcePolicyCommand,
  PolicyNotFoundException,
  PutResourcePolicyCommand,
  UpdateContinuousBackupsCommand,
  UpdateContributorInsightsCommand,
  UpdateKinesisStreamingDestinationCommand,
  UpdateTableCommand,
} from '@aws-sdk/client-dynamodb';

/**
 * go-to-k/cdkd#5365: a replica's `PointInTimeRecoverySpecification`,
 * `ContributorInsightsSpecification`, `KinesisStreamSpecification`,
 * `ResourcePolicy` and `ReplicaStreamSpecification.ResourcePolicy` were never
 * sent, for the local table or a cross-region replica, on create or update.
 *
 * The bags follow `cdk synth` for a `TableV2` whose replicas set
 * `pointInTimeRecoverySpecification`, `contributorInsightsSpecification`,
 * `kinesisStream`, `resourcePolicy` and `streamResourcePolicy`: each renders
 * PER REPLICA.
 */

const { mockSend, regionalSend, mockAutoScalingSend, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  regionalSend: vi.fn(),
  mockAutoScalingSend: vi.fn(),
  warnSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

// Every client is the SOURCE double except the eu-west-1 one, so a call's
// REGION is what a test reads.
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
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import {
  DynamoDBGlobalTableProvider,
  replicaSettingsRefusal,
} from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import {
  planReplicaSettingCorrections,
  planReplicaSettingOps,
  readKinesisSpec,
  readPitrSpec,
  replicaSettingRefusals,
} from '../../../src/provisioning/dynamodb-replica-settings.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';
const ALL = new Set(['pitr', 'contributorInsights', 'kinesis', 'tablePolicy', 'streamPolicy'] as const);
const TABLE = 'gt-5365';
const LOCAL_ARN = `arn:aws:dynamodb:us-east-1:123456789012:table/${TABLE}`;
const REMOTE_ARN = `arn:aws:dynamodb:eu-west-1:123456789012:table/${TABLE}`;
const LOCAL_STREAM = `${LOCAL_ARN}/stream/2026-10-27T00:00:00.000`;
const REMOTE_STREAM = `${REMOTE_ARN}/stream/2026-10-27T00:00:00.000`;
const LOCAL_KS = 'arn:aws:kinesis:us-east-1:123456789012:stream/local';
const REMOTE_KS = 'arn:aws:kinesis:eu-west-1:123456789012:stream/remote';
const REMOTE_KS2 = 'arn:aws:kinesis:eu-west-1:123456789012:stream/remote2';

const policy = (action: string): Record<string, unknown> => ({
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { AWS: 'arn:aws:iam::123456789012:root' },
      Action: action,
      Resource: '*',
    },
  ],
});

/** Every setting this issue wires, for one replica. */
const allSettings = (kinesisStream: string, withTablePolicy = true): Record<string, unknown> => ({
  PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 10 },
  ContributorInsightsSpecification: { Enabled: true },
  KinesisStreamSpecification: {
    StreamArn: kinesisStream,
    ApproximateCreationDateTimePrecision: 'MILLISECOND',
  },
  ...(withTablePolicy && { ResourcePolicy: { PolicyDocument: policy('dynamodb:GetItem') } }),
  ReplicaStreamSpecification: { ResourcePolicy: { PolicyDocument: policy('dynamodb:GetRecords') } },
});

const base = (
  local: Record<string, unknown> = {},
  remote: Record<string, unknown> | null = {}
): Record<string, unknown> => ({
  TableName: TABLE,
  BillingMode: 'PAY_PER_REQUEST',
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
  Replicas: [
    { Region: 'us-east-1', ...local },
    ...(remote !== null ? [{ Region: 'eu-west-1', ...remote }] : []),
  ],
});

type Sent = { constructor: { name: string }; input: Record<string, any> };
const sent = (fn: ReturnType<typeof vi.fn>, ctor: { name: string }): Array<Record<string, any>> =>
  fn.mock.calls
    .map((c) => c[0] as Sent)
    .filter((c) => c.constructor.name === ctor.name)
    .map((c) => c.input);

/** The WRITE calls this issue adds, in order, as `[command, input]`. */
const WRITES = [
  UpdateContinuousBackupsCommand,
  UpdateContributorInsightsCommand,
  EnableKinesisStreamingDestinationCommand,
  DisableKinesisStreamingDestinationCommand,
  UpdateKinesisStreamingDestinationCommand,
  PutResourcePolicyCommand,
  DeleteResourcePolicyCommand,
].map((c) => c.name);
const writes = (fn: ReturnType<typeof vi.fn>): Array<[string, Record<string, any>]> =>
  fn.mock.calls
    .map((c) => c[0] as Sent)
    .filter((c) => WRITES.includes(c.constructor.name))
    .map((c) => [c.constructor.name, c.input]);

interface Live {
  pitr?: 'ENABLED' | 'DISABLED';
  period?: number;
  ci?: 'ENABLED' | 'DISABLED';
  kinesis?: string[];
  tablePolicy?: boolean;
  streamPolicy?: boolean;
}

/**
 * One region's table double: answers the describes (ARNs, stream, the four
 * setting reads) from `live`, and every write with `{}` unless `refuse`
 * names its command.
 */
const regionDouble = (
  arn: string,
  stream: string,
  live: Live,
  replicas: string[] | undefined,
  refuse: (name: string, input: Record<string, any>) => Error | undefined = () => undefined
) => {
  return async (command: Sent): Promise<unknown> => {
    const name = command.constructor.name;
    const refusal = refuse(name, command.input);
    if (refusal) throw refusal;
    switch (name) {
      case DescribeContinuousBackupsCommand.name:
        return {
          ContinuousBackupsDescription: {
            PointInTimeRecoveryDescription: {
              PointInTimeRecoveryStatus: live.pitr ?? 'DISABLED',
              ...(live.period !== undefined && { RecoveryPeriodInDays: live.period }),
            },
          },
        };
      case DescribeContributorInsightsCommand.name:
        return { ContributorInsightsStatus: live.ci ?? 'DISABLED' };
      case DescribeKinesisStreamingDestinationCommand.name:
        return {
          KinesisDataStreamDestinations: (live.kinesis ?? []).map((s) => ({
            StreamArn: s,
            DestinationStatus: 'ACTIVE',
          })),
        };
      case GetResourcePolicyCommand.name: {
        const has =
          command.input['ResourceArn'] === stream ? live.streamPolicy : live.tablePolicy;
        if (has) return { Policy: '{}' };
        throw new PolicyNotFoundException({ message: 'no policy', $metadata: {} });
      }
      default:
        if (name === UpdateTableCommand.name) {
          const dropped = command.input['ReplicaUpdates']?.[0]?.Delete?.RegionName;
          if (dropped !== undefined && replicas !== undefined) {
            replicas = replicas.filter((r) => r !== dropped);
          }
          return {};
        }
        if (WRITES.includes(name)) return {};
        return {
          Table: {
            TableName: TABLE,
            TableArn: arn,
            TableStatus: 'ACTIVE',
            LatestStreamArn: stream,
            StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' },
            ...(replicas !== undefined && {
              Replicas: replicas.map((r) => ({ RegionName: r, ReplicaStatus: 'ACTIVE' })),
            }),
          },
        };
    }
  };
};

const setLive = (
  local: Live = {},
  remote: Live = {},
  opts: {
    replicas?: string[];
    refuseLocal?: (name: string, input: Record<string, any>) => Error | undefined;
    refuseRemote?: (name: string, input: Record<string, any>) => Error | undefined;
  } = {}
): void => {
  mockSend.mockImplementation(
    regionDouble(LOCAL_ARN, LOCAL_STREAM, local, opts.replicas ?? ['eu-west-1'], opts.refuseLocal)
  );
  regionalSend.mockImplementation(
    regionDouble(REMOTE_ARN, REMOTE_STREAM, remote, undefined, opts.refuseRemote)
  );
};

describe('replica setting readers and plans (go-to-k/cdkd#5365)', () => {
  it('reads a PITR block, refusing a non-boolean flag and an out-of-range period', () => {
    expect(readPitrSpec({ PointInTimeRecoveryEnabled: 'true', RecoveryPeriodInDays: '7' })).toEqual({
      kind: 'usable',
      enabled: true,
      recoveryPeriodInDays: 7,
    });
    expect(readPitrSpec({ PointInTimeRecoveryEnabled: 'yes' }).kind).toBe('unusable');
    expect(
      readPitrSpec({ PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 36 }).kind
    ).toBe('unusable');
    // The period is not sent alongside `false` (AWS refuses it).
    expect(
      readPitrSpec({ PointInTimeRecoveryEnabled: false, RecoveryPeriodInDays: 7 })
    ).toEqual({ kind: 'usable', enabled: false });
  });

  it('reads a Kinesis block, refusing one without a StreamArn', () => {
    expect(readKinesisSpec({ StreamArn: REMOTE_KS })).toEqual({
      kind: 'usable',
      streamArn: REMOTE_KS,
    });
    expect(readKinesisSpec({}).kind).toBe('unusable');
    expect(readKinesisSpec({ StreamArn: '' }).kind).toBe('unusable');
  });

  it('lists every unreadable block of a replica, by member path', () => {
    expect(
      replicaSettingRefusals({
        PointInTimeRecoverySpecification: 'on',
        ContributorInsightsSpecification: { Enabled: 'maybe' },
        KinesisStreamSpecification: {},
        ResourcePolicy: {},
        ReplicaStreamSpecification: { ResourcePolicy: { PolicyDocument: '  ' } },
      })
    ).toEqual([
      expect.stringContaining('Replicas[].PointInTimeRecoverySpecification'),
      expect.stringContaining('Replicas[].ContributorInsightsSpecification.Enabled'),
      expect.stringContaining('Replicas[].KinesisStreamSpecification.StreamArn'),
      expect.stringContaining('Replicas[].ResourcePolicy.PolicyDocument'),
      expect.stringContaining('Replicas[].ReplicaStreamSpecification.ResourcePolicy.PolicyDocument'),
    ]);
  });

  it('plans every declared setting for a fresh replica, and nothing that turns one off', () => {
    const ops = planReplicaSettingOps(allSettings(REMOTE_KS), undefined, { fresh: true }, () => {});
    expect(ops.map((o) => o.kind)).toEqual([
      'pitr',
      'contributorInsights',
      'kinesisEnable',
      'putTablePolicy',
      'putStreamPolicy',
    ]);
    expect(
      planReplicaSettingOps(
        {
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
          ContributorInsightsSpecification: { Enabled: false },
        },
        undefined,
        { fresh: true },
        () => {}
      )
    ).toEqual([]);
  });

  it('resets every removed setting the way CloudFormation does', () => {
    expect(planReplicaSettingOps({}, allSettings(REMOTE_KS), { fresh: false }, () => {})).toEqual([
      { kind: 'pitr', enabled: false },
      { kind: 'contributorInsights', action: 'DISABLE' },
      { kind: 'kinesisDisable', streamArn: REMOTE_KS },
      { kind: 'deleteTablePolicy' },
      { kind: 'deleteStreamPolicy' },
    ]);
  });

  it('plans nothing for an unchanged replica', () => {
    expect(
      planReplicaSettingOps(allSettings(REMOTE_KS), allSettings(REMOTE_KS), { fresh: false }, () => {})
    ).toEqual([]);
  });

  it('moves streaming to a new Kinesis stream, and updates a precision-only change in place', () => {
    expect(
      planReplicaSettingOps(
        { KinesisStreamSpecification: { StreamArn: REMOTE_KS2 } },
        { KinesisStreamSpecification: { StreamArn: REMOTE_KS } },
        { fresh: false },
        () => {}
      )
    ).toEqual([
      { kind: 'kinesisDisable', streamArn: REMOTE_KS },
      { kind: 'kinesisEnable', streamArn: REMOTE_KS2 },
    ]);
    expect(
      planReplicaSettingOps(
        {
          KinesisStreamSpecification: {
            StreamArn: REMOTE_KS,
            ApproximateCreationDateTimePrecision: 'MICROSECOND',
          },
        },
        { KinesisStreamSpecification: { StreamArn: REMOTE_KS } },
        { fresh: false },
        () => {}
      )
    ).toEqual([{ kind: 'kinesisPrecision', streamArn: REMOTE_KS, precision: 'MICROSECOND' }]);
  });

  it('puts an unchanged stream policy on a replaced stream, and still deletes a removed one', () => {
    const settings = allSettings(REMOTE_KS);
    expect(
      planReplicaSettingOps(settings, settings, { fresh: false, streamReplaced: true }, () => {})
    ).toEqual([{ kind: 'putStreamPolicy', document: JSON.stringify(policy('dynamodb:GetRecords')) }]);
    expect(
      planReplicaSettingOps({}, { ReplicaStreamSpecification: settings['ReplicaStreamSpecification'] }, {
        fresh: false,
        streamReplaced: true,
      }, () => {})
    ).toEqual([{ kind: 'deleteStreamPolicy' }]);
  });

  it('leaves an unreadable desired block alone and reports it', () => {
    const reasons: string[] = [];
    expect(
      planReplicaSettingOps(
        { PointInTimeRecoverySpecification: 'on', ResourcePolicy: {} },
        allSettings(REMOTE_KS),
        { fresh: false },
        (reason) => reasons.push(reason)
      ).map((o) => o.kind)
    ).toEqual(['contributorInsights', 'kinesisDisable', 'deleteStreamPolicy']);
    expect(reasons).toHaveLength(2);
  });

  it('corrects only a declared setting AWS reports differently', () => {
    const desired = allSettings(REMOTE_KS);
    expect(
      planReplicaSettingCorrections(
        desired,
        {
          pitr: { enabled: true, recoveryPeriodInDays: 10 },
          contributorInsightsEnabled: true,
          kinesisStreamArns: new Set([REMOTE_KS]),
          hasTablePolicy: true,
          hasStreamPolicy: true,
        },
        ALL
      )
    ).toEqual([]);
    expect(
      planReplicaSettingCorrections(
        desired,
        {
          pitr: { enabled: false },
          contributorInsightsEnabled: false,
          kinesisStreamArns: new Set(),
          hasTablePolicy: false,
          hasStreamPolicy: false,
        },
        ALL
      ).map((o) => o.kind)
    ).toEqual(['pitr', 'contributorInsights', 'kinesisEnable', 'putTablePolicy', 'putStreamPolicy']);
    // An unknown live answer is never corrected, nor a setting not asked about.
    expect(planReplicaSettingCorrections(desired, {}, ALL)).toEqual([]);
    expect(
      planReplicaSettingCorrections(desired, { contributorInsightsEnabled: false }, new Set(['pitr']))
    ).toEqual([]);
  });
});

describe('replicaSettingsRefusal (go-to-k/cdkd#5365)', () => {
  it('refuses a table policy on any replica of a create with a cross-region replica', () => {
    const local = { ResourcePolicy: { PolicyDocument: policy('dynamodb:GetItem') } };
    expect(replicaSettingsRefusal(base(local, {}), undefined, 'us-east-1')).toMatch(
      /us-east-1 replica: Replicas\[\]\.ResourcePolicy cannot be set in the deploy that creates/
    );
    // A single-region create takes it (measured: CloudFormation does too).
    expect(replicaSettingsRefusal(base(local, null), undefined, 'us-east-1')).toBeUndefined();
    // A stream policy is accepted on a create (measured).
    expect(
      replicaSettingsRefusal(
        base({ ReplicaStreamSpecification: allSettings(LOCAL_KS)['ReplicaStreamSpecification'] }, {}),
        undefined,
        'us-east-1'
      )
    ).toBeUndefined();
  });

  it("refuses an added replica's table policy, but not a kept one's", () => {
    const remote = { ResourcePolicy: { PolicyDocument: policy('dynamodb:GetItem') } };
    expect(replicaSettingsRefusal(base({}, remote), base({}, null))).toMatch(/eu-west-1 replica/);
    expect(replicaSettingsRefusal(base({}, remote), base({}, {}))).toBeUndefined();
  });

  it('refuses an unreadable block only on a replica whose blocks changed', () => {
    const bad = { PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: 'yes' } };
    expect(replicaSettingsRefusal(base({}, bad), base({}, {}))).toMatch(
      /eu-west-1 replica: Replicas\[\]\.PointInTimeRecoverySpecification\.PointInTimeRecoveryEnabled/
    );
    expect(replicaSettingsRefusal(base({}, bad), base({}, bad))).toBeUndefined();
  });
});

describe('DynamoDB GlobalTable replica settings writes (go-to-k/cdkd#5365)', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    regionalSend.mockReset();
    mockAutoScalingSend.mockReset();
    warnSpy.mockReset();
    vi.restoreAllMocks();
    setLive();
    mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
    provider = new DynamoDBGlobalTableProvider();
  });

  describe('create', () => {
    it('sends every setting to each replica through its own region', async () => {
      await provider.create(
        'T',
        RESOURCE_TYPE,
        base(allSettings(LOCAL_KS, false), allSettings(REMOTE_KS, false))
      );

      const expected = (ks: string, stream: string): Array<[string, Record<string, any>]> => [
        [
          UpdateContinuousBackupsCommand.name,
          {
            TableName: TABLE,
            PointInTimeRecoverySpecification: {
              PointInTimeRecoveryEnabled: true,
              RecoveryPeriodInDays: 10,
            },
          },
        ],
        [
          UpdateContributorInsightsCommand.name,
          { TableName: TABLE, ContributorInsightsAction: 'ENABLE' },
        ],
        [
          EnableKinesisStreamingDestinationCommand.name,
          {
            TableName: TABLE,
            StreamArn: ks,
            EnableKinesisStreamingConfiguration: { ApproximateCreationDateTimePrecision: 'MILLISECOND' },
          },
        ],
        [
          PutResourcePolicyCommand.name,
          { ResourceArn: stream, Policy: JSON.stringify(policy('dynamodb:GetRecords')) },
        ],
      ];
      expect(writes(mockSend)).toEqual(expected(LOCAL_KS, LOCAL_STREAM));
      expect(writes(regionalSend)).toEqual(expected(REMOTE_KS, REMOTE_STREAM));
    });

    it("puts a single-region table's resource policy on its table arn", async () => {
      setLive({}, {}, { replicas: [] });
      await provider.create(
        'T',
        RESOURCE_TYPE,
        base({ ResourcePolicy: { PolicyDocument: policy('dynamodb:GetItem') } }, null)
      );

      expect(sent(mockSend, PutResourcePolicyCommand)).toEqual([
        { ResourceArn: LOCAL_ARN, Policy: JSON.stringify(policy('dynamodb:GetItem')) },
      ]);
    });

    it('refuses a table policy on a multi-region create before CreateTable', async () => {
      await expect(
        provider.create(
          'T',
          RESOURCE_TYPE,
          base({ ResourcePolicy: { PolicyDocument: policy('dynamodb:GetItem') } }, {})
        )
      ).rejects.toThrow(/cannot be set in the deploy that creates the replica/);
      expect(sent(mockSend, CreateTableCommand)).toEqual([]);
    });

    it('refuses an unreadable block before CreateTable', async () => {
      await expect(
        provider.create(
          'T',
          RESOURCE_TYPE,
          base({}, { ContributorInsightsSpecification: { Enabled: 'maybe' } })
        )
      ).rejects.toThrow(/eu-west-1 replica: Replicas\[\]\.ContributorInsightsSpecification\.Enabled/);
      expect(sent(mockSend, CreateTableCommand)).toEqual([]);
    });

    it('fails the create (and cleans up) when a setting write is refused', async () => {
      setLive({}, {}, {
        refuseRemote: (name) =>
          name === UpdateContinuousBackupsCommand.name ? new Error('access denied') : undefined,
      });
      await expect(
        provider.create('T', RESOURCE_TYPE, base({}, allSettings(REMOTE_KS, false)))
      ).rejects.toThrow(/access denied/);
      expect(
        sent(mockSend, UpdateTableCommand).some((i) => i['ReplicaUpdates']?.[0]?.Delete)
      ).toBe(true);
    });
  });

  describe('update', () => {
    it('resets every setting the template removed, in its own region', async () => {
      setLive(
        {},
        { pitr: 'ENABLED', ci: 'ENABLED', kinesis: [REMOTE_KS], tablePolicy: true, streamPolicy: true }
      );
      await provider.update('T', TABLE, RESOURCE_TYPE, base({}, {}), base({}, allSettings(REMOTE_KS)));

      expect(writes(regionalSend)).toEqual([
        [
          UpdateContinuousBackupsCommand.name,
          { TableName: TABLE, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false } },
        ],
        [
          UpdateContributorInsightsCommand.name,
          { TableName: TABLE, ContributorInsightsAction: 'DISABLE' },
        ],
        [DisableKinesisStreamingDestinationCommand.name, { TableName: TABLE, StreamArn: REMOTE_KS }],
        [DeleteResourcePolicyCommand.name, { ResourceArn: REMOTE_ARN }],
        [DeleteResourcePolicyCommand.name, { ResourceArn: REMOTE_STREAM }],
      ]);
      expect(writes(mockSend)).toEqual([]);
    });

    it('sends the local table its settings through the source client', async () => {
      await provider.update(
        'T',
        TABLE,
        RESOURCE_TYPE,
        base({ ContributorInsightsSpecification: { Enabled: true } }, {}),
        base({}, {})
      );

      expect(writes(mockSend)).toEqual([
        [
          UpdateContributorInsightsCommand.name,
          { TableName: TABLE, ContributorInsightsAction: 'ENABLE' },
        ],
      ]);
      expect(writes(regionalSend)).toEqual([]);
    });

    it('refuses an added replica with a table policy before any write', async () => {
      await expect(
        provider.update(
          'T',
          TABLE,
          RESOURCE_TYPE,
          base({}, { ResourcePolicy: { PolicyDocument: policy('dynamodb:GetItem') } }),
          base({}, null)
        )
      ).rejects.toThrow(/eu-west-1 replica: Replicas\[\]\.ResourcePolicy cannot be set/);
      expect(sent(mockSend, UpdateTableCommand)).toEqual([]);
    });

    it('brings a declared setting the template did not change to the declared value', async () => {
      // Deployed before go-to-k/cdkd#5365: the record names the settings, AWS holds none.
      await provider.update(
        'T',
        TABLE,
        RESOURCE_TYPE,
        { ...base({}, allSettings(REMOTE_KS)), Tags: 'drive-an-update' },
        base({}, allSettings(REMOTE_KS))
      );

      expect(writes(regionalSend).map(([name]) => name)).toEqual([
        UpdateContinuousBackupsCommand.name,
        UpdateContributorInsightsCommand.name,
        EnableKinesisStreamingDestinationCommand.name,
        PutResourcePolicyCommand.name,
        PutResourcePolicyCommand.name,
      ]);
    });

    it('writes nothing when AWS already holds every declared setting', async () => {
      setLive(
        {},
        {
          pitr: 'ENABLED',
          period: 10,
          ci: 'ENABLED',
          kinesis: [REMOTE_KS],
          tablePolicy: true,
          streamPolicy: true,
        }
      );
      await provider.update(
        'T',
        TABLE,
        RESOURCE_TYPE,
        base({}, allSettings(REMOTE_KS)),
        base({}, allSettings(REMOTE_KS))
      );

      expect(writes(regionalSend)).toEqual([]);
    });

    it('reports a refused correction instead of failing the update', async () => {
      setLive({}, {}, {
        refuseRemote: (name) =>
          name === UpdateContinuousBackupsCommand.name ? new Error('access denied') : undefined,
      });
      await provider.update(
        'T',
        TABLE,
        RESOURCE_TYPE,
        base({}, { PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } }),
        base({}, { PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } })
      );

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /eu-west-1 replica of gt-5365 does not hold its declared PointInTimeRecoverySpecification/
        )
      );
    });

    it('fails the update when a template-side change is refused', async () => {
      setLive({}, {}, {
        refuseRemote: (name) =>
          name === UpdateContinuousBackupsCommand.name ? new Error('access denied') : undefined,
      });
      await expect(
        provider.update(
          'T',
          TABLE,
          RESOURCE_TYPE,
          base({}, { PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } }),
          base({}, {})
        )
      ).rejects.toThrow(/access denied/);
    });

    it('takes a refused Kinesis enable whose destination is already streaming', async () => {
      // The enable lands but its answer is lost: AWS streams there afterwards.
      const remote: { kinesis: string[] } = { kinesis: [] };
      setLive({}, remote, {
        refuseRemote: (name) => {
          if (name !== EnableKinesisStreamingDestinationCommand.name) return undefined;
          remote.kinesis.push(REMOTE_KS);
          return Object.assign(new Error('already enabled'), { name: 'ValidationException' });
        },
      });
      await provider.update(
        'T',
        TABLE,
        RESOURCE_TYPE,
        base({}, { KinesisStreamSpecification: { StreamArn: REMOTE_KS } }),
        base({}, {})
      );

      expect(sent(regionalSend, EnableKinesisStreamingDestinationCommand)).toHaveLength(1);
    });

    it('updates a precision-only Kinesis change in place', async () => {
      await provider.update(
        'T',
        TABLE,
        RESOURCE_TYPE,
        base(
          {},
          {
            KinesisStreamSpecification: {
              StreamArn: REMOTE_KS,
              ApproximateCreationDateTimePrecision: 'MICROSECOND',
            },
          }
        ),
        base({}, { KinesisStreamSpecification: { StreamArn: REMOTE_KS } })
      );

      expect(sent(regionalSend, UpdateKinesisStreamingDestinationCommand)).toEqual([
        {
          TableName: TABLE,
          StreamArn: REMOTE_KS,
          UpdateKinesisStreamingConfiguration: { ApproximateCreationDateTimePrecision: 'MICROSECOND' },
        },
      ]);
    });

    it('retries a write refused while an earlier change settles', async () => {
      vi.useFakeTimers();
      try {
        let refusals = 0;
        setLive({}, {}, {
          refuseRemote: (name) =>
            name === UpdateContributorInsightsCommand.name && refusals++ === 0
              ? Object.assign(new Error('table is being updated'), {
                  name: 'ResourceInUseException',
                })
              : undefined,
        });
        const run = provider.update(
          'T',
          TABLE,
          RESOURCE_TYPE,
          base({}, { ContributorInsightsSpecification: { Enabled: true } }),
          base({}, {})
        );
        await vi.runAllTimersAsync();
        await run;
        expect(sent(regionalSend, UpdateContributorInsightsCommand)).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('fix round (PR review)', () => {
    const refuseWith =
      (target: string, error: () => Error) =>
      (name: string): Error | undefined =>
        name === target ? error() : undefined;

    it('takes a refused Kinesis disable whose destination is already off', async () => {
      setLive({}, { kinesis: [] }, {
        refuseRemote: refuseWith(DisableKinesisStreamingDestinationCommand.name, () =>
          Object.assign(new Error('not enabled'), { name: 'ValidationException' })
        ),
      });
      await provider.update(
        'T',
        TABLE,
        RESOURCE_TYPE,
        base({}, {}),
        base({}, { KinesisStreamSpecification: { StreamArn: REMOTE_KS } })
      );
      expect(sent(regionalSend, DisableKinesisStreamingDestinationCommand)).toHaveLength(1);
    });

    it('fails on a refused Kinesis disable whose destination still streams', async () => {
      setLive({}, { kinesis: [REMOTE_KS] }, {
        refuseRemote: refuseWith(DisableKinesisStreamingDestinationCommand.name, () =>
          Object.assign(new Error('access denied'), { name: 'AccessDeniedException' })
        ),
      });
      await expect(
        provider.update(
          'T',
          TABLE,
          RESOURCE_TYPE,
          base({}, {}),
          base({}, { KinesisStreamSpecification: { StreamArn: REMOTE_KS } })
        )
      ).rejects.toThrow(/access denied/);
    });

    it('fails on a refused Kinesis enable whose destination is not streaming', async () => {
      setLive({}, { kinesis: [] }, {
        refuseRemote: refuseWith(EnableKinesisStreamingDestinationCommand.name, () =>
          Object.assign(new Error('access denied'), { name: 'AccessDeniedException' })
        ),
      });
      await expect(
        provider.update(
          'T',
          TABLE,
          RESOURCE_TYPE,
          base({}, { KinesisStreamSpecification: { StreamArn: REMOTE_KS } }),
          base({}, {})
        )
      ).rejects.toThrow(/access denied/);
    });

    it('sends no enable when the destination already streams', async () => {
      setLive({}, { kinesis: [REMOTE_KS] });
      await provider.update(
        'T',
        TABLE,
        RESOURCE_TYPE,
        base({}, { KinesisStreamSpecification: { StreamArn: REMOTE_KS } }),
        base({}, {})
      );
      expect(sent(regionalSend, EnableKinesisStreamingDestinationCommand)).toEqual([]);
    });

    it('takes a policy delete that finds no policy', async () => {
      setLive({}, {}, {
        refuseRemote: refuseWith(
          DeleteResourcePolicyCommand.name,
          () => new PolicyNotFoundException({ message: 'no policy', $metadata: {} })
        ),
      });
      await provider.update(
        'T',
        TABLE,
        RESOURCE_TYPE,
        base({}, {}),
        base({}, { ResourcePolicy: { PolicyDocument: policy('dynamodb:GetItem') } })
      );
      expect(sent(regionalSend, DeleteResourcePolicyCommand)).toEqual([{ ResourceArn: REMOTE_ARN }]);
    });

    it('does not put a policy whose live read failed for another reason', async () => {
      setLive({}, {}, {
        refuseRemote: refuseWith(GetResourcePolicyCommand.name, () =>
          Object.assign(new Error('denied'), { name: 'AccessDeniedException' })
        ),
      });
      const props = base({}, { ResourcePolicy: { PolicyDocument: policy('dynamodb:GetItem') } });
      await provider.update('T', TABLE, RESOURCE_TYPE, props, props);
      expect(sent(regionalSend, PutResourcePolicyCommand)).toEqual([]);
    });

    it('re-puts an unchanged stream policy after a StreamViewType change', async () => {
      const stream = { ResourcePolicy: { PolicyDocument: policy('dynamodb:GetRecords') } };
      // AWS reports a stream policy, so only the StreamViewType change can put one.
      setLive({ streamPolicy: true }, {}, { replicas: [] });
      await provider.update(
        'T',
        TABLE,
        RESOURCE_TYPE,
        {
          ...base({ ReplicaStreamSpecification: stream }, null),
          StreamSpecification: { StreamViewType: 'NEW_IMAGE' },
        },
        base({ ReplicaStreamSpecification: stream }, null)
      );
      expect(sent(mockSend, PutResourcePolicyCommand)).toEqual([
        { ResourceArn: LOCAL_STREAM, Policy: JSON.stringify(policy('dynamodb:GetRecords')) },
      ]);
    });

    it('puts no stream policy when the StreamViewType held still and AWS holds one', async () => {
      const stream = { ResourcePolicy: { PolicyDocument: policy('dynamodb:GetRecords') } };
      setLive({ streamPolicy: true }, {}, { replicas: [] });
      const props = base({ ReplicaStreamSpecification: stream }, null);
      await provider.update('T', TABLE, RESOURCE_TYPE, props, props);
      expect(sent(mockSend, PutResourcePolicyCommand)).toEqual([]);
    });

    it('still enables Kinesis when the pre-check read fails', async () => {
      setLive({}, {}, {
        refuseRemote: refuseWith(DescribeKinesisStreamingDestinationCommand.name, () =>
          Object.assign(new Error('denied'), { name: 'AccessDeniedException' })
        ),
      });
      await provider.update(
        'T',
        TABLE,
        RESOURCE_TYPE,
        base({}, { KinesisStreamSpecification: { StreamArn: REMOTE_KS } }),
        base({}, {})
      );
      expect(sent(regionalSend, EnableKinesisStreamingDestinationCommand)).toHaveLength(1);
    });

    it('leaves point-in-time recovery that is still ENABLING alone', async () => {
      setLive({}, { pitr: 'ENABLING' as never });
      const props = base({}, { PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } });
      await provider.update('T', TABLE, RESOURCE_TYPE, props, props);
      expect(sent(regionalSend, UpdateContinuousBackupsCommand)).toEqual([]);
    });

    it('fails a stream policy put on a table with no stream', async () => {
      mockSend.mockImplementation(async (command: Sent) =>
        command.constructor.name === 'DescribeTableCommand'
          ? { Table: { TableName: TABLE, TableArn: LOCAL_ARN, TableStatus: 'ACTIVE' } }
          : {}
      );
      await expect(
        provider.update(
          'T',
          TABLE,
          RESOURCE_TYPE,
          base(
            { ReplicaStreamSpecification: { ResourcePolicy: { PolicyDocument: policy('x:Y') } } },
            null
          ),
          base({}, null)
        )
      ).rejects.toThrow(/no LatestStreamArn/);
    });

    it('sends an added replica its settings as a fresh one (no disables)', async () => {
      await provider.update(
        'T',
        TABLE,
        RESOURCE_TYPE,
        base(
          {},
          {
            PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
            ContributorInsightsSpecification: { Enabled: false },
          }
        ),
        base({}, null)
      );
      expect(writes(regionalSend)).toEqual([
        [
          UpdateContinuousBackupsCommand.name,
          { TableName: TABLE, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } },
        ],
      ]);
    });

    it('warns and continues when a replay cannot put a fresh replica table policy', async () => {
      setLive({}, {}, {
        refuseRemote: refuseWith(PutResourcePolicyCommand.name, () => new Error('replica is new')),
      });
      await provider.create(
        'T',
        RESOURCE_TYPE,
        base({}, { ResourcePolicy: { PolicyDocument: policy('dynamodb:GetItem') } }),
        { replayingState: true } as never
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/eu-west-1 replica of gt-5365 was created without its ResourcePolicy/)
      );
    });

    it('never turns point-in-time recovery off as a correction, nor on drift --revert', async () => {
      setLive({}, { pitr: 'ENABLED', period: 35 });
      const off = base({}, { PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false } });
      await provider.update('T', TABLE, RESOURCE_TYPE, off, off);
      const shorter = base({}, {
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 7 },
      });
      await provider.update('T', TABLE, RESOURCE_TYPE, shorter, shorter);
      await provider.update(
        'T',
        TABLE,
        RESOURCE_TYPE,
        base({}, {}),
        base({}, { PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } }),
        { desiredFromAwsReadback: true } as never
      );
      expect(sent(regionalSend, UpdateContinuousBackupsCommand)).toEqual([]);
    });
  });

  describe('plan edges (PR review)', () => {
    it('treats a JSON-string policy equal to the declared object as unchanged', () => {
      const doc = policy('dynamodb:GetItem');
      expect(
        planReplicaSettingOps(
          { ResourcePolicy: { PolicyDocument: doc } },
          { ResourcePolicy: { PolicyDocument: JSON.stringify(doc, null, 2) } },
          { fresh: false },
          () => {}
        )
      ).toEqual([]);
    });

    it('refuses an unresolved intrinsic policy document', () => {
      expect(replicaSettingRefusals({ ResourcePolicy: { PolicyDocument: { Ref: 'X' } } })).toEqual([
        expect.stringContaining('unresolved intrinsic'),
      ]);
    });

    it('sends a recovery-period-only change', () => {
      expect(
        planReplicaSettingOps(
          { PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 10 } },
          { PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 7 } },
          { fresh: false },
          () => {}
        )
      ).toEqual([{ kind: 'pitr', enabled: true, recoveryPeriodInDays: 10 }]);
    });
  });

  describe('parent review round', () => {
    const withAll = base(
      {},
      {
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        ContributorInsightsSpecification: { Enabled: true },
        KinesisStreamSpecification: { StreamArn: REMOTE_KS },
        ResourcePolicy: { PolicyDocument: policy('dynamodb:GetItem') },
        ReplicaStreamSpecification: { ResourcePolicy: { PolicyDocument: policy('dynamodb:GetRecords') } },
      }
    );

    it('removes nothing on drift --revert for a member the read-back omitted', async () => {
      setLive({}, { pitr: 'ENABLED', ci: 'ENABLED', kinesis: [REMOTE_KS], tablePolicy: true, streamPolicy: true });
      await provider.update('T', TABLE, RESOURCE_TYPE, base({}, {}), withAll, {
        desiredFromAwsReadback: true,
      } as never);
      expect(writes(regionalSend)).toEqual([]);
    });

    it('still applies an explicit disable the drift --revert read-back carries', async () => {
      setLive({}, { ci: 'ENABLED' });
      await provider.update(
        'T',
        TABLE,
        RESOURCE_TYPE,
        base({}, { ContributorInsightsSpecification: { Enabled: false } }),
        base({}, { ContributorInsightsSpecification: { Enabled: true } }),
        { desiredFromAwsReadback: true } as never
      );
      expect(sent(regionalSend, UpdateContributorInsightsCommand)).toEqual([
        { TableName: TABLE, ContributorInsightsAction: 'DISABLE' },
      ]);
    });

    it('never turns point-in-time recovery off on a rollback replay, but resets the rest', async () => {
      setLive({}, { pitr: 'ENABLED', ci: 'ENABLED' });
      await provider.update(
        'T',
        TABLE,
        RESOURCE_TYPE,
        base({}, {}),
        base(
          {},
          {
            PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
            ContributorInsightsSpecification: { Enabled: true },
          }
        ),
        { replayingState: true } as never
      );
      expect(sent(regionalSend, UpdateContinuousBackupsCommand)).toEqual([]);
      expect(sent(regionalSend, UpdateContributorInsightsCommand)).toEqual([
        { TableName: TABLE, ContributorInsightsAction: 'DISABLE' },
      ]);
    });

    it('deletes a removed stream policy from the stream a StreamViewType change retired', async () => {
      const NEW_STREAM = `${LOCAL_ARN}/stream/2026-10-28T00:00:00.000`;
      let current = LOCAL_STREAM;
      mockSend.mockImplementation(async (command: Sent) => {
        if (
          command.constructor.name === UpdateTableCommand.name &&
          command.input['StreamSpecification'] !== undefined
        ) {
          current = NEW_STREAM;
        }
        if (command.constructor.name === DeleteResourcePolicyCommand.name && command.input['ResourceArn'] === NEW_STREAM) {
          throw new PolicyNotFoundException({ message: 'no policy', $metadata: {} });
        }
        return regionDouble(LOCAL_ARN, current, {}, [])(command);
      });
      const stream = { ResourcePolicy: { PolicyDocument: policy('dynamodb:GetRecords') } };
      await provider.update(
        'T',
        TABLE,
        RESOURCE_TYPE,
        { ...base({}, null), StreamSpecification: { StreamViewType: 'NEW_IMAGE' } },
        base({ ReplicaStreamSpecification: stream }, null)
      );
      expect(sent(mockSend, DeleteResourcePolicyCommand).map((i) => i['ResourceArn'])).toEqual([
        NEW_STREAM,
        LOCAL_STREAM,
      ]);
    });

    it('names the whole table in the create-time refusal', () => {
      expect(
        replicaSettingsRefusal(
          base({ ResourcePolicy: { PolicyDocument: policy('dynamodb:GetItem') } }, {}),
          undefined,
          'us-east-1'
        )
      ).toMatch(/Deploy the table and its replicas without it, then add the policy/);
    });
  });
});
