/**
 * Shared per-kind context-shape builder for the authorizer pipeline.
 *
 * Today's only direct consumer is
 * `buildAuthorizerContextForServiceIntegration` in
 * [http-server.ts](./http-server.ts), which delegates to this helper to
 * produce `$context.authorizer.*` for HTTP API v2 service-integration
 * routes. The sibling `buildOverlay` in `http-server.ts` (used to
 * produce `event.requestContext.authorizer` for Lambda AWS_PROXY
 * routes via `applyAuthorizerOverlay`) still uses hand-rolled per-kind
 * branches because it wraps the result in the
 * `AuthorizerEventOverlay` discriminated union (with the
 * `kind === 'lambda-http-v2'` arm layering an additional `.lambda`
 * namespace that lives in the consumer, not here). The inner per-kind
 * context shape it builds matches this helper's output exactly, so a
 * future kind addition can be lifted through this helper at both call
 * sites with no behavior change.
 *
 * The returned shape is the BARE per-kind context the consumers want
 * — callers layer any consumed-shape-specific namespacing themselves.
 *
 * Per-kind shape:
 *   - `lambda-token` / `lambda-request`: `principalId` (when set) plus
 *     every key in `result.context` flat at the top.
 *   - `iam`: `principalId` (when set) only — no IAM-context emulation.
 *   - `cognito`: `{ claims: {...result.context} }` (REST v1 namespacing).
 *   - `jwt`: `{ jwt: { claims: {...result.context}, scopes: [] } }`
 *     (HTTP v2 namespacing; the scopes array always present per the
 *     deployed shape).
 */

import type { AuthorizerInfo } from './authorizer-resolver.js';
import type { CachedAuthorizerResult } from './authorizer-cache.js';

/**
 * Build the per-kind context shape for the authorizer pipeline. Returns
 * an empty object only when nothing in the result is surfaceable (e.g.
 * a Lambda authorizer with no `principalId` and no `context`); callers
 * decide whether to skip surfacing in that case.
 *
 * For Lambda kinds: callers may need to wrap the returned shape in a
 * `lambda` namespace for HTTP API v2 (`{ lambda: shape }`); the wrap
 * is consumer-specific so it's NOT done here. The shape returned is
 * the always-flat REST v1 form.
 */
export function buildAuthorizerContextShape(
  authorizer: AuthorizerInfo,
  result: CachedAuthorizerResult
): Record<string, unknown> {
  if (authorizer.kind === 'lambda-token' || authorizer.kind === 'lambda-request') {
    const ctx: Record<string, unknown> = {};
    if (result.principalId !== undefined) ctx['principalId'] = result.principalId;
    if (result.context) Object.assign(ctx, result.context);
    return ctx;
  }
  if (authorizer.kind === 'iam') {
    const ctx: Record<string, unknown> = {};
    if (result.principalId !== undefined) ctx['principalId'] = result.principalId;
    return ctx;
  }
  if (authorizer.kind === 'cognito') {
    return { claims: { ...(result.context ?? {}) } };
  }
  // jwt
  return {
    jwt: {
      claims: { ...(result.context ?? {}) },
      scopes: [],
    },
  };
}
