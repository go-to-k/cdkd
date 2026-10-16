import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * `RoleChild` (go-to-k/cdkd#3869 item 2): a nested stack whose `ChildNamedRole`
 * is named from the secret's `crole` field. The IAM provider REWRITES that name
 * (`.` folded to `-`), so the role's name
 * spells no recorded plaintext. The role's name is the child's output, which
 * the parent reads with `Fn::GetAtt RoleChild.Outputs.<Key>`.
 */
class RoleChild extends cdk.NestedStack {
  readonly roleName: string;

  constructor(scope: Construct, id: string, props: cdk.NestedStackProps & { secretName: string }) {
    super(scope, id, props);
    // Pinned so the child's cdkd state key (and the role name's prefix) is
    // `<parent>~RoleChild`.
    (this.nestedStackResource as cdk.CfnResource).overrideLogicalId('RoleChild');
    // Not `...Secret...`: the output key CDK derives from this id must not
    // read as credential-bearing, or the resolver's line prints `<redacted>`
    // whatever the masking does, and the step-1b check would be vacuous.
    const role = new iam.CfnRole(this, 'ChildNamedRole', {
      roleName: cdk.SecretValue.secretsManager(props.secretName, { jsonField: 'crole' }).unsafeUnwrap(),
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' },
        ],
      },
    });
    role.overrideLogicalId('ChildNamedRole');
    this.roleName = role.ref;
  }
}

/**
 * Step 1b's isolated stack (go-to-k/cdkd#3869 item 2). `ChildRoleReader`
 * stores the nested child's role name, read through the child's output.
 * SDIN_NO_EDIT=true edits the reader alone, so a redeploy resolves the read
 * from the row's record while the row is NO_CHANGE.
 */
export class SecretDerivedNestedOutputStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const secretName = process.env.SDIN_SECRET_NAME ?? 'cdkd-integ-sdin-unset';
    const child = new RoleChild(this, 'RoleChild', { secretName });
    const reader = new ssm.CfnParameter(this, 'ChildRoleReader', {
      // Named per run by `verify.sh`, so its cleanup can delete it by name.
      name: process.env.SDIN_NO_PARAM_NAME ?? '/cdkd-integ/sdin-unset/child-role-name',
      type: 'String',
      value: child.roleName,
      description:
        process.env.SDIN_NO_EDIT === 'true' ? 'cdkd integ: reader edited' : 'cdkd integ: initial',
    });
    reader.overrideLogicalId('ChildRoleReader');
  }
}
