import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';

/**
 * Issue #6706: an Auto Scaling group of two instances using CDK's `init` with
 * `includeRole: true` (signed cfn-init / cfn-signal), `signals:
 * Signals.waitForAll()` (a CreationPolicy the receiver waits on at create)
 * and a rolling update with `WaitOnResourceSignals` (cdkd `--update-policy`
 * waits for one signal per replaced instance).
 *
 * CDKD_TEST_UPDATE=true (verify.sh Phase 2): the init file's content changes,
 * so the launch template's user data changes and the rolling update replaces
 * both instances; each signals SUCCESS.
 *
 * CDKD_TEST_UPDATE=fail (verify.sh Phase 3): the init command exits 1, so the
 * replaced instances signal FAILURE: the refresh is cancelled, the deploy
 * fails and rolls the group back to the Phase 2 launch template.
 */
export class AsgRollingSignalsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC }],
    });

    const mode = process.env.CDKD_TEST_UPDATE ?? '';
    const content = mode === '' ? 'v1' : 'v2';
    const check =
      mode === 'fail' ? 'exit 1' : `grep -q ${content} /tmp/cdkd-6706.txt`;

    new autoscaling.AutoScalingGroup(this, 'Asg', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      associatePublicIpAddress: true,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      requireImdsv2: true,
      minCapacity: 2,
      maxCapacity: 2,
      init: ec2.CloudFormationInit.fromElements(
        ec2.InitFile.fromString('/tmp/cdkd-6706.txt', content),
        ec2.InitCommand.shellCommand(check)
      ),
      initOptions: { includeRole: true },
      signals: autoscaling.Signals.waitForAll({ timeout: cdk.Duration.minutes(10) }),
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({
        maxBatchSize: 1,
        minInstancesInService: 1,
        pauseTime: cdk.Duration.minutes(4),
        waitOnResourceSignals: true,
      }),
    });
  }
}
