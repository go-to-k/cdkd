import {
  SECRET_MASK,
  intrinsicLeafResolutionOf,
  resolvedExpressionsOf,
  resolvedPlaintextOf,
  type IntrinsicLeafResolution,
  type RecordedSecretValues,
} from '../pairs.js';
import { type PathSourceRules, isPlainObject } from '../rules.js';
import { referencesConsumedBy } from '../consumed-references.js';
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
 * The leaf holds the text of a secret its resolution consumed, but the record
 * holds no span for it: only an arm certified by PROVENANCE may still place
 * it, else the leaf masks (`redact-path.ts`).
 */
export const TAINTED_WITHOUT_SPAN: unique symbol = Symbol('tainted-without-span');

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
): string | typeof TAINTED_WITHOUT_SPAN | undefined {
  if (rules.sourceIsTemplate !== true || typeof bag !== 'string') return undefined;
  if (!isPlainObject(source)) return undefined;
  if (literalRenderingSuspended()) return undefined;
  const plaintextOf = new Map<string, string>();
  for (const token of resolvedExpressionsOf(secrets)) {
    const plaintext = resolvedPlaintextOf(secrets, token);
    if (plaintext !== undefined && plaintext !== '') plaintextOf.set(token, plaintext);
  }
  // TAINT, generic: every secret reference this leaf's resolution CONSUMED,
  // whatever construct consumed it (the resolver stamps each intrinsic object
  // it dispatched, `consumed-references.ts`). A consumed secret's text in the leaf is placed only by a recorded
  // span; at any other position the leaf is masked, never searched.
  const consumed = new Set<string>();
  for (const token of referencesConsumedBy(secrets, source)) {
    if (plaintextOf.has(token)) consumed.add(token);
  }
  const tainted = [...consumed].some((t) => bag.includes(plaintextOf.get(t)!));
  const resolution = intrinsicLeafResolutionOf(secrets, source);
  const spans = resolution === undefined ? undefined : substitutionSpans(resolution, bag);
  if (spans === undefined || !spans.some((span) => span.secret)) {
    return tainted ? TAINTED_WITHOUT_SPAN : undefined;
  }
  // A node the template-text reader cannot read (a token assembled from
  // parts) has no segments: every stretch is then a gap.
  const segments = templateSegmentsOf(source, secrets) ?? [{ gap: true } as Segment];
  // Each recorded span PINS the next template token spelling it. A secret
  // token the record does not place (a part that lent no record: an
  // `Fn::Select` over a literal token list) masks the leaf.
  const regions: Segment[][] = [[]];
  let pinned = 0;
  for (const segment of segments) {
    if ('token' in segment && pinned < spans.length && segment.token === spans[pinned]!.token) {
      regions.push([]);
      pinned++;
    } else {
      // A consumed secret token the record does not place: its value sits at
      // a position no span proves.
      if ('token' in segment && consumed.has(segment.token)) return SECRET_MASK;
      regions[regions.length - 1]!.push(segment);
    }
  }
  const aligned = pinned === spans.length;
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
      const answer = redactGap(piece.text, secrets, copies, scan);
      if (answer === 'mask') return SECRET_MASK;
      persisted += answer;
    }
    if (i < spans.length) {
      const span = spans[i]!;
      if (span.secret) {
        persisted += span.token;
      } else {
        // A PUBLIC token's value (an ssm `String`) is a value like a gap's.
        const answer = redactGap(bag.slice(span.start, span.end), secrets, copies, scan);
        if (answer === 'mask') return SECRET_MASK;
        persisted += answer;
      }
      cursor = span.end;
    }
  }
  return persisted;
}

/**
 * A gap's bytes as persisted (go-to-k/cdkd#7050), or `'mask'`. By provenance
 * a gap is a parameter's, an attribute's or an import's value, so no token is
 * ever written into it on the strength of its bytes, and nothing in it is
 * attributed by search: a gap holding ANY recorded secret's text (at any
 * length, any position) or a mask-only value masks the whole leaf. The one
 * exception is a reader's copy of a secret-named physical id, kept in
 * plaintext by design (#4810). The value scan must leave what remains alone
 * too, or the leaf is masked. Every reader treats the mask as unknown, and the
 * masked-property fingerprints keep an unchanged template from reading as a
 * change in the plan (`analyzer/diff-calculator/redaction-masks.ts`).
 */
function redactGap(
  gap: string,
  secrets: RecordedSecretValues,
  copies: readonly string[],
  scan: ValueScan
): string | 'mask' {
  for (const plaintext of secrets.keys()) {
    if (plaintext !== '' && exposedAt(gap, plaintext, copies).length > 0) return 'mask';
  }
  const scanned = scan(gap);
  return typeof scanned === 'string' && scanned === gap ? gap : 'mask';
}

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
