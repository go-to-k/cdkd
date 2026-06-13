#!/usr/bin/env node
/**
 * Drift injector for the CdkdDriftArraysExample stack (issue #802
 * canonicalization integ). Two modes, selected by argv[2]:
 *
 *   reorder  — BENIGN AWS-side reorder of an existing tag set, NO value
 *              change. Re-PUTs the S3 bucket's existing six tags in a
 *              REVERSED order via PutBucketTagging. The tag SET is
 *              identical; only the on-the-wire order differs. A correct
 *              `cdkd drift` (with #802 `canonicalizeTagListsDeep`) must
 *              report NO drift after this — it proves a pure reorder is
 *              not a false positive. (Used by verify.sh step 3b.)
 *
 *   drift    — REAL out-of-band drift the comparator MUST detect:
 *              - S3:  PutBucketTagging changes the VALUE of one existing
 *                     tag (Owner=cdkd-integ -> Owner=DRIFTED), keeping the
 *                     rest. A value change is real drift, distinct from a
 *                     reorder.
 *              - IAM: CreatePolicyVersion + SetDefaultPolicyVersion rewrite
 *                     the managed policy's first statement Action list
 *                     (adds s3:DeleteObject) — a real change to an Action
 *                     array (which the canonicalizer intentionally does
 *                     NOT sort, being order-significant-by-design), so it
 *                     must surface.
 *              - EC2: AuthorizeSecurityGroupIngress adds a NEW ingress
 *                     rule (tcp/9000 from 10.0.9.0/24) that was not
 *                     templated — a real added array member.
 *              (Used by verify.sh step 4.)
 *
 * Idempotent within each mode: re-running `drift` after a revert
 * re-injects the same drift cleanly (CreatePolicyVersion prunes the
 * oldest non-default version when the 5-version limit is hit;
 * AuthorizeSecurityGroupIngress tolerates the already-exists duplicate).
 *
 * Resolves resource ids from env vars (BUCKET_NAME / MANAGED_POLICY_ARN /
 * SECURITY_GROUP_ID) when present, else from `cdkd state show
 * CdkdDriftArraysExample --json` outputs.
 */
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  S3Client,
  GetBucketTaggingCommand,
  PutBucketTaggingCommand,
} from '@aws-sdk/client-s3';
import {
  IAMClient,
  GetPolicyCommand,
  GetPolicyVersionCommand,
  CreatePolicyVersionCommand,
  ListPolicyVersionsCommand,
  DeletePolicyVersionCommand,
} from '@aws-sdk/client-iam';
import {
  EC2Client,
  AuthorizeSecurityGroupIngressCommand,
} from '@aws-sdk/client-ec2';

const STACK = 'CdkdDriftArraysExample';
const REGION = process.env.AWS_REGION ?? 'us-east-1';

const DRIFTED_TAG_KEY = 'Owner';
const DRIFTED_TAG_VALUE = 'DRIFTED';
const ADDED_INGRESS_CIDR = '10.0.9.0/24';
const ADDED_INGRESS_PORT = 9000;
const ADDED_INGRESS_DESC = 'integ-DRIFTED-rule';

interface StateShowOutput {
  state?: {
    outputs?: Record<string, string>;
  };
}

interface ResolvedIds {
  bucketName: string;
  managedPolicyArn: string;
  securityGroupId: string;
}

function resolveResourceIds(): ResolvedIds {
  const envBucket = process.env.BUCKET_NAME;
  const envPolicy = process.env.MANAGED_POLICY_ARN;
  const envSg = process.env.SECURITY_GROUP_ID;
  if (envBucket && envPolicy && envSg) {
    return { bucketName: envBucket, managedPolicyArn: envPolicy, securityGroupId: envSg };
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
  const managedPolicyArn = outputs['ManagedPolicyArn'];
  const securityGroupId = outputs['SecurityGroupId'];
  if (!bucketName || !managedPolicyArn || !securityGroupId) {
    throw new Error(
      `Could not resolve all resource ids from state show JSON: ${JSON.stringify(outputs)}`
    );
  }
  return { bucketName, managedPolicyArn, securityGroupId };
}

async function readBucketTags(
  s3: S3Client,
  bucketName: string
): Promise<{ Key: string; Value: string }[]> {
  try {
    const got = await s3.send(new GetBucketTaggingCommand({ Bucket: bucketName }));
    return (got.TagSet ?? []).filter(
      (t): t is { Key: string; Value: string } => !!t.Key && t.Value !== undefined
    );
  } catch (err) {
    const e = err as { name?: string; Code?: string };
    if (e?.name === 'NoSuchTagSet' || e?.Code === 'NoSuchTagSet') return [];
    throw err;
  }
}

async function injectBenignReorder(bucketName: string): Promise<void> {
  const s3 = new S3Client({ region: REGION });
  const existing = await readBucketTags(s3, bucketName);
  if (existing.length < 2) {
    throw new Error(
      `Expected the bucket to carry >=2 tags for the reorder test, found ${existing.length}`
    );
  }
  // Reverse the on-the-wire order. Same SET, different ORDER — a correct
  // canonicalizer must absorb this so `cdkd drift` stays clean.
  const reordered = [...existing].reverse();
  await s3.send(
    new PutBucketTaggingCommand({
      Bucket: bucketName,
      Tagging: { TagSet: reordered },
    })
  );
  console.log(
    `[inject:reorder] s3: re-PUT ${reordered.length} EXISTING tags in reversed order on bucket ${bucketName} (no value change)`
  );
}

async function injectS3ValueDrift(bucketName: string): Promise<void> {
  const s3 = new S3Client({ region: REGION });
  const existing = await readBucketTags(s3, bucketName);
  const next = existing.filter((t) => t.Key !== DRIFTED_TAG_KEY);
  next.push({ Key: DRIFTED_TAG_KEY, Value: DRIFTED_TAG_VALUE });
  await s3.send(
    new PutBucketTaggingCommand({
      Bucket: bucketName,
      Tagging: { TagSet: next },
    })
  );
  console.log(
    `[inject:drift] s3: changed tag ${DRIFTED_TAG_KEY} value to '${DRIFTED_TAG_VALUE}' on bucket ${bucketName}`
  );
}

async function injectIamActionDrift(managedPolicyArn: string): Promise<void> {
  const iam = new IAMClient({ region: REGION });

  const policyResp = await iam.send(new GetPolicyCommand({ PolicyArn: managedPolicyArn }));
  const defaultVersionId = policyResp.Policy?.DefaultVersionId;
  if (!defaultVersionId) {
    throw new Error(`Managed policy ${managedPolicyArn} has no default version id`);
  }

  const versionResp = await iam.send(
    new GetPolicyVersionCommand({ PolicyArn: managedPolicyArn, VersionId: defaultVersionId })
  );
  const rawDoc = versionResp.PolicyVersion?.Document;
  if (typeof rawDoc !== 'string') {
    throw new Error(`Managed policy ${managedPolicyArn} default version returned no document`);
  }
  const doc = JSON.parse(decodeURIComponent(rawDoc)) as {
    Version: string;
    Statement: Array<{ Action?: string | string[]; Resource?: string | string[] } & Record<string, unknown>>;
  };

  // Rewrite the first statement's Action list to add a new action. This is
  // a REAL change to a (deliberately un-canonicalized) Action array.
  const first = doc.Statement[0];
  const actions = Array.isArray(first.Action) ? [...first.Action] : first.Action ? [first.Action] : [];
  if (!actions.includes('s3:DeleteObject')) actions.push('s3:DeleteObject');
  first.Action = actions;

  // IAM allows at most 5 versions; prune the oldest non-default before
  // adding a new default so re-runs stay idempotent.
  await pruneOldestNonDefaultVersion(iam, managedPolicyArn);

  await iam.send(
    new CreatePolicyVersionCommand({
      PolicyArn: managedPolicyArn,
      PolicyDocument: JSON.stringify(doc),
      SetAsDefault: true,
    })
  );
  console.log(
    `[inject:drift] iam: added action s3:DeleteObject to the managed policy first statement on ${managedPolicyArn}`
  );
}

async function pruneOldestNonDefaultVersion(
  iam: IAMClient,
  managedPolicyArn: string
): Promise<void> {
  const versions = await iam.send(
    new ListPolicyVersionsCommand({ PolicyArn: managedPolicyArn })
  );
  const list = versions.Versions ?? [];
  if (list.length < 5) return; // room for a new version
  const nonDefault = list
    .filter((v) => !v.IsDefaultVersion && v.VersionId)
    .sort((a, b) => (a.CreateDate?.getTime() ?? 0) - (b.CreateDate?.getTime() ?? 0));
  const oldest = nonDefault[0];
  if (oldest?.VersionId) {
    await iam.send(
      new DeletePolicyVersionCommand({ PolicyArn: managedPolicyArn, VersionId: oldest.VersionId })
    );
    console.log(`[inject:drift] iam: pruned old policy version ${oldest.VersionId}`);
  }
}

async function injectSgRuleDrift(securityGroupId: string): Promise<void> {
  const ec2 = new EC2Client({ region: REGION });
  try {
    await ec2.send(
      new AuthorizeSecurityGroupIngressCommand({
        GroupId: securityGroupId,
        IpPermissions: [
          {
            IpProtocol: 'tcp',
            FromPort: ADDED_INGRESS_PORT,
            ToPort: ADDED_INGRESS_PORT,
            IpRanges: [{ CidrIp: ADDED_INGRESS_CIDR, Description: ADDED_INGRESS_DESC }],
          },
        ],
      })
    );
    console.log(
      `[inject:drift] ec2: added ingress rule tcp/${ADDED_INGRESS_PORT} from ${ADDED_INGRESS_CIDR} on SG ${securityGroupId}`
    );
  } catch (err) {
    const e = err as { name?: string; Code?: string };
    if (e?.name === 'InvalidPermission.Duplicate' || e?.Code === 'InvalidPermission.Duplicate') {
      console.log(
        `[inject:drift] ec2: ingress rule already present on SG ${securityGroupId} (idempotent)`
      );
      return;
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'drift';
  const ids = resolveResourceIds();

  if (mode === 'reorder') {
    await injectBenignReorder(ids.bucketName);
    console.log('[inject:reorder] benign tag reorder applied — `cdkd drift` MUST still report clean');
    return;
  }

  if (mode === 'drift') {
    await injectS3ValueDrift(ids.bucketName);
    await injectIamActionDrift(ids.managedPolicyArn);
    await injectSgRuleDrift(ids.securityGroupId);
    console.log('[inject:drift] real drift injected — `cdkd drift` should now report exit 1');
    return;
  }

  throw new Error(`Unknown inject mode '${mode}' (expected 'reorder' or 'drift')`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
