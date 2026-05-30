/**
 * Shim: re-exports cdk-local's REST v1 / Function URL `AuthorizationType:
 * 'AWS_IAM'` SigV4 verification primitives — `defaultCredentialsLoader`
 * resolves the dev's local AWS credentials (via the SDK default chain) that
 * the verifier reproduces the request signature against. The implementation
 * lives in cdk-local and cdkd consumes it verbatim instead of carrying a
 * byte-identical copy. cdkd follows cdk-local's warn-and-pass default and
 * surfaces the strict-mode opt-in via `--strict-sigv4`; the
 * `sigV4StrictByDefault: false` / `sigV4OptFlag: '--strict-sigv4'`
 * embedConfig fields set in `local-invoke.ts` keep the inherited warn
 * messages cdkd-branded. See cdk-local's `src/local/sigv4-verify.ts`.
 */
export { defaultCredentialsLoader, type CredentialsLoader } from 'cdk-local/internal';
