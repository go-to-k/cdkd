import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Integ probe for go-to-k/cdkd#6324 (and #6328 / #6343, below): a managed policy that a SIBLING
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
 * covers: AWS::IAM::UserToGroupAddition
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
      // go-to-k/cdkd#6609: an inline policy and a permissions boundary, so the
      // create's baseline capture is checked on both (static: the role stays
      // NO_CHANGE in every later phase).
      inlinePolicies: {
        'cdkd-6609-inline': new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({ actions: ['sqs:ListQueues'], resources: ['*'] })],
        }),
      },
      permissionsBoundary: iam.ManagedPolicy.fromAwsManagedPolicyName('PowerUserAccess'),
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

    // Mode tokens (monotonic: every later deploy keeps `late`):
    //  - `late`: the second deploy adds the Attacher role and puts the
    //    declared-Groups user into the addition. The policy and that user are
    //    NO_CHANGE there, so their baselines stay pinned to what the FIRST
    //    deploy recorded, before either sibling wrote.
    //  - `shrink`: drops the second user from the addition.
    //  - `touch` (go-to-k/cdkd#6343): UPDATEs the policy and the declared-Groups
    //    user while both siblings write, so each one's capture records the
    //    sibling's member on its DECLARED list (`Roles` / `Groups`).
    //  - `drop` (#6343): the Attacher role drops the policy and the addition
    //    drops the declared-Groups user; the policy and that user are NO_CHANGE.
    //  - `rename` (#6343): renames the policy, so it is REPLACED under a new ARN
    //    while the role it attaches is NO_CHANGE.
    const updateMode = (process.env['CDKD_TEST_UPDATE'] ?? '').split(',');
    const late = updateMode.includes('late');
    const shrink = updateMode.includes('shrink');
    const touch = updateMode.includes('touch');
    const drop = updateMode.includes('drop');
    const rename = updateMode.includes('rename');

    const mp = new iam.ManagedPolicy(this, 'Mp', {
      managedPolicyName: rename ? 'cdkd-iam-sibling-mp-policy2' : 'cdkd-iam-sibling-mp-policy',
      roles: [role],
      users: [user],
      groups: [group],
      statements: [
        new iam.PolicyStatement({
          actions: touch ? ['sqs:GetQueueUrl', 'sqs:ListQueues'] : ['sqs:GetQueueUrl'],
          resources: ['*'],
        }),
      ],
    });

    // go-to-k/cdkd#6328, the mirror: a role attaching the policy from ITS side
    // (`ManagedPolicyArns: [{Ref: Mp}]`). The policy's baseline `Roles` is
    // `[role]`, and `ListEntitiesForPolicy` then reports this role too.
    if (late) {
      new iam.Role(this, 'Attacher', {
        roleName: 'cdkd-iam-sibling-mp-attacher',
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: drop ? [] : [mp],
      });
    }

    // go-to-k/cdkd#6328: group membership a sibling `UserToGroupAddition`
    // writes, on users that declare no `Groups` (1 and 2) and on one that does
    // (3).
    const addGroup = new iam.CfnGroup(this, 'AddGroup', { groupName: 'cdkd-iam-sibling-mp-addgroup' });
    const u1 = new iam.CfnUser(this, 'AddUser1', { userName: 'cdkd-iam-sibling-mp-add-u1' });
    const u2 = new iam.CfnUser(this, 'AddUser2', { userName: 'cdkd-iam-sibling-mp-add-u2' });
    // The DECLARED shape: this user lists the first group in its own `Groups`,
    // and (from `late`) the addition puts it in the second one too.
    const u3 = new iam.CfnUser(this, 'AddUser3', {
      userName: 'cdkd-iam-sibling-mp-add-u3',
      groups: [group.groupName],
      ...(touch && { tags: [{ key: 'cdkd-6343', value: 'touch' }] }),
      // go-to-k/cdkd#6609: `touch` replaces the inline policy and adds a
      // permissions boundary, so the update's baseline capture is checked.
      policies: [
        {
          policyName: 'cdkd-6609-u3-inline',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: touch ? ['sqs:GetQueueUrl', 'sqs:ListQueues'] : 'sqs:ListQueues',
                Resource: '*',
              },
            ],
          },
        },
      ],
      ...(touch && {
        permissionsBoundary: `arn:${this.partition}:iam::aws:policy/PowerUserAccess`,
      }),
    });
    new iam.CfnUserToGroupAddition(this, 'Add', {
      groupName: addGroup.ref,
      users: [u1.ref, ...(shrink ? [] : [u2.ref]), ...(late && !drop ? [u3.ref] : [])],
    });
  }
}
