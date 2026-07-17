import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dlm from 'aws-cdk-lib/aws-dlm';
import type { Construct } from 'constructs';

/**
 * Minimal DLM lifecycle policy fixture for the AWS::DLM::LifecyclePolicy SDK
 * provider (issue #1040).
 *
 * covers: AWS::DLM::LifecyclePolicy
 * covers: AWS::IAM::Role
 *
 * The policy targets a tag (`cdkd-integ-dlm=true`) that no volume in the
 * account carries, so it never actually creates snapshots — the fixture is
 * free to run.
 *
 * UPDATE phase (CDKD_TEST_UPDATE=true) exercises the in-place update path:
 *   - Description change + State ENABLED -> DISABLED (UpdateLifecyclePolicy)
 *   - Tag value change + tag REMOVAL (TagResource / UntagResource — the #981
 *     regression class)
 */
export class DlmLifecyclePolicyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    const role = new iam.Role(this, 'DlmRole', {
      roleName: 'cdkd-integ-dlm-role',
      assumedBy: new iam.ServicePrincipal('dlm.amazonaws.com'),
      inlinePolicies: {
        dlm: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'ec2:CreateSnapshot',
                'ec2:CreateSnapshots',
                'ec2:DeleteSnapshot',
                'ec2:DescribeInstances',
                'ec2:DescribeVolumes',
                'ec2:DescribeSnapshots',
              ],
              resources: ['*'],
            }),
            new iam.PolicyStatement({
              actions: ['ec2:CreateTags'],
              resources: ['arn:aws:ec2:*::snapshot/*'],
            }),
          ],
        }),
      },
    });

    const policy = new dlm.CfnLifecyclePolicy(this, 'Policy', {
      description: isUpdate ? 'cdkd integ policy (updated)' : 'cdkd integ policy (baseline)',
      executionRoleArn: role.roleArn,
      state: isUpdate ? 'DISABLED' : 'ENABLED',
      policyDetails: {
        policyType: 'EBS_SNAPSHOT_MANAGEMENT',
        resourceTypes: ['VOLUME'],
        targetTags: [{ key: 'cdkd-integ-dlm', value: 'true' }],
        schedules: [
          {
            name: 'Daily',
            createRule: { interval: 24, intervalUnit: 'HOURS', times: ['09:00'] },
            retainRule: { count: 1 },
          },
        ],
      },
      tags: isUpdate
        ? [
            // constant tag used by verify.sh cleanup to find leftover policies
            { key: 'cdkd-integ', value: 'dlm-lifecycle-policy' },
            { key: 'env', value: 'changed' },
          ]
        : [
            { key: 'cdkd-integ', value: 'dlm-lifecycle-policy' },
            { key: 'env', value: 'test' },
            { key: 'dropme', value: 'yes' },
          ],
    });

    new cdk.CfnOutput(this, 'PolicyId', { value: policy.ref });
    new cdk.CfnOutput(this, 'PolicyArn', { value: policy.attrArn });
  }
}
