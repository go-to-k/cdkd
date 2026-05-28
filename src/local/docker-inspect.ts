/**
 * Shim: re-exports cdk-local's `getContainerNetworkIp` (`docker inspect`
 * -> a container's per-network IP, `undefined` on race / missing attach
 * so the caller warn-and-skips). The implementation lives in cdk-local
 * and cdkd consumes it verbatim instead of carrying a byte-identical
 * copy. See cdk-local's `src/local/docker-inspect.ts`.
 */
export { getContainerNetworkIp } from 'cdk-local';
