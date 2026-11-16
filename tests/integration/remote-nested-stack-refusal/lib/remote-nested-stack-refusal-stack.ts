import * as cdk from 'aws-cdk-lib';
import * as sm from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

/**
 * A secret with a HOSTED rotation (go-to-k/cdkd#6385). CDK adds the
 * `AWS::SecretsManager-2024-09-16` transform; its expansion turns the
 * `HostedRotationLambda` into a nested-stack row whose `TemplateURL` is an
 * AWS-hosted Serverless Application Repository template,
 * a nested stack with no local template. cdkd must refuse it after macro
 * expansion and before anything is published or provisioned, so the secret is
 * never created.
 *
 * The secret is NAMED so `verify.sh` can probe that no secret of that name
 * exists after the refusal (a created-then-rolled-back secret would linger in
 * its recovery window and answer the probe).
 */
export class RemoteNestedStackRefusalStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps & { secretName: string }) {
    super(scope, id, props);

    const secret = new sm.Secret(this, 'S', {
      secretName: props.secretName,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'u' }),
        generateStringKey: 'password',
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    secret.addRotationSchedule('Rot', {
      hostedRotation: sm.HostedRotation.mysqlSingleUser(),
      automaticallyAfter: cdk.Duration.days(30),
    });
  }
}
