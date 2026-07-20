import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as fsx from 'aws-cdk-lib/aws-fsx';
import type { Construct } from 'constructs';

/**
 * Minimal FSx for NetApp ONTAP fixture for the AWS::FSx::FileSystem SDK
 * provider (issue #1088, follow-up to PR #1085 which shipped the
 * Windows / ONTAP / OpenZFS variants but live-integ-verified only OpenZFS).
 * The type is ProvisioningType: NON_PROVISIONABLE, so no Cloud Control
 * fallback exists — this fixture is the end-to-end proof of the ONTAP
 * variant mapping. aws-cdk-lib ships no ONTAP L2, so it uses the L1
 * `fsx.CfnFileSystem`.
 *
 * covers: AWS::FSx::FileSystem
 * covers: AWS::EC2::VPC
 *
 * Cost bounding — every constrained value is the SMALLEST LEGAL one:
 *   - `SINGLE_AZ_1` (one subnet, one HA pair): the cheapest ONTAP
 *     deployment type. MULTI_AZ_1 doubles the file-server footprint.
 *   - `StorageCapacity: 1024` GiB. ONTAP's minimum is `1024 * HAPairs`
 *     and HAPairs defaults to 1, so 1024 GiB is the floor
 *     (CreateFileSystemRequest.StorageCapacity, @aws-sdk/client-fsx).
 *   - `ThroughputCapacity: 128` MBps. For SINGLE_AZ_1 the valid values
 *     are 128, 256, 512, 1024, 2048, 4096 MBps — 128 is the floor
 *     (CreateFileSystemOntapConfiguration.ThroughputCapacityPerHAPair
 *     docs, @aws-sdk/client-fsx).
 *   - `AutomaticBackupRetentionDays: 0` disables automatic backups, so
 *     the run cannot leave chargeable backups behind (the ONTAP default
 *     is 30).
 *   - `PreferredSubnetId` is deliberately omitted: it is required only
 *     for MULTI_AZ_1 / MULTI_AZ_2.
 *   - No `FsxAdminPassword`: optional, and the fixture never talks to the
 *     ONTAP CLI, so no secret is committed.
 *
 * UPDATE phase (CDKD_TEST_UPDATE=true) exercises the in-place ONTAP
 * update path. Precisely: it proves the ROUTING — that a change reaches
 * `UpdateFileSystem` under the right `configKey` and the right
 * `UpdateFileSystemOntapConfiguration` wrapper. It does NOT prove any
 * variant-UNIQUE update field, because `WeeklyMaintenanceStartTime` is
 * the identical trivial pass-through arm in all four apply functions.
 * ONTAP's own arms — `FsxAdminPassword`, `HAPairs`,
 * `ThroughputCapacityPerHAPair`, `RouteTableIds` — are untested here.
 *   - `WeeklyMaintenanceStartTime` '1:05:00' -> '2:06:00' (an
 *     UpdateFileSystem-mutable OntapConfiguration sub-property). Chosen
 *     over a ThroughputCapacity change on purpose: scaling ONTAP
 *     throughput is a live storage-optimization operation that adds
 *     tens of minutes of wall clock AND raises the hourly bill for the
 *     rest of the run, while exercising the same
 *     `applyOntapUpdateField` mapping.
 *   - Tag value change + tag REMOVAL (TagResource / UntagResource).
 * Both must keep the FileSystemId unchanged (no replacement).
 *
 * Known coverage boundary: because `WeeklyMaintenanceStartTime` is
 * metadata-only, `UpdateFileSystem` reports no pending administrative
 * action, so this fixture does NOT exercise the provider's asynchronous
 * admin-action wait. That branch is variant-agnostic and is covered live
 * by `fsx-openzfs`, whose UPDATE scales ThroughputCapacity.
 */
export class FsxOntapStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    // VPC with 1 AZ, public subnet only, no NAT (cheapest legal shape —
    // SINGLE_AZ_1 needs exactly one subnet).
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

    const fileSystem = new fsx.CfnFileSystem(this, 'Fs', {
      fileSystemType: 'ONTAP',
      // Smallest legal ONTAP capacity: 1024 GiB * HAPairs(=1).
      storageCapacity: 1024,
      subnetIds: [vpc.publicSubnets[0].subnetId],
      ontapConfiguration: {
        deploymentType: 'SINGLE_AZ_1',
        // Smallest legal SINGLE_AZ_1 throughput.
        throughputCapacity: 128,
        // No automatic backups — nothing chargeable survives the destroy.
        automaticBackupRetentionDays: 0,
        // The UPDATE phase moves this; see the class doc for why it is
        // the chosen mutable sub-property.
        weeklyMaintenanceStartTime: isUpdate ? '2:06:00' : '1:05:00',
        // AUTOMATIC is the default (SSD IOPS scale with capacity), so this
        // costs nothing. Setting it alone would prove nothing either —
        // being the default, a provider that dropped the block entirely
        // would look identical. verify.sh therefore READS BACK
        // `DiskIopsConfiguration.Mode`/`.Iops`, which is what actually
        // covers the shared `toDiskIopsConfiguration` mapping.
        diskIopsConfiguration: {
          mode: 'AUTOMATIC',
        },
      },
    });
    fileSystem.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // Constant tag used by verify.sh cleanup to find leftover file systems.
    cdk.Tags.of(fileSystem).add('cdkd-integ', 'fsx-ontap');
    cdk.Tags.of(fileSystem).add('env', isUpdate ? 'changed' : 'test');
    if (!isUpdate) {
      // Removed in the UPDATE phase — exercises UntagResource.
      cdk.Tags.of(fileSystem).add('dropme', 'yes');
    }

    new cdk.CfnOutput(this, 'FileSystemId', { value: fileSystem.ref });
    // Fn::GetAtt ResourceARN — proves the provider's attribute wiring end
    // to end. ONTAP file systems expose no top-level DNSName (their
    // endpoints live under OntapConfiguration.Endpoints), so ResourceARN
    // is the attribute this variant can assert against.
    new cdk.CfnOutput(this, 'ResourceArn', { value: fileSystem.attrResourceArn });
  }
}
