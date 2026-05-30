/**
 * Shim: re-exports cdk-local's AgentCore `CodeConfiguration` managed-runtime
 * source-to-image builder for `cdkd local invoke-agentcore` — runs a
 * `CodeConfiguration` artifact's source through a Docker build that produces
 * a runnable AgentCore container image. The implementation lives in cdk-local
 * and cdkd consumes it verbatim instead of carrying a byte-identical copy.
 * See cdk-local's `src/local/agentcore-code-build.ts`.
 */
export {
  buildAgentCoreCodeImage,
  renderCodeDockerfile,
  toCmdArgv,
  computeCodeImageTag,
  SUPPORTED_CODE_RUNTIMES,
  type BuildAgentCoreCodeImageOptions,
} from 'cdk-local/internal';
