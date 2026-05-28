/**
 * Shim: re-exports cdk-local's `start-api` REST API v1 `IntegrationResponses[]`
 * selection helpers — picks the matching integration response by
 * `SelectionPattern` regex (AWS pre-compiles it `^pattern$`-anchored), evaluates
 * `ResponseParameters` header literals, and selects the response template by the
 * `Accept` header. The implementation lives in cdk-local and cdkd consumes it
 * verbatim instead of carrying a byte-identical copy. See cdk-local's
 * `src/local/integration-response-selector.ts`. The selector throws
 * `VtlEvaluationError`, re-exported from cdk-local via `./vtl-engine.js` so the
 * throw and the REST v1 dispatcher's `instanceof VtlEvaluationError` catch share
 * one class identity.
 */
export {
  evaluateResponseParameters,
  pickResponseTemplate,
  selectIntegrationResponse,
  tryParseStatus,
  type IntegrationResponseEntry,
} from 'cdk-local';
