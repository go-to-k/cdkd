import { type RecordedSecretValues } from './pairs.js';
import { dynamicReferenceSpans } from './redact-path.js';

/**
 * Does `live` equal `send` at every character OUTSIDE the spans of `send`'s
 * unresolved `{{resolve:...}}` tokens (issue
 * [#2102](https://github.com/go-to-k/cdkd/issues/2102))?
 *
 * `send` is a leaf of the `cdkd drift --revert` payload that EMBEDS at least
 * one token cdkd could not resolve (`jdbc:...password={{resolve:x:/pw}}`), and
 * is otherwise literal text plus whatever plaintext cdkd DID resolve into it.
 * Each unresolved token is a WILDCARD (any live text, empty included); every
 * other character is a literal that must appear in `live` in order, anchored at
 * both ends. A `true` answer means AWS's value differs from the payload ONLY
 * inside those spans, so keeping `live` changes nothing cdkd knows about — and
 * every byte it adds to the payload sits at a position no CloudFormation
 * service resolves (issue #2482 made every one of them resolve), i.e. ordinary
 * data, never a secret cdkd failed to record.
 *
 * THE RESOLVED HALVES ARE PART OF THE FRAME, and that is the disclosure
 * boundary: a `secretsmanager` plaintext cdkd substituted beside the token
 * must match AWS byte for byte, so a ROTATED secret AWS still holds there (no
 * map entry, so nothing could mask it in the retry log, an AWS error text or
 * the #1644 narrowing delta) fails the match and is never copied in.
 *
 * Only spans whose text is in `unresolvedTokens` are wildcards. A
 * `{{resolve:...}}`-shaped substring that came out of a resolved PLAINTEXT is
 * literal frame; and a wildcard span that INTERSECTS any occurrence of a
 * recorded plaintext refuses the whole leaf rather than guess which bytes are
 * whose. Intersecting, not containing: the spans are scanned over the RESOLVED
 * string, so a plaintext can supply just a span's opening `{` or closing `}`
 * (a secret ending in `{` written before a literal `{resolve:x}}`), and the
 * wildcard would then swallow part of the secret. A false refusal (a short
 * plaintext that happens to occur inside a token's text) only ships the token,
 * the pre-#2102 behaviour.
 *
 * Wildcard-only matching is decided exactly by a greedy leftmost scan: anchor
 * the first and last literal, then find each middle literal at its leftmost
 * position after the previous one. The MATCH, not the split, is what the
 * caller needs — on success it keeps `live` whole, so an ambiguous split
 * (`{{a}}-{{b}}` against `x-y-z`) has no wrong answer to give.
 */
export function liveMatchesUnresolvedTokenFrame(
  send: string,
  live: string,
  unresolvedTokens: ReadonlySet<string>,
  secrets: RecordedSecretValues
): boolean {
  const wildcards = dynamicReferenceSpans(send).filter((span) =>
    unresolvedTokens.has(send.slice(span.start, span.end))
  );
  if (wildcards.length === 0) return false;
  if (wildcardOverlapsResolvedPlaintext(send, wildcards, secrets)) return false;
  const literals: string[] = [];
  let at = 0;
  for (const span of wildcards) {
    literals.push(send.slice(at, span.start));
    at = span.end;
  }
  literals.push(send.slice(at));
  const first = literals[0]!;
  const last = literals[literals.length - 1]!;
  if (live.length < first.length + last.length) return false;
  if (!live.startsWith(first) || !live.endsWith(last)) return false;
  let pos = first.length;
  const end = live.length - last.length;
  for (let i = 1; i < literals.length - 1; i++) {
    const literal = literals[i]!;
    const found = live.indexOf(literal, pos);
    if (found < 0 || found + literal.length > end) return false;
    pos = found + literal.length;
  }
  return true;
}

/**
 * Does any wildcard span intersect an occurrence of a recorded plaintext in
 * `send`? Every occurrence counts, overlapping ones included (the scan steps by
 * one character).
 */
function wildcardOverlapsResolvedPlaintext(
  send: string,
  wildcards: ReadonlyArray<{ start: number; end: number }>,
  secrets: RecordedSecretValues
): boolean {
  for (const plaintext of secrets.keys()) {
    if (plaintext === '') continue;
    for (let from = send.indexOf(plaintext); from >= 0; from = send.indexOf(plaintext, from + 1)) {
      const to = from + plaintext.length;
      if (wildcards.some((span) => span.start < to && from < span.end)) return true;
    }
  }
  return false;
}
