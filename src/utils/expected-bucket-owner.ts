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

const cache = new WeakMap<object, Promise<string | undefined>>();

/**
 * Resolve the AWS account id of the caller behind an S3 client's
 * credentials. Cached per client instance for the process lifetime (a
 * region-rebuilt replacement client re-resolves once — same credentials,
 * one extra STS call).
 *
 * Works for the cross-account state-read path too (`Fn::GetStackOutput`
 * `RoleArn`): the ephemeral backend's client carries the ASSUMED
 * credentials, so the resolved owner is the producer account — exactly the
 * owner its `cdkd-state-{producerAccountId}` bucket must have.
 */
export function resolveExpectedBucketOwner(client: S3Client): Promise<string | undefined> {
  const cached = cache.get(client);
  if (cached) return cached;

  const promise = (async (): Promise<string | undefined> => {
    try {
      const config = (
        client as {
          config?: { region?: unknown; credentials?: unknown };
        }
      ).config;
      if (
        !config ||
        typeof config.region !== 'function' ||
        typeof config.credentials !== 'function'
      ) {
        // Test double / non-standard client — skip the header.
        return undefined;
      }
      const region = await (config.region as () => Promise<unknown>)();
      const credentials = (await (config.credentials as () => Promise<unknown>)()) as {
        accessKeyId?: string;
        secretAccessKey?: string;
        sessionToken?: string;
      };
      if (!credentials?.accessKeyId || !credentials.secretAccessKey) {
        return undefined;
      }
      const sts = new STSClient({
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
    } catch (error) {
      getLogger().debug(
        `ExpectedBucketOwner resolution skipped (header omitted): ${String(error)}`
      );
      // Do NOT keep a failed resolution cached — a transient STS throttle at
      // process start must not silently disable the header for the rest of
      // the run (mirrors write-only-properties.ts's no-failure-caching).
      // The early structural returns above stay cached: a test double /
      // credential-less client is deterministic, not transient.
      cache.delete(client);
      return undefined;
    }
  })();

  cache.set(client, promise);
  return promise;
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
