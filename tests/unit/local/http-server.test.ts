import { createHash, createHmac } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  buildAuthorizerContextForServiceIntegration,
  parseQueryStringSingular,
  startApiServer,
  writeAuthRejection,
} from '../../../src/local/http-server.js';
import type { AuthorizerInfo, RouteWithAuth } from '../../../src/local/authorizer-resolver.js';
import type { CachedAuthorizerResult } from '../../../src/local/authorizer-cache.js';
import type { ContainerPool } from '../../../src/local/container-pool.js';
import { createAuthorizerCache } from '../../../src/local/authorizer-cache.js';
import { createJwksCache } from '../../../src/local/cognito-jwt.js';
import {
  canonicalizePath,
  canonicalizeQueryString,
  type CredentialsLoader,
  type ResolvedCredentials,
} from '../../../src/local/sigv4-verify.js';

vi.mock('../../../src/local/rie-client.js', () => ({
  invokeRie: vi.fn(),
  invokeRieStreaming: vi.fn(),
}));
import * as rieClient from '../../../src/local/rie-client.js';
const invokeRieMock = rieClient.invokeRie as unknown as ReturnType<typeof vi.fn>;
const invokeRieStreamingMock = rieClient.invokeRieStreaming as unknown as ReturnType<typeof vi.fn>;

/**
 * Construct a minimal `ServerResponse` stand-in that records `statusCode`
 * and the final body. We don't need a real `node:http` socket for the
 * `writeAuthRejection` unit tests.
 */
function makeResponse(): ServerResponse & {
  capturedBody: string;
  capturedHeaders: Map<string, string>;
} {
  const headers = new Map<string, string>();
  let body = '';
  const stub = {
    statusCode: 0,
    setHeader(name: string, value: string | string[]) {
      headers.set(String(name).toLowerCase(), Array.isArray(value) ? value.join(',') : String(value));
    },
    end(payload?: string | Buffer) {
      body = payload ? payload.toString() : '';
    },
    get capturedBody() {
      return body;
    },
    get capturedHeaders() {
      return headers;
    },
  } as unknown as ServerResponse & { capturedBody: string; capturedHeaders: Map<string, string> };
  return stub;
}

describe('writeAuthRejection', () => {
  it('REST v1 + missing-identity → 401 Unauthorized', () => {
    const res = makeResponse();
    writeAuthRejection(res, 'v1', 'missing-identity');
    expect(res.statusCode).toBe(401);
    expect(res.capturedBody).toBe('{"message":"Unauthorized"}');
  });

  it('REST v1 + policy-deny → 403 Forbidden', () => {
    const res = makeResponse();
    writeAuthRejection(res, 'v1', 'policy-deny');
    expect(res.statusCode).toBe(403);
    expect(res.capturedBody).toBe('{"message":"Forbidden"}');
  });

  it('HTTP v2 + missing-identity → 401 Unauthorized', () => {
    const res = makeResponse();
    writeAuthRejection(res, 'v2', 'missing-identity');
    expect(res.statusCode).toBe(401);
    expect(res.capturedBody).toBe('{"message":"Unauthorized"}');
  });

  it('HTTP v2 + policy-deny → 401 Unauthorized', () => {
    const res = makeResponse();
    writeAuthRejection(res, 'v2', 'policy-deny');
    expect(res.statusCode).toBe(401);
    expect(res.capturedBody).toBe('{"message":"Unauthorized"}');
  });

  it('Function URL (v2 + IAM) + missing-identity → 403 Forbidden (#621)', () => {
    // Function URL with AWS_IAM is v2-shaped but the AWS-deployed response
    // is 403 (the SigV4 layer rejects), not API Gateway v2's default 401.
    const res = makeResponse();
    writeAuthRejection(res, 'v2', 'missing-identity', 'iam');
    expect(res.statusCode).toBe(403);
    expect(res.capturedBody).toBe('{"Message":"Forbidden"}');
  });

  it('Function URL (v2 + IAM) + policy-deny → 403 Forbidden (#621)', () => {
    const res = makeResponse();
    writeAuthRejection(res, 'v2', 'policy-deny', 'iam');
    expect(res.statusCode).toBe(403);
    expect(res.capturedBody).toBe('{"Message":"Forbidden"}');
  });
});

/**
 * End-to-end tests for the per-request authorizer pass via `startApiServer`.
 * We boot a real `node:http` server on an ephemeral port and curl-equivalent
 * `fetch()` it; the route handler + authorizer are mocked via `invokeRie`.
 */
function makePool(): ContainerPool {
  const acquire = vi.fn(async () => ({
    containerId: 'c1',
    containerHost: '127.0.0.1',
    hostPort: 1234,
    logicalId: 'X',
    release: vi.fn(),
  }));
  const release = vi.fn();
  return {
    acquire,
    release,
    dispose: vi.fn(async () => undefined),
  } as unknown as ContainerPool;
}

function makeRequestRoute(opts: {
  authorizerLogicalId: string;
  resultTtlSeconds?: number;
}): RouteWithAuth {
  return {
    route: {
      method: 'GET',
      pathPattern: '/items/{id}',
      lambdaLogicalId: 'HandlerFn',
      source: 'rest-v1',
      apiVersion: 'v1',
      stage: 'prod',
      declaredAt: 'S/Method-X',
    },
    authorizer: {
      kind: 'lambda-request',
      logicalId: opts.authorizerLogicalId,
      lambdaLogicalId: 'AuthFn',
      identitySources: [{ kind: 'header', name: 'authorization' }],
      resultTtlSeconds: opts.resultTtlSeconds ?? 300,
      apiVersion: 'v1',
      declaredAt: 'S/Method-X',
    },
  };
}

describe('startApiServer — REQUEST authorizer cache (must-fix #1)', () => {
  beforeEach(() => {
    invokeRieMock.mockReset();
  });

  it('caches REQUEST authorizer verdicts: 2 same-identity requests invoke the Lambda exactly once', async () => {
    const route = makeRequestRoute({ authorizerLogicalId: 'Auth' });
    // The authorizer Lambda is invoked first per request (when cache
    // misses); the route handler is invoked after Allow.
    invokeRieMock.mockImplementation(async (host, port, event) => {
      // The route handler request has no `type: 'REQUEST'`; the
      // authorizer event does. Branch on that.
      const isAuthorizer = (event as { type?: string }).type === 'REQUEST';
      if (isAuthorizer) {
        return {
          raw: '',
          payload: {
            principalId: 'u',
            policyDocument: {
              Statement: [
                {
                  Effect: 'Allow',
                  Resource: 'arn:aws:execute-api:local:123456789012:local/prod/GET/items/*',
                },
              ],
            },
            context: { tier: 'pro' },
          },
        };
      }
      return {
        raw: '',
        payload: { statusCode: 200, body: 'ok' },
      };
    });

    const cache = createAuthorizerCache();
    const server = await startApiServer({
      state: { routes: [route], pool: makePool(), corsConfigByApiId: new Map() },
      rieTimeoutMs: 1000,
      host: '127.0.0.1',
      port: 0,
      authorizerCache: cache,
    });

    try {
      // Two requests with the same identity → authorizer Lambda invoked
      // exactly once (cache reuses verdict for the second).
      const url = `http://${server.host}:${server.port}/items/42`;
      const r1 = await fetch(url, { headers: { authorization: 'Bearer xyz' } });
      expect(r1.status).toBe(200);
      const r2 = await fetch(url, { headers: { authorization: 'Bearer xyz' } });
      expect(r2.status).toBe(200);

      const authorizerInvocations = invokeRieMock.mock.calls.filter(
        (c) => (c[2] as { type?: string }).type === 'REQUEST'
      );
      expect(authorizerInvocations).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('cache key is per-identity: different headers → 2 authorizer invocations', async () => {
    const route = makeRequestRoute({ authorizerLogicalId: 'Auth' });
    invokeRieMock.mockImplementation(async (_h, _p, event) => {
      const isAuthorizer = (event as { type?: string }).type === 'REQUEST';
      if (isAuthorizer) {
        return {
          raw: '',
          payload: {
            principalId: 'u',
            policyDocument: {
              Statement: [
                {
                  Effect: 'Allow',
                  Resource: 'arn:aws:execute-api:local:123456789012:local/prod/GET/items/*',
                },
              ],
            },
          },
        };
      }
      return { raw: '', payload: { statusCode: 200, body: 'ok' } };
    });

    const cache = createAuthorizerCache();
    const server = await startApiServer({
      state: { routes: [route], pool: makePool(), corsConfigByApiId: new Map() },
      rieTimeoutMs: 1000,
      host: '127.0.0.1',
      port: 0,
      authorizerCache: cache,
    });

    try {
      const url = `http://${server.host}:${server.port}/items/42`;
      await fetch(url, { headers: { authorization: 'Bearer A' } });
      await fetch(url, { headers: { authorization: 'Bearer B' } });
      const authorizerInvocations = invokeRieMock.mock.calls.filter(
        (c) => (c[2] as { type?: string }).type === 'REQUEST'
      );
      expect(authorizerInvocations).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it('cache disabled when ttl=0 (HTTP v2 default)', async () => {
    const route: RouteWithAuth = {
      route: {
        method: 'GET',
        pathPattern: '/items/{id}',
        lambdaLogicalId: 'HandlerFn',
        source: 'http-api',
        apiVersion: 'v2',
        stage: '$default',
        declaredAt: 'S/Route-X',
      },
      authorizer: {
        kind: 'lambda-request',
        logicalId: 'Auth',
        lambdaLogicalId: 'AuthFn',
        identitySources: [{ kind: 'header', name: 'authorization' }],
        resultTtlSeconds: 0, // No caching
        apiVersion: 'v2',
        declaredAt: 'S/Route-X',
      },
    };
    invokeRieMock.mockImplementation(async (_h, _p, event) => {
      const isAuthorizer = (event as { type?: string }).type === 'REQUEST';
      if (isAuthorizer) {
        return { raw: '', payload: { isAuthorized: true } };
      }
      return { raw: '', payload: { statusCode: 200, body: 'ok' } };
    });

    const cache = createAuthorizerCache();
    const server = await startApiServer({
      state: { routes: [route], pool: makePool(), corsConfigByApiId: new Map() },
      rieTimeoutMs: 1000,
      host: '127.0.0.1',
      port: 0,
      authorizerCache: cache,
    });

    try {
      const url = `http://${server.host}:${server.port}/items/42`;
      await fetch(url, { headers: { authorization: 'Bearer xyz' } });
      await fetch(url, { headers: { authorization: 'Bearer xyz' } });
      const authorizerInvocations = invokeRieMock.mock.calls.filter(
        (c) => (c[2] as { type?: string }).type === 'REQUEST'
      );
      // ttl=0 → no caching → 2 invocations.
      expect(authorizerInvocations).toHaveLength(2);
    } finally {
      await server.close();
    }
  });
});

describe('startApiServer — narrow-Resource cache leak (must-fix #2)', () => {
  beforeEach(() => {
    invokeRieMock.mockReset();
  });

  it('cached Allow with narrow Resource is denied for a different methodArn', async () => {
    // Route /items/{id} matches both /items/42 and /items/999.
    const route = makeRequestRoute({ authorizerLogicalId: 'Auth' });
    invokeRieMock.mockImplementation(async (_h, _p, event) => {
      const isAuthorizer = (event as { type?: string }).type === 'REQUEST';
      if (isAuthorizer) {
        return {
          raw: '',
          payload: {
            principalId: 'u',
            policyDocument: {
              Statement: [
                {
                  Effect: 'Allow',
                  // Narrow: only /items/42 is allowed.
                  Resource: 'arn:aws:execute-api:local:123456789012:local/prod/GET/items/42',
                },
              ],
            },
          },
        };
      }
      return { raw: '', payload: { statusCode: 200, body: 'ok' } };
    });

    const cache = createAuthorizerCache();
    const server = await startApiServer({
      state: { routes: [route], pool: makePool(), corsConfigByApiId: new Map() },
      rieTimeoutMs: 1000,
      host: '127.0.0.1',
      port: 0,
      authorizerCache: cache,
    });

    try {
      const baseUrl = `http://${server.host}:${server.port}`;
      // 1st request: hits /items/42 (narrow Resource matches) → 200.
      const r1 = await fetch(`${baseUrl}/items/42`, {
        headers: { authorization: 'Bearer xyz' },
      });
      expect(r1.status).toBe(200);

      // 2nd request: same identity → cache hit, BUT new methodArn
      // /items/999 does NOT match the narrow Resource → must deny.
      // Pre-fix this returned 200 (cache stored the verdict directly,
      // no per-request Resource re-eval).
      const r2 = await fetch(`${baseUrl}/items/999`, {
        headers: { authorization: 'Bearer xyz' },
      });
      expect(r2.status).toBe(403);

      // Authorizer Lambda invoked exactly once: cache hit for r2 (we're
      // NOT re-invoking; Resource re-eval is a CPU-only path off the
      // cached verdict).
      const authorizerInvocations = invokeRieMock.mock.calls.filter(
        (c) => (c[2] as { type?: string }).type === 'REQUEST'
      );
      expect(authorizerInvocations).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});

describe('startApiServer — JWKS pass-through warn fires once per server (must-fix #3)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    invokeRieMock.mockReset();
    // Capture warnings via the global console.warn channel — the logger
    // routes warn lines through console.warn.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('JWKS unreachable + 2 requests → exactly 1 pass-through warn line', async () => {
    const route: RouteWithAuth = {
      route: {
        method: 'GET',
        pathPattern: '/protected',
        lambdaLogicalId: 'HandlerFn',
        source: 'rest-v1',
        apiVersion: 'v1',
        stage: 'prod',
        declaredAt: 'S/Method-Y',
      },
      authorizer: {
        kind: 'cognito',
        logicalId: 'Auth',
        userPoolArn: 'arn:aws:cognito-idp:us-east-1:111:userpool/us-east-1_x',
        region: 'us-east-1',
        userPoolId: 'us-east-1_x',
        declaredAt: 'S/Method-Y',
      },
    };
    invokeRieMock.mockImplementation(async () => ({
      raw: '',
      payload: { statusCode: 200, body: 'ok' },
    }));

    // JWKS cache that always fails fetch → pass-through.
    const jwksCache = createJwksCache({
      fetchImpl: async () => {
        throw new Error('unreachable');
      },
    });
    const jwksWarnedUrls = new Set<string>();
    const server = await startApiServer({
      state: { routes: [route], pool: makePool(), corsConfigByApiId: new Map() },
      rieTimeoutMs: 1000,
      host: '127.0.0.1',
      port: 0,
      jwksCache,
      jwksWarnedUrls,
    });

    try {
      const url = `http://${server.host}:${server.port}/protected`;
      // Use any-old Bearer token; pass-through accepts.
      await fetch(url, { headers: { authorization: 'Bearer xyz' } });
      await fetch(url, { headers: { authorization: 'Bearer xyz' } });

      // Count warn lines about pass-through. The logger emits other
      // warn lines (JWKS unreachable at startup) — only count the
      // request-time pass-through line.
      const passThroughWarns = warnSpy.mock.calls.filter((args) => {
        const msg = args.map((a) => String(a)).join(' ');
        return msg.includes('JWKS pass-through mode for ');
      });
      // Pre-fix: warn fired every request (2 lines). Post-fix: warn
      // fires at most once per JWKS URL per server lifecycle.
      expect(passThroughWarns).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});

describe('startApiServer — unsupported route (deferred 501)', () => {
  beforeEach(() => {
    invokeRieMock.mockReset();
  });

  it('returns HTTP 501 + reason in JSON body without invoking any Lambda', async () => {
    const route: RouteWithAuth = {
      route: {
        method: 'GET',
        pathPattern: '/admin',
        lambdaLogicalId: '',
        source: 'rest-v1',
        apiVersion: 'v1',
        stage: 'prod',
        apiLogicalId: 'Api',
        apiStackName: 'S',
        declaredAt: 'S/AdminMethod',
        unsupported: {
          reason: 'S/AdminMethod: MOCK integration is not emulated (only the CORS preflight subset).',
        },
      },
    };
    const pool = makePool();
    const server = await startApiServer({
      state: { routes: [route], pool, corsConfigByApiId: new Map() },
      rieTimeoutMs: 1000,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const url = `http://${server.host}:${server.port}/admin`;
      const r = await fetch(url);
      expect(r.status).toBe(501);
      const body = (await r.json()) as { message: string; reason: string };
      expect(body.message).toBe('Not Implemented');
      expect(body.reason).toMatch(/MOCK integration is not emulated/);
      // Crucial: no container acquire, no Lambda invoke.
      expect(invokeRieMock).not.toHaveBeenCalled();
      expect((pool.acquire as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('does not run the authorizer pass on an unsupported route', async () => {
    // Reach for the authorizer-attached route fixture, then flag it
    // unsupported. The authorizer Lambda must NOT be invoked (we
    // short-circuit before the authorizer pass).
    const baseRoute = makeRequestRoute({ authorizerLogicalId: 'Auth' });
    const route: RouteWithAuth = {
      ...baseRoute,
      route: { ...baseRoute.route, unsupported: { reason: 'flagged for testing' } },
    };
    const server = await startApiServer({
      state: { routes: [route], pool: makePool(), corsConfigByApiId: new Map() },
      rieTimeoutMs: 1000,
      host: '127.0.0.1',
      port: 0,
      authorizerCache: createAuthorizerCache(),
    });
    try {
      const r = await fetch(`http://${server.host}:${server.port}/items/42`, {
        headers: { authorization: 'Bearer x' },
      });
      expect(r.status).toBe(501);
      expect(invokeRieMock).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});

describe('startApiServer — mockCors preflight', () => {
  beforeEach(() => {
    invokeRieMock.mockReset();
  });

  it('returns the captured status + headers on OPTIONS without invoking any Lambda', async () => {
    const route: RouteWithAuth = {
      route: {
        method: 'OPTIONS',
        pathPattern: '/items',
        lambdaLogicalId: '',
        source: 'rest-v1',
        apiVersion: 'v1',
        stage: 'prod',
        apiLogicalId: 'Api',
        apiStackName: 'S',
        declaredAt: 'S/CorsMethod',
        mockCors: {
          statusCode: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'OPTIONS,GET,POST',
            'Access-Control-Allow-Headers': 'Content-Type,Authorization',
          },
        },
      },
    };
    const pool = makePool();
    const server = await startApiServer({
      state: { routes: [route], pool, corsConfigByApiId: new Map() },
      rieTimeoutMs: 1000,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const r = await fetch(`http://${server.host}:${server.port}/items`, { method: 'OPTIONS' });
      expect(r.status).toBe(204);
      expect(r.headers.get('access-control-allow-origin')).toBe('*');
      expect(r.headers.get('access-control-allow-methods')).toBe('OPTIONS,GET,POST');
      expect(r.headers.get('access-control-allow-headers')).toBe('Content-Type,Authorization');
      expect(invokeRieMock).not.toHaveBeenCalled();
      expect((pool.acquire as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});

describe('startApiServer — RESPONSE_STREAM dispatch (#467)', () => {
  beforeEach(() => {
    invokeRieMock.mockReset();
    invokeRieStreamingMock.mockReset();
  });

  it('routes invokeMode=RESPONSE_STREAM to invokeRieStreaming and pipes the body with chunked encoding', async () => {
    const { Readable } = await import('node:stream');
    invokeRieStreamingMock.mockImplementation(async () => ({
      prelude: {
        statusCode: 200,
        headers: { 'Content-Type': 'text/plain', 'X-Custom': 'hello' },
      },
      body: Readable.from([Buffer.from('chunk-0\n'), Buffer.from('chunk-1\n')]),
    }));
    const route: RouteWithAuth = {
      route: {
        method: 'ANY',
        pathPattern: '/{proxy+}',
        lambdaLogicalId: 'Fn',
        source: 'function-url',
        apiVersion: 'v2',
        stage: '$default',
        apiStackName: 'S',
        declaredAt: 'S/Url',
        invokeMode: 'RESPONSE_STREAM',
      },
    };
    const pool = makePool();
    const server = await startApiServer({
      state: { routes: [route], pool, corsConfigByApiId: new Map() },
      rieTimeoutMs: 5000,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const r = await fetch(`http://${server.host}:${server.port}/anything`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('text/plain');
      expect(r.headers.get('x-custom')).toBe('hello');
      // Node sets Transfer-Encoding: chunked automatically when no Content-Length.
      expect(r.headers.get('transfer-encoding')).toBe('chunked');
      const body = await r.text();
      expect(body).toBe('chunk-0\nchunk-1\n');
      // Buffered path NOT used.
      expect(invokeRieMock).not.toHaveBeenCalled();
      expect(invokeRieStreamingMock).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it('emits multiple Set-Cookie headers from the prelude cookies array', async () => {
    const { Readable } = await import('node:stream');
    invokeRieStreamingMock.mockImplementation(async () => ({
      prelude: {
        statusCode: 200,
        headers: {},
        cookies: ['a=1; Path=/', 'b=2; Path=/'],
      },
      body: Readable.from([Buffer.from('ok')]),
    }));
    const route: RouteWithAuth = {
      route: {
        method: 'ANY',
        pathPattern: '/{proxy+}',
        lambdaLogicalId: 'Fn',
        source: 'function-url',
        apiVersion: 'v2',
        stage: '$default',
        apiStackName: 'S',
        declaredAt: 'S/Url',
        invokeMode: 'RESPONSE_STREAM',
      },
    };
    const server = await startApiServer({
      state: { routes: [route], pool: makePool(), corsConfigByApiId: new Map() },
      rieTimeoutMs: 5000,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const r = await fetch(`http://${server.host}:${server.port}/anything`);
      // Node's fetch / undici exposes multi-valued Set-Cookie via getSetCookie().
      const cookies = r.headers.getSetCookie();
      expect(cookies).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    } finally {
      await server.close();
    }
  });

  it('falls back to buffered invokeRie when invokeMode is BUFFERED (default)', async () => {
    invokeRieMock.mockResolvedValue({
      payload: { statusCode: 200, body: 'buffered-response' },
      raw: '{}',
    });
    const route: RouteWithAuth = {
      route: {
        method: 'ANY',
        pathPattern: '/{proxy+}',
        lambdaLogicalId: 'Fn',
        source: 'function-url',
        apiVersion: 'v2',
        stage: '$default',
        apiStackName: 'S',
        declaredAt: 'S/Url',
        invokeMode: 'BUFFERED',
      },
    };
    const server = await startApiServer({
      state: { routes: [route], pool: makePool(), corsConfigByApiId: new Map() },
      rieTimeoutMs: 5000,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const r = await fetch(`http://${server.host}:${server.port}/anything`);
      expect(r.status).toBe(200);
      expect(await r.text()).toBe('buffered-response');
      expect(invokeRieMock).toHaveBeenCalledTimes(1);
      expect(invokeRieStreamingMock).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('returns 502 + releases the pool when streaming invoke throws before any headers', async () => {
    invokeRieStreamingMock.mockRejectedValue(new Error('rie boom'));
    const pool = makePool();
    const route: RouteWithAuth = {
      route: {
        method: 'ANY',
        pathPattern: '/{proxy+}',
        lambdaLogicalId: 'Fn',
        source: 'function-url',
        apiVersion: 'v2',
        stage: '$default',
        apiStackName: 'S',
        declaredAt: 'S/Url',
        invokeMode: 'RESPONSE_STREAM',
      },
    };
    const server = await startApiServer({
      state: { routes: [route], pool, corsConfigByApiId: new Map() },
      rieTimeoutMs: 5000,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const r = await fetch(`http://${server.host}:${server.port}/anything`);
      expect(r.status).toBe(502);
      // Pool must be released so the warm container can serve the next request.
      expect((pool.release as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it('destroys the body Readable + releases the pool when writeStreamingResponse throws synchronously on a malformed prelude header', async () => {
    // Regression for the PR #501 review blocker: when `res.writeHead(...)`
    // throws synchronously (e.g. on a header value containing CRLF — Node
    // rejects it with ERR_INVALID_CHAR), the body Readable from
    // `invokeRieStreaming` had no consumer attached yet (the `'error'`
    // / `'close'` listeners are installed AFTER `writeHead` succeeds
    // inside `writeStreamingResponse`). Without the fix, the IIFE in
    // `invokeRieStreaming` would keep pushing chunks into an orphan
    // Readable forever and the pool entry would never be returned.
    const { Readable } = await import('node:stream');
    let bodyStream: import('node:stream').Readable | undefined;
    invokeRieStreamingMock.mockImplementation(async () => {
      bodyStream = Readable.from([Buffer.from('chunk-0\n')]);
      return {
        prelude: {
          statusCode: 200,
          // Invalid CRLF in a header value: Node's writeHead rejects
          // synchronously with ERR_INVALID_CHAR.
          headers: { 'X-Bad': 'broken\r\nvalue' },
        },
        body: bodyStream,
      };
    });
    const pool = makePool();
    const route: RouteWithAuth = {
      route: {
        method: 'ANY',
        pathPattern: '/{proxy+}',
        lambdaLogicalId: 'Fn',
        source: 'function-url',
        apiVersion: 'v2',
        stage: '$default',
        apiStackName: 'S',
        declaredAt: 'S/Url',
        invokeMode: 'RESPONSE_STREAM',
      },
    };
    const server = await startApiServer({
      state: { routes: [route], pool, corsConfigByApiId: new Map() },
      rieTimeoutMs: 5000,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const r = await fetch(`http://${server.host}:${server.port}/anything`);
      // Outer catch reports 502 (no headers were sent before the throw).
      expect(r.status).toBe(502);
      // (a) Pool must be released so the warm container can serve again.
      expect((pool.release as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
      // (b) Body Readable must be destroyed so the underlying fetch reader
      // is released and the `invokeRieStreaming` IIFE stops pushing.
      expect(bodyStream).toBeDefined();
      expect(bodyStream!.destroyed).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('strips Content-Length and Transfer-Encoding from the prelude headers (issue #503 item 3)', async () => {
    // A handler that defensively sets `Content-Length` or
    // `Transfer-Encoding` in its prelude must not break the chunked-
    // encoding contract Node enforces automatically. Both headers
    // (case-insensitive) are stripped before `res.writeHead(...)`.
    const { Readable } = await import('node:stream');
    invokeRieStreamingMock.mockImplementation(async () => ({
      prelude: {
        statusCode: 200,
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': '9999',
          'Transfer-Encoding': 'gzip',
          'X-Preserved': 'kept',
        },
      },
      body: Readable.from([Buffer.from('hello-world')]),
    }));
    const route: RouteWithAuth = {
      route: {
        method: 'ANY',
        pathPattern: '/{proxy+}',
        lambdaLogicalId: 'Fn',
        source: 'function-url',
        apiVersion: 'v2',
        stage: '$default',
        apiStackName: 'S',
        declaredAt: 'S/Url',
        invokeMode: 'RESPONSE_STREAM',
      },
    };
    const server = await startApiServer({
      state: { routes: [route], pool: makePool(), corsConfigByApiId: new Map() },
      rieTimeoutMs: 5000,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const r = await fetch(`http://${server.host}:${server.port}/anything`);
      expect(r.status).toBe(200);
      // Node emits Transfer-Encoding: chunked automatically when no
      // Content-Length is set. The handler's "gzip" stays stripped.
      expect(r.headers.get('transfer-encoding')).toBe('chunked');
      // Conflicting Content-Length is stripped (no actual length sent).
      // undici exposes `null` for absent headers.
      expect(r.headers.get('content-length')).toBeNull();
      // Sibling headers pass through intact.
      expect(r.headers.get('content-type')).toBe('text/plain');
      expect(r.headers.get('x-preserved')).toBe('kept');
      const body = await r.text();
      expect(body).toBe('hello-world');
    } finally {
      await server.close();
    }
  });

  it('strips Content-Length and Transfer-Encoding case-insensitively (issue #503 item 3)', async () => {
    // Same as above but with lowercase / mixed-case keys to assert the
    // strip is case-insensitive.
    const { Readable } = await import('node:stream');
    invokeRieStreamingMock.mockImplementation(async () => ({
      prelude: {
        statusCode: 200,
        headers: {
          'content-length': '9999',
          'transfer-encoding': 'chunked',
          'X-Kept': 'yes',
        },
      },
      body: Readable.from([Buffer.from('lc')]),
    }));
    const route: RouteWithAuth = {
      route: {
        method: 'ANY',
        pathPattern: '/{proxy+}',
        lambdaLogicalId: 'Fn',
        source: 'function-url',
        apiVersion: 'v2',
        stage: '$default',
        apiStackName: 'S',
        declaredAt: 'S/Url',
        invokeMode: 'RESPONSE_STREAM',
      },
    };
    const server = await startApiServer({
      state: { routes: [route], pool: makePool(), corsConfigByApiId: new Map() },
      rieTimeoutMs: 5000,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const r = await fetch(`http://${server.host}:${server.port}/anything`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-length')).toBeNull();
      // Node still emits chunked automatically.
      expect(r.headers.get('transfer-encoding')).toBe('chunked');
      expect(r.headers.get('x-kept')).toBe('yes');
      expect(await r.text()).toBe('lc');
    } finally {
      await server.close();
    }
  });
});

describe('parseQueryStringSingular — multi-value comma-join (PR #500 minor)', () => {
  it('comma-joins repeated keys in declaration order', () => {
    // `?foo=a&foo=b` -> `foo: 'a,b'` matches the contract documented at
    // `src/local/parameter-mapping.ts:14` ("multi-values comma-joined")
    // AND deployed API Gateway behavior. Pre-fix the implementation did
    // last-wins (`foo: 'b'`) which silently dropped earlier values for
    // service-integration RequestParameters.
    expect(parseQueryStringSingular('/path?foo=a&foo=b')).toEqual({ foo: 'a,b' });
  });

  it('comma-joins three or more repetitions, preserves order', () => {
    expect(parseQueryStringSingular('/?id=1&id=2&id=3&id=4')).toEqual({ id: '1,2,3,4' });
  });

  it('leaves single-value keys untouched (no extra commas)', () => {
    expect(parseQueryStringSingular('/?a=1&b=2')).toEqual({ a: '1', b: '2' });
  });

  it('mixes single-value + multi-value keys cleanly', () => {
    expect(parseQueryStringSingular('/?foo=a&bar=x&foo=b')).toEqual({
      foo: 'a,b',
      bar: 'x',
    });
  });

  it('URL-decodes each value before joining', () => {
    expect(parseQueryStringSingular('/?q=hello%20world&q=goodbye%21')).toEqual({
      q: 'hello world,goodbye!',
    });
  });

  it('returns empty map on no query string', () => {
    expect(parseQueryStringSingular('/path')).toEqual({});
    expect(parseQueryStringSingular('/path?')).toEqual({});
  });

  it('handles empty values cleanly', () => {
    expect(parseQueryStringSingular('/?foo=&foo=bar')).toEqual({ foo: ',bar' });
  });
});

describe('buildAuthorizerContextForServiceIntegration (closes #502)', () => {
  function lambdaTokenAuth(): AuthorizerInfo {
    return {
      kind: 'lambda-token',
      logicalId: 'TokenAuth',
      lambdaLogicalId: 'AuthFn',
      tokenHeader: 'authorization',
      resultTtlSeconds: 0,
      declaredAt: 'S/Auth',
    };
  }
  function lambdaRequestAuth(): AuthorizerInfo {
    return {
      kind: 'lambda-request',
      logicalId: 'ReqAuth',
      lambdaLogicalId: 'AuthFn',
      identitySources: [{ kind: 'header', name: 'authorization' }],
      resultTtlSeconds: 0,
      apiVersion: 'v2',
      declaredAt: 'S/Auth',
    };
  }
  function jwtAuth(): AuthorizerInfo {
    return {
      kind: 'jwt',
      logicalId: 'JwtAuth',
      issuer: 'https://example.com',
      audiences: ['my-aud'],
      identitySources: [{ kind: 'header', name: 'authorization' }],
      declaredAt: 'S/Auth',
    } as unknown as AuthorizerInfo;
  }
  function cognitoAuth(): AuthorizerInfo {
    return {
      kind: 'cognito',
      logicalId: 'CogAuth',
      pools: [
        {
          userPoolArn: 'arn:aws:cognito-idp:us-east-1:123:userpool/p',
          region: 'us-east-1',
          userPoolId: 'p',
        },
      ],
      userPoolArn: 'arn:aws:cognito-idp:us-east-1:123:userpool/p',
      region: 'us-east-1',
      userPoolId: 'p',
      identitySource: 'authorization',
      declaredAt: 'S/Auth',
    } as unknown as AuthorizerInfo;
  }
  function iamAuth(): AuthorizerInfo {
    return {
      kind: 'iam',
      logicalId: 'AWS_IAM',
      declaredAt: 'S/Auth',
    };
  }

  it('returns undefined when no authorizer fired', () => {
    expect(buildAuthorizerContextForServiceIntegration(undefined, undefined)).toBeUndefined();
    expect(
      buildAuthorizerContextForServiceIntegration(lambdaTokenAuth(), undefined)
    ).toBeUndefined();
    expect(
      buildAuthorizerContextForServiceIntegration(undefined, { allow: true } as CachedAuthorizerResult)
    ).toBeUndefined();
  });

  it('Lambda TOKEN: flattens principalId + context fields at the top level', () => {
    const result: CachedAuthorizerResult = {
      allow: true,
      principalId: 'user-42',
      context: { tier: 'pro', email: 'a@example.com' },
    };
    expect(buildAuthorizerContextForServiceIntegration(lambdaTokenAuth(), result)).toEqual({
      principalId: 'user-42',
      tier: 'pro',
      email: 'a@example.com',
    });
  });

  it('Lambda REQUEST: flattens principalId + context at the top level', () => {
    const result: CachedAuthorizerResult = {
      allow: true,
      principalId: 'u',
      context: { tier: 'pro' },
    };
    expect(buildAuthorizerContextForServiceIntegration(lambdaRequestAuth(), result)).toEqual({
      principalId: 'u',
      tier: 'pro',
    });
  });

  it('Lambda authorizer: omits principalId when absent', () => {
    const result: CachedAuthorizerResult = { allow: true, context: { tier: 'pro' } };
    expect(buildAuthorizerContextForServiceIntegration(lambdaTokenAuth(), result)).toEqual({
      tier: 'pro',
    });
  });

  it('Lambda authorizer: empty record when result has neither principal nor context', () => {
    const result: CachedAuthorizerResult = { allow: true };
    expect(buildAuthorizerContextForServiceIntegration(lambdaTokenAuth(), result)).toEqual({});
  });

  it('IAM (AWS_IAM): surfaces principalId only (no policy emulation)', () => {
    const result: CachedAuthorizerResult = { allow: true, principalId: 'AKIA...' };
    expect(buildAuthorizerContextForServiceIntegration(iamAuth(), result)).toEqual({
      principalId: 'AKIA...',
    });
  });

  it('Cognito: nests claims under `claims.X`', () => {
    const result: CachedAuthorizerResult = {
      allow: true,
      context: { sub: 'cog-user', email: 'b@example.com' },
    };
    expect(buildAuthorizerContextForServiceIntegration(cognitoAuth(), result)).toEqual({
      claims: { sub: 'cog-user', email: 'b@example.com' },
    });
  });

  it('Cognito: empty claims object when no context', () => {
    const result: CachedAuthorizerResult = { allow: true };
    expect(buildAuthorizerContextForServiceIntegration(cognitoAuth(), result)).toEqual({
      claims: {},
    });
  });

  it('JWT: nests claims under `jwt.claims.X` with empty `jwt.scopes`', () => {
    const result: CachedAuthorizerResult = {
      allow: true,
      context: { sub: 'user-42', email: 'a@example.com' },
    };
    expect(buildAuthorizerContextForServiceIntegration(jwtAuth(), result)).toEqual({
      jwt: {
        claims: { sub: 'user-42', email: 'a@example.com' },
        scopes: [],
      },
    });
  });
});

/**
 * End-to-end tests for Lambda Function URL `AuthType: 'AWS_IAM'`
 * (issue #621). The infrastructure for SigV4 verification shipped in
 * PR #447 for REST v1; this issue wires Function URL routes through the
 * same `IamAuthorizer` plumbing so they share the verifier rather than
 * being rejected at boot.
 *
 * Tests boot a real `node:http` server with a Function URL route
 * (v2-shaped) carrying an IAM authorizer, then exercise three
 * end-to-end shapes: valid SigV4 (200), missing Authorization header
 * (403), and tampered signature (403). The 403 status (vs API Gateway
 * v2's default 401) matches Lambda's deployed Function URL IAM response.
 */
function signFunctionUrlRequest(opts: {
  method: string;
  path: string;
  query?: string;
  headers: Record<string, string>;
  body?: Buffer;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  amzDate: string;
}): { authorization: string; headers: Record<string, string> } {
  const headers = { ...opts.headers };
  if (!headers['x-amz-date']) headers['x-amz-date'] = opts.amzDate;
  const body = opts.body ?? Buffer.alloc(0);
  const payloadHash = createHash('sha256').update(body).digest('hex');

  const signedHeaderNames = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const headerLines = signedHeaderNames
    .map((h) => `${h}:${headers[h]!.trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const canonicalQuery = opts.query ? canonicalizeQueryString(opts.query) : '';
  const canonicalUri = canonicalizePath(opts.path);

  const canonicalRequest = [
    opts.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    headerLines,
    signedHeaderNames.join(';'),
    payloadHash,
  ].join('\n');

  const date = opts.amzDate.slice(0, 8);
  // Function URL uses service=lambda when signed by an AWS SDK client;
  // the verifier only checks the access-key-id matches the dev's local
  // creds and the canonical-request hash matches, so the service name
  // in the credential scope is not load-bearing for the verify step.
  const service = 'lambda';
  const credentialScope = `${date}/${opts.region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    opts.amzDate,
    credentialScope,
    createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');

  const kDate = createHmac('sha256', `AWS4${opts.secretAccessKey}`).update(date).digest();
  const kRegion = createHmac('sha256', kDate).update(opts.region).digest();
  const kService = createHmac('sha256', kRegion).update(service).digest();
  const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`;
  return { authorization, headers };
}

function nowAmzDate(): string {
  // YYYYMMDDTHHmmssZ — what AWS SDKs put in `x-amz-date`. Use the
  // current clock so the verifier's 15-min skew check passes against
  // the real wall clock that `startApiServer` reads (the http-server
  // does NOT pass a `now` override to `verifySigV4`).
  const d = new Date();
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  const hh = d.getUTCHours().toString().padStart(2, '0');
  const mi = d.getUTCMinutes().toString().padStart(2, '0');
  const ss = d.getUTCSeconds().toString().padStart(2, '0');
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

function stubCredentialsLoader(creds: ResolvedCredentials): CredentialsLoader {
  return async () => creds;
}

function functionUrlIamRoute(): RouteWithAuth {
  return {
    route: {
      method: 'ANY',
      pathPattern: '/{proxy+}',
      lambdaLogicalId: 'HandlerFn',
      source: 'function-url',
      apiVersion: 'v2',
      stage: '$default',
      apiStackName: 'S',
      declaredAt: 'S/Url',
      invokeMode: 'BUFFERED',
    },
    authorizer: {
      kind: 'iam',
      logicalId: 'AWS_IAM',
      declaredAt: 'S/Url',
    },
  };
}

describe('startApiServer — Function URL AWS_IAM (#621)', () => {
  const accessKeyId = 'AKIDEXAMPLE';
  const secretAccessKey = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';

  beforeEach(() => {
    invokeRieMock.mockReset();
  });

  it('valid SigV4 → 200 (request reaches the Lambda handler)', async () => {
    invokeRieMock.mockImplementation(async () => ({
      raw: '',
      payload: { statusCode: 200, body: 'ok' },
    }));
    const route = functionUrlIamRoute();
    const server = await startApiServer({
      state: { routes: [route], pool: makePool(), corsConfigByApiId: new Map() },
      rieTimeoutMs: 1000,
      host: '127.0.0.1',
      port: 0,
      sigV4CredentialsLoader: stubCredentialsLoader({ accessKeyId, secretAccessKey }),
    });
    try {
      const path = '/items/42';
      const amzDate = nowAmzDate();
      const { authorization, headers } = signFunctionUrlRequest({
        method: 'GET',
        path,
        // The verifier rebuilds the canonical request from the request
        // signed-header list. The Host header at the client side is
        // `127.0.0.1:<port>`; signing it here keeps the hashes aligned.
        headers: { host: `${server.host}:${server.port}` },
        accessKeyId,
        secretAccessKey,
        region: 'us-east-1',
        amzDate,
      });
      const r = await fetch(`http://${server.host}:${server.port}${path}`, {
        headers: { authorization, ...headers },
      });
      expect(r.status).toBe(200);
      expect(invokeRieMock).toHaveBeenCalledTimes(1);
      // Function URL + AWS_IAM does NOT emit a `buildOverlay` block —
      // AWS-deployed Function URLs write principal context under
      // `event.requestContext.authorizer.iam.{accessKey, accountId, ...}`,
      // NOT `.lambda`. cdkd has no local IAM data plane to synthesize
      // the `.iam` block, so the safest answer is no overlay at all:
      // the base v2 event's `authorizer: null` survives intact (PR body
      // honors this with "no Function URL identity context" out-of-scope).
      // A regression that wrote principalId under `.lambda.principalId`
      // would mislead handlers that defensive-read `.iam ?? {}` — this
      // assertion catches it.
      const passedEvent = invokeRieMock.mock.calls[0]?.[2] as
        | { requestContext?: { authorizer?: Record<string, unknown> | null } }
        | undefined;
      expect(passedEvent?.requestContext?.authorizer).toBeNull();
    } finally {
      await server.close();
    }
  });

  it('missing Authorization header → 403 Forbidden (no Lambda invoke)', async () => {
    const route = functionUrlIamRoute();
    const pool = makePool();
    const server = await startApiServer({
      state: { routes: [route], pool, corsConfigByApiId: new Map() },
      rieTimeoutMs: 1000,
      host: '127.0.0.1',
      port: 0,
      sigV4CredentialsLoader: stubCredentialsLoader({ accessKeyId, secretAccessKey }),
    });
    try {
      const r = await fetch(`http://${server.host}:${server.port}/items/42`);
      expect(r.status).toBe(403);
      const body = (await r.json()) as { Message: string };
      expect(body.Message).toBe('Forbidden');
      expect(invokeRieMock).not.toHaveBeenCalled();
      expect((pool.acquire as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('tampered signature → 403 Forbidden (no Lambda invoke)', async () => {
    const route = functionUrlIamRoute();
    const pool = makePool();
    const server = await startApiServer({
      state: { routes: [route], pool, corsConfigByApiId: new Map() },
      rieTimeoutMs: 1000,
      host: '127.0.0.1',
      port: 0,
      sigV4CredentialsLoader: stubCredentialsLoader({ accessKeyId, secretAccessKey }),
    });
    try {
      const path = '/items/42';
      const amzDate = nowAmzDate();
      const { authorization, headers } = signFunctionUrlRequest({
        method: 'GET',
        path,
        headers: { host: `${server.host}:${server.port}` },
        accessKeyId,
        secretAccessKey,
        region: 'us-east-1',
        amzDate,
      });
      // Flip one hex character in the signature so the verifier rejects.
      const tampered = authorization.replace(/Signature=([0-9a-f])/, (_m, c: string) =>
        `Signature=${c === '0' ? '1' : '0'}`
      );
      const r = await fetch(`http://${server.host}:${server.port}${path}`, {
        headers: { authorization: tampered, ...headers },
      });
      expect(r.status).toBe(403);
      const body = (await r.json()) as { Message: string };
      expect(body.Message).toBe('Forbidden');
      expect(invokeRieMock).not.toHaveBeenCalled();
      expect((pool.acquire as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
