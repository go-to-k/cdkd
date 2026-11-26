import type { OutputOverride } from './sdk-wire-harness.js';

/**
 * The read-back revert check's live resources (`sdk-wire-revert-readback.ts`,
 * #7025): per type whose `readCurrentState` finds nothing on the generated
 * fakes (a list read answering no entry), what its reads answer for a live
 * resource `physicalId` with only the members AWS always reports.
 */
export const READBACK_ARMS: Record<
  string,
  (physicalId: string) => Record<string, OutputOverride>
> = {
  'AWS::Logs::LogGroup': (id) => ({
    DescribeLogGroupsCommand: () => ({
      logGroups: [{ logGroupName: id, arn: `arn:aws:logs:us-east-1:123456789012:log-group:${id}:*` }],
    }),
  }),
  'AWS::ECS::Service': (id) => ({
    DescribeServicesCommand: () => ({
      services: [
        {
          serviceName: id.split('/').pop(),
          status: 'ACTIVE',
          clusterArn: id.replace(':service/', ':cluster/').replace(/\/[^/]*$/, ''),
          taskDefinition: 'arn:aws:ecs:us-east-1:123456789012:task-definition/td:1',
          desiredCount: 1,
        },
      ],
    }),
  }),
  'AWS::ElasticLoadBalancingV2::TargetGroup': (id) => ({
    DescribeTargetGroupsCommand: () => ({
      TargetGroups: [
        {
          TargetGroupArn: id,
          TargetGroupName: 'tg',
          Protocol: 'HTTP',
          Port: 80,
          VpcId: 'vpc-1',
          TargetType: 'instance',
        },
      ],
    }),
  }),
  'AWS::ElasticLoadBalancingV2::Listener': (id) => ({
    DescribeListenersCommand: () => ({
      Listeners: [
        {
          ListenerArn: id,
          LoadBalancerArn:
            'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/lb/0123456789abcdef',
          Port: 80,
          Protocol: 'HTTP',
          DefaultActions: [
            {
              Type: 'forward',
              TargetGroupArn:
                'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/tg/0123456789abcdef',
            },
          ],
        },
      ],
    }),
  }),
  'AWS::EC2::VPC': (id) => ({
    DescribeVpcsCommand: () => ({
      Vpcs: [{ VpcId: id, CidrBlock: '10.0.0.0/16', InstanceTenancy: 'default' }],
    }),
  }),
  'AWS::EC2::InternetGateway': (id) => ({
    DescribeInternetGatewaysCommand: () => ({ InternetGateways: [{ InternetGatewayId: id }] }),
  }),
  'AWS::EC2::VPCGatewayAttachment': (id) => ({
    DescribeInternetGatewaysCommand: () => ({
      InternetGateways: [
        {
          InternetGatewayId: id.split('|')[0],
          Attachments: [{ VpcId: id.split('|')[1], State: 'available' }],
        },
      ],
    }),
  }),
  'AWS::EC2::RouteTable': (id) => ({
    DescribeRouteTablesCommand: () => ({ RouteTables: [{ RouteTableId: id, VpcId: 'vpc-1' }] }),
  }),
  'AWS::EC2::Route': (id) => ({
    DescribeRouteTablesCommand: () => ({
      RouteTables: [
        {
          RouteTableId: id.split('|')[0],
          VpcId: 'vpc-1',
          Routes: [
            { DestinationCidrBlock: id.split('|')[1], GatewayId: 'igw-1', Origin: 'CreateRoute' },
          ],
        },
      ],
    }),
  }),
  'AWS::EC2::SubnetRouteTableAssociation': (id) => ({
    DescribeRouteTablesCommand: () => ({
      RouteTables: [
        {
          RouteTableId: 'rtb-1',
          Associations: [
            { RouteTableAssociationId: id, SubnetId: 'subnet-1', RouteTableId: 'rtb-1' },
          ],
        },
      ],
    }),
  }),
  'AWS::EC2::SecurityGroup': (id) => ({
    DescribeSecurityGroupsCommand: () => ({
      SecurityGroups: [{ GroupId: id, GroupName: 'sg', Description: 'sg', VpcId: 'vpc-1' }],
    }),
  }),
  'AWS::EC2::SecurityGroupIngress': (id) => ({
    DescribeSecurityGroupsCommand: () => ({
      SecurityGroups: [
        {
          GroupId: id.split('|')[0],
          GroupName: 'sg',
          Description: 'sg',
          VpcId: 'vpc-1',
          IpPermissions: [
            {
              IpProtocol: 'tcp',
              FromPort: 80,
              ToPort: 80,
              IpRanges: [{ CidrIp: '10.0.0.0/8', Description: 'd' }],
            },
          ],
        },
      ],
    }),
  }),
  'AWS::EC2::NetworkAcl': (id) => ({
    DescribeNetworkAclsCommand: () => ({ NetworkAcls: [{ NetworkAclId: id, VpcId: 'vpc-1' }] }),
  }),
  'AWS::EC2::NetworkAclEntry': (id) => ({
    DescribeNetworkAclsCommand: () => ({
      NetworkAcls: [
        {
          NetworkAclId: id.split('|')[0],
          Entries: [
            {
              RuleNumber: 100,
              Egress: true,
              Protocol: '6',
              RuleAction: 'allow',
              CidrBlock: '0.0.0.0/0',
            },
          ],
        },
      ],
    }),
  }),
  'AWS::EC2::SubnetNetworkAclAssociation': (id) => ({
    DescribeNetworkAclsCommand: () => ({
      NetworkAcls: [
        {
          NetworkAclId: 'acl-1',
          Associations: [
            { NetworkAclAssociationId: id, NetworkAclId: 'acl-1', SubnetId: 'subnet-1' },
          ],
        },
      ],
    }),
  }),
  'AWS::EFS::AccessPoint': (id) => ({
    DescribeAccessPointsCommand: () => ({
      AccessPoints: [{ AccessPointId: id, FileSystemId: 'fs-12345678' }],
    }),
  }),
  'AWS::CodeBuild::Project': (id) => ({
    BatchGetProjectsCommand: () => ({
      projects: [
        {
          name: id,
          serviceRole: 'arn:aws:iam::123456789012:role/r',
          source: { type: 'NO_SOURCE', buildspec: 'version: 0.2' },
          artifacts: { type: 'NO_ARTIFACTS' },
          environment: {
            type: 'LINUX_CONTAINER',
            image: 'aws/codebuild/standard:7.0',
            computeType: 'BUILD_GENERAL1_SMALL',
          },
        },
      ],
    }),
  }),
  'AWS::ElastiCache::SubnetGroup': (id) => ({
    DescribeCacheSubnetGroupsCommand: () => ({
      CacheSubnetGroups: [
        {
          CacheSubnetGroupName: id,
          CacheSubnetGroupDescription: 'd',
          Subnets: [{ SubnetIdentifier: 'subnet-1' }],
        },
      ],
    }),
  }),
  'AWS::Lambda::Permission': (id) => ({
    GetPolicyCommand: () => ({
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: id,
            Effect: 'Allow',
            Principal: '*',
            Action: 'lambda:InvokeFunctionUrl',
            Resource: 'arn:aws:lambda:us-east-1:123456789012:function:f',
          },
        ],
      }),
    }),
  }),
  'AWS::S3::BucketPolicy': (id) => ({
    GetBucketPolicyCommand: () => ({
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: 'arn:aws:iam::123456789012:role/r' },
            Action: 's3:GetObject',
            Resource: `arn:aws:s3:::${id}/live/*`,
          },
        ],
      }),
    }),
  }),
  'AWS::IAM::AccessKey': (id) => ({
    GetAccessKeyLastUsedCommand: () => ({ UserName: 'u' }),
    ListAccessKeysCommand: () => ({
      AccessKeyMetadata: [{ AccessKeyId: id, UserName: 'u', Status: 'Active' }],
      IsTruncated: false,
    }),
  }),
  'AWS::KMS::Alias': (id) => ({
    ListAliasesCommand: () => ({
      Aliases: [{ AliasName: id, TargetKeyId: '1234abcd-12ab-34cd-56ef-1234567890ab' }],
    }),
  }),
  'AWS::CloudWatch::AnomalyDetector': () => ({
    DescribeAnomalyDetectorsCommand: () => ({
      AnomalyDetectors: [
        {
          SingleMetricAnomalyDetector: {
            Namespace: 'AWS/Lambda',
            MetricName: 'Errors',
            Stat: 'Sum',
            Dimensions: [
              { Name: 'FunctionName', Value: 'f' },
              { Name: 'Resource', Value: 'r' },
            ],
          },
          StateValue: 'TRAINED',
        },
      ],
    }),
  }),
  'AWS::AppSync::ApiKey': () => ({
    ListApiKeysCommand: () => ({ apiKeys: [{ id: 'da2-key', expires: 1_900_000_000 }] }),
  }),
  'AWS::Lightsail::Alarm': (id) => ({
    GetAlarmsCommand: () => ({
      alarms: [
        {
          name: id,
          monitoredResourceInfo: { name: 'inst' },
          metricName: 'CPUUtilization',
          comparisonOperator: 'GreaterThanOrEqualToThreshold',
          evaluationPeriods: 1,
          threshold: 90,
        },
      ],
    }),
  }),
  'AWS::CloudWatch::Alarm': (id) => ({
    DescribeAlarmsCommand: () => ({
      MetricAlarms: [
        {
          AlarmName: id,
          MetricName: 'Errors',
          Namespace: 'AWS/Lambda',
          Statistic: 'Sum',
          ComparisonOperator: 'GreaterThanThreshold',
          Threshold: 1,
          EvaluationPeriods: 1,
          Period: 60,
        },
      ],
    }),
  }),
  'AWS::Glue::Connection': (id) => ({
    GetConnectionCommand: () => ({
      Connection: { Name: id, ConnectionType: 'JDBC', ConnectionProperties: {} },
    }),
  }),
  'AWS::KinesisFirehose::DeliveryStream': (id) => ({
    DescribeDeliveryStreamCommand: () => ({
      DeliveryStreamDescription: {
        DeliveryStreamName: id,
        DeliveryStreamARN: `arn:aws:firehose:us-east-1:123456789012:deliverystream/${id}`,
        DeliveryStreamStatus: 'ACTIVE',
        DeliveryStreamType: 'DirectPut',
        VersionId: '1',
        HasMoreDestinations: false,
        Destinations: [
          {
            DestinationId: 'destinationId-000000000001',
            ExtendedS3DestinationDescription: {
              RoleARN: 'arn:aws:iam::123456789012:role/firehose',
              BucketARN: 'arn:aws:s3:::bucket',
              BufferingHints: { SizeInMBs: 5, IntervalInSeconds: 300 },
              CompressionFormat: 'UNCOMPRESSED',
              EncryptionConfiguration: { NoEncryptionConfig: 'NoEncryption' },
              S3BackupMode: 'Disabled',
            },
          },
        ],
      },
    }),
  }),
};
