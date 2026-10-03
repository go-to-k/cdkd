import { describe, it, expect } from 'vite-plus/test';
import { liveMatchesUnresolvedTokenFrame } from '../../../src/deployment/secret-redaction.js';

// Issue #2102: the span matcher behind `cdkd drift --revert`'s preservation of
// a token EMBEDDED in a longer string. Each surviving token is a wildcard;
// every other character must match AWS's value in order, anchored at both ends.
const A = '{{resolve:notaservice:/a}}';
const B = '{{resolve:notaservice:/b}}';
const BOTH = new Set([A, B]);
const match = (send: string, live: string, tokens: ReadonlySet<string> = BOTH): boolean =>
  liveMatchesUnresolvedTokenFrame(send, live, tokens, new Map());

describe('liveMatchesUnresolvedTokenFrame (#2102)', () => {
  it('anchors the literal before and after a single token', () => {
    expect(match(`pre-${A}-post`, 'pre-anything-post')).toBe(true);
    expect(match(`pre-${A}-post`, 'pre--post')).toBe(true); // empty span
    expect(match(`pre-${A}-post`, 'xpre-v-post')).toBe(false);
    expect(match(`pre-${A}-post`, 'pre-v-postx')).toBe(false);
  });

  it('does not let the prefix and suffix overlap', () => {
    // `aba` starts with `ab` and ends with `ba`, but only by sharing the `b`.
    expect(match(`ab${A}ba`, 'aba')).toBe(false);
    expect(match(`ab${A}ba`, 'abba')).toBe(true);
  });

  it('finds middle literals in order between two tokens', () => {
    expect(match(`${A}:${B}`, 'host:port')).toBe(true);
    expect(match(`${A}:${B}`, 'x:y:z')).toBe(true); // ambiguous split, still a match
    expect(match(`${A}:${B}`, 'hostport')).toBe(false);
    expect(match(`<${A}|${B}>`, '<1|2>')).toBe(true);
    expect(match(`<${A}|${B}>`, '<1>|')).toBe(false);
  });

  it('rejects a middle literal found only inside the suffix region', () => {
    // `:` exists in `live` only as part of the anchored suffix `:end`.
    expect(match(`${A}:${B}:end`, 'x:end')).toBe(false);
  });

  it('handles adjacent tokens with no literal between them', () => {
    expect(match(`${A}${B}`, 'anything')).toBe(true);
    expect(match(`${A}${B}`, '')).toBe(true);
  });

  it('answers false when no span is a surviving token', () => {
    expect(match(`pre-${A}`, 'pre-x', new Set())).toBe(false);
    expect(match(`pre-${A}`, 'pre-x', new Set([B]))).toBe(false);
  });

  it('treats a non-survivor token as literal frame', () => {
    expect(match(`${A}-${B}`, `x-${B}`, new Set([A]))).toBe(true);
    expect(match(`${A}-${B}`, 'x-y', new Set([A]))).toBe(false);
  });

  it('refuses when a survivor span overlaps a resolved plaintext containing it', () => {
    const plaintext = `s${A}t`;
    const secrets = new Map([[plaintext, '{{resolve:secretsmanager:x:SecretString:k::}}']]);
    expect(liveMatchesUnresolvedTokenFrame(`p-${plaintext}`, 'p-sQt', BOTH, secrets)).toBe(false);
    // ...including one that STARTS at the token (the occurrence begins inside
    // the span rather than before it).
    const leading = `${A}tail`;
    const leadingSecrets = new Map([[leading, '{{resolve:secretsmanager:z:SecretString:k::}}']]);
    expect(liveMatchesUnresolvedTokenFrame(`p-${leading}`, 'p-Qtail', BOTH, leadingSecrets)).toBe(
      false
    );
    // A plaintext elsewhere in the string does not affect a disjoint span.
    const other = new Map([[`r${B}`, '{{resolve:secretsmanager:y:SecretString:k::}}']]);
    expect(liveMatchesUnresolvedTokenFrame(`${A}|r${B}`, `v|r${B}`, new Set([A]), other)).toBe(
      true
    );
  });
});
