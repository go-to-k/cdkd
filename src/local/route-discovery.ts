import { readCdkPath } from '../cli/cdk-path.js';
import type { StackInfo } from '../synthesis/assembly-reader.js';
import type { CloudFormationTemplate, TemplateResource } from '../types/resource.js';
import { RouteDiscoveryError } from '../utils/error-handler.js';
import { stringifyValue } from '../utils/stringify.js';
import { resolveLambdaArnIntrinsic as resolveLambdaArnShared } from './intrinsic-lambda-arn.js';

/**
 * One discovered API → Lambda route for `cdkd local start-api`.
 *
 * Walks the synthesized template, extracts every API Gateway REST v1
 * route, ApiGatewayV2 (HTTP) route, and Function URL, and produces a flat
 * list of routes the HTTP server can match on.
 *
 * `apiVersion` governs the event-shape construction: REST v1 (`AWS::ApiGateway::*`)
 * uses the v1 proxy event shape (`multiValueHeaders` etc.); HTTP API and
 * Function URL use the v2 shape (`requestContext.http`, `cookies` array).
 *
 * Per-route classification (see {@link DiscoveredRoute.unsupported} /
 * {@link DiscoveredRoute.mockCors}):
 *   - **Supported** — `unsupported` and `mockCors` both unset. The server
 *     dispatches to the route's Lambda via the container pool.
 *   - **Synthetic CORS preflight** — `mockCors` set. The server answers
 *     OPTIONS requests directly with the captured headers (no Lambda
 *     invocation). Used to emulate CDK's `defaultCorsPreflightOptions`,
 *     which synthesizes a REST v1 OPTIONS Method backed by a MOCK
 *     integration with literal `method.response.header.*` parameters.
 *   - **Unsupported, deferred error** — `unsupported` set. The server
 *     surfaces the route in the route table and returns HTTP 501 with
 *     the `reason` in the JSON body if and when the route is hit. Boot
 *     proceeds normally so the rest of the API surface stays reachable.
 *
 * The discovery layer still **hard-errors** via {@link RouteDiscoveryError}
 * on template-structural problems it cannot generate a meaningful route
 * from (missing `Integration` on an `AWS::ApiGateway::Method`,
 * non-Ref `RestApiId` / `ApiId`, malformed Route `Target`, ParentId cycle
 * / missing parent / wrong parent type / missing PathPart). These would
 * leave the server in a state where the unsupported-route 501 path
 * doesn't have enough info to identify what was misconfigured.
 */
export interface DiscoveredRoute {
  /** HTTP method or `'ANY'`. REST v1 spec routes `'ANY'` to every method. */
  method: string;
  /** Path pattern with `{param}` placeholders, `{proxy+}` for greedy, or `'$default'`. */
  pathPattern: string;
  /** Logical ID of the Lambda the route invokes. */
  lambdaLogicalId: string;
  /** Where the route originated. Drives event-shape selection downstream. */
  source: 'http-api' | 'rest-v1' | 'function-url';
  /** Event-shape version: 'v1' for REST v1, 'v2' for HTTP API and Function URL. */
  apiVersion: 'v1' | 'v2';
  /**
   * REST v1: the resolved Stage name (or `'$default'` if none was attached).
   * HTTP API: `'$default'`. Function URL: `'$default'`.
   *
   * For HTTP API + REST v1, this is the **default** stage name picked
   * at discovery time. The CLI's `--stage <name>` override is applied
   * by `attachStageContext` (PR 8c) which mutates `stage` on each
   * route — see `src/local/stage-resolver.ts` for the rules.
   */
  stage: string;
  /**
   * Logical ID of the parent API resource:
   *   - REST v1 routes: the `AWS::ApiGateway::RestApi`.
   *   - HTTP API routes: the `AWS::ApiGatewayV2::Api`.
   *   - Function URL routes: `undefined` (Function URLs aren't grouped
   *     under an API).
   *
   * Used by the CORS handler + stage-resolver to look up per-API config.
   */
  apiLogicalId?: string;
  /**
   * Name of the stack the parent API resource (or backing Lambda for
   * Function URLs) lives in. Populated for every route so the
   * `--api` filter can accept the **stack-qualified logical id**
   * form (`MyStack:MyHttpApi`) — mirrors `cdkd local invoke` /
   * `cdkd local run-task` target syntax.
   */
  apiStackName?: string;
  /**
   * CDK Construct path (`aws:cdk:path` metadata) of the parent API
   * resource (or the backing Lambda for Function URLs). Populated
   * for every route when the synthesized resource carries the
   * metadata. Used by `--api` to accept the **CDK display path**
   * form (`MyStack/MyHttpApi`) with prefix-rule matching (matches
   * the input exactly OR when the input is the parent L2 path that
   * resolves down to this resource's L1 child) — mirrors the same
   * prefix rule `cdkd orphan` uses.
   */
  apiCdkPath?: string;
  /**
   * Stage variables for the route's selected Stage (PR 8c). `null` when
   * the route's Stage has no Variables, or for routes without a Stage
   * (Function URLs). Populated by `attachStageContext` after discovery
   * — `discoverRoutes` itself does NOT set this field.
   */
  stageVariables?: Record<string, string> | null;
  /**
   * Function URL invoke mode. Defaults to `'BUFFERED'` (the standard
   * request/response shape); `'RESPONSE_STREAM'` opts into Lambda
   * response streaming via the RIE streaming protocol — the local
   * server invokes the Lambda with the
   * `Lambda-Runtime-Function-Response-Mode: streaming` header and
   * pipes the response chunks to the HTTP client with
   * `Transfer-Encoding: chunked`. Only set on `source: 'function-url'`
   * routes; REST v1 / HTTP API v2 routes are always buffered.
   */
  invokeMode?: 'BUFFERED' | 'RESPONSE_STREAM';
  /**
   * Set on routes that cdkd discovered but cannot dispatch to a Lambda.
   * The HTTP server returns HTTP 501 + `{"message": "Not Implemented",
   * "reason": <reason>}` when these routes are hit. Examples:
   * non-AWS_PROXY REST v1 integrations (`MOCK` not matching the CORS
   * preflight shape, `AWS`, `HTTP`, `HTTP_PROXY`), HTTP API v2
   * service integrations (`IntegrationSubtype` set), WebSocket APIs,
   * Function URLs with `AuthType !== 'NONE'` or with an
   * `InvokeMode` value outside `BUFFERED` / `RESPONSE_STREAM`, and
   * routes whose Lambda Arn intrinsic cannot be resolved against the
   * same template. (Function URLs with `InvokeMode: RESPONSE_STREAM`
   * are normal routes dispatched via the streaming protocol — #467.)
   *
   * Mutually exclusive with {@link DiscoveredRoute.mockCors}. When set,
   * `lambdaLogicalId` may be the empty string (we never need to dispatch
   * to it); the field is preserved when it COULD be resolved (e.g.
   * Function URL with `AuthType: AWS_IAM` still knows its Lambda).
   */
  unsupported?: { reason: string };
  /**
   * Set on synthetic CORS preflight routes derived from a REST v1
   * `AWS::ApiGateway::Method` whose `HttpMethod === 'OPTIONS'`,
   * `Integration.Type === 'MOCK'`, and `IntegrationResponses[]` carries
   * literal `method.response.header.*` mapping parameters (the shape
   * CDK's `defaultCorsPreflightOptions` synthesizes). The HTTP server
   * intercepts matching OPTIONS requests and returns the captured
   * status + headers directly without invoking any Lambda.
   *
   * Mutually exclusive with {@link DiscoveredRoute.unsupported}.
   * `lambdaLogicalId` is the empty string on these routes (there is no
   * Lambda to dispatch to). Non-OPTIONS MOCK methods, and OPTIONS MOCK
   * methods without literal `method.response.header.*` parameters, become
   * `unsupported` instead — cdkd cannot run their VTL mapping templates.
   */
  mockCors?: { statusCode: number; headers: Record<string, string> };
  /** Diagnostic only — used in route-table output and error messages. */
  declaredAt: string;
}

/**
 * Walk every stack's template and produce a flat list of discovered
 * routes. Routes are de-duplicated only when their (method, pathPattern,
 * lambdaLogicalId, stage) tuple is identical — different stacks may
 * legitimately host different APIs that mount the same path.
 *
 * Each route is one of three classes (see {@link DiscoveredRoute}):
 *   - normal (no flag set);
 *   - synthetic CORS preflight (`mockCors` set);
 *   - deferred-error unsupported (`unsupported` set).
 *
 * Throws {@link RouteDiscoveryError} only on template-structural failures
 * the discovery layer cannot generate a meaningful route from (e.g.
 * missing Integration property, ParentId cycle, non-Ref RestApiId). Per-
 * route integration unsupportedness now flows through `unsupported` and
 * is surfaced as HTTP 501 at request time.
 */
export function discoverRoutes(stacks: readonly StackInfo[]): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  const errors: string[] = [];

  for (const stack of stacks) {
    const template = stack.template;
    const resources = template.Resources ?? {};

    for (const [logicalId, resource] of Object.entries(resources)) {
      try {
        switch (resource.Type) {
          case 'AWS::ApiGateway::Method':
            routes.push(...discoverRestV1Method(logicalId, resource, template, stack.stackName));
            break;
          case 'AWS::ApiGatewayV2::Route':
            routes.push(...discoverHttpApiRoute(logicalId, resource, template, stack.stackName));
            break;
          case 'AWS::Lambda::Url':
            routes.push(...discoverFunctionUrl(logicalId, resource, template, stack.stackName));
            break;
          default:
            // Filter the known parent types early so we don't log noise.
            break;
        }
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
  }

  if (errors.length > 0) {
    throw new RouteDiscoveryError(
      `cdkd local start-api: ${errors.length} malformed route(s) in the synthesized template:\n` +
        errors.map((e) => `  - ${e}`).join('\n')
    );
  }

  return routes;
}

/**
 * Discover REST v1 routes from an `AWS::ApiGateway::Method` resource.
 *
 * Walks the `Resource.ParentId` chain up to the parent `RestApi` to build
 * the full path, then looks up the corresponding Stage (when one is
 * attached to the same RestApi) so `requestContext.stage` is realistic.
 *
 * Per-integration classification (see {@link DiscoveredRoute}):
 *   - `Integration.Type === 'AWS_PROXY'` → normal route.
 *   - `HttpMethod === 'OPTIONS'` + `Type === 'MOCK'` + `IntegrationResponses`
 *     contain literal `method.response.header.*` mapping params → synthetic
 *     CORS preflight (`mockCors` set). Emulates CDK's
 *     `defaultCorsPreflightOptions` output.
 *   - All other `Integration.Type` values (`MOCK` without CORS shape,
 *     `AWS`, `HTTP`, `HTTP_PROXY`) → unsupported route. The HTTP server
 *     returns 501 when the route is hit; boot proceeds.
 *
 * Hard-errors on template-structural problems (missing Integration,
 * non-Ref RestApiId, ParentId-chain failures).
 *
 * Method.HttpMethod values of `'ANY'` are returned as a single route with
 * `method='ANY'`; the matcher routes any HTTP method to the Lambda.
 */
function discoverRestV1Method(
  logicalId: string,
  resource: TemplateResource,
  template: CloudFormationTemplate,
  stackName: string
): DiscoveredRoute[] {
  const props = resource.Properties ?? {};
  const integration = props['Integration'] as Record<string, unknown> | undefined;
  if (!integration) {
    throw new Error(
      `${stackName}/${logicalId} (AWS::ApiGateway::Method): missing Integration property`
    );
  }

  const restApiId = props['RestApiId'];
  const restApiLogicalId = pickRefLogicalId(restApiId);
  if (!restApiLogicalId) {
    throw new Error(
      `${stackName}/${logicalId} (AWS::ApiGateway::Method): RestApiId must be a { Ref: '...' } reference (got ${shortJson(
        restApiId
      )}).`
    );
  }

  const resourceId = props['ResourceId'];
  const path = buildRestV1Path(resourceId, restApiLogicalId, template, stackName, logicalId);

  const httpMethod = stringifyValue(props['HttpMethod'] ?? 'ANY');
  const stage = pickRestV1Stage(restApiLogicalId, template);
  const restApiCdkPath = readApiCdkPath(restApiLogicalId, template);
  const baseRoute: Omit<DiscoveredRoute, 'method' | 'pathPattern' | 'lambdaLogicalId'> = {
    source: 'rest-v1',
    apiVersion: 'v1',
    stage,
    apiLogicalId: restApiLogicalId,
    apiStackName: stackName,
    ...(restApiCdkPath !== undefined && { apiCdkPath: restApiCdkPath }),
    declaredAt: `${stackName}/${logicalId}`,
  };

  const integrationType = integration['Type'];

  // REST v1 MOCK CORS preflight: CDK's `defaultCorsPreflightOptions`
  // synthesizes an OPTIONS Method backed by a MOCK integration whose
  // IntegrationResponses[].ResponseParameters carry literal
  // `method.response.header.<Name>: "'value'"` pairs. We extract those
  // pairs and emit a synthetic preflight route the HTTP server answers
  // directly without invoking any Lambda.
  if (integrationType === 'MOCK') {
    const preflight =
      httpMethod === 'OPTIONS' ? extractRestV1MockCorsConfig(integration) : undefined;
    if (preflight) {
      return [
        {
          ...baseRoute,
          method: 'OPTIONS',
          pathPattern: path,
          lambdaLogicalId: '',
          mockCors: preflight,
        },
      ];
    }
    return [
      {
        ...baseRoute,
        method: httpMethod,
        pathPattern: path,
        lambdaLogicalId: '',
        unsupported: {
          reason: `${stackName}/${logicalId}: MOCK integration is not emulated (only the CORS preflight subset, where HttpMethod=OPTIONS and IntegrationResponses carry literal method.response.header.* values, is supported).`,
        },
      },
    ];
  }

  // Other non-AWS_PROXY integration types — surfaced as deferred 501.
  if (integrationType !== 'AWS_PROXY') {
    return [
      {
        ...baseRoute,
        method: httpMethod,
        pathPattern: path,
        lambdaLogicalId: '',
        unsupported: {
          reason: `${stackName}/${logicalId}: REST v1 integration type '${String(
            integrationType
          )}' is not supported (only AWS_PROXY and the MOCK CORS preflight subset).`,
        },
      },
    ];
  }

  // AWS_PROXY: resolve the Lambda Arn. Unresolvable shapes become
  // unsupported routes (the route is identifiable, we just can't reach
  // its handler — e.g. cross-stack reference, imported Lambda).
  const integrationUri = integration['Uri'];
  const arnOutcome = resolveLambdaArnOutcome(integrationUri);
  if (arnOutcome.kind === 'unsupported') {
    return [
      {
        ...baseRoute,
        method: httpMethod,
        pathPattern: path,
        lambdaLogicalId: '',
        unsupported: {
          reason: `${stackName}/${logicalId}.Integration.Uri: ${arnOutcome.detail} (got ${shortJson(
            integrationUri
          )}). Lambda Arn intrinsics on cross-stack / imported references are not resolvable locally; deploy the producer stack and use \`cdkd local invoke --from-state\` shapes if you need it.`,
        },
      },
    ];
  }

  return [
    {
      ...baseRoute,
      method: httpMethod,
      pathPattern: path,
      lambdaLogicalId: arnOutcome.logicalId,
    },
  ];
}

/**
 * Extract the canonical CORS-preflight headers from a REST v1 MOCK
 * Method's `Integration.IntegrationResponses[0]`. Returns `undefined`
 * when the shape isn't a CORS preflight (no IntegrationResponses, no
 * `method.response.header.*` mapping parameters, or any individual
 * mapping parameter we could not evaluate locally — see below).
 *
 * AWS represents header literals in `ResponseParameters` with surrounding
 * single-quotes (e.g. `"'*'"` for `*`). The single-quote wrappers are
 * stripped to produce the canonical header value the local server emits.
 *
 * **All-or-nothing**: if any `method.response.header.*` entry is
 * intrinsic-valued (`Fn::Sub`, `Ref` etc.), unquoted, or otherwise
 * not a string-literal-with-quotes, the WHOLE preflight falls through
 * to the unsupported class. Emitting a partial preflight with some
 * headers missing would silently break CORS in the browser (the
 * preflight succeeds, then the actual request hits a CORS error the
 * user has to debug through Network panel) — caller's the better
 * place to surface the underlying VTL-requirement via the 501 path.
 *
 * Only the first `IntegrationResponses` entry is consulted. CDK's
 * `defaultCorsPreflightOptions` emits exactly one entry; hand-rolled
 * multi-status MOCK preflights are an unsupported v1 limitation.
 */
function extractRestV1MockCorsConfig(
  integration: Record<string, unknown>
): { statusCode: number; headers: Record<string, string> } | undefined {
  const responses = integration['IntegrationResponses'];
  if (!Array.isArray(responses) || responses.length === 0) return undefined;
  const first = responses[0];
  if (!first || typeof first !== 'object') return undefined;
  const entry = first as Record<string, unknown>;
  const responseParameters = entry['ResponseParameters'];
  if (
    !responseParameters ||
    typeof responseParameters !== 'object' ||
    Array.isArray(responseParameters)
  ) {
    return undefined;
  }

  const headers: Record<string, string> = {};
  let sawAnyHeader = false;
  for (const [key, raw] of Object.entries(responseParameters as Record<string, unknown>)) {
    const m = /^method\.response\.header\.(.+)$/.exec(key);
    if (!m) continue;
    sawAnyHeader = true;
    const headerName = m[1]!;
    // AWS literal-value convention: surround the literal with single
    // quotes. Anything else (an intrinsic, an unquoted reference) we
    // can't evaluate locally. All-or-nothing: reject the whole preflight
    // so the route falls through to the 501 path with the full reason,
    // rather than silently emitting a partial CORS response the browser
    // accepts AT the preflight but then chokes on at the actual request.
    if (typeof raw !== 'string') return undefined;
    if (raw.length < 2 || raw[0] !== "'" || raw[raw.length - 1] !== "'") return undefined;
    headers[headerName] = raw.slice(1, -1);
  }
  if (!sawAnyHeader) return undefined;

  // AWS represents the status code as a string. Default to 204 (the CDK
  // default for `defaultCorsPreflightOptions`) when it's missing or
  // unparseable.
  const statusCodeRaw = entry['StatusCode'];
  const parsed = typeof statusCodeRaw === 'string' ? Number.parseInt(statusCodeRaw, 10) : NaN;
  const statusCode = Number.isFinite(parsed) ? parsed : 204;

  return { statusCode, headers };
}

/**
 * Walk a chain of `AWS::ApiGateway::Resource` parent pointers up to the
 * `RestApi` root to build the full path. Each `Resource` contributes a
 * `PathPart` segment; the `RestApi` itself contributes the leading `/`.
 *
 * The walk hard-fails on cycles, missing parents, and non-Ref ParentId
 * intrinsics — all of which would silently corrupt the path otherwise.
 */
function buildRestV1Path(
  resourceIdIntrinsic: unknown,
  restApiLogicalId: string,
  template: CloudFormationTemplate,
  stackName: string,
  methodLogicalId: string
): string {
  // Special case: `ResourceId: { 'Fn::GetAtt': [restApi, 'RootResourceId'] }`
  // means the method is mounted at `/`. CDK's RestApi.root.addMethod() emits
  // exactly this shape.
  if (
    resourceIdIntrinsic &&
    typeof resourceIdIntrinsic === 'object' &&
    !Array.isArray(resourceIdIntrinsic)
  ) {
    const obj = resourceIdIntrinsic as Record<string, unknown>;
    if ('Fn::GetAtt' in obj) {
      const arg = obj['Fn::GetAtt'];
      if (Array.isArray(arg) && arg.length === 2 && arg[1] === 'RootResourceId') {
        return '/';
      }
    }
  }

  const resourceLogicalId = pickRefLogicalId(resourceIdIntrinsic);
  if (!resourceLogicalId) {
    throw new Error(
      `${stackName}/${methodLogicalId}: ResourceId must be { Ref: '...' } or { 'Fn::GetAtt': [..., 'RootResourceId'] } (got ${shortJson(
        resourceIdIntrinsic
      )}).`
    );
  }

  const segments: string[] = [];
  const visited = new Set<string>();
  let cursor: string | undefined = resourceLogicalId;

  while (cursor && cursor !== restApiLogicalId) {
    if (visited.has(cursor)) {
      throw new Error(
        `${stackName}/${methodLogicalId}: cycle detected in AWS::ApiGateway::Resource ParentId chain at ${cursor}`
      );
    }
    visited.add(cursor);
    const node: TemplateResource | undefined = template.Resources?.[cursor];
    if (!node) {
      throw new Error(
        `${stackName}/${methodLogicalId}: ParentId chain references missing resource '${cursor}'`
      );
    }
    if (node.Type !== 'AWS::ApiGateway::Resource') {
      throw new Error(
        `${stackName}/${methodLogicalId}: ParentId chain hit ${node.Type} (expected AWS::ApiGateway::Resource or RestApi root)`
      );
    }
    const nodeProps: Record<string, unknown> = node.Properties ?? {};
    const pathPart = nodeProps['PathPart'];
    if (typeof pathPart !== 'string') {
      throw new Error(
        `${stackName}/${methodLogicalId}: AWS::ApiGateway::Resource '${cursor}' missing PathPart`
      );
    }
    segments.unshift(pathPart);

    const parentId: unknown = nodeProps['ParentId'];
    // Fn::GetAtt RootResourceId means we've reached the RestApi root.
    if (
      parentId &&
      typeof parentId === 'object' &&
      !Array.isArray(parentId) &&
      'Fn::GetAtt' in (parentId as Record<string, unknown>)
    ) {
      const arg = (parentId as Record<string, unknown>)['Fn::GetAtt'];
      if (Array.isArray(arg) && arg[1] === 'RootResourceId') break;
    }
    cursor = pickRefLogicalId(parentId) ?? undefined;
  }

  return '/' + segments.join('/');
}

/**
 * Find the first `AWS::ApiGateway::Stage` attached to the given RestApi
 * and return its `StageName`. Falls back to `'$default'` when no Stage
 * resource is attached (e.g. CDK's `RestApi` always emits a default stage,
 * but a hand-rolled template may omit it).
 */
function pickRestV1Stage(restApiLogicalId: string, template: CloudFormationTemplate): string {
  const resources = template.Resources ?? {};
  for (const [, resource] of Object.entries(resources)) {
    if (resource.Type !== 'AWS::ApiGateway::Stage') continue;
    const props = resource.Properties ?? {};
    const ref = pickRefLogicalId(props['RestApiId']);
    if (ref === restApiLogicalId) {
      const stageName = props['StageName'];
      if (typeof stageName === 'string') return stageName;
    }
  }
  return '$default';
}

/**
 * Discover routes from an `AWS::ApiGatewayV2::Route` resource.
 *
 * Filters out:
 *   - WebSocket APIs (`AWS::ApiGatewayV2::Api.ProtocolType === 'WEBSOCKET'`).
 *   - Service integrations (`Integration.IntegrationSubtype` set), even
 *     when their type is `AWS_PROXY` — those are SQS / EventBridge etc.
 *     direct integrations (no Lambda involved).
 */
function discoverHttpApiRoute(
  logicalId: string,
  resource: TemplateResource,
  template: CloudFormationTemplate,
  stackName: string
): DiscoveredRoute[] {
  const props = resource.Properties ?? {};

  const apiId = props['ApiId'];
  const apiLogicalId = pickRefLogicalId(apiId);
  if (!apiLogicalId) {
    throw new Error(
      `${stackName}/${logicalId} (AWS::ApiGatewayV2::Route): ApiId must be { Ref: '...' } (got ${shortJson(
        apiId
      )}).`
    );
  }

  const routeKey = props['RouteKey'];
  if (typeof routeKey !== 'string' || routeKey.length === 0) {
    throw new Error(
      `${stackName}/${logicalId} (AWS::ApiGatewayV2::Route): RouteKey must be a string`
    );
  }
  const apiCdkPath = readApiCdkPath(apiLogicalId, template);

  // C13: WebSocket-protocol APIs cannot be emulated locally. Check this
  // BEFORE parsing the RouteKey — WebSocket routes use `$connect` /
  // `$disconnect` / `$default` which `parseRouteKey` rejects (it only
  // accepts `<METHOD> <path>` / `$default`). For the route table /
  // 501 response we surface the raw RouteKey as the path and 'ANY' as
  // the method; an HTTP request will never match because the path
  // starts with `$`.
  const apiResource = template.Resources?.[apiLogicalId];
  if (apiResource?.Type === 'AWS::ApiGatewayV2::Api') {
    const protocolType = (apiResource.Properties ?? {})['ProtocolType'];
    if (protocolType === 'WEBSOCKET') {
      return [
        {
          method: 'ANY',
          pathPattern: routeKey,
          lambdaLogicalId: '',
          source: 'http-api',
          apiVersion: 'v2',
          stage: '$default',
          apiLogicalId,
          apiStackName: stackName,
          ...(apiCdkPath !== undefined && { apiCdkPath }),
          declaredAt: `${stackName}/${logicalId}`,
          unsupported: {
            reason: `${stackName}/${logicalId}: WebSocket APIs are not supported in cdkd local start-api.`,
          },
        },
      ];
    }
  }

  // RouteKey grammar: `<METHOD> <path>` or `$default`.
  const { method, pathPattern } = parseRouteKey(routeKey);
  const baseRoute: Omit<DiscoveredRoute, 'lambdaLogicalId'> = {
    method,
    pathPattern,
    source: 'http-api',
    apiVersion: 'v2',
    stage: '$default',
    apiLogicalId,
    apiStackName: stackName,
    ...(apiCdkPath !== undefined && { apiCdkPath }),
    declaredAt: `${stackName}/${logicalId}`,
  };

  // Resolve the Target — `Target: 'integrations/<integrationLogicalId>'`.
  // CDK emits this as `Fn::Join: ['/', ['integrations', { Ref: <id> }]]`.
  const target = props['Target'];
  const integrationLogicalId = parseHttpApiTargetIntegration(
    target,
    `${stackName}/${logicalId}.Target`
  );

  const integration = template.Resources?.[integrationLogicalId];
  if (!integration || integration.Type !== 'AWS::ApiGatewayV2::Integration') {
    throw new Error(
      `${stackName}/${logicalId} (AWS::ApiGatewayV2::Route): Target points at '${integrationLogicalId}' which is not an AWS::ApiGatewayV2::Integration`
    );
  }
  const integrationProps = integration.Properties ?? {};

  // C9: filter to AWS_PROXY + no IntegrationSubtype. Both become
  // deferred-error unsupported routes (boot proceeds; 501 at request time).
  const integrationType = integrationProps['IntegrationType'];
  if (integrationType !== 'AWS_PROXY') {
    return [
      {
        ...baseRoute,
        lambdaLogicalId: '',
        unsupported: {
          reason: `${stackName}/${logicalId}: HTTP API v2 integration type '${String(
            integrationType
          )}' is not supported (only AWS_PROXY).`,
        },
      },
    ];
  }
  if (integrationProps['IntegrationSubtype'] !== undefined) {
    return [
      {
        ...baseRoute,
        lambdaLogicalId: '',
        unsupported: {
          reason: `${stackName}/${logicalId}: HTTP API v2 service integration with IntegrationSubtype '${stringifyValue(
            integrationProps['IntegrationSubtype']
          )}' is not supported (cdkd cannot proxy directly to SQS / EventBridge / etc.).`,
        },
      },
    ];
  }

  const arnOutcome = resolveLambdaArnOutcome(integrationProps['IntegrationUri']);
  if (arnOutcome.kind === 'unsupported') {
    return [
      {
        ...baseRoute,
        lambdaLogicalId: '',
        unsupported: {
          reason: `${stackName}/${integrationLogicalId}.IntegrationUri: ${arnOutcome.detail} (got ${shortJson(
            integrationProps['IntegrationUri']
          )}). Lambda Arn intrinsics on cross-stack / imported references are not resolvable locally.`,
        },
      },
    ];
  }

  return [
    {
      ...baseRoute,
      lambdaLogicalId: arnOutcome.logicalId,
    },
  ];
}

/**
 * Discover the synthetic `ANY /{proxy+}` route from an
 * `AWS::Lambda::Url` resource.
 *
 * Per-shape classification:
 *   - `AuthType === 'NONE'` + `InvokeMode === 'BUFFERED'` (or unset) → normal route.
 *   - `AuthType === 'NONE'` + `InvokeMode === 'RESPONSE_STREAM'` → normal route
 *     dispatched via the RIE streaming protocol (the response body is a
 *     JSON prelude — `{statusCode, headers, cookies?}` — followed by 8
 *     NULL bytes and then the raw body chunks). The HTTP server pipes
 *     the chunks to the client with `Transfer-Encoding: chunked` (#467).
 *   - `AuthType !== 'NONE'` (e.g. `AWS_IAM`) → deferred-error
 *     unsupported. Boot proceeds; HTTP 501 + `reason` at request time.
 *     IAM auth would need SigV4 verification cdkd cannot emulate.
 *
 * The Lambda Arn intrinsic resolution still **hard-errors** when it
 * cannot pin down a same-template Lambda — Function URLs have no other
 * identifying info (no RouteKey / RestApi parent), so the route would
 * be uninformative as a deferred-501 entry.
 */
function discoverFunctionUrl(
  logicalId: string,
  resource: TemplateResource,
  template: CloudFormationTemplate,
  stackName: string
): DiscoveredRoute[] {
  const props = resource.Properties ?? {};

  // Resolve the backing Lambda first — without it we cannot identify
  // the route surface at all. An unresolvable Arn becomes a hard error
  // because Function URLs have no other identifying info (no RouteKey /
  // RestApi parent).
  const targetArn = props['TargetFunctionArn'];
  const arnOutcome = resolveLambdaArnOutcome(targetArn);
  if (arnOutcome.kind === 'unsupported') {
    throw new Error(
      `${stackName}/${logicalId}.TargetFunctionArn: ${arnOutcome.detail} (got ${shortJson(targetArn)}).`
    );
  }
  const lambdaLogicalId = arnOutcome.logicalId;
  // Function URLs identify by their backing Lambda — surface the Lambda's
  // cdk path so `--api MyStack/MyHandler` (the natural CDK Construct path
  // for the Function, not the auto-generated URL child) matches.
  const lambdaCdkPath = readApiCdkPath(lambdaLogicalId, template);
  const baseRoute: Omit<DiscoveredRoute, 'lambdaLogicalId'> = {
    method: 'ANY',
    pathPattern: '/{proxy+}',
    source: 'function-url',
    apiVersion: 'v2',
    stage: '$default',
    apiStackName: stackName,
    ...(lambdaCdkPath !== undefined && { apiCdkPath: lambdaCdkPath }),
    declaredAt: `${stackName}/${logicalId}`,
  };

  const authType = props['AuthType'];
  if (authType !== 'NONE') {
    return [
      {
        ...baseRoute,
        lambdaLogicalId,
        unsupported: {
          reason: `${stackName}/${logicalId}: AuthType '${String(
            authType
          )}' is not supported (only NONE — IAM auth requires SigV4 verification cdkd cannot emulate locally).`,
        },
      },
    ];
  }
  // InvokeMode controls the response wire protocol. RESPONSE_STREAM
  // opts into the RIE streaming protocol (JSON prelude + 8-NULL-byte
  // separator + raw chunked body) — the local server invokes the Lambda
  // with the `Lambda-Runtime-Function-Response-Mode: streaming` request
  // header and pipes the chunks to the HTTP client with
  // `Transfer-Encoding: chunked`. Closes issue #467. Anything other
  // than these two AWS-documented values is rejected so a future API
  // shape change surfaces as a clear error rather than silent fallback.
  const invokeModeRaw = props['InvokeMode'];
  let invokeMode: 'BUFFERED' | 'RESPONSE_STREAM' = 'BUFFERED';
  if (invokeModeRaw === 'RESPONSE_STREAM') {
    invokeMode = 'RESPONSE_STREAM';
  } else if (invokeModeRaw !== undefined && invokeModeRaw !== 'BUFFERED') {
    // Render with shortJson so an object-valued InvokeMode (defensive
    // — AWS docs require a string, but a malformed template could ship
    // an intrinsic) shows as JSON rather than `[object Object]`.
    return [
      {
        ...baseRoute,
        lambdaLogicalId,
        unsupported: {
          reason: `${stackName}/${logicalId}: InvokeMode ${shortJson(
            invokeModeRaw
          )} is not a recognized value (expected 'BUFFERED' or 'RESPONSE_STREAM').`,
        },
      },
    ];
  }

  return [
    {
      ...baseRoute,
      lambdaLogicalId,
      invokeMode,
    },
  ];
}

/**
 * Read the `aws:cdk:path` metadata of the resource at `logicalId`,
 * returning the empty string when the resource is missing or the
 * metadata isn't set. Hides the "may be missing for a hand-rolled
 * `cfn.Resource`" branch from every call site.
 */
function readApiCdkPath(logicalId: string, template: CloudFormationTemplate): string | undefined {
  const resource = template.Resources?.[logicalId];
  if (!resource) return undefined;
  const path = readCdkPath(resource);
  return path || undefined;
}

/**
 * Local intrinsic resolver for `IntegrationUri` (and the equivalent
 * `Uri` field on REST v1 Method.Integration). Delegates to the shared
 * `resolveLambdaArnIntrinsic` in `intrinsic-lambda-arn.ts` (extracted in
 * issue #286 Gaps 3 / 4); see that module's docstring for the full
 * shape list — `Ref` / `Fn::GetAtt: [..., 'Arn']` / the REST v1
 * invoke-ARN `Fn::Join` wrapper / the `Fn::Sub` invoke-ARN wrapper (both
 * 1-arg and 2-arg forms).
 *
 * Non-throwing: returns the shared resolver's discriminated union
 * unchanged so each call site can decide whether to surface the
 * unsupported case as a per-route `unsupported` flag (the new default)
 * or as a hard error (Function URLs, which lack route-level identity
 * without their Lambda).
 *
 * **Why we don't reuse `src/deployment/intrinsic-function-resolver.ts`**:
 * that resolver is deploy-state-coupled — it pulls in STS / EC2 / Secrets
 * Manager / SSM SDKs and the state backend to resolve runtime values.
 * `cdkd local start-api` runs purely against the synthesized template
 * and doesn't have any of that.
 */
function resolveLambdaArnOutcome(
  value: unknown
): { kind: 'resolved'; logicalId: string } | { kind: 'unsupported'; detail: string } {
  return resolveLambdaArnShared(value);
}

/**
 * Marker prefix the HTTP API v2 Route `Target` field always starts with —
 * AWS documents this as `integrations/<IntegrationId>`. Load-bearing
 * signal that an `Fn::Sub` shape on this field is actually pointing at
 * a same-template Integration rather than something unrelated.
 */
const TARGET_INTEGRATIONS_PREFIX = 'integrations/';

/**
 * Parse an HTTP API Route's `Target` into the integration's logical ID.
 *
 * CDK emits one of:
 *   - `Fn::Join: ['/', ['integrations', { Ref: 'MyIntegration' }]]` (rare).
 *   - `Fn::Join: ['', ['integrations/', { Ref: 'MyIntegration' }]]`
 *     (the shape `aws-cdk-lib/aws-apigatewayv2`'s `HttpApi.addRoutes`
 *     actually emits — empty separator + `'integrations/'` literal
 *     prefix in front of the Ref).
 *   - `Fn::Sub: 'integrations/${MyIntegration}'` (1-arg form — AWS-docs
 *     canonical; emitted by hand-rolled `CfnRoute` constructs).
 *   - `Fn::Sub: ['integrations/${IntId}', { IntId: <Ref|GetAtt> }]`
 *     (2-arg form — what `cdk.Fn.sub(template, vars)` synthesizes
 *     when users build `target` programmatically).
 *   - `'integrations/abc123'` (literal — rare).
 *
 * All five forms are accepted; anything else throws.
 */
function parseHttpApiTargetIntegration(target: unknown, location: string): string {
  if (typeof target === 'string') {
    const m = /^integrations\/(.+)$/.exec(target);
    if (m) return m[1]!;
    throw new Error(`${location}: literal Target '${target}' must start with 'integrations/'`);
  }
  if (target && typeof target === 'object' && !Array.isArray(target)) {
    const obj = target as Record<string, unknown>;

    const join = obj['Fn::Join'];
    if (Array.isArray(join) && join.length === 2 && Array.isArray(join[1])) {
      const sep: unknown = join[0];
      const parts = join[1] as unknown[];

      // Slash-separated form: ['/', ['integrations', { Ref }]]
      if (sep === '/' && parts.length === 2 && parts[0] === 'integrations') {
        const ref = pickRefLogicalId(parts[1]);
        if (ref) return ref;
      }

      // Empty-separator form: ['', ['integrations/', { Ref }]]
      if (sep === '' && parts.length === 2 && parts[0] === 'integrations/') {
        const ref = pickRefLogicalId(parts[1]);
        if (ref) return ref;
      }
    }

    if ('Fn::Sub' in obj) {
      const sub = obj['Fn::Sub'];

      // 1-arg form: `'integrations/${LogicalId}'` — the placeholder name
      // is a direct `Ref` to the integration resource. The marker prefix
      // is load-bearing: a `Fn::Sub` without `integrations/` is not a
      // route Target shape and the caller should see the same hard error
      // as any other bad input.
      if (typeof sub === 'string') {
        const m = new RegExp(`^${TARGET_INTEGRATIONS_PREFIX}\\$\\{([^}]+)\\}$`).exec(sub);
        if (m) {
          const placeholder = m[1]!;
          // Reject dotted refs (`${LogicalId.attr}`) — Integration has no
          // GetAtt shape that produces a route-Target id.
          if (!placeholder.includes('.')) return placeholder;
        }
      }

      // 2-arg form: `['integrations/${Var}', { Var: { Ref: 'LogicalId' } }]`
      // — the template references a binding whose value resolves to the
      // integration logical id.
      if (
        Array.isArray(sub) &&
        sub.length === 2 &&
        typeof sub[0] === 'string' &&
        sub[1] !== null &&
        typeof sub[1] === 'object' &&
        !Array.isArray(sub[1])
      ) {
        const template = sub[0];
        const bindings = sub[1] as Record<string, unknown>;
        const m = new RegExp(`^${TARGET_INTEGRATIONS_PREFIX}\\$\\{([^}]+)\\}$`).exec(template);
        if (m) {
          const placeholder = m[1]!;
          const bound = bindings[placeholder];
          if (bound !== undefined) {
            const ref = pickRefLogicalId(bound);
            if (ref) return ref;
          }
        }
      }
    }
  }
  throw new Error(
    `${location}: Target must be 'integrations/<id>', Fn::Join with one of the documented shapes, or Fn::Sub with an 'integrations/\${...}' template (got ${shortJson(
      target
    )}).`
  );
}

/**
 * Parse an HTTP API RouteKey (`'<METHOD> <path>'` or `'$default'`) into
 * its components.
 */
function parseRouteKey(routeKey: string): { method: string; pathPattern: string } {
  if (routeKey === '$default') {
    return { method: 'ANY', pathPattern: '$default' };
  }
  const m = /^([A-Za-z]+)\s+(\S+)$/.exec(routeKey);
  if (!m) {
    throw new Error(
      `RouteKey '${routeKey}' is malformed: expected '<METHOD> <path>' (e.g. 'GET /items/{id}') or '$default'.`
    );
  }
  return { method: m[1]!.toUpperCase(), pathPattern: m[2]! };
}

/**
 * If `value` is a `{ Ref: <string> }` intrinsic, return the referenced
 * logical ID. Otherwise return `null`.
 */
function pickRefLogicalId(value: unknown): string | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const ref = (value as Record<string, unknown>)['Ref'];
    if (typeof ref === 'string') return ref;
  }
  return null;
}

/**
 * Compact JSON for error messages — caps long objects so a malformed
 * intrinsic doesn't dump the whole template into a stderr line.
 */
function shortJson(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return stringifyValue(value);
  }
}
