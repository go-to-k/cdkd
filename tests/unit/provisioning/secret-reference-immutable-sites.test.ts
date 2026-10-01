/**
 * go-to-k/cdkd#4275 (and #4264): every provider immutable-name guard that
 * compared the resolved desired value with the recorded `{{resolve:...}}`
 * reference, driven through the provider's real `update()`.
 *
 * The deploy engine hands `update()` the RESOLVED plaintext as the desired side
 * and the state record (which keeps a secret leaf as its reference) as the
 * previous side, so before the fix every in-place update of such a resource
 * was refused although the template never changed the name.
 *
 * Each site is driven four ways:
 *  - UNCHANGED: the reference resolves to the name the resource already has.
 *    The guard must let the update through, which the fake AWS proves by being
 *    reached: its FIRST post-guard call rejects with a sentinel, so a passing
 *    guard surfaces the sentinel and a refusing one surfaces its own message.
 *  - RENAMED: the desired value differs from the resource's name (a real
 *    rename, or a secret rotated under an unchanged reference where the
 *    physical id carries the name). Still refused.
 *  - PLAIN: an ordinary recorded value that differs. Still refused (the
 *    exemption needs a secret-derived previous side).
 *  - MASK (`***`) where the physical id does not carry the name, and NO
 *    MASKER: both still refused.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, mockRegion, debugSpy, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockRegion: vi.fn(),
  debugSpy: vi.fn(),
  warnSpy: vi.fn(),
}));

function sdkClientMock(clientName: string) {
  return async (importOriginal: () => Promise<unknown>) => {
    const orig = (await importOriginal()) as Record<string, unknown>;
    return {
      ...orig,
      [clientName]: vi.fn().mockImplementation(() => ({
        send: mockSend,
        config: { region: () => Promise.resolve('us-east-1') },
      })),
    };
  };
}

vi.mock('@aws-sdk/client-apigatewayv2', sdkClientMock('ApiGatewayV2Client'));
vi.mock('@aws-sdk/client-emr', sdkClientMock('EMRClient'));
vi.mock('@aws-sdk/client-rds', sdkClientMock('RDSClient'));
vi.mock('@aws-sdk/client-s3vectors', sdkClientMock('S3VectorsClient'));
vi.mock('@aws-sdk/client-scheduler', sdkClientMock('SchedulerClient'));
vi.mock('@aws-sdk/client-kinesis', sdkClientMock('KinesisClient'));
vi.mock('@aws-sdk/client-ecs', sdkClientMock('ECSClient'));
// The GlobalTable provider's per-region replica clients.
vi.mock('@aws-sdk/client-dynamodb', sdkClientMock('DynamoDBClient'));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: mockRegion } },
  }),
}));

// The masker arm's create-only gate reads the engine's lookup; answered from
// the committed snapshot so no case reaches DescribeType.
vi.mock('../../../src/provisioning/create-only-properties.js', async () => {
  const { CREATE_ONLY_PATHS_SNAPSHOT } = await import(
    '../../../src/provisioning/create-only-snapshot.generated.js'
  );
  return {
    getCreateOnlyPropertyPaths: async (type: string) => CREATE_ONLY_PATHS_SNAPSHOT.get(type) ?? [],
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const child = { debug: debugSpy, info: vi.fn(), warn: warnSpy, error: vi.fn(), child: vi.fn() };
  child.child = vi.fn().mockReturnValue(child);
  return { getLogger: () => child };
});

import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
import {
  hasRedactedCause,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import { ApiGatewayV2Provider } from '../../../src/provisioning/providers/apigatewayv2-provider.js';
import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { EMRClusterProvider } from '../../../src/provisioning/providers/emr-cluster-provider.js';
import { EMRInstanceFleetConfigProvider } from '../../../src/provisioning/providers/emr-instance-fleet-config-provider.js';
import { EMRInstanceGroupConfigProvider } from '../../../src/provisioning/providers/emr-instance-group-config-provider.js';
import { RDSDBProxyProvider } from '../../../src/provisioning/providers/rds-dbproxy-provider.js';
import { RDSDBProxyEndpointProvider } from '../../../src/provisioning/providers/rds-dbproxy-endpoint-provider.js';
import { RDSDBProxyTargetGroupProvider } from '../../../src/provisioning/providers/rds-dbproxy-targetgroup-provider.js';
import { S3VectorsProvider } from '../../../src/provisioning/providers/s3-vectors-provider.js';
import { SchedulerScheduleProvider } from '../../../src/provisioning/providers/scheduler-schedule-provider.js';
import { KinesisStreamConsumerProvider } from '../../../src/provisioning/providers/kinesis-streamconsumer-provider.js';
import { ECSProvider } from '../../../src/provisioning/providers/ecs-provider.js';
import { createSecretMasker, SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';
import type { ResourceProvider, UpdateContext } from '../../../src/types/resource.js';

/** What the secret resolves to this deploy, and what state recorded instead. */
const NAME = 'resolved-secret-name';
const REF = '{{resolve:secretsmanager:name-secret:SecretString:name}}';
const OTHER = 'some-other-name';

function bagOf(...values: string[]): RecordedSecretValues {
  return new Map(values.map((v) => [v, `{{resolve:secretsmanager:${v}}}`]));
}

/** The deploy's own masker: it knows every value this deploy resolved. */
const context: UpdateContext = { maskSecrets: createSecretMasker(bagOf(NAME, OTHER)) };

const SENTINEL = 'SENTINEL-first-post-guard-aws-call';

const commandName = (command: unknown): string =>
  (command as { constructor: { name: string } }).constructor.name;

/**
 * The fake AWS. `answers` names commands that SUCCEED (the pre-update reads a
 * site needs); every other command rejects with the sentinel.
 */
function fakeAws(answers: Record<string, (input: Record<string, unknown>) => unknown> = {}): void {
  mockSend.mockImplementation(async (command: { input: Record<string, unknown> }) => {
    const answer = answers[commandName(command)];
    if (answer) return answer(command.input);
    throw new Error(SENTINEL);
  });
}

interface Site {
  label: string;
  type: string;
  provider: () => ResourceProvider;
  /** The key under test. */
  key: string;
  /** The physical id when the resource's name is `NAME`. */
  physicalId: string;
  /** The rest of the bag: identical on both sides except for one mutable change. */
  desiredRest: Record<string, unknown>;
  previousRest: Record<string, unknown>;
  /** The substring the site's refusal carries. */
  refusal: string;
  /** Does the physical id carry the name (so a `***` previous is decidable)? */
  physicalCarriesName: boolean;
  /** Reads the site makes before its first write, answered successfully. */
  answers?: Record<string, (input: Record<string, unknown>) => unknown>;
}

const TG_ARN = 'arn:aws:rds:us-east-1:123456789012:target-group:prx-tg-0123456789abcdef';
/** The target group lookup the DBProxyTargetGroup confirmation makes, answered with `arn`. */
const targetGroupAt = (arn: string) => ({
  DescribeDBProxyTargetGroupsCommand: () => ({ TargetGroups: [{ TargetGroupArn: arn }] }),
});

const SUBNETS = ['subnet-1', 'subnet-2'];
const STREAM_ARN = 'arn:aws:kinesis:us-east-1:123456789012:stream/s1';

const SITES: Site[] = [
  {
    label: 'ApiGatewayV2 Stage StageName (go-to-k/cdkd#4264)',
    type: 'AWS::ApiGatewayV2::Stage',
    provider: () => new ApiGatewayV2Provider(),
    key: 'StageName',
    physicalId: NAME,
    desiredRest: { ApiId: 'api-1', Description: 'new' },
    previousRest: { ApiId: 'api-1', Description: 'old' },
    refusal: 'StageName is immutable',
    physicalCarriesName: true,
  },
  {
    label: 'DynamoDB GlobalTable TableName',
    type: 'AWS::DynamoDB::GlobalTable',
    provider: () => new DynamoDBGlobalTableProvider(),
    key: 'TableName',
    physicalId: NAME,
    desiredRest: {
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
      BillingMode: 'PAY_PER_REQUEST',
      Replicas: [{ Region: 'us-east-1' }],
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    },
    previousRest: {
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
      BillingMode: 'PAY_PER_REQUEST',
      Replicas: [{ Region: 'us-east-1' }],
    },
    refusal: 'TableName is immutable',
    physicalCarriesName: true,
  },
  {
    label: 'EMR Cluster Name',
    type: 'AWS::EMR::Cluster',
    provider: () => new EMRClusterProvider(),
    key: 'Name',
    physicalId: 'j-1ABCDEFGHIJK',
    desiredRest: { ReleaseLabel: 'emr-7.0.0', VisibleToAllUsers: false },
    previousRest: { ReleaseLabel: 'emr-7.0.0', VisibleToAllUsers: true },
    refusal: 'EMR Cluster Name is immutable',
    physicalCarriesName: false,
  },
  {
    label: 'EMR InstanceFleetConfig Name',
    type: 'AWS::EMR::InstanceFleetConfig',
    provider: () => new EMRInstanceFleetConfigProvider(),
    key: 'Name',
    physicalId: 'if-1ABCDEFGHIJK',
    desiredRest: { ClusterId: 'j-1', InstanceFleetType: 'TASK', TargetOnDemandCapacity: 2 },
    previousRest: { ClusterId: 'j-1', InstanceFleetType: 'TASK', TargetOnDemandCapacity: 1 },
    refusal: 'InstanceFleetConfig Name is immutable',
    physicalCarriesName: false,
  },
  {
    label: 'EMR InstanceGroupConfig Name',
    type: 'AWS::EMR::InstanceGroupConfig',
    provider: () => new EMRInstanceGroupConfigProvider(),
    key: 'Name',
    physicalId: 'ig-1ABCDEFGHIJK',
    desiredRest: {
      JobFlowId: 'j-1',
      InstanceRole: 'TASK',
      InstanceType: 'm5.xlarge',
      InstanceCount: 2,
    },
    previousRest: {
      JobFlowId: 'j-1',
      InstanceRole: 'TASK',
      InstanceType: 'm5.xlarge',
      InstanceCount: 1,
    },
    refusal: 'InstanceGroupConfig Name is immutable',
    physicalCarriesName: false,
  },
  {
    label: 'RDS DBProxy DBProxyName',
    type: 'AWS::RDS::DBProxy',
    provider: () => new RDSDBProxyProvider(),
    key: 'DBProxyName',
    physicalId: NAME,
    desiredRest: { EngineFamily: 'MYSQL', VpcSubnetIds: SUBNETS, RequireTLS: true },
    previousRest: { EngineFamily: 'MYSQL', VpcSubnetIds: SUBNETS, RequireTLS: false },
    refusal: 'DBProxyName is immutable',
    physicalCarriesName: true,
  },
  {
    label: 'RDS DBProxyEndpoint DBProxyEndpointName',
    type: 'AWS::RDS::DBProxyEndpoint',
    provider: () => new RDSDBProxyEndpointProvider(),
    key: 'DBProxyEndpointName',
    physicalId: NAME,
    desiredRest: { DBProxyName: 'proxy', VpcSubnetIds: SUBNETS, VpcSecurityGroupIds: ['sg-2'] },
    previousRest: { DBProxyName: 'proxy', VpcSubnetIds: SUBNETS, VpcSecurityGroupIds: ['sg-1'] },
    refusal: 'DBProxyEndpointName is immutable',
    physicalCarriesName: true,
  },
  {
    label: 'RDS DBProxyEndpoint DBProxyName (not in the physical id)',
    type: 'AWS::RDS::DBProxyEndpoint',
    provider: () => new RDSDBProxyEndpointProvider(),
    key: 'DBProxyName',
    physicalId: 'my-endpoint',
    desiredRest: {
      DBProxyEndpointName: 'my-endpoint',
      VpcSubnetIds: SUBNETS,
      VpcSecurityGroupIds: ['sg-2'],
    },
    previousRest: {
      DBProxyEndpointName: 'my-endpoint',
      VpcSubnetIds: SUBNETS,
      VpcSecurityGroupIds: ['sg-1'],
    },
    refusal: 'DBProxyName is immutable',
    physicalCarriesName: false,
  },
  {
    label: 'RDS DBProxyTargetGroup DBProxyName',
    type: 'AWS::RDS::DBProxyTargetGroup',
    provider: () => new RDSDBProxyTargetGroupProvider(),
    key: 'DBProxyName',
    physicalId: TG_ARN,
    desiredRest: {
      TargetGroupName: 'default',
      ConnectionPoolConfigurationInfo: { MaxConnectionsPercent: 50 },
    },
    previousRest: {
      TargetGroupName: 'default',
      ConnectionPoolConfigurationInfo: { MaxConnectionsPercent: 40 },
    },
    refusal: 'DBProxyName is immutable',
    physicalCarriesName: false,
    // Its writes are addressed by the desired names, so AWS confirms them first.
    answers: targetGroupAt(TG_ARN),
  },
  {
    label: 'S3Vectors VectorBucket VectorBucketName',
    type: 'AWS::S3Vectors::VectorBucket',
    provider: () => new S3VectorsProvider(),
    key: 'VectorBucketName',
    physicalId: NAME,
    desiredRest: { Tags: [{ Key: 'k', Value: '2' }] },
    previousRest: { Tags: [{ Key: 'k', Value: '1' }] },
    refusal: "'VectorBucketName' is immutable",
    physicalCarriesName: true,
  },
  {
    label: 'ECS Service ServiceName (go-to-k/cdkd#4263)',
    type: 'AWS::ECS::Service',
    provider: () => new ECSProvider(),
    key: 'ServiceName',
    physicalId: `arn:aws:ecs:us-east-1:123456789012:service/my-cluster/${NAME}`,
    desiredRest: { Cluster: 'my-cluster', DesiredCount: 2 },
    previousRest: { Cluster: 'my-cluster', DesiredCount: 1 },
    refusal: 'Cannot update ServiceName',
    physicalCarriesName: true,
  },
  {
    label: 'ECS Service ServiceName, legacy short-format ARN',
    type: 'AWS::ECS::Service',
    provider: () => new ECSProvider(),
    key: 'ServiceName',
    physicalId: `arn:aws:ecs:us-east-1:123456789012:service/${NAME}`,
    desiredRest: { Cluster: 'my-cluster', DesiredCount: 2 },
    previousRest: { Cluster: 'my-cluster', DesiredCount: 1 },
    refusal: 'Cannot update ServiceName',
    physicalCarriesName: true,
  },
  {
    label: 'ECS Service ServiceName, bare-name physical id (an import)',
    type: 'AWS::ECS::Service',
    provider: () => new ECSProvider(),
    key: 'ServiceName',
    physicalId: NAME,
    desiredRest: { Cluster: 'my-cluster', DesiredCount: 2 },
    previousRest: { Cluster: 'my-cluster', DesiredCount: 1 },
    refusal: 'Cannot update ServiceName',
    physicalCarriesName: true,
  },
  {
    label: 'ECS Service ServiceName, composite physical id',
    type: 'AWS::ECS::Service',
    provider: () => new ECSProvider(),
    key: 'ServiceName',
    physicalId: `arn:aws:ecs:us-east-1:123456789012:cluster/my-cluster|${NAME}`,
    desiredRest: { Cluster: 'my-cluster', DesiredCount: 2 },
    previousRest: { Cluster: 'my-cluster', DesiredCount: 1 },
    refusal: 'Cannot update ServiceName',
    physicalCarriesName: true,
  },
  {
    label: 'Kinesis StreamConsumer ConsumerName',
    type: 'AWS::Kinesis::StreamConsumer',
    provider: () => new KinesisStreamConsumerProvider(),
    key: 'ConsumerName',
    physicalId: `${STREAM_ARN}/consumer/${NAME}:1700000000`,
    desiredRest: { StreamARN: STREAM_ARN, Tags: [{ Key: 'k', Value: '2' }] },
    previousRest: { StreamARN: STREAM_ARN, Tags: [{ Key: 'k', Value: '1' }] },
    refusal: 'ConsumerName / StreamARN are immutable',
    physicalCarriesName: true,
  },
];

async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return 'resolved';
}

function run(
  site: Site,
  desired: unknown,
  previous: unknown,
  physicalId = site.physicalId,
  ctx: UpdateContext = context
): Promise<string> {
  return outcome(
    site.provider().update(
      'Resource',
      physicalId,
      site.type,
      { ...site.desiredRest, [site.key]: desired },
      { ...site.previousRest, [site.key]: previous },
      ctx
    )
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRegion.mockResolvedValue('us-east-1');
  fakeAws();
});

describe('a secret-derived immutable name (go-to-k/cdkd#4275)', () => {
  for (const site of SITES) {
    describe(site.label, () => {
      it('UNCHANGED: a recorded reference resolving to the current name lets the update through', async () => {
        fakeAws(site.answers);
        const result = await run(site, NAME, REF);
        expect(result).not.toContain(site.refusal);
        expect(result).toContain(SENTINEL);
        expect(mockSend).toHaveBeenCalled();
      });

      it('RENAMED: a desired value naming another resource is still refused', async () => {
        // Physical-id sites: the resource is still called NAME, the desired
        // side says OTHER (a rename, or a rotated secret). Masker sites: the
        // desired side is a literal the masker never resolved.
        const result = site.physicalCarriesName
          ? await run(site, OTHER, REF)
          : await run(site, 'a-literal-name', REF);
        expect(result).toContain(site.refusal);
        expect(result).not.toContain(SENTINEL);
      });

      it('PLAIN: an ordinary recorded value that differs is still refused', async () => {
        const result = await run(site, NAME, 'recorded-plain-name');
        expect(result).toContain(site.refusal);
        expect(result).not.toContain(SENTINEL);
      });

      if (site.physicalCarriesName) {
        it('a recorded *** is decided by the physical id', async () => {
          expect(await run(site, NAME, SECRET_MASK)).toContain(SENTINEL);
        });
      } else {
        it('a recorded *** is still refused: a mask says nothing about the value', async () => {
          fakeAws(site.answers);
          const result = await run(site, NAME, SECRET_MASK);
          expect(result).toContain(site.refusal);
          expect(result).not.toContain(SENTINEL);
        });

        it('no masker: the desired value cannot be shown secret-derived, so it is refused', async () => {
          fakeAws(site.answers);
          // `{}`, not `undefined`: an explicit `undefined` takes the default.
          const result = await run(site, NAME, REF, site.physicalId, {});
          expect(result).toContain(site.refusal);
          expect(result).not.toContain(SENTINEL);
        });
      }
    });
  }
});

describe('EMR Cluster KerberosAttributes password (go-to-k/cdkd#4275)', () => {
  const kerberos = (password: string) => ({ Realm: 'EC2.INTERNAL', KdcAdminPassword: password });
  const rest = { Name: 'cluster', ReleaseLabel: 'emr-7.0.0' };

  it('an unchanged secret password lets a mutable change through', async () => {
    const result = await outcome(
      new EMRClusterProvider().update(
        'Cluster',
        'j-1ABCDEFGHIJK',
        'AWS::EMR::Cluster',
        { ...rest, KerberosAttributes: kerberos(NAME), VisibleToAllUsers: false },
        { ...rest, KerberosAttributes: kerberos(REF), VisibleToAllUsers: true },
        context
      )
    );
    expect(result).toContain(SENTINEL);
  });

  it('a changed realm beside it is still refused', async () => {
    const result = await outcome(
      new EMRClusterProvider().update(
        'Cluster',
        'j-1ABCDEFGHIJK',
        'AWS::EMR::Cluster',
        { ...rest, KerberosAttributes: { ...kerberos(NAME), Realm: 'OTHER' } },
        { ...rest, KerberosAttributes: kerberos(REF) },
        context
      )
    );
    expect(result).toContain('EMR Cluster KerberosAttributes is immutable');
  });
});

describe('Kinesis StreamConsumer StreamARN from the consumer ARN (go-to-k/cdkd#4275)', () => {
  const physicalId = `${STREAM_ARN}/consumer/consumer-a:1700000000`;
  const base = { ConsumerName: 'consumer-a', Tags: [] };

  it('a secret-derived StreamARN matching the ARN the consumer lives on proceeds', async () => {
    const result = await outcome(
      new KinesisStreamConsumerProvider().update(
        'Consumer',
        physicalId,
        'AWS::Kinesis::StreamConsumer',
        { ...base, StreamARN: STREAM_ARN, Tags: [{ Key: 'k', Value: '1' }] },
        { ...base, StreamARN: REF },
        context
      )
    );
    expect(result).toContain(SENTINEL);
  });

  it('a secret-derived StreamARN resolving to ANOTHER stream than the ARN names: refused', async () => {
    const other = 'arn:aws:kinesis:us-east-1:123456789012:stream/other-stream';
    const result = await outcome(
      new KinesisStreamConsumerProvider().update(
        'Consumer',
        physicalId,
        'AWS::Kinesis::StreamConsumer',
        { ...base, StreamARN: other, Tags: [{ Key: 'k', Value: '1' }] },
        { ...base, StreamARN: REF },
        { maskSecrets: createSecretMasker(bagOf(other)) }
      )
    );
    expect(result).toContain('ConsumerName / StreamARN are immutable');
    expect(result).not.toContain(SENTINEL);
  });

  it('a stream named `consumer` still splits at the LAST marker', async () => {
    const streamArn = 'arn:aws:kinesis:us-east-1:123456789012:stream/consumer';
    const result = await outcome(
      new KinesisStreamConsumerProvider().update(
        'Consumer',
        `${streamArn}/consumer/${NAME}:1700000000`,
        'AWS::Kinesis::StreamConsumer',
        { StreamARN: streamArn, ConsumerName: NAME, Tags: [{ Key: 'k', Value: '1' }] },
        { StreamARN: streamArn, ConsumerName: REF, Tags: [] },
        context
      )
    );
    expect(result).toContain(SENTINEL);
  });

  it('an unparseable physical id gives no evidence, so the refusal stands', async () => {
    const result = await outcome(
      new KinesisStreamConsumerProvider().update(
        'Consumer',
        'not-an-arn',
        'AWS::Kinesis::StreamConsumer',
        { StreamARN: STREAM_ARN, ConsumerName: NAME },
        { StreamARN: STREAM_ARN, ConsumerName: REF },
        context
      )
    );
    expect(result).toContain('ConsumerName / StreamARN are immutable');
  });
});

describe('Scheduler Schedule GroupName stays refused (go-to-k/cdkd#4275)', () => {
  // Nothing non-secret in the record identifies the group, and a probe of the
  // resolved group cannot tell a rotated secret from an unchanged one, so a
  // secret-derived group keeps the refusal, and AWS is never asked.
  it('a recorded reference against its resolved value is refused, with no AWS call', async () => {
    fakeAws({ GetScheduleCommand: () => ({}) });
    const rest = {
      ScheduleExpression: 'rate(1 hour)',
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: { Arn: 'arn:aws:sqs:us-east-1:1:q', RoleArn: 'arn:aws:iam::1:role/r' },
    };
    const result = await outcome(
      new SchedulerScheduleProvider().update(
        'Schedule',
        'my-schedule',
        'AWS::Scheduler::Schedule',
        { ...rest, GroupName: NAME, Description: 'new' },
        { ...rest, GroupName: REF },
        context
      )
    );
    expect(result).toContain('GroupName addresses the schedule');
    // The resolved group is masked where the refusal is built, not only by
    // the engine's thrown-message mask.
    expect(result).toContain('to ***)');
    expect(result).not.toContain(NAME);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('the log lines a secret-derived name newly reaches are masked (go-to-k/cdkd#4275)', () => {
  // Before the fix these lines were unreachable with a secret-derived name:
  // the guard refused first. Each case asserts the masked line WAS written (a
  // `***` in the transcript), so "no plaintext" is not vacuous.
  const transcript = (): string =>
    [...debugSpy.mock.calls, ...warnSpy.mock.calls].map((args) => String(args[0])).join('\n');

  const cases: Array<{
    label: string;
    site: string;
    answers: Record<string, (input: Record<string, unknown>) => unknown>;
    desiredRest?: Record<string, unknown>;
    /** The fixed text of each line the case must see, with the name masked. */
    pinned: string[];
  }> = [
    {
      label: 'DBProxy modify line',
      site: 'RDS DBProxy DBProxyName',
      answers: { ModifyDBProxyCommand: () => ({}), DescribeDBProxiesCommand: () => ({}) },
      pinned: [`Updating DBProxy ${SECRET_MASK}:`],
    },
    {
      label: 'DBProxyEndpoint security-group line',
      site: 'RDS DBProxyEndpoint DBProxyEndpointName',
      answers: {
        ModifyDBProxyEndpointCommand: () => ({}),
        DescribeDBProxyEndpointsCommand: () => ({}),
      },
      pinned: [`Updating DBProxyEndpoint ${SECRET_MASK} security groups`],
    },
    {
      label: 'S3 VectorBucket tag line',
      site: 'S3Vectors VectorBucket VectorBucketName',
      answers: {
        GetVectorBucketCommand: () => ({
          vectorBucket: { vectorBucketArn: `arn:aws:s3vectors:us-east-1:1:bucket/${NAME}` },
        }),
        TagResourceCommand: () => ({}),
        UntagResourceCommand: () => ({}),
      },
      pinned: [`Updated tags for S3 VectorBucket Resource (${SECRET_MASK})`],
    },
    {
      label: 'Kinesis consumer tag and attribute-refresh lines',
      site: 'Kinesis StreamConsumer ConsumerName',
      answers: {
        TagResourceCommand: () => ({}),
        UntagResourceCommand: () => ({}),
        DescribeStreamConsumerCommand: (input) => {
          throw new Error(`not found: ${String(input['ConsumerARN'])}`);
        },
      },
      desiredRest: { StreamARN: STREAM_ARN, Tags: [{ Key: 'k2', Value: '2' }] },
      pinned: [
        `on Kinesis stream consumer ${STREAM_ARN}/consumer/${SECRET_MASK}:1700000000`,
        `from Kinesis stream consumer ${STREAM_ARN}/consumer/${SECRET_MASK}:1700000000`,
        `DescribeStreamConsumer(${STREAM_ARN}/consumer/${SECRET_MASK}:1700000000) failed`,
      ],
    },
    {
      label: 'DBProxy tag lookup-failure line (the ARN read fails)',
      site: 'RDS DBProxy DBProxyName',
      answers: {
        ModifyDBProxyCommand: () => ({}),
        DescribeDBProxiesCommand: () => {
          throw new Error(`DBProxy ${NAME} is unavailable`);
        },
      },
      desiredRest: {
        EngineFamily: 'MYSQL',
        VpcSubnetIds: SUBNETS,
        RequireTLS: false,
        Tags: [{ Key: 'k', Value: '2' }],
      },
      pinned: [`Skipping tag diff for ${SECRET_MASK} (no ARN):`],
    },
    {
      label: 'DBProxyEndpoint tag lookup-failure line (the ARN read fails)',
      site: 'RDS DBProxyEndpoint DBProxyEndpointName',
      answers: {
        DescribeDBProxyEndpointsCommand: () => {
          throw new Error(`endpoint ${NAME} is unavailable`);
        },
      },
      desiredRest: {
        DBProxyName: 'proxy',
        VpcSubnetIds: SUBNETS,
        VpcSecurityGroupIds: ['sg-1'],
        Tags: [{ Key: 'k', Value: '2' }],
      },
      pinned: [`Skipping tag diff for ${SECRET_MASK} (no ARN):`],
    },
  ];

  for (const c of cases) {
    it(c.label, async () => {
      const site = SITES.find((s) => s.label === c.site)!;
      fakeAws(c.answers);
      const result = await run(
        c.desiredRest ? { ...site, desiredRest: c.desiredRest } : site,
        NAME,
        REF
      );
      expect(result).toBe('resolved');
      for (const line of c.pinned) expect(transcript()).toContain(line);
      expect(transcript()).not.toContain(NAME);
    });
  }

  it('Scheduler updating line (a rollback replay: both sides resolved)', async () => {
    fakeAws({
      UpdateScheduleCommand: () => ({ ScheduleArn: `arn:aws:scheduler:us-east-1:1:schedule/${NAME}/s` }),
    });
    const result = await outcome(
      new SchedulerScheduleProvider().update(
        'Schedule',
        'my-schedule',
        'AWS::Scheduler::Schedule',
        {
          GroupName: NAME,
          ScheduleExpression: 'rate(1 hour)',
          FlexibleTimeWindow: { Mode: 'OFF' },
          Target: { Arn: 'arn:aws:sqs:us-east-1:1:q', RoleArn: 'arn:aws:iam::1:role/r' },
        },
        {
          GroupName: NAME,
          ScheduleExpression: 'rate(2 hours)',
          FlexibleTimeWindow: { Mode: 'OFF' },
          Target: { Arn: 'arn:aws:sqs:us-east-1:1:q', RoleArn: 'arn:aws:iam::1:role/r' },
        },
        context
      )
    );
    expect(result).toBe('resolved');
    expect(transcript()).toContain(`(group: ${SECRET_MASK})`);
    expect(transcript()).not.toContain(NAME);
  });
});

describe('DynamoDB GlobalTable: the local tag lines name the table ARN masked (go-to-k/cdkd#4275)', () => {
  const transcript = (): string =>
    [...debugSpy.mock.calls, ...warnSpy.mock.calls].map((args) => String(args[0])).join('\n');
  const TABLE_ARN = `arn:aws:dynamodb:us-east-1:123456789012:table/${NAME}`;

  it('a tag change on a table whose name is secret-derived', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (commandName(command) === 'DescribeTableCommand') {
        return {
          Table: {
            TableName: NAME,
            TableArn: TABLE_ARN,
            TableStatus: 'ACTIVE',
            Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
          },
        };
      }
      return {};
    });
    const common = {
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
      BillingMode: 'PAY_PER_REQUEST',
    };
    const result = await outcome(
      new DynamoDBGlobalTableProvider().update(
        'Table',
        NAME,
        'AWS::DynamoDB::GlobalTable',
        {
          ...common,
          TableName: NAME,
          Replicas: [{ Region: 'us-east-1', Tags: [{ Key: 'k2', Value: '2' }] }],
        },
        {
          ...common,
          TableName: REF,
          Replicas: [{ Region: 'us-east-1', Tags: [{ Key: 'k', Value: '1' }] }],
        },
        context
      )
    );
    expect(result).toBe('resolved');
    const names = mockSend.mock.calls.map((c) => commandName(c[0]));
    expect(names).toContain('TagResourceCommand');
    expect(names).toContain('UntagResourceCommand');
    expect(transcript()).toContain(`GlobalTable arn:aws:dynamodb:us-east-1:123456789012:table/${SECRET_MASK}`);
    expect(transcript()).not.toContain(NAME);
  });

  it('a tags-only change on a cross-region replica: the skipped-UpdateReplica line', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (commandName(command) === 'DescribeTableCommand') {
        return {
          Table: {
            TableName: NAME,
            TableArn: TABLE_ARN,
            TableStatus: 'ACTIVE',
            Replicas: [
              { RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' },
              { RegionName: 'us-west-2', ReplicaStatus: 'ACTIVE' },
            ],
          },
        };
      }
      return {};
    });
    const common = {
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
      BillingMode: 'PAY_PER_REQUEST',
    };
    const result = await outcome(
      new DynamoDBGlobalTableProvider().update(
        'Table',
        NAME,
        'AWS::DynamoDB::GlobalTable',
        {
          ...common,
          TableName: NAME,
          Replicas: [
            { Region: 'us-east-1' },
            { Region: 'us-west-2', Tags: [{ Key: 'k', Value: '2' }] },
          ],
        },
        {
          ...common,
          TableName: REF,
          Replicas: [
            { Region: 'us-east-1' },
            { Region: 'us-west-2', Tags: [{ Key: 'k', Value: '1' }] },
          ],
        },
        context
      )
    );
    expect(result).toBe('resolved');
    expect(transcript()).toContain(`Cross-region replica us-west-2 of ${SECRET_MASK}`);
    expect(transcript()).not.toContain(NAME);
  });
});

describe('a name below the masker substring floor is masked as a VALUE (go-to-k/cdkd#4275)', () => {
  // A finished message reaches only the masker's substring arm, which skips
  // needles under 4 characters; only masking the raw value catches these.
  const TINY = 'qxz';
  const tinyContext: UpdateContext = { maskSecrets: createSecretMasker(bagOf(TINY)) };
  const lines = (needle: string): string[] =>
    [...debugSpy.mock.calls, ...warnSpy.mock.calls]
      .map((args) => String(args[0]))
      .filter((line) => line.includes(needle));

  it('Scheduler group', async () => {
    fakeAws({ UpdateScheduleCommand: () => ({}) });
    const rest = {
      ScheduleExpression: 'rate(1 hour)',
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: { Arn: 'arn:aws:sqs:us-east-1:1:q', RoleArn: 'arn:aws:iam::1:role/r' },
    };
    const result = await outcome(
      new SchedulerScheduleProvider().update(
        'Schedule',
        'my-schedule',
        'AWS::Scheduler::Schedule',
        { ...rest, GroupName: TINY },
        { ...rest, GroupName: TINY, ScheduleExpression: 'rate(2 hours)' },
        tinyContext
      )
    );
    expect(result).toBe('resolved');
    expect(lines('Updating Schedule')).toEqual([
      `Updating Schedule Schedule: my-schedule (group: ${SECRET_MASK})`,
    ]);
  });

  it('GlobalTable cross-region replica line', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (commandName(command) === 'DescribeTableCommand') {
        return {
          Table: {
            TableName: TINY,
            TableArn: `arn:aws:dynamodb:us-east-1:123456789012:table/${TINY}`,
            TableStatus: 'ACTIVE',
            Replicas: [
              { RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' },
              { RegionName: 'us-west-2', ReplicaStatus: 'ACTIVE' },
            ],
          },
        };
      }
      return {};
    });
    const common = {
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
      BillingMode: 'PAY_PER_REQUEST',
    };
    const replicas = (value: string) => [
      { Region: 'us-east-1' },
      { Region: 'us-west-2', Tags: [{ Key: 'k', Value: value }] },
    ];
    const result = await outcome(
      new DynamoDBGlobalTableProvider().update(
        'Table',
        TINY,
        'AWS::DynamoDB::GlobalTable',
        { ...common, TableName: TINY, Replicas: replicas('2') },
        { ...common, TableName: REF, Replicas: replicas('1') },
        tinyContext
      )
    );
    expect(result).toBe('resolved');
    const [line, ...more] = lines('Cross-region replica us-west-2 of');
    expect(more).toEqual([]);
    expect(line).toContain(`Cross-region replica us-west-2 of ${SECRET_MASK}:`);
  });
});

describe('the non-name create-only keys of the masker arm (go-to-k/cdkd#4275)', () => {
  // Each key is sent to no AWS call (the writes go to the physical id), so an
  // unchanged secret-derived value must not refuse the update.
  const cases: Array<{
    label: string;
    site: string;
    key: string;
    desired: unknown;
    previous: unknown;
    physicalId?: string;
    ctx?: UpdateContext;
  }> = [
    {
      label: 'DBProxy EngineFamily',
      site: 'RDS DBProxy DBProxyName',
      key: 'EngineFamily',
      // NOT the physical id's name: a selector that handed this key the
      // physical-id arm would then refuse it.
      desired: OTHER,
      previous: REF,
    },
    {
      label: 'DBProxy VpcSubnetIds (a list with one secret entry)',
      site: 'RDS DBProxy DBProxyName',
      key: 'VpcSubnetIds',
      desired: ['subnet-1', NAME],
      previous: ['subnet-1', REF],
    },
    {
      label: 'DBProxyEndpoint VpcSubnetIds',
      site: 'RDS DBProxyEndpoint DBProxyEndpointName',
      key: 'VpcSubnetIds',
      desired: ['subnet-1', NAME],
      previous: ['subnet-1', REF],
    },
    {
      label: 'DBProxyTargetGroup TargetGroupName (through the default normalisation)',
      site: 'RDS DBProxyTargetGroup DBProxyName',
      key: 'TargetGroupName',
      desired: 'default',
      previous: '{{resolve:secretsmanager:tg-secret:SecretString:tg}}',
      ctx: { maskSecrets: createSecretMasker(bagOf('default')) },
    },
    {
      label: 'VectorBucket EncryptionConfiguration (a nested secret-derived key ARN)',
      site: 'S3Vectors VectorBucket VectorBucketName',
      key: 'EncryptionConfiguration',
      desired: { SseType: 'aws:kms', KmsKeyArn: NAME },
      previous: { SseType: 'aws:kms', KmsKeyArn: REF },
    },
  ];

  for (const c of cases) {
    it(`${c.label}: unchanged behind its reference, the update goes through`, async () => {
      const site = SITES.find((x) => x.label === c.site)!;
      fakeAws(site.answers);
      const result = await outcome(
        site.provider().update(
          'Resource',
          c.physicalId ?? site.physicalId,
          site.type,
          { ...site.desiredRest, [site.key]: site.key === c.key ? c.desired : 'fixed', [c.key]: c.desired },
          { ...site.previousRest, [site.key]: 'fixed', [c.key]: c.previous },
          c.ctx ?? context
        )
      );
      expect(result).toContain(SENTINEL);
    });

    it(`${c.label}: a literal the masker never resolved is still refused`, async () => {
      const site = SITES.find((x) => x.label === c.site)!;
      fakeAws(site.answers);
      const literal =
        typeof c.desired === 'string'
          ? 'a-literal-value'
          : JSON.parse(JSON.stringify(c.desired).split(NAME).join('a-literal-value'));
      const result = await outcome(
        site.provider().update(
          'Resource',
          c.physicalId ?? site.physicalId,
          site.type,
          { ...site.desiredRest, [site.key]: 'fixed', [c.key]: literal },
          { ...site.previousRest, [site.key]: 'fixed', [c.key]: c.previous },
          // The REAL masker: a literal it never resolved must still be refused.
          c.ctx ?? context
        )
      );
      expect(result).toContain(`${c.key}`);
      expect(result).toMatch(/immutable/);
      expect(result).not.toContain(SENTINEL);
    });
  }
});

describe('keys that ADDRESS the writes are never exempted (go-to-k/cdkd#4275)', () => {
  // A secret rotated under an unchanged reference resolves to another
  // resource's id, and these providers send the desired value.
  it('EMR InstanceFleetConfig ClusterId', async () => {
    const result = await outcome(
      new EMRInstanceFleetConfigProvider().update(
        'Fleet',
        'if-1ABCDEFGHIJK',
        'AWS::EMR::InstanceFleetConfig',
        { ClusterId: NAME, InstanceFleetType: 'TASK', TargetOnDemandCapacity: 2 },
        { ClusterId: REF, InstanceFleetType: 'TASK', TargetOnDemandCapacity: 1 },
        context
      )
    );
    expect(result).toContain('InstanceFleetConfig ClusterId is immutable');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('EMR InstanceGroupConfig JobFlowId', async () => {
    const result = await outcome(
      new EMRInstanceGroupConfigProvider().update(
        'Group',
        'ig-1ABCDEFGHIJK',
        'AWS::EMR::InstanceGroupConfig',
        { JobFlowId: NAME, InstanceRole: 'TASK', InstanceType: 'm5.xlarge', InstanceCount: 2 },
        { JobFlowId: REF, InstanceRole: 'TASK', InstanceType: 'm5.xlarge', InstanceCount: 1 },
        context
      )
    );
    expect(result).toContain('InstanceGroupConfig JobFlowId is immutable');
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('DBProxyTargetGroup: AWS confirms the resolved names before any write (go-to-k/cdkd#4275)', () => {
  const site = SITES.find((x) => x.label === 'RDS DBProxyTargetGroup DBProxyName')!;
  const writes = () =>
    mockSend.mock.calls
      .map((c) => commandName(c[0]))
      .filter((n) => n !== 'DescribeDBProxyTargetGroupsCommand');
  const lookups = () =>
    mockSend.mock.calls
      .filter((c) => commandName(c[0]) === 'DescribeDBProxyTargetGroupsCommand')
      .map((c) => (c[0] as { input: unknown }).input);

  it('the lookup is addressed by the RESOLVED names', async () => {
    fakeAws(targetGroupAt(TG_ARN));
    expect(await run(site, NAME, REF)).toContain(SENTINEL);
    expect(lookups()).toEqual([{ DBProxyName: NAME, TargetGroupName: 'default' }]);
  });

  it('a rotated secret naming ANOTHER proxy (a different target group ARN): refused as a rotation, nothing written', async () => {
    fakeAws(targetGroupAt('arn:aws:rds:us-east-1:123456789012:target-group:prx-tg-someone-else'));
    const result = await run(site, NAME, REF);
    expect(result).toContain('addresses a different target group (the secret may have been rotated)');
    expect(writes()).toEqual([]);
  });

  it('no target group under the resolved names (`TargetGroups: []`): refused, nothing written', async () => {
    fakeAws({ DescribeDBProxyTargetGroupsCommand: () => ({ TargetGroups: [] }) });
    const result = await run(site, NAME, REF);
    expect(result).toContain('addresses no target group (the secret may have been rotated)');
    expect(writes()).toEqual([]);
  });

  it('a failed lookup is refused as a FAILURE naming its class, not a rotation, and says why at debug', async () => {
    fakeAws({
      DescribeDBProxyTargetGroupsCommand: () => {
        throw Object.assign(new Error(`proxy ${NAME} is busy`), { name: 'ThrottlingException' });
      },
    });
    // NOT a typed ResourceUpdateNotSupportedError, which the engine turns into
    // a replacement under --replace; the AWS failure rides as a stamped cause.
    const error = await site
      .provider()
      .update(
        'Resource',
        site.physicalId,
        site.type,
        { ...site.desiredRest, [site.key]: NAME },
        { ...site.previousRest, [site.key]: REF },
        context
      )
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(error).toBeInstanceOf(ProvisioningError);
    expect(error).not.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(hasRedactedCause(error as Error)).toBe(true);
    expect(((error as Error).cause as Error).name).toBe('ThrottlingException');
    // A throttle stays retryable (the classifier reads the cause's NAME).
    expect(isRetryableTransientError(error, retryClassificationText(error))).toBe(true);
    vi.clearAllMocks();
    const result = await run(site, NAME, REF);
    expect(result).toContain('could not be confirmed (ThrottlingException)');
    expect(result).not.toContain('rotated');
    expect(writes()).toEqual([]);
    const debug = debugSpy.mock.calls.map((a) => String(a[0])).join('\n');
    expect(debug).toContain(`Could not confirm that the resolved names address Resource's target group:`);
    expect(debug).not.toContain(NAME);
  });

  it('a NOT-FOUND fault (a rotated proxy name) is refused as a typed rotation, not as a failure to retry', async () => {
    for (const name of ['DBProxyNotFoundFault', 'DBProxyTargetGroupNotFoundFault']) {
      fakeAws({
        DescribeDBProxyTargetGroupsCommand: () => {
          throw Object.assign(new Error('not found'), { name });
        },
      });
      const error = await site
        .provider()
        .update(
          'Resource',
          site.physicalId,
          site.type,
          { ...site.desiredRest, [site.key]: NAME },
          { ...site.previousRest, [site.key]: REF },
          context
        )
        .then(
          () => undefined,
          (e: unknown) => e
        );
      expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect((error as Error).message).toContain('addresses no target group');
      expect(writes()).toEqual([]);
    }
  });

  it("the stamp is what keeps a failure retryable that only its AWS TEXT marks (IAM propagation)", async () => {
    // The refusal's message names only the failure class, so a classifier
    // keyed on the AWS wording sees it only through the stamped cause.
    fakeAws({
      DescribeDBProxyTargetGroupsCommand: () => {
        throw Object.assign(
          new Error('User: arn:aws:sts::1:assumed-role/r/s is not authorized to perform: rds:DescribeDBProxyTargetGroups'),
          { name: 'AccessDeniedException' }
        );
      },
    });
    const error = await site
      .provider()
      .update(
        'Resource',
        site.physicalId,
        site.type,
        { ...site.desiredRest, [site.key]: NAME },
        { ...site.previousRest, [site.key]: REF },
        context
      )
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as Error).message).not.toContain('not authorized to perform');
    expect(isRetryableTransientError(error, retryClassificationText(error))).toBe(true);
  });

  it('a rejection that is not an Error is refused as an unreadable failure', async () => {
    fakeAws({
      DescribeDBProxyTargetGroupsCommand: () => {
        throw 'x';
      },
    });
    const result = await run(site, NAME, REF);
    expect(result).toContain('could not be confirmed (an unreadable failure)');
    expect(writes()).toEqual([]);
  });

  it('the mismatch arms stay a typed refusal (a real change, which --replace may replace)', async () => {
    fakeAws(targetGroupAt('arn:aws:rds:us-east-1:123456789012:target-group:prx-tg-someone-else'));
    const error = await site
      .provider()
      .update(
        'Resource',
        site.physicalId,
        site.type,
        { ...site.desiredRest, [site.key]: NAME },
        { ...site.previousRest, [site.key]: REF },
        context
      )
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
  });

  it('a short name inside the other is still value-masked (longest replaced first)', async () => {
    // The proxy name `def` is a prefix of the target group name `default`,
    // and comes FIRST in the provider's list: replacing it first would leave
    // `***ault` where AWS quotes the target group.
    fakeAws({
      DescribeDBProxyTargetGroupsCommand: () => {
        throw Object.assign(new Error('target group default is busy'), {
          name: 'ThrottlingException',
        });
      },
    });
    const masker = createSecretMasker(
      new Map([
        ['def', '{{resolve:secretsmanager:p}}'],
        ['default', '{{resolve:secretsmanager:t}}'],
      ])
    );
    await run(site, 'def', REF, site.physicalId, { maskSecrets: masker });
    const debug = debugSpy.mock.calls.map((a) => String(a[0])).join('\n');
    expect(debug).toContain(`target group ${SECRET_MASK} is busy`);
    expect(debug).not.toContain('ault');
  });

  it('a name below the masker substring floor that AWS quotes is masked as a value on the debug line', async () => {
    const TINY = 'qxz';
    fakeAws({
      DescribeDBProxyTargetGroupsCommand: () => {
        throw Object.assign(new Error(`DBProxy ${TINY} not found`), { name: 'DBProxyNotFoundFault' });
      },
    });
    const result = await run(site, TINY, REF, site.physicalId, {
      maskSecrets: createSecretMasker(bagOf(TINY)),
    });
    // A not-found is an answer (the names address nothing), not a failure.
    expect(result).toContain('addresses no target group (the secret may have been rotated)');
    const debug = debugSpy.mock.calls.map((a) => String(a[0])).join('\n');
    expect(debug).toContain(`DBProxy ${SECRET_MASK} not found`);
    expect(debug).not.toMatch(new RegExp(`\\b${TINY}\\b`));
  });

  it('an ordinary, unchanged record never pays the lookup', async () => {
    fakeAws();
    const result = await run(site, 'proxy-a', 'proxy-a');
    expect(result).toContain(SENTINEL);
    expect(lookups()).toEqual([]);
  });
});

describe('the remaining branches (go-to-k/cdkd#4275)', () => {
  it('Kinesis: a consumer ARN with no creation timestamp gives no evidence', async () => {
    const result = await outcome(
      new KinesisStreamConsumerProvider().update(
        'Consumer',
        `${STREAM_ARN}/consumer/${NAME}`,
        'AWS::Kinesis::StreamConsumer',
        { StreamARN: STREAM_ARN, ConsumerName: NAME },
        { StreamARN: STREAM_ARN, ConsumerName: REF },
        context
      )
    );
    expect(result).toContain('ConsumerName / StreamARN are immutable');
  });

  it('GlobalTable: the update-path index wait masks the table name, short ones included', async () => {
    const TINY = 'qxz';
    mockSend.mockImplementation(async () => {
      throw Object.assign(new Error(`table ${TINY} exploded`), { name: 'InternalServerError' });
    });
    const provider = new DynamoDBGlobalTableProvider() as unknown as {
      waitForIndexesActive(
        tableName: string,
        logicalId: string,
        opts?: { maxAttempts?: number; maskSecrets?: (t: string) => string }
      ): Promise<void>;
    };
    await provider.waitForIndexesActive(TINY, 'Table', {
      maxAttempts: 1,
      maskSecrets: createSecretMasker(bagOf(TINY)),
    });
    const warned = warnSpy.mock.calls.map((a) => String(a[0]));
    expect(warned.some((l) => l.includes(`while waiting for indexes on ${SECRET_MASK}`))).toBe(true);
    for (const line of [...warned, ...debugSpy.mock.calls.map((a) => String(a[0]))]) {
      expect(line).not.toMatch(new RegExp(`\\b${TINY}\\b`));
    }
  });
});

describe('value masks catch a name below the substring floor on every value-masked line (go-to-k/cdkd#4275)', () => {
  const TINY = 'qxz';
  const tinyContext: UpdateContext = { maskSecrets: createSecretMasker(bagOf(TINY)) };
  const transcript = (): string =>
    [...debugSpy.mock.calls, ...warnSpy.mock.calls].map((args) => String(args[0])).join('\n');
  const cases: Array<{ site: string; answers: Record<string, () => unknown>; pinned: string }> = [
    {
      site: 'RDS DBProxy DBProxyName',
      answers: { ModifyDBProxyCommand: () => ({}), DescribeDBProxiesCommand: () => ({}) },
      pinned: `Updating DBProxy ${SECRET_MASK}:`,
    },
    {
      site: 'RDS DBProxyEndpoint DBProxyEndpointName',
      answers: {
        ModifyDBProxyEndpointCommand: () => ({}),
        DescribeDBProxyEndpointsCommand: () => ({}),
      },
      pinned: `Updating DBProxyEndpoint ${SECRET_MASK} security groups`,
    },
    {
      site: 'S3Vectors VectorBucket VectorBucketName',
      answers: {
        GetVectorBucketCommand: () => ({ vectorBucket: { vectorBucketArn: 'arn:aws:s3vectors:1' } }),
        TagResourceCommand: () => ({}),
        UntagResourceCommand: () => ({}),
      },
      pinned: `Updated tags for S3 VectorBucket Resource (${SECRET_MASK})`,
    },
  ];
  for (const c of cases) {
    it(c.site, async () => {
      const site = SITES.find((x) => x.label === c.site)!;
      fakeAws(c.answers);
      expect(await run(site, TINY, REF, TINY, tinyContext)).toBe('resolved');
      expect(transcript()).toContain(c.pinned);
      expect(transcript()).not.toMatch(new RegExp(`\\b${TINY}\\b`));
    });
  }
});
