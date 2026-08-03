import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

/**
 * `DeletionPolicy: Snapshot` on a ROLLED-BACK CREATE (issue #1358).
 *
 * A deploy that creates two resources and fails on the second rolls the
 * first one back. cdkd used to ORPHAN a rolled-back CREATE carrying
 * `DeletionPolicy: Snapshot` (left in AWS, dropped from state) — an
 * untracked, billing resource after a deploy that reported a completed
 * rollback. CloudFormation deletes it, honoring the policy: final snapshot
 * first, then delete.
 *
 * The fixture forces exactly that shape:
 *
 *   - `VolumeSnap`  — a 1 GiB gp3 EBS volume, `DeletionPolicy: Snapshot`.
 *                     Cheapest CFn-documented Snapshot-capable type.
 *   - `BadQueue`    — an `AWS::SQS::Queue` with an out-of-range
 *                     `MessageRetentionPeriod` (the repo's standard failure
 *                     injection). `DependsOn` the volume, so the volume is
 *                     always COMPLETED before the failure fires and is
 *                     therefore a rollback target rather than a never-created
 *                     resource.
 *
 * The whole point is that the deploy FAILS, so there is no `CDKD_TEST_FAIL`
 * toggle: the stack is always the failing shape and `verify.sh` asserts a
 * non-zero deploy exit.
 */
export class RollbackDeletionPolicySnapshotStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const volume = new ec2.CfnVolume(this, 'VolumeSnap', {
      availabilityZone: cdk.Fn.select(0, cdk.Fn.getAzs()),
      size: 1,
      volumeType: 'gp3',
      tags: [{ key: 'cdkd-integ', value: 'rollback-deletion-policy-snapshot' }],
    });
    volume.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.SNAPSHOT;
    new cdk.CfnOutput(this, 'VolumeSnapId', { value: volume.ref });

    // MessageRetentionPeriod must be 60..1209600; 1 is rejected by AWS, so
    // this resource always fails to create.
    const badQueue = new sqs.CfnQueue(this, 'BadQueue', {
      messageRetentionPeriod: 1,
    });
    badQueue.addDependency(volume);
  }
}
