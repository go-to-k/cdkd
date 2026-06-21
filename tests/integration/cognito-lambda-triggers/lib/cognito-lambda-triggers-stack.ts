import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * cdkd Cognito UserPool Lambda triggers (preSignUp / postConfirmation) integ.
 *
 * A daily CDK pattern: a UserPool with `lambdaTriggers`. CDK wires a UserPool
 * `LambdaConfig` map (one ARN per trigger) + one AWS::Lambda::Permission per
 * trigger granting `cognito-idp.amazonaws.com` invoke. cdkd must apply the
 * LambdaConfig AND the permissions, and order them so the functions exist
 * before the UserPool references them.
 *
 * verify.sh proves the wiring two ways: (1) describe-user-pool LambdaConfig
 * carries both ARNs, and (2) a real sign-up auto-confirms (preSignUp sets
 * autoConfirmUser=true) — the trigger runs INLINE during SignUp, so a CONFIRMED
 * user proves the permission + LambdaConfig actually work end-to-end.
 *
 * covers: AWS::Cognito::UserPool
 * covers: AWS::Cognito::UserPoolClient
 * covers: AWS::Lambda::Permission
 */
export class CognitoLambdaTriggersStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const preSignUp = new lambda.Function(this, 'PreSignUp', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        `exports.handler = async (e) => {
  e.response = e.response || {};
  e.response.autoConfirmUser = true;
  return e;
};`,
      ),
    });

    const postConfirmation = new lambda.Function(this, 'PostConfirmation', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`exports.handler = async (e) => e;`),
    });

    const pool = new cognito.UserPool(this, 'Pool', {
      userPoolName: 'cdkd-cognito-triggers-pool',
      selfSignUpEnabled: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      lambdaTriggers: {
        preSignUp,
        postConfirmation,
      },
    });

    const client = pool.addClient('Client', {
      userPoolClientName: 'cdkd-cognito-triggers-client',
      authFlows: { userPassword: true },
    });

    new cdk.CfnOutput(this, 'UserPoolId', { value: pool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: client.userPoolClientId });
  }
}
