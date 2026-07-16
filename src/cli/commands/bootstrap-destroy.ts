import readline from 'node:readline/promises';
import {
  S3Client,
  HeadBucketCommand,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  DeleteBucketCommand,
  type ObjectIdentifier,
} from '@aws-sdk/client-s3';
import { ECRClient, DeleteRepositoryCommand } from '@aws-sdk/client-ecr';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { getLogger } from '../../utils/logger.js';
import type { Logger } from '../../types/config.js';
import { CdkdError, normalizeAwsError } from '../../utils/error-handler.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { rebuildClientForBucketRegion } from '../../utils/bucket-region-client.js';
import { getDefaultStateBucketName } from '../config-loader.js';
import {
  BOOTSTRAP_MARKER_PREFIX,
  getBootstrapMarkerKey,
  parseBootstrapMarker,
  type BootstrapMarker,
} from '../../assets/asset-storage.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { listAllStateKeys, describeStateKey } from './state-file-keys.js';

/**
 * `cdkd bootstrap --destroy` — teardown of cdkd-created account resources
 * (issue #1010, the reverse of `cdkd bootstrap` / `ensureAssetStorage`).
 *
 * Scope per invocation is ONE region's asset storage (`--region`, same
 * option the create side uses): empty + delete the asset bucket, force-
 * delete the container-asset ECR repo, then delete the region's bootstrap
 * marker LAST — the mirror image of the create side's marker-written-last
 * ordering, so a crash mid-teardown leaves the region still consistently
 * opted in (marker present → deploys keep hard-erroring at the missing
 * resources with a re-bootstrap hint, never a silent legacy fallback).
 *
 * The asset bucket / repo NAMES are read from the region's bootstrap
 * marker, NOT recomputed from the naming convention — the marker is the
 * source of truth for names (design §4.1), which keeps this teardown
 * compatible with custom asset-storage names (issue #1011).
 *
 * The state bucket is NOT deleted by default: it is the account's source
 * of truth. `--include-state-bucket` opts in, and even then the deletion
 * is refused while ANY stack state exists in the bucket or any OTHER
 * region is still opted in to asset storage (deleting their markers would
 * silently flip those regions back to legacy mode).
 */

/** S3 key prefix for state files — same fixed value the create side uses. */
const STATE_PREFIX = 'cdkd';

export interface BootstrapDestroyOptions {
  stateBucket?: string;
  region?: string;
  profile?: string;
  roleArn?: string;
  /** Skip the deployed-stack reference scan (destroy anyway). */
  force: boolean;
  /** Also delete the S3 state bucket (refused while any stack state exists). */
  includeStateBucket: boolean;
  /** `-y` / `--yes` — skip the interactive confirmation. */
  yes: boolean;
  verbose: boolean;
}

/**
 * Interactive confirmation for the teardown. Follows the repo's
 * destructive-prompt convention (see `recreate-confirm-prompt.ts`, the
 * same pattern family as `confirm-prompt.ts`): print the deletion plan as
 * a WARN block, `--yes` skips the prompt, a non-TTY stdin without `--yes`
 * is a hard error (never hang / never silently decline in CI), and the
 * prompt itself defaults to NO because the side effect is destructive.
 */
export async function promptBootstrapDestroyConfirm(input: {
  planLines: string[];
  yes: boolean;
}): Promise<boolean> {
  const logger = getLogger();
  logger.warn('');
  logger.warn('cdkd bootstrap --destroy will delete the following:');
  for (const line of input.planLines) {
    logger.warn(`  - ${line}`);
  }

  if (input.yes) return true;

  if (process.stdin.isTTY !== true) {
    throw new CdkdError(
      'The bootstrap --destroy confirmation prompt cannot run in a non-interactive ' +
        'environment. Pass --yes / -y to confirm the teardown, or run the command ' +
        'from a real terminal.',
      'NON_INTERACTIVE_CONFIRM'
    );
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('\nContinue? (y/N): ');
    const trimmed = answer.trim().toLowerCase();
    return trimmed === 'y' || trimmed === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * Scan every state file in the state bucket for references to the target
 * region's asset bucket / container repo. A pragmatic string scan of the
 * serialized state (design rationale in issue #1010): asset references
 * appear in many property shapes (`Code.S3Bucket`, `ImageUri`, nested
 * `TemplateURL`, `s3.Asset` env-var URLs, …) but all of them carry the
 * bucket / repo NAME verbatim, so a substring match over the raw JSON body
 * catches every shape — including ones future providers add — with zero
 * per-shape maintenance. Covers both key layouts (region-prefixed and
 * legacy), nested-stack children, and stacks deployed under a custom
 * `--state-prefix` (the listing spans the whole bucket, not just the
 * default `cdkd/` prefix).
 *
 * Returns a human-readable `stack (region)` descriptor per referencing
 * state file.
 */
export async function scanStateReferences(
  stateBackend: Pick<S3StateBackend, 'listRawKeys' | 'getRawObject'>,
  names: string[]
): Promise<string[]> {
  const stateKeys = await listAllStateKeys(stateBackend);
  const referencing: string[] = [];
  for (const key of stateKeys) {
    const body = await stateBackend.getRawObject(key);
    if (body === null) continue;
    if (names.some((name) => body.includes(name))) {
      referencing.push(describeStateKey(key));
    }
  }
  return referencing;
}

/**
 * Empty (all versions + delete markers) and delete an S3 bucket, with
 * `ExpectedBucketOwner` pinned on every call — deleting a foreign bucket
 * that squatted the predictable name would be catastrophic, so the same
 * ownership defense as the create side applies in reverse. Returns `false`
 * (skip, info line) when the bucket does not exist — the idempotency
 * mirror of `ensureAssetStorage`.
 */
async function emptyAndDeleteBucket(
  s3Client: Pick<S3Client, 'send'>,
  bucket: string,
  accountId: string,
  label: string,
  logger: Logger
): Promise<boolean> {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: bucket, ExpectedBucketOwner: accountId }));
  } catch (error) {
    const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === 'NotFound' || err.name === 'NoSuchBucket') {
      logger.info(`${label} ${bucket} does not exist — skipping`);
      return false;
    }
    if (err.$metadata?.httpStatusCode === 403) {
      throw new CdkdError(
        `${label} '${bucket}' exists but is not owned by account ${accountId} ` +
          `(or access is denied). Refusing to delete it.`,
        'ASSET_STORAGE_FOREIGN_BUCKET',
        error as Error
      );
    }
    throw normalizeAwsError(error, { bucket, operation: 'HeadBucket' });
  }

  logger.info(`Emptying ${label.toLowerCase()}: ${bucket}`);
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    const page = await s3Client.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        ExpectedBucketOwner: accountId,
        ...(keyMarker && { KeyMarker: keyMarker }),
        ...(versionIdMarker && { VersionIdMarker: versionIdMarker }),
      })
    );
    const entries: ObjectIdentifier[] = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]
      .filter((v) => v.Key)
      .map((v) => ({ Key: v.Key!, ...(v.VersionId && { VersionId: v.VersionId }) }));
    if (entries.length > 0) {
      const response = await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          ExpectedBucketOwner: accountId,
          Delete: { Objects: entries, Quiet: true },
        })
      );
      const failures = (response.Errors ?? []).map(
        (e) => `${e.Key ?? '<unknown>'} (${e.Code ?? 'Error'}: ${e.Message ?? ''})`
      );
      if (failures.length > 0) {
        throw new CdkdError(
          `Failed to delete ${failures.length} object(s) from ${label.toLowerCase()} ` +
            `'${bucket}': ${failures.join('; ')}`,
          'BUCKET_EMPTY_FAILED'
        );
      }
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker || versionIdMarker);

  await s3Client.send(new DeleteBucketCommand({ Bucket: bucket, ExpectedBucketOwner: accountId }));
  logger.info(`✓ Deleted ${label.toLowerCase()}: ${bucket}`);
  return true;
}

/**
 * Force-delete the container-asset ECR repository. Missing repo is an
 * idempotent skip with an info line.
 */
async function deleteContainerRepo(
  containerRepo: string,
  region: string,
  profile: string | undefined,
  logger: Logger
): Promise<void> {
  const ecrClient = new ECRClient({ region, ...(profile && { profile }) });
  try {
    await ecrClient.send(
      new DeleteRepositoryCommand({ repositoryName: containerRepo, force: true })
    );
    logger.info(`✓ Deleted container-asset ECR repository: ${containerRepo}`);
  } catch (error) {
    const err = error as { name?: string };
    if (err.name === 'RepositoryNotFoundException') {
      logger.info(`Container-asset repository ${containerRepo} does not exist — skipping`);
    } else {
      throw normalizeAwsError(error, { operation: 'DeleteRepository' });
    }
  } finally {
    ecrClient.destroy();
  }
}

/**
 * List OTHER regions that still have a bootstrap marker in the state
 * bucket (i.e. are still opted in to cdkd asset storage).
 */
async function listOtherBootstrapRegions(
  stateBackend: Pick<S3StateBackend, 'listRawKeys'>,
  region: string
): Promise<string[]> {
  const keys = await stateBackend.listRawKeys(BOOTSTRAP_MARKER_PREFIX);
  return keys
    .filter((k) => k.endsWith('.json'))
    .map((k) => k.slice(BOOTSTRAP_MARKER_PREFIX.length, -'.json'.length))
    .filter((r) => r.length > 0 && r !== region);
}

/**
 * `cdkd bootstrap --destroy` implementation. Dispatched from the bootstrap
 * command action when `--destroy` is passed.
 */
export async function bootstrapDestroyCommand(options: BootstrapDestroyOptions): Promise<void> {
  const logger = getLogger();

  if (options.verbose) {
    logger.setLevel('debug');
  }

  logger.info('Starting cdkd bootstrap --destroy...');
  logger.debug('Options:', options);

  // Resolve --role-arn / CDKD_ROLE_ARN before any AWS call (create-side parity).
  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

  const awsClients = new AwsClients({
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  const region = options.region || process.env['AWS_REGION'] || 'us-east-1';

  // Account id is needed for the default bucket name AND for the
  // ExpectedBucketOwner pin on every S3 call, so always resolve it.
  const identity = await awsClients.sts.send(new GetCallerIdentityCommand({}));
  const accountId = identity.Account!;
  const bucketName = options.stateBucket ?? getDefaultStateBucketName(accountId);

  // State-bucket reads/writes (marker, state scan) go through the state
  // backend, which resolves the bucket's ACTUAL region itself — the state
  // bucket is account-scoped and may live in a different region than
  // --region (create-side parity).
  const markerS3Client = new S3Client({
    region,
    ...(options.profile && { profile: options.profile }),
  });
  const stateBackend = new S3StateBackend(
    markerS3Client,
    { bucket: bucketName, prefix: STATE_PREFIX },
    { region, ...(options.profile && { profile: options.profile }) }
  );

  try {
    // 1. Read the region's bootstrap marker — the source of truth for the
    //    asset bucket / repo names (never recompute the naming convention;
    //    custom-name compatibility, issue #1011).
    const markerKey = getBootstrapMarkerKey(region);
    let markerBody: string | null;
    try {
      markerBody = await stateBackend.getRawObject(markerKey);
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchBucket') {
        // Never-bootstrapped account: no state bucket means no marker, no
        // asset storage, and nothing for --include-state-bucket either.
        logger.info(
          `State bucket '${bucketName}' does not exist — this account/region was ` +
            `never bootstrapped; nothing to delete.`
        );
        return;
      }
      throw error;
    }
    let marker: BootstrapMarker | undefined;
    if (markerBody === null) {
      logger.info(
        `No bootstrap marker for region '${region}' (${markerKey}) — asset storage ` +
          `is not opted in for this region (or was already destroyed); nothing to delete.`
      );
      if (!options.includeStateBucket) {
        logger.info(
          `If the asset bucket / ECR repo still exist without a marker, re-run ` +
            `'cdkd bootstrap --region ${region}' to recreate the marker, then destroy again.`
        );
        return;
      }
    } else {
      marker = parseBootstrapMarker(markerBody, markerKey);
    }

    // 2. Safety scan: refuse while any DEPLOYED stack still references the
    //    asset bucket / repo (running Lambdas keep working after deletion,
    //    but any future re-deploy / rollback of those stacks breaks).
    //    `--force` overrides.
    if (marker && !options.force) {
      logger.info('Scanning stack state for references to the asset storage...');
      const referencing = await scanStateReferences(stateBackend, [
        marker.assetBucket,
        marker.containerRepo,
      ]);
      if (referencing.length > 0) {
        throw new CdkdError(
          `Refusing to destroy asset storage for region '${region}': ` +
            `${referencing.length} deployed stack(s) still reference ` +
            `'${marker.assetBucket}' / '${marker.containerRepo}':\n` +
            referencing.map((s) => `  - ${s}`).join('\n') +
            `\nDestroy (or re-deploy off the storage) these stacks first, ` +
            `or pass --force to delete anyway.`,
          'ASSET_STORAGE_IN_USE'
        );
      }
    }

    // 3. State-bucket pre-flight (--include-state-bucket): the bucket is
    //    the account's source of truth — refuse while ANY stack state
    //    exists (no --force override), and refuse while any OTHER region
    //    is still opted in (deleting their markers would silently flip
    //    those regions back to legacy mode). The state listing spans the
    //    WHOLE bucket (not just the default `cdkd/` prefix) so stacks
    //    deployed with a custom --state-prefix cannot slip past the guard.
    if (options.includeStateBucket) {
      const stateKeys = await listAllStateKeys(stateBackend);
      if (stateKeys.length > 0) {
        const listing = stateKeys.map((k) => `  - ${describeStateKey(k)}  [${k}]`).join('\n');
        throw new CdkdError(
          `Refusing to delete state bucket '${bucketName}': ${stateKeys.length} stack(s) ` +
            `still have state in it:\n${listing}\n` +
            `Destroy every stack ('cdkd destroy' / 'cdkd state destroy') before ` +
            `deleting the state bucket.`,
          'STATE_BUCKET_NOT_EMPTY'
        );
      }
      const otherRegions = await listOtherBootstrapRegions(stateBackend, region);
      if (otherRegions.length > 0) {
        throw new CdkdError(
          `Refusing to delete state bucket '${bucketName}': region(s) ` +
            `${otherRegions.join(', ')} are still opted in to cdkd asset storage ` +
            `(their bootstrap markers live in this bucket). Run ` +
            `'cdkd bootstrap --destroy --region <r>' for each first.`,
          'STATE_BUCKET_HOLDS_MARKERS'
        );
      }
    }

    // 4. Confirmation (default: interactive, y/N; `--yes` skips).
    const planLines: string[] = [];
    if (marker) {
      planLines.push(`Asset bucket: s3://${marker.assetBucket} (region ${region}, all contents)`);
      planLines.push(
        `Container-asset ECR repository: ${marker.containerRepo} (region ${region}, all images)`
      );
      planLines.push(`Bootstrap marker: s3://${bucketName}/${markerKey} (deleted last)`);
    }
    if (options.includeStateBucket) {
      planLines.push(`State bucket: s3://${bucketName} (ALL contents, including all versions)`);
    }
    const confirmed = await promptBootstrapDestroyConfirm({ planLines, yes: options.yes });
    if (!confirmed) {
      logger.info('Bootstrap teardown cancelled — nothing deleted.');
      return;
    }

    // 5. Teardown. Order matters: asset bucket → ECR repo → marker LAST
    //    (mirror of the create side's marker-written-last ordering), so a
    //    crash mid-teardown leaves the region still consistently opted in.
    if (marker) {
      await emptyAndDeleteBucket(
        awsClients.s3,
        marker.assetBucket,
        accountId,
        'Asset bucket',
        logger
      );
      await deleteContainerRepo(marker.containerRepo, region, options.profile, logger);
      await stateBackend.deleteRawObjects([markerKey]);
      logger.info(`✓ Deleted bootstrap marker (${markerKey})`);
      logger.info(
        `\ncdkd asset storage is now OFF for region ${region}: future deploys in this ` +
          `region fall back to legacy mode (CDK bootstrap destinations) unless the ` +
          `region is bootstrapped again.`
      );
    }

    if (options.includeStateBucket) {
      // The state bucket may live in a different region than --region —
      // resolve its actual region first (create-side parity; a cross-region
      // Head/Delete would otherwise 301).
      const rebuiltStateBucketClient = await rebuildClientForBucketRegion(
        awsClients.s3,
        bucketName,
        { ...(options.profile && { profile: options.profile }) }
      );
      try {
        const stateBucketS3 = rebuiltStateBucketClient ?? awsClients.s3;
        await emptyAndDeleteBucket(stateBucketS3, bucketName, accountId, 'State bucket', logger);
      } finally {
        rebuiltStateBucketClient?.destroy();
      }
    }

    logger.info('\n✓ Bootstrap teardown completed');
  } finally {
    // If the backend rebuilt its client for the state bucket's region it
    // already destroyed this one; a second destroy is a safe no-op.
    markerS3Client.destroy();
    awsClients.destroy();
  }
}
