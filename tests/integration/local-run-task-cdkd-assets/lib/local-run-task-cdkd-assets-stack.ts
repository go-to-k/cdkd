import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';

/**
 * Fixture stack for the `cdkd local run-task` custom-qualifier container-assets
 * classification integ (issue #1002 PR 3).
 *
 * One EC2 / bridge task definition whose single container image is a local
 * `ContainerImage.fromAsset` build. Combined with the custom bootstrap
 * qualifier set in bin/app.ts, CDK synthesizes the container `Image` as an
 * `Fn::Sub` referencing `cdk-myqual99-container-assets-<acct>-<region>:<hash>`.
 * The verify script runs `cdkd local run-task` and asserts the container BUILT
 * FROM cdk.out and printed its marker — proving the resolver classified the URI
 * as a CDK asset instead of attempting an ECR pull (the pre-fix behavior for any
 * bootstrap qualifier other than the default `hnb659fds`).
 *
 * No AWS deploy required — the asset builds and runs entirely against local
 * Docker.
 */
export class LocalRunTaskCdkdAssetsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const taskDef = new ecs.TaskDefinition(this, 'AssetTask', {
      compatibility: ecs.Compatibility.EC2,
      networkMode: ecs.NetworkMode.BRIDGE,
    });

    taskDef.addContainer('printer', {
      image: ecs.ContainerImage.fromAsset('image'),
      essential: true,
      memoryReservationMiB: 64,
    });
  }
}
