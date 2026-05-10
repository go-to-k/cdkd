import { describe, expect, it } from 'vitest';
import { translateLambdaResponse } from '../../../src/local/api-gateway-response.js';

describe('translateLambdaResponse — shaped', () => {
  it('passes statusCode / headers / body through', () => {
    const result = translateLambdaResponse(
      {
        statusCode: 201,
        headers: { 'Content-Type': 'application/json' },
        body: '{"ok":true}',
      },
      'v2'
    );
    expect(result.statusCode).toBe(201);
    expect(result.headers['content-type']).toBe('application/json');
    expect(result.body.toString('utf-8')).toBe('{"ok":true}');
  });

  it('decodes base64 body when isBase64Encoded is true', () => {
    const original = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const result = translateLambdaResponse(
      { statusCode: 200, body: original.toString('base64'), isBase64Encoded: true },
      'v2'
    );
    expect(Array.from(result.body)).toEqual(Array.from(original));
  });

  it('emits multiple Set-Cookie headers from the v2 cookies array (C5)', () => {
    const result = translateLambdaResponse(
      { statusCode: 200, body: 'ok', cookies: ['a=b', 'c=d'] },
      'v2'
    );
    expect(result.cookies).toEqual(['a=b', 'c=d']);
    expect(result.headers['set-cookie']).toBeUndefined();
  });

  it('v1 multiValueHeaders set-cookie maps to multiple Set-Cookie headers', () => {
    const result = translateLambdaResponse(
      {
        statusCode: 200,
        body: 'ok',
        multiValueHeaders: { 'Set-Cookie': ['a=b', 'c=d'] },
      },
      'v1'
    );
    expect(result.cookies).toEqual(['a=b', 'c=d']);
  });

  it('v1 set-cookie via single headers map is also lifted into cookies', () => {
    const result = translateLambdaResponse(
      { statusCode: 200, body: '', headers: { 'Set-Cookie': 'a=b' } },
      'v1'
    );
    expect(result.cookies).toEqual(['a=b']);
  });
});

describe('translateLambdaResponse — error envelope (C7)', () => {
  it('returns 502 with canonical body when payload has errorMessage and no statusCode', () => {
    const result = translateLambdaResponse(
      {
        errorMessage: 'oops',
        errorType: 'Error',
        stackTrace: ['Error: oops at ...'],
      },
      'v2'
    );
    expect(result.statusCode).toBe(502);
    expect(result.body.toString('utf-8')).toBe('{"message":"Internal server error"}');
    expect(result.headers['content-type']).toBe('application/json');
  });

  it('respects user payload that legitimately includes errorMessage AND statusCode', () => {
    const result = translateLambdaResponse(
      { statusCode: 400, body: '{"errorMessage":"validation"}', headers: {} },
      'v2'
    );
    expect(result.statusCode).toBe(400);
  });
});

describe('translateLambdaResponse — auto-format (C6)', () => {
  it('wraps a JSON object without statusCode as 200 + JSON body', () => {
    const result = translateLambdaResponse({ message: 'hello' }, 'v2');
    expect(result.statusCode).toBe(200);
    expect(result.headers['content-type']).toBe('application/json');
    expect(result.body.toString('utf-8')).toBe('{"message":"hello"}');
  });

  it('wraps an array without statusCode as 200 + JSON body', () => {
    const result = translateLambdaResponse([1, 2, 3], 'v2');
    expect(result.statusCode).toBe(200);
    expect(result.body.toString('utf-8')).toBe('[1,2,3]');
  });

  it('wraps a primitive value (number) as 200 + JSON body', () => {
    const result = translateLambdaResponse(42, 'v2');
    expect(result.statusCode).toBe(200);
    expect(result.body.toString('utf-8')).toBe('42');
  });
});
