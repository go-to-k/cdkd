import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
/**
 * Serverless API example stack
 *
 * Demonstrates a realistic serverless API pattern combining:
 * - API Gateway V2 HTTP API (CfnApi, CfnStage, CfnIntegration, CfnRoute L1 constructs)
 * - Lambda Function with inline Python handler returning JSON
 * - DynamoDB Table for data persistence
 * - SNS Topic for notifications
 * - IAM permissions via grantReadWriteData / grantPublish
 * - CfnOutputs for API URL, table name, topic ARN
 */
export class ServerlessApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Tags for identification
    cdk.Tags.of(this).add('Project', 'cdkd');
    cdk.Tags.of(this).add('Example', 'serverless-api');

    // DynamoDB Table
    const table = new dynamodb.Table(this, 'ItemsTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // SNS Topic for notifications
    const topic = new sns.Topic(this, 'NotificationTopic', {
      displayName: 'Serverless API Notifications',
    });

    // Lambda Function with inline Python handler
    const fn = new lambda.Function(this, 'ApiHandler', {
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromInline(
        `
import json
import os

def handler(event, context):
    table_name = os.environ.get('TABLE_NAME', 'unknown')
    topic_arn = os.environ.get('TOPIC_ARN', 'unknown')
    return {
        'statusCode': 200,
        'headers': {'Content-Type': 'application/json'},
        'body': json.dumps({
            'message': 'Hello from Serverless API!',
            'table': table_name,
            'topic': topic_arn,
        })
    }
      `.trim()
      ),
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(10),
      environment: {
        TABLE_NAME: table.tableName,
        TOPIC_ARN: topic.topicArn,
      },
    });

    // Grant permissions
    table.grantReadWriteData(fn);
    topic.grantPublish(fn);

    // Lambda permission for API Gateway V2 to invoke the function
    new lambda.CfnPermission(this, 'ApiInvokePermission', {
      action: 'lambda:InvokeFunction',
      functionName: fn.functionName,
      principal: 'apigateway.amazonaws.com',
    });

    // Cognito UserPool for JWT auth
    const userPool = new cognito.UserPool(this, 'ApiUserPool', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userPoolClient = userPool.addClient('ApiClient');

    // API Gateway V2 HTTP API (L1 constructs)
    const httpApi = new apigatewayv2.CfnApi(this, 'HttpApi', {
      name: 'cdkd-serverless-api',
      protocolType: 'HTTP',
      description: 'Serverless HTTP API for cdkd testing',
    });

    // Default stage with auto-deploy
    new apigatewayv2.CfnStage(this, 'DefaultStage', {
      apiId: httpApi.ref,
      stageName: '$default',
      autoDeploy: true,
    });

    // Lambda integration
    const integration = new apigatewayv2.CfnIntegration(this, 'LambdaIntegration', {
      apiId: httpApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: fn.functionArn,
      payloadFormatVersion: '2.0',
    });

    // JWT Authorizer
    const authorizer = new apigatewayv2.CfnAuthorizer(this, 'JwtAuthorizer', {
      apiId: httpApi.ref,
      authorizerType: 'JWT',
      name: 'jwt-authorizer',
      identitySource: ['$request.header.Authorization'],
      jwtConfiguration: {
        audience: [userPoolClient.userPoolClientId],
        issuer: `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      },
    });

    // Default route with JWT authorization
    new apigatewayv2.CfnRoute(this, 'DefaultRoute', {
      apiId: httpApi.ref,
      routeKey: '$default',
      authorizationType: 'JWT',
      authorizerId: authorizer.ref,
      target: cdk.Fn.join('/', ['integrations', integration.ref]),
    });

    // Outputs
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: httpApi.attrApiEndpoint,
      description: 'HTTP API URL',
    });

    new cdk.CfnOutput(this, 'TableName', {
      value: table.tableName,
      description: 'DynamoDB Table name',
    });

    new cdk.CfnOutput(this, 'TopicArn', {
      value: topic.topicArn,
      description: 'SNS Topic ARN',
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito UserPool ID',
    });
  }
}
