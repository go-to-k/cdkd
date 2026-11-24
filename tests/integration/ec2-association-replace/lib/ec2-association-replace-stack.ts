import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';

/**
 * Replacing a link AWS allows only one of (go-to-k/cdkd#6958): a VPC gateway
 * attachment (one internet gateway per VPC) and a subnet route table
 * association (one per subnet). cdkd replaces both delete-first, as
 * CloudFormation does; create-first is refused with
 * `Resource.AlreadyAssociated`.
 *
 * covers: AWS::EC2::VPCGatewayAttachment
 * covers: AWS::EC2::SubnetRouteTableAssociation
 * covers: AWS::EC2::InternetGateway
 * covers: AWS::EC2::RouteTable
 * covers: AWS::EC2::Subnet
 * covers: AWS::EC2::VPC
 * covers: AWS::EC2::Route
 *
 * Two arms, each gated on a token of the comma-separated CDKD_TEST_UPDATE:
 *
 * - `move` (L1): the gateway attachment `Att` moves from `VpcA` to `VpcB`, and
 *   `RtAssoc` moves the subnet from `RtA` to `RtB`.
 * - `cidr` (L2): the `ec2.Vpc` `Net` changes its CIDR, so the VPC, its public
 *   subnet, route table, association, default route and gateway attachment
 *   are all replaced; the attachment's `VpcId` names the new VPC.
 */
export class Ec2AssociationReplaceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const modes = new Set((process.env.CDKD_TEST_UPDATE ?? '').split(','));
    const move = modes.has('move');
    const cidr = modes.has('cidr');

    // --- L1 arm --------------------------------------------------------------
    const vpcA = new ec2.CfnVPC(this, 'VpcA', { cidrBlock: '10.60.0.0/16' });
    vpcA.overrideLogicalId('VpcA');
    const vpcB = new ec2.CfnVPC(this, 'VpcB', { cidrBlock: '10.61.0.0/16' });
    vpcB.overrideLogicalId('VpcB');
    const igw = new ec2.CfnInternetGateway(this, 'Igw');
    igw.overrideLogicalId('Igw');
    const att = new ec2.CfnVPCGatewayAttachment(this, 'Att', {
      vpcId: (move ? vpcB : vpcA).ref,
      internetGatewayId: igw.ref,
    });
    att.overrideLogicalId('Att');

    const subnet = new ec2.CfnSubnet(this, 'Subnet', {
      vpcId: vpcA.ref,
      cidrBlock: '10.60.0.0/24',
      availabilityZone: cdk.Fn.select(0, cdk.Fn.getAzs()),
    });
    subnet.overrideLogicalId('Subnet');
    const rtA = new ec2.CfnRouteTable(this, 'RtA', { vpcId: vpcA.ref });
    rtA.overrideLogicalId('RtA');
    const rtB = new ec2.CfnRouteTable(this, 'RtB', { vpcId: vpcA.ref });
    rtB.overrideLogicalId('RtB');
    const assoc = new ec2.CfnSubnetRouteTableAssociation(this, 'RtAssoc', {
      subnetId: subnet.ref,
      routeTableId: (move ? rtB : rtA).ref,
    });
    assoc.overrideLogicalId('RtAssoc');

    // --- L2 arm --------------------------------------------------------------
    const net = new ec2.Vpc(this, 'Net', {
      ipAddresses: ec2.IpAddresses.cidr(cidr ? '10.63.0.0/16' : '10.62.0.0/16'),
      maxAzs: 1,
      natGateways: 0,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });

    const out = (name: string, value: string): void => {
      new cdk.CfnOutput(this, name, { value });
    };
    out('VpcAId', vpcA.ref);
    out('VpcBId', vpcB.ref);
    out('IgwId', igw.ref);
    out('SubnetId', subnet.ref);
    out('RtAId', rtA.ref);
    out('RtBId', rtB.ref);
    out('NetVpcId', net.vpcId);
    out('NetIgwId', net.internetGatewayId!);
    out('NetSubnetId', net.publicSubnets[0]!.subnetId);
  }
}
