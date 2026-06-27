import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';

/**
 * Cognito federated-auth pattern: UserPool + UserPoolClient + CfnIdentityPool.
 * Neither `AWS::Cognito::IdentityPool` nor (here) the identity-pool wiring is in
 * cdkd's SDK provider set, so the identity pool routes through Cloud Control.
 * Confirmed CLEAN by a /hunt-bugs sweep; this fixture is the regression guard.
 *
 * The UserPool is given `RemovalPolicy.DESTROY` (CDK defaults it to RETAIN) so
 * destroy leaves zero orphans.
 */
export class CognitoIdentityPoolStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${this.stackName}-up`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const client = userPool.addClient('Client', {
      userPoolClientName: `${this.stackName}-client`,
      generateSecret: false,
    });

    const idPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
      identityPoolName: `${this.stackName}_idp`,
      allowUnauthenticatedIdentities: true,
      cognitoIdentityProviders: [
        { clientId: client.userPoolClientId, providerName: userPool.userPoolProviderName },
      ],
    });

    new cdk.CfnOutput(this, 'IdentityPoolId', { value: idPool.ref });
  }
}
