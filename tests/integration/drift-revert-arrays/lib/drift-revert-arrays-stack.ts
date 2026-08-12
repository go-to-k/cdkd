import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

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
 *  - A standalone ELBv2 TargetGroup (`targetType: 'ip'`, no load balancer)
 *    with THREE registered IP targets. `Targets` is an array of OBJECTS,
 *    the shape issue #1620 added to `canonicalizeUnorderedArraysAtPaths` —
 *    `DescribeTargetHealth` documents no ordering guarantee, so without the
 *    object-array pass a reorder between the deploy-time snapshot and a
 *    later read is phantom drift. The TRUE-drift mutation REGISTERS a
 *    fourth, untemplated IP out of band, so the comparator surfaces an
 *    added member and `--revert` deregisters it.
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
    // ─── Numeric IpProtocol, INLINE-rule shape (issue #1643) ──────────
    // AWS renames the four protocol numbers it has a name for, so a rule
    // declaring `IpProtocol: '6'` is stored and read back as `tcp`. The L2
    // `addIngressRule` above can only emit a name, so the numeric shape has to
    // be injected at the L1. Without `drift-protocol-normalize.ts`
    // canonicalizing BOTH comparison sides, the recorded `'6'` and the
    // read-back `tcp` are two spellings of ONE protocol and step 3a below (a
    // clean deploy must be drift-free) fails on every run.
    const sgL1 = securityGroup.node.defaultChild as ec2.CfnSecurityGroup;
    sgL1.addPropertyOverride('SecurityGroupIngress.4', {
      IpProtocol: '6',
      FromPort: 9443,
      ToPort: 9443,
      CidrIp: '10.0.9.0/24',
      Description: 'numeric-protocol-6-inline (issue #1643)',
    });

    cdk.Tags.of(securityGroup).add('Zone', 'z1');
    cdk.Tags.of(securityGroup).add('Owner', 'cdkd-integ');
    cdk.Tags.of(securityGroup).add('Component', 'drift-revert-arrays');

    // ─── Numeric IpProtocol, STANDALONE-rule shape (issue #1643) ──────
    // The same renaming breaks the standalone type one layer LOWER: its
    // physicalId is `<groupId>|<protocol>|<from>|<to>` built from the value
    // cdkd SENT (`6`), while `readSecurityGroupIngressCurrentState` filters
    // AWS's `IpPermissions[]` whose `IpProtocol` is `tcp` — so the lookup
    // matched nothing, returned undefined, and `cdkd drift` reported the rule
    // as "drift unknown" forever. That is invisible to a comparison-side fix
    // (no AWS-side bag is ever produced), so the provider canonicalizes both
    // sides of the tuple compare too.
    //
    // This rule gets its OWN security group, deliberately: attaching it to the
    // group above would materialize a FIFTH member into that group's live
    // `IpPermissions` while its template still declares four, which is real
    // drift on the parent (the issue #1498 sibling-materialization class) and
    // would fail this fixture for an unrelated reason. A group whose template
    // declares NO ingress is exactly the shape `undeclaredEmptyObservedKeys`
    // covers — the case its comment already names as "standalone SG rules".
    const numericProtocolSg = new ec2.SecurityGroup(this, 'NumericProtocolSg', {
      vpc,
      description: 'drift-revert-arrays SG for the standalone numeric-protocol rule',
      allowAllOutbound: true,
    });
    new ec2.CfnSecurityGroupIngress(this, 'NumericProtocolIngress', {
      groupId: numericProtocolSg.securityGroupId,
      ipProtocol: '6',
      fromPort: 9444,
      toPort: 9444,
      cidrIp: '10.0.10.0/24',
      description: 'numeric-protocol-6-standalone (issue #1643)',
    });
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
    // ─── Standalone ELBv2 TargetGroup with an unordered OBJECT list ────
    // `Targets` is an array of `{Id, Port?, AvailabilityZone?}` OBJECTS, the
    // shape issue #1620 taught `canonicalizeUnorderedArraysAtPaths` to sort.
    // No load balancer is attached (a target group is a standalone,
    // no-cost resource), so the registered targets sit in `unused` health —
    // which is exactly the state the provider's readback must still count as
    // REGISTERED. The three IPs are declared out of lexical order on purpose,
    // so the template order cannot coincide with AWS's readback order.
    const targetGroup = new elbv2.CfnTargetGroup(this, 'ArraysTargetGroup', {
      protocol: 'HTTP',
      port: 80,
      vpcId: vpc.vpcId,
      targetType: 'ip',
      // `HealthCheckEnabled: false` is REJECTED by AWS for target type 'ip'
      // ("Health check enabled must be true for target groups with target
      // type 'ip'", live-verified 2026-08-11), so the default stands. With no
      // load balancer attached no health check actually runs and the targets
      // sit in `unused` — which is precisely the state the readback must
      // still count as REGISTERED.
      targets: [{ id: '10.0.0.11' }, { id: '10.0.0.10' }, { id: '10.0.0.12' }],
      tags: [
        { key: 'Owner', value: 'cdkd-integ' },
        { key: 'Component', value: 'drift-revert-arrays' },
      ],
    });
    targetGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new cdk.CfnOutput(this, 'SecurityGroupId', {
      value: securityGroup.securityGroupId,
      description: 'Id of the SecurityGroup targeted by inject-drift.ts',
    });
    new cdk.CfnOutput(this, 'TargetGroupArn', {
      value: targetGroup.ref,
      description: 'ARN of the TargetGroup targeted by inject-drift.ts (#1620)',
    });
  }
}
