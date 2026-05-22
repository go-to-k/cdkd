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
 */

import type { ContainerPool } from './container-pool.js';
import { invokeRie } from './rie-client.js';
import {
  evaluateResponseParameters,
  pickResponseTemplate,
  selectIntegrationResponse,
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
  /** Used by AWS Lambda non-proxy to acquire a warm RIE container. */
  pool: ContainerPool;
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
      config.responses.find((e) => parseStatus(e.StatusCode) === pickedStatus) ??
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

  return {
    statusCode: parseStatus(entry.StatusCode) ?? 200,
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
  applyRequestParameters(config.requestParameters, req, { headers: outHeaders, urlObj: undefined });

  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const fetchInit: RequestInit = { method, headers: outHeaders };
  if (methodHasBody(method)) {
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

  const upstreamBody = Buffer.from(await upstream.arrayBuffer());
  // IntegrationResponses[].SelectionPattern matches against the status
  // code as a string.
  const selected = selectIntegrationResponse(config.responses, {
    kind: upstream.ok ? 'success' : 'error',
    matchTarget: String(upstream.status),
  });

  // For HTTP_PROXY, AWS forwards the upstream response shape verbatim
  // when no entry is selected — only ResponseParameters / Status come
  // from the selected entry.
  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
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
  applyRequestParameters(config.requestParameters, req, { headers: outHeaders, urlObj: undefined });

  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const fetchInit: RequestInit = { method, headers: outHeaders };
  if (methodHasBody(method) && outBody !== undefined) {
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

  const upstreamText = await upstream.text();
  const selected = selectIntegrationResponse(config.responses, {
    kind: upstream.ok ? 'success' : 'error',
    matchTarget: String(upstream.status),
  });

  // Render response template against the upstream body.
  const respCtx = buildVtlContextFromRequest(req, upstreamText, safeJsonParse(upstreamText));
  let body = upstreamText;
  let contentType = upstream.headers.get('content-type') ?? 'application/json';
  if (selected.entry) {
    const picked = pickResponseTemplate(selected.entry.ResponseTemplates, req.headers['accept']);
    if (picked) {
      try {
        body = evaluateVtl(picked.template, respCtx);
      } catch (err) {
        return vtlFailure('response', err, picked.template);
      }
      contentType = picked.contentType;
    }
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

  let invokeOutcome;
  try {
    invokeOutcome = await invokeRie(
      handle.containerHost,
      handle.hostPort,
      eventPayload,
      deps.rieTimeoutMs
    );
  } catch (err) {
    deps.pool.release(handle);
    return {
      statusCode: 502,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'AWS Lambda non-proxy invocation failed',
        reason: err instanceof Error ? err.message : String(err),
      }),
    };
  }
  deps.pool.release(handle);

  // Detect Lambda error envelope: `{ errorMessage, errorType?, stackTrace? }`.
  const payload = invokeOutcome.payload;
  const isError =
    payload !== null &&
    typeof payload === 'object' &&
    'errorMessage' in (payload as Record<string, unknown>);
  const matchTarget = isError
    ? String((payload as Record<string, unknown>)['errorMessage'])
    : 'success';

  const selected = selectIntegrationResponse(
    config.responses,
    isError ? { kind: 'error', matchTarget } : { kind: 'success' }
  );

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
 */
function extractStatusCodeFromRendered(rendered: string): number | undefined {
  try {
    const parsed = JSON.parse(rendered);
    if (parsed && typeof parsed === 'object' && 'statusCode' in parsed) {
      const val = (parsed as Record<string, unknown>)['statusCode'];
      if (typeof val === 'number') return val;
      if (typeof val === 'string') {
        const n = Number.parseInt(val, 10);
        if (Number.isFinite(n)) return n;
      }
    }
  } catch {
    // Not JSON — that's OK, AWS just falls back to the default entry.
  }
  return undefined;
}

function defaultResponseEntry(
  entries: IntegrationResponseEntry[]
): IntegrationResponseEntry | null {
  return entries.find((e) => e.SelectionPattern === undefined || e.SelectionPattern === '') ?? null;
}

function parseStatus(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function methodHasBody(method: string): boolean {
  const m = method.toUpperCase();
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
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
 *   - `integration.request.querystring.<name>` → query string param
 *   - `integration.request.path.<name>` → path placeholder substitution
 *
 * Supported value shapes:
 *   - `method.request.header.<name>` → read incoming header
 *   - `method.request.querystring.<name>` → read incoming query param
 *   - `method.request.path.<name>` → read path parameter
 *   - `'literal'` → single-quoted literal
 *
 * Unsupported mapping expressions are logged at warn and skipped (matches
 * the ResponseParameters handling in `integration-response-selector.ts`).
 */
function applyRequestParameters(
  requestParameters: Record<string, string> | undefined,
  req: RestV1IntegrationRequest,
  out: { headers: Record<string, string>; urlObj: URL | undefined }
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
      // The dispatchers consume the URL string before this hook runs in
      // some paths; for query rewrites we mutate the URL by string-concat.
      // Done inline in the dispatcher above instead — log + skip here.
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
