import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * go-to-k/cdkd#4606, the IAM user and group arm: a fix-forward deploy deletes
 * the user or group a failed CREATE left in AWS, and keeps one whose name was
 * re-used.
 *
 * - The baseline holds `BaseUser`.
 * - `WITH_ORPHANS=true` adds `UserA`, `UserC`, `GroupA` and `GroupC`, each
 *   declaring an inline policy. verify.sh deploys that template as a role that
 *   may create a user or group and attach `AWSDenyAll` to it, but may neither
 *   put an inline policy on it, detach a policy, nor delete it. So each CREATE
 *   makes the user or group, fails on the post-create `PutUserPolicy` /
 *   `PutGroupPolicy`, and cannot clean up: the journal records each as a
 *   proven orphan with the `UserId` / `GroupId` its create answered with.
 *   `UserA` and `GroupA` also attach `AWSDenyAll`, whose attach succeeds
 *   before the inline policy fails, and whose cleanup detach is refused too:
 *   the fix-forward's delete must detach it before deleting.
 * - `ORPHAN_FIX_FORWARD=true` keeps every orphan logical id under another name
 *   (`-b`), so the fix-forward deploy creates four new entities. Before it,
 *   verify.sh deletes `UserC`'s user and `GroupC`'s group and re-creates each
 *   name itself (made outside the stack, under another id): the fix-forward
 *   must delete `UserA`'s user and `GroupA`'s group and keep those two.
 *
 * L1 resources with explicit names, using only properties the IAM user/group
 * SDK provider handles, so every one stays on the SDK route (`provisionedBy:
 * sdk`), where `isSameResource` / `resourceIdentity` live.
 */
export class IamUserGroupFixForwardOrphanStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new iam.CfnUser(this, 'BaseUser', { userName: 'cdkd-iufo-base' });

    if (process.env.WITH_ORPHANS === 'true') {
      const suffix = process.env.ORPHAN_FIX_FORWARD === 'true' ? '-b' : '';
      const denyAll = 'arn:aws:iam::aws:policy/AWSDenyAll';
      const policies = [
        {
          policyName: 'iufo-inline',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [{ Effect: 'Deny', Action: 'logs:CreateLogGroup', Resource: '*' }],
          },
        },
      ];
      new iam.CfnUser(this, 'UserA', {
        userName: `cdkd-iufo-user-a${suffix}`,
        managedPolicyArns: [denyAll],
        policies,
      });
      new iam.CfnUser(this, 'UserC', { userName: `cdkd-iufo-user-c${suffix}`, policies });
      new iam.CfnGroup(this, 'GroupA', {
        groupName: `cdkd-iufo-group-a${suffix}`,
        managedPolicyArns: [denyAll],
        policies,
      });
      new iam.CfnGroup(this, 'GroupC', { groupName: `cdkd-iufo-group-c${suffix}`, policies });
    }
  }
}
