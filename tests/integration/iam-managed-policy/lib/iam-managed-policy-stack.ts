import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Verifies cdkd's IAM principal-list handling against real AWS: the
 * AWS::IAM::ManagedPolicy provider, plus the three other types whose principal
 * lists cdkd diffs on update (go-to-k/cdkd#3906, go-to-k/cdkd#3888).
 *
 * Deploys:
 *   - Two IAM Roles with sts:AssumeRole for the Lambda service principal.
 *   - A standalone customer-managed policy (AWS::IAM::ManagedPolicy) granting
 *     read access to /tmp/* style log groups. Attached to a role via
 *     `roles: [...]` on the policy itself (NOT via `role.attachManagedPolicy`
 *     which routes through `ManagedPolicyArns` on the Role and would short-
 *     circuit this fixture's target type).
 *   - An AWS::IAM::InstanceProfile holding one role.
 *   - Two groups and three users: MemberB joins a group through its own
 *     `Groups`, and an AWS::IAM::UserToGroupAddition puts MemberA in GroupA.
 *
 * UPDATE (CDKD_TEST_UPDATE=true) SWAPS every list, so each update() diff both
 * adds and removes against a list cdkd recorded at deploy:
 *   - the managed policy moves from ServiceRole to SecondRole;
 *   - the instance profile's role moves from ServiceRole to SecondRole;
 *   - MemberB's `Groups` moves from GroupB to GroupA;
 *   - the UserToGroupAddition's `Users` moves from MemberA to MemberC.
 *
 * Destroy step exercises:
 *   - Detach-before-delete (the ManagedPolicy is attached to a Role).
 *   - The UserToGroupAddition delete, from its recorded `Users`.
 *   - Delete-the-Role afterwards (depends on the ManagedPolicy being detached).
 */
export class IamManagedPolicyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const update = process.env.CDKD_TEST_UPDATE === 'true';

    const role = new iam.Role(this, 'ServiceRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Test role for cdkd IAM ManagedPolicy integ',
    });
    const secondRole = new iam.Role(this, 'SecondRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Second test role for cdkd IAM ManagedPolicy integ',
    });

    new iam.ManagedPolicy(this, 'ReadLogsPolicy', {
      description: 'Grants read access to CloudWatch Logs (cdkd integ test)',
      document: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['logs:DescribeLogGroups', 'logs:GetLogEvents'],
            resources: ['*'],
          }),
        ],
      }),
      roles: [update ? secondRole : role],
    });

    new iam.CfnInstanceProfile(this, 'Profile', {
      roles: [update ? secondRole.roleName : role.roleName],
    });

    const groupA = new iam.Group(this, 'GroupA');
    const groupB = new iam.Group(this, 'GroupB');
    const memberA = new iam.User(this, 'MemberA');
    new iam.User(this, 'MemberB', { groups: [update ? groupA : groupB] });
    const memberC = new iam.User(this, 'MemberC');
    new iam.CfnUserToGroupAddition(this, 'Membership', {
      groupName: groupA.groupName,
      users: [update ? memberC.userName : memberA.userName],
    });

    new cdk.CfnOutput(this, 'ServiceRoleArn', {
      value: role.roleArn,
      description: 'ARN of the service role the managed policy is attached to',
    });
  }
}
