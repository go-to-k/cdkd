import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as athena from 'aws-cdk-lib/aws-athena';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Failure-seeking integ for STACK-LEVEL tag propagation across MANY
 * taggable resource types, on BOTH the cdkd SDK-provider path AND the
 * Cloud Control API path.
 *
 * `cdk.Tags.of(stack).add(k, v)` injects the same N tags into the CFn
 * `Tags` property of every taggable resource in the stack. cdkd must
 * forward those tags to AWS correctly for EVERY type — but each AWS
 * resource type accepts tags in a DIFFERENT wire shape:
 *
 *   - {Key,Value}[] list  : S3, SNS, IAM Role, DynamoDB, Athena WorkGroup
 *   - { k: v } map        : SSM Parameter (CFn `Json`!), CloudWatch Logs,
 *                           Lambda, SQS
 *
 * Per memory `feedback_ssm_parameter_tags_is_a_map`, `AWS::SSM::Parameter`
 * `Tags` is a key->value MAP in CFn (not the list almost every other type
 * uses); a provider doing `properties.Tags.map()` crashed deploy. This
 * fixture deliberately tags an SSM Parameter so that regression is caught
 * end-to-end against real AWS.
 *
 * Path split:
 *   - SDK-provider path (registered in register-providers.ts): S3 Bucket,
 *     SNS Topic, SQS Queue, SSM Parameter, IAM Role, Logs LogGroup,
 *     Lambda Function, DynamoDB Table.
 *   - Cloud Control API path: Athena WorkGroup has NO SDK provider, so
 *     cdkd routes it through Cloud Control, which forwards the full CFn
 *     `Tags` property. This proves the stack-level tags also land on a
 *     CC-API-provisioned resource (verified via `provisionedBy: 'cc-api'`
 *     in state + `athena list-tags-for-resource`).
 *
 * No VPC / NAT / instances — every resource here is control-plane-only
 * and cheap, so the fixture stays fast and quota-free.
 *
 * The stack-level tags themselves are added in bin/app.ts via
 * `cdk.Tags.of(app).add(...)` so they propagate to ALL stacks/resources.
 */
export class TagsPropagationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- SDK-provider-path taggable resources ---

    // S3 Bucket — Tags wire shape: {Key,Value}[] (get-bucket-tagging).
    // No `autoDeleteObjects` on purpose: it would add a Custom Resource +
    // a provider Lambda + extra IAM roles, making the per-type "first
    // resource of this type" physical-id extraction in verify.sh
    // ambiguous (two Lambdas / multiple Roles). The bucket stays empty, so
    // a plain DESTROY removes it cleanly.
    new s3.Bucket(this, 'TaggedBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // SNS Topic — Tags wire shape: {Key,Value}[] (list-tags-for-resource).
    new sns.Topic(this, 'TaggedTopic', {
      displayName: 'cdkd tags-propagation topic',
    });

    // SQS Queue — Tags wire shape: { k: v } map (list-queue-tags).
    new sqs.Queue(this, 'TaggedQueue', {
      retentionPeriod: cdk.Duration.days(4),
    });

    // SSM Parameter — Tags wire shape: { k: v } MAP in CFn (the known
    // crash-prone type; see memory feedback_ssm_parameter_tags_is_a_map).
    new ssm.StringParameter(this, 'TaggedParameter', {
      stringValue: 'cdkd-tags-propagation',
    });

    // IAM Role — Tags wire shape: {Key,Value}[] (list-role-tags). This is
    // the SOLE IAM role in the stack (it also backs the Lambda below) so
    // the "first AWS::IAM::Role in state" extraction in verify.sh is
    // unambiguous — a Lambda with no explicit role would make CDK
    // synthesize a second, auto-named execution role.
    const role = new iam.Role(this, 'TaggedRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole'
        ),
      ],
    });

    // CloudWatch Logs LogGroup — Tags wire shape: { k: v } map
    // (logs list-tags-for-resource --resource-arn).
    new logs.LogGroup(this, 'TaggedLogGroup', {
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Lambda Function — Tags wire shape: { k: v } map (lambda list-tags).
    // Reuses `role` above so no second auto-named execution role is
    // synthesized (keeps the IAM-role extraction in verify.sh unambiguous).
    new lambda.Function(this, 'TaggedFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      timeout: cdk.Duration.seconds(15),
      role,
    });

    // DynamoDB Table — Tags wire shape: {Key,Value}[]
    // (dynamodb list-tags-of-resource).
    new dynamodb.Table(this, 'TaggedTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- Cloud Control API-path taggable resource ---

    // Athena WorkGroup — NO cdkd SDK provider, so cdkd routes this via
    // Cloud Control API. Tags wire shape: {Key,Value}[]
    // (athena list-tags-for-resource --resource-arn). RecursiveDeleteOption
    // lets destroy clean it even with named query history.
    const workGroup = new athena.CfnWorkGroup(this, 'TaggedWorkGroup', {
      name: `${this.stackName}-wg`,
      recursiveDeleteOption: true,
      state: 'ENABLED',
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: false,
      },
    });

    // Expose the workgroup name so verify.sh can build its ARN.
    new cdk.CfnOutput(this, 'WorkGroupName', {
      value: workGroup.name,
      description: 'Athena WorkGroup name (CC-API-routed taggable resource)',
    });
  }
}
