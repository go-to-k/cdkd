import { describe, it, expect } from 'vite-plus/test';
import {
  describeJsonParseFailure,
  utf8ByteLength,
} from '../../../src/utils/json-parse-failure.js';

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
