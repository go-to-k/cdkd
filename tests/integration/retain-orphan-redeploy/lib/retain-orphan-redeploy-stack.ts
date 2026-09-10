import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Retain-orphan-redeploy integ stack (issue #2902).
 *
 * The reported loop, reduced to the smallest shape that reproduces it: a
 * resource whose physical name cdkd GENERATES, of a type that REFUSES a
 * colliding create.
 *
 * Both properties are load-bearing and neither is incidental:
 *
 *   - No `roleName`, so `generateResourceName` derives
 *     `{stackName}-{logicalId}` with no random component. A template-named
 *     resource would not exercise the diagnosis at all, because the advice
 *     deliberately refuses a name cdkd did not derive.
 *   - `AWS::IAM::Role`, because it answers a duplicate name with
 *     `EntityAlreadyExists`. Several types do NOT: `AWS::S3::Bucket`,
 *     `AWS::Logs::LogGroup` and `AWS::SNS::Topic` silently ADOPT an existing
 *     resource, so a fixture built on one of those would redeploy green and
 *     assert nothing — the failure mode this fixture exists to catch.
 *
 * The role is deliberately trivial (an assumable principal, no policies): the
 * subject under test is cdkd's naming and its recovery advice, not IAM.
 *
 * `RemovalPolicy.DESTROY` is explicit. The ORPHAN this fixture needs is
 * manufactured by `cdkd state orphan`, which drops the state record and leaves
 * AWS untouched — the same end state a `DeletionPolicy: Retain` rollback
 * produces, reached deterministically instead of by injecting a failure whose
 * timing decides what got created. Retain here would only leak the role.
 */
export class RetainOrphanRedeployStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const role = new iam.Role(this, 'OrphanedRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Resource whose cdkd-generated name the redeploy collides with',
    });
    role.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new cdk.CfnOutput(this, 'RoleName', { value: role.roleName });
  }
}
