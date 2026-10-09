import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

/**
 * go-to-k/cdkd#4705: the same stack name deployed under two state prefixes in
 * one account and region. No resource carries an explicit physical name, so
 * every name is cdkd's `{stackName}-{logicalId}` and both deployments ask AWS
 * for the same ones:
 *
 *  - the Role's CreateRole fails with EntityAlreadyExists;
 *  - the Queue's CreateQueue (identical attributes) hands back the existing
 *    queue, and its removal policy is DESTROY (the L2 default, spelled out);
 *  - the LogGroup's ResourceAlreadyExistsException is swallowed, and its
 *    removal policy is RETAIN (the L2 default, spelled out).
 *
 * `CDKD_4705_RETENTION_DAYS` sets the LogGroup's retention, so a second
 * deployment rewriting the first one's log group is observable (default 7).
 *
 * The KMS Key is the resource the settle arm seeds as a proven failed-CREATE
 * orphan in the OTHER prefix's journal: its physical id is a unique key id,
 * so a successful deploy's settle deletes such an orphan without an identity
 * read -- unless the cross-prefix check keeps it.
 *
 * `CDKD_4705_B_MINIMAL=1` synthesizes ONLY a harmless SSM parameter, for the
 * settle arm's successful deploy under the other prefix: nothing in it
 * collides with the first deployment's names.
 *
 * `CDKD_4705_B_AUTOROLLBACK=1` synthesizes the Queue exactly as above (so its
 * CreateQueue would hand back the first deployment's queue) and `FailLater`,
 * an SSM parameter whose value does not match its own `AllowedPattern`,
 * created after the Queue: the Queue's create must be refused before it is
 * sent, so nothing is adopted.
 *
 * covers: AWS::IAM::Role
 * covers: AWS::SQS::Queue
 * covers: AWS::Logs::LogGroup
 * covers: AWS::KMS::Key
 * covers: AWS::SSM::Parameter
 */
export class CrossBackendSameStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    if (process.env.CDKD_4705_B_AUTOROLLBACK === '1') {
      const queue = new sqs.Queue(this, 'Queue', {
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      const failLater = new ssm.CfnParameter(this, 'FailLater', {
        type: 'String',
        value: 'not-a-number',
        allowedPattern: '^[0-9]+$',
      });
      failLater.node.addDependency(queue);
      return;
    }

    if (process.env.CDKD_4705_B_MINIMAL === '1') {
      new ssm.StringParameter(this, 'MinimalParam', { stringValue: 'cdkd-4705-settle-arm' });
      return;
    }

    const retention = Number(process.env.CDKD_4705_RETENTION_DAYS ?? '7') as logs.RetentionDays;

    new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    new sqs.Queue(this, 'Queue', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new logs.LogGroup(this, 'LogGroup', {
      retention,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    new kms.Key(this, 'Key', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pendingWindow: cdk.Duration.days(7),
    });
  }
}
