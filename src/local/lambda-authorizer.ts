import { invokeRie } from './rie-client.js';
import type { ContainerPool } from './container-pool.js';
import type { CachedAuthorizerResult } from './authorizer-cache.js';
import type {
  IdentitySourceSelector,
  LambdaRequestAuthorizer,
  LambdaTokenAuthorizer,
} from './authorizer-resolver.js';
import { buildIdentityHash } from './authorizer-resolver.js';

/**
 * Lambda authorizer (TOKEN + REQUEST) invocation for `cdkd local start-api`.
 *
 * Both flavors invoke the authorizer Lambda via the same warm container
 * pool the route handlers use, then parse the response into a
 * {@link CachedAuthorizerResult}. The HTTP server layer feeds that result
 * to the per-request authorizer cache and (on Allow) propagates the
 * authorizer's `context` map into the route event.
 *
 * Spec references:
 *   - REST v1 TOKEN:
 *     https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-lambda-authorizer-input.html
 *   - REST v1 REQUEST:
 *     https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-lambda-authorizer-input.html
 *   - HTTP v2 REQUEST:
 *     https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-lambda-authorizer.html
 */

export interface RequestSnapshotForAuthorizer {
  /** HTTP method (uppercased). */
  method: string;
  /** Lowercased headers as a key → joined-value map (V2 shape). */
  headers: Record<string, string>;
  /** Singular query-string map (last value wins). */
  queryStringParameters: Record<string, string>;
  /** Path parameters captured by the route matcher. */
  pathParameters: Record<string, string>;
  /** Source IP (typically `127.0.0.1` for the local server). */
  sourceIp: string;
  /** Path that matched the route (post-substitution). */
  matchedPath: string;
  /** API Gateway stage (REST v1: the configured stage name; HTTP v2: `$default`). */
  stage: string;
}

export interface AuthorizerInvocationContext {
  /** Pool used to invoke the authorizer Lambda. */
  pool: ContainerPool;
  /** RIE invoke timeout. */
  rieTimeoutMs: number;
  /**
   * The methodArn the authorizer's policy evaluator compares against.
   * Built once per request as
   *   `arn:aws:execute-api:local:<accountId>:<apiId>/<stage>/<METHOD>/<path>`.
   */
  methodArn: string;
  /** Mock account id (matches api-gateway-event.ts `MOCK_ACCOUNT_ID`). */
  mockAccountId: string;
  /** Mock api id (matches api-gateway-event.ts `MOCK_API_ID`). */
  mockApiId: string;
}

/**
 * Build the methodArn the authorizer's policy evaluator compares against.
 * Spec: `arn:aws:execute-api:<region>:<account>:<apiId>/<stage>/<METHOD>/<path>`.
 *
 * The path component MUST NOT have a leading slash; `/items/{id}` becomes
 * `items/{id}`. Method `ANY` is replaced with the actual request method
 * (matches AWS-deployed behavior).
 */
export function buildMethodArn(opts: {
  apiId: string;
  accountId: string;
  region?: string;
  stage: string;
  method: string;
  path: string;
}): string {
  const region = opts.region ?? 'local';
  const trimmedPath = opts.path.replace(/^\//, '');
  return `arn:aws:execute-api:${region}:${opts.accountId}:${opts.apiId}/${opts.stage}/${opts.method.toUpperCase()}/${trimmedPath}`;
}

/**
 * Invoke a TOKEN-type Lambda authorizer.
 *
 * The TOKEN event shape is the simplest of the three:
 *   - `type: 'TOKEN'`
 *   - `authorizationToken: <full header value>`
 *   - `methodArn: <built by caller>`
 *
 * Returns `{ allow: false }` on:
 *   - missing identity header (caller surfaces 401);
 *   - authorizer Lambda throwing (caller surfaces 401 / 500 — TOKEN
 *     authorizers map an error to 401 per the deployed behavior).
 */
export async function invokeTokenAuthorizer(
  authorizer: LambdaTokenAuthorizer,
  request: RequestSnapshotForAuthorizer,
  ctx: AuthorizerInvocationContext
): Promise<CachedAuthorizerResult & { identityHash: string | undefined }> {
  const token = request.headers[authorizer.tokenHeader];
  if (!token || token.length === 0) {
    return { allow: false, identityHash: undefined };
  }

  const event = {
    type: 'TOKEN',
    authorizationToken: token,
    methodArn: ctx.methodArn,
  };

  const identityHash = buildIdentityHash([token]);
  const result = await invokeAuthorizerLambda(authorizer.lambdaLogicalId, event, ctx);
  return parseLambdaAuthorizerResponse(result, ctx.methodArn, identityHash);
}

/**
 * Invoke a REQUEST-type Lambda authorizer.
 *
 * REST v1 and HTTP v2 use slightly different event shapes — the REST v1
 * shape mirrors the legacy proxy event; the HTTP v2 shape mirrors the
 * v2 proxy event. v1 / v2 distinction is carried on the authorizer
 * itself ({@link LambdaRequestAuthorizer.apiVersion}).
 */
export async function invokeRequestAuthorizer(
  authorizer: LambdaRequestAuthorizer,
  request: RequestSnapshotForAuthorizer,
  ctx: AuthorizerInvocationContext
): Promise<CachedAuthorizerResult & { identityHash: string | undefined }> {
  // Build the cache key from every identity source the authorizer
  // declared. Missing values become empty strings; an authorizer with no
  // declared identity sources caches once globally (`identityHash = ''`).
  // REST v1: missing every identity source → 401 (matches deployed
  // behavior). HTTP v2 falls through with empty values; the authorizer
  // is then expected to deny on its own.
  const { identityHash, missing } = computeRequestIdentityHash(authorizer, request);
  if (missing) {
    return { allow: false, identityHash: undefined };
  }

  const event =
    authorizer.apiVersion === 'v1'
      ? buildRequestEventV1(authorizer, request, ctx)
      : buildRequestEventV2(authorizer, request, ctx);

  const result = await invokeAuthorizerLambda(authorizer.lambdaLogicalId, event, ctx);
  if (authorizer.apiVersion === 'v2') {
    // HTTP v2 supports two response shapes: simple ({isAuthorized: bool})
    // and IAM (policy document). cdkd accepts both — the simple shape
    // wins when `isAuthorized` is present, otherwise we fall back to the
    // IAM-style policy parse.
    return parseHttpV2RequestResponse(result, ctx.methodArn, identityHash);
  }
  return parseLambdaAuthorizerResponse(result, ctx.methodArn, identityHash);
}

/**
 * Pick the value for one identity-source selector out of the request
 * snapshot. Returns `undefined` when the source isn't present in the
 * request (caller decides whether that's a deny or a pass-through).
 *
 * REST v1 supports `context.<name>` and `stageVariables.<name>` as
 * identity sources too. Local server has no realistic `requestContext`
 * sub-tree to query yet, and stage variables aren't populated in v1
 * (PR 8c will plumb them through), so both kinds currently return
 * `undefined`. Add a code comment when wiring stage variables — until
 * then, an authorizer whose ONLY identity source is a context /
 * stage-variable selector will still 401 the request on REST v1
 * (matching the deployed behavior when those sources are absent).
 */
export function extractIdentityValue(
  sel: IdentitySourceSelector,
  request: RequestSnapshotForAuthorizer
): string | undefined {
  switch (sel.kind) {
    case 'header':
      return request.headers[sel.name];
    case 'query':
      return request.queryStringParameters[sel.name];
    case 'context':
      // Local server doesn't carry a realistic `requestContext` sub-tree
      // for v1; once available, look up `request.requestContext[sel.name]`
      // here. Until then, return undefined and surface the same 401 the
      // deployed behavior produces when the source is absent.
      return undefined;
    case 'stage-variable':
      // Stage variables become meaningful once PR 8c plumbs them through
      // — until then there is no map to look up against.
      return undefined;
  }
}

/**
 * Pre-compute the identity hash for a REQUEST authorizer from the request
 * snapshot, BEFORE invoking the Lambda. Used by the HTTP server's cache
 * lookup path so a hit can be served without paying for a Lambda invocation.
 *
 * Returns `undefined` when REST v1 has no usable identity source (caller
 * surfaces a 401 without invoking). HTTP v2 falls through with empty values
 * and the authorizer is expected to deny on its own.
 */
export function computeRequestIdentityHash(
  authorizer: LambdaRequestAuthorizer,
  request: RequestSnapshotForAuthorizer
): { identityHash: string; missing: boolean } {
  const identityValues = authorizer.identitySources.map((sel) =>
    extractIdentityValue(sel, request)
  );
  const missing =
    authorizer.apiVersion === 'v1' &&
    authorizer.identitySources.length > 0 &&
    identityValues.every((v) => v === undefined || v === '');
  return { identityHash: buildIdentityHash(identityValues), missing };
}

/**
 * Build the REST v1 REQUEST authorizer event. Mirrors the deployed shape
 * (legacy proxy event minus the body).
 */
function buildRequestEventV1(
  authorizer: LambdaRequestAuthorizer,
  request: RequestSnapshotForAuthorizer,
  ctx: AuthorizerInvocationContext
): Record<string, unknown> {
  // Build the method-arn-shape `httpMethod` carries the actual method;
  // the deployed REST v1 authorizer event also carries `resource` and
  // `path`, which we set to the matched path for parity.
  return {
    type: 'REQUEST',
    methodArn: ctx.methodArn,
    resource: request.matchedPath,
    path: request.matchedPath,
    httpMethod: request.method,
    headers: request.headers,
    multiValueHeaders: Object.fromEntries(
      Object.entries(request.headers).map(([k, v]) => [k, v.split(',')])
    ),
    queryStringParameters: request.queryStringParameters,
    multiValueQueryStringParameters: Object.fromEntries(
      Object.entries(request.queryStringParameters).map(([k, v]) => [k, [v]])
    ),
    pathParameters: request.pathParameters,
    stageVariables: null,
    requestContext: {
      accountId: ctx.mockAccountId,
      apiId: ctx.mockApiId,
      httpMethod: request.method,
      identity: { sourceIp: request.sourceIp },
      path: `/${request.stage}${request.matchedPath}`,
      stage: request.stage,
    },
    authorizationToken: request.headers[authorizer.identitySources[0]?.name ?? 'authorization'],
  };
}

/**
 * Build the HTTP v2 REQUEST authorizer event.
 */
function buildRequestEventV2(
  _authorizer: LambdaRequestAuthorizer,
  request: RequestSnapshotForAuthorizer,
  ctx: AuthorizerInvocationContext
): Record<string, unknown> {
  return {
    version: '2.0',
    type: 'REQUEST',
    routeArn: ctx.methodArn,
    identitySource: [], // Honored by AWS but not interpreted by user code.
    routeKey: `${request.method} ${request.matchedPath}`,
    rawPath: request.matchedPath,
    rawQueryString: '',
    headers: request.headers,
    queryStringParameters: request.queryStringParameters,
    pathParameters: request.pathParameters,
    stageVariables: null,
    requestContext: {
      accountId: ctx.mockAccountId,
      apiId: ctx.mockApiId,
      domainName: 'localhost',
      domainPrefix: 'local',
      http: {
        method: request.method,
        path: request.matchedPath,
        protocol: 'HTTP/1.1',
        sourceIp: request.sourceIp,
        userAgent: request.headers['user-agent'] ?? '',
      },
      requestId: 'local-authorizer',
      routeKey: `${request.method} ${request.matchedPath}`,
      stage: request.stage,
      time: '',
      timeEpoch: 0,
    },
  };
}

/**
 * Send the event to the authorizer Lambda's RIE container.
 */
async function invokeAuthorizerLambda(
  lambdaLogicalId: string,
  event: unknown,
  ctx: AuthorizerInvocationContext
): Promise<unknown> {
  const handle = await ctx.pool.acquire(lambdaLogicalId);
  try {
    const result = await invokeRie(handle.containerHost, handle.hostPort, event, ctx.rieTimeoutMs);
    return result.payload;
  } finally {
    ctx.pool.release(handle);
  }
}

/**
 * Parse a REST v1 / HTTP v2 IAM-style Lambda authorizer response. The
 * deployed shape is:
 *
 *   {
 *     "principalId": "user|guest",
 *     "policyDocument": {
 *       "Version": "2012-10-17",
 *       "Statement": [{ "Effect": "Allow"|"Deny", "Action": ..., "Resource": ... }]
 *     },
 *     "context"?: { ... }     // string-valued map
 *   }
 *
 * cdkd allows the response when ANY Allow statement's Resource matches
 * the methodArn (literal match OR wildcard at the trailing
 * `/<METHOD>/<path>` segment). A non-Allow / wildcard-mismatch / missing
 * policyDocument all map to deny.
 */
export function parseLambdaAuthorizerResponse(
  payload: unknown,
  methodArn: string,
  identityHash: string
): CachedAuthorizerResult & { identityHash: string } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { allow: false, identityHash };
  }
  const obj = payload as Record<string, unknown>;
  const principalId = typeof obj['principalId'] === 'string' ? obj['principalId'] : undefined;
  const context =
    obj['context'] && typeof obj['context'] === 'object' && !Array.isArray(obj['context'])
      ? (obj['context'] as Record<string, unknown>)
      : undefined;

  const policy = obj['policyDocument'];
  if (!policy || typeof policy !== 'object') {
    return {
      allow: false,
      identityHash,
      ...(principalId !== undefined && { principalId }),
      ...(context && { context }),
    };
  }
  const stmts = (policy as Record<string, unknown>)['Statement'];
  if (!Array.isArray(stmts)) {
    return {
      allow: false,
      identityHash,
      ...(principalId !== undefined && { principalId }),
      ...(context && { context }),
      policy,
    };
  }

  const allow = stmts.some((stmt) => {
    if (!stmt || typeof stmt !== 'object' || Array.isArray(stmt)) return false;
    const s = stmt as Record<string, unknown>;
    if (s['Effect'] !== 'Allow') return false;
    const resources = Array.isArray(s['Resource']) ? s['Resource'] : [s['Resource']];
    return resources.some((r) => typeof r === 'string' && resourceMatches(r, methodArn));
  });

  return {
    allow,
    identityHash,
    ...(principalId !== undefined && { principalId }),
    ...(context && { context }),
    policy,
  };
}

/**
 * HTTP v2 simple-format response shape:
 *   { "isAuthorized": true|false, "context"?: { ... } }
 *
 * Falls back to the IAM-style parse when `isAuthorized` is absent.
 */
function parseHttpV2RequestResponse(
  payload: unknown,
  methodArn: string,
  identityHash: string
): CachedAuthorizerResult & { identityHash: string } {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const obj = payload as Record<string, unknown>;
    if (typeof obj['isAuthorized'] === 'boolean') {
      const context =
        obj['context'] && typeof obj['context'] === 'object' && !Array.isArray(obj['context'])
          ? (obj['context'] as Record<string, unknown>)
          : undefined;
      return {
        allow: obj['isAuthorized'],
        identityHash,
        ...(context && { context }),
      };
    }
  }
  return parseLambdaAuthorizerResponse(payload, methodArn, identityHash);
}

/**
 * Match a Resource value against the methodArn. AWS supports `*` and `?`
 * glob characters in IAM policy resources; cdkd implements the segmented
 * semantics AWS documents — `*` matches any sequence of characters
 * **within** a single segment, where segments are delimited by `:`
 * (ARN partition / service / region / account) and `/` (path). `**`
 * matches across segment boundaries for callers that need the looser
 * behavior (cdkd-specific extension; no AWS equivalent, useful for
 * stage-wide rules like `arn:.../prod/**`).
 *
 * Examples:
 *   - `arn:.../prod/GET/*` matches `arn:.../prod/GET/items` (single
 *     trailing segment) but NOT `arn:.../prod/GET/items/42` (would cross
 *     a `/`).
 *   - `arn:.../prod/**` matches every method+path under `prod/`.
 *   - `arn:.../prod/* / *` (no `**`, spaces inserted for readability)
 *     matches `prod/GET/items` (two single-segment wildcards).
 *
 * Special case: a Resource ending in `/*` therefore allows any single
 * trailing segment, NOT arbitrarily-deep sub-paths — for the latter,
 * write `/**`. This is a behavior change vs the pre-fix permissive
 * implementation; deployed AWS policies that work in production should
 * not be affected because AWS itself applies the segmented rule.
 */
export function resourceMatches(pattern: string, methodArn: string): boolean {
  if (pattern === methodArn) return true;
  if (!pattern.includes('*') && !pattern.includes('?')) return false;
  // Translate the glob to a regex, taking care to handle `**` before `*`
  // so the cross-segment alternative is not greedy-consumed by the
  // single-segment rule.
  let regex = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**` — cross-segment match (`.*`)
        regex += '.*';
        i++;
      } else {
        // `*` — single segment (anything except `:` and `/`)
        regex += '[^:/]*';
      }
    } else if (ch === '?') {
      // `?` — any single character except `:` and `/` (segment-scoped)
      regex += '[^:/]';
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      regex += '\\' + ch;
    } else {
      regex += ch;
    }
  }
  const re = new RegExp(`^${regex}$`);
  return re.test(methodArn);
}

/**
 * Re-evaluate a cached Lambda authorizer's policy document against the
 * current request's methodArn. Used by the HTTP server's cache hit path:
 * AWS-deployed API Gateway caches the IAM policy and re-checks `Resource`
 * against each new request's methodArn, so cdkd mirrors that — caching
 * the verdict directly would let a narrow-Resource Allow leak across
 * routes.
 *
 * Returns the recomputed `allow` plus the existing `principalId` /
 * `context` carried on the cached entry. Returns `allow: false` when
 * the cached entry has no policy (not a Lambda authorizer) — caller
 * should not have called this in that case.
 */
export function evaluateCachedLambdaPolicy(
  cached: CachedAuthorizerResult,
  methodArn: string
): CachedAuthorizerResult {
  const policy = cached.policy;
  if (!policy || typeof policy !== 'object') {
    return { ...cached, allow: false };
  }
  const stmts = (policy as Record<string, unknown>)['Statement'];
  if (!Array.isArray(stmts)) {
    return { ...cached, allow: false };
  }
  const allow = stmts.some((stmt) => {
    if (!stmt || typeof stmt !== 'object' || Array.isArray(stmt)) return false;
    const s = stmt as Record<string, unknown>;
    if (s['Effect'] !== 'Allow') return false;
    const resources = Array.isArray(s['Resource']) ? s['Resource'] : [s['Resource']];
    return resources.some((r) => typeof r === 'string' && resourceMatches(r, methodArn));
  });
  return { ...cached, allow };
}
