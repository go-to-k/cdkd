/**
 * Shim: re-exports cdk-local's Bedrock AgentCore Runtime resolver for
 * `cdkd local invoke-agentcore` — synth template -> `ResolvedAgentCoreRuntime`
 * (container ARN / protocol / code artifact / jwt authorizer / etc.) +
 * `pickAgentCoreCandidateStack` for image-uri intrinsic resolution. The
 * implementation lives in cdk-local and cdkd consumes it verbatim instead of
 * carrying a byte-identical copy. See cdk-local's `src/local/agentcore-resolver.ts`.
 */
export {
  resolveAgentCoreTarget,
  pickAgentCoreCandidateStack,
  AgentCoreResolutionError,
  AGENTCORE_RUNTIME_TYPE,
  AGENTCORE_HTTP_PROTOCOL,
  AGENTCORE_MCP_PROTOCOL,
  AGENTCORE_A2A_PROTOCOL,
  AGENTCORE_AGUI_PROTOCOL,
  type ResolvedAgentCoreRuntime,
  type AgentCoreJwtAuthorizer,
  type AgentCoreCustomClaim,
  type AgentCoreCodeArtifact,
} from 'cdk-local/internal';
