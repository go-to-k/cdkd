import { readCdkPath } from '../cli/cdk-path.js';
import type { StackInfo } from '../synthesis/assembly-reader.js';
import type { CloudFormationTemplate, TemplateResource } from '../types/resource.js';
import { RouteDiscoveryError } from '../utils/error-handler.js';
import { resolveLambdaArnIntrinsic } from './intrinsic-lambda-arn.js';

/**
 * Discovered WebSocket API for `cdkd local start-api`.
 *
 * AWS WebSocket APIs use a fundamentally different model from HTTP APIs:
 * routes are keyed by an opaque `RouteKey` string (`$connect`,
 * `$disconnect`, `$default`, or a custom user-defined string), NOT by
 * (method, path) tuples; the API's `RouteSelectionExpression` decides
 * which custom route fires for any given client message. We therefore
 * surface WebSocket discovery as a separate type alongside the
 * `DiscoveredRoute[]` produced by HTTP / REST / Function URL discovery
 * (see design Q4 in docs/design/462-websocket-api.md).
 *
 * Filter: only `AWS::ApiGatewayV2::Api` resources with
 * `ProtocolType: 'WEBSOCKET'` are discovered as WebSocket APIs. HTTP
 * API v2 (`ProtocolType: 'HTTP'`) continues through the normal
 * `discoverRoutes` path.
 */
export interface DiscoveredWebSocketApi {
  /** Logical ID of the parent `AWS::ApiGatewayV2::Api` resource. */
  apiLogicalId: string;
  /** Stack name containing the API resource. */
  apiStackName: string;
  /** Diagnostic only — `<StackName>/<LogicalId>`. */
  declaredAt: string;
  /**
   * CDK Construct path (`aws:cdk:path` metadata) of the API resource.
   * Populated when the synthesized resource carries the metadata. Used
   * by `--api` to accept the CDK display path form.
   */
  apiCdkPath?: string;
  /**
   * The API's selection expression. Defaults to the AWS-canonical
   * `$request.body.action` when the property is omitted. v1 supports
   * only the `$request.body.<key>` (optionally nested) shape; any
   * other shape (`$request.header.X`, `$context.X`) hard-errors at
   * discovery time.
   */
  routeSelectionExpression: string;
  /**
   * Resolved Stage name. Picked from the first `AWS::ApiGatewayV2::Stage`
   * referencing this API; falls back to `'local'` when no Stage is
   * attached (defensive — CDK's `WebSocketStage` always emits one,
   * but a hand-rolled template might not).
   */
  stage: string;
  /**
   * Discovered routes keyed by RouteKey. Each entry resolves the
   * route's backing Lambda via its
   * `AWS::ApiGatewayV2::Integration.IntegrationUri`.
   *
   * v1 supports `IntegrationType: 'AWS_PROXY'` only. Non-Lambda
   * integrations (service-direct) are rejected at discovery — there is
   * no analog of the deferred-501 fallback for WebSocket because the
   * full API model is route-keyed and a single unsupported route
   * forces a different selection-expression evaluator. Closes the
   * design's "Lambda-only in v1" constraint.
   */
  routes: WebSocketRouteEntry[];
  /**
   * Set when the whole API is unsupported by cdkd's local emulation.
   * The CLI's WebSocket attach loop skips an `unsupported`-tagged API
   * (no server is attached, no upgrade is accepted) and surfaces the
   * `reason` as a startup warn naming the affected API so the user
   * sees the gap BEFORE attempting a `wscat`.
   *
   * v1 sets this when any route declares
   * `AuthorizationType !== 'NONE'` (`'AWS_IAM'` / `'CUSTOM'` /
   * `'JWT'` / `'COGNITO_USER_POOLS'`) — auth on `$connect` is the
   * canonical WebSocket guard and silently admitting unauthenticated
   * clients would be a security gap (mirrors the structural pre-empt
   * fix PR #514 shipped for HTTP API v2 service integrations). Full
   * authorizer support (wiring `attachAuthorizers` / `runAuthorizerPass`
   * into the `$connect` flow) is tracked as a follow-up.
   */
  unsupported?: { reason: string };
}

/** One row in {@link DiscoveredWebSocketApi.routes}. */
export interface WebSocketRouteEntry {
  /** `$connect` / `$disconnect` / `$default` / custom user-defined key. */
  routeKey: string;
  /** Logical ID of the backing Lambda. */
  targetLambdaLogicalId: string;
  /** Stack the backing Lambda lives in. */
  lambdaStackName: string;
  /** Diagnostic only — `<StackName>/<RouteLogicalId>`. */
  declaredAt: string;
}

const DEFAULT_ROUTE_SELECTION_EXPRESSION = '$request.body.action';
const DEFAULT_STAGE = 'local';

/**
 * Walk every synthesized stack and produce one {@link DiscoveredWebSocketApi}
 * per WebSocket API found. Errors per API are aggregated and surfaced
 * as a single {@link RouteDiscoveryError} (matches the HTTP-side
 * discovery behavior — a single malformed API shouldn't abort the
 * server boot for sibling APIs).
 *
 * Resolution chain:
 *   1. Find each `AWS::ApiGatewayV2::Api` with `ProtocolType: WEBSOCKET`.
 *   2. Validate `RouteSelectionExpression` (only `$request.body.<key>`
 *      forms supported in v1).
 *   3. Resolve attached Stage (first Stage referencing this API).
 *   4. Walk every `AWS::ApiGatewayV2::Route` referencing this API,
 *      resolve each route's Target → Integration → IntegrationUri →
 *      Lambda logical ID via the shared `resolveLambdaArnIntrinsic`
 *      helper (handles every CFn intrinsic shape CDK emits).
 */
export function discoverWebSocketApis(stacks: readonly StackInfo[]): {
  apis: DiscoveredWebSocketApi[];
  errors: string[];
} {
  const apis: DiscoveredWebSocketApi[] = [];
  const errors: string[] = [];

  for (const stack of stacks) {
    const template = stack.template;
    const resources = template.Resources ?? {};

    for (const [logicalId, resource] of Object.entries(resources)) {
      if (resource.Type !== 'AWS::ApiGatewayV2::Api') continue;
      const props = resource.Properties ?? {};
      if (props['ProtocolType'] !== 'WEBSOCKET') continue;

      try {
        apis.push(discoverOneApi(logicalId, resource, template, stack.stackName));
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
  }

  return { apis, errors };
}

/**
 * Convenience wrapper around {@link discoverWebSocketApis} that
 * throws on any error (mirrors `discoverRoutes` for HTTP — useful in
 * test fixtures where errors should fail fast).
 */
export function discoverWebSocketApisOrThrow(
  stacks: readonly StackInfo[]
): DiscoveredWebSocketApi[] {
  const { apis, errors } = discoverWebSocketApis(stacks);
  if (errors.length > 0) {
    throw new RouteDiscoveryError(
      `cdkd local start-api: ${errors.length} malformed WebSocket API(s) in the synthesized template:\n` +
        errors.map((e) => `  - ${e}`).join('\n')
    );
  }
  return apis;
}

function discoverOneApi(
  logicalId: string,
  resource: TemplateResource,
  template: CloudFormationTemplate,
  stackName: string
): DiscoveredWebSocketApi {
  const props = resource.Properties ?? {};
  const declaredAt = `${stackName}/${logicalId}`;

  const rawSelection = props['RouteSelectionExpression'];
  const routeSelectionExpression =
    typeof rawSelection === 'string' && rawSelection.length > 0
      ? rawSelection
      : DEFAULT_ROUTE_SELECTION_EXPRESSION;

  // v1 supports only `$request.body.<key>` (optionally `<nested.key>`)
  // selection expressions. Reject anything else at discovery time
  // rather than fail mid-message with a confusing error.
  assertSupportedSelectionExpression(routeSelectionExpression, declaredAt);

  const stage = pickStage(logicalId, template);
  const apiCdkPath = readApiCdkPath(logicalId, template);
  const routes = collectRoutesForApi(logicalId, template, stackName);

  if (routes.length === 0) {
    throw new Error(
      `${declaredAt}: WebSocket API has no AWS::ApiGatewayV2::Route children — at least one route (typically '$connect') is required to dispatch.`
    );
  }

  // Scan for non-NONE AuthorizationType on any Route belonging to
  // this API. If found, tag the whole API as unsupported — the CLI
  // attach loop will skip it (no upgrade accepted) and surface the
  // affected routes as a startup warn. cdkd v1 does NOT emulate
  // WebSocket authorizers; silently admitting an unauthenticated
  // client would be a security gap that diverges from
  // AWS-deployed behavior. Full authorizer support (wire
  // `attachAuthorizers` / `runAuthorizerPass` into the `$connect`
  // flow) is tracked as a follow-up.
  const authRoutes = collectAuthRoutesForApi(logicalId, template, stackName);
  const unsupported =
    authRoutes.length > 0
      ? {
          reason: `WebSocket API requires authorizer support, which cdkd v1 does not emulate. Affected route(s): ${authRoutes
            .map((r) => `${r.routeKey} [AuthorizationType=${r.authorizationType}]`)
            .join(
              ', '
            )}. The API will be discovered but no upgrade requests will be accepted on this server.`,
        }
      : undefined;

  return {
    apiLogicalId: logicalId,
    apiStackName: stackName,
    declaredAt,
    ...(apiCdkPath !== '' && { apiCdkPath }),
    routeSelectionExpression,
    stage,
    routes,
    ...(unsupported !== undefined && { unsupported }),
  };
}

/**
 * Scan the synthesized template for every `AWS::ApiGatewayV2::Route`
 * referencing the given WebSocket API, returning the subset whose
 * `AuthorizationType` is set to anything other than `NONE` (the
 * AWS-default when omitted). Used by {@link discoverOneApi} to tag
 * the parent API as unsupported when v1's no-authorizer emulation
 * gap would otherwise let unauthenticated clients through.
 */
function collectAuthRoutesForApi(
  apiLogicalId: string,
  template: CloudFormationTemplate,
  _stackName: string
): { routeKey: string; authorizationType: string }[] {
  const resources = template.Resources ?? {};
  const result: { routeKey: string; authorizationType: string }[] = [];
  for (const [, resource] of Object.entries(resources)) {
    if (resource.Type !== 'AWS::ApiGatewayV2::Route') continue;
    const props = resource.Properties ?? {};
    const parentRef = pickRefLogicalId(props['ApiId']);
    if (parentRef !== apiLogicalId) continue;
    const authType = props['AuthorizationType'];
    if (typeof authType !== 'string' || authType.length === 0) continue;
    if (authType === 'NONE') continue;
    const routeKey = props['RouteKey'];
    result.push({
      routeKey: typeof routeKey === 'string' ? routeKey : '<unknown>',
      authorizationType: authType,
    });
  }
  return result;
}

/**
 * `$request.body.<key>` is the AWS-canonical shape and the only one
 * v1 supports. Allow nested dot access (`$request.body.action.subKey`)
 * — real CDK chat apps sometimes use this for protocol versioning.
 *
 * Reject array-index access (`$request.body.items[0]`), filter
 * expressions, header / context selections — these would require a
 * fuller JSONPath / VTL evaluator and are out of scope for v1.
 */
function assertSupportedSelectionExpression(expr: string, declaredAt: string): void {
  if (!/^\$request\.body(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(expr)) {
    throw new Error(
      `${declaredAt}: RouteSelectionExpression '${expr}' is not supported in cdkd local start-api v1 — only '$request.body.<key>' shapes (optionally nested via dots) are recognized. File a follow-up issue if you need '$request.header.X' / '$context.X' / array-index access.`
    );
  }
}

/**
 * Parse a `$request.body.x.y` selection expression into the JSON-path
 * tokens after `$request.body`. Returns `['x', 'y']` for the example
 * above. Used at message-dispatch time to walk the parsed message body.
 */
export function parseSelectionExpressionPath(expr: string): string[] {
  // Strip the `$request.body.` prefix and split on `.`. We already
  // validated the shape in `assertSupportedSelectionExpression`, so a
  // failed match here is a defensive guard.
  const m = /^\$request\.body\.(.+)$/.exec(expr);
  if (!m) return [];
  return m[1]!.split('.');
}

/**
 * Pick the first `AWS::ApiGatewayV2::Stage` referencing the API. CDK's
 * `apigatewayv2.WebSocketStage` always emits one; the fallback to
 * `'local'` handles hand-rolled templates without a Stage.
 */
function pickStage(apiLogicalId: string, template: CloudFormationTemplate): string {
  const resources = template.Resources ?? {};
  for (const [, resource] of Object.entries(resources)) {
    if (resource.Type !== 'AWS::ApiGatewayV2::Stage') continue;
    const props = resource.Properties ?? {};
    const ref = pickRefLogicalId(props['ApiId']);
    if (ref === apiLogicalId) {
      const stageName = props['StageName'];
      if (typeof stageName === 'string' && stageName.length > 0) return stageName;
    }
  }
  return DEFAULT_STAGE;
}

/**
 * Walk every `AWS::ApiGatewayV2::Route` and resolve each one whose
 * parent `ApiId` Ref matches the WebSocket API. Per-route failures
 * abort the API's discovery (a partial route map would silently
 * disable some routes — better to fail fast and let the user fix the
 * template).
 */
function collectRoutesForApi(
  apiLogicalId: string,
  template: CloudFormationTemplate,
  stackName: string
): WebSocketRouteEntry[] {
  const resources = template.Resources ?? {};
  const result: WebSocketRouteEntry[] = [];
  const seenKeys = new Set<string>();

  for (const [routeLogicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== 'AWS::ApiGatewayV2::Route') continue;
    const props = resource.Properties ?? {};
    const parentRef = pickRefLogicalId(props['ApiId']);
    if (parentRef !== apiLogicalId) continue;

    const declaredAt = `${stackName}/${routeLogicalId}`;
    const routeKey = props['RouteKey'];
    if (typeof routeKey !== 'string' || routeKey.length === 0) {
      throw new Error(`${declaredAt}: RouteKey must be a non-empty string.`);
    }
    if (seenKeys.has(routeKey)) {
      throw new Error(
        `${declaredAt}: WebSocket API has duplicate RouteKey '${routeKey}' — each RouteKey may appear at most once per API.`
      );
    }
    seenKeys.add(routeKey);

    const targetLogicalId = parseRouteTarget(props['Target'], declaredAt);
    const integration = resources[targetLogicalId];
    if (!integration || integration.Type !== 'AWS::ApiGatewayV2::Integration') {
      throw new Error(
        `${declaredAt}: Target points at '${targetLogicalId}' which is not an AWS::ApiGatewayV2::Integration.`
      );
    }
    const integrationProps = integration.Properties ?? {};
    const integrationType = integrationProps['IntegrationType'];
    if (integrationType !== 'AWS_PROXY') {
      throw new Error(
        `${declaredAt}: WebSocket route IntegrationType '${String(
          integrationType
        )}' is not supported in cdkd local start-api v1 — only AWS_PROXY (Lambda) integrations are emulated.`
      );
    }

    const arnOutcome = resolveLambdaArnIntrinsic(integrationProps['IntegrationUri']);
    if (arnOutcome.kind === 'unsupported') {
      throw new Error(
        `${stackName}/${targetLogicalId}.IntegrationUri: ${arnOutcome.detail} — WebSocket routes must point at a same-template Lambda.`
      );
    }

    result.push({
      routeKey,
      targetLambdaLogicalId: arnOutcome.logicalId,
      lambdaStackName: stackName,
      declaredAt,
    });
  }

  return result;
}

/**
 * WebSocket Routes use the same `Target: 'integrations/<id>'` shape as
 * HTTP API v2 Routes. We accept the same five forms documented in
 * `route-discovery.ts:parseHttpApiTargetIntegration` — literal string,
 * two `Fn::Join` shapes, two `Fn::Sub` shapes.
 *
 * Implementation note: we intentionally duplicate the parser rather
 * than reach into `route-discovery.ts` because that module is in flux
 * (`unsupported` / `mockCors` shapes; HTTP-specific). When the two
 * parsers grow apart, the WebSocket one only needs to track the AWS
 * WebSocket-side shape — which has been stable since 2018.
 */
function parseRouteTarget(target: unknown, location: string): string {
  if (typeof target === 'string') {
    const m = /^integrations\/(.+)$/.exec(target);
    if (m) return m[1]!;
    throw new Error(`${location}: literal Target '${target}' must start with 'integrations/'.`);
  }
  if (target && typeof target === 'object' && !Array.isArray(target)) {
    const obj = target as Record<string, unknown>;

    const join = obj['Fn::Join'];
    if (Array.isArray(join) && join.length === 2 && Array.isArray(join[1])) {
      const sep: unknown = join[0];
      const parts = join[1] as unknown[];

      if (sep === '/' && parts.length === 2 && parts[0] === 'integrations') {
        const ref = pickRefLogicalId(parts[1]);
        if (ref) return ref;
      }
      if (sep === '' && parts.length === 2 && parts[0] === 'integrations/') {
        const ref = pickRefLogicalId(parts[1]);
        if (ref) return ref;
      }
    }

    if ('Fn::Sub' in obj) {
      const sub = obj['Fn::Sub'];
      const prefix = 'integrations/';
      if (typeof sub === 'string') {
        const m = new RegExp(`^${prefix}\\$\\{([^}]+)\\}$`).exec(sub);
        if (m) {
          const placeholder = m[1]!;
          if (!placeholder.includes('.')) return placeholder;
        }
      }
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
        const m = new RegExp(`^${prefix}\\$\\{([^}]+)\\}$`).exec(template);
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
    `${location}: Target must be 'integrations/<id>' literal, Fn::Join with the documented shapes, or Fn::Sub with an 'integrations/\${...}' template.`
  );
}

function pickRefLogicalId(value: unknown): string | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const ref = (value as Record<string, unknown>)['Ref'];
    if (typeof ref === 'string') return ref;
  }
  return null;
}

function readApiCdkPath(logicalId: string, template: CloudFormationTemplate): string {
  const resource = template.Resources?.[logicalId];
  if (!resource) return '';
  return readCdkPath(resource);
}
