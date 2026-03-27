import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';

/**
 * Cache and Streaming pattern stack
 *
 * Demonstrates:
 * - VPC with 1 AZ, public subnet only (no NAT to save cost)
 * - ElastiCache Redis cluster (L1 CfnCacheCluster)
 * - ElastiCache Subnet Group (L1 CfnSubnetGroup)
 * - Security Group for Redis access
 * - Kinesis Data Stream
 * - Lambda Function with Kinesis event source mapping
 * - CfnOutputs for Redis endpoint, stream name, function name
 */
export class CacheStreamingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const tags = {
      Project: 'cdkd',
      Example: 'cache-streaming',
    };

    // VPC with 1 AZ, public subnet only (no NAT to save cost)
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
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

    // ElastiCache Redis cluster (L1 construct)
    const redis = new elasticache.CfnCacheCluster(this, 'RedisCluster', {
      cacheNodeType: 'cache.t3.micro',
      engine: 'redis',
      numCacheNodes: 1,
      vpcSecurityGroupIds: [redisSg.securityGroupId],
      cacheSubnetGroupName: subnetGroup.ref,
    });
    redis.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

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
