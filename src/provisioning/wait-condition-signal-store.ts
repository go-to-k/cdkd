/**
 * The S3 side of `AWS::CloudFormation::WaitConditionHandle` /
 * `AWS::CloudFormation::WaitCondition` (go-to-k/cdkd#6694).
 *
 * Under CloudFormation a handle's physical id (its `Ref`) is a pre-signed S3
 * URL that `cfn-signal` / `curl -X PUT` posts a signal document to, and the
 * wait condition blocks until `Count` signals arrive. cdkd reproduces that with
 * its own state bucket: a handle is a pre-signed PUT URL for ONE key under
 * {@link WAIT_CONDITION_SIGNAL_PREFIX}, and the wait condition polls that key.
 * The state bucket is versioned, so every PUT is its own object VERSION and a
 * `Count > 1` wait reads each signal rather than only the last writer's.
 *
 * The URL is a bearer credential for PUTs to that one key: it is never logged
 * (`secret-physical-id.ts` masks it wherever the physical id is displayed). It
 * carries no `ExpectedBucketOwner` and no `Content-Type` in its signature, so
 * any HTTP client can PUT to it as it would to CloudFormation's URL.
 */

import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getAwsClients } from '../utils/aws-clients.js';
import { rebuildClientForBucketRegion } from '../utils/bucket-region-client.js';
import { expectedOwnerParam } from '../utils/expected-bucket-owner.js';
import { getLogger } from '../utils/logger.js';
import { safeMsg } from '../utils/display-safe.js';
import { describeAwsFailure } from '../utils/aws-failure-text.js';
import { purgeNoncurrentKeyVersions } from '../state/s3-noncurrent-version-purge.js';
import { listSignalVersions } from './wait-condition-signal-versions.js';
import { WAIT_CONDITION_SIGNAL_PREFIX } from '../state/state-prefix.js';

/**
 * 12 hours: what CloudFormation signs its own handle URL for (measured,
 * `X-Amz-Expires=43199`), and the longest `Timeout` a wait condition takes.
 * Longer would only widen the window the bearer URL is usable (#6704).
 */
export const SIGNAL_URL_EXPIRES_IN_SECONDS = 12 * 60 * 60;

/** A signal body larger than this is ignored: CloudFormation's own cap is far smaller. */
export const MAX_SIGNAL_BYTES = 64 * 1024;

export { LEGACY_HANDLE_ID_PREFIX } from './wait-condition-handle-id.js';
import { isLegacyHandleId } from './wait-condition-handle-id.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SIGNAL_KEY = new RegExp(
  `^${WAIT_CONDITION_SIGNAL_PREFIX}/[A-Za-z0-9]{1,255}-${UUID}\\.json$`
);

/** The one key a handle's URL writes to. Logical ids are alphanumeric. */
export function signalKeyFor(logicalId: string): string {
  return `${WAIT_CONDITION_SIGNAL_PREFIX}/${logicalId}-${randomUUID()}.json`;
}

/**
 * What a handle URL addresses, as seen from the configured state bucket:
 * `ours` (a key this store minted in THIS bucket), `legacy` (a pre-#6694
 * placeholder id), or `foreign` (anything else — CloudFormation's own URL after
 * a `--migrate-from-cloudformation` import, another bucket, a hand-written
 * value). Only `ours` can be waited on.
 */
export type HandleUrlVerdict =
  | { kind: 'ours'; key: string }
  | { kind: 'legacy' }
  | { kind: 'foreign' };

export function classifyHandleUrl(handle: string, bucket: string): HandleUrlVerdict {
  if (isLegacyHandleId(handle)) return { kind: 'legacy' };
  let parsed: URL;
  try {
    parsed = new URL(handle);
  } catch {
    return { kind: 'foreign' };
  }
  const marker = `/${WAIT_CONDITION_SIGNAL_PREFIX}/`;
  const at = parsed.pathname.lastIndexOf(marker);
  if (at < 0) return { kind: 'foreign' };
  let key: string;
  try {
    key = decodeURIComponent(parsed.pathname.slice(at + 1));
  } catch {
    return { kind: 'foreign' };
  }
  if (!SIGNAL_KEY.test(key)) return { kind: 'foreign' };
  // Path-style (`/<bucket>/<key>`) or virtual-hosted (`<bucket>.s3...`).
  const before = parsed.pathname.slice(0, at);
  const sameBucket =
    before === `/${bucket}` || (before === '' && parsed.hostname.startsWith(`${bucket}.`));
  return sameBucket ? { kind: 'ours', key } : { kind: 'foreign' };
}

/** One parsed signal document. */
export interface WaitConditionSignal {
  status: 'SUCCESS' | 'FAILURE';
  uniqueId: string;
  data: string;
  reason: string;
}

/**
 * Parse a signal body, `undefined` when it is not one. The body is written by
 * whoever holds the URL, so it is untrusted: only the four documented fields
 * are read, each coerced to a string.
 */
export function parseSignalBody(body: string): WaitConditionSignal | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return undefined;
  const d = doc as Record<string, unknown>;
  const status = typeof d['Status'] === 'string' ? d['Status'].toUpperCase() : undefined;
  if (status !== 'SUCCESS' && status !== 'FAILURE') return undefined;
  const text = (v: unknown): string =>
    v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  return {
    status,
    uniqueId: text(d['UniqueId']),
    data: text(d['Data']),
    reason: text(d['Reason']),
  };
}

/** Where a wait stands after reading every signal received so far. */
export type SignalVerdict =
  | { state: 'pending'; successes: number }
  | { state: 'failed'; signal: WaitConditionSignal }
  | { state: 'succeeded'; data: Record<string, string> };

/**
 * Fold signals, in ARRIVAL order, into a verdict. As CloudFormation does, the
 * wait ends at whichever comes first: a `FAILURE`, or the `Count`-th distinct
 * `UniqueId` signalling `SUCCESS` (a repeat of one id replaces its `Data`).
 */
export function evaluateSignals(
  signals: readonly WaitConditionSignal[],
  count: number
): SignalVerdict {
  const data = new Map<string, string>();
  if (count <= 0) return { state: 'succeeded', data: {} };
  for (const signal of signals) {
    if (signal.status === 'FAILURE') return { state: 'failed', signal };
    data.set(signal.uniqueId, signal.data);
    if (data.size >= count) return { state: 'succeeded', data: Object.fromEntries(data) };
  }
  return { state: 'pending', successes: data.size };
}

/**
 * The state bucket and a region-corrected client for it. One per
 * `ProviderRegistry`, configured by `setCustomResourceResponseBucket`, shared by
 * the handle and wait-condition providers.
 */
export class WaitConditionSignalStore {
  private bucket: string | undefined;
  /** Per base client: the clients are per stack scope (`getAwsClients()`). */
  private readonly clients = new WeakMap<S3Client, Promise<S3Client>>();
  private readonly logger = getLogger().child('WaitConditionSignalStore');

  setBucket(bucket: string): void {
    this.bucket = bucket;
  }

  /** The configured bucket, or a throw naming why a handle cannot exist without one. */
  requireBucket(): string {
    if (this.bucket === undefined || this.bucket === '') {
      throw new Error(
        'No cdkd state bucket is configured, so no wait condition signal URL can be issued.'
      );
    }
    return this.bucket;
  }

  private client(): Promise<S3Client> {
    const base = getAwsClients().s3;
    const bucket = this.requireBucket();
    let resolved = this.clients.get(base);
    if (resolved === undefined) {
      resolved = rebuildClientForBucketRegion(base, bucket, {
        reuseClientCredentials: true,
        tolerateNonStandardClient: true,
      }).then((rebuilt) => rebuilt ?? base);
      this.clients.set(base, resolved);
      resolved.catch(() => {
        if (this.clients.get(base) === resolved) this.clients.delete(base);
      });
    }
    return resolved;
  }

  /**
   * Issue a handle URL for a new key. `expiresAt` is when the URL stops
   * working: 12 hours, or sooner when the signing credentials are temporary
   * and expire first (SigV4 cannot outlive its session) — then
   * `limitedByCredentials` is set.
   */
  async issueSignalUrl(
    logicalId: string
  ): Promise<{ url: string; key: string; expiresAt: Date; limitedByCredentials: boolean }> {
    const bucket = this.requireBucket();
    const client = await this.client();
    const key = signalKeyFor(logicalId);
    const url = await getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn: SIGNAL_URL_EXPIRES_IN_SECONDS,
    });
    let expiresAt = new Date(Date.now() + SIGNAL_URL_EXPIRES_IN_SECONDS * 1000);
    let limitedByCredentials = false;
    try {
      const provider = (client as { config?: { credentials?: unknown } }).config?.credentials;
      const creds =
        typeof provider === 'function'
          ? ((await (provider as () => Promise<unknown>)()) as { expiration?: unknown })
          : undefined;
      if (creds?.expiration instanceof Date && creds.expiration < expiresAt) {
        expiresAt = creds.expiration;
        limitedByCredentials = true;
      }
    } catch {
      // The URL is already signed; its lifetime is only reported.
    }
    return { url, key, expiresAt, limitedByCredentials };
  }

  /**
   * Every signal received at `key` so far, in arrival order. `seen` caches
   * each version's parse across polls (keyed by version id), so a poll GETs
   * only what is new. More than `maxVersions` versions is a flood, not a set
   * of signals: it throws a `WaitConditionSignalFlood` error rather than
   * reading them all.
   */
  async readSignals(
    key: string,
    seen: Map<string, WaitConditionSignal | null>,
    maxVersions = Infinity
  ): Promise<WaitConditionSignal[]> {
    const bucket = this.requireBucket();
    const client = await this.client();
    const owner = await expectedOwnerParam(client);
    const versions = await listSignalVersions(client, bucket, key, owner);
    if (versions.length > maxVersions) {
      throw Object.assign(
        new Error(`${versions.length} signal versions exceed the limit of ${maxVersions}`),
        { name: 'WaitConditionSignalFlood' }
      );
    }
    const signals: WaitConditionSignal[] = [];
    for (const { versionId, size } of versions) {
      if (!seen.has(versionId)) {
        seen.set(versionId, await this.readVersion(client, bucket, key, versionId, size, owner));
      }
      const signal = seen.get(versionId);
      if (signal) signals.push(signal);
    }
    return signals;
  }

  private async readVersion(
    client: S3Client,
    bucket: string,
    key: string,
    versionId: string,
    size: number,
    owner: { ExpectedBucketOwner?: string }
  ): Promise<WaitConditionSignal | null> {
    if (size === 0) return null;
    if (size > MAX_SIGNAL_BYTES) {
      this.logger.warn(
        safeMsg`Ignoring a wait condition signal of ${size} bytes (over ${MAX_SIGNAL_BYTES}).`
      );
      return null;
    }
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId, ...owner })
    );
    const body = (await response.Body?.transformToString()) ?? '';
    const signal = parseSignalBody(body);
    if (signal === undefined) {
      // The body's length only: it is whatever the URL holder sent.
      this.logger.warn(
        safeMsg`Ignoring a wait condition signal that is not a {"Status": "SUCCESS" | "FAILURE", ...} document (${body.length} bytes).`
      );
      return null;
    }
    return signal;
  }

  /**
   * Remove the key and its signal versions. Best-effort: the objects hold
   * only signal documents, and a failure leaves them for a later sweep rather
   * than failing the handle's delete.
   */
  async deleteSignals(key: string): Promise<void> {
    try {
      const bucket = this.requireBucket();
      const client = await this.client();
      const owner = await expectedOwnerParam(client);
      const deleted = await client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: key, ...owner })
      );
      await purgeNoncurrentKeyVersions(client, bucket, [key], { requestFields: owner });
      // On the versioned state bucket the delete left a marker; the prefix has
      // no lifecycle rule, so remove it by its own version id too.
      if (deleted.DeleteMarker === true && typeof deleted.VersionId === 'string') {
        await client.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: key,
            VersionId: deleted.VersionId,
            ...owner,
          })
        );
      }
    } catch (error) {
      const failure = describeAwsFailure(error);
      this.logger.warn(
        safeMsg`Could not remove the wait condition signal object ${key}: ${failure.summary}`
      );
      this.logger.debug(safeMsg`Signal object delete failure detail: ${failure.detail}`);
    }
  }
}
