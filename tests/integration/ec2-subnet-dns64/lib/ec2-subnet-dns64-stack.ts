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
    const changedCidr = ['change-cidr', 'enable-dns64', 'move-dns-block', 'remove-dns64', 'disable-dns64', 'remove-ipv6'].includes(phase);
    const vpc = new ec2.CfnVPC(this, 'Vpc', { cidrBlock: '10.62.0.0/16' });
    const ipv6 = new ec2.CfnVPCCidrBlock(this, 'VpcIpv6', {
      vpcId: vpc.ref, amazonProvidedIpv6CidrBlock: true,
    });
    const blocks = cdk.Fn.cidr(cdk.Fn.select(0, vpc.attrIpv6CidrBlocks), 8, '64');
    const block = cdk.Fn.select(changedCidr ? 1 : 0, blocks);
    // A CfnSubnet, not the L2, so this subnet declares no AssignIpv6AddressOnCreation.
    const subnet = new ec2.CfnSubnet(this, 'Subnet', {
      vpcId: vpc.ref, cidrBlock: '10.62.1.0/24',
      ...(removeIpv6 ? {} : { ipv6CidrBlock: block }),
      ...(removeDns64 ? {} : { enableDns64: !['disable-first', 'change-cidr', 'disable-dns64', 'remove-ipv6'].includes(phase) }),
      // The companion tag also changes when a retained property is removed.
      tags: [{ key: 'Phase', value: phase }],
    });
    subnet.addDependency(ipv6);

    // go-to-k/cdkd#5632: AssignIpv6AddressOnCreation and
    // PrivateDnsNameOptionsOnLaunch on their own dual-stack subnet, so the
    // IPv6-block phases above never meet them. The removal phase drops both
    // after `enable-dns64` set non-default values, which must survive it.
    // The L1 types this block as `any` and passes its keys through verbatim,
    // so they are spelled the CloudFormation way.
    const dnsShape: Record<string, { assign: boolean; dns: Record<string, unknown> }> = {
      create: {
        assign: true,
        dns: { HostnameType: 'resource-name', EnableResourceNameDnsARecord: true, EnableResourceNameDnsAAAARecord: true },
      },
      'disable-first': {
        assign: false,
        dns: { HostnameType: 'ip-name', EnableResourceNameDnsARecord: true, EnableResourceNameDnsAAAARecord: true },
      },
      'enable-dns64': {
        assign: true,
        dns: { HostnameType: 'resource-name', EnableResourceNameDnsARecord: false, EnableResourceNameDnsAAAARecord: true },
      },
      'disable-dns64': {
        assign: false,
        dns: { HostnameType: 'ip-name', EnableResourceNameDnsARecord: false, EnableResourceNameDnsAAAARecord: false },
      },
    };
    const shape =
      dnsShape[phase] ??
      dnsShape[phase === 'change-cidr' ? 'disable-first' : phase === 'move-dns-block' ? 'enable-dns64' : 'disable-dns64'];
    // `move-dns-block` changes the IPv6 block while AssignIpv6AddressOnCreation,
    // the AAAA record and DNS64 stay true, which EC2 refuses to detach unless
    // each is turned off first; the block stays moved until the final `create`
    // puts it back (with DNS64 still on).
    const movedDnsBlock = ['move-dns-block', 'remove-dns64', 'disable-dns64', 'remove-ipv6'].includes(phase);
    const dnsBlock = cdk.Fn.select(movedDnsBlock ? 4 : 2, blocks);
    const dnsSubnet = new ec2.CfnSubnet(this, 'DnsSubnet', {
      vpcId: vpc.ref, cidrBlock: '10.62.2.0/24', ipv6CidrBlock: dnsBlock,
      // DNS64 stays on, so every block move here also detaches under it.
      ...(removeDns64
        ? {}
        : { assignIpv6AddressOnCreation: shape.assign, privateDnsNameOptionsOnLaunch: shape.dns, enableDns64: true }),
      tags: [{ key: 'Phase', value: phase }],
    });
    dnsSubnet.addDependency(ipv6);

    // go-to-k/cdkd#5632: an IPv6-only subnet, created by the SDK route with no
    // IPv4 block; unchanged across every phase, so it must never be replaced.
    const nativeSubnet = new ec2.CfnSubnet(this, 'NativeSubnet', {
      vpcId: vpc.ref, ipv6Native: true, ipv6CidrBlock: cdk.Fn.select(3, blocks),
      assignIpv6AddressOnCreation: true,
      privateDnsNameOptionsOnLaunch: { HostnameType: 'resource-name', EnableResourceNameDnsAAAARecord: true },
    });
    nativeSubnet.addDependency(ipv6);

    // go-to-k/cdkd#5843: a subnet whose template never declares Ipv6CidrBlock;
    // its block comes from an AWS::EC2::SubnetCidrBlock added in the SAME
    // deploy that declares auto-assign, DNS64 and the AAAA record true. The
    // SubnetCidrBlock depends on the subnet, so the subnet update runs first,
    // with no block. `cidr-block-off` turns all three off again, since EC2
    // refuses to detach the block (the destroy) while any is on.
    const blockPhase = ['cidr-block-on', 'cidr-block-off'].includes(phase);
    const blockOn = phase === 'cidr-block-on';
    const blockSubnet = new ec2.CfnSubnet(this, 'BlockSubnet', {
      vpcId: vpc.ref, cidrBlock: '10.62.3.0/24',
      ...(blockPhase && {
        assignIpv6AddressOnCreation: blockOn,
        enableDns64: blockOn,
        privateDnsNameOptionsOnLaunch: { EnableResourceNameDnsAAAARecord: blockOn },
      }),
    });
    blockSubnet.addDependency(ipv6);
    if (blockPhase) {
      const blockCidr = new ec2.CfnSubnetCidrBlock(this, 'BlockSubnetCidr', {
        subnetId: blockSubnet.ref, ipv6CidrBlock: cdk.Fn.select(5, blocks),
      });
      blockCidr.addDependency(ipv6);
    }

    new cdk.CfnOutput(this, 'SubnetId', { value: subnet.ref });
    // go-to-k/cdkd#5944: Subnet return values the SDK record lacks, read live.
    // The prefix keeps the output non-empty once the IPv6 block is removed.
    new cdk.CfnOutput(this, 'SubnetIpv6Blocks', {
      value: cdk.Fn.join('', ['blocks:', cdk.Fn.join(',', subnet.attrIpv6CidrBlocks)]),
    });
    new cdk.CfnOutput(this, 'SubnetNaclAssociationId', { value: subnet.attrNetworkAclAssociationId });
    new cdk.CfnOutput(this, 'SubnetVpcId', { value: subnet.attrVpcId });
    new cdk.CfnOutput(this, 'BlockSubnetId', { value: blockSubnet.ref });
    new cdk.CfnOutput(this, 'DnsSubnetId', { value: dnsSubnet.ref });
    new cdk.CfnOutput(this, 'DnsExpectedCidr', { value: dnsBlock });
    new cdk.CfnOutput(this, 'NativeSubnetId', { value: nativeSubnet.ref });
    new cdk.CfnOutput(this, 'VpcId', { value: vpc.ref });
    new cdk.CfnOutput(this, 'ExpectedCidr', { value: removeIpv6 ? 'none' : block });
  }
}
