import type { DiscoveredRoute } from './route-discovery.js';

/**
 * Match an incoming HTTP method + path against a list of discovered
 * routes (C10).
 *
 * Three tiers per AWS docs:
 *   1. **Full match** — every literal segment matches; `{name}` placeholders
 *      capture one segment each. The most-literal route wins (best-effort
 *      tie-break — see comment below; AWS does not formally specify
 *      multi-route precedence within the same tier).
 *   2. **Greedy proxy** — the route ends in `{proxy+}` and the request path
 *      starts with the literal prefix. The remainder of the path is captured
 *      as the `proxy` parameter.
 *   3. **`$default`** — the catch-all RouteKey. Picked when nothing in tiers
 *      1 / 2 matched.
 *
 * Method matching: a route with method `'ANY'` matches every HTTP method;
 * method strings are compared case-insensitively otherwise.
 *
 * Returns `null` when no route matches.
 */
export interface RouteMatchResult {
  route: DiscoveredRoute;
  pathParameters: Record<string, string>;
}

/**
 * Match a request to the first applicable route per the 3-tier precedence
 * rule. Tier order is honored across the whole list — a tier-1 match in
 * any route always wins over every tier-2 / tier-3 match.
 */
export function matchRoute(
  method: string,
  requestPath: string,
  routes: readonly DiscoveredRoute[]
): RouteMatchResult | null {
  const methodUpper = method.toUpperCase();

  // Strip any trailing slash beyond the root so `/items/` and `/items` match
  // the same route. AWS treats them identically.
  const normalizedPath = requestPath.length > 1 ? requestPath.replace(/\/+$/, '') : requestPath;

  // Pre-split request segments once.
  const requestSegments = splitPath(normalizedPath);

  // Pass 1: full match.
  let bestFull: {
    route: DiscoveredRoute;
    pathParameters: Record<string, string>;
    literalCount: number;
  } | null = null;
  for (const route of routes) {
    if (!methodMatches(route.method, methodUpper)) continue;
    if (route.pathPattern === '$default') continue;
    if (isProxyRoute(route.pathPattern)) continue;
    const result = matchFullPattern(requestSegments, route.pathPattern);
    if (!result) continue;
    if (!bestFull || result.literalCount > bestFull.literalCount) {
      bestFull = {
        route,
        pathParameters: result.pathParameters,
        literalCount: result.literalCount,
      };
    }
  }
  if (bestFull) return { route: bestFull.route, pathParameters: bestFull.pathParameters };

  // Pass 2: greedy `{proxy+}`. Among multiple matches, prefer the one with
  // the longest literal prefix.
  let bestProxy: {
    route: DiscoveredRoute;
    pathParameters: Record<string, string>;
    literalCount: number;
  } | null = null;
  for (const route of routes) {
    if (!methodMatches(route.method, methodUpper)) continue;
    if (route.pathPattern === '$default') continue;
    if (!isProxyRoute(route.pathPattern)) continue;
    const result = matchProxyPattern(requestSegments, route.pathPattern);
    if (!result) continue;
    if (!bestProxy || result.literalCount > bestProxy.literalCount) {
      bestProxy = {
        route,
        pathParameters: result.pathParameters,
        literalCount: result.literalCount,
      };
    }
  }
  if (bestProxy) return { route: bestProxy.route, pathParameters: bestProxy.pathParameters };

  // Pass 3: `$default`.
  for (const route of routes) {
    if (!methodMatches(route.method, methodUpper)) continue;
    if (route.pathPattern === '$default') return { route, pathParameters: {} };
  }

  return null;
}

/**
 * Split a path into its non-empty segments. `/items/123` → `['items', '123']`;
 * `/` → `[]`.
 */
function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

/**
 * Whether the route's HTTP method allows the incoming method. `'ANY'` is
 * the wildcard; otherwise compare case-insensitively.
 */
function methodMatches(routeMethod: string, requestMethodUpper: string): boolean {
  if (routeMethod === 'ANY') return true;
  return routeMethod.toUpperCase() === requestMethodUpper;
}

/**
 * Whether the route's path pattern ends in `{proxy+}` (the greedy
 * placeholder). AWS only accepts the greedy placeholder as the LAST
 * segment of the pattern.
 */
function isProxyRoute(pattern: string): boolean {
  return /\/\{[^/{}]+\+\}$/.test(pattern) || pattern === '/{proxy+}';
}

/**
 * Try to match a request against a non-proxy route pattern.
 *
 * Each segment of the pattern is either:
 *   - a literal — must match the request segment exactly (case-sensitive,
 *     AWS-spec-conformant);
 *   - a `{name}` placeholder — captures one request segment as
 *     `pathParameters.name`.
 *
 * Returns `null` on miss; on hit, returns the captured params plus the
 * count of literal segments (used by the caller as the tie-break heuristic
 * "more literal segments wins" within tier 1).
 */
function matchFullPattern(
  requestSegments: readonly string[],
  pattern: string
): { pathParameters: Record<string, string>; literalCount: number } | null {
  const patternSegments = splitPath(pattern);
  if (patternSegments.length !== requestSegments.length) return null;

  const pathParameters: Record<string, string> = {};
  let literalCount = 0;

  for (let i = 0; i < patternSegments.length; i++) {
    const ps = patternSegments[i]!;
    const rs = requestSegments[i]!;
    if (isPlaceholder(ps)) {
      const name = ps.slice(1, -1);
      pathParameters[name] = rs;
    } else if (ps === rs) {
      literalCount++;
    } else {
      return null;
    }
  }
  return { pathParameters, literalCount };
}

/**
 * Try to match a greedy-proxy route. The pattern's `{proxy+}` consumes
 * every remaining request segment; the literal prefix and any
 * `{name}` placeholders before it follow the same rules as
 * `matchFullPattern`.
 */
function matchProxyPattern(
  requestSegments: readonly string[],
  pattern: string
): { pathParameters: Record<string, string>; literalCount: number } | null {
  const patternSegments = splitPath(pattern);
  if (patternSegments.length === 0) return null;

  const tail = patternSegments[patternSegments.length - 1]!;
  if (!/^\{[^/{}]+\+\}$/.test(tail)) return null;
  const proxyName = tail.slice(1, -2); // strip `{` ... `+}`

  const fixedPrefixLen = patternSegments.length - 1;
  if (requestSegments.length < fixedPrefixLen) return null;

  const pathParameters: Record<string, string> = {};
  let literalCount = 0;
  for (let i = 0; i < fixedPrefixLen; i++) {
    const ps = patternSegments[i]!;
    const rs = requestSegments[i]!;
    if (isPlaceholder(ps)) {
      pathParameters[ps.slice(1, -1)] = rs;
    } else if (ps === rs) {
      literalCount++;
    } else {
      return null;
    }
  }

  pathParameters[proxyName] = requestSegments.slice(fixedPrefixLen).join('/');
  return { pathParameters, literalCount };
}

/**
 * Whether a pattern segment is a single-segment placeholder (`{name}`
 * — NOT the greedy `{name+}` form, which is handled separately).
 */
function isPlaceholder(segment: string): boolean {
  return /^\{[^/{}+]+\}$/.test(segment);
}
