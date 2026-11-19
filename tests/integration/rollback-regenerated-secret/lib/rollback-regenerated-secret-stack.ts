import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

/**
 * go-to-k/cdkd#6591: a rollback that regenerates a secret restores a reader of
 * that secret with the value the secret holds after its revert.
 *
 * v1 (default): a generated secret (`passwordLength: 20`) and a Lambda whose
 * `PW` environment variable reads the secret's `password` through a
 * `{{resolve:secretsmanager:...}}` dynamic reference (a `Ref` to the secret,
 * so the function depends on it).
 *
 * v2 (`ROLLBACK_SECRET_FAIL=true`): `passwordLength: 24` (AWS generates a new
 * password), `PLAIN` changes so the function updates too, and an
 * `AWS::SQS::Queue` with an out-of-range `MessageRetentionPeriod` (valid range
 * [60, 1209600]) depends on the function, so both updates complete before the
 * queue's create fails. The rollback restores the secret, which generates yet
 * another password, as CloudFormation's rollback does. Before the fix the
 * function was restored first, with the password from before the deploy.
 *
 * v3 (`ROLLBACK_SECRET_FAIL=reader`, go-to-k/cdkd#6597): the same secret and
 * `PLAIN` changes, with no failing queue; the function's own update fails
 * (`MemorySize: 20000`). The rollback must revert the failed function after
 * the secret, at the secret's regenerated value.
 */
export class RollbackRegeneratedSecretStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const mode = process.env.ROLLBACK_SECRET_FAIL;
    const fail = mode === 'true' || mode === 'reader';

    const secret = new secretsmanager.Secret(this, 'Sec', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'app' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: fail ? 24 : 20,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fn = new lambda.Function(this, 'Fn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => "ok";'),
      environment: {
        PW: secret.secretValueFromJson('password').unsafeUnwrap(),
        PLAIN: fail ? 'two' : 'one',
      },
    });

    if (mode === 'reader') {
      // go-to-k/cdkd#6597: the reader's own update fails (Lambda's MemorySize
      // range is [128, 10240]) after the secret's update regenerated it.
      (fn.node.defaultChild as lambda.CfnFunction).addPropertyOverride('MemorySize', 20000);
    }

    new cdk.CfnOutput(this, 'SecretArn', { value: secret.secretArn });
    new cdk.CfnOutput(this, 'FunctionName', { value: fn.functionName });

    if (mode === 'true') {
      // L1, so CDK does not reject the out-of-range value at synth.
      const failing = new sqs.CfnQueue(this, 'FailingQueue', {
        queueName: 'CdkdRollbackRegeneratedSecret-failing',
        messageRetentionPeriod: 10,
      });
      failing.node.addDependency(fn);
    }
  }
}
