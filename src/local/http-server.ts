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
import type { AuthorizerInfo, RouteWithAuth } from './authorizer-resolver.js';
import type { AuthorizerCache, CachedAuthorizerResult } from './authorizer-cache.js';
import {
  buildMethodArn,
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
 *   - Authorizer pass: when `routesByPath` returns a route with an
 *     attached authorizer, the server invokes it (Lambda TOKEN /
 *     REQUEST or Cognito / JWT verify) before forwarding to the route
 *     handler. Allow → claims/context propagated into
 *     `event.requestContext.authorizer`. Deny → 401/403 written
 *     directly without invoking the route handler. Caches per
 *     {@link AuthorizerCache}'s TTL.
 *
 * Critical: this module does NOT instantiate `live-renderer` or any
 * other `setInterval`-driven thing. The event loop must be free to
 * drain on graceful shutdown so `process.exit(0)` works.
 */

export interface StartApiServerOptions {
  routes: readonly RouteWithAuth[];
  pool: ContainerPool;
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
}

/**
 * Bind a server and start serving requests. Resolves once the server
 * is listening (after which the caller is expected to print
 * `Server listening on http://<host>:<port>` per D8.4).
 */
export async function startApiServer(opts: StartApiServerOptions): Promise<StartedApiServer> {
  const logger = getLogger().child('start-api');
  const server = createServer((req, res) => {
    handleRequest(req, res, opts).catch((err) => {
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
  };
}

/**
 * Handle a single incoming HTTP request: read body, match route, invoke
 * authorizer (if any), build event, acquire container, invoke RIE,
 * release container, translate response, write response. Errors at any
 * stage become a 502 response.
 */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: StartApiServerOptions
): Promise<void> {
  const logger = getLogger().child('start-api');

  // Read the request body (eager, all-in-memory). Local-only — large
  // bodies are not a concern in v1.
  const bodyBuf = await readBody(req);

  const rawUrl = req.url ?? '/';
  const method = (req.method ?? 'GET').toUpperCase();

  const requestPath = rawUrl.split('?')[0] ?? '/';
  const flatRoutes = opts.routes.map((r) => r.route);
  const match = matchRoute(method, requestPath, flatRoutes);
  if (!match) {
    writeError(res, 404, '{"message":"Not Found"}');
    return;
  }
  // Find the authorizer attached to the matched route (if any).
  const matchedEntry = opts.routes.find(
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
    try {
      authResult = await runAuthorizerPass(
        authorizer,
        snapshot,
        matchCtx,
        opts,
        baseEvent['requestContext'] as Record<string, unknown>
      );
    } catch (err) {
      logger.error(
        `Authorizer ${authorizer.logicalId} threw for ${match.route.declaredAt}: ${err instanceof Error ? err.message : String(err)}`
      );
      writeAuthRejection(res, match.route.apiVersion);
      return;
    }
    if (!authResult.allow) {
      writeAuthRejection(res, match.route.apiVersion);
      return;
    }
    const overlay = buildOverlay(authorizer, authResult);
    if (overlay) {
      baseEvent = applyAuthorizerOverlay(baseEvent, overlay);
    }
  }

  let handle;
  try {
    handle = await opts.pool.acquire(match.route.lambdaLogicalId);
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
    opts.pool.release(handle);
  }
}

/**
 * Run the authorizer (cache hit or fresh invocation) and return the
 * verdict. Treats `authResult.allow === true` as the only happy path;
 * the http-server gates route forwarding on this.
 */
async function runAuthorizerPass(
  authorizer: AuthorizerInfo,
  snapshot: HttpRequestSnapshot,
  matchCtx: MatchedRouteContext,
  opts: StartApiServerOptions,
  requestContextV2: Record<string, unknown>
): Promise<CachedAuthorizerResult> {
  // Build the snapshot the authorizer-invoker consumes. We use the v2
  // header+query maps for both versions because the local server canon-
  // icalizes those upstream; the route-event builder is the only place
  // that re-emits the v1 multi-value shape, and the authorizer event
  // builders re-derive multiValueHeaders from this single map.
  const headers = lowercaseSingularHeaders(snapshot.headers);
  const queryStringParameters = parseQueryStringSingular(snapshot.rawUrl);
  const sourceIp =
    typeof requestContextV2['http'] === 'object' &&
    requestContextV2['http'] !== null &&
    !Array.isArray(requestContextV2['http']) &&
    typeof (requestContextV2['http'] as Record<string, unknown>)['sourceIp'] === 'string'
      ? ((requestContextV2['http'] as Record<string, unknown>)['sourceIp'] as string)
      : (snapshot.sourceIp ?? '127.0.0.1');

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

  // Build identity hash up-front for cache lookup (TOKEN / REQUEST /
  // JWT all derive a hash from the request).
  const cache = opts.authorizerCache;

  if (authorizer.kind === 'lambda-token') {
    const token = headers[authorizer.tokenHeader];
    if (!token) {
      return { allow: false };
    }
    if (cache) {
      const cached = cache.get(authorizer.logicalId, hashOne(token));
      if (cached) return cached;
    }
    const result = await invokeTokenAuthorizer(authorizer, reqSnap, {
      pool: opts.pool,
      rieTimeoutMs: opts.rieTimeoutMs,
      methodArn,
      mockAccountId: '123456789012',
      mockApiId: 'local',
    });
    if (cache && result.identityHash !== undefined) {
      cache.set(authorizer.logicalId, result.identityHash, authorizer.resultTtlSeconds, result);
    }
    return stripHash(result);
  }

  if (authorizer.kind === 'lambda-request') {
    // Pre-cache check: identity-hash needs the resolved values.
    const result = await invokeRequestAuthorizer(authorizer, reqSnap, {
      pool: opts.pool,
      rieTimeoutMs: opts.rieTimeoutMs,
      methodArn,
      mockAccountId: '123456789012',
      mockApiId: 'local',
    });
    // Cache lookup re-uses the resolver-built hash; we fold it into a
    // post-invoke set when the value is fresh and the TTL is positive.
    if (cache && result.identityHash !== undefined && authorizer.resultTtlSeconds > 0) {
      const cached = cache.get(authorizer.logicalId, result.identityHash);
      if (cached) return cached;
      cache.set(authorizer.logicalId, result.identityHash, authorizer.resultTtlSeconds, result);
    }
    return stripHash(result);
  }

  if (!opts.jwksCache) {
    // Defensive: should never reach here in practice — local-start-api
    // always passes a JWKS cache when any JWT authorizer is configured.
    return { allow: false };
  }

  const authHeader = headers['authorization'];
  if (authorizer.kind === 'cognito') {
    if (cache && authHeader !== undefined) {
      const cached = cache.get(authorizer.logicalId, hashOne(authHeader));
      if (cached) return cached;
    }
    const result = await verifyCognitoJwt(authorizer, authHeader, opts.jwksCache);
    if (cache && result.identityHash !== undefined && result.ttlSeconds > 0) {
      cache.set(authorizer.logicalId, result.identityHash, result.ttlSeconds, result);
    }
    return stripHashAndTtl(result);
  }

  // jwt
  if (cache && authHeader !== undefined) {
    const cached = cache.get(authorizer.logicalId, hashOne(authHeader));
    if (cached) return cached;
  }
  const result = await verifyJwtAuthorizer(authorizer, authHeader, opts.jwksCache);
  if (cache && result.identityHash !== undefined && result.ttlSeconds > 0) {
    cache.set(authorizer.logicalId, result.identityHash, result.ttlSeconds, result);
  }
  return stripHashAndTtl(result);
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
 * REST v1 maps authorizer rejections to HTTP 403 (`Forbidden`); HTTP v2
 * uses 401 (`Unauthorized`). Mirrors the deployed behavior.
 */
function writeAuthRejection(res: ServerResponse, apiVersion: 'v1' | 'v2'): void {
  if (apiVersion === 'v1') {
    writeError(res, 403, '{"message":"Forbidden"}');
  } else {
    writeError(res, 401, '{"message":"Unauthorized"}');
  }
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

// Keep DiscoveredRoute import alive for downstream consumers reading
// from this module's namespace export.
export type { DiscoveredRoute };
