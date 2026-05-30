/**
 * Shim: re-exports cdk-local's Docker host-gateway version probe for
 * `cdkd local start-api` — gates the `--add-host=...:host-gateway` mapping
 * WebSocket Lambda containers need to reach the host server on Linux native
 * dockerd. The implementation lives in cdk-local and cdkd consumes it
 * verbatim instead of carrying a byte-identical copy. See cdk-local's
 * `src/local/docker-version.ts`.
 */
export { HOST_GATEWAY_MIN_VERSION, probeHostGatewaySupport } from 'cdk-local/internal';
