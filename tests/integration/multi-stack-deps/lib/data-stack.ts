import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';

/**
 * Data stack that creates DynamoDB table and S3 bucket.
 *
 * Exports table name and bucket name for the AppStack to consume
 * via Fn::ImportValue. Depends on NetworkStack for deployment ordering.
 */
export class DataStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create DynamoDB table
    const table = new dynamodb.Table(this, 'AppTable', {
      partitionKey: {
        name: 'pk',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'sk',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create S3 bucket
    const bucket = new s3.Bucket(this, 'DataBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
    });

    // Export table name
    new cdk.CfnOutput(this, 'TableNameExport', {
      value: table.tableName,
      description: 'DynamoDB table name',
      exportName: 'MultiStackDeps-TableName',
    });

    // Export table ARN
    new cdk.CfnOutput(this, 'TableArnExport', {
      value: table.tableArn,
      description: 'DynamoDB table ARN',
      exportName: 'MultiStackDeps-TableArn',
    });

    // Export bucket name
    new cdk.CfnOutput(this, 'BucketNameExport', {
      value: bucket.bucketName,
      description: 'S3 bucket name',
      exportName: 'MultiStackDeps-BucketName',
    });
  }
}
