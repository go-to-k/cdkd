import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';

/**
 * The security group each routing phase declares. `SecurityGroups` is the only
 * mutable property, and consecutive deploys must differ: one the differ calls
 * NO_CHANGE never provisions the mount target, so it could not flip. verify.sh
 * runs its `cdkd diff` with `pinned`, because `seed` and `flip` declare one group.
 */
const SECURITY_GROUP_BY_PHASE: Record<string, 'A' | 'B'> = {
  base: 'A',
  seed: 'B',
  pinned: 'A',
  flip: 'B',
};

/**
 * physicalId-parity arm for issue 5641: a mount target recorded
 * `provisionedBy: 'cc-api'` returns to its SDK provider without churn.
 *
 * covers: AWS::EFS::MountTarget
 *
 * The schema's `primaryIdentifier` is `Id`; `EFSProvider.create` records the
 * CreateMountTarget `MountTargetId`, and Cloud Control returned the same
 * `fsmt-...` (measured us-east-1, 2026-11-02). The id is AWS-minted, so a flip
 * that kept it is its own identity witness: verify.sh proves the mint by
 * watching the recreate change it.
 */
export class CcToSdkRerouteMountTargetStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const phase = process.env.CDKD_TEST_PHASE ?? 'base';
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        { cidrMask: 24, name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });
    const groupA = new ec2.SecurityGroup(this, 'GroupA', { vpc, description: 'reroute group A' });
    const groupB = new ec2.SecurityGroup(this, 'GroupB', { vpc, description: 'reroute group B' });
    const fileSystem = new efs.CfnFileSystem(this, 'FileSystem', { encrypted: true });

    const declared = (SECURITY_GROUP_BY_PHASE[phase] ?? 'A') === 'A' ? groupA : groupB;
    const mountTarget = new efs.CfnMountTarget(this, 'RerouteMountTarget', {
      fileSystemId: fileSystem.ref,
      subnetId: vpc.isolatedSubnets[0]!.subnetId,
      securityGroups: [declared.securityGroupId],
    });

    new cdk.CfnOutput(this, 'GroupAId', { value: groupA.securityGroupId });
    new cdk.CfnOutput(this, 'GroupBId', { value: groupB.securityGroupId });
    new cdk.CfnOutput(this, 'FileSystemId', { value: fileSystem.ref });
    new cdk.CfnOutput(this, 'MountTargetRef', { value: mountTarget.ref });
    new cdk.CfnOutput(this, 'MountTargetIp', { value: mountTarget.attrIpAddress });
  }
}
