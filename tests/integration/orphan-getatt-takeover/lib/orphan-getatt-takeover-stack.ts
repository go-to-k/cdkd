import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

/** The role's FIXED name: verify.sh re-creates a role under it out of band. */
export const ROLE_NAME = 'cdkd-orphan-getatt-takeover-role';
export const PARAMETER_NAME = '/cdkd-integ/orphan-getatt-takeover/role-id';
/** Fixed names: verify.sh deletes the orphaned log group itself. */
export const LOG_GROUP_NAME = '/cdkd-integ/orphan-getatt-takeover/region-probe';
export const LOG_GROUP_ARN_PARAMETER_NAME = '/cdkd-integ/orphan-getatt-takeover/log-group-arn';

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
 * The second parameter holds `Fn::GetAtt [LogGroup, Arn]` (issue #4937):
 * verify.sh strips the recorded `Arn` so `cdkd orphan` reads it live, with the
 * shell's `AWS_REGION` pointed at another region. The provider derives the ARN
 * from its client's region, so a read outside the stack's region writes a
 * wrong-region ARN into the parameter's state row.
 *
 * covers: AWS::IAM::Role
 * covers: AWS::SSM::Parameter
 * covers: AWS::Logs::LogGroup
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

    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: LOG_GROUP_NAME,
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new ssm.StringParameter(this, 'LogGroupArnParam', {
      parameterName: LOG_GROUP_ARN_PARAMETER_NAME,
      stringValue: logGroup.logGroupArn,
    });
  }
}
