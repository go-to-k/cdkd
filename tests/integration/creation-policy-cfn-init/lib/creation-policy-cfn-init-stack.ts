import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Issue #6705: an EC2 instance using CDK's `init` (`applyCloudFormationInit`)
 * with `includeRole: true`, so cfn-init / cfn-signal sign their calls with
 * the instance role.
 * CDK emits a `CreationPolicy` `ResourceSignal`, `AWS::CloudFormation::Init`
 * metadata, and user data running `cfn-init --stack ${AWS::StackName}
 * --resource <id>` then `cfn-signal -e $? --stack ... --resource <id>`. Both
 * call the CloudFormation API; cdkd answers them through the stack's persistent
 * signal receiver (a CloudFormation stack named as this stack, whose real ARN
 * `AWS::StackId` resolves to, so CDK's grant on it matches), and the deploy
 * completes only once the instance signals.
 *
 * The init config writes a file and runs a command that checks it, so a
 * SUCCESS signal proves cfn-init read the metadata from the receiver.
 *
 * `UnsignedInstance` keeps CDK's default (`includeRole: false`): its unsigned
 * calls are answered only for CloudFormation's own instances, so cdkd warns
 * and creates it without waiting (verify.sh Phase 1 asserts both).
 *
 * CDKD_TEST_UPDATE=true (verify.sh Phase 3): Amazon Linux 2 instead of 2023,
 * so the instance is REPLACED and its replacement waits for a fresh signal.
 *
 * CDKD_TEST_FAIL=true (verify.sh Phase 4): a second instance whose init
 * command exits 1, so cfn-signal sends FAILURE: the deploy must fail and roll
 * that instance back.
 */
export class CreationPolicyCfnInitStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC }],
    });

    const instanceProps = {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage:
        process.env.CDKD_TEST_UPDATE === 'true'
          ? ec2.MachineImage.latestAmazonLinux2()
          : ec2.MachineImage.latestAmazonLinux2023(),
      requireImdsv2: true,
      initOptions: { timeout: cdk.Duration.minutes(10), includeRole: true },
    };

    new ec2.Instance(this, 'Instance', {
      ...instanceProps,
      init: ec2.CloudFormationInit.fromElements(
        ec2.InitFile.fromString('/tmp/cdkd-6705.txt', 'from-receiver-metadata'),
        ec2.InitCommand.shellCommand('grep -q from-receiver-metadata /tmp/cdkd-6705.txt')
      ),
    });

    new ec2.Instance(this, 'UnsignedInstance', {
      ...instanceProps,
      initOptions: { timeout: cdk.Duration.minutes(10) },
      init: ec2.CloudFormationInit.fromElements(ec2.InitCommand.shellCommand('true')),
    });

    if (process.env.CDKD_TEST_FAIL === 'true') {
      new ec2.Instance(this, 'FailingInstance', {
        ...instanceProps,
        init: ec2.CloudFormationInit.fromElements(ec2.InitCommand.shellCommand('exit 1')),
      });
    }
  }
}
