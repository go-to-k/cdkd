import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * A VPC whose primary CIDR is allocated from an IPAM pool (issue #5633).
 *
 * The VPC declares `Ipv4IpamPoolId` and `Ipv4NetmaskLength` and no
 * `CidrBlock`; before #5633 both were SDK-unwired, so the VPC went to Cloud
 * Control. verify.sh asserts it stays on the SDK provider, that its CIDR is a
 * /28 allocation of this pool, and that `Fn::GetAtt Vpc.CidrBlock` resolves
 * to that allocated CIDR, after the create and after an in-place update.
 *
 * The IPAM is the ADVANCED tier: the free tier refuses a pool in the private
 * scope (measured, us-east-1). An account holds one IPAM per region, so
 * verify.sh refuses to start while the region has one, and never adopts or
 * deletes an IPAM it did not create. The IPAM, its pool and the pool CIDR go
 * through Cloud Control (no SDK provider).
 *
 * A subnet (go-to-k/cdkd#5632) in a second VPC with a declared CIDR
 * (`SubnetVpc`) takes its CIDR from a subnet pool carved from a planning pool
 * whose source is that VPC, with `Ipv4IpamPoolId` and `Ipv4NetmaskLength` and
 * no `CidrBlock`, and names its zone by `AvailabilityZoneId` (from
 * CDKD_TEST_AZ_ID, which verify.sh resolves). All three were SDK-unwired
 * before #5632, routing the subnet to Cloud Control. The pools and the subnet
 * join the stack only under CDKD_IPAM_WITH_SUBNET=true, after IPAM monitors
 * SubnetVpc (see below).
 *
 * UPDATE phase: CDKD_TEST_UPDATE=true adds a tag to the IPAM VPC and the subnet,
 * in-place updates whose recorded `CidrBlock` attributes must survive.
 *
 * covers: AWS::EC2::IPAM
 * covers: AWS::EC2::IPAMPool
 * covers: AWS::EC2::IPAMPoolCidr
 */
export class Ec2VpcIpamStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    const ipam = new ec2.CfnIPAM(this, 'Ipam', {
      tier: 'advanced',
      operatingRegions: [{ regionName: this.region }],
      tags: [
        { key: 'cdkd-integ', value: 'ec2-vpc-ipam' },
        // verify.sh's per-run nonce: its fallback cleanup deletes only an
        // IPAM carrying the value this run set.
        ...(process.env.CDKD_IPAM_RUN_TAG
          ? [{ key: 'cdkd-integ-run', value: process.env.CDKD_IPAM_RUN_TAG }]
          : []),
      ],
    });

    const pool = new ec2.CfnIPAMPool(this, 'Pool', {
      addressFamily: 'ipv4',
      ipamScopeId: ipam.attrPrivateDefaultScopeId,
      locale: this.region,
    });

    const poolCidr = new ec2.CfnIPAMPoolCidr(this, 'PoolCidr', {
      ipamPoolId: pool.attrIpamPoolId,
      cidr: '10.240.0.0/16',
    });

    const vpc = new ec2.CfnVPC(this, 'Vpc', {
      ipv4IpamPoolId: pool.attrIpamPoolId,
      ipv4NetmaskLength: 28,
      ...(isUpdate ? { tags: [{ key: 'cdkd-5633', value: 'updated' }] } : {}),
    });
    // The allocation needs the pool's CIDR provisioned first.
    vpc.addDependency(poolCidr);

    new cdk.CfnOutput(this, 'VpcId', { value: vpc.ref });

    // go-to-k/cdkd#5632: the subnet arm (AWS's subnet-planning sequence, see
    // https://docs.aws.amazon.com/vpc/latest/ipam/tutorials-subnet-planning.html).
    // A VPC whose CIDR came from a pool cannot source a planning pool, its CIDR
    // being allocated space in the scope already ("The CIDR overlaps with
    // space already in the scope."), so the subnet lives in a second VPC with a
    // declared CIDR, outside the pool above.
    const subnetVpcCidr = '10.241.0.0/20';
    const subnetVpc = new ec2.CfnVPC(this, 'SubnetVpc', { cidrBlock: subnetVpcCidr });
    new cdk.CfnOutput(this, 'SubnetVpcId', { value: subnetVpc.ref });

    // EC2 refuses a pool sourced from a VPC until IPAM monitors it ("The
    // source resource vpc-... is not monitored in the IPAM scope."), which
    // happens minutes after the VPC exists and which no template dependency can
    // wait for. verify.sh deploys without the pools and the subnet first, waits
    // for IPAM to monitor SubnetVpc, then sets CDKD_IPAM_WITH_SUBNET=true for
    // every later step.
    if (process.env.CDKD_IPAM_WITH_SUBNET === 'true') {
      const azId = process.env.CDKD_TEST_AZ_ID;
      if (!azId) throw new Error('CDKD_TEST_AZ_ID is required (verify.sh resolves it)');
      const sourceResource = {
        resourceId: subnetVpc.ref,
        resourceOwner: this.account,
        resourceRegion: this.region,
        resourceType: 'vpc',
      };
      // The planning pool holds the VPC's whole CIDR.
      const planningPool = new ec2.CfnIPAMPool(this, 'PlanningPool', {
        addressFamily: 'ipv4',
        ipamScopeId: ipam.attrPrivateDefaultScopeId,
        locale: this.region,
        sourceResource,
      });
      const planningPoolCidr = new ec2.CfnIPAMPoolCidr(this, 'PlanningPoolCidr', {
        ipamPoolId: planningPool.attrIpamPoolId,
        cidr: subnetVpcCidr,
      });
      // The subnet pool is carved from it, and must name the same VPC: EC2
      // refuses one without it ("has a VPC source resource that is different
      // from the input").
      const subnetPool = new ec2.CfnIPAMPool(this, 'SubnetPool', {
        addressFamily: 'ipv4',
        ipamScopeId: ipam.attrPrivateDefaultScopeId,
        locale: this.region,
        sourceIpamPoolId: planningPool.attrIpamPoolId,
        sourceResource,
      });
      subnetPool.addDependency(planningPoolCidr);
      const subnetPoolCidr = new ec2.CfnIPAMPoolCidr(this, 'SubnetPoolCidr', {
        ipamPoolId: subnetPool.attrIpamPoolId,
        cidr: '10.241.0.0/24',
      });
      const subnet = new ec2.CfnSubnet(this, 'Subnet', {
        vpcId: subnetVpc.ref,
        ipv4IpamPoolId: subnetPool.attrIpamPoolId,
        ipv4NetmaskLength: 28,
        availabilityZoneId: azId,
        ...(isUpdate ? { tags: [{ key: 'cdkd-5632', value: 'updated' }] } : {}),
      });
      // The allocation needs the subnet pool's CIDR provisioned first.
      subnet.addDependency(subnetPoolCidr);

      new cdk.CfnOutput(this, 'SubnetId', { value: subnet.ref });
      new cdk.CfnOutput(this, 'SubnetCidr', { value: subnet.attrCidrBlock });
      new cdk.CfnOutput(this, 'SubnetAzId', { value: subnet.attrAvailabilityZoneId });
      new cdk.CfnOutput(this, 'SubnetPoolId', { value: subnetPool.attrIpamPoolId });
      new cdk.CfnOutput(this, 'PlanningPoolId', { value: planningPool.attrIpamPoolId });
    }
    new cdk.CfnOutput(this, 'VpcCidr', { value: vpc.attrCidrBlock });
    new cdk.CfnOutput(this, 'IpamId', { value: ipam.attrIpamId });
    new cdk.CfnOutput(this, 'ScopeId', { value: ipam.attrPrivateDefaultScopeId });
    new cdk.CfnOutput(this, 'PoolId', { value: pool.attrIpamPoolId });
  }
}
