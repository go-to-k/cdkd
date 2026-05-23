import { randomUUID } from 'node:crypto';

/**
 * AWS API Gateway WebSocket event-payload builders.
 *
 * Spec: https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-mapping-template-reference.html
 *
 * Three event types — CONNECT / MESSAGE / DISCONNECT — each carry a
 * shared {@link WebSocketRequestContext} plus per-event fields.
 *
 * Fields cdkd populates locally vs mocks (matches design Q1 in
 * `docs/design/462-websocket-api.md`):
 *
 * | Field                                | Source                                  |
 * |--------------------------------------|-----------------------------------------|
 * | `connectionId`                       | UUID v4 generated at `$connect`         |
 * | `requestId` / `extendedRequestId`    | Generated UUID per event                |
 * | `messageId` (MESSAGE only)           | Generated UUID per event                |
 * | `requestTime` / `requestTimeEpoch`   | `Date.now()` at build time              |
 * | `connectedAt`                        | Captured at `$connect`                  |
 * | `stage`                              | Resolved Stage Name; `'local'` default  |
 * | `apiId`                              | `'local'` (mock)                        |
 * | `domainName`                         | `'localhost'` (mock)                    |
 * | `identity.sourceIp`                  | `req.socket.remoteAddress` (real)       |
 * | `identity.userAgent`                 | Upgrade `User-Agent` header (real)      |
 * | `headers`/`queryStringParameters`    | Parsed from upgrade `req` (real)        |
 * | `authorizer`                         | `null` in v1 (deferred)                 |
 *
 * Per-event `eventType` / `routeKey` / `messageDirection` are fixed by
 * the lifecycle stage, NOT by the route's `routeKey` field — `routeKey`
 * carries which user-declared route fired ("$connect" / "$disconnect" /
 * "$default" / custom).
 */

const MOCK_ACCOUNT_ID = '123456789012';
const MOCK_DOMAIN_NAME = 'localhost';
const MOCK_API_ID = 'local';

/**
 * Request snapshot from the WebSocket upgrade handshake. The handshake is
 * a plain HTTP GET with `Upgrade: websocket`; cdkd extracts headers /
 * query string / source IP from the underlying `IncomingMessage` once at
 * `$connect` and reuses them for every subsequent event on the same
 * connection so the Lambda's event-context stays consistent.
 *
 * Headers are passed in their on-wire case; the builders lowercase them
 * per AWS spec.
 */
export interface WebSocketHandshakeSnapshot {
  /** Header map: header-name → array of values (multiple of the same name preserved). */
  headers: Record<string, string[]>;
  /** Raw query string (NOT decoded) from the upgrade URL. */
  rawQueryString: string;
  /** Parsed query parameters (decoded). Single-value: last wins. */
  queryStringParameters?: Record<string, string>;
  /** Multi-value query parameters preserved. */
  multiValueQueryStringParameters?: Record<string, string[]>;
  /** Source IP from `req.socket.remoteAddress`. */
  sourceIp?: string;
  /** User-Agent header (already extracted, for `identity.userAgent`). */
  userAgent?: string;
}

/**
 * Shared shape of the WebSocket event's `requestContext` field. Per-event
 * builders add the discriminator (`eventType`, `routeKey`, `messageId`)
 * plus event-specific fields like `disconnectStatusCode` on top of this.
 */
export interface WebSocketRequestContextBase {
  routeKey: string;
  eventType: 'CONNECT' | 'MESSAGE' | 'DISCONNECT';
  connectionId: string;
  extendedRequestId: string;
  requestTime: string;
  requestTimeEpoch: number;
  messageDirection: 'IN';
  stage: string;
  connectedAt: number;
  requestId: string;
  domainName: string;
  apiId: string;
  authorizer: null;
  identity: {
    accountId: string;
    sourceIp: string;
    userAgent: string;
  };
}

/** Top-level event object passed to the route's Lambda. */
export interface WebSocketLambdaEvent {
  /** Header map (lowercase keys, comma-joined when multi-valued). */
  headers?: Record<string, string>;
  /** Multi-value headers (lowercase keys). */
  multiValueHeaders?: Record<string, string[]>;
  /** Query string parameters (single-value, last wins). */
  queryStringParameters?: Record<string, string> | null;
  /** Multi-value query parameters. */
  multiValueQueryStringParameters?: Record<string, string[]> | null;
  /** Request context with routing / identity metadata. */
  requestContext: WebSocketRequestContextBase & Record<string, unknown>;
  /** Always `false` in v1 — frame bodies are passed through as text. */
  isBase64Encoded: boolean;
  /** Frame body for MESSAGE events; empty string on CONNECT / DISCONNECT. */
  body: string;
}

/**
 * Build a request-context block shared across all three event types.
 * `eventType` / `routeKey` are passed in by the per-event caller; the
 * shared block produces fresh `requestId` / `extendedRequestId` per
 * event (matching AWS-deployed behavior — these are NOT stable across
 * events on the same connection).
 */
function buildRequestContext(
  routeKey: string,
  eventType: 'CONNECT' | 'MESSAGE' | 'DISCONNECT',
  connectionId: string,
  connectedAt: number,
  stage: string,
  snapshot: WebSocketHandshakeSnapshot
): WebSocketRequestContextBase {
  const now = Date.now();
  return {
    routeKey,
    eventType,
    connectionId,
    extendedRequestId: randomUUID(),
    requestTime: formatRequestTime(now),
    requestTimeEpoch: now,
    messageDirection: 'IN',
    stage,
    connectedAt,
    requestId: randomUUID(),
    domainName: MOCK_DOMAIN_NAME,
    apiId: MOCK_API_ID,
    authorizer: null,
    identity: {
      // Mirror AWS-deployed WebSocket events: `requestContext.identity.accountId`
      // carries the API owner's account id. Local emulation hard-codes the
      // shared mock account so handler code reading this field is non-undefined,
      // matching the deployed surface. The constant is exported via
      // `WEBSOCKET_MOCK_CONSTANTS` so integ tests + handlers can assert against
      // the same value.
      accountId: MOCK_ACCOUNT_ID,
      sourceIp: snapshot.sourceIp ?? '127.0.0.1',
      userAgent: snapshot.userAgent ?? '',
    },
  };
}

/**
 * Build the `$connect` event. AWS WebSocket APIs fire `$connect` ONCE
 * per client connection. Handler returns `{statusCode: 200}` to allow
 * the connection, anything else (or throws) to deny — cdkd matches the
 * deployed behavior by checking the response in the caller.
 */
export function buildConnectEvent(opts: {
  connectionId: string;
  connectedAt: number;
  stage: string;
  snapshot: WebSocketHandshakeSnapshot;
}): WebSocketLambdaEvent {
  const headers = normalizeHeaders(opts.snapshot.headers);
  const multiValueHeaders = lowercaseMultiValueHeaders(opts.snapshot.headers);
  return {
    ...(headers !== undefined && { headers }),
    ...(multiValueHeaders !== undefined && { multiValueHeaders }),
    queryStringParameters: opts.snapshot.queryStringParameters ?? null,
    multiValueQueryStringParameters: opts.snapshot.multiValueQueryStringParameters ?? null,
    requestContext: {
      ...buildRequestContext(
        '$connect',
        'CONNECT',
        opts.connectionId,
        opts.connectedAt,
        opts.stage,
        opts.snapshot
      ),
    },
    isBase64Encoded: false,
    body: '',
  };
}

/**
 * Build a MESSAGE event. Fires for every frame the client sends. The
 * route the API dispatches to is resolved upstream by the route
 * selection-expression layer; the resolved `routeKey` (`$default` or
 * a custom string) lands on `requestContext.routeKey`.
 */
export function buildMessageEvent(opts: {
  connectionId: string;
  connectedAt: number;
  stage: string;
  snapshot: WebSocketHandshakeSnapshot;
  routeKey: string;
  body: string;
  /**
   * Whether the body is base64-encoded. True iff the source WebSocket
   * frame was binary (opcode 0x2); false for text frames (opcode 0x1).
   * Matches AWS-deployed WebSocket API semantics — handlers reading
   * `event.body` decode with `Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8')`.
   * Hardcoding this to `false` (pre-fix) silently corrupted every byte
   * > 0x7F because the UTF-8 decoder rejected / replaced binary bytes.
   */
  isBase64Encoded: boolean;
}): WebSocketLambdaEvent {
  return {
    requestContext: {
      ...buildRequestContext(
        opts.routeKey,
        'MESSAGE',
        opts.connectionId,
        opts.connectedAt,
        opts.stage,
        opts.snapshot
      ),
      messageId: randomUUID(),
    },
    isBase64Encoded: opts.isBase64Encoded,
    body: opts.body,
  };
}

/**
 * Build the `$disconnect` event. Fires when the WebSocket closes from
 * either side (client / server / abnormal). The Lambda's response is
 * ignored (the socket is already gone); AWS still invokes the handler
 * for cleanup / logging side effects.
 *
 * `disconnectStatusCode` / `disconnectReason` are taken from the
 * WebSocket close frame (RFC 6455 §7.1.5 — close codes such as 1000
 * normal / 1001 going-away / 1008 policy-violation).
 */
export function buildDisconnectEvent(opts: {
  connectionId: string;
  connectedAt: number;
  stage: string;
  snapshot: WebSocketHandshakeSnapshot;
  disconnectStatusCode?: number;
  disconnectReason?: string;
}): WebSocketLambdaEvent {
  return {
    requestContext: {
      ...buildRequestContext(
        '$disconnect',
        'DISCONNECT',
        opts.connectionId,
        opts.connectedAt,
        opts.stage,
        opts.snapshot
      ),
      ...(opts.disconnectStatusCode !== undefined && {
        disconnectStatusCode: opts.disconnectStatusCode,
      }),
      ...(opts.disconnectReason !== undefined && {
        disconnectReason: opts.disconnectReason,
      }),
    },
    isBase64Encoded: false,
    body: '',
  };
}

/**
 * Format a timestamp in the AWS-canonical `dd/MMM/yyyy:HH:mm:ss +0000`
 * shape that AWS API Gateway emits on `requestContext.requestTime`.
 * Always UTC (matches AWS-deployed behavior, which is region-independent).
 */
function formatRequestTime(epochMs: number): string {
  const d = new Date(epochMs);
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ][d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const hour = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const sec = String(d.getUTCSeconds()).padStart(2, '0');
  return `${day}/${month}/${year}:${hour}:${min}:${sec} +0000`;
}

/**
 * Lowercase header keys, comma-join duplicates per AWS spec.
 */
function normalizeHeaders(headers: Record<string, string[]>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  let any = false;
  for (const [name, values] of Object.entries(headers)) {
    if (values.length === 0) continue;
    out[name.toLowerCase()] = values.join(',');
    any = true;
  }
  return any ? out : undefined;
}

/**
 * Lowercase header keys, preserve multi-value array shape.
 */
function lowercaseMultiValueHeaders(
  headers: Record<string, string[]>
): Record<string, string[]> | undefined {
  const out: Record<string, string[]> = {};
  let any = false;
  for (const [name, values] of Object.entries(headers)) {
    if (values.length === 0) continue;
    out[name.toLowerCase()] = [...values];
    any = true;
  }
  return any ? out : undefined;
}

// Re-export the mock identifiers so tests + integ helpers can verify
// the expected mock values without redefining them.
export const WEBSOCKET_MOCK_CONSTANTS = {
  accountId: MOCK_ACCOUNT_ID,
  domainName: MOCK_DOMAIN_NAME,
  apiId: MOCK_API_ID,
} as const;
