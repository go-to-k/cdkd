import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';

/**
 * LaunchTemplate + AutoScalingGroup in-place GetAtt propagation fixture (issue #985)
 * + UPDATE property-removal reset fixture (issue #1160).
 *
 * Issue #985 leg: the ASG's `LaunchTemplate.Version` is
 * `Fn::GetAtt [Lt, LatestVersionNumber]`. An in-place edit of the
 * LaunchTemplate's `instanceType` (t3.micro -> t3.small under
 * CDKD_TEST_UPDATE=true) bumps the LaunchTemplate's computed
 * LatestVersionNumber 1 -> 2. Before the fix, the ASG was classified NO_CHANGE
 * (its raw template did not change and the diff-time resolution saw the pre-update
 * version "1"), so it stayed pinned at version "1" and only caught up on the NEXT
 * deploy. The verify.sh asserts the ASG re-points to version "2" in the SAME
 * deploy as the LaunchTemplate edit.
 *
 * Issue #1160 leg: phases 1-2 set non-default HealthCheckGracePeriod /
 * MaxInstanceLifetime / TerminationPolicies on the ASG; the removal phase
 * (CDKD_TEST_REMOVAL=true) drops them from the template. UpdateAutoScalingGroup
 * has merge semantics (absent = unchanged), so pre-fix the live values silently
 * survived the removal; verify.sh asserts they return to the CFn defaults
 * (grace period 0, no max lifetime, TerminationPolicies ['Default']).
 *
 * min/max/desiredCapacity are all 0 so no instances launch — keeps the deploy
 * cheap and destroy fast (no instance teardown wait).
 */
export class LaunchTemplateAsgInplaceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // CDKD_TEST_UPDATE toggles ONLY the instance type — every other property
    // (incl. all ASG props) is identical across phases 1 and 2, so the only
    // template delta is the LaunchTemplate's instanceType (the #985 leg needs
    // the ASG's raw template to be UNCHANGED in that phase).
    // CDKD_TEST_REMOVAL keeps the phase-2 instance type and ADDITIONALLY drops
    // the three non-default ASG properties below (the #1160 removal leg).
    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';
    const isRemoval = process.env.CDKD_TEST_REMOVAL === 'true';
    const instanceType =
      isUpdate || isRemoval
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
    const asg = new autoscaling.AutoScalingGroup(this, 'Asg', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      launchTemplate,
      minCapacity: 0,
      maxCapacity: 0,
      desiredCapacity: 0,
    });

    // Issue #1160 removal leg: set non-default values for three optional
    // mutable ASG properties in phases 1-2, then REMOVE them from the template
    // in the removal phase. Set via the L1 escape hatch so the exact CFn
    // property names land in the template (no L2 API drift).
    if (!isRemoval) {
      const cfnAsg = asg.node.defaultChild as autoscaling.CfnAutoScalingGroup;
      cfnAsg.healthCheckGracePeriod = 90; // CFn default: 0
      cfnAsg.maxInstanceLifetime = 604800; // 7 days; CFn default: none (API min is 86400)
      cfnAsg.terminationPolicies = ['OldestInstance']; // CFn default: ['Default']
    }
  }
}
