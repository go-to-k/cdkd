import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

/**
 * go-to-k/cdkd#3869 item 3 (Phase 0): a stack of its own. `NoEchoChangedRole`
 * is named from the `NoEcho` parameter `ChangedRoleTok` plus padding, so the
 * IAM provider TRUNCATES the name past 64
 * characters (with a hash): the role's name holds the value but not the whole
 * stored `RoleName`, so a needle of the stored leaf alone does not match it.
 *
 * `verify.sh` rewrites the record as a binary before schema v11 stored it (the
 * name in plaintext, no `noEchoLeaves`), then deploys and destroys with
 * ANOTHER value: no value the run binds spells the old name.
 */
export class NoechoChangedValueArmStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const token = new cdk.CfnParameter(this, 'ChangedRoleTok', {
      type: 'String',
      noEcho: true,
      default: process.env['CDKD_TEST_NOECHO_CV_TOKEN'] ?? 'CdkdNoEchoCvUnset',
    });
    token.overrideLogicalId('ChangedRoleTok');
    const role = new iam.CfnRole(this, 'NoEchoChangedRole', {
      roleName: cdk.Fn.sub('${ChangedRoleTok}-padding-past-the-iam-name-limit-0123456789'),
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' },
        ],
      },
    });
    role.overrideLogicalId('NoEchoChangedRole');
  }
}
