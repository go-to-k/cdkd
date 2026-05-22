/**
 * REST v1 non-AWS_PROXY integration dispatchers for `cdkd local start-api`
 * (#457).
 *
 * Five integration kinds are supported:
 *
 *   - **`AWS_PROXY`** — handled by the existing AWS_PROXY path in
 *     `http-server.ts`. NOT a concern of this module.
 *   - **`AWS`** (Lambda non-proxy with VTL): apply
 *     `Integration.RequestTemplates['<content-type>']` (VTL) to the
 *     request body to produce the Lambda event payload, invoke the
 *     Lambda via RIE, apply
 *     `IntegrationResponses[N].ResponseTemplates['<content-type>']` to
 *     the Lambda return value. `IntegrationResponses[N].SelectionPattern`
 *     drives status-code selection (regex against Lambda's
 *     `errorMessage` field).
 *   - **`HTTP_PROXY`** — forward the HTTP request to `Integration.Uri`
 *     mostly verbatim. `Integration.RequestParameters` (header / path /
 *     query rewrites) apply. No VTL.
 *   - **`HTTP`** (non-proxy) — same as HTTP_PROXY but VTL templates
 *     transform request + response.
 *   - **`MOCK`** (non-CORS-preflight subset) — evaluate
 *     `IntegrationResponses[N].ResponseTemplates['application/json']` as
 *     VTL against an empty input. Status code from
 *     `IntegrationResponses[N].StatusCode`.
 *
 * Each dispatcher returns a `RestV1IntegrationOutcome` the http-server
 * pipes onto the `ServerResponse`. The dispatchers themselves are
 * pure-functional (no `ServerResponse` mutation) so they're easy to
 * unit-test.
 *
 * Limitations
 * -----------
 *
 *   - VTL features outside the supported subset (see
 *     `src/local/vtl-engine.ts` for the full list) surface a clear error
 *     via `VtlEvaluationError`; cdkd's dispatcher catches it and emits a
 *     `502 Bad Gateway` with the template + error name in the body. AWS
 *     would surface a similar 5xx for VTL evaluation failures.
 *   - `Integration.RequestParameters` mapping expressions
 *     (`integration.request.header.X = method.request.header.Y`) are
 *     implemented for direction = REQUEST. The reverse direction is
 *     handled by `evaluateResponseParameters` in
 *     `integration-response-selector.ts`.
 *   - The HTTP_PROXY / HTTP dispatchers do NOT verify TLS certificates
 *     against the system CA store — uses Node's default fetch behavior.
 *     This is acceptable for local-dev (the upstream URL is the user's
 *     own).
 *   - **SSRF surface**: `Integration.Uri` is accepted verbatim and
 *     passed to `fetch()`; cdkd does NOT block private / loopback /
 *     link-local destinations. A `warnSsrfRiskyUri()` helper surfaces a
 *     warn at server boot when an Uri's hostname resolves to a
 *     well-known internal address (IMDS, loopback, link-local, RFC1918)
 *     so users see the risk in their integ logs. Threading an
 *     `--allow-internal-uri` block flag is deferred — this is a
 *     developer-loop tool, not a security boundary; warn-and-proceed
 *     matches the precedent set by the cognito JWKS pass-through
 *     fallback. The source URI is the user's own CDK template, so the
 *     attack surface requires a malicious cdk.out or templated value.
 */

import type { ContainerPool } from './container-pool.js';
import { invokeRie } from './rie-client.js';
import {
  evaluateResponseParameters,
  pickResponseTemplate,
  selectIntegrationResponse,
  tryParseStatus,
  type IntegrationResponseEntry,
} from './integration-response-selector.js';
import {
  buildDefaultUtil,
  buildVtlInput,
  buildVtlRequestContext,
  evaluateVtl,
  VtlEvaluationError,
  type VtlContext,
} from './vtl-engine.js';
import { getLogger } from '../utils/logger.js';

/**
 * Per-request snapshot the dispatchers consume. Mirrors the shape
 * `http-server.handleRequest` already builds for AWS_PROXY — keeping
 * this aligned simplifies the dispatch wiring.
 */
export interface RestV1IntegrationRequest {
  /** HTTP method (uppercase). */
  method: string;
  /** Request path AFTER matching (relative to API root). */
  matchedPath: string;
  /** Path parameters from {param} placeholders. */
  pathParameters: Record<string, string>;
  /** Query-string single-value form (last wins on duplicates). */
  querystring: Record<string, string>;
  /** Header single-value form (lowercased, comma-joined dupes). */
  headers: Record<string, string>;
  /** Raw request body as a Buffer. */
  body: Buffer;
  /** Client source IP (for `$context.identity.sourceIp`). */
  sourceIp: string;
  /** User agent header (for `$context.identity.userAgent`). */
  userAgent: string;
  /** Route's stage name (for `$context.stage`). */
  stage: string;
  /** Route's path pattern (for `$context.resourcePath`). */
  resourcePath: string;
  /** Synthesized request ID (UUID-shape, opaque). */
  requestId: string;
}

/**
 * What the dispatchers return — the http-server applies this to the
 * outgoing `ServerResponse`.
 */
export interface RestV1IntegrationOutcome {
  /** Final HTTP status code. */
  statusCode: number;
  /** Response headers (lowercase keys; case is preserved on output). */
  headers: Record<string, string>;
  /** Response body. May be empty. */
  body: string | Buffer;
}

/**
 * Configuration passed by the http-server to every dispatcher — the
 * shared services (container pool, timeouts) live here so the
 * dispatchers themselves take only request data.
 */
export interface RestV1DispatcherDeps {
  /**
   * Used by AWS Lambda non-proxy to acquire a warm RIE container. The
   * dispatcher only invokes `acquire` + `release`; the narrower
   * `Pick<ContainerPool, ...>` shape lets unit tests pass a minimal
   * mock without an `as any` cast (PR #515 item 5).
   */
  pool: Pick<ContainerPool, 'acquire' | 'release'>;
  /** RIE invoke timeout in ms. */
  rieTimeoutMs: number;
  /**
   * HTTP fetch override — Node's `fetch` by default; overridable for
   * unit tests against in-memory mock servers.
   */
  fetch?: typeof globalThis.fetch;
}

// ==================== MOCK integration ===================================

/**
 * MOCK integration body parsed at boot time. Only stores what the
 * dispatcher needs — the discovery layer is the single source for
 * `Integration.IntegrationResponses[]` translation.
 */
export interface MockIntegrationConfig {
  kind: 'mock';
  /**
   * `Integration.RequestTemplates['application/json']` (or first
   * available content type). MOCK uses the request template to drive
   * status-code selection — AWS reads `{"statusCode": <N>}` from the
   * rendered template and matches against `IntegrationResponses[].StatusCode`.
   */
  requestTemplate: string | undefined;
  /** Selected from `Integration.IntegrationResponses[]`. */
  responses: IntegrationResponseEntry[];
}

/**
 * Dispatch a MOCK integration. AWS MOCK semantics:
 *
 *   1. Render `RequestTemplates['application/json']` (VTL) against the
 *      request — yields a JSON object like `{"statusCode": 200}`.
 *   2. Parse the rendered JSON; pick the `IntegrationResponses[]` entry
 *      whose `StatusCode` equals the parsed `statusCode` (string compare,
 *      mirroring AWS).
 *   3. Render the picked entry's `ResponseTemplates[<content-type>]`
 *      against an empty body context and emit it.
 *   4. Apply `ResponseParameters` header literals.
 *
 * When no request template is configured AWS defaults to picking the
 * `IntegrationResponses[]` entry with `SelectionPattern === ''` (or the
 * first entry).
 */
export function dispatchMockIntegration(
  config: MockIntegrationConfig,
  req: RestV1IntegrationRequest
): RestV1IntegrationOutcome {
  const logger = getLogger().child('start-api');

  const ctx = buildVtlContextFromRequest(req, '');
  let pickedStatus: number | undefined;
  if (config.requestTemplate !== undefined && config.requestTemplate.trim().length > 0) {
    try {
      const rendered = evaluateVtl(config.requestTemplate, ctx);
      pickedStatus = extractStatusCodeFromRendered(rendered);
    } catch (err) {
      return vtlFailure('request', err, config.requestTemplate);
    }
  }

  // Find the matching response entry.
  let entry: IntegrationResponseEntry | null = null;
  if (pickedStatus !== undefined) {
    entry =
      config.responses.find((e) => tryParseStatus(e.StatusCode) === pickedStatus) ??
      defaultResponseEntry(config.responses);
  } else {
    entry = defaultResponseEntry(config.responses);
  }
  if (!entry) {
    return {
      statusCode: pickedStatus ?? 200,
      headers: { 'content-type': 'application/json' },
      body: '',
    };
  }

  const accept = req.headers['accept'];
  const picked = pickResponseTemplate(entry.ResponseTemplates, accept);
  // Build response context with `$inputRoot = null` (MOCK has no
  // backend body to feed into $inputRoot).
  const respCtx = buildVtlContextFromRequest(req, '', null);
  let body = '';
  let contentType = 'application/json';
  if (picked) {
    try {
      body = evaluateVtl(picked.template, respCtx);
    } catch (err) {
      return vtlFailure('response', err, picked.template);
    }
    contentType = picked.contentType;
  }

  const headers: Record<string, string> = { 'content-type': contentType };
  Object.assign(
    headers,
    evaluateResponseParameters(entry.ResponseParameters, {
      onUnsupported: (_k, _v, reason) => logger.warn(`MOCK response: ${reason}`),
    })
  );
  // Issue (#507) item 4: AWS API Gateway omits Content-Type on empty MOCK
  // responses; mirror that here. ResponseParameters can still set
  // Content-Type if the template ships an explicit literal — that overlay
  // already happened above, so checking on `headers['content-type']` (not
  // `contentType`) preserves the user's explicit setting.
  if (body === '' && headers['content-type'] === contentType) {
    delete headers['content-type'];
  }

  return {
    statusCode: tryParseStatus(entry.StatusCode) ?? 200,
    headers,
    body,
  };
}

// ==================== HTTP_PROXY integration ============================

export interface HttpProxyIntegrationConfig {
  kind: 'http-proxy';
  /** Upstream URL (may contain `{path}` placeholders matching method PathPart). */
  uri: string;
  /** Override method (`Integration.IntegrationHttpMethod`). Defaults to request method when missing. */
  integrationHttpMethod?: string;
  /**
   * `Integration.RequestParameters` — keys like
   * `integration.request.header.X` / `.path.X` / `.querystring.X`,
   * values pointing at request data or single-quoted literals.
   */
  requestParameters?: Record<string, string>;
  /** `IntegrationResponses[]` — entries shape the response. */
  responses: IntegrationResponseEntry[];
}

/**
 * Dispatch an HTTP_PROXY integration. The request is forwarded verbatim
 * with `RequestParameters` mappings applied; the response is also
 * forwarded verbatim (AWS does NOT apply ResponseTemplates on HTTP_PROXY,
 * only IntegrationResponses[].SelectionPattern routes the status code).
 */
export async function dispatchHttpProxyIntegration(
  config: HttpProxyIntegrationConfig,
  req: RestV1IntegrationRequest,
  deps: RestV1DispatcherDeps
): Promise<RestV1IntegrationOutcome> {
  const url = substituteUriPlaceholders(config.uri, req);
  const method = config.integrationHttpMethod ?? req.method;

  // Build request headers from the incoming request, then overlay
  // `RequestParameters`.
  const outHeaders: Record<string, string> = { ...req.headers };
  // Strip hop-by-hop / connection-specific headers.
  for (const drop of ['host', 'connection', 'content-length', 'transfer-encoding']) {
    delete outHeaders[drop];
  }
  applyRequestParameters(config.requestParameters, req, { headers: outHeaders });

  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const fetchInit: RequestInit = { method, headers: outHeaders };
  // Forward the request body whenever the client sent one — DO NOT gate
  // on method. Reasons: (a) the integration may override the method via
  // `IntegrationHttpMethod`, so a client POST may map to an upstream
  // GET that still wants the body (matches AWS behavior); (b) some
  // upstreams accept bodies on non-canonical methods like DELETE.
  // `content-length` is already stripped at outHeaders setup; fetch
  // recomputes it from `body`.
  if (req.body.length > 0) {
    fetchInit.body = new Uint8Array(req.body);
  }
  let upstream: Response;
  try {
    upstream = await fetchImpl(url, fetchInit);
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'HTTP_PROXY upstream unreachable',
        url,
        reason: err instanceof Error ? err.message : String(err),
      }),
    };
  }

  // Read the body BEFORE building the headers map: `fetch` auto-decodes
  // gzip/deflate/br and removes `content-encoding` from `upstream.headers`,
  // so reading the body first ensures the resulting bytes are decoded
  // plaintext. We then strip `content-encoding` (and `content-length`)
  // from the forwarded headers regardless — if fetch already removed it
  // the strip is a no-op, but a Response constructed from raw bytes in
  // tests may still carry the original encoding tag.
  const upstreamBody = Buffer.from(await upstream.arrayBuffer());
  // IntegrationResponses[].SelectionPattern matches against the status
  // code as a string. ALWAYS run the regex loop (PR #505 fix 14) —
  // a `SelectionPattern: '200'` entry IS expected to match a 200
  // upstream response.
  const selected = selectIntegrationResponse(
    config.responses,
    String(upstream.status),
    upstream.status
  );

  // For HTTP_PROXY, AWS forwards the upstream response shape verbatim
  // when no entry is selected — only ResponseParameters / Status come
  // from the selected entry.
  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  // Strip `content-encoding` (fetch already decoded the body — the
  // header would mislead downstream clients into double-decoding) and
  // `content-length` (the post-decode byte count differs from the
  // upstream's encoded one). Both are case-insensitive lookups against
  // the lowercased map.
  delete headers['content-encoding'];
  delete headers['content-length'];
  const logger = getLogger().child('start-api');
  Object.assign(
    headers,
    evaluateResponseParameters(selected.entry?.ResponseParameters, {
      onUnsupported: (_k, _v, reason) => logger.warn(`HTTP_PROXY response: ${reason}`),
    })
  );

  return {
    statusCode: selected.entry ? selected.statusCode : upstream.status,
    headers,
    body: upstreamBody,
  };
}

// ==================== HTTP non-proxy integration ========================

export interface HttpIntegrationConfig {
  kind: 'http';
  uri: string;
  integrationHttpMethod?: string;
  requestParameters?: Record<string, string>;
  /** `Integration.RequestTemplates[<content-type>]` — VTL-transformed body. */
  requestTemplates?: Record<string, string>;
  responses: IntegrationResponseEntry[];
}

/**
 * Dispatch an HTTP (non-proxy) integration: HTTP_PROXY + VTL on both
 * directions. Same upstream-call shape; the request body is transformed
 * via VTL, and the response body is transformed via VTL too.
 */
export async function dispatchHttpIntegration(
  config: HttpIntegrationConfig,
  req: RestV1IntegrationRequest,
  deps: RestV1DispatcherDeps
): Promise<RestV1IntegrationOutcome> {
  const logger = getLogger().child('start-api');
  const url = substituteUriPlaceholders(config.uri, req);
  const method = config.integrationHttpMethod ?? req.method;

  const ctx = buildVtlContextFromRequest(req, req.body.toString('utf-8'));
  const reqTemplate = pickRequestTemplate(config.requestTemplates, req.headers['content-type']);
  let outBody: string | undefined;
  let outContentType = req.headers['content-type'] ?? 'application/json';
  if (reqTemplate) {
    try {
      outBody = evaluateVtl(reqTemplate.template, ctx);
    } catch (err) {
      return vtlFailure('request', err, reqTemplate.template);
    }
    outContentType = reqTemplate.contentType;
  } else {
    outBody = req.body.toString('utf-8');
  }

  const outHeaders: Record<string, string> = { ...req.headers, 'content-type': outContentType };
  for (const drop of ['host', 'connection', 'content-length', 'transfer-encoding']) {
    delete outHeaders[drop];
  }
  applyRequestParameters(config.requestParameters, req, { headers: outHeaders });

  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const fetchInit: RequestInit = { method, headers: outHeaders };
  // Forward the (possibly VTL-rewritten) body whenever it is non-empty
  // — DO NOT gate on method (see HTTP_PROXY rationale). `outBody` is a
  // VTL-template render output when the integration has a
  // `RequestTemplates` entry, otherwise the raw client body as UTF-8.
  if (outBody !== undefined && outBody.length > 0) {
    fetchInit.body = outBody;
  }
  let upstream: Response;
  try {
    upstream = await fetchImpl(url, fetchInit);
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'HTTP upstream unreachable',
        url,
        reason: err instanceof Error ? err.message : String(err),
      }),
    };
  }

  // Read the upstream body. Branch on the upstream's Content-Type:
  // text-like content types (`text/*`, `application/json`,
  // `application/xml`, `application/x-www-form-urlencoded`) are decoded
  // as UTF-8 so the VTL ResponseTemplates can run against the body text.
  // Other content types (binary blobs — images, octet-stream, etc.) go
  // straight through as a Buffer so cdkd does not corrupt them via
  // UTF-8 decode. VTL templates that assume text against a binary
  // upstream are limited by this design — see the dispatcher docstring.
  const upstreamContentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
  const isUpstreamTextLike = isTextLikeContentType(upstreamContentType);
  let upstreamText: string | undefined;
  let upstreamBinary: Buffer | undefined;
  if (isUpstreamTextLike) {
    upstreamText = await upstream.text();
  } else {
    upstreamBinary = Buffer.from(await upstream.arrayBuffer());
  }

  // SelectionPattern always runs against the status string (PR #505 fix 14).
  const selected = selectIntegrationResponse(
    config.responses,
    String(upstream.status),
    upstream.status
  );

  // Render response template against the upstream body. Only available
  // on the text-decoded path; binary upstreams that pick a
  // ResponseTemplates entry surface a warn-and-pass-through (no VTL run).
  let body: string | Buffer;
  let contentType = upstreamContentType;
  if (selected.entry) {
    const picked = pickResponseTemplate(selected.entry.ResponseTemplates, req.headers['accept']);
    if (picked) {
      if (upstreamText === undefined) {
        // Upstream is binary but a ResponseTemplate is configured. VTL
        // requires the body as a string; cdkd cannot apply it without
        // corrupting binary content. Surface a warn and pass the binary
        // through as-is (matches the binary-pass-through fall-through
        // below).
        logger.warn(
          `HTTP response: ResponseTemplates set but upstream Content-Type ` +
            `'${upstreamContentType}' is binary; passing body through unchanged.`
        );
        body = upstreamBinary!;
      } else {
        const respCtx = buildVtlContextFromRequest(req, upstreamText, safeJsonParse(upstreamText));
        try {
          body = evaluateVtl(picked.template, respCtx);
        } catch (err) {
          return vtlFailure('response', err, picked.template);
        }
        contentType = picked.contentType;
      }
    } else {
      body = upstreamText ?? upstreamBinary!;
    }
  } else {
    body = upstreamText ?? upstreamBinary!;
  }

  const headers: Record<string, string> = { 'content-type': contentType };
  Object.assign(
    headers,
    evaluateResponseParameters(selected.entry?.ResponseParameters, {
      onUnsupported: (_k, _v, reason) => logger.warn(`HTTP response: ${reason}`),
    })
  );

  return {
    statusCode: selected.statusCode,
    headers,
    body,
  };
}

// ==================== AWS Lambda non-proxy integration ==================

export interface AwsLambdaIntegrationConfig {
  kind: 'aws-lambda';
  /** Logical id of the Lambda the integration invokes. */
  lambdaLogicalId: string;
  /** `Integration.RequestTemplates[<content-type>]` — VTL-transformed event. */
  requestTemplates?: Record<string, string>;
  /** `IntegrationResponses[]` — entries shape the HTTP response. */
  responses: IntegrationResponseEntry[];
}

/**
 * Dispatch an AWS (Lambda non-proxy) integration. The request body is
 * transformed via VTL into the Lambda event; the Lambda is invoked via
 * RIE; the return value is transformed via ResponseTemplates.
 *
 * AWS error routing: when the Lambda returns an object with an
 * `errorMessage` field (Node Lambda runtime convention), AWS treats it
 * as an error and matches `SelectionPattern` against the
 * `errorMessage`. Otherwise success.
 */
export async function dispatchAwsLambdaIntegration(
  config: AwsLambdaIntegrationConfig,
  req: RestV1IntegrationRequest,
  deps: RestV1DispatcherDeps
): Promise<RestV1IntegrationOutcome> {
  const logger = getLogger().child('start-api');

  const ctx = buildVtlContextFromRequest(req, req.body.toString('utf-8'));
  const template = pickRequestTemplate(config.requestTemplates, req.headers['content-type']);
  let eventPayload: unknown;
  if (template) {
    let rendered: string;
    try {
      rendered = evaluateVtl(template.template, ctx);
    } catch (err) {
      return vtlFailure('request', err, template.template);
    }
    // The template's output is typically JSON; parse it. If the template
    // is just a literal string the Lambda receives the string verbatim
    // (matches AWS — the SDK does no JSON parsing on the event payload).
    try {
      eventPayload = JSON.parse(rendered);
    } catch {
      eventPayload = rendered;
    }
  } else {
    // No template → pass the raw body. AWS docs: "When there is no
    // template, AWS passes through the body as-is."
    eventPayload = safeJsonParse(req.body.toString('utf-8')) ?? req.body.toString('utf-8');
  }

  // Acquire a warm RIE container for this Lambda.
  let handle;
  try {
    handle = await deps.pool.acquire(config.lambdaLogicalId);
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'Failed to acquire RIE container for AWS Lambda non-proxy integration',
        reason: err instanceof Error ? err.message : String(err),
      }),
    };
  }

  // Wrap every post-acquire path in `try { ... } finally { release }` so a
  // throw in the synchronous selectIntegrationResponse / pickResponseTemplate
  // / evaluateVtl block (very unlikely but possible on an exotic template)
  // never strands the warm container — matches the buffered AWS_PROXY path's
  // pattern in `http-server.ts` (Issue (#507) item 1).
  try {
    let invokeOutcome;
    try {
      invokeOutcome = await invokeRie(
        handle.containerHost,
        handle.hostPort,
        eventPayload,
        deps.rieTimeoutMs
      );
    } catch (err) {
      return {
        statusCode: 502,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: 'AWS Lambda non-proxy invocation failed',
          reason: err instanceof Error ? err.message : String(err),
        }),
      };
    }

    // Detect Lambda error envelope: `{ errorMessage, errorType?, stackTrace? }`.
    const payload = invokeOutcome.payload;
    const isError =
      payload !== null &&
      typeof payload === 'object' &&
      'errorMessage' in (payload as Record<string, unknown>);
    const matchTarget = isError
      ? String((payload as Record<string, unknown>)['errorMessage'])
      : 'success';

    // Lambda success uses the sentinel match target `'success'` (which is
    // unlikely to match any user-written SelectionPattern, so it falls to
    // the default entry — preserves pre-fix #14 behavior on Lambda).
    // Lambda error matches against the errorMessage string per AWS docs.
    const selected = selectIntegrationResponse(config.responses, matchTarget, isError ? 500 : 200);

    // Build response context with $inputRoot = parsed Lambda payload (AWS
    // docs convention for response mapping templates).
    const respCtx = buildVtlContextFromRequest(req, JSON.stringify(payload ?? null), payload);

    let body = '';
    let contentType = 'application/json';
    if (selected.entry) {
      const picked = pickResponseTemplate(selected.entry.ResponseTemplates, req.headers['accept']);
      if (picked) {
        try {
          body = evaluateVtl(picked.template, respCtx);
        } catch (err) {
          return vtlFailure('response', err, picked.template);
        }
        contentType = picked.contentType;
      } else {
        // No template — AWS emits the payload as JSON (matches AWS docs).
        body = JSON.stringify(payload ?? null);
      }
    } else {
      body = JSON.stringify(payload ?? null);
    }

    const headers: Record<string, string> = { 'content-type': contentType };
    Object.assign(
      headers,
      evaluateResponseParameters(selected.entry?.ResponseParameters, {
        onUnsupported: (_k, _v, reason) => logger.warn(`AWS Lambda non-proxy response: ${reason}`),
      })
    );

    return {
      statusCode: selected.statusCode,
      headers,
      body,
    };
  } finally {
    deps.pool.release(handle);
  }
}

// ==================== Helpers ===========================================

function buildVtlContextFromRequest(
  req: RestV1IntegrationRequest,
  body: string,
  inputRoot?: unknown
): VtlContext {
  const input = buildVtlInput(body, req.headers, req.querystring, req.pathParameters);
  const context = buildVtlRequestContext({
    requestId: req.requestId,
    httpMethod: req.method,
    resourcePath: req.resourcePath,
    stage: req.stage,
    sourceIp: req.sourceIp,
    userAgent: req.userAgent,
  });
  return {
    input,
    context,
    util: buildDefaultUtil(),
    ...(inputRoot !== undefined && { inputRoot }),
  };
}

function pickRequestTemplate(
  requestTemplates: Record<string, string> | undefined,
  contentType: string | undefined
): { template: string; contentType: string } | undefined {
  if (!requestTemplates) return undefined;
  const entries = Object.entries(requestTemplates);
  if (entries.length === 0) return undefined;
  if (contentType) {
    const primary = contentType.split(';')[0]!.trim();
    if (requestTemplates[primary] !== undefined) {
      return { template: requestTemplates[primary], contentType: primary };
    }
  }
  // AWS docs: "If the Content-Type header is missing or doesn't match
  // any template, the application/json template is used."
  if (requestTemplates['application/json'] !== undefined) {
    return { template: requestTemplates['application/json'], contentType: 'application/json' };
  }
  const first = entries[0]!;
  return { template: first[1], contentType: first[0] };
}

/**
 * Extract `{"statusCode": <N>}` from a rendered MOCK request template.
 * AWS uses this single key to drive `IntegrationResponses[]` selection.
 *
 * Returns `undefined` when the rendered template is not JSON OR does not
 * carry a `{statusCode: N}` object OR the value is not a positive integer
 * (Issue (#507) item 6 — `Number.isInteger` rejects `"200abc"` /
 * fractional values that `Number.parseInt` would silently accept). On any
 * fallback case the caller falls back to the default `IntegrationResponses[]`
 * entry. The fallback path is logged at debug (Issue (#507) item 3) so
 * users diagnosing a MOCK dispatch see what AWS would have seen.
 */
function extractStatusCodeFromRendered(rendered: string): number | undefined {
  const logFallback = (reason: string): undefined => {
    const truncated = rendered.length > 200 ? rendered.slice(0, 200) + '...' : rendered;
    getLogger()
      .child('start-api')
      .debug(
        `MOCK request template did not yield a statusCode selection driver (${reason}); falling back to the default IntegrationResponses[] entry. Rendered output: ${truncated}`
      );
    return undefined;
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rendered);
  } catch {
    return logFallback('rendered output is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || !('statusCode' in parsed)) {
    return logFallback('rendered output has no statusCode field');
  }
  const val = (parsed as Record<string, unknown>)['statusCode'];
  // PR #511 review fix-back: tighten validation beyond `Number.isInteger`
  // so empty strings (Number("") === 0), whitespace-only strings, negative
  // numbers, and out-of-range integers all reject. Valid HTTP status codes
  // live in [100, 599]; anything else falls back to the default entry.
  if (typeof val === 'number') {
    if (Number.isInteger(val) && val >= 100 && val < 600) return val;
    return logFallback(`statusCode ${val} is out of HTTP range [100, 600)`);
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed === '') return logFallback('statusCode is empty / whitespace');
    const n = Number(trimmed);
    if (!Number.isInteger(n)) return logFallback(`statusCode '${val}' is not a valid integer`);
    if (n < 100 || n >= 600) return logFallback(`statusCode ${n} is out of HTTP range [100, 600)`);
    return n;
  }
  return logFallback(`statusCode has unexpected type '${typeof val}'`);
}

function defaultResponseEntry(
  entries: IntegrationResponseEntry[]
): IntegrationResponseEntry | null {
  return entries.find((e) => e.SelectionPattern === undefined || e.SelectionPattern === '') ?? null;
}

/**
 * Heuristic: is the given HTTP `Content-Type` header value likely to
 * carry text content that VTL ResponseTemplates can safely render
 * against? Used by `dispatchHttpIntegration` to branch the upstream
 * body read between `.text()` (text-like) and `.arrayBuffer()` (binary
 * pass-through). Charset parameters are stripped before matching.
 *
 * Exported for unit testing.
 */
export function isTextLikeContentType(contentType: string): boolean {
  const primary = contentType.split(';')[0]!.trim().toLowerCase();
  if (primary.startsWith('text/')) return true;
  // Common text-shaped application types.
  if (
    primary === 'application/json' ||
    primary === 'application/xml' ||
    primary === 'application/x-www-form-urlencoded' ||
    primary === 'application/javascript' ||
    primary === 'application/ld+json'
  ) {
    return true;
  }
  // `application/*+json` / `application/*+xml` (e.g. `application/vnd.api+json`).
  if (
    primary.startsWith('application/') &&
    (primary.endsWith('+json') || primary.endsWith('+xml'))
  ) {
    return true;
  }
  return false;
}

/**
 * Classify a hostname or IP literal against well-known internal address
 * spaces. Used by `warnSsrfRiskyUri` at server boot to surface a warn
 * line per HTTP / HTTP_PROXY integration whose URI points at a
 * potentially-sensitive destination. Best-effort; does NOT do DNS
 * resolution — only matches hostname literals that are already an IP.
 *
 * Returns `undefined` when the host appears safe (public DNS name) OR
 * cannot be classified (DNS name that may resolve to an internal IP
 * the helper cannot see without async DNS).
 *
 * Exported for unit testing.
 */
export function classifyInternalHost(host: string): string | undefined {
  // Trim IPv6 brackets if present.
  const h = host.replace(/^\[|\]$/g, '');
  // AWS IMDS specifically (most actionable warning).
  if (h === '169.254.169.254' || h === '[fd00:ec2::254]' || h === 'fd00:ec2::254') {
    return 'AWS IMDS (169.254.169.254) — credentials exfiltration risk';
  }
  // IPv4 loopback (127.0.0.0/8).
  if (/^127\.\d+\.\d+\.\d+$/.test(h)) return 'IPv4 loopback (127.0.0.0/8)';
  // IPv6 loopback.
  if (h === '::1') return 'IPv6 loopback (::1)';
  // IPv4 link-local (169.254.0.0/16 — includes IMDS handled above).
  if (/^169\.254\.\d+\.\d+$/.test(h)) return 'IPv4 link-local (169.254.0.0/16)';
  // IPv6 link-local (fe80::/10).
  if (/^fe[89ab][0-9a-f]?:/i.test(h)) return 'IPv6 link-local (fe80::/10)';
  // RFC1918 private ranges.
  if (/^10\.\d+\.\d+\.\d+$/.test(h)) return 'RFC1918 private (10.0.0.0/8)';
  if (/^192\.168\.\d+\.\d+$/.test(h)) return 'RFC1918 private (192.168.0.0/16)';
  // 172.16.0.0/12 — 172.16-172.31.
  const m = /^172\.(\d+)\.\d+\.\d+$/.exec(h);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) {
    return 'RFC1918 private (172.16.0.0/12)';
  }
  return undefined;
}

/**
 * Emit a `logger.warn` line for each HTTP / HTTP_PROXY integration
 * whose `Integration.Uri` parses to a hostname classified as internal
 * by `classifyInternalHost`. Called once at server boot from
 * `cdkd local start-api`'s discovery pass; per-route deduplicated.
 *
 * cdkd does NOT block the URI — this is a developer-loop tool, not a
 * security boundary, and warn-and-proceed matches the precedent set by
 * the cognito JWKS pass-through fallback. The right v2 follow-up is an
 * `--allow-internal-uri` flag (and an opposite default block) once the
 * surface is well-understood.
 */
export function warnSsrfRiskyUri(
  uri: string,
  routeLabel: string,
  warn: (msg: string) => void
): void {
  let host: string;
  try {
    // Strip placeholders so URL() does not reject `{paramName}` shapes
    // — the substituted value at request time is what matters, but the
    // template Uri's literal host segment IS the right thing to
    // classify here.
    const sanitized = uri.replace(/\{[^/{}]+\}/g, 'x');
    host = new URL(sanitized).hostname;
  } catch {
    return; // Malformed Uri; route-discovery handles the error.
  }
  const classification = classifyInternalHost(host);
  if (classification !== undefined) {
    warn(
      `Integration URI for ${routeLabel} points at ${host} — ${classification}. ` +
        `cdkd does NOT block this; ensure the upstream is intentional.`
    );
  }
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Apply `Integration.RequestParameters` mappings — header / query / path
 * rewrites that copy from `method.request.X` to `integration.request.Y`.
 *
 * Supported key shapes:
 *   - `integration.request.header.<name>` → outgoing header
 *   - `integration.request.querystring.<name>` → query string param (warn-and-skip)
 *   - `integration.request.path.<name>` → path placeholder substitution (warn-and-skip)
 *
 * Supported value shapes (header case-insensitive + multi-value comma-joined,
 * querystring case-sensitive + last-wins; see {@link resolveRequestParameterValue}
 * and `vtl-engine.ts` `$input.params` for the matching read-side semantics):
 *   - `method.request.header.<name>` → read incoming header
 *   - `method.request.querystring.<name>` → read incoming query param
 *   - `method.request.path.<name>` → read path parameter
 *   - `'literal'` → single-quoted literal
 *
 * Unsupported mapping expressions are logged at warn and skipped (matches
 * the ResponseParameters handling in `integration-response-selector.ts`).
 *
 * Note: querystring / path-rewrite branches currently warn-and-skip; cdkd
 * relies on `{paramName}` URI substitution for the canonical case (see
 * {@link substituteUriPlaceholders}). The previous `urlObj` parameter was
 * never used by the unimplemented querystring rewrite branch and has been
 * dropped (Issue (#507) item 2).
 */
function applyRequestParameters(
  requestParameters: Record<string, string> | undefined,
  req: RestV1IntegrationRequest,
  out: { headers: Record<string, string> }
): void {
  if (!requestParameters) return;
  const logger = getLogger().child('start-api');
  for (const [key, value] of Object.entries(requestParameters)) {
    const resolved = resolveRequestParameterValue(value, req);
    if (resolved === undefined) {
      logger.warn(
        `RequestParameter '${key}' value '${value}' is not a recognized mapping; skipping.`
      );
      continue;
    }
    const headerMatch = /^integration\.request\.header\.(.+)$/.exec(key);
    const queryMatch = /^integration\.request\.querystring\.(.+)$/.exec(key);
    const pathMatch = /^integration\.request\.path\.(.+)$/.exec(key);
    if (headerMatch) {
      out.headers[headerMatch[1]!.toLowerCase()] = resolved;
    } else if (queryMatch) {
      // Querystring rewrites are recognized but cdkd applies querystring
      // rewrites only via URI placeholder substitution; ignore.
      logger.warn(
        `RequestParameter '${key}' (querystring rewrite) is recognized but cdkd applies querystring rewrites only via URI placeholder substitution; ignoring.`
      );
    } else if (pathMatch) {
      // Path rewrites apply at URI substitution time. Log + skip — the
      // pre-substituted URI already used the path parameters via
      // `{paramName}` placeholders, so a separate rewrite is rarely needed.
      logger.warn(
        `RequestParameter '${key}' (path rewrite) is recognized but cdkd substitutes path placeholders via {param} in the URI; ignoring.`
      );
    } else {
      logger.warn(`Unsupported RequestParameter key '${key}'; skipping.`);
    }
  }
}

/**
 * Resolve a single `RequestParameters` value to a string.
 *
 * Case-sensitivity contract (Issue (#507) item 5; mirrored on the VTL
 * read side by `vtl-engine.ts` `$input.params`):
 *
 *   - Header lookups are **case-insensitive** (the incoming-header map is
 *     pre-lowercased by the http-server) and multi-value duplicates are
 *     comma-joined.
 *   - Querystring lookups are **case-sensitive** (matches AWS API Gateway's
 *     deployed behavior) and multi-value duplicates surface only the
 *     last-wins string (the http-server's request snapshot collapses
 *     duplicates at parse time).
 *   - Path parameters are case-sensitive (CFn template `{paramName}`
 *     placeholders are case-sensitive by construction).
 */
function resolveRequestParameterValue(
  raw: string,
  req: RestV1IntegrationRequest
): string | undefined {
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1);
  }
  const headerMatch = /^method\.request\.header\.(.+)$/.exec(raw);
  if (headerMatch) return req.headers[headerMatch[1]!.toLowerCase()];
  const queryMatch = /^method\.request\.querystring\.(.+)$/.exec(raw);
  if (queryMatch) return req.querystring[queryMatch[1]!];
  const pathMatch = /^method\.request\.path\.(.+)$/.exec(raw);
  if (pathMatch) return req.pathParameters[pathMatch[1]!];
  return undefined;
}

/**
 * Substitute `{paramName}` placeholders in a URI string with the value
 * of the matching path parameter on the request. Used by HTTP_PROXY /
 * HTTP integrations whose `Integration.Uri` may contain such
 * placeholders (e.g. `https://upstream.example.com/users/{userId}`).
 */
export function substituteUriPlaceholders(uri: string, req: RestV1IntegrationRequest): string {
  return uri.replace(/\{([^/{}]+)\}/g, (_, name) => {
    const val = req.pathParameters[name];
    return val !== undefined ? encodeURIComponent(val) : '';
  });
}

function vtlFailure(
  direction: 'request' | 'response',
  err: unknown,
  template: string
): RestV1IntegrationOutcome {
  const reason =
    err instanceof VtlEvaluationError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
  const body = JSON.stringify({
    message: `VTL ${direction}-template evaluation failed`,
    reason,
    template: template.length > 200 ? template.slice(0, 200) + '...' : template,
  });
  return {
    statusCode: 502,
    headers: { 'content-type': 'application/json' },
    body,
  };
}
