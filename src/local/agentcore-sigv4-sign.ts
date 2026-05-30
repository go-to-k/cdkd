/**
 * Shim: re-exports cdk-local's SigV4 request signer for
 * `cdkd local invoke-agentcore` — signs outbound `POST /invocations` requests
 * against the local AWS credentials when the target uses SigV4 auth. The
 * implementation lives in cdk-local and cdkd consumes it verbatim instead of
 * carrying a byte-identical copy. See cdk-local's
 * `src/local/agentcore-sigv4-sign.ts`.
 */
export {
  signAgentCoreInvocation,
  AGENTCORE_SIGV4_SERVICE,
  type SigV4Credentials,
  type SignAgentCoreInvocationOptions,
  type SignedAgentCoreHeaders,
} from 'cdk-local/internal';
