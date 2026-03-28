import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3tables from 'aws-cdk-lib/aws-s3tables';

export class S3TablesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const tableBucket = new s3tables.CfnTableBucket(this, 'TableBucket', {
      tableBucketName: `${this.stackName}-table-bucket`.toLowerCase(),
    });

    new cdk.CfnOutput(this, 'TableBucketArn', {
      value: tableBucket.attrTableBucketArn,
      description: 'S3 Table Bucket ARN',
    });
  }
}
