import type { RouteWithAuth } from './authorizer-resolver.js';

/**
 * One group of routes that share a single API surface — and therefore
 * a single local HTTP server in `cdkd local start-api` (issue #260).
 *
 * Pre-PR `cdkd local start-api` lumped every discovered API into one
 * HTTP server on one port. That broke realistic CDK apps with multiple
 * APIs (e.g. an admin API with Cognito auth and a public API with no
 * auth): authorizers, CORS configs, and stage variables are all
 * per-API, and lumping them into one server forced an awkward "first
 * match wins" semantic that did not mirror AWS Lambda's actual
 * routing.
 *
 * Post-PR the CLI launches **one server per group** so each API gets
 * its own port, its own authorizer pipeline, its own CORS config, and
 * its own container pool. The grouping rule:
 *
 *   - `AWS::ApiGateway::RestApi`     → one group per RestApi logical id
 *   - `AWS::ApiGatewayV2::Api`       → one group per HTTP API logical id
 *   - `AWS::Lambda::Url`             → one group per Function URL (keyed
 *                                       by the Lambda's logical id, since
 *                                       Function URLs are 1:1 with their
 *                                       backing Lambda and don't share a
 *                                       parent "Api" resource)
 *
 * `serverKey` is the stable matching key (used by the reload orchestrator
 * to swap state per server across reloads). `displayName` is what we
 * print in the startup banner / route table — human-readable, includes
 * the API kind in parens for disambiguation.
 */
export interface ApiServerGroup {
  /**
   * Stable identity for cross-reload state matching. Format:
   *   - `http-api:<stackName>:<apiLogicalId>` (when route has `apiStackName`)
   *   - `rest-v1:<stackName>:<apiLogicalId>`
   *   - `function-url:<stackName>:<lambdaLogicalId>`
   *
   * Routes without `apiStackName` (templates lacking `aws:cdk:path`
   * metadata, hand-rolled `cfn.Resource` defs, or fixtures from
   * pre-`aws:cdk:path` test code) fall back to the un-prefixed shape:
   *   - `http-api:<apiLogicalId>` / `rest-v1:<apiLogicalId>` /
   *     `function-url:<lambdaLogicalId>`
   *
   * The stack prefix means cross-stack same-logical-id APIs (a CDK app
   * with `MyHttpApi` in both `WebStack` and `AdminStack`) get **two
   * separate servers** rather than silently colliding on one serverKey
   * — defense-in-depth on top of the upstream multi-stack bare-id
   * rejection in the CLI command body.
   */
  readonly serverKey: string;
  /** Human-readable name surfaced in logs (e.g. "MyHttpApi (HTTP API v2)"). */
  readonly displayName: string;
  /** Discriminator on the kind of API. */
  readonly kind: 'rest-v1' | 'http-api' | 'function-url' | 'websocket';
  /**
   * Logical ID of the parent API resource (or, for Function URLs, the
   * backing Lambda). Useful for `--api <id>` filtering, CORS lookup,
   * and route-grouping diagnostics.
   */
  readonly identifier: string;
  /** Routes that belong to this server. Non-empty by construction. */
  readonly routes: readonly RouteWithAuth[];
}

/**
 * Group a flat list of discovered routes (with authorizer info already
 * attached by `attachAuthorizers`) into one group per local HTTP server.
 *
 * The output order is stable across calls: groups appear in the order
 * their first route appears in the input, which mirrors the user's
 * CDK template traversal order — so the startup banner lists APIs in a
 * predictable order across reloads.
 *
 * Returns an empty array iff `routes` is empty. Callers are expected to
 * surface the "no routes discovered" error themselves; this helper does
 * not throw.
 */
export function groupRoutesByServer(routes: readonly RouteWithAuth[]): ApiServerGroup[] {
  const order: string[] = [];
  const byKey = new Map<
    string,
    {
      displayName: string;
      kind: ApiServerGroup['kind'];
      identifier: string;
      routes: RouteWithAuth[];
    }
  >();

  for (const rwa of routes) {
    const r = rwa.route;
    let serverKey: string;
    let kind: ApiServerGroup['kind'];
    let identifier: string;
    let displayName: string;

    // Stack-prefix the serverKey so two stacks with the same bare
    // logical id get **two separate** servers (defense-in-depth — the
    // upstream filter rejects bare ids in multi-stack apps, but
    // unfiltered runs (no `--api` / `<target>`) still need this to
    // disambiguate). Pre-PR the serverKey was just `<kind>:<logicalId>`
    // and cross-stack collisions silently merged into one server.
    // Routes without `apiStackName` (template w/o `aws:cdk:path` /
    // hand-rolled `cfn.Resource`) keep the un-prefixed serverKey
    // shape so the change is non-breaking for those fixtures.
    const stackPrefix = r.apiStackName ? `${r.apiStackName}:` : '';

    if (r.source === 'function-url') {
      // Function URLs have no parent API resource — each URL is its own
      // surface, scoped by its backing Lambda's logical id.
      identifier = r.lambdaLogicalId;
      serverKey = `function-url:${stackPrefix}${identifier}`;
      kind = 'function-url';
      displayName = `${identifier} (Function URL)`;
    } else if (r.source === 'http-api') {
      identifier = r.apiLogicalId ?? '<unknown>';
      serverKey = `http-api:${stackPrefix}${identifier}`;
      kind = 'http-api';
      displayName = `${identifier} (HTTP API v2)`;
    } else {
      // rest-v1
      identifier = r.apiLogicalId ?? '<unknown>';
      serverKey = `rest-v1:${stackPrefix}${identifier}`;
      kind = 'rest-v1';
      displayName = `${identifier} (REST API v1)`;
    }

    const existing = byKey.get(serverKey);
    if (existing) {
      existing.routes.push(rwa);
    } else {
      byKey.set(serverKey, { displayName, kind, identifier, routes: [rwa] });
      order.push(serverKey);
    }
  }

  return order.map((key) => {
    const entry = byKey.get(key)!;
    return {
      serverKey: key,
      displayName: entry.displayName,
      kind: entry.kind,
      identifier: entry.identifier,
      routes: entry.routes,
    };
  });
}

/**
 * Filter the route list to a single API by user-supplied identifier.
 *
 * Accepts four input forms — matches the rest of the `cdkd local *`
 * target-resolution family (`local invoke <target>` /
 * `local run-task <target>`) for consistency:
 *
 *   1. **Bare logical id** (`MyHttpApi`) — exact match on the parent
 *      API's logical id, or on the backing Lambda's logical id for
 *      Function URLs.
 *   2. **Stack-qualified logical id** (`MyStack:MyHttpApi`) — exact
 *      match on `<stackName>:<logicalId>`. Useful in multi-stack apps
 *      where the same bare logical id appears in two stacks.
 *   3. **CDK Construct path / display path** (`MyStack/MyHttpApi`) —
 *      exact match on the resource's `aws:cdk:path` metadata.
 *   4. **CDK Construct path prefix** — when the input is a strict
 *      ancestor of the resource's `aws:cdk:path` (i.e.
 *      `cdkPath.startsWith(input + '/')`). Mirrors the prefix rule
 *      `cdkd orphan` uses so an L2 wrapper path resolves to its L1
 *      child (`MyStack/MyHttpApi` matches `MyStack/MyHttpApi/Resource`).
 *
 * Routes discovered before this field set was added (or routes where
 * the synthesized template doesn't carry `aws:cdk:path` metadata —
 * e.g. hand-rolled `cfn.Resource` defs) silently fall through to the
 * bare-logical-id-only path so the change is non-breaking.
 *
 * Returns an empty array when no route matches — the caller is
 * responsible for surfacing a "no API matched" error with the list of
 * available identifiers (see {@link availableApiIdentifiers}).
 */
export function filterRoutesByApiIdentifier(
  routes: readonly RouteWithAuth[],
  identifier: string
): RouteWithAuth[] {
  return routes.filter((rwa) => routeMatchesIdentifier(rwa.route, identifier));
}

/**
 * Predicate behind {@link filterRoutesByApiIdentifier} and
 * {@link availableApiIdentifiers}'s primary-form selection. Exported
 * for test coverage only — the production code path goes through
 * `filterRoutesByApiIdentifier`.
 */
export function routeMatchesIdentifier(route: RouteWithAuth['route'], identifier: string): boolean {
  const bareId = route.source === 'function-url' ? route.lambdaLogicalId : route.apiLogicalId;
  if (bareId && bareId === identifier) return true;
  if (route.apiStackName) {
    if (bareId && identifier === `${route.apiStackName}:${bareId}`) return true;
  }
  if (route.apiCdkPath) {
    if (identifier === route.apiCdkPath) return true;
    if (route.apiCdkPath.startsWith(`${identifier}/`)) return true;
  }
  return false;
}

/**
 * Enumerate every distinct API identifier in the route list, in the
 * order they were discovered. Useful for the "available APIs" error
 * message when `--api <id>` doesn't match.
 *
 * Returns the **primary form** per API (CDK Construct path when
 * available, else bare logical id) — the "available identifiers" hint
 * stays compact while pointing users at the form most likely to round-
 * trip across rename refactors.
 */
export function availableApiIdentifiers(routes: readonly RouteWithAuth[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rwa of routes) {
    const r = rwa.route;
    const bareId =
      r.source === 'function-url' ? r.lambdaLogicalId : (r.apiLogicalId ?? '<unknown>');
    const primary = r.apiCdkPath ?? bareId;
    if (!seen.has(primary)) {
      seen.add(primary);
      out.push(primary);
    }
  }
  return out;
}
