import * as cdk from 'aws-cdk-lib';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

/**
 * An Amazon Connect instance with an S3 chat-transcript storage config, both
 * routed through Cloud Control.
 *
 * covers: AWS::Connect::Instance
 * covers: AWS::Connect::InstanceStorageConfig
 *
 * The instance alias is part of a global URL (`<alias>.my.connect.aws`), so it
 * carries the account id to stay unique. CDKD_TEST_UPDATE=true turns on
 * contact-flow logs and moves the transcript prefix, both in-place updates.
 */
export class ConnectInstanceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    // No autoDeleteObjects: nothing writes transcripts during the run, and the
    // custom resource it adds would blur the Connect timings this fixture reports.
    const bucket = new s3.Bucket(this, 'TranscriptBucket', {
      bucketName: `cdkd-connect-integ-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const instance = new connect.CfnInstance(this, 'Instance', {
      identityManagementType: 'CONNECT_MANAGED',
      instanceAlias: `cdkd-connect-${this.account}`,
      attributes: {
        inboundCalls: true,
        outboundCalls: true,
        contactflowLogs: isUpdate,
      },
    });

    new connect.CfnInstanceStorageConfig(this, 'ChatTranscripts', {
      instanceArn: instance.attrArn,
      resourceType: 'CHAT_TRANSCRIPTS',
      storageType: 'S3',
      s3Config: {
        bucketName: bucket.bucketName,
        bucketPrefix: isUpdate ? 'chat-v2' : 'chat',
      },
    });

    new cdk.CfnOutput(this, 'InstanceId', { value: instance.attrId });
  }
}
