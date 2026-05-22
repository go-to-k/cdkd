import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebSocket } from 'ws';

/**
 * Local emulation of the AWS `apigatewaymanagementapi` data plane —
 * specifically the `@connections` sub-resource Lambdas use to push
 * messages back to connected clients.
 *
 * Endpoint shape (matches AWS):
 *   - `POST   /@connections/<connectionId>`  — send a message
 *   - `GET    /@connections/<connectionId>`  — get connection metadata (deferred)
 *   - `DELETE /@connections/<connectionId>`  — force-disconnect (deferred)
 *
 * Handlers route to this module via the env-var override
 * `AWS_ENDPOINT_URL_APIGATEWAYMANAGEMENTAPI=http://<host>:<port>` that
 * `cdkd local start-api` injects into every WebSocket-API Lambda's
 * container (see `container-pool.ts`). The AWS SDK v3 honors this
 * env var and sends the call to cdkd's HTTP server instead of the
 * synthetic `*.execute-api.*.amazonaws.com` hostname.
 *
 * Security: cdkd does NOT verify SigV4 on the inbound request — the
 * dev-loop is not a security boundary (matches the precedent set by
 * `ecs-network.ts`'s metadata-endpoints sidecar). The SDK still signs
 * the request because that's what v3 does unconditionally; cdkd
 * ignores the signature.
 */

/**
 * Per-API connection registry — one instance per WebSocket API server.
 * Keyed by `connectionId` so the `POST /@connections/<id>` handler can
 * route the payload back to the live WebSocket without scanning every
 * server's registry. Ephemeral by design (no persistence across server
 * restarts) — matches `cdkd local start-api`'s overall no-state model.
 */
export interface ConnectionRegistryEntry {
  /** UUID v4 generated at `$connect`. Opaque per AWS docs. */
  connectionId: string;
  /** Open `ws.WebSocket`. Used for outbound send + close. */
  socket: WebSocket;
  /** `Date.now()` at `$connect`. Surfaced as `requestContext.connectedAt`. */
  connectedAt: number;
  /** The API the connection belongs to. Used in error messages only. */
  apiLogicalId: string;
  /** Stage name resolved at discovery. Surfaced as `requestContext.stage`. */
  stage: string;
}

/**
 * `Map<connectionId, ConnectionRegistryEntry>` wrapper with type-safe
 * accessors. Lookups by connectionId stay O(1).
 */
export class ConnectionRegistry {
  private readonly entries = new Map<string, ConnectionRegistryEntry>();

  register(entry: ConnectionRegistryEntry): void {
    this.entries.set(entry.connectionId, entry);
  }

  unregister(connectionId: string): ConnectionRegistryEntry | undefined {
    const entry = this.entries.get(connectionId);
    if (entry) this.entries.delete(connectionId);
    return entry;
  }

  get(connectionId: string): ConnectionRegistryEntry | undefined {
    return this.entries.get(connectionId);
  }

  size(): number {
    return this.entries.size;
  }

  /**
   * Snapshot the live entries (for diagnostics / shutdown drain).
   * Returns a fresh array so the caller can iterate without ownership
   * concerns over the underlying Map.
   */
  list(): ConnectionRegistryEntry[] {
    return Array.from(this.entries.values());
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * Match the request URL against the `@connections` endpoint family.
 * Returns the parsed connectionId on match, `null` otherwise.
 *
 * AWS reserves `$` / `@` for control planes so the path prefix
 * `/@connections/` can never collide with user-declared routes.
 */
export function parseConnectionsPath(url: string): {
  connectionId: string;
} | null {
  // Strip the optional query string (e.g. `?Action=GetConnection`).
  const pathOnly = url.split('?', 1)[0]!;
  const m = /^\/@connections\/([^/]+)\/?$/.exec(pathOnly);
  if (!m) return null;
  const decoded = safeDecodeURIComponent(m[1]!);
  if (decoded === null) return null;
  return { connectionId: decoded };
}

/**
 * `decodeURIComponent` throws `URIError` on malformed input
 * (`%`-escape with non-hex tail). We treat that as a not-found rather
 * than a server error — symmetric with AWS-deployed behavior, which
 * returns `GoneException` (HTTP 410) for any connection id it can't
 * look up.
 */
function safeDecodeURIComponent(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * Read the full request body into a Buffer. Mirrors `node:http`'s
 * `IncomingMessage` consume pattern — collect chunks, resolve on `end`.
 *
 * The body is what the user's handler passed to
 * `apigatewaymanagementapi.PostToConnection({Data: <bytes>})`. AWS docs
 * say the body is raw bytes (treated as opaque by the API plane); we
 * forward the buffer through to `WebSocket.send` so binary frames work
 * end to end.
 */
export function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      if (Buffer.isBuffer(chunk)) chunks.push(chunk);
      else chunks.push(Buffer.from(chunk, 'utf-8'));
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/**
 * Handle a `@connections/<id>` HTTP request. Dispatches by method:
 *   - `POST`   → push the request body to the matching open WebSocket.
 *   - `DELETE` → force-close the WebSocket (1000 normal close).
 *   - `GET`    → return synthetic metadata for the connection.
 *   - anything else → 405.
 *
 * Returns `true` when the request was handled (caller short-circuits),
 * `false` when the URL didn't match (caller continues normal HTTP
 * route dispatch).
 *
 * AWS-correct status codes:
 *   - Connection not in registry → `410 Gone` (matches AWS's
 *     `GoneException` for closed connections).
 *   - Send succeeded → `200 OK` (body empty).
 *   - Send failed (socket not OPEN) → `410 Gone` — the connection has
 *     started closing on the WebSocket side but the registry entry
 *     hasn't been removed yet (the `close` event clean-up is async).
 *
 * NOTE: The body buffer can include arbitrary binary; `ws.send` handles
 * both string and Buffer inputs (the recipient receives the same bytes
 * the sender wrote).
 */
export async function handleConnectionsRequest(opts: {
  req: IncomingMessage;
  res: ServerResponse;
  registry: ConnectionRegistry;
}): Promise<void> {
  const { req, res, registry } = opts;
  const url = req.url ?? '';
  const parsed = parseConnectionsPath(url);
  if (!parsed) {
    writeJson(res, 404, { message: 'Not Found' });
    return;
  }

  const { connectionId } = parsed;
  const entry = registry.get(connectionId);
  const method = (req.method ?? '').toUpperCase();

  // No-such-connection short-circuit. AWS docs say `GoneException`
  // (HTTP 410) for every method when the connection is unknown.
  if (!entry) {
    writeJson(res, 410, { message: 'GoneException' });
    return;
  }

  if (method === 'POST') {
    let body: Buffer;
    try {
      body = await readRequestBody(req);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      writeJson(res, 500, { message: `Failed to read request body: ${reason}` });
      return;
    }

    // `ws.send` accepts both Buffer and string; we keep the original
    // bytes so binary payloads round-trip unchanged.
    if (entry.socket.readyState !== entry.socket.OPEN) {
      // Socket is closing / closed but registry hasn't been swept yet.
      // Match AWS's GoneException response.
      writeJson(res, 410, { message: 'GoneException' });
      return;
    }
    try {
      entry.socket.send(body);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      writeJson(res, 500, { message: `Failed to deliver to socket: ${reason}` });
      return;
    }
    // AWS returns 200 with an empty body on successful PostToConnection.
    res.writeHead(200);
    res.end();
    return;
  }

  if (method === 'DELETE') {
    // AWS returns 204 on successful DeleteConnection. We close the
    // socket (registry-unregister + $disconnect dispatch fires from
    // the websocket-server module's close listener — single source of
    // truth for cleanup).
    try {
      entry.socket.close(1000, 'DeleteConnection');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      writeJson(res, 500, { message: `Failed to close socket: ${reason}` });
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }

  if (method === 'GET') {
    // AWS-shape GetConnection response (subset of fields). Real AWS
    // also returns `LastActiveAt` / `Identity`; we synthesize the
    // mandatory subset and omit fields the local server doesn't track.
    writeJson(res, 200, {
      ConnectedAt: new Date(entry.connectedAt).toISOString(),
      Identity: { SourceIp: '127.0.0.1' },
      LastActiveAt: new Date().toISOString(),
    });
    return;
  }

  // Method not allowed.
  res.setHeader('Allow', 'POST, GET, DELETE');
  writeJson(res, 405, { message: 'MethodNotAllowedException' });
}

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}
