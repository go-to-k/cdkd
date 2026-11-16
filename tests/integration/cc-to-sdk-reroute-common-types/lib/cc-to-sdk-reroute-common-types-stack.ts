import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * The value each routing phase declares on every resource under test.
 * Consecutive deploys must differ: one the differ calls NO_CHANGE never
 * provisions a resource, so it could not flip. verify.sh runs its `cdkd diff`
 * with `pinned`, because `seed` and `flip` declare the same value.
 */
const VALUE_BY_PHASE: Record<string, 'a' | 'b'> = {
  base: 'a',
  seed: 'b',
  pinned: 'a',
  flip: 'b',
};

/**
 * physicalId-parity arm for issue 6454: a resource of each of ten types,
 * recorded `provisionedBy: 'cc-api'`, returns to its SDK provider without
 * churn.
 *
 * covers: AWS::EC2::SecurityGroup, AWS::EC2::RouteTable,
 * AWS::ElasticLoadBalancingV2::TargetGroup, AWS::KMS::Key,
 * AWS::SecretsManager::Secret, AWS::Lambda::EventSourceMapping, AWS::IAM::Role,
 * AWS::IAM::ManagedPolicy, AWS::SQS::Queue, AWS::SSM::Parameter
 *
 * Every resource under test is a LEAF: nothing in the stack references it, so
 * verify.sh's `--recreate-via-cc-api` replaces only that resource and no
 * dependent's create-only property changes with it. Each one's logical id is
 * fixed so verify.sh can name it without reading the template. verify.sh holds
 * each type's identity witness and live readback.
 */
export class CcToSdkRerouteCommonTypesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const value = VALUE_BY_PHASE[process.env.CDKD_TEST_PHASE ?? 'base'] ?? 'a';
    const phase = `phase-${value}`;
    const phaseTags = [{ key: 'cdkd-phase', value: phase }];
    const fixed = (resource: cdk.CfnResource, logicalId: string): void => {
      resource.overrideLogicalId(logicalId);
    };

    const vpc = new ec2.CfnVPC(this, 'Vpc', { cidrBlock: '10.42.0.0/24' });

    fixed(
      new ec2.CfnSecurityGroup(this, 'SecurityGroup', {
        groupDescription: 'cdkd reroute security group',
        vpcId: vpc.ref,
        tags: phaseTags,
      }),
      'RerouteSecurityGroup'
    );

    fixed(new ec2.CfnRouteTable(this, 'RouteTable', { vpcId: vpc.ref, tags: phaseTags }), 'RerouteRouteTable');

    fixed(
      new elbv2.CfnTargetGroup(this, 'TargetGroup', {
        vpcId: vpc.ref,
        port: 80,
        protocol: 'HTTP',
        targetType: 'ip',
        healthCheckPath: `/${phase}`,
      }),
      'RerouteTargetGroup'
    );

    const key = new kms.CfnKey(this, 'Key', {
      description: phase,
      pendingWindowInDays: 7,
      keyPolicy: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: `arn:${this.partition}:iam::${this.account}:root` },
            Action: 'kms:*',
            Resource: '*',
          },
        ],
      },
    });
    key.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.DELETE;
    fixed(key, 'RerouteKey');

    const secret = new secretsmanager.CfnSecret(this, 'Secret', {
      description: phase,
      generateSecretString: { excludePunctuation: true, passwordLength: 16 },
    });
    secret.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.DELETE;
    fixed(secret, 'RerouteSecret');

    // The event source mapping's function and queue are NOT under test; only
    // the mapping is recreated, so their ids hold across every phase.
    const sourceQueue = new sqs.Queue(this, 'SourceQueue', { visibilityTimeout: cdk.Duration.seconds(30) });
    const handler = new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => {};'),
    });
    sourceQueue.grantConsumeMessages(handler);
    const mapping = new lambda.CfnEventSourceMapping(this, 'EventSourceMapping', {
      functionName: handler.functionName,
      eventSourceArn: sourceQueue.queueArn,
      batchSize: value === 'a' ? 5 : 6,
    });
    mapping.node.addDependency(handler);
    fixed(mapping, 'RerouteEventSourceMapping');

    fixed(
      new iam.CfnRole(this, 'Role', {
        description: phase,
        assumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }],
        },
      }),
      'RerouteRole'
    );

    fixed(
      new iam.CfnManagedPolicy(this, 'ManagedPolicy', {
        policyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Sid: value === 'a' ? 'PhaseA' : 'PhaseB',
              Effect: 'Allow',
              Action: 'sqs:GetQueueUrl',
              Resource: sourceQueue.queueArn,
            },
          ],
        },
      }),
      'RerouteManagedPolicy'
    );

    const queue = new sqs.CfnQueue(this, 'Queue', { visibilityTimeout: value === 'a' ? 30 : 31 });
    queue.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.DELETE;
    fixed(queue, 'RerouteQueue');

    fixed(new ssm.CfnParameter(this, 'Parameter', { type: 'String', value: phase }), 'RerouteParameter');

    new cdk.CfnOutput(this, 'VpcId', { value: vpc.ref });
    new cdk.CfnOutput(this, 'HandlerName', { value: handler.functionName });
  }
}
