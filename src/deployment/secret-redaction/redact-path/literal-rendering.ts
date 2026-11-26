import { type RecordedSecretValues } from '../pairs.js';
import { type PathSourceRules, isPlainObject } from '../rules.js';
import { dynamicReferenceSpans } from './reference-tokens.js';
import { secretRerenderPairs } from './template-literal.js';

/** One piece of a rendered source: template text, or a whole reference token. */
type Segment = { text: string } | { token: string };

/**
 * The persisted spelling of an `Fn::Join` / `Fn::Sub` leaf built ONLY from
 * template text and whole secret `{{resolve:...}}` tokens (go-to-k/cdkd#7037):
 * the text as the template spells it, each token as itself. `undefined`
 * whenever that cannot be proven.
 *
 * The value scan rewrote every occurrence of a recorded plaintext in such a
 * leaf, the template's own text included: `Fn::Join ['', ['postgres:',
 * {{username}}]]` with the username `postgres` was persisted as
 * `{{username}}:{{username}}`, which the next diff read as a change. Here the
 * parts the template wrote stay text, whatever secret they equal or contain,
 * and the parts a reference supplied stay that reference.
 *
 * What makes it safe to persist:
 *
 * - The result is a function of the SOURCE alone: template text and the
 *   tokens the template spells at those spans. No byte of the resolved bag
 *   reaches it, so no secret-derived value can.
 * - It is returned only where the source, each token spelled as the plaintext
 *   this pass recorded for it, renders to `bag` EXACTLY, so the template
 *   spelling describes the value being persisted.
 * - Anything else refuses: a `Ref` / `Fn::GetAtt` / `Fn::ImportValue` / any
 *   other intrinsic part (a `NoEcho` parameter's value, a resource attribute,
 *   a cross-stack read are values, not template text), an `Fn::Sub` holding a
 *   `${...}` placeholder or a variable map, a token with no single recorded
 *   plaintext (a public `ssm` reference this pass resolved as public, a
 *   service cdkd does not resolve), and a STATE source.
 *
 * An `Fn::If` at the leaf takes the one branch spelling that renders to
 * `bag`, only when every branch is renderable (or `AWS::NoValue`) and no two
 * spellings render to it.
 *
 * A refusal leaves the leaf to the positional arms and the value scan, as
 * before.
 */
export function positionByLiteralRendering(
  bag: unknown,
  source: unknown,
  secrets: RecordedSecretValues,
  rules: PathSourceRules
): string | undefined {
  if (rules.sourceIsTemplate !== true || typeof bag !== 'string') return undefined;
  if (!isPlainObject(source)) return undefined;
  const plaintextOf = tokenPlaintexts(secrets);
  const ifArgs = source['Fn::If'];
  if (Object.keys(source).length === 1 && Array.isArray(ifArgs)) {
    // An `Fn::If` at the leaf: this module never learns the condition, so a
    // branch is taken only where it is the ONE spelling rendering to `bag`.
    // Two branches rendering to it with different spellings (a literal, and a
    // reference resolving to the same text) refuse: persisting the literal
    // would say which value the secret holds (go-to-k/cdkd#4954's shape).
    // Every branch must be renderable, or be `AWS::NoValue` (which yields no
    // string): a value-bearing branch (a `NoEcho` parameter) that resolved to
    // the other branch's text would otherwise be persisted as that text,
    // confirming the value.
    if (ifArgs.length !== 3) return undefined;
    const spellings = new Set<string>();
    for (const branch of [ifArgs[1], ifArgs[2]]) {
      if (isNoValue(branch)) continue;
      const segments = renderSegments(branch, 1);
      if (segments === undefined) return undefined;
      const spelled = spelledIfRendersTo(segments, plaintextOf, bag);
      if (spelled !== undefined) spellings.add(spelled);
    }
    return spellings.size === 1 ? [...spellings][0] : undefined;
  }
  const segments = renderSegments(source, 0);
  if (segments === undefined) return undefined;
  return spelledIfRendersTo(segments, plaintextOf, bag);
}

/** The persisted spelling of `segments` when, with each token as its plaintext, they render to `bag`. */
function spelledIfRendersTo(
  segments: readonly Segment[],
  plaintextOf: ReadonlyMap<string, string>,
  bag: string
): string | undefined {
  let rendered = '';
  let persisted = '';
  for (const segment of segments) {
    if ('text' in segment) {
      rendered += segment.text;
      persisted += segment.text;
      continue;
    }
    const plaintext = plaintextOf.get(segment.token);
    if (plaintext === undefined) return undefined;
    rendered += plaintext;
    persisted += segment.token;
  }
  return rendered === bag ? persisted : undefined;
}

function isNoValue(node: unknown): boolean {
  return isPlainObject(node) && Object.keys(node).length === 1 && node['Ref'] === 'AWS::NoValue';
}

/** Nesting beyond this is refused, never walked. */
const MAX_DEPTH = 16;

function renderSegments(node: unknown, depth: number): Segment[] | undefined {
  if (depth > MAX_DEPTH) return undefined;
  if (typeof node === 'string') return stringSegments(node);
  if (!isPlainObject(node)) return undefined;
  const keys = Object.keys(node);
  if (keys.length !== 1) return undefined;
  if (keys[0] === 'Fn::Join') {
    const args = node['Fn::Join'];
    if (!Array.isArray(args) || args.length !== 2) return undefined;
    const [delimiter, list] = args as [unknown, unknown];
    if (typeof delimiter !== 'string' || !Array.isArray(list)) return undefined;
    const out: Segment[] = [];
    for (let i = 0; i < list.length; i++) {
      if (i > 0) out.push(...stringSegments(delimiter));
      const part = renderSegments(list[i], depth + 1);
      if (part === undefined) return undefined;
      out.push(...part);
    }
    return out;
  }
  if (keys[0] === 'Fn::Sub') {
    const text = node['Fn::Sub'];
    // A placeholder names a value (a parameter, an attribute), never text.
    if (typeof text !== 'string' || text.includes('${')) return undefined;
    return stringSegments(text);
  }
  return undefined;
}

function stringSegments(value: string): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const span of dynamicReferenceSpans(value)) {
    if (span.start > at) out.push({ text: value.slice(at, span.start) });
    out.push({ token: value.slice(span.start, span.end) });
    at = span.end;
  }
  if (at < value.length) out.push({ text: value.slice(at) });
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
