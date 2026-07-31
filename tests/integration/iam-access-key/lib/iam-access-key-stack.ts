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
 */
export class IamAccessKeyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    const user = new iam.User(this, 'CiUser', {
      userName: 'cdkd-iam-access-key-user',
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
