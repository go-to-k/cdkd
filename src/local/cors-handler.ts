/**
 * Shim: re-exports cdk-local's `start-api` CORS handling for
 * `cdkd local start-api` — parses CFn `CorsConfiguration` (and the CloudFront
 * distribution chain) into a per-API CORS config and answers OPTIONS preflight
 * for HTTP API v2. The implementation lives in cdk-local and cdkd consumes it
 * verbatim instead of carrying a byte-identical copy. `CorsConfig` is
 * re-exported as a type. See cdk-local's `src/local/cors-handler.ts`.
 */
export {
  applyCorsResponseHeaders,
  buildCorsConfigByApiId,
  buildCorsConfigFromCloudFrontChain,
  matchPreflight,
  type CorsConfig,
} from 'cdk-local/internal';
