import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

/**
 * An IAM role and an inline policy whose changes cover what `cdkd diff
 * --fail-on=broadening` and `cdkd deploy --require-approval=broadening` tell
 * apart (issue #4601). `cdk.json` sets `"requireApproval": "broadening"`, so a
 * deploy without the flag reads the level from there. `CDKD_TEST_UPDATE`
 * selects the phase:
 *
 * - unset: the baseline. Creating the role (a trust policy) broadens.
 * - `describe`: the role's `Description` changes and the policy drops its
 *   `s3:ListBucket` statement, which grants nothing. The policy keeps a
 *   statement on the role's own ARN (`Fn::GetAtt`), so this phase also proves
 *   the unchanged statement compares as equal: the recorded ARN against the
 *   diff's resolved one, not against the intrinsic.
 * - `broaden`: the same, plus the policy gains an `s3:PutObject` statement.
 *
 * The bucket ARNs name no real bucket: the policy is only ever read back.
 *
 * covers: AWS::IAM::Role, AWS::IAM::Policy
 */
export class RequireApprovalBroadeningStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const mode = process.env.CDKD_TEST_UPDATE ?? '';
    const described = mode === 'describe' || mode === 'broaden';
    const broadened = mode === 'broaden';
    const objects = 'arn:aws:s3:::cdkd-integ-4601-no-such-bucket/*';

    const role = new iam.Role(this, 'Role', {
      roleName: 'cdkd-integ-4601-broadening',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: described ? 'cdkd integ 4601 v2' : 'cdkd integ 4601 v1',
    });

    const statements = [
      new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [objects] }),
      new iam.PolicyStatement({ actions: ['iam:GetRole'], resources: [role.roleArn] }),
    ];
    if (!described) {
      statements.push(
        new iam.PolicyStatement({
          actions: ['s3:ListBucket'],
          resources: ['arn:aws:s3:::cdkd-integ-4601-no-such-bucket'],
        })
      );
    }
    if (broadened) {
      statements.push(new iam.PolicyStatement({ actions: ['s3:PutObject'], resources: [objects] }));
    }
    new iam.Policy(this, 'Probe', {
      policyName: 'broadening-probe',
      roles: [role],
      statements,
    });
  }
}
