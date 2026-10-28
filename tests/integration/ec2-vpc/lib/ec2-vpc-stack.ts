import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';

/**
 * EC2/VPC example stack
 *
 * Demonstrates:
 * - VPC creation with public subnet (1 AZ, no NAT gateways for cost saving)
 * - Security Group with ingress rule and explicit egress rule
 * - Resource dependencies (Security Group depends on VPC)
 * - Network ACL with custom ingress/egress rules
 * - Elastic IP address
 * - VPC Gateway Endpoint (S3)
 * - Launch Template
 * - Removal of the VPC DNS attributes (CDKD_TEST_REMOVAL, issue #1160)
 * - An in-place NACL entry rule change in the same deploy (issue #5070)
 * - In-place tag changes on the IGW, public RouteTable and NACL (issue #5448)
 * - VPC InstanceTenancy dedicated -> default in place, default -> dedicated replaced (issue #5449)
 * - A private hosted zone whose `VPCs` the removal phase drops (issue #1160)
 * - Fn::GetAtt for outputs (VPC ID, Security Group ID, Subnet IDs, NACL ID, EIP, Launch Template)
 *
 * Note: No EC2 instances are created to avoid costs.
 * This stack only provisions networking resources (VPC, Subnet, Security Group, NACL, EIP, VPC Endpoint, Launch Template).
 *
 * covers: AWS::EC2::NetworkAclEntry
 * covers: AWS::Route53::HostedZone
 * covers: AWS::EC2::SubnetNetworkAclAssociation
 */
export class Ec2VpcStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // REMOVAL phase (issue #1160): both VPCs drop EnableDnsHostnames and
    // EnableDnsSupport. CloudFormation resets each to the VPC default
    // (hostnames off, support on), while ModifyVpcAttribute changes only the
    // attribute it is sent, so cdkd used to keep the old values.
    const isRemoval = process.env.CDKD_TEST_REMOVAL === 'true';

    // Create VPC with 1 AZ and no NAT gateways (cost saving)
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    // The L2 VPC sets hostnames on (non-default) and support on.
    const cfnVpc = vpc.node.defaultChild as ec2.CfnVPC;
    if (isRemoval) {
      cfnVpc.addPropertyDeletionOverride('EnableDnsHostnames');
      cfnVpc.addPropertyDeletionOverride('EnableDnsSupport');
    }

    // A second, bare VPC with DNS support off (non-default), so the removal
    // phase also reaches the support reset. No subnets, no cost.
    const dnsOffVpc = new ec2.CfnVPC(this, 'DnsOffVpc', {
      cidrBlock: '10.1.0.0/16',
      ...(isRemoval ? {} : { enableDnsHostnames: false, enableDnsSupport: false }),
    });

    // Issue #5449: two bare VPCs whose InstanceTenancy the removal phase
    // changes. CloudFormation (measured, us-east-1) changes dedicated -> default
    // in place, here by dropping the property, and creates a new VPC for
    // default -> dedicated. No subnets or instances, so no dedicated-tenancy
    // charge.
    const tenancyDownVpc = new ec2.CfnVPC(this, 'TenancyDownVpc', {
      cidrBlock: '10.2.0.0/16',
      ...(isRemoval ? {} : { instanceTenancy: 'dedicated' }),
    });
    const tenancyUpVpc = new ec2.CfnVPC(this, 'TenancyUpVpc', {
      cidrBlock: '10.3.0.0/16',
      instanceTenancy: isRemoval ? 'dedicated' : 'default',
    });

    // Issue #1160: a private hosted zone on the main VPC. The removal phase
    // drops `VPCs` whole. CloudFormation keeps every association (A/B,
    // us-east-1), so cdkd sends no DisassociateVPCFromHostedZone and warns
    // instead. The zone stays private on the VPC until destroy.
    const privateZone = new route53.CfnHostedZone(this, 'PrivateZone', {
      name: 'cdkd-test-ec2-vpc.internal',
      ...(isRemoval ? {} : { vpcs: [{ vpcId: vpc.vpcId, vpcRegion: this.region }] }),
    });

    // Create Security Group with HTTP ingress rule
    const securityGroup = new ec2.SecurityGroup(this, 'WebSecurityGroup', {
      vpc,
      description: 'Allow HTTP traffic from anywhere',
      allowAllOutbound: true,
    });

    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP from anywhere'
    );

    // VPC Flow Log (to CloudWatch Logs). The log group is explicit with
    // RemovalPolicy.DESTROY so the fixture is self-cleaning: the CDK-default
    // auto-created log group carries DeletionPolicy: Retain and leaked one
    // log group per integ run (issue 1241). Retain semantics are covered by
    // the dedicated deletion-policy-retain fixture.
    const flowLogGroup = new logs.LogGroup(this, 'VpcFlowLogGroup', {
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const flowLog = new ec2.FlowLog(this, 'VpcFlowLog', {
      resourceType: ec2.FlowLogResourceType.fromVpc(vpc),
      destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
    });

    // Custom Network ACL
    const nacl = new ec2.NetworkAcl(this, 'CustomNacl', {
      vpc,
      subnetSelection: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // The same deploy (CDKD_TEST_REMOVAL) changes this entry's action and CIDR,
    // both "Update requires: No interruption" in CloudFormation: one in-place
    // ReplaceNetworkAclEntry under the unchanged `acl|100|false` physicalId,
    // never a delete + create (issue #5070).
    nacl.addEntry('AllowHTTPIn', {
      cidr: isRemoval ? ec2.AclCidr.ipv4('10.0.0.0/8') : ec2.AclCidr.anyIpv4(),
      ruleNumber: 100,
      traffic: ec2.AclTraffic.tcpPort(80),
      direction: ec2.TrafficDirection.INGRESS,
      ruleAction: isRemoval ? ec2.Action.DENY : ec2.Action.ALLOW,
    });

    nacl.addEntry('AllowAllOut', {
      cidr: ec2.AclCidr.anyIpv4(),
      ruleNumber: 100,
      traffic: ec2.AclTraffic.allTraffic(),
      direction: ec2.TrafficDirection.EGRESS,
    });

    // Issue #5448: the same deploy (CDKD_TEST_REMOVAL) changes one tag and
    // drops another on the InternetGateway, the public RouteTable and the
    // custom NACL. CloudFormation applies both in place (a raw change set
    // reads Modify / Replacement False for each); cdkd refused the update.
    const tagged = [
      vpc.node.findChild('IGW') as ec2.CfnInternetGateway,
      vpc.publicSubnets[0]!.node.findChild('RouteTable') as ec2.CfnRouteTable,
      nacl.node.defaultChild as ec2.CfnNetworkAcl,
    ];
    for (const resource of tagged) {
      cdk.Tags.of(resource).add('cdkd-5448', isRemoval ? 'two' : 'one');
      if (!isRemoval) cdk.Tags.of(resource).add('cdkd-5448-gone', 'x');
    }

    // Elastic IP
    const eip = new ec2.CfnEIP(this, 'TestEip', {
      tags: [{ key: 'Name', value: `${this.stackName}/TestEip` }],
    });

    // VPC Endpoint (S3 Gateway - free)
    vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // Explicit SecurityGroupEgress rule
    new ec2.CfnSecurityGroupEgress(this, 'TestEgress', {
      groupId: securityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 443,
      toPort: 443,
      cidrIp: '0.0.0.0/0',
      description: 'Allow HTTPS outbound',
    });

    // Launch Template
    const launchTemplate = new ec2.LaunchTemplate(this, 'TestLaunchTemplate', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
    });

    // Outputs
    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
      description: 'VPC ID',
    });

    new cdk.CfnOutput(this, 'DnsOffVpcId', {
      value: dnsOffVpc.ref,
      description: 'DNS-support-off VPC ID (issue #1160 removal phase)',
    });

    new cdk.CfnOutput(this, 'TenancyVpcIds', {
      value: cdk.Fn.join(',', [tenancyDownVpc.ref, tenancyUpVpc.ref]),
      description: 'InstanceTenancy VPC IDs (issue #5449 removal phase)',
    });

    new cdk.CfnOutput(this, 'PrivateZoneId', {
      value: privateZone.ref,
      description: 'Private hosted zone ID (issue #1160 removal phase)',
    });

    new cdk.CfnOutput(this, 'SecurityGroupId', {
      value: securityGroup.securityGroupId,
      description: 'Security Group ID',
    });

    new cdk.CfnOutput(this, 'PublicSubnetIds', {
      value: vpc.publicSubnets.map((s) => s.subnetId).join(','),
      description: 'Public Subnet IDs',
    });

    new cdk.CfnOutput(this, 'FlowLogId', {
      value: flowLog.flowLogId,
      description: 'VPC Flow Log ID',
    });

    new cdk.CfnOutput(this, 'NaclId', {
      value: nacl.networkAclId,
      description: 'Custom Network ACL ID',
    });

    new cdk.CfnOutput(this, 'EipAllocationId', {
      value: eip.attrAllocationId,
      description: 'Elastic IP Allocation ID',
    });

    new cdk.CfnOutput(this, 'LaunchTemplateId', {
      value: launchTemplate.launchTemplateId!,
      description: 'Launch Template ID',
    });
  }
}
