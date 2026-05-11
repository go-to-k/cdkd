import { describe, expect, it } from 'vitest';
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
});

describe('filterRoutesByApiIdentifier', () => {
  const routes = [
    makeRoute({ source: 'http-api', apiLogicalId: 'PublicApi', pathPattern: '/p' }),
    makeRoute({ source: 'http-api', apiLogicalId: 'AdminApi', pathPattern: '/a' }),
    makeRoute({ source: 'function-url', lambdaLogicalId: 'GoHandler', apiLogicalId: undefined }),
  ];

  it('matches HTTP API by apiLogicalId', () => {
    const result = filterRoutesByApiIdentifier(routes, 'PublicApi');
    expect(result).toHaveLength(1);
    expect(result[0]!.route.apiLogicalId).toBe('PublicApi');
  });

  it('matches Function URLs by backing Lambda logical id', () => {
    const result = filterRoutesByApiIdentifier(routes, 'GoHandler');
    expect(result).toHaveLength(1);
    expect(result[0]!.route.source).toBe('function-url');
  });

  it('returns an empty array on no match (caller surfaces error)', () => {
    expect(filterRoutesByApiIdentifier(routes, 'Nope')).toEqual([]);
  });
});

describe('availableApiIdentifiers', () => {
  it('returns distinct identifiers in first-seen order', () => {
    const routes = [
      makeRoute({ source: 'http-api', apiLogicalId: 'PublicApi' }),
      makeRoute({ source: 'http-api', apiLogicalId: 'PublicApi' }),
      makeRoute({ source: 'http-api', apiLogicalId: 'AdminApi' }),
      makeRoute({ source: 'function-url', lambdaLogicalId: 'GoHandler' }),
    ];
    expect(availableApiIdentifiers(routes)).toEqual(['PublicApi', 'AdminApi', 'GoHandler']);
  });
});
