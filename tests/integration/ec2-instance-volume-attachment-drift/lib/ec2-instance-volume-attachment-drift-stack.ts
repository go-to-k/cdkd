import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';

/**
 * go-to-k/cdkd#6384: an `AWS::EC2::VolumeAttachment` attaches its volume after
 * the instance settles, and `DescribeInstances` lists it under the instance's
 * `BlockDeviceMappings`. Before the fix `cdkd drift` reported that device as
 * drift on every run of an untouched stack, and `--revert` printed success
 * while changing nothing.
 *
 * Two instances, each with an attached volume:
 *  - `Plain` declares no `BlockDeviceMappings` (the CDK default), so drift
 *    does not compare the list at all;
 *  - `Declared` declares its root device (`blockDevices`), so drift compares
 *    the declared device only, and an out-of-band change to it is still drift.
 */
export class Ec2InstanceVolumeAttachmentDriftStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC }],
    });
    const machineImage = ec2.MachineImage.latestAmazonLinux2023({
      cpuType: ec2.AmazonLinuxCpuType.ARM_64,
    });
    const instanceType = new ec2.InstanceType('t4g.nano');

    const plain = new ec2.Instance(this, 'Plain', { vpc, instanceType, machineImage });
    const declared = new ec2.Instance(this, 'Declared', {
      vpc,
      instanceType,
      machineImage,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(8, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            deleteOnTermination: true,
          }),
        },
      ],
    });

    for (const [name, instance] of [
      ['Plain', plain],
      ['Declared', declared],
    ] as const) {
      const volume = new ec2.CfnVolume(this, `${name}Volume`, {
        availabilityZone: instance.instanceAvailabilityZone,
        size: 1,
        volumeType: 'gp3',
      });
      new ec2.CfnVolumeAttachment(this, `${name}Attachment`, {
        instanceId: instance.instanceId,
        volumeId: volume.ref,
        device: '/dev/sdf',
      });
      new cdk.CfnOutput(this, `${name}InstanceId`, { value: instance.instanceId });
      new cdk.CfnOutput(this, `${name}VolumeId`, { value: volume.ref });
    }
  }
}
