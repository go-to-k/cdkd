import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';

import { getLogger } from '../utils/logger.js';
import type { ContainerPool } from './container-pool.js';
import { invokeRie } from './rie-client.js';
import {
  buildConnectEvent,
  buildDisconnectEvent,
  buildMessageEvent,
  type WebSocketHandshakeSnapshot,
  type WebSocketLambdaEvent,
} from './websocket-event.js';
import {
  ConnectionRegistry,
  handleConnectionsRequest,
  parseConnectionsPath,
  type ConnectionRegistryEntry,
} from './websocket-mgmt-api.js';
import type { DiscoveredWebSocketApi } from './websocket-route-discovery.js';
import { parseSelectionExpressionPath } from './websocket-route-discovery.js';

/**
 * Wire a WebSocket API into a long-lived `node:http`'s `upgrade`
 * pipeline. The same server already serves HTTP API v2 / REST v1 /
 * Function URL routes via the `request` listener; this module adds a
 * sibling `upgrade` listener that handles WebSocket handshakes.
 *
 * Architecture (mirrors design doc §2 / §8):
 *   - One {@link WebSocketServer} per cdkd local-start-api server.
 *   - `noServer: true` mode — cdkd owns the upgrade-event dispatch.
 *   - Per-connection lifecycle: handshake -> $connect Lambda ->
 *     (allow/deny) -> message loop -> close -> $disconnect Lambda.
 *   - Outbound `@connections/<id>` POST from a handler-side AWS SDK
 *     call routes to the WebSocket via the shared
 *     {@link ConnectionRegistry}.
 *
 * The container pool is the SAME instance the HTTP-side server uses for
 * REST/HTTP API/Function URL routes — WebSocket dispatch is just
 * another consumer; per-Lambda concurrency caps still apply.
 */

const DEFAULT_INVOKE_TIMEOUT_MS = 60_000;

/**
 * Configuration for one WebSocket API attached to the server.
 *
 * `apiPath` controls the upgrade URL the WebSocket listens on; defaults
 * to `/` so a single-API setup matches the SAM Local UX (`wscat -c
 * ws://host:port`). Multi-API setups use `/<stage>` to disambiguate
 * (mirrors AWS's deployed-URL shape `wss://<id>.execute-api.<region>.amazonaws.com/<stage>`).
 */
export interface WebSocketApiConfig {
  /** Discovered WebSocket API metadata. */
  api: DiscoveredWebSocketApi;
  /**
   * URL path that the upgrade request must match. `'/'` by default;
   * `'/<stageName>'` when the server hosts multiple WebSocket APIs.
   * `req.url`'s pathname is matched against this verbatim.
   */
  apiPath: string;
}

/**
 * Handle returned by {@link attachWebSocketServer}. The CLI's shutdown
 * loop calls `close()` to gracefully tear down every active connection
 * (close frame 1001 going-away) before disposing the container pool.
 */
export interface AttachedWebSocketServer {
  /** Connection registry — exposed for the `@connections` HTTP handler. */
  registry: ConnectionRegistry;
  /**
   * Close every live WebSocket with code 1001 (going-away) and stop
   * accepting new upgrades. Safe to call multiple times. Resolves once
   * every socket has emitted its `close` event (which also fires the
   * `$disconnect` Lambda per connection).
   */
  close: () => Promise<void>;
  /**
   * The list of API paths this server now handles. The CLI uses this
   * to print the WebSocket URL on the listening banner.
   */
  apiPaths: readonly string[];
}

/**
 * Build a per-server connection registry plus a request pre-pass for
 * the `/@connections/<id>` endpoint. Mounted on the SAME node:http
 * server as the HTTP-side dispatcher via a `request`-listener pre-pass
 * (see {@link attachWebSocketServer.handleManagementRequest}).
 */
export interface AttachOptions {
  /** Node `http.Server` or `https.Server` to attach to. */
  httpServer: HttpServer;
  /** Apis to wire into the upgrade pipeline. */
  apis: readonly WebSocketApiConfig[];
  /** Container pool sourced from the parent CLI. */
  pool: ContainerPool;
  /**
   * RIE invoke timeout in ms. Defaults to {@link DEFAULT_INVOKE_TIMEOUT_MS};
   * the CLI scales this with the function's `Properties.Timeout` * 2.
   */
  rieTimeoutMs?: number;
}

/**
 * Attach a WebSocket server to the parent HTTP listener. Returns an
 * {@link AttachedWebSocketServer} the CLI uses for graceful shutdown +
 * to expose the connection registry to the management-API
 * pre-pass.
 *
 * Implementation:
 *   - One shared {@link ws.WebSocketServer} in `noServer` mode.
 *   - One `upgrade` listener that routes by `req.url`'s pathname; an
 *     unrecognized upgrade target is destroyed (RFC 6455 §4.3.2 —
 *     server SHOULD respond with HTTP 404 or 426).
 *   - Per-connection state held in a {@link ConnectionRegistry} the
 *     `@connections` HTTP handler reads to push messages back.
 *
 * Returns synchronously — the underlying ws server is fully bound by
 * the time this function returns.
 */
export function attachWebSocketServer(opts: AttachOptions): AttachedWebSocketServer {
  const logger = getLogger().child('start-api/ws');
  const rieTimeoutMs = opts.rieTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS;
  const registry = new ConnectionRegistry();
  const wss = new WebSocketServer({ noServer: true });

  // Per-API state lookup. The upgrade listener uses `req.url`'s
  // pathname; the message dispatcher uses the per-connection entry.
  const apisByPath = new Map<string, WebSocketApiConfig>();
  const apiPaths: string[] = [];
  for (const cfg of opts.apis) {
    apisByPath.set(cfg.apiPath, cfg);
    apiPaths.push(cfg.apiPath);
  }

  const upgradeListener = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = req.url ?? '/';
    const pathOnly = url.split('?', 1)[0]!;
    const cfg = apisByPath.get(pathOnly);
    if (!cfg) {
      // Unknown upgrade target. RFC 6455 §4.3.2 — close with HTTP 404
      // before the WebSocket handshake completes (no socket exposed to
      // the client).
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      void onConnect(ws, req, cfg).catch((err) => {
        logger.error(
          `WebSocket $connect dispatch failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
        );
        try {
          ws.close(1011, 'internal error');
        } catch {
          /* socket may already be closed */
        }
      });
    });
  };
  opts.httpServer.on('upgrade', upgradeListener);

  // Per-connection driver. Runs `$connect`, registers the socket on
  // success, then wires the message / close event handlers.
  //
  // Listener-attach ordering is **load-bearing**: 'message' / 'close' /
  // 'error' handlers are attached SYNCHRONOUSLY (before any await) on
  // the same micro-task tick the upgrade callback fires. Otherwise a
  // client that sends a frame immediately after the WebSocket 'open'
  // event (the common case) can race the >100ms `$connect` Lambda
  // cold-start and lose the frame — Node's WebSocket library has no
  // built-in buffer for pre-listener messages. We buffer messages
  // ourselves in `pendingMessages` until the $connect verdict lands.
  const onConnect = async (
    ws: WebSocket,
    req: IncomingMessage,
    cfg: WebSocketApiConfig
  ): Promise<void> => {
    const connectionId = randomUUID();
    const connectedAt = Date.now();
    const handshakeSnapshot = buildHandshakeSnapshot(req);
    const connectEvent = buildConnectEvent({
      connectionId,
      connectedAt,
      stage: cfg.api.stage,
      snapshot: handshakeSnapshot,
    });

    // Buffer messages until the $connect verdict resolves. Read by
    // the post-allow loop; populated by the always-on listener
    // attached BEFORE the await below.
    const pendingMessages: string[] = [];
    let connectVerdict: 'pending' | 'allowed' | 'denied' = 'pending';

    ws.on('message', (raw, isBinary) => {
      const body = bufferToBody(raw, isBinary);
      logger.debug(
        `WebSocket message received for connection ${connectionId} (verdict=${connectVerdict}): ${body.slice(0, 200)}`
      );
      if (connectVerdict === 'pending') {
        pendingMessages.push(body);
        return;
      }
      if (connectVerdict === 'denied') return;
      void dispatchMessage(connectionId, cfg, body, handshakeSnapshot).catch((err) => {
        logger.error(
          `WebSocket message dispatch failed (connection ${connectionId}): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
        );
        try {
          ws.send(
            JSON.stringify({
              message: 'Internal server error',
              connectionId,
              requestId: randomUUID(),
            })
          );
        } catch {
          /* socket may already be closed */
        }
      });
    });

    ws.on('close', (code, reason) => {
      void onDisconnect(connectionId, cfg, handshakeSnapshot, code, reason.toString('utf-8')).catch(
        (err) => {
          logger.warn(
            `WebSocket $disconnect dispatch failed (connection ${connectionId}): ${err instanceof Error ? err.message : String(err)}`
          );
        }
      );
    });
    ws.on('error', (err) => {
      logger.debug(
        `WebSocket error for connection ${connectionId}: ${err instanceof Error ? err.message : String(err)}`
      );
    });

    // Find the `$connect` route. AWS treats `$connect` as optional —
    // when absent, the connection is admitted without invoking any
    // Lambda. Match deployed behavior.
    const connectRoute = cfg.api.routes.find((r) => r.routeKey === '$connect');
    if (connectRoute) {
      const allowed = await invokeRouteAndDecideAuth(
        connectRoute.targetLambdaLogicalId,
        connectEvent,
        opts.pool,
        rieTimeoutMs
      );
      if (!allowed) {
        // Deny — close the upgrade with policy violation (1008) and
        // do NOT register the connection. AWS-deployed behavior is to
        // refuse the upgrade entirely; we already completed the
        // handshake by calling `handleUpgrade`, so the closest we can
        // get is an immediate close frame with the policy code.
        connectVerdict = 'denied';
        pendingMessages.length = 0;
        try {
          ws.close(1008, 'Forbidden');
        } catch {
          /* ignore */
        }
        logger.debug(
          `WebSocket $connect denied for connection ${connectionId} on ${cfg.api.declaredAt}`
        );
        return;
      }
    }

    const entry: ConnectionRegistryEntry = {
      connectionId,
      socket: ws,
      connectedAt,
      apiLogicalId: cfg.api.apiLogicalId,
      stage: cfg.api.stage,
    };
    registry.register(entry);
    connectVerdict = 'allowed';
    logger.debug(
      `WebSocket connected: ${connectionId} (${cfg.api.declaredAt}, stage=${cfg.api.stage})`
    );

    // Drain any messages buffered during the $connect await. Same
    // dispatcher as the inline path — the buffered messages just had
    // their frame arrival timestamp predate the registry entry.
    for (const body of pendingMessages) {
      void dispatchMessage(connectionId, cfg, body, handshakeSnapshot).catch((err) => {
        logger.error(
          `WebSocket buffered-message dispatch failed (connection ${connectionId}): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
        );
      });
    }
    pendingMessages.length = 0;
  };

  const dispatchMessage = async (
    connectionId: string,
    cfg: WebSocketApiConfig,
    body: string,
    snapshot: WebSocketHandshakeSnapshot
  ): Promise<void> => {
    const entry = registry.get(connectionId);
    if (!entry) return;

    const routeKey = selectRouteKey(cfg.api, body);
    const route = cfg.api.routes.find((r) => r.routeKey === routeKey);
    if (!route) {
      // Match AWS-deployed behavior: emit the error frame, keep socket
      // open. The socket reaches this branch only when neither the
      // selected key NOR `$default` matched.
      try {
        entry.socket.send(
          JSON.stringify({
            message: 'Internal server error',
            connectionId,
            requestId: randomUUID(),
          })
        );
      } catch {
        /* socket may have closed mid-error */
      }
      return;
    }
    const event = buildMessageEvent({
      connectionId,
      connectedAt: entry.connectedAt,
      stage: entry.stage,
      snapshot,
      routeKey,
      body,
    });
    // AWS-deployed WebSocket APIs invoke the handler then DISCARD the
    // response; handler code MUST use `PostToConnection` to reply.
    // Match that exactly — invoke for side-effects, ignore return.
    await invokeRoute(route.targetLambdaLogicalId, event, opts.pool, rieTimeoutMs);
  };

  const onDisconnect = async (
    connectionId: string,
    cfg: WebSocketApiConfig,
    snapshot: WebSocketHandshakeSnapshot,
    code: number,
    reason: string
  ): Promise<void> => {
    const entry = registry.unregister(connectionId);
    if (!entry) return;
    logger.debug(
      `WebSocket disconnected: ${connectionId} (code=${code}, reason=${reason || '<none>'})`
    );
    const disconnectRoute = cfg.api.routes.find((r) => r.routeKey === '$disconnect');
    if (!disconnectRoute) return;
    const event = buildDisconnectEvent({
      connectionId,
      connectedAt: entry.connectedAt,
      stage: entry.stage,
      snapshot,
      disconnectStatusCode: code,
      disconnectReason: reason,
    });
    await invokeRoute(disconnectRoute.targetLambdaLogicalId, event, opts.pool, rieTimeoutMs);
  };

  let closed = false;
  return {
    registry,
    apiPaths,
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      opts.httpServer.off('upgrade', upgradeListener);
      // Close every live socket. The `close` handler each socket
      // installed will fire `$disconnect` per connection. Await every
      // closure via the WebSocketServer's tracked clients.
      const clients: WebSocket[] = Array.from(wss.clients);
      const closes = clients.map(
        (ws) =>
          new Promise<void>((resolve) => {
            const onClose = (): void => resolve();
            ws.once('close', onClose);
            try {
              ws.close(1001, 'going away');
            } catch {
              resolve();
            }
            // Defensive timeout so a stuck socket never hangs shutdown.
            setTimeout(() => {
              ws.off('close', onClose);
              resolve();
            }, 5_000).unref();
          })
      );
      await Promise.all(closes);
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}

/**
 * Pre-pass for the HTTP `request` listener: intercept `POST/GET/DELETE
 * /@connections/<id>` calls and route them to the connection registry.
 *
 * Returns `true` when the request was handled (caller short-circuits
 * the normal HTTP dispatch path), `false` when the URL didn't match.
 *
 * The CLI installs this BEFORE the existing http-server pipeline so a
 * Lambda inside a container can call
 * `apigatewaymanagementapi:PostToConnection` and have cdkd deliver the
 * message back to the open WebSocket without the request hitting the
 * route table.
 */
export async function handleManagementRequest(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ConnectionRegistry
): Promise<boolean> {
  const url = req.url ?? '';
  if (parseConnectionsPath(url) === null) return false;
  await handleConnectionsRequest({ req, res, registry });
  return true;
}

/**
 * Select the route the client message dispatches to.
 *
 * Algorithm (matches AWS docs §"Selection expressions"):
 *   1. Try to parse the body as JSON. Non-JSON → `$default`.
 *   2. Walk the selection-expression's JSON-path tokens against the
 *      parsed body. Missing intermediate keys → `$default`.
 *   3. The final value's `String()` representation is the route key.
 *   4. When that key has no matching route, fall back to `$default`.
 *
 * v1's selection-expression grammar is `$request.body.<key>` (with
 * optional nested dot access). Other shapes were rejected upstream at
 * discovery time.
 */
function selectRouteKey(api: DiscoveredWebSocketApi, body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return '$default';
  }
  const tokens = parseSelectionExpressionPath(api.routeSelectionExpression);
  let cursor: unknown = parsed;
  for (const token of tokens) {
    if (cursor === null || typeof cursor !== 'object') return '$default';
    cursor = (cursor as Record<string, unknown>)[token];
    if (cursor === undefined) return '$default';
  }
  const candidate = String(cursor);
  if (api.routes.some((r) => r.routeKey === candidate)) return candidate;
  return '$default';
}

/**
 * Invoke a route's Lambda for side effects only (MESSAGE / DISCONNECT
 * paths). The Lambda's response is intentionally discarded — AWS-deployed
 * WebSocket APIs do the same; handlers reply via `PostToConnection`.
 */
async function invokeRoute(
  lambdaLogicalId: string,
  event: WebSocketLambdaEvent,
  pool: ContainerPool,
  rieTimeoutMs: number
): Promise<void> {
  const handle = await pool.acquire(lambdaLogicalId);
  try {
    await invokeRie(handle.containerHost, handle.hostPort, event, rieTimeoutMs);
  } finally {
    pool.release(handle);
  }
}

/**
 * Invoke the `$connect` Lambda and decide whether to accept the
 * connection. AWS-deployed behavior: handler returns `{statusCode:
 * 200}` (or any 2xx) → allow; anything else (non-2xx, error envelope,
 * throw, timeout) → deny.
 */
async function invokeRouteAndDecideAuth(
  lambdaLogicalId: string,
  event: WebSocketLambdaEvent,
  pool: ContainerPool,
  rieTimeoutMs: number
): Promise<boolean> {
  let result;
  try {
    const handle = await pool.acquire(lambdaLogicalId);
    try {
      result = await invokeRie(handle.containerHost, handle.hostPort, event, rieTimeoutMs);
    } finally {
      pool.release(handle);
    }
  } catch {
    return false;
  }
  // Lambda runtime error envelope. The Node Lambda runtime emits
  // `{errorMessage, errorType, stackTrace}` for thrown handlers.
  if (result.payload && typeof result.payload === 'object') {
    const obj = result.payload as Record<string, unknown>;
    if (typeof obj['errorMessage'] === 'string' && typeof obj['statusCode'] !== 'number') {
      return false;
    }
    const status = obj['statusCode'];
    if (typeof status === 'number') {
      return status >= 200 && status < 300;
    }
  }
  // No explicit statusCode → admit. Matches AWS-deployed lenience for
  // handlers that simply return `null` / `undefined` on `$connect`.
  return true;
}

/**
 * Snapshot the upgrade-request data the event-builders need. We capture
 * this ONCE at `$connect` and reuse it for every event on the same
 * connection — `requestContext.identity.sourceIp` etc. must stay
 * consistent across CONNECT / MESSAGE / DISCONNECT (matches AWS).
 */
function buildHandshakeSnapshot(req: IncomingMessage): WebSocketHandshakeSnapshot {
  const headers: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers[name] = Array.isArray(value) ? [...value] : [value];
  }
  const url = req.url ?? '/';
  const queryIdx = url.indexOf('?');
  const rawQueryString = queryIdx >= 0 ? url.slice(queryIdx + 1) : '';
  const { single, multi } = parseQueryString(rawQueryString);
  const userAgent =
    typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined;
  const sourceIp = req.socket.remoteAddress;
  return {
    headers,
    rawQueryString,
    ...(Object.keys(single).length > 0 && { queryStringParameters: single }),
    ...(Object.keys(multi).length > 0 && { multiValueQueryStringParameters: multi }),
    ...(sourceIp !== undefined && { sourceIp }),
    ...(userAgent !== undefined && { userAgent }),
  };
}

/**
 * Parse a raw query string into single-value (last-wins per AWS) and
 * multi-value maps. Mirrors `route-discovery.ts:parseQueryStringSingular`'s
 * convention — duplicated locally rather than reaching across modules
 * because the WebSocket path is a thin slice that does not need the
 * full HTTP-API parser.
 */
function parseQueryString(qs: string): {
  single: Record<string, string>;
  multi: Record<string, string[]>;
} {
  const single: Record<string, string> = {};
  const multi: Record<string, string[]> = {};
  if (qs.length === 0) return { single, multi };
  for (const pair of qs.split('&')) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq >= 0 ? pair.slice(0, eq) : pair;
    const rawVal = eq >= 0 ? pair.slice(eq + 1) : '';
    const key = safeDecode(rawKey);
    const val = safeDecode(rawVal);
    if (key === null) continue;
    single[key] = val ?? '';
    (multi[key] ??= []).push(val ?? '');
  }
  return { single, multi };
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

/**
 * Convert a ws-emitted message buffer into the AWS-canonical event
 * body. Text frames pass through as UTF-8; binary frames are base64-
 * encoded so the handler receives a valid string (matches AWS's
 * `requestContext.isBase64Encoded` shape — but in v1 we always emit
 * the body as a UTF-8 string for simplicity and only flip to base64
 * for actual binary frames).
 */
function bufferToBody(raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): string {
  const buf: Buffer = Array.isArray(raw)
    ? Buffer.concat(raw)
    : Buffer.isBuffer(raw)
      ? raw
      : Buffer.from(raw);
  if (isBinary) return buf.toString('base64');
  return buf.toString('utf-8');
}
