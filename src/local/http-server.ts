import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { getLogger } from '../utils/logger.js';
import { invokeRie } from './rie-client.js';
import {
  applyAuthorizerOverlay,
  buildHttpApiV2Event,
  buildRestV1Event,
  type AuthorizerEventOverlay,
  type HttpRequestSnapshot,
  type MatchedRouteContext,
} from './api-gateway-event.js';
import { translateLambdaResponse } from './api-gateway-response.js';
import { matchRoute } from './route-matcher.js';
import type { DiscoveredRoute } from './route-discovery.js';
import type { ContainerPool } from './container-pool.js';
import { matchPreflight, type CorsConfig } from './cors-handler.js';
import type { AuthorizerInfo, RouteWithAuth } from './authorizer-resolver.js';
import type { AuthorizerCache, CachedAuthorizerResult } from './authorizer-cache.js';
import {
  buildMethodArn,
  computeRequestIdentityHash,
  evaluateCachedLambdaPolicy,
  invokeRequestAuthorizer,
  invokeTokenAuthorizer,
} from './lambda-authorizer.js';
import { type JwksCache, verifyCognitoJwt, verifyJwtAuthorizer } from './cognito-jwt.js';

/**
 * The user-facing HTTP server for `cdkd local start-api`.
 *
 * Wires together:
 *   - {@link matchRoute} for routing (3-tier precedence + literal-segment
 *     tie-break);
 *   - {@link buildHttpApiV2Event} / {@link buildRestV1Event} for event
 *     construction;
 *   - {@link ContainerPool} for per-Lambda warm container reuse;
 *   - {@link translateLambdaResponse} for response translation.
 *
 * PR 8b additions:
 *   - Authorizer pass: when the matched route has an attached authorizer,
 *     the server invokes it (Lambda TOKEN / REQUEST or Cognito / JWT
 *     verify) before forwarding to the route handler. Allow → claims /
 *     context propagated into `event.requestContext.authorizer`. Deny →
 *     401 / 403 written directly without invoking the route handler.
 *     Caches per {@link AuthorizerCache}'s TTL.
 *
 * PR 8c additions:
 *   - CORS preflight interception (HTTP API v2 only) runs BEFORE the
 *     authorizer pass — preflight responses do NOT carry credentials per
 *     the CORS spec, so they must succeed without an Authorization
 *     header.
 *   - Hot reload support: `ServerState` is held in a closure cell;
 *     `setServerState` swaps it atomically; the `node:http` listener is
 *     never reconstructed.
 *
 * Critical: this module does NOT instantiate `live-renderer` or any
 * other `setInterval`-driven thing. The event loop must be free to
 * drain on graceful shutdown so `process.exit(0)` works.
 */

/**
 * Mutable server state read on every incoming request. Hot reload (PR
 * 8c) swaps the entire `ServerState` atomically via the
 * `setServerState` callback returned from `startApiServer`, so the
 * server keeps serving against the new template without restarting the
 * `node:http` listener (and without dropping in-flight requests — they
 * run against the old state until `pool.dispose()` returns).
 *
 * Each field corresponds to one piece of "what the server is serving":
 *
 *   - `routes` — the discovered routes with their attached authorizer
 *     info (output of `attachAuthorizers(discoverRoutes(...))`). Routes
 *     without an authorizer carry `authorizer: undefined`.
 *   - `pool` — the per-Lambda container pool. Hot reload may swap pools
 *     when the set of reachable Lambdas changes; the old pool's
 *     `dispose()` runs in the orchestrator after the swap.
 *   - `corsConfigByApiId` — `apiLogicalId → CorsConfig` map. Routes
 *     whose `apiLogicalId` is in this map participate in OPTIONS
 *     preflight interception.
 */
export interface ServerState {
  routes: readonly RouteWithAuth[];
  pool: ContainerPool;
  corsConfigByApiId: Map<string, CorsConfig>;
}

export interface StartApiServerOptions {
  /** Initial state. The server reads this on the first request. */
  state: ServerState;
  /** RIE invoke timeout in ms. Default `2 * max(timeoutSec) * 1000`, floor 30s. */
  rieTimeoutMs: number;
  /** Bind host (default `127.0.0.1`). */
  host: string;
  /** Bind port (or 0 for auto-allocation). */
  port: number;
  /** Authorizer-result cache (PR 8b). When omitted, every request re-invokes. */
  authorizerCache?: AuthorizerCache;
  /** JWKS cache (PR 8b). Required when any route has a Cognito / JWT authorizer. */
  jwksCache?: JwksCache;
  /**
   * Per-server-lifecycle Set of JWKS URLs we have already emitted a
   * pass-through warn line for (PR 8b post-review fix). Constructed once
   * by the caller (`local-start-api.ts`) and threaded through to every
   * request so the warn fires at most ONCE per JWKS URL per server.
   * When omitted, the verifier no-ops the warn (used in tests where the
   * server is not started through the CLI bootstrap).
   */
  jwksWarnedUrls?: Set<string>;
}

export interface StartedApiServer {
  /** The actual port the server is listening on (after auto-alloc). */
  port: number;
  /** The host the server is bound to. */
  host: string;
  /** Underlying Node http.Server (for `close()` plumbing). */
  server: Server;
  /**
   * Drain in-flight requests, close the server. Resolves once the
   * server has flushed every connection. Safe to call multiple times.
   */
  close: () => Promise<void>;
  /**
   * Atomically swap the server's state. Hot reload (PR 8c) calls this
   * with the new `routes` / `pool` / `corsConfigByApiId` after re-synth
   * + re-discovery completes. Returns the previous state so the caller
   * can `pool.dispose()` it in the background once in-flight requests
   * drain.
   */
  setServerState: (next: ServerState) => ServerState;
  /** Read the current state (for tests / orchestrator diagnostics). */
  getServerState: () => ServerState;
}

/**
 * Bind a server and start serving requests. Resolves once the server
 * is listening (after which the caller is expected to print
 * `Server listening on http://<host>:<port>` per D8.4).
 */
export async function startApiServer(opts: StartApiServerOptions): Promise<StartedApiServer> {
  const logger = getLogger().child('start-api');
  // The state is held in a closure cell so request handlers always read
  // the latest value. Hot reload mutates `currentState` via
  // `setServerState`; the server itself is never reconstructed.
  let currentState: ServerState = opts.state;
  const server = createServer((req, res) => {
    handleRequest(req, res, currentState, opts).catch((err) => {
      logger.error(
        `Unhandled request error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
      );
      if (!res.headersSent) {
        writeError(res, 502);
      }
    });
  });

  // Disable Nagle's algorithm for snappier curl interactions; trivial
  // win on a local server.
  server.on('connection', (socket) => {
    socket.setNoDelay(true);
  });

  const { actualPort, actualHost } = await new Promise<{ actualPort: number; actualHost: string }>(
    (resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(opts.port, opts.host, () => {
        const addr = server.address();
        if (addr === null || typeof addr === 'string') {
          rejectListen(new Error('Could not determine listening address'));
          return;
        }
        resolveListen({ actualPort: addr.port, actualHost: opts.host });
      });
    }
  );

  let closed = false;
  return {
    port: actualPort,
    host: actualHost,
    server,
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        // Force-close keep-alive sockets so close() actually returns.
        server.closeAllConnections?.();
      });
    },
    setServerState: (next: ServerState): ServerState => {
      const prev = currentState;
      currentState = next;
      return prev;
    },
    getServerState: (): ServerState => currentState,
  };
}

/**
 * Handle a single incoming HTTP request: read body, optionally
 * intercept CORS preflight, match route, invoke authorizer (if any),
 * build event, acquire container, invoke RIE, release container,
 * translate response, write response. Errors at any stage become a 502
 * response.
 *
 * Order of phases (load-bearing):
 *   1. CORS preflight interception (PR 8c). OPTIONS requests on an HTTP
 *      API v2 with a `CorsConfiguration` short-circuit here without
 *      touching the authorizer pass — preflight responses MUST succeed
 *      without an Authorization header per the CORS spec.
 *   2. Route match. 404s exit before the authorizer pass.
 *   3. Authorizer pass (PR 8b). Deny → 401 / 403 without invoking the
 *      route handler.
 *   4. Build event, acquire container, invoke RIE, translate response.
 */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  state: ServerState,
  opts: StartApiServerOptions
): Promise<void> {
  const logger = getLogger().child('start-api');

  // Read the request body (eager, all-in-memory). Local-only — large
  // bodies are not a concern in v1.
  const bodyBuf = await readBody(req);

  const rawUrl = req.url ?? '/';
  const method = (req.method ?? 'GET').toUpperCase();

  const requestPath = rawUrl.split('?')[0] ?? '/';

  // PR 8c: CORS preflight interception. We attempt to find a route the
  // OPTIONS request matches as if it were the actual method (we look at
  // `Access-Control-Request-Method` per the CORS spec); when found AND
  // the API has a CORS config AND no explicit OPTIONS route is
  // registered, we respond with the canonical preflight headers.
  // Preflight runs BEFORE the authorizer pass — preflight requests
  // never carry credentials per the CORS spec.
  const preflightHandled =
    method === 'OPTIONS' ? maybeHandleCorsPreflight(req, res, requestPath, state) : false;
  if (preflightHandled) return;

  const flatRoutes = state.routes.map((r) => r.route);
  const match = matchRoute(method, requestPath, flatRoutes);
  if (!match) {
    writeError(res, 404, '{"message":"Not Found"}');
    return;
  }

  // Synthetic CORS preflight (REST v1 MOCK preflight): respond with
  // the captured status + headers directly, no Lambda invocation. Runs
  // BEFORE the authorizer pass — preflight requests do not carry
  // credentials per the CORS spec.
  if (match.route.mockCors) {
    writeMockCorsPreflight(res, match.route.mockCors);
    return;
  }

  // Unsupported route — discovered with enough structure to match
  // (method + path), but no Lambda dispatch is possible. Surface the
  // reason as HTTP 501 so the user sees exactly what went wrong WHEN
  // they hit the route, while the rest of the API surface stays up.
  if (match.route.unsupported) {
    writeNotImplemented(res, match.route.unsupported.reason);
    return;
  }

  // Find the authorizer attached to the matched route (if any).
  const matchedEntry = state.routes.find(
    (r) => r.route.declaredAt === match.route.declaredAt && r.route.method === match.route.method
  );
  const authorizer = matchedEntry?.authorizer;

  const snapshot: HttpRequestSnapshot = {
    method,
    rawUrl,
    headers: collectHeaders(req),
    body: bodyBuf,
    ...(req.socket.remoteAddress !== undefined && { sourceIp: req.socket.remoteAddress }),
  };
  const matchCtx: MatchedRouteContext = {
    route: match.route,
    pathParameters: match.pathParameters,
    matchedPath: requestPath,
  };

  let baseEvent =
    match.route.apiVersion === 'v1'
      ? buildRestV1Event(snapshot, matchCtx)
      : buildHttpApiV2Event(snapshot, matchCtx);

  // Authorizer pass.
  let authResult: CachedAuthorizerResult | undefined;
  if (authorizer) {
    let outcome: AuthorizerOutcome;
    try {
      outcome = await runAuthorizerPass(
        authorizer,
        snapshot,
        matchCtx,
        state,
        opts,
        baseEvent['requestContext'] as Record<string, unknown>
      );
    } catch (err) {
      logger.error(
        `Authorizer ${authorizer.logicalId} threw for ${match.route.declaredAt}: ${err instanceof Error ? err.message : String(err)}`
      );
      // Authorizer error is treated as policy-deny (403 on REST v1, 401
      // on HTTP v2) — matches deployed behavior on Lambda authorizer
      // exceptions.
      writeAuthRejection(res, match.route.apiVersion, 'policy-deny');
      return;
    }
    if (!outcome.result.allow) {
      writeAuthRejection(res, match.route.apiVersion, outcome.denyKind ?? 'policy-deny');
      return;
    }
    authResult = outcome.result;
    const overlay = buildOverlay(authorizer, authResult);
    if (overlay) {
      baseEvent = applyAuthorizerOverlay(baseEvent, overlay);
    }
  }

  let handle;
  try {
    handle = await state.pool.acquire(match.route.lambdaLogicalId);
  } catch (err) {
    logger.error(
      `Failed to acquire container for ${match.route.lambdaLogicalId}: ${err instanceof Error ? err.message : String(err)}`
    );
    writeError(res, 502);
    return;
  }

  try {
    const invokeResult = await invokeRie(
      handle.containerHost,
      handle.hostPort,
      baseEvent,
      opts.rieTimeoutMs
    );

    const translated = translateLambdaResponse(invokeResult.payload, match.route.apiVersion);
    res.statusCode = translated.statusCode;
    for (const [name, value] of Object.entries(translated.headers)) {
      res.setHeader(name, value);
    }
    if (translated.cookies.length > 0) {
      // Multiple Set-Cookie headers — Node's setHeader accepts an array.
      res.setHeader('set-cookie', translated.cookies);
    }
    res.end(translated.body);
  } catch (err) {
    logger.error(
      `RIE invoke failed for ${match.route.lambdaLogicalId}: ${err instanceof Error ? err.message : String(err)}`
    );
    if (!res.headersSent) {
      writeError(res, 502);
    } else {
      res.end();
    }
  } finally {
    state.pool.release(handle);
  }
}

/**
 * Attempt CORS preflight interception. Returns `true` when the
 * preflight response was written (caller must NOT continue to route
 * dispatch); `false` when no preflight match (caller falls through to
 * normal request dispatch — typically a 404 / user OPTIONS handler).
 *
 * Match conditions (all must hold):
 *   1. The request's `Access-Control-Request-Method` header points at a
 *      route on an HTTP API v2 (`apiLogicalId` set, route's
 *      `apiVersion === 'v2'`).
 *   2. That API has a CORS config in `state.corsConfigByApiId`.
 *   3. There is NO explicit OPTIONS route registered for `requestPath`
 *      — the user's Lambda owns the OPTIONS surface in that case.
 *   4. The request's Origin / Method / Headers all satisfy the CORS
 *      config (delegated to {@link matchPreflight}).
 */
function maybeHandleCorsPreflight(
  req: IncomingMessage,
  res: ServerResponse,
  requestPath: string,
  state: ServerState
): boolean {
  if (state.corsConfigByApiId.size === 0) return false;

  const headers = collectHeaders(req);
  const requestedMethodHeader = pickFirstHeaderValue(headers, 'access-control-request-method');
  if (!requestedMethodHeader) return false;

  // Find the route the requested method would have hit. We DON'T need
  // to be perfectly precise here — the existence of a matching route on
  // the HTTP API v2 is enough to know "this is a route we own; emit
  // preflight". If no route matches, we let the request fall through to
  // 404.
  const flatRoutes = state.routes.map((r) => r.route);
  const surrogateMatch = matchRoute(requestedMethodHeader, requestPath, flatRoutes);
  if (!surrogateMatch) return false;
  const route = surrogateMatch.route;
  if (route.apiVersion !== 'v2' || !route.apiLogicalId) return false;

  // Skip when the user has an explicit OPTIONS method registered ON THE
  // SAME API (their Lambda owns it). The `apiLogicalId` filter is
  // load-bearing — without it, an explicit OPTIONS route on Stack B's
  // REST v1 API at the same path would suppress preflight on Stack A's
  // HTTP API v2 (the bug the PR review caught). `method === 'OPTIONS'`
  // is the only signal of explicit user intent — `ANY` is a catch-all
  // and doesn't represent CORS-handling intent.
  const surrogateApiId = route.apiLogicalId;
  const explicitOptionsRoute = flatRoutes.find(
    (r) =>
      r.apiLogicalId === surrogateApiId &&
      r.method.toUpperCase() === 'OPTIONS' &&
      pathPatternMatchesPath(r.pathPattern, requestPath)
  );
  if (explicitOptionsRoute) return false;

  const cors = state.corsConfigByApiId.get(surrogateApiId);
  if (!cors) return false;

  const preflight = matchPreflight({ method: 'OPTIONS', headers }, cors);
  if (!preflight) return false;

  res.statusCode = preflight.statusCode;
  for (const [name, value] of Object.entries(preflight.headers)) {
    res.setHeader(name, value);
  }
  res.end();
  return true;
}

/**
 * Compatibility helper: AWS API Gateway path patterns use `{name}` /
 * `{name+}` placeholders. We need a binary "does this pattern match
 * the request path" check (used to detect explicit OPTIONS routes).
 *
 * Reuses the same segment-walk logic as the route matcher, but
 * collapsed to a boolean — copying the rules avoids a circular import
 * back into `route-matcher.ts`'s richer `matchRoute` API.
 */
function pathPatternMatchesPath(pattern: string, requestPath: string): boolean {
  if (pattern === '$default') return true;
  const requestSegments = requestPath.split('/').filter((s) => s.length > 0);
  const patternSegments = pattern.split('/').filter((s) => s.length > 0);
  // Greedy `{proxy+}` consumes every remaining segment.
  if (patternSegments.length > 0) {
    const tail = patternSegments[patternSegments.length - 1]!;
    if (/^\{[^/{}]+\+\}$/.test(tail)) {
      const fixed = patternSegments.length - 1;
      if (requestSegments.length < fixed) return false;
      for (let i = 0; i < fixed; i++) {
        const ps = patternSegments[i]!;
        const rs = requestSegments[i]!;
        if (/^\{[^/{}+]+\}$/.test(ps)) continue;
        if (ps !== rs) return false;
      }
      return true;
    }
  }
  if (patternSegments.length !== requestSegments.length) return false;
  for (let i = 0; i < patternSegments.length; i++) {
    const ps = patternSegments[i]!;
    const rs = requestSegments[i]!;
    if (/^\{[^/{}+]+\}$/.test(ps)) continue;
    if (ps !== rs) return false;
  }
  return true;
}

/**
 * Pick the first value for a header (case-insensitive). Returns `null`
 * when the header isn't present. Used by the CORS preflight matcher
 * which only cares about `access-control-request-method` /
 * `access-control-request-headers`.
 */
function pickFirstHeaderValue(headers: Record<string, string[]>, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower && v.length > 0) return v[0]!;
  }
  return null;
}

/**
 * Outcome of an authorizer pass. The HTTP server uses `denyKind` to
 * differentiate REST v1 missing-identity (401) from policy-deny (403);
 * HTTP v2 collapses both to 401.
 */
interface AuthorizerOutcome {
  result: CachedAuthorizerResult;
  /**
   * `'missing-identity'` when the request lacks the configured identity
   * source (REST v1 → 401); `'policy-deny'` when the authorizer ran and
   * denied (REST v1 → 403). Unset on Allow outcomes.
   */
  denyKind?: 'missing-identity' | 'policy-deny';
}

/**
 * Run the authorizer (cache hit or fresh invocation) and return the
 * verdict + denyKind. Treats `result.allow === true` as the only happy
 * path; the http-server gates route forwarding on this.
 *
 * **Cache semantics (PR #237 review fixes)**:
 *   - The cache is keyed by `(authorizerLogicalId, identityHash)` and
 *     stores the authorizer's verdict shape (principalId, policyDocument,
 *     context) NOT the per-request `Resource`-evaluated allow/deny. On
 *     every Lambda-authorizer cache hit we re-run `resourceMatches`
 *     against the current request's methodArn so a narrow-Resource
 *     policy doesn't leak across routes.
 *   - For REQUEST authorizers we pre-compute the identity hash from
 *     the request snapshot BEFORE invoking the Lambda and consult the
 *     cache first; only a cache miss triggers `invokeRequestAuthorizer`.
 *     (Pre-fix: every request invoked, then checked cache.)
 */
async function runAuthorizerPass(
  authorizer: AuthorizerInfo,
  snapshot: HttpRequestSnapshot,
  matchCtx: MatchedRouteContext,
  state: ServerState,
  opts: StartApiServerOptions,
  requestContextV2: Record<string, unknown>
): Promise<AuthorizerOutcome> {
  // Build the snapshot the authorizer-invoker consumes. We use the v2
  // header+query maps for both versions because the local server canon-
  // icalizes those upstream; the route-event builder is the only place
  // that re-emits the v1 multi-value shape, and the authorizer event
  // builders re-derive multiValueHeaders from this single map.
  const headers = lowercaseSingularHeaders(snapshot.headers);
  const queryStringParameters = parseQueryStringSingular(snapshot.rawUrl);
  const sourceIp = pickSourceIp(matchCtx.route.apiVersion, requestContextV2, snapshot);

  const reqSnap = {
    method: snapshot.method.toUpperCase(),
    headers,
    queryStringParameters,
    pathParameters: matchCtx.pathParameters,
    sourceIp,
    matchedPath: matchCtx.matchedPath,
    stage: matchCtx.route.stage,
  };

  const methodArn = buildMethodArn({
    apiId: 'local',
    accountId: '123456789012',
    stage: matchCtx.route.stage,
    method: snapshot.method,
    path: matchCtx.matchedPath,
  });

  const cache = opts.authorizerCache;

  if (authorizer.kind === 'lambda-token') {
    const token = headers[authorizer.tokenHeader];
    if (!token) {
      return { result: { allow: false }, denyKind: 'missing-identity' };
    }
    if (cache) {
      const cached = cache.get(authorizer.logicalId, hashOne(token));
      if (cached) {
        // Re-evaluate Resource against the current methodArn so a
        // narrow-Resource Allow doesn't leak across routes. Cached
        // entries without a policy (only possible on a deny path,
        // since `parseLambdaAuthorizerResponse` only emits Allow with
        // a populated policy) skip re-eval.
        if (cached.policy !== undefined) {
          return shapeOutcome(evaluateCachedLambdaPolicy(cached, methodArn));
        }
        return shapeOutcome(cached);
      }
    }
    const result = await invokeTokenAuthorizer(authorizer, reqSnap, {
      pool: state.pool,
      rieTimeoutMs: opts.rieTimeoutMs,
      methodArn,
      mockAccountId: '123456789012',
      mockApiId: 'local',
    });
    if (cache && result.identityHash !== undefined) {
      cache.set(
        authorizer.logicalId,
        result.identityHash,
        authorizer.resultTtlSeconds,
        stripHash(result)
      );
    }
    return shapeOutcome(stripHash(result));
  }

  if (authorizer.kind === 'lambda-request') {
    // Pre-compute identity hash for cache lookup BEFORE invoking. Pre-fix
    // this code invoked first and consulted the cache only afterwards,
    // defeating the cache for every request.
    const { identityHash, missing } = computeRequestIdentityHash(authorizer, reqSnap);
    if (missing) {
      return { result: { allow: false }, denyKind: 'missing-identity' };
    }
    if (cache && authorizer.resultTtlSeconds > 0) {
      const cached = cache.get(authorizer.logicalId, identityHash);
      if (cached) {
        // For Lambda authorizers we always re-evaluate Resource against
        // the current methodArn (mirrors AWS-deployed API Gateway). The
        // HTTP v2 `{isAuthorized}` simple shape has no policy — those
        // cached entries pass through their own allow flag.
        if (cached.policy !== undefined) {
          return shapeOutcome(evaluateCachedLambdaPolicy(cached, methodArn));
        }
        return shapeOutcome(cached);
      }
    }
    const result = await invokeRequestAuthorizer(authorizer, reqSnap, {
      pool: state.pool,
      rieTimeoutMs: opts.rieTimeoutMs,
      methodArn,
      mockAccountId: '123456789012',
      mockApiId: 'local',
    });
    if (cache && result.identityHash !== undefined && authorizer.resultTtlSeconds > 0) {
      cache.set(
        authorizer.logicalId,
        result.identityHash,
        authorizer.resultTtlSeconds,
        stripHash(result)
      );
    }
    return shapeOutcome(stripHash(result));
  }

  if (!opts.jwksCache) {
    // Defensive: should never reach here in practice — local-start-api
    // always passes a JWKS cache when any JWT authorizer is configured.
    return { result: { allow: false }, denyKind: 'policy-deny' };
  }

  const authHeader = headers['authorization'];
  const jwksOpts = { ...(opts.jwksWarnedUrls && { warned: opts.jwksWarnedUrls }) };
  if (authorizer.kind === 'cognito') {
    if (cache && authHeader !== undefined) {
      const cached = cache.get(authorizer.logicalId, hashOne(authHeader));
      if (cached) return shapeOutcome(cached);
    }
    const result = await verifyCognitoJwt(authorizer, authHeader, opts.jwksCache, jwksOpts);
    if (cache && result.identityHash !== undefined && result.ttlSeconds > 0) {
      cache.set(
        authorizer.logicalId,
        result.identityHash,
        result.ttlSeconds,
        stripHashAndTtl(result)
      );
    }
    if (!result.allow && authHeader === undefined) {
      return { result: stripHashAndTtl(result), denyKind: 'missing-identity' };
    }
    return shapeOutcome(stripHashAndTtl(result));
  }

  // jwt
  if (cache && authHeader !== undefined) {
    const cached = cache.get(authorizer.logicalId, hashOne(authHeader));
    if (cached) return shapeOutcome(cached);
  }
  const result = await verifyJwtAuthorizer(authorizer, authHeader, opts.jwksCache, jwksOpts);
  if (cache && result.identityHash !== undefined && result.ttlSeconds > 0) {
    cache.set(
      authorizer.logicalId,
      result.identityHash,
      result.ttlSeconds,
      stripHashAndTtl(result)
    );
  }
  if (!result.allow && authHeader === undefined) {
    return { result: stripHashAndTtl(result), denyKind: 'missing-identity' };
  }
  return shapeOutcome(stripHashAndTtl(result));
}

/**
 * Wrap a {@link CachedAuthorizerResult} into the {@link AuthorizerOutcome}
 * shape. Allow → no denyKind; Deny → `'policy-deny'` (the explicit
 * "authorizer ran and denied" path; missing-identity is set by the
 * caller before this point).
 */
function shapeOutcome(result: CachedAuthorizerResult): AuthorizerOutcome {
  if (result.allow) return { result };
  return { result, denyKind: 'policy-deny' };
}

/**
 * Pick the source IP for the authorizer event. REST v1 stores it under
 * `requestContext.identity.sourceIp`; HTTP v2 under `requestContext.http.sourceIp`.
 * Falls back to the snapshot's `sourceIp` (or `127.0.0.1` for the local
 * server) when the structured field is absent.
 */
function pickSourceIp(
  apiVersion: 'v1' | 'v2',
  requestContext: Record<string, unknown>,
  snapshot: HttpRequestSnapshot
): string {
  if (apiVersion === 'v1') {
    const identity = requestContext['identity'];
    if (
      identity &&
      typeof identity === 'object' &&
      !Array.isArray(identity) &&
      typeof (identity as Record<string, unknown>)['sourceIp'] === 'string'
    ) {
      return (identity as Record<string, unknown>)['sourceIp'] as string;
    }
  } else {
    const http = requestContext['http'];
    if (
      http &&
      typeof http === 'object' &&
      !Array.isArray(http) &&
      typeof (http as Record<string, unknown>)['sourceIp'] === 'string'
    ) {
      return (http as Record<string, unknown>)['sourceIp'] as string;
    }
  }
  return snapshot.sourceIp ?? '127.0.0.1';
}

function buildOverlay(
  authorizer: AuthorizerInfo,
  result: CachedAuthorizerResult
): AuthorizerEventOverlay | undefined {
  if (authorizer.kind === 'lambda-token' || authorizer.kind === 'lambda-request') {
    const isV2 = authorizer.kind === 'lambda-request' && authorizer.apiVersion === 'v2';
    return isV2
      ? {
          kind: 'lambda-http-v2',
          ...(result.principalId !== undefined && { principalId: result.principalId }),
          ...(result.context && { context: result.context }),
        }
      : {
          kind: 'lambda-rest-v1',
          ...(result.principalId !== undefined && { principalId: result.principalId }),
          ...(result.context && { context: result.context }),
        };
  }
  if (authorizer.kind === 'cognito') {
    return { kind: 'cognito-rest-v1', claims: result.context ?? {} };
  }
  // jwt
  return { kind: 'jwt-http-v2', claims: result.context ?? {} };
}

/**
 * Map the authorizer rejection to an HTTP status code and body.
 *   - REST v1, missing identity → 401 `{"message":"Unauthorized"}`
 *     (matches deployed behavior; the route reaches the Method but no
 *     identity source is present so the authorizer never runs).
 *   - REST v1, policy-deny → 403 `{"message":"Forbidden"}` (the
 *     authorizer ran and denied; status mirrors AWS API Gateway).
 *   - HTTP v2, both kinds → 401 `{"message":"Unauthorized"}` (HTTP API
 *     collapses both into the same response).
 */
export function writeAuthRejection(
  res: ServerResponse,
  apiVersion: 'v1' | 'v2',
  denyKind: 'missing-identity' | 'policy-deny'
): void {
  if (apiVersion === 'v2') {
    writeError(res, 401, '{"message":"Unauthorized"}');
    return;
  }
  if (denyKind === 'missing-identity') {
    writeError(res, 401, '{"message":"Unauthorized"}');
    return;
  }
  writeError(res, 403, '{"message":"Forbidden"}');
}

function hashOne(value: string): string {
  return value;
}

function stripHash(r: CachedAuthorizerResult & { identityHash?: unknown }): CachedAuthorizerResult {
  const { identityHash, ...rest } = r;
  void identityHash;
  return rest;
}

function stripHashAndTtl(
  r: CachedAuthorizerResult & { identityHash?: unknown; ttlSeconds?: unknown }
): CachedAuthorizerResult {
  const { identityHash, ttlSeconds, ...rest } = r;
  void identityHash;
  void ttlSeconds;
  return rest;
}

/**
 * Lowercase header names + comma-join multiple values (matches v2 shape).
 */
function lowercaseSingularHeaders(raw: Record<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, values] of Object.entries(raw)) {
    out[name.toLowerCase()] = values.join(',');
  }
  return out;
}

/**
 * Parse query string into a singular (last-wins) map. Used by the
 * authorizer pass — separate from api-gateway-event because the
 * authorizer needs raw header values too.
 */
function parseQueryStringSingular(rawUrl: string): Record<string, string> {
  const q = rawUrl.indexOf('?');
  if (q < 0) return {};
  const raw = rawUrl.slice(q + 1);
  if (raw.length === 0) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split('&')) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? '' : pair.slice(eq + 1);
    let key = rawKey;
    let value = rawValue;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      /* keep raw */
    }
    try {
      value = decodeURIComponent(rawValue);
    } catch {
      /* keep raw */
    }
    out[key] = value;
  }
  return out;
}

/**
 * Drain the request body into a Buffer. Local-only server — eager read
 * is fine; v1 makes no attempt to stream.
 */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', rejectBody);
  });
}

/**
 * Collect headers from the IncomingMessage as a name → values[] map (the
 * shape `buildHttpApiV2Event` consumes). Node's `req.headers` already
 * lowercases names, but we keep them as-is and let the event-builder
 * normalize so the same request snapshot can be replayed in tests.
 *
 * `set-cookie` is the only header Node returns as `string[]`; we
 * normalize every other field by wrapping in `[v]` so the downstream
 * code never has to special-case array-vs-string.
 */
function collectHeaders(req: IncomingMessage): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      out[name] = value;
    } else if (typeof value === 'string') {
      out[name] = [value];
    }
  }
  return out;
}

/**
 * Write a small JSON error response. Used when the server cannot reach
 * the handler at all (no matching route, container acquire failed, RIE
 * unreachable).
 */
function writeError(
  res: ServerResponse,
  statusCode: number,
  body = '{"message":"Internal server error"}'
): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-length', String(Buffer.byteLength(body, 'utf-8')));
  res.end(body);
}

/**
 * Write the 501 Not Implemented response surfaced for routes the
 * discovery layer flagged as `unsupported`. The integration's reason
 * (e.g. "MOCK integration is not emulated", "WebSocket APIs are not
 * supported") is echoed in the body so the user gets a precise pointer
 * at first hit instead of a generic 502.
 */
function writeNotImplemented(res: ServerResponse, reason: string): void {
  const body = JSON.stringify({ message: 'Not Implemented', reason });
  res.statusCode = 501;
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-length', String(Buffer.byteLength(body, 'utf-8')));
  res.end(body);
}

/**
 * Write the canonical CORS preflight response derived from a REST v1
 * MOCK Method's `Integration.IntegrationResponses[0].ResponseParameters`.
 * Headers are emitted verbatim — the discovery layer already stripped
 * AWS's literal single-quote wrappers and dropped any non-literal
 * (intrinsic-valued) entries.
 */
function writeMockCorsPreflight(
  res: ServerResponse,
  preflight: { statusCode: number; headers: Record<string, string> }
): void {
  res.statusCode = preflight.statusCode;
  for (const [name, value] of Object.entries(preflight.headers)) {
    res.setHeader(name, value);
  }
  res.end();
}

// Keep DiscoveredRoute import alive for downstream consumers reading
// from this module's namespace export.
export type { DiscoveredRoute };
