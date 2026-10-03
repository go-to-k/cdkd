import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as fsx from 'aws-cdk-lib/aws-fsx';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';

/**
 * One copy of a stack that bin/app.ts instantiates TWICE (go-to-k/cdkd#4428).
 *
 * Every create token here used to be derived from the logical id (and the
 * create-only inputs) only, so the second copy sent the first copy's token:
 * EFS refused its file system with `FileSystemAlreadyExists`, and CloudFront
 * answered its origin access identity with the FIRST copy's identity, which a
 * destroy of the second copy then deleted.
 *
 * `CDKD_TEST_RETAIN=true` gives the file system `RemovalPolicy.RETAIN` (CDK's
 * own default for `efs.FileSystem`): a destroy keeps it, and the redeploy that
 * follows sends the same deterministic token, which must be refused rather
 * than adopted.
 *
 * No VPC: a file system needs none until a mount target is added.
 *
 * covers: AWS::EFS::FileSystem
 * covers: AWS::CloudFront::CloudFrontOriginAccessIdentity
 */
export class StackCopyCreateTokensStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const fs = new efs.CfnFileSystem(this, 'TokenScopeFs', {
      encrypted: true,
      performanceMode: 'generalPurpose',
    });
    fs.applyRemovalPolicy(
      process.env.CDKD_TEST_RETAIN === 'true' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
    );

    // A constant comment, as CDK's own default OAI comment is: both copies
    // send an identical config, which is what CloudFront hands back on.
    const oai = new cloudfront.CfnCloudFrontOriginAccessIdentity(this, 'TokenScopeOai', {
      cloudFrontOriginAccessIdentityConfig: { comment: 'cdkd-token-scope-4428' },
    });
    oai.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new cdk.CfnOutput(this, 'FileSystemId', { value: fs.ref });
    new cdk.CfnOutput(this, 'OaiId', { value: oai.ref });
  }
}

/**
 * The network the two FSx copies share: one public subnet (1 AZ, no NAT) and a
 * security group admitting Lustre traffic from itself.
 *
 * covers: AWS::EC2::VPC
 * covers: AWS::EC2::SecurityGroup
 */
export class FsxNetworkStack extends cdk.Stack {
  readonly subnetId: string;
  readonly securityGroupId: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ cidrMask: 24, name: 'Public', subnetType: ec2.SubnetType.PUBLIC }],
    });
    const sg = new ec2.SecurityGroup(this, 'LustreSg', { vpc, allowAllOutbound: true });
    // Lustre LNET traffic between the file system's own network interfaces.
    sg.addIngressRule(sg, ec2.Port.tcp(988), 'Lustre');
    sg.addIngressRule(sg, ec2.Port.tcpRange(1018, 1023), 'Lustre');

    // The cleanup's last-resort VPC sweep finds the network by this tag.
    cdk.Tags.of(this).add('cdkd-integ', 'stack-copy-create-tokens');

    this.subnetId = vpc.publicSubnets[0].subnetId;
    this.securityGroupId = sg.securityGroupId;
  }
}

/**
 * One FSx copy: a minimal Lustre SCRATCH_2 file system (1.2 TiB) on the shared
 * network. Both copies send identical create-only inputs, so before the fix
 * FSx answered the second copy's create with the FIRST copy's file system.
 *
 * covers: AWS::FSx::FileSystem
 */
export class FsxCopyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps & { net: FsxNetworkStack }) {
    super(scope, id, props);

    const fs = new fsx.CfnFileSystem(this, 'TokenScopeFsx', {
      fileSystemType: 'LUSTRE',
      storageCapacity: 1200,
      subnetIds: [props.net.subnetId],
      securityGroupIds: [props.net.securityGroupId],
      lustreConfiguration: { deploymentType: 'SCRATCH_2' },
      tags: [{ key: 'cdkd-integ', value: 'stack-copy-create-tokens' }],
    });
    fs.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new cdk.CfnOutput(this, 'FileSystemId', { value: fs.ref });
  }
}
