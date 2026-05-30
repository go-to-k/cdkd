/**
 * Shim: re-exports cdk-local's `start-api` API-server grouping for
 * `cdkd local start-api` — splits a flat discovered-route list into one group
 * per local HTTP server (one per RestApi / HTTP API / Function URL) and
 * filters the route list to a single API by a user-supplied `--api`
 * identifier. The implementation lives in cdk-local and cdkd consumes it
 * verbatim instead of carrying a byte-identical copy. `ApiServerGroup` is
 * re-exported as a type. See cdk-local's `src/local/api-server-grouping.ts`.
 */
export {
  availableApiIdentifiers,
  filterRoutesByApiIdentifier,
  groupRoutesByServer,
  type ApiServerGroup,
} from 'cdk-local/internal';
