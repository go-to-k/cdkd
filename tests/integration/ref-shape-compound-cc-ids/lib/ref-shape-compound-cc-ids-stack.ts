import * as cdk from 'aws-cdk-lib';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

/**
 * Issue #6293: `Ref` on five Cloud-Control-routed types with a pipe-joined
 * physical id resolved to the whole compound id where CloudFormation returns
 * one segment: LogStream (stream name), SubscriptionFilter (filter name),
 * MaintenanceWindowTarget (target id), MaintenanceWindowTask (task id) and
 * CodeDeploy DeploymentGroup (group name). The task's `Targets` value is a
 * `Ref` to the target, so the wrong value also reaches a resource property.
 *
 * covers: AWS::Logs::LogGroup
 * covers: AWS::Logs::LogStream
 * covers: AWS::Logs::SubscriptionFilter
 * covers: AWS::Lambda::Function
 * covers: AWS::Lambda::Permission
 * covers: AWS::SSM::MaintenanceWindow
 * covers: AWS::SSM::MaintenanceWindowTarget
 * covers: AWS::SSM::MaintenanceWindowTask
 * covers: AWS::CodeDeploy::Application
 * covers: AWS::CodeDeploy::DeploymentGroup
 */
export class RefShapeCompoundCcIdsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const logGroup = new logs.CfnLogGroup(this, 'LogGroup', { retentionInDays: 1 });
    const logStream = new logs.CfnLogStream(this, 'LogStream', {
      logGroupName: logGroup.ref,
      logStreamName: 'cdkd-ref-shape-stream',
    });

    const fnRole = new iam.CfnRole(this, 'FnRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' },
        ],
      },
      managedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
    });
    const fn = new lambda.CfnFunction(this, 'Fn', {
      runtime: 'nodejs22.x',
      handler: 'index.handler',
      role: fnRole.attrArn,
      code: { zipFile: 'exports.handler = async () => ({});' },
    });
    const permission = new lambda.CfnPermission(this, 'FnPermission', {
      action: 'lambda:InvokeFunction',
      functionName: fn.ref,
      principal: 'logs.amazonaws.com',
      sourceArn: logGroup.attrArn,
    });
    const filter = new logs.CfnSubscriptionFilter(this, 'Filter', {
      logGroupName: logGroup.ref,
      destinationArn: fn.attrArn,
      filterPattern: '',
    });
    filter.addDependency(permission);

    const window = new ssm.CfnMaintenanceWindow(this, 'Window', {
      name: 'cdkd-ref-shape-6293',
      allowUnassociatedTargets: true,
      schedule: 'cron(0 4 ? * SUN *)',
      duration: 2,
      cutoff: 1,
    });
    const target = new ssm.CfnMaintenanceWindowTarget(this, 'WindowTarget', {
      windowId: window.ref,
      resourceType: 'INSTANCE',
      targets: [{ key: 'tag:bughunt', values: ['ref-shape'] }],
    });
    const task = new ssm.CfnMaintenanceWindowTask(this, 'WindowTask', {
      windowId: window.ref,
      taskArn: 'AWS-RunShellScript',
      taskType: 'RUN_COMMAND',
      priority: 1,
      maxConcurrency: '1',
      maxErrors: '1',
      targets: [{ key: 'WindowTargetIds', values: [target.ref] }],
    });

    const app = new codedeploy.CfnApplication(this, 'App', { computePlatform: 'Server' });
    const cdRole = new iam.CfnRole(this, 'CodeDeployRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Principal: { Service: 'codedeploy.amazonaws.com' }, Action: 'sts:AssumeRole' },
        ],
      },
      managedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AWSCodeDeployRole'],
    });
    const group = new codedeploy.CfnDeploymentGroup(this, 'DeploymentGroup', {
      applicationName: app.ref,
      serviceRoleArn: cdRole.attrArn,
      ec2TagFilters: [{ key: 'bughunt', value: 'ref-shape', type: 'KEY_AND_VALUE' }],
    });

    new cdk.CfnOutput(this, 'LogGroupName', { value: logGroup.ref });
    new cdk.CfnOutput(this, 'LogStreamRef', { value: logStream.ref });
    new cdk.CfnOutput(this, 'FilterRef', { value: filter.ref });
    new cdk.CfnOutput(this, 'WindowId', { value: window.ref });
    new cdk.CfnOutput(this, 'TargetRef', { value: target.ref });
    new cdk.CfnOutput(this, 'TaskRef', { value: task.ref });
    new cdk.CfnOutput(this, 'AppName', { value: app.ref });
    new cdk.CfnOutput(this, 'DeploymentGroupRef', { value: group.ref });
  }
}
