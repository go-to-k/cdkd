/**
 * Shim: re-exports cdk-local's Lambda-response -> HTTP translator
 * (`translateLambdaResponse`: shaped response / runtime-error envelope /
 * auto-format heuristic + v2 multi-`Set-Cookie` handling). The
 * implementation lives in cdk-local and cdkd consumes it verbatim
 * instead of carrying a byte-identical copy. See cdk-local's
 * `src/local/api-gateway-response.ts`.
 */
export { translateLambdaResponse, type TranslatedHttpResponse } from 'cdk-local';
