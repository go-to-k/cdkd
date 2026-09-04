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
import { confirmOrRefuse } from './confirm-prompt.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { foldRegionOption, namedCliRegion } from '../region-options.js';
import { resolveBucketRegion } from '../../utils/aws-region-resolver.js';
import { getDefaultStateBucketName, getLegacyStateBucketName } from '../config-loader.js';
import { expectedOwnerParam } from '../../utils/expected-bucket-owner.js';
import { buildDenyExternalAccessPolicy } from '../../utils/deny-external-access-policy.js';
import { awsClientDefaults } from '../../utils/aws-client-defaults.js';

interface MigrateOptions {
  region?: string;
  profile?: string;
  roleArn?: string;
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
async function stateMigrateCommand(options: MigrateOptions): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');

  // Resolve --role-arn / CDKD_ROLE_ARN before any AWS call.
  // Issue #2065 - fold `--region` ONCE, at the boundary, so no raw spelling
  // reaches an SDK client, an ARN segment or a state key. Rationale (and why
  // this is per-command rather than per-consumer) in `src/cli/region-options.ts`.
  foldRegionOption(options);
  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

  const region = namedCliRegion(options.region) ?? 'us-east-1';

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
    const probe = new S3Client({ ...awsClientDefaults(), region: probeRegion });
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

    const legacyS3 = new S3Client({ ...awsClientDefaults(), region: legacyRegion });

    try {
      await assertNoActiveLocks(legacyS3, legacyBucket);

      const sourceObjects = await listAllObjects(legacyS3, legacyBucket);
      logger.info(`  source object count: ${sourceObjects.length}`);

      if (sourceObjects.length === 0) {
        logger.info('Source bucket is empty — no objects to copy.');
      }

      // Issue #2538: the dry-run bail comes BEFORE the prompt, not after.
      // Asking a user to confirm a copy that will never run is backwards, and
      // `confirmOrRefuse` throws NON_INTERACTIVE_CONFIRM on a non-TTY — which
      // made `--dry-run` alone exit 1 in CI, the one place a preview is most
      // useful. Everything the preview reports (both bucket names, the source
      // bucket's real region, the object count) has already been printed by
      // this point, so returning here loses nothing. Matches
      // `state refresh-observed`, whose prompt is likewise skipped under
      // `--dry-run`.
      if (options.dryRun) {
        // `--remove-legacy` is named NOWHERE above — the only place it
        // surfaced was the prompt string this bail now precedes, so without
        // this line the preview of the single destructive flag would say
        // nothing about it.
        if (options.removeLegacy) {
          logger.info(
            `--remove-legacy: '${legacyBucket}' would then be emptied ` +
              `(every object version and delete marker) and deleted.`
          );
        }
        logger.info('--dry-run: no changes will be made. Stopping here.');
        return;
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

      const newS3 = await ensureDestinationBucket(newBucket, legacyRegion, accountId, logger);

      try {
        let copied = 0;
        for (const obj of sourceObjects) {
          if (!obj.Key) continue;
          await newS3.send(
            new CopyObjectCommand({
              Bucket: newBucket,
              Key: obj.Key,
              ...(await expectedOwnerParam(newS3)),
              ExpectedSourceBucketOwner: accountId,
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
          await legacyS3.send(
            new DeleteBucketCommand({
              Bucket: legacyBucket,
              ...(await expectedOwnerParam(legacyS3)),
            })
          );
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
    await s3.send(new HeadBucketCommand({ Bucket: bucketName, ...(await expectedOwnerParam(s3)) }));
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
        ...(await expectedOwnerParam(s3)),
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
  const probe = new S3Client({ ...awsClientDefaults(), region });
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
    return new S3Client({ ...awsClientDefaults(), region: actual });
  }

  // Create the destination in the same region as the source for parity.
  logger.info(`Creating destination bucket ${bucketName} in ${region}...`);
  const s3 = new S3Client({ ...awsClientDefaults(), region });

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
      ...(await expectedOwnerParam(s3)),
      VersioningConfiguration: { Status: 'Enabled' },
    })
  );
  await s3.send(
    new PutBucketEncryptionCommand({
      Bucket: bucketName,
      ...(await expectedOwnerParam(s3)),
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
      ...(await expectedOwnerParam(s3)),
      // Derived from the client that creates the bucket, matching the rule the
      // other two call sites follow (issue #1794 review). Here the two are the
      // same value by construction — `s3` is `new S3Client({ region })` and
      // this arm runs only after the `CreateBucket` above — but reading it off
      // the client keeps ONE rule for where a bucket's partition comes from,
      // rather than a per-site judgement about whether the local `region`
      // variable happens to be authoritative.
      Policy: JSON.stringify(
        buildDenyExternalAccessPolicy(bucketName, accountId, await s3.config.region())
      ),
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
        ...(await expectedOwnerParam(s3)),
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
          ...(await expectedOwnerParam(s3)),
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

/**
 * `cdkd state migrate`'s confirmation prompt. Its only call site is inside the
 * `if (!options.yes)` block above, which is what keeps `confirmOrRefuse`'s
 * non-interactive refusal (issue #2275) from firing on a `--yes` run — and it
 * sits BELOW the `--dry-run` bail (issue #2538), so a preview never reaches it
 * either. Together those are the two ways not to be asked, matching
 * `state refresh-observed`, whose prompt condition spells both:
 * `!options.yes && !options.dryRun`.
 *
 * Exported for unit testing — internal to the command flow otherwise.
 */
export async function confirmPrompt(prompt: string): Promise<boolean> {
  return confirmOrRefuse(prompt, {
    refusal:
      'The cdkd state migrate confirmation prompt cannot run in a non-interactive ' +
      'environment. Pass -y / --yes to confirm the migration, or run the command ' +
      'from a real terminal.',
  });
}

/**
 * Create the `cdkd state migrate` subcommand.
 *
 * Migrates from the legacy region-suffixed default bucket
 * (`cdkd-state-{accountId}-{region}`) to the region-free default
 * (`cdkd-state-{accountId}`). Per-region: each invocation handles one source
 * region. The destination bucket is created on the first run and reused on
 * subsequent runs.
 */
export function createStateMigrateCommand(): Command {
  const cmd = new Command('migrate')
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
    .action(withErrorHandling(stateMigrateCommand));

  commonOptions.forEach((o) => cmd.addOption(o));
  return cmd;
}
