import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as msk from 'aws-cdk-lib/aws-msk';
import * as s3 from 'aws-cdk-lib/aws-s3';

/** Deterministic names, so verify.sh's cleanup can find what a failed run left. */
export const STREAM_NAME = 'CdkdFirehoseMsk5636';
export const CLUSTER_NAME = 'cdkd-firehose-msk-5636';
export const TOPIC_NAME = 'cdkd-5636-events';
/** The VPC's Name tag, how verify.sh's cleanup finds a VPC no state recorded. */
export const VPC_NAME = 'cdkd-firehose-msk-5636';
/** IAM is global: the region suffix keeps runs in two regions apart. */
export const ROLE_NAME_PREFIX = 'CdkdFirehoseMsk5636Role';
/**
 * 2026-01-01T00:00:00Z as a string of epoch MILLISECONDS, the one spelling
 * CloudFormation reads (an ISO 8601 date is refused with `For input string`,
 * and `1761955200` reached Firehose as 1970-01-21; measured 2026-11-03).
 */
export const READ_FROM_TIMESTAMP = '1767225600000';

/**
 * Firehose `MSKSourceConfiguration` on the SDK route (issue #5636).
 *
 * covers: AWS::KinesisFirehose::DeliveryStream
 * covers: AWS::MSK::ServerlessCluster
 * covers: AWS::MSK::ClusterPolicy
 * covers: AWS::EC2::VPC
 * covers: AWS::EC2::Subnet
 * covers: AWS::EC2::SecurityGroup
 *
 * Before the fix the property was not in the provider's `handledProperties`,
 * so the stream routed through Cloud Control (recorded `provisionedBy:
 * "cc-api"`). The SDK route now sends it, `ReadFromTimestamp` converted from
 * epoch milliseconds to the SDK's `Date`.
 *
 * Mode list (`CDKD_TEST_UPDATE`): '' (phase 1) | 'true' (phase 2: a stream tag
 * added, an in-place `TagDeliveryStream`; the create-only MSK block is
 * unchanged and must not be sent or replace the stream).
 *
 * The cluster is MSK SERVERLESS (IAM auth only): it reaches ACTIVE in about two
 * minutes where a provisioned one takes 20-40. No topic is created: MSK's topic
 * APIs refuse a serverless cluster, and Firehose does not need the topic to
 * exist for the stream to reach ACTIVE (measured 2026-11-03: a PRIVATE
 * stream on a fresh serverless cluster with no topic went ACTIVE in ~2.5 min).
 * No record is ever put. The cluster policy lets the Firehose service reach the
 * cluster privately, as Firehose's MSK source docs require; the stream waits
 * for it.
 *
 * The VPC has two isolated subnets and no route out: MSK places its own
 * endpoint network interfaces there, and nothing else needs one.
 */
export class FirehoseMskSourceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = (process.env.CDKD_TEST_UPDATE ?? '').includes('true');

    const vpc = new ec2.CfnVPC(this, 'Vpc', {
      cidrBlock: '10.56.0.0/16',
      // MSK refuses a cluster in a VPC without DNS hostnames.
      enableDnsSupport: true,
      enableDnsHostnames: true,
      tags: [{ key: 'Name', value: VPC_NAME }],
    });
    const subnets = [0, 1].map(
      (i) =>
        new ec2.CfnSubnet(this, `Subnet${i}`, {
          vpcId: vpc.ref,
          cidrBlock: `10.56.${i}.0/24`,
          availabilityZone: cdk.Fn.select(i, cdk.Fn.getAzs()),
        })
    );
    const securityGroup = new ec2.CfnSecurityGroup(this, 'ClusterSg', {
      vpcId: vpc.ref,
      groupDescription: 'cdkd 5636 MSK serverless cluster',
    });

    const cluster = new msk.CfnServerlessCluster(this, 'Cluster', {
      clusterName: CLUSTER_NAME,
      vpcConfigs: [
        { subnetIds: subnets.map((s) => s.ref), securityGroups: [securityGroup.ref] },
      ],
      clientAuthentication: { sasl: { iam: { enabled: true } } },
    });

    const clusterPolicy = new msk.CfnClusterPolicy(this, 'ClusterPolicy', {
      clusterArn: cluster.attrArn,
      policy: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'firehose.amazonaws.com' },
            Action: ['kafka:CreateVpcConnection', 'kafka:GetBootstrapBrokers', 'kafka:DescribeClusterV2'],
            Resource: cluster.attrArn,
          },
        ],
      },
    });

    const bucket = new s3.CfnBucket(this, 'Bucket');
    bucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const clusterScoped = (kind: string): string =>
      `arn:${this.partition}:kafka:${this.region}:${this.account}:${kind}/${CLUSTER_NAME}/*`;

    const role = new iam.CfnRole(this, 'Role', {
      roleName: `${ROLE_NAME_PREFIX}-${this.region}`,
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'firehose.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      },
      policies: [
        {
          policyName: 'msk-source',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['kafka:GetBootstrapBrokers', 'kafka:DescribeCluster', 'kafka:DescribeClusterV2'],
                Resource: cluster.attrArn,
              },
              {
                Effect: 'Allow',
                Action: [
                  'kafka-cluster:Connect',
                  'kafka-cluster:DescribeTopic',
                  'kafka-cluster:DescribeTopicDynamicConfiguration',
                  'kafka-cluster:ReadData',
                  'kafka-cluster:DescribeGroup',
                  'kafka-cluster:AlterGroup',
                ],
                Resource: [cluster.attrArn, clusterScoped('topic'), clusterScoped('group')],
              },
              {
                Effect: 'Allow',
                Action: [
                  's3:AbortMultipartUpload',
                  's3:GetBucketLocation',
                  's3:GetObject',
                  's3:ListBucket',
                  's3:ListBucketMultipartUploads',
                  's3:PutObject',
                ],
                Resource: [bucket.attrArn, `${bucket.attrArn}/*`],
              },
            ],
          },
        },
      ],
    });

    const stream = new firehose.CfnDeliveryStream(this, 'Stream', {
      deliveryStreamName: STREAM_NAME,
      deliveryStreamType: 'MSKAsSource',
      mskSourceConfiguration: {
        mskClusterArn: cluster.attrArn,
        topicName: TOPIC_NAME,
        authenticationConfiguration: { roleArn: role.attrArn, connectivity: 'PRIVATE' },
        readFromTimestamp: READ_FROM_TIMESTAMP,
      },
      extendedS3DestinationConfiguration: {
        bucketArn: bucket.attrArn,
        roleArn: role.attrArn,
        bufferingHints: { intervalInSeconds: 60, sizeInMBs: 1 },
      },
      ...(isUpdate && { tags: [{ key: 'cdkd-5636-phase', value: '2' }] }),
    });
    stream.addResourceDependency(clusterPolicy);

    new cdk.CfnOutput(this, 'StreamName', { value: stream.ref });
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.ref });
    new cdk.CfnOutput(this, 'RoleArn', { value: role.attrArn });
    new cdk.CfnOutput(this, 'ClusterArn', { value: cluster.attrArn });
    new cdk.CfnOutput(this, 'VpcId', { value: vpc.ref });
  }
}
