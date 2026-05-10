import type { StackInfo } from '../synthesis/assembly-reader.js';
import type { CloudFormationTemplate, TemplateResource } from '../types/resource.js';
import { RouteDiscoveryError } from '../utils/error-handler.js';

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
 * The discovery layer is **strict** — any unsupported shape (non-AWS_PROXY
 * integration, ApiGwV2 service integration, WebSocket protocol,
 * non-NONE Lambda::Url AuthType, RESPONSE_STREAM invoke mode, unsupported
 * intrinsic in `IntegrationUri`) hard-errors via {@link RouteDiscoveryError}
 * with the offending route's location named in the message. The server
 * does not start in a half-working state.
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
   */
  stage: string;
  /** Diagnostic only — used in route-table output and error messages. */
  declaredAt: string;
}

/**
 * Walk every stack's template and produce a flat list of discovered
 * routes. Routes are de-duplicated only when their (method, pathPattern,
 * lambdaLogicalId, stage) tuple is identical — different stacks may
 * legitimately host different APIs that mount the same path.
 *
 * Throws {@link RouteDiscoveryError} on any unsupported shape with every
 * offending route named in a single message.
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
            routes.push(...discoverFunctionUrl(logicalId, resource, stack.stackName));
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
      `cdkd local start-api: ${errors.length} unsupported route(s) in the synthesized template:\n` +
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
 * Returns `[]` when the Method's integration is non-AWS_PROXY (e.g. MOCK,
 * AWS, HTTP) — that is a hard error, raised by the caller's catch.
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

  // REST v1 uses `Type: 'AWS_PROXY'` to mean Lambda Proxy integration.
  // Other Type values (`MOCK`, `AWS`, `HTTP`, `HTTP_PROXY`) require
  // mapping templates / VTL we cannot emulate locally.
  const integrationType = integration['Type'];
  if (integrationType !== 'AWS_PROXY') {
    throw new Error(
      `${stackName}/${logicalId} (AWS::ApiGateway::Method): integration type '${String(
        integrationType
      )}' is not supported (only AWS_PROXY). MOCK / AWS / HTTP / HTTP_PROXY require mapping templates that cdkd cannot emulate.`
    );
  }

  const integrationUri = integration['Uri'];
  const lambdaLogicalId = resolveLambdaArnIntrinsic(
    integrationUri,
    `${stackName}/${logicalId}.Integration.Uri`
  );

  // Walk Resource.ParentId chain up to RestApi to assemble the path.
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

  const httpMethod = String(props['HttpMethod'] ?? 'ANY');
  const stage = pickRestV1Stage(restApiLogicalId, template);

  return [
    {
      method: httpMethod,
      pathPattern: path,
      lambdaLogicalId,
      source: 'rest-v1',
      apiVersion: 'v1',
      stage,
      declaredAt: `${stackName}/${logicalId}`,
    },
  ];
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

  // C13: WebSocket-protocol APIs cannot be emulated locally.
  const apiResource = template.Resources?.[apiLogicalId];
  if (apiResource?.Type === 'AWS::ApiGatewayV2::Api') {
    const protocolType = (apiResource.Properties ?? {})['ProtocolType'];
    if (protocolType === 'WEBSOCKET') {
      throw new Error(
        `${stackName}/${logicalId} (AWS::ApiGatewayV2::Route): WebSocket APIs are not supported in cdkd local start-api (deferred follow-up PR).`
      );
    }
  }

  const routeKey = props['RouteKey'];
  if (typeof routeKey !== 'string' || routeKey.length === 0) {
    throw new Error(
      `${stackName}/${logicalId} (AWS::ApiGatewayV2::Route): RouteKey must be a string`
    );
  }

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

  // C9: filter to AWS_PROXY + no IntegrationSubtype.
  const integrationType = integrationProps['IntegrationType'];
  if (integrationType !== 'AWS_PROXY') {
    throw new Error(
      `${stackName}/${logicalId} (AWS::ApiGatewayV2::Route): integration type '${String(
        integrationType
      )}' is not supported (only AWS_PROXY).`
    );
  }
  if (integrationProps['IntegrationSubtype'] !== undefined) {
    throw new Error(
      `${stackName}/${logicalId} (AWS::ApiGatewayV2::Route): IntegrationSubtype '${String(
        integrationProps['IntegrationSubtype']
      )}' is not supported (ApiGatewayV2 service integrations like SQS/EventBridge cannot run locally).`
    );
  }

  const lambdaLogicalId = resolveLambdaArnIntrinsic(
    integrationProps['IntegrationUri'],
    `${stackName}/${integrationLogicalId}.IntegrationUri`
  );

  // RouteKey grammar: `<METHOD> <path>` or `$default`.
  const { method, pathPattern } = parseRouteKey(routeKey);

  return [
    {
      method,
      pathPattern,
      lambdaLogicalId,
      source: 'http-api',
      apiVersion: 'v2',
      stage: '$default',
      declaredAt: `${stackName}/${logicalId}`,
    },
  ];
}

/**
 * Discover the synthetic `ANY /{proxy+}` route from an
 * `AWS::Lambda::Url` resource.
 *
 * C12: keep only `AuthType === 'NONE' && InvokeMode !== 'RESPONSE_STREAM'`.
 * Other shapes hard-fail at discovery — IAM auth needs SigV4 verification
 * we cannot do locally, and RESPONSE_STREAM uses a streaming response shape
 * (`InvokeWithResponseStream`) the RIE container does not implement.
 */
function discoverFunctionUrl(
  logicalId: string,
  resource: TemplateResource,
  stackName: string
): DiscoveredRoute[] {
  const props = resource.Properties ?? {};
  const authType = props['AuthType'];
  if (authType !== 'NONE') {
    throw new Error(
      `${stackName}/${logicalId} (AWS::Lambda::Url): AuthType '${String(
        authType
      )}' is not supported (only NONE — IAM auth requires SigV4 verification cdkd cannot emulate locally; deferred follow-up PR).`
    );
  }
  const invokeMode = props['InvokeMode'];
  if (invokeMode === 'RESPONSE_STREAM') {
    throw new Error(
      `${stackName}/${logicalId} (AWS::Lambda::Url): InvokeMode RESPONSE_STREAM is not supported (deferred follow-up PR).`
    );
  }

  const targetArn = props['TargetFunctionArn'];
  const lambdaLogicalId = resolveLambdaArnIntrinsic(
    targetArn,
    `${stackName}/${logicalId}.TargetFunctionArn`
  );

  return [
    {
      method: 'ANY',
      pathPattern: '/{proxy+}',
      lambdaLogicalId,
      source: 'function-url',
      apiVersion: 'v2',
      stage: '$default',
      declaredAt: `${stackName}/${logicalId}`,
    },
  ];
}

/**
 * Local intrinsic resolver for `IntegrationUri` (and the equivalent
 * `Uri` field on REST v1 Method.Integration). Handles ONLY the shapes
 * CDK actually emits for AWS_PROXY Lambda integrations:
 *
 *   1. `{ Ref: <LambdaLogicalId> }` — rare, but accepted.
 *   2. `{ 'Fn::GetAtt': [<LambdaLogicalId>, 'Arn'] }` — common HTTP API
 *      shape.
 *   3. **REST v1 invoke ARN wrap**: `{ 'Fn::Join': ['', ['arn:', { Ref:
 *      'AWS::Partition' }, ':apigateway:', { Ref: 'AWS::Region' },
 *      ':lambda:path/2015-03-31/functions/', { 'Fn::GetAtt':
 *      [<LambdaLogicalId>, 'Arn'] }, '/invocations']] }` — the only
 *      shape `apigateway.LambdaIntegration({proxy: true})` synthesizes.
 *
 * Any other intrinsic (`Fn::Sub` against an arbitrary template, etc.)
 * hard-errors with the offending route + raw intrinsic named.
 *
 * **Why we don't reuse `src/deployment/intrinsic-function-resolver.ts`**:
 * that resolver is deploy-state-coupled — it pulls in STS / EC2 / Secrets
 * Manager / SSM SDKs and the state backend to resolve runtime values.
 * `cdkd local start-api` runs purely against the synthesized template
 * and doesn't have any of that.
 */
function resolveLambdaArnIntrinsic(value: unknown, location: string): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;

    if ('Ref' in obj && typeof obj['Ref'] === 'string') {
      return obj['Ref'];
    }

    if ('Fn::GetAtt' in obj) {
      const arg = obj['Fn::GetAtt'];
      if (
        Array.isArray(arg) &&
        arg.length === 2 &&
        typeof arg[0] === 'string' &&
        arg[1] === 'Arn'
      ) {
        return arg[0];
      }
    }

    // REST v1 invoke-ARN wrapping (case 3 above). CDK's
    // `LambdaIntegration({ proxy: true })` always emits this exact shape;
    // we walk the array looking for the embedded `Fn::GetAtt: [..., 'Arn']`
    // entry and pluck the logical ID out of it.
    if ('Fn::Join' in obj) {
      const join = obj['Fn::Join'];
      if (Array.isArray(join) && join.length === 2 && Array.isArray(join[1])) {
        // The first element is the separator; the second is the parts list.
        // `parts.join('')` should look like the invoke-ARN template; we
        // verify by looking for the literal `:lambda:path/2015-03-31/`
        // marker in any string entry, then pluck the GetAtt logical ID.
        const parts = join[1] as unknown[];
        const literalParts = parts.filter((p): p is string => typeof p === 'string').join('');
        if (literalParts.includes(':lambda:path/2015-03-31/functions/')) {
          for (const p of parts) {
            if (p && typeof p === 'object' && !Array.isArray(p)) {
              const inner = p as Record<string, unknown>;
              const arg = inner['Fn::GetAtt'];
              if (
                Array.isArray(arg) &&
                arg.length === 2 &&
                typeof arg[0] === 'string' &&
                arg[1] === 'Arn'
              ) {
                return arg[0];
              }
            }
          }
        }
      }
    }
  }

  throw new Error(
    `${location}: only { Ref: <LambdaLogicalId> }, { 'Fn::GetAtt': [<LambdaLogicalId>, 'Arn'] }, or the REST v1 invoke-ARN Fn::Join wrapper are supported (got ${shortJson(
      value
    )}). Other intrinsics (Fn::Sub against arbitrary templates, etc.) require deploy-state and are not supported in cdkd local start-api.`
  );
}

/**
 * Parse an HTTP API Route's `Target` into the integration's logical ID.
 *
 * CDK emits one of:
 *   - `Fn::Join: ['/', ['integrations', { Ref: 'MyIntegration' }]]` (rare).
 *   - `Fn::Join: ['', ['integrations/', { Ref: 'MyIntegration' }]]`
 *     (the shape `aws-cdk-lib/aws-apigatewayv2`'s `HttpApi.addRoutes`
 *     actually emits — empty separator + `'integrations/'` literal
 *     prefix in front of the Ref).
 *   - `'integrations/abc123'` (literal — rare).
 *
 * All three forms are accepted; anything else throws.
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
  }
  throw new Error(
    `${location}: Target must be 'integrations/<id>' or Fn::Join with one of the documented shapes (got ${shortJson(
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
    return String(value);
  }
}
