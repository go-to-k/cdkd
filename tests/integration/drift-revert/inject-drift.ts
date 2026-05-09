#!/usr/bin/env node
/**
 * Mutates the deployed CdkdDriftRevertExample stack via direct AWS SDK
 * calls so that a subsequent `cdkd drift` reports drift, and `cdkd drift
 * --revert -y` clears it.
 *
 *   - S3: PutBucketTagging adds a third tag (preserving existing two).
 *   - SNS: SetTopicAttributes flips DisplayName from 'integ-display' to
 *     'integ-display-DRIFTED', and bumps the per-protocol Lambda
 *     SuccessFeedbackSampleRate from '50' to '100' (PR #192 reverse-map).
 *   - IAM: PutRolePermissionsBoundary attaches a boundary that wasn't
 *     templated, and PutRolePolicy overwrites the templated 'InitialPolicy'
 *     inline policy body with a different action.
 *   - KMS: EnableKeyRotation flips rotation from false to true.
 *   - Logs: PutLogGroupDeletionProtection flips DeletionProtectionEnabled
 *     from false to true (PR #194 write-side). Direction is intentional:
 *     templating `true` would deadlock destroy (cdkd correctly refuses to
 *     delete a protected log group, matching CFn behavior on protected
 *     resources). Template `false` + drift to `true` + revert back to
 *     `false` lets destroy clean up.
 *   - ECS: UpdateClusterSettings flips containerInsights from 'enabled'
 *     to 'disabled' (PR #197).
 *   - Glue: UpdateDatabase rewrites the database Description (PR #195).
 *   - ApiGwV2: UpdateApi + UpdateStage rewrite each Description (PR #198).
 *
 * Idempotent: re-running after revert re-injects the same drift cleanly.
 *
 * Reads resource ids either from environment vars (BUCKET_NAME / TOPIC_ARN
 * / ROLE_NAME / KEY_ID / LOG_GROUP_NAME / CLUSTER_NAME / GLUE_DATABASE_NAME
 * / HTTP_API_ID / HTTP_STAGE_NAME) or, when those are unset, from `cdkd
 * state show CdkdDriftRevertExample --json`. The env-var path is what
 * verify.sh uses.
 */
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  S3Client,
  GetBucketTaggingCommand,
  PutBucketTaggingCommand,
} from '@aws-sdk/client-s3';
import { SNSClient, SetTopicAttributesCommand } from '@aws-sdk/client-sns';
import {
  IAMClient,
  PutRolePermissionsBoundaryCommand,
  PutRolePolicyCommand,
} from '@aws-sdk/client-iam';
import { KMSClient, EnableKeyRotationCommand } from '@aws-sdk/client-kms';
import {
  CloudWatchLogsClient,
  PutLogGroupDeletionProtectionCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { ECSClient, UpdateClusterSettingsCommand } from '@aws-sdk/client-ecs';
import { GlueClient, UpdateDatabaseCommand } from '@aws-sdk/client-glue';
import {
  ApiGatewayV2Client,
  UpdateApiCommand,
  UpdateStageCommand,
} from '@aws-sdk/client-apigatewayv2';

const STACK = 'CdkdDriftRevertExample';
const REGION = process.env.AWS_REGION ?? 'us-east-1';
const INJECTED_TAG_KEY = 'IntegInjected';
const INJECTED_TAG_VALUE = 'yes';
const DRIFTED_DISPLAY_NAME = 'integ-display-DRIFTED';
// Stable AWS-managed policy used as a permissions boundary. ReadOnly is
// safe for any role; we only need the ARN for boundary attachment.
const INJECTED_PERMISSIONS_BOUNDARY = 'arn:aws:iam::aws:policy/IAMReadOnlyAccess';
const INJECTED_INLINE_POLICY_NAME = 'InitialPolicy';
const INJECTED_INLINE_POLICY_BODY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      // Drifted action — the templated policy allows s3:GetObject; this
      // expands to s3:* so drift detects the change.
      Action: 's3:*',
      Resource: 'arn:aws:s3:::cdkd-drift-revert-placeholder/*',
    },
  ],
});
const DRIFTED_GLUE_DESCRIPTION = 'integ-DRIFTED';
const DRIFTED_API_DESCRIPTION = 'integ-Api-DRIFTED';
const DRIFTED_STAGE_DESCRIPTION = 'integ-Stage-DRIFTED';

interface StateShowOutput {
  state?: {
    outputs?: Record<string, string>;
  };
}

interface ResolvedIds {
  bucketName: string;
  topicArn: string;
  roleName: string;
  keyId: string;
  logGroupName: string;
  clusterName: string;
  glueDatabaseName: string;
  httpApiId: string;
  httpStageName: string;
}

function resolveResourceIds(): ResolvedIds {
  const envBucket = process.env.BUCKET_NAME;
  const envTopic = process.env.TOPIC_ARN;
  const envRole = process.env.ROLE_NAME;
  const envKey = process.env.KEY_ID;
  const envLogGroup = process.env.LOG_GROUP_NAME;
  const envCluster = process.env.CLUSTER_NAME;
  const envGlueDb = process.env.GLUE_DATABASE_NAME;
  const envHttpApi = process.env.HTTP_API_ID;
  const envHttpStage = process.env.HTTP_STAGE_NAME;
  if (
    envBucket &&
    envTopic &&
    envRole &&
    envKey &&
    envLogGroup &&
    envCluster &&
    envGlueDb &&
    envHttpApi &&
    envHttpStage
  ) {
    return {
      bucketName: envBucket,
      topicArn: envTopic,
      roleName: envRole,
      keyId: envKey,
      logGroupName: envLogGroup,
      clusterName: envCluster,
      glueDatabaseName: envGlueDb,
      httpApiId: envHttpApi,
      httpStageName: envHttpStage,
    };
  }

  const repoRoot = execSync('git rev-parse --show-toplevel').toString().trim();
  const cli = resolve(repoRoot, 'dist', 'cli.js');
  const stateBucket = process.env.STATE_BUCKET;
  const args = ['state', 'show', STACK, '--json'];
  if (stateBucket) args.push('--state-bucket', stateBucket);

  const stdout = execSync(`node ${JSON.stringify(cli)} ${args.join(' ')}`, {
    stdio: ['ignore', 'pipe', 'inherit'],
  }).toString();

  const parsed = JSON.parse(stdout) as StateShowOutput;
  const outputs = parsed.state?.outputs ?? {};
  const bucketName = outputs['BucketName'];
  const topicArn = outputs['TopicArn'];
  const roleName = outputs['RoleName'];
  const keyId = outputs['KeyId'];
  const logGroupName = outputs['LogGroupName'];
  const clusterName = outputs['ClusterName'];
  const glueDatabaseName = outputs['GlueDatabaseName'];
  const httpApiId = outputs['HttpApiId'];
  const httpStageName = outputs['HttpStageName'];
  if (
    !bucketName ||
    !topicArn ||
    !roleName ||
    !keyId ||
    !logGroupName ||
    !clusterName ||
    !glueDatabaseName ||
    !httpApiId ||
    !httpStageName
  ) {
    throw new Error(
      `Could not resolve all resource ids from state show JSON: ${JSON.stringify(outputs)}`
    );
  }
  return {
    bucketName,
    topicArn,
    roleName,
    keyId,
    logGroupName,
    clusterName,
    glueDatabaseName,
    httpApiId,
    httpStageName,
  };
}

async function injectS3Drift(bucketName: string): Promise<void> {
  const s3 = new S3Client({ region: REGION });

  // Read existing tags so we preserve them.
  let existing: { Key?: string; Value?: string }[] = [];
  try {
    const got = await s3.send(new GetBucketTaggingCommand({ Bucket: bucketName }));
    existing = got.TagSet ?? [];
  } catch (err) {
    // NoSuchTagSet means no tags yet — start from an empty array.
    const e = err as { name?: string; Code?: string };
    if (e?.name !== 'NoSuchTagSet' && e?.Code !== 'NoSuchTagSet') {
      throw err;
    }
  }

  const filtered = existing.filter((t) => t.Key !== INJECTED_TAG_KEY);
  filtered.push({ Key: INJECTED_TAG_KEY, Value: INJECTED_TAG_VALUE });

  await s3.send(
    new PutBucketTaggingCommand({
      Bucket: bucketName,
      Tagging: { TagSet: filtered as { Key: string; Value: string }[] },
    })
  );
  console.log(
    `[inject] s3: added tag ${INJECTED_TAG_KEY}=${INJECTED_TAG_VALUE} to bucket ${bucketName} (preserved ${existing.length} pre-existing tag(s))`
  );
}

async function injectSnsDrift(topicArn: string): Promise<void> {
  const sns = new SNSClient({ region: REGION });
  await sns.send(
    new SetTopicAttributesCommand({
      TopicArn: topicArn,
      AttributeName: 'DisplayName',
      AttributeValue: DRIFTED_DISPLAY_NAME,
    })
  );
  console.log(`[inject] sns: set DisplayName=${DRIFTED_DISPLAY_NAME} on topic ${topicArn}`);

  // NOTE: PR #192's per-protocol DeliveryStatusLogging round-trip
  // verification is deferred until cdkd's SNS create-side casing bug
  // is fixed (it does naive `${protocol}SuccessFeedbackRoleArn` so a
  // CDK-templated `protocol: 'lambda'` fails AWS validation). Once the
  // create-side normalizes lowercase → PascalCase prefix, this function
  // can re-add the `LambdaSuccessFeedbackSampleRate` mutation.
}

async function injectIamDrift(roleName: string): Promise<void> {
  const iam = new IAMClient({ region: REGION });

  // PermissionsBoundary — exercises the always-emit fix in
  // IAMRoleProvider.readCurrentState. The role was deployed without a
  // boundary; observedProperties carries `PermissionsBoundary: ''` so
  // the comparator descends into the key and surfaces this ADD as drift.
  await iam.send(
    new PutRolePermissionsBoundaryCommand({
      RoleName: roleName,
      PermissionsBoundary: INJECTED_PERMISSIONS_BOUNDARY,
    })
  );
  console.log(
    `[inject] iam: attached PermissionsBoundary=${INJECTED_PERMISSIONS_BOUNDARY} to role ${roleName}`
  );

  // Inline policy body mutation — exercises the GetRolePolicy round-trip
  // in IAMRoleProvider.readCurrentState. The drift comparator sees the
  // changed Action and surfaces it as a Policies-array drift.
  await iam.send(
    new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: INJECTED_INLINE_POLICY_NAME,
      PolicyDocument: INJECTED_INLINE_POLICY_BODY,
    })
  );
  console.log(
    `[inject] iam: rewrote inline policy ${INJECTED_INLINE_POLICY_NAME} on role ${roleName} (Action: s3:GetObject -> s3:*)`
  );
}

async function injectKmsDrift(keyId: string): Promise<void> {
  const kms = new KMSClient({ region: REGION });
  // EnableKeyRotation toggle — exercises the GetKeyRotationStatus
  // round-trip in KMSProvider.readCurrentState. The key was deployed
  // with rotation disabled; toggling ON makes the comparator see
  // `EnableKeyRotation: false -> true`.
  await kms.send(new EnableKeyRotationCommand({ KeyId: keyId }));
  console.log(`[inject] kms: enabled key rotation on key ${keyId}`);
}

async function injectLogsDrift(logGroupName: string): Promise<void> {
  const logs = new CloudWatchLogsClient({ region: REGION });
  // PR #194: write-side coverage. Templated DeletionProtectionEnabled=false
  // (the AWS-side default); flip it ON so the comparator surfaces the
  // drift, and provider.update reverts via the same
  // PutLogGroupDeletionProtection API. Templating `true` would deadlock
  // destroy: cdkd correctly refuses to delete a protected log group
  // (matches CFn behavior on protected resources — auto-bypassing user-
  // set protection during destroy is a safety violation).
  await logs.send(
    new PutLogGroupDeletionProtectionCommand({
      logGroupIdentifier: logGroupName,
      deletionProtectionEnabled: true,
    })
  );
  console.log(
    `[inject] logs: enabled DeletionProtectionEnabled on log group ${logGroupName}`
  );
}

async function injectEcsDrift(clusterName: string): Promise<void> {
  const ecs = new ECSClient({ region: REGION });
  // PR #197: ClusterSettings round-trip. Templated
  // containerInsights=enabled; flip to disabled so the comparator
  // surfaces the drift, and provider.update reverts via UpdateCluster
  // with the templated settings.
  await ecs.send(
    new UpdateClusterSettingsCommand({
      cluster: clusterName,
      settings: [{ name: 'containerInsights', value: 'disabled' }],
    })
  );
  console.log(
    `[inject] ecs: set containerInsights=disabled on cluster ${clusterName}`
  );
}

async function injectGlueDrift(glueDatabaseName: string): Promise<void> {
  const glue = new GlueClient({ region: REGION });
  // PR #195: Glue Database update. Templated Description='integ-original-description';
  // rewrite to 'integ-DRIFTED' so the comparator surfaces the drift, and
  // provider.update reverts via UpdateDatabase with the rebuilt input.
  // CatalogId omitted -> AWS uses the caller's account id (matches the
  // stack's templated `cdk.Stack.of(this).account`).
  await glue.send(
    new UpdateDatabaseCommand({
      Name: glueDatabaseName,
      DatabaseInput: {
        Name: glueDatabaseName,
        Description: DRIFTED_GLUE_DESCRIPTION,
      },
    })
  );
  console.log(
    `[inject] glue: set Description=${DRIFTED_GLUE_DESCRIPTION} on database ${glueDatabaseName}`
  );
}

async function injectApiGwV2Drift(httpApiId: string, httpStageName: string): Promise<void> {
  const apigw = new ApiGatewayV2Client({ region: REGION });
  // PR #198: ApiGwV2 Api + Stage updates. Both Descriptions are mutable
  // via UpdateApi / UpdateStage; templated values are
  // 'integ-original' / 'integ-stage-original' respectively.
  await apigw.send(
    new UpdateApiCommand({
      ApiId: httpApiId,
      Description: DRIFTED_API_DESCRIPTION,
    })
  );
  console.log(
    `[inject] apigwv2: set Api Description=${DRIFTED_API_DESCRIPTION} on api ${httpApiId}`
  );

  await apigw.send(
    new UpdateStageCommand({
      ApiId: httpApiId,
      StageName: httpStageName,
      Description: DRIFTED_STAGE_DESCRIPTION,
    })
  );
  console.log(
    `[inject] apigwv2: set Stage Description=${DRIFTED_STAGE_DESCRIPTION} on stage ${httpApiId}/${httpStageName}`
  );
}

async function main(): Promise<void> {
  const ids = resolveResourceIds();
  await injectS3Drift(ids.bucketName);
  await injectSnsDrift(ids.topicArn);
  await injectIamDrift(ids.roleName);
  await injectKmsDrift(ids.keyId);
  await injectLogsDrift(ids.logGroupName);
  await injectEcsDrift(ids.clusterName);
  await injectGlueDrift(ids.glueDatabaseName);
  await injectApiGwV2Drift(ids.httpApiId, ids.httpStageName);
  console.log('[inject] drift injected — `cdkd drift` should now report exit 1');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
