import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';

/**
 * Drift-revert E2E test stack.
 *
 * Two resources whose providers have first-class readCurrentState +
 * provider.update support, both of which were touched in PRs #167 / #168:
 *
 *  - S3 Bucket with two user tags. inject-drift.ts adds a third tag.
 *    Drift comparator sees the new tag (Tags is always-emitted in
 *    observedProperties since PR #145), provider.update reverts via
 *    PutBucketTagging.
 *  - SNS Topic with DisplayName. inject-drift.ts mutates the DisplayName
 *    via SetTopicAttributes. Drift comparator sees the changed scalar,
 *    provider.update reverts via SetTopicAttributes.
 */
export class DriftRevertStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'DriftBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    cdk.Tags.of(bucket).add('Owner', 'cdkd-integ');
    cdk.Tags.of(bucket).add('Component', 'drift-revert');

    const topic = new sns.Topic(this, 'DriftTopic', {
      displayName: 'integ-display',
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'Name of the S3 bucket targeted by inject-drift.ts',
    });

    new cdk.CfnOutput(this, 'TopicArn', {
      value: topic.topicArn,
      description: 'ARN of the SNS topic targeted by inject-drift.ts',
    });
  }
}
