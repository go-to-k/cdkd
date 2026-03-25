#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Example CDK stack for testing cdkq
 */
class ExampleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // S3 Bucket
    new s3.Bucket(this, 'ExampleBucket', {
      bucketName: `cdkq-example-bucket-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Lambda Function (inline code - no assets)
    new lambda.Function(this, 'ExampleFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          console.log('Hello from cdkq!');
          return { statusCode: 200, body: 'Hello from cdkq!' };
        };
      `),
    });

    // Output
    new cdk.CfnOutput(this, 'StackName', {
      value: this.stackName,
      description: 'The name of the stack',
    });
  }
}

const app = new cdk.App();
new ExampleStack(app, 'CdkqExampleStack');
