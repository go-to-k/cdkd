import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as pipes from 'aws-cdk-lib/aws-pipes';
import * as sqs from 'aws-cdk-lib/aws-sqs';

/**
 * Cloud Control in-place UPDATE of a resource whose write-only key holds a
 * create-only path the read handler cannot return (go-to-k/cdkd#4416). Cloud
 * Control refuses any patch bringing such a value in, unchanged or not, so the
 * write-only re-add (#809) must leave it out:
 *
 * - `AWS::Cognito::ManagedLoginBranding` `ClientId` is write-only AND
 *   create-only; the UPDATE changes only `Settings`.
 * - `AWS::Pipes::Pipe` `SourceParameters` is write-only and, for a Kinesis
 *   source, holds the create-only `KinesisStreamParameters.StartingPosition`;
 *   the UPDATE changes only `Description`.
 * - `AWS::CodePipeline::CustomActionType` `Settings` / `ConfigurationProperties`
 *   are create-only and hold write-only leaves; the UPDATE changes only `Tags`.
 *
 * None of the three has an SDK provider, so all route through Cloud Control.
 */
export class CcWriteOnlyCreateOnlyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const update = process.env.CDKD_TEST_UPDATE === 'true';

    const pool = new cognito.UserPool(this, 'Pool', {
      userPoolName: `${this.stackName}-pool`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    pool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: `cdkd-wo-co-${this.account}` },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    const client = pool.addClient('Client', { userPoolClientName: 'web' });

    new cognito.CfnManagedLoginBranding(this, 'Branding', {
      userPoolId: pool.userPoolId,
      clientId: client.userPoolClientId,
      useCognitoProvidedValues: false,
      settings: { categories: { global: { colorSchemeMode: update ? 'DARK' : 'LIGHT' } } },
    });

    const stream = new kinesis.Stream(this, 'Source', {
      streamName: `${this.stackName}-src`,
      shardCount: 1,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const target = new sqs.Queue(this, 'Target', {
      queueName: `${this.stackName}-tgt`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const role = new iam.Role(this, 'PipeRole', {
      assumedBy: new iam.ServicePrincipal('pipes.amazonaws.com'),
    });
    stream.grantRead(role);
    target.grantSendMessages(role);

    new pipes.CfnPipe(this, 'Pipe', {
      name: `${this.stackName}-pipe`,
      roleArn: role.roleArn,
      source: stream.streamArn,
      target: target.queueArn,
      desiredState: 'STOPPED',
      description: update ? 'v2' : 'v1',
      sourceParameters: { kinesisStreamParameters: { startingPosition: 'LATEST', batchSize: 10 } },
    });

    // A deleted custom action version can never be created again, so each run
    // takes its own (verify.sh exports it once, for both deploys).
    new codepipeline.CfnCustomActionType(this, 'Action', {
      category: 'Test',
      provider: 'CdkdWoCo',
      version: process.env.CDKD_ACTION_VERSION ?? 'synth',
      inputArtifactDetails: { minimumCount: 0, maximumCount: 1 },
      outputArtifactDetails: { minimumCount: 0, maximumCount: 1 },
      settings: {
        thirdPartyConfigurationUrl: 'https://example.com/config',
        entityUrlTemplate: 'https://example.com/entity',
      },
      configurationProperties: [
        { name: 'p', key: true, required: true, secret: false, type: 'String' },
      ],
      tags: [{ key: 'phase', value: update ? 'v2' : 'v1' }],
    });
  }
}
