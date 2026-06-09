import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * EC2 Instance example stack
 *
 * Demonstrates:
 * - VPC creation with public subnet (1 AZ, no NAT gateways for cost saving)
 * - EC2 Instance (t3.micro, Amazon Linux 2023)
 * - Security Group with SSH ingress rule
 * - Resource dependencies (Instance depends on VPC, Subnet, SecurityGroup)
 * - Fn::GetAtt for outputs (Instance ID, Public IP, Private IP)
 * - Security-focused property backfill (#609): DisableApiTermination /
 *   MetadataOptions (IMDSv2) / Monitoring / EbsOptimized / CreditSpecification
 *
 * The instance is authored as a RAW `ec2.CfnInstance` (L1) on purpose. The L2
 * `ec2.Instance` construct always emits an `AvailabilityZone` property (a cdkd
 * silent-drop), which under the #614 routing rule flips the ENTIRE resource
 * onto the Cloud Control path — which forwards every property to AWS verbatim
 * and therefore NEVER exercises the SDK provider's create/update/readback
 * backfill this fixture is meant to verify. Using L1 lets us emit ONLY
 * cdkd-handled top-level properties so the instance stays on the SDK provider
 * path (per the #609 backfill-fixture rule: L1 over L2, every emitted prop must
 * be handled). All five backfilled props ride on RunInstances directly.
 */
export class Ec2InstanceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

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

    // Create Security Group allowing SSH
    const securityGroup = new ec2.SecurityGroup(this, 'InstanceSG', {
      vpc,
      description: 'Security group for EC2 instance',
      allowAllOutbound: true,
    });

    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      'Allow SSH from anywhere'
    );

    // Resolve the Amazon Linux 2023 AMI for this stack's region.
    const ami = ec2.MachineImage.latestAmazonLinux2023().getImage(this).imageId;

    // Raw L1 instance — emit only cdkd-handled top-level props so the resource
    // stays on the SDK provider path (see class doc above).
    const instance = new ec2.CfnInstance(this, 'Instance', {
      imageId: ami,
      instanceType: 't3.micro',
      subnetId: vpc.publicSubnets[0].subnetId,
      securityGroupIds: [securityGroup.securityGroupId],
      // Security-focused property backfill (#609):
      // Termination protection — a silent-drop here would let a user believe
      // the instance is protected when it is not. `cdkd destroy
      // --remove-protection` (exercised by verify.sh) flips this off before
      // terminate.
      disableApiTermination: true,
      // IMDSv2 enforcement inline on the instance (no LaunchTemplate).
      metadataOptions: {
        httpTokens: 'required',
        httpEndpoint: 'enabled',
        httpPutResponseHopLimit: 1,
      },
      // Detailed CloudWatch monitoring.
      monitoring: true,
      // Dedicated EBS throughput.
      ebsOptimized: true,
      // T-family burstable CPU credit mode.
      creditSpecification: { cpuCredits: 'unlimited' },
    });

    // Outputs
    new cdk.CfnOutput(this, 'InstanceId', {
      value: instance.ref,
      description: 'EC2 Instance ID',
    });

    new cdk.CfnOutput(this, 'PublicIp', {
      value: instance.attrPublicIp,
      description: 'EC2 Instance Public IP',
    });

    new cdk.CfnOutput(this, 'PrivateIp', {
      value: instance.attrPrivateIp,
      description: 'EC2 Instance Private IP',
    });

    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
      description: 'VPC ID',
    });
  }
}
