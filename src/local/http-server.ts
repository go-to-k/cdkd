import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { getLogger } from '../utils/logger.js';
import { invokeRie } from './rie-client.js';
import {
  buildHttpApiV2Event,
  buildRestV1Event,
  type HttpRequestSnapshot,
  type MatchedRouteContext,
} from './api-gateway-event.js';
import { translateLambdaResponse } from './api-gateway-response.js';
import { matchRoute } from './route-matcher.js';
import type { DiscoveredRoute } from './route-discovery.js';
import type { ContainerPool } from './container-pool.js';
import { matchPreflight, type CorsConfig } from './cors-handler.js';

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
 *   - `routes` — the discovered routes (output of `discoverRoutes`).
 *   - `pool` — the per-Lambda container pool. Hot reload may swap pools
 *     when the set of reachable Lambdas changes; the old pool's
 *     `dispose()` runs in the orchestrator after the swap.
 *   - `corsConfigByApiId` — `apiLogicalId → CorsConfig` map. Routes
 *     whose `apiLogicalId` is in this map participate in OPTIONS
 *     preflight interception.
 */
export interface ServerState {
  routes: readonly DiscoveredRoute[];
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
  // eslint-disable-next-line prefer-const
  let currentState: ServerState = opts.state;
  const server = createServer((req, res) => {
    handleRequest(req, res, currentState, opts.rieTimeoutMs).catch((err) => {
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
 * Handle a single incoming HTTP request: read body, match route, build
 * event, acquire container, invoke RIE, release container, translate
 * response, write response. Errors at any stage become a 502 response.
 *
 * PR 8c additions: CORS preflight interception runs BEFORE route
 * dispatch — when the request is OPTIONS and matches a route on an
 * HTTP API v2 with a `CorsConfiguration`, return the canonical
 * preflight response without invoking the Lambda. The interception is
 * skipped when the user has registered an explicit OPTIONS method for
 * the request path (their Lambda owns it).
 */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  state: ServerState,
  rieTimeoutMs: number
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
  const preflightHandled =
    method === 'OPTIONS' ? maybeHandleCorsPreflight(req, res, requestPath, state) : false;
  if (preflightHandled) return;

  const match = matchRoute(method, requestPath, state.routes);
  if (!match) {
    writeError(res, 404, '{"message":"Not Found"}');
    return;
  }

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

  const event =
    match.route.apiVersion === 'v1'
      ? buildRestV1Event(snapshot, matchCtx)
      : buildHttpApiV2Event(snapshot, matchCtx);

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
      event,
      rieTimeoutMs
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
  const surrogateMatch = matchRoute(requestedMethodHeader, requestPath, state.routes);
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
  const explicitOptionsRoute = state.routes.find(
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
