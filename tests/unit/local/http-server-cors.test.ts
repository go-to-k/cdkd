import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { startApiServer, type ServerState } from '../../../src/local/http-server.js';
import type {
  ContainerPool,
  ContainerHandle,
  ContainerSpec,
} from '../../../src/local/container-pool.js';
import type { CorsConfig } from '../../../src/local/cors-handler.js';
import type { DiscoveredRoute } from '../../../src/local/route-discovery.js';
import type { RouteWithAuth } from '../../../src/local/authorizer-resolver.js';

/**
 * End-to-end coverage for the CORS preflight interception path inside
 * the HTTP server's request handler.
 *
 * `maybeHandleCorsPreflight` is private — exercised via real HTTP
 * requests against a live `startApiServer`. We use a stub ContainerPool
 * that records every `acquire()` call so each test can assert preflight
 * was intercepted (acquire NOT called) vs. fell through to route
 * dispatch (acquire called). Lambda-side execution is mocked away by
 * having the pool's acquire reject — the request body never reaches
 * `invokeRie` because we want to test only the preflight path.
 */

interface StubPool extends ContainerPool {
  acquireCalls: string[];
}

function stubPool(): StubPool {
  const acquireCalls: string[] = [];
  const pool = {
    acquireCalls,
    acquire: vi.fn(async (logicalId: string): Promise<ContainerHandle> => {
      acquireCalls.push(logicalId);
      // Make every actual route dispatch a 502 so tests that DON'T expect
      // preflight interception can still observe a clear non-204 path.
      throw new Error('stub-acquire-failed');
    }),
    release: vi.fn(),
    dispose: vi.fn(async (): Promise<void> => undefined),
  } as unknown as StubPool;
  Object.defineProperty(pool, '__cdkdSpecs', {
    value: new Map<string, ContainerSpec>(),
    enumerable: false,
    configurable: true,
  });
  return pool;
}

function v2Route(over: Partial<DiscoveredRoute> = {}): RouteWithAuth {
  return {
    route: {
      method: 'POST', // matches the preflight's access-control-request-method
      pathPattern: '/items',
      lambdaLogicalId: 'L_v2',
      source: 'http-api',
      apiVersion: 'v2',
      stage: '$default',
      apiLogicalId: 'ApiV2',
      declaredAt: 'S/Items',
      ...over,
    },
  };
}

function v1Route(over: Partial<DiscoveredRoute> = {}): RouteWithAuth {
  return {
    route: {
      method: 'OPTIONS',
      pathPattern: '/items',
      lambdaLogicalId: 'L_v1',
      source: 'rest-v1',
      apiVersion: 'v1',
      stage: '$default',
      apiLogicalId: 'ApiV1',
      declaredAt: 'S/ItemsV1',
      ...over,
    },
  };
}

const corsConfig: CorsConfig = {
  AllowOrigins: ['https://example.com'],
  AllowMethods: ['GET', 'POST'],
  AllowHeaders: ['Content-Type'],
  ExposeHeaders: [],
};

async function preflight(
  port: number,
  host: string,
  path: string,
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; headers: Headers; body: string }> {
  const url = `http://${host}:${port}${path}`;
  const res = await fetch(url, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://example.com',
      'access-control-request-method': 'POST',
      ...extraHeaders,
    },
  });
  const body = await res.text();
  return { status: res.status, headers: res.headers, body };
}

describe('http-server CORS preflight integration', () => {
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined;

  beforeEach(() => {
    server = undefined;
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  it('intercepts preflight on a CORS-configured HTTP API v2 route', async () => {
    const pool = stubPool();
    const state: ServerState = {
      routes: [v2Route()],
      pool,
      corsConfigByApiId: new Map([['ApiV2', corsConfig]]),
    };
    server = await startApiServer({ state, rieTimeoutMs: 5_000, host: '127.0.0.1', port: 0 });
    const r = await preflight(server.port, server.host, '/items');
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe('https://example.com');
    expect(r.headers.get('vary')).toBe('Origin');
    // Preflight does NOT acquire a container (Lambda not invoked).
    expect(pool.acquireCalls).toEqual([]);
  });

  it('preflight on API A is NOT suppressed by an explicit OPTIONS route on API B (cross-API contamination guard)', async () => {
    const pool = stubPool();
    // Two APIs sharing the path /items: API v2 has CORS config; v1 has
    // an explicit OPTIONS route. Pre-fix the v1 OPTIONS route would
    // suppress preflight on the v2 API; post-fix the apiLogicalId
    // filter scopes the explicit-OPTIONS check to the matched route's
    // own API.
    const state: ServerState = {
      routes: [
        v2Route(), // GET /items on ApiV2 (with CORS)
        v1Route(), // OPTIONS /items on ApiV1 (different API)
      ],
      pool,
      corsConfigByApiId: new Map([['ApiV2', corsConfig]]),
    };
    server = await startApiServer({ state, rieTimeoutMs: 5_000, host: '127.0.0.1', port: 0 });
    const r = await preflight(server.port, server.host, '/items');
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe('https://example.com');
    expect(pool.acquireCalls).toEqual([]);
  });

  it('falls through to route dispatch when an explicit OPTIONS route exists on the SAME API', async () => {
    const pool = stubPool();
    // Two routes on the same v2 API: GET /items (would match preflight)
    // and OPTIONS /items (user owns CORS for this path). The explicit
    // OPTIONS should suppress interception so the user's Lambda is
    // dispatched (which then 502s due to our stub).
    const state: ServerState = {
      routes: [
        v2Route(),
        v2Route({ method: 'OPTIONS', lambdaLogicalId: 'L_v2_options' }),
      ],
      pool,
      corsConfigByApiId: new Map([['ApiV2', corsConfig]]),
    };
    server = await startApiServer({ state, rieTimeoutMs: 5_000, host: '127.0.0.1', port: 0 });
    const r = await preflight(server.port, server.host, '/items');
    expect(r.status).toBe(502);
    // Lambda was dispatched.
    expect(pool.acquireCalls).toEqual(['L_v2_options']);
  });

  it('falls through to 404 when no route matches the requested method (surrogateMatch fail)', async () => {
    const pool = stubPool();
    const state: ServerState = {
      routes: [v2Route({ pathPattern: '/other' })], // path doesn't match
      pool,
      corsConfigByApiId: new Map([['ApiV2', corsConfig]]),
    };
    server = await startApiServer({ state, rieTimeoutMs: 5_000, host: '127.0.0.1', port: 0 });
    const r = await preflight(server.port, server.host, '/items');
    expect(r.status).toBe(404);
    expect(pool.acquireCalls).toEqual([]);
  });

  it('falls through to route dispatch when the matched route is REST v1 (preflight not handled for v1)', async () => {
    const pool = stubPool();
    const state: ServerState = {
      // Only a v1 route on /items — preflight should NOT be intercepted
      // (REST v1 CORS via Mock OPTIONS is out of scope). The route's
      // method must match the preflight's `Access-Control-Request-Method`
      // (POST) for surrogateMatch to find it; we use ANY here so the
      // route matches any method.
      routes: [v1Route({ method: 'ANY', lambdaLogicalId: 'L_v1' })],
      pool,
      corsConfigByApiId: new Map([['ApiV1', corsConfig]]), // even if cors map has v1 entry
    };
    server = await startApiServer({ state, rieTimeoutMs: 5_000, host: '127.0.0.1', port: 0 });
    const r = await preflight(server.port, server.host, '/items');
    // Falls through to route dispatch; the actual OPTIONS request hits
    // matchRoute again — ANY matches OPTIONS too, so we end up
    // dispatching the v1 Lambda. Stub pool's acquire rejects, so we get
    // a 502.
    expect(r.status).toBe(502);
    expect(pool.acquireCalls).toEqual(['L_v1']);
  });

  it('returns early (no preflight) when access-control-request-method header is missing', async () => {
    const pool = stubPool();
    const state: ServerState = {
      routes: [v2Route()],
      pool,
      corsConfigByApiId: new Map([['ApiV2', corsConfig]]),
    };
    server = await startApiServer({ state, rieTimeoutMs: 5_000, host: '127.0.0.1', port: 0 });
    // OPTIONS without access-control-request-method. Falls through to
    // route dispatch — but the routes don't include OPTIONS for /items,
    // so it 404s.
    const url = `http://${server.host}:${server.port}/items`;
    const res = await fetch(url, {
      method: 'OPTIONS',
      headers: { origin: 'https://example.com' },
    });
    expect(res.status).toBe(404);
    expect(pool.acquireCalls).toEqual([]);
  });

  it('matches greedy {proxy+} pattern when checking explicit-OPTIONS suppression on the same API', async () => {
    const pool = stubPool();
    // POST /api/{proxy+} would match preflight (preflight asks for
    // POST); OPTIONS /api/{proxy+} on the SAME API should suppress
    // interception. The greedy pattern is exercised because the
    // request path `/api/items/123` has more segments than the literal
    // prefix.
    const state: ServerState = {
      routes: [
        v2Route({ pathPattern: '/api/{proxy+}', method: 'POST' }),
        v2Route({
          pathPattern: '/api/{proxy+}',
          method: 'OPTIONS',
          lambdaLogicalId: 'L_v2_options',
        }),
      ],
      pool,
      corsConfigByApiId: new Map([['ApiV2', corsConfig]]),
    };
    server = await startApiServer({ state, rieTimeoutMs: 5_000, host: '127.0.0.1', port: 0 });
    const r = await preflight(server.port, server.host, '/api/items/123');
    // Preflight suppressed — falls through to route dispatch (stub 502).
    expect(r.status).toBe(502);
    expect(pool.acquireCalls).toEqual(['L_v2_options']);
  });
});
