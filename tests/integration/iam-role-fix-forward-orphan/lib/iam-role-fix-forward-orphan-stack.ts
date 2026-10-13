import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * go-to-k/cdkd#4606, the IAM role arm: a fix-forward deploy deletes the role a
 * failed CREATE left in AWS, and keeps one whose name was re-used.
 *
 * - The baseline holds `BaseRole`.
 * - `WITH_ORPHANS=true` adds `OrphanA` and `OrphanC`, each declaring `Tags`.
 *   verify.sh deploys that template as a role that may create a role but may
 *   neither tag nor delete it, so each CREATE makes the role, fails on the
 *   post-create `TagRole`, and cannot clean up: the journal records each as a
 *   proven orphan with the `RoleId` its `CreateRole` answered with. `OrphanA`
 *   also declares an inline policy, whose `PutRolePolicy` succeeds before the
 *   `TagRole` fails, and whose cleanup `DeleteRolePolicy` is refused too: the
 *   fix-forward's delete must remove it before `DeleteRole`.
 * - `ORPHAN_FIX_FORWARD=true` keeps every orphan logical id under another name
 *   (`-b`), so the fix-forward deploy creates two new roles. Before it,
 *   verify.sh deletes `OrphanC`'s role and re-creates the name itself (one
 *   made outside the stack, under another `RoleId`): the fix-forward must
 *   delete `OrphanA`'s role and keep that one.
 *
 * L1 roles with explicit names, using only properties the IAM role SDK
 * provider handles, so every role stays on the SDK route (`provisionedBy:
 * sdk`), where `isSameResource` / `resourceIdentity` live.
 */
export class IamRoleFixForwardOrphanStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const assumeRolePolicyDocument = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Service: 'lambda.amazonaws.com' },
          Action: 'sts:AssumeRole',
        },
      ],
    };

    new iam.CfnRole(this, 'BaseRole', {
      roleName: 'cdkd-irffo-base',
      assumeRolePolicyDocument,
    });

    if (process.env.WITH_ORPHANS === 'true') {
      const suffix = process.env.ORPHAN_FIX_FORWARD === 'true' ? '-b' : '';
      new iam.CfnRole(this, 'OrphanA', {
        roleName: `cdkd-irffo-a${suffix}`,
        assumeRolePolicyDocument,
        policies: [
          {
            policyName: 'irffo-inline',
            policyDocument: {
              Version: '2012-10-17',
              Statement: [{ Effect: 'Allow', Action: 'logs:CreateLogGroup', Resource: '*' }],
            },
          },
        ],
        tags: [{ key: 'cdkd-integ', value: 'iam-role-fix-forward-orphan' }],
      });
      new iam.CfnRole(this, 'OrphanC', {
        roleName: `cdkd-irffo-c${suffix}`,
        assumeRolePolicyDocument,
        tags: [{ key: 'cdkd-integ', value: 'iam-role-fix-forward-orphan' }],
      });
    }
  }
}
