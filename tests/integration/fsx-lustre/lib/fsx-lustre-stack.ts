import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as fsx from 'aws-cdk-lib/aws-fsx';
import type { Construct } from 'constructs';

/**
 * Minimal FSx for Lustre fixture for the AWS::FSx::FileSystem SDK provider
 * (issue #1042). The type is ProvisioningType: NON_PROVISIONABLE, so no
 * Cloud Control fallback exists — this fixture is the end-to-end proof of
 * the SDK provider, built on the CDK L2 (`aws-fsx.LustreFileSystem`).
 *
 * covers: AWS::FSx::FileSystem
 * covers: AWS::EC2::VPC
 * covers: AWS::EC2::SecurityGroup
 *
 * Smallest legal Lustre config: SCRATCH_2 at 1200 GiB (1.2 TiB), single
 * AZ, no NAT — keeps the hourly cost and the create wall-clock bounded.
 *
 * UPDATE phase (CDKD_TEST_UPDATE=true) exercises the in-place update path:
 *   - DataCompressionType NONE -> LZ4 (UpdateFileSystem — mutable Lustre
 *     sub-property)
 *   - Tag value change + tag REMOVAL (TagResource / UntagResource)
 * Both must keep the FileSystemId unchanged (no replacement).
 *
 * REMOVAL phase (CDKD_TEST_UPDATE=true CDKD_TEST_REMOVAL=true, issue #1160):
 *   - DataCompressionType is DROPPED from the template (live value LZ4,
 *     AWS's non-default). UpdateFileSystem keeps a field it is not sent and
 *     cdkd sends no reset, so the value must stay LZ4 and the deploy must
 *     name the removal in a warning instead of dropping it silently.
 *   - WeeklyMaintenanceStartTime is ADDED in the same deploy, a companion
 *     change proving UpdateFileSystem fired with the removal beside it.
 */
export class FsxLustreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';
    const isRemoval = process.env.CDKD_TEST_REMOVAL === 'true';
    const isMaintAlt = process.env.CDKD_TEST_MAINT_ALT === 'true';

    // VPC with 1 AZ, public subnet only, no NAT (cheapest legal shape).
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

    const fileSystem = new fsx.LustreFileSystem(this, 'Fs', {
      vpc,
      vpcSubnet: vpc.publicSubnets[0],
      storageCapacityGiB: 1200,
      lustreConfiguration: {
        deploymentType: fsx.LustreDeploymentType.SCRATCH_2,
        ...(isRemoval
          ? {
              // Sunday 03:30 UTC -> "7:03:30" on the wire, or Monday 04:45
              // -> "1:04:45" under CDKD_TEST_MAINT_ALT=true, which verify.sh
              // picks when AWS already holds the first.
              weeklyMaintenanceStartTime: new fsx.LustreMaintenanceTime(
                isMaintAlt
                  ? { day: fsx.Weekday.MONDAY, hour: 4, minute: 45 }
                  : { day: fsx.Weekday.SUNDAY, hour: 3, minute: 30 }
              ),
            }
          : {
              dataCompressionType: isUpdate
                ? fsx.LustreDataCompressionType.LZ4
                : fsx.LustreDataCompressionType.NONE,
            }),
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Constant tag used by verify.sh cleanup to find leftover file systems.
    cdk.Tags.of(fileSystem).add('cdkd-integ', 'fsx-lustre');
    cdk.Tags.of(fileSystem).add('env', isUpdate ? 'changed' : 'test');
    if (!isUpdate) {
      // Removed in the UPDATE phase — exercises UntagResource.
      cdk.Tags.of(fileSystem).add('dropme', 'yes');
    }

    new cdk.CfnOutput(this, 'FileSystemId', { value: fileSystem.fileSystemId });
    // Fn::GetAtt DNSName / LustreMountName — proves the provider's
    // attribute wiring end to end.
    new cdk.CfnOutput(this, 'DnsName', { value: fileSystem.dnsName });
    new cdk.CfnOutput(this, 'MountName', { value: fileSystem.mountName });
  }
}
