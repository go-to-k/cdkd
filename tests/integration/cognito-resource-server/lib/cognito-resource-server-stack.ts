import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';

/**
 * Exercises the Cloud-Control compound-id `Ref` path for the Cognito
 * UserPool-child family (issue: bug-hunt sweep 2026-06-28).
 *
 * None of UserPoolResourceServer / UserPoolGroup / UserPoolDomain have an SDK
 * provider, so they route through Cloud Control, whose physical id is the
 * compound `<userPoolId>|<child>`. CFn `Ref` of these returns ONLY the trailing
 * `<child>` segment. The UserPoolClient below references the resource server in
 * `AllowedOAuthScopes` via `{Fn::Join: ["", [{Ref: ResourceServer}, "/read"]]}`,
 * so a compound id leaks into the scope as `<userPoolId>|api/read` and Cognito
 * rejects the client create with "Invalid scope requested" unless cdkd's
 * intrinsic resolver extracts the after-pipe segment.
 */
export class CognitoResourceServerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const pool = new cognito.UserPool(this, 'Pool', {
      userPoolName: `${this.stackName}-pool`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const readScope = new cognito.ResourceServerScope({
      scopeName: 'read',
      scopeDescription: 'read access',
    });
    const resourceServer = pool.addResourceServer('Rs', {
      identifier: 'api',
      scopes: [readScope],
    });

    const client = pool.addClient('Client', {
      userPoolClientName: `${this.stackName}-client`,
      generateSecret: true,
      oAuth: {
        flows: { clientCredentials: true },
        scopes: [cognito.OAuthScope.resourceServer(resourceServer, readScope)],
      },
    });

    // UserPoolGroup + UserPoolDomain are the sibling compound-id Ref types.
    new cognito.CfnUserPoolGroup(this, 'Group', {
      userPoolId: pool.userPoolId,
      groupName: `${this.stackName}-admins`,
      precedence: 1,
    });
    pool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: `${this.account}-cdkd-cogrs` },
    });

    new cdk.CfnOutput(this, 'UserPoolId', { value: pool.userPoolId });
    new cdk.CfnOutput(this, 'ClientId', { value: client.userPoolClientId });
  }
}
