import * as cdk from 'aws-cdk-lib';
import * as datasync from 'aws-cdk-lib/aws-datasync';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

/**
 * DataSync S3 locations whose bucket access role is created in the SAME stack
 * (issue #6573).
 *
 * `AWS::DataSync::LocationS3` has no SDK provider, so it is created through
 * Cloud Control seconds after the role, and DataSync refuses it with "Invalid
 * IAM role ... DataSync service was unable to perform sts:AssumeRole" until
 * IAM has propagated the role. cdkd now retries that wording as IAM
 * propagation. The locations are L1 `CfnLocationS3`, as an app writes them.
 *
 * `CDKD_TEST_UPDATE=verify` sets the task's `Options.VerifyMode`: the task has
 * no schedule, so Cloud Control reads it back as `Schedule: {}`, which
 * `UpdateTask` refuses unless the update drops it (issue #6676).
 *
 * `CDKD_TEST_SUBDIR=1` moves the destination location's `Subdirectory` in
 * place, which rewrites its `LocationUri`; `DstUriReader` reads that URI
 * (go-to-k/cdkd#7007).
 *
 * covers: AWS::DataSync::LocationS3, AWS::DataSync::Task
 */
export class DatasyncLocationRoleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const src = new s3.Bucket(this, 'SrcBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const dst = new s3.Bucket(this, 'DstBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('datasync.amazonaws.com'),
    });
    src.grantRead(role);
    dst.grantReadWrite(role);

    const locSrc = new datasync.CfnLocationS3(this, 'LocSrc', {
      s3BucketArn: src.bucketArn,
      s3Config: { bucketAccessRoleArn: role.roleArn },
    });
    locSrc.node.addDependency(role);
    const locDst = new datasync.CfnLocationS3(this, 'LocDst', {
      s3BucketArn: dst.bucketArn,
      s3Config: { bucketAccessRoleArn: role.roleArn },
      ...(process.env.CDKD_TEST_SUBDIR === '1' ? { subdirectory: '/cdkd-7007/' } : {}),
    });
    new ssm.CfnParameter(this, 'DstUriReader', {
      name: 'cdkd-datasync-location-role-dst-uri',
      type: 'String',
      value: locDst.attrLocationUri,
    });
    locDst.node.addDependency(role);

    const task = new datasync.CfnTask(this, 'Task', {
      sourceLocationArn: locSrc.attrLocationArn,
      destinationLocationArn: locDst.attrLocationArn,
      ...(process.env.CDKD_TEST_UPDATE === 'verify' ? { options: { verifyMode: 'NONE' } } : {}),
    });

    new cdk.CfnOutput(this, 'SrcLocationArn', { value: locSrc.attrLocationArn });
    new cdk.CfnOutput(this, 'DstLocationArn', { value: locDst.attrLocationArn });
    new cdk.CfnOutput(this, 'TaskArn', { value: task.attrTaskArn });
  }
}
