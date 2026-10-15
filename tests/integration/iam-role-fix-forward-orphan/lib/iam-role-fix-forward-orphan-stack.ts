import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * go-to-k/cdkd#4606, the IAM role arm: a fix-forward deploy deletes the role a
 * failed CREATE left in AWS, and keeps one whose name was re-used.
 *
 * - The baseline holds `BaseRole`.
 * - `WITH_ORPHANS=true` adds `OrphanA` and `OrphanC`, each declaring `Tags`.
 *   Outside the fix-forward each also declares an inline policy AWS refuses
 *   (`MalformedPolicyDocument`: a `Resource` that is not an ARN). verify.sh
 *   deploys that template as a role that may create and tag a role but may
 *   not delete it, so each CREATE makes the role -- tagged, since the tags
 *   ride on `CreateRole` (go-to-k/cdkd#4971) -- fails on that `PutRolePolicy`,
 *   and cannot clean up: the journal records each as a proven orphan with the
 *   `RoleId` its `CreateRole` answered with. `OrphanA` puts a valid inline
 *   policy first, whose cleanup `DeleteRolePolicy` is refused too: the
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
      const fixForward = process.env.ORPHAN_FIX_FORWARD === 'true';
      const suffix = fixForward ? '-b' : '';
      // The failed CREATE's wiring failure: AWS refuses this document
      // (`MalformedPolicyDocument`, measured). Synth's template validation
      // warns about the same `Resource`; that warning is expected.
      const refused: iam.CfnRole.PolicyProperty[] = fixForward
        ? []
        : [
            {
              policyName: 'irffo-refused',
              policyDocument: {
                Version: '2012-10-17',
                Statement: [
                  { Effect: 'Allow', Action: 'logs:CreateLogGroup', Resource: 'not-an-arn' },
                ],
              },
            },
          ];
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
          ...refused,
        ],
        tags: [{ key: 'cdkd-integ', value: 'iam-role-fix-forward-orphan' }],
      });
      new iam.CfnRole(this, 'OrphanC', {
        roleName: `cdkd-irffo-c${suffix}`,
        assumeRolePolicyDocument,
        ...(refused.length > 0 && { policies: refused }),
        tags: [{ key: 'cdkd-integ', value: 'iam-role-fix-forward-orphan' }],
      });

    }
  }
}
