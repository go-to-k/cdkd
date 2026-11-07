import { resolvedPlaintextOf, type RecordedSecretValues } from '../pairs.js';
import { isPlainObject } from '../rules.js';
import { redactForState } from '../context.js';
import { rendersLiteralTo } from '../positions.js';
import { dynamicReferenceSpans, deepEqualJsonValue } from '../redact-path.js';
import { spanNamesResolvableService } from '../anchors.js';
import { takenIfBranchOf } from '../resolver-outcomes.js';
import { inheritedParameterReads, redactInheritedParameterValue } from './inherited-parameters.js';
import { type ParameterBinding, REREAD_TRIGGERS, pseudoBindingOf } from './pseudo-parameters.js';
import { carriesChildOnlyPlaintext } from './child-only-plaintext.js';

const MAX_REREAD_DEPTH = 16;
/**
 * The most distinct `Fn::If` condition names one re-read enumerates (each
 * doubles the evaluations); a source naming more is no re-read.
 */
const MAX_REREAD_CONDITIONS = 4;
/** What a re-read evaluates `{Ref: AWS::NoValue}` to: the leaf drops out. */
const REREAD_NO_VALUE: unique symbol = Symbol('cdkd.reread.no-value');

/**
 * `Fn::Split` as a COMPARISON pass evaluates it (issue
 * [#4914](https://github.com/go-to-k/cdkd/issues/4914)): `text` split on
 * `delimiter` everywhere EXCEPT inside a complete `{{resolve:...}}` token of a
 * service cdkd resolves that `standsForSecret` accepts, which stays whole in
 * its piece.
 *
 * Such a token stands for a plaintext the comparison pass does not hold
 * (`skipDynamicReferences`, or a nested child's parameter bound to its
 * spelling), and `:` is in every one, so a plain split cut it into fragments
 * (`//{{resolve`) that no persisted value ever holds: a change on every
 * deploy. Kept whole, each piece is the real piece with its plaintext replaced
 * by the token -- exactly what the persist side writes -- whenever the
 * plaintext itself holds no delimiter, whole or straddling its boundary (a
 * delimiter `a{` before a JSON secret starting with `{`); where it does, the
 * real split cuts there and nothing the comparison side can compute agrees
 * anyway. An
 * empty delimiter splits per character there too, so it keeps the plain split.
 *
 * `standsForSecret` is the caller's PROVENANCE test: only a token the real
 * pass replaces with its plaintext before splitting may stay whole. Token
 * TEXT the real pass passes through as text (a `Ref` to a parameter whose
 * value spells one, an `Fn::FindInMap` value) is split there as text, so it
 * must be split here the same way. The resolver's diff pass and the
 * nested-stack re-read ({@link rereadParameterExpression}) share this one
 * function.
 */
export function splitOutsideDynamicReferences(
  text: string,
  delimiter: string,
  standsForSecret: (token: string) => boolean
): string[] {
  if (delimiter === '') return text.split(delimiter);
  const spans = dynamicReferenceSpans(text).filter((span) => {
    const token = text.slice(span.start, span.end);
    return spanNamesResolvableService(token) && standsForSecret(token);
  });
  if (spans.length === 0) return text.split(delimiter);
  const pieces: string[] = [];
  let cursor = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(delimiter, from);
    if (at === -1) break;
    const end = at + delimiter.length;
    // An occurrence overlapping a token: every later one starting before the
    // token's end overlaps it too, so resume the search past it.
    const token = spans.find((span) => span.start < end && at < span.end);
    if (token !== undefined) {
      from = token.end;
      continue;
    }
    pieces.push(text.slice(cursor, at));
    cursor = end;
    from = end;
  }
  pieces.push(text.slice(cursor));
  return pieces;
}

/**
 * Does `token` stand for a plaintext the parent resolved, so the child's real
 * pass holds that plaintext where its comparison pass holds the token? A pair
 * recorded on the parent's bag ({@link resolvedPlaintextOf}) is the evidence.
 */
export function standsForInheritedSecret(
  parentSecrets: RecordedSecretValues | undefined,
  token: string
): boolean {
  return parentSecrets !== undefined && resolvedPlaintextOf(parentSecrets, token) !== undefined;
}

/** `Fn::Split` as a pass holding REAL values evaluates it. */
const plainSplit = (text: string, delimiter: string): string[] => text.split(delimiter);

/**
 * Which branch an `Fn::If` object takes in one evaluation: `true` for its
 * first, `undefined` to refuse (issue #4954: no recorded branch).
 */
type IfBranchChoice = (condition: string, node: object) => boolean | undefined;

/**
 * Evaluate a PURE parameter expression -- string literals, arrays, `{Ref}` to
 * a parameter `bind` answers or a pseudo parameter `pseudo` answers (issue
 * [#4962](https://github.com/go-to-k/cdkd/issues/4962)), `Fn::Select`,
 * `Fn::Split`, `Fn::Join`, `Fn::Sub` over such values, and `Fn::If` taking
 * the branch `choose` names -- as the resolver does (`string-functions.ts`,
 * `sub.ts`, `functions.ts`), or `undefined` for anything else: a `{{resolve:`
 * literal (the resolver would resolve it), a number outside a `Fn::Select`
 * index, a non-literal index or delimiter, an index out of bounds, a
 * non-string `Fn::Sub` value, any other intrinsic (`Fn::GetAtt`, a pseudo
 * parameter `pseudo` does not answer, a dotted `${X.Y}`). `split` is
 * the pass's `Fn::Split`: {@link plainSplit} over real values,
 * {@link splitOutsideDynamicReferences} as the diff side splits.
 *
 * `{Ref: AWS::NoValue}` evaluates to {@link REREAD_NO_VALUE}, which only an
 * `Fn::If` passes up: anywhere else (an array element, an argument) it refuses
 * rather than model the resolver's filtering.
 */
function evaluatePureRead(
  node: unknown,
  bind: ParameterBinding,
  pseudo: ParameterBinding,
  split: (text: string, delimiter: string) => string[],
  choose: IfBranchChoice,
  depth = 0
): { value: unknown } | undefined {
  if (depth > MAX_REREAD_DEPTH) return undefined;
  const evaluate = (child: unknown): { value: unknown } | undefined =>
    evaluatePureRead(child, bind, pseudo, split, choose, depth + 1);
  if (typeof node === 'string') return node.includes('{{resolve:') ? undefined : { value: node };
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (const element of node) {
      const evaluated = evaluate(element);
      if (evaluated === undefined || evaluated.value === REREAD_NO_VALUE) return undefined;
      out.push(evaluated.value);
    }
    return { value: out };
  }
  if (!isPlainObject(node)) return undefined;
  const keys = Object.keys(node);
  if (keys.length !== 1) return undefined;
  const key = keys[0]!;
  const args = node[key];
  if (key === 'Ref') {
    if (args === 'AWS::NoValue') return { value: REREAD_NO_VALUE };
    return typeof args === 'string' ? bindReadName(args, bind, pseudo) : undefined;
  }
  if (key === 'Fn::If') {
    // `resolveIf`: the evaluated condition picks the branch, which is
    // resolved as any other value.
    if (!Array.isArray(args) || args.length !== 3 || typeof args[0] !== 'string') return undefined;
    const tookTrue = choose(args[0], node);
    if (tookTrue === undefined) return undefined;
    return evaluate(tookTrue ? args[1] : args[2]);
  }
  if (key === 'Fn::Sub') return evaluatePureSub(args, bind, pseudo, evaluate);
  if (!Array.isArray(args) || args.length !== 2) return undefined;
  if (key === 'Fn::Select') {
    // `selectIndexPosition`'s rule (`intrinsic-resolver/context.ts`), spelled
    // here because this family imports nothing outside it; keep the two alike.
    const index = args[0];
    const position =
      typeof index === 'number'
        ? index
        : typeof index === 'string' && /^(0|[1-9][0-9]*)$/.test(index)
          ? Number(index)
          : undefined;
    if (position === undefined || !Number.isSafeInteger(position) || position < 0) return undefined;
    const list = evaluate(args[1]);
    if (list === undefined || !Array.isArray(list.value) || position >= list.value.length) {
      return undefined;
    }
    return { value: list.value[position] };
  }
  const delimiter = args[0];
  if (typeof delimiter !== 'string') return undefined;
  if (key === 'Fn::Split') {
    const value = evaluate(args[1]);
    if (value === undefined || typeof value.value !== 'string') return undefined;
    return { value: split(value.value, delimiter) };
  }
  if (key === 'Fn::Join') {
    const parts = evaluate(args[1]);
    if (parts === undefined || !Array.isArray(parts.value)) return undefined;
    if (!parts.value.every((part) => typeof part === 'string')) return undefined;
    return { value: parts.value.join(delimiter) };
  }
  return undefined;
}

/**
 * `Fn::Sub` as `resolveSub` (`sub.ts`) evaluates it (issue
 * [#4919](https://github.com/go-to-k/cdkd/issues/4919)), over string values
 * only: `${!X}` renders `${X}`, an empty `${}` stays, a name bound in the
 * variable map takes that variable (every one evaluated, as the resolver
 * resolves the map), and any other name is read as {@link bindReadName}
 * answers it: a pseudo parameter `pseudo` binds (issue #4962) or a parameter
 * `bind` does. A dotted attribute read, an unbound name, a non-string value
 * (`String()` of a number or a list's refusal) all refuse.
 */
function evaluatePureSub(
  args: unknown,
  bind: ParameterBinding,
  pseudo: ParameterBinding,
  evaluate: (child: unknown) => { value: unknown } | undefined
): { value: unknown } | undefined {
  const [text, variables] =
    typeof args === 'string'
      ? [args, {}]
      : Array.isArray(args) && args.length === 2
        ? [args[0], args[1]]
        : [undefined, undefined];
  if (typeof text !== 'string' || text.includes('{{resolve:') || !isPlainObject(variables)) {
    return undefined;
  }
  const bound = new Map<string, string>();
  for (const [name, variable] of Object.entries(variables)) {
    const evaluated = evaluate(variable);
    if (evaluated === undefined || typeof evaluated.value !== 'string') return undefined;
    bound.set(name, evaluated.value);
  }
  let out = '';
  let cursor = 0;
  for (const match of text.matchAll(/\$\{(!)?([^}]*)\}/g)) {
    const name = match[2] ?? '';
    let replacement: string;
    if (match[1] === '!') replacement = `\${${name}}`;
    else if (name === '') replacement = match[0];
    else if (bound.has(name)) replacement = bound.get(name)!;
    else {
      // The resolver's order: a pseudo parameter, then a `Ref`, then a dotted
      // `Fn::GetAtt`, which no re-read evaluates.
      if (name.includes('.')) return undefined;
      const value = bindReadName(name, bind, pseudo);
      if (value === undefined || typeof value.value !== 'string') return undefined;
      replacement = value.value;
    }
    out += text.slice(cursor, match.index) + replacement;
    cursor = match.index + match[0].length;
  }
  return { value: out + text.slice(cursor) };
}

/**
 * A `{Ref}` or `Fn::Sub` placeholder `name` as a re-read binds it: an `AWS::`
 * name from `pseudo` alone (issue #4962), any other from `bind`. An `AWS::`
 * name `bind` answers too refuses: `resolveRef` takes a declared parameter
 * first and `resolveSub` the pseudo parameter, so the two disagree on it.
 */
function bindReadName(
  name: string,
  bind: ParameterBinding,
  pseudo: ParameterBinding
): { value: unknown } | undefined {
  if (!name.startsWith('AWS::')) return bind(name);
  return bind(name) === undefined ? pseudo(name) : undefined;
}

/**
 * Collect into `names` every `Fn::If` condition name in `node`, untaken
 * branches included; `false` for a malformed one or a source too deep.
 */
function collectRereadConditions(node: unknown, names: Set<string>, depth = 0): boolean {
  if (depth > MAX_REREAD_DEPTH) return false;
  if (Array.isArray(node)) {
    return node.every((element) => collectRereadConditions(element, names, depth + 1));
  }
  if (!isPlainObject(node)) return true;
  if (Object.hasOwn(node, 'Fn::If')) {
    const args = node['Fn::If'];
    if (!Array.isArray(args) || typeof args[0] !== 'string') return false;
    names.add(args[0]);
  }
  return Object.values(node).every((child) => collectRereadConditions(child, names, depth + 1));
}

/** Does `node` hold a {@link REREAD_TRIGGERS} intrinsic anywhere? */
function holdsRereadTrigger(node: unknown, depth = 0): boolean {
  if (depth > MAX_REREAD_DEPTH) return false;
  if (Array.isArray(node)) return node.some((element) => holdsRereadTrigger(element, depth + 1));
  if (!isPlainObject(node)) return false;
  return Object.entries(node).some(
    ([key, child]) => REREAD_TRIGGERS.has(key) || holdsRereadTrigger(child, depth + 1)
  );
}

/**
 * Does `spelling` render to exactly `value` through `parentSecrets`' own
 * pairs, leaf for leaf? A string either equals the value and holds no
 * plaintext the parent's scan would rewrite (a piece no secret reached), or
 * passes {@link rendersLiteralTo}; a list matches element for element.
 */
function rendersReadTo(
  spelling: unknown,
  parentSecrets: RecordedSecretValues,
  value: unknown
): boolean {
  if (typeof spelling === 'string' && typeof value === 'string') {
    if (spelling === value)
      return (
        redactForState(spelling, { provenance: 'value-scan', secrets: parentSecrets }) === spelling
      );
    return rendersLiteralTo(spelling, parentSecrets, value);
  }
  if (Array.isArray(spelling) && Array.isArray(value) && spelling.length === value.length) {
    return spelling.every((element, i) => rendersReadTo(element, parentSecrets, value[i]));
  }
  return false;
}

/** One evaluation of a re-read: the source's real value and its diff-side value. */
interface ParameterReread {
  readonly resolved: unknown;
  readonly redacted: unknown;
}

/**
 * What a re-read assignment that names a parameter its binding does not
 * answer evaluates to: the evaluator walks only the branches the assignment
 * takes, as `resolveIf` does, so at persist time (bound to this resource's
 * recorded reads) such an assignment is one the real pass did NOT take.
 */
const REREAD_UNBOUND: unique symbol = Symbol('cdkd.reread.unbound');

/**
 * What a re-read assignment that does not evaluate, but whose taken branches
 * name no parameter, counts as for the collision walk (issue
 * [#4954](https://github.com/go-to-k/cdkd/issues/4954)): a pass taking it
 * reads no parameter in this leaf, so nothing there reads the carry's slot
 * for one.
 */
const REREAD_PARAMETER_FREE: unique symbol = Symbol('cdkd.reread.parameter-free');

type RereadOutcome =
  | ParameterReread
  | typeof REREAD_NO_VALUE
  | typeof REREAD_UNBOUND
  | typeof REREAD_PARAMETER_FREE
  | undefined;

/** The bindings and `Fn::Split` the DIFF side evaluates a re-read with. */
function diffSideReading(
  bind: ParameterBinding,
  parentSecrets: RecordedSecretValues
): { bind: ParameterBinding; split: (text: string, delimiter: string) => string[] } {
  return {
    bind: (name) => {
      const bound = bind(name);
      return bound && { value: redactInheritedParameterValue(parentSecrets, name, bound.value) };
    },
    // A token the parent resolved stands for its plaintext; any other is text
    // the child received as text. The resolver's diff pass asks the same bag.
    split: (text, delimiter) =>
      splitOutsideDynamicReferences(text, delimiter, (token) =>
        standsForInheritedSecret(parentSecrets, token)
      ),
  };
}

/**
 * One evaluation of `source` under `choose`: the pair,
 * {@link REREAD_NO_VALUE} where both sides drop out, or `undefined` where it
 * does not re-read ({@link evaluatePureRead} refuses, or `redacted` does not
 * render to `resolved`).
 */
function rereadUnder(
  source: unknown,
  bind: ParameterBinding,
  parentSecrets: RecordedSecretValues,
  choose: IfBranchChoice
): ParameterReread | typeof REREAD_NO_VALUE | undefined {
  // The pseudo values are the resolver's own (issue #4962) and carry no
  // secret, so both sides bind them as they are.
  const pseudo = pseudoBindingOf(parentSecrets);
  const resolved = evaluatePureRead(source, bind, pseudo, plainSplit, choose);
  if (resolved === undefined) return undefined;
  const diffSide = diffSideReading(bind, parentSecrets);
  const redacted = evaluatePureRead(source, diffSide.bind, pseudo, diffSide.split, choose);
  if (redacted === undefined) return undefined;
  if (resolved.value === REREAD_NO_VALUE || redacted.value === REREAD_NO_VALUE) {
    return resolved.value === redacted.value ? REREAD_NO_VALUE : undefined;
  }
  if (!rendersReadTo(redacted.value, parentSecrets, resolved.value)) return undefined;
  return { resolved: resolved.value, redacted: redacted.value };
}

/**
 * Does `node` name, on the branches `choose` takes, a `{Ref}` or an `Fn::Sub`
 * placeholder `isParameter` answers (issue
 * [#4954](https://github.com/go-to-k/cdkd/issues/4954))? `true` for a
 * malformed `Fn::If` or a source too deep, so a caller refuses. Every other
 * intrinsic's arguments are walked whole, and a variable-map name counts:
 * over-reading only refuses more.
 *
 * `true` for a `{{resolve:` string too: `cdkd scrub` resolves a COPY of every
 * ancestor of a cross-region reference it pins (`pinCrossRegionSecrets`), so
 * the `Fn::If` holding one records its branch on the copy while the persist
 * walk reads the original, finds no record, and the slot answers. Refusing
 * keeps the collision walk's verdict to what every pass positions.
 */
function namesParameterOnBranches(
  node: unknown,
  choose: IfBranchChoice,
  isParameter: (name: string) => boolean,
  depth = 0
): boolean {
  if (depth > MAX_REREAD_DEPTH) return true;
  if (typeof node === 'string') return node.includes('{{resolve:');
  if (Array.isArray(node)) {
    return node.some((element) =>
      namesParameterOnBranches(element, choose, isParameter, depth + 1)
    );
  }
  if (!isPlainObject(node)) return false;
  if (Object.hasOwn(node, 'Fn::If')) {
    const args = node['Fn::If'];
    if (Object.keys(node).length !== 1) return true;
    if (!Array.isArray(args) || args.length !== 3 || typeof args[0] !== 'string') return true;
    const tookTrue = choose(args[0], node);
    if (tookTrue === undefined) return true;
    return namesParameterOnBranches(tookTrue ? args[1] : args[2], choose, isParameter, depth + 1);
  }
  if (typeof node['Ref'] === 'string' && isParameter(node['Ref'])) return true;
  const sub = node['Fn::Sub'];
  const text = typeof sub === 'string' ? sub : Array.isArray(sub) ? sub[0] : undefined;
  if (typeof text === 'string') {
    for (const match of text.matchAll(/\$\{([^}!][^}]*)\}/g)) {
      if (isParameter(match[1]!.trim()) || isParameter(match[1]!)) return true;
    }
  }
  return Object.values(node).some((child) =>
    namesParameterOnBranches(child, choose, isParameter, depth + 1)
  );
}

/**
 * The source re-read under every assignment of its `Fn::If` conditions (issue
 * [#4919](https://github.com/go-to-k/cdkd/issues/4919)), one entry per
 * assignment: the pair, {@link REREAD_NO_VALUE} where both sides drop out,
 * {@link REREAD_UNBOUND} where it names a parameter `bind` does not answer,
 * {@link REREAD_PARAMETER_FREE} (only when `parameterFree` is given) where it
 * does not re-read but its taken branches name no parameter that answers, or
 * `undefined` where it does not re-read for any other reason. `undefined` overall
 * for a source with no {@link REREAD_TRIGGERS} intrinsic, a malformed
 * `Fn::If`, or more than {@link MAX_REREAD_CONDITIONS} condition names.
 *
 * Assigned per condition NAME, as `resolveIf` reads one evaluated table: one
 * name never takes two branches in one pass. Names that are equivalent are
 * still assigned independently, which only adds assignments no pass takes.
 */
function rereadAssignments(
  source: unknown,
  bind: ParameterBinding,
  parentSecrets: RecordedSecretValues,
  /** Names whose missing binding proves the assignment untaken; none by default. */
  untakenWhenUnbound: (name: string) => boolean = () => false,
  /** The parameter names for {@link REREAD_PARAMETER_FREE}; omitted, none is. */
  parameterFree?: (name: string) => boolean
): RereadOutcome[] | undefined {
  if (!holdsRereadTrigger(source)) return undefined;
  const conditions = new Set<string>();
  if (!collectRereadConditions(source, conditions)) return undefined;
  if (conditions.size > MAX_REREAD_CONDITIONS) return undefined;
  const names = [...conditions];
  const out: RereadOutcome[] = [];
  for (let assignment = 0; assignment < 2 ** names.length; assignment++) {
    const choose: IfBranchChoice = (condition) =>
      Math.floor(assignment / 2 ** names.indexOf(condition)) % 2 === 1;
    let unbound = false;
    const tracked: ParameterBinding = (name) => {
      const bound = bind(name);
      if (bound === undefined && untakenWhenUnbound(name)) unbound = true;
      return bound;
    };
    const reread = rereadUnder(source, tracked, parentSecrets, choose);
    if (unbound) out.push(REREAD_UNBOUND);
    else if (reread !== undefined) out.push(reread);
    else if (
      parameterFree !== undefined &&
      !namesParameterOnBranches(source, choose, parameterFree)
    ) {
      out.push(REREAD_PARAMETER_FREE);
    } else out.push(undefined);
  }
  return out;
}

/**
 * Re-read a nested-stack child's leaf source holding `Fn::Select`,
 * `Fn::Split` or `Fn::If` over its parameters with the bindings the DIFF side
 * uses (issues [#4731](https://github.com/go-to-k/cdkd/issues/4731),
 * [#4919](https://github.com/go-to-k/cdkd/issues/4919)): `resolved` is the
 * source evaluated with `bind`'s real values, `redacted` with each value as
 * {@link redactInheritedParameterValue} answers it -- the function
 * `redactParametersForDiff` (`deploy-engine/masking.ts`) binds -- so `redacted` is what the
 * diff side computes for the leaf, splitting as it does
 * ({@link splitOutsideDynamicReferences}: a token stays whole, issue
 * [#4914](https://github.com/go-to-k/cdkd/issues/4914)). A re-read requires
 * the source to be pure ({@link evaluatePureRead}) and `redacted` to render,
 * through the parent's own pairs, to exactly `resolved` ({@link rendersReadTo}):
 * a delimiter cutting a PLAINTEXT, a piece left holding a plaintext, an
 * unpaired token all refuse.
 *
 * STATIC, for the collision walk (`poisonRenderedSpellingsCollidingIn`),
 * which runs before any condition is evaluated and reads such a leaf as
 * answered per parameter rather than from the carry's slot: EVERY assignment
 * of the source's `Fn::If` conditions must re-read, drop out on both sides,
 * or name no parameter `bind` answers on its taken branches (a pass taking it
 * reads none here), and at least one must re-read. The persist walk
 * ({@link positionByParameterReread}) evaluates the branches the resolver
 * RECORDED it took (issue
 * [#4954](https://github.com/go-to-k/cdkd/issues/4954)), so two assignments
 * resolving to one value spelled two ways need no telling apart. That holds
 * only while the persist walk's source is the very template objects the pass
 * resolved into its bag: without the record, the walk's leaf-based fallback
 * refuses those shapes and the slot answers, which this verdict does not
 * predict. The pair returned is the first assignment's that re-reads;
 * `undefined` otherwise.
 */
export function rereadParameterExpression(
  source: unknown,
  bind: ParameterBinding,
  parentSecrets: RecordedSecretValues
): ParameterReread | undefined {
  const assignments = rereadAssignments(
    source,
    bind,
    parentSecrets,
    undefined,
    (name) => bind(name) !== undefined
  );
  if (
    assignments === undefined ||
    assignments.includes(undefined) ||
    assignments.includes(REREAD_UNBOUND)
  ) {
    return undefined;
  }
  return assignments.find(
    (entry): entry is ParameterReread =>
      entry !== undefined &&
      entry !== REREAD_NO_VALUE &&
      entry !== REREAD_UNBOUND &&
      entry !== REREAD_PARAMETER_FREE
  );
}

/** Do two re-reads share a `resolved` value but differ in their `redacted` one? */
function ambiguousRereads(rereads: readonly ParameterReread[]): boolean {
  return rereads.some((a, i) =>
    rereads
      .slice(i + 1)
      .some(
        (b) =>
          deepEqualJsonValue(a.resolved, b.resolved) && !deepEqualJsonValue(a.redacted, b.redacted)
      )
  );
}

/**
 * Persist a nested-stack child leaf whose source is `Fn::Select`,
 * `Fn::Split` or `Fn::If` over its parameters as the diff side computes it
 * (issues [#4731](https://github.com/go-to-k/cdkd/issues/4731),
 * [#4919](https://github.com/go-to-k/cdkd/issues/4919)), or `undefined` (the
 * caller keeps its existing arms).
 *
 * Such a leaf used to fall to the CHILD bag's value scan, whose one slot per
 * plaintext holds whichever parameter this resource read LAST: in a resource
 * reading a literal-spelled parameter (#4644) beside a same-plaintext sibling,
 * one of the two leaves persisted the other's token, and
 * `poisonRenderedSpellingsCollidingIn` had to withdraw the literal's spelling
 * for the whole child. Re-reading answers each leaf from its own parameters.
 *
 * An `Fn::If` takes the branch the resolver RECORDED this pass took
 * (`takenIfBranchOf`, issue [#4954](https://github.com/go-to-k/cdkd/issues/4954)),
 * the branch the diff side takes too, as it evaluates the same conditions.
 * Only where some `Fn::If` the evaluation meets has no record (none was
 * resolved into this bag, or one was resolved two ways) is the branch read off
 * the LEAF (issue #4919): every condition assignment must either re-read with
 * this resource's recorded values or name a DECLARED parameter this resource
 * never read (one the pass did not take: it read every parameter its taken
 * branches name; a `Ref` to a resource or pseudo parameter is no such proof),
 * and those whose `resolved` value IS the leaf must agree on one diff-side
 * value. An assignment refused for any other reason may be the taken one, so
 * it refuses the leaf. The records are keyed by OBJECT: `source` must be the
 * object the pass resolved into `secrets` (a structural copy finds none), or
 * {@link rereadParameterExpression}'s verdict for the collision walk is wrong.
 *
 * {@link positionByInheritedParameter}'s conditions, over the re-read: this
 * resource's resolution read every parameter the taken source names (its
 * recorded values bind the re-read; the #2087 scope), the source evaluated
 * with them IS the leaf, the leaf carries no child-only plaintext, and the
 * child bag would not rewrite the answer.
 */
export function positionByParameterReread(
  bag: unknown,
  source: Record<string, unknown>,
  secrets: RecordedSecretValues
): unknown {
  const reads = inheritedParameterReads.get(secrets);
  if (reads === undefined || typeof reads === 'symbol') return undefined;
  if (typeof bag !== 'string' && !Array.isArray(bag)) return undefined;
  if (!holdsRereadTrigger(source)) return undefined;
  const bind: ParameterBinding = (name) =>
    reads.values.has(name) ? { value: reads.values.get(name) } : undefined;
  let unrecorded = false;
  const recorded = rereadUnder(source, bind, reads.parent, (_, node) => {
    const taken = takenIfBranchOf(secrets, node);
    if (taken === undefined) unrecorded = true;
    return taken;
  });
  let answer: unknown;
  if (!unrecorded) {
    if (
      recorded === undefined ||
      recorded === REREAD_NO_VALUE ||
      !deepEqualJsonValue(recorded.resolved, bag)
    ) {
      return undefined;
    }
    answer = recorded.redacted;
  } else {
    const declared = reads.declared;
    const assignments = rereadAssignments(
      source,
      bind,
      reads.parent,
      (name) => declared?.has(name) === true
    );
    // An assignment refused for any reason but an unread parameter may be the
    // one the pass took, whose leaf another assignment could merely equal.
    if (assignments === undefined || assignments.includes(undefined)) return undefined;
    const matching = assignments.filter(
      (entry): entry is ParameterReread =>
        entry !== undefined &&
        entry !== REREAD_NO_VALUE &&
        entry !== REREAD_UNBOUND &&
        entry !== REREAD_PARAMETER_FREE &&
        deepEqualJsonValue(entry.resolved, bag)
    );
    if (matching.length === 0 || ambiguousRereads(matching)) return undefined;
    answer = matching[0]!.redacted;
  }
  if (carriesChildOnlyPlaintext(bag, secrets, reads.parent)) return undefined;
  if (!deepEqualJsonValue(redactForState(answer, { provenance: 'value-scan', secrets }), answer))
    return undefined;
  return answer;
}
