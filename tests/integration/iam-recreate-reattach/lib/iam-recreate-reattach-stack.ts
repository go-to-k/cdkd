import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Integ fixture for issue #4461: a fixed-name IAM role and group re-created
 * under the same name (`--recreate-via-cc-api`) lose what is attached to
 * them, since IAM deletes a principal only once its managed policies, instance
 * profiles and members are gone. The attaching resources survive, and the
 * deploy attaches them again.
 *
 * A fixed-name user is re-created too:
 * - `Guardrail`: a managed policy (a Deny) attached to the role, the group AND
 *   the re-created user.
 * - `Profile`: an instance profile holding the role.
 * - `Member`: a fixed-name user in the group (through its `Groups`).
 * - `Membership`: a `UserToGroupAddition` putting a second user in the group.
 * - `GroupInline` / `UserInline`: an inline policy on the group and on the
 *   re-created user (deleted with them, re-put).
 *
 * covers: AWS::IAM::Role
 * covers: AWS::IAM::Group
 * covers: AWS::IAM::User
 * covers: AWS::IAM::ManagedPolicy
 * covers: AWS::IAM::InstanceProfile
 * covers: AWS::IAM::Policy
 * covers: AWS::IAM::UserToGroupAddition
 */
export class IamRecreateReattachStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const prefix = this.stackName;

    const role = new iam.CfnRole(this, 'FixedRole', {
      roleName: `${prefix}-role`,
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' },
        ],
      },
    });
    const group = new iam.CfnGroup(this, 'FixedGroup', { groupName: `${prefix}-group` });
    const user = new iam.CfnUser(this, 'FixedUser', { userName: `${prefix}-user` });

    new iam.CfnManagedPolicy(this, 'Guardrail', {
      managedPolicyName: `${prefix}-guardrail`,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Deny', Action: 's3:DeleteBucket', Resource: '*' }],
      },
      roles: [role.ref],
      groups: [group.ref],
      users: [user.ref],
    });
    new iam.CfnInstanceProfile(this, 'Profile', {
      instanceProfileName: `${prefix}-profile`,
      roles: [role.ref],
    });
    new iam.CfnUser(this, 'Member', { userName: `${prefix}-member`, groups: [group.ref] });
    const added = new iam.CfnUser(this, 'Added', { userName: `${prefix}-added` });
    new iam.CfnUserToGroupAddition(this, 'Membership', {
      groupName: group.ref,
      users: [added.ref],
    });
    new iam.CfnPolicy(this, 'GroupInline', {
      policyName: `${prefix}-inline`,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Deny', Action: 's3:DeleteObject', Resource: '*' }],
      },
      groups: [group.ref],
    });
    new iam.CfnPolicy(this, 'UserInline', {
      policyName: `${prefix}-user-inline`,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Deny', Action: 's3:DeleteObject', Resource: '*' }],
      },
      users: [user.ref],
    });
  }
}
