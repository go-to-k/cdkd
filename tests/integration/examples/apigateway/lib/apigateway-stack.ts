import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';

/**
 * API Gateway + Lambda example stack
 *
 * Demonstrates:
 * - REST API Gateway creation via Cloud Control API
 * - Lambda function with inline code (no asset publishing needed)
 * - Lambda integration with API Gateway
 * - Multiple resource types in one stack (API Gateway, Lambda, IAM)
 * - CfnOutput resolution with Fn::Join for API URL
 */
export class ApiGatewayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create Lambda function with inline code
    const handler = new lambda.Function(this, 'HelloHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromInline(`
exports.handler = async (event) => {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Hello from cdkq!",
      timestamp: new Date().toISOString(),
    }),
  };
};
      `.trim()),
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(10),
    });

    // Create REST API Gateway
    const api = new apigateway.RestApi(this, 'HelloApi', {
      restApiName: 'cdkq-hello-api',
      description: 'A simple API Gateway + Lambda example for cdkq testing',
    });

    // Add GET /hello endpoint with Lambda integration
    const helloResource = api.root.addResource('hello');
    helloResource.addMethod('GET', new apigateway.LambdaIntegration(handler));

    // Outputs
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'REST API URL',
    });

    new cdk.CfnOutput(this, 'ApiId', {
      value: api.restApiId,
      description: 'REST API ID',
    });

    new cdk.CfnOutput(this, 'FunctionName', {
      value: handler.functionName,
      description: 'Lambda function name',
    });

    new cdk.CfnOutput(this, 'FunctionArn', {
      value: handler.functionArn,
      description: 'Lambda function ARN',
    });
  }
}
