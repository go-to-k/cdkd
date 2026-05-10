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

export interface StartApiServerOptions {
  routes: readonly DiscoveredRoute[];
  pool: ContainerPool;
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
 * Handle a single incoming HTTP request: read body, match route, build
 * event, acquire container, invoke RIE, release container, translate
 * response, write response. Errors at any stage become a 502 response.
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
  const match = matchRoute(method, requestPath, opts.routes);
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
      event,
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
