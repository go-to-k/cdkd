/**
 * Shim: re-exports cdk-local's WebSocket `@connections` management API — the
 * in-process connection registry + the local management-endpoint HTTP handler
 * — for `cdkd local start-api`. The implementation lives in cdk-local and cdkd
 * consumes it verbatim instead of carrying a byte-identical copy. See
 * cdk-local's `src/local/websocket-mgmt-api.ts`.
 */
export {
  ConnectionRegistry,
  type ConnectionRegistryEntry,
  buildMgmtEndpointEnvUrl,
  handleConnectionsRequest,
  parseConnectionsPath,
} from 'cdk-local/internal';
