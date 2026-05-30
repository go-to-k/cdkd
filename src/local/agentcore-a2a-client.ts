/**
 * Shim: re-exports cdk-local's AgentCore A2A (Agent-to-Agent) protocol client
 * for `cdkd local invoke-agentcore` — `POST /a2a` JSON-RPC contract. The
 * implementation lives in cdk-local and cdkd consumes it verbatim instead of
 * carrying a byte-identical copy. See cdk-local's `src/local/agentcore-a2a-client.ts`.
 */
export {
  a2aInvokeOnce,
  A2A_CONTAINER_PORT,
  A2A_PATH,
  type A2aInvokeResult,
  type A2aInvokeOptions,
  type A2aJsonRpcRequest,
} from 'cdk-local/internal';
