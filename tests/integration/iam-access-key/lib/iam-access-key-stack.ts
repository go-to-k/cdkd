import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

/**
 * Fixture for issue #1323: the AWS::IAM::AccessKey SDK provider.
 *
 * The documented CDK pattern for CI credentials: an IAM user, an access key,
 * and the key's create-time-only SecretAccessKey piped into a Secrets Manager
 * secret via `Fn::GetAtt` — the attribute IAM returns ONLY from
 * CreateAccessKey, so this exercises the provider's cached-attribute
 * resolution end to end.
 *
 * CREATE: user + key (Active) + secret holding the SecretAccessKey.
 * UPDATE (CDKD_TEST_UPDATE=true): flips the key Status to Inactive — the only
 * in-place-mutable property per the registry schema (UserName / Serial are
 * createOnly). The cached SecretAccessKey must SURVIVE the update (the
 * provider omits attributes on update so the create-time secret is not wiped).
 * The same update moves the user and a group to another `Path`, which is
 * mutable in place (#3723: cdkd used to drop it on update).
 *
 * The user also has a console login profile (go-to-k/cdkd#6755): verify.sh
 * flips its PasswordResetRequired out of band and expects drift.
 */
export class IamAccessKeyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    const path = isUpdate ? '/cdkd-moved/' : undefined;

    // go-to-k/cdkd#6755: a console login profile, so drift reads its
    // PasswordResetRequired back. The password is a generated secret, read by
    // a plain-NAME dynamic reference (a CDK token would render an Fn::Join), so
    // cdkd persists the reference and never the value; the explicit dependency
    // stands in for the edge a name reference does not create.
    const loginPassword = new secretsmanager.Secret(this, 'CiLoginPassword', {
      secretName: 'cdkd-iam-access-key-login-password',
      generateSecretString: { passwordLength: 32 },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const user = new iam.User(this, 'CiUser', {
      userName: 'cdkd-iam-access-key-user',
      path,
      password: cdk.SecretValue.secretsManager('cdkd-iam-access-key-login-password'),
      passwordResetRequired: false,
    });
    user.node.addDependency(loginPassword);

    new iam.Group(this, 'CiGroup', {
      groupName: 'cdkd-iam-access-key-group',
      path,
    });

    const key = new iam.AccessKey(this, 'CiKey', {
      user,
      status: isUpdate ? iam.AccessKeyStatus.INACTIVE : iam.AccessKeyStatus.ACTIVE,
    });

    const secret = new secretsmanager.Secret(this, 'CiSecret', {
      secretName: 'cdkd-iam-access-key-secret',
      secretStringValue: key.secretAccessKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'AccessKeyId', { value: key.accessKeyId });
    new cdk.CfnOutput(this, 'SecretArn', { value: secret.secretArn });
  }
}
