import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';

/**
 * Producer fixture: a single S3 bucket whose ARN is exported via the
 * canonical CloudFormation `Output.Export.Name` pattern. The consumer
 * stack imports this value via `cdk.Fn.importValue('IntegBucketArn')`.
 *
 * The bucket uses RemovalPolicy.DESTROY + autoDeleteObjects so the
 * verify.sh teardown step succeeds without manual cleanup.
 */
export class ProducerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'IntegBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new cdk.CfnOutput(this, 'IntegBucketArnOutput', {
      value: bucket.bucketArn,
      exportName: 'IntegBucketArn',
      description:
        'Exported by Producer; imported by Consumer via Fn::ImportValue to ' +
        'exercise the strong-reference destroy refusal.',
    });
  }
}
