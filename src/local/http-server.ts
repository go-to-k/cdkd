/**
 * Shim: re-exports cdk-local's `start-api` local HTTP server — the
 * `node:http` accept loop that dispatches discovered routes to RIE-backed
 * Lambda containers, runs the authorizer pass, answers CORS preflight, and
 * supports mTLS + atomic hot-reload server-state swap. The implementation
 * lives in cdk-local and cdkd consumes it verbatim instead of carrying a
 * byte-identical copy. cdkd follows cdk-local's SigV4 default (warn-and-pass)
 * and surfaces the strict-mode opt-in via `--strict-sigv4`; the embedConfig
 * fields `sigV4StrictByDefault: false` / `sigV4OptFlag: '--strict-sigv4'`
 * set in `local-invoke.ts` keep the inherited warn messages cdkd-branded.
 * See cdk-local's `src/local/http-server.ts`.
 */
export {
  startApiServer,
  readMtlsMaterialsFromDisk,
  type ServerState,
  type StartedApiServer,
  type MtlsServerConfig,
} from 'cdk-local/internal';
