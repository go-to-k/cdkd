import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as iam from 'aws-cdk-lib/aws-iam';

/** The mount target's declared IPv4 address (issue #2762); verify.sh asserts it. */
const MOUNT_TARGET_IP = '10.0.0.100';

/**
 * EFS Standalone example stack
 *
 * Demonstrates:
 * - AWS::EC2::VPC (1 AZ, public only, no NAT)
 * - AWS::EC2::SecurityGroup
 * - AWS::EFS::FileSystem (with #609 backfilled props: LifecyclePolicies,
 *   BackupPolicy, FileSystemPolicy, FileSystemProtection)
 * - AWS::EFS::MountTarget (DUAL_STACK at a declared IpAddress, #2762)
 * - AWS::EFS::AccessPoint
 * - CfnOutputs for filesystem ID, access point ID, mount target id + IpAddress
 */
export class EfsStandaloneStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC with 1 AZ, public subnet only, no NAT. Dual-stack so the mount
    // target can be DUAL_STACK (issue #2762, below).
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      ipProtocol: ec2.IpProtocol.DUAL_STACK,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    // CDKD_TEST_REMOVAL (issue #1160, efs batch): the baseline template sets
    // ThroughputMode: provisioned + ProvisionedThroughputInMibps: 1; the
    // removal phase drops both. EFS UpdateFileSystem MERGES (absent = "no
    // change"), so pre-fix the live file system silently stayed provisioned
    // (and kept billing); the provider must mirror CloudFormation's reset to
    // the create default 'bursting' (live CFn A/B 2026-08-11).
    // The same phase also drops BackupPolicy, FileSystemPolicy and
    // FileSystemProtection (issue #1160, efs-provider.ts row): CloudFormation
    // resets each (PutBackupPolicy DISABLED / DeleteFileSystemPolicy /
    // UpdateFileSystemProtection ENABLED, live CFn A/B 2026-10-28), while
    // pre-fix cdkd sent nothing. The baseline sets protection DISABLED, the
    // non-default value, so the removal reset is observable.
    const removal = process.env.CDKD_TEST_REMOVAL === 'true';

    // EFS FileSystem — exercises the #609 backfilled top-level properties:
    //  - LifecyclePolicies     (lifecyclePolicy → PutLifecycleConfiguration)
    //  - BackupPolicy          (enableAutomaticBackups → PutBackupPolicy)
    //  - FileSystemProtection  (replicationOverwriteProtection → UpdateFileSystemProtection)
    //  - FileSystemPolicy      (fileSystemPolicy → PutFileSystemPolicy)
    const fs = new efs.FileSystem(this, 'Fs', {
      vpc,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      ...(removal
        ? {}
        : {
            throughputMode: efs.ThroughputMode.PROVISIONED,
            provisionedThroughputPerSecond: cdk.Size.mebibytes(1),
            enableAutomaticBackups: true,
            replicationOverwriteProtection: efs.ReplicationOverwriteProtection.DISABLED,
            fileSystemPolicy: new iam.PolicyDocument({
              statements: [
                new iam.PolicyStatement({
                  effect: iam.Effect.ALLOW,
                  principals: [new iam.AccountRootPrincipal()],
                  actions: ['elasticfilesystem:ClientMount'],
                  resources: ['*'],
                }),
              ],
            }),
          }),
    });

    // CDKD_TEST_THROUGHPUT_VALUE_REMOVED (issue #5547): keep the baseline's
    // ThroughputMode: provisioned but drop ProvisionedThroughputInMibps, and
    // change a tag beside it. CloudFormation rejects that update before any
    // EFS call (live CFn A/B), so cdkd must refuse it, leaving the value and
    // the tag as they were; pre-fix the deploy succeeded and kept the value.
    // The L2 refuses the shape at synth, so reach its CfnFileSystem.
    const throughputValueRemoved = process.env.CDKD_TEST_THROUGHPUT_VALUE_REMOVED === 'true';
    if (throughputValueRemoved && !removal) {
      (fs.node.defaultChild as efs.CfnFileSystem).addPropertyDeletionOverride(
        'ProvisionedThroughputInMibps'
      );
    }

    // Issue #2762: the mount target's create-only addressing, which used to
    // route it through Cloud Control (the SDK provider did not handle it).
    // The L2 exposes neither, so reach its one CfnMountTarget. The
    // same values in every phase: a change would replace the mount target.
    // 10.0.0.100 sits in the only subnet (10.0.0.0/24: the default
    // 10.0.0.0/16 VPC CIDR, one /24 public subnet).
    const mountTargets = fs.node
      .findAll()
      .filter((c): c is efs.CfnMountTarget => c instanceof efs.CfnMountTarget);
    if (mountTargets.length !== 1) {
      throw new Error(`expected 1 CfnMountTarget, found ${mountTargets.length}`);
    }
    const mountTarget = mountTargets[0]!;
    mountTarget.addPropertyOverride('IpAddressType', 'DUAL_STACK');
    mountTarget.addPropertyOverride('IpAddress', MOUNT_TARGET_IP);

    // EFS AccessPoint
    const ap = fs.addAccessPoint('AP', {
      path: '/data',
      createAcl: {
        ownerGid: '1001',
        ownerUid: '1001',
        permissions: '750',
      },
      posixUser: {
        gid: '1001',
        uid: '1001',
      },
    });

    // Issue #5464: FileSystemTags / AccessPointTags are tag-updatable in
    // CloudFormation. The removal phase (CDKD_TEST_REMOVAL) retags the file
    // system — one value changed, one key dropped — and the access-point phase
    // (CDKD_TEST_AP_RETAG) does the same to the access point alone, so each
    // half fails at its own verify.sh assertion. Pre-fix the file-system
    // retag sent nothing and the access-point retag was refused.
    const apRetag = process.env.CDKD_TEST_AP_RETAG === 'true';
    const fsOnly = { excludeResourceTypes: ['AWS::EFS::AccessPoint'] };
    cdk.Tags.of(fs).add(
      'cdkd-retag',
      removal ? 'v2' : throughputValueRemoved ? 'refused' : 'v1',
      fsOnly
    );
    if (!removal) cdk.Tags.of(fs).add('cdkd-drop', 'x', fsOnly);
    cdk.Tags.of(ap).add('cdkd-ap-retag', apRetag ? 'v2' : 'v1');
    if (!apRetag) cdk.Tags.of(ap).add('cdkd-ap-drop', 'x');

    // Outputs
    new cdk.CfnOutput(this, 'FileSystemId', {
      value: fs.fileSystemId,
      description: 'EFS FileSystem ID',
    });

    new cdk.CfnOutput(this, 'AccessPointId', {
      value: ap.accessPointId,
      description: 'EFS AccessPoint ID',
    });

    // Issue #2762: `Fn::GetAtt [MountTarget, IpAddress]`, which resolved to
    // the mount target id before the SDK provider recorded the attribute.
    new cdk.CfnOutput(this, 'MountTargetId', { value: mountTarget.ref });
    new cdk.CfnOutput(this, 'MountTargetIpAddress', { value: mountTarget.attrIpAddress });
  }
}
