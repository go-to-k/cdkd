import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3express from 'aws-cdk-lib/aws-s3express';

export class S3DirectoryBucketStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // S3 Express Directory Bucket WITHOUT the auto-delete opt-in: the
    // destroy data guard (issue #1344) must refuse to delete it while it
    // holds an out-of-band object.
    const bucket = new s3express.CfnDirectoryBucket(this, 'DirectoryBucket', {
      dataRedundancy: 'SingleAvailabilityZone',
      locationName: `${this.region}c--x-s3`, // us-east-1c (use1-az4, S3 Express supported)
    });

    // Sibling bucket WITH template Tags (a handled property since issue
    // #609), including the `aws-cdk:auto-delete-objects` opt-in — its
    // data-carrying auto-empty must succeed in the same destroy that the
    // guard refuses on the untagged sibling. Tags are injected via
    // addPropertyOverride so the fixture does not depend on the aws-cdk-lib
    // codegen version that added the L1 `tags` prop.
    //
    // UPDATE mode (CDKD_TEST_UPDATE=true) mutates the tag set to exercise
    // the S3 Control TagResource / UntagResource update path live:
    // `cdkd-integ` changes value, `transient` is removed.
    const updateMode = process.env.CDKD_TEST_UPDATE === 'true';
    const autoBucket = new s3express.CfnDirectoryBucket(this, 'AutoDeleteBucket', {
      dataRedundancy: 'SingleAvailabilityZone',
      locationName: `${this.region}c--x-s3`,
    });
    autoBucket.addPropertyOverride('Tags', [
      { Key: 'aws-cdk:auto-delete-objects', Value: 'true' },
      { Key: 'cdkd-integ', Value: updateMode ? 'updated' : 'initial' },
      ...(updateMode ? [] : [{ Key: 'transient', Value: 'drop-me' }]),
    ]);

    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.ref,
      description: 'Directory Bucket name (no opt-in — guard target)',
    });

    new cdk.CfnOutput(this, 'BucketArn', {
      value: bucket.attrArn,
      description: 'Directory Bucket ARN',
    });

    new cdk.CfnOutput(this, 'AutoBucketName', {
      value: autoBucket.ref,
      description: 'Tagged directory bucket name (auto-delete opt-in)',
    });

    new cdk.CfnOutput(this, 'AutoBucketArn', {
      value: autoBucket.attrArn,
      description: 'Tagged directory bucket ARN',
    });
  }
}
