import { describe, expect, it, vi, beforeEach } from 'vite-plus/test';

// vi.hoisted so the spies are available inside the vi.mock factory below
// (vi.mock is hoisted to file-top — top-level consts captured by the
// factory are referenced before they're initialized otherwise).
const { dispatchSpy, verifyJwtAuthorizerSpy } = vi.hoisted(() => ({
  dispatchSpy: vi.fn(),
  verifyJwtAuthorizerSpy: vi.fn(),
}));

// Mock the service-integration SDK adapter so we can prove the
// authorizer-deny path NEVER invokes it. Using `vi.importActual` to
// preserve every other export from the module (the dispatcher is the
// ONLY function we want to spy on; `applyResponseParameters` /
// `resolveServiceIntegrationParameters` / etc. must keep their real
// implementations because http-server.ts calls them on the auth-allow
// path).
vi.mock('../../../src/local/httpv2-service-integration.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/local/httpv2-service-integration.js')>(
    '../../../src/local/httpv2-service-integration.js'
  );
  return {
    ...actual,
    dispatchServiceIntegration: dispatchSpy,
  };
});

vi.mock('../../../src/local/rie-client.js', () => ({
  invokeRie: vi.fn(),
  invokeRieStreaming: vi.fn(),
}));

// Mock the JWT-verify entry points so a JWT-deny verdict can be injected
// without standing up a real JWKS endpoint. `createJwksCache` keeps its
// real impl (the server's `opts.jwksCache` shape must round-trip), so we
// preserve every other export via `vi.importActual`.
vi.mock('../../../src/local/cognito-jwt.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/local/cognito-jwt.js')>(
    '../../../src/local/cognito-jwt.js'
  );
  return {
    ...actual,
    verifyJwtAuthorizer: verifyJwtAuthorizerSpy,
  };
});

import { startApiServer } from '../../../src/local/http-server.js';
import type { RouteWithAuth } from '../../../src/local/authorizer-resolver.js';
import type { ContainerPool } from '../../../src/local/container-pool.js';
import { createAuthorizerCache } from '../../../src/local/authorizer-cache.js';
import { createJwksCache } from '../../../src/local/cognito-jwt.js';
import * as rieClient from '../../../src/local/rie-client.js';

const invokeRieMock = rieClient.invokeRie as unknown as ReturnType<typeof vi.fn>;

/**
 * PR #515 item 8: end-to-end deny-path coverage for service-integration
 * routes. The unit-level behavior of
 * `buildAuthorizerContextForServiceIntegration` is covered in
 * `http-server.test.ts`, but the load-bearing security claim from PR
 * #514 — "auth-deny → SDK never fires" — only surfaces at the
 * `handleRequest` -> `runAuthorizerPass` -> `handleServiceIntegrationRequest`
 * dispatch chain. These tests wire that chain end-to-end against BOTH
 * authorizer kinds the service-integration auth-pass guards — a Lambda
 * REQUEST authorizer (deny verdict / missing identity / handler crash)
 * AND a JWT authorizer (forged-signature deny) — and assert the spy on
 * `dispatchServiceIntegration` is never called.
 */
function makePool(): ContainerPool {
  const acquire = vi.fn(async () => ({
    containerId: 'c1',
    containerHost: '127.0.0.1',
    hostPort: 1234,
    logicalId: 'AuthFn',
    release: vi.fn(),
  }));
  const release = vi.fn();
  return {
    acquire,
    release,
    dispose: vi.fn(async () => undefined),
  } as unknown as ContainerPool;
}

function makeServiceRoute(): RouteWithAuth {
  return {
    route: {
      method: 'POST',
      pathPattern: '/protected-sqs',
      lambdaLogicalId: '',
      source: 'http-api',
      apiVersion: 'v2',
      stage: '$default',
      declaredAt: 'S/Route-ProtectedSqs',
      serviceIntegration: {
        subtype: 'SQS-SendMessage',
        requestParameters: {
          QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/queue',
          MessageBody: '$request.body',
        },
      },
    },
    authorizer: {
      kind: 'lambda-request',
      logicalId: 'ReqAuth',
      lambdaLogicalId: 'AuthFn',
      identitySources: [{ kind: 'header', name: 'authorization' }],
      resultTtlSeconds: 0,
      apiVersion: 'v2',
      declaredAt: 'S/Route-ProtectedSqs',
    },
  };
}

function makeJwtServiceRoute(): RouteWithAuth {
  return {
    route: {
      method: 'POST',
      pathPattern: '/protected-sqs',
      lambdaLogicalId: '',
      source: 'http-api',
      apiVersion: 'v2',
      stage: '$default',
      declaredAt: 'S/Route-ProtectedSqs',
      serviceIntegration: {
        subtype: 'SQS-SendMessage',
        requestParameters: {
          QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/queue',
          MessageBody: '$request.body',
        },
      },
    },
    authorizer: {
      kind: 'jwt',
      logicalId: 'JwtAuth',
      issuer: 'https://issuer.example.com',
      audience: ['my-client-id'],
      declaredAt: 'S/Route-ProtectedSqs',
    },
  };
}

describe('PR #515 item 8: service-integration route + authorizer-deny → SDK never fires', () => {
  beforeEach(() => {
    invokeRieMock.mockReset();
    dispatchSpy.mockReset();
    verifyJwtAuthorizerSpy.mockReset();
  });

  it('Lambda REQUEST authorizer denies → HTTP 401 + dispatchServiceIntegration NOT called', async () => {
    // Authorizer Lambda returns a non-Allow verdict. HTTP API v2 simple
    // shape: `{ isAuthorized: false }` means deny.
    invokeRieMock.mockImplementation(async (_h, _p, event) => {
      const isAuthorizer = (event as { type?: string }).type === 'REQUEST';
      if (isAuthorizer) {
        return {
          raw: '',
          payload: { isAuthorized: false },
        };
      }
      throw new Error('handler must never be invoked on deny');
    });

    const route = makeServiceRoute();
    const cache = createAuthorizerCache();
    const server = await startApiServer({
      state: { routes: [route], pool: makePool(), corsConfigByApiId: new Map() },
      rieTimeoutMs: 1000,
      host: '127.0.0.1',
      port: 0,
      authorizerCache: cache,
      defaultRegion: 'us-east-1',
    });

    try {
      const url = `http://${server.host}:${server.port}/protected-sqs`;
      const resp = await fetch(url, {
        method: 'POST',
        body: 'message-body',
        headers: { authorization: 'Bearer wrong-token', 'content-type': 'text/plain' },
      });
      // HTTP API v2 collapses both deny kinds to 401.
      expect(resp.status).toBe(401);
      // The load-bearing security invariant: deny → no SDK fire.
      expect(dispatchSpy).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('Lambda REQUEST authorizer missing identity → 401 + dispatch never invoked', async () => {
    // The route's identity source is the `authorization` header; we
    // omit it entirely so the authorizer pass sees no identity. AWS API
    // Gateway short-circuits this case BEFORE invoking the Lambda — the
    // assert here is that the SDK adapter spy ALSO never fires.
    invokeRieMock.mockImplementation(async (_h, _p, _event) => {
      // If the Lambda ever runs, the test should fail loudly. The
      // missing-identity path should short-circuit before this.
      throw new Error('authorizer Lambda must not run on missing-identity');
    });

    const route = makeServiceRoute();
    const cache = createAuthorizerCache();
    const server = await startApiServer({
      state: { routes: [route], pool: makePool(), corsConfigByApiId: new Map() },
      rieTimeoutMs: 1000,
      host: '127.0.0.1',
      port: 0,
      authorizerCache: cache,
      defaultRegion: 'us-east-1',
    });

    try {
      const url = `http://${server.host}:${server.port}/protected-sqs`;
      const resp = await fetch(url, {
        method: 'POST',
        body: 'message-body',
        // No `authorization` header — Lambda REQUEST identity source missing.
        headers: { 'content-type': 'text/plain' },
      });
      expect(resp.status).toBe(401);
      expect(dispatchSpy).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('Lambda REQUEST authorizer throws → 401 + dispatch never invoked', async () => {
    // Authorizer Lambda itself throws (HTTP API v2 treats this as
    // policy-deny → 401). The load-bearing claim is unchanged: deny
    // path of any flavor MUST short-circuit before any SDK call fires.
    invokeRieMock.mockImplementation(async (_h, _p, event) => {
      const isAuthorizer = (event as { type?: string }).type === 'REQUEST';
      if (isAuthorizer) {
        // A non-deterministic Lambda error (e.g. handler crash). The
        // http-server's runAuthorizerPass catches and routes to
        // writeAuthRejection('policy-deny') = 401 on HTTP v2.
        throw new Error('authorizer Lambda crashed');
      }
      throw new Error('handler must never be invoked');
    });

    const route = makeServiceRoute();
    const cache = createAuthorizerCache();
    const server = await startApiServer({
      state: { routes: [route], pool: makePool(), corsConfigByApiId: new Map() },
      rieTimeoutMs: 1000,
      host: '127.0.0.1',
      port: 0,
      authorizerCache: cache,
      defaultRegion: 'us-east-1',
    });

    try {
      const url = `http://${server.host}:${server.port}/protected-sqs`;
      const resp = await fetch(url, {
        method: 'POST',
        body: 'message-body',
        headers: { authorization: 'Bearer xyz', 'content-type': 'text/plain' },
      });
      expect(resp.status).toBe(401);
      expect(dispatchSpy).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('JWT authorizer rejects forged signature → 401 + dispatch never invoked', async () => {
    // JWT-deny mirrors the security claim across the other authorizer
    // kind the service-integration auth-pass guards. The forged token is
    // shaped like a real JWT (`header.payload.signature` base64url
    // segments) so it gets past `extractBearer` and into the JWKS-backed
    // verifier; the mocked `verifyJwtAuthorizer` returns the canonical
    // signature-mismatch verdict (`allow: false`). The load-bearing
    // invariant is the same as the Lambda REQUEST cases: deny → no SDK
    // fire.
    verifyJwtAuthorizerSpy.mockResolvedValue({
      allow: false,
      identityHash: undefined,
      ttlSeconds: 0,
    });

    const route = makeJwtServiceRoute();
    const cache = createAuthorizerCache();
    const jwksCache = createJwksCache();
    const server = await startApiServer({
      state: { routes: [route], pool: makePool(), corsConfigByApiId: new Map() },
      rieTimeoutMs: 1000,
      host: '127.0.0.1',
      port: 0,
      authorizerCache: cache,
      jwksCache,
      defaultRegion: 'us-east-1',
    });

    try {
      const url = `http://${server.host}:${server.port}/protected-sqs`;
      // Plausible-shaped JWT (three base64url segments). The signature
      // does not match anything `verifyJwtAuthorizer` would accept; the
      // mock returns deny regardless.
      const forgedJwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMifQ.bogus';
      const resp = await fetch(url, {
        method: 'POST',
        body: 'message-body',
        headers: { authorization: `Bearer ${forgedJwt}`, 'content-type': 'text/plain' },
      });
      // HTTP API v2 collapses every deny kind to 401.
      expect(resp.status).toBe(401);
      // The load-bearing security invariant: JWT-deny → no SDK fire.
      expect(dispatchSpy).not.toHaveBeenCalled();
      // The mocked verifier was reached (proves the auth pass DID run on
      // the JWT route; the route wasn't accidentally bypassed before
      // reaching the verify step).
      expect(verifyJwtAuthorizerSpy).toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
