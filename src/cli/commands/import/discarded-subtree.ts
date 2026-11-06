/** The opener every dynamic reference starts with, secret-bearing or not. */
export const DYNAMIC_REFERENCE_OPENER = '{{resolve:';

/**
 * How many dynamic-reference OPENERS a property bag carries, counted over its
 * JSON serialization rather than by walking string leaves — which is the whole
 * point on the RAW side: a token assembled by `Fn::Join` is SPLIT across array
 * elements, so `{{resolve:secretsmanager:` survives as a fragment that no scan
 * for a COMPLETE token would see. `secretValueFromJson` renders exactly that
 * shape, so the split form is the common one, not the exotic one.
 *
 * `undefined` when the bag cannot be serialized. Callers treat that as "cannot
 * vouch for this bag" rather than as zero — the only safe direction, since the
 * cost of a false refusal is a drift baseline and the cost of a false pass is a
 * plaintext secret in `state.json`.
 */
export function countDynamicReferenceOpeners(bag: unknown): number | undefined {
  let text: string;
  try {
    text = JSON.stringify(bag ?? {}) ?? '';
  } catch {
    return undefined;
  }
  let count = 0;
  for (let from = 0; ;) {
    const at = text.indexOf(DYNAMIC_REFERENCE_OPENER, from);
    if (at === -1) return count;
    count++;
    from = at + DYNAMIC_REFERENCE_OPENER.length;
  }
}

/**
 * Whether an object key can make the resolver treat its object as an
 * INTRINSIC. Deliberately BROADER than the resolver's own dispatch list
 * (`resolveValue` names specific keys; this matches any `Fn::`-prefixed one):
 * the callers below use it to decide what a DISCARDED subtree could have
 * been, and over-matching there only widens a refusal, never a pass.
 */
function isIntrinsicShapedKey(key: string): boolean {
  return key === 'Ref' || key.startsWith('Fn::');
}

/**
 * Whether a subtree the resolve DISCARDED is provably INERT: pure JSON
 * literals, carrying no `{{resolve:` opener text in any string leaf and no
 * intrinsic-shaped object key anywhere.
 *
 * This is the capability question of issue
 * [#2850](https://github.com/go-to-k/cdkd/issues/2850) asked in the
 * fail-closed direction. Asking "could this subtree have carried or SOURCED a
 * dynamic reference" precisely would need enumerating every source a reference
 * can arrive from — a parameter `Default` via `Ref` or `Fn::Sub`, a `Mappings`
 * entry via `Fn::FindInMap`, another stack's outputs via `Fn::ImportValue` /
 * `Fn::GetStackOutput` — and the enumeration missing one form is exactly how
 * the opener COUNT missed the first two. Every one of those source forms is an
 * intrinsic, so "no intrinsic at all" covers them all without naming any, and
 * a plain-literal subtree is one whose value at deploy time was the same
 * public template text this walk can read.
 */
function isInertDiscardedSubtree(node: unknown): boolean {
  if (typeof node === 'string') return !node.includes(DYNAMIC_REFERENCE_OPENER);
  if (node === null || typeof node !== 'object') return true;
  if (Array.isArray(node)) return node.every((element) => isInertDiscardedSubtree(element));
  const record = node as Record<string, unknown>;
  // `{Ref: 'AWS::NoValue'}` is the ONE intrinsic that cannot have produced a
  // value at deploy time either — CloudFormation defines it as property
  // REMOVAL — so discarding it discards nothing AWS could hold. Without this
  // carve-out the walk refused the single most common `Fn::If` idiom
  // (`[Cond, <value>, {Ref: 'AWS::NoValue'}]`) whenever the condition held,
  // a pure false positive a review round measured (the matrix's NoValue row
  // pins it). Exact single-key match only: a `Ref` beside other keys is the
  // dispatch-order discard and stays non-inert.
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === 'Ref' && record['Ref'] === 'AWS::NoValue') return true;
  return Object.entries(record).every(
    ([key, value]) => !isIntrinsicShapedKey(key) && isInertDiscardedSubtree(value)
  );
}

/**
 * Whether a scalar the resolver consumes RAW (an `Fn::Select` index) is a
 * template-constant literal that `resolveSelect`'s `resolvedList[index]` read
 * actually honors: a number, or the CANONICAL digit-string of one. The
 * canonical form is load-bearing, not pedantry — a delta review round
 * measured `['a','b']['01']` as `undefined` (a non-canonical string is a
 * property name, not an index) while CloudFormation integer-parses it to 1,
 * so `'01'` is exactly as selection-divergent as an intrinsic index and must
 * not count as static. Anything non-static makes the selection depend on a
 * value this import cannot reproduce.
 */
function isStaticSelectIndex(value: unknown): boolean {
  // Non-negative on the number arm too (parent review): `resolveSelect`
  // refuses a negative index (issue #3574) — the string arm's regex already
  // refuses `'-1'`, and the two arms vouching for different shapes was the
  // asymmetry. This predicate's job is "the selection is a real,
  // deploy-constant index", which a negative never is.
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0;
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
}

/**
 * A `Fn::FindInMap` lookup-key argument the resolver can only have resolved
 * to the same key at deploy time: a plain scalar literal CARRYING NO
 * `{{resolve:` opener. The opener clause is the same delta-review finding one
 * helper up: `resolveFindInMap` resolves each key through `resolveValue`, so
 * a dynamic-reference STRING key is decrypted before the lookup and the
 * selected entry depends on the secret's deploy-time value — not on the
 * template text this walk reads.
 */
function isStaticLookupKey(value: unknown): boolean {
  if (typeof value === 'string') return !value.includes(DYNAMIC_REFERENCE_OPENER);
  return typeof value === 'number' || typeof value === 'boolean';
}

/**
 * ARM 3 of the observed-baseline refusal (issue
 * [#2850](https://github.com/go-to-k/cdkd/issues/2850)): did the resolve
 * DISCARD a subtree it cannot vouch is inert?
 *
 * The opener-count comparison (ARM 2) sees only what the raw bag SPELLS, and
 * the issue measured two ways past it on the success arm: a downgraded
 * `Fn::If` that drops one reference while a parameter-sourced reference is
 * added elsewhere (the totals balance), and a reference sourced ENTIRELY from
 * outside the bag then dropped (both counts read zero, nothing throws, no
 * warn fires). Both are DISCARD events: the resolver threw a subtree away
 * unresolved, and whatever that subtree would have produced — which is what
 * AWS actually holds when the deployed condition took the other branch — is
 * exactly what the persisted bag cannot position a redaction for.
 *
 * So this walk detects the discard EVENTS on the RAW bag instead of comparing
 * positions across the resolve (which would need a path identity across the
 * `Fn::If` collapse that does not exist). The discarders, enumerated from
 * `IntrinsicFunctionResolver` rather than assumed — and re-enumerated by this
 * PR's review round, which found the first cut had missed TWO (`Fn::FindInMap`
 * and `Fn::Select` below; an earlier revision called `resolveIf` "the only
 * LAZY selector" and the resolver's own source refutes it):
 *
 *  - `resolveIf` — a LAZY selector: it resolves the selected branch
 *    only, so the unselected branch is discarded UNRESOLVED. A missing
 *    condition warns and selects the FALSE branch (no throw), so the success
 *    arm reaches it. Dispatch is `'Fn::If' in obj`, not single-key.
 *  - `resolveFindInMap` — the OTHER lazy site: the 4-argument form's
 *    `DefaultValue` is resolved only on a lookup MISS, so a HIT discards it
 *    unresolved; and a non-literal lookup KEY makes the un-taken mapping
 *    entries discarded template content. The walk's own arm comment carries
 *    both modes.
 *  - `resolveSelect` — eager on the LIST but the INDEX is consumed RAW, never
 *    resolved: an intrinsic index selects `undefined` here while
 *    CloudFormation resolved it at deploy, so the whole list is potentially
 *    discarded content. (With a NUMERIC-LITERAL index the selection is
 *    template-constant and the un-selected elements were discarded at deploy
 *    too — that case discards nothing AWS could hold.)
 *  - Dispatch order itself — `resolveValue` dispatches on the first matching
 *    intrinsic key, so an object holding an intrinsic key AMONG OTHER KEYS
 *    resolves as that intrinsic and silently DROPS the sibling keys'
 *    subtrees.
 *  - NOT `Fn::Sub`: its variable map is resolved eagerly, every entry.
 *  - NOT `Fn::Join`'s delimiter: it is consumed raw too, but CloudFormation
 *    itself admits no intrinsic there, and an intrinsic delimiter joins as
 *    `[object Object]` — a mangled value, not a discarded reference.
 *
 * Fail-closed rules, in the order tested (an earlier revision of this list
 * omitted the two arms the review round added while still claiming to BE the
 * tested order — a list that claims an order and is not the order is worse
 * than no list, so keep it complete or delete the claim):
 *
 *  - an ARRAY recurses element-wise, so a discarder inside a list property
 *    (`SecurityGroupIds: [{Fn::If: ...}]`) is found;
 *  - single-key `Fn::If` with well-formed args and a condition the evaluated
 *    map carries (`Object.hasOwn`, the same test `resolveIf` uses since issue
 *    #2767): the UNSELECTED branch must be inert, and the SELECTED branch is
 *    recursed into;
 *  - single-key `Fn::If` whose condition the map does NOT carry: BOTH
 *    branches must be inert. The resolver warns and takes the false branch,
 *    so this is a SUPERSET of mirroring it — mirroring the lookup exactly is
 *    the two-spellings-of-one-question drift this repo keeps paying for, and
 *    the superset can only over-refuse, never leak;
 *  - single-key `Fn::If` with MALFORMED args: refuse;
 *  - single-key `Fn::FindInMap`: MALFORMED (< 3 args) refuses; a 4th
 *    argument must be inert AS A WHOLE (its `DefaultValue` is resolved only
 *    on a lookup miss, and any sibling key there — or a whole 4th arg with
 *    no `DefaultValue` key — is discarded unconditionally); a non-literal
 *    lookup key refuses unless the map in scope is inert (the NAMED map for
 *    a literal map name, the whole `Mappings` section otherwise); then the
 *    args recurse;
 *  - single-key `Fn::Select`: MALFORMED (not exactly 2 args) refuses; a
 *    non-static index refuses unless the list argument is inert; then the
 *    args recurse;
 *  - a MULTI-KEY object carrying intrinsic-shaped keys: TWO or more such
 *    keys refuse outright (dispatch drops the losers as whole INTRINSICS,
 *    whose values' text is not evidence of what they pull); with exactly
 *    one, every value must be inert — which sibling the dispatch order
 *    drops is deliberately not mirrored here;
 *  - everything else recurses, so a nested `Fn::If` inside an `Fn::Join` /
 *    `Fn::Sub` argument is still found.
 *
 * Additive beside ARM 1 (throw) and ARM 2 (count loss): refusal strictly
 * widens, so no previously-refused shape can start leaking, and the risk
 * direction is over-refusal alone. The negative controls live in the matrix:
 * an `Fn::If` discarding pure literals stays ADMITTED, and so does a
 * multi-key intrinsic object whose sibling values are literals.
 *
 * THE CALLER WRAPS EVERY CALL IN A FAIL-CLOSED try (see the ARM 3 note at
 * the call site): this walk recurses synchronously and a deep-enough bag
 * overflows the call stack where the JSON.stringify arms still compute.
 */
export function resolveDiscardsNonInertSubtree(
  node: unknown,
  conditions: Record<string, boolean>,
  mappings: unknown
): boolean {
  if (node === null || typeof node !== 'object') return false;
  if (Array.isArray(node)) {
    return node.some((element) => resolveDiscardsNonInertSubtree(element, conditions, mappings));
  }
  const record = node as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === 'Fn::If') {
    const args = record['Fn::If'];
    if (!Array.isArray(args) || args.length !== 3 || typeof args[0] !== 'string') {
      return true;
    }
    const [conditionName, valueIfTrue, valueIfFalse] = args as [string, unknown, unknown];
    if (!Object.hasOwn(conditions, conditionName)) {
      return !isInertDiscardedSubtree(valueIfTrue) || !isInertDiscardedSubtree(valueIfFalse);
    }
    const selected = conditions[conditionName] ? valueIfTrue : valueIfFalse;
    const discarded = conditions[conditionName] ? valueIfFalse : valueIfTrue;
    if (!isInertDiscardedSubtree(discarded)) return true;
    return resolveDiscardsNonInertSubtree(selected, conditions, mappings);
  }
  // `Fn::FindInMap` — TWO discard modes, both found by the PR's review round
  // (the enumeration below this walk's doc block originally called `resolveIf`
  // "the only LAZY selector", which the resolver's own source refutes):
  //
  //  - the 4-argument form's `DefaultValue` is resolved LAZILY, only when the
  //    lookup misses ("resolve it lazily only when we need to fall back to
  //    it", `resolveFindInMap`). A lookup that HITS at import discards the
  //    `DefaultValue` subtree UNRESOLVED — the exact `resolveIf` pattern —
  //    while the deployed stack may have MISSED (the keys were resolved from
  //    values this import does not hold) and AWS holds what the default
  //    resolved to. So a non-inert `DefaultValue` refuses regardless of which
  //    way this import's lookup went. (With ALL-LITERAL keys the hit/miss IS
  //    template-static and deploy-identical, so refusing there is a
  //    deliberate over-refusal — the fail-closed form is kept rather than
  //    re-deriving the lookup, a delta review round weighed and accepted it.)
  //  - a lookup KEY that is not a scalar literal makes WHICH mapping entry
  //    was selected depend on a value this import cannot reproduce, so the
  //    un-taken entries are discarded template content. That matters exactly
  //    when the map holds something non-inert (a `{{resolve:` token — the
  //    Mappings grammar admits no intrinsics, but nothing enforces that on an
  //    imported template), so refuse on the pair: non-literal key AND
  //    non-inert map. The map checked is the NAMED one when the map name is a
  //    literal, the whole `Mappings` section when even that is dynamic.
  if (keys.length === 1 && keys[0] === 'Fn::FindInMap') {
    const args = record['Fn::FindInMap'];
    // Malformed in BOTH directions, like the `Fn::Select` arm below (parent
    // review round 2): `resolveFindInMap` destructures exactly four args and
    // IGNORES the rest, so a fifth argument is discarded WHOLE and unresolved
    // — the same class the 4th-argument check below closes — and judging it
    // by recursion alone admits a `{Ref: ...}` there.
    if (!Array.isArray(args) || args.length < 3 || args.length > 4) return true;
    if (args.length > 3) {
      // The WHOLE 4th argument must be inert, not just its `DefaultValue`
      // (parent review): `resolveFindInMap` reads ONLY that key, so a SIBLING
      // key's subtree there is discarded unconditionally — and a 4th arg with
      // no `DefaultValue` key at all (a typo'd one included) is discarded
      // WHOLE, since `hasDefaultValue` reads false and the lookup proceeds as
      // 3-arg. Judging the container instead of extracting one key covers
      // every one of those shapes with the same fail-closed question, and an
      // ordinary `{ DefaultValue: 'literal' }` is inert as a whole exactly
      // when its default is.
      if (!isInertDiscardedSubtree(args[3])) return true;
    }
    if (!args.slice(0, 3).every((key) => isStaticLookupKey(key))) {
      const scope =
        typeof args[0] === 'string' &&
        mappings !== null &&
        typeof mappings === 'object' &&
        Object.hasOwn(mappings as Record<string, unknown>, args[0])
          ? (mappings as Record<string, unknown>)[args[0]]
          : mappings;
      if (!isInertDiscardedSubtree(scope)) return true;
    }
    return args.some((arg) => resolveDiscardsNonInertSubtree(arg, conditions, mappings));
  }
  // An intrinsic `Fn::Select` index is resolved at deploy time (a `Ref` to a
  // parameter, an `Fn::FindInMap`), so the template text does not say which
  // element was selected. The list is resolved eagerly (every element
  // decrypted and recorded), but the un-selected elements are then discarded,
  // and with the maps dead by capture time the persisted bag cannot vouch for
  // what AWS holds at that position. A non-static index over a non-inert list
  // therefore refuses; over a pure-literal list every element AWS could hold
  // is public template text and the resource keeps its baseline.
  if (keys.length === 1 && keys[0] === 'Fn::Select') {
    const args = record['Fn::Select'];
    if (!Array.isArray(args) || args.length !== 2) return true;
    // A static index over a LITERAL list must also be IN BOUNDS (parent
    // review round 2): index 999 on a two-element list makes
    // `resolveSelect` answer with its OutOfBounds placeholder, and the whole
    // eagerly-decrypted list is discarded. Only a literal array's length is
    // checkable statically;
    // an intrinsic list argument keeps the index-only test.
    const staticSelection =
      isStaticSelectIndex(args[0]) && (!Array.isArray(args[1]) || Number(args[0]) < args[1].length);
    if (!staticSelection && !isInertDiscardedSubtree(args[1])) return true;
    return args.some((arg) => resolveDiscardsNonInertSubtree(arg, conditions, mappings));
  }
  if (keys.length > 1 && keys.some((key) => isIntrinsicShapedKey(key))) {
    // TWO OR MORE intrinsic-shaped keys refuse OUTRIGHT (parent review):
    // dispatch order runs exactly one of them and drops the others as WHOLE
    // INTRINSICS — `{Ref: 'P', 'Fn::Sub': '${SecretRef}'}` discards the
    // `Fn::Sub`, whose VALUE is an opener-free string while its SEMANTICS
    // pull a parameter — so judging the dropped values' text is not evidence
    // there. With a single intrinsic key, the dropped siblings are plain
    // VALUES and the inertness question is the right one.
    if (keys.filter((key) => isIntrinsicShapedKey(key)).length > 1) return true;
    return !keys.every((key) => isInertDiscardedSubtree(record[key]));
  }
  return keys.some((key) => resolveDiscardsNonInertSubtree(record[key], conditions, mappings));
}
