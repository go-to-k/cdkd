#!/usr/bin/env node
/**
 * Drop `observedProperties` from EVERY resource of the stack's state record,
 * manufacturing the template-only drift baseline (a deploy with
 * `--no-capture-observed-state`, or a failed post-deploy capture) that
 * go-to-k/cdkd#6624 / #6627 are about. Same approach as
 * `tests/integration/drift-revert/strip-observed.ts`, widened to every record.
 *
 * Fails LOUDLY when no resource had a baseline to strip: a silent no-op would
 * leave the drift run that follows comparing the observed baseline instead.
 *
 * Writes `state.json` directly (no lock): the fixture is the only writer.
 */
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const REGION = process.env['AWS_REGION'] ?? 'us-east-1';
const STACK = process.env['STACK'] ?? 'CdkdDriftVerbatimReadbackExample';
const BUCKET = process.env['STATE_BUCKET'];
if (!BUCKET) throw new Error('STATE_BUCKET must be set');

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const s3 = new S3Client({ region: REGION });
const key = `cdkd/${STACK}/${REGION}/state.json`;
const got = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
const body = await got.Body?.transformToString();
if (!body) throw new Error(`state.json at s3://${BUCKET}/${key} is empty`);
const state: unknown = JSON.parse(body);
if (!isRecord(state) || !isRecord(state['resources'])) {
  throw new Error('state.json has no resources map');
}

const stripped: string[] = [];
for (const [logicalId, rec] of Object.entries(state['resources'])) {
  if (isRecord(rec) && rec['observedProperties'] !== undefined) {
    delete rec['observedProperties'];
    stripped.push(logicalId);
  }
}
if (stripped.length === 0) {
  throw new Error('no resource had observedProperties: the strip would be a no-op');
}

await s3.send(
  new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: JSON.stringify(state, null, 2),
    ContentType: 'application/json',
  })
);
console.log(`[strip-all-observed] removed observedProperties from ${stripped.length} resources`);
