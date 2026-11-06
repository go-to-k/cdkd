import { getLogger } from '../../../utils/logger.js';
import type { StackInfo } from '../../../synthesis/assembly-reader.js';
import type { DiscoveredRoute } from '../../../local/route-discovery.js';
import type { DiscoveredWebSocketApi } from '../../../local/websocket-route-discovery.js';
import { warnSsrfRiskyUri } from '../../../local/rest-v1-integrations.js';
import type { ContainerSpec } from '../../../local/container-pool.js';
import type { ApiServerGroup } from '../../../local/api-server-grouping.js';
import {
  buildCorsConfigByApiId,
  buildCorsConfigFromCloudFrontChain,
  type CorsConfig,
} from '../../../local/cors-handler.js';
import {
  attachStageContext,
  buildStageMap,
  type ResolvedStage,
} from '../../../local/stage-resolver.js';
import type { RouteWithAuth } from '../../../local/authorizer-resolver.js';
import { formatAuthority } from '../../../utils/url-authority.js';
import type { NextStateMaterial, BootedApiServer } from './types.js';
import {
  routeStackName,
  reachedLambdas,
  lambdaOwners,
  servedLambdaKey,
  servedLambdaKeyFor,
  groupStackName,
} from './served-lambdas.js';

/**
 * Print the discovered route table to stdout. Format mirrors the spec
 * doc's example so verify.sh / users can read it at a glance.
 *
 * Routes with `unsupported` or `mockCors` are annotated so the user can
 * tell at a glance which routes will dispatch to a Lambda vs which
 * return 501 / 204 directly:
 *   - normal:        `GET /items to Handler  (HTTP API)`
 *   - mockCors:      `OPTIONS /items to [MOCK CORS preflight]  (REST v1, stage 'prod')`
 *   - unsupported:   `POST /admin to [501 Not Implemented]  (HTTP API)`
 */
function printRouteTable(routes: readonly RouteWithAuth[]): void {
  const flat = routes.map((r) => r.route);
  const sorted = [...flat].sort((a, b) => {
    if (a.pathPattern !== b.pathPattern) return a.pathPattern.localeCompare(b.pathPattern);
    return a.method.localeCompare(b.method);
  });
  const methodWidth = Math.max(...sorted.map((r) => r.method.length), 6);
  const pathWidth = Math.max(...sorted.map((r) => r.pathPattern.length), 8);
  process.stdout.write('Discovered routes:\n');
  for (const r of sorted) {
    const sourceLabel =
      r.source === 'http-api'
        ? 'HTTP API'
        : r.source === 'rest-v1'
          ? `REST v1, stage '${r.stage}'`
          : 'Function URL';
    const target = r.mockCors
      ? '[MOCK CORS preflight]'
      : r.unsupported
        ? '[501 Not Implemented]'
        : r.serviceIntegration
          ? `[${r.serviceIntegration.subtype}]`
          : r.restV1Integration
            ? formatRestV1IntegrationLabel(r.restV1Integration)
            : r.lambdaLogicalId;
    process.stdout.write(
      `  ${r.method.padEnd(methodWidth)}  ${r.pathPattern.padEnd(pathWidth)}  to ${target}  (${sourceLabel})\n`
    );
  }
  process.stdout.write('\n');
}

/**
 * Format the route-table label for a REST v1 non-AWS_PROXY integration.
 * `MOCK` / `HTTP` / `HTTP_PROXY` show their integration kind directly;
 * `AWS` (Lambda non-proxy) shows the Lambda logical id with an `[AWS]`
 * suffix so it's distinguishable from AWS_PROXY rows. Closes #457.
 */
function formatRestV1IntegrationLabel(
  integration: NonNullable<DiscoveredRoute['restV1Integration']>
): string {
  switch (integration.kind) {
    case 'mock':
      return '[MOCK]';
    case 'http-proxy':
      return `[HTTP_PROXY ${integration.uri}]`;
    case 'http':
      return `[HTTP ${integration.uri}]`;
    case 'aws-lambda':
      return `${integration.lambdaLogicalId} [AWS]`;
  }
}

/**
 * Attach each route's Stage (`stage`, `stageVariables`) from its OWN stack's
 * Stage map (#5181), so two stacks reusing an API construct id each serve
 * their own Stage. Returns the APIs with no Stage named `stageOverride` (empty
 * without one), stack-qualified when more than one stack is served.
 *
 * @internal exported for unit tests.
 */
export function attachStageContextPerStack(
  stacks: readonly StackInfo[],
  routes: DiscoveredRoute[],
  stageOverride: string | undefined
): Set<string> {
  const missingApis = new Set<string>();
  for (const stack of stacks) {
    const stageMap: Map<string, ResolvedStage> = buildStageMap(stack.template, stageOverride);
    const own = routes.filter((r) => routeStackName(r, stacks) === stack.stackName);
    if (stageOverride) {
      // HTTP API v2 / REST v1 routes whose API had no Stage with the
      // override name. One entry per such API, deduplicated.
      for (const r of own) {
        if (!r.apiLogicalId || stageMap.has(r.apiLogicalId)) continue;
        missingApis.add(
          stacks.length > 1 ? `${stack.stackName}:${r.apiLogicalId}` : r.apiLogicalId
        );
      }
    }
    attachStageContext(own, stageMap);
  }
  return missingApis;
}

/**
 * The per-API CORS config of each stack, keyed by stack name (#5181). Within
 * a stack: HTTP API v2 `CorsConfiguration`, a Function URL's own `Cors`
 * (#644), and CORS borrowed from a fronting CloudFront
 * ResponseHeadersPolicy (#646), the Function URL's own winning.
 *
 * @internal exported for unit tests.
 */
export function buildCorsConfigByStack(
  stacks: readonly StackInfo[]
): Map<string, Map<string, CorsConfig>> {
  const out = new Map<string, Map<string, CorsConfig>>();
  for (const stack of stacks) {
    const corsConfigByApiId = new Map<string, CorsConfig>();
    for (const [k, v] of buildCorsConfigFromCloudFrontChain(stack.template)) {
      corsConfigByApiId.set(k, v);
    }
    for (const [k, v] of buildCorsConfigByApiId(stack.template)) corsConfigByApiId.set(k, v);
    out.set(stack.stackName, corsConfigByApiId);
  }
  return out;
}

/**
 * Build one container spec per reached Lambda, keyed by
 * {@link servedLambdaKey} and resolved against the route's own stack
 * (#5181): two stacks reusing a construct id get one spec each. `build`
 * receives the owning stack alone, or every served stack when the Lambda has
 * no single owner, so the resolver names the miss or the ambiguity; `index`
 * counts the specs built so far (the `--debug-port-base` offset).
 *
 * @internal exported for unit tests.
 */
export async function buildServedLambdaSpecs(
  stacks: StackInfo[],
  routes: readonly DiscoveredRoute[],
  routesWithAuth: readonly RouteWithAuth[],
  webSocketApis: readonly DiscoveredWebSocketApi[],
  build: (args: { logicalId: string; stacks: StackInfo[]; index: number }) => Promise<ContainerSpec>
): Promise<Map<string, ContainerSpec>> {
  const specs = new Map<string, ContainerSpec>();
  for (const ref of reachedLambdas(routes, routesWithAuth, webSocketApis)) {
    const owners = lambdaOwners(ref, stacks);
    const key =
      owners.length === 1 ? servedLambdaKey(owners[0]!.stackName, ref.logicalId) : undefined;
    if (key !== undefined && specs.has(key)) continue;
    const spec = await build({
      logicalId: ref.logicalId,
      stacks: owners.length === 1 ? owners : stacks,
      index: specs.size,
    });
    specs.set(key ?? ref.logicalId, spec);
  }
  return specs;
}

/**
 * Filter the global Lambda spec map to just the Lambdas reachable from
 * one API server group. The container pool for that server is built
 * from this filtered map so per-API authorizer Lambdas + route
 * handlers stay scoped to their owning server — disposing one server's
 * pool on shutdown does NOT touch another server's still-warm
 * containers.
 *
 * Also includes any authorizer Lambdas attached to the group's routes
 * (a Lambda authorizer is a Lambda the pool needs to know about, even
 * though no route directly handles `lambdaLogicalId === auth.lambdaLogicalId`).
 *
 * @internal exported for unit tests.
 */
export function filterSpecsForGroup(
  group: ApiServerGroup,
  material: Pick<NextStateMaterial, 'specs' | 'stacks'>
): Map<string, ContainerSpec> {
  // The pool is keyed by the bare id the server dispatches on; one server is
  // one API of one stack, so the id is unique within it. The spec is looked
  // up by the route's own stack (#5181).
  const out = new Map<string, ContainerSpec>();
  const add = (stackName: string | undefined, logicalId: string): void => {
    if (out.has(logicalId)) return;
    const key = servedLambdaKeyFor({ stackName, logicalId }, material.stacks);
    const spec = key === undefined ? undefined : material.specs.get(key);
    if (spec) out.set(logicalId, spec);
  };
  for (const rwa of group.routes) {
    add(rwa.route.apiStackName, rwa.route.lambdaLogicalId);
    const auth = rwa.authorizer;
    if (auth && (auth.kind === 'lambda-token' || auth.kind === 'lambda-request')) {
      add(rwa.route.apiStackName, auth.lambdaLogicalId);
    }
  }
  return out;
}

/**
 * {@link filterSpecsForGroup} for one WebSocket API: its routes' Lambdas,
 * keyed by the bare id the WebSocket server dispatches on, each spec looked
 * up by the route's own stack (#5181).
 *
 * @internal exported for unit tests.
 */
export function filterSpecsForWebSocketApi(
  api: DiscoveredWebSocketApi,
  material: Pick<NextStateMaterial, 'specs' | 'stacks'>
): Map<string, ContainerSpec> {
  const out = new Map<string, ContainerSpec>();
  for (const r of api.routes) {
    const ref = { stackName: r.lambdaStackName, logicalId: r.targetLambdaLogicalId };
    const key = servedLambdaKeyFor(ref, material.stacks);
    const spec = key === undefined ? undefined : material.specs.get(key);
    if (spec) out.set(r.targetLambdaLogicalId, spec);
  }
  return out;
}

/**
 * The per-API CORS map of a server's own stack (#5181): one server is one API
 * of one stack, so two stacks reusing an API construct id keep their own CORS.
 *
 * @internal exported for unit tests.
 */
export function corsConfigForGroup(
  group: ApiServerGroup,
  material: Pick<NextStateMaterial, 'corsConfigByStack' | 'stacks'>
): Map<string, CorsConfig> {
  const stackName = groupStackName(group, material.stacks);
  return (
    (stackName === undefined ? undefined : material.corsConfigByStack.get(stackName)) ?? new Map()
  );
}

/**
 * Print one route table per server, with the server's display name as
 * the section header. Replaces the pre-issue #260 single flat table —
 * users now see exactly which routes belong to which API + port.
 */
export function printPerServerRouteTables(servers: readonly BootedApiServer[]): void {
  for (const { group, server } of servers) {
    process.stdout.write(
      `\n${group.displayName}  (http://${formatAuthority(server.host, server.port)})\n`
    );
    printRouteTable(group.routes);
  }
}

/**
 * Surface every `unsupported` route (deferred 501) as a startup warn so
 * the user sees what isn't reachable BEFORE they try to curl it. One
 * warn line per route — the route's `unsupported.reason` already names
 * the offender + the underlying limitation, so we just prefix with
 * method + path. Returns the number of unsupported routes so the caller
 * can emit a single-line summary header above the list.
 */
export function warnUnsupportedRoutes(
  routes: readonly DiscoveredRoute[],
  logger: ReturnType<typeof getLogger>
): number {
  const unsupported = routes.filter((r) => r.unsupported);
  if (unsupported.length === 0) return 0;
  logger.warn(
    `${unsupported.length} route(s) will respond HTTP 501 Not Implemented when hit (boot continued):`
  );
  for (const r of unsupported) {
    logger.warn(`  - ${r.method} ${r.pathPattern}: ${r.unsupported!.reason}`);
  }
  return unsupported.length;
}

/**
 * Surface every WebSocket API tagged as unsupported at discovery as a
 * startup warn. The boot loop above skips attaching the server for
 * these APIs, so no upgrade requests are ever accepted on them —
 * mirrors `warnUnsupportedRoutes`'s shape but for the WebSocket axis.
 * Typical trigger: a Route declaring `AuthorizationType !== 'NONE'` on
 * `$connect` (cdkd v1 does not emulate WebSocket authorizers; closing
 * this gap structurally rather than silently admitting
 * unauthenticated clients matches the security-by-default precedent
 * PR #514 set for HTTP API v2 service integrations).
 */
export function warnUnsupportedWebSocketApis(
  apis: readonly DiscoveredWebSocketApi[],
  logger: ReturnType<typeof getLogger>
): number {
  const unsupported = apis.filter((api) => api.unsupported);
  if (unsupported.length === 0) return 0;
  logger.warn(
    `${unsupported.length} WebSocket API(s) will NOT accept upgrade requests (boot continued):`
  );
  for (const api of unsupported) {
    logger.warn(`  - ${api.declaredAt}: ${api.unsupported!.reason}`);
  }
  return unsupported.length;
}

/**
 * Surface a one-line warn per HTTP / HTTP_PROXY integration whose
 * `Integration.Uri` points at a well-known internal address space
 * (AWS IMDS, loopback, link-local, RFC1918). PR #505 / issue #457
 * follow-up: cdkd does NOT block these — warn-and-proceed matches the
 * cognito JWKS pass-through pattern — but the user should see the
 * destination at boot so a malicious / typo'd template Uri does not
 * silently exfiltrate credentials in CI. Deduplicated per-Uri.
 */
export function warnSsrfRiskyIntegrations(
  routes: readonly DiscoveredRoute[],
  logger: ReturnType<typeof getLogger>
): void {
  const seen = new Set<string>();
  for (const r of routes) {
    const integ = r.restV1Integration;
    if (!integ) continue;
    if (integ.kind !== 'http' && integ.kind !== 'http-proxy') continue;
    if (seen.has(integ.uri)) continue;
    seen.add(integ.uri);
    warnSsrfRiskyUri(integ.uri, `${r.method} ${r.pathPattern}`, (msg) => logger.warn(msg));
  }
}
