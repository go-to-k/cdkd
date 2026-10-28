import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as fsx from 'aws-cdk-lib/aws-fsx';
import type { Construct } from 'constructs';

/**
 * Minimal FSx for OpenZFS fixture for the AWS::FSx::FileSystem SDK provider
 * Windows / ONTAP / OpenZFS variants (issue #1068, follow-up to #1042). The
 * type is ProvisioningType: NON_PROVISIONABLE, so no Cloud Control fallback
 * exists — this fixture is the end-to-end proof of the OpenZFS variant
 * mapping. aws-cdk-lib ships no OpenZFS L2, so it uses the L1
 * `fsx.CfnFileSystem`.
 *
 * OpenZFS is the CHEAPEST non-Lustre variant to stand up (SINGLE_AZ_1, no
 * Active Directory, one subnet, 64 GiB / 64 MB/s — the smallest legal
 * config), so it is the variant chosen for the live integ. Windows / ONTAP
 * are unit-tested and share this fixture's integ-verified create-poll /
 * delete-poll path.
 *
 * covers: AWS::FSx::FileSystem
 * covers: AWS::EC2::VPC
 *
 * UPDATE phase (CDKD_TEST_UPDATE=true) exercises the in-place OpenZFS update
 * path:
 *   - ThroughputCapacity 64 -> 128 MB/s (UpdateFileSystem — a mutable
 *     OpenZFSConfiguration sub-property)
 *   - Tag value change + tag REMOVAL (TagResource / UntagResource)
 *   - OpenZFSConfiguration.Options DELETE_CHILD_VOLUMES_AND_SNAPSHOTS is
 *     ADDED (go-to-k/cdkd#5431). It is a DeleteFileSystem option (CFn "Update
 *     requires: No interruption"), so the deploy must accept it with nothing
 *     sent to AWS, and the destroy must send it: verify.sh adds a child volume
 *     outside the stack before the destroy, which FSx refuses to delete
 *     without the option.
 * All must keep the FileSystemId unchanged (no replacement).
 *
 * REMOVAL phase (CDKD_TEST_UPDATE=true CDKD_TEST_REMOVAL=true, issue #1160):
 *   - StorageCapacity (64), StorageType (SSD) and NetworkType (IPV4), declared
 *     until now, are DROPPED from the template. UpdateFileSystem keeps a field
 *     it is not sent and cdkd sends no reset, as CloudFormation leaves them
 *     (CFn A/B on issue #1160), so the values must stay and the deploy must
 *     name the three removals in one warning saying CloudFormation keeps them.
 *     SSD and IPV4 are AWS's defaults here: this VPC has no IPv6, and
 *     the SINGLE_AZ_1 file system is SSD, so the arm proves the warning and that
 *     nothing is reset, not a non-default value surviving.
 *   - WeeklyMaintenanceStartTime is ADDED in the same deploy, a companion
 *     change proving UpdateFileSystem fired with the removals beside it.
 *
 * THROUGHPUT REMOVAL phase (the REMOVAL phase's env plus
 * CDKD_TEST_TP_REMOVAL=true, issue #1160):
 *   - ThroughputCapacity (128) is DROPPED. The CFn A/B on issue #1160 measured
 *     CloudFormation keeping it on MULTI_AZ_1 only, never on this SINGLE_AZ_1
 *     shape, so cdkd must leave the value in place and warn WITHOUT claiming
 *     what CloudFormation does.
 */
export class FsxOpenZfsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';
    const isRemoval = process.env.CDKD_TEST_REMOVAL === 'true';
    const isMaintAlt = process.env.CDKD_TEST_MAINT_ALT === 'true';
    const isTpRemoval = process.env.CDKD_TEST_TP_REMOVAL === 'true';

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

    const fileSystem = new fsx.CfnFileSystem(this, 'Fs', {
      fileSystemType: 'OPENZFS',
      // Smallest legal OpenZFS SINGLE_AZ_1 capacity. The three top-level
      // settings are dropped in the REMOVAL phase (issue #1160).
      ...(isRemoval ? {} : { storageCapacity: 64, storageType: 'SSD', networkType: 'IPV4' }),
      subnetIds: [vpc.publicSubnets[0].subnetId],
      openZfsConfiguration: {
        deploymentType: 'SINGLE_AZ_1',
        // 64 MB/s baseline; the UPDATE phase scales it to 128, and the
        // THROUGHPUT REMOVAL phase drops it (issue #1160).
        ...(!isTpRemoval && { throughputCapacity: isUpdate ? 128 : 64 }),
        // go-to-k/cdkd#5431: declared from the UPDATE phase on, so the
        // destroy deletes the child volume verify.sh adds.
        ...(isUpdate && { options: ['DELETE_CHILD_VOLUMES_AND_SNAPSHOTS'] }),
        // Sunday 03:30 UTC, or Monday 04:45 under CDKD_TEST_MAINT_ALT=true,
        // which verify.sh picks when AWS already holds the first.
        ...(isRemoval && { weeklyMaintenanceStartTime: isMaintAlt ? '1:04:45' : '7:03:30' }),
        // Default root volume — exercises the RootVolumeConfiguration create
        // mapping (record size + compression).
        rootVolumeConfiguration: {
          recordSizeKiB: 128,
          dataCompressionType: 'LZ4',
        },
      },
    });
    fileSystem.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // Constant tag used by verify.sh cleanup to find leftover file systems.
    cdk.Tags.of(fileSystem).add('cdkd-integ', 'fsx-openzfs');
    cdk.Tags.of(fileSystem).add('env', isUpdate ? 'changed' : 'test');
    if (!isUpdate) {
      // Removed in the UPDATE phase — exercises UntagResource.
      cdk.Tags.of(fileSystem).add('dropme', 'yes');
    }

    new cdk.CfnOutput(this, 'FileSystemId', { value: fileSystem.ref });
    // Fn::GetAtt DNSName / RootVolumeId — proves the provider's attribute
    // wiring end to end (RootVolumeId is OpenZFS-only).
    new cdk.CfnOutput(this, 'DnsName', { value: fileSystem.attrDnsName });
    new cdk.CfnOutput(this, 'RootVolumeId', { value: fileSystem.attrRootVolumeId });
  }
}
