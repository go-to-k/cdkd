import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Integ probe for issue #6303: state-persist secret redaction replaced every
 * occurrence of a resolved secret's plaintext, even inside an unrelated plain
 * template literal. With a generated secret whose username is `postgres`, the
 * literal `engine aurora-postgresql` was stored as
 * `engine aurora-{{resolve:secretsmanager:...:SecretString:username::}}ql`,
 * so the next `cdkd diff` reported a change (an Aurora cluster's `Engine`
 * read as a replacement).
 *
 * covers: AWS::SecretsManager::Secret, AWS::SSM::Parameter
 *
 * `Param.Value` is filled from the secret (a real reference, stays a
 * `{{resolve:...}}` expression in state); `Param.Description` is a plain
 * literal that merely contains the username as a substring.
 */
export class SecretSubstringLiteralStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const secret = new secretsmanager.Secret(this, 'DbSecret', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'postgres' }),
        generateStringKey: 'password',
        excludePunctuation: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new ssm.CfnParameter(this, 'Param', {
      type: 'String',
      value: secret.secretValueFromJson('username').unsafeUnwrap(),
      description: 'engine aurora-postgresql',
    });
  }
}
