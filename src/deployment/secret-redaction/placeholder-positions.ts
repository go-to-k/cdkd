import { isPlainObject, MIN_NEEDLE_LENGTH } from './rules.js';
import { type RecordedSecretValues, intrinsicLeafResolutionOf } from './pairs.js';
import { crossStackSourceKey, crossStackAssociations } from './cross-stack.js';
import { redactSecretsForState } from './redact-state.js';
import { UNKNOWN_PART, joinPartLiteralText } from './positions.js';
import { certifiedExpressionForLeaf } from './certified-positions.js';

/**
 * A part of a {@link parameterPlaceholderParts} source: literal text, a
 * reference the association store can answer (its {@link crossStackSourceKey}),
 * or {@link UNKNOWN_PART} for a part whose text the template cannot state.
 */
type PlaceholderPart = string | { readonly key: string } | typeof UNKNOWN_PART;

/** A keyed part, or UNKNOWN when the reference has no literal key. */
function keyedPart(source: Record<string, unknown>): PlaceholderPart {
  const key = crossStackSourceKey(source);
  return key === undefined ? UNKNOWN_PART : { key };
}

/**
 * How many parts one leaf's source may expand to, and how deep its nested
 * intrinsics may go, before the parse REFUSES (the leaf falls to the value
 * scan). A bound `Fn::Sub` variable is expanded at EVERY `${V}` naming it, so a
 * source nesting `{'Fn::Sub': ['${V}${V}…', {V: <next level>}]}` grows as k^d --
 * at k=8, d=6 an unbounded expansion overflowed the stack at the persist /
 * journal choke points, AFTER the provider call. The part count is bounded by
 * the RESOLVED leaf's length (a legitimate source renders at least one
 * character per non-empty part), the depth by a constant no CDK app reaches.
 */
interface PlaceholderPartBudget {
  remaining: number;
  exhausted: boolean;
}
const MAX_PLACEHOLDER_DEPTH = 8;

function pushPlaceholderPart(
  out: PlaceholderPart[],
  part: PlaceholderPart,
  budget: PlaceholderPartBudget
): void {
  if (budget.remaining <= 0) {
    budget.exhausted = true;
    return;
  }
  budget.remaining -= 1;
  out.push(part);
}

/**
 * The parts one VALUE contributes where the resolver renders it as text — an
 * `Fn::Join` element, or an `Fn::Sub` variable the 2-arg map binds. Both are
 * rendered as `String(resolved)`, so:
 *
 * - a string, number or boolean is literal ({@link joinPartLiteralText});
 * - `{Ref: <name>}` is a parameter candidate;
 * - a nested `Fn::Sub` / `Fn::Join` contributes its own parts, recursively
 *   (`{'Fn::Join': ['', ['x-', {'Fn::Sub': '${A}'}]]}`), since the string it
 *   resolves to is exactly those parts concatenated;
 * - an `Fn::ImportValue` / `Fn::GetStackOutput` / `Fn::GetAtt` is keyed as
 *   that reference (issue #2298): the resolver records a cross-stack read
 *   under the key of the RAW intrinsic it resolved, embedded or not;
 * - anything else is ONE {@link UNKNOWN_PART}.
 *
 * Nothing here is trusted: the caller accepts only a reassembly equal to the
 * resolved leaf, so a misreading costs a refusal.
 */
function appendValuePlaceholderParts(
  value: unknown,
  out: PlaceholderPart[],
  budget: PlaceholderPartBudget,
  depth: number
): void {
  if (budget.exhausted) return;
  const literal = joinPartLiteralText(value);
  if (literal !== undefined) return pushPlaceholderPart(out, literal, budget);
  if (isPlainObject(value) && Object.keys(value).length === 1) {
    const ref = value['Ref'];
    if (typeof ref === 'string' && ref !== '') {
      return pushPlaceholderPart(out, keyedPart({ Ref: ref }), budget);
    }
    if (depth >= MAX_PLACEHOLDER_DEPTH) {
      budget.exhausted = true;
      return;
    }
    if (appendParameterPlaceholderParts(value, out, budget, depth + 1)) return;
    return pushPlaceholderPart(out, keyedPart(value), budget);
  }
  pushPlaceholderPart(out, UNKNOWN_PART, budget);
}

/**
 * An `Fn::Sub` / `Fn::Join` source in order, as literal text, keyed references
 * and {@link UNKNOWN_PART}s, appended to `out`; `false` (nothing appended) for
 * a source of any other shape.
 *
 * - `Fn::Sub`: the bare template, or `[template, vars]` with a plain-object
 *   map. `${!X}` is the escape and renders as the literal `${X}`; an empty
 *   `${}` is left verbatim, as the resolver leaves it. A placeholder the map
 *   BINDS (`Object.hasOwn`, the resolver's own test over its null-prototype
 *   copy, so `${constructor}` is not bound) contributes its value's parts
 *   ({@link appendValuePlaceholderParts}) — CDK's `Fn.sub('x-${V}', {V: param})`.
 *   A dotted `${Res.Attr}` is keyed as the `Fn::GetAtt` `resolveSub` hands
 *   the bare name to (a nested-stack output, issue #2298); any other name is a
 *   parameter candidate, pseudo parameters included. A key no writer recorded
 *   (a same-stack attribute, a pseudo parameter) ends up UNKNOWN.
 * - `Fn::Join`: a string delimiter and an array, each element contributing
 *   {@link appendValuePlaceholderParts}.
 *
 * The SHAPE is checked before anything is appended, so a refused nested source
 * leaves `out` untouched for its caller to mark UNKNOWN. Running out of
 * {@link PlaceholderPartBudget} sets `exhausted`, which the top-level caller
 * reads as a refusal of the whole leaf.
 */
function appendParameterPlaceholderParts(
  source: Record<string, unknown>,
  out: PlaceholderPart[],
  budget: PlaceholderPartBudget,
  depth: number
): boolean {
  const keys = Object.keys(source);
  if (keys.length !== 1) return false;
  const key = keys[0]!;

  if (key === 'Fn::Join') {
    const args = source[key];
    if (!Array.isArray(args) || args.length !== 2) return false;
    const [delimiter, parts] = args as [unknown, unknown];
    if (typeof delimiter !== 'string' || !Array.isArray(parts)) return false;
    for (let index = 0; index < parts.length && !budget.exhausted; index++) {
      if (index > 0) pushPlaceholderPart(out, delimiter, budget);
      appendValuePlaceholderParts(parts[index], out, budget, depth);
    }
    return true;
  }

  if (key === 'Fn::Sub') {
    const args = source[key];
    let template: unknown;
    let variables: Record<string, unknown> = {};
    if (typeof args === 'string') {
      template = args;
    } else if (Array.isArray(args) && args.length === 2 && isPlainObject(args[1])) {
      template = args[0];
      variables = args[1];
    } else {
      return false;
    }
    if (typeof template !== 'string') return false;
    let cursor = 0;
    for (const hit of template.matchAll(/\$\{(!)?([^}]*)\}/g)) {
      if (budget.exhausted) return true;
      pushPlaceholderPart(out, template.slice(cursor, hit.index), budget);
      cursor = hit.index + hit[0].length;
      const name = hit[2] ?? '';
      if (hit[1] === '!') pushPlaceholderPart(out, `\${${name}}`, budget);
      else if (name === '') pushPlaceholderPart(out, hit[0], budget);
      else if (Object.hasOwn(variables, name)) {
        appendValuePlaceholderParts(variables[name], out, budget, depth);
      } else if (name.includes('.')) {
        pushPlaceholderPart(out, keyedPart({ 'Fn::GetAtt': name }), budget);
      } else pushPlaceholderPart(out, keyedPart({ Ref: name }), budget);
    }
    pushPlaceholderPart(out, template.slice(cursor), budget);
    return true;
  }

  return false;
}

/**
 * {@link appendParameterPlaceholderParts} for one leaf, bounded by its resolved
 * length; `undefined` for an undescribable source or an exhausted budget.
 */
function parameterPlaceholderParts(
  source: Record<string, unknown>,
  bag: string
): PlaceholderPart[] | undefined {
  const budget: PlaceholderPartBudget = { remaining: bag.length * 2 + 16, exhausted: false };
  const out: PlaceholderPart[] = [];
  if (!appendParameterPlaceholderParts(source, out, budget, 0)) return undefined;
  return budget.exhausted ? undefined : out;
}

/**
 * Position a leaf whose SOURCE is an `Fn::Sub` / `Fn::Join` over a nested-stack
 * child's own PARAMETERS, placeholder by placeholder (issue
 * [#2320](https://github.com/go-to-k/cdkd/issues/2320)), and over CROSS-STACK
 * references embedded in text (issue
 * [#2298](https://github.com/go-to-k/cdkd/issues/2298)).
 *
 * The EMBEDDING twin of `positionByCrossStackSource` (`certified-positions.ts`),
 * for every spelling it keys: a `${Param}`, a `${Child.Outputs.X}`, or an
 * `Fn::ImportValue` / `Fn::GetStackOutput` / `Fn::GetAtt` element or bound
 * variable. The writer records each such read WHOLE-TOKEN under the key of the
 * raw intrinsic it resolved, so the embedded part has its own association even
 * though the leaf does not; nothing keys the partial leaf itself.
 *
 * Before it, a leaf such as `Fn::Sub 'x${A}'` could only be redacted by the
 * plaintext-keyed value scan, which reads ONE expression per plaintext —
 * whichever parameter the resource resolved LAST. The DIFF side
 * (`redactParametersForDiff`) answers per PARAMETER, so a resource holding this
 * leaf beside a `{Ref: B}` leaf, `A` and `B` resolving to one plaintext,
 * persisted `B`'s expression on the embedded leaf while the desired side held
 * `A`'s: an UPDATE on every deploy, a REPLACEMENT on a create-only property.
 *
 * Each keyed placeholder is answered EXACTLY as a whole leaf of that reference
 * over the same value would be — the same association row, the same
 * {@link certifiedExpressionForLeaf} — so the leaf persists what the diff side
 * renders: the template's literals with each reference's own expression in its
 * place. A placeholder with no certified association is UNKNOWN.
 *
 * Condition 2 of {@link certifiedExpressionForLeaf} is always true here, since
 * each part is certified over its association's OWN plaintext; the exact
 * reassembly below is what refuses a bag the association is not about.
 *
 * THE RENDERING IS CHECKED, NOT TRUSTED. Nothing here reproduces the
 * resolver's substitution: the literals and each association's plaintext must
 * reassemble the resolved leaf EXACTLY, or the arm refuses. A divergence from
 * the resolver (a `Ref` it answered from a same-named RESOURCE, a list
 * parameter, a `{{resolve:` token in the literal text) therefore costs only a
 * refusal, i.e. the value scan.
 *
 * TWO READINGS, the resolver's first. {@link positionByRecordedParameterSpans}
 * reads the spans the RESOLVER recorded while it substituted each parameter
 * (issue #4446) and placed each cross-stack read (issue #4527), which answers
 * any number of unknown parts and an `Fn::If` selecting an `Fn::Sub` /
 * `Fn::Join`. Where this pass kept no usable record,
 * the TEMPLATE parse below aligns the source against the leaf instead:
 *
 * AT MOST ONE UNKNOWN PART (a pseudo parameter, an intrinsic, an unassociated
 * reference). Every other part has fixed text, so the unknown span is whatever
 * lies between the fixed prefix and the fixed suffix — unambiguous, and so are
 * adjacent placeholders with equal values (`${A}${B}`), because no span is
 * SEARCHED for. That span is kept verbatim, and the arm refuses when the
 * value scan would rewrite it at all. Two or more unknown parts could split
 * the remainder more than one way, and refuse.
 *
 * Refuses (falls to the next arm, then the value scan) when the bag holds no
 * association at all — a pass that read no secret across a stack boundary —
 * when no placeholder is certified, and when the persisted string would still hold a needle the
 * value scan rewrites (a recorded plaintext in the template's own literal text
 * or in the unknown span, a containment needle), or when a recorded needle
 * crosses a certified span's edge on the resolved leaf, so this arm never
 * persists text the scan would have rewritten.
 */
export function positionByParameterPlaceholders(
  bag: string,
  source: Record<string, unknown>,
  secrets: RecordedSecretValues
): string | undefined {
  const associations = crossStackAssociations.get(secrets);
  if (associations === undefined) return undefined;
  // The RESOLVER's own spans first (issue #4446): they need no alignment, so
  // they answer the shapes the template parse below refuses. On any refusal
  // the parse still gets its turn, under its own guards.
  const spanned = positionByRecordedParameterSpans(bag, source, secrets, associations);
  if (spanned !== undefined) return spanned;
  const parts = parameterPlaceholderParts(source, bag);
  if (parts === undefined) return undefined;
  // `[rendered, persisted]` for each side of the (at most one) unknown part.
  const before: [string, string] = ['', ''];
  const after: [string, string] = ['', ''];
  let side = before;
  let unknown = false;
  let certified = 0;
  // Each certified span as `[side, offset within that side, length]`, so it can
  // be placed on the RESOLVED leaf once the unknown span's width is known.
  const spans: Array<[typeof before, number, number]> = [];
  for (const part of parts) {
    let rendered: string;
    let persisted: string;
    if (typeof part === 'string') {
      rendered = part;
      persisted = part;
    } else {
      let expression: string | undefined;
      let plaintext = '';
      if (part !== UNKNOWN_PART) {
        const association = associations.get(part.key);
        if (association !== undefined && typeof association !== 'symbol') {
          plaintext = association.plaintext;
          expression = certifiedExpressionForLeaf(secrets, association, plaintext);
        }
      }
      if (expression === undefined) {
        if (unknown) return undefined;
        unknown = true;
        side = after;
        continue;
      }
      rendered = plaintext;
      persisted = expression;
      certified += 1;
      spans.push([side, side[0].length, plaintext.length]);
    }
    side[0] += rendered;
    side[1] += persisted;
  }
  // No test discriminates this floor: with no keyed part, the reassembly
  // below makes this arm's answer the value scan's own. It keeps the arm from
  // pre-empting the skeleton / frame arms on a source it holds no evidence for.
  if (certified === 0) return undefined;
  let persisted: string;
  if (!unknown) {
    if (before[0] !== bag) return undefined;
    persisted = before[1];
  } else {
    if (bag.length < before[0].length + after[0].length) return undefined;
    if (!bag.startsWith(before[0]) || !bag.endsWith(after[0])) return undefined;
    const middle = bag.slice(before[0].length, bag.length - after[0].length);
    // The unknown span is kept VERBATIM, never scanned on its own: a scan of a
    // slice is not the scan of the leaf. Its whole-value arm has no length
    // floor, so a 1-3 character slice equal to a recorded plaintext would take
    // that secret's expression (a wrong reference), and its containment
    // flatten would leave an inline `***` that no replay refusal recognises
    // (only a leaf that IS `***` is). A slice the scan would rewrite at all
    // refuses instead, which is the value scan's whole-leaf answer.
    if (redactSecretsForState(middle, secrets) !== middle) return undefined;
    persisted = before[1] + middle + after[1];
  }
  const afterStart = bag.length - after[0].length;
  return acceptedPlaceholderRendering(
    bag,
    persisted,
    spans.map(([side, offset, length]) => [(side === before ? 0 : afterStart) + offset, length]),
    secrets
  );
}

/**
 * The two disclosure guards both placeholder arms end on, over the RESOLVED
 * leaf `bag`, the string about to be persisted, and each certified span as
 * `[start on bag, length]`; `persisted`, or `undefined` to refuse.
 *
 * A needle crossing a certified span's edge (part plaintext, part literal or
 * unknown text) is gone from `persisted` -- the span became an expression --
 * so the re-scan cannot see the half left behind. Refuse it on the RESOLVED
 * leaf instead. A needle wholly inside a span is replaced with it. Then the
 * value scan must leave `persisted` alone, so nothing it would have rewritten
 * is persisted.
 */
function acceptedPlaceholderRendering(
  bag: string,
  persisted: string,
  spans: ReadonlyArray<readonly [number, number]>,
  secrets: RecordedSecretValues
): string | undefined {
  for (const plaintext of secrets.keys()) {
    if (plaintext.length < MIN_NEEDLE_LENGTH) continue;
    for (let at = bag.indexOf(plaintext); at !== -1; at = bag.indexOf(plaintext, at + 1)) {
      const end = at + plaintext.length;
      for (const [start, length] of spans) {
        const overlaps = at < start + length && end > start;
        if (overlaps && (at < start || end > start + length)) return undefined;
      }
    }
  }
  if (redactSecretsForState(persisted, secrets) !== persisted) return undefined;
  return persisted;
}

/**
 * {@link positionByParameterPlaceholders}'s first arm: the parameter spans the
 * RESOLVER recorded for `source` in this pass (issue
 * [#4446](https://github.com/go-to-k/cdkd/issues/4446)), instead of spans
 * inferred by aligning the template against the resolved leaf.
 *
 * The template parse refuses whatever it cannot align: two or more parts whose
 * text the template cannot state, and every source other than `Fn::Sub` /
 * `Fn::Join` (an `Fn::If` selecting one). The resolver states WHERE each
 * parameter `Ref` and each cross-stack read (issue #4527) landed while it
 * substituted it (`IntrinsicLeafResolution.parameterSpans`, through every
 * nesting and an `Fn::If`'s selected branch), so nothing here re-implements
 * the rendering and nothing is searched for.
 *
 * - The record must describe THIS leaf: its `output` equals `bag`, and its
 *   spans are ascending, non-overlapping and inside it; anything else refuses.
 * - Each span is certified exactly as a whole leaf of its reference over its
 *   text would be ({@link certifiedExpressionForLeaf} over the association
 *   recorded under the span's key: a `{Ref: <Param>}`, an `Fn::ImportValue` /
 *   `Fn::GetStackOutput` / `Fn::GetAtt`), which is what
 *   `redactParametersForDiff` and `positionByCrossStackSource` render. A span
 *   that is not certified stays as text.
 * - Every other stretch of `bag` (a GAP: literal text, a pseudo parameter, an
 *   attribute, an uncertified parameter) is kept VERBATIM and must be one the
 *   value scan leaves alone ON ITS OWN, for the reason the template arm keeps
 *   its one unknown span that way: a slice the scan would rewrite (a 1-3
 *   character slice equal to a recorded plaintext, a containment needle) has
 *   no faithful verbatim rendering, so the leaf refuses to the scan.
 * - Then {@link acceptedPlaceholderRendering}'s straddle and final re-scan
 *   guards, the template arm's own.
 */
function positionByRecordedParameterSpans(
  bag: string,
  source: Record<string, unknown>,
  secrets: RecordedSecretValues,
  associations: NonNullable<ReturnType<typeof crossStackAssociations.get>>
): string | undefined {
  const resolution = intrinsicLeafResolutionOf(secrets, source);
  if (resolution === undefined || resolution.output !== bag) return undefined;
  const recorded = resolution.parameterSpans;
  if (recorded === undefined) return undefined;
  // `previousEnd` validates EVERY span, certified or not; `cursor` is where
  // the next gap starts, the end of the last CERTIFIED one.
  let previousEnd = 0;
  let cursor = 0;
  let persisted = '';
  const gaps: string[] = [];
  const certified: Array<readonly [number, number]> = [];
  for (const { start, length, key } of recorded) {
    // The upper bound is load-bearing: `slice` clamps, so an overlong span
    // whose clamped text IS a plaintext would certify text the record never
    // described (pinned by the "overlong span" case).
    if (!(start >= previousEnd && length > 0 && start + length <= bag.length)) return undefined;
    previousEnd = start + length;
    const text = bag.slice(start, start + length);
    const association = associations.get(key);
    if (association === undefined || typeof association === 'symbol') continue;
    const expression = certifiedExpressionForLeaf(secrets, association, text);
    if (expression === undefined) continue;
    const gap = bag.slice(cursor, start);
    gaps.push(gap);
    persisted += gap + expression;
    certified.push([start, length]);
    cursor = start + length;
  }
  if (certified.length === 0) return undefined;
  const tail = bag.slice(cursor);
  gaps.push(tail);
  persisted += tail;
  for (const gap of gaps) {
    if (redactSecretsForState(gap, secrets) !== gap) return undefined;
  }
  return acceptedPlaceholderRendering(bag, persisted, certified, secrets);
}
