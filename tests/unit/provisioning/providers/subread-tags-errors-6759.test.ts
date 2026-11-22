/**
 * go-to-k/cdkd#6759: a failed Tags SUB-read inside `readCurrentState` used to
 * be swallowed on ANY error -- the key was omitted or defaulted to `[]` -- so
 * an AccessDenied / throttle on `ListTagsForResource` left Tags uncompared and
 * `cdkd drift` said "no drift". Now only the call's own not-found answer keeps
 * the old result; every other failure rejects, which `cdkd drift` reports as
 * `notCompared: readFailed`.
 *
 * Each row stubs the provider's client with a dispatcher keyed on the command
 * class name, so the main read answers and only the tag read fails.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import { ResourceNotFoundException as AgentCoreNotFound } from '@aws-sdk/client-bedrock-agentcore-control';
import { WAFNonexistentItemException } from '@aws-sdk/client-wafv2';
import {
  DBProxyEndpointNotFoundFault,
  DBProxyNotFoundFault,
  DBProxyTargetGroupNotFoundFault,
} from '@aws-sdk/client-rds';
import { ResourceNotFoundException as KinesisNotFound } from '@aws-sdk/client-kinesis';
import { ResourceNotFoundException as FirehoseNotFound } from '@aws-sdk/client-firehose';
import { RESOURCE_NOT_FOUND } from '../../../../src/types/resource.js';
import { AgentCoreEvaluatorProvider } from '../../../../src/provisioning/providers/agentcore-evaluator-provider.js';
import { AgentCoreRuntimeProvider } from '../../../../src/provisioning/providers/agentcore-runtime-provider.js';
import { CloudWatchAlarmProvider } from '../../../../src/provisioning/providers/cloudwatch-alarm-provider.js';
import { WAFv2WebACLProvider } from '../../../../src/provisioning/providers/wafv2-provider.js';
import { RDSDBProxyTargetGroupProvider } from '../../../../src/provisioning/providers/rds-dbproxy-targetgroup-provider.js';
import { RDSProvider } from '../../../../src/provisioning/providers/rds-provider.js';
import { ElastiCacheProvider } from '../../../../src/provisioning/providers/elasticache-provider.js';
import { NeptuneProvider } from '../../../../src/provisioning/providers/neptune-provider.js';
import { DocDBProvider } from '../../../../src/provisioning/providers/docdb-provider.js';
import { DocDBSubnetGroupProvider } from '../../../../src/provisioning/providers/docdb-subnet-group-provider.js';
import { KinesisStreamProvider } from '../../../../src/provisioning/providers/kinesis-provider.js';
import { FirehoseProvider } from '../../../../src/provisioning/providers/firehose-provider.js';
import { KinesisStreamConsumerProvider } from '../../../../src/provisioning/providers/kinesis-streamconsumer-provider.js';
import { RDSDBProxyProvider } from '../../../../src/provisioning/providers/rds-dbproxy-provider.js';
import { RDSDBProxyEndpointProvider } from '../../../../src/provisioning/providers/rds-dbproxy-endpoint-provider.js';
import { S3VectorsProvider } from '../../../../src/provisioning/providers/s3-vectors-provider.js';
import { ECSProvider } from '../../../../src/provisioning/providers/ecs-provider.js';
import { EC2Provider } from '../../../../src/provisioning/providers/ec2-provider.js';

type Handler = (input: Record<string, unknown>) => unknown;
type Handlers = Record<string, Handler>;

function awsError(name: string, message = `${name} raised`): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

/** A client whose `send` answers by command class name; anything unlisted is `{}`. */
function fakeClient(handlers: Handlers) {
  const sent: string[] = [];
  const send = vi.fn(async (command: { constructor: { name: string }; input: unknown }) => {
    const name = command.constructor.name;
    sent.push(name);
    const handler = handlers[name];
    if (handler === undefined) return {};
    return handler(command.input as Record<string, unknown>);
  });
  return { client: { send, config: { region: async () => 'us-east-1' } }, sent };
}

/** Points the provider's client at `client`, whichever way it reaches one. */
function inject(provider: object, client: unknown): void {
  const p = provider as Record<string, unknown>;
  if (typeof p['getClient'] === 'function') {
    p['getClient'] = () => client;
  }
  if ('client' in p) p['client'] = client;
  if ('cloudWatchClient' in p) p['cloudWatchClient'] = client;
}

interface Row {
  name: string;
  make: () => object;
  resourceType: string;
  physicalId: string;
  properties?: Record<string, unknown>;
  /** The tag-read command class name. */
  tagCommand: string;
  /** Its not-found error name, which keeps today's result. */
  notFoundName: string;
  /** The modeled SDK class, for a site that tests `instanceof` (as the SDK deserializes). */
  notFoundClass?: new (opts: { message: string; $metadata: object }) => Error;
  /** What `readCurrentState` resolves to when the tag read says not-found. */
  onNotFound: 'omitTags' | 'emptyTags' | 'resourceNotFound';
  /** The main read(s), answering with a live resource. */
  handlers: Handlers;
}

const ARN = (svc: string, rest: string) => `arn:aws:${svc}:us-east-1:123456789012:${rest}`;

const rows: Row[] = [
  {
    name: 'AgentCore Evaluator',
    make: () => new AgentCoreEvaluatorProvider(),
    resourceType: 'AWS::BedrockAgentCore::Evaluator',
    physicalId: ARN('bedrock-agentcore', 'evaluator/ev-1'),
    tagCommand: 'ListTagsForResourceCommand',
    notFoundName: 'ResourceNotFoundException',
    notFoundClass: AgentCoreNotFound,
    onNotFound: 'omitTags',
    handlers: { GetEvaluatorCommand: () => ({ evaluatorName: 'ev' }) },
  },
  {
    name: 'AgentCore Runtime',
    make: () => new AgentCoreRuntimeProvider(),
    resourceType: 'AWS::BedrockAgentCore::Runtime',
    physicalId: 'rt-1',
    tagCommand: 'ListTagsForResourceCommand',
    notFoundName: 'ResourceNotFoundException',
    notFoundClass: AgentCoreNotFound,
    onNotFound: 'omitTags',
    handlers: {
      GetAgentRuntimeCommand: () => ({
        agentRuntimeName: 'rt',
        agentRuntimeArn: ARN('bedrock-agentcore', 'runtime/rt-1'),
      }),
    },
  },
  {
    name: 'CloudWatch Alarm',
    make: () => new CloudWatchAlarmProvider(),
    resourceType: 'AWS::CloudWatch::Alarm',
    physicalId: 'my-alarm',
    tagCommand: 'ListTagsForResourceCommand',
    notFoundName: 'ResourceNotFoundException',
    onNotFound: 'omitTags',
    handlers: {
      DescribeAlarmsCommand: () => ({
        MetricAlarms: [
          {
            AlarmName: 'my-alarm',
            AlarmArn: ARN('cloudwatch', 'alarm:my-alarm'),
            MetricName: 'Errors',
            Namespace: 'AWS/Lambda',
            ComparisonOperator: 'GreaterThanThreshold',
            EvaluationPeriods: 1,
            Threshold: 1,
            Statistic: 'Sum',
            Period: 60,
          },
        ],
      }),
    },
  },
  {
    name: 'WAFv2 WebACL',
    make: () => new WAFv2WebACLProvider(),
    resourceType: 'AWS::WAFv2::WebACL',
    physicalId: ARN('wafv2', 'regional/webacl/my-acl/abc-123'),
    tagCommand: 'ListTagsForResourceCommand',
    notFoundName: 'WAFNonexistentItemException',
    notFoundClass: WAFNonexistentItemException,
    onNotFound: 'omitTags',
    handlers: {
      GetWebACLCommand: () => ({
        WebACL: { Name: 'my-acl', Id: 'abc-123', DefaultAction: { Allow: {} }, Rules: [] },
      }),
    },
  },
  {
    name: 'RDS DBProxyTargetGroup',
    make: () => new RDSDBProxyTargetGroupProvider(),
    resourceType: 'AWS::RDS::DBProxyTargetGroup',
    physicalId: ARN('rds', 'target-group:prx-tg-1'),
    properties: { DBProxyName: 'my-proxy', TargetGroupName: 'default' },
    tagCommand: 'ListTagsForResourceCommand',
    notFoundName: 'DBProxyTargetGroupNotFoundFault',
    notFoundClass: DBProxyTargetGroupNotFoundFault,
    onNotFound: 'omitTags',
    handlers: {
      DescribeDBProxyTargetGroupsCommand: () => ({
        TargetGroups: [{ TargetGroupName: 'default', ConnectionPoolConfig: {} }],
      }),
      DescribeDBProxyTargetsCommand: () => ({ Targets: [] }),
    },
  },
  {
    name: 'RDS DBSubnetGroup (rds/calls attachTags)',
    make: () => new RDSProvider(),
    resourceType: 'AWS::RDS::DBSubnetGroup',
    physicalId: 'my-sg',
    tagCommand: 'ListTagsForResourceCommand',
    notFoundName: 'DBSubnetGroupNotFoundFault',
    onNotFound: 'omitTags',
    handlers: {
      DescribeDBSubnetGroupsCommand: () => ({
        DBSubnetGroups: [
          {
            DBSubnetGroupName: 'my-sg',
            DBSubnetGroupDescription: 'd',
            DBSubnetGroupArn: ARN('rds', 'subgrp:my-sg'),
            Subnets: [],
          },
        ],
      }),
    },
  },
  {
    name: 'ElastiCache CacheCluster',
    make: () => new ElastiCacheProvider(),
    resourceType: 'AWS::ElastiCache::CacheCluster',
    physicalId: 'my-cc',
    tagCommand: 'ListTagsForResourceCommand',
    notFoundName: 'CacheClusterNotFoundFault',
    onNotFound: 'omitTags',
    handlers: {
      DescribeCacheClustersCommand: () => ({
        CacheClusters: [
          {
            CacheClusterId: 'my-cc',
            ARN: ARN('elasticache', 'cluster:my-cc'),
            Engine: 'redis',
            CacheNodeType: 'cache.t3.micro',
            NumCacheNodes: 1,
          },
        ],
      }),
    },
  },
  {
    name: 'Neptune DBSubnetGroup',
    make: () => new NeptuneProvider(),
    resourceType: 'AWS::Neptune::DBSubnetGroup',
    physicalId: 'my-nsg',
    tagCommand: 'ListTagsForResourceCommand',
    notFoundName: 'DBSubnetGroupNotFoundFault',
    onNotFound: 'omitTags',
    handlers: {
      DescribeDBSubnetGroupsCommand: () => ({
        DBSubnetGroups: [
          {
            DBSubnetGroupName: 'my-nsg',
            DBSubnetGroupDescription: 'd',
            DBSubnetGroupArn: ARN('rds', 'subgrp:my-nsg'),
            Subnets: [],
          },
        ],
      }),
    },
  },
  {
    name: 'DocDB DBSubnetGroup (docdb-shared attachDocDBTags)',
    make: () => new DocDBSubnetGroupProvider(),
    resourceType: 'AWS::DocDB::DBSubnetGroup',
    physicalId: 'my-dsg',
    tagCommand: 'ListTagsForResourceCommand',
    notFoundName: 'DBSubnetGroupNotFoundFault',
    onNotFound: 'omitTags',
    handlers: {
      DescribeDBSubnetGroupsCommand: () => ({
        DBSubnetGroups: [
          {
            DBSubnetGroupName: 'my-dsg',
            DBSubnetGroupDescription: 'd',
            DBSubnetGroupArn: ARN('rds', 'subgrp:my-dsg'),
            Subnets: [],
          },
        ],
      }),
    },
  },
  {
    name: 'DocDB DBCluster (docdb-shared attachDocDBTags)',
    make: () => new DocDBProvider(),
    resourceType: 'AWS::DocDB::DBCluster',
    physicalId: 'my-dc',
    tagCommand: 'ListTagsForResourceCommand',
    notFoundName: 'DBClusterNotFoundFault',
    onNotFound: 'omitTags',
    handlers: {
      DescribeDBClustersCommand: () => ({
        DBClusters: [
          {
            DBClusterIdentifier: 'my-dc',
            DBClusterArn: ARN('rds', 'cluster:my-dc'),
            Engine: 'docdb',
            Status: 'available',
          },
        ],
      }),
    },
  },
  {
    name: 'Kinesis Stream',
    make: () => new KinesisStreamProvider(),
    resourceType: 'AWS::Kinesis::Stream',
    physicalId: 'my-stream',
    tagCommand: 'ListTagsForStreamCommand',
    notFoundName: 'ResourceNotFoundException',
    notFoundClass: KinesisNotFound,
    onNotFound: 'resourceNotFound',
    handlers: {
      DescribeStreamCommand: () => ({
        StreamDescription: {
          StreamName: 'my-stream',
          StreamModeDetails: { StreamMode: 'PROVISIONED' },
          Shards: [{ ShardId: 's-1' }],
          RetentionPeriodHours: 24,
        },
      }),
      DescribeStreamSummaryCommand: () => ({ StreamDescriptionSummary: {} }),
    },
  },
  {
    name: 'Firehose DeliveryStream',
    make: () => new FirehoseProvider(),
    resourceType: 'AWS::KinesisFirehose::DeliveryStream',
    physicalId: 'my-ds',
    tagCommand: 'ListTagsForDeliveryStreamCommand',
    notFoundName: 'ResourceNotFoundException',
    notFoundClass: FirehoseNotFound,
    onNotFound: 'resourceNotFound',
    handlers: {
      DescribeDeliveryStreamCommand: () => ({
        DeliveryStreamDescription: {
          DeliveryStreamName: 'my-ds',
          DeliveryStreamType: 'DirectPut',
          DeliveryStreamStatus: 'ACTIVE',
          Destinations: [],
        },
      }),
    },
  },
  {
    name: 'Kinesis StreamConsumer',
    make: () => new KinesisStreamConsumerProvider(),
    resourceType: 'AWS::Kinesis::StreamConsumer',
    physicalId: ARN('kinesis', 'stream/my-stream/consumer/c:1'),
    tagCommand: 'ListTagsForResourceCommand',
    notFoundName: 'ResourceNotFoundException',
    notFoundClass: KinesisNotFound,
    onNotFound: 'resourceNotFound',
    handlers: {
      DescribeStreamConsumerCommand: () => ({
        ConsumerDescription: {
          ConsumerName: 'c',
          StreamARN: ARN('kinesis', 'stream/my-stream'),
          ConsumerStatus: 'ACTIVE',
        },
      }),
    },
  },
  {
    name: 'RDS DBProxy',
    make: () => new RDSDBProxyProvider(),
    resourceType: 'AWS::RDS::DBProxy',
    physicalId: 'my-proxy',
    tagCommand: 'ListTagsForResourceCommand',
    notFoundName: 'DBProxyNotFoundFault',
    notFoundClass: DBProxyNotFoundFault,
    onNotFound: 'emptyTags',
    handlers: {
      DescribeDBProxiesCommand: () => ({
        DBProxies: [
          {
            DBProxyName: 'my-proxy',
            DBProxyArn: ARN('rds', 'db-proxy:prx-1'),
            EngineFamily: 'POSTGRESQL',
            RoleArn: ARN('iam', 'role/r'),
            VpcSubnetIds: [],
            VpcSecurityGroupIds: [],
            Auth: [],
          },
        ],
      }),
    },
  },
  {
    name: 'RDS DBProxyEndpoint',
    make: () => new RDSDBProxyEndpointProvider(),
    resourceType: 'AWS::RDS::DBProxyEndpoint',
    physicalId: 'my-ep',
    tagCommand: 'ListTagsForResourceCommand',
    notFoundName: 'DBProxyEndpointNotFoundFault',
    notFoundClass: DBProxyEndpointNotFoundFault,
    onNotFound: 'emptyTags',
    handlers: {
      DescribeDBProxyEndpointsCommand: () => ({
        DBProxyEndpoints: [
          {
            DBProxyEndpointName: 'my-ep',
            DBProxyName: 'my-proxy',
            DBProxyEndpointArn: ARN('rds', 'db-proxy-endpoint:prx-ep-1'),
            VpcSubnetIds: [],
            VpcSecurityGroupIds: [],
            TargetRole: 'READ_WRITE',
          },
        ],
      }),
    },
  },
  {
    name: 'S3 Vectors VectorBucket',
    make: () => new S3VectorsProvider(),
    resourceType: 'AWS::S3Vectors::VectorBucket',
    physicalId: 'my-vb',
    tagCommand: 'ListTagsForResourceCommand',
    notFoundName: 'NotFoundException',
    onNotFound: 'emptyTags',
    handlers: {
      GetVectorBucketCommand: () => ({
        vectorBucket: { vectorBucketName: 'my-vb', vectorBucketArn: ARN('s3vectors', 'bucket/my-vb') },
      }),
    },
  },
];

/** A tag read that answers `team=a`, in the response shape of the row's command. */
function tagsAnswer(row: Row): unknown {
  const list = [{ Key: 'team', Value: 'a' }];
  if (row.name.startsWith('AgentCore') || row.name.startsWith('S3 Vectors')) {
    return { tags: { team: 'a' } };
  }
  if (row.name.startsWith('WAFv2')) return { TagInfoForResource: { TagList: list } };
  if (
    row.name.startsWith('CloudWatch') ||
    row.name.startsWith('Kinesis') ||
    row.name.startsWith('Firehose')
  ) {
    return { Tags: list };
  }
  return { TagList: list };
}

async function read(row: Row, tagHandler: Handler) {
  const { client, sent } = fakeClient({ ...row.handlers, [row.tagCommand]: tagHandler });
  const provider = row.make();
  inject(provider, client);
  const readCurrentState = (
    provider as {
      readCurrentState: (
        physicalId: string,
        logicalId: string,
        resourceType: string,
        properties?: Record<string, unknown>
      ) => Promise<unknown>;
    }
  ).readCurrentState.bind(provider);
  const result = readCurrentState(row.physicalId, 'L', row.resourceType, row.properties ?? {});
  return { result, sent };
}

describe('a failed Tags sub-read reaches readFailed (go-to-k/cdkd#6759)', () => {
  describe.each(rows)('$name', (row) => {
    it('reads Tags when the tag read answers (the fixture reaches it)', async () => {
      const { result, sent } = await read(row, () => tagsAnswer(row));
      const live = (await result) as Record<string, unknown>;
      expect(sent).toContain(row.tagCommand);
      expect(live).toEqual(expect.objectContaining({ Tags: expect.anything() }));
      expect(JSON.stringify(live['Tags'])).toContain('team');
    });

    it.each(['AccessDeniedException', 'ThrottlingException'])(
      'rejects when the tag read fails with %s',
      async (errorName) => {
        const { result, sent } = await read(row, () => {
          throw awsError(errorName);
        });
        await expect(result).rejects.toMatchObject({ name: errorName });
        expect(sent).toContain(row.tagCommand);
      }
    );

    it('keeps the pre-#6759 result when the tag read answers not-found', async () => {
      const { result, sent } = await read(row, () => {
        throw row.notFoundClass !== undefined
          ? new row.notFoundClass({ message: 'gone', $metadata: {} })
          : awsError(row.notFoundName);
      });
      const live = await result;
      expect(sent).toContain(row.tagCommand);
      if (row.onNotFound === 'resourceNotFound') {
        expect(live).toBe(RESOURCE_NOT_FOUND);
      } else {
        expect(typeof live).toBe('object');
        const bag = live as Record<string, unknown>;
        if (row.onNotFound === 'omitTags') expect(Object.hasOwn(bag, 'Tags')).toBe(false);
        else expect(bag['Tags']).toEqual([]);
      }
    });
  });
});

describe('ECS readCurrentState throws on a non-not-found describe failure (go-to-k/cdkd#6759)', () => {
  const ecsRows = [
    {
      resourceType: 'AWS::ECS::Cluster',
      physicalId: 'my-cluster',
      command: 'DescribeClustersCommand',
      notFound: () => awsError('ClusterNotFoundException'),
    },
    {
      resourceType: 'AWS::ECS::Service',
      physicalId: ARN('ecs', 'service/my-cluster/my-svc'),
      command: 'DescribeServicesCommand',
      notFound: () => awsError('ServiceNotFoundException'),
    },
    {
      resourceType: 'AWS::ECS::TaskDefinition',
      physicalId: ARN('ecs', 'task-definition/fam:1'),
      command: 'DescribeTaskDefinitionCommand',
      notFound: () => awsError('ClientException', 'Unable to describe task definition.'),
    },
  ];

  function ecsRead(row: (typeof ecsRows)[number], error: Error) {
    const { client, sent } = fakeClient({
      [row.command]: () => {
        throw error;
      },
    });
    const provider = new ECSProvider();
    inject(provider, client);
    return { result: provider.readCurrentState(row.physicalId, 'L', row.resourceType), sent };
  }

  describe.each(ecsRows)('$resourceType', (row) => {
    it('rejects with the AWS error on AccessDenied (was a bare undefined)', async () => {
      const { result, sent } = ecsRead(row, awsError('AccessDeniedException'));
      await expect(result).rejects.toMatchObject({ name: 'AccessDeniedException' });
      expect(sent).toEqual([row.command]);
    });

    it('still answers RESOURCE_NOT_FOUND on its not-found error', async () => {
      const { result } = ecsRead(row, row.notFound());
      await expect(result).resolves.toBe(RESOURCE_NOT_FOUND);
    });
  });
});

describe('EC2 SecurityGroupIngress by-id read throws on a non-NotFound failure (go-to-k/cdkd#6759)', () => {
  const ID = 'sgr-0a1b2c3d4e5f60718';
  const declared = {
    GroupId: 'sg-1',
    IpProtocol: 'tcp',
    FromPort: 443,
    ToPort: 443,
    CidrIp: '10.0.0.0/16',
    Description: 'from the VPC',
  };
  // The listing holds the rule under another description, so only the
  // identity fallback's by-id call (go-to-k/cdkd#4447) can answer.
  const edited = {
    SecurityGroups: [
      {
        GroupId: 'sg-1',
        IpPermissions: [
          {
            IpProtocol: 'tcp',
            FromPort: 443,
            ToPort: 443,
            IpRanges: [
              { CidrIp: '10.0.0.0/16', Description: 'edited in the console' },
              { CidrIp: '192.168.0.0/16', Description: 'from the VPC' },
            ],
          },
        ],
      },
    ],
  };

  function ec2Read(error: Error) {
    const { client, sent } = fakeClient({
      DescribeSecurityGroupsCommand: () => edited,
      DescribeSecurityGroupRulesCommand: () => {
        throw error;
      },
    });
    const provider = new EC2Provider();
    (provider as unknown as { ec2Client: unknown }).ec2Client = client;
    vi.spyOn(provider, 'listGroupRules').mockResolvedValue(undefined);
    const result = provider.readCurrentState(
      'sg-1|tcp|443|443',
      'L',
      'AWS::EC2::SecurityGroupIngress',
      declared,
      { attributes: { Id: ID } }
    );
    return { result, sent };
  }

  it.each(['UnauthorizedOperation', 'RequestLimitExceeded'])(
    'rejects when the by-id read fails with %s (was a bare undefined)',
    async (name) => {
      const { result, sent } = ec2Read(awsError(name));
      await expect(result).rejects.toMatchObject({ name });
      expect(sent).toContain('DescribeSecurityGroupRulesCommand');
    }
  );

  it('still reads unknown when the recorded rule id is gone (.NotFound)', async () => {
    const { result, sent } = ec2Read(awsError('InvalidSecurityGroupRuleId.NotFound'));
    await expect(result).resolves.toBeUndefined();
    expect(sent).toContain('DescribeSecurityGroupRulesCommand');
  });
});
