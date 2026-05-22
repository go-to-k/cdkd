import { describe, expect, it } from 'vite-plus/test';
import {
  resolveSelectionExpression,
  resolveServiceIntegrationParameters,
  type RequestParameterContext,
} from '../../../src/local/parameter-mapping.js';

function makeCtx(overrides: Partial<RequestParameterContext> = {}): RequestParameterContext {
  return {
    headers: {},
    queryString: {},
    pathParameters: {},
    requestPath: '/',
    body: '',
    context: {},
    stageVariables: {},
    ...overrides,
  };
}

describe('resolveSelectionExpression — bare references', () => {
  it('resolves $request.header.X case-insensitively', () => {
    const ctx = makeCtx({ headers: { authorization: 'Bearer xyz' } });
    expect(resolveSelectionExpression('$request.header.Authorization', ctx)).toBe('Bearer xyz');
  });

  it('resolves $request.querystring.X case-sensitively', () => {
    const ctx = makeCtx({ queryString: { url: 'https://example.com', URL: 'OTHER' } });
    expect(resolveSelectionExpression('$request.querystring.url', ctx)).toBe('https://example.com');
    expect(resolveSelectionExpression('$request.querystring.URL', ctx)).toBe('OTHER');
  });

  it('resolves $request.path.X from extracted path parameters', () => {
    const ctx = makeCtx({ pathParameters: { id: '42' } });
    expect(resolveSelectionExpression('$request.path.id', ctx)).toBe('42');
  });

  it('resolves $request.path to the full request path', () => {
    const ctx = makeCtx({ requestPath: '/items/42' });
    expect(resolveSelectionExpression('$request.path', ctx)).toBe('/items/42');
  });

  it('resolves $request.body to the raw body string', () => {
    const ctx = makeCtx({ body: '{"foo":1}' });
    expect(resolveSelectionExpression('$request.body', ctx)).toBe('{"foo":1}');
  });

  it('resolves $request.body.<jsonpath> against parsed JSON', () => {
    const ctx = makeCtx({ body: '{"user":{"name":"Alice","age":30},"items":["a","b"]}' });
    expect(resolveSelectionExpression('$request.body.user.name', ctx)).toBe('Alice');
    expect(resolveSelectionExpression('$request.body.user.age', ctx)).toBe('30');
    expect(resolveSelectionExpression('$request.body.items[0]', ctx)).toBe('a');
    expect(resolveSelectionExpression('$request.body.items[1]', ctx)).toBe('b');
  });

  it('JSONPath: returns empty string for missing keys', () => {
    const ctx = makeCtx({ body: '{"x":1}' });
    expect(resolveSelectionExpression('$request.body.missing', ctx)).toBe('');
  });

  it('JSONPath: returns empty string for malformed JSON body', () => {
    const ctx = makeCtx({ body: 'not json' });
    expect(resolveSelectionExpression('$request.body.anything', ctx)).toBe('');
  });

  it('JSONPath: rejects recursive descent and filter expressions', () => {
    const ctx = makeCtx({ body: '{"x":1}' });
    expect(resolveSelectionExpression('$request.body..x', ctx)).toBe('');
    expect(resolveSelectionExpression('$request.body.x?(@.y)', ctx)).toBe('');
  });

  it('resolves $context.<key>', () => {
    const ctx = makeCtx({ context: { requestId: 'abc-123', 'identity.sourceIp': '1.2.3.4' } });
    expect(resolveSelectionExpression('$context.requestId', ctx)).toBe('abc-123');
    expect(resolveSelectionExpression('$context.identity.sourceIp', ctx)).toBe('1.2.3.4');
  });

  describe('$context.authorizer.X (closes #502)', () => {
    it('resolves $context.authorizer.principalId for Lambda authorizers', () => {
      const ctx = makeCtx({
        authorizer: { principalId: 'user-42', tier: 'pro' },
      });
      expect(resolveSelectionExpression('$context.authorizer.principalId', ctx)).toBe('user-42');
      expect(resolveSelectionExpression('$context.authorizer.tier', ctx)).toBe('pro');
    });

    it('resolves $context.authorizer.jwt.claims.X for JWT authorizers', () => {
      const ctx = makeCtx({
        authorizer: {
          jwt: {
            claims: { sub: 'cognito-user-id', email: 'a@example.com' },
            scopes: ['read', 'write'],
          },
        },
      });
      expect(resolveSelectionExpression('$context.authorizer.jwt.claims.sub', ctx)).toBe(
        'cognito-user-id'
      );
      expect(resolveSelectionExpression('$context.authorizer.jwt.claims.email', ctx)).toBe(
        'a@example.com'
      );
    });

    it('resolves $context.authorizer.claims.X for Cognito REST v1 authorizers', () => {
      const ctx = makeCtx({
        authorizer: {
          claims: { sub: 'cog-user', email: 'b@example.com' },
        },
      });
      expect(resolveSelectionExpression('$context.authorizer.claims.sub', ctx)).toBe('cog-user');
    });

    it('returns empty string for missing authorizer path', () => {
      const ctx = makeCtx({ authorizer: { principalId: 'u' } });
      expect(resolveSelectionExpression('$context.authorizer.missing', ctx)).toBe('');
      expect(resolveSelectionExpression('$context.authorizer.jwt.claims.sub', ctx)).toBe('');
    });

    it('returns empty string when no authorizer is attached', () => {
      const ctx = makeCtx();
      expect(resolveSelectionExpression('$context.authorizer.principalId', ctx)).toBe('');
      expect(resolveSelectionExpression('$context.authorizer.jwt.claims.sub', ctx)).toBe('');
    });

    it('stringifies non-string leaves (numbers, booleans, arrays, objects)', () => {
      const ctx = makeCtx({
        authorizer: {
          age: 42,
          isAdmin: true,
          roles: ['admin', 'user'],
          nested: { x: 1 },
        },
      });
      expect(resolveSelectionExpression('$context.authorizer.age', ctx)).toBe('42');
      expect(resolveSelectionExpression('$context.authorizer.isAdmin', ctx)).toBe('true');
      expect(resolveSelectionExpression('$context.authorizer.roles', ctx)).toBe('["admin","user"]');
      expect(resolveSelectionExpression('$context.authorizer.nested', ctx)).toBe('{"x":1}');
    });

    it('${...} interpolation works for $context.authorizer.X', () => {
      const ctx = makeCtx({
        authorizer: { jwt: { claims: { sub: 'user-42' } } },
      });
      expect(
        resolveSelectionExpression('prefix-${context.authorizer.jwt.claims.sub}-suffix', ctx)
      ).toBe('prefix-user-42-suffix');
    });
  });

  it('resolves $stageVariables.<key>', () => {
    const ctx = makeCtx({ stageVariables: { env: 'prod' } });
    expect(resolveSelectionExpression('$stageVariables.env', ctx)).toBe('prod');
  });

  it('unresolved reference (recognized prefix, absent key) → empty string', () => {
    const ctx = makeCtx();
    expect(resolveSelectionExpression('$request.querystring.missing', ctx)).toBe('');
    expect(resolveSelectionExpression('$request.header.missing', ctx)).toBe('');
  });

  it('unrecognized $-prefixed string → literal passthrough', () => {
    const ctx = makeCtx();
    expect(resolveSelectionExpression('$reqeust.X', ctx)).toBe('$reqeust.X');
  });

  it('plain literal string → returned verbatim', () => {
    const ctx = makeCtx();
    expect(resolveSelectionExpression('plain-literal', ctx)).toBe('plain-literal');
    expect(resolveSelectionExpression('', ctx)).toBe('');
  });
});

describe('resolveSelectionExpression — ${...} interpolation', () => {
  it('substitutes a single ${...} placeholder', () => {
    const ctx = makeCtx({ pathParameters: { id: '42' } });
    expect(resolveSelectionExpression('item-${request.path.id}', ctx)).toBe('item-42');
  });

  it('substitutes multiple placeholders with literal interleaved text', () => {
    const ctx = makeCtx({ pathParameters: { name: 'Alice' }, queryString: { id: '7' } });
    expect(
      resolveSelectionExpression('${request.path.name}: ${request.querystring.id}', ctx)
    ).toBe('Alice: 7');
  });

  it('absent placeholder → empty string inside template', () => {
    const ctx = makeCtx();
    expect(resolveSelectionExpression('[${request.querystring.x}]', ctx)).toBe('[]');
  });

  it('throws on unclosed ${...} interpolation', () => {
    const ctx = makeCtx();
    expect(() => resolveSelectionExpression('${request.path.id', ctx)).toThrow(/unclosed/);
  });
});

describe('resolveServiceIntegrationParameters', () => {
  it('resolves every value while preserving keys', () => {
    const ctx = makeCtx({
      queryString: { url: 'https://q', body: 'hi' },
      pathParameters: { id: '7' },
      body: '{"msg":"hello"}',
    });
    const outcome = resolveServiceIntegrationParameters(
      {
        QueueUrl: '$request.querystring.url',
        MessageBody: '$request.body.msg',
        SomePath: '/foo/${request.path.id}/bar',
        Literal: 'static',
      },
      ctx
    );
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      expect(outcome.resolved).toEqual({
        QueueUrl: 'https://q',
        MessageBody: 'hello',
        SomePath: '/foo/7/bar',
        Literal: 'static',
      });
    }
  });

  it('rejects non-string parameter values', () => {
    const outcome = resolveServiceIntegrationParameters({ X: 5 } as Record<string, unknown>, makeCtx());
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.reason).toContain('must be a string');
    }
  });

  it('passes the inner unclosed-interpolation error up', () => {
    const outcome = resolveServiceIntegrationParameters(
      { Body: 'hello-${request.path.id' },
      makeCtx()
    );
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.reason).toContain('unclosed');
      expect(outcome.reason).toContain('Body');
    }
  });
});
