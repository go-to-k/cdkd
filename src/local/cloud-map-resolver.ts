/**
 * Shim: re-exports cdk-local's `start-service` Cloud Map service-discovery
 * index builder. Walks a synthesized stack's
 * `AWS::ServiceDiscovery::PrivateDnsNamespace` / `::Service` resources into the
 * namespace / service lookup maps the local ECS service runner resolves peers
 * against (non-private namespaces — `PublicDnsNamespace` / `HttpNamespace` —
 * hard-reject at the resolver layer). The implementation lives in cdk-local and
 * cdkd consumes it verbatim instead of carrying a byte-identical copy. See
 * cdk-local's `src/local/cloud-map-resolver.ts`. Throws `EcsTaskResolutionError`,
 * re-exported from cdk-local via `./ecs-task-resolver.js` so the throw and every
 * host-side `instanceof` / `toThrow` share one class identity.
 */
export { buildCloudMapIndex, type CloudMapIndex } from 'cdk-local/internal';
