import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * IAM principal lists whose NAMES come from a Secrets Manager secret
 * (go-to-k/cdkd#3906, go-to-k/cdkd#3888).
 *
 * cdkd persists a secret-derived value REDACTED: state records the
 * `{{resolve:secretsmanager:...}}` expression, never the resolved name. So on
 * every later update the RECORDED list is secret-derived and cannot be diffed
 * from the record. cdkd reads that kind from IAM instead, ADD-only for a
 * ManagedPolicy's `Roles` and a User's `Groups`: it attaches what the template
 * names and detaches nothing on IAM's evidence (IAM's list includes attachments
 * made elsewhere).
 *
 * The types with NO live source for the recorded side, an inline
 * AWS::IAM::Policy's `Roles` and a UserToGroupAddition's `Users`, instead have
 * the unchanged reference dropped from the recorded side (go-to-k/cdkd#4064),
 * so the provider re-applies it: a plain record diff, no ADD-only reading.
 *
 * `verify.sh` creates the role, the group and the user OUTSIDE the stack and
 * seeds the secret `SDP_SECRET_NAME` with their names (`{"role": ...,
 * "group": ..., "user": ...}`), so the names appear nowhere in the template:
 * the only way into state is through the secret, which is what the plaintext
 * sweep checks.
 *
 * Deploys:
 *   - `SecretPolicy` (AWS::IAM::ManagedPolicy), `Roles: [<secret role>]`.
 *   - `SecretMember` (AWS::IAM::User), `Groups: [<secret group>]`.
 *   - `SecretInlinePolicy` (AWS::IAM::Policy), `Roles: [<secret role>]`.
 *   - `SecretGroupAddition` (AWS::IAM::UserToGroupAddition) into
 *     `AdditionGroup`, `Users: [<secret user>]`.
 *   - `AddedRole` / `AddedGroup`, the principals the update adds.
 *
 * UPDATE (CDKD_TEST_UPDATE=true) changes both policy documents (an unrelated
 * change that forces the in-place update) and ADDS `AddedRole` to both
 * policies, `AddedGroup` to the user and `SecretMember` to the addition,
 * keeping the secret-derived ones.
 */
export class IamSecretDerivedPrincipalsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const update = process.env.CDKD_TEST_UPDATE === 'true';
    // A placeholder keeps `cdk synth` working without the script; a deploy
    // against it fails at resolve time, which is the loud outcome.
    const secretName = process.env.SDP_SECRET_NAME ?? 'cdkd-integ-sdp-unset';
    const fromSecret = (jsonField: string): string =>
      cdk.SecretValue.secretsManager(secretName, { jsonField }).unsafeUnwrap();

    const addedRole = new iam.Role(this, 'AddedRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Added to the secret-named policy by the update (cdkd integ)',
    });
    const addedGroup = new iam.Group(this, 'AddedGroup');

    const actions = update
      ? ['logs:DescribeLogGroups', 'logs:GetLogEvents']
      : ['logs:DescribeLogGroups'];
    new iam.CfnManagedPolicy(this, 'SecretPolicy', {
      description: 'Attached to a role named through a secret (cdkd integ)',
      policyDocument: {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: actions, Resource: '*' }],
      },
      roles: update ? [fromSecret('role'), addedRole.roleName] : [fromSecret('role')],
    });

    const member = new iam.CfnUser(this, 'SecretMember', {
      groups: update ? [fromSecret('group'), addedGroup.groupName] : [fromSecret('group')],
    });

    // go-to-k/cdkd#4064: the recorded `Roles` / `Users` hold the reference, and
    // neither provider can read the old side from IAM. The fixed name keeps
    // verify.sh's readbacks exact; the stack name is fixed, so no two runs
    // share it (the pre-flight refuses a leftover state).
    new iam.CfnPolicy(this, 'SecretInlinePolicy', {
      policyName: 'cdkd-integ-sdp-inline',
      policyDocument: {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: actions, Resource: '*' }],
      },
      roles: update ? [fromSecret('role'), addedRole.roleName] : [fromSecret('role')],
    });
    const additionGroup = new iam.Group(this, 'AdditionGroup');
    new iam.CfnUserToGroupAddition(this, 'SecretGroupAddition', {
      groupName: additionGroup.groupName,
      users: update ? [fromSecret('user'), member.ref] : [fromSecret('user')],
    });
  }
}
