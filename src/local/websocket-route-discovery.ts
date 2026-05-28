/**
 * Shim: re-exports cdk-local's WebSocket API discovery
 * (`discoverWebSocketApis` / `discoverWebSocketApisOrThrow` /
 * `parseSelectionExpressionPath`). The implementation lives in cdk-local
 * and cdkd consumes it verbatim instead of carrying a byte-identical
 * copy. See cdk-local's `src/local/websocket-route-discovery.ts`.
 */
export {
  discoverWebSocketApis,
  discoverWebSocketApisOrThrow,
  parseSelectionExpressionPath,
  type DiscoveredWebSocketApi,
  type WebSocketRouteEntry,
} from 'cdk-local';
