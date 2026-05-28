/**
 * Shim: re-exports cdk-local's HTTP API v2 service-integration
 * parameter-mapping resolver (`resolveServiceIntegrationParameters` /
 * `resolveSelectionExpression`). The implementation lives in cdk-local
 * and cdkd consumes it verbatim instead of carrying a byte-identical
 * copy. See cdk-local's `src/local/parameter-mapping.ts`.
 */
export {
  resolveServiceIntegrationParameters,
  resolveSelectionExpression,
  type RequestParameterContext,
  type ResolveParametersOutcome,
} from 'cdk-local';
