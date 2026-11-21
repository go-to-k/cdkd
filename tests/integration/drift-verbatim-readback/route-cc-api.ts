#!/usr/bin/env node
/**
 * Mark the named logical ids `provisionedBy: 'cc-api'` in the stack's state
 * record, so `cdkd drift` reads and reverts them through Cloud Control, as
 * for a principal deployed with `--recreate-via-cc-api` (the routing sticks
 * to the record). go-to-k/cdkd#6627: a Cloud Control read is not filtered by
 * sibling ownership, so this drives the revert-bag path the SDK readers never
 * reach.
 *
 * Fails LOUDLY when a named id is missing or not an IAM principal: a silent
 * no-op would leave the phase that follows on the SDK route.
 *
 * Usage: route-cc-api.ts <logicalId>...
 * Writes `state.json` directly (no lock): the fixture is the only writer.
 */
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const REGION = process.env['AWS_REGION'] ?? 'us-east-1';
const STACK = process.env['STACK'] ?? 'CdkdDriftVerbatimReadbackExample';
const BUCKET = process.env['STATE_BUCKET'];
if (!BUCKET) throw new Error('STATE_BUCKET must be set');
const ids = process.argv.slice(2);
if (ids.length === 0) throw new Error('name at least one logical id');

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
const resources = state['resources'];
for (const id of ids) {
  const rec = resources[id];
  if (!isRecord(rec)) throw new Error(`no state record for ${id}`);
  if (!/^AWS::IAM::(Role|User|Group)$/.test(String(rec['resourceType']))) {
    throw new Error(`${id} is ${String(rec['resourceType'])}, not an IAM principal`);
  }
  rec['provisionedBy'] = 'cc-api';
}

await s3.send(
  new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: JSON.stringify(state, null, 2),
    ContentType: 'application/json',
  })
);
console.log(`[route-cc-api] ${ids.join(', ')} now read and reverted through Cloud Control`);
