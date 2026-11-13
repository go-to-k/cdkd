import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

/**
 * Issue #6232: four `Fn::GetAtt` attributes CloudFormation defines resolved
 * to the resource's PHYSICAL ID under cdkd, with only a warning:
 * `AWS::EC2::VPC` `DefaultNetworkAcl` (the VPC id) and `CidrBlockAssociations`
 * (the VPC id as a string, so `Fn::Select` failed), and
 * `AWS::IAM::ManagedPolicy` `PolicyId` / `DefaultVersionId` (the policy ARN).
 *
 * Each is consumed the way a CDK app does: the default ACL in a
 * `NetworkAclEntry` property (a VPC id there fails the create), the rest in
 * Outputs that verify.sh compares with the live AWS values. Under
 * `CDKD_TEST_UPDATE=true` the policy document changes, so IAM mints `v2` and
 * `DefaultVersionId` must follow it in place.
 *
 * covers: AWS::EC2::VPC
 * covers: AWS::EC2::NetworkAclEntry
 * covers: AWS::IAM::ManagedPolicy
 */
export class GetattVpcManagedPolicyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    const vpc = new ec2.Vpc(this, 'Vpc', {
      natGateways: 0,
      maxAzs: 1,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [{ name: 'pub', subnetType: ec2.SubnetType.PUBLIC }],
    });

    new ec2.CfnNetworkAclEntry(this, 'DenyDocNet', {
      networkAclId: vpc.vpcDefaultNetworkAcl,
      ruleNumber: 150,
      protocol: -1,
      ruleAction: 'deny',
      egress: false,
      cidrBlock: '192.0.2.0/24',
    });

    const actions = isUpdate ? ['s3:ListAllMyBuckets', 's3:GetBucketLocation'] : ['s3:ListAllMyBuckets'];
    const policy = new iam.ManagedPolicy(this, 'Policy', {
      managedPolicyName: `${id}-policy`,
      statements: [new iam.PolicyStatement({ actions, resources: ['*'] })],
    });
    const cfnPolicy = policy.node.defaultChild as iam.CfnManagedPolicy;

    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId });
    new cdk.CfnOutput(this, 'DefaultNetworkAcl', { value: vpc.vpcDefaultNetworkAcl });
    new cdk.CfnOutput(this, 'CidrAssociation0', {
      value: cdk.Fn.select(0, vpc.vpcCidrBlockAssociations),
    });
    new cdk.CfnOutput(this, 'PolicyArn', { value: policy.managedPolicyArn });
    new cdk.CfnOutput(this, 'PolicyId', { value: cfnPolicy.attrPolicyId });
    new cdk.CfnOutput(this, 'DefaultVersionId', { value: cfnPolicy.attrDefaultVersionId });
  }
}
