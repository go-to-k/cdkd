import {
  SECRET_MASK,
  intrinsicLeafResolutionOf,
  resolvedExpressionsOf,
  resolvedPlaintextOf,
  type IntrinsicLeafResolution,
  type RecordedSecretValues,
} from '../pairs.js';
import { type PathSourceRules, isPlainObject } from '../rules.js';
import { physicalNameCopiesOf } from '../physical-name-copies.js';
import { dynamicReferenceSpans } from './reference-tokens.js';
import {
  literalRenderingSuspended,
  placeTextPieces,
  templateSegmentsOf,
  type Segment,
  type ValueScan,
} from './literal-rendering.js';

/** Where the resolver placed one `{{resolve:...}}` token's value on a resolved string. */
interface SubstitutionSpan {
  start: number;
  end: number;
  token: string;
  secret: boolean;
}

/**
 * Where the resolver SUBSTITUTED each `{{resolve:...}}` token of the
 * intrinsic `source` on `bag`, from its own record of that resolution
 * (go-to-k/cdkd#7050), or `undefined` when the record cannot say.
 *
 * The record (`IntrinsicLeafResolution`, `pairs.ts`) holds the text the
 * object's references were replaced in (`input`), what it resolved to
 * (`output`) and each replacement made. Replaying the replacements over
 * `input`, token by token, must give `output` exactly. That proves each
 * token's value sits at the replayed span, by PROVENANCE: no search of the
 * value decides it, so a secret whose text also occurs elsewhere in the leaf
 * (in a parameter's value, an attribute, the template's own text) cannot be
 * mistaken for it. Refused when the pass recorded no resolution or two
 * different ones for the object, when a token was left unreplaced, when one
 * token was replaced with two values, and when the replay does not
 * reproduce the output (or the output is not `bag`).
 */
function substitutionSpans(
  resolution: IntrinsicLeafResolution,
  bag: string
): SubstitutionSpan[] | undefined {
  if (!resolution.complete || resolution.output !== bag) return undefined;
  const valueOf = new Map<string, { value: string; secret: boolean } | null>();
  for (const { token, value, secret } of resolution.substitutions) {
    const known = valueOf.get(token);
    if (known === undefined) valueOf.set(token, { value, secret });
    else if (known !== null && (known.value !== value || known.secret !== secret)) {
      valueOf.set(token, null);
    }
  }
  const spans: SubstitutionSpan[] = [];
  let rendered = '';
  let cursor = 0;
  for (const span of dynamicReferenceSpans(resolution.input)) {
    const token = resolution.input.slice(span.start, span.end);
    const answer = valueOf.get(token);
    if (answer === undefined || answer === null) return undefined;
    rendered += resolution.input.slice(cursor, span.start);
    spans.push({
      start: rendered.length,
      end: rendered.length + answer.value.length,
      token,
      secret: answer.secret,
    });
    rendered += answer.value;
    cursor = span.end;
  }
  rendered += resolution.input.slice(cursor);
  return rendered === bag ? spans : undefined;
}

/**
 * The persisted spelling of an intrinsic leaf whose SECRET tokens are placed
 * where the resolver substituted them (go-to-k/cdkd#7050), or `undefined`.
 *
 * Every secret token is written at its recorded span, so its plaintext never
 * reaches state, at any length (the #5056 / #5063 class: `Fn::Join ['',
 * [<username reference>, {Ref: Alias}]]` with the username `pg` and `Alias`
 * holding `pg` was persisted `pgpg`, since no search could tell which `pg`
 * the reference produced). A public token's value stays as resolved. Each
 * stretch between tokens is read against the template's segments
 * (`literal-rendering.ts`): TEMPLATE TEXT is kept as written (#7037), and
 * every other byte (a GAP: a parameter, an attribute, an import) is redacted
 * by {@link redactGap}. A stretch whose text cannot be placed exactly is
 * redacted whole as a gap, so an ambiguity costs a redaction artifact, never
 * a plaintext.
 *
 * Only for a TEMPLATE source and a leaf with at least one secret token; the
 * template-text arm and the older arms answer every other leaf.
 */
export function positionBySubstitutionSpans(
  bag: unknown,
  source: unknown,
  secrets: RecordedSecretValues,
  rules: PathSourceRules,
  scan: ValueScan
): string | undefined {
  if (rules.sourceIsTemplate !== true || typeof bag !== 'string') return undefined;
  if (!isPlainObject(source)) return undefined;
  const resolution = intrinsicLeafResolutionOf(secrets, source);
  if (resolution === undefined) return undefined;
  const spans = substitutionSpans(resolution, bag);
  if (spans === undefined || !spans.some((span) => span.secret)) return undefined;
  if (literalRenderingSuspended()) return undefined;
  // A node the template-text reader cannot read (a token assembled from
  // parts) has no segments: every stretch is then a gap, so the tokens are
  // still placed and nothing between them is kept unredacted.
  const segments = templateSegmentsOf(source, secrets) ?? [{ gap: true } as Segment];
  // Each recorded span PINS the next template token spelling it; a template
  // token the record does not place (a part that lent no record: an
  // `Fn::Select` over a literal token list) stays a segment of its stretch,
  // placed there by its own recorded plaintext. A span no template token
  // spells means the segments describe another text: every stretch is then
  // read as a gap.
  const regions: Segment[][] = [[]];
  let pinned = 0;
  for (const segment of segments) {
    if ('token' in segment && pinned < spans.length && segment.token === spans[pinned]!.token) {
      regions.push([]);
      pinned++;
    } else {
      regions[regions.length - 1]!.push(segment);
    }
  }
  const aligned = pinned === spans.length;
  const plaintextOf = new Map<string, string>();
  for (const token of resolvedExpressionsOf(secrets)) {
    const plaintext = resolvedPlaintextOf(secrets, token);
    if (plaintext !== undefined) plaintextOf.set(token, plaintext);
  }
  // The plaintext of each SECRET token this leaf references, and its token.
  const own = new Map<string, string>();
  for (const span of spans) {
    if (!span.secret) continue;
    const plaintext = bag.slice(span.start, span.end);
    if (plaintext !== '') own.set(plaintext, span.token);
  }
  const copies = [...(physicalNameCopiesOf.get(secrets) ?? [])].filter((c) => c !== '');
  let persisted = '';
  let cursor = 0;
  for (let i = 0; i <= spans.length; i++) {
    const end = i < spans.length ? spans[i]!.start : bag.length;
    const region = bag.slice(cursor, end);
    const pieces = aligned ? placeTextPieces(regions[i]!, region, plaintextOf) : undefined;
    for (const piece of pieces ?? [{ text: region, gap: true }]) {
      if (!piece.gap) {
        persisted += piece.text;
        continue;
      }
      const answer = redactGap(piece.text, own, secrets, copies, scan);
      if (answer === 'mask') return SECRET_MASK;
      persisted += answer.text;
    }
    if (i < spans.length) {
      const span = spans[i]!;
      if (span.secret) {
        persisted += span.token;
      } else {
        // A PUBLIC token's value (an ssm `String`) is a value like a gap's,
        // and is redacted as one: it can hold a secret's text too.
        const answer = redactGap(bag.slice(span.start, span.end), own, secrets, copies, scan);
        if (answer === 'mask') return SECRET_MASK;
        persisted += answer.text;
      }
      cursor = span.end;
    }
  }
  return persisted;
}

/** What {@link redactGap} decided for one gap. */
type GapAnswer = { text: string } | 'mask';

/**
 * A gap's bytes as persisted (go-to-k/cdkd#7050). By provenance a gap is a
 * parameter's, an attribute's or an import's value, not a secret; what it
 * must never keep is the text of a secret THIS leaf references:
 *
 * - each occurrence of an own token's plaintext, at any length (one under
 *   `MIN_NEEDLE_LENGTH` the scan does not see), is written as that token,
 *   outside a token and outside a reader's copy of a secret-named physical id
 *   (kept in plaintext by design, #4810);
 * - the leaf is MASKED when two tokens resolved to that text: which one the
 *   gap holds is not known, and a survivor would send the wrong value on a
 *   replay;
 * - every other recorded secret goes through the value scan, as any value's
 *   does (one the gap equals whole at any length, a substring from 4
 *   characters); a mask-only value MASKS the leaf whole. Another secret's
 *   sub-floor text inside a larger gap is kept, as the scan keeps it:
 *   rewriting it would spell a public value as an unrelated reference.
 */
function redactGap(
  gap: string,
  own: ReadonlyMap<string, string>,
  secrets: RecordedSecretValues,
  copies: readonly string[],
  scan: ValueScan
): GapAnswer {
  let text = gap;
  // Longest first, so a needle inside a longer one does not split it.
  for (const [plaintext, token] of [...own].sort((a, b) => b[0].length - a[0].length)) {
    const at = exposedAt(text, plaintext, copies);
    if (at.length === 0) continue;
    const spellers = resolvedExpressionsOf(secrets).filter(
      (expression) => resolvedPlaintextOf(secrets, expression) === plaintext
    );
    if (spellers.length > 1) return 'mask';
    let out = '';
    let cursor = 0;
    for (const start of at) {
      out += text.slice(cursor, start) + token;
      cursor = start + plaintext.length;
    }
    text = out + text.slice(cursor);
  }
  for (const plaintext of own.keys()) {
    if (exposedAt(text, plaintext, copies).length > 0) return 'mask';
  }
  // Then the value scan, for every other recorded secret (4+ characters, or
  // one the gap equals whole): its answer is taken, as the scan's is for any
  // value. A mask-only value in the gap masks the leaf whole, never inline.
  const scanned = scan(text);
  if (typeof scanned !== 'string' || scanned.includes(SECRET_MASK)) return 'mask';
  return { text: scanned };
}

/**
 * Where `plaintext` occurs in `text` outside every `{{resolve:...}}` token
 * and every physical-id copy: non-overlapping, leftmost first.
 */
function exposedAt(text: string, plaintext: string, copies: readonly string[]): number[] {
  const tokens = dynamicReferenceSpans(text).map((s) => [s.start, s.end] as const);
  const copyRanges: Array<readonly [number, number]> = [];
  for (const copy of copies) {
    for (let at = text.indexOf(copy); at !== -1; at = text.indexOf(copy, at + 1)) {
      copyRanges.push([at, at + copy.length]);
    }
  }
  const out: number[] = [];
  for (let at = text.indexOf(plaintext); at !== -1;) {
    const end = at + plaintext.length;
    // Touching a token at all is shielded (rewriting across its edge would
    // corrupt it); a copy shields only what lies wholly inside it.
    const shielded =
      tokens.some(([from, to]) => at < to && end > from) ||
      copyRanges.some(([from, to]) => at >= from && end <= to);
    if (shielded) {
      at = text.indexOf(plaintext, at + 1);
      continue;
    }
    out.push(at);
    at = text.indexOf(plaintext, end);
  }
  return out;
}
