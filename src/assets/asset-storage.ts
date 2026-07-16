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
  if (marker.assetSupportVersion > ASSET_SUPPORT_VERSION) {
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
 */
export async function ensureAssetStorage(
  options: EnsureAssetStorageOptions
): Promise<{ assetBucket: string; containerRepo: string }> {
  const logger = getLogger();
  const { s3Client, ecrClient, stateBackend, accountId, region, force } = options;
  const assetBucket = getCdkdAssetBucketName(accountId, region);
  const containerRepo = getCdkdContainerRepoName(accountId, region);

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
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'DenyExternalAccess',
              Effect: 'Deny',
              Principal: '*',
              Action: 's3:*',
              Resource: [`arn:aws:s3:::${assetBucket}`, `arn:aws:s3:::${assetBucket}/*`],
              Condition: {
                StringNotEquals: { 'aws:PrincipalAccount': accountId },
              },
            },
          ],
        }),
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
  await stateBackend.putRawObject(getBootstrapMarkerKey(region), JSON.stringify(marker, null, 2));
  logger.info(`✓ Wrote bootstrap marker (${getBootstrapMarkerKey(region)})`);

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
  private legacyNoticeShownRegions = new Set<string>();
  private stateBackend: S3StateBackend;
  private accountId: string;
  private profile: string | undefined;
  private useCdkBootstrapAssets: boolean;
  private suppressLegacyNotice: boolean;

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
    } = {}
  ) {
    this.stateBackend = stateBackend;
    this.accountId = accountId;
    this.profile = opts.profile;
    this.useCdkBootstrapAssets = opts.useCdkBootstrapAssets ?? false;
    this.suppressLegacyNotice = opts.suppressLegacyNotice ?? false;
  }

  /**
   * Resolve the asset mode for a deploy region. Concurrent callers for the
   * same region share one in-flight resolution.
   */
  resolve(region: string): Promise<AssetMode> {
    if (this.useCdkBootstrapAssets) {
      // Explicit per-app / per-invocation legacy pin: no marker read, no
      // notice — byte-identical to pre-#1002 behavior (design §4.2).
      return Promise.resolve({ mode: 'legacy' });
    }
    const cached = this.cache.get(region);
    if (cached) return cached;
    const inFlight = this.doResolve(region).catch((error: unknown) => {
      // Do not cache failures — a transient S3 error on the marker read
      // should not poison every later stack in the same run.
      this.cache.delete(region);
      throw error;
    });
    this.cache.set(region, inFlight);
    return inFlight;
  }

  private async doResolve(region: string): Promise<AssetMode> {
    const markerKey = getBootstrapMarkerKey(region);
    const body = await this.stateBackend.getRawObject(markerKey);

    if (body === null) {
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

    const marker = parseBootstrapMarker(body, markerKey);
    await verifyAssetStorageExists(marker, this.accountId, region, {
      ...(this.profile && { profile: this.profile }),
    });
    this.logger.debug(
      `cdkd asset storage active for region '${region}': ` +
        `${marker.assetBucket} / ${marker.containerRepo}`
    );
    return { mode: 'cdkd-assets', marker };
  }
}
