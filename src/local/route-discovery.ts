/**
 * Shim: re-exports cdk-local's `start-api` route-discovery
 * (`discoverRoutes`: synth template -> REST v1 / HTTP API / Function URL
 * `DiscoveredRoute[]`). The implementation lives in cdk-local and cdkd
 * consumes it verbatim instead of carrying a byte-identical copy. See
 * cdk-local's `src/local/route-discovery.ts`.
 */
export {
  discoverRoutes,
  type DiscoveredRoute,
  type RestV1IntegrationConfig,
} from 'cdk-local/internal';
