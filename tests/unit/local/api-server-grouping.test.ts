import { describe, expect, it } from 'vite-plus/test';
import type { RouteWithAuth } from '../../../src/local/authorizer-resolver.js';
import type { DiscoveredRoute } from '../../../src/local/route-discovery.js';
import {
  availableApiIdentifiers,
  filterRoutesByApiIdentifier,
  groupRoutesByServer,
} from '../../../src/local/api-server-grouping.js';

function makeRoute(partial: Partial<DiscoveredRoute>): RouteWithAuth {
  const route: DiscoveredRoute = {
    method: partial.method ?? 'GET',
    pathPattern: partial.pathPattern ?? '/',
    lambdaLogicalId: partial.lambdaLogicalId ?? 'Handler',
    source: partial.source ?? 'http-api',
    apiVersion: partial.apiVersion ?? 'v2',
    stage: partial.stage ?? '$default',
    declaredAt: partial.declaredAt ?? 'Stack/Method',
    ...(partial.apiLogicalId !== undefined && { apiLogicalId: partial.apiLogicalId }),
    ...(partial.apiStackName !== undefined && { apiStackName: partial.apiStackName }),
    ...(partial.apiCdkPath !== undefined && { apiCdkPath: partial.apiCdkPath }),
  };
  return { route, authorizer: undefined };
}

describe('groupRoutesByServer', () => {
  it('returns one group per HTTP API logical id, preserving first-seen order', () => {
    const routes = [
      makeRoute({ source: 'http-api', apiLogicalId: 'PublicApi', pathPattern: '/public' }),
      makeRoute({ source: 'http-api', apiLogicalId: 'AdminApi', pathPattern: '/admin' }),
      makeRoute({ source: 'http-api', apiLogicalId: 'PublicApi', pathPattern: '/public/v2' }),
    ];
    const groups = groupRoutesByServer(routes);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.serverKey).toBe('http-api:PublicApi');
    expect(groups[0]!.kind).toBe('http-api');
    expect(groups[0]!.identifier).toBe('PublicApi');
    expect(groups[0]!.displayName).toBe('PublicApi (HTTP API v2)');
    expect(groups[0]!.routes).toHaveLength(2);
    expect(groups[1]!.serverKey).toBe('http-api:AdminApi');
    expect(groups[1]!.routes).toHaveLength(1);
  });

  it('groups REST v1 separately from HTTP API even with the same logical id', () => {
    // Defense-in-depth: a CDK app could in theory name a RestApi and an
    // ApiGwV2 Api with the same identifier. Group by (kind, identifier),
    // not identifier alone.
    const routes = [
      makeRoute({ source: 'rest-v1', apiLogicalId: 'MyApi', apiVersion: 'v1' }),
      makeRoute({ source: 'http-api', apiLogicalId: 'MyApi', apiVersion: 'v2' }),
    ];
    const groups = groupRoutesByServer(routes);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.kind).sort()).toEqual(['http-api', 'rest-v1']);
    expect(groups.find((g) => g.kind === 'rest-v1')!.displayName).toBe('MyApi (REST API v1)');
    expect(groups.find((g) => g.kind === 'http-api')!.displayName).toBe('MyApi (HTTP API v2)');
  });

  it('keys Function URLs by backing Lambda logical id (no parent API)', () => {
    const routes = [
      makeRoute({ source: 'function-url', lambdaLogicalId: 'GoHandler', apiLogicalId: undefined }),
      makeRoute({ source: 'function-url', lambdaLogicalId: 'NodeHandler', apiLogicalId: undefined }),
    ];
    const groups = groupRoutesByServer(routes);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.serverKey).toBe('function-url:GoHandler');
    expect(groups[0]!.displayName).toBe('GoHandler (Function URL)');
    expect(groups[0]!.kind).toBe('function-url');
    expect(groups[0]!.identifier).toBe('GoHandler');
    expect(groups[1]!.serverKey).toBe('function-url:NodeHandler');
  });

  it('returns an empty array for empty input', () => {
    expect(groupRoutesByServer([])).toEqual([]);
  });

  it('handles a mix of HTTP API, REST v1, and Function URL in one shot', () => {
    const routes = [
      makeRoute({ source: 'http-api', apiLogicalId: 'PublicApi' }),
      makeRoute({ source: 'rest-v1', apiLogicalId: 'LegacyApi', apiVersion: 'v1' }),
      makeRoute({ source: 'function-url', lambdaLogicalId: 'GoHandler' }),
      makeRoute({ source: 'http-api', apiLogicalId: 'PublicApi' }),
    ];
    const groups = groupRoutesByServer(routes);
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.serverKey)).toEqual([
      'http-api:PublicApi',
      'rest-v1:LegacyApi',
      'function-url:GoHandler',
    ]);
    const publicGroup = groups.find((g) => g.identifier === 'PublicApi')!;
    expect(publicGroup.routes).toHaveLength(2);
  });

  it('stack-prefixes serverKey so same-logical-id APIs across stacks get separate servers', () => {
    // Cross-stack same-logical-id case: `MyHttpApi` in both `WebStack`
    // and `AdminStack`. Pre-fix the serverKey was `http-api:MyHttpApi`
    // for both, silently merging routes from two different APIs into
    // one server. Post-fix the serverKey includes `apiStackName`, so
    // the two surfaces get two separate servers on different ports.
    const routes = [
      makeRoute({
        source: 'http-api',
        apiLogicalId: 'MyHttpApi',
        apiStackName: 'WebStack',
        pathPattern: '/web',
      }),
      makeRoute({
        source: 'http-api',
        apiLogicalId: 'MyHttpApi',
        apiStackName: 'AdminStack',
        pathPattern: '/admin',
      }),
    ];
    const groups = groupRoutesByServer(routes);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.serverKey).toBe('http-api:WebStack:MyHttpApi');
    expect(groups[1]!.serverKey).toBe('http-api:AdminStack:MyHttpApi');
    // Routes must NOT cross-pollinate between the two servers.
    expect(groups[0]!.routes).toHaveLength(1);
    expect(groups[0]!.routes[0]!.route.pathPattern).toBe('/web');
    expect(groups[1]!.routes).toHaveLength(1);
    expect(groups[1]!.routes[0]!.route.pathPattern).toBe('/admin');
  });

  it('falls back to un-prefixed serverKey when apiStackName is absent (backward compat)', () => {
    // Templates without `aws:cdk:path` Metadata (or hand-rolled
    // `cfn.Resource` defs) produce routes with `apiStackName: undefined`.
    // The serverKey stays in the pre-fix shape so existing fixtures /
    // synthesized templates without the metadata still group cleanly.
    const routes = [
      makeRoute({ source: 'http-api', apiLogicalId: 'BareApi' }),
      makeRoute({ source: 'rest-v1', apiLogicalId: 'BareRest', apiVersion: 'v1' }),
      makeRoute({ source: 'function-url', lambdaLogicalId: 'BareHandler' }),
    ];
    const groups = groupRoutesByServer(routes);
    expect(groups.map((g) => g.serverKey)).toEqual([
      'http-api:BareApi',
      'rest-v1:BareRest',
      'function-url:BareHandler',
    ]);
  });
});

describe('filterRoutesByApiIdentifier', () => {
  const routes = [
    makeRoute({
      source: 'http-api',
      apiLogicalId: 'PublicApi',
      apiStackName: 'WebStack',
      apiCdkPath: 'WebStack/PublicApi/Resource',
      pathPattern: '/p',
    }),
    makeRoute({
      source: 'http-api',
      apiLogicalId: 'AdminApi',
      apiStackName: 'AdminStack',
      apiCdkPath: 'AdminStack/AdminApi/Resource',
      pathPattern: '/a',
    }),
    makeRoute({
      source: 'function-url',
      lambdaLogicalId: 'GoHandler',
      apiLogicalId: undefined,
      apiStackName: 'BackendStack',
      apiCdkPath: 'BackendStack/GoHandler',
    }),
  ];

  it('matches HTTP API by bare logical id (form 1)', () => {
    const result = filterRoutesByApiIdentifier(routes, 'PublicApi');
    expect(result).toHaveLength(1);
    expect(result[0]!.route.apiLogicalId).toBe('PublicApi');
  });

  it('matches Function URLs by backing Lambda logical id (form 1)', () => {
    const result = filterRoutesByApiIdentifier(routes, 'GoHandler');
    expect(result).toHaveLength(1);
    expect(result[0]!.route.source).toBe('function-url');
  });

  it('matches HTTP API by stack-qualified logical id (form 2)', () => {
    const result = filterRoutesByApiIdentifier(routes, 'WebStack:PublicApi');
    expect(result).toHaveLength(1);
    expect(result[0]!.route.apiLogicalId).toBe('PublicApi');
  });

  it('matches Function URL by stack-qualified Lambda logical id (form 2)', () => {
    const result = filterRoutesByApiIdentifier(routes, 'BackendStack:GoHandler');
    expect(result).toHaveLength(1);
    expect(result[0]!.route.source).toBe('function-url');
  });

  it('matches HTTP API by exact CDK Construct path (form 3)', () => {
    const result = filterRoutesByApiIdentifier(routes, 'WebStack/PublicApi/Resource');
    expect(result).toHaveLength(1);
    expect(result[0]!.route.apiLogicalId).toBe('PublicApi');
  });

  it('matches Function URL by exact CDK Construct path (form 3)', () => {
    const result = filterRoutesByApiIdentifier(routes, 'BackendStack/GoHandler');
    expect(result).toHaveLength(1);
    expect(result[0]!.route.source).toBe('function-url');
  });

  it('matches HTTP API by L2 Construct-path prefix → synthesized L1 child (form 4)', () => {
    // CDK's `new apigatewayv2.HttpApi(stack, 'PublicApi')` emits L1 child
    // at `WebStack/PublicApi/Resource`; users would type the L2 path
    // `WebStack/PublicApi` and expect prefix-rule resolution — same UX
    // as `cdkd orphan`.
    const result = filterRoutesByApiIdentifier(routes, 'WebStack/PublicApi');
    expect(result).toHaveLength(1);
    expect(result[0]!.route.apiLogicalId).toBe('PublicApi');
  });

  it('does NOT prefix-match on partial path component (boundary check)', () => {
    // `WebStack/Public` is a partial component of `WebStack/PublicApi/...`,
    // NOT an ancestor cdk path — must not match. The trailing-`/` rule
    // protects against this.
    expect(filterRoutesByApiIdentifier(routes, 'WebStack/Public')).toEqual([]);
  });

  it('returns an empty array on no match (caller surfaces error)', () => {
    expect(filterRoutesByApiIdentifier(routes, 'Nope')).toEqual([]);
  });

  it('falls back to bare-logical-id-only when apiCdkPath/apiStackName are missing', () => {
    // Backward compat: routes discovered from a synthesized template
    // without `aws:cdk:path` metadata (e.g. hand-rolled `cfn.Resource`)
    // keep the pre-PR behavior — bare logical id matches, but the new
    // forms don't.
    const sparse = [
      makeRoute({ source: 'http-api', apiLogicalId: 'BareApi', pathPattern: '/b' }),
    ];
    expect(filterRoutesByApiIdentifier(sparse, 'BareApi')).toHaveLength(1);
    expect(filterRoutesByApiIdentifier(sparse, 'Stack:BareApi')).toEqual([]);
    expect(filterRoutesByApiIdentifier(sparse, 'Stack/BareApi')).toEqual([]);
  });
});

describe('availableApiIdentifiers', () => {
  it('returns CDK Construct path when present (preferred primary form)', () => {
    const routes = [
      makeRoute({
        source: 'http-api',
        apiLogicalId: 'PublicApi',
        apiCdkPath: 'WebStack/PublicApi/Resource',
      }),
      makeRoute({
        source: 'http-api',
        apiLogicalId: 'PublicApi',
        apiCdkPath: 'WebStack/PublicApi/Resource',
      }),
      makeRoute({
        source: 'http-api',
        apiLogicalId: 'AdminApi',
        apiCdkPath: 'AdminStack/AdminApi/Resource',
      }),
      makeRoute({
        source: 'function-url',
        lambdaLogicalId: 'GoHandler',
        apiCdkPath: 'BackendStack/GoHandler',
      }),
    ];
    expect(availableApiIdentifiers(routes)).toEqual([
      'WebStack/PublicApi/Resource',
      'AdminStack/AdminApi/Resource',
      'BackendStack/GoHandler',
    ]);
  });

  it('falls back to bare logical id when apiCdkPath is missing', () => {
    const routes = [
      makeRoute({ source: 'http-api', apiLogicalId: 'PublicApi' }),
      makeRoute({ source: 'http-api', apiLogicalId: 'AdminApi' }),
      makeRoute({ source: 'function-url', lambdaLogicalId: 'GoHandler' }),
    ];
    expect(availableApiIdentifiers(routes)).toEqual(['PublicApi', 'AdminApi', 'GoHandler']);
  });
});
