import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * go-to-k/cdkd#4606, the IAM instance profile and managed policy arm: a
 * fix-forward deploy deletes the instance profile or managed policy a failed
 * CREATE left in AWS, and keeps one whose name was re-used.
 *
 * - The baseline holds `BaseRole` and `BaseGroup`.
 * - `WITH_ORPHANS=true` adds `ProfileA` and `ProfileC` (each holding
 *   `BaseRole`), `PolicyA` (attached to `BaseGroup` and `BaseRole`) and
 *   `PolicyC` (attached to `BaseRole`). verify.sh deploys that template as a
 *   role that may create an instance profile or managed policy and attach a
 *   policy to `BaseGroup`, but may neither add a role to a profile, attach a
 *   policy to a role, detach a policy, nor delete a profile or policy. So each
 *   CREATE makes the profile or policy, fails on the post-create
 *   `AddRoleToInstanceProfile` / `AttachRolePolicy`, and cannot clean up: the
 *   journal records each as a proven orphan with the `InstanceProfileId` /
 *   `PolicyId` its create answered with. `PolicyA`'s group attach succeeds
 *   before its role attach fails, and its cleanup detach is refused too: the
 *   fix-forward's delete must detach it before deleting.
 * - `ORPHAN_FIX_FORWARD=true` keeps every orphan logical id under another name
 *   (`-b`), so the fix-forward deploy creates four new resources. Before it,
 *   verify.sh deletes `ProfileC`'s profile and `PolicyC`'s policy and
 *   re-creates each name itself (made outside the stack, under another id):
 *   the fix-forward must delete `ProfileA`'s and `PolicyA`'s and keep those
 *   two.
 *
 * L1 resources with explicit names, using only properties the IAM SDK
 * providers handle, so every one stays on the SDK route (`provisionedBy:
 * sdk`), where `isSameResource` / `resourceIdentity` live.
 */
export class IamProfilePolicyFixForwardOrphanStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const baseRole = new iam.CfnRole(this, 'BaseRole', {
      roleName: 'cdkd-ippfo-base-role',
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' },
        ],
      },
    });
    const baseGroup = new iam.CfnGroup(this, 'BaseGroup', { groupName: 'cdkd-ippfo-base-group' });

    if (process.env.WITH_ORPHANS === 'true') {
      const suffix = process.env.ORPHAN_FIX_FORWARD === 'true' ? '-b' : '';
      const policyDocument = {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Deny', Action: 'logs:CreateLogGroup', Resource: '*' }],
      };
      new iam.CfnInstanceProfile(this, 'ProfileA', {
        instanceProfileName: `cdkd-ippfo-profile-a${suffix}`,
        roles: [baseRole.ref],
      });
      new iam.CfnInstanceProfile(this, 'ProfileC', {
        instanceProfileName: `cdkd-ippfo-profile-c${suffix}`,
        roles: [baseRole.ref],
      });
      new iam.CfnManagedPolicy(this, 'PolicyA', {
        managedPolicyName: `cdkd-ippfo-policy-a${suffix}`,
        policyDocument,
        groups: [baseGroup.ref],
        roles: [baseRole.ref],
      });
      new iam.CfnManagedPolicy(this, 'PolicyC', {
        managedPolicyName: `cdkd-ippfo-policy-c${suffix}`,
        policyDocument,
        roles: [baseRole.ref],
      });
    }
  }
}
