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
 *
 * REMOVAL phase (CDKD_TEST_REMOVAL=true, issue #1160 dlm batch): a second,
 * always-DISABLED VOLUME default policy carries every UpdateLifecyclePolicy
 * shorthand field at non-default values (CreateInterval=2, RetainInterval=3,
 * CopyTags=true, ExtendDeletion=true, CrossRegionCopyTargets, Exclusions);
 * the removal redeploy drops them all, and verify.sh asserts AWS reset each
 * to its default (1 / 7 / false / false / [] / empty exclusions) instead of
 * silently keeping the live values (UpdateLifecyclePolicy merge semantics).
 * DISABLED means the default policy never actually snapshots any volume.
 */
export class DlmLifecyclePolicyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';
    const isRemoval = process.env.CDKD_TEST_REMOVAL === 'true';

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
      description: isUpdate ? 'cdkd integ policy updated' : 'cdkd integ policy baseline',
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

    // issue #1160 removal-reset coverage: a DISABLED VOLUME default policy
    // carrying every UpdateLifecyclePolicy shorthand field at a non-default
    // value; the CDKD_TEST_REMOVAL=true redeploy drops them all.
    const defaultPolicy = new dlm.CfnLifecyclePolicy(this, 'DefaultPolicy', {
      description: 'cdkd integ default policy',
      executionRoleArn: role.roleArn,
      state: 'DISABLED',
      defaultPolicy: 'VOLUME',
      ...(isRemoval
        ? {}
        : {
            createInterval: 2,
            retainInterval: 3,
            copyTags: true,
            extendDeletion: true,
            crossRegionCopyTargets: [{ targetRegion: 'us-west-2' }],
            exclusions: {
              excludeBootVolumes: true,
              excludeTags: [{ key: 'cdkd-integ-exclude', value: 'yes' }],
            },
          }),
      tags: [{ key: 'cdkd-integ', value: 'dlm-lifecycle-policy' }],
    });

    new cdk.CfnOutput(this, 'PolicyId', { value: policy.ref });
    new cdk.CfnOutput(this, 'PolicyArn', { value: policy.attrArn });
    new cdk.CfnOutput(this, 'DefaultPolicyId', { value: defaultPolicy.ref });
  }
}
