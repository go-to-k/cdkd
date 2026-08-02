import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

/**
 * Destroy data guards (issue #1340): four resources exercising both sides of
 * the CloudFormation-parity force-cleanup gate.
 *
 * - GuardedBucket / GuardedRepo carry NO force-cleanup opt-in. With data
 *   loaded out of band, `cdkd destroy` must FAIL on them (CFn DELETE_FAILED
 *   parity) and leave the data intact.
 * - OptInBucket carries the `aws-cdk:auto-delete-objects` tag — the exact
 *   signal CDK's `autoDeleteObjects: true` stamps on the bucket and the one
 *   cdkd's S3 provider gates its auto-empty on. The tag is applied directly
 *   (not via `autoDeleteObjects: true`) so the fixture tests cdkd's gate in
 *   isolation, without the CDK custom resource emptying the bucket first;
 *   the full custom-resource flow is exercised by the `bucket-deployment`
 *   fixture. The bucket is VERSIONED so the auto-empty path is proven
 *   against object versions + delete markers.
 * - OptInRepo carries `emptyOnDelete: true` (`EmptyOnDelete: true` in the
 *   template) — cdkd force-deletes it images and all.
 */
export class DestroyDataGuardStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new s3.Bucket(this, 'GuardedBucket', {
      bucketName: `cdkd-test-ddg-guarded-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const optInBucket = new s3.Bucket(this, 'OptInBucket', {
      bucketName: `cdkd-test-ddg-optin-${this.account}`,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    cdk.Tags.of(optInBucket).add('aws-cdk:auto-delete-objects', 'true');

    new ecr.Repository(this, 'GuardedRepo', {
      repositoryName: 'cdkd-test-ddg-guarded-repo',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new ecr.Repository(this, 'OptInRepo', {
      repositoryName: 'cdkd-test-ddg-optin-repo',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });
  }
}
