#!/usr/bin/env node
/**
 * Drop `observedProperties` from the bucket's state record, manufacturing the
 * RAW-TEMPLATE revert baseline that issue
 * [#1626](https://github.com/go-to-k/cdkd/issues/1626) is about.
 *
 * Why this has to be manufactured: every resource cdkd deploys today records
 * `observedProperties`, so no fixture can reach the template-only baseline by
 * deploying. It is reached in the field by a resource deployed before
 * observed-capture shipped, or by one whose deploy-time capture failed — and
 * that is exactly the state this leaves behind. Without this step the #1626
 * branch has no real-AWS coverage at all and only its unit tests speak for it.
 *
 * On that baseline cdkd cannot tell an AWS-authored value from an out-of-band
 * change, because neither appears in the template — so `--revert` MERGES every
 * untemplated path into the bag it sends rather than overlaying the drifted
 * subtree wholesale. `Tags` on `AWS::S3::Bucket` is the sharpest available
 * probe of that: `PutBucketTagging` is documented FULL-REPLACE, so the
 * preserved tag can only survive if it reached the provider on the DESIRED
 * side. A fix that merely trimmed `previousProperties` would leave this
 * assertion failing, which is the point of asserting it here.
 *
 * Writes `state.json` directly (no lock): the fixture is the only writer, and
 * this is precisely the "an earlier deploy recorded no observed capture"
 * condition.
 *
 * Fails LOUDLY when the target resource or its `observedProperties` is absent —
 * a silent no-op would make verify.sh's assertion pass vacuously.
 */
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const REGION = process.env['AWS_REGION'] ?? 'us-east-1';
const STACK = process.env['STACK'] ?? 'CdkdDriftRevertExample';
const BUCKET = process.env['STATE_BUCKET'];
/** Logical id prefix of the fixture's S3 bucket (CDK appends a hash suffix). */
const TARGET_PREFIX = 'DriftBucket';

if (!BUCKET) {
  throw new Error('STATE_BUCKET must be set');
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const s3 = new S3Client({ region: REGION });
const key = `cdkd/${STACK}/${REGION}/state.json`;

const got = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
const body = await got.Body?.transformToString();
if (!body) {
  throw new Error(`state.json at s3://${BUCKET}/${key} is empty`);
}
const state: unknown = JSON.parse(body);
if (!isRecord(state) || !isRecord(state['resources'])) {
  throw new Error('state.json has no resources map');
}
const resources = state['resources'];

// The bucket's logical id carries a CDK hash suffix, so match by prefix and
// require EXACTLY one hit — two would make it ambiguous which one was stripped.
const matches = Object.keys(resources).filter(
  (id) => id.startsWith(TARGET_PREFIX) && isRecord(resources[id])
);
const target = matches.filter((id) => {
  const r = resources[id];
  return isRecord(r) && r['resourceType'] === 'AWS::S3::Bucket';
});
if (target.length !== 1) {
  throw new Error(
    `expected exactly one AWS::S3::Bucket logical id starting with '${TARGET_PREFIX}', ` +
      `found ${target.length}: ${target.join(', ') || '(none)'} (candidates: ${matches.join(', ')})`
  );
}
const logicalId = target[0]!;
const record = resources[logicalId];
if (!isRecord(record)) {
  throw new Error(`resource ${logicalId} is not an object`);
}
if (record['observedProperties'] === undefined) {
  throw new Error(
    `resource ${logicalId} already has no observedProperties — the strip would be a no-op, ` +
      `so the #1626 assertion downstream would pass vacuously`
  );
}
if (!isRecord(record['properties']) || record['properties']['Tags'] === undefined) {
  throw new Error(
    `resource ${logicalId} has no template-recorded Tags — the downstream assertion ` +
      `needs a DECLARED tag list so the drift is detected on that key`
  );
}

delete record['observedProperties'];

await s3.send(
  new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: JSON.stringify(state, null, 2),
    ContentType: 'application/json',
  })
);

console.log(`[strip-observed] removed observedProperties from ${logicalId}`);
