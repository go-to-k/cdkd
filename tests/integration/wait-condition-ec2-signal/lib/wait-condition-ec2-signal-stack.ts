import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudformation from 'aws-cdk-lib/aws-cloudformation';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Issue #6694: the classic user-data signalling pattern. An EC2 instance's
 * user data signals a `WaitConditionHandle` twice — once with `cfn-signal`
 * (from `aws-cfn-bootstrap`) and once with a bare `curl -X PUT` — and a
 * `WaitCondition` with `Count: 2` waits for both. Under cdkd the handle's
 * `Ref` is a pre-signed URL into the state bucket; the two PUTs land as two
 * object versions of one key, which is what lets `Count: 2` see both.
 *
 * The VPC is one public subnet with no NAT gateway: the instance reaches S3
 * (and the package repository) through the internet gateway.
 */
export class WaitConditionEc2SignalStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC }],
    });

    const handle = new cloudformation.CfnWaitConditionHandle(this, 'Handle');

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euxo pipefail',
      'dnf install -y aws-cfn-bootstrap',
      `/opt/aws/bin/cfn-signal --success true --id boot --data booted --reason 'booted' '${handle.ref}'`,
      `curl -sSf -X PUT -H 'Content-Type:' --data-binary '{"Status":"SUCCESS","UniqueId":"app","Data":"ready","Reason":"app up"}' '${handle.ref}'`
    );

    const instance = new ec2.Instance(this, 'Instance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      userData,
      requireImdsv2: true,
    });

    const wait = new cloudformation.CfnWaitCondition(this, 'Wait', {
      handle: handle.ref,
      timeout: '900',
      count: 2,
    });
    wait.node.addDependency(instance);

    new cdk.CfnOutput(this, 'WaitData', { value: wait.attrData });
    new cdk.CfnOutput(this, 'InstanceId', { value: instance.instanceId });
  }
}
