import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

/**
 * DeletionPolicy: Snapshot fixture (issue #1352).
 *
 * Two 1 GiB gp3 volumes, both `DeletionPolicy: Snapshot`:
 *
 *   - `VolumeKeep`   — survives until `cdkd destroy`, exercising the
 *                      destroy-runner final-snapshot path.
 *   - `VolumeRemove` — omitted from the template when
 *                      `CDKD_TEST_UPDATE=true` (the repo's standard UPDATE
 *                      toggle), so the redeploy exercises the deploy
 *                      engine's DELETE-branch final-snapshot path
 *                      (template-removal delete).
 *
 * `AWS::EC2::Volume` is the cheapest CFn-documented Snapshot-capable type
 * and is CC-API-routed, so both paths run the pre-delete EBS
 * `CreateSnapshot`+wait rather than an atomic provider parameter.
 */
export class DeletionPolicySnapshotStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const az = cdk.Fn.select(0, cdk.Fn.getAzs());

    const volumeKeep = new ec2.CfnVolume(this, 'VolumeKeep', {
      availabilityZone: az,
      size: 1,
      volumeType: 'gp3',
      tags: [{ key: 'cdkd-integ', value: 'deletion-policy-snapshot-keep' }],
    });
    volumeKeep.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.SNAPSHOT;
    new cdk.CfnOutput(this, 'VolumeKeepId', { value: volumeKeep.ref });

    if (process.env.CDKD_TEST_UPDATE !== 'true') {
      const volumeRemove = new ec2.CfnVolume(this, 'VolumeRemove', {
        availabilityZone: az,
        size: 1,
        volumeType: 'gp3',
        tags: [{ key: 'cdkd-integ', value: 'deletion-policy-snapshot-remove' }],
      });
      volumeRemove.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.SNAPSHOT;
      new cdk.CfnOutput(this, 'VolumeRemoveId', { value: volumeRemove.ref });
    }
  }
}
