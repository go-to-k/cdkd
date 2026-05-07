#!/usr/bin/env node
/**
 * Mutates the deployed CdkdDriftRevertExample stack via direct AWS SDK
 * calls so that a subsequent `cdkd drift` reports drift, and `cdkd drift
 * --revert -y` clears it.
 *
 *   - S3: PutBucketTagging adds a third tag (preserving the existing two).
 *   - SNS: SetTopicAttributes flips DisplayName from 'integ-display' to
 *     'integ-display-DRIFTED'.
 *
 * Idempotent: re-running after revert re-injects the same drift cleanly.
 *
 * Reads BucketName + TopicArn either from environment vars
 * (BUCKET_NAME / TOPIC_ARN) or, when those are unset, from
 * `cdkd state show CdkdDriftRevertExample --json`. The env-var path is
 * what verify.sh uses.
 */
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  S3Client,
  GetBucketTaggingCommand,
  PutBucketTaggingCommand,
} from '@aws-sdk/client-s3';
import { SNSClient, SetTopicAttributesCommand } from '@aws-sdk/client-sns';

const STACK = 'CdkdDriftRevertExample';
const REGION = process.env.AWS_REGION ?? 'us-east-1';
const INJECTED_TAG_KEY = 'IntegInjected';
const INJECTED_TAG_VALUE = 'yes';
const DRIFTED_DISPLAY_NAME = 'integ-display-DRIFTED';

interface StateShowOutput {
  state?: {
    outputs?: Record<string, string>;
  };
}

function resolveResourceIds(): { bucketName: string; topicArn: string } {
  const envBucket = process.env.BUCKET_NAME;
  const envTopic = process.env.TOPIC_ARN;
  if (envBucket && envTopic) {
    return { bucketName: envBucket, topicArn: envTopic };
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
  if (!bucketName || !topicArn) {
    throw new Error(
      `Could not resolve BucketName / TopicArn from state show JSON: ${JSON.stringify(outputs)}`
    );
  }
  return { bucketName, topicArn };
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

async function main(): Promise<void> {
  const { bucketName, topicArn } = resolveResourceIds();
  await injectS3Drift(bucketName);
  await injectSnsDrift(topicArn);
  console.log('[inject] drift injected — `cdkd drift` should now report exit 1');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
