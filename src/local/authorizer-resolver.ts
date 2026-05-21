import type { StackInfo } from '../synthesis/assembly-reader.js';
import type { CloudFormationTemplate, TemplateResource } from '../types/resource.js';
import { RouteDiscoveryError } from '../utils/error-handler.js';
import { stringifyValue } from '../utils/stringify.js';
import { resolveLambdaArnIntrinsic as resolveLambdaArnShared } from './intrinsic-lambda-arn.js';

/**
 * Authorizer detection for `cdkd local start-api` (PR 8b of #224).
 *
 * The route-discovery layer now collects an optional {@link AuthorizerInfo}
 * for each route whose `AuthorizationType` references an authorizer
 * resource in the same stack. The HTTP server consults this map at
 * request time and gates the route forwarding on the authorizer's
 * verdict.
 *
 * Supported authorizer kinds:
 *   - **Lambda TOKEN** (REST v1 only) — `AWS::ApiGateway::Authorizer.Type === 'TOKEN'`.
 *     Identity is the single header named in `IdentitySource` (default
 *     `method.request.header.Authorization`).
 *   - **Lambda REQUEST** — REST v1 (`Type === 'REQUEST'`) and HTTP v2
 *     (`AWS::ApiGatewayV2::Authorizer.AuthorizerType === 'REQUEST'`).
 *     Identity is a comma-separated list of `method.request.header.X` /
 *     `method.request.querystring.X` selectors (REST v1) or a list of
 *     `$request.header.X` / `$request.querystring.X` selectors (HTTP v2).
 *   - **Cognito User Pool** — REST v1 (`Type === 'COGNITO_USER_POOLS'`)
 *     extracts the JWT from `Authorization: Bearer <token>`.
 *   - **JWT** — HTTP v2 (`AuthorizerType === 'JWT'`). The `JwtConfiguration`
 *     names the `Issuer` and `Audience` for verification.
 *
 * Out of scope (hard-errored at discovery):
 *   - REST v1 Custom authorizers with non-Lambda backing.
 *   - mTLS / VPC Lambda authorizers (the latter is not a separate kind —
 *     its Lambda is just a VPC-config Lambda; we warn at startup but do
 *     not block).
 *
 * Supported with signature-verification-only semantics:
 *   - REST v1 IAM authorizers (`AuthorizationType === 'AWS_IAM'`, #447):
 *     the local server verifies SigV4 signatures against the dev's local
 *     credentials but does NOT evaluate IAM resource / action / condition
 *     policies. See `src/local/sigv4-verify.ts`.
 */

export interface LambdaTokenAuthorizer {
  kind: 'lambda-token';
  /** `AWS::ApiGateway::Authorizer` logical ID. */
  logicalId: string;
  /** Lambda logical ID resolved from `AuthorizerUri`. */
  lambdaLogicalId: string;
  /**
   * The single header whose value is the token. AWS docs name this
   * `IdentitySource`, e.g. `method.request.header.Authorization`. cdkd
   * stores the bare lowercased header name (`authorization`).
   */
  tokenHeader: string;
  /** TTL in seconds; 0 disables caching. Default 300, max 3600 (REST v1 cap). */
  resultTtlSeconds: number;
  /** Diagnostic. */
  declaredAt: string;
}

export interface LambdaRequestAuthorizer {
  kind: 'lambda-request';
  logicalId: string;
  lambdaLogicalId: string;
  /** Identity-source selectors normalized to a stable shape. */
  identitySources: ReadonlyArray<IdentitySourceSelector>;
  /** TTL in seconds; HTTP v2 stores this on the route, REST v1 on the authorizer. */
  resultTtlSeconds: number;
  /** Discriminator: 'rest-v1' uses 401 on missing identity, 'http-v2' falls through. */
  apiVersion: 'v1' | 'v2';
  declaredAt: string;
}

export interface CognitoUserPoolAuthorizer {
  kind: 'cognito';
  logicalId: string;
  /**
   * The Cognito user pool ARN(s) declared on the authorizer. cdkd extracts
   * region + userPoolId from the first ARN to build the JWKS URL. v1 only
   * supports a single pool per authorizer; multi-pool federation is
   * deferred.
   */
  userPoolArn: string;
  /** Region parsed from the user pool ARN — used to build the JWKS URL. */
  region: string;
  /** Pool id parsed from the ARN. */
  userPoolId: string;
  // NOTE: there is intentionally no `audience` field on REST v1 Cognito
  // authorizers. The audience that JWT verification would check (`aud`
  // for ID tokens, `client_id` for access tokens) is the User Pool *App
  // Client ID*. CDK / CFn's `AWS::ApiGateway::Authorizer` only carries
  // the User Pool ARN(s) via `ProviderARNs`, not the client id, so
  // there's no template-time data for cdkd to surface here.
  // `verifyCognitoJwt` therefore passes `expectedAudience: undefined`
  // and falls back to issuer / signature / expiry checks only — matches
  // the deployed REST v1 behavior. HTTP v2 JWT authorizers DO carry an
  // explicit audience allowlist via `JwtConfiguration.Audience`; see
  // {@link JwtAuthorizer.audience}.
  declaredAt: string;
}

export interface JwtAuthorizer {
  kind: 'jwt';
  logicalId: string;
  /** OIDC issuer URL (HTTP v2's `JwtConfiguration.Issuer`). */
  issuer: string;
  /**
   * Allowed audiences. JWT's `aud` claim must match one of these (or
   * `client_id` for non-Cognito tokens that omit `aud`).
   */
  audience: ReadonlyArray<string>;
  /**
   * For Cognito-issued JWTs the issuer URL embeds the user pool id and
   * we can derive the JWKS URL automatically. Other issuers also expose
   * `<issuer>/.well-known/jwks.json` so we use the same fetch path.
   */
  region?: string;
  userPoolId?: string;
  declaredAt: string;
}

/**
 * REST v1 `AuthorizationType: 'AWS_IAM'` (closes #447).
 *
 * Unlike the other authorizer kinds, AWS_IAM has NO `AWS::ApiGateway::Authorizer`
 * resource in the template — the method's `AuthorizationType` is the only
 * signal. The local server verifies the request's SigV4 signature against
 * the dev's local credentials (see `src/local/sigv4-verify.ts`). IAM
 * policy evaluation (resource / action / condition) is intentionally not
 * emulated — that requires the deployed IAM data plane.
 */
export interface IamAuthorizer {
  kind: 'iam';
  /** Synthetic logical id — there is no real `AWS::ApiGateway::Authorizer` resource. */
  logicalId: 'AWS_IAM';
  declaredAt: string;
}

export type AuthorizerInfo =
  | LambdaTokenAuthorizer
  | LambdaRequestAuthorizer
  | CognitoUserPoolAuthorizer
  | JwtAuthorizer
  | IamAuthorizer;

export type IdentitySourceSelector =
  | { kind: 'header'; name: string }
  | { kind: 'query'; name: string }
  | { kind: 'context'; name: string }
  | { kind: 'stage-variable'; name: string };

/**
 * Resolve an `AWS::ApiGateway::Authorizer` referenced by a REST v1 method
 * to its {@link AuthorizerInfo} record. Returns `undefined` when the
 * authorizer is intentionally unsupported (the caller treats this as
 * "no authorizer", which is wrong but produces a warn line — see
 * `route-discovery.ts`).
 */
export function resolveRestV1Authorizer(
  authorizerLogicalId: string,
  template: CloudFormationTemplate,
  stackName: string,
  declaredAt: string
): AuthorizerInfo {
  const authResource = template.Resources?.[authorizerLogicalId];
  if (!authResource || authResource.Type !== 'AWS::ApiGateway::Authorizer') {
    throw new RouteDiscoveryError(
      `${declaredAt}: AuthorizerId '${authorizerLogicalId}' does not point at an AWS::ApiGateway::Authorizer in stack '${stackName}'.`
    );
  }
  const props = authResource.Properties ?? {};
  const type = props['Type'];

  if (type === 'TOKEN') {
    const lambdaLogicalId = resolveLambdaArn(
      props['AuthorizerUri'],
      `${stackName}/${authorizerLogicalId}.AuthorizerUri`
    );
    const identitySource =
      typeof props['IdentitySource'] === 'string'
        ? props['IdentitySource']
        : 'method.request.header.Authorization';
    const tokenHeader = parseRestV1HeaderSelector(identitySource, stackName, authorizerLogicalId);
    const ttl = parseTtl(props['AuthorizerResultTtlInSeconds'], 300, 3600);
    return {
      kind: 'lambda-token',
      logicalId: authorizerLogicalId,
      lambdaLogicalId,
      tokenHeader,
      resultTtlSeconds: ttl,
      declaredAt,
    };
  }

  if (type === 'REQUEST') {
    const lambdaLogicalId = resolveLambdaArn(
      props['AuthorizerUri'],
      `${stackName}/${authorizerLogicalId}.AuthorizerUri`
    );
    const identitySources = parseRestV1IdentitySources(
      typeof props['IdentitySource'] === 'string' ? props['IdentitySource'] : ''
    );
    const ttl = parseTtl(props['AuthorizerResultTtlInSeconds'], 300, 3600);
    return {
      kind: 'lambda-request',
      logicalId: authorizerLogicalId,
      lambdaLogicalId,
      identitySources,
      resultTtlSeconds: ttl,
      apiVersion: 'v1',
      declaredAt,
    };
  }

  if (type === 'COGNITO_USER_POOLS') {
    const arns = props['ProviderARNs'];
    if (!Array.isArray(arns) || arns.length === 0) {
      throw new RouteDiscoveryError(
        `${stackName}/${authorizerLogicalId}: COGNITO_USER_POOLS authorizer is missing ProviderARNs.`
      );
    }
    const arn = pickStringFromArn(arns[0], `${stackName}/${authorizerLogicalId}.ProviderARNs[0]`);
    const parsed = parseCognitoUserPoolArn(arn, `${stackName}/${authorizerLogicalId}`);
    return {
      kind: 'cognito',
      logicalId: authorizerLogicalId,
      userPoolArn: arn,
      region: parsed.region,
      userPoolId: parsed.userPoolId,
      declaredAt,
    };
  }

  // Unknown Type — surface a structured error that the route-discovery
  // layer wraps with offending route info. Note: AWS_IAM is detected at
  // the Method level (`AuthorizationType: 'AWS_IAM'`), not here — CDK
  // does not emit a companion `AWS::ApiGateway::Authorizer` resource
  // for IAM. mTLS lives on the `AWS::ApiGateway::DomainName` resource,
  // also not via Authorizer.
  throw new RouteDiscoveryError(
    `${stackName}/${authorizerLogicalId}: AWS::ApiGateway::Authorizer.Type '${String(type)}' is not supported by cdkd local start-api (only TOKEN / REQUEST / COGNITO_USER_POOLS are accepted at the Authorizer resource).`
  );
}

/**
 * Resolve an `AWS::ApiGatewayV2::Authorizer`. HTTP v2 has only `REQUEST`
 * and `JWT`; everything else is unsupported.
 */
export function resolveHttpApiAuthorizer(
  authorizerLogicalId: string,
  routeAuthorizationScopes: readonly string[] | undefined,
  template: CloudFormationTemplate,
  stackName: string,
  declaredAt: string
): AuthorizerInfo {
  const authResource = template.Resources?.[authorizerLogicalId];
  if (!authResource || authResource.Type !== 'AWS::ApiGatewayV2::Authorizer') {
    throw new RouteDiscoveryError(
      `${declaredAt}: AuthorizerId '${authorizerLogicalId}' does not point at an AWS::ApiGatewayV2::Authorizer in stack '${stackName}'.`
    );
  }
  const props = authResource.Properties ?? {};
  const authType = props['AuthorizerType'];

  if (authType === 'REQUEST') {
    const lambdaLogicalId = resolveLambdaArn(
      props['AuthorizerUri'],
      `${stackName}/${authorizerLogicalId}.AuthorizerUri`
    );
    const identitySources = parseHttpV2IdentitySources(props['IdentitySource']);
    const ttl = parseTtl(props['AuthorizerResultTtlInSeconds'], 0, 3600);
    return {
      kind: 'lambda-request',
      logicalId: authorizerLogicalId,
      lambdaLogicalId,
      identitySources,
      resultTtlSeconds: ttl,
      apiVersion: 'v2',
      declaredAt,
    };
  }

  if (authType === 'JWT') {
    const jwt = props['JwtConfiguration'];
    if (!jwt || typeof jwt !== 'object') {
      throw new RouteDiscoveryError(
        `${stackName}/${authorizerLogicalId}: AWS::ApiGatewayV2::Authorizer.JwtConfiguration is required for AuthorizerType=JWT.`
      );
    }
    const obj = jwt as Record<string, unknown>;
    const issuer = obj['Issuer'];
    if (typeof issuer !== 'string' || issuer.length === 0) {
      throw new RouteDiscoveryError(
        `${stackName}/${authorizerLogicalId}: JwtConfiguration.Issuer must be a string.`
      );
    }
    const audienceRaw = obj['Audience'];
    const audience = Array.isArray(audienceRaw)
      ? audienceRaw.filter((s): s is string => typeof s === 'string')
      : [];

    // Cognito-issued JWTs encode the user pool id in the issuer URL; we
    // detect that shape so the JWKS fetcher can use the canonical
    // `cognito-idp.<region>.amazonaws.com/<userPoolId>/.well-known/jwks.json`
    // URL even when the user-supplied issuer omits the trailing slash.
    const cognito = parseCognitoIssuer(issuer);
    void routeAuthorizationScopes; // scopes are not enforced in v1; accepted for parity.
    return {
      kind: 'jwt',
      logicalId: authorizerLogicalId,
      issuer,
      audience,
      ...(cognito && { region: cognito.region, userPoolId: cognito.userPoolId }),
      declaredAt,
    };
  }

  throw new RouteDiscoveryError(
    `${stackName}/${authorizerLogicalId}: AWS::ApiGatewayV2::Authorizer.AuthorizerType '${String(authType)}' is not supported by cdkd local start-api (only REQUEST / JWT).`
  );
}

/**
 * Thrown by {@link resolveLambdaArn} when the authorizer's
 * `AuthorizerUri` intrinsic does not resolve to a same-template Lambda
 * (cross-stack reference, imported Lambda, hand-rolled `Fn::Sub` outside
 * the invoke-ARN wrapper).
 *
 * Caught by {@link attachAuthorizers} and converted into a per-route
 * `unsupported` flag — symmetric with how `route-discovery.ts` handles
 * an unresolvable `IntegrationUri`. The route appears in the route
 * table as `[501 Not Implemented]` and returns HTTP 501 + the
 * `reason` at request time. The alternative ("attach no authorizer,
 * leave route normal") would be **unsafe** — it would let a request
 * hit a user-protected route without any auth check just because the
 * authorizer Lambda lives in another stack.
 *
 * Private to this module: `attachAuthorizers` is the only legitimate
 * consumer.
 */
class AuthorizerLambdaUnresolvableError extends RouteDiscoveryError {
  // Extends RouteDiscoveryError so existing tests that catch the
  // generic `RouteDiscoveryError` (e.g. direct calls to
  // `resolveHttpApiAuthorizer` that bypass `attachAuthorizers`) keep
  // working unchanged. `attachAuthorizers` matches on the more
  // specific subclass first so the deferred-501 path takes priority
  // over the generic catch.
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
    this.name = 'AuthorizerLambdaUnresolvableError';
    // The parent's constructor calls setPrototypeOf back to
    // RouteDiscoveryError.prototype (a well-known transpile-target
    // workaround for `extends Error`); re-apply ours so
    // `instanceof AuthorizerLambdaUnresolvableError` works in
    // `attachAuthorizers`'s catch.
    Object.setPrototypeOf(this, AuthorizerLambdaUnresolvableError.prototype);
  }
}

/**
 * Resolve a Lambda ARN intrinsic to its logical ID. Delegates to the
 * shared `resolveLambdaArnIntrinsic` in `intrinsic-lambda-arn.ts`
 * (extracted in issue #286 Gaps 3 / 4); accepts `Ref` /
 * `Fn::GetAtt: [..., 'Arn']` / the REST v1 invoke-ARN `Fn::Join` wrapper
 * (now also used by CDK 2.x's `HttpLambdaAuthorizer` for HTTP API v2 —
 * verified via real `cdk synth` 2026-05-12) / the `Fn::Sub` invoke-ARN
 * wrapper (both 1-arg and 2-arg forms).
 *
 * On an unresolvable intrinsic throws {@link AuthorizerLambdaUnresolvableError}
 * (caught by `attachAuthorizers` and converted into a per-route
 * deferred-501) instead of the generic `RouteDiscoveryError`, so
 * `cdkd local start-api` can boot against an app with a cross-stack
 * authorizer Lambda — symmetric with the route-level `IntegrationUri`
 * unresolvable case (issue #431).
 */
function resolveLambdaArn(value: unknown, location: string): string {
  const outcome = resolveLambdaArnShared(value);
  if (outcome.kind === 'resolved') return outcome.logicalId;
  throw new AuthorizerLambdaUnresolvableError(
    `${location}: ${outcome.detail} (got ${shortJson(value)}). Only { Ref }, { Fn::GetAtt: [..., 'Arn'] }, the REST v1 invoke-ARN Fn::Join wrapper, and the Fn::Sub invoke-ARN wrapper are supported.`
  );
}

/**
 * REST v1 IdentitySource for TOKEN authorizers must be exactly one
 * `method.request.header.<HeaderName>` reference. Returns the bare
 * lowercased header name.
 */
function parseRestV1HeaderSelector(
  identitySource: string,
  stackName: string,
  authorizerLogicalId: string
): string {
  const m = /^method\.request\.header\.([A-Za-z0-9-_]+)$/.exec(identitySource.trim());
  if (!m) {
    throw new RouteDiscoveryError(
      `${stackName}/${authorizerLogicalId}: TOKEN authorizer IdentitySource '${identitySource}' must be 'method.request.header.<HeaderName>'.`
    );
  }
  return m[1]!.toLowerCase();
}

/**
 * REST v1 IdentitySource for REQUEST authorizers is a comma-separated
 * list of selectors. Examples:
 *   - `method.request.header.X-Api-Key`
 *   - `method.request.querystring.token`
 *   - `context.identity.sourceIp` (rare)
 *   - `stageVariables.foo` (rare)
 *
 * Whitespace around commas is tolerated. Empty input returns `[]`.
 */
function parseRestV1IdentitySources(raw: string): IdentitySourceSelector[] {
  const out: IdentitySourceSelector[] = [];
  for (const tokenRaw of raw.split(',')) {
    const token = tokenRaw.trim();
    if (token.length === 0) continue;
    const headerMatch = /^method\.request\.header\.([A-Za-z0-9-_]+)$/.exec(token);
    if (headerMatch) {
      out.push({ kind: 'header', name: headerMatch[1]!.toLowerCase() });
      continue;
    }
    const queryMatch = /^method\.request\.querystring\.([A-Za-z0-9-_]+)$/.exec(token);
    if (queryMatch) {
      out.push({ kind: 'query', name: queryMatch[1]! });
      continue;
    }
    const contextMatch = /^context\.([A-Za-z0-9._-]+)$/.exec(token);
    if (contextMatch) {
      out.push({ kind: 'context', name: contextMatch[1]! });
      continue;
    }
    const stageMatch = /^stageVariables\.([A-Za-z0-9._-]+)$/.exec(token);
    if (stageMatch) {
      out.push({ kind: 'stage-variable', name: stageMatch[1]! });
      continue;
    }
    // Unknown form — keep it as a header selector defensively (matches
    // upstream's tolerant parsing); the cache key still hashes it.
    out.push({ kind: 'header', name: token.toLowerCase() });
  }
  return out;
}

/**
 * HTTP v2 IdentitySource is an array of `$request.header.X` /
 * `$request.querystring.X` selectors (CDK emits a list).
 */
function parseHttpV2IdentitySources(raw: unknown): IdentitySourceSelector[] {
  if (!Array.isArray(raw)) return [];
  const out: IdentitySourceSelector[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const headerMatch = /^\$request\.header\.([A-Za-z0-9-_]+)$/.exec(entry);
    if (headerMatch) {
      out.push({ kind: 'header', name: headerMatch[1]!.toLowerCase() });
      continue;
    }
    const queryMatch = /^\$request\.querystring\.([A-Za-z0-9-_]+)$/.exec(entry);
    if (queryMatch) {
      out.push({ kind: 'query', name: queryMatch[1]! });
      continue;
    }
    out.push({ kind: 'header', name: entry.toLowerCase() });
  }
  return out;
}

/**
 * Parse a Cognito User Pool ARN
 * `arn:aws:cognito-idp:<region>:<account>:userpool/<region>_<id>`
 * into its region and pool id.
 */
function parseCognitoUserPoolArn(
  arn: string,
  location: string
): { region: string; userPoolId: string } {
  const m = /^arn:aws[a-z0-9-]*:cognito-idp:([a-z0-9-]+):[0-9]+:userpool\/(.+)$/.exec(arn);
  if (!m) {
    throw new RouteDiscoveryError(
      `${location}: malformed Cognito User Pool ARN '${arn}'. Expected 'arn:aws:cognito-idp:<region>:<account>:userpool/<id>'.`
    );
  }
  return { region: m[1]!, userPoolId: m[2]! };
}

/**
 * Detect Cognito-issued JWT issuer URLs and pluck the region + pool id
 * out for the JWKS fetcher. Issuer URLs look like
 * `https://cognito-idp.<region>.amazonaws.com/<userPoolId>` — non-Cognito
 * URLs return undefined and the JWKS fetcher uses the OIDC discovery
 * convention (`<issuer>/.well-known/jwks.json`) instead.
 */
function parseCognitoIssuer(issuer: string): { region: string; userPoolId: string } | undefined {
  const m = /^https:\/\/cognito-idp\.([a-z0-9-]+)\.amazonaws\.com\/([^/]+)\/?$/.exec(issuer);
  if (!m) return undefined;
  return { region: m[1]!, userPoolId: m[2]! };
}

/**
 * Pull a string out of a {Ref} / literal entry under `ProviderARNs`.
 * CDK's CognitoUserPoolsAuthorizer emits a literal array of `Fn::GetAtt:
 * [<UserPool>, 'Arn']` entries — we accept both.
 */
function pickStringFromArn(value: unknown, location: string): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if ('Fn::GetAtt' in obj) {
      const arg = obj['Fn::GetAtt'];
      if (
        Array.isArray(arg) &&
        arg.length === 2 &&
        typeof arg[0] === 'string' &&
        arg[1] === 'Arn'
      ) {
        // Synthesize a placeholder ARN — start-api never reaches AWS for
        // this; we only need region + pool id, which the JWKS fetcher
        // re-derives from the issuer URL inside the JWT itself if the
        // ARN-shaped lookup fails. But Cognito authorizers use ARNs for
        // verification so the discovery layer has to fail loudly if it
        // can't extract one.
        throw new RouteDiscoveryError(
          `${location}: ProviderARNs[0] uses Fn::GetAtt against logical ID '${arg[0]}'. cdkd local start-api needs the literal ARN string to derive the JWKS URL — set the user pool ARN explicitly via 'authorizer.providerArns' on the CDK construct, or upgrade to JWT (HTTP v2) which encodes the pool in the Issuer URL.`
        );
      }
    }
  }
  throw new RouteDiscoveryError(
    `${location}: ProviderARNs[0] must be a literal string (got ${shortJson(value)}).`
  );
}

/**
 * Parse and clamp a TTL value to `[0, max]` with a default fallback.
 * The TTL field is optional — undefined / non-number / negative → default.
 */
function parseTtl(raw: unknown, fallback: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return fallback;
  return Math.min(Math.trunc(raw), max);
}

/**
 * Stable cache key for a `(authorizer, identity)` pair. Used by
 * {@link AuthorizerCache}; declared here so the resolver and the cache
 * agree on the hash semantics.
 *
 * For TOKEN authorizers the identity-hash is the token itself. For
 * REQUEST authorizers we concatenate every identity-source selector's
 * resolved value with `\u0000` as the separator — control chars cannot
 * appear in HTTP header values so collision-by-substring is impossible.
 */
export function buildIdentityHash(parts: ReadonlyArray<string | undefined>): string {
  return parts.map((p) => p ?? '').join('\u0000');
}

/**
 * Walk every stack and route, attaching an {@link AuthorizerInfo} to each
 * route whose `AuthorizationType` references one. Routes without an
 * authorizer keep `authorizer: undefined`. Routes that reference an
 * intentionally-unsupported authorizer kind (IAM, etc.) hard-fail via
 * {@link RouteDiscoveryError}.
 *
 * **Pure-functional** — does not mutate `routes`. Returns a parallel
 * array of `{route, authorizer}` records that the http-server consumes.
 */
export interface RouteWithAuth {
  route: import('./route-discovery.js').DiscoveredRoute;
  authorizer?: AuthorizerInfo;
}

export function attachAuthorizers(
  stacks: readonly StackInfo[],
  routes: readonly import('./route-discovery.js').DiscoveredRoute[]
): RouteWithAuth[] {
  // Build a per-stack lookup so we don't re-scan stacks per route.
  const stackByRoute = new Map<string, StackInfo>();
  for (const stack of stacks) {
    const prefix = `${stack.stackName}/`;
    for (const route of routes) {
      if (route.declaredAt.startsWith(prefix)) stackByRoute.set(route.declaredAt, stack);
    }
  }

  const out: RouteWithAuth[] = [];
  const errors: string[] = [];

  for (const route of routes) {
    // Skip deferred-error / mockCors routes — they never reach the
    // authorizer pass at request time (the http-server short-circuits
    // before it), and a route flagged unsupported for AuthorizationType
    // / AuthType (e.g. Function URL with AWS_IAM) would otherwise
    // hard-error here instead of surfacing the cleaner 501.
    if (route.unsupported || route.mockCors) {
      out.push({ route });
      continue;
    }
    const stack = stackByRoute.get(route.declaredAt);
    if (!stack) {
      // This shouldn't happen — every route's declaredAt has a stack
      // prefix — but defensive: pass the route through with no authorizer.
      out.push({ route });
      continue;
    }
    try {
      const authorizer = detectAuthorizer(route, stack);
      out.push({ route, ...(authorizer && { authorizer }) });
    } catch (err) {
      // Authorizer Lambda Arn unresolvable (cross-stack / imported /
      // unsupported intrinsic shape): flip the route to `unsupported`
      // with the resolver's reason instead of aborting boot. Mirrors
      // route-discovery.ts's treatment of an unresolvable
      // `IntegrationUri` so authorizer-protected routes degrade to
      // HTTP 501 + reason at request time rather than blocking every
      // other route on the API (issue #431). The alternative — leave
      // the route normal with no authorizer attached — would silently
      // expose a user-protected route, so we err on the safe side.
      if (err instanceof AuthorizerLambdaUnresolvableError) {
        out.push({
          route: {
            ...route,
            unsupported: {
              reason: `${route.declaredAt}: authorizer Lambda Arn unresolvable — ${err.reason}`,
            },
          },
        });
        continue;
      }
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (errors.length > 0) {
    throw new RouteDiscoveryError(
      `cdkd local start-api: ${errors.length} authorizer error(s):\n` +
        errors.map((e) => `  - ${e}`).join('\n')
    );
  }
  return out;
}

/**
 * Detect the authorizer (if any) attached to a discovered route.
 * Walks the original CFn resource for the route in `stack.template`.
 */
function detectAuthorizer(
  route: import('./route-discovery.js').DiscoveredRoute,
  stack: StackInfo
): AuthorizerInfo | undefined {
  // declaredAt looks like `<stackName>/<logicalId>` — peel the logical id
  // back out so we can find the originating CFn resource.
  const slash = route.declaredAt.indexOf('/');
  if (slash < 0) return undefined;
  const logicalId = route.declaredAt.slice(slash + 1);
  const resource = stack.template.Resources?.[logicalId];
  if (!resource) return undefined;

  if (resource.Type === 'AWS::ApiGateway::Method') {
    return detectRestV1Authorizer(resource, logicalId, stack);
  }
  if (resource.Type === 'AWS::ApiGatewayV2::Route') {
    return detectHttpApiAuthorizer(resource, logicalId, stack);
  }
  // Function URLs have AuthType: NONE only (route-discovery already
  // hard-errors on IAM); no authorizer to attach.
  return undefined;
}

function detectRestV1Authorizer(
  methodResource: TemplateResource,
  methodLogicalId: string,
  stack: StackInfo
): AuthorizerInfo | undefined {
  const props = methodResource.Properties ?? {};
  const authType = props['AuthorizationType'];
  if (authType === undefined || authType === 'NONE') return undefined;

  // AWS_IAM has no companion `AWS::ApiGateway::Authorizer` resource —
  // the AuthorizationType alone is the signal. SigV4 signatures are
  // verified at request time by `src/local/sigv4-verify.ts` (#447).
  if (authType === 'AWS_IAM') {
    return {
      kind: 'iam',
      logicalId: 'AWS_IAM',
      declaredAt: `${stack.stackName}/${methodLogicalId}`,
    };
  }

  const authorizerId = props['AuthorizerId'];
  const refLogicalId = pickRefLogicalId(authorizerId);

  // CUSTOM / COGNITO_USER_POOLS / etc. all need an AuthorizerId Ref.
  if (!refLogicalId) {
    throw new RouteDiscoveryError(
      `${stack.stackName}/${methodLogicalId}: AuthorizationType='${stringifyValue(authType)}' but AuthorizerId is missing or not a {Ref:...}.`
    );
  }

  return resolveRestV1Authorizer(
    refLogicalId,
    stack.template,
    stack.stackName,
    `${stack.stackName}/${methodLogicalId}`
  );
}

function detectHttpApiAuthorizer(
  routeResource: TemplateResource,
  routeLogicalId: string,
  stack: StackInfo
): AuthorizerInfo | undefined {
  const props = routeResource.Properties ?? {};
  const authType = props['AuthorizationType'];
  if (authType === undefined || authType === 'NONE') return undefined;

  const authorizerId = props['AuthorizerId'];
  const refLogicalId = pickRefLogicalId(authorizerId);
  if (!refLogicalId) {
    throw new RouteDiscoveryError(
      `${stack.stackName}/${routeLogicalId}: AuthorizationType='${stringifyValue(authType)}' but AuthorizerId is missing or not a {Ref:...}.`
    );
  }
  const scopesRaw = props['AuthorizationScopes'];
  const scopes = Array.isArray(scopesRaw)
    ? scopesRaw.filter((s): s is string => typeof s === 'string')
    : undefined;

  return resolveHttpApiAuthorizer(
    refLogicalId,
    scopes,
    stack.template,
    stack.stackName,
    `${stack.stackName}/${routeLogicalId}`
  );
}

function pickRefLogicalId(value: unknown): string | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const ref = (value as Record<string, unknown>)['Ref'];
    if (typeof ref === 'string') return ref;
  }
  return null;
}

function shortJson(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return stringifyValue(value);
  }
}
