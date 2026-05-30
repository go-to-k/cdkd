/**
 * Shim: re-exports cdk-local's `matchRoute` (3-tier request-to-route
 * matcher: full -> greedy `{proxy+}` -> `$default`). The implementation
 * lives in cdk-local and cdkd consumes it verbatim instead of carrying a
 * byte-identical copy. See cdk-local's `src/local/route-matcher.ts`.
 */
export { matchRoute, type RouteMatchResult } from 'cdk-local/internal';
