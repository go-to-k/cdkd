import type { CloudFormationTemplate } from '../types/resource.js';

/**
 * CORS preflight (OPTIONS) interception for `cdkd local start-api`
 * (PR 8c, issue #235).
 *
 * Background: PR 8a left CORS preflight unimplemented. AWS's HTTP API
 * (`AWS::ApiGatewayV2::Api.CorsConfiguration`) responds to OPTIONS
 * preflight requests automatically — the request never reaches the
 * Lambda integration. cdkd's local server pre-PR forwarded OPTIONS to
 * the route's handler, which usually 404s or returns a non-CORS body.
 *
 * Scope (locked in the issue brief):
 *
 *   - **HTTP API v2** (this module): read `CorsConfiguration` from each
 *     `AWS::ApiGatewayV2::Api` resource and intercept OPTIONS preflight
 *     requests for routes on that API.
 *   - **REST v1 MOCK preflight** (route-discovery.ts, NOT this module):
 *     CDK's `defaultCorsPreflightOptions` synthesizes an OPTIONS
 *     `AWS::ApiGateway::Method` with a MOCK integration whose literal
 *     `method.response.header.*` `ResponseParameters` carry the CORS
 *     headers. `route-discovery.ts` captures those at boot as
 *     `DiscoveredRoute.mockCors` and the HTTP server returns the
 *     captured status + headers directly on OPTIONS (no Lambda invoke,
 *     no VTL evaluation). The "REST v1 CORS is out of scope" comment
 *     that used to live here is no longer accurate — only non-CORS
 *     MOCK integrations (custom VTL response bodies, MOCK on non-OPTIONS
 *     methods) remain unimplemented.
 *   - **Skip preflight handling when the route has an explicit OPTIONS
 *     method registered** — that signals the user's Lambda owns it.
 *
 * Algorithm:
 *
 *   1. Build a per-API `CorsConfig | undefined` map at server boot
 *      (`buildCorsConfigByApiId`). Routes attached to APIs that don't
 *      have CorsConfiguration get nothing.
 *   2. On every incoming OPTIONS request the server first calls
 *      `matchPreflight(req, configByRoute)`. If the request matches a
 *      route AND its API has a CorsConfig AND there is no explicit
 *      OPTIONS route, return the canonical preflight response. Otherwise
 *      return `null` and let the normal request handler run.
 *
 * Validation (matches AWS's HTTP API v2 behavior closely enough for a
 * local emulator):
 *
 *   - `Origin` matches `AllowOrigins` literally OR `'*'` is present.
 *   - `Access-Control-Request-Method` matches `AllowMethods` literally
 *     OR `'*'` is present.
 *   - `Access-Control-Request-Headers` is split on `,`, every entry must
 *     match `AllowHeaders` (case-insensitive) OR `'*'` must be present.
 *
 * On match, respond with `204 No Content` and the canonical headers:
 *
 *   - `access-control-allow-origin`: the request's literal Origin (when
 *     a wildcard hit) or the matched literal entry.
 *   - `access-control-allow-methods`: literal echo of the matched method.
 *   - `access-control-allow-headers`: literal echo of the matched headers
 *     (or `'*'` when AWS allows-wildcard).
 *   - `access-control-max-age`: when `MaxAge` is set on the config.
 *   - `access-control-allow-credentials`: `'true'` when `AllowCredentials`.
 *   - `access-control-expose-headers`: when `ExposeHeaders` is set.
 *
 * Mismatched preflight returns `null` (let the request fall through to
 * the route handler / 404), matching what AWS does — it returns a 4xx
 * with no CORS headers, the browser then refuses the actual request.
 */

/**
 * Normalized CorsConfiguration after extraction from the template.
 * Field names match the CFn property casing (PascalCase) so test
 * fixtures can be written verbatim against CDK's synthesized output.
 */
export interface CorsConfig {
  AllowOrigins: string[];
  AllowMethods: string[];
  AllowHeaders: string[];
  ExposeHeaders: string[];
  MaxAge?: number;
  AllowCredentials?: boolean;
}

/**
 * Build a `logicalId → CorsConfig | undefined` map. Walks the template
 * once and picks two CORS-bearing resource types:
 *
 *   - `AWS::ApiGatewayV2::Api` → `Properties.CorsConfiguration`
 *     (HTTP API v2; the original PR 8c surface)
 *   - `AWS::Lambda::Url` → `Properties.Cors` (Function URL; issue #644)
 *
 * Both blocks are field-for-field identical in CFn schema (same
 * `AllowOrigins` / `AllowMethods` / `AllowHeaders` / `ExposeHeaders` /
 * `MaxAge` / `AllowCredentials`), so a single parser handles both. The
 * map key is the resource's own logical ID — that ID is later looked up
 * against `DiscoveredRoute.apiLogicalId` (set to the surface-bearing
 * resource at route-discovery time) so the preflight interceptor finds
 * the right config.
 *
 * Resources without a CORS block (or whose block is malformed) are NOT
 * entered into the map.
 */
export function buildCorsConfigByApiId(template: CloudFormationTemplate): Map<string, CorsConfig> {
  const out = new Map<string, CorsConfig>();
  const resources = template.Resources ?? {};
  for (const [logicalId, resource] of Object.entries(resources)) {
    let raw: unknown;
    if (resource.Type === 'AWS::ApiGatewayV2::Api') {
      raw = (resource.Properties ?? {})['CorsConfiguration'];
    } else if (resource.Type === 'AWS::Lambda::Url') {
      raw = (resource.Properties ?? {})['Cors'];
    } else {
      continue;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const parsed = parseCorsConfiguration(raw as Record<string, unknown>);
    if (parsed) out.set(logicalId, parsed);
  }
  return out;
}

/**
 * Parse a single `CorsConfiguration` block. Accepts the CFn shape
 * (`AllowOrigins`, ...) — CDK's `aws-cdk-lib/aws-apigatewayv2` emits
 * this casing. Returns `undefined` when every field is missing /
 * malformed (no point installing an empty interceptor).
 */
function parseCorsConfiguration(raw: Record<string, unknown>): CorsConfig | undefined {
  const allowOrigins = pickStringArray(raw['AllowOrigins']);
  const allowMethods = pickStringArray(raw['AllowMethods']);
  const allowHeaders = pickStringArray(raw['AllowHeaders']);
  const exposeHeaders = pickStringArray(raw['ExposeHeaders']);
  const maxAgeRaw = raw['MaxAge'];
  const allowCreds = raw['AllowCredentials'];

  // Avoid installing an interceptor when nothing was configured. A
  // CorsConfiguration block with all fields empty / unset is the same
  // as having no configuration at all.
  if (
    allowOrigins.length === 0 &&
    allowMethods.length === 0 &&
    allowHeaders.length === 0 &&
    exposeHeaders.length === 0 &&
    maxAgeRaw === undefined &&
    allowCreds === undefined
  ) {
    return undefined;
  }

  const config: CorsConfig = {
    AllowOrigins: allowOrigins,
    AllowMethods: allowMethods,
    AllowHeaders: allowHeaders,
    ExposeHeaders: exposeHeaders,
  };
  if (typeof maxAgeRaw === 'number' && Number.isFinite(maxAgeRaw)) {
    config.MaxAge = Math.trunc(maxAgeRaw);
  }
  if (typeof allowCreds === 'boolean') {
    config.AllowCredentials = allowCreds;
  }
  return config;
}

/**
 * Coerce an unknown into a `string[]`, dropping non-string entries.
 * Returns `[]` when the input isn't an array.
 */
function pickStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) if (typeof v === 'string') out.push(v);
  return out;
}

/**
 * Build a `fnUrlLogicalId → CorsConfig` map by tracing CloudFront →
 * Function URL chains in the template (issue #646).
 *
 * Production-correct CDK pattern: Function URL fronted by a CloudFront
 * Distribution where CORS is declared on the CloudFront
 * `ResponseHeadersPolicy` (NOT on the Function URL itself). Without this
 * helper, `cdkd local start-api` sees `Cors: null` on the Function URL
 * and emits no preflight headers — even though the CDK code correctly
 * declares the allowed origins on the CloudFront side.
 *
 * Detection: an `AWS::CloudFront::Distribution` whose `Origins[].DomainName`
 * matches the canonical CDK 2.x shape
 * `Fn::Select[2, Fn::Split['/', Fn::GetAtt[<FnUrlLogicalId>, 'FunctionUrl']]]`
 * is the chain marker. For each such origin, we walk every cache behavior
 * (`DefaultCacheBehavior` + `CacheBehaviors[]`), resolve their
 * `ResponseHeadersPolicyId: { Ref: <RhpLogicalId> }` to the
 * `AWS::CloudFront::ResponseHeadersPolicy` resource, and extract its
 * `Properties.ResponseHeadersPolicyConfig.CorsConfig`.
 *
 * Schema mapping (CloudFront → internal `CorsConfig`):
 *
 *   AccessControlAllowOrigins.Items  → AllowOrigins
 *   AccessControlAllowMethods.Items  → AllowMethods
 *   AccessControlAllowHeaders.Items  → AllowHeaders
 *   AccessControlExposeHeaders.Items → ExposeHeaders
 *   AccessControlMaxAgeSec           → MaxAge
 *   AccessControlAllowCredentials    → AllowCredentials
 *   (OriginOverride is ignored — cdkd has only one config slot)
 *
 * Multiple distributions fronting the same Function URL: last write
 * wins (rare in practice). Per-path CORS via `CacheBehaviors[]` is
 * NOT supported in v1 — the `DefaultCacheBehavior`'s policy applies
 * to all paths.
 */
export function buildCorsConfigFromCloudFrontChain(
  template: CloudFormationTemplate
): Map<string, CorsConfig> {
  const out = new Map<string, CorsConfig>();
  const resources = template.Resources ?? {};
  for (const [, resource] of Object.entries(resources)) {
    if (resource.Type !== 'AWS::CloudFront::Distribution') continue;
    const distConfig = (resource.Properties ?? {})['DistributionConfig'];
    if (!distConfig || typeof distConfig !== 'object') continue;
    const dc = distConfig as Record<string, unknown>;

    const origins = Array.isArray(dc['Origins']) ? (dc['Origins'] as unknown[]) : [];
    for (const origin of origins) {
      if (!origin || typeof origin !== 'object') continue;
      const fnUrlLogicalId = pickFnUrlLogicalIdFromOriginDomainName(
        (origin as Record<string, unknown>)['DomainName']
      );
      if (!fnUrlLogicalId) continue;

      // Walk every cache behavior (default + per-path) and merge any
      // CORS configs found. v1: last-write-wins on collision.
      const cacheBehaviors: unknown[] = [
        dc['DefaultCacheBehavior'],
        ...(Array.isArray(dc['CacheBehaviors']) ? (dc['CacheBehaviors'] as unknown[]) : []),
      ];
      for (const behavior of cacheBehaviors) {
        if (!behavior || typeof behavior !== 'object') continue;
        const rhpId = pickRhpRefLogicalId(
          (behavior as Record<string, unknown>)['ResponseHeadersPolicyId']
        );
        if (!rhpId) continue;
        const rhpResource = resources[rhpId];
        if (!rhpResource || rhpResource.Type !== 'AWS::CloudFront::ResponseHeadersPolicy') continue;
        const rhpConfig = (rhpResource.Properties ?? {})['ResponseHeadersPolicyConfig'];
        if (!rhpConfig || typeof rhpConfig !== 'object') continue;
        const corsConfig = (rhpConfig as Record<string, unknown>)['CorsConfig'];
        if (!corsConfig || typeof corsConfig !== 'object' || Array.isArray(corsConfig)) continue;
        const parsed = parseCloudFrontCorsConfig(corsConfig as Record<string, unknown>);
        if (parsed) out.set(fnUrlLogicalId, parsed);
      }
    }
  }
  return out;
}

/**
 * Detect the canonical CDK 2.x `DomainName` shape that points a
 * CloudFront Origin at a Function URL:
 *   {Fn::Select: [2, {Fn::Split: ['/', {Fn::GetAtt: [<id>, 'FunctionUrl']}]}]}
 * Returns the Function URL's logical ID, or undefined if the shape
 * doesn't match.
 */
function pickFnUrlLogicalIdFromOriginDomainName(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const outer = value as Record<string, unknown>;
  const sel = outer['Fn::Select'];
  if (!Array.isArray(sel) || sel.length !== 2 || sel[0] !== 2) return undefined;
  const split = sel[1];
  if (!split || typeof split !== 'object') return undefined;
  const splitArgs = (split as Record<string, unknown>)['Fn::Split'];
  if (!Array.isArray(splitArgs) || splitArgs.length !== 2 || splitArgs[0] !== '/') return undefined;
  const getAtt = splitArgs[1];
  if (!getAtt || typeof getAtt !== 'object') return undefined;
  const ga = (getAtt as Record<string, unknown>)['Fn::GetAtt'];
  if (
    !Array.isArray(ga) ||
    ga.length !== 2 ||
    typeof ga[0] !== 'string' ||
    ga[1] !== 'FunctionUrl'
  ) {
    return undefined;
  }
  return ga[0];
}

/**
 * Unwrap a `ResponseHeadersPolicyId` value to its referenced logical
 * ID. CDK 2.x synthesizes this as `{ Ref: <id> }`. Returns undefined
 * for the AWS-managed-policy ID form (literal UUID string) since
 * cdkd can't fetch those — and for any non-Ref shape.
 */
function pickRhpRefLogicalId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const ref = (value as Record<string, unknown>)['Ref'];
  if (typeof ref !== 'string' || ref.length === 0) return undefined;
  return ref;
}

/**
 * Parse a CloudFront `ResponseHeadersPolicyConfig.CorsConfig` block
 * into the internal `CorsConfig` shape. Schema differs from Function
 * URL / HTTP API v2 (`AccessControl*` prefix + nested `Items` wrapper);
 * see `buildCorsConfigFromCloudFrontChain` JSDoc for the field mapping.
 *
 * Returns undefined when every value-bearing field is missing.
 */
function parseCloudFrontCorsConfig(raw: Record<string, unknown>): CorsConfig | undefined {
  const allowOrigins = pickItemsStringArray(raw['AccessControlAllowOrigins']);
  const allowMethods = pickItemsStringArray(raw['AccessControlAllowMethods']);
  const allowHeaders = pickItemsStringArray(raw['AccessControlAllowHeaders']);
  const exposeHeaders = pickItemsStringArray(raw['AccessControlExposeHeaders']);
  const maxAgeRaw = raw['AccessControlMaxAgeSec'];
  const allowCreds = raw['AccessControlAllowCredentials'];

  if (
    allowOrigins.length === 0 &&
    allowMethods.length === 0 &&
    allowHeaders.length === 0 &&
    exposeHeaders.length === 0 &&
    maxAgeRaw === undefined &&
    allowCreds === undefined
  ) {
    return undefined;
  }

  const config: CorsConfig = {
    AllowOrigins: allowOrigins,
    AllowMethods: allowMethods,
    AllowHeaders: allowHeaders,
    ExposeHeaders: exposeHeaders,
  };
  if (typeof maxAgeRaw === 'number' && Number.isFinite(maxAgeRaw)) {
    config.MaxAge = Math.trunc(maxAgeRaw);
  }
  if (typeof allowCreds === 'boolean') {
    config.AllowCredentials = allowCreds;
  }
  return config;
}

/**
 * CloudFront `AccessControl*Origins/Methods/Headers` use a nested
 * `Items: string[]` wrapper. Unwrap to a plain `string[]`.
 */
function pickItemsStringArray(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const items = (value as Record<string, unknown>)['Items'];
  return pickStringArray(items);
}

/**
 * The result of a successful preflight match. The HTTP server writes
 * `statusCode + headers` and ends the response with no body.
 */
export interface PreflightResponse {
  statusCode: number;
  headers: Record<string, string>;
}

/**
 * Try to match an OPTIONS preflight request against the given CORS
 * config. Returns the canonical response when every check passes;
 * `null` when the request didn't satisfy AllowOrigins / AllowMethods /
 * AllowHeaders (the caller falls back to normal route dispatch — which
 * usually 404s — matching what AWS does on mismatched preflight).
 */
export function matchPreflight(
  req: { method: string; headers: Record<string, string[]> },
  config: CorsConfig
): PreflightResponse | null {
  if (req.method.toUpperCase() !== 'OPTIONS') return null;

  const headersLower: Record<string, string> = {};
  for (const [name, values] of Object.entries(req.headers)) {
    if (values.length === 0) continue;
    headersLower[name.toLowerCase()] = values.join(',');
  }

  const origin = headersLower['origin'];
  const requestedMethod = headersLower['access-control-request-method'];
  if (!origin || !requestedMethod) {
    // Not a CORS preflight (just a plain OPTIONS); let the route handler
    // own it — most user code returns 200 / a documentation response.
    return null;
  }

  // AllowOrigins match.
  const originMatch = matchOrigin(origin, config.AllowOrigins);
  if (!originMatch) return null;

  // AllowMethods match.
  const methodMatch = matchToken(requestedMethod, config.AllowMethods);
  if (!methodMatch) return null;

  // AllowHeaders match. The request's `Access-Control-Request-Headers`
  // is a `,`-separated list — every entry must be allowed.
  const requestedHeaders = headersLower['access-control-request-headers'] ?? '';
  if (!matchHeaderList(requestedHeaders, config.AllowHeaders)) return null;

  // Build the response.
  const responseHeaders: Record<string, string> = {
    'access-control-allow-origin': originMatch === '*' ? '*' : origin,
    'access-control-allow-methods': methodMatch === '*' ? requestedMethod : methodMatch,
  };
  if (requestedHeaders.length > 0) {
    responseHeaders['access-control-allow-headers'] = requestedHeaders;
  } else if (config.AllowHeaders.length > 0 && !config.AllowHeaders.includes('*')) {
    responseHeaders['access-control-allow-headers'] = config.AllowHeaders.join(',');
  }
  if (config.ExposeHeaders.length > 0) {
    responseHeaders['access-control-expose-headers'] = config.ExposeHeaders.join(',');
  }
  if (config.MaxAge !== undefined) {
    responseHeaders['access-control-max-age'] = String(config.MaxAge);
  }
  if (config.AllowCredentials === true) {
    // RFC 6749 / browser fetch spec: when credentials are allowed, the
    // `Access-Control-Allow-Origin` MUST be a literal — `*` is invalid.
    // If config has `*` AND `AllowCredentials: true` (which AWS rejects
    // at deploy but a hand-rolled CFn template might still synthesize),
    // we echo the request Origin to keep the response valid.
    responseHeaders['access-control-allow-origin'] = origin;
    responseHeaders['access-control-allow-credentials'] = 'true';
  }

  // Vary: Origin — set whenever the response's `Access-Control-
  // Allow-Origin` was DERIVED from the request (wildcard match echoed
  // as `*`, literal Origin echo, or AllowCredentials echo). Without
  // this, downstream caches (browsers / CDN) may share a cached
  // response across origins and serve the wrong CORS headers to a
  // different origin — silently breaking the security model. Mirrors
  // `Vary: Origin` semantics from MDN's CORS guide and most server-side
  // CORS libraries.
  responseHeaders['vary'] = 'Origin';

  return { statusCode: 204, headers: responseHeaders };
}

/**
 * Whether the request's Origin matches the AllowOrigins list. Returns
 * `'*'` when a wildcard matched, the literal entry on a literal match,
 * `null` otherwise. The literal case is used by the caller to decide
 * whether to echo the request Origin or return the configured value.
 *
 * AWS's HTTP API v2 supports literal entries and the `'*'` wildcard;
 * regex / glob origins are NOT supported by AWS, so we don't either.
 */
function matchOrigin(requestOrigin: string, allowOrigins: string[]): string | null {
  if (allowOrigins.length === 0) return null;
  if (allowOrigins.includes('*')) return '*';
  for (const allowed of allowOrigins) {
    if (allowed === requestOrigin) return allowed;
  }
  return null;
}

/**
 * Whether `token` matches any entry in `allowed` (case-insensitive for
 * methods + the AllowHeaders list). Returns the literal entry on match
 * or `'*'` when the wildcard hit, `null` otherwise.
 */
function matchToken(token: string, allowed: string[]): string | null {
  if (allowed.length === 0) return null;
  if (allowed.includes('*')) return '*';
  const lower = token.toLowerCase();
  for (const a of allowed) {
    if (a.toLowerCase() === lower) return a;
  }
  return null;
}

/**
 * Whether every `,`-separated entry in `headerList` is allowed.
 * Empty `headerList` is always allowed (the request didn't ask for any
 * specific headers — common when the actual request has no custom
 * headers). An empty entry within a non-empty list (e.g.
 * `"Content-Type,,,Authorization"`) is treated as a malformed request
 * and rejected — matches AWS's stricter validation on `Access-Control-
 * Request-Headers`. Pre-fix the empty entries were silently skipped,
 * which made `"Content-Type,,,Authorization"` match against an
 * AllowHeaders list that only contains those two — surprising and
 * inconsistent with the docstring's "every entry must be allowed".
 */
function matchHeaderList(headerList: string, allowed: string[]): boolean {
  const trimmed = headerList.trim();
  if (trimmed.length === 0) return true;
  if (allowed.includes('*')) return true;
  if (allowed.length === 0) return false;
  const allowedLower = new Set(allowed.map((s) => s.toLowerCase()));
  for (const entry of trimmed.split(',')) {
    const e = entry.trim().toLowerCase();
    if (e.length === 0) return false;
    if (!allowedLower.has(e)) return false;
  }
  return true;
}
