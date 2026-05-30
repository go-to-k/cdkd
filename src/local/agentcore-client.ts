/**
 * Shim: re-exports cdk-local's AgentCore HTTP protocol client for
 * `cdkd local invoke-agentcore` — speaks the AgentCore Runtime container's
 * `GET /ping` (readiness) + `POST /invocations` (request) contract. The
 * implementation lives in cdk-local and cdkd consumes it verbatim instead of
 * carrying a byte-identical copy. See cdk-local's `src/local/agentcore-client.ts`.
 */
export {
  waitForAgentCorePing,
  invokeAgentCore,
  AGENTCORE_SESSION_ID_HEADER,
  type AgentCoreInvokeResult,
  type InvokeAgentCoreOptions,
} from 'cdk-local/internal';
