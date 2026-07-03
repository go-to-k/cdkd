import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';

/**
 * LaunchTemplate + AutoScalingGroup in-place GetAtt propagation fixture (issue #985).
 *
 * The ASG's `LaunchTemplate.Version` is `Fn::GetAtt [Lt, LatestVersionNumber]`.
 * An in-place edit of the LaunchTemplate's `instanceType` (t3.micro -> t3.small
 * under CDKD_TEST_UPDATE=true) bumps the LaunchTemplate's computed
 * LatestVersionNumber 1 -> 2. Before the fix, the ASG was classified NO_CHANGE
 * (its raw template did not change and the diff-time resolution saw the pre-update
 * version "1"), so it stayed pinned at version "1" and only caught up on the NEXT
 * deploy. The verify.sh asserts the ASG re-points to version "2" in the SAME
 * deploy as the LaunchTemplate edit.
 *
 * min/max/desiredCapacity are all 0 so no instances launch — keeps the deploy
 * cheap and destroy fast (no instance teardown wait).
 */
export class LaunchTemplateAsgInplaceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // CDKD_TEST_UPDATE toggles ONLY the instance type — every other property
    // (incl. all ASG props) is identical across the two phases, so the only
    // template delta is the LaunchTemplate's instanceType.
    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';
    const instanceType = isUpdate
      ? ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL)
      : ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    const launchTemplate = new ec2.LaunchTemplate(this, 'Lt', {
      launchTemplateName: 'cdkd-lt-asg-inplace',
      instanceType,
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
    });

    // ASG consumes the LaunchTemplate. CDK renders LaunchTemplate.Version as
    // Fn::GetAtt [Lt, LatestVersionNumber]. Capacity is pinned to 0 so no EC2
    // instances are ever launched.
    new autoscaling.AutoScalingGroup(this, 'Asg', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      launchTemplate,
      minCapacity: 0,
      maxCapacity: 0,
      desiredCapacity: 0,
    });
  }
}
