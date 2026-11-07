import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import { ECRClient, DescribeRepositoriesCommand } from '@aws-sdk/client-ecr';
import { awsClientDefaults } from '../../utils/aws-client-defaults.js';
import { CdkdError, normalizeAwsError } from '../../utils/error-handler.js';
import { pasteableCommand } from '../../utils/pasteable-command.js';
import { s3ClientDefaults } from '../../utils/s3-client-defaults.js';
import { isCrossRegionRedirect, assertAssetBucketRegion } from './bucket-region.js';
import { type BootstrapMarker, quotedIfPlain, isPlainName } from './marker.js';

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
  // Appended LAST by each of the three refusals below, so its command stays the
  // final line of whatever message carries it (go-to-k/cdkd#3436).
  const rebootstrap = pasteableCommand('cdkd bootstrap', [
    { flag: '--region', value: region, hole: 'region' },
  ]);
  const rebootstrapHint =
    `cdkd never silently falls back to CDK bootstrap asset storage once a region is opted in.` +
    `\nRecreate it with: ${rebootstrap.command}`;

  // `--profile` must reach these probes: with the default chain resolving a
  // DIFFERENT account, the asset bucket's own deny-external-account policy
  // turns HeadBucket into a 403 and the error below misreports a foreign
  // bucket.
  const clientOpts = { region, ...(opts.profile && { profile: opts.profile }) };
  // `awsClientDefaults()` is called ONCE PER CLIENT rather than folded into
  // `clientOpts`. Sharing the bag would share the `requestHandler` it carries,
  // and therefore the routing agent inside it -- and `NodeHttpHandler.destroy()`
  // forwards into an agent whose `destroy()` kills ACTIVE sockets, so the
  // `finally` below destroying one client would tear down the other's. The two
  // destroys are adjacent today, but the sharing is the hazard the per-client
  // agent rule exists to prevent, and it is invisible at the call site.
  const s3Client = new S3Client({
    ...awsClientDefaults({ profile: opts.profile }),
    ...s3ClientDefaults(),
    ...clientOpts,
  });
  const ecrClient = new ECRClient({
    ...awsClientDefaults({ profile: opts.profile }),
    ...clientOpts,
  });
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
            `${quotedIfPlain(marker.assetBucket, 'named by its marker')} is missing. ${rebootstrapHint}`,
          'ASSET_STORAGE_MISSING'
        );
      }
      if (err.$metadata?.httpStatusCode === 403) {
        throw new CdkdError(
          `${isPlainName(marker.assetBucket) ? `Asset bucket '${marker.assetBucket}'` : 'The asset bucket named by the marker'} exists but is not owned by account ` +
            `${accountId} (or access is denied). Refusing to use it. ${rebootstrapHint}`,
          'ASSET_STORAGE_FOREIGN_BUCKET',
          error as Error
        );
      }
      if (isCrossRegionRedirect(error)) {
        // The bucket lives in another region. Without this arm the caller got
        // the SDK's bare synthetic `UnknownError` with no context at all —
        // this path does not even reach `normalizeAwsError` (issue #2240).
        await assertAssetBucketRegion(
          s3Client,
          marker.assetBucket,
          region,
          accountId,
          error as Error
        );
        // Unreachable in practice (a redirect means the regions differ), but if
        // the guard ever returns, do not leak the SDK's synthetic `UnknownError`
        // the way this path used to. NOTE this is the ONE site whose
        // non-redirect fall-through is a raw `throw error` rather than
        // `normalizeAwsError`, so unlike its two siblings the widening below
        // can change WHICH object is thrown here -- only for a synthetic
        // `Unknown`, since `normalizeAwsError` returns a real-named error
        // untouched.
        throw normalizeAwsError(error, { bucket: marker.assetBucket, operation: 'HeadBucket' });
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
            `ECR repository ${quotedIfPlain(marker.containerRepo, 'named by its marker')} is missing. ${rebootstrapHint}`,
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
