import { describe, expect, it } from 'vitest';
import {
  buildHttpApiV2Event,
  buildRestV1Event,
  type HttpRequestSnapshot,
  type MatchedRouteContext,
} from '../../../src/local/api-gateway-event.js';
import type { DiscoveredRoute } from '../../../src/local/route-discovery.js';

function makeRoute(
  apiVersion: 'v1' | 'v2',
  pathPattern: string,
  method = 'GET'
): DiscoveredRoute {
  return {
    method,
    pathPattern,
    lambdaLogicalId: 'Fn',
    source: apiVersion === 'v1' ? 'rest-v1' : 'http-api',
    apiVersion,
    stage: apiVersion === 'v1' ? 'prod' : '$default',
    declaredAt: 'Test',
  };
}

const FIXED_NOW = new Date('2026-05-10T12:00:00.000Z');
const fixedNow = (): Date => FIXED_NOW;

describe('buildHttpApiV2Event — shape', () => {
  it('produces the canonical v2 shape with all required fields', () => {
    const req: HttpRequestSnapshot = {
      method: 'GET',
      rawUrl: '/items/123?foo=bar',
      headers: {
        'Content-Type': ['application/json'],
        'User-Agent': ['curl/8.0.0'],
      },
      body: Buffer.from('{"x":1}', 'utf-8'),
      sourceIp: '10.0.0.1',
    };
    const ctx: MatchedRouteContext = {
      route: makeRoute('v2', '/items/{id}'),
      pathParameters: { id: '123' },
      matchedPath: '/items/123',
    };
    const event = buildHttpApiV2Event(req, ctx, { now: fixedNow });
    expect(event['version']).toBe('2.0');
    expect(event['routeKey']).toBe('GET /items/{id}');
    expect(event['rawPath']).toBe('/items/123');
    expect(event['rawQueryString']).toBe('foo=bar');
    expect(event['cookies']).toEqual([]);
    expect(event['stageVariables']).toBeNull();
    expect(event['isBase64Encoded']).toBe(false);
    expect(event['body']).toBe('{"x":1}');
    const rc = event['requestContext'] as Record<string, unknown>;
    expect(rc['accountId']).toBe('123456789012');
    expect(rc['apiId']).toBe('local');
    expect(rc['domainPrefix']).toBe('local');
    expect(rc['authentication']).toBeNull();
    expect(rc['authorizer']).toBeNull();
    expect((rc['http'] as Record<string, unknown>)['protocol']).toBe('HTTP/1.1');
    expect((rc['http'] as Record<string, unknown>)['userAgent']).toBe('curl/8.0.0');
    expect((rc['http'] as Record<string, unknown>)['sourceIp']).toBe('10.0.0.1');
    expect(rc['stage']).toBe('$default');
  });

  it('lowercases header names and joins duplicates with commas (C14)', () => {
    const req: HttpRequestSnapshot = {
      method: 'GET',
      rawUrl: '/x',
      headers: { 'X-Foo': ['a', 'b', 'c'] },
      body: Buffer.alloc(0),
    };
    const ctx: MatchedRouteContext = {
      route: makeRoute('v2', '/x'),
      pathParameters: {},
      matchedPath: '/x',
    };
    const event = buildHttpApiV2Event(req, ctx);
    expect((event['headers'] as Record<string, string>)['x-foo']).toBe('a,b,c');
  });

  it('splits the cookie header into the cookies array (C5)', () => {
    const req: HttpRequestSnapshot = {
      method: 'GET',
      rawUrl: '/x',
      headers: { Cookie: ['session=abc; theme=dark'] },
      body: Buffer.alloc(0),
    };
    const ctx: MatchedRouteContext = {
      route: makeRoute('v2', '/x'),
      pathParameters: {},
      matchedPath: '/x',
    };
    const event = buildHttpApiV2Event(req, ctx);
    expect(event['cookies']).toEqual(['session=abc', 'theme=dark']);
    expect((event['headers'] as Record<string, string>)['cookie']).toBeUndefined();
  });

  it('decodes pathParameters values (C11)', () => {
    const req: HttpRequestSnapshot = {
      method: 'GET',
      rawUrl: '/items/hello%20world',
      headers: {},
      body: Buffer.alloc(0),
    };
    const ctx: MatchedRouteContext = {
      route: makeRoute('v2', '/items/{id}'),
      pathParameters: { id: 'hello%20world' },
      matchedPath: '/items/hello%20world',
    };
    const event = buildHttpApiV2Event(req, ctx);
    expect((event['pathParameters'] as Record<string, string>)['id']).toBe('hello world');
    // rawPath stays NOT decoded:
    expect(event['rawPath']).toBe('/items/hello%20world');
  });

  it('leaves rawQueryString undecoded but decodes queryStringParameters values', () => {
    const req: HttpRequestSnapshot = {
      method: 'GET',
      rawUrl: '/?key=hello%20world&key=baz',
      headers: {},
      body: Buffer.alloc(0),
    };
    const ctx: MatchedRouteContext = {
      route: makeRoute('v2', '/'),
      pathParameters: {},
      matchedPath: '/',
    };
    const event = buildHttpApiV2Event(req, ctx);
    expect(event['rawQueryString']).toBe('key=hello%20world&key=baz');
    expect((event['queryStringParameters'] as Record<string, string>)['key']).toBe(
      'hello world,baz'
    );
  });

  it('base64-encodes a binary body when content-type is binary', () => {
    const body = Buffer.from([0xff, 0xd8, 0xff]); // jpeg magic
    const req: HttpRequestSnapshot = {
      method: 'POST',
      rawUrl: '/upload',
      headers: { 'Content-Type': ['image/jpeg'] },
      body,
    };
    const ctx: MatchedRouteContext = {
      route: makeRoute('v2', '/upload', 'POST'),
      pathParameters: {},
      matchedPath: '/upload',
    };
    const event = buildHttpApiV2Event(req, ctx);
    expect(event['isBase64Encoded']).toBe(true);
    expect(event['body']).toBe(body.toString('base64'));
  });

  it("requestContext.routeKey is '$default' when the matched route is $default", () => {
    const route: DiscoveredRoute = makeRoute('v2', '$default', 'ANY');
    const req: HttpRequestSnapshot = { method: 'GET', rawUrl: '/x', headers: {}, body: Buffer.alloc(0) };
    const ctx: MatchedRouteContext = { route, pathParameters: {}, matchedPath: '/x' };
    const event = buildHttpApiV2Event(req, ctx);
    expect(event['routeKey']).toBe('$default');
    expect((event['requestContext'] as Record<string, unknown>)['routeKey']).toBe('$default');
  });
});

describe('buildRestV1Event — shape', () => {
  it('produces the v1 shape with multiValueHeaders + identity', () => {
    const req: HttpRequestSnapshot = {
      method: 'POST',
      rawUrl: '/items?key=a&key=b',
      headers: {
        'Content-Type': ['application/json'],
        'X-Custom': ['v1', 'v2'],
      },
      body: Buffer.from('{"y":2}'),
      sourceIp: '127.0.0.1',
    };
    const ctx: MatchedRouteContext = {
      route: makeRoute('v1', '/items', 'POST'),
      pathParameters: {},
      matchedPath: '/items',
    };
    const event = buildRestV1Event(req, ctx, { now: fixedNow });
    expect(event['httpMethod']).toBe('POST');
    expect(event['resource']).toBe('/items');
    expect(event['path']).toBe('/items');
    const headers = event['headers'] as Record<string, string>;
    const mvh = event['multiValueHeaders'] as Record<string, string[]>;
    expect(headers['x-custom']).toBe('v2');
    expect(mvh['x-custom']).toEqual(['v1', 'v2']);
    const rc = event['requestContext'] as Record<string, unknown>;
    expect((rc['identity'] as Record<string, unknown>)['sourceIp']).toBe('127.0.0.1');
    expect(rc['stage']).toBe('prod');
    expect(rc['path']).toBe('/prod/items');
    expect(rc['authorizer']).toBeNull();
  });

  it('queryStringParameters: null when none, multiValueQueryStringParameters: null when none', () => {
    const req: HttpRequestSnapshot = { method: 'GET', rawUrl: '/x', headers: {}, body: Buffer.alloc(0) };
    const ctx: MatchedRouteContext = {
      route: makeRoute('v1', '/x'),
      pathParameters: {},
      matchedPath: '/x',
    };
    const event = buildRestV1Event(req, ctx);
    expect(event['queryStringParameters']).toBeNull();
    expect(event['multiValueQueryStringParameters']).toBeNull();
    expect(event['pathParameters']).toBeNull();
    expect(event['body']).toBeNull();
  });
});
