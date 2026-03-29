import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';

/**
 * API Gateway + Cognito + Lambda example stack
 *
 * Demonstrates:
 * - Cognito UserPool and UserPoolClient creation
 * - CfnAuthorizer (L1) for Cognito-based API Gateway authorization
 * - Lambda function with inline Python handler
 * - API Gateway REST API with Cognito authorizer on methods
 * - CfnOutput resolution with Fn::Join for API URL
 * - Cross-service integration (Cognito + API Gateway + Lambda)
 */
export class ApiCognitoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create Cognito UserPool
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'cdkd-api-cognito-pool',
      selfSignUpEnabled: true,
      signInAliases: {
        email: true,
      },
      autoVerify: {
        email: true,
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create Cognito UserPoolClient
    const userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool,
      userPoolClientName: 'cdkd-api-cognito-client',
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      generateSecret: false,
    });

    // Create Lambda function with inline Python handler
    const handler = new lambda.Function(this, 'ApiHandler', {
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromInline(`
import json

def handler(event, context):
    claims = event.get('requestContext', {}).get('authorizer', {}).get('claims', {})
    return {
        'statusCode': 200,
        'headers': {
            'Content-Type': 'application/json',
        },
        'body': json.dumps({
            'message': 'Hello from authenticated API!',
            'user': claims.get('email', 'unknown'),
        }),
    }
      `.trim()),
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(10),
    });

    // Create REST API Gateway
    const api = new apigateway.RestApi(this, 'AuthApi', {
      restApiName: 'cdkd-auth-api',
      description: 'API Gateway with Cognito authorizer for cdkd testing',
    });

    // Create Cognito Authorizer using L1 construct (CfnAuthorizer)
    const authorizer = new apigateway.CfnAuthorizer(this, 'CognitoAuth', {
      restApiId: api.restApiId,
      name: 'CognitoAuthorizer',
      type: 'COGNITO_USER_POOLS',
      providerArns: [userPool.userPoolArn],
      identitySource: 'method.request.header.Authorization',
    });

    // Add GET /secure endpoint with Lambda integration and Cognito authorization
    const secureResource = api.root.addResource('secure');
    secureResource.addMethod('GET', new apigateway.LambdaIntegration(handler), {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: {
        authorizerId: authorizer.ref,
      },
    });

    // Outputs
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'REST API URL',
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito UserPool ID',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito UserPool Client ID',
    });
  }
}
