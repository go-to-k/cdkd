import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * The security group each routing phase declares. `SecurityGroupIds` is the
 * mutable property, and consecutive deploys must differ: one the differ calls
 * NO_CHANGE never provisions the endpoint, so it could not flip. verify.sh runs
 * its first `cdkd diff` with `pinned`, because `seed` and `flip` declare one
 * group, and its last with `flip`, which must then diff to no change.
 */
const SECURITY_GROUP_BY_PHASE: Record<string, 'A' | 'B'> = {
  base: 'A',
  seed: 'B',
  pinned: 'A',
  flip: 'B',
};

/**
 * physicalId-parity arm for issue 6943: an Interface VPC endpoint recorded
 * `provisionedBy: 'cc-api'` returns to its SDK provider (go-to-k/cdkd#6939)
 * without churn.
 *
 * covers: AWS::EC2::VPCEndpoint
 *
 * The schema's `primaryIdentifier` is `Id`; `EC2VPCEndpointProvider.create`
 * records the CreateVpcEndpoint `VpcEndpointId`, and Cloud Control returns the
 * same `vpce-...`. Both the endpoint id and its network interface id are
 * AWS-minted: verify.sh proves the mint by watching the recreate change them,
 * so a flip that keeps both is its own identity witness.
 */
export class CcToSdkRerouteVpcEndpointStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const phase = process.env.CDKD_TEST_PHASE ?? 'base';
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.83.0.0/16'),
      maxAzs: 1,
      natGateways: 0,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        { cidrMask: 24, name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });
    const groupA = new ec2.SecurityGroup(this, 'GroupA', { vpc, description: 'reroute group A' });
    const groupB = new ec2.SecurityGroup(this, 'GroupB', { vpc, description: 'reroute group B' });

    const declared = (SECURITY_GROUP_BY_PHASE[phase] ?? 'A') === 'A' ? groupA : groupB;
    const endpoint = new ec2.CfnVPCEndpoint(this, 'RerouteEndpoint', {
      vpcId: vpc.vpcId,
      vpcEndpointType: 'Interface',
      serviceName: `com.amazonaws.${this.region}.sts`,
      subnetIds: [vpc.isolatedSubnets[0]!.subnetId],
      securityGroupIds: [declared.securityGroupId],
      privateDnsEnabled: false,
    });

    new cdk.CfnOutput(this, 'GroupAId', { value: groupA.securityGroupId });
    new cdk.CfnOutput(this, 'GroupBId', { value: groupB.securityGroupId });
    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId });
    new cdk.CfnOutput(this, 'EndpointRef', { value: endpoint.ref });
    new cdk.CfnOutput(this, 'EndpointEnis', {
      value: cdk.Fn.join(',', endpoint.attrNetworkInterfaceIds),
    });
  }
}
