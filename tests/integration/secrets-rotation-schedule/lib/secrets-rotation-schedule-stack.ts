import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * A Secrets Manager secret with an automatic rotation schedule backed by a
 * rotation Lambda — a common daily pattern. CDK synthesizes:
 *
 *   covers: AWS::SecretsManager::Secret
 *   covers: AWS::SecretsManager::RotationSchedule
 *   covers: AWS::Lambda::Function
 *   covers: AWS::Lambda::Permission
 *
 * `AWS::SecretsManager::RotationSchedule` has NO dedicated cdkd SDK provider, so
 * it routes through the Cloud Control API fallback. This fixture is the
 * regression guard for the CC-API create/destroy of a RotationSchedule that
 * references both the Secret and the Lambda.
 *
 * NOTE — no UPDATE phase by design. CDK's `addRotationSchedule` does not emit
 * `RotateImmediatelyOnUpdate`, so AWS defaults it to true and auto-triggers an
 * immediate rotation on CREATE. With the trivial (no-op) rotation Lambda below
 * that initial rotation never completes, so any later UPDATE of RotationRules
 * is rejected by AWS with "A previous rotation isn't complete" (CloudFormation
 * behaves identically). Testing a rule UPDATE would require a full 4-step
 * (createSecret/setSecret/testSecret/finishSecret) rotation Lambda plus polling
 * for the rotation to finish; that fragility is out of scope here, so this
 * fixture covers CREATE + DESTROY only.
 */
export class SecretsRotationScheduleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const secret = new secretsmanager.Secret(this, 'Secret', {
      secretName: `${cdk.Stack.of(this).stackName}-secret`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
        generateStringKey: 'password',
      },
    });

    // A trivial no-op rotation Lambda — we only verify cdkd can stand up and
    // tear down the RotationSchedule resource, not the rotation logic itself.
    const rotationFn = new lambda.Function(this, 'RotationFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        'exports.handler = async (e) => { console.log(JSON.stringify(e)); return {}; };'
      ),
      timeout: cdk.Duration.seconds(30),
    });

    secret.addRotationSchedule('Rotation', {
      rotationLambda: rotationFn,
      automaticallyAfter: cdk.Duration.days(30),
    });

    new cdk.CfnOutput(this, 'SecretArn', { value: secret.secretArn });
  }
}
