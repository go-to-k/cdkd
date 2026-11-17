import * as cdk from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

/**
 * `cdkd deploy --update-policy` on Auto Scaling groups (go-to-k/cdkd#6437,
 * go-to-k/cdkd#6457).
 *
 * covers: AWS::AutoScaling::AutoScalingGroup
 * covers: AWS::EC2::LaunchTemplate
 *
 * Two groups of ONE t3.micro each (MinSize 1, MaxSize 2), every instance in one isolated subnet:
 *
 * - `RollingAsg` declares `AutoScalingRollingUpdate` (MaxBatchSize 1,
 *   MinInstancesInService 0, PauseTime PT0S: terminate-then-launch, no warmup,
 *   so a refresh of one instance stays short).
 * - `ReplacingAsg` declares `AutoScalingReplacingUpdate` (`WillReplace: true`).
 *
 * Both also declare `AutoScalingScheduledAction`, as the CDK L2 does by
 * default. Each group has its own launch template whose user data carries a
 * marker that `CDKD_ASG_PHASE` changes, so a phase bumps the template's
 * version, which the group reads through `Fn::GetAtt LatestVersionNumber`
 * (verify.sh reads the version numbers from AWS; a rollback adds one too):
 *
 * | phase | RollingLt marker | ReplacingLt marker | FailingQueue |
 * | --- | --- | --- | --- |
 * | 1 (unset) | v1 | v1 | - |
 * | 2 | v2 | v2 | - |
 * | 3 | v3 | v2 (unchanged) | present (fails to create, after RollingAsg) |
 * | 4 | v4 | v4 | - |
 * | 5 | v5, `AutoScalingInstanceRefresh` instead of the rolling update | v4 (unchanged) | - |
 *
 * `ReplacingAsg` also has a simple scaling policy, a reader of the
 * group by `Ref`: a replacement must re-create it on the new group. Every
 * taggable resource carries the `cdkd-integ` tag, so verify.sh's cleanup finds
 * what a failed run leaves.
 *
 * `FailingQueue` is gated on its own phase on purpose: it never exists in AWS
 * (`MessageRetentionPeriod` 30 is below SQS's minimum of 60), so it is absent
 * from every other phase's template by design.
 */
export class AsgUpdatePolicyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const phase = process.env.CDKD_ASG_PHASE ?? '1';
    const rollingMarker = `v${phase}`;
    const replacingMarker = phase === '3' ? 'v2' : phase === '5' ? 'v4' : `v${phase}`;
    cdk.Tags.of(this).add('cdkd-integ', 'asg-update-policy');

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const rolling = this.group(
      vpc,
      'Rolling',
      rollingMarker,
      phase === '5'
        ? {
            autoScalingScheduledAction: { ignoreUnmodifiedGroupSizeProperties: true },
            // Set through an override below: not every aws-cdk-lib version
            // types `autoScalingInstanceRefresh` on CfnUpdatePolicy.
          }
        : {
            autoScalingScheduledAction: { ignoreUnmodifiedGroupSizeProperties: true },
            autoScalingRollingUpdate: {
              maxBatchSize: 1,
              minInstancesInService: 0,
              pauseTime: 'PT0S',
            },
          }
    );
    if (phase === '5') {
      // One instance: terminate first (MinHealthyPercentage 0), no warmup.
      rolling.addOverride('UpdatePolicy.AutoScalingInstanceRefresh', {
        Strategy: 'Rolling',
        Preferences: { MinHealthyPercentage: 0, MaxHealthyPercentage: 100, InstanceWarmup: 0, SkipMatching: false },
      });
    }
    const replacing = this.group(vpc, 'Replacing', replacingMarker, {
      autoScalingScheduledAction: { ignoreUnmodifiedGroupSizeProperties: true },
      autoScalingReplacingUpdate: { willReplace: true },
    });
    // A simple scaling policy no alarm invokes: a reader of the group that
    // never changes its capacity (a target-tracking one could scale out to 2
    // during a boot and break verify.sh's one-instance checks).
    const policy = new autoscaling.CfnScalingPolicy(this, 'ReplacingCpu', {
      autoScalingGroupName: replacing.ref,
      policyType: 'SimpleScaling',
      adjustmentType: 'ChangeInCapacity',
      scalingAdjustment: 1,
    });
    policy.overrideLogicalId('ReplacingCpu');

    if (phase === '3') {
      const failing = new sqs.CfnQueue(this, 'FailingQueue', { messageRetentionPeriod: 30 });
      failing.overrideLogicalId('FailingQueue');
      failing.addDependency(rolling);
    }
  }

  private group(
    vpc: ec2.IVpc,
    name: string,
    marker: string,
    updatePolicy: cdk.CfnUpdatePolicy
  ): autoscaling.CfnAutoScalingGroup {
    const userData = ec2.UserData.forLinux();
    userData.addCommands(`echo "cdkd-asg-update-policy ${name} ${marker}"`);
    const lt = new ec2.LaunchTemplate(this, `${name}Lt`, {
      launchTemplateName: `cdkd-asg-update-policy-${name.toLowerCase()}`,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      userData,
    });
    (lt.node.defaultChild as ec2.CfnLaunchTemplate).overrideLogicalId(`${name}Lt`);
    const asg = new autoscaling.AutoScalingGroup(this, `${name}Asg`, {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      launchTemplate: lt,
      minCapacity: 1,
      maxCapacity: 2,
    });
    const cfn = asg.node.defaultChild as autoscaling.CfnAutoScalingGroup;
    cfn.overrideLogicalId(`${name}Asg`);
    cfn.cfnOptions.updatePolicy = updatePolicy;
    return cfn;
  }
}
