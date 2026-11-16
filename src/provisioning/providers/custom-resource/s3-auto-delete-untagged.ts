import { GetBucketTaggingCommand } from '@aws-sdk/client-s3';
import { getAwsClients } from '../../../utils/aws-clients.js';

/** The custom resource type CDK's `s3.Bucket({ autoDeleteObjects: true })` emits. */
export const S3_AUTO_DELETE_OBJECTS_RESOURCE_TYPE = 'Custom::S3AutoDeleteObjects';

/**
 * Whether a FAILED Delete from CDK's `Custom::S3AutoDeleteObjects` handler is
 * the handler's own no-op, proven by S3 rather than read off the handler's
 * `Reason` (go-to-k/cdkd#6422).
 *
 * The handler empties the bucket only when it carries the
 * `aws-cdk:auto-delete-objects` tag, read via `GetBucketTagging`, and lets
 * every error but `NoSuchBucket` escape. A bucket with NO tags at all answers
 * `NoSuchTagSet`, so turning `autoDeleteObjects` off — which removes the tag
 * and the custom resource in one deploy — fails the Delete on cdkd. Under
 * CloudFormation the bucket always keeps its `aws:cloudformation:*` tags, the
 * read succeeds, and the handler skips. cdkd cannot write `aws:` tags.
 *
 * A bucket with no tag set cannot carry the auto-delete tag, so the handler
 * had nothing to empty, and emptying is all it manages. That is why the answer
 * comes from cdkd's OWN read: the #2054 FAILED arm deliberately classifies no
 * handler `Reason` (free text a user's handler writes). Only `NoSuchTagSet`
 * answers true; a tagged bucket, any other error (a missing permission, a
 * bucket in another region, `NoSuchBucket`) or a non-string `BucketName`
 * answers false and the FAILED arm keeps its skip.
 */
export async function isUntaggedAutoDeleteBucket(
  resourceType: string,
  properties: Record<string, unknown>
): Promise<boolean> {
  if (resourceType !== S3_AUTO_DELETE_OBJECTS_RESOURCE_TYPE) return false;
  const bucketName = properties['BucketName'];
  if (typeof bucketName !== 'string' || bucketName === '') return false;
  try {
    await getAwsClients().s3.send(new GetBucketTaggingCommand({ Bucket: bucketName }));
    return false;
  } catch (error) {
    return (error as { name?: unknown } | null)?.name === 'NoSuchTagSet';
  }
}
