import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';

/**
 * A SageMaker Studio domain whose `VpcId` moves (go-to-k/cdkd#7126).
 *
 * CloudFormation replaces a domain on a `VpcId` change (measured on #7083:
 * Cloud Control refuses it `NotUpdatable`, and CloudFormation's execution went
 * to the create path). The type is stateful (the domain owns its users' home
 * EFS), so cdkd must refuse the replacement before any call unless
 * `--force-stateful-recreation` is passed. `DomainName` is required and
 * create-only, so even with the flag the create-first replacement collides
 * with the domain that keeps the name (`AlreadyExists`, as under
 * CloudFormation) and cdkd refuses it, deleting nothing.
 *
 * The domain starts in the account's DEFAULT VPC (ids from verify.sh), not one
 * this stack creates: a deleted domain leaves its home EFS and two NFS
 * security groups behind, which would block a stack VPC's deletion. verify.sh
 * sweeps them after destroy. The second VPC is the move's target and never
 * holds the domain, since every move is refused.
 *
 * CDKD_TEST_VPC_MOVE=true points the domain at the second VPC.
 *
 * covers: AWS::SageMaker::Domain
 * covers: AWS::EC2::VPC
 * covers: AWS::EC2::Subnet
 * covers: AWS::IAM::Role
 */
export class SageMakerDomainVpcStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const defaultVpcId = process.env.CDKD_TEST_DEFAULT_VPC_ID;
    const defaultSubnetId = process.env.CDKD_TEST_DEFAULT_SUBNET_ID;
    // Per run (verify.sh), so its by-name cleanup never touches another run's domain.
    const domainName = process.env.CDKD_TEST_DOMAIN_NAME;
    if (!defaultVpcId || !defaultSubnetId || !domainName) {
      throw new Error(
        'CDKD_TEST_DEFAULT_VPC_ID, CDKD_TEST_DEFAULT_SUBNET_ID and CDKD_TEST_DOMAIN_NAME are required (verify.sh sets them)'
      );
    }
    const move = process.env.CDKD_TEST_VPC_MOVE === 'true';

    const targetVpc = new ec2.CfnVPC(this, 'TargetVpc', { cidrBlock: '10.71.0.0/16' });
    const targetSubnet = new ec2.CfnSubnet(this, 'TargetSubnet', {
      vpcId: targetVpc.ref,
      cidrBlock: '10.71.0.0/24',
      availabilityZone: cdk.Fn.select(0, cdk.Fn.getAzs()),
    });

    const role = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
    });

    const domain = new sagemaker.CfnDomain(this, 'Domain', {
      domainName,
      authMode: 'IAM',
      defaultUserSettings: { executionRole: role.roleArn },
      vpcId: move ? targetVpc.ref : defaultVpcId,
      subnetIds: [move ? targetSubnet.ref : defaultSubnetId],
    });
    domain.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new cdk.CfnOutput(this, 'DomainId', { value: domain.attrDomainId });
  }
}
