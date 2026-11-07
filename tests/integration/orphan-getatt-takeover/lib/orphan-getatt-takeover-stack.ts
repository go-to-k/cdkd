import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

/** The role's FIXED name: verify.sh re-creates a role under it out of band. */
export const ROLE_NAME = 'cdkd-orphan-getatt-takeover-role';
export const PARAMETER_NAME = '/cdkd-integ/orphan-getatt-takeover/role-id';
/** Fixed names: verify.sh deletes the orphaned log group itself. */
export const LOG_GROUP_NAME = '/cdkd-integ/orphan-getatt-takeover/region-probe';
export const LOG_GROUP_ARN_PARAMETER_NAME = '/cdkd-integ/orphan-getatt-takeover/log-group-arn';
/** verify.sh finds the two subnet-attribute parameters by these names. */
export const SUBNET_BLOCKS_PARAMETER_NAME = '/cdkd-integ/orphan-getatt-takeover/subnet-ipv6-blocks';
export const SUBNET_NACL_PARAMETER_NAME = '/cdkd-integ/orphan-getatt-takeover/subnet-nacl-association';

/**
 * `cdkd orphan` over a resource whose NAME was taken over out of band
 * (issue #4186).
 *
 * The parameter's value is `Fn::GetAtt [Role, RoleId]`. `RoleId` is unique
 * per role INSTANCE while the provider's live read addresses the role by
 * NAME, so after verify.sh deletes the role and creates another under the
 * same name, a live read answers with the newcomer's id. `cdkd orphan` must
 * substitute the RECORDED id — the one the parameter was deployed with.
 *
 * The second parameter holds `Fn::GetAtt [LogGroup, Arn]` (issue #4937):
 * verify.sh strips the recorded `Arn` so `cdkd orphan` reads it live, with the
 * shell's `AWS_REGION` pointed at another region. The provider derives the ARN
 * from its client's region, so a read outside the stack's region writes a
 * wrong-region ARN into the parameter's state row.
 *
 * The last two parameters read an IPv6 subnet's `Ipv6CidrBlocks` and
 * `NetworkAclAssociationId` (issue #5968): `cdkd orphan` of the subnet reads
 * both live through the provider's `getAttribute`, which answered neither, so
 * the rewrite aborted as unresolvable. A minimal VPC (no gateways, no NAT)
 * holds the subnet; its default network ACL supplies the association.
 *
 * covers: AWS::IAM::Role
 * covers: AWS::SSM::Parameter
 * covers: AWS::Logs::LogGroup
 * covers: AWS::EC2::VPC
 * covers: AWS::EC2::VPCCidrBlock
 * covers: AWS::EC2::Subnet
 */
export class OrphanGetattTakeoverStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const role = new iam.Role(this, 'Role', {
      roleName: ROLE_NAME,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    role.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new ssm.StringParameter(this, 'RoleIdParam', {
      parameterName: PARAMETER_NAME,
      stringValue: role.roleId,
    });

    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: LOG_GROUP_NAME,
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new ssm.StringParameter(this, 'LogGroupArnParam', {
      parameterName: LOG_GROUP_ARN_PARAMETER_NAME,
      stringValue: logGroup.logGroupArn,
    });

    const vpc = new ec2.CfnVPC(this, 'Vpc', { cidrBlock: '10.63.0.0/16' });
    const vpcIpv6 = new ec2.CfnVPCCidrBlock(this, 'VpcIpv6', {
      vpcId: vpc.ref,
      amazonProvidedIpv6CidrBlock: true,
    });
    // `V6Subnet`, not `Subnet`: `cdkd orphan` matches construct paths by prefix.
    const subnet = new ec2.CfnSubnet(this, 'V6Subnet', {
      vpcId: vpc.ref,
      cidrBlock: '10.63.1.0/24',
      ipv6CidrBlock: cdk.Fn.select(
        0,
        cdk.Fn.cidr(cdk.Fn.select(0, vpc.attrIpv6CidrBlocks), 1, '64')
      ),
    });
    subnet.addResourceDependency(vpcIpv6);

    new ssm.StringParameter(this, 'SubnetBlocksParam', {
      parameterName: SUBNET_BLOCKS_PARAMETER_NAME,
      stringValue: cdk.Fn.join(',', subnet.attrIpv6CidrBlocks),
    });
    new ssm.StringParameter(this, 'SubnetNaclParam', {
      parameterName: SUBNET_NACL_PARAMETER_NAME,
      stringValue: subnet.attrNetworkAclAssociationId,
    });
  }
}
