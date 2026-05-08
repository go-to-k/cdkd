#!/usr/bin/env node
/**
 * Mutates the deployed CdkdDriftRevertExample stack via direct AWS SDK
 * calls so that a subsequent `cdkd drift` reports drift, and `cdkd drift
 * --revert -y` clears it.
 *
 *   - S3: PutBucketTagging adds a third tag (preserving existing two).
 *   - SNS: SetTopicAttributes flips DisplayName from 'integ-display' to
 *     'integ-display-DRIFTED'.
 *   - IAM: PutRolePermissionsBoundary attaches a boundary that wasn't
 *     templated, and PutRolePolicy overwrites the templated 'InitialPolicy'
 *     inline policy body with a different action.
 *   - KMS: EnableKeyRotation flips rotation from false to true.
 *
 * Idempotent: re-running after revert re-injects the same drift cleanly.
 *
 * Reads BucketName / TopicArn / RoleName / KeyId either from environment
 * vars (BUCKET_NAME / TOPIC_ARN / ROLE_NAME / KEY_ID) or, when those are
 * unset, from `cdkd state show CdkdDriftRevertExample --json`. The env-var
 * path is what verify.sh uses.
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

interface StateShowOutput {
  state?: {
    outputs?: Record<string, string>;
  };
}

function resolveResourceIds(): {
  bucketName: string;
  topicArn: string;
  roleName: string;
  keyId: string;
} {
  const envBucket = process.env.BUCKET_NAME;
  const envTopic = process.env.TOPIC_ARN;
  const envRole = process.env.ROLE_NAME;
  const envKey = process.env.KEY_ID;
  if (envBucket && envTopic && envRole && envKey) {
    return { bucketName: envBucket, topicArn: envTopic, roleName: envRole, keyId: envKey };
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
  if (!bucketName || !topicArn || !roleName || !keyId) {
    throw new Error(
      `Could not resolve all resource ids from state show JSON: ${JSON.stringify(outputs)}`
    );
  }
  return { bucketName, topicArn, roleName, keyId };
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

async function main(): Promise<void> {
  const { bucketName, topicArn, roleName, keyId } = resolveResourceIds();
  await injectS3Drift(bucketName);
  await injectSnsDrift(topicArn);
  await injectIamDrift(roleName);
  await injectKmsDrift(keyId);
  console.log('[inject] drift injected — `cdkd drift` should now report exit 1');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
