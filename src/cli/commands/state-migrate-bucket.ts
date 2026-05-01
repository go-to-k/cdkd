import * as readline from 'node:readline/promises';
import { Command } from 'commander';
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  PutBucketEncryptionCommand,
  PutBucketPolicyCommand,
  PutBucketVersioningCommand,
  S3Client,
  type BucketLocationConstraint,
  type _Object,
} from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { commonOptions } from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { resolveBucketRegion } from '../../utils/aws-region-resolver.js';
import { getDefaultStateBucketName, getLegacyStateBucketName } from '../config-loader.js';

interface MigrateBucketOptions {
  region?: string;
  profile?: string;
  legacyBucket?: string;
  newBucket?: string;
  dryRun: boolean;
  yes: boolean;
  removeLegacy: boolean;
  verbose: boolean;
}

type Logger = ReturnType<typeof getLogger>;

/**
 * Move state from the legacy region-suffixed default bucket
 * (`cdkd-state-{accountId}-{region}`) to the new region-free default
 * (`cdkd-state-{accountId}`).
 *
 * Per-region: callers point at one legacy bucket via `--region`. Multi-region
 * users invoke the command once per region, each time copying into the same
 * destination bucket — when the destination already exists, subsequent runs
 * just copy more objects in.
 *
 * Failure model:
 * - Refuses to start if any `**\/lock.json` exists in the source bucket
 *   (an in-flight `cdkd deploy` / `destroy` would race with the copy).
 * - On copy failure, the destination bucket is kept as-is (re-running resumes
 *   from where it left off — `CopyObject` is idempotent for object keys).
 * - Source bucket is only deleted with `--remove-legacy` AND only after a
 *   post-copy object-count verification passes.
 */
async function stateMigrateBucketCommand(options: MigrateBucketOptions): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');

  const region = options.region || process.env['AWS_REGION'] || 'us-east-1';

  // SDK clients constructed from the user's profile/region. The bucket-region
  // S3 clients below are constructed independently to pin to each bucket's
  // actual region (legacy and destination may differ).
  const awsClients = new AwsClients({
    region,
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  try {
    const identity = await awsClients.sts.send(new GetCallerIdentityCommand({}));
    const accountId = identity.Account;
    if (!accountId) {
      throw new Error('STS GetCallerIdentity returned no Account id.');
    }

    const legacyBucket = options.legacyBucket ?? getLegacyStateBucketName(accountId, region);
    const newBucket = options.newBucket ?? getDefaultStateBucketName(accountId);

    if (legacyBucket === newBucket) {
      logger.warn(
        `Source and destination resolve to the same bucket (${legacyBucket}); nothing to do.`
      );
      return;
    }

    logger.info('Migrating state bucket:');
    logger.info(`  source:      ${legacyBucket} (resolved for --region ${region})`);
    logger.info(`  destination: ${newBucket}`);

    // Probe source existence with a region-agnostic client. 301/403 both mean
    // "exists somewhere" — we resolve the actual region next.
    const probeRegion = 'us-east-1';
    const probe = new S3Client({ region: probeRegion });
    let sourceExists: boolean;
    try {
      sourceExists = await bucketExists(probe, legacyBucket);
    } finally {
      probe.destroy();
    }
    if (!sourceExists) {
      throw new Error(
        `Source bucket '${legacyBucket}' does not exist. ` +
          `Nothing to migrate. (Tip: run \`cdkd state info\` to confirm which bucket cdkd is reading from.)`
      );
    }

    const legacyRegion = await resolveBucketRegion(legacyBucket);
    logger.info(`  source bucket actual region: ${legacyRegion}`);

    const legacyS3 = new S3Client({ region: legacyRegion });

    try {
      await assertNoActiveLocks(legacyS3, legacyBucket);

      const sourceObjects = await listAllObjects(legacyS3, legacyBucket);
      logger.info(`  source object count: ${sourceObjects.length}`);

      if (sourceObjects.length === 0) {
        logger.info('Source bucket is empty — no objects to copy.');
      }

      if (!options.yes) {
        const action = options.removeLegacy
          ? 'and DELETE the source bucket'
          : '(source bucket will be kept)';
        const ok = await confirmPrompt(
          `Copy ${sourceObjects.length} object(s) from ${legacyBucket} -> ${newBucket} ${action}?`
        );
        if (!ok) {
          logger.info('Migration cancelled.');
          return;
        }
      }

      if (options.dryRun) {
        logger.info('--dry-run: no changes will be made. Stopping here.');
        return;
      }

      const newS3 = await ensureDestinationBucket(newBucket, legacyRegion, accountId, logger);

      try {
        let copied = 0;
        for (const obj of sourceObjects) {
          if (!obj.Key) continue;
          await newS3.send(
            new CopyObjectCommand({
              Bucket: newBucket,
              Key: obj.Key,
              // CopySource needs encoding for slashes inside the key path.
              CopySource: encodeURIComponent(`${legacyBucket}/${obj.Key}`),
            })
          );
          copied++;
          logger.debug(`  copied ${obj.Key}`);
        }
        logger.info(`✓ Copied ${copied} object(s) to ${newBucket}`);

        // Sanity: destination must contain at least the source count. Strict
        // equality would fail when the destination already had objects from a
        // previous partial migration (we treat extra objects as fine).
        const destObjects = await listAllObjects(newS3, newBucket);
        if (destObjects.length < sourceObjects.length) {
          throw new Error(
            `Migration verification failed: source has ${sourceObjects.length} object(s), ` +
              `destination has ${destObjects.length}. Aborting before any source-bucket cleanup.`
          );
        }
        logger.info('✓ Object count verified at destination');

        if (options.removeLegacy) {
          logger.info(`Emptying source bucket ${legacyBucket} (all versions + delete markers)...`);
          await emptyBucketAllVersions(legacyS3, legacyBucket);
          logger.info(`Deleting source bucket ${legacyBucket}...`);
          await legacyS3.send(new DeleteBucketCommand({ Bucket: legacyBucket }));
          logger.info(`✓ Deleted source bucket: ${legacyBucket}`);
        } else {
          logger.info(
            `Source bucket ${legacyBucket} kept. Pass --remove-legacy on a future run to delete it.`
          );
        }

        logger.info(`✓ Migration complete: ${legacyBucket} -> ${newBucket}`);
      } finally {
        newS3.destroy();
      }
    } finally {
      legacyS3.destroy();
    }
  } finally {
    awsClients.destroy();
  }
}

async function bucketExists(s3: S3Client, bucketName: string): Promise<boolean> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
    return true;
  } catch (error) {
    const err = error as {
      name?: string;
      $metadata?: { httpStatusCode?: number };
    };
    const status = err.$metadata?.httpStatusCode;
    if (err.name === 'NotFound' || err.name === 'NoSuchBucket' || status === 404) {
      return false;
    }
    // 301 (cross-region) and 403 (no permission to head) both prove existence.
    if (status === 301 || status === 403) return true;
    throw error;
  }
}

async function listAllObjects(s3: S3Client, bucket: string): Promise<_Object[]> {
  const all: _Object[] = [];
  let continuationToken: string | undefined;
  do {
    const resp = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ...(continuationToken && { ContinuationToken: continuationToken }),
      })
    );
    if (resp.Contents) all.push(...resp.Contents);
    continuationToken = resp.NextContinuationToken;
  } while (continuationToken);
  return all;
}

/**
 * Refuse to migrate while any stack has an active lock — `**\/lock.json` is the
 * exclusive-lock marker `LockManager` writes during deploy/destroy. Migrating
 * mid-flight would race the in-progress write.
 */
async function assertNoActiveLocks(s3: S3Client, bucket: string): Promise<void> {
  const all = await listAllObjects(s3, bucket);
  const locks = all
    .map((o) => o.Key)
    .filter((k): k is string => typeof k === 'string' && k.endsWith('/lock.json'));
  if (locks.length > 0) {
    const sample = locks.slice(0, 3).join(', ');
    const more = locks.length > 3 ? ` (+${locks.length - 3} more)` : '';
    throw new Error(
      `Refusing to migrate: ${locks.length} active lock file(s) found in '${bucket}': ${sample}${more}. ` +
        `Wait for in-flight cdkd operations to complete, or run 'cdkd force-unlock <stack>' if a lock is stale.`
    );
  }
}

async function ensureDestinationBucket(
  bucketName: string,
  region: string,
  accountId: string,
  logger: Logger
): Promise<S3Client> {
  // Probe: if the destination already exists, reuse it (idempotent re-run).
  const probe = new S3Client({ region });
  let exists: boolean;
  try {
    exists = await bucketExists(probe, bucketName);
  } finally {
    probe.destroy();
  }

  if (exists) {
    logger.info(`Destination bucket ${bucketName} already exists; reusing it.`);
    const actual = await resolveBucketRegion(bucketName);
    if (actual !== region) {
      logger.warn(
        `Destination bucket lives in ${actual}, but source is in ${region}. ` +
          `Cross-region copy is supported but slower; objects will be replicated to ${actual}.`
      );
    }
    return new S3Client({ region: actual });
  }

  // Create the destination in the same region as the source for parity.
  logger.info(`Creating destination bucket ${bucketName} in ${region}...`);
  const s3 = new S3Client({ region });

  const createParams: {
    Bucket: string;
    CreateBucketConfiguration?: { LocationConstraint: BucketLocationConstraint };
  } = { Bucket: bucketName };
  // S3 quirk: us-east-1 is implicit; passing LocationConstraint=us-east-1 fails.
  if (region !== 'us-east-1') {
    createParams.CreateBucketConfiguration = {
      LocationConstraint: region as BucketLocationConstraint,
    };
  }
  await s3.send(new CreateBucketCommand(createParams));
  logger.info(`✓ Created destination bucket: ${bucketName}`);

  // Apply the same hardening defaults as `cdkd bootstrap`.
  await s3.send(
    new PutBucketVersioningCommand({
      Bucket: bucketName,
      VersioningConfiguration: { Status: 'Enabled' },
    })
  );
  await s3.send(
    new PutBucketEncryptionCommand({
      Bucket: bucketName,
      ServerSideEncryptionConfiguration: {
        Rules: [
          {
            ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
            BucketKeyEnabled: true,
          },
        ],
      },
    })
  );
  await s3.send(
    new PutBucketPolicyCommand({
      Bucket: bucketName,
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'DenyExternalAccess',
            Effect: 'Deny',
            Principal: '*',
            Action: 's3:*',
            Resource: [`arn:aws:s3:::${bucketName}`, `arn:aws:s3:::${bucketName}/*`],
            Condition: { StringNotEquals: { 'aws:PrincipalAccount': accountId } },
          },
        ],
      }),
    })
  );
  logger.info('✓ Applied versioning, encryption, and account-only access policy');
  return s3;
}

/**
 * Empty a versioned bucket — every prior version and delete-marker — so that
 * `DeleteBucket` succeeds. Required because the state buckets bootstrap with
 * versioning enabled.
 */
async function emptyBucketAllVersions(s3: S3Client, bucket: string): Promise<void> {
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    const resp = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        ...(keyMarker && { KeyMarker: keyMarker }),
        ...(versionIdMarker && { VersionIdMarker: versionIdMarker }),
      })
    );

    const ids: { Key: string; VersionId: string }[] = [];
    for (const v of resp.Versions ?? []) {
      if (v.Key && v.VersionId) ids.push({ Key: v.Key, VersionId: v.VersionId });
    }
    for (const dm of resp.DeleteMarkers ?? []) {
      if (dm.Key && dm.VersionId) ids.push({ Key: dm.Key, VersionId: dm.VersionId });
    }

    // DeleteObjects is capped at 1000 entries per call.
    for (let i = 0; i < ids.length; i += 1000) {
      const batch = ids.slice(i, i + 1000);
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: batch,
            Quiet: true,
          },
        })
      );
    }

    keyMarker = resp.NextKeyMarker;
    versionIdMarker = resp.NextVersionIdMarker;
  } while (keyMarker || versionIdMarker);
}

async function confirmPrompt(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await rl.question(`${prompt} [y/N] `);
    return /^y(es)?$/i.test(ans.trim());
  } finally {
    rl.close();
  }
}

/**
 * Create the `cdkd state migrate-bucket` subcommand.
 *
 * Migrates from the legacy region-suffixed default bucket
 * (`cdkd-state-{accountId}-{region}`) to the region-free default
 * (`cdkd-state-{accountId}`). Per-region: each invocation handles one source
 * region. The destination bucket is created on the first run and reused on
 * subsequent runs.
 */
export function createStateMigrateBucketCommand(): Command {
  const cmd = new Command('migrate-bucket')
    .description(
      'Migrate state from the legacy region-suffixed bucket (cdkd-state-{account}-{region}) ' +
        'to the new region-free default (cdkd-state-{account}). Source bucket is kept by default; ' +
        'pass --remove-legacy to delete it after a successful migration.'
    )
    .option(
      '--region <region>',
      'Region of the legacy bucket to migrate. Defaults to AWS_REGION or us-east-1. ' +
        'Run once per region for multi-region setups.'
    )
    .option(
      '--legacy-bucket <name>',
      'Override the legacy (source) bucket name (default: derived from STS account + --region).'
    )
    .option(
      '--new-bucket <name>',
      'Override the new (destination) bucket name (default: cdkd-state-{accountId}).'
    )
    .option('--dry-run', 'Show planned actions without making changes', false)
    .option(
      '--remove-legacy',
      'Delete the source bucket after successful migration. Default: keep it.',
      false
    )
    .action(withErrorHandling(stateMigrateBucketCommand));

  commonOptions.forEach((o) => cmd.addOption(o));
  return cmd;
}
