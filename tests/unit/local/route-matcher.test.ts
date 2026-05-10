import { describe, expect, it } from 'vitest';
import { matchRoute } from '../../../src/local/route-matcher.js';
import type { DiscoveredRoute } from '../../../src/local/route-discovery.js';

function r(method: string, pathPattern: string, lambdaLogicalId = 'Fn'): DiscoveredRoute {
  return {
    method,
    pathPattern,
    lambdaLogicalId,
    source: 'http-api',
    apiVersion: 'v2',
    stage: '$default',
    declaredAt: `Test/${method}-${pathPattern}`,
  };
}

describe('matchRoute — full match', () => {
  it('matches a literal path', () => {
    const result = matchRoute('GET', '/items', [r('GET', '/items')]);
    expect(result?.route.pathPattern).toBe('/items');
    expect(result?.pathParameters).toEqual({});
  });

  it('extracts {name} placeholders', () => {
    const result = matchRoute('GET', '/items/42', [r('GET', '/items/{id}')]);
    expect(result?.route.pathPattern).toBe('/items/{id}');
    expect(result?.pathParameters).toEqual({ id: '42' });
  });

  it('rejects mismatched segment count', () => {
    expect(matchRoute('GET', '/items/1/2', [r('GET', '/items/{id}')])).toBeNull();
  });

  it('rejects mismatched literal segment', () => {
    expect(matchRoute('GET', '/widgets/1', [r('GET', '/items/{id}')])).toBeNull();
  });

  it('routes ANY-method routes to every HTTP method', () => {
    const result = matchRoute('PATCH', '/items', [r('ANY', '/items')]);
    expect(result?.route.pathPattern).toBe('/items');
  });

  it('case-insensitive method comparison', () => {
    expect(matchRoute('get', '/items', [r('GET', '/items')])).not.toBeNull();
  });

  it('treats trailing slash as equivalent', () => {
    expect(matchRoute('GET', '/items/', [r('GET', '/items')])).not.toBeNull();
  });
});

describe('matchRoute — precedence (3-tier)', () => {
  it('full match beats greedy proxy', () => {
    const routes = [r('GET', '/items/{proxy+}', 'Proxy'), r('GET', '/items/42', 'Specific')];
    const result = matchRoute('GET', '/items/42', routes);
    expect(result?.route.lambdaLogicalId).toBe('Specific');
  });

  it('greedy proxy beats $default', () => {
    const routes = [r('ANY', '$default', 'Default'), r('ANY', '/api/{proxy+}', 'Proxy')];
    const result = matchRoute('GET', '/api/foo/bar', routes);
    expect(result?.route.lambdaLogicalId).toBe('Proxy');
    expect(result?.pathParameters).toEqual({ proxy: 'foo/bar' });
  });

  it('falls through to $default', () => {
    const routes = [r('GET', '/items', 'A'), r('ANY', '$default', 'Default')];
    const result = matchRoute('GET', '/anything', routes);
    expect(result?.route.lambdaLogicalId).toBe('Default');
  });

  it('returns null when nothing matches', () => {
    expect(matchRoute('GET', '/nothing', [r('GET', '/items')])).toBeNull();
  });
});

describe('matchRoute — literal-segment tie-break', () => {
  it('within tier 1, more literal segments wins', () => {
    const routes = [
      r('GET', '/{a}/{b}', 'AllPlaceholders'),
      r('GET', '/items/{b}', 'OneLiteral'),
    ];
    const result = matchRoute('GET', '/items/42', routes);
    expect(result?.route.lambdaLogicalId).toBe('OneLiteral');
  });
});

describe('matchRoute — greedy proxy', () => {
  it('captures every remaining segment as `proxy`', () => {
    const result = matchRoute('GET', '/api/v1/foo/bar', [r('GET', '/api/{proxy+}')]);
    expect(result?.pathParameters).toEqual({ proxy: 'v1/foo/bar' });
  });

  it('matches root /{proxy+}', () => {
    const result = matchRoute('GET', '/anything/here', [r('ANY', '/{proxy+}')]);
    expect(result?.pathParameters).toEqual({ proxy: 'anything/here' });
  });

  it('within tier 2, longest literal prefix wins', () => {
    const routes = [r('ANY', '/{proxy+}', 'Root'), r('ANY', '/api/{proxy+}', 'Api')];
    const result = matchRoute('GET', '/api/v1', routes);
    expect(result?.route.lambdaLogicalId).toBe('Api');
  });
});
