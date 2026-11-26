import { type RecordedSecretValues } from '../pairs.js';
import { type PathSourceRules, isPlainObject } from '../rules.js';
import { dynamicReferenceSpans } from './reference-tokens.js';
import { secretRerenderPairs } from './template-literal.js';
import { takenIfBranchOf } from '../resolver-outcomes.js';
import { physicalNameCopiesOf } from '../physical-name-copies.js';

/**
 * One piece of a rendered source: template text, a whole reference token, or
 * a GAP, a part whose value the template does not spell (a `Ref`, a pseudo
 * parameter, `Fn::GetAtt`, `Fn::ImportValue`, an `Fn::If` inside a join...).
 */
type Segment = { text: string } | { token: string } | { gap: true };

/** The value scan of one string, as the caller's walk would persist it. */
export type ValueScan = (text: string) => unknown;

/**
 * The persisted spelling of an intrinsic leaf whose TEMPLATE TEXT is kept as
 * written (go-to-k/cdkd#7037), or `undefined` whenever that cannot be proven.
 *
 * The value scan rewrote every occurrence of a recorded plaintext in such a
 * leaf, the template's own text included: `Fn::Join ['', ['postgresql://',
 * {Fn::GetAtt: [Db, Endpoint.Address]}, '/postgres']]` with the username
 * `postgres` was persisted as `{{username}}ql://<host>/{{username}}`, which
 * every next diff read as a change (a create-only one as a replacement).
 *
 * The source is read as a sequence of segments: TEXT the template spells
 * (strings, numbers, an `Fn::Select` / `Fn::Split` over literals, an
 * `Fn::Sub` escape), whole `{{resolve:...}}` TOKENS, and GAPS. Text and tokens
 * are ANCHORS: each token rendered as the one plaintext this pass recorded for
 * it. The anchors must sit in `bag` at exactly ONE set of positions, in order,
 * with the gaps between them; the persisted leaf is each anchor as the
 * template spells it (text as text, token as token) and each gap as the bag
 * holds it.
 *
 * What makes it safe to persist:
 *
 * - Every anchor byte is template text or a token the template spells there.
 * - A gap is kept only when the caller's value scan leaves it unchanged, so a
 *   gap holding any recorded secret refuses the arm, and the specialized arms
 *   (parameter placeholders, cross-stack reads, the skeleton and frame arms)
 *   and the scan decide the leaf as before, a pseudo parameter's gap too (the
 *   walk cannot prove which bag bytes a gap resolved to). A `NoEcho` parameter's gap is
 *   masked afterwards by the positional `NoEcho` arm, whatever this returns.
 * - Ambiguous anchors (more than one placement), a leaf with no non-empty
 *   anchor, a token with no single recorded plaintext, text holding a PARTIAL
 *   `{{resolve:` (a token assembled from parts), and a STATE source refuse.
 * - An `Fn::If` at the leaf is spelled as the branch the resolver recorded
 *   this pass taking (`resolver-outcomes.ts`). With no record, it takes the
 *   one branch spelling that renders to `bag`, only when no branch holds a
 *   gap and no two spellings render to it:
 *   a value-bearing branch that resolved to the other branch's text would be
 *   persisted as that text, confirming the value (go-to-k/cdkd#4954's shape).
 *
 * A refusal leaves the leaf to the positional arms and the value scan.
 */
export function positionByLiteralRendering(
  bag: unknown,
  source: unknown,
  secrets: RecordedSecretValues,
  rules: PathSourceRules,
  scan: ValueScan
): string | undefined {
  if (rules.sourceIsTemplate !== true || typeof bag !== 'string') return undefined;
  if (suspended > 0) return undefined;
  visits = 0;
  walking = secrets;
  if (!isPlainObject(source)) return undefined;
  const plaintextOf = tokenPlaintexts(secrets);
  const recorded = [...secrets.keys()];
  const copies = [...(physicalNameCopiesOf.get(secrets) ?? [])];
  const ifArgs = source['Fn::If'];
  if (Object.keys(source).length === 1 && Array.isArray(ifArgs)) {
    if (ifArgs.length !== 3) return undefined;
    // The branch this pass took, where the resolver recorded it: spelled as
    // that branch, which is what the diff side selects from the same
    // conditions, so no other branch's text is ever persisted for it.
    const taken = takenIfBranchOf(secrets, source);
    if (taken !== undefined) {
      const branch = taken ? ifArgs[1] : ifArgs[2];
      if (isNoValue(branch)) return undefined;
      const segments = renderSegments(branch, 1);
      return segments === undefined
        ? undefined
        : placeAnchors(segments, plaintextOf, bag, scan, recorded, copies);
    }
    const spellings = new Set<string>();
    for (const branch of [ifArgs[1], ifArgs[2]]) {
      if (isNoValue(branch)) continue;
      const segments = renderSegments(branch, 1);
      if (segments === undefined || segments.some((s) => 'gap' in s)) return undefined;
      const spelled = placeAnchors(segments, plaintextOf, bag, scan, recorded, copies);
      if (spelled !== undefined) spellings.add(spelled);
    }
    return spellings.size === 1 ? [...spellings][0] : undefined;
  }
  const segments = renderSegments(source, 0);
  if (segments === undefined) return undefined;
  return placeAnchors(segments, plaintextOf, bag, scan, recorded, copies);
}

/**
 * The text a template node spells when it is ALL template text (a string with
 * no token, an `Fn::Join` / `Fn::Sub` / `Fn::Select` / `Fn::Split` of
 * literals, numbers), else `undefined`: the value every walk keeps as written.
 */
export function staticTemplateText(node: unknown): string | undefined {
  walking = undefined;
  const segments = renderSegments(node, 0);
  if (segments === undefined) return undefined;
  let text = '';
  for (const segment of segments) {
    if (!('text' in segment)) return undefined;
    text += segment.text;
  }
  return text;
}

/**
 * The pass map of the rendering in progress, for an `Fn::If` INSIDE an
 * intrinsic (its taken branch is recorded per map). Set at each top-level
 * call; the walk is synchronous.
 */
let walking: RecordedSecretValues | undefined;

/** Nesting depth of {@link withoutLiteralRendering} scopes. */
let suspended = 0;

/**
 * `run` with this arm switched off, for a caller that DERIVES needles from the
 * walk's answer rather than persisting it: the nested-stack parameter recorder
 * (`record-parameter-expressions.ts`) certifies a child's spelling only from
 * the arms it was written against, so its tables keep their answers. The walk
 * is synchronous; the flag is restored on a throw.
 */
export function withoutLiteralRendering<T>(run: () => T): T {
  suspended++;
  try {
    return run();
  } finally {
    suspended--;
  }
}

/** An anchor's two spellings: as rendered (tokens as plaintext) and as persisted. */
interface Anchor {
  rendered: string;
  persisted: string;
}

/**
 * The persisted spelling of `segments` against `bag`: anchors at their one
 * placement, gaps as the bag holds them (each left unchanged by `scan`).
 */
function placeAnchors(
  segments: readonly Segment[],
  plaintextOf: ReadonlyMap<string, string>,
  bag: string,
  scan: ValueScan,
  plaintexts: readonly string[],
  physicalNameCopies: readonly string[]
): string | undefined {
  // [anchor, gap, anchor, ...]: consecutive known parts merged, consecutive
  // gaps merged, and a leading or trailing gap recorded as a flag.
  const anchors: Anchor[] = [];
  let leadingGap = false;
  let trailingGap = false;
  let current: Anchor | undefined;
  for (const segment of segments) {
    if ('gap' in segment) {
      if (current !== undefined) {
        anchors.push(current);
        current = undefined;
      } else if (anchors.length === 0) {
        leadingGap = true;
      }
      trailingGap = true;
      continue;
    }
    trailingGap = false;
    current ??= { rendered: '', persisted: '' };
    if ('text' in segment) {
      current.rendered += segment.text;
      current.persisted += segment.text;
    } else {
      const plaintext = plaintextOf.get(segment.token);
      if (plaintext === undefined) return undefined;
      current.rendered += plaintext;
      current.persisted += segment.token;
    }
  }
  if (current !== undefined) anchors.push(current);
  if (!leadingGap && !trailingGap && anchors.length <= 1) {
    // No gap at all: the rendering must be the bag.
    const only = anchors[0] ?? { rendered: '', persisted: '' };
    return only.rendered === bag ? only.persisted : undefined;
  }
  if (!anchors.some((a) => a.rendered.length > 0)) return undefined;
  const leftmost = placements(anchors, bag, leadingGap, trailingGap, 'left');
  const rightmost = placements(anchors, bag, leadingGap, trailingGap, 'right');
  if (leftmost === undefined || rightmost === undefined) return undefined;
  if (leftmost.some((at, i) => at !== rightmost[i])) return undefined;
  // Anchors are separated by exactly one (merged) gap, so the leaf reads
  // [gap] A0 gap A1 ... An [gap].
  const gaps: string[] = [];
  const gapRanges: Array<readonly [number, number]> = [];
  let persisted = '';
  let cursor = 0;
  for (let i = 0; i < anchors.length; i++) {
    const at = leftmost[i]!;
    if (i > 0 || leadingGap) {
      const gap = bag.slice(cursor, at);
      gaps.push(gap);
      gapRanges.push([cursor, at]);
      persisted += gap;
    } else if (at !== 0) {
      return undefined;
    }
    persisted += anchors[i]!.persisted;
    cursor = at + anchors[i]!.rendered.length;
  }
  if (trailingGap) {
    const gap = bag.slice(cursor);
    gaps.push(gap);
    gapRanges.push([cursor, bag.length]);
    persisted += gap;
  } else if (cursor !== bag.length) {
    return undefined;
  }
  // A gap holding a recorded secret is not this arm's to answer, whatever it
  // names: the walk cannot prove the bag's bytes there are what the gap
  // resolved to (a pseudo parameter included), so a secret in them is the
  // scan's.
  if (gaps.some((gap) => scan(gap) !== gap)) return undefined;
  // ...nor one that the scan cannot see: a recorded plaintext of ANY length
  // touching a gap, inside it (a 1-3 character secret under the scan's floor,
  // #5056 / #5063) or STRADDLING its edge into an anchor (#4986). The one
  // occurrence a gap may keep is inside a reader's copy of a secret-named
  // physical id, which the walk keeps in plaintext by design (#4810).
  const copyRanges: Array<readonly [number, number]> = [];
  for (const copy of physicalNameCopies) {
    if (copy === '') continue;
    for (let at = bag.indexOf(copy); at !== -1; at = bag.indexOf(copy, at + 1)) {
      copyRanges.push([at, at + copy.length]);
    }
  }
  for (const plaintext of plaintexts) {
    if (plaintext === '') continue;
    for (let at = bag.indexOf(plaintext); at !== -1; at = bag.indexOf(plaintext, at + 1)) {
      const end = at + plaintext.length;
      const touchesGap = gapRanges.some(([from, to]) => at < to && end > from);
      if (!touchesGap) continue;
      const insideCopy = copyRanges.some(
        ([from, to]) =>
          at >= from && end <= to && gapRanges.some(([g0, g1]) => from >= g0 && to <= g1)
      );
      if (!insideCopy) return undefined;
    }
  }
  return persisted;
}

/**
 * Where each anchor starts in `bag`, placed leftmost (or rightmost) first;
 * `undefined` where they cannot all be placed. An anchor with no gap before it
 * starts where the previous one ended (the first: at 0); the last, with no
 * trailing gap, ends at the bag's end.
 */
function placements(
  anchors: readonly Anchor[],
  bag: string,
  leadingGap: boolean,
  trailingGap: boolean,
  side: 'left' | 'right'
): number[] | undefined {
  const out = new Array<number>(anchors.length);
  if (side === 'left') {
    let cursor = 0;
    for (let i = 0; i < anchors.length; i++) {
      const text = anchors[i]!.rendered;
      const pinnedStart = i === 0 && !leadingGap;
      const pinnedEnd = i === anchors.length - 1 && !trailingGap;
      let at: number;
      if (pinnedStart) at = 0;
      else if (pinnedEnd) at = bag.length - text.length;
      else at = bag.indexOf(text, cursor);
      if (at < cursor || bag.slice(at, at + text.length) !== text) return undefined;
      if (pinnedEnd && at + text.length !== bag.length) return undefined;
      out[i] = at;
      cursor = at + text.length;
    }
    return out;
  }
  let limit = bag.length;
  for (let i = anchors.length - 1; i >= 0; i--) {
    const text = anchors[i]!.rendered;
    const pinnedStart = i === 0 && !leadingGap;
    const pinnedEnd = i === anchors.length - 1 && !trailingGap;
    let at: number;
    if (pinnedEnd) at = bag.length - text.length;
    else if (pinnedStart) at = 0;
    else at = limit - text.length < 0 ? -1 : bag.lastIndexOf(text, limit - text.length);
    if (at < 0 || at + text.length > limit || bag.slice(at, at + text.length) !== text) {
      return undefined;
    }
    if (pinnedStart && at !== 0) return undefined;
    out[i] = at;
    limit = at;
  }
  return out;
}

function isNoValue(node: unknown): boolean {
  return isPlainObject(node) && Object.keys(node).length === 1 && node['Ref'] === 'AWS::NoValue';
}

/** Nesting beyond this is refused, never walked. */
const MAX_DEPTH = 16;

const GAP: Segment[] = [{ gap: true }];

/** The most segments one leaf may expand to; beyond it the leaf is refused, never walked. */
const MAX_SEGMENTS = 512;

/** Nodes one top-level rendering may visit (a `k^d` variable bomb is refused, never walked). */
const MAX_VISITS = 4096;
let visits = 0;

function renderSegments(node: unknown, depth: number): Segment[] | undefined {
  if (depth === 0) visits = 0;
  if (++visits > MAX_VISITS) return undefined;
  if (depth > MAX_DEPTH) return undefined;
  if (typeof node === 'string') return stringSegments(node);
  if (typeof node === 'number' || typeof node === 'boolean') return [{ text: String(node) }];
  if (!isPlainObject(node) || Object.keys(node).length !== 1) return GAP;
  const [key] = Object.keys(node) as [string];
  const args = node[key];
  if (key === 'Fn::Join') {
    if (!Array.isArray(args) || args.length !== 2) return GAP;
    const [delimiter, list] = args as [unknown, unknown];
    if (typeof delimiter !== 'string' || !Array.isArray(list)) return GAP;
    const glue = stringSegments(delimiter);
    if (glue === undefined) return undefined;
    const out: Segment[] = [];
    // Every element, an `AWS::NoValue` one too: it is a gap (whatever the
    // resolver renders for it), never text.
    const parts = list;
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) out.push(...glue);
      const part = renderSegments(parts[i], depth + 1);
      if (part === undefined) return undefined;
      out.push(...part);
      if (out.length > MAX_SEGMENTS) return undefined;
    }
    return out;
  }
  if (key === 'Fn::Sub') {
    if (typeof args === 'string') return subSegments(args, {}, depth);
    if (Array.isArray(args) && args.length === 2 && typeof args[0] === 'string') {
      const variables = args[1];
      if (!isPlainObject(variables)) return GAP;
      return subSegments(args[0], variables, depth);
    }
    return GAP;
  }
  if (key === 'Fn::If') {
    // The branch this pass took, where the resolver recorded it; else a gap.
    const taken = walking === undefined ? undefined : takenIfBranchOf(walking, node);
    if (taken === undefined || !Array.isArray(args) || args.length !== 3) return GAP;
    const branch = taken ? args[1] : args[2];
    return isNoValue(branch) ? GAP : renderSegments(branch, depth + 1);
  }
  if (key === 'Fn::Select') {
    if (!Array.isArray(args) || args.length !== 2) return GAP;
    const index =
      typeof args[0] === 'number'
        ? args[0]
        : typeof args[0] === 'string' && /^\d+$/.test(args[0])
          ? Number(args[0])
          : undefined;
    const list = staticList(args[1]);
    if (index === undefined || list === undefined || index >= list.length) return GAP;
    return renderSegments(list[index], depth + 1);
  }
  return GAP;
}

/** A list the template spells: an array, or an `Fn::Split` of a literal. */
function staticList(node: unknown): unknown[] | undefined {
  if (Array.isArray(node)) return node;
  if (!isPlainObject(node) || Object.keys(node).length !== 1) return undefined;
  const split = node['Fn::Split'];
  if (!Array.isArray(split) || split.length !== 2) return undefined;
  const [delimiter, text] = split as [unknown, unknown];
  if (typeof delimiter !== 'string' || delimiter === '' || typeof text !== 'string')
    return undefined;
  if (text.includes('{{resolve:')) return undefined;
  return text.split(delimiter);
}

/** `Fn::Sub` text: `${!x}` is the text `${x}`, `${name}` a variable or a gap. */
function subSegments(
  text: string,
  variables: Record<string, unknown>,
  depth: number
): Segment[] | undefined {
  const out: Segment[] = [];
  let at = 0;
  const pattern = /\$\{([^}]*)\}/g;
  for (const match of text.matchAll(pattern)) {
    const literal = stringSegments(text.slice(at, match.index));
    if (literal === undefined) return undefined;
    out.push(...literal);
    const name = match[1]!;
    if (name.startsWith('!')) {
      out.push({ text: `\${${name.slice(1)}}` });
    } else if (Object.hasOwn(variables, name)) {
      const part = renderSegments(variables[name], depth + 1);
      if (part === undefined) return undefined;
      out.push(...part);
      if (out.length > MAX_SEGMENTS) return undefined;
    } else {
      out.push({ gap: true });
    }
    at = match.index + match[0].length;
  }
  const rest = stringSegments(text.slice(at));
  if (rest === undefined) return undefined;
  out.push(...rest);
  return out;
}

/**
 * Text and whole tokens; `undefined` for text holding a PARTIAL `{{resolve:`
 * (a token the template assembles from parts, which the skeleton arms answer).
 */
function stringSegments(value: string): Segment[] | undefined {
  const out: Segment[] = [];
  let at = 0;
  for (const span of dynamicReferenceSpans(value)) {
    const text = value.slice(at, span.start);
    if (text.includes('{{resolve:')) return undefined;
    if (text !== '') out.push({ text });
    out.push({ token: value.slice(span.start, span.end) });
    at = span.end;
  }
  const rest = value.slice(at);
  if (rest.includes('{{resolve:')) return undefined;
  if (rest !== '') out.push({ text: rest });
  return out;
}

/** Each whole token's ONE recorded plaintext; a token recorded with two is left out. */
function tokenPlaintexts(secrets: RecordedSecretValues): Map<string, string> {
  const out = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [token, plaintext] of secretRerenderPairs(secrets)) {
    const known = out.get(token);
    if (known !== undefined && known !== plaintext) ambiguous.add(token);
    else out.set(token, plaintext);
  }
  for (const token of ambiguous) out.delete(token);
  return out;
}
