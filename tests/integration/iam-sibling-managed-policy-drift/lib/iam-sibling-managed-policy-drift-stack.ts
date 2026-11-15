import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Integ probe for go-to-k/cdkd#6324: a managed policy that a SIBLING
 * `AWS::IAM::ManagedPolicy` attaches to an IAM principal through its own
 * `Roles` / `Users` / `Groups` list is that resource's, not the principal's.
 *
 * Before the fix `cdkd drift` reported it as `ManagedPolicyArns` drift on the
 * role of a freshly deployed stack, and `cdkd drift --revert` DETACHED it
 * while printing success.
 *
 * - The role declares one AWS managed policy of its own, so its
 *   `ManagedPolicyArns` is non-empty and the filter must keep the declared
 *   ARN while dropping the sibling's.
 * - A user and a group take the same sibling attachment through `Users` /
 *   `Groups`, each declaring `IAMUserChangePassword` of its own.
 *
 * covers: AWS::IAM::Role
 * covers: AWS::IAM::User
 * covers: AWS::IAM::Group
 * covers: AWS::IAM::ManagedPolicy
 */
export class IamSiblingManagedPolicyDriftStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const role = new iam.Role(this, 'Role', {
      roleName: 'cdkd-iam-sibling-mp-role',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    // The user and the group declare one AWS managed policy of their own too,
    // so their `ManagedPolicyArns` is compared (an undeclared, empty baseline
    // key is skipped) and an out-of-band attach on them reports.
    const own = iam.ManagedPolicy.fromAwsManagedPolicyName('IAMUserChangePassword');
    const user = new iam.User(this, 'User', {
      userName: 'cdkd-iam-sibling-mp-user',
      managedPolicies: [own],
    });
    const group = new iam.Group(this, 'Group', {
      groupName: 'cdkd-iam-sibling-mp-group',
      managedPolicies: [own],
    });

    new iam.ManagedPolicy(this, 'Mp', {
      managedPolicyName: 'cdkd-iam-sibling-mp-policy',
      roles: [role],
      users: [user],
      groups: [group],
      statements: [new iam.PolicyStatement({ actions: ['sqs:GetQueueUrl'], resources: ['*'] })],
    });
  }
}
