import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

/**
 * VPC endpoints on cdkd's SDK provider (go-to-k/cdkd#6939): an Interface
 * endpoint (STS) in an isolated VPC and a Gateway endpoint (S3) on its route
 * tables, plus an SSM parameter whose value reads the Interface endpoint's
 * `NetworkInterfaceIds` and `DnsEntries` through `Fn::GetAtt`, so a GetAtt the
 * provider cannot answer fails the deploy rather than an output.
 *
 * covers: AWS::EC2::VPCEndpoint
 *
 * CDKD_TEST_UPDATE=true changes the Interface endpoint in place: a second
 * subnet, private DNS on, a narrower policy and another tag value; and gives
 * the Gateway endpoint a policy.
 */
export class Ec2VpcEndpointStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.82.0.0/16'),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    const subnets = vpc.isolatedSubnets.map((s) => s.subnetId);

    const sg = new ec2.SecurityGroup(this, 'EndpointSg', {
      vpc,
      description: 'cdkd integ VPC endpoint',
      allowAllOutbound: false,
    });
    sg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(443));

    const interfaceEndpoint = new ec2.CfnVPCEndpoint(this, 'StsEndpoint', {
      vpcId: vpc.vpcId,
      vpcEndpointType: 'Interface',
      serviceName: `com.amazonaws.${this.region}.sts`,
      subnetIds: isUpdate ? subnets : [subnets[0]],
      securityGroupIds: [sg.securityGroupId],
      privateDnsEnabled: isUpdate,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: '*',
            Action: isUpdate ? ['sts:GetCallerIdentity'] : ['sts:*'],
            Resource: '*',
          },
        ],
      },
      tags: [{ key: 'cdkd-integ', value: isUpdate ? 'updated' : 'base' }],
    });

    const gatewayEndpoint = new ec2.CfnVPCEndpoint(this, 'S3Endpoint', {
      vpcId: vpc.vpcId,
      vpcEndpointType: 'Gateway',
      serviceName: `com.amazonaws.${this.region}.s3`,
      routeTableIds: vpc.isolatedSubnets.map((s) => s.routeTable.routeTableId),
      ...(isUpdate && {
        policyDocument: {
          Version: '2012-10-17',
          Statement: [
            { Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'], Resource: '*' },
          ],
        },
      }),
    });

    // `<eni-ids joined by ,>|<first DnsEntries entry>`, checked against the
    // live endpoint by verify.sh.
    new ssm.StringParameter(this, 'EndpointNetwork', {
      parameterName: `/cdkd-integ/${this.stackName}/endpoint-network`,
      stringValue: cdk.Fn.join('|', [
        cdk.Fn.join(',', interfaceEndpoint.attrNetworkInterfaceIds),
        cdk.Fn.select(0, interfaceEndpoint.attrDnsEntries),
      ]),
    });

    new cdk.CfnOutput(this, 'InterfaceEndpointId', { value: interfaceEndpoint.ref });
    new cdk.CfnOutput(this, 'GatewayEndpointId', { value: gatewayEndpoint.ref });
  }
}
