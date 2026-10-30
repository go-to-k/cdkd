import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';

/**
 * Generated physical names across a stack's lifetime (issue #5064).
 *
 * covers: AWS::DynamoDB::Table, AWS::SQS::Queue, AWS::SNS::Topic,
 * AWS::Logs::LogGroup, AWS::IAM::Role, AWS::IAM::Policy,
 * AWS::IAM::ManagedPolicy, AWS::Lambda::Function, AWS::Events::Rule,
 * AWS::S3::Bucket, AWS::ElasticLoadBalancingV2::TargetGroup,
 * AWS::ElasticLoadBalancingV2::LoadBalancer,
 * AWS::ElasticLoadBalancingV2::Listener, AWS::CloudFormation::Stack
 *
 * NOTHING here declares a physical name: every name is the one cdkd
 * GENERATES. On a stack whose state carries a `stackInstanceId` that name is
 * `{stack}-{logicalId}-{12 hex}`, the hex hashing the id, the logical id and
 * the resource's name GENERATION; a legacy (v12) stack keeps
 * `{stack}-{logicalId}`. verify.sh computes every expected name itself
 * (`names.mjs`), so the logical ids are pinned with `overrideLogicalId`.
 *
 * Every input is an environment variable verify.sh sets, read at synth time,
 * so the pinned v12 binary and the local one synthesize the same template:
 *
 *   GNL_EDIT        a token folded into in-place-updatable properties
 *   GNL_TABLE_KEY   Table's partition key (create-only: a replacement)
 *   GNL_ROLE_PATH   Role's Path (create-only: a replacement)
 *   GNL_TG_PORT     Tg's port (create-only: a replacement)
 *   GNL_ALB         '1' adds the load balancer and its listener (Tg behind it)
 *   GNL_ALB_INTERNAL '1' makes the load balancer internal (Scheme: a replacement)
 *   GNL_NESTED      '1' adds the nested stack Child (an un-named ChildRole)
 *   GNL_CHILD_PATH  ChildRole's Path
 *   GNL_EXTRA       '1' adds ExtraQ (Delete) and ExtraKeptQ (Retain)
 *   GNL_ORPHANQ     '1' adds OrphanQ (Retain)
 *   GNL_FAIL        '1' adds Fail, a queue AWS refuses, after GNL_FAIL_AFTER
 */
export class GeneratedNameLifecycleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const env = (name: string, fallback: string): string => process.env[name] ?? fallback;
    const edit = env('GNL_EDIT', '1');
    const pin = (construct: Construct, logicalId: string): cdk.CfnResource => {
      const cfn = construct.node.defaultChild as cdk.CfnResource;
      cfn.overrideLogicalId(logicalId);
      return cfn;
    };
    const byId = new Map<string, cdk.CfnResource>();
    const keep = (logicalId: string, cfn: cdk.CfnResource): void => {
      byId.set(logicalId, cfn);
    };

    const table = new dynamodb.Table(this, 'TableL2', {
      partitionKey: { name: env('GNL_TABLE_KEY', 'pk'), type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    keep('Table', pin(table, 'Table'));

    const queue = new sqs.Queue(this, 'QueueL2', {
      visibilityTimeout: cdk.Duration.seconds(30 + Number(edit)),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    keep('Queue', pin(queue, 'Queue'));

    const topic = new sns.Topic(this, 'TopicL2', { displayName: `gnl-${edit}` });
    keep('Topic', pin(topic, 'Topic'));

    const logGroup = new logs.LogGroup(this, 'LogGroupL2', {
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    keep('LogGroup', pin(logGroup, 'LogGroup'));

    const role = new iam.Role(this, 'RoleL2', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      path: env('GNL_ROLE_PATH', '/a/'),
      description: `gnl-${edit}`,
    });
    keep('Role', pin(role, 'Role'));
    // An inline policy (AWS::IAM::Policy) and a managed policy, both un-named,
    // that follow the role across its replacement.
    role.addToPolicy(
      new iam.PolicyStatement({ actions: ['sqs:GetQueueUrl'], resources: [queue.queueArn] })
    );
    const managed = new iam.ManagedPolicy(this, 'ManagedL2', {
      statements: [
        new iam.PolicyStatement({ actions: ['sns:GetTopicAttributes'], resources: [topic.topicArn] }),
      ],
      roles: [role],
    });
    keep('Managed', pin(managed, 'Managed'));

    const fn = new lambda.Function(this, 'FnL2', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({ ok: true });'),
      role,
      description: `gnl-${edit}`,
    });
    keep('Fn', pin(fn, 'Fn'));

    const rule = new events.Rule(this, 'RuleL2', {
      schedule: events.Schedule.rate(cdk.Duration.days(1)),
      enabled: false,
      description: `gnl-${edit}`,
    });
    keep('Rule', pin(rule, 'Rule'));

    const bucket = new s3.Bucket(this, 'BucketL2', { removalPolicy: cdk.RemovalPolicy.DESTROY });
    keep('Bucket', pin(bucket, 'Bucket'));

    // No NAT, public subnets only: VPC + IGW + subnets + route tables.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC }],
    });

    const tg = new elbv2.ApplicationTargetGroup(this, 'TgL2', {
      vpc,
      port: Number(env('GNL_TG_PORT', '80')),
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
    });
    keep('Tg', pin(tg, 'Tg'));
    // A logical id far past ELBv2's 32-character cap: the generated name keeps
    // its 12-hex suffix and cuts the readable part.
    const longTg = new elbv2.ApplicationTargetGroup(this, 'LongTgL2', {
      vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
    });
    keep(
      'TargetGroupWithAVeryLongLogicalIdPastTheCap',
      pin(longTg, 'TargetGroupWithAVeryLongLogicalIdPastTheCap')
    );

    if (env('GNL_ALB', '0') === '1') {
      // The target group sits behind a listener, so the replaced one's delete
      // is refused while the listener still forwards to it (ResourceInUse) and
      // is retried after the listener moved: the deferred delete.
      const alb = new elbv2.ApplicationLoadBalancer(this, 'AlbL2', {
        vpc,
        internetFacing: env('GNL_ALB_INTERNAL', '0') !== '1',
      });
      keep('Alb', pin(alb, 'Alb'));
      const listener = alb.addListener('ListenerL2', { port: 80, defaultTargetGroups: [tg] });
      pin(listener, 'Listener');
    }

    if (env('GNL_NESTED', '0') === '1') {
      const child = new ChildStack(this, 'ChildL2', { path: env('GNL_CHILD_PATH', '/a/') });
      (child.nestedStackResource as cdk.CfnResource).overrideLogicalId('Child');
    }

    if (env('GNL_EXTRA', '0') === '1') {
      keep(
        'ExtraQ',
        pin(new sqs.Queue(this, 'ExtraQL2', { removalPolicy: cdk.RemovalPolicy.DESTROY }), 'ExtraQ')
      );
      keep(
        'ExtraKeptQ',
        pin(
          new sqs.Queue(this, 'ExtraKeptQL2', { removalPolicy: cdk.RemovalPolicy.RETAIN }),
          'ExtraKeptQ'
        )
      );
    }

    if (env('GNL_ORPHANQ', '0') === '1') {
      keep(
        'OrphanQ',
        pin(
          new sqs.Queue(this, 'OrphanQL2', { removalPolicy: cdk.RemovalPolicy.RETAIN }),
          'OrphanQ'
        )
      );
    }

    if (env('GNL_FAIL', '0') === '1') {
      // SQS refuses a retention under 60 seconds: this create always fails,
      // after the resource it depends on has completed.
      const fail = new sqs.CfnQueue(this, 'Fail', { messageRetentionPeriod: 10 });
      fail.overrideLogicalId('Fail');
      const after = byId.get(env('GNL_FAIL_AFTER', 'Table'));
      if (after !== undefined) fail.addResourceDependency(after);
    }
  }
}

/** The nested child: one un-named role whose Path verify.sh moves. */
class ChildStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: { path: string }) {
    super(scope, id);
    const role = new iam.Role(this, 'ChildRoleL2', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      path: props.path,
    });
    (role.node.defaultChild as cdk.CfnResource).overrideLogicalId('ChildRole');
  }
}
