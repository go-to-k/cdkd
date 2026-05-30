/**
 * Shim: re-exports cdk-local's literal-ARN Lambda Layer materializer for
 * `cdkd local invoke` / `cdkd local start-api` — downloads a layer version's
 * ZIP (optionally via an assumed role), unzips it to a host tmpdir, and
 * returns the path for `/opt` bind-mounting alongside same-stack layers. The
 * implementation lives in cdk-local and cdkd consumes it verbatim instead of
 * carrying a byte-identical copy. See cdk-local's
 * `src/local/layer-arn-materializer.ts`.
 */
export { materializeLayerFromArn } from 'cdk-local/internal';
