import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Benchmark stack: SDK Provider only.
 *
 * All 5 resources are handled by native SDK providers (no CC API polling).
 * Resources are independent so cdkd can provision them in parallel.
 */
export class BenchSdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new s3.Bucket(this, 'Bucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new sqs.Queue(this, 'Queue', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new sns.Topic(this, 'Topic');

    new ssm.StringParameter(this, 'Parameter', {
      parameterName: `/${this.stackName}/benchmark`,
      stringValue: 'benchmark-value',
    });
  }
}
