import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

/** The role's FIXED name: verify.sh re-creates a role under it out of band. */
export const ROLE_NAME = 'cdkd-orphan-getatt-takeover-role';
export const PARAMETER_NAME = '/cdkd-integ/orphan-getatt-takeover/role-id';

/**
 * `cdkd orphan` over a resource whose NAME was taken over out of band
 * (issue #4186).
 *
 * The parameter's value is `Fn::GetAtt [Role, RoleId]`. `RoleId` is unique
 * per role INSTANCE while the provider's live read addresses the role by
 * NAME, so after verify.sh deletes the role and creates another under the
 * same name, a live read answers with the newcomer's id. `cdkd orphan` must
 * substitute the RECORDED id — the one the parameter was deployed with.
 *
 * covers: AWS::IAM::Role
 * covers: AWS::SSM::Parameter
 */
export class OrphanGetattTakeoverStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const role = new iam.Role(this, 'Role', {
      roleName: ROLE_NAME,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    role.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new ssm.StringParameter(this, 'RoleIdParam', {
      parameterName: PARAMETER_NAME,
      stringValue: role.roleId,
    });
  }
}
