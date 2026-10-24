/**
 * Describe a `JSON.parse` failure WITHOUT echoing the body it parsed — the ONE
 * rule for every message built from such a failure (issues
 * [#2667](https://github.com/go-to-k/cdkd/issues/2667),
 * [#5247](https://github.com/go-to-k/cdkd/issues/5247)).
 *
 * V8 embeds a window of the INPUT in its parse error, so interpolating
 * `err.message` republishes whatever bytes sat near the syntax error. Measured
 * on node v24:
 *
 * ```
 * JSON.parse('{"password":hunter2SECRET,"x":1}')
 * -> Unexpected token 'h', ..."password":hunter2SEC"... is not valid JSON
 * ```
 *
 * An ASCII allowlist does not help: the window is plaintext. `state.json`, the
 * rollback journal and the exports index all hold resolved values before
 * `cdkd scrub`, so the window can be a secret.
 *
 * What survives is the SIZE, plus the OFFSET WHEN V8 STATES ONE — neither is a
 * function of the body's content, and both help an operator holding the object
 * locate the damage. The offset is extracted by pattern rather than passed
 * through, so a message worded differently yields no offset instead of leaking
 * the rest of the sentence. The two numbers are in DIFFERENT UNITS and the
 * message says so: V8 counts `at position` in UTF-16 code units while the size
 * is UTF-8 bytes, so `'{ nöt json'` reports position 2 and 11 bytes. The
 * `Expected ...` family carries `at position N`; the `Unexpected token 'X',
 * ...snippet...` family — the one that embeds the body — does NOT, so the size
 * is what is always present and the offset is a bonus.
 *
 * A caller that wants V8's full text puts it at `debug`, sanitized, never in a
 * thrown message or an error `cause`: `formatError` renders a cause on its
 * `Caused by:` line, and the CLI's last-resort handler inspects the chain.
 */
import { describeAwsFailure } from './aws-failure-text.js';

export function describeJsonParseFailure(err: unknown, bytes: number): string {
  const raw = describeAwsFailure(err).detail;
  // Anchored on V8's OWN sentence ending (`... in JSON at position N (line L
  // column C)`, `... after JSON at position N ...` for trailing garbage, or
  // the older forms without the line/column suffix): the quoting family ends
  // `... is not valid JSON`, and a quoted body can itself contain
  // `at position 42`, which an unanchored match would report as the offset.
  const at = / (?:in|after) JSON at position (\d+)(?: \(line \d+ column \d+\))?$/.exec(raw);
  // `at position` is V8's UTF-16 CODE-UNIT index, not a byte offset -- named
  // in the rendered text because the size beside it is UTF-8 bytes.
  const where = at ? ` at code-unit position ${at[1]}` : '';
  return `invalid JSON${where}; ${bytes} byte(s) read`;
}

/**
 * UTF-8 bytes of the decoded body, for {@link describeJsonParseFailure}.
 * `body.length` counts UTF-16 code units. This is not always the size S3
 * reports: a torn multibyte sequence decodes to U+FFFD, which re-encodes as
 * 3 bytes.
 */
export function utf8ByteLength(body: string): number {
  return Buffer.byteLength(body, 'utf8');
}
