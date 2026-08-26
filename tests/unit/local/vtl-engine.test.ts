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

describe('$util.parseJson - the failure message must not echo the parsed input (issue #2203)', () => {
  // Under `cdkd local start-api` the argument of `$util.parseJson(...)` is
  // routinely `$input.body` -- the incoming HTTP request body, which on a
  // login endpoint carries a password. V8 embeds a prefix of the PARSED
  // INPUT in `SyntaxError.message`, so interpolating the parser's message
  // put that prefix on the terminal AND (via `vtlFailure` in
  // `src/local/rest-v1-integrations.ts`, which copies the reason into the
  // 502 body) back over the wire.
  //
  // Each case pairs the negative with POSITIVES. "the needle is absent" on
  // its own is a confluence point -- any unrelated rejection satisfies it --
  // so the discriminators that have to SURVIVE are asserted too.

  function parseJsonFailure(body: string): string {
    const ctx = buildContext({ input: { body } as VtlContext['input'] });
    try {
      evaluateVtl('$util.parseJson($input.body)', ctx);
    } catch (err) {
      expect(err).toBeInstanceOf(VtlEvaluationError);
      return (err as Error).message;
    }
    expect.fail('$util.parseJson should have thrown on a non-JSON body');
  }

  it('withholds the ~10-character prefix V8 quotes from a long body', () => {
    // `JSON.parse('hunter2-my-db-password')` yields
    // `Unexpected token 'h', "hunter2-my"... is not valid JSON` on the pinned
    // Node 24.15. The needle is the PREFIX, not the whole body: asserting
    // `not.toContain('hunter2-my-db-password')` would pass WITHOUT the fix,
    // because V8 never emits more than its prefix window.
    const body = 'hunter2-my-db-password';
    const message = parseJsonFailure(body);

    expect(message).not.toContain('hunter2-my');
    // Also fence the parser's PHRASING, not just the quoted segment: a
    // message keeping `Unexpected token 'h', is not valid JSON` with only
    // the quote stripped still leaks the first character and the offset.
    expect(message).not.toContain('Unexpected token');
    // Deliberately NOT `not.toContain(body)`: for an input this long that
    // assertion is vacuous -- V8 never emits past its prefix window, so it
    // holds with the fix reverted. The full-quote shape has its own case
    // below, where the same assertion is real.

    expect(message).toContain('$util.parseJson');
    expect(message).toContain('SyntaxError');
    // Anchored with the trailing `)`: a bare `argument length 22` is a
    // substring of `argument length 220`, so an inflated count would pass.
    expect(message).toContain(`argument length ${body.length})`);
  });

  it('withholds a SHORT body, which V8 quotes in FULL rather than truncating', () => {
    // A distinct leak shape: V8 appends `...` only past its prefix window,
    // so `JSON.parse('pw42')` quotes the whole string --
    // `Unexpected token 'p', "pw42" is not valid JSON`. A guard written only
    // against the truncated shape would miss this one entirely.
    const body = 'pw42';
    const message = parseJsonFailure(body);

    expect(message).not.toContain(body);
    expect(message).not.toContain('Unexpected token');

    expect(message).toContain('$util.parseJson');
    expect(message).toContain('SyntaxError');
    expect(message).toContain('argument length 4)');
  });

  it('reports the COERCED length for every value that coerces to the empty string', () => {
    // `coerce` answers `''` two different ways, and only one was covered
    // before: `JSON.stringify` THROWS on a circular object, and RETURNS
    // `undefined` for a function / symbol / `toJSON`-yielding-undefined. The
    // second kind used to make the `.length` read throw a TypeError, so the
    // caller got something OTHER than a `VtlEvaluationError`.
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    for (const [label, value] of [
      ['circular (stringify throws)', circular],
      ['function (stringify returns undefined)', () => 'x'],
      ['symbol (stringify returns undefined)', Symbol('s')],
      ['toJSON -> undefined', { toJSON: () => undefined }],
    ] as const) {
      let caught: unknown;
      try {
        buildDefaultUtil().parseJson(value);
      } catch (err) {
        caught = err;
      }
      expect(caught, label).toBeInstanceOf(VtlEvaluationError);
      expect((caught as Error).message, label).toContain('argument length 0)');
    }
  });

  it('reaches the empty-coercion path from a TEMPLATE, not just a direct call', () => {
    // `$input.json` / `$input.path` / `$input.params` are own-property
    // FUNCTIONS on the object `buildVtlInput` returns, so forgetting the call
    // parens hands one straight to `$util.parseJson`.
    const ctx = buildContext({ input: { body: '{"a":1}' } as VtlContext['input'] });
    let caught: unknown;
    try {
      evaluateVtl('$util.parseJson($input.params)', ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VtlEvaluationError);
    expect((caught as Error).message).toContain('argument length 0)');
  });
});
