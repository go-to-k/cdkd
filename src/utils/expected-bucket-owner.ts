/**
 * `ExpectedBucketOwner` resolution for cdkd-owned buckets (the state-bucket
 * family: state / lock / exports-index / deployment-events / transient
 * template uploads).
 *
 * S3 bucket names are global and cdkd's default names are predictable
 * (`cdkd-state-{accountId}`). Without this header, a bucket pre-created in
 * ANOTHER account under that name — with a bucket policy that deliberately
 * ALLOWS this account — would silently accept cdkd's state reads/writes
 * (name-squatting: the attacker could then read resource properties and
 * tamper with physical ids). With the header, S3 itself rejects any call
 * whose bucket owner differs (403), regardless of what the bucket's policy
 * allows. The asset-storage family has carried the same defense since issue
 * #1002 PR 1; this module extends it to the state-bucket family.
 *
 * Best-effort by design: a test double without a standard `config`, or an
 * STS failure, resolves to `undefined` (header omitted — pre-hardening
 * behavior) rather than failing the operation. The S3 calls themselves run
 * with the same credentials, so a working S3 path implies a working STS
 * path in practice; the degradation exists for exotic credential setups and
 * unit-test doubles, not as an expected runtime branch.
 */

import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import type { S3Client } from '@aws-sdk/client-s3';
import { getLogger } from './logger.js';
import { awsClientDefaults } from './aws-client-defaults.js';

/**
 * Resolved credential shape we care about. `accessKeyId` doubles as the
 * cache key — see {@link resolveAccountIdForCredentials}.
 */
interface ResolvedCredentials {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

/**
 * Fast path: per-S3-client memoization, so repeated calls on ONE client skip
 * even the (local) credential resolution.
 */
const clientCache = new WeakMap<object, Promise<string | undefined>>();

/**
 * Slow path: the actual `sts:GetCallerIdentity`, memoized by the resolved
 * **access key id** rather than by client identity (issue #1283).
 *
 * Why this key is both correct and safe:
 *
 *  - An AWS access key id belongs to exactly ONE account, so "the account
 *    behind these credentials" is a deterministic function of the credentials.
 *    Keying on it is semantically identical to resolving per client — it is
 *    strictly a better cache key for the same question.
 *  - It cannot leak one identity's account onto another. An assumed-role
 *    session has its own (`ASIA…`) key id, so the cross-account
 *    `Fn::GetStackOutput` `RoleArn` path — whose ephemeral client carries the
 *    ASSUMED credentials and must resolve the PRODUCER account — still misses
 *    the cache and resolves its own account, exactly as before.
 *
 * The per-client WeakMap alone could not collapse the calls this cache
 * collapses: cdkd builds several S3 clients from the SAME credential chain in
 * one deploy preflight (the bucket-existence probe, the shared
 * `AwsClients.s3`, and the region-corrected client `ensureClientForBucket`
 * rebuilds), each of which used to pay its own STS round trip — with a fresh
 * TLS handshake, since each resolution constructs and destroys its own
 * `STSClient`.
 */
const credentialsCache = new Map<string, Promise<string | undefined>>();

/**
 * Resolve (and memoize) the account id behind a specific set of credentials.
 *
 * Failures are deliberately NOT cached — a transient STS throttle at process
 * start must not silently disable the header for the rest of the run (mirrors
 * write-only-properties.ts's no-failure-caching).
 */
function resolveAccountIdForCredentials(
  region: unknown,
  credentials: Required<Pick<ResolvedCredentials, 'accessKeyId' | 'secretAccessKey'>> &
    ResolvedCredentials
): Promise<string | undefined> {
  const key = credentials.accessKeyId;
  const cached = credentialsCache.get(key);
  if (cached) return cached;

  const promise = (async (): Promise<string | undefined> => {
    const sts = new STSClient({
      ...awsClientDefaults(),
      ...(typeof region === 'string' && region ? { region } : {}),
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        ...(credentials.sessionToken && { sessionToken: credentials.sessionToken }),
      },
    });
    try {
      const identity = await sts.send(new GetCallerIdentityCommand({}));
      return identity.Account;
    } finally {
      sts.destroy();
    }
  })();

  credentialsCache.set(key, promise);
  // Drop a failed resolution so the next caller retries. The `.catch` also
  // marks the stored promise as handled, so a rejection here never surfaces
  // as an unhandled rejection when no other caller is awaiting it.
  promise.catch(() => {
    if (credentialsCache.get(key) === promise) credentialsCache.delete(key);
  });
  return promise;
}

/**
 * Read a client's resolved region + credentials, or `undefined` when the
 * client is a test double / non-standard object.
 */
async function readClientIdentity(
  client: unknown
): Promise<{ region: unknown; credentials: ResolvedCredentials } | undefined> {
  const config = (
    client as {
      config?: { region?: unknown; credentials?: unknown };
    }
  ).config;
  if (!config || typeof config.region !== 'function' || typeof config.credentials !== 'function') {
    return undefined;
  }
  const region = await (config.region as () => Promise<unknown>)();
  const credentials = (await (config.credentials as () => Promise<unknown>)()) as
    | ResolvedCredentials
    | undefined;
  return { region, credentials: credentials ?? {} };
}

/**
 * Resolve the AWS account id of the caller behind an S3 client's
 * credentials. Memoized per client instance AND — for the STS call itself —
 * per resolved access key id, for the process lifetime.
 *
 * Works for the cross-account state-read path too (`Fn::GetStackOutput`
 * `RoleArn`): the ephemeral backend's client carries the ASSUMED
 * credentials, whose access key id differs from the default chain's, so the
 * resolved owner is the producer account — exactly the owner its
 * `cdkd-state-{producerAccountId}` bucket must have.
 */
export function resolveExpectedBucketOwner(client: S3Client): Promise<string | undefined> {
  const cached = clientCache.get(client);
  if (cached) return cached;

  const promise = (async (): Promise<string | undefined> => {
    try {
      const identity = await readClientIdentity(client);
      if (!identity) {
        // Test double / non-standard client — skip the header.
        return undefined;
      }
      const { region, credentials } = identity;
      if (!credentials.accessKeyId || !credentials.secretAccessKey) {
        return undefined;
      }
      return await resolveAccountIdForCredentials(region, {
        ...credentials,
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      });
    } catch (error) {
      getLogger().debug(
        `ExpectedBucketOwner resolution skipped (header omitted): ${String(error)}`
      );
      // Do NOT keep a failed resolution cached — a transient STS throttle at
      // process start must not silently disable the header for the rest of
      // the run (mirrors write-only-properties.ts's no-failure-caching).
      // The early structural returns above stay cached: a test double /
      // credential-less client is deterministic, not transient.
      clientCache.delete(client);
      return undefined;
    }
  })();

  clientCache.set(client, promise);
  return promise;
}

/**
 * Record an account id that a `sts:GetCallerIdentity` **already issued with
 * this client's own credentials** returned, so the next
 * {@link resolveExpectedBucketOwner} for any client sharing those credentials
 * is a cache hit instead of a second round trip (issue #1283).
 *
 * This is a memoization of a call that just happened, NOT an override:
 *
 *  - The account is keyed by the credentials THIS client resolves, read from
 *    the client itself. The caller cannot name the key, so it cannot attach
 *    an account to credentials it does not hold.
 *  - Consequently it can never be applied to a client carrying assumed or
 *    foreign credentials on behalf of a different identity: seeding with an
 *    assumed-credentials client records that SESSION's own account, under
 *    that session's `ASIA…` key id, affecting only calls made with those
 *    same credentials. There is deliberately no global "current account"
 *    setter.
 *
 * The one real precondition — that `accountId` came from a
 * `GetCallerIdentity` made with `client`'s credentials — is why the only
 * caller is the state-bucket default-name resolution, which does exactly
 * that, on the line above the call.
 *
 * Best-effort: a non-standard client (test double) or an unresolvable
 * credential chain is a silent no-op; a later resolution just pays the round
 * trip it would have paid anyway.
 */
export async function recordResolvedAccountId(
  client: unknown,
  accountId: string | undefined
): Promise<void> {
  if (!accountId) return;
  try {
    const identity = await readClientIdentity(client);
    const accessKeyId = identity?.credentials.accessKeyId;
    if (!accessKeyId || !identity.credentials.secretAccessKey) return;
    if (credentialsCache.has(accessKeyId)) return;
    credentialsCache.set(accessKeyId, Promise.resolve(accountId));
  } catch (error) {
    getLogger().debug(`ExpectedBucketOwner seed skipped: ${String(error)}`);
  }
}

/**
 * Spread helper: `{...(await expectedOwnerParam(client))}` adds
 * `ExpectedBucketOwner` when the owner resolved, nothing otherwise.
 */
export async function expectedOwnerParam(
  client: S3Client
): Promise<{ ExpectedBucketOwner?: string }> {
  const owner = await resolveExpectedBucketOwner(client);
  return owner ? { ExpectedBucketOwner: owner } : {};
}

/**
 * Test-only: drop the credentials-keyed memoization so a test can assert on
 * the number of STS round trips without cross-test contamination. The
 * per-client layer is a `WeakMap` keyed by object identity, so a freshly
 * built client double is uncached by construction and needs no reset.
 */
export function clearExpectedBucketOwnerCache(): void {
  credentialsCache.clear();
}
