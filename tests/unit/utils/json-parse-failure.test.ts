import { describe, it, expect } from 'vite-plus/test';
import {
  describeJsonParseFailure,
  jsonParseFailureStandIn,
  parseFailureDebugDetail,
  parseJsonNamingNoBody,
  utf8ByteLength,
} from '../../../src/utils/json-parse-failure.js';
import { UNRENDERABLE } from '../../../src/utils/display-safe.js';

function parseError(body: string): unknown {
  try {
    JSON.parse(body);
  } catch (e) {
    return e;
  }
  throw new Error(`expected ${JSON.stringify(body)} to fail to parse`);
}

describe('describeJsonParseFailure (issue #5247)', () => {
  it('renders the quoting form as size only, without the token V8 quotes', () => {
    const body = '{"password":hunter2SECRET,"x":1}';
    const err = parseError(body);
    // Premise: V8 quotes the token, so its absence below is the helper's doing.
    expect((err as Error).message).toContain('hunter2');

    const rendered = describeJsonParseFailure(err, utf8ByteLength(body));
    expect(rendered).toBe(`invalid JSON; ${body.length} byte(s) read`);
    expect(rendered).not.toContain('hunter2');
  });

  it('keeps V8 offset, labelled in code units, when V8 states one', () => {
    const body = '{"a":1,';
    const err = parseError(body);
    expect((err as Error).message).toMatch(/at position \d+/);

    expect(describeJsonParseFailure(err, utf8ByteLength(body))).toMatch(
      /^invalid JSON at code-unit position \d+; 7 byte\(s\) read$/
    );
  });

  it('takes no offset from a quoted body that itself says `at position`', () => {
    const body = '[at position 42]';
    const err = parseError(body);
    // Premise: V8 quotes the phrase inside its `is not valid JSON` sentence.
    expect((err as Error).message).toContain('at position 42');

    expect(describeJsonParseFailure(err, utf8ByteLength(body))).toBe(
      'invalid JSON; 16 byte(s) read'
    );
  });

  it('keeps the offset of the trailing-garbage family (`after JSON at position N`)', () => {
    const body = '{} x';
    const err = parseError(body);
    expect((err as Error).message).toMatch(/after JSON at position 3/);

    expect(describeJsonParseFailure(err, utf8ByteLength(body))).toBe(
      'invalid JSON at code-unit position 3; 4 byte(s) read'
    );
  });

  it('keeps the offset of the older V8 form without a line/column suffix', () => {
    const err = new SyntaxError('Unexpected token } in JSON at position 123');
    expect(describeJsonParseFailure(err, 4)).toBe(
      'invalid JSON at code-unit position 123; 4 byte(s) read'
    );
  });

  it('renders a non-Error value without echoing it', () => {
    expect(describeJsonParseFailure('hunter2 in JSON at position 3x', 5)).toBe(
      'invalid JSON; 5 byte(s) read'
    );
  });

  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    expect(utf8ByteLength('ö')).toBe(2);
    expect(utf8ByteLength('\u{1F600}')).toBe(4);
  });
});

describe('parseFailureDebugDetail (issue #5254)', () => {
  it('keeps V8 text but drops the non-ASCII bytes it quotes from the body', () => {
    // A bidi override and a plain non-ASCII letter inside V8's quote window:
    // the denylist would keep the `ö`, so only the allowlist drops it.
    const body = '[1,\u202e\u00f6x hunter2]';
    const err = parseError(body);
    expect((err as Error).message).toContain('\u00f6');
    const line = parseFailureDebugDetail(err);
    expect(line).toContain('hunter2');
    expect(line).not.toMatch(/[^\x20-\x7e]/);
  });

  it('answers UNRENDERABLE when nothing survives the allowlist', () => {
    expect(parseFailureDebugDetail(new Error('\u00f6\u00f6'))).toBe(UNRENDERABLE);
  });
});

describe('jsonParseFailureStandIn (issue #5254)', () => {
  it('is a SyntaxError carrying only the offset and size', () => {
    const body = '{"password":hunter2SECRET,"x":1}';
    const standIn = jsonParseFailureStandIn(parseError(body), utf8ByteLength(body));
    expect(standIn).toBeInstanceOf(SyntaxError);
    expect(standIn.name).toBe('SyntaxError');
    expect(standIn.message).toBe(`invalid JSON; ${body.length} byte(s) read`);
    expect(String(standIn.stack)).not.toContain('hunter2');
  });
});

describe('parseJsonNamingNoBody (issue #5254)', () => {
  it('returns the parsed value', () => {
    expect(parseJsonNamingNoBody('{"a":1}', 'the X', () => undefined)).toEqual({ a: 1 });
  });

  it('throws the subject and size with no cause, and hands V8 text to debug only', () => {
    const body = '{"password":hunter2SECRET,"x":1}';
    const debug: string[] = [];
    let caught: unknown;
    try {
      parseJsonNamingNoBody(body, 'the X', (line) => debug.push(line));
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toBe(
      `the X is not valid JSON: invalid JSON; ${body.length} byte(s) read`
    );
    expect((caught as Error).cause).toBeUndefined();
    expect(debug.join('\n')).toContain('hunter2');
  });
});
