import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

/**
 * Issue #6242, measured against CloudFormation (us-east-1, 2026-11-14): the
 * whole-object read-only attributes cdkd refused --
 *  - `AWS::ElastiCache::CacheCluster` `RedisEndpoint` (a Redis cluster) and
 *    `ConfigurationEndpoint` (a Memcached cluster): `{"Address", "Port"}`,
 *    Port a STRING;
 *  - `AWS::Kinesis::Stream` `WarmThroughputObject`:
 *    `{"TargetMiBps": 0, "CurrentMiBps": 0}` (NUMBERS) for a stream AWS
 *    reports no warm throughput for;
 *  - `AWS::Lambda::Function` `SnapStartResponse`: `{"ApplyOn", "OptimizationStatus"}`;
 *  - `AWS::EC2::Instance` `State`: `{"Code": "16", "Name": "running"}`, Code a STRING.
 *
 * Objects cannot be stack outputs, so they reach a custom resource's
 * properties -- the way CloudFormation passes them to a consumer -- and the
 * echo handler returns each as compact sorted JSON in `Data`, which the
 * outputs read. The dotted `RedisEndpoint.Port` / `SnapStartResponse.ApplyOn`
 * ride along to pin that a member and its object agree. Under
 * `CDKD_TEST_UPDATE=true` every probed resource takes an in-place update (the
 * attribute map REPLACES the record on update) and the echo re-runs.
 *
 * covers: AWS::ElastiCache::CacheCluster
 * covers: AWS::Kinesis::Stream
 * covers: AWS::Lambda::Function
 * covers: AWS::EC2::Instance
 */
export class GetattCacheKinesisLambdaEc2Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';
    const phase = isUpdate ? 'update' : 'create';

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ cidrMask: 24, name: 'Public', subnetType: ec2.SubnetType.PUBLIC }],
    });
    const sg = new ec2.SecurityGroup(this, 'Sg', { vpc, description: 'cdkd #6242 probe' });
    const subnetGroup = new elasticache.CfnSubnetGroup(this, 'CacheSubnets', {
      description: 'cdkd #6242 probe',
      subnetIds: vpc.publicSubnets.map((s) => s.subnetId),
    });

    const redis = new elasticache.CfnCacheCluster(this, 'Redis', {
      engine: 'redis',
      cacheNodeType: 'cache.t3.micro',
      numCacheNodes: 1,
      cacheSubnetGroupName: subnetGroup.ref,
      vpcSecurityGroupIds: [sg.securityGroupId],
      // An in-place ModifyCacheCluster on the update phase.
      preferredMaintenanceWindow: isUpdate ? 'sun:05:00-sun:06:00' : 'sun:04:00-sun:05:00',
    });
    const memcached = new elasticache.CfnCacheCluster(this, 'Memcached', {
      engine: 'memcached',
      cacheNodeType: 'cache.t3.micro',
      numCacheNodes: 1,
      cacheSubnetGroupName: subnetGroup.ref,
      vpcSecurityGroupIds: [sg.securityGroupId],
      preferredMaintenanceWindow: isUpdate ? 'sun:05:00-sun:06:00' : 'sun:04:00-sun:05:00',
    });

    const stream = new kinesis.CfnStream(this, 'Stream', {
      shardCount: 1,
      retentionPeriodHours: isUpdate ? 48 : 24,
    });

    const role = new iam.Role(this, 'EchoRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    // The echo handler is also the probed function: its SnapStartResponse is
    // the no-SnapStart `{"ApplyOn": "None", "OptimizationStatus": "Off"}`.
    const echo = new lambda.CfnFunction(this, 'Echo', {
      runtime: 'python3.12',
      handler: 'index.handler',
      role: role.roleArn,
      timeout: isUpdate ? 31 : 30,
      code: {
        zipFile: [
          'import json, urllib.request',
          'def handler(event, context):',
          '    props = event.get("ResourceProperties", {})',
          '    data = {}',
          '    if event["RequestType"] != "Delete":',
          '        data = {k: (v if isinstance(v, str) else json.dumps(v, sort_keys=True, separators=(",", ":"))) for k, v in props.items() if k not in ("ServiceToken", "ServiceTimeout")}',
          '    body = json.dumps({"Status": "SUCCESS", "Reason": "ok", "PhysicalResourceId": event.get("PhysicalResourceId", "echo"),',
          '        "StackId": event["StackId"], "RequestId": event["RequestId"], "LogicalResourceId": event["LogicalResourceId"], "Data": data}).encode()',
          '    req = urllib.request.Request(event["ResponseURL"], data=body, method="PUT", headers={"Content-Type": "", "Content-Length": str(len(body))})',
          '    urllib.request.urlopen(req)',
        ].join('\n'),
      },
    });

    const instance = new ec2.CfnInstance(this, 'Instance', {
      imageId: ec2.MachineImage.latestAmazonLinux2023().getImage(this).imageId,
      instanceType: 't3.micro',
      subnetId: vpc.publicSubnets[0].subnetId,
      securityGroupIds: [sg.securityGroupId],
      // A tag-only in-place update on the update phase.
      tags: [{ key: 'cdkd-6242-phase', value: phase }],
    });

    const probe = new cdk.CfnCustomResource(this, 'Probe', { serviceToken: echo.attrArn });
    const probeProps: Record<string, unknown> = {
      ServiceTimeout: 60,
      Phase: phase,
      RedisEndpoint: redis.getAtt('RedisEndpoint'),
      RedisEndpointPort: redis.getAtt('RedisEndpoint.Port'),
      ConfigurationEndpoint: memcached.getAtt('ConfigurationEndpoint'),
      WarmThroughputObject: stream.getAtt('WarmThroughputObject'),
      SnapStartResponse: echo.getAtt('SnapStartResponse'),
      SnapStartApplyOn: echo.getAtt('SnapStartResponse.ApplyOn'),
      InstanceState: instance.getAtt('State'),
    };
    for (const [k, v] of Object.entries(probeProps)) probe.addPropertyOverride(k, v);

    new cdk.CfnOutput(this, 'RedisId', { value: redis.ref });
    new cdk.CfnOutput(this, 'MemcachedId', { value: memcached.ref });
    new cdk.CfnOutput(this, 'StreamName', { value: stream.ref });
    new cdk.CfnOutput(this, 'FunctionName', { value: echo.ref });
    new cdk.CfnOutput(this, 'InstanceId', { value: instance.ref });
    for (const k of Object.keys(probeProps)) {
      if (k === 'ServiceTimeout') continue;
      new cdk.CfnOutput(this, `Probe${k}`, { value: probe.getAtt(k).toString() });
    }
  }
}
