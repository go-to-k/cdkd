/**
 * Unit tests for the REST v1 non-AWS_PROXY integration dispatchers
 * (#457). Covers `dispatchMockIntegration`, `dispatchHttpProxyIntegration`,
 * `dispatchHttpIntegration`, `dispatchAwsLambdaIntegration` from
 * `src/local/rest-v1-integrations.ts`.
 *
 * The HTTP_PROXY / HTTP tests inject a mock `fetch` so no real network
 * calls fire. The AWS Lambda non-proxy test would normally need a
 * container pool — covered at a smaller surface here by mocking
 * `invokeRie`.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../../src/local/rie-client.js', () => ({
  invokeRie: vi.fn(),
}));

import { invokeRie } from '../../../src/local/rie-client.js';
import type { ContainerPool } from '../../../src/local/container-pool.js';
import {
  dispatchAwsLambdaIntegration,
  dispatchHttpIntegration,
  dispatchHttpProxyIntegration,
  dispatchMockIntegration,
  substituteUriPlaceholders,
  type RestV1IntegrationRequest,
} from '../../../src/local/rest-v1-integrations.js';
import { randomUUID } from 'node:crypto';

function buildRequest(
  overrides: Partial<RestV1IntegrationRequest> = {}
): RestV1IntegrationRequest {
  return {
    method: 'GET',
    matchedPath: '/items',
    pathParameters: {},
    querystring: {},
    headers: {},
    body: Buffer.from(''),
    sourceIp: '127.0.0.1',
    userAgent: 'test',
    stage: 'prod',
    resourcePath: '/items',
    requestId: randomUUID(),
    ...overrides,
  };
}

describe('dispatchMockIntegration', () => {
  it('renders the default response entry when no request template is configured', () => {
    const outcome = dispatchMockIntegration(
      {
        kind: 'mock',
        requestTemplate: undefined,
        responses: [
          { StatusCode: '200', ResponseTemplates: { 'application/json': '{"ok":true}' } },
        ],
      },
      buildRequest()
    );
    expect(outcome.statusCode).toBe(200);
    expect(outcome.body).toBe('{"ok":true}');
    expect(outcome.headers['content-type']).toBe('application/json');
  });
  it('picks status code from rendered request template {"statusCode":N}', () => {
    const outcome = dispatchMockIntegration(
      {
        kind: 'mock',
        requestTemplate: '{"statusCode": 404}',
        responses: [
          { StatusCode: '200', ResponseTemplates: { 'application/json': 'success' } },
          { StatusCode: '404', ResponseTemplates: { 'application/json': 'not found' } },
        ],
      },
      buildRequest()
    );
    expect(outcome.statusCode).toBe(404);
    expect(outcome.body).toBe('not found');
  });
  it('applies ResponseParameters header literals', () => {
    const outcome = dispatchMockIntegration(
      {
        kind: 'mock',
        requestTemplate: undefined,
        responses: [
          {
            StatusCode: '200',
            ResponseParameters: { 'method.response.header.X-Powered-By': "'cdkd-local'" },
            ResponseTemplates: { 'application/json': '{}' },
          },
        ],
      },
      buildRequest()
    );
    expect(outcome.headers['X-Powered-By']).toBe('cdkd-local');
  });
  it('returns 502 when the request template fails to evaluate', () => {
    const outcome = dispatchMockIntegration(
      {
        kind: 'mock',
        requestTemplate: '#macro(unused)x#end',
        responses: [],
      },
      buildRequest()
    );
    expect(outcome.statusCode).toBe(502);
    expect(String(outcome.body)).toMatch(/VTL request-template/);
  });
  it('handles empty IntegrationResponses (returns 200 + empty body)', () => {
    const outcome = dispatchMockIntegration(
      { kind: 'mock', requestTemplate: undefined, responses: [] },
      buildRequest()
    );
    expect(outcome.statusCode).toBe(200);
  });
});

describe('dispatchHttpProxyIntegration', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
  });

  it('forwards the upstream response verbatim on 2xx', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const outcome = await dispatchHttpProxyIntegration(
      {
        kind: 'http-proxy',
        uri: 'http://example.com/api',
        responses: [],
      },
      buildRequest(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pool: {} as ContainerPool, rieTimeoutMs: 30_000, fetch: mockFetch as any }
    );
    expect(outcome.statusCode).toBe(200);
    expect(String(outcome.body)).toContain('"ok":true');
    expect(mockFetch).toHaveBeenCalledWith('http://example.com/api', expect.any(Object));
  });
  it('substitutes path placeholders in the upstream URL', async () => {
    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await dispatchHttpProxyIntegration(
      {
        kind: 'http-proxy',
        uri: 'http://example.com/users/{userId}',
        responses: [],
      },
      buildRequest({ pathParameters: { userId: '42' } }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pool: {} as ContainerPool, rieTimeoutMs: 30_000, fetch: mockFetch as any }
    );
    expect(mockFetch.mock.calls[0]?.[0]).toBe('http://example.com/users/42');
  });
  it('returns 502 when upstream is unreachable', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const outcome = await dispatchHttpProxyIntegration(
      { kind: 'http-proxy', uri: 'http://nope/', responses: [] },
      buildRequest(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pool: {} as ContainerPool, rieTimeoutMs: 30_000, fetch: mockFetch as any }
    );
    expect(outcome.statusCode).toBe(502);
    expect(String(outcome.body)).toContain('ECONNREFUSED');
  });
  it('routes status code via IntegrationResponses SelectionPattern', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Server error', { status: 500 }));
    const outcome = await dispatchHttpProxyIntegration(
      {
        kind: 'http-proxy',
        uri: 'http://example.com/api',
        responses: [
          { StatusCode: '200' },
          { StatusCode: '503', SelectionPattern: '5\\d\\d' },
        ],
      },
      buildRequest(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pool: {} as ContainerPool, rieTimeoutMs: 30_000, fetch: mockFetch as any }
    );
    expect(outcome.statusCode).toBe(503);
  });
});

describe('dispatchHttpIntegration', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
  });

  it('applies request VTL template to body before sending upstream', async () => {
    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await dispatchHttpIntegration(
      {
        kind: 'http',
        uri: 'http://upstream/api',
        requestTemplates: {
          'application/json': '{"wrapped": $input.json("$")}',
        },
        responses: [],
      },
      buildRequest({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('{"x":1}'),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pool: {} as ContainerPool, rieTimeoutMs: 30_000, fetch: mockFetch as any }
    );
    const passedBody = mockFetch.mock.calls[0]?.[1]?.body as string;
    expect(passedBody).toBe('{"wrapped": {"x":1}}');
  });

  it('applies response VTL template to upstream body before returning', async () => {
    mockFetch.mockResolvedValueOnce(new Response('{"upstream":42}', { status: 200 }));
    const outcome = await dispatchHttpIntegration(
      {
        kind: 'http',
        uri: 'http://upstream/api',
        responses: [
          {
            StatusCode: '200',
            ResponseTemplates: {
              'application/json': '{"value": $input.json("$.upstream")}',
            },
          },
        ],
      },
      buildRequest(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pool: {} as ContainerPool, rieTimeoutMs: 30_000, fetch: mockFetch as any }
    );
    expect(outcome.statusCode).toBe(200);
    expect(String(outcome.body)).toBe('{"value": 42}');
  });
});

describe('dispatchAwsLambdaIntegration', () => {
  beforeEach(() => {
    vi.mocked(invokeRie).mockReset();
  });

  function buildPool(): ContainerPool {
    // Minimal pool mock — `acquire` returns a handle the dispatcher
    // hands to the mocked `invokeRie`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return {
      acquire: vi.fn(async () => ({ containerHost: '127.0.0.1', hostPort: 9000 })),
      release: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  it('transforms request via VTL and applies response template', async () => {
    vi.mocked(invokeRie).mockResolvedValueOnce({
      payload: { result: 'ok' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const pool = buildPool();
    const outcome = await dispatchAwsLambdaIntegration(
      {
        kind: 'aws-lambda',
        lambdaLogicalId: 'MyHandler',
        requestTemplates: {
          'application/json': '{"action": "$input.params(\'action\')"}',
        },
        responses: [
          {
            StatusCode: '200',
            ResponseTemplates: { 'application/json': 'value=$input.json("$.result")' },
          },
        ],
      },
      buildRequest({
        querystring: { action: 'compute' },
        headers: { 'content-type': 'application/json' },
      }),
      { pool, rieTimeoutMs: 30_000 }
    );
    expect(outcome.statusCode).toBe(200);
    expect(String(outcome.body)).toBe('value="ok"');

    const invoked = vi.mocked(invokeRie).mock.calls[0]?.[2];
    expect(invoked).toEqual({ action: 'compute' });
  });

  it('routes Lambda errorMessage via SelectionPattern', async () => {
    vi.mocked(invokeRie).mockResolvedValueOnce({
      payload: { errorMessage: 'NotFoundError: item missing', errorType: 'NotFoundError' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const outcome = await dispatchAwsLambdaIntegration(
      {
        kind: 'aws-lambda',
        lambdaLogicalId: 'MyHandler',
        responses: [
          { StatusCode: '200' },
          { StatusCode: '404', SelectionPattern: '.*NotFoundError.*' },
        ],
      },
      buildRequest(),
      { pool: buildPool(), rieTimeoutMs: 30_000 }
    );
    expect(outcome.statusCode).toBe(404);
  });

  it('returns 502 when container acquire fails', async () => {
    const pool = {
      acquire: vi.fn(async () => {
        throw new Error('no container');
      }),
      release: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as ContainerPool;
    const outcome = await dispatchAwsLambdaIntegration(
      { kind: 'aws-lambda', lambdaLogicalId: 'X', responses: [] },
      buildRequest(),
      { pool, rieTimeoutMs: 30_000 }
    );
    expect(outcome.statusCode).toBe(502);
    expect(String(outcome.body)).toContain('no container');
  });
});

describe('substituteUriPlaceholders', () => {
  it('substitutes {param} with path-parameter values', () => {
    const out = substituteUriPlaceholders(
      'http://x/items/{id}/things/{name}',
      buildRequest({ pathParameters: { id: '42', name: 'alice' } })
    );
    expect(out).toBe('http://x/items/42/things/alice');
  });
  it('URL-encodes substituted values', () => {
    const out = substituteUriPlaceholders(
      'http://x/items/{id}',
      buildRequest({ pathParameters: { id: 'a b/c' } })
    );
    expect(out).toBe('http://x/items/a%20b%2Fc');
  });
  it('emits empty string for missing path params', () => {
    const out = substituteUriPlaceholders('http://x/items/{missing}/X', buildRequest());
    expect(out).toBe('http://x/items//X');
  });
});
