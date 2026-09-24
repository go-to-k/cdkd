import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Integ probe for issue #3661: `cdkd import --migrate-from-cloudformation`
 * could not adopt the VPC plumbing a CDK `ec2.Vpc` synthesizes (route tables,
 * routes, the internet gateway and its attachment, subnet associations), nor a
 * NACL + entry + association or an instance. The CloudFormation stack was
 * retired with them orphaned, and the next `cdkd deploy` re-created them: a
 * duplicate route table and a conflicting association.
 *
 * `restrictDefaultSecurityGroup: false` keeps a Custom Resource out of the
 * stack. Besides the EC2 types, the instance brings its IAM role and instance
 * profile, which already imported before the fix.
 */
export class ImportMigrateVpcStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    const acl = new ec2.NetworkAcl(this, 'Acl', {
      vpc,
      subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    acl.addEntry('AllowAllIn', {
      ruleNumber: 100,
      cidr: ec2.AclCidr.anyIpv4(),
      traffic: ec2.AclTraffic.allTraffic(),
      direction: ec2.TrafficDirection.INGRESS,
    });
    acl.addEntry('AllowAllOut', {
      ruleNumber: 100,
      cidr: ec2.AclCidr.anyIpv4(),
      traffic: ec2.AclTraffic.allTraffic(),
      direction: ec2.TrafficDirection.EGRESS,
    });

    new ec2.Instance(this, 'Instance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
    });
  }
}
