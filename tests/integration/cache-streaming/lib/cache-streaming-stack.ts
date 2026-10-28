import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';

/**
 * Cache and Streaming pattern stack
 *
 * Demonstrates:
 * - VPC with 2 AZs, public subnets only (no NAT to save cost)
 * - ElastiCache Redis cluster (L1 CfnCacheCluster)
 * - ElastiCache Subnet Group (L1 CfnSubnetGroup)
 * - Security Group for Redis access
 * - Kinesis Data Stream
 * - Lambda Function with Kinesis event source mapping
 * - CfnOutputs for Redis endpoint, stream name, function name
 * - CDKD_TEST_REMOVAL=true: the cluster template LACKS SnapshotRetentionLimit,
 *   AutoMinorVersionUpgrade, NotificationTopicArn and LogDeliveryConfigurations
 *   (issue #5004 -- see the cluster comment below)
 * - CDKD_TEST_NODETYPE=true: the cluster's CacheNodeType moves cache.t3.micro
 *   -> cache.t3.small, an in-place ModifyCacheCluster (issue #5438)
 * - A 2-node Memcached cluster on its own subnet group; CDKD_TEST_NODEREMOVE=true
 *   lowers it to 1 node, which needs CacheNodeIdsToRemove (issue #5441), and
 *   CDKD_TEST_PAZMOVE=true moves its PreferredAvailabilityZones to a zone the
 *   previous list does not name, which replaces the cluster (issue #5458)
 */
export class CacheStreamingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const tags = {
      Project: 'cdkd',
      Example: 'cache-streaming',
    };

    // VPC with 2 AZs (the Memcached zone move of issue #5458 needs a second
    // one), public subnets only (no NAT to save cost)
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });
    cdk.Tags.of(vpc).add('Project', tags.Project);
    cdk.Tags.of(vpc).add('Example', tags.Example);

    // Security Group for Redis
    const redisSg = new ec2.SecurityGroup(this, 'RedisSecurityGroup', {
      vpc,
      description: 'Security group for ElastiCache Redis cluster',
      allowAllOutbound: true,
    });
    redisSg.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(6379),
      'Allow Redis access from VPC',
    );
    cdk.Tags.of(redisSg).add('Project', tags.Project);
    cdk.Tags.of(redisSg).add('Example', tags.Example);

    // ElastiCache Subnet Group
    const subnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: 'Subnet group for Redis cluster',
      subnetIds: vpc.publicSubnets.map((s) => s.subnetId),
      cacheSubnetGroupName: `${this.stackName}-redis-subnet-group`,
    });

    // CDKD_TEST_REMOVAL (issue #5004). The baseline template sets
    // SnapshotRetentionLimit / AutoMinorVersionUpgrade / NotificationTopicArn
    // to NON-default values plus a slow-log LogDeliveryConfigurations entry.
    // The removal phase drops all four AND changes PreferredMaintenanceWindow,
    // a property ModifyCacheCluster sends, so the Modify call provably fires.
    // Real CloudFormation A/B: the first three are KEPT (live value stays,
    // topic status stays active); LogDeliveryConfigurations is RESET (delivery
    // disabled). The topic and log group are NOT mode-gated: only scalar
    // cluster properties change, so no later deploy deletes a resource.
    const removal = process.env.CDKD_TEST_REMOVAL === 'true';
    // CDKD_TEST_NODETYPE (issue #5438): a node-type scale-up. Real
    // CloudFormation applies it in place (same cluster id, ApplyImmediately).
    const nodeTypeChange = process.env.CDKD_TEST_NODETYPE === 'true';
    const topic = new sns.Topic(this, 'CacheNotifications');
    topic.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    const slowLogGroup = new logs.LogGroup(this, 'RedisSlowLog', {
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ElastiCache Redis cluster (L1 construct)
    const redis = new elasticache.CfnCacheCluster(this, 'RedisCluster', {
      cacheNodeType: nodeTypeChange ? 'cache.t3.small' : 'cache.t3.micro',
      engine: 'redis',
      engineVersion: '7.1',
      numCacheNodes: 1,
      vpcSecurityGroupIds: [redisSg.securityGroupId],
      cacheSubnetGroupName: subnetGroup.ref,
      // Companion change: baseline tue, removal wed. Not overlapping SnapshotWindow.
      preferredMaintenanceWindow: removal ? 'wed:05:00-wed:06:00' : 'tue:05:00-tue:06:00',
      snapshotWindow: '02:00-03:00',
      ...(removal
        ? {}
        : {
            snapshotRetentionLimit: 3, // default 0
            autoMinorVersionUpgrade: false, // default true
            notificationTopicArn: topic.topicArn,
            logDeliveryConfigurations: [
              {
                logType: 'slow-log',
                destinationType: 'cloudwatch-logs',
                logFormat: 'json',
                destinationDetails: {
                  cloudWatchLogsDetails: { logGroup: slowLogGroup.logGroupName },
                },
              },
            ],
          }),
    });
    redis.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // CDKD_TEST_NODEREMOVE (issue #5441): a Memcached scale-in. AWS refuses a
    // lower NumCacheNodes without CacheNodeIdsToRemove; real CloudFormation
    // names the lowest node ids and keeps the cluster. Its own subnet group
    // (same subnet), so the Redis assertions that find their cluster by
    // subnet group keep finding exactly one.
    const nodeRemoval = process.env.CDKD_TEST_NODEREMOVE === 'true';
    // CDKD_TEST_PAZMOVE (issue #5458): real CloudFormation REPLACES the
    // cluster when PreferredAvailabilityZones moves to zones the previous list
    // does not name ([az0] -> [az1]); the #5441 removal ([az0, az0] -> [az0])
    // shares az0 and stays in place.
    const pazMove = process.env.CDKD_TEST_PAZMOVE === 'true';
    const [az0, az1] = vpc.availabilityZones;
    const memcachedSubnetGroup = new elasticache.CfnSubnetGroup(this, 'MemcachedSubnetGroup', {
      description: 'Subnet group for the Memcached cluster',
      subnetIds: vpc.publicSubnets.map((s) => s.subnetId),
      cacheSubnetGroupName: `${this.stackName}-memcached-subnet-group`,
    });
    const memcached = new elasticache.CfnCacheCluster(this, 'MemcachedCluster', {
      cacheNodeType: 'cache.t3.micro',
      engine: 'memcached',
      numCacheNodes: nodeRemoval || pazMove ? 1 : 2,
      azMode: 'single-az',
      preferredAvailabilityZones: pazMove ? [az1] : nodeRemoval ? [az0] : [az0, az0],
      vpcSecurityGroupIds: [redisSg.securityGroupId],
      cacheSubnetGroupName: memcachedSubnetGroup.ref,
    });
    memcached.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // Kinesis Data Stream
    const stream = new kinesis.Stream(this, 'DataStream', {
      streamName: `${this.stackName}-data-stream`,
      shardCount: 1,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    cdk.Tags.of(stream).add('Project', tags.Project);
    cdk.Tags.of(stream).add('Example', tags.Example);

    // Lambda Function (inline Python) to process Kinesis records
    const processor = new lambda.Function(this, 'StreamProcessor', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import json
import base64

def handler(event, context):
    print(f"Received {len(event['Records'])} records")
    for record in event['Records']:
        payload = base64.b64decode(record['kinesis']['data']).decode('utf-8')
        print(f"Record: {payload}")
    return {'statusCode': 200, 'body': json.dumps({'processed': len(event['Records'])})}
`),
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      logRetention: logs.RetentionDays.ONE_WEEK,
      environment: {
        REDIS_ENDPOINT: redis.attrRedisEndpointAddress,
        REDIS_PORT: redis.attrRedisEndpointPort,
        STREAM_NAME: stream.streamName,
      },
    });
    cdk.Tags.of(processor).add('Project', tags.Project);
    cdk.Tags.of(processor).add('Example', tags.Example);

    // Kinesis event source mapping
    processor.addEventSource(
      new lambdaEventSources.KinesisEventSource(stream, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 10,
      }),
    );

    // Outputs
    new cdk.CfnOutput(this, 'RedisEndpoint', {
      value: redis.attrRedisEndpointAddress,
      description: 'ElastiCache Redis endpoint address',
    });

    new cdk.CfnOutput(this, 'NotificationTopicArn', {
      value: topic.topicArn,
      description: 'SNS topic the cache cluster notifies (issue #5004 removal arm)',
    });

    new cdk.CfnOutput(this, 'MemcachedMoveAz', {
      value: az1,
      description: 'Zone the Memcached cluster moves to under CDKD_TEST_PAZMOVE (issue #5458)',
    });

    new cdk.CfnOutput(this, 'StreamName', {
      value: stream.streamName,
      description: 'Kinesis Data Stream name',
    });

    new cdk.CfnOutput(this, 'ProcessorFunctionName', {
      value: processor.functionName,
      description: 'Lambda processor function name',
    });
  }
}
