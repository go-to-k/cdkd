#!/usr/bin/env node
/**
 * Rewrite the bucket policy's recorded principal into its IAM UNIQUE ID form,
 * so the #1515 canonicalization can be exercised DETERMINISTICALLY.
 *
 * AWS renders an IAM role principal inside a resource policy either as the role
 * ARN or as the role's unique id (`AROA…`), substituting the unique id while
 * the principal is transiently unresolvable and re-rendering the ARN once it
 * resolves. cdkd's deploy-time `observedProperties` capture stores whichever
 * form came back — a RACE (the CDK `autoDeleteObjects` role is created
 * concurrently with the policy that references it), which is why two
 * back-to-back runs of this fixture on 2026-08-10 disagreed with no code change
 * in between: the second captured `AROA…`, compared it against the ARN AWS
 * returned, and reported drift `--revert` could not clear.
 *
 * A race cannot be an assertion, so this script MANUFACTURES the recorded form
 * by editing the state baseline in place — exactly the state an unlucky deploy
 * leaves behind. Two modes, and running BOTH is what makes the check
 * non-vacuous:
 *
 *   `real`   — the referenced role's ACTUAL unique id. `cdkd drift` must report
 *              CLEAN: the two spellings are one principal.
 *   `bogus`  — a well-formed unique id belonging to nothing. `cdkd drift` must
 *              still report DRIFT, proving the clean verdict above comes from
 *              canonicalization and not from the field having stopped being
 *              compared at all.
 *
 * Writes `state.json` directly (no lock): the fixture is the only writer, and
 * this is precisely the "an earlier deploy recorded that form" condition.
 *
 * Fails LOUDLY when it cannot find a bucket-policy principal to rewrite — a
 * silent no-op here would make the assertions in verify.sh pass vacuously.
 */
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { IAMClient, GetRoleCommand } from '@aws-sdk/client-iam';

const REGION = process.env['AWS_REGION'] ?? 'us-east-1';
const STACK = process.env['STACK'] ?? 'CdkdDriftRevertExample';
const BUCKET = process.env['STATE_BUCKET'];
const MODE = process.argv[2];

/** A well-formed unique id that belongs to no principal in any account. */
const BOGUS_UNIQUE_ID = 'AROAZZZZZZZZZZZZZZZZZ';

if (MODE !== 'real' && MODE !== 'bogus') {
  throw new Error(`usage: node inject-principal-uniqueid.ts <real|bogus> (got ${MODE ?? 'nothing'})`);
}
if (!BUCKET) {
  throw new Error('STATE_BUCKET must be set');
}

const s3 = new S3Client({ region: REGION });
const iam = new IAMClient({ region: REGION });
const key = `cdkd/${STACK}/${REGION}/state.json`;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every `Principal.AWS` string in the value, with a setter for each. */
function principalSlots(
  value: unknown,
  out: Array<{ get: () => string; set: (next: string) => void }>
): void {
  if (Array.isArray(value)) {
    for (const element of value) principalSlots(element, out);
    return;
  }
  if (!isRecord(value)) return;
  for (const [k, member] of Object.entries(value)) {
    if (k === 'Principal' && isRecord(member)) {
      const aws = member['AWS'];
      if (typeof aws === 'string') {
        out.push({ get: () => aws, set: (next) => (member['AWS'] = next) });
      } else if (Array.isArray(aws)) {
        aws.forEach((entry, i) => {
          if (typeof entry === 'string')
            out.push({ get: () => entry, set: (next) => (aws[i] = next) });
        });
      }
    }
    principalSlots(member, out);
  }
}

const body = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
const state = JSON.parse(await body.Body!.transformToString()) as {
  resources: Record<string, Record<string, unknown>>;
};

let rewritten = 0;
for (const [logicalId, resource] of Object.entries(state.resources ?? {})) {
  if (resource['resourceType'] !== 'AWS::S3::BucketPolicy') continue;
  // The TEMPLATE side keeps the ARN even after a previous mode rewrote the
  // baseline, so it is the reliable source for the role to look up.
  const templateSlots: Array<{ get: () => string; set: (next: string) => void }> = [];
  principalSlots(resource['properties'], templateSlots);
  const roleArn = templateSlots.map((s) => s.get()).find((v) => /^arn:[a-z0-9-]+:iam::\d{12}:role\//.test(v));
  if (!roleArn) continue;

  let replacement = BOGUS_UNIQUE_ID;
  if (MODE === 'real') {
    const roleName = roleArn.split('/').pop()!;
    const role = await iam.send(new GetRoleCommand({ RoleName: roleName }));
    if (!role.Role?.RoleId) throw new Error(`GetRole(${roleName}) returned no RoleId`);
    replacement = role.Role.RoleId;
  }

  const observedSlots: Array<{ get: () => string; set: (next: string) => void }> = [];
  principalSlots(resource['observedProperties'], observedSlots);
  for (const slot of observedSlots) {
    const current = slot.get();
    // Rewrite the role principal only: a Service / `*` principal in the same
    // policy has no unique-id form and must be left alone.
    if (current !== roleArn && !/^AROA[A-Z0-9]+$/.test(current)) continue;
    slot.set(replacement);
    rewritten += 1;
  }
  console.log(`[inject-principal] ${logicalId}: ${roleArn} -> ${replacement} (${MODE})`);
}

if (rewritten === 0) {
  throw new Error(
    'no AWS::S3::BucketPolicy role principal found in the observed baseline — ' +
      'the #1515 assertions below would pass vacuously, so this is a hard failure'
  );
}

await s3.send(
  new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: JSON.stringify(state),
    ContentType: 'application/json',
  })
);
console.log(`[inject-principal] state baseline updated (${rewritten} principal(s), mode=${MODE})`);
