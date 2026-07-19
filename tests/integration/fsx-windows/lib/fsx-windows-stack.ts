import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as fsx from 'aws-cdk-lib/aws-fsx';
import type { Construct } from 'constructs';

/**
 * Minimal FSx for Windows File Server fixture for the AWS::FSx::FileSystem
 * SDK provider (issue #1088, follow-up to PR #1085 which shipped the
 * Windows / ONTAP / OpenZFS variants but live-integ-verified only
 * OpenZFS). The type is ProvisioningType: NON_PROVISIONABLE, so no Cloud
 * Control fallback exists — this fixture is the end-to-end proof of the
 * Windows variant mapping. aws-cdk-lib ships no Windows-variant L2, so it
 * uses the L1 `fsx.CfnFileSystem`.
 *
 * covers: AWS::FSx::FileSystem
 * covers: AWS::EC2::VPC
 *
 * ## Why the file system is behind an env var
 *
 * A Windows file system MUST join an Active Directory at creation, and
 * the only practical option here is an AWS Managed Microsoft AD (a
 * self-managed AD would need real domain controllers). cdkd cannot
 * provision one: the AD resource type is reported by AWS as
 * `ProvisioningType: NON_PROVISIONABLE` and cdkd ships no SDK provider
 * for it, so it sits in `src/provisioning/unsupported-types.generated.ts`.
 *
 * verify.sh therefore creates the directory out of band, in the VPC this
 * stack deploys, and feeds its id back in through `FSX_AD_ID`:
 *
 *   - `FSX_AD_ID` unset  -> VPC only (bootstrap for the directory, and
 *     the shape verify.sh re-deploys to make cdkd DELETE the file system
 *     while the VPC still stands).
 *   - `FSX_AD_ID` set    -> VPC + the AD-joined Windows file system.
 *
 * The VPC has 2 AZs because `DirectoryVpcSettings.SubnetIds` requires
 * exactly two subnets in DIFFERENT Availability Zones. The file system
 * itself is SINGLE_AZ_1 and uses only the first subnet.
 *
 * ## Cost bounding
 *
 * Every constrained value is the smallest legal one, verified against the
 * FSx API rather than the CloudFormation schema:
 *   - `SINGLE_AZ_1`: the cheapest Windows deployment type (MULTI_AZ_1
 *     runs a standby file server). It also allows the lowest throughput
 *     tier — SINGLE_AZ_2 / MULTI_AZ_1 start at 32 MBps.
 *   - `StorageType: SSD` + `StorageCapacity: 32` GiB. SSD's minimum is
 *     32 GiB; HDD's minimum is 2000 GiB, so SSD is both the floor and
 *     the cheaper choice at this size (FSx for Windows quotas:
 *     "Minimum storage capacity, SSD file systems: 32 GiB").
 *   - `ThroughputCapacity: 8` MBps — the documented minimum throughput
 *     capacity, and the lowest member of the valid set
 *     (8, 16, 32, 64, 128, 256, 512, 1024, 2048).
 *   - `AutomaticBackupRetentionDays: 0` disables automatic backups
 *     (default is 30), so the run cannot leave chargeable backups behind.
 *   - The Managed AD is created by verify.sh with `Edition: Standard`
 *     (the cheaper of Standard / Enterprise; the API default is
 *     Enterprise, so it must be passed explicitly).
 *
 * UPDATE phase (CDKD_TEST_UPDATE=true) exercises the in-place Windows
 * update path:
 *   - `WeeklyMaintenanceStartTime` '1:05:00' -> '2:06:00' (an
 *     UpdateFileSystem-mutable WindowsConfiguration sub-property). Chosen
 *     over a ThroughputCapacity change on purpose: scaling Windows
 *     throughput swaps the underlying file servers and can add ~30
 *     minutes of billed wall clock while exercising the same
 *     `applyWindowsUpdateField` mapping.
 *   - Tag value change + tag REMOVAL (TagResource / UntagResource).
 * Both must keep the FileSystemId unchanged (no replacement).
 */
export class FsxWindowsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';
    const activeDirectoryId = process.env.FSX_AD_ID;

    // 2 AZs: the Managed AD needs two subnets in different AZs. Public
    // subnets only, no NAT (cheapest legal shape).
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    // Always emitted — verify.sh needs these to create the directory
    // before the file system can be deployed.
    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId });
    new cdk.CfnOutput(this, 'SubnetIdA', { value: vpc.publicSubnets[0].subnetId });
    new cdk.CfnOutput(this, 'SubnetIdB', { value: vpc.publicSubnets[1].subnetId });

    if (!activeDirectoryId) {
      // Bootstrap phase: no directory yet, so no file system either.
      return;
    }

    const fileSystem = new fsx.CfnFileSystem(this, 'Fs', {
      fileSystemType: 'WINDOWS',
      // Smallest legal Windows SSD capacity.
      storageCapacity: 32,
      storageType: 'SSD',
      subnetIds: [vpc.publicSubnets[0].subnetId],
      windowsConfiguration: {
        activeDirectoryId,
        deploymentType: 'SINGLE_AZ_1',
        // Minimum Windows throughput capacity.
        throughputCapacity: 8,
        // No automatic backups — nothing chargeable survives the destroy.
        automaticBackupRetentionDays: 0,
        // The UPDATE phase moves this; see the class doc for why it is
        // the chosen mutable sub-property.
        weeklyMaintenanceStartTime: isUpdate ? '2:06:00' : '1:05:00',
      },
    });
    fileSystem.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // Constant tag used by verify.sh cleanup to find leftover file systems.
    cdk.Tags.of(fileSystem).add('cdkd-integ', 'fsx-windows');
    cdk.Tags.of(fileSystem).add('env', isUpdate ? 'changed' : 'test');
    if (!isUpdate) {
      // Removed in the UPDATE phase — exercises UntagResource.
      cdk.Tags.of(fileSystem).add('dropme', 'yes');
    }

    new cdk.CfnOutput(this, 'FileSystemId', { value: fileSystem.ref });
    // Fn::GetAtt DNSName / ResourceARN — proves the provider's attribute
    // wiring end to end. The DNS name of an AD-joined Windows file system
    // is derived from the directory's domain, so it also witnesses that
    // the domain join really happened.
    new cdk.CfnOutput(this, 'DnsName', { value: fileSystem.attrDnsName });
    new cdk.CfnOutput(this, 'ResourceArn', { value: fileSystem.attrResourceArn });
  }
}
