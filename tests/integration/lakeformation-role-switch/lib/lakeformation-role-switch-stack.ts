import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lakeformation from 'aws-cdk-lib/aws-lakeformation';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

/**
 * go-to-k/cdkd#7121. A bucket registered with Lake Formation:
 * - by default with the service-linked role (`UseServiceLinkedRole: true`);
 * - `CDKD_TEST_UPDATE=own` registers it with the stack's own role instead
 *   (`UseServiceLinkedRole: false` + `RoleArn`), which Lake Formation's
 *   UpdateResource refuses and CloudFormation applies in place;
 * - `CDKD_TEST_UPDATE=fresh` adds a second role and registers the location
 *   with it, so the switch runs against a role created in the same deploy.
 *
 * covers: AWS::LakeFormation::Resource
 */
export class LakeFormationRoleSwitchStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const own = process.env['CDKD_TEST_UPDATE'] === 'own';
    const fresh = process.env['CDKD_TEST_UPDATE'] === 'fresh';

    const bucket = new s3.Bucket(this, 'Location', {
      bucketName: `cdkd-integ-lf-role-switch-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const role = new iam.Role(this, 'LocationRole', {
      roleName: `CdkdLfRoleSwitch-${cdk.Aws.REGION}`,
      assumedBy: new iam.ServicePrincipal('lakeformation.amazonaws.com'),
    });
    bucket.grantReadWrite(role);
    const freshRole = fresh
      ? new iam.Role(this, 'FreshLocationRole', {
          roleName: `CdkdLfRoleSwitchFresh-${cdk.Aws.REGION}`,
          assumedBy: new iam.ServicePrincipal('lakeformation.amazonaws.com'),
        })
      : undefined;
    if (freshRole) bucket.grantReadWrite(freshRole);
    const registeredWith = freshRole ?? (own ? role : undefined);

    const registration = new lakeformation.CfnResource(this, 'Registration', {
      resourceArn: bucket.bucketArn,
      useServiceLinkedRole: registeredWith === undefined,
      ...(registeredWith && { roleArn: registeredWith.roleArn }),
    });
    // The role's policy must exist before Lake Formation registers with it.
    registration.node.addDependency(role);
    if (freshRole) registration.node.addDependency(freshRole);
  }
}
