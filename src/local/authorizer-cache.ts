/**
 * TTL-aware authorizer-result cache for `cdkd local start-api` (PR 8b).
 *
 * AWS API Gateway caches authorizer results per `(authorizer, identity)`
 * tuple to avoid invoking the Lambda / re-verifying the JWT on every
 * request. cdkd mirrors that behavior locally so the dev experience
 * (latency, log noise) matches deployed behavior.
 *
 * Implementation:
 *   - Keyed by `<authorizerLogicalId>\u0000<identityHash>` (control char
 *     separator — cannot collide with valid header / token values).
 *   - Per-entry expiry is enforced lazily on `get()`; entries past their
 *     deadline are deleted and treated as cache misses.
 *   - `set(key, ttlSeconds, result)` with `ttlSeconds === 0` is a no-op
 *     (the AWS-side default for HTTP v2 JWT authorizers — no caching).
 *
 * The cache is **per-server-instance** — a shutdown discards every entry,
 * matching the deployed behavior where each API Gateway stage has its
 * own cache scope.
 */

export interface CachedAuthorizerResult {
  /**
   * Whether the authorizer Allow'd the request.
   *
   * **Cache semantics caveat**: for Lambda authorizers the cache stores
   * the authorizer's verdict shape (`principalId`, `policyDocument`,
   * `context`) keyed by `(authorizerLogicalId, identityHash)`; each
   * cache hit re-evaluates `policyDocument.Resource` against the
   * current request's methodArn so a narrow-Resource policy doesn't
   * leak across routes. So for Lambda authorizers the cached `allow`
   * is the verdict at cache-write time and is recomputed by the
   * caller; for JWT / Cognito (where there is no IAM policy and only
   * Allow results are ever cached) it is the final verdict.
   */
  allow: boolean;
  /**
   * The principal id from the policy document (or the JWT `sub` claim).
   * Surfaced in the request context for the route handler to log.
   */
  principalId?: string;
  /**
   * The authorizer's `context` (Lambda) or claims (JWT) — propagated
   * into `event.requestContext.authorizer` per
   * api-gateway-event.ts.
   */
  context?: Record<string, unknown>;
  /**
   * Original Lambda authorizer policy document (REST v1 + HTTP v2 IAM
   * shape) — surfaced verbatim into
   * `event.requestContext.authorizer.policy` for parity with the
   * deployed behavior, AND used to re-evaluate `Resource` against the
   * current request's methodArn on every cache hit so a narrow-Resource
   * policy can't leak across routes. JWT authorizers omit this.
   */
  policy?: unknown;
}

interface Entry {
  expiresAt: number;
  result: CachedAuthorizerResult;
}

export interface AuthorizerCache {
  /**
   * Look up `(authorizerLogicalId, identityHash)`. Returns the cached
   * result when present and not yet expired; expired entries are evicted
   * lazily. Returns `undefined` on cache miss.
   */
  get(authorizerLogicalId: string, identityHash: string): CachedAuthorizerResult | undefined;
  /**
   * Cache the result for `ttlSeconds`. A TTL of 0 is a documented no-op.
   */
  set(
    authorizerLogicalId: string,
    identityHash: string,
    ttlSeconds: number,
    result: CachedAuthorizerResult
  ): void;
  /** Clear every entry. Mostly useful for tests. */
  clear(): void;
  /** Diagnostic: number of currently-cached (non-expired) entries. */
  size(): number;
}

/**
 * Construct a fresh authorizer cache. `now` is injectable for tests so
 * we can advance time without `vi.useFakeTimers()` ceremony at every
 * call site.
 */
export function createAuthorizerCache(opts: { now?: () => number } = {}): AuthorizerCache {
  const now = opts.now ?? ((): number => Date.now());
  const map = new Map<string, Entry>();

  const buildKey = (auth: string, identity: string): string => `${auth}\u0000${identity}`;

  const sweep = (): void => {
    const t = now();
    for (const [k, v] of map) {
      if (v.expiresAt <= t) map.delete(k);
    }
  };

  return {
    get(authorizerLogicalId, identityHash) {
      const key = buildKey(authorizerLogicalId, identityHash);
      const entry = map.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        map.delete(key);
        return undefined;
      }
      return entry.result;
    },

    set(authorizerLogicalId, identityHash, ttlSeconds, result) {
      if (ttlSeconds <= 0) return;
      const key = buildKey(authorizerLogicalId, identityHash);
      map.set(key, { expiresAt: now() + ttlSeconds * 1000, result });
    },

    clear() {
      map.clear();
    },

    size() {
      sweep();
      return map.size;
    },
  };
}
