/**
 * Unit tests for the Issue (#507) follow-up fixes against
 * `src/local/rest-v1-integrations.ts` + `src/local/integration-response-selector.ts`
 * + `src/local/vtl-engine.ts`. Each test maps 1:1 to a numbered item in
 * issue (#507).
 *
 * The existing `rest-v1-integrations.test.ts` covers the broader dispatcher
 * surface and is intentionally not mutated here to avoid disturbing its
 * mocks; this file lives separately so the issue (#507) changes have a
 * dedicated coverage anchor.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockSend: _unused, debugSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  debugSpy: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

vi.mock('../../../src/local/rie-client.js', () => ({
  invokeRie: vi.fn(),
}));

import { invokeRie } from '../../../src/local/rie-client.js';
import type { ContainerPool } from '../../../src/local/container-pool.js';
import {
  dispatchAwsLambdaIntegration,
  dispatchMockIntegration,
  type RestV1IntegrationRequest,
} from '../../../src/local/rest-v1-integrations.js';
import { selectIntegrationResponse } from '../../../src/local/integration-response-selector.js';
import { buildVtlInput, VtlEvaluationError } from '../../../src/local/vtl-engine.js';
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

describe('Issue (#507) item 1: dispatchAwsLambdaIntegration release in finally', () => {
  beforeEach(() => {
    vi.mocked(invokeRie).mockReset();
  });

  it('releases the container even when VTL response-template evaluation throws after a successful invoke', async () => {
    // Make the invoke succeed but the response template explode at
    // evaluation time. Pre-fix, the synchronous evaluateVtl throw would
    // skip the `pool.release(handle)` call entirely (the release was
    // emitted just before the success return, after the try/catch around
    // invokeRie).
    vi.mocked(invokeRie).mockResolvedValueOnce({
      payload: { greeting: 'hi' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const releaseSpy = vi.fn();
    const handle = { containerHost: '127.0.0.1', hostPort: 9000 };
    const pool = {
      acquire: vi.fn(async () => handle),
      release: releaseSpy,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as ContainerPool;
    const outcome = await dispatchAwsLambdaIntegration(
      {
        kind: 'aws-lambda',
        lambdaLogicalId: 'X',
        responses: [
          {
            StatusCode: '200',
            // `#macro` is an explicitly-unsupported VTL directive — the
            // evaluator throws VtlEvaluationError at evaluation time.
            ResponseTemplates: { 'application/json': '#macro(unused)x#end' },
          },
        ],
      },
      buildRequest({ headers: { accept: 'application/json' } }),
      { pool, rieTimeoutMs: 30_000 }
    );
    // Outcome routed through `vtlFailure` (502); the important assertion
    // is that release() ran exactly once with the original handle despite
    // the throw on the synchronous evaluateVtl path.
    expect(outcome.statusCode).toBe(502);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledWith(handle);
  });

  it('releases on the invokeRie error path (no double-release)', async () => {
    // The invokeRie rejection lands in the inner catch, which returns
    // 502 inside the outer try; the outer finally then releases. The
    // pre-fix path also released here, so this test guards against a
    // regression where the refactor accidentally introduces double-release.
    vi.mocked(invokeRie).mockRejectedValueOnce(new Error('boom'));
    const releaseSpy = vi.fn();
    const handle = { containerHost: '127.0.0.1', hostPort: 9000 };
    const pool = {
      acquire: vi.fn(async () => handle),
      release: releaseSpy,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as ContainerPool;
    const outcome = await dispatchAwsLambdaIntegration(
      { kind: 'aws-lambda', lambdaLogicalId: 'X', responses: [] },
      buildRequest(),
      { pool, rieTimeoutMs: 30_000 }
    );
    expect(outcome.statusCode).toBe(502);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT release when acquire fails (nothing to release)', async () => {
    const releaseSpy = vi.fn();
    const pool = {
      acquire: vi.fn(async () => {
        throw new Error('no container');
      }),
      release: releaseSpy,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as ContainerPool;
    const outcome = await dispatchAwsLambdaIntegration(
      { kind: 'aws-lambda', lambdaLogicalId: 'X', responses: [] },
      buildRequest(),
      { pool, rieTimeoutMs: 30_000 }
    );
    expect(outcome.statusCode).toBe(502);
    expect(releaseSpy).not.toHaveBeenCalled();
  });
});

describe('Issue (#507) item 3: extractStatusCodeFromRendered debug log on fallback', () => {
  beforeEach(() => {
    debugSpy.mockReset();
  });

  it('emits a debug log naming the offending rendered output when JSON.parse fails', () => {
    // Non-JSON request template — `JSON.parse` throws and the helper
    // returns `undefined`, so the dispatcher falls back to the default
    // entry. The debug log is the new signal users get to diagnose why
    // their MOCK selection driver was unparseable.
    const outcome = dispatchMockIntegration(
      {
        kind: 'mock',
        requestTemplate: 'not json at all',
        responses: [
          {
            StatusCode: '200',
            ResponseTemplates: { 'application/json': '{"hit":"default"}' },
          },
        ],
      },
      buildRequest()
    );
    expect(outcome.statusCode).toBe(200);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    const message = debugSpy.mock.calls[0]?.[0] as string;
    expect(message).toMatch(/rendered output is not valid JSON/);
    expect(message).toMatch(/not json at all/);
  });

  it('emits a debug log when the JSON object has no statusCode field', () => {
    const outcome = dispatchMockIntegration(
      {
        kind: 'mock',
        requestTemplate: '{"otherKey": 1}',
        responses: [{ StatusCode: '200', ResponseTemplates: { 'application/json': 'ok' } }],
      },
      buildRequest()
    );
    expect(outcome.statusCode).toBe(200);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy.mock.calls[0]?.[0] as string).toMatch(/no statusCode field/);
  });

  it('truncates the rendered output at 200 chars in the debug log', () => {
    const huge = 'A'.repeat(500);
    dispatchMockIntegration(
      {
        kind: 'mock',
        requestTemplate: huge,
        responses: [],
      },
      buildRequest()
    );
    expect(debugSpy).toHaveBeenCalledTimes(1);
    const message = debugSpy.mock.calls[0]?.[0] as string;
    // 200 chars of A + ellipsis marker
    expect(message).toContain('A'.repeat(200) + '...');
    expect(message).not.toContain('A'.repeat(201));
  });
});

describe('Issue (#507) item 4: MOCK Content-Type omitted on empty body', () => {
  it('drops Content-Type when body is empty AND no ResponseTemplate matched', () => {
    // Responses list exists but no `ResponseTemplates['application/json']`
    // (or any Accept-matching entry), so the dispatcher falls through to
    // body = '' with the default content-type. AWS API Gateway omits
    // Content-Type on this surface; we mirror that.
    const outcome = dispatchMockIntegration(
      {
        kind: 'mock',
        requestTemplate: undefined,
        responses: [{ StatusCode: '204' }],
      },
      buildRequest()
    );
    expect(outcome.statusCode).toBe(204);
    expect(outcome.body).toBe('');
    expect(outcome.headers['content-type']).toBeUndefined();
  });

  it('keeps Content-Type when body is non-empty', () => {
    // Smoke test — the regression risk is that the new branch over-fires
    // and drops Content-Type on responses that DO emit a body.
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
    expect(outcome.body).toBe('{"ok":true}');
    expect(outcome.headers['content-type']).toBe('application/json');
  });

  it('preserves Content-Type set by a literal ResponseParameter override even on empty body', () => {
    // Defensive: a template may set an explicit Content-Type via
    // ResponseParameters even when the body is empty (some clients require
    // it). The drop should only happen on the default-initializer Content-Type,
    // not on a literal overlay.
    const outcome = dispatchMockIntegration(
      {
        kind: 'mock',
        requestTemplate: undefined,
        responses: [
          {
            StatusCode: '204',
            ResponseParameters: {
              'method.response.header.Content-Type': "'text/plain'",
            },
          },
        ],
      },
      buildRequest()
    );
    expect(outcome.body).toBe('');
    // PR #511 review fix-back: ResponseParameters keys are lowercased at
    // the overlay layer so the merge with the dispatcher's
    // default-initializer (`headers['content-type']`) collapses to one
    // entry instead of producing `content-type` AND `Content-Type` side
    // by side. The overlay's literal value wins (matches AWS-deployed
    // single-header semantics).
    expect(outcome.headers['content-type']).toBe('text/plain');
    expect(outcome.headers['Content-Type']).toBeUndefined();
  });

  it('PR #511 review fix-back: case-distinct keys collapse on non-empty body', () => {
    // Regression guard: a non-empty body case used to leak
    // `headers['content-type'] = 'application/json'` (default) AND
    // `headers['Content-Type'] = 'text/xml'` (overlay) side by side,
    // resulting in two conflicting headers reaching the wire. With
    // the lowercase normalization at the overlay layer the two entries
    // collapse to a single `content-type` and the overlay value wins.
    const outcome = dispatchMockIntegration(
      {
        kind: 'mock',
        requestTemplate: undefined,
        responses: [
          {
            StatusCode: '200',
            ResponseTemplates: { 'application/json': 'hello world' },
            ResponseParameters: {
              'method.response.header.Content-Type': "'text/xml'",
            },
          },
        ],
      },
      buildRequest()
    );
    expect(outcome.body).toBe('hello world');
    expect(outcome.headers['content-type']).toBe('text/xml');
    expect(outcome.headers['Content-Type']).toBeUndefined();
  });
});

describe('Issue (#507) item 6: Number.isInteger rejects malformed status codes', () => {
  it('extractStatusCodeFromRendered rejects "200abc" (no truncation)', () => {
    // Pre-fix, `Number.parseInt("200abc", 10)` returned 200 and the entry
    // for StatusCode "200" silently won. Post-fix the value is rejected
    // and the dispatcher falls back to the default entry (the entry with
    // SelectionPattern === '' OR undefined; `defaultResponseEntry` in
    // `rest-v1-integrations.ts`). To make the test unambiguous, the 200
    // entry uses a non-default SelectionPattern so the fallback target
    // (500 entry with empty SelectionPattern) is the only default
    // candidate.
    const outcome = dispatchMockIntegration(
      {
        kind: 'mock',
        requestTemplate: '{"statusCode": "200abc"}',
        responses: [
          {
            StatusCode: '200',
            SelectionPattern: '2\\d{2}', // non-empty pattern — NOT the default entry
            ResponseTemplates: { 'application/json': 'success' },
          },
          {
            StatusCode: '500',
            ResponseTemplates: { 'application/json': 'default' },
            SelectionPattern: '', // empty SelectionPattern marks the default
          },
        ],
      },
      buildRequest()
    );
    // Falls back to the default entry (StatusCode 500), not the 200 entry.
    expect(outcome.statusCode).toBe(500);
    expect(outcome.body).toBe('default');
  });

  it('extractStatusCodeFromRendered accepts integer-valued statusCode', () => {
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
  });

  it('extractStatusCodeFromRendered rejects fractional statusCode', () => {
    // A fractional value like 200.5 is also not a valid HTTP status code;
    // `Number.isInteger` rejects it, falling back to the default entry.
    const outcome = dispatchMockIntegration(
      {
        kind: 'mock',
        requestTemplate: '{"statusCode": 200.5}',
        responses: [
          {
            StatusCode: '200',
            SelectionPattern: '2\\d{2}', // non-default
            ResponseTemplates: { 'application/json': 'two-hundred' },
          },
          {
            StatusCode: '500',
            ResponseTemplates: { 'application/json': 'default' },
            SelectionPattern: '', // default
          },
        ],
      },
      buildRequest()
    );
    expect(outcome.statusCode).toBe(500);
  });

  it('selectIntegrationResponse parseStatus rejects "200abc" StatusCode', () => {
    // Same shape on the integration-response-selector side: a malformed
    // StatusCode in the entry itself falls back to the caller's
    // fallbackStatusCode rather than silently parsing to 200.
    const result = selectIntegrationResponse(
      [
        {
          StatusCode: '200abc',
          SelectionPattern: '.*',
          ResponseTemplates: { 'application/json': 'never returned' },
        },
      ],
      'whatever',
      599 // fallback marker
    );
    expect(result.entry).not.toBeNull();
    // parseStatus rejected "200abc" so the picked entry's effective status
    // falls back to the caller-supplied fallback (599 here as a marker).
    expect(result.statusCode).toBe(599);
  });

  it('selectIntegrationResponse parseStatus accepts integer-valued StatusCode', () => {
    const result = selectIntegrationResponse(
      [{ StatusCode: '404', SelectionPattern: '.*' }],
      'whatever',
      200
    );
    expect(result.statusCode).toBe(404);
  });

  // ==================== PR #511 review fix-back =========================
  // The pre-review-fix `Number(...) + Number.isInteger(...)` validation
  // accepted empty strings (Number("") === 0), whitespace-only strings,
  // negative numbers, and out-of-range integers. Tighten the range guard
  // to HTTP status [100, 600) and reject empty / whitespace input.

  it('selectIntegrationResponse parseStatus rejects empty-string StatusCode', () => {
    // Number("") === 0 — pre-fix this passed `Number.isInteger` and the
    // dispatcher emitted HTTP 0 response code. Post-fix it falls back.
    const result = selectIntegrationResponse(
      [{ StatusCode: '', SelectionPattern: '.*' }],
      'whatever',
      599 // fallback marker
    );
    expect(result.statusCode).toBe(599);
  });

  it('selectIntegrationResponse parseStatus rejects whitespace-only StatusCode', () => {
    // Number(" ") === 0 — same shape as empty string.
    const result = selectIntegrationResponse(
      [{ StatusCode: '   ', SelectionPattern: '.*' }],
      'whatever',
      599
    );
    expect(result.statusCode).toBe(599);
  });

  it('selectIntegrationResponse parseStatus rejects negative StatusCode', () => {
    // Number("-1") === -1 passes Number.isInteger but is not a valid
    // HTTP status code. Range guard at [100, 600) rejects it.
    const result = selectIntegrationResponse(
      [{ StatusCode: '-1', SelectionPattern: '.*' }],
      'whatever',
      599
    );
    expect(result.statusCode).toBe(599);
  });

  it('selectIntegrationResponse parseStatus rejects out-of-range StatusCode (>=600)', () => {
    const result = selectIntegrationResponse(
      [{ StatusCode: '999', SelectionPattern: '.*' }],
      'whatever',
      599
    );
    expect(result.statusCode).toBe(599);
  });

  it('selectIntegrationResponse parseStatus rejects below-range StatusCode (<100)', () => {
    // Number("16") === 16 passes Number.isInteger but is not a valid
    // HTTP status code (Number("0x10") === 16 also lands here).
    const result = selectIntegrationResponse(
      [{ StatusCode: '99', SelectionPattern: '.*' }],
      'whatever',
      599
    );
    expect(result.statusCode).toBe(599);
  });

  it('selectIntegrationResponse parseStatus accepts boundary 100', () => {
    const result = selectIntegrationResponse(
      [{ StatusCode: '100', SelectionPattern: '.*' }],
      'whatever',
      599
    );
    expect(result.statusCode).toBe(100);
  });

  it('selectIntegrationResponse parseStatus accepts boundary 599', () => {
    const result = selectIntegrationResponse(
      [{ StatusCode: '599', SelectionPattern: '.*' }],
      'whatever',
      200
    );
    expect(result.statusCode).toBe(599);
  });

  it('extractStatusCodeFromRendered rejects empty-string statusCode', () => {
    const outcome = dispatchMockIntegration(
      {
        kind: 'mock',
        requestTemplate: '{"statusCode": ""}',
        responses: [
          {
            StatusCode: '200',
            SelectionPattern: '2\\d{2}', // non-default
            ResponseTemplates: { 'application/json': 'success' },
          },
          {
            StatusCode: '500',
            ResponseTemplates: { 'application/json': 'default' },
            SelectionPattern: '', // default
          },
        ],
      },
      buildRequest()
    );
    expect(outcome.statusCode).toBe(500);
  });

  it('extractStatusCodeFromRendered rejects negative statusCode', () => {
    const outcome = dispatchMockIntegration(
      {
        kind: 'mock',
        requestTemplate: '{"statusCode": -1}',
        responses: [
          {
            StatusCode: '200',
            SelectionPattern: '2\\d{2}', // non-default
            ResponseTemplates: { 'application/json': 'success' },
          },
          {
            StatusCode: '500',
            ResponseTemplates: { 'application/json': 'default' },
            SelectionPattern: '', // default
          },
        ],
      },
      buildRequest()
    );
    expect(outcome.statusCode).toBe(500);
  });

  it('extractStatusCodeFromRendered rejects out-of-range statusCode (999)', () => {
    const outcome = dispatchMockIntegration(
      {
        kind: 'mock',
        requestTemplate: '{"statusCode": 999}',
        responses: [
          {
            StatusCode: '200',
            SelectionPattern: '2\\d{2}', // non-default
            ResponseTemplates: { 'application/json': 'success' },
          },
          {
            StatusCode: '500',
            ResponseTemplates: { 'application/json': 'default' },
            SelectionPattern: '', // default
          },
        ],
      },
      buildRequest()
    );
    expect(outcome.statusCode).toBe(500);
  });
});

describe('Issue (#507) item 7: VTL $input.json against non-JSON body', () => {
  it('throws VtlEvaluationError on non-JSON body via $input.json("$")', () => {
    // The lazyJson(opts.throwOnParseError=true) path fires only on the
    // JSON entry point — `$input.json(...)`.
    const input = buildVtlInput('this is not JSON', {}, {}, {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => (input as any).json('$')).toThrow(VtlEvaluationError);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => (input as any).json('$')).toThrow(/non-JSON|valid JSON|Invalid JSON/);
  });

  it('$input.path("$") returns null on non-JSON body (lenient, pre-fix behavior preserved)', () => {
    const input = buildVtlInput('this is not JSON', {}, {}, {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = (input as any).path('$');
    expect(v).toBeNull();
  });

  it('$input.json works fine on valid JSON body', () => {
    const input = buildVtlInput('{"a":1}', {}, {}, {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((input as any).json('$.a')).toBe('1');
  });

  it('$input.json on empty body returns "null" (no error — empty is treated as null root)', () => {
    const input = buildVtlInput('', {}, {}, {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((input as any).json('$')).toBe('null');
  });
});
