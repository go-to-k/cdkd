/**
 * Shim: re-exports cdk-local's WebSocket API Lambda event-shape builders
 * (`$connect` / `$disconnect` / message) for `cdkd local start-api`. The
 * implementation lives in cdk-local and cdkd consumes it verbatim instead of
 * carrying a byte-identical copy. See cdk-local's
 * `src/local/websocket-event.ts`.
 */
export {
  buildConnectEvent,
  buildDisconnectEvent,
  buildMessageEvent,
  type WebSocketHandshakeSnapshot,
  type WebSocketLambdaEvent,
} from 'cdk-local/internal';
