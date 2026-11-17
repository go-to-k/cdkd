import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

/**
 * go-to-k/cdkd#6463: a create-first replacement of a type cdkd snapshots
 * BEFORE its delete, under `UpdateReplacePolicy: Snapshot`, deletes the old
 * copy in the deploy's cleanup phase, and the snapshot moves into that
 * deferred delete. A deploy failing after the replacement never reaches the
 * cleanup phase, so its rollback re-adopts the old volume whole and no
 * snapshot of it is taken.
 *
 * - `Vol` is a 1 GiB gp3 EBS volume in the region's first Availability Zone,
 *   or its second under `VOL_AZ=b`. `AvailabilityZone` cannot change in place,
 *   so `VOL_AZ=b` replaces it, the new volume first.
 *   `UpdateReplacePolicy: Snapshot` (a pre-delete snapshot: cdkd takes it and
 *   waits before a plain delete) and `DeletionPolicy: Delete`, so a destroy
 *   takes none. `AWS::EC2::Volume` is Cloud Control routed.
 * - `BREAK=true` adds `BadQueue`, an `AWS::SQS::Queue` with an out-of-range
 *   `MessageRetentionPeriod` that depends on `Vol`, so it fails after the
 *   replacement.
 *
 * covers: AWS::EC2::Volume, AWS::SQS::Queue
 */
export class ReplacePredeleteSnapshotFailedRollbackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('cdkd-integ-fixture', 'replace-predelete-snapshot-failed-rollback');

    const azIndex = process.env.VOL_AZ === 'b' ? 1 : 0;
    const vol = new ec2.CfnVolume(this, 'Vol', {
      availabilityZone: cdk.Fn.select(azIndex, cdk.Fn.getAzs()),
      size: 1,
      volumeType: 'gp3',
    });
    vol.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.DELETE;
    vol.cfnOptions.updateReplacePolicy = cdk.CfnDeletionPolicy.SNAPSHOT;

    if (process.env.BREAK === 'true') {
      // MessageRetentionPeriod must be 60..1209600; AWS rejects 1.
      const badQueue = new sqs.CfnQueue(this, 'BadQueue', { messageRetentionPeriod: 1 });
      badQueue.addDependency(vol);
    }
  }
}
