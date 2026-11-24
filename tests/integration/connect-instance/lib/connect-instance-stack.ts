import * as cdk from 'aws-cdk-lib';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

/**
 * An Amazon Connect instance (SDK provider, go-to-k/cdkd#6912) with the
 * dependents a typical Connect stack hangs off it: an S3 chat-transcript
 * storage config, a contact flow and a Lambda integration association, all
 * referencing the instance by its ARN, plus an output of `ServiceRole`, which
 * exists only once the instance is ACTIVE.
 *
 * covers: AWS::Connect::Instance
 * covers: AWS::Connect::InstanceStorageConfig
 * covers: AWS::Connect::ContactFlow
 * covers: AWS::Connect::IntegrationAssociation
 *
 * The instance alias is part of a global URL (`<alias>.my.connect.aws`), so it
 * carries the account id to stay unique. CDKD_TEST_UPDATE=true turns on
 * contact-flow logs and early media and moves the transcript prefix, all
 * in-place updates.
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
        // Not a CreateInstance member: applied by UpdateInstanceAttribute
        // before the instance is ACTIVE.
        earlyMedia: isUpdate,
      },
      tags: [{ key: 'cdkd-integ', value: isUpdate ? 'updated' : 'base' }],
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

    const startId = '6c0e7b6a-2f3e-4c8e-9a51-0d8b1f6f2a10';
    new connect.CfnContactFlow(this, 'Flow', {
      instanceArn: instance.attrArn,
      name: 'cdkd-integ-disconnect',
      type: 'CONTACT_FLOW',
      content: JSON.stringify({
        Version: '2019-10-30',
        StartAction: startId,
        Metadata: {},
        Actions: [
          { Identifier: startId, Type: 'DisconnectParticipant', Parameters: {}, Transitions: {} },
        ],
      }),
    });

    const fn = new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({ ok: true });'),
    });
    new connect.CfnIntegrationAssociation(this, 'LambdaAssociation', {
      instanceId: instance.attrArn,
      integrationType: 'LAMBDA_FUNCTION',
      integrationArn: fn.functionArn,
    });

    new cdk.CfnOutput(this, 'InstanceId', { value: instance.attrId });
    new cdk.CfnOutput(this, 'ServiceRole', { value: instance.attrServiceRole });
  }
}
