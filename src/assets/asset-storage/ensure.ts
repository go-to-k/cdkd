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
import { safeMsg } from '../../utils/display-safe.js';
import { getLogger } from '../../utils/logger.js';
import { CdkdError, normalizeAwsError } from '../../utils/error-handler.js';
import type { S3StateBackend } from '../../state/s3-state-backend.js';
import { buildDenyExternalAccessPolicy } from '../../utils/deny-external-access-policy.js';
import { pasteableCommand } from '../../utils/pasteable-command.js';
import {
  ASSET_SUPPORT_VERSION,
  getCdkdAssetBucketName,
  getCdkdContainerRepoName,
} from './names.js';
import { isCrossRegionRedirect, assertAssetBucketRegion } from './bucket-region.js';
import {
  getBootstrapMarkerKey,
  type BootstrapMarker,
  quotedIfPlain,
  shownName,
  droppedMarkerNames,
  bucketNameSubject,
  markerSubject,
  parseBootstrapMarker,
} from './marker.js';
import {
  applyAbortIncompleteMultipartUpload,
  abortIncompleteMultipartWarning,
  ABORT_INCOMPLETE_MULTIPART_DAYS,
} from './lifecycle.js';

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
  let malformedBody: string | undefined;
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
      // absent and rewrite it below. Warned once the names are resolved, so
      // the warning names only what the rewrite actually drops.
      malformedBody = existingBody;
    }
  }

  if (existingMarker) {
    const conflicts: string[] = [];
    if (options.assetBucketName && options.assetBucketName !== existingMarker.assetBucket) {
      conflicts.push(
        // The requested name is the operator's own, validated by
        // `bootstrap.ts` before it reaches here; described anyway as defence
        // in depth (go-to-k/cdkd#4205 review).
        `asset bucket ${quotedIfPlain(existingMarker.assetBucket, 'with a name that is not a plain identifier')} (requested ${quotedIfPlain(options.assetBucketName, 'a name that is not a plain identifier')})`
      );
    }
    if (options.containerRepoName && options.containerRepoName !== existingMarker.containerRepo) {
      conflicts.push(
        `container repo ${quotedIfPlain(existingMarker.containerRepo, 'with a name that is not a plain identifier')} (requested ${quotedIfPlain(options.containerRepoName, 'a name that is not a plain identifier')})`
      );
    }
    if (conflicts.length > 0) {
      throw new CdkdError(
        `Region ${quotedIfPlain(region, 'that is not a plain identifier')} is already bootstrapped with ${conflicts.join(' and ')}. ` +
          `Changing asset storage names would strand the existing storage and every ` +
          `published asset in it — tear the region's asset storage down first, then ` +
          `re-run bootstrap with the new names.` +
          `\nTear it down with: ${
            pasteableCommand('cdkd bootstrap', [
              { literal: '--destroy' },
              { flag: '--region', value: region, hole: 'region' },
            ]).command
          }`,
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
  if (malformedBody !== undefined) {
    logger.warn(
      `${markerSubject(markerKey)} is malformed — rewriting it as part of this bootstrap.` +
        droppedMarkerNames(malformedBody, assetBucket, containerRepo)
    );
  }

  // 1. Asset bucket.
  let bucketExists = false;
  try {
    await s3Client.send(
      new HeadBucketCommand({ Bucket: assetBucket, ExpectedBucketOwner: accountId })
    );
    bucketExists = true;
    logger.info(`Asset bucket ${shownName(assetBucket)} already exists`);
  } catch (error) {
    const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === 'NotFound' || err.name === 'NoSuchBucket') {
      // Will create below.
    } else if (err.$metadata?.httpStatusCode === 403) {
      throw new CdkdError(
        `${bucketNameSubject(assetBucket)} is already taken by a bucket this account ` +
          `does not own (or access is denied). Refusing to adopt it — resolve the ` +
          `naming conflict before re-running 'cdkd bootstrap'.`,
        'ASSET_STORAGE_FOREIGN_BUCKET',
        error as Error
      );
    } else if (isCrossRegionRedirect(error)) {
      // The bucket lives in another region. `normalizeAwsError` does render a
      // 301 readably, but its wording ("cdkd resolves this automatically; if
      // you see this message, please report it") is TRUE for the state bucket
      // and FALSE here — the asset clients stay `--region`-scoped on purpose,
      // so it would send a user with a self-inflicted naming collision to file
      // a bug. Refuse with the actionable message instead (issue #2240).
      await assertAssetBucketRegion(s3Client, assetBucket, region, accountId, error as Error);
      throw normalizeAwsError(error, { bucket: assetBucket, operation: 'HeadBucket' });
    } else {
      throw normalizeAwsError(error, { bucket: assetBucket, operation: 'HeadBucket' });
    }
  }

  if (!bucketExists) {
    logger.info(`Creating asset bucket: ${shownName(assetBucket)} in region ${region}`);
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
      logger.info(`✓ Created asset bucket: ${shownName(assetBucket)}`);
    } catch (error) {
      const err = error as { name?: string };
      if (err.name === 'BucketAlreadyOwnedByYou') {
        // Raced with a concurrent bootstrap of the same account — fine, but
        // ONLY if the bucket the race created is in THIS region. The 409 is an
        // account-global ownership signal, so it also fires for a bucket of
        // ours elsewhere; adopting that one would run the configuration PUTs
        // below against it (issue #2240).
        //
        // The equality check inside the guard is LOAD-BEARING, not a safety
        // net. Measured 2026-08-26: a same-region re-create of a bucket we
        // already own returns 200 ONLY on the us-east-1 legacy endpoint —
        // ap-northeast-1 and us-west-2 both answer `BucketAlreadyOwnedByYou`.
        // So in every region but one, an ordinary same-region race arrives
        // here as a 409 and it is the region comparison, not the error name,
        // that lets it proceed.
        await assertAssetBucketRegion(s3Client, assetBucket, region, accountId, error as Error);
        logger.info(`Asset bucket ${shownName(assetBucket)} already exists`);
      } else if (err.name === 'BucketAlreadyExists') {
        throw new CdkdError(
          `${bucketNameSubject(assetBucket)} is already taken by another AWS account. ` +
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

  // Issue #6185: abort incomplete multipart uploads after one day, as the CDK
  // bootstrap bucket does (a file asset over 5 MiB is uploaded in parts, #6184).
  // Runs for new AND existing buckets: a read-merge-write that keeps every
  // existing rule and is a no-op once the rule is there. A failure warns —
  // bootstrap without the lifecycle permissions must keep succeeding.
  const lifecycle = await applyAbortIncompleteMultipartUpload(s3Client, assetBucket, {
    expectedBucketOwner: accountId,
  });
  if (lifecycle.status === 'failed') {
    logger.warn(abortIncompleteMultipartWarning(assetBucket, lifecycle));
  } else if (lifecycle.status === 'added') {
    logger.info(
      safeMsg`✓ Set asset bucket lifecycle rule (abort incomplete multipart uploads after ${ABORT_INCOMPLETE_MULTIPART_DAYS} day)`
    );
  }

  // 2. Container-asset ECR repo. Repos are account-scoped, so an existing
  // repo is always ours — no squatting concern on this leg.
  let repoExists = false;
  try {
    await ecrClient.send(new DescribeRepositoriesCommand({ repositoryNames: [containerRepo] }));
    repoExists = true;
    logger.info(`Container-asset repository ${shownName(containerRepo)} already exists`);
  } catch (error) {
    const err = error as { name?: string };
    if (err.name !== 'RepositoryNotFoundException') {
      throw error;
    }
  }

  if (!repoExists) {
    logger.info(`Creating container-asset ECR repository: ${shownName(containerRepo)}`);
    try {
      await ecrClient.send(
        new CreateRepositoryCommand({
          repositoryName: containerRepo,
          // Tags are content hashes — immutable, matching CDK bootstrap.
          imageTagMutability: 'IMMUTABLE',
        })
      );
      logger.info(`✓ Created container-asset ECR repository: ${shownName(containerRepo)}`);
    } catch (error) {
      const err = error as { name?: string };
      if (err.name === 'RepositoryAlreadyExistsException') {
        logger.info(`Container-asset repository ${shownName(containerRepo)} already exists`);
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
