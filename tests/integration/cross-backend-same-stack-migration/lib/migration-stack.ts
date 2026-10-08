import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

export interface MigrationStackProps extends cdk.StackProps {
  /** Add an unnamed IAM Role (a type whose create refuses an existing name). */
  withRole: boolean;
}

/**
 * go-to-k/cdkd#4705 migration probe: deployments made by the PREVIOUS cdkd
 * release, then driven by this build.
 *
 * No resource carries an explicit physical name. The Queue and the LogGroup
 * are types whose create hands back a resource already holding the name, so
 * the previous release lets a second deployment of the same stack name under
 * another state prefix record them too (the pre-fix pair).
 *
 * `CDKD_4705_FAIL_LATER=1` adds `FailLater`, an SSM parameter whose value does
 * not match its own `AllowedPattern`, created after the Queue: a
 * `--no-rollback` deploy then fails with the Queue's CREATE journaled as
 * completed, the rollback journal the repro's damage path replays.
 *
 * `CDKD_4705_DROP_LOGGROUP=1` removes the LogGroup, so a redeploy's plan
 * DELETES it: the destructive-plan check's case.
 *
 * covers: AWS::IAM::Role
 * covers: AWS::SQS::Queue
 * covers: AWS::Logs::LogGroup
 * covers: AWS::SSM::Parameter
 */
export class MigrationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MigrationStackProps) {
    super(scope, id, props);

    if (props.withRole) {
      new iam.Role(this, 'Role', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      });
    }

    const queue = new sqs.Queue(this, 'Queue', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    if (process.env.CDKD_4705_DROP_LOGGROUP !== '1') {
      new logs.LogGroup(this, 'LogGroup', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    }

    if (process.env.CDKD_4705_FAIL_LATER === '1') {
      const failLater = new ssm.CfnParameter(this, 'FailLater', {
        type: 'String',
        value: 'not-a-number',
        allowedPattern: '^[0-9]+$',
      });
      failLater.node.addDependency(queue);
    }
  }
}
