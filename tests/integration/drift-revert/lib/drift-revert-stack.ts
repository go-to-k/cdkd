import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';

/**
 * Drift-revert E2E test stack.
 *
 * Resources whose providers have first-class readCurrentState +
 * provider.update support, exercised end-to-end:
 *
 *  - S3 Bucket with two user tags. inject-drift.ts adds a third tag.
 *    Drift comparator sees the new tag, provider.update reverts via
 *    PutBucketTagging.
 *  - SNS Topic with DisplayName + DeliveryStatusLogging (Lambda protocol,
 *    SuccessFeedbackSampleRate=50). inject-drift.ts mutates DisplayName
 *    via SetTopicAttributes and bumps the per-protocol
 *    LambdaSuccessFeedbackSampleRate to 100. Drift comparator sees the
 *    changed scalars (PR #192's per-protocol reverse-mapping); provider
 *    .update reverts both via SetTopicAttributes.
 *  - IAM Role with a templated inline policy. inject-drift.ts (a) adds a
 *    PermissionsBoundary that wasn't templated (exercises the always-emit
 *    fix — observedProperties carries `PermissionsBoundary: ''` so the
 *    console-side ADD is detectable), and (b) overwrites the inline
 *    policy body via PutRolePolicy (exercises the GetRolePolicy
 *    round-trip in readCurrentState). Drift comparator sees both;
 *    provider.update reverts inline policies via PutRolePolicy diff and
 *    boundary via DeleteRolePermissionsBoundary.
 *  - KMS Key with EnableKeyRotation: false. inject-drift.ts toggles
 *    rotation ON via EnableKeyRotation (exercises the
 *    GetKeyRotationStatus round-trip; Class 1 discriminator-gated on
 *    KeySpec=SYMMETRIC_DEFAULT). Drift comparator sees the toggle;
 *    provider.update reverts via DisableKeyRotation.
 *  - CloudWatch Logs LogGroup with DeletionProtectionEnabled: true and
 *    RetentionInDays: 7 (PR #194 write-side). inject-drift.ts flips
 *    DeletionProtectionEnabled off via PutLogGroupDeletionProtection;
 *    provider.update reverts via the same API.
 *  - ECS Cluster with ClusterSettings containerInsights=enabled (PR #197).
 *    inject-drift.ts disables containerInsights via UpdateClusterSettings;
 *    provider.update reverts via UpdateClusterCommand with the templated
 *    settings.
 *  - Glue Database with Description (PR #195). inject-drift.ts mutates
 *    the description via UpdateDatabase; provider.update reverts via
 *    UpdateDatabaseCommand using the rebuilt DatabaseInput.
 *  - API Gateway V2 HTTP Api + default Stage with Description on each
 *    (PR #198). inject-drift.ts mutates both descriptions via
 *    UpdateApi / UpdateStage; provider.update reverts via the same APIs.
 *  - A NAMED IAM Role and a NAMED IAM ManagedPolicy (issue #4023). verify.sh
 *    deploys with `CDKD_PREFIX_USER_SUPPLIED_NAMES=true`, so AWS holds
 *    `<stack>-<name>` while the template records `<name>`; step 6e strips
 *    their observed baselines and reverts an out-of-band change, which must
 *    land on the prefixed resources rather than replace them under the bare
 *    template name.
 */
export class DriftRevertStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'DriftBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    cdk.Tags.of(bucket).add('Owner', 'cdkd-integ');
    cdk.Tags.of(bucket).add('Component', 'drift-revert');

    const topic = new sns.Topic(this, 'DriftTopic', {
      displayName: 'integ-display',
    });

    // NOTE: DeliveryStatusLogging is intentionally NOT templated here.
    // PR #192 added per-protocol reverse-mapping in `readCurrentState`
    // (PascalCase prefix walk: `Application` / `Firehose` / `HTTP` /
    // `HTTPS` / `Lambda` / `SQS`), but cdkd's SNSTopicProvider.create()
    // does naive lowercase concatenation (`${protocol}SuccessFeedbackRoleArn`)
    // — CDK templates emit `protocol: 'lambda'` (lowercase per CDK
    // convention), which produces an invalid AWS attribute name like
    // `lambdaSuccessFeedbackRoleArn`. AWS rejects with
    // "Invalid parameter: AttributeName". Real cdkd bug found by this
    // integ — to be addressed in a separate PR (case normalization on
    // both create-side and reverse-mapping). Once that lands, this test
    // can re-add a `cfnTopic.deliveryStatusLogging = [...]` block to
    // exercise PR #192's reverse-mapping end-to-end.

    const role = new iam.Role(this, 'DriftRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'drift-revert E2E test role',
      inlinePolicies: {
        InitialPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['s3:GetObject'],
              resources: ['arn:aws:s3:::cdkd-drift-revert-placeholder/*'],
            }),
          ],
        }),
      },
    });

    // Issue #4023: user-supplied names, so the deploy's
    // `CDKD_PREFIX_USER_SUPPLIED_NAMES=true` prefixes them. Neither is attached to
    // anything, so a leaked copy under the bare name (the pre-fix revert's
    // replacement) is deletable by `cleanup` with one call each.
    new iam.Role(this, 'DriftNamedRole', {
      roleName: 'cdkd-drift-revert-named-role',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'drift-revert named role',
    });
    new iam.ManagedPolicy(this, 'DriftNamedPolicy', {
      managedPolicyName: 'cdkd-drift-revert-named-policy',
      statements: [
        new iam.PolicyStatement({
          actions: ['s3:GetObject'],
          resources: ['arn:aws:s3:::cdkd-drift-revert-placeholder/*'],
        }),
      ],
    });

    const key = new kms.Key(this, 'DriftKey', {
      description: 'drift-revert E2E test key',
      enableKeyRotation: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pendingWindow: cdk.Duration.days(7),
    });

    // CloudWatch Logs LogGroup. The L2 logs.LogGroup does not expose
    // DeletionProtectionEnabled directly; use the L1 CfnLogGroup.
    //
    // Template carries `deletionProtectionEnabled: false` (the AWS-side
    // default). The integ flow drifts it to `true` via direct SDK call,
    // then `cdkd drift --revert` pulls it back to `false`. We
    // intentionally do NOT template `true` because cdkd's destroy()
    // correctly refuses to delete a log group with delete-protection
    // enabled — auto-bypassing user-set protection during destroy is a
    // safety violation (matches CFn's behavior on protected resources).
    const logGroup = new logs.CfnLogGroup(this, 'DriftLogGroup', {
      retentionInDays: 7,
      deletionProtectionEnabled: false,
    });
    logGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // ECS Cluster with containerInsights enabled (no VPC needed — the
    // cluster is a control-plane resource; only Services / Tasks pull a
    // VPC in).
    const cluster = new ecs.CfnCluster(this, 'DriftCluster', {
      clusterSettings: [{ name: 'containerInsights', value: 'enabled' }],
    });
    cluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // Glue Database with a templated description. cdkd's GlueProvider
    // requires DatabaseInput.Name on create (matches AWS Glue API
    // contract: Name is the unique key in the catalog).
    const glueDb = new glue.CfnDatabase(this, 'DriftGlueDatabase', {
      catalogId: cdk.Stack.of(this).account,
      databaseInput: {
        name: 'cdkd_drift_revert_db',
        description: 'integ-original-description',
        // Issue #2102: a `{{resolve:...}}` token EMBEDDED in a longer string,
        // spelled with a service nobody resolves, so cdkd deploys it as
        // written (synth's validation report flags the service, as a warning:
        // CloudFormation itself would refuse it, cdkd warns and keeps it).
        // inject-drift.ts puts a different value at the token's span out of
        // band; the Description drift then makes `--revert` overlay
        // this whole `DatabaseInput`, and verify.sh step 5b asserts the live
        // value at the span survives it.
        parameters: {
          conn: 'jdbc:mysql://db.internal:3306/app?password={{resolve:cdkdlookalike:/cdkd/drift-revert/2102}}',
        },
      },
    });
    glueDb.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // API Gateway V2 HTTP Api + default Stage. ProtocolType is immutable
    // (the integ never mutates it). Description on both is mutable.
    const httpApi = new apigwv2.CfnApi(this, 'DriftHttpApi', {
      name: 'cdkd-drift-revert-api',
      protocolType: 'HTTP',
      description: 'integ-original',
    });
    httpApi.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const httpStage = new apigwv2.CfnStage(this, 'DriftHttpStage', {
      apiId: httpApi.ref,
      stageName: '$default',
      autoDeploy: true,
      description: 'integ-stage-original',
    });
    httpStage.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'Name of the S3 bucket targeted by inject-drift.ts',
    });

    new cdk.CfnOutput(this, 'TopicArn', {
      value: topic.topicArn,
      description: 'ARN of the SNS topic targeted by inject-drift.ts',
    });

    new cdk.CfnOutput(this, 'RoleName', {
      value: role.roleName,
      description: 'Name of the IAM role targeted by inject-drift.ts',
    });

    new cdk.CfnOutput(this, 'KeyId', {
      value: key.keyId,
      description: 'Id of the KMS key targeted by inject-drift.ts',
    });

    new cdk.CfnOutput(this, 'LogGroupName', {
      value: logGroup.ref,
      description: 'Name of the CloudWatch Logs log group targeted by inject-drift.ts',
    });

    new cdk.CfnOutput(this, 'ClusterName', {
      value: cluster.ref,
      description: 'Name of the ECS cluster targeted by inject-drift.ts',
    });

    new cdk.CfnOutput(this, 'GlueDatabaseName', {
      value: glueDb.ref,
      description: 'Name of the Glue database targeted by inject-drift.ts',
    });

    new cdk.CfnOutput(this, 'HttpApiId', {
      value: httpApi.ref,
      description: 'Id of the API Gateway V2 HTTP API targeted by inject-drift.ts',
    });

    new cdk.CfnOutput(this, 'HttpStageName', {
      value: httpStage.ref,
      description: 'Name of the API Gateway V2 stage targeted by inject-drift.ts',
    });
  }
}
