/**
 * Shim: re-exports cdk-local's Lambda env-var resolution for
 * `cdkd local invoke` / `cdkd local start-api` — merges template-literal
 * env vars with SAM-shape `--env-vars` overrides (intrinsic-valued entries
 * warn-and-drop unless `--from-state` / `--from-cfn-stack` substituted them
 * upstream). The implementation lives in cdk-local and cdkd consumes it
 * verbatim instead of carrying a byte-identical copy. See cdk-local's
 * `src/local/env-resolver.ts`.
 */
export { resolveEnvVars, type EnvOverrideFile } from 'cdk-local';
