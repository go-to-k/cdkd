import type { AssumeRoleOption } from '../../options.js';
import { readCdkPathOrUndefined } from '../../cdk-path.js';
import type { StackInfo } from '../../../synthesis/assembly-reader.js';
import type { DiscoveredRoute } from '../../../local/route-discovery.js';
import type { DiscoveredWebSocketApi } from '../../../local/websocket-route-discovery.js';
import type { ApiServerGroup } from '../../../local/api-server-grouping.js';
import type { EnvOverrideFile } from '../../../local/env-resolver.js';
import { describeStack } from '../../stack-matcher.js';
import type { RouteWithAuth } from '../../../local/authorizer-resolver.js';
import { displayIdent } from '../../../utils/display-safe.js';

export const LAMBDA_FUNCTION_TYPE = 'AWS::Lambda::Function';

/**
 * The stacks whose template declares `logicalId` (optionally of one resource
 * type). One predicate for the served-union checks, {@link lambdaOwners} and
 * {@link resolveLambdaByLogicalId}, so they cannot disagree.
 */
export function stacksDeclaring(
  logicalId: string,
  stacks: readonly StackInfo[],
  type?: string
): StackInfo[] {
  return stacks.filter((stack) => {
    const resource = stack.template.Resources?.[logicalId];
    return resource !== undefined && (type === undefined || resource.Type === type);
  });
}

/**
 * The next step both refusals end with: serve one stack, named by its CDK path
 * -- a shared physical name selects every stack carrying it.
 */
export function renderServeOneStackAdvice(stacks: readonly StackInfo[]): string {
  const example = stacks.find((s) => s.displayName && s.displayName !== s.stackName)?.displayName;
  const shown =
    example !== undefined && displayIdent(example) === example
      ? ` (e.g. --stack '${example}')`
      : '';
  return (
    `Serve one stack at a time: pass --stack with its CDK path${shown}, ` +
    `or a target starting with that path.`
  );
}

/**
 * A Lambda that a served route, its authorizer or a WebSocket route reaches:
 * the stack discovery read the route from (`undefined` when it did not say)
 * and the Lambda's logical id.
 */
export interface ReachedLambda {
  stackName: string | undefined;
  logicalId: string;
}

/**
 * The served stack(s) declaring a reached Lambda: the route's own stack when
 * it declares the id, otherwise every served stack that does. Two stacks
 * reusing one construct id each serve their own Lambda, so the route's stack
 * decides, never the first stack in the list (#5181).
 */
export function lambdaOwners(ref: ReachedLambda, stacks: readonly StackInfo[]): StackInfo[] {
  if (ref.stackName !== undefined) {
    const own = stacks.filter((s) => s.stackName === ref.stackName);
    const declaring = stacksDeclaring(ref.logicalId, own, LAMBDA_FUNCTION_TYPE);
    if (declaring.length > 0) return declaring;
  }
  return stacksDeclaring(ref.logicalId, stacks, LAMBDA_FUNCTION_TYPE);
}

/**
 * The key a served Lambda's container spec is stored under: its stack's name
 * and its logical id, so two stacks reusing a construct id keep two specs
 * (#5181). Unique because a served union never holds two stacks of one name
 * ({@link assertServedLogicalIdsUnambiguous}), and unambiguous because a
 * CloudFormation stack name holds no `:`.
 *
 * @internal exported for unit tests.
 */
export function servedLambdaKey(stackName: string, logicalId: string): string {
  return `${stackName}:${logicalId}`;
}

/** {@link servedLambdaKey} of a reached Lambda's one owner; `undefined` when it has none or several. */
export function servedLambdaKeyFor(
  ref: ReachedLambda,
  stacks: readonly StackInfo[]
): string | undefined {
  const owners = lambdaOwners(ref, stacks);
  return owners.length === 1 ? servedLambdaKey(owners[0]!.stackName, ref.logicalId) : undefined;
}

/**
 * The stack a route was discovered in. Discovery records it on every route;
 * the single-stack fallback covers a route built without it.
 */
export function routeStackName(
  route: DiscoveredRoute,
  stacks: readonly StackInfo[] | undefined
): string | undefined {
  if (route.apiStackName !== undefined) return route.apiStackName;
  return stacks?.length === 1 ? stacks[0]!.stackName : undefined;
}

/** The stack one API server serves: one server is one API of one stack. */
export function groupStackName(
  group: ApiServerGroup,
  stacks: readonly StackInfo[]
): string | undefined {
  const route = group.routes[0]?.route;
  return route === undefined ? undefined : routeStackName(route, stacks);
}

/**
 * The value `byStack` holds for `stackName`, made on first use. Server state
 * that cdk-local keys by bare logical id (the authorizer-verdict cache) is
 * kept per stack this way (#5181), across `--watch` reloads.
 *
 * @internal exported for unit tests.
 */
export function perStack<T>(
  byStack: Map<string, T>,
  stackName: string | undefined,
  make: () => T
): T {
  // JSON: `undefined` (a route discovery left without its stack) cannot
  // collide with a real stack name.
  const key = JSON.stringify(stackName ?? null);
  let value = byStack.get(key);
  if (value === undefined) {
    value = make();
    byStack.set(key, value);
  }
  return value;
}

/**
 * Refuse a served union start-api cannot serve as one. Stacks reusing a
 * construct id are served side by side: the container specs, the stage and the
 * CORS maps are keyed by (stack, logical id) (#5181). What still refuses:
 *
 * - two served stacks sharing one physical stack name (a CDK Stage deployed
 *   twice): deployed state and those keys are looked up by that name (#5175);
 * - a user-supplied BARE logical id -- an `--assume-role <LogicalId>=<arn>`
 *   entry or an `--env-vars` key -- naming a Lambda that more than one served
 *   stack declares, since it does not say which stack it means.
 *
 * @internal exported for unit tests.
 */
export function assertServedLogicalIdsUnambiguous(
  stacks: readonly StackInfo[],
  routes: readonly DiscoveredRoute[],
  routesWithAuth: readonly RouteWithAuth[],
  webSocketApis: readonly DiscoveredWebSocketApi[] = [],
  userIds: { assumeRole?: AssumeRoleOption; overrides?: EnvOverrideFile } = {}
): void {
  if (stacks.length < 2) return;
  // Deployed state, the stage / CORS maps and the container specs are looked
  // up by stack NAME, so two served stacks sharing one would read the first
  // one's state even when no logical id collides.
  const byName = new Map<string, StackInfo[]>();
  for (const stack of stacks)
    byName.set(stack.stackName, [...(byName.get(stack.stackName) ?? []), stack]);
  for (const [name, sharing] of byName) {
    if (sharing.length > 1) {
      // cdkd-raw-beside-safe: `describeStack` and `renderServeOneStackAdvice`
      // sanitize what they print; the name goes through `displayIdent`.
      throw new Error(
        `The served stacks ${sharing.map(describeStack).join(', ')} share the physical stack ` +
          `name ${displayIdent(name)}, and cdkd local start-api reads each stack's deployed ` +
          `state by that name, so it cannot serve them together. ${renderServeOneStackAdvice(sharing)}`
      );
    }
  }

  // The served stacks owning a reached Lambda of each logical id.
  const ownersById = new Map<string, StackInfo[]>();
  for (const ref of reachedLambdas(routes, routesWithAuth, webSocketApis)) {
    const owners = lambdaOwners(ref, stacks);
    if (owners.length > 1) {
      // Reached only when the route's own stack does not declare the id
      // (discovery reads both from one template, so in practice never).
      // cdkd-raw-beside-safe: a count, `describeStack` and
      // `renderServeOneStackAdvice`, each sanitized as above.
      throw new Error(
        `Lambda ${displayIdent(ref.logicalId)} is declared by ${owners.length} of the served ` +
          `stacks (${owners.map(describeStack).join(', ')}), and cdkd local start-api cannot ` +
          `tell which one its route reaches. ${renderServeOneStackAdvice(owners)}`
      );
    }
    for (const owner of owners) {
      const list = ownersById.get(ref.logicalId) ?? [];
      if (!list.includes(owner)) list.push(owner);
      ownersById.set(ref.logicalId, list);
    }
  }

  const perLambda = userIds.assumeRole?.perLambda ?? {};
  for (const logicalId of Object.keys(perLambda)) {
    const owners = ownersById.get(logicalId) ?? [];
    if (owners.length < 2) continue;
    // cdkd-raw-beside-safe: a count, `describeStack` and
    // `renderServeOneStackAdvice`, each sanitized as above.
    throw new Error(
      `--assume-role names Lambda ${displayIdent(logicalId)} by its bare logical ID, which ` +
        `${owners.length} of the served stacks declare (${owners.map(describeStack).join(', ')}), ` +
        `so it does not say which one to assume the role for. ${renderServeOneStackAdvice(owners)}`
    );
  }
  for (const key of Object.keys(userIds.overrides ?? {})) {
    if (key === 'Parameters') continue;
    const owners = ownersById.get(key) ?? [];
    if (owners.length < 2) continue;
    // cdkd-raw-beside-safe: a count, `describeStack`, and each construct path
    // printed only when `displayIdent` leaves it unchanged.
    throw new Error(
      `--env-vars key ${displayIdent(key)} names a Lambda by its bare logical ID, which ` +
        `${owners.length} of the served stacks declare (${owners.map(describeStack).join(', ')}), ` +
        `so it does not say which one it overrides. ${renderConstructPathKeyAdvice(key, owners)}`
    );
  }
}

/**
 * The `--env-vars` next step: key the override by the Lambda's construct
 * path, which starts with its stack's CDK path and so names one stack.
 */
function renderConstructPathKeyAdvice(logicalId: string, owners: readonly StackInfo[]): string {
  const paths: string[] = [];
  for (const owner of owners) {
    const resource = owner.template.Resources?.[logicalId];
    const path = resource
      ? readCdkPathOrUndefined(resource)?.replace(/\/Resource$/, '')
      : undefined;
    if (path !== undefined && displayIdent(path) === path) paths.push(JSON.stringify(path));
  }
  return paths.length > 0
    ? `Key it by the Lambda's construct path instead, which names one stack: ${paths.join(', ')}.`
    : `Key it by the Lambda's construct path instead, which names one stack.`;
}

/**
 * Distinct, stable list of the Lambdas reachable through any discovered route,
 * a Lambda authorizer attached to one, or a WebSocket route -- each with the
 * stack its route came from. Stable order = first-occurrence order in the
 * routes list, then any newly-introduced authorizer Lambdas, then WebSocket
 * Lambdas, which keeps the route-table output deterministic.
 */
export function reachedLambdas(
  routes: readonly DiscoveredRoute[],
  routesWithAuth: readonly RouteWithAuth[],
  webSocketApis: readonly DiscoveredWebSocketApi[] = []
): ReachedLambda[] {
  const seen = new Set<string>();
  const out: ReachedLambda[] = [];
  const add = (stackName: string | undefined, logicalId: string): void => {
    // JSON: neither part can then forge the other's boundary.
    const key = JSON.stringify([stackName ?? null, logicalId]);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ stackName, logicalId });
  };
  for (const r of routes) {
    // Skip deferred-error unsupported routes, synthetic mockCors
    // routes, and service-integration routes — none of them dispatch
    // to a Lambda, so spinning up their containers (when a
    // lambdaLogicalId IS attached, e.g. on a Function URL with
    // AuthType=AWS_IAM) would be wasted boot time.
    if (r.unsupported || r.mockCors || r.serviceIntegration) continue;
    if (r.lambdaLogicalId.length === 0) continue;
    add(r.apiStackName, r.lambdaLogicalId);
  }
  for (const entry of routesWithAuth) {
    // An unsupported / mockCors / service-integration route never
    // reaches the authorizer pass, so its authorizer Lambda doesn't
    // need a container either.
    if (entry.route.unsupported || entry.route.mockCors || entry.route.serviceIntegration) {
      continue;
    }
    const auth = entry.authorizer;
    if (!auth) continue;
    // An authorizer is declared in its route's API's stack.
    if (auth.kind === 'lambda-token' || auth.kind === 'lambda-request') {
      add(entry.route.apiStackName, auth.lambdaLogicalId);
    }
  }
  // #462: pull every WebSocket route's backing Lambda into the
  // unified spec map so the shared container pool can dispatch them
  // alongside HTTP / REST routes.
  for (const api of webSocketApis) {
    for (const r of api.routes) add(r.lambdaStackName, r.targetLambdaLogicalId);
  }
  return out;
}
