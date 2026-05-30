/**
 * Shim: re-exports cdk-local's AgentCore WebSocket protocol client for
 * `cdkd local invoke-agentcore --ws` — streams JSON frames over the
 * AgentCore Runtime container's `/ws` endpoint. The implementation lives in
 * cdk-local and cdkd consumes it verbatim instead of carrying a byte-identical
 * copy. See cdk-local's `src/local/agentcore-ws-client.ts`.
 */
export {
  invokeAgentCoreWs,
  type InvokeAgentCoreWsOptions,
  type AgentCoreWsResult,
} from 'cdk-local/internal';
