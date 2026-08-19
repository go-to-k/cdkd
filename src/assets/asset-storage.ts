import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutBucketEncryptionCommand,
  PutBucketPolicyCommand,
  PutPublicAccessBlockCommand,
  type BucketLocationConstraint,
} from '@aws-sdk/client-s3';
import {
  ECRClient,
  DescribeRepositoriesCommand,
  CreateRepositoryCommand,
  PutImageTagMutabilityCommand,
} from '@aws-sdk/client-ecr';
import { getLogger } from '../utils/logger.js';
import { CdkdError, normalizeAwsError } from '../utils/error-handler.js';
import type { S3StateBackend } from '../state/s3-state-backend.js';
import { buildDenyExternalAccessPolicy } from '../utils/deny-external-access-policy.js';
import { canonicalizeRegion } from '../utils/aws-partition.js';

/**
 * cdkd-owned asset storage — naming, bootstrap marker, and deploy-time
 * asset-mode detection (issue #1002, design at
 * docs/design/1002-cdkd-asset-storage.md).
 *
 * Why this exists: cdkd publishes assets to the CDK bootstrap bucket / ECR
 * repo, but `cdk gc` decides "in use" by scanning CloudFormation stack
 * templates — cdkd-deployed stacks have no CFn stack, so every cdkd-published
 * asset looks isolated and gets deleted. The fix is cdkd-owned asset storage
 * created by `cdkd bootstrap` (structurally out of `cdk gc`'s reach because
 * gc only discovers storage from the CDK bootstrap stack's outputs).
 *
 * The upgrade is strictly transparent: deploys behave byte-identically to
 * before until the user re-runs `cdkd bootstrap` for a region, which writes a
 * per-region marker object into the state bucket. Deploy reads the marker to
 * pick the mode; PR 2 of the phasing wires the actual publish redirection +
 * template rewrite onto the `cdkd-assets` mode resolved here.
 */

/** Marker schema version, bumped if the marker shape ever changes. */
export const ASSET_SUPPORT_VERSION = 1;

/**
 * S3 key prefix for bootstrap markers in the state bucket. Deliberately
 * outside the `cdkd/` state prefix so `state list` key-listing never mistakes
 * a marker for a stack, and concurrent bootstraps in two regions cannot race
 * last-writer-wins on a shared object (design §12.1).
 */
export const BOOTSTRAP_MARKER_PREFIX = 'cdkd-bootstrap/';

/**
 * Name of the cdkd-owned asset bucket for an (account, region) pair.
 * Per-region because Lambda requires the code bucket to be in the function's
 * region — the same reason CDK's asset bucket is per-region (design §3).
 */
export function getCdkdAssetBucketName(accountId: string, region: string): string {
  return `cdkd-assets-${accountId}-${region}`;
}

/**
 * Name of the cdkd-owned container-asset ECR repository for an
 * (account, region) pair. ECR repos are account+region scoped by ARN, so the
 * suffix is not strictly needed — the CDK-parallel shape keeps the future
 * template rewrite uniform and the names self-describing (design §3).
 */
export function getCdkdContainerRepoName(accountId: string, region: string): string {
  return `cdkd-container-assets-${accountId}-${region}`;
}

/**
 * State-bucket key of the bootstrap marker for a region.
 */
export function getBootstrapMarkerKey(region: string): string {
  return `${BOOTSTRAP_MARKER_PREFIX}${region}.json`;
}

/**
 * Outcome of {@link readBootstrapMarkerBody}.
 */
export interface BootstrapMarkerRead {
  /** The marker body, or `null` when neither spelling of the key exists. */
  body: string | null;
  /**
   * The key the body ACTUALLY came from. On a miss this is the canonical key.
   *
   * Every caller must follow it rather than re-deriving `getBootstrapMarkerKey`:
   * `parseBootstrapMarker` names it in its error messages, `cdkd gc` prints it,
   * and `cdkd bootstrap --destroy` DELETES it — deleting the canonical key when
   * the body came from the raw one orphans the marker (a review catch on issue
   * #1995's PR).
   */
  resolvedKey: string;
}

/**
 * Read a region's bootstrap marker, probing the CANONICAL key first and the
 * region's RAW spelling second (issues #1836 / #1995 / #2021).
 *
 * Why two probes: the READ side folds region case (SDK endpoint resolution is
 * case-sensitive, and folding also keeps one region from occupying two cache
 * slots), but the WRITE side does not — `cdkd bootstrap` derives its region as
 * `options.region || AWS_REGION || 'us-east-1'` verbatim and uses that spelling
 * for {@link getBootstrapMarkerKey}. Aligning the write side is issue #1820's
 * lane; until then this read is independent of it.
 *
 * HOW REACHABLE the raw key actually is (measured for #2021, because this PR
 * turns the probe into a SHARED contract for four callers and the earlier
 * per-caller comments overstated it). A plain `AWS_REGION=US-EAST-1 cdkd
 * bootstrap` CANNOT write `cdkd-bootstrap/US-EAST-1.json`: the marker is
 * written LAST, and both resources have to be created first with names derived
 * from that same raw region — `getCdkdAssetBucketName` yields
 * `cdkd-assets-<acct>-US-EAST-1`, which S3 rejects as a bucket name, and
 * `region !== 'us-east-1'` is true for `US-EAST-1` so `CreateBucket` is also
 * handed `LocationConstraint: 'US-EAST-1'`, an invalid enum value. The
 * conventional name is never run through `validateAssetBucketName` (that guards
 * only `--asset-bucket`), so it fails at S3 rather than earlier. The raw key is
 * therefore reachable only when ALL of these hold:
 *
 * 1. both `--asset-bucket` and `--container-repo` are given as valid lowercase
 *    names, so neither conventional name is derived from the raw region; AND
 * 2. the asset bucket ALREADY EXISTS and is owned by this account, so the
 *    `CreateBucket` carrying the bad `LocationConstraint` is never issued;
 *
 * plus, outside that flow, a marker written by hand or by a cdkd predating
 * those guards. Probe 2 is kept rather than dropped because that state is real
 * and losing it silently re-points a bootstrapped region at `cdk gc`-collectable
 * storage — the exact #2021 failure — while the cost is one extra `GetObject`
 * on a non-canonical region only. It is skipped entirely when the region was
 * already canonical, so the common path still costs exactly one `GetObject`.
 * Both conditions are pinned by tests, so this claim cannot rot silently.
 *
 * This helper deliberately does NOT catch: each caller keeps its own policy on
 * top (`cdkd gc` / `cdkd bootstrap --destroy` translate `NoSuchBucket` into a
 * "never bootstrapped" message and hard-error on anything else;
 * `loadBootstrapContainerRepo` is best-effort and warns-and-falls-back).
 */
export async function readBootstrapMarkerBody(
  stateBackend: Pick<S3StateBackend, 'getRawObject'>,
  rawRegion: string,
  opts: { logPrefix?: string } = {}
): Promise<BootstrapMarkerRead> {
  const canonicalKey = getBootstrapMarkerKey(canonicalizeRegion(rawRegion));
  const rawKey = getBootstrapMarkerKey(rawRegion);

  const body = await stateBackend.getRawObject(canonicalKey);
  if (body !== null || rawKey === canonicalKey) {
    return { body, resolvedKey: canonicalKey };
  }

  const rawBody = await stateBackend.getRawObject(rawKey);
  if (rawBody === null) {
    // Neither spelling exists — report the CANONICAL key as the resolved one,
    // so a caller's not-found message names the key a canonical-region
    // `cdkd bootstrap` would write.
    return { body: null, resolvedKey: canonicalKey };
  }

  const subject = opts.logPrefix ? `${opts.logPrefix}: bootstrap marker` : 'Bootstrap marker';
  getLogger().debug(
    `${subject} found at the un-folded key '${rawKey}' (none at '${canonicalKey}') — ` +
      `an upper-cased region was used at 'cdkd bootstrap' time.`
  );
  return { body: rawBody, resolvedKey: rawKey };
}

/**
 * Pragmatic S3 bucket-name check for `cdkd bootstrap --asset-bucket`
 * (issue #1011): 3-63 chars, lowercase letters / digits / dots / hyphens,
 * starting and ending with a letter or digit. Rejecting before any AWS call
 * gives a clearer error than S3's own `InvalidBucketName`.
 */
const ASSET_BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/**
 * Pragmatic ECR repository-name check for `cdkd bootstrap --container-repo`
 * (issue #1011): 2-256 chars of `[a-z0-9]` runs joined by single `.` / `_` /
 * `-` / `/` separators (no leading / trailing / doubled separators).
 */
const CONTAINER_REPO_NAME_PATTERN = /^[a-z0-9]+(?:[._\-/][a-z0-9]+)*$/;

/**
 * Validate a custom asset bucket name (`cdkd bootstrap --asset-bucket`).
 * Throws before any AWS call so a typo never reaches S3.
 */
export function validateAssetBucketName(name: string): void {
  if (!ASSET_BUCKET_NAME_PATTERN.test(name)) {
    throw new CdkdError(
      `--asset-bucket '${name}' is not a valid S3 bucket name. Bucket names must be ` +
        `3-63 characters of lowercase letters, digits, dots, and hyphens, and must ` +
        `start and end with a letter or digit.`,
      'INVALID_ASSET_STORAGE_NAME'
    );
  }
}

/**
 * Validate a custom container-asset ECR repository name
 * (`cdkd bootstrap --container-repo`). Throws before any AWS call.
 */
export function validateContainerRepoName(name: string): void {
  if (name.length < 2 || name.length > 256 || !CONTAINER_REPO_NAME_PATTERN.test(name)) {
    throw new CdkdError(
      `--container-repo '${name}' is not a valid ECR repository name. Repository names ` +
        `must be 2-256 characters of lowercase letters and digits, optionally separated ` +
        `by single '.', '_', '-', or '/' characters (no leading, trailing, or doubled ` +
        `separators).`,
      'INVALID_ASSET_STORAGE_NAME'
    );
  }
}

/**
 * Bootstrap marker object written by `cdkd bootstrap` to
 * `s3://{stateBucket}/cdkd-bootstrap/{region}.json`. Its presence records
 * explicit user intent ("I ran the new bootstrap for this region") — chosen
 * over a `HeadBucket` probe on the conventional name because a marker is
 * immune to name-squatting / coincidence and gives future custom-name
 * support a natural home (design §4.1).
 */
export interface BootstrapMarker {
  /** cdkd-owned S3 bucket that file assets will be published to. */
  assetBucket: string;
  /** cdkd-owned ECR repository that container-image assets will be pushed to. */
  containerRepo: string;
  /** Marker schema version ({@link ASSET_SUPPORT_VERSION}). */
  assetSupportVersion: number;
  /** ISO-8601 timestamp of the bootstrap run that wrote the marker. */
  createdAt: string;
}

/**
 * Deploy-time asset mode for one (account, region) pair.
 *
 * - `legacy` — no marker: publish to the `assets.json` destinations verbatim,
 *   byte-identical to pre-#1002 behavior.
 * - `cdkd-assets` — marker present: assets belong in the cdkd-owned storage
 *   named by the marker (redirection + rewrite land in PR 2 of the phasing).
 */
export type AssetMode = { mode: 'legacy' } | { mode: 'cdkd-assets'; marker: BootstrapMarker };

/**
 * Parse and validate a bootstrap marker body.
 *
 * Throws on malformed JSON or missing required fields — a corrupt marker is
 * treated like the marker-present-but-resources-missing case (hard error,
 * never a silent legacy fallback that would flip-flop stack properties
 * between deploys — design §4.1).
 */
export function parseBootstrapMarker(body: string, markerKey: string): BootstrapMarker {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new CdkdError(
      `Bootstrap marker '${markerKey}' in the state bucket is not valid JSON. ` +
        `Re-run 'cdkd bootstrap' for this region to rewrite it.`,
      'INVALID_BOOTSTRAP_MARKER',
      error as Error
    );
  }
  const marker = parsed as Partial<BootstrapMarker>;
  // Version check FIRST: a future marker version may rename / remove the
  // v1 required fields, and classifying it as merely "malformed" would let
  // ensureAssetStorage's corrupt-marker rewrite path clobber it with v1
  // semantics — exactly what this guard exists to prevent.
  if (
    typeof marker.assetSupportVersion === 'number' &&
    marker.assetSupportVersion > ASSET_SUPPORT_VERSION
  ) {
    // A newer cdkd wrote this marker with semantics this binary does not
    // know. Interpreting it under v1 rules could publish to the wrong
    // destination — hard error instead (the marker is the user's explicit
    // opt-in, so silent legacy fallback is equally wrong here).
    throw new CdkdError(
      `Bootstrap marker '${markerKey}' has assetSupportVersion ` +
        `${marker.assetSupportVersion}, but this cdkd only understands up to ` +
        `${ASSET_SUPPORT_VERSION}. Upgrade cdkd to deploy in this region.`,
      'UNSUPPORTED_BOOTSTRAP_MARKER_VERSION'
    );
  }
  if (
    typeof marker.assetBucket !== 'string' ||
    marker.assetBucket.length === 0 ||
    typeof marker.containerRepo !== 'string' ||
    marker.containerRepo.length === 0 ||
    typeof marker.assetSupportVersion !== 'number'
  ) {
    throw new CdkdError(
      `Bootstrap marker '${markerKey}' in the state bucket is malformed ` +
        `(missing assetBucket / containerRepo / assetSupportVersion). ` +
        `Re-run 'cdkd bootstrap' for this region to rewrite it.`,
      'INVALID_BOOTSTRAP_MARKER'
    );
  }
  return {
    assetBucket: marker.assetBucket,
    containerRepo: marker.containerRepo,
    assetSupportVersion: marker.assetSupportVersion,
    createdAt: typeof marker.createdAt === 'string' ? marker.createdAt : '',
  };
}

/**
 * Verify that the asset bucket + ECR repo named by a marker actually exist.
 *
 * Called when a marker is present: the user opted the region in, so missing
 * resources (user deleted them) are a hard error naming the missing resource
 * and the `cdkd bootstrap` fix — never a silent fallback to CDK bootstrap
 * storage (design §4.1).
 *
 * Every S3 call passes `ExpectedBucketOwner` so a marker pointing at a
 * since-recreated foreign bucket can never leak assets cross-account
 * (bucket-squatting defense, design §5).
 */
export async function verifyAssetStorageExists(
  marker: BootstrapMarker,
  accountId: string,
  region: string,
  opts: { profile?: string } = {}
): Promise<void> {
  const rebootstrapHint = `Run 'cdkd bootstrap --region ${region}' to recreate it. cdkd never silently falls back to CDK bootstrap asset storage once a region is opted in.`;

  // `--profile` must reach these probes: with the default chain resolving a
  // DIFFERENT account, the asset bucket's own deny-external-account policy
  // turns HeadBucket into a 403 and the error below misreports a foreign
  // bucket.
  const clientOpts = { region, ...(opts.profile && { profile: opts.profile }) };
  const s3Client = new S3Client(clientOpts);
  const ecrClient = new ECRClient(clientOpts);
  try {
    try {
      await s3Client.send(
        new HeadBucketCommand({ Bucket: marker.assetBucket, ExpectedBucketOwner: accountId })
      );
    } catch (error) {
      const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (err.name === 'NotFound' || err.name === 'NoSuchBucket') {
        throw new CdkdError(
          `cdkd asset storage is bootstrapped for region '${region}' but the asset bucket ` +
            `'${marker.assetBucket}' is missing. ${rebootstrapHint}`,
          'ASSET_STORAGE_MISSING'
        );
      }
      if (err.$metadata?.httpStatusCode === 403) {
        throw new CdkdError(
          `Asset bucket '${marker.assetBucket}' exists but is not owned by account ` +
            `${accountId} (or access is denied). Refusing to use it. ${rebootstrapHint}`,
          'ASSET_STORAGE_FOREIGN_BUCKET',
          error as Error
        );
      }
      throw error;
    }

    try {
      await ecrClient.send(
        new DescribeRepositoriesCommand({ repositoryNames: [marker.containerRepo] })
      );
    } catch (error) {
      const err = error as { name?: string };
      if (err.name === 'RepositoryNotFoundException') {
        throw new CdkdError(
          `cdkd asset storage is bootstrapped for region '${region}' but the container-asset ` +
            `ECR repository '${marker.containerRepo}' is missing. ${rebootstrapHint}`,
          'ASSET_STORAGE_MISSING'
        );
      }
      throw error;
    }
  } finally {
    s3Client.destroy();
    ecrClient.destroy();
  }
}

/**
 * Options for {@link ensureAssetStorage}. Clients are injected so the
 * bootstrap command wires real region-scoped clients and unit tests wire
 * mocks.
 */
export interface EnsureAssetStorageOptions {
  /** S3 client scoped to `region` (asset bucket lives there). */
  s3Client: S3Client;
  /** ECR client scoped to `region`. */
  ecrClient: ECRClient;
  /** State backend for the marker write (resolves the state bucket's own region). */
  stateBackend: S3StateBackend;
  accountId: string;
  region: string;
  /** Re-apply bucket encryption/policy + repo tag-mutability on existing resources. */
  force: boolean;
  /**
   * Custom asset bucket name (`cdkd bootstrap --asset-bucket`, issue #1011).
   * Overrides the conventional `cdkd-assets-{acct}-{region}` name for the
   * existence probe, the create calls, and the value written into the
   * marker (the marker is the single source of truth for every consumer
   * afterward). Must not conflict with an existing marker's name — see the
   * conflict check in {@link ensureAssetStorage}. The deploy-time
   * auto-create (issue #1007) never passes this: custom names require the
   * explicit `cdkd bootstrap`.
   */
  assetBucketName?: string;
  /** Custom container-asset ECR repo name (`--container-repo`) — see {@link assetBucketName}. */
  containerRepoName?: string;
}

/**
 * Create (or adopt, when already owned by this account) the cdkd asset
 * bucket + container-asset ECR repo for a region, then write the bootstrap
 * marker. Called by `cdkd bootstrap` unless `--no-assets` is passed.
 *
 * Idempotent like the state-bucket path: existing resources are left as-is
 * unless `force` re-applies their configuration. The marker is written LAST,
 * only after both resources exist (design §5) — a crash mid-bootstrap leaves
 * no marker, so deploys stay in legacy mode.
 *
 * Bucket-squatting defense: the bucket name is predictable (same weakness as
 * CDK's bootstrap bucket), so this refuses to adopt a bucket this account
 * does not own, and the `HeadBucket` probe passes `ExpectedBucketOwner`.
 * A CUSTOM bucket name (issue #1011) goes through the exact same probe /
 * refusal path — custom names get the identical squatting defense.
 *
 * Name resolution (issue #1011): an explicit custom name
 * ({@link EnsureAssetStorageOptions.assetBucketName} /
 * {@link EnsureAssetStorageOptions.containerRepoName}) wins; otherwise an
 * existing marker's name is reused (so a plain re-bootstrap of a region
 * bootstrapped with custom names keeps them instead of creating a second,
 * conventional set); otherwise the conventional name. A custom name that
 * DIFFERS from an existing marker's name is a hard error — re-pointing a
 * region at different storage requires `cdkd bootstrap --destroy` first.
 */
export async function ensureAssetStorage(
  options: EnsureAssetStorageOptions
): Promise<{ assetBucket: string; containerRepo: string }> {
  const logger = getLogger();
  const { s3Client, ecrClient, stateBackend, accountId, region, force } = options;

  // 0. Existing-marker read (issue #1011) — needed both to reuse a custom
  // name on plain re-bootstrap and to refuse a conflicting custom name.
  //
  // Deliberately NOT folded onto `readBootstrapMarkerBody` (issue #2021): this
  // read is paired with the marker WRITE at the bottom of this function, and
  // both use the same raw `region`. Folding the read alone would break that
  // pairing — a bootstrap under `US-EAST-1` would read `cdkd-bootstrap/
  // us-east-1.json` and then write `cdkd-bootstrap/US-EAST-1.json`, so a custom
  // name recorded by an earlier run would stop being reused and a conflicting
  // one would stop being refused. Aligning the WRITE side (and with it the
  // asset bucket / ECR repo NAMES this same `region` builds) is issue #1820's
  // lane; this read follows it, whichever spelling that lands on.
  const markerKey = getBootstrapMarkerKey(region);
  let existingMarker: BootstrapMarker | null = null;
  const existingBody = await stateBackend.getRawObject(markerKey);
  if (existingBody !== null) {
    try {
      existingMarker = parseBootstrapMarker(existingBody, markerKey);
    } catch (error) {
      if (error instanceof CdkdError && error.code === 'UNSUPPORTED_BOOTSTRAP_MARKER_VERSION') {
        // A newer cdkd wrote this marker — clobbering it with v1 semantics
        // could re-point deploys at the wrong storage. Same hard error as
        // the deploy-time read.
        throw error;
      }
      // Corrupt / malformed marker: re-running bootstrap is the documented
      // fix ("Re-run 'cdkd bootstrap' ... to rewrite it"), so treat it as
      // absent and rewrite it below.
      logger.warn(
        `Bootstrap marker '${markerKey}' is malformed — rewriting it as part of this bootstrap.`
      );
    }
  }

  if (existingMarker) {
    const conflicts: string[] = [];
    if (options.assetBucketName && options.assetBucketName !== existingMarker.assetBucket) {
      conflicts.push(
        `asset bucket '${existingMarker.assetBucket}' (requested '${options.assetBucketName}')`
      );
    }
    if (options.containerRepoName && options.containerRepoName !== existingMarker.containerRepo) {
      conflicts.push(
        `container repo '${existingMarker.containerRepo}' (requested '${options.containerRepoName}')`
      );
    }
    if (conflicts.length > 0) {
      throw new CdkdError(
        `Region '${region}' is already bootstrapped with ${conflicts.join(' and ')}. ` +
          `Changing asset storage names would strand the existing storage and every ` +
          `published asset in it — run 'cdkd bootstrap --destroy --region ${region}' to ` +
          `tear the region's asset storage down first, then re-run bootstrap with the ` +
          `new names.`,
        'ASSET_STORAGE_NAME_CONFLICT'
      );
    }
  }

  const assetBucket =
    options.assetBucketName ??
    existingMarker?.assetBucket ??
    getCdkdAssetBucketName(accountId, region);
  const containerRepo =
    options.containerRepoName ??
    existingMarker?.containerRepo ??
    getCdkdContainerRepoName(accountId, region);

  // 1. Asset bucket.
  let bucketExists = false;
  try {
    await s3Client.send(
      new HeadBucketCommand({ Bucket: assetBucket, ExpectedBucketOwner: accountId })
    );
    bucketExists = true;
    logger.info(`Asset bucket ${assetBucket} already exists`);
  } catch (error) {
    const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === 'NotFound' || err.name === 'NoSuchBucket') {
      // Will create below.
    } else if (err.$metadata?.httpStatusCode === 403) {
      throw new CdkdError(
        `Asset bucket name '${assetBucket}' is already taken by a bucket this account ` +
          `does not own (or access is denied). Refusing to adopt it — resolve the ` +
          `naming conflict before re-running 'cdkd bootstrap'.`,
        'ASSET_STORAGE_FOREIGN_BUCKET',
        error as Error
      );
    } else {
      throw normalizeAwsError(error, { bucket: assetBucket, operation: 'HeadBucket' });
    }
  }

  if (!bucketExists) {
    logger.info(`Creating asset bucket: ${assetBucket} in region ${region}`);
    try {
      await s3Client.send(
        new CreateBucketCommand({
          Bucket: assetBucket,
          // For regions other than us-east-1, LocationConstraint is required.
          ...(region !== 'us-east-1' && {
            CreateBucketConfiguration: {
              LocationConstraint: region as BucketLocationConstraint,
            },
          }),
        })
      );
      logger.info(`✓ Created asset bucket: ${assetBucket}`);
    } catch (error) {
      const err = error as { name?: string };
      if (err.name === 'BucketAlreadyOwnedByYou') {
        // Raced with a concurrent bootstrap of the same account — fine.
        logger.info(`Asset bucket ${assetBucket} already exists`);
      } else if (err.name === 'BucketAlreadyExists') {
        throw new CdkdError(
          `Asset bucket name '${assetBucket}' is already taken by another AWS account. ` +
            `Refusing to adopt it — resolve the naming conflict before re-running ` +
            `'cdkd bootstrap'.`,
          'ASSET_STORAGE_FOREIGN_BUCKET',
          error as Error
        );
      } else {
        throw normalizeAwsError(error, { bucket: assetBucket, operation: 'CreateBucket' });
      }
    }
  }

  if (!bucketExists || force) {
    // Encryption AES-256 + BucketKey, public-access block, same
    // deny-external-account policy as the state bucket. Deliberately NO
    // versioning — assets are immutable content-addressed blobs (design §5).
    // `ExpectedBucketOwner` on every configuration PUT closes the
    // (tiny) window between the ownership probe above and these writes.
    await s3Client.send(
      new PutBucketEncryptionCommand({
        Bucket: assetBucket,
        ExpectedBucketOwner: accountId,
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
    await s3Client.send(
      new PutPublicAccessBlockCommand({
        Bucket: assetBucket,
        ExpectedBucketOwner: accountId,
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      })
    );
    await s3Client.send(
      new PutBucketPolicyCommand({
        Bucket: assetBucket,
        ExpectedBucketOwner: accountId,
        // The partition comes from the CLIENT that creates the bucket, not
        // from the `region` option. They usually agree — the auto-create path
        // builds a `region`-scoped client — but `cdkd bootstrap` passes the
        // shared `awsClients.s3`, whose region the SDK chain resolves from the
        // profile when `--region` is absent, while its `region` option falls
        // back to a hardcoded `us-east-1`. Deriving from the client is what
        // keeps the ARN naming the partition the bucket is actually in (the
        // same defect the state-bucket policy in `bootstrap.ts` carries; found
        // by the issue #1794 PR review). That divergence also mis-NAMES the
        // bucket (`getCdkdAssetBucketName` uses the option) — a separate
        // pre-existing bug, tracked in issue #1820.
        Policy: JSON.stringify(
          buildDenyExternalAccessPolicy(assetBucket, accountId, await s3Client.config.region())
        ),
      })
    );
    logger.info(
      '✓ Configured asset bucket (AES-256 encryption, public access block, deny external access)'
    );
  }

  // 2. Container-asset ECR repo. Repos are account-scoped, so an existing
  // repo is always ours — no squatting concern on this leg.
  let repoExists = false;
  try {
    await ecrClient.send(new DescribeRepositoriesCommand({ repositoryNames: [containerRepo] }));
    repoExists = true;
    logger.info(`Container-asset repository ${containerRepo} already exists`);
  } catch (error) {
    const err = error as { name?: string };
    if (err.name !== 'RepositoryNotFoundException') {
      throw error;
    }
  }

  if (!repoExists) {
    logger.info(`Creating container-asset ECR repository: ${containerRepo}`);
    try {
      await ecrClient.send(
        new CreateRepositoryCommand({
          repositoryName: containerRepo,
          // Tags are content hashes — immutable, matching CDK bootstrap.
          imageTagMutability: 'IMMUTABLE',
        })
      );
      logger.info(`✓ Created container-asset ECR repository: ${containerRepo}`);
    } catch (error) {
      const err = error as { name?: string };
      if (err.name === 'RepositoryAlreadyExistsException') {
        logger.info(`Container-asset repository ${containerRepo} already exists`);
      } else {
        throw error;
      }
    }
  } else if (force) {
    await ecrClient.send(
      new PutImageTagMutabilityCommand({
        repositoryName: containerRepo,
        imageTagMutability: 'IMMUTABLE',
      })
    );
    logger.info('✓ Configured container-asset repository (immutable tags)');
  }

  // 3. Marker write — LAST, only after both resources exist.
  const marker: BootstrapMarker = {
    assetBucket,
    containerRepo,
    assetSupportVersion: ASSET_SUPPORT_VERSION,
    createdAt: new Date().toISOString(),
  };
  await stateBackend.putRawObject(markerKey, JSON.stringify(marker, null, 2));
  logger.info(`✓ Wrote bootstrap marker (${markerKey})`);

  return { assetBucket, containerRepo };
}

/**
 * Deploy-time asset-mode resolver. One instance per CLI invocation; results
 * are cached per region for the process lifetime (the marker read is one
 * GetObject against a bucket every deploy already reads — design §4.1).
 *
 * In legacy mode, one `logger.info` line per legacy region per invocation
 * mentions the `cdk gc` hazard and the exact `cdkd bootstrap --region <r>`
 * opt-in command (info, not warn — existing users are not doing anything
 * wrong; design §12.2). Per-region because opt-in is keyed by each stack's
 * deploy region: a multi-region app can be opted in for one region and
 * legacy for another, and a region-less notice reads as a false negative to
 * a user who just bootstrapped a different region.
 */
export class AssetModeResolver {
  private logger = getLogger().child('AssetMode');
  private cache = new Map<string, Promise<AssetMode>>();
  /**
   * NOT load-bearing today — defense-in-depth only. `resolve` sets `cache`
   * synchronously before the first await, so `doResolve` runs at most once per
   * canonical region, and the notice arm always returns successfully so the
   * failure-eviction path cannot re-enter it. This Set was already ineffective
   * BEFORE the issue #2021 fold (two spellings simply made two entries), so it
   * is not a regression that fold introduced. Kept so removing or bypassing the
   * cache cannot silently turn the notice into one line per resolve.
   */
  private legacyNoticeShownRegions = new Set<string>();
  private stateBackend: S3StateBackend;
  private accountId: string;
  private profile: string | undefined;
  private useCdkBootstrapAssets: boolean;
  private suppressLegacyNotice: boolean;
  private autoCreate: { confirm: (region: string) => Promise<boolean> } | undefined;

  constructor(
    stateBackend: S3StateBackend,
    accountId: string,
    opts: {
      profile?: string;
      /**
       * `--use-cdk-bootstrap-assets` / `cdk.json context.cdkd.useCdkBootstrapAssets`
       * (design §4.2): pin legacy mode for this invocation even when the
       * region's bootstrap marker exists — for apps deployed via both CFn
       * and cdkd during a migration window. Skips the marker read entirely
       * and also suppresses the legacy-mode `cdk gc` notice (the user made
       * an explicit storage choice — design §12.2).
       */
      useCdkBootstrapAssets?: boolean;
      /**
       * Skip the legacy-mode `cdk gc` info line. Used by commands whose
       * invocation publishes nothing (`diff`, `import`) — the notice's
       * "assets are published to..." wording only fits `deploy` /
       * `publish-assets`.
       */
      suppressLegacyNotice?: boolean;
      /**
       * Issue #1007 — auto-create the per-region asset storage on the first
       * deploy into a region with no bootstrap marker, instead of falling
       * back to legacy mode. Restores the "bootstrap once per account" UX:
       * asset storage is inherently regional (Lambda requires same-region
       * S3/ECR), but the per-region step no longer leaks into the workflow.
       * `confirm` gates creation (interactive prompt; `--yes` / non-TTY
       * callers log-and-return-true). A declined confirm or a failed
       * creation falls back to legacy mode + the gc notice — a deploy that
       * used to work must never start hard-failing because S3/ECR create
       * was denied. Only `deploy` passes this (and not under `--dry-run` /
       * `--skip-assets` — the latter would rewrite already-published legacy
       * references to a freshly created EMPTY bucket/repo);
       * `diff` / `import` / `publish-assets` never create resources.
       */
      autoCreate?: { confirm: (region: string) => Promise<boolean> };
    } = {}
  ) {
    this.stateBackend = stateBackend;
    this.accountId = accountId;
    this.profile = opts.profile;
    this.useCdkBootstrapAssets = opts.useCdkBootstrapAssets ?? false;
    this.suppressLegacyNotice = opts.suppressLegacyNotice ?? false;
    this.autoCreate = opts.autoCreate;
  }

  /**
   * Resolve the asset mode for a deploy region. Concurrent callers for the
   * same region share one in-flight resolution.
   *
   * The region arrives UNFOLDED (issue #2021): both deploy-time callers derive
   * it as `options.region || AWS_REGION || 'us-east-1'` and then
   * `stack.region || baseRegion`, so an env-agnostic stack under
   * `--region US-EAST-1` (or `AWS_REGION=US-EAST-1`) hands an upper-cased
   * spelling straight through. A stack whose `env.region` is pinned in CDK is
   * unaffected — `stack.region` comes from the Cloud Assembly and is canonical.
   *
   * Folding at THIS boundary rather than at each caller fixes two things at
   * once: the marker read below (which used to miss `cdkd-bootstrap/
   * us-east-1.json` and silently downgrade the whole region to LEGACY —
   * `cdk gc`-collectable — storage), and the CACHE, where `us-east-1` and
   * `US-EAST-1` occupied two slots and each re-probed S3.
   */
  resolve(rawRegion: string): Promise<AssetMode> {
    if (this.useCdkBootstrapAssets) {
      // Explicit per-app / per-invocation legacy pin: no marker read, no
      // notice — byte-identical to pre-#1002 behavior (design §4.2).
      return Promise.resolve({ mode: 'legacy' });
    }
    const region = canonicalizeRegion(rawRegion);
    // ASYMMETRY this fold introduces, stated rather than left to be found: the
    // cache is keyed by the CANONICAL region, so the first spelling resolved in
    // a run decides whether the raw key is ever probed. A canonical-region stack
    // resolving first caches `legacy`, and a later `--region US-EAST-1` stack
    // reuses that entry without ever probing `cdkd-bootstrap/US-EAST-1.json`.
    // Accepted deliberately over probing per RAW spelling: that would restore
    // the double-slot S3 re-probe this fold exists to remove, and it would buy
    // a key reachable only under the narrow conditions enumerated on
    // `readBootstrapMarkerBody`. The cheaper and permanent fix is #1820 aligning
    // the write side, after which no raw key is written at all.
    const cached = this.cache.get(region);
    if (cached) return cached;
    // The RAW spelling still travels to `doResolve` — it is what the marker's
    // second probe needs (see `readBootstrapMarkerBody`). Everything else,
    // including every AWS client this resolver builds, uses the canonical one.
    const inFlight = this.doResolve(region, rawRegion).catch((error: unknown) => {
      // Do not cache failures — a transient S3 error on the marker read
      // should not poison every later stack in the same run.
      this.cache.delete(region);
      throw error;
    });
    this.cache.set(region, inFlight);
    return inFlight;
  }

  private async doResolve(region: string, rawRegion: string): Promise<AssetMode> {
    const { body, resolvedKey } = await readBootstrapMarkerBody(this.stateBackend, rawRegion);

    if (body === null) {
      if (this.autoCreate) {
        // The auto-create WRITES through `ensureAssetStorage` with the
        // CANONICAL region, so its post-create read-back must use the canonical
        // key — not `resolvedKey`, which on a miss is the same value but is
        // reported by the reader rather than chosen by the writer.
        const created = await this.tryAutoCreate(region, getBootstrapMarkerKey(region));
        if (created) return created;
        // Declined or failed — fall through to legacy mode + the notice.
      }
      if (!this.legacyNoticeShownRegions.has(region) && !this.suppressLegacyNotice) {
        this.legacyNoticeShownRegions.add(region);
        // Name the exact region so users who already ran `cdkd bootstrap` in
        // another region (e.g. their CLI default) see WHY the notice still
        // fires — opt-in is per deploy region, keyed by each stack's
        // env.region, not the shell's default region.
        this.logger.info(
          `Assets for region '${region}' are published to the CDK bootstrap bucket/repo, which 'cdk gc' may ` +
            `garbage-collect (cdkd-deployed stacks have no CloudFormation stack for gc to scan). ` +
            `Run 'cdkd bootstrap --region ${region}' to create cdkd-owned asset storage that 'cdk gc' never touches.`
        );
      }
      return { mode: 'legacy' };
    }

    const marker = parseBootstrapMarker(body, resolvedKey);
    await verifyAssetStorageExists(marker, this.accountId, region, {
      ...(this.profile && { profile: this.profile }),
    });
    this.logger.debug(
      `cdkd asset storage active for region '${region}': ` +
        `${marker.assetBucket} / ${marker.containerRepo}`
    );
    return { mode: 'cdkd-assets', marker };
  }

  /**
   * Issue #1007 — first deploy into an un-opted-in region: confirm, then
   * create the asset bucket + container repo + marker via the same
   * {@link ensureAssetStorage} `cdkd bootstrap` uses (squatting defense,
   * idempotent creation, marker-written-last all included). Returns `null`
   * (= stay legacy) when the user declines or creation fails — the caller
   * then shows the legacy notice, so the user still learns the exact
   * `cdkd bootstrap --region <r>` remediation.
   */
  private async tryAutoCreate(region: string, markerKey: string): Promise<AssetMode | null> {
    let confirmed: boolean;
    try {
      confirmed = await this.autoCreate!.confirm(region);
    } catch {
      // A broken prompt (closed stdin, readline error) must not fail the
      // deploy — treat it as a decline.
      confirmed = false;
    }
    if (!confirmed) {
      return null;
    }
    // Constructed inside the try so even a throwing client constructor
    // lands in the fail-open catch below instead of escaping to the deploy.
    let s3Client: S3Client | undefined;
    let ecrClient: ECRClient | undefined;
    try {
      s3Client = new S3Client({
        region,
        ...(this.profile && { profile: this.profile }),
      });
      ecrClient = new ECRClient({
        region,
        ...(this.profile && { profile: this.profile }),
      });
      await ensureAssetStorage({
        s3Client,
        ecrClient,
        stateBackend: this.stateBackend,
        accountId: this.accountId,
        region,
        force: false,
      });
      const body = await this.stateBackend.getRawObject(markerKey);
      if (body === null) {
        throw new CdkdError(
          `bootstrap marker missing at '${markerKey}' right after creation`,
          'ASSET_STORAGE_MARKER_MISSING'
        );
      }
      const marker = parseBootstrapMarker(body, markerKey);
      this.logger.debug(
        `cdkd asset storage auto-created for region '${region}': ` +
          `${marker.assetBucket} / ${marker.containerRepo}`
      );
      return { mode: 'cdkd-assets', marker };
    } catch (error) {
      // Never hard-fail the deploy over a denied/failed storage creation —
      // legacy mode is exactly the pre-#1007 behavior and still works
      // wherever it worked before.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to auto-create cdkd asset storage for region '${region}': ${message} ` +
          `Falling back to the CDK bootstrap destinations for this run — run ` +
          `'cdkd bootstrap --region ${region}' (with S3/ECR create permissions) to opt the region in.`
      );
      return null;
    } finally {
      s3Client?.destroy();
      ecrClient?.destroy();
    }
  }
}
