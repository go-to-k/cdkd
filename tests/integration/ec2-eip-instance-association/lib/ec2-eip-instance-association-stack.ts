import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/** The tag verify.sh's teardown sweep finds the address and instance by. */
export const SWEEP_TAG_KEY = 'cdkd-integ-6752';

/**
 * An Elastic IP associated with a RUNNING instance through its own
 * `InstanceId`, in a non-default VPC (go-to-k/cdkd#6752).
 *
 * In a non-default VPC, `ReleaseAddress` refuses an address that is still
 * associated (`InvalidIPAddress.InUse`), and a destroy reaches the EIP before
 * the instance its `InstanceId` names (the EIP depends on it), so the address
 * is still associated when its delete runs. The #6715 fix disassociates the
 * association the EIP's own `InstanceId` made after that refusal, then
 * releases. verify.sh asserts the association is live before the destroy, and
 * that the destroy disassociated, released the address and terminated the
 * instance.
 *
 * Kept small and cheap: one AZ, one public subnet (AssociateAddress needs an
 * internet gateway on the VPC), no NAT gateway, a t3.nano from the public
 * Amazon Linux 2023 SSM parameter. The instance is an L1 `CfnInstance` emitting
 * only SDK-handled properties, so it stays on the SDK route (as in the
 * `ec2-instance` fixture); the EIP's `InstanceId` association runs on the SDK
 * route too, which verify.sh checks, since the fix lives in that provider.
 *
 * covers: AWS::EC2::EIP
 */
export class Ec2EipInstanceAssociationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const sweepTag = { key: SWEEP_TAG_KEY, value: this.stackName };

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ cidrMask: 24, name: 'Public', subnetType: ec2.SubnetType.PUBLIC }],
    });

    const instance = new ec2.CfnInstance(this, 'Instance', {
      imageId: ec2.MachineImage.latestAmazonLinux2023().getImage(this).imageId,
      instanceType: 't3.nano',
      subnetId: vpc.publicSubnets[0].subnetId,
      availabilityZone: vpc.publicSubnets[0].availabilityZone,
      tags: [sweepTag],
    });

    // The association is made at create, through the EIP's own InstanceId.
    const eip = new ec2.CfnEIP(this, 'Eip', {
      domain: 'vpc',
      instanceId: instance.ref,
      tags: [sweepTag],
    });
    // AssociateAddress refuses a VPC with no internet gateway attached, and
    // nothing in the template orders the EIP after the ATTACHMENT
    // (`internetConnectivityEstablished` names only the gateway itself).
    eip.addDependency(vpc.node.findChild('VPCGW') as ec2.CfnVPCGatewayAttachment);

    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId });
    new cdk.CfnOutput(this, 'InstanceId', { value: instance.ref });
    new cdk.CfnOutput(this, 'AllocationId', { value: eip.attrAllocationId });
  }
}
