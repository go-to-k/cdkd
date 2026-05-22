/**
 * Unit tests for IntegrationResponses[] selection logic (#457).
 *
 * Covers `selectIntegrationResponse`, `evaluateResponseParameters`, and
 * `pickResponseTemplate` from `src/local/integration-response-selector.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  evaluateResponseParameters,
  pickResponseTemplate,
  selectIntegrationResponse,
  type IntegrationResponseEntry,
} from '../../../src/local/integration-response-selector.js';

describe('selectIntegrationResponse', () => {
  const responses: IntegrationResponseEntry[] = [
    { StatusCode: '200' /* default — no SelectionPattern */ },
    { StatusCode: '404', SelectionPattern: '.*Not Found.*' },
    { StatusCode: '500', SelectionPattern: '.*Internal.*' },
  ];

  it('returns default entry on success outcome', () => {
    const r = selectIntegrationResponse(responses, { kind: 'success' });
    expect(r.statusCode).toBe(200);
    expect(r.entry?.StatusCode).toBe('200');
  });
  it('picks regex-matching entry on error', () => {
    const r = selectIntegrationResponse(responses, {
      kind: 'error',
      matchTarget: 'Item Not Found locally',
    });
    expect(r.statusCode).toBe(404);
  });
  it('falls back to default on error when no pattern matches', () => {
    const r = selectIntegrationResponse(responses, {
      kind: 'error',
      matchTarget: 'something else',
    });
    expect(r.statusCode).toBe(200);
  });
  it('returns null entry + 200 when entries array is undefined', () => {
    const r = selectIntegrationResponse(undefined, { kind: 'success' });
    expect(r.entry).toBeNull();
    expect(r.statusCode).toBe(200);
  });
  it('returns null entry + 500 when error has no entries', () => {
    const r = selectIntegrationResponse([], { kind: 'error', matchTarget: 'X' });
    expect(r.entry).toBeNull();
    expect(r.statusCode).toBe(200);
  });
  it('skips entries with invalid regex (does not abort)', () => {
    const r = selectIntegrationResponse(
      [
        { StatusCode: '200' },
        { StatusCode: '418', SelectionPattern: '[invalid(regex' },
        { StatusCode: '500', SelectionPattern: '.*Boom.*' },
      ],
      { kind: 'error', matchTarget: 'Boom!' }
    );
    expect(r.statusCode).toBe(500);
  });
  it('anchors regex with ^ and $', () => {
    const r = selectIntegrationResponse(
      [{ StatusCode: '404', SelectionPattern: 'Not Found' }],
      { kind: 'error', matchTarget: 'Not Found something' }
    );
    // 'Not Found' anchored should NOT match 'Not Found something'.
    expect(r.entry).toBeNull();
  });
});

describe('evaluateResponseParameters', () => {
  it('extracts single-quoted literal header values', () => {
    const out = evaluateResponseParameters({
      'method.response.header.X-Custom': "'literal-value'",
      'method.response.header.Content-Type': "'application/json'",
    });
    expect(out).toEqual({
      'X-Custom': 'literal-value',
      'Content-Type': 'application/json',
    });
  });
  it('skips and surfaces mapping expressions', () => {
    const seen: Array<{ key: string; reason: string }> = [];
    const out = evaluateResponseParameters(
      {
        'method.response.header.X': 'integration.response.body.field',
        'method.response.header.Y': "'literal'",
      },
      { onUnsupported: (key, _v, reason) => seen.push({ key, reason }) }
    );
    expect(out).toEqual({ Y: 'literal' });
    expect(seen[0]?.key).toBe('method.response.header.X');
  });
  it('returns empty map when input undefined', () => {
    expect(evaluateResponseParameters(undefined)).toEqual({});
  });
  it('skips non-method.response.header keys', () => {
    const seen: string[] = [];
    const out = evaluateResponseParameters(
      { 'some.weird.key': "'value'" },
      { onUnsupported: (key) => seen.push(key) }
    );
    expect(out).toEqual({});
    expect(seen).toContain('some.weird.key');
  });
});

describe('pickResponseTemplate', () => {
  it('picks application/json by default', () => {
    const out = pickResponseTemplate(
      { 'application/json': '{}', 'text/plain': 'hi' },
      undefined
    );
    expect(out?.contentType).toBe('application/json');
  });
  it('respects Accept header when matching', () => {
    const out = pickResponseTemplate(
      { 'application/json': '{}', 'text/plain': 'hi' },
      'text/plain'
    );
    expect(out?.contentType).toBe('text/plain');
  });
  it('falls back to first when Accept does not match and no JSON entry', () => {
    const out = pickResponseTemplate({ 'text/xml': '<x/>' }, 'image/jpeg');
    expect(out?.contentType).toBe('text/xml');
  });
  it('returns undefined when input is empty', () => {
    expect(pickResponseTemplate(undefined, 'application/json')).toBeUndefined();
    expect(pickResponseTemplate({}, 'application/json')).toBeUndefined();
  });
});
