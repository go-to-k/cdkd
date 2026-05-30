/**
 * Shim: re-exports cdk-local's API Gateway event-shape builders
 * (`buildHttpApiV2Event` / `buildRestV1Event` / `applyAuthorizerOverlay`).
 * The implementation lives in cdk-local and cdkd consumes it verbatim
 * instead of carrying a byte-identical copy. See cdk-local's
 * `src/local/api-gateway-event.ts`.
 */
export {
  buildHttpApiV2Event,
  buildRestV1Event,
  applyAuthorizerOverlay,
  type HttpRequestSnapshot,
  type MatchedRouteContext,
  type AuthorizerEventOverlay,
} from 'cdk-local/internal';
