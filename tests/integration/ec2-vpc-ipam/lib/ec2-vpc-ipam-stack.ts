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
 * UPDATE phase: CDKD_TEST_UPDATE=true adds a tag to the VPC, an in-place
 * update whose recorded `CidrBlock` attribute must survive.
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
    new cdk.CfnOutput(this, 'VpcCidr', { value: vpc.attrCidrBlock });
    new cdk.CfnOutput(this, 'IpamId', { value: ipam.attrIpamId });
    new cdk.CfnOutput(this, 'ScopeId', { value: ipam.attrPrivateDefaultScopeId });
    new cdk.CfnOutput(this, 'PoolId', { value: pool.attrIpamPoolId });
  }
}
