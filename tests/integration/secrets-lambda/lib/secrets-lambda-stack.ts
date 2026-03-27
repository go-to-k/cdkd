import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Secrets Manager + Lambda integration test stack
 *
 * Demonstrates:
 * - SecretsManager Secret with generated secret value
 * - Lambda Function (inline Python) reading the secret ARN
 * - IAM policy granting Lambda read access to the secret (grantRead)
 * - CfnOutputs for secret ARN and function name
 */
export class SecretsLambdaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create Secrets Manager Secret with generated value
    const secret = new secretsmanager.Secret(this, 'AppSecret', {
      description: 'Secret for Lambda integration test',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 16,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create Lambda Function with inline Python code
    const fn = new lambda.Function(this, 'SecretReader', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import os
import json
import boto3

def handler(event, context):
    secret_arn = os.environ['SECRET_ARN']
    client = boto3.client('secretsmanager')
    response = client.get_secret_value(SecretId=secret_arn)
    secret_value = json.loads(response['SecretString'])
    return {
        'statusCode': 200,
        'body': json.dumps({
            'message': 'Secret retrieved successfully',
            'username': secret_value.get('username'),
            'has_password': 'password' in secret_value,
        }),
    }
`),
      environment: {
        SECRET_ARN: secret.secretArn,
      },
      timeout: cdk.Duration.seconds(30),
    });

    // Grant Lambda read access to the secret
    secret.grantRead(fn);

    // Outputs
    new cdk.CfnOutput(this, 'SecretArn', {
      value: secret.secretArn,
      description: 'Secrets Manager Secret ARN',
    });

    new cdk.CfnOutput(this, 'FunctionName', {
      value: fn.functionName,
      description: 'Lambda Function name',
    });
  }
}
