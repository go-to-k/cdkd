import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * EFS Standalone example stack
 *
 * Demonstrates:
 * - AWS::EC2::VPC (1 AZ, public only, no NAT)
 * - AWS::EC2::SecurityGroup
 * - AWS::EFS::FileSystem (with #609 backfilled props: LifecyclePolicies,
 *   BackupPolicy, FileSystemPolicy, FileSystemProtection)
 * - AWS::EFS::MountTarget
 * - AWS::EFS::AccessPoint
 * - CfnOutputs for filesystem ID, access point ID
 */
export class EfsStandaloneStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC with 1 AZ, public subnet only, no NAT
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

    // EFS FileSystem — exercises the #609 backfilled top-level properties:
    //  - LifecyclePolicies     (lifecyclePolicy → PutLifecycleConfiguration)
    //  - BackupPolicy          (enableAutomaticBackups → PutBackupPolicy)
    //  - FileSystemProtection  (replicationOverwriteProtection → UpdateFileSystemProtection)
    //  - FileSystemPolicy      (fileSystemPolicy → PutFileSystemPolicy)
    const fs = new efs.FileSystem(this, 'Fs', {
      vpc,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      enableAutomaticBackups: true,
      replicationOverwriteProtection: efs.ReplicationOverwriteProtection.ENABLED,
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
    });

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

    // Outputs
    new cdk.CfnOutput(this, 'FileSystemId', {
      value: fs.fileSystemId,
      description: 'EFS FileSystem ID',
    });

    new cdk.CfnOutput(this, 'AccessPointId', {
      value: ap.accessPointId,
      description: 'EFS AccessPoint ID',
    });
  }
}
