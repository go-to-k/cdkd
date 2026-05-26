import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Verifies cdkd's IAMManagedPolicyProvider against real AWS.
 *
 * Deploys:
 *   - An IAM Role with sts:AssumeRole for the Lambda service principal.
 *   - A standalone customer-managed policy (AWS::IAM::ManagedPolicy) granting
 *     read access to /tmp/* style log groups. Attached to the role via
 *     `roles: [...]` on the policy itself (NOT via `role.attachManagedPolicy`
 *     which routes through `ManagedPolicyArns` on the Role and would short-
 *     circuit this fixture's target type).
 *
 * Destroy step exercises:
 *   - Detach-before-delete (the ManagedPolicy is attached to a Role).
 *   - Delete-the-Role afterwards (depends on the ManagedPolicy being detached).
 */
export class IamManagedPolicyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const role = new iam.Role(this, 'ServiceRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Test role for cdkd IAM ManagedPolicy integ',
    });

    new iam.ManagedPolicy(this, 'ReadLogsPolicy', {
      description: 'Grants read access to CloudWatch Logs (cdkd integ test)',
      document: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['logs:DescribeLogGroups', 'logs:GetLogEvents'],
            resources: ['*'],
          }),
        ],
      }),
      roles: [role],
    });

    new cdk.CfnOutput(this, 'ServiceRoleArn', {
      value: role.roleArn,
      description: 'ARN of the service role the managed policy is attached to',
    });
  }
}
