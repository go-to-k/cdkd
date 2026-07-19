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
 * Both must keep the FileSystemId unchanged (no replacement).
 */
export class FsxOpenZfsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

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
      // Smallest legal OpenZFS SINGLE_AZ_1 capacity.
      storageCapacity: 64,
      subnetIds: [vpc.publicSubnets[0].subnetId],
      openZfsConfiguration: {
        deploymentType: 'SINGLE_AZ_1',
        // 64 MB/s baseline; the UPDATE phase scales it to 128.
        throughputCapacity: isUpdate ? 128 : 64,
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
