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
  const plaintexts = [...secrets.keys()].filter((p) => p !== '');
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
      const redacted = redactGap(piece.text, secrets, plaintexts, copies, scan);
      if (redacted === undefined) return SECRET_MASK;
      persisted += redacted;
    }
    if (i < spans.length) {
      const span = spans[i]!;
      persisted += span.secret ? span.token : bag.slice(span.start, span.end);
      cursor = span.end;
    }
  }
  return persisted;
}

/**
 * A gap's bytes as persisted: the value scan first, then every recorded
 * plaintext it still holds at ANY length (one under `MIN_NEEDLE_LENGTH` the
 * scan does not see) rewritten to its expression, outside a token and
 * outside a reader's copy of a secret-named physical id (kept in plaintext by
 * design, #4810). `undefined` (mask the leaf) where a mask-only value sits in
 * it or a plaintext survives (overlapping needles): never a plaintext.
 */
function redactGap(
  gap: string,
  secrets: RecordedSecretValues,
  plaintexts: readonly string[],
  copies: readonly string[],
  scan: ValueScan
): string | undefined {
  const scanned = scan(gap);
  if (typeof scanned !== 'string') return undefined;
  let text = scanned;
  // Longest first, so a needle inside a longer one does not split it.
  for (const plaintext of [...plaintexts].sort((a, b) => b.length - a.length)) {
    if (!text.includes(plaintext)) continue;
    const expression = secrets.get(plaintext);
    // Two references resolved to this text: which one a gap holds is not
    // known, and writing the map's survivor would send the wrong one's value
    // on a replay. The leaf is masked instead.
    const spellers = resolvedExpressionsOf(secrets).filter(
      (token) => resolvedPlaintextOf(secrets, token) === plaintext
    );
    if (spellers.length > 1 && exposedAt(text, plaintext, copies).length > 0) return undefined;
    if (expression === undefined || expression === SECRET_MASK) {
      if (exposedAt(text, plaintext, copies).length > 0) return undefined;
      continue;
    }
    let out = '';
    let cursor = 0;
    for (const at of exposedAt(text, plaintext, copies)) {
      out += text.slice(cursor, at) + expression;
      cursor = at + plaintext.length;
    }
    text = out + text.slice(cursor);
  }
  for (const plaintext of plaintexts) {
    if (exposedAt(text, plaintext, copies).length > 0) return undefined;
  }
  return text;
}

/**
 * Where `plaintext` occurs in `text` outside every `{{resolve:...}}` token
 * and every physical-id copy: non-overlapping, leftmost first.
 */
function exposedAt(text: string, plaintext: string, copies: readonly string[]): number[] {
  const shielded: Array<readonly [number, number]> = dynamicReferenceSpans(text).map(
    (s) => [s.start, s.end] as const
  );
  for (const copy of copies) {
    for (let at = text.indexOf(copy); at !== -1; at = text.indexOf(copy, at + 1)) {
      shielded.push([at, at + copy.length]);
    }
  }
  const out: number[] = [];
  for (let at = text.indexOf(plaintext); at !== -1;) {
    const end = at + plaintext.length;
    const inside = shielded.some(([from, to]) => at >= from && end <= to);
    if (inside) {
      at = text.indexOf(plaintext, at + 1);
      continue;
    }
    out.push(at);
    at = text.indexOf(plaintext, end);
  }
  return out;
}
