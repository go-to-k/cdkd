import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

/**
 * A CloudFormation stack whose CDK code changes AFTER its last `cdk deploy`,
 * then migrated with `cdkd import --migrate-from-cloudformation` (issues #6840
 * and #6841).
 *
 * `cdk deploy` runs WITHOUT `CDKD_TEST_UPDATE`, so the role's trust condition
 * holds ONE `aws:SourceArn` pattern. The migration and everything after it run
 * WITH `CDKD_TEST_UPDATE=true`, which widens the condition to TWO patterns: the
 * code change the next `cdk deploy` would have applied. The migration's Retain
 * update keeps CloudFormation's template, so AWS still holds one pattern, and
 * the import must record THAT, leaving the widening a pending `cdkd diff`.
 *
 * The role's `DefaultPolicy` is the CDK inline `AWS::IAM::Policy` whose
 * CloudFormation `PhysicalResourceId` is a generated id, not its name (#6841).
 *
 * covers: AWS::IAM::Role
 * covers: AWS::IAM::Policy
 */
export class ImportMigratePendingChangeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const widened = process.env.CDKD_TEST_UPDATE === 'true';
    const pattern = (suffix: string): string =>
      `arn:${cdk.Aws.PARTITION}:lambda:${this.region}:${this.account}:function:cdkd-integ-pending-${suffix}`;
    const sourceArns = widened ? [pattern('a'), pattern('b')] : pattern('a');

    const role = new iam.Role(this, 'TrustRole', {
      roleName: `cdkd-integ-pending-change-${this.region}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com', {
        conditions: { StringLike: { 'aws:SourceArn': sourceArns } },
      }),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sqs:GetQueueAttributes'],
        resources: ['*'],
      })
    );
  }
}
