/**
 * The state-bucket client: the bucket-region resolution and rebuild, the cross-prefix scan client, the connection warm-up and `headObject`.
 *
 * Moved verbatim out of `src/state/s3-state-backend.ts` (go-to-k/cdkd#5835); the
 * `S3StateBackend` class keeps one `f.call(this, ...)` delegator per moved method.
 */
import type { S3StateBackend } from '../s3-state-backend.js';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import { rebuildClientForBucketRegion } from '../../utils/bucket-region-client.js';
import { awsClientDefaults } from '../../utils/aws-client-defaults.js';
import { s3ClientDefaults } from '../../utils/s3-client-defaults.js';
import { isNoSuchKey } from './shared.js';

/**
 * The S3 client the cross-prefix scan probes through (go-to-k/cdkd#4705): a
 * second client for the same bucket region and credentials, so its up to
 * `PROBE_CONCURRENCY` probes in flight hold sockets of THEIR pool, never
 * the deploy's. A client whose region cannot be read (a test double) is used
 * as it is.
 */
export async function clientForScan(this: S3StateBackend): Promise<S3Client> {
  await this.ensureClientForBucket();
  if (this.scanClient !== undefined) return this.scanClient;
  // Built the way a bucket-region rebuild builds one, and only from a real
  // client: anything else (a test double) is used as it is.
  if (!(this.s3Client instanceof S3Client)) return this.s3Client;
  const region = await this.s3Client.config.region();
  this.scanClient = new S3Client({
    ...awsClientDefaults(this.clientOpts.profile ? { profile: this.clientOpts.profile } : {}),
    ...s3ClientDefaults(),
    region,
    credentials: this.s3Client.config.credentials,
  });
  return this.scanClient;
}

/**
 * Open `count` connections to the state bucket now, each with a HeadObject
 * on the stack's state key (`s3:GetObject`, which every deploy already
 * needs; a first deploy's 404 still completes the handshake). S3 closes a
 * keep-alive socket left idle about five seconds, which a deploy's last
 * resource usually outwaits, so the writes after it would each open a new
 * TLS connection. Read-only; never throws.
 */
export async function warmConnections(
  this: S3StateBackend,
  stackName: string,
  region: string,
  count: number
): Promise<void> {
  try {
    await this.ensureClientForBucket();
    const owner = await this.ownerParam();
    const key = this.getStateKey(stackName, region);
    await Promise.allSettled(
      Array.from({ length: count }, () =>
        this.s3Client.send(
          new HeadObjectCommand({ Bucket: this.config.bucket, ...owner, Key: key })
        )
      )
    );
  } catch {
    // Only a warm-up: the writes it serves open their own connections.
  }
}

/**
 * Resolve the state bucket's actual region and, if it differs from the
 * client's currently-configured region, replace the S3Client with one
 * pointed at the bucket's region.
 *
 * This is idempotent: subsequent calls return immediately. Concurrent
 * callers (e.g. when several public methods race during a parallel deploy)
 * share a single in-flight resolution promise so we never issue more than
 * one `GetBucketLocation` per backend.
 *
 * Errors from `GetBucketLocation` are deliberately swallowed by
 * `resolveBucketRegion` — the resolver returns `fallbackRegion` so the
 * caller can surface the more actionable downstream error (e.g. the
 * `HeadBucket` 404 routed via `normalizeAwsError`).
 */
export async function ensureClientForBucket(this: S3StateBackend): Promise<void> {
  if (this.clientResolved) return;
  if (this.resolveInFlight) return this.resolveInFlight;

  this.resolveInFlight = (async (): Promise<void> => {
    try {
      // S3StateBackend OWNS its client and threads static `--profile` /
      // credentials from its constructor `clientOpts` into both the probe
      // and the rebuild; the replaced client is destroyed.
      const replacement = await rebuildClientForBucketRegion(this.s3Client, this.config.bucket, {
        ...(this.clientOpts.profile && { profile: this.clientOpts.profile }),
        ...(this.clientOpts.credentials && { credentials: this.clientOpts.credentials }),
        destroyOldClient: true,
        onRebuild: ({ bucketRegion, currentRegion }) => {
          this.logger.debug(
            `State bucket '${this.config.bucket}' is in '${bucketRegion}' (client was '${String(currentRegion)}'); rebuilding S3 client.`
          );
        },
      });
      if (replacement) {
        this.s3Client = replacement;
      }
      this.clientResolved = true;
    } finally {
      this.resolveInFlight = null;
    }
  })();

  return this.resolveInFlight;
}

/**
 * HeadObject probe — returns true on 200, false on NotFound. Other errors
 * propagate so we don't accidentally swallow IAM denials.
 */
export async function headObject(this: S3StateBackend, key: string): Promise<boolean> {
  try {
    await this.s3Client.send(
      new HeadObjectCommand({
        Bucket: this.config.bucket,
        ...(await this.ownerParam()),
        Key: key,
      })
    );
    return true;
  } catch (error) {
    if (isNoSuchKey(error) || (error as { name?: string }).name === 'NotFound') {
      return false;
    }
    throw error;
  }
}
