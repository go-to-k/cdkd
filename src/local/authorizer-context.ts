/**
 * Shared per-kind context-shape builder for the authorizer pipeline.
 * PR #515 item 9: consolidates `buildOverlay` (in `http-server.ts`,
 * used to produce `event.requestContext.authorizer` for Lambda
 * AWS_PROXY routes via `applyAuthorizerOverlay`) and
 * `buildAuthorizerContextForServiceIntegration` (in `http-server.ts`,
 * used to populate `$context.authorizer.*` in the parameter-mapping
 * context for HTTP API v2 service-integration routes).
 *
 * Pre-extraction the two helpers each carried a ~80% identical
 * per-kind switch that would drift the next time a new authorizer
 * kind landed; this single source of truth means future shape changes
 * (or new kinds) get applied once and consumed by both call sites.
 *
 * The returned shape is the BARE per-kind context the consumers want
 * — neither caller layers the `$context.authorizer.lambda` namespacing
 * the HTTP API v2 Lambda-AWS_PROXY case applies. That namespacing lives
 * in the consumer (see `buildOverlay`'s `kind === 'lambda-http-v2'` arm
 * in `http-server.ts`) because it is consumed-shape-specific.
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
