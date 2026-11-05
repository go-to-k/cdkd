import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';

/** covers: AWS::EC2::Subnet */
export class Ec2SubnetDns64Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const phase = process.env.CDKD_TEST_UPDATE ?? 'create';
    const removeDns64 = process.env.CDKD_TEST_REMOVAL === 'true';
    const removeIpv6 = phase === 'remove-ipv6';
    const changedCidr = ['change-cidr', 'enable-dns64', 'remove-dns64', 'disable-dns64', 'remove-ipv6'].includes(phase);
    const vpc = new ec2.CfnVPC(this, 'Vpc', { cidrBlock: '10.62.0.0/16' });
    const ipv6 = new ec2.CfnVPCCidrBlock(this, 'VpcIpv6', {
      vpcId: vpc.ref, amazonProvidedIpv6CidrBlock: true,
    });
    const block = cdk.Fn.select(changedCidr ? 1 : 0,
      cdk.Fn.cidr(cdk.Fn.select(0, vpc.attrIpv6CidrBlocks), 2, '64'));
    // The L2 adds AssignIpv6AddressOnCreation, outside this slice's SDK coverage.
    const subnet = new ec2.CfnSubnet(this, 'Subnet', {
      vpcId: vpc.ref, cidrBlock: '10.62.1.0/24',
      ...(removeIpv6 ? {} : { ipv6CidrBlock: block }),
      ...(removeDns64 ? {} : { enableDns64: !['disable-first', 'change-cidr', 'disable-dns64', 'remove-ipv6'].includes(phase) }),
      // The companion tag also changes when a retained property is removed.
      tags: [{ key: 'Phase', value: phase }],
    });
    subnet.addDependency(ipv6);
    new cdk.CfnOutput(this, 'SubnetId', { value: subnet.ref });
    new cdk.CfnOutput(this, 'VpcId', { value: vpc.ref });
    new cdk.CfnOutput(this, 'ExpectedCidr', { value: removeIpv6 ? 'none' : block });
  }
}
