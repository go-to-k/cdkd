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
import { canonicalizeRegion } from '../../utils/aws-partition.js';
import {
  BOOTSTRAP_MARKER_PREFIX,
  getBootstrapMarkerKey,
  parseBootstrapMarker,
  readBootstrapMarkerBody,
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

/** The region spelling a bootstrap marker key carries, e.g. `Us-East-1`. */
function markerRegionOfKey(markerKey: string): string {
  return markerKey.slice(BOOTSTRAP_MARKER_PREFIX.length, -'.json'.length);
}

/**
 * Partition the state bucket's bootstrap markers, relative to the ONE this run
 * resolved, into the two kinds that must not be silently destroyed with the
 * bucket:
 *
 * - `otherRegions` — markers for a DIFFERENT region, still opted in.
 * - `sameRegionKeys` — markers for THIS region under a different SPELLING of
 *   its name. The teardown deletes exactly one key, so every other spelling
 *   survives, naming asset storage this run did not touch.
 *
 * Both come from ONE listing, and the second kind is why the listing rather
 * than a per-key probe is the source: a probe is only as deep as the keys it
 * guesses (`us-east-1` / `US-EAST-1`), while a region can hold a marker under
 * any spelling (`Us-East-1`), and the listing sees all of them.
 *
 * `region` arrives CANONICAL (issue #1995) while the key segments are whatever
 * `cdkd bootstrap` actually wrote, which is not folded (issue #1820) — so the
 * two sides are compared through {@link canonicalizeRegion} rather than
 * directly. A raw compare re-introduces this command's own bug in a different
 * flag: with a marker at `cdkd-bootstrap/US-EAST-1.json`,
 * `--destroy --region US-EAST-1 --include-state-bucket` would list `US-EAST-1`
 * as an "other" region, refuse with `STATE_BUCKET_HOLDS_MARKERS` naming the
 * very region being torn down, and tell the user to run the command they just
 * ran. It aborts BEFORE the teardown, so the bucket and repo survive too.
 *
 * Other regions are deduplicated by the folded name, so a region bootstrapped
 * twice under two spellings is reported once rather than twice.
 *
 * The comparison folds but the REPORTED value stays the RAW key segment, and
 * that asymmetry is load-bearing. The error tells the user to run
 * `cdkd bootstrap --destroy --region <r>` for each name printed, and only the
 * raw spelling actually reaches the marker: `--region eu-west-1` against a
 * marker at `cdkd-bootstrap/EU-WEST-1.json` probes the canonical key (absent),
 * finds `rawMarkerKey === markerKey`, skips the second probe, and reports
 * "nothing to delete". Printing the folded name would hand the user a command
 * that cannot work.
 */
async function listBootstrapMarkerSiblings(
  stateBackend: Pick<S3StateBackend, 'listRawKeys'>,
  region: string,
  resolvedMarkerKey: string
): Promise<{ otherRegions: string[]; sameRegionKeys: string[] }> {
  const keys = await stateBackend.listRawKeys(BOOTSTRAP_MARKER_PREFIX);
  // Fold ONCE per entry — it was recomputed three times per key.
  const segments = keys
    .filter((k) => k.endsWith('.json'))
    .map((k) => {
      const raw = k.slice(BOOTSTRAP_MARKER_PREFIX.length, -'.json'.length);
      return { key: k, raw, folded: canonicalizeRegion(raw) };
    })
    .filter((e) => e.raw.length > 0);

  // Dedupe OTHER regions BY the folded name, keeping the raw spelling.
  const byCanonical = new Map<string, string>();
  for (const { raw, folded } of segments) {
    if (folded === region) continue;
    if (!byCanonical.has(folded)) byCanonical.set(folded, raw);
  }

  // Same region, different KEY than the one this run resolved: every spelling
  // of this region's own marker that the teardown will NOT delete.
  const sameRegionKeys = segments
    .filter((e) => e.folded === region && e.key !== resolvedMarkerKey)
    .map((e) => e.key);

  return { otherRegions: [...byCanonical.values()], sameRegionKeys };
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
  await applyRoleArnIfSet({
    roleArn: options.roleArn,
    region: canonicalizeRegion(options.region),
  });

  // Issue #1995, same split as `cdkd gc` (`src/cli/commands/gc.ts`) — this
  // command had the identical defect, with a WORSE failure direction. gc's
  // version merely collects nothing; here `--region US-EAST-1` found no marker
  // and reported "nothing to delete" while the asset bucket and the ECR
  // repository stayed alive, so a user who believes they tore their storage
  // down keeps paying for it.
  //
  // - The CLIENTS need the region CANONICAL: SDK endpoint resolution is
  //   case-sensitive (`derivePartitionAndUrlSuffix`'s note measures `CN-NORTH-1`
  //   resolving to the COMMERCIAL suffix).
  // - The marker KEY needs BOTH spellings probed, canonical first. `cdkd
  //   bootstrap` still derives its own region verbatim (issue #1820), so
  //   `AWS_REGION=US-EAST-1 cdkd bootstrap` really wrote
  //   `cdkd-bootstrap/US-EAST-1.json`; a fold-and-stop read would MISS that
  //   marker where the pre-fold read HIT it, which for THIS command means
  //   refusing to destroy storage that exists.
  const rawRegion = options.region || process.env['AWS_REGION'] || 'us-east-1';
  const region = canonicalizeRegion(rawRegion);

  // Canonical when a region was NAMED (flag or env), absent when it was not.
  //
  // Deliberately NOT `region` unconditionally the way `gc.ts` passes it: that
  // variable falls back to the literal `'us-east-1'`, so passing it always
  // would PIN us-east-1 for a user who names no region and expects the SDK's
  // own chain (`~/.aws/config` profile region) to answer — a behaviour change
  // well outside this fix. What #1995 requires is only that a RAW spelling
  // never reaches a client, and that holds here: the env path is folded too,
  // which is the half the conditional spread used to miss
  // (`AWS_REGION=CN-NORTH-1 cdkd bootstrap --destroy` previously let the SDK
  // read the raw env value itself and resolve the wrong partition).
  //
  // Same shape as `loadBootstrapContainerRepo`'s `clientRegion`
  // (`src/cli/commands/local-state-loader.ts`): fold, and let absent stay
  // absent.
  const clientRegion = canonicalizeRegion(options.region || process.env['AWS_REGION']) || undefined;

  const awsClients = new AwsClients({
    ...(clientRegion !== undefined && { region: clientRegion }),
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

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
    const rawMarkerKey = getBootstrapMarkerKey(rawRegion);
    let markerBody: string | null;
    // Which key the body actually came from — `parseBootstrapMarker` names it
    // in its error messages, so a malformed marker must point at the file that
    // really was read.
    let resolvedMarkerKey = markerKey;
    try {
      // Issue #2021 folded the canonical-then-raw probe (issue #1995) into
      // `readBootstrapMarkerBody`. THIS caller's policy is unchanged, and it is
      // the strictest of the three: the helper does not catch, so `NoSuchBucket`
      // is still the never-bootstrapped early return below and every other
      // failure still aborts with NOTHING deleted. The `resolvedKey` it reports
      // is also load-bearing here beyond messaging — the teardown DELETES that
      // key (see the plan line and the delete below), and deleting the canonical
      // key when the body came from the raw one would orphan the marker.
      const read = await readBootstrapMarkerBody(stateBackend, rawRegion);
      markerBody = read.body;
      resolvedMarkerKey = read.resolvedKey;
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
    // NOTE a marker that EXISTS at the canonical key but fails to parse still
    // hard-errors below, and now masks a valid marker at the raw key (pre-#1995
    // only the raw key was ever read for an upper-cased region). Same call as
    // `gc.ts` makes, and safe for the same reason: `parseBootstrapMarker` sits
    // outside the try above, so the command aborts with NOTHING deleted, and
    // falling through to another key after finding a CORRUPT one would hide the
    // corruption while the teardown acted on second-choice names — here that
    // means deleting a bucket and repo the user did not mean to name.
    // Every OTHER bootstrap marker in the bucket, relative to the one just
    // resolved. Used by the `--include-state-bucket` guards, by the
    // surviving-sibling warning after the teardown, AND by the not-found
    // message below — so all three see the same listing-derived set rather
    // than independently-guessed key probes.
    //
    // Taken BEFORE the `markerBody === null` early return, which is the whole
    // point: with only `cdkd-bootstrap/Us-East-1.json` present, both probes
    // miss, and a listing taken after the return never happens — the command
    // reported "nothing to delete" and exited 0 while that marker's asset
    // bucket and ECR repository kept billing. That is the failure direction
    // this file's header calls the worse one, reached through the not-found
    // door instead of the teardown door.
    //
    // Failure policy is split on purpose. The listing needs `s3:ListBucket`,
    // which a plain `--destroy` never used to require, so a policy without it
    // must not turn a working teardown into a hard failure: warn and continue
    // with an empty set. Under `--include-state-bucket` the same listing is
    // load-bearing — it is the ONLY thing standing between the user and a
    // deleted state bucket whose sibling markers named surviving storage — so
    // there it stays fatal.
    let markerSiblings: { otherRegions: string[]; sameRegionKeys: string[] } = {
      otherRegions: [],
      sameRegionKeys: [],
    };
    // Whether the set above is a MEASUREMENT or just a default. An empty
    // `sameRegionKeys` means "no sibling" only when the listing succeeded; on
    // the fail-open arm it means "could not look", and conflating the two
    // re-opens the very case this scan exists to catch — the sibling-only
    // teardown would print "nothing to delete" plus the harmful re-bootstrap
    // hint and exit 0, exactly as it did before the scan was added.
    let markerListingSucceeded = true;
    try {
      markerSiblings = await listBootstrapMarkerSiblings(stateBackend, region, resolvedMarkerKey);
    } catch (error) {
      markerListingSucceeded = false;
      if (options.includeStateBucket) {
        throw new CdkdError(
          `Cannot verify which bootstrap markers the state bucket '${bucketName}' still ` +
            `holds (listing '${BOOTSTRAP_MARKER_PREFIX}' failed), and --include-state-bucket ` +
            `deletes every one of them. Grant s3:ListBucket on this bucket and re-run.`,
          'STATE_BUCKET_MARKER_SCAN_FAILED',
          error as Error
        );
      }
      logger.warn(
        `Could not list bootstrap markers under '${BOOTSTRAP_MARKER_PREFIX}' ` +
          `(${error instanceof Error ? error.message : String(error)}). Continuing — this ` +
          `only means a marker for this region under another spelling of its name would ` +
          `not be reported.`
      );
    }

    let marker: BootstrapMarker | undefined;
    if (markerBody === null) {
      const probed = rawMarkerKey === markerKey ? markerKey : `${markerKey}, ${rawMarkerKey}`;
      logger.info(
        `No bootstrap marker for region '${region}' (${probed}) — asset storage ` +
          `is not opted in for this region (or was already destroyed); nothing to delete.`
      );
      if (markerSiblings.sameRegionKeys.length > 0) {
        // The door this early return used to slam. These markers name asset
        // storage that is still alive and still billing, and neither probe
        // spelled their key — so without this the run exits 0 having said
        // nothing about them.
        for (const siblingKey of markerSiblings.sameRegionKeys) {
          logger.warn(
            `A bootstrap marker for this region DOES exist at '${siblingKey}', under a ` +
              `different spelling of the region name — its asset bucket and ECR ` +
              `repository are still alive. Re-run ` +
              `'cdkd bootstrap --destroy --region ${markerRegionOfKey(siblingKey)}' to tear ` +
              `it down.`
          );
        }
      }
      if (!options.includeStateBucket) {
        // Only suggest re-bootstrapping when a successful listing PROVED there
        // is no sibling: with one present the advice is actively harmful, since
        // `cdkd bootstrap` would write a SECOND marker at the canonical key
        // with DEFAULT names, and the next destroy would tear down that
        // default-named storage while the custom-named storage behind the
        // sibling survives untouched. When the listing could not be made, say
        // so instead of implying the absence was verified.
        if (!markerListingSucceeded) {
          // WARN, not info, to match its neighbours: this is a caution about a
          // DESTRUCTIVE follow-up (re-bootstrapping blind), not a hint.
          logger.warn(
            `The bootstrap-marker listing could not be made, so it is NOT known whether ` +
              `this region has a marker under another spelling of its name. Check ` +
              `'s3://${bucketName}/${BOOTSTRAP_MARKER_PREFIX}' before re-bootstrapping — ` +
              `re-running 'cdkd bootstrap' while one exists writes a SECOND marker with ` +
              `DEFAULT names, and the next destroy would then tear down that storage ` +
              `while the storage the existing marker names survives.`
          );
        } else if (markerSiblings.sameRegionKeys.length === 0) {
          logger.info(
            `If the asset bucket / ECR repo still exist without a marker, re-run ` +
              `'cdkd bootstrap --region ${region}' to recreate the marker, then destroy again.`
          );
        }
        return;
      }
    } else {
      marker = parseBootstrapMarker(markerBody, resolvedMarkerKey);
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
      if (markerSiblings.otherRegions.length > 0) {
        throw new CdkdError(
          `Refusing to delete state bucket '${bucketName}': region(s) ` +
            `${markerSiblings.otherRegions.join(', ')} are still opted in to cdkd asset ` +
            `storage (their bootstrap markers live in this bucket). Run ` +
            `'cdkd bootstrap --destroy --region <r>' for each first.`,
          'STATE_BUCKET_HOLDS_MARKERS'
        );
      }
      if (markerSiblings.sameRegionKeys.length > 0) {
        // Same region under another SPELLING. Folding the comparison above is
        // what stops these being mis-reported as "other" regions — but dropping
        // them from the guard without catching them here is worse than the bug
        // it fixed: this run deletes exactly ONE marker key, so the siblings
        // would go with the state bucket while the asset bucket and ECR repo
        // they name survive, nameless and unreachable. The raw compare
        // accidentally prevented that; this arm does it deliberately.
        // Nothing has been deleted on this path, so — unlike the post-teardown
        // warning, where the canonical key is already gone — a per-key
        // `--region <spelling>` can be actively WRONG: while the canonical key
        // still exists, probe 1 resolves IT first, and the run would tear down
        // the canonical marker's storage rather than the one the message named.
        // So the remedy is only per-key when the canonical key is absent.
        const canonicalStillPresent = markerBody !== null && resolvedMarkerKey === markerKey;
        const listing = markerSiblings.sameRegionKeys
          .map((k) =>
            canonicalStillPresent
              ? `  - ${k}`
              : `  - ${k}  (cdkd bootstrap --destroy --region ${markerRegionOfKey(k)})`
          )
          .join('\n');
        const remedy = canonicalStillPresent
          ? `Run 'cdkd bootstrap --destroy --region ${region}' WITHOUT ` +
            `--include-state-bucket ONCE: it tears down '${resolvedMarkerKey}' and then ` +
            `prints the exact --region spelling for each marker still standing. Follow ` +
            `those, then re-run with --include-state-bucket. (No per-marker spelling is ` +
            `given here because '${resolvedMarkerKey}' still exists and would be resolved ` +
            `first — and simply repeating this same command would not clear the rest, ` +
            `since once it is gone this region's canonical key no longer resolves ` +
            `anything.)`
          : `Run the command shown against each marker above, then re-run with ` +
            `--include-state-bucket.`;
        throw new CdkdError(
          `Refusing to delete state bucket '${bucketName}': region '${region}' has ` +
            `${markerSiblings.sameRegionKeys.length} further bootstrap marker(s) under a ` +
            `different spelling of its name, which this teardown does not delete:\n` +
            `${listing}\n${remedy}\n` +
            `Destroy each one first — deleting the state bucket now would remove those ` +
            `markers while the asset storage they name survives, with no record of its ` +
            `names.`,
          // Distinct from the other-region refusal above: same bucket, but a
          // different situation and a different remedy, and a consumer that
          // cannot tell them apart cannot act on either.
          'STATE_BUCKET_HOLDS_SIBLING_MARKERS'
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
      // `resolvedMarkerKey`, NOT `markerKey`: with the two-probe read (issue
      // #1995) the marker may have come from the un-folded key, and deleting
      // the canonical one would be a silent no-op — the bucket and repo gone
      // while the marker survives, pointing every later command at storage
      // that no longer exists. The plan line has to name the same file the
      // teardown will actually remove.
      planLines.push(`Bootstrap marker: s3://${bucketName}/${resolvedMarkerKey} (deleted last)`);
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
      await stateBackend.deleteRawObjects([resolvedMarkerKey]);
      logger.info(`✓ Deleted bootstrap marker (${resolvedMarkerKey})`);

      // A region bootstrapped TWICE under two spellings has two markers. The
      // read above takes the first one that exists, so the sibling survives —
      // and it names asset storage this run did NOT destroy.
      //
      // WARN rather than delete, deliberately. The two markers may carry
      // DIFFERENT custom names (issue #1011), and the marker is the only
      // machine-readable record of them, so deleting one we never read would
      // orphan its bucket and repo namelessly — the irreversible direction,
      // and the same reasoning the integ fixture's cleanup uses when it
      // refuses to drop a marker whose bucket still exists. The remedy is
      // simply to run the command again: the canonical key is gone now, so
      // the next run's second probe finds the sibling and tears it down.
      //
      // Derived from the marker LISTING, not from a probe of `rawMarkerKey`:
      // a region can hold a marker under ANY spelling, so a probe that guesses
      // two keys leaves a third (`Us-East-1.json`) unmentioned.
      //
      // Each remedy names the surviving key's OWN region spelling, which is the
      // only one that reaches it: the canonical key is gone now, so a re-run
      // with the canonical spelling probes it once, finds nothing, and reports
      // "nothing to delete" — the same unreachable-marker trap this command's
      // two-probe read exists to avoid, and one this warning would otherwise
      // re-create in its own remediation.
      for (const siblingKey of markerSiblings.sameRegionKeys) {
        logger.warn(
          `A further bootstrap marker for this region remains at '${siblingKey}' ` +
            `(this region was bootstrapped under more than one spelling of its name). ` +
            `It names asset storage that was NOT destroyed by this run — re-run ` +
            `'cdkd bootstrap --destroy --region ${markerRegionOfKey(siblingKey)}' to ` +
            `tear that one down too.`
        );
      }
      if (!markerListingSucceeded) {
        // The not-found path restates this (see the withheld-hint branch above);
        // the teardown path must too, or "storage is now OFF" reads as verified
        // when a sibling marker under another spelling may still be live.
        logger.warn(
          `The bootstrap-marker listing could not be made, so a marker under another ` +
            `spelling of this region may still be live. Check ` +
            `'s3://${bucketName}/${BOOTSTRAP_MARKER_PREFIX}'.`
        );
      }
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
