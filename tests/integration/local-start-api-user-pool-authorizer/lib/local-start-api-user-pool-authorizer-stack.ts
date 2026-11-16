import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';

// The container runs natively on the host: cdk-local pins `docker --platform`
// to the declared architecture, and the X86_64 default runs under emulation on
// an arm64 host, which faults the Go RIE.
const HOST_ARCHITECTURE =
  process.arch === 'arm64' ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64;

const HANDLER = `
exports.handler = async (event) => {
  const claims = (event.requestContext.authorizer && event.requestContext.authorizer.jwt && event.requestContext.authorizer.jwt.claims) || {};
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sub: claims.sub, aud: claims.aud, clientIdEnv: process.env.CLIENT_ID }),
  };
};
`;

/**
 * Fixture stack for `cdkd local start-api --from-state` behind an HTTP API
 * `HttpUserPoolAuthorizer` (go-to-k/cdkd#6419).
 *
 * The authorizer's Issuer is a `Fn::Join` over `Ref AWS::Region` and
 * `Ref <UserPool>`; its Audience is `[Ref <UserPoolClient>]`. Only the
 * deployed state can resolve them. Client B is NOT given to the authorizer, so
 * a token minted for it must be refused once the audience is resolved.
 *
 * covers: AWS::Cognito::UserPool
 * covers: AWS::Cognito::UserPoolClient
 * covers: AWS::ApiGatewayV2::Api
 * covers: AWS::ApiGatewayV2::Authorizer
 */
export class LocalStartApiUserPoolAuthorizerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const pool = new cognito.UserPool(this, 'Pool', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const clientA = pool.addClient('ClientA', { authFlows: { adminUserPassword: true } });
    const clientB = pool.addClient('ClientB', { authFlows: { adminUserPassword: true } });

    const fn = new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromInline(HANDLER),
      timeout: cdk.Duration.seconds(10),
      environment: { CLIENT_ID: clientA.userPoolClientId },
    });

    const api = new apigwv2.HttpApi(this, 'Api');
    api.addRoutes({
      path: '/secure',
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration('SecureIntegration', fn),
      authorizer: new HttpUserPoolAuthorizer('Auth', pool, { userPoolClients: [clientA] }),
    });

    new cdk.CfnOutput(this, 'PoolId', { value: pool.userPoolId });
    new cdk.CfnOutput(this, 'ClientAId', { value: clientA.userPoolClientId });
    new cdk.CfnOutput(this, 'ClientBId', { value: clientB.userPoolClientId });
  }
}
