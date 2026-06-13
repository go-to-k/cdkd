import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Drift-revert E2E test stack for TAG-heavy and ARRAY-heavy resource
 * types — the resources whose drift comparison is sensitive to tag-list
 * order, resource-id array order, and ARN array order.
 *
 * This fixture exists to exercise the issue #802 canonicalization path
 * (`src/analyzer/drift-normalize.ts`: `canonicalizeTagListsDeep` +
 * `canonicalizeIdArraysDeep`) end-to-end against real AWS. The existing
 * `drift-revert` / `drift-revert-vpc` fixtures exercise the
 * `readCurrentState` -> compare -> `--revert` round-trip per provider but
 * none of their resources carry the unordered-set array shapes #802
 * fixed: AWS returns tag lists ({Key,Value}[]) and resource-id / ARN
 * arrays in a non-deterministic order across reads, and the comparator in
 * `drift-calculator.ts` compares arrays POSITIONALLY, so without
 * canonicalization a benign reorder surfaces as phantom drift.
 *
 * Resources (all cheap, no VPC NAT):
 *
 *  - S3 Bucket with SIX user tags. The tag list is an unordered set —
 *    `PutBucketTagging` may return them in any order. inject-drift.ts can
 *    re-PUT the SAME six tags in a DIFFERENT order to induce a benign
 *    AWS-side reorder; `canonicalizeTagListsDeep` must absorb it so
 *    `cdkd drift` still reports clean. The TRUE-drift mutation changes a
 *    tag VALUE (not just order), which must still surface.
 *
 *  - SNS Topic with SIX user tags + a DisplayName. Same tag-list-order
 *    canonicalization surface as S3, via the SNS provider's `ListTagsForResource`
 *    readback.
 *
 *  - SQS Queue with SIX user tags. SQS tags are a key->value MAP on the
 *    wire (no order), included as a third tag-bearing type so the
 *    canonicalizer is exercised across the {Key,Value}[] (S3/SNS) AND map
 *    (SQS) shapes.
 *
 *  - IAM ManagedPolicy with a MULTI-statement PolicyDocument whose
 *    statements carry multiple `Action[]` (plain scalar arrays —
 *    intentionally NOT canonicalized, order-significant) and multiple
 *    `Resource[]` (ARN arrays — canonicalized by `canonicalizeIdArraysDeep`,
 *    which sorts any array whose every element is an AWS resource id or
 *    ARN). Plus SIX user tags. This is the primary ARN-array surface:
 *    `GetPolicyVersion` returns the document with AWS's own ordering of the
 *    Resource ARNs, which need not match the deploy-time snapshot's order.
 *    The TRUE-drift mutation rewrites a statement Action so the comparator
 *    fires on a real change.
 *
 *  - VPC (natGateways: 0, no NAT cost) + one SecurityGroup with FOUR CIDR
 *    ingress rules + SIX tags. `DescribeSecurityGroups` returns the
 *    `IpPermissions[]` in AWS-chosen order (reverse-mapped to the CFn
 *    `SecurityGroupIngress` rule-list by the EC2 provider), and the SG
 *    tag list is reorder-prone. The TRUE-drift mutation authorizes a NEW
 *    ingress rule out of band so the comparator surfaces an added rule.
 *
 * Every resource carries removalPolicy / autoDelete so destroy is clean.
 */
export class DriftRevertArraysStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ─── S3 Bucket with many tags ──────────────────────────────────────
    const bucket = new s3.Bucket(this, 'ArraysBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    // Six tags whose Key sort order differs from declaration order, so the
    // canonicalizer's by-Key sort is actually exercised.
    cdk.Tags.of(bucket).add('Zone', 'z1');
    cdk.Tags.of(bucket).add('Owner', 'cdkd-integ');
    cdk.Tags.of(bucket).add('Component', 'drift-revert-arrays');
    cdk.Tags.of(bucket).add('App', 'cdkd');
    cdk.Tags.of(bucket).add('Tier', 'test');
    cdk.Tags.of(bucket).add('Env', 'integ');

    // ─── SNS Topic with many tags ──────────────────────────────────────
    const topic = new sns.Topic(this, 'ArraysTopic', {
      displayName: 'integ-arrays-display',
    });
    cdk.Tags.of(topic).add('Zone', 'z1');
    cdk.Tags.of(topic).add('Owner', 'cdkd-integ');
    cdk.Tags.of(topic).add('Component', 'drift-revert-arrays');
    cdk.Tags.of(topic).add('App', 'cdkd');
    cdk.Tags.of(topic).add('Tier', 'test');
    cdk.Tags.of(topic).add('Env', 'integ');

    // ─── SQS Queue with many tags ──────────────────────────────────────
    const queue = new sqs.Queue(this, 'ArraysQueue', {
      retentionPeriod: cdk.Duration.days(1),
    });
    cdk.Tags.of(queue).add('Zone', 'z1');
    cdk.Tags.of(queue).add('Owner', 'cdkd-integ');
    cdk.Tags.of(queue).add('Component', 'drift-revert-arrays');
    cdk.Tags.of(queue).add('App', 'cdkd');
    cdk.Tags.of(queue).add('Tier', 'test');
    cdk.Tags.of(queue).add('Env', 'integ');

    // ─── IAM ManagedPolicy with multi-statement / multi-ARN document ───
    // The Resource arrays are ARN arrays (canonicalized); the Action arrays
    // are plain scalar lists (left untouched). Statement order + Resource
    // order are AWS-normalized on readback.
    const managedPolicy = new iam.ManagedPolicy(this, 'ArraysPolicy', {
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
          resources: [
            'arn:aws:s3:::cdkd-drift-arrays-bucket-c/*',
            'arn:aws:s3:::cdkd-drift-arrays-bucket-a/*',
            'arn:aws:s3:::cdkd-drift-arrays-bucket-b/*',
          ],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['sqs:SendMessage', 'sqs:ReceiveMessage'],
          resources: [
            'arn:aws:sqs:us-east-1:111111111111:cdkd-drift-arrays-q-c',
            'arn:aws:sqs:us-east-1:111111111111:cdkd-drift-arrays-q-a',
            'arn:aws:sqs:us-east-1:111111111111:cdkd-drift-arrays-q-b',
          ],
        }),
      ],
    });
    cdk.Tags.of(managedPolicy).add('Zone', 'z1');
    cdk.Tags.of(managedPolicy).add('Owner', 'cdkd-integ');
    cdk.Tags.of(managedPolicy).add('Component', 'drift-revert-arrays');
    cdk.Tags.of(managedPolicy).add('App', 'cdkd');
    cdk.Tags.of(managedPolicy).add('Tier', 'test');
    cdk.Tags.of(managedPolicy).add('Env', 'integ');

    // ─── VPC (no NAT) + SecurityGroup with several ingress rules + tags ─
    const vpc = new ec2.Vpc(this, 'ArraysVpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    const securityGroup = new ec2.SecurityGroup(this, 'ArraysSecurityGroup', {
      vpc,
      description: 'drift-revert-arrays SG with several ingress rules',
      allowAllOutbound: true,
    });
    // Four CIDR ingress rules. AWS returns IpPermissions[] in its own
    // order; the EC2 provider reverse-maps to the SecurityGroupIngress
    // rule-list, which the comparator must treat as an unordered set.
    securityGroup.addIngressRule(ec2.Peer.ipv4('10.0.0.0/24'), ec2.Port.tcp(443), 'https-a');
    securityGroup.addIngressRule(ec2.Peer.ipv4('10.0.1.0/24'), ec2.Port.tcp(8080), 'http-b');
    securityGroup.addIngressRule(ec2.Peer.ipv4('10.0.2.0/24'), ec2.Port.tcp(5432), 'pg-c');
    securityGroup.addIngressRule(ec2.Peer.ipv4('10.0.3.0/24'), ec2.Port.tcp(6379), 'redis-d');
    cdk.Tags.of(securityGroup).add('Zone', 'z1');
    cdk.Tags.of(securityGroup).add('Owner', 'cdkd-integ');
    cdk.Tags.of(securityGroup).add('Component', 'drift-revert-arrays');
    cdk.Tags.of(securityGroup).add('App', 'cdkd');
    cdk.Tags.of(securityGroup).add('Tier', 'test');
    cdk.Tags.of(securityGroup).add('Env', 'integ');

    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'Name of the S3 bucket targeted by inject-drift.ts',
    });
    new cdk.CfnOutput(this, 'TopicArn', {
      value: topic.topicArn,
      description: 'ARN of the SNS topic targeted by inject-drift.ts',
    });
    new cdk.CfnOutput(this, 'QueueUrl', {
      value: queue.queueUrl,
      description: 'URL of the SQS queue targeted by inject-drift.ts',
    });
    new cdk.CfnOutput(this, 'QueueArn', {
      value: queue.queueArn,
      description: 'ARN of the SQS queue targeted by inject-drift.ts',
    });
    new cdk.CfnOutput(this, 'ManagedPolicyArn', {
      value: managedPolicy.managedPolicyArn,
      description: 'ARN of the IAM managed policy targeted by inject-drift.ts',
    });
    new cdk.CfnOutput(this, 'SecurityGroupId', {
      value: securityGroup.securityGroupId,
      description: 'Id of the SecurityGroup targeted by inject-drift.ts',
    });
  }
}
