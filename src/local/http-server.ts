/**
 * Shim: re-exports cdk-local's `start-api` local HTTP server — the
 * `node:http` accept loop that dispatches discovered routes to RIE-backed
 * Lambda containers, runs the authorizer pass, answers CORS preflight, and
 * supports mTLS + atomic hot-reload server-state swap. The implementation
 * lives in cdk-local and cdkd consumes it verbatim instead of carrying a
 * byte-identical copy. cdkd passes `sigV4Strict` (derived from its
 * `--allow-unverified-sigv4` opt-out flag) so the inherited SigV4 default
 * stays cdkd's fail-closed; the warn-message wording reads cdkd's flag via
 * the `sigV4StrictByDefault` / `sigV4OptFlag` embedConfig fields set in
 * `local-invoke.ts`. See cdk-local's `src/local/http-server.ts`.
 */
export {
  startApiServer,
  readMtlsMaterialsFromDisk,
  type ServerState,
  type StartedApiServer,
  type MtlsServerConfig,
} from 'cdk-local';
