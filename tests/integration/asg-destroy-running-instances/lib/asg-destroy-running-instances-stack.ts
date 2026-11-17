import * as cdk from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';

export interface AsgDestroyRunningInstancesStackProps extends cdk.StackProps {
  /** Launch the group's instances protected from scale in. */
  readonly protectedFromScaleIn: boolean;
}

/**
 * Issue #6466: `cdkd destroy` of an Auto Scaling group that still runs
 * instances. AWS refuses a delete without ForceDelete of a non-empty group;
 * CloudFormation scales the group to 0, waits for its instances to terminate,
 * then deletes it, and so must cdkd without `--remove-protection`.
 *
 * Two stacks from this class: one whose single instance a scale-in terminates
 * (the plain destroy must succeed), and one whose instance is protected from
 * scale in (the plain destroy must refuse without scaling anything, and
 * `--remove-protection` must force-delete it).
 *
 * One `t4g.nano` per stack, in an isolated subnet with no NAT gateway and no
 * public address, so the fixture costs a few minutes of the smallest instance.
 *
 * covers: AWS::AutoScaling::AutoScalingGroup
 * covers: AWS::EC2::LaunchTemplate
 */
export class AsgDestroyRunningInstancesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AsgDestroyRunningInstancesStackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      natGateways: 0,
      maxAzs: 1,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [{ name: 'iso', subnetType: ec2.SubnetType.PRIVATE_ISOLATED }],
    });
    const launchTemplate = new ec2.LaunchTemplate(this, 'Lt', {
      instanceType: new ec2.InstanceType('t4g.nano'),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
    });
    new autoscaling.AutoScalingGroup(this, 'Asg', {
      autoScalingGroupName: `${id}-asg`,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      launchTemplate,
      minCapacity: 1,
      maxCapacity: 1,
      desiredCapacity: 1,
      newInstancesProtectedFromScaleIn: props.protectedFromScaleIn,
    });
  }
}
