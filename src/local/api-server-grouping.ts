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
   *   - `http-api:<apiLogicalId>`
   *   - `rest-v1:<apiLogicalId>`
   *   - `function-url:<lambdaLogicalId>`
   */
  readonly serverKey: string;
  /** Human-readable name surfaced in logs (e.g. "MyHttpApi (HTTP API v2)"). */
  readonly displayName: string;
  /** Discriminator on the kind of API. */
  readonly kind: 'rest-v1' | 'http-api' | 'function-url';
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

    if (r.source === 'function-url') {
      // Function URLs have no parent API resource — each URL is its own
      // surface, scoped by its backing Lambda's logical id.
      identifier = r.lambdaLogicalId;
      serverKey = `function-url:${identifier}`;
      kind = 'function-url';
      displayName = `${identifier} (Function URL)`;
    } else if (r.source === 'http-api') {
      identifier = r.apiLogicalId ?? '<unknown>';
      serverKey = `http-api:${identifier}`;
      kind = 'http-api';
      displayName = `${identifier} (HTTP API v2)`;
    } else {
      // rest-v1
      identifier = r.apiLogicalId ?? '<unknown>';
      serverKey = `rest-v1:${identifier}`;
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
 * Matches against both the parent API logical id (HTTP API / REST v1)
 * AND the Function URL's backing-Lambda logical id, so users can pass
 * any of:
 *
 *   - The HTTP API logical id (e.g. `MyHttpApi`)
 *   - The REST API logical id (e.g. `MyRestApi`)
 *   - The Lambda logical id backing a Function URL (e.g. `GoHandler`)
 *
 * Returns an empty array when no route matches — the caller is
 * responsible for surfacing a "no API matched" error with the list of
 * available identifiers (see {@link availableApiIdentifiers}).
 */
export function filterRoutesByApiIdentifier(
  routes: readonly RouteWithAuth[],
  identifier: string
): RouteWithAuth[] {
  return routes.filter((rwa) => {
    const r = rwa.route;
    if (r.source === 'function-url') {
      return r.lambdaLogicalId === identifier;
    }
    return r.apiLogicalId === identifier;
  });
}

/**
 * Enumerate every distinct API identifier in the route list, in the
 * order they were discovered. Useful for the "available APIs" error
 * message when `--api <id>` doesn't match.
 */
export function availableApiIdentifiers(routes: readonly RouteWithAuth[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rwa of routes) {
    const r = rwa.route;
    const id = r.source === 'function-url' ? r.lambdaLogicalId : (r.apiLogicalId ?? '<unknown>');
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
