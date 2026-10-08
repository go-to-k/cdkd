import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
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
 * covers: AWS::IAM::Role
 * covers: AWS::SQS::Queue
 * covers: AWS::Logs::LogGroup
 */
export class CrossBackendSameStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

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
  }
}
