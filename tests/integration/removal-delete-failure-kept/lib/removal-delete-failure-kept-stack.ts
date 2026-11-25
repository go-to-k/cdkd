import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

/**
 * Issue #6969: a resource removed from the template whose delete AWS refuses.
 *
 * - default: `Main` queue (VisibilityTimeout 30), plus a `Data` bucket
 *   (DESTROY, no autoDeleteObjects) that DependsOn an `Anchor` queue.
 * - `CDKD_TEST_UPDATE=true`: `Main` at 60, and `Data` + `Anchor` removed.
 *   `verify.sh` puts an object in the bucket first, so its delete is refused.
 *   The deploy must keep Main's update (CloudFormation ends UPDATE_COMPLETE),
 *   keep the bucket's record, and keep `Anchor`, which the bucket depends on.
 *
 * The bucket name is fixed so `verify.sh` can probe and clean it up.
 */
export class RemovalDeleteFailureKeptStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const removed = process.env.CDKD_TEST_UPDATE === 'true';

    new sqs.Queue(this, 'Main', {
      visibilityTimeout: cdk.Duration.seconds(removed ? 60 : 30),
    });

    if (!removed) {
      const anchor = new sqs.Queue(this, 'Anchor');
      const bucket = new s3.Bucket(this, 'Data', {
        bucketName: `cdkd-removal-kept-${this.account}-${this.region}`,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      bucket.node.addDependency(anchor);
    }
  }
}
