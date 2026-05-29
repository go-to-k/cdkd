/**
 * Shim: re-exports cdk-local's REST v1 / Function URL `AuthorizationType:
 * 'AWS_IAM'` SigV4 verification primitives — `defaultCredentialsLoader`
 * resolves the dev's local AWS credentials (via the SDK default chain) that
 * the verifier reproduces the request signature against. The implementation
 * lives in cdk-local and cdkd consumes it verbatim instead of carrying a
 * byte-identical copy. cdkd keeps its fail-closed-by-default behavior: the
 * `start-api` server passes `sigV4Strict` derived from cdkd's opt-out
 * `--allow-unverified-sigv4` flag, and the warn-message wording reads cdkd's
 * flag via the `sigV4StrictByDefault` / `sigV4OptFlag` embedConfig fields.
 * See cdk-local's `src/local/sigv4-verify.ts`.
 */
export { defaultCredentialsLoader, type CredentialsLoader } from 'cdk-local';
