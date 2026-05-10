import { randomUUID } from 'node:crypto';
import type { DiscoveredRoute } from './route-discovery.js';

/**
 * HTTP request shape the event-builders consume. Decoupled from
 * `node:http`'s `IncomingMessage` so the builders are pure-functional and
 * unit-testable without a real socket.
 */
export interface HttpRequestSnapshot {
  /** HTTP method, uppercased (`GET` / `POST` / ...). */
  method: string;
  /**
   * Full URL path including query string, NOT decoded. Example:
   * `/items/123?foo=bar%20baz&foo=baz`.
   */
  rawUrl: string;
  /**
   * Headers as a key → array map (multiple values per name preserved).
   * Header names should be passed in their on-wire case; the builders
   * lowercase them per spec.
   */
  headers: Record<string, string[]>;
  /** Request body as a Buffer. Empty body → zero-length Buffer. */
  body: Buffer;
  /** The remote socket address (`socket.remoteAddress`). May be undefined. */
  sourceIp?: string;
}

/**
 * The matched route plus the path-parameter capture map produced by the
 * route-matcher. `matchedPath` is the literal request path that matched
 * (with placeholders substituted), used for `requestContext.http.path`.
 */
export interface MatchedRouteContext {
  route: DiscoveredRoute;
  pathParameters: Record<string, string>;
  /** The literal request path (e.g. `/items/123`) — not decoded. */
  matchedPath: string;
}

const MOCK_ACCOUNT_ID = '123456789012';
const MOCK_DOMAIN_PREFIX = 'local';
const MOCK_DOMAIN_NAME = 'localhost';
const MOCK_API_ID = 'local';

/**
 * Build the HTTP API v2 / Function URL event payload.
 *
 * Spec: https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-lambda.html#http-api-develop-integrations-lambda.proxy-format
 *
 * Key points (C4 / C5 / C11 / C14):
 *   - Header names are lowercased; duplicate-named headers are joined with
 *     `,` into a single string (NOT an array).
 *   - Cookies live in their own `cookies: string[]` field, separated from
 *     `headers` by splitting the `cookie` header on `; `.
 *   - `rawPath` / `rawQueryString` are NOT decoded.
 *   - `pathParameters` / `queryStringParameters` values ARE
 *     `decodeURIComponent`'d.
 *   - `stageVariables: null` (explicit null, not undefined).
 *   - `requestContext.authorizer: null` and `requestContext.authentication:
 *     null` (explicit nulls — `"authorizer" in event.requestContext` is a
 *     real check pattern in user code).
 *   - `body` is base64 when the content is binary; otherwise UTF-8.
 *     Heuristic: when the headers carry a textual content-type
 *     (`text/*`, `application/json`, `application/xml`, `application/javascript`,
 *     `application/x-www-form-urlencoded`, `application/graphql`), the body is
 *     UTF-8; otherwise base64. Mirrors what API Gateway emits.
 */
export function buildHttpApiV2Event(
  req: HttpRequestSnapshot,
  ctx: MatchedRouteContext,
  opts: { now?: () => Date } = {}
): Record<string, unknown> {
  const { rawPath, rawQueryString } = splitRawUrl(req.rawUrl);
  const { headers, cookies } = normalizeHeadersV2(req.headers);
  const queryStringParameters = parseQueryStringV2(rawQueryString);
  const userAgent = headers['user-agent'] ?? '';
  const contentType = headers['content-type'] ?? '';
  const { body, isBase64Encoded } = encodeBody(req.body, contentType);
  const now = opts.now ? opts.now() : new Date();

  const routeKey =
    ctx.route.pathPattern === '$default'
      ? '$default'
      : `${ctx.route.method} ${ctx.route.pathPattern}`;

  const event: Record<string, unknown> = {
    version: '2.0',
    routeKey,
    rawPath,
    rawQueryString,
    cookies,
    headers,
    queryStringParameters,
    pathParameters: decodePathParameters(ctx.pathParameters),
    stageVariables: null,
    requestContext: {
      accountId: MOCK_ACCOUNT_ID,
      apiId: MOCK_API_ID,
      domainName: MOCK_DOMAIN_NAME,
      domainPrefix: MOCK_DOMAIN_PREFIX,
      http: {
        method: req.method.toUpperCase(),
        path: ctx.matchedPath,
        protocol: 'HTTP/1.1',
        sourceIp: req.sourceIp ?? '127.0.0.1',
        userAgent,
      },
      requestId: randomUUID(),
      routeKey,
      stage: ctx.route.stage,
      time: formatRequestTime(now),
      timeEpoch: now.getTime(),
      authentication: null,
      authorizer: null,
    },
    body,
    isBase64Encoded,
  };
  return event;
}

/**
 * Build the REST v1 proxy event payload (the legacy shape used by
 * `AWS::ApiGateway::Method` integrations of type AWS_PROXY).
 *
 * Spec: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format
 *
 * Differences from v2:
 *   - Header / query-string duplicates are kept in dedicated
 *     `multiValueHeaders` / `multiValueQueryStringParameters` arrays
 *     **alongside** the singular maps (the singular form keeps the LAST
 *     value, matching API Gateway behavior).
 *   - Cookies stay inline in the `cookie` header — there is no separate
 *     `cookies` array.
 *   - `requestContext` is REST-flavored (no `http` sub-object); identity
 *     and stage live at the top level of requestContext.
 *   - `pathParameters` may be `null` when there are none (matches AWS).
 */
export function buildRestV1Event(
  req: HttpRequestSnapshot,
  ctx: MatchedRouteContext,
  opts: { now?: () => Date } = {}
): Record<string, unknown> {
  const { rawPath, rawQueryString } = splitRawUrl(req.rawUrl);
  const { singular: headers, multi: multiValueHeaders } = normalizeHeadersV1(req.headers);
  const { singular: queryStringParameters, multi: multiValueQueryStringParameters } =
    parseQueryStringV1(rawQueryString);
  const contentType = headers['content-type'] ?? '';
  const { body, isBase64Encoded } = encodeBody(req.body, contentType);
  const now = opts.now ? opts.now() : new Date();

  const pathParams = decodePathParameters(ctx.pathParameters);
  const event: Record<string, unknown> = {
    resource: ctx.route.pathPattern,
    path: ctx.matchedPath,
    httpMethod: req.method.toUpperCase(),
    headers,
    multiValueHeaders,
    queryStringParameters:
      Object.keys(queryStringParameters).length > 0 ? queryStringParameters : null,
    multiValueQueryStringParameters:
      Object.keys(multiValueQueryStringParameters).length > 0
        ? multiValueQueryStringParameters
        : null,
    pathParameters: Object.keys(pathParams).length > 0 ? pathParams : null,
    stageVariables: null,
    requestContext: {
      accountId: MOCK_ACCOUNT_ID,
      apiId: MOCK_API_ID,
      domainName: MOCK_DOMAIN_NAME,
      domainPrefix: MOCK_DOMAIN_PREFIX,
      httpMethod: req.method.toUpperCase(),
      identity: {
        sourceIp: req.sourceIp ?? '127.0.0.1',
        userAgent: headers['user-agent'] ?? '',
      },
      path: `/${ctx.route.stage}${ctx.matchedPath}`,
      protocol: 'HTTP/1.1',
      requestId: randomUUID(),
      requestTime: formatRequestTime(now),
      requestTimeEpoch: now.getTime(),
      resourcePath: ctx.route.pathPattern,
      stage: ctx.route.stage,
      authorizer: null,
    },
    body: req.body.length === 0 ? null : body,
    isBase64Encoded,
  };
  // C11: rawPath isn't part of the v1 spec but we keep the rawQueryString
  // line out — RestV1 doesn't expose it directly. Consumers wanting raw
  // values can re-decode the singular maps.
  void rawPath;
  return event;
}

/**
 * Split the request URL into `rawPath` (everything before `?`) and
 * `rawQueryString` (everything after, or `''`). Neither component is
 * decoded — that's the whole point of "raw" per the AWS spec.
 */
function splitRawUrl(rawUrl: string): { rawPath: string; rawQueryString: string } {
  const q = rawUrl.indexOf('?');
  if (q === -1) return { rawPath: rawUrl, rawQueryString: '' };
  return { rawPath: rawUrl.slice(0, q), rawQueryString: rawUrl.slice(q + 1) };
}

/**
 * V2 header normalization (C14): lowercase every header name, comma-join
 * duplicate values into a single string, and split out the `cookie`
 * header into a `cookies` array (C5).
 */
function normalizeHeadersV2(rawHeaders: Record<string, string[]>): {
  headers: Record<string, string>;
  cookies: string[];
} {
  const headers: Record<string, string> = {};
  let cookies: string[] = [];
  for (const [name, values] of Object.entries(rawHeaders)) {
    const lower = name.toLowerCase();
    if (lower === 'cookie') {
      // Spec: split the request `Cookie:` header on `;` (with optional
      // surrounding whitespace) into individual `name=value` cookies.
      cookies = values
        .flatMap((v) => v.split(';'))
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      continue;
    }
    headers[lower] = values.join(',');
  }
  return { headers, cookies };
}

/**
 * V1 header normalization: lowercase every name and produce BOTH the
 * singular map (last value wins per AWS behavior) and the multi-value
 * map (every value preserved).
 */
function normalizeHeadersV1(rawHeaders: Record<string, string[]>): {
  singular: Record<string, string>;
  multi: Record<string, string[]>;
} {
  const singular: Record<string, string> = {};
  const multi: Record<string, string[]> = {};
  for (const [name, values] of Object.entries(rawHeaders)) {
    const lower = name.toLowerCase();
    if (values.length === 0) continue;
    multi[lower] = [...values];
    singular[lower] = values[values.length - 1]!;
  }
  return { singular, multi };
}

/**
 * V2 query-string parsing (C11 / C14): names and values are
 * `decodeURIComponent`'d; duplicate-named pairs are comma-joined into a
 * single value.
 */
function parseQueryStringV2(rawQueryString: string): Record<string, string> {
  if (rawQueryString.length === 0) return {};
  const out: Record<string, string[]> = {};
  for (const pair of rawQueryString.split('&')) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? '' : pair.slice(eq + 1);
    const key = safeDecode(rawKey);
    const value = safeDecode(rawValue);
    if (!out[key]) out[key] = [];
    out[key].push(value);
  }
  const result: Record<string, string> = {};
  for (const [k, vs] of Object.entries(out)) result[k] = vs.join(',');
  return result;
}

/**
 * V1 query-string parsing: same decoding rules, but produce BOTH a
 * singular (last-wins) map and a multi-value map, matching the v1 event
 * shape.
 */
function parseQueryStringV1(rawQueryString: string): {
  singular: Record<string, string>;
  multi: Record<string, string[]>;
} {
  const multi: Record<string, string[]> = {};
  if (rawQueryString.length > 0) {
    for (const pair of rawQueryString.split('&')) {
      if (pair.length === 0) continue;
      const eq = pair.indexOf('=');
      const rawKey = eq === -1 ? pair : pair.slice(0, eq);
      const rawValue = eq === -1 ? '' : pair.slice(eq + 1);
      const key = safeDecode(rawKey);
      const value = safeDecode(rawValue);
      if (!multi[key]) multi[key] = [];
      multi[key].push(value);
    }
  }
  const singular: Record<string, string> = {};
  for (const [k, vs] of Object.entries(multi)) {
    if (vs.length > 0) singular[k] = vs[vs.length - 1]!;
  }
  return { singular, multi };
}

/**
 * Decode every value in a path-parameter map. Keys are always literal
 * names from the route pattern (no decoding needed); values come from the
 * URL and are `decodeURIComponent`'d per C11.
 */
function decodePathParameters(pathParameters: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(pathParameters)) {
    out[k] = safeDecode(v);
  }
  return out;
}

/**
 * Decode a URL component, falling back to the raw value when
 * `decodeURIComponent` throws on an invalid escape sequence (`%ZZ`).
 * Mirrors API Gateway's lenient behavior.
 */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Encode a Buffer as the event's `body` string + `isBase64Encoded` flag.
 *
 * Heuristic: textual content types pass through as UTF-8; everything else
 * is base64. The list of textual prefixes mirrors what real API Gateway
 * emits when the integration is a Lambda Proxy.
 */
function encodeBody(body: Buffer, contentType: string): { body: string; isBase64Encoded: boolean } {
  if (body.length === 0) {
    return { body: '', isBase64Encoded: false };
  }
  if (isTextualContentType(contentType)) {
    return { body: body.toString('utf-8'), isBase64Encoded: false };
  }
  return { body: body.toString('base64'), isBase64Encoded: true };
}

const TEXT_PREFIXES = [
  'text/',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-www-form-urlencoded',
  'application/graphql',
];

/**
 * Whether the given `Content-Type` value indicates textual data (so the
 * event body should be UTF-8 instead of base64).
 */
function isTextualContentType(contentType: string): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return TEXT_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * Format a Date as the API Gateway request-time string
 * (`10/May/2026:12:00:00 +0000`). Always emits UTC — the local server is
 * not timezone-aware and consistency is more useful than developer-locale
 * accuracy.
 */
function formatRequestTime(d: Date): string {
  const months = [
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
  ];
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mmm = months[d.getUTCMonth()]!;
  const yyyy = d.getUTCFullYear();
  const HH = String(d.getUTCHours()).padStart(2, '0');
  const MM = String(d.getUTCMinutes()).padStart(2, '0');
  const SS = String(d.getUTCSeconds()).padStart(2, '0');
  return `${dd}/${mmm}/${yyyy}:${HH}:${MM}:${SS} +0000`;
}
