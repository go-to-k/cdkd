/**
 * Shim: re-exports cdk-local's TTL-aware authorizer-result cache for
 * `cdkd local start-api` (mirrors API Gateway's authorizer caching locally).
 * The implementation lives in cdk-local and cdkd consumes it verbatim
 * instead of carrying a byte-identical copy. See cdk-local's
 * `src/local/authorizer-cache.ts`.
 */
export {
  createAuthorizerCache,
  type AuthorizerCache,
  type CachedAuthorizerResult,
} from 'cdk-local';
