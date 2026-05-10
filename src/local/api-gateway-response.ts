/**
 * Translate a Lambda RIE response payload into HTTP response components
 * the local server can write back to the user.
 *
 * Three cases (C6 / C7):
 *   1. **Shaped response** — the payload has a `statusCode`. Use the
 *      caller-provided status / headers / cookies / body / isBase64Encoded
 *      directly.
 *   2. **Lambda runtime error envelope** — the payload has `errorMessage`
 *      / `errorType` and **no statusCode**. The handler threw. Return HTTP
 *      502 with body `{"message":"Internal server error"}`. Stack trace
 *      stays in the server log; the wire response does NOT leak it.
 *   3. **Auto-format heuristic** — the payload is "valid JSON without
 *      `statusCode`". Wrap it as a 200 + JSON body with `content-type:
 *      application/json`. (NOTE: the trigger is "valid JSON", NOT "string
 *      body" — the pre-review draft was wrong on this.)
 *
 * Cookies in the shaped case (C5): the v2 spec uses a `cookies: string[]`
 * array which the server emits as **multiple** `Set-Cookie:` HTTP headers
 * (NOT comma-joined into one).
 */

export interface TranslatedHttpResponse {
  statusCode: number;
  /**
   * Single-valued headers: name → value. Names are lowercased and emitted
   * as-is. The `set-cookie` key is NOT in this map — cookies live in
   * `cookies` so the server can emit one header per entry.
   */
  headers: Record<string, string>;
  /** One value per cookie. Each is a full `Set-Cookie:` header value. */
  cookies: string[];
  /** Body bytes ready to write to the socket. */
  body: Buffer;
}

/**
 * Translate a Lambda RIE response into the HTTP components.
 *
 * @param payload   The parsed JSON payload returned by RIE. Already-failed
 *                  JSON parses upstream surface as a malformed body and
 *                  callers should treat them as the error-envelope case
 *                  (HTTP 502); pass `undefined` here to land on the
 *                  auto-format branch with `body: ''`.
 * @param version   Event version this response corresponds to. v1 ignores
 *                  the `cookies` array (REST v1 has no separate cookies
 *                  field — set-cookie is just another response header);
 *                  v2 separates them.
 */
export function translateLambdaResponse(
  payload: unknown,
  version: 'v1' | 'v2'
): TranslatedHttpResponse {
  // (3) Lambda runtime error envelope → 502.
  if (isErrorEnvelope(payload)) {
    return errorEnvelopeResponse();
  }

  // (1) Shaped response.
  if (isShapedResponse(payload)) {
    return translateShapedResponse(payload, version);
  }

  // (2) Auto-format: any other JSON-able payload → 200 + JSON body.
  return autoFormatResponse(payload);
}

/**
 * Shape detection for the Lambda runtime's error response. RIE wraps a
 * thrown error in `{errorMessage, errorType, stackTrace, ...}`. Detection
 * relies on the `errorMessage` key + absence of `statusCode` — the latter
 * matters because user code MAY return a Lambda Proxy response that
 * happens to have `errorMessage` as a payload field.
 */
function isErrorEnvelope(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const obj = payload as Record<string, unknown>;
  if ('statusCode' in obj) return false;
  return typeof obj['errorMessage'] === 'string';
}

/**
 * Shape detection for a Lambda Proxy / Function URL response — must be a
 * plain object with a numeric `statusCode`.
 */
function isShapedResponse(payload: unknown): payload is Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const status = (payload as Record<string, unknown>)['statusCode'];
  return typeof status === 'number';
}

/**
 * Build the canonical 502 response for the Lambda-runtime-error case.
 * Body matches what real API Gateway returns when an integration response
 * fails; client code that fans out on `502 Bad Gateway` works
 * unchanged.
 */
function errorEnvelopeResponse(): TranslatedHttpResponse {
  const body = Buffer.from('{"message":"Internal server error"}', 'utf-8');
  return {
    statusCode: 502,
    headers: {
      'content-type': 'application/json',
      'content-length': String(body.length),
    },
    cookies: [],
    body,
  };
}

/**
 * Translate a Lambda Proxy / Function URL response to HTTP components.
 *
 * Header normalization:
 *   - The handler may emit headers under any case (`Content-Type`,
 *     `content-type`, `CONTENT-TYPE`); we lowercase every name for the
 *     wire write so the server's behavior is predictable.
 *   - `multiValueHeaders` (v1 spec) are merged into the single map by
 *     comma-joining their values. v2 doesn't surface multiValueHeaders;
 *     `set-cookie` lives in the `cookies` array instead.
 *   - `set-cookie` removed from `headers` and pushed onto `cookies` so
 *     the server emits multiple `Set-Cookie:` lines (one per entry).
 */
function translateShapedResponse(
  payload: Record<string, unknown>,
  version: 'v1' | 'v2'
): TranslatedHttpResponse {
  const statusCode = Number(payload['statusCode']);
  const isBase64 = payload['isBase64Encoded'] === true;
  const rawBody = payload['body'];

  let body: Buffer;
  if (rawBody === undefined || rawBody === null) {
    body = Buffer.alloc(0);
  } else if (typeof rawBody === 'string') {
    body = isBase64 ? Buffer.from(rawBody, 'base64') : Buffer.from(rawBody, 'utf-8');
  } else {
    body = Buffer.from(JSON.stringify(rawBody), 'utf-8');
  }

  const headers: Record<string, string> = {};
  const cookies: string[] = [];

  // Singular headers map.
  const headersIn = payload['headers'];
  if (headersIn && typeof headersIn === 'object' && !Array.isArray(headersIn)) {
    for (const [name, value] of Object.entries(headersIn as Record<string, unknown>)) {
      const lower = name.toLowerCase();
      const stringValue = stringifyHeaderValue(value);
      if (lower === 'set-cookie') {
        cookies.push(stringValue);
        continue;
      }
      headers[lower] = stringValue;
    }
  }

  // v1: multiValueHeaders override / extend the singular map.
  if (version === 'v1') {
    const mvh = payload['multiValueHeaders'];
    if (mvh && typeof mvh === 'object' && !Array.isArray(mvh)) {
      for (const [name, values] of Object.entries(mvh as Record<string, unknown>)) {
        if (!Array.isArray(values)) continue;
        const lower = name.toLowerCase();
        const stringified = values.map((v) => stringifyHeaderValue(v));
        if (lower === 'set-cookie') {
          for (const c of stringified) cookies.push(c);
          continue;
        }
        headers[lower] = stringified.join(',');
      }
    }
  }

  // v2: cookies array (preferred form).
  if (version === 'v2') {
    const cookieList = payload['cookies'];
    if (Array.isArray(cookieList)) {
      for (const c of cookieList) {
        if (typeof c === 'string') cookies.push(c);
      }
    }
  }

  // content-length is informational; we always emit one based on the
  // actual body bytes so partial writes don't lie about the size.
  if (!('content-length' in headers)) {
    headers['content-length'] = String(body.length);
  }

  return { statusCode, headers, cookies, body };
}

/**
 * Wrap an unshaped payload as a 200 + JSON body. Triggered when the
 * response is "valid JSON without statusCode" — the C6 fix-up to the
 * pre-review draft's incorrect "string body" trigger.
 */
function autoFormatResponse(payload: unknown): TranslatedHttpResponse {
  const body =
    payload === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload), 'utf-8');
  return {
    statusCode: 200,
    headers: {
      'content-type': 'application/json',
      'content-length': String(body.length),
    },
    cookies: [],
    body,
  };
}

/**
 * Stringify a header value while accepting the loose shapes user code
 * might return (`number`, `boolean`, `null`, etc.). Arrays are
 * comma-joined to match the same dup-coalesce rule used on the request
 * side.
 */
function stringifyHeaderValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((v) => String(v)).join(',');
  return String(value);
}
