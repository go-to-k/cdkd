import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';

/**
 * Cognito UserPoolUser compound-id `Ref` regression fixture.
 *
 * `AWS::Cognito::UserPoolUser` has no SDK provider, so it routes through Cloud
 * Control, whose primaryIdentifier is the compound `<userPoolId>|<username>`;
 * cdkd stores that compound as the physicalId. CloudFormation's `Ref` for the
 * type returns ONLY the trailing `<username>` segment. Before the fix the type
 * was missing from `REF_RETURNS_SEGMENT_AFTER_PIPE`, so cdkd's resolver handed
 * back the whole compound.
 *
 * The `CfnUserPoolUserToGroupAttachment` below sets `username: user.ref`
 * (the natural CDK pattern, since there is no L2 and `CfnUserPoolUser` exposes
 * no `Attr*` getter). Without the fix, `user.ref` resolves to
 * `<userPoolId>|admin` and the attachment's AdminAddUserToGroup call fails
 * ("User does not exist" / invalid username). With the fix it resolves to the
 * bare `admin` and the attachment succeeds — found by the compound-id-Ref
 * family audit (the missed Cognito sibling).
 *
 * The UserPool gets `RemovalPolicy.DESTROY` (CDK defaults it to RETAIN) so
 * destroy leaves zero orphans.
 */
export class CognitoUserPoolUserRefStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const pool = new cognito.UserPool(this, 'Pool', {
      userPoolName: `${this.stackName}-pool`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const group = new cognito.CfnUserPoolGroup(this, 'Group', {
      userPoolId: pool.userPoolId,
      groupName: 'admins',
    });

    const user = new cognito.CfnUserPoolUser(this, 'User', {
      userPoolId: pool.userPoolId,
      username: 'admin',
      // Suppress the welcome message so the create needs no email/phone delivery.
      messageAction: 'SUPPRESS',
    });

    // The load-bearing line: username consumes the UserPoolUser's Ref. Without
    // the after-pipe fix this is the compound `<poolId>|admin` and AWS rejects it.
    new cognito.CfnUserPoolUserToGroupAttachment(this, 'Attach', {
      userPoolId: pool.userPoolId,
      groupName: group.ref,
      username: user.ref,
    });
  }
}
