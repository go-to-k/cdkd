import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';

export interface ProducerStackProps extends cdk.StackProps {
  /**
   * When true, the stack adds a `CfnOutput` with an `Export.Name` carrying
   * the bucket ARN. When false, the stack has the SAME resources but NO
   * output/export.
   *
   * Flipping this from false → true between two deploys produces an
   * Outputs-only change (the bucket resource is identical; only the
   * template's Outputs section gains an entry) — exactly the #875 case
   * where the no-op resource diff must still persist the new export.
   */
  readonly exportArn: boolean;
}

export class ProducerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ProducerStackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'IntegBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    if (props.exportArn) {
      new cdk.CfnOutput(this, 'IntegBucketArnOutput', {
        value: bucket.bucketArn,
        exportName: 'CdkdOutputsOnlyBucketArn',
        description:
          'Exported by Producer only once the Consumer references it. Added ' +
          'without any change to the bucket resource, so the producer deploy ' +
          'is a no-op at the resource level but must still persist this export ' +
          '(Issue #875).',
      });
    }
  }
}
