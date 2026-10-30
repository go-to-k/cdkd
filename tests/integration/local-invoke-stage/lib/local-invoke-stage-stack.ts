import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import {
  HttpLambdaAuthorizer,
  HttpLambdaResponseType,
} from 'aws-cdk-lib/aws-apigatewayv2-authorizers';

/**
 * Declare the HOST architecture on every function in this fixture (the shape
 * `tests/integration/local-invoke/lib/local-invoke-stack.ts` set, fenced by
 * `tests/unit/scripts/integ-fixture-host-architecture.test.ts`): a function
 * with no `architecture` is `X86_64`, which runs emulated on an arm64 host.
 */
const HOST_ARCHITECTURE =
  process.arch === 'arm64' ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64;

export interface MarkerStackProps extends cdk.StackProps {
  /** Returned by the handler, so a response names the stack it came from. */
  marker: string;
  /**
   * Also front the handler with an HTTP API `Api` whose Stage variable and
   * CORS origin carry the marker (issue go-to-k/cdkd#5181), so a response
   * proves which stack's Stage and CORS served it. Its Lambda authorizer
   * (cached 300 s) allows only `Authorization: Bearer <marker>`, so a verdict
   * cached for one stack must never answer the other stack's API.
   */
  httpApi?: boolean;
}

/**
 * One inline Lambda whose response carries this stack's marker, fronted by a
 * Function URL so `cdkd local start-api` can serve it too.
 */
export class MarkerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MarkerStackProps) {
    super(scope, id, props);

    const handler = new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        `exports.handler = async (event) => ({ marker: ${JSON.stringify(props.marker)}, ` +
          `stageVar: (event && event.stageVariables && event.stageVariables.marker) || null });`
      ),
      timeout: cdk.Duration.seconds(10),
    });
    handler.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    if (props.httpApi) {
      const api = new apigwv2.HttpApi(this, 'Api', {
        createDefaultStage: false,
        corsPreflight: {
          allowOrigins: [`https://${props.marker}.example`],
          allowMethods: [apigwv2.CorsHttpMethod.GET],
        },
      });
      const authHandler = new lambda.Function(this, 'AuthHandler', {
        runtime: lambda.Runtime.NODEJS_20_X,
        architecture: HOST_ARCHITECTURE,
        handler: 'index.handler',
        code: lambda.Code.fromInline(
          `exports.handler = async (event) => ({ isAuthorized: ` +
            `((event && event.headers && event.headers.authorization) || '') === ` +
            `${JSON.stringify(`Bearer ${props.marker}`)} });`
        ),
        timeout: cdk.Duration.seconds(10),
      });
      api.addRoutes({
        path: '/',
        methods: [apigwv2.HttpMethod.GET],
        integration: new HttpLambdaIntegration('Integration', handler),
        authorizer: new HttpLambdaAuthorizer('Authorizer', authHandler, {
          responseTypes: [HttpLambdaResponseType.SIMPLE],
          resultsCacheTtl: cdk.Duration.seconds(300),
        }),
      });
      new apigwv2.CfnStage(this, 'Stage', {
        apiId: api.apiId,
        stageName: '$default',
        autoDeploy: true,
        stageVariables: { marker: props.marker },
      });
    }
  }
}
