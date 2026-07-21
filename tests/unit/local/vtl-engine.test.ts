/**
 * Unit tests for cdkd's minimal VTL engine (closes #457). Covers the
 * subset of AWS API Gateway VTL that `cdkd local start-api` REST v1
 * non-AWS_PROXY integrations rely on — `$input` / `$context` / `$util`
 * built-ins, `#set` / `#if` / `#foreach` directives, comparison
 * operators, and the supported JSONPath subset.
 */

import { describe, expect, it } from 'vite-plus/test';
import {
  applyJsonPath,
  buildDefaultUtil,
  buildVtlInput,
  buildVtlRequestContext,
  evaluateVtl,
  VtlEvaluationError,
  type VtlContext,
} from '../../../src/local/vtl-engine.js';

function buildContext(overrides: Partial<VtlContext> = {}): VtlContext {
  const input = buildVtlInput(
    overrides.input?.body ?? '',
    overrides.input?.headers ?? {},
    overrides.input?.querystring ?? {},
    overrides.input?.path ?? {}
  );
  const context =
    overrides.context ??
    buildVtlRequestContext({
      requestId: 'req-1',
      httpMethod: 'GET',
      resourcePath: '/items/{id}',
      stage: 'prod',
      sourceIp: '1.2.3.4',
      userAgent: 'test-agent',
    });
  return {
    input,
    context,
    util: overrides.util ?? buildDefaultUtil(),
    ...(overrides.inputRoot !== undefined && { inputRoot: overrides.inputRoot }),
  };
}

describe('evaluateVtl - basics', () => {
  it('returns empty string for undefined template', () => {
    expect(evaluateVtl(undefined, buildContext())).toBe('');
  });
  it('returns empty string for empty template', () => {
    expect(evaluateVtl('', buildContext())).toBe('');
  });
  it('echoes literal text verbatim', () => {
    expect(evaluateVtl('hello world', buildContext())).toBe('hello world');
  });
  it('expands a $var.field reference', () => {
    expect(evaluateVtl('stage=$context.stage', buildContext())).toBe('stage=prod');
  });
  it('expands a ${var} block-form reference', () => {
    expect(evaluateVtl('${context.stage}', buildContext())).toBe('prod');
  });
  it('escapes \\$ to a literal dollar sign', () => {
    expect(evaluateVtl('cost: \\$5', buildContext())).toBe('cost: $5');
  });
});

describe('evaluateVtl - $input built-in', () => {
  it('exposes $input.body', () => {
    const ctx = buildContext();
    ctx.input = buildVtlInput('hello', {}, {}, {});
    expect(evaluateVtl('body=$input.body', ctx)).toBe('body=hello');
  });
  it('$input.json("$.field") returns a JSON-stringified slice', () => {
    const ctx = buildContext();
    ctx.input = buildVtlInput(JSON.stringify({ name: 'Alice', n: 42 }), {}, {}, {});
    expect(evaluateVtl('$input.json("$.name")', ctx)).toBe('"Alice"');
    expect(evaluateVtl('$input.json("$.n")', ctx)).toBe('42');
  });
  it('$input.path("$.field") returns the native value', () => {
    const ctx = buildContext();
    ctx.input = buildVtlInput(JSON.stringify({ items: [10, 20] }), {}, {}, {});
    expect(evaluateVtl('$input.path("$.items[0]")', ctx)).toBe('10');
  });
  it('$input.params("name") resolves path > query > header', () => {
    const ctx = buildContext();
    ctx.input = buildVtlInput(
      '',
      { token: 'header-val' },
      { token: 'query-val' },
      { token: 'path-val' }
    );
    expect(evaluateVtl('$input.params("token")', ctx)).toBe('path-val');
  });
  it('$input.params("header") returns the header map for chained access', () => {
    const ctx = buildContext();
    ctx.input = buildVtlInput('', { authorization: 'Bearer abc' }, {}, {});
    expect(evaluateVtl('$input.params("header").authorization', ctx)).toBe('Bearer abc');
  });
  it('$input.json("$") returns the full body', () => {
    const ctx = buildContext();
    ctx.input = buildVtlInput('{"x":1}', {}, {}, {});
    expect(evaluateVtl('$input.json("$")', ctx)).toBe('{"x":1}');
  });
});

describe('evaluateVtl - $util built-in', () => {
  it('$util.escapeJavaScript escapes quotes and slashes', () => {
    expect(evaluateVtl('$util.escapeJavaScript("a\\"b")', buildContext())).toBe('a\\"b');
  });
  it('$util.base64Encode round-trips with Decode', () => {
    expect(evaluateVtl('$util.base64Encode("hello")', buildContext())).toBe('aGVsbG8=');
    expect(evaluateVtl('$util.base64Decode("aGVsbG8=")', buildContext())).toBe('hello');
  });
  it('$util.urlEncode percent-encodes special chars', () => {
    expect(evaluateVtl('$util.urlEncode("a b")', buildContext())).toBe('a%20b');
  });
});

describe('evaluateVtl - $context built-in', () => {
  it('exposes basic $context fields', () => {
    const ctx = buildContext();
    expect(evaluateVtl('$context.requestId', ctx)).toBe('req-1');
    expect(evaluateVtl('$context.httpMethod', ctx)).toBe('GET');
    expect(evaluateVtl('$context.identity.sourceIp', ctx)).toBe('1.2.3.4');
  });
});

describe('evaluateVtl - directives', () => {
  it('#set assigns a variable that subsequent references read', () => {
    const output = evaluateVtl('#set($x = "alice")\nname=$x', buildContext());
    expect(output).toBe('name=alice');
  });
  it('#set with a JSON literal works', () => {
    const output = evaluateVtl('#set($x = 42)\nval=$x', buildContext());
    expect(output).toBe('val=42');
  });
  it('#if renders the true branch only', () => {
    const tmpl = '#if($context.stage == "prod")PROD#else DEV#end';
    expect(evaluateVtl(tmpl, buildContext())).toBe('PROD');
  });
  it('#if / #elseif / #else with comparison ops', () => {
    const tmpl = '#if($n < 5)small#elseif($n < 10)medium#else large#end';
    const ctx = buildContext();
    ctx.input = buildVtlInput('', {}, {}, {});
    expect(evaluateVtl('#set($n = 3)' + tmpl, ctx)).toBe('small');
    expect(evaluateVtl('#set($n = 7)' + tmpl, ctx)).toBe('medium');
    // `#else large` — the literal " large" follows the directive marker;
    // cdkd's directive-trailing-whitespace eater strips the leading
    // whitespace after `#else` (matches Velocity's "directive eats its
    // own newline / trailing whitespace" rule).
    expect(evaluateVtl('#set($n = 50)' + tmpl, ctx)).toBe('large');
  });
  it('#foreach iterates an array', () => {
    const ctx = buildContext();
    ctx.input = buildVtlInput(JSON.stringify({ items: ['a', 'b', 'c'] }), {}, {}, {});
    const tmpl = '#foreach($x in $input.path("$.items"))[$x]#end';
    expect(evaluateVtl(tmpl, ctx)).toBe('[a][b][c]');
  });
  it('## marks a single-line comment', () => {
    const output = evaluateVtl('hello ## this is a comment\nworld', buildContext());
    expect(output).toBe('hello world');
  });
  it('rejects unsupported directives with a clear error', () => {
    expect(() => evaluateVtl('#macro(x)body#end', buildContext())).toThrow(VtlEvaluationError);
  });
  it('rejects unterminated #if with a clear error', () => {
    expect(() => evaluateVtl('#if($x == 1)nope', buildContext())).toThrow(/without matching #end/);
  });
});

describe('evaluateVtl - logical operators', () => {
  it('&& evaluates both sides', () => {
    const ctx = buildContext();
    expect(evaluateVtl('#if($context.stage == "prod" && $context.httpMethod == "GET")yes#end', ctx)).toBe('yes');
  });
  it('|| short-circuits', () => {
    const ctx = buildContext();
    expect(evaluateVtl('#if($context.stage == "dev" || $context.stage == "prod")match#end', ctx)).toBe('match');
  });
  it('! negates a condition', () => {
    const ctx = buildContext();
    expect(evaluateVtl('#if(!($context.stage == "dev"))not-dev#end', ctx)).toBe('not-dev');
  });
});

describe('applyJsonPath', () => {
  it('returns root for $', () => {
    expect(applyJsonPath({ a: 1 }, '$')).toEqual({ a: 1 });
  });
  it('navigates $.field.sub', () => {
    expect(applyJsonPath({ a: { b: 42 } }, '$.a.b')).toBe(42);
  });
  it('indexes into arrays via [n]', () => {
    expect(applyJsonPath({ list: [10, 20, 30] }, '$.list[1]')).toBe(20);
  });
  it('returns null for unknown fields', () => {
    expect(applyJsonPath({ a: 1 }, '$.missing')).toBeNull();
  });
  it('throws on unsupported filter expressions', () => {
    expect(() => applyJsonPath({ a: 1 }, '$..items')).toThrow(VtlEvaluationError);
  });
});

describe('VtlEvaluationError shape', () => {
  it('preserves the name', () => {
    try {
      evaluateVtl('#macro(x)b#end', buildContext());
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(VtlEvaluationError);
      expect((err as Error).name).toBe('VtlEvaluationError');
    }
  });
});
