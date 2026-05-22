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
  classifyInternalHost,
  dispatchAwsLambdaIntegration,
  dispatchHttpIntegration,
  dispatchHttpProxyIntegration,
  dispatchMockIntegration,
  isTextLikeContentType,
  substituteUriPlaceholders,
  warnSsrfRiskyUri,
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
  it('applies ResponseParameters header literals (key lowercased — PR #511 review fix-back)', () => {
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
    // PR #511 review fix-back: ResponseParameters keys are lowercased so
    // overlays share the dispatcher's default-initializer namespace and
    // PascalCase / lowercase variants of the same header no longer
    // coexist as separate keys in the output map.
    expect(outcome.headers['x-powered-by']).toBe('cdkd-local');
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

// ====================================================================
// PR #505 review fixes
// ====================================================================

describe('Fix 1: body forwarding gate (HTTP_PROXY + HTTP)', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
  });

  it('HTTP_PROXY forwards body on GET when client sent one (no method gate)', async () => {
    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await dispatchHttpProxyIntegration(
      { kind: 'http-proxy', uri: 'http://example.com/api', responses: [] },
      buildRequest({ method: 'GET', body: Buffer.from('{"q":"data"}') }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pool: {} as ContainerPool, rieTimeoutMs: 30_000, fetch: mockFetch as any }
    );
    const init = mockFetch.mock.calls[0]?.[1];
    expect(init?.body).toBeDefined();
  });

  it('HTTP_PROXY does NOT forward body when client body is empty', async () => {
    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await dispatchHttpProxyIntegration(
      { kind: 'http-proxy', uri: 'http://example.com/api', responses: [] },
      buildRequest({ method: 'POST', body: Buffer.from('') }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pool: {} as ContainerPool, rieTimeoutMs: 30_000, fetch: mockFetch as any }
    );
    const init = mockFetch.mock.calls[0]?.[1];
    expect(init?.body).toBeUndefined();
  });

  it('HTTP_PROXY forwards body when integration overrides method to GET', async () => {
    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await dispatchHttpProxyIntegration(
      {
        kind: 'http-proxy',
        uri: 'http://example.com/api',
        integrationHttpMethod: 'GET',
        responses: [],
      },
      buildRequest({ method: 'POST', body: Buffer.from('{"x":1}') }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pool: {} as ContainerPool, rieTimeoutMs: 30_000, fetch: mockFetch as any }
    );
    const init = mockFetch.mock.calls[0]?.[1];
    // Body forwarded even though upstream method is GET.
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeDefined();
  });

  it('HTTP_PROXY strips content-length from forwarded headers', async () => {
    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await dispatchHttpProxyIntegration(
      { kind: 'http-proxy', uri: 'http://example.com/api', responses: [] },
      buildRequest({
        method: 'POST',
        body: Buffer.from('{"x":1}'),
        headers: { 'content-length': '999', 'content-type': 'application/json' },
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pool: {} as ContainerPool, rieTimeoutMs: 30_000, fetch: mockFetch as any }
    );
    const init = mockFetch.mock.calls[0]?.[1];
    const headers = init?.headers as Record<string, string>;
    expect(headers['content-length']).toBeUndefined();
    expect(headers['content-type']).toBe('application/json');
  });

  it('HTTP non-proxy forwards body on GET when VTL render is non-empty', async () => {
    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await dispatchHttpIntegration(
      {
        kind: 'http',
        uri: 'http://upstream/api',
        integrationHttpMethod: 'GET',
        requestTemplates: { 'application/json': '{"wrapped": true}' },
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
    const init = mockFetch.mock.calls[0]?.[1];
    expect(init?.method).toBe('GET');
    expect(init?.body).toBe('{"wrapped": true}');
  });
});

describe('Fix 5: HTTP_PROXY strips content-encoding from upstream headers', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
  });

  it('removes content-encoding header set on the upstream Response', async () => {
    // Construct a Response that carries `content-encoding: gzip` even
    // though the body is already-decoded plaintext (mirrors fetch's
    // post-decode invariant).
    mockFetch.mockResolvedValueOnce(
      new Response('decoded plaintext', {
        status: 200,
        headers: {
          'content-encoding': 'gzip',
          'content-length': '999',
          'content-type': 'text/plain',
        },
      })
    );
    const outcome = await dispatchHttpProxyIntegration(
      { kind: 'http-proxy', uri: 'http://example.com/api', responses: [] },
      buildRequest(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pool: {} as ContainerPool, rieTimeoutMs: 30_000, fetch: mockFetch as any }
    );
    expect(outcome.headers['content-encoding']).toBeUndefined();
    expect(outcome.headers['content-length']).toBeUndefined();
    expect(outcome.headers['content-type']).toBe('text/plain');
  });
});

describe('Fix 6: HTTP non-proxy branches on upstream content-type', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
  });

  it('reads text upstream body as text (.text())', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('hello world', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })
    );
    const outcome = await dispatchHttpIntegration(
      { kind: 'http', uri: 'http://upstream/api', responses: [] },
      buildRequest(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pool: {} as ContainerPool, rieTimeoutMs: 30_000, fetch: mockFetch as any }
    );
    expect(outcome.body).toBe('hello world');
    expect(typeof outcome.body).toBe('string');
  });

  it('reads binary upstream body as a Buffer (no UTF-8 corruption)', async () => {
    // 0xFF / 0xFE are invalid UTF-8 lead bytes; .text() would corrupt
    // them. Use arrayBuffer + content-type=octet-stream to exercise the
    // binary branch.
    const binary = Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x01, 0x02]);
    mockFetch.mockResolvedValueOnce(
      new Response(binary as unknown as BodyInit, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })
    );
    const outcome = await dispatchHttpIntegration(
      { kind: 'http', uri: 'http://upstream/api', responses: [] },
      buildRequest(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pool: {} as ContainerPool, rieTimeoutMs: 30_000, fetch: mockFetch as any }
    );
    expect(Buffer.isBuffer(outcome.body)).toBe(true);
    expect(Buffer.compare(outcome.body as Buffer, binary)).toBe(0);
  });

  it('handles binary upstream with a ResponseTemplate by passing the bytes through (warn-and-skip VTL)', async () => {
    const binary = Buffer.from([0xff, 0xfe, 0xfd]);
    mockFetch.mockResolvedValueOnce(
      new Response(binary as unknown as BodyInit, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })
    );
    const outcome = await dispatchHttpIntegration(
      {
        kind: 'http',
        uri: 'http://upstream/api',
        responses: [
          {
            StatusCode: '200',
            ResponseTemplates: { 'application/json': '{"vtl":"would-run"}' },
          },
        ],
      },
      buildRequest(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pool: {} as ContainerPool, rieTimeoutMs: 30_000, fetch: mockFetch as any }
    );
    // VTL was skipped → body is the raw binary, not the template output.
    expect(Buffer.isBuffer(outcome.body)).toBe(true);
  });

  describe('isTextLikeContentType', () => {
    it.each([
      ['text/plain', true],
      ['text/html; charset=utf-8', true],
      ['application/json', true],
      ['application/json; charset=utf-8', true],
      ['application/xml', true],
      ['application/x-www-form-urlencoded', true],
      ['application/javascript', true],
      ['application/ld+json', true],
      ['application/vnd.api+json', true],
      ['application/vnd.foo+xml', true],
      ['application/octet-stream', false],
      ['image/png', false],
      ['image/jpeg', false],
      ['video/mp4', false],
      ['application/pdf', false],
      ['application/zip', false],
    ])('isTextLikeContentType(%s) === %s', (ct, expected) => {
      expect(isTextLikeContentType(ct)).toBe(expected);
    });
  });
});

describe('Fix 14: SelectionPattern runs on upstream OK status (HTTP_PROXY)', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
  });

  it('matches a SelectionPattern: 200 entry against a 200 upstream', async () => {
    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const outcome = await dispatchHttpProxyIntegration(
      {
        kind: 'http-proxy',
        uri: 'http://example.com/api',
        responses: [
          { StatusCode: '500' /* default — would have won pre-fix */ },
          { StatusCode: '202', SelectionPattern: '200' },
        ],
      },
      buildRequest(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pool: {} as ContainerPool, rieTimeoutMs: 30_000, fetch: mockFetch as any }
    );
    expect(outcome.statusCode).toBe(202);
  });

  it('still falls to default when no SelectionPattern matches the status', async () => {
    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const outcome = await dispatchHttpProxyIntegration(
      {
        kind: 'http-proxy',
        uri: 'http://example.com/api',
        responses: [
          { StatusCode: '200' /* default */ },
          { StatusCode: '503', SelectionPattern: '5\\d\\d' },
        ],
      },
      buildRequest(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pool: {} as ContainerPool, rieTimeoutMs: 30_000, fetch: mockFetch as any }
    );
    expect(outcome.statusCode).toBe(200);
  });
});

describe('Fix 2: SSRF warning helpers', () => {
  describe('classifyInternalHost', () => {
    it.each([
      ['169.254.169.254', 'AWS IMDS'],
      ['127.0.0.1', 'IPv4 loopback'],
      ['127.42.7.9', 'IPv4 loopback'],
      ['::1', 'IPv6 loopback'],
      ['169.254.5.5', 'IPv4 link-local'],
      ['fe80::1', 'IPv6 link-local'],
      ['10.0.0.1', 'RFC1918 private (10.'],
      ['10.255.255.255', 'RFC1918 private (10.'],
      ['172.16.0.1', 'RFC1918 private (172.16'],
      ['172.31.255.254', 'RFC1918 private (172.16'],
      ['192.168.1.1', 'RFC1918 private (192.168'],
    ])('classifies %s as internal', (host, expectedSubstring) => {
      const result = classifyInternalHost(host);
      expect(result).toBeDefined();
      expect(result).toContain(expectedSubstring);
    });

    it.each([
      'example.com',
      'api.example.com',
      '8.8.8.8',
      '1.1.1.1',
      '172.32.0.1', // OUTSIDE 172.16-172.31
      '172.15.0.1', // OUTSIDE the range too
      '11.0.0.1', // OUTSIDE 10.0.0.0/8 boundary
    ])('returns undefined for safe host %s', (host) => {
      expect(classifyInternalHost(host)).toBeUndefined();
    });
  });

  describe('warnSsrfRiskyUri', () => {
    it('emits a warn for an IMDS URI', () => {
      const warns: string[] = [];
      warnSsrfRiskyUri('http://169.254.169.254/latest/meta-data/', 'GET /imds', (m) =>
        warns.push(m)
      );
      expect(warns.length).toBe(1);
      expect(warns[0]).toMatch(/AWS IMDS/);
      expect(warns[0]).toMatch(/GET \/imds/);
    });
    it('emits no warn for a public DNS URI', () => {
      const warns: string[] = [];
      warnSsrfRiskyUri('https://api.example.com/v1/things', 'GET /things', (m) =>
        warns.push(m)
      );
      expect(warns.length).toBe(0);
    });
    it('tolerates {placeholder} path segments without crashing', () => {
      const warns: string[] = [];
      warnSsrfRiskyUri(
        'http://10.0.0.1/users/{userId}',
        'GET /users/{userId}',
        (m) => warns.push(m)
      );
      expect(warns.length).toBe(1);
      expect(warns[0]).toMatch(/RFC1918/);
    });
    it('silently skips malformed URIs (route discovery handles them)', () => {
      const warns: string[] = [];
      warnSsrfRiskyUri('not-a-url', 'GET /broken', (m) => warns.push(m));
      expect(warns.length).toBe(0);
    });
    it('emits a warn for IPv6 loopback', () => {
      const warns: string[] = [];
      warnSsrfRiskyUri('http://[::1]/health', 'GET /health', (m) => warns.push(m));
      expect(warns.length).toBe(1);
      expect(warns[0]).toMatch(/IPv6 loopback/);
    });
  });
});

