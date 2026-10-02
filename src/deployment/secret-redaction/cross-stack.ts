import { type RecordedSecretValues } from './pairs.js';
import { isPlainObject, isSingleDynamicReferenceToken } from './rules.js';

/**
 * Every cross-stack source leaf whose producer stored a WHOLE
 * `{{resolve:...}}` token, against the token the producer stored and the
 * plaintext it resolved to — SCOPED TO ONE RESOLUTION PASS (issue
 * [#2059](https://github.com/go-to-k/cdkd/issues/2059)).
 *
 * WHY A SECOND STORE, when {@link recordedSecretExpressions} already holds
 * every expression uncollapsed. That set is a CANDIDATE LIST, and
 * {@link positionByIntrinsicSkeleton} picks from it by matching the source
 * leaf's literal TEXT. `Fn::ImportValue` / `Fn::GetStackOutput` carry no text
 * about their expression at all — an export NAME bears no relation to the
 * producer's `{{resolve:...}}` string — so a text matcher can only ever REFUSE
 * for them, and a refusal falls through to the plaintext-keyed value scan,
 * which is the collapse. Two consumer leaves importing an `:AWSCURRENT` and an
 * `:AWSPREVIOUS` export of one secret momentarily resolve to the SAME plaintext
 * during a rotation, so both were persisted holding whichever expression was
 * recorded last, and `resolveReplayProps` then re-resolves the WRONG reference
 * against the live resource on a rollback or a `cdkd drift --revert`.
 *
 * What closes it is an ASSOCIATION rather than a matcher, and the resolver is
 * the only place both halves are in hand at once: it knows the source leaf it
 * is resolving AND the token the producer stored. This is where it puts them.
 *
 * THE SCOPE IS THE SAFETY ARGUMENT, and it took two rounds to get right, so the
 * history is recorded rather than left to be re-derived. The store began
 * PROCESS-WIDE — one module-level map, cleared with the resolver caches — and
 * that is unsound here for a reason no amount of narrowing reaches. The key is
 * not region-qualified: an `Fn::ImportValue` key carries no region at all and
 * an `Fn::GetStackOutput` that omits `Region` keys it empty, so ONE key
 * genuinely names TWO producers inside a single `cdkd deploy --all`, where
 * `deploy.ts` builds a resolver per stack region. A second stack's leaf was
 * then certified with the FIRST stack's region-pinned expression — a case the
 * value scan gets RIGHT, so it was a NEW wrong answer rather than a missed
 * improvement. Pairing each entry with its plaintext narrowed that but could
 * not close it: two regions holding the SAME value (a Secrets Manager
 * multi-region replica, a shared API key) pair happily, and "correct only while
 * replication holds" is a property nobody declared and nothing enforces.
 *
 * So the store is keyed by the RESOLUTION PASS's own {@link RecordedSecretValues}
 * bag, and a foreign entry is not merely refused — it cannot be REACHED. That
 * bag is already per-pass and already travels from the resolver context to the
 * redaction path (`DeployEngine.perResourceSecrets`, `cdkd scrub`'s
 * `perResourceSecrets`, `rollback-executor.ts`'s `secrets`, each storing the
 * very object the resolver mutated), so this is a scope change rather than new
 * plumbing, and no call site had to grow a parameter. A caller that hands the
 * redaction path a DIFFERENT bag from the one it resolved with — `cdkd state
 * refresh-observed`, whose map is empty by construction because it neither
 * synthesizes nor resolves — simply finds no associations and falls back to the
 * value scan, which is the direction a mismatch must fail in.
 *
 * A `WeakMap` so a pass's associations die with its bag. That replaces an
 * explicit clear paired with `resetAccountInfoCache`, which production never
 * called — and it is what keeps the PLAINTEXTS these entries hold from
 * outliving the pass that fetched them.
 *
 * Each entry still carries its plaintext, and the reader still refuses an entry
 * whose plaintext is not the bag it is certifying. That check is now
 * BELT-AND-BRACES against a foreign pass, and it is deliberately kept: inside
 * ONE pass it is still the only guard against a bag/source MISALIGNMENT, where
 * a readback bag holds a different resource's secret while the source leaf
 * still spells this import.
 *
 * ONE class of row is NOT written by the resolver: the `Ref` rows a nested-stack
 * CHILD inherits from its parent through
 * {@link inheritNestedStackParameterAssociations} (issue #2291). Those describe
 * a leaf whose producer is the PARENT ENGINE rather than a producer stack read
 * during this pass, so the writer is the engine and the association is copied in
 * at context-construction time. The reader below is unchanged for them — the
 * three conditions mean exactly what they mean for the resolver-written rows.
 *
 * A key recorded against a DIFFERENT (expression, plaintext) pair is POISONED
 * to {@link CONFLICTING_CROSS_STACK} rather than overwritten, and the reader
 * then refuses. Either half differing is enough: two expressions under one key
 * means the pass read one leaf identity two ways, and one expression under two
 * plaintexts is the same reference answering differently in two regions (the
 * issue [#1933](https://github.com/go-to-k/cdkd/issues/1933) shape, reachable
 * within one pass through a producer-region resolver). Guessing between them
 * would be the collapse this exists to remove, one step over. Every refusal
 * degrades to the value scan, i.e. to today's behavior, so no case gets worse.
 */
export interface CrossStackAssociation {
  /**
   * The WHOLE `{{resolve:...}}` token the producer's state held -- or, from
   * the nested-stack recorder's sub-floor carry (issue #3079), the parent's
   * literal FRAME around one (`port:{{resolve:...}}`), the string its
   * whole-value entry persists.
   */
  readonly expression: string;
  /** What that token resolved to when this pass read the producer. */
  readonly plaintext: string;
}

export type CrossStackAssociations = Map<string, CrossStackAssociation | symbol>;

export const crossStackAssociations = new WeakMap<RecordedSecretValues, CrossStackAssociations>();

/** Poison for a key seen against two different (expression, plaintext) pairs. */
const CONFLICTING_CROSS_STACK = Symbol('conflicting cross-stack association');

/**
 * Separator for the composite keys {@link crossStackSourceKey} builds.
 *
 * A NUL rather than a printable character: a printable separator (`:` / `|`)
 * does occur inside a real export name — CDK's own convention is
 * `Stack:ExportName` — which would let one leaf's key be read as another's.
 *
 * **It does NOT follow that no two distinct source leaves can spell a single
 * key, and this note asserted that for a while** (go-to-k/cdkd#3496). The
 * reason given was that no AWS export name, stack name, output name, region or
 * role ARN can contain a NUL — a claim about what AWS ACCEPTS, while these
 * halves are TEMPLATE literals read straight out of the intrinsic. A hand-written
 * template can put a NUL in any of them.
 *
 * What makes the key safe is not injectivity but what happens on a collision:
 * the association store POISONS a slot recorded against a differing
 * (expression, plaintext) pair rather than overwriting it, and the scope is a
 * `WeakMap` on the pass's own bag. So a forged key degrades to a REFUSAL, never
 * to one leaf's expression being served for another's. Keep that property if
 * this separator is ever revisited; it, not the charset, is the guarantee.
 */
const CROSS_STACK_KEY_SEPARATOR = '\u0000';

/** A non-empty literal string, or `undefined` for anything else. */
function literalStringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Split the STRING spelling of an `Fn::GetAtt` argument into its logical id and
 * its attribute name, or `undefined` when the string is not a well-formed one.
 *
 * THE ONE ANSWER TO "what arity does the string form accept", shared by the two
 * sites that must agree about it (issue
 * [#2270](https://github.com/go-to-k/cdkd/issues/2270)):
 * `IntrinsicFunctionResolver.resolveGetAtt`, which RESOLVES the reference, and
 * {@link crossStackSourceKey} below, which keys the same leaf for the persist
 * path. They were two spellings of one question and they disagreed -- the
 * resolver split on every dot and rejected anything but two segments, so the
 * key function copied that rule ("the string form only at exactly two
 * dot-separated segments, `resolveGetAtt` throws otherwise"). When #2270
 * widened the resolver to CloudFormation's actual rule, a paraphrase here would
 * have gone silently stale in the direction that matters: the resolver would
 * key a leaf the persist path refuses, and issue
 * [#2059](https://github.com/go-to-k/cdkd/issues/2059)'s per-leaf positioning
 * would degrade to the plaintext-keyed value scan for exactly the nested-stack
 * OUTPUT references that positioning exists for. A shared function cannot drift.
 *
 * IT LIVES HERE, in a family that is a LEAF by design (see the header of
 * `secret-redaction.ts` -- it imports nothing outside `secret-redaction/`,
 * because both the resolver and the deploy engine consume it), rather than in
 * the resolver: the resolver ALREADY imports this module, so the dependency
 * runs in the only direction that does not create a cycle.
 *
 * The rule is CloudFormation's: split on the FIRST dot only, because an
 * ATTRIBUTE NAME may itself contain dots (`Outputs.<Key>` on an
 * `AWS::CloudFormation::Stack`, `Endpoint.Address` on an RDS cluster), so
 * `Child.Outputs.Foo` parses as `["Child", "Outputs.Foo"]`. BOTH halves must be
 * non-empty, which is what still rejects the shapes the old arity test rejected
 * for a real reason -- a bare `MyResource` (no attribute), a leading `.Attr`
 * (no logical id) and a trailing `MyResource.` (empty attribute). `indexOf`
 * answers all three: -1, 0, and `length - 1` respectively.
 *
 * Callers differ only in what they DO with a refusal -- the resolver throws
 * `Invalid Fn::GetAtt format`, this module's key function returns `undefined`
 * and degrades to the value scan -- which is why this returns a value rather
 * than throwing.
 */
export function splitGetAttStringForm(
  getAtt: string
): { logicalId: string; attributeName: string } | undefined {
  const firstDot = getAtt.indexOf('.');
  if (firstDot <= 0 || firstDot === getAtt.length - 1) return undefined;
  return { logicalId: getAtt.slice(0, firstDot), attributeName: getAtt.slice(firstDot + 1) };
}

/**
 * The canonical key identifying a cross-stack source leaf, or `undefined` when
 * this leaf's identity is not LITERALLY COMPUTABLE from the source alone
 * (issue #2059).
 *
 * Both sides of {@link crossStackAssociations} call THIS function, which
 * is what makes the two keys byte-identical by construction: the resolver hands
 * it the raw intrinsic it is about to resolve, the redaction path hands it the
 * template source leaf at the position being persisted, and both are the same
 * template object. Deriving the writer's key from the resolver's RESOLVED
 * `exportName` / `stackName` instead would look equivalent and is not — the
 * persist path has only the source leaf, so the two spellings would have to be
 * proven equal at every slot rather than being the same string.
 *
 * REFUSAL IS THE POINT of the literal test. An export name that is itself an
 * `Fn::Sub` / `Fn::Join` / `Ref` resolves to something the persist path cannot
 * compute — it holds the unresolved template — so there is no honest key for it
 * and this returns `undefined`. The caller then falls back to today's behavior
 * (the skeleton pass, then the value scan) rather than guessing.
 *
 * The resolver's existing `origin` string is deliberately NOT reused: it is a
 * human-readable log label built from RESOLVED values and carrying prose
 * (`(producer X / Y)`), so it is neither derivable from the source leaf nor
 * stable.
 *
 * FIVE arms answer, and the enumeration is kept current because a stale one
 * reads as exhaustive: `Fn::ImportValue`, `Fn::GetStackOutput`, the `Fn::GetAtt`
 * on a nested-stack OUTPUT that issue #2055's read site re-resolves, the
 * single-placeholder `Fn::Sub` that normalizes ONTO that `Fn::GetAtt` key
 * (issue #2270 round 3 -- this list said THREE until issue #2291 noticed it had
 * been four since then), and the `Ref` to a nested-stack CHILD's own PARAMETER
 * (issue #2291). Every other leaf refuses.
 *
 * `Region` and `RoleArn` are OPTIONAL slots, and an ABSENT one keys as empty
 * while a PRESENT-but-non-literal one refuses. Absent has to be its own key
 * rather than being filled in with the resolver's own region: the persist path
 * cannot see that region, so a key built from it could not be recomputed.
 *
 * THE KEY IS THEREFORE NOT REGION-QUALIFIED, and an `Fn::ImportValue` key never
 * is at all — so it does NOT identify one producer on its own. Two stacks in
 * two regions carrying the identical leaf produce the identical key inside one
 * `cdkd deploy --all`, because `deploy.ts` builds a resolver per stack region.
 * An earlier revision of this note claimed the opposite ("one resolver region
 * answers them all"), and that false premise is exactly what let the store's
 * first shape certify one region's expression onto another region's resource.
 * What makes the key safe is not uniqueness but SCOPE:
 * {@link crossStackAssociations} is keyed by the resolution pass's own secrets
 * bag, so a key another pass recorded cannot be reached from here at all. Each
 * entry additionally carries the plaintext it resolved to, which is what
 * refuses a MISALIGNED entry inside one pass.
 *
 * A MULTI-KEY leaf (`{'Fn::ImportValue': 'X', Extra: 1}`) is the one exception
 * to "both sides compute the same string": the resolver reaches this function
 * having already selected the intrinsic, so it hands over a single-key object
 * and gets a key, while the redaction path sees the leaf as authored and
 * refuses on the `keys.length !== 1` test above. That asymmetry is FAIL-SAFE in
 * the only direction it can go — the writer records an association no reader
 * will ever look up — and such a leaf is not valid CloudFormation anyway.
 */
export function crossStackSourceKey(source: Record<string, unknown>): string | undefined {
  const keys = Object.keys(source);
  if (keys.length !== 1) return undefined;
  const key = keys[0]!;

  if (key === 'Fn::ImportValue') {
    const exportName = literalStringOrUndefined(source[key]);
    if (exportName === undefined) return undefined;
    return ['Fn::ImportValue', exportName].join(CROSS_STACK_KEY_SEPARATOR);
  }

  if (key === 'Fn::GetStackOutput') {
    const args = source[key];
    if (!isPlainObject(args)) return undefined;
    // `Object.hasOwn` on EVERY slot, required and optional alike (an earlier
    // revision read the two required ones straight off `args`, which contradicts
    // the rationale below). The resolver's own slot tests use `'X' in args`, and
    // the two agree for a JSON-parsed template — the only bag that can reach the
    // resolver — so this is the STRICTER of the two rather than a divergence: a
    // prototype-inherited slot yields no key here and the leaf falls back, which
    // is the fail-safe direction. They are deliberately not unified, because
    // doing so would loosen a key derivation to match a lookup.
    const stackName = Object.hasOwn(args, 'StackName')
      ? literalStringOrUndefined(args['StackName'])
      : undefined;
    const outputName = Object.hasOwn(args, 'OutputName')
      ? literalStringOrUndefined(args['OutputName'])
      : undefined;
    if (stackName === undefined || outputName === undefined) return undefined;
    const slots: string[] = ['Fn::GetStackOutput', stackName, outputName];
    for (const optional of ['Region', 'RoleArn'] as const) {
      const raw = Object.hasOwn(args, optional) ? args[optional] : undefined;
      if (raw === undefined || raw === null) {
        slots.push('');
        continue;
      }
      const literal = literalStringOrUndefined(raw);
      if (literal === undefined) return undefined;
      slots.push(literal);
    }
    return slots.join(CROSS_STACK_KEY_SEPARATOR);
  }

  // `Fn::GetAtt` on a NESTED-STACK OUTPUT (issue #2055's read site). The
  // resolver re-resolves such a leaf through `reresolveCrossStackValue` exactly
  // as it does the two arms above, so without a key here that arm passed
  // `undefined` and the persist path fell back to the plaintext-keyed value
  // scan. That fallback is only lossless while the plaintexts differ: a child
  // exporting `Cur` (`:AWSCURRENT`) and `Prev` (`:AWSPREVIOUS`) of ONE rotating
  // secret has both outputs resolve to the same value during the `AWSPENDING`
  // window, `recordedSecretValues` collapses them onto whichever expression was
  // recorded last, and BOTH parent properties then persist the survivor's
  // expression -- which `resolveReplayProps` re-resolves and applies to a live
  // resource on rollback, i.e. the WRONG stage. Keying by the consumer's own
  // leaf separates them.
  //
  // BOTH SIDES COMPUTE FROM THE RAW LEAF, which is what makes the two strings
  // identical by construction: the resolver hands over the `Fn::GetAtt`
  // argument exactly as authored (BEFORE it resolves an intrinsic attribute
  // name), and the persist path hands over the template source leaf at the
  // position being persisted. Deriving the resolver's half from its RESOLVED
  // `attributeName` would look equivalent and is not, for the same reason the
  // `Fn::ImportValue` note above gives.
  //
  // The two authored spellings are accepted on the SAME terms the resolver
  // accepts them, and for the string form that is now literally the same
  // FUNCTION rather than a restatement of its rule: {@link
  // splitGetAttStringForm} is what `resolveGetAtt` splits with too, so the two
  // cannot drift apart (issue #2270 -- see that helper for what the drift cost
  // and why the helper lives in this module). It splits on the FIRST dot, so a
  // nested stack's `Child.Outputs.Foo` keys identically to its array spelling
  // `["Child", "Outputs.Foo"]`; the array form is still accepted only at
  // exactly two elements. A NON-LITERAL attribute name refuses, because the
  // persist path holds the unresolved template and could not recompute it.
  // Every refusal degrades to today's behaviour (the skeleton pass, then the
  // value scan).
  if (key === 'Fn::GetAtt') {
    const raw = source[key];
    let logicalId: string | undefined;
    let attributeName: string | undefined;
    if (typeof raw === 'string') {
      // Both halves come back non-empty or the whole split refuses, so the
      // `literalStringOrUndefined` pass the array arm still needs would be a
      // no-op here.
      const split = splitGetAttStringForm(raw);
      if (split === undefined) return undefined;
      logicalId = split.logicalId;
      attributeName = split.attributeName;
    } else if (Array.isArray(raw) && raw.length === 2) {
      logicalId = literalStringOrUndefined(raw[0]);
      attributeName = literalStringOrUndefined(raw[1]);
    }
    if (logicalId === undefined || attributeName === undefined) return undefined;
    return ['Fn::GetAtt', logicalId, attributeName].join(CROSS_STACK_KEY_SEPARATOR);
  }

  // `Fn::Sub` over a SINGLE nested-stack output placeholder, normalized to the
  // `Fn::GetAtt` key above (issue
  // [#2270](https://github.com/go-to-k/cdkd/issues/2270), round 3).
  //
  // WHY THIS ARM EXISTS AT ALL: the same PR that made `${Child.Outputs.Foo}`
  // resolve CREATED a collapse population here. Before it, that placeholder was
  // kept as literal text and carried no secret; after it, the leaf resolves to a
  // plaintext and needs positioning like any other cross-stack read. It had
  // none -- this function refused every `Fn::Sub`, and `intrinsicSkeletonPattern`
  // cannot position it either (its wildcard is `[^}]*`, which cannot cross a
  // `{{resolve:...}}` token's own `}}`), so the leaf fell to the plaintext-keyed
  // value scan. A child exporting two staging labels of ONE rotating secret has
  // both resolve EQUAL during the `AWSPENDING` window, so both parent properties
  // persisted the SURVIVOR's expression and `resolveReplayProps` applied the
  // wrong stage to the live resource on a rollback / `cdkd drift --revert`.
  //
  // IT KEYS AS `Fn::GetAtt`, NOT AS `Fn::Sub`, and that is the whole mechanism
  // rather than a tidiness choice. The WRITER is `resolveGetAtt`, which
  // `resolveSub` calls with the bare placeholder TEXT (`Child.Outputs.Foo`), so
  // the key it records is `crossStackSourceKey({'Fn::GetAtt': 'Child.Outputs.Foo'})`
  // -- it never sees the `Fn::Sub` wrapper at all. Keying this leaf by its
  // `Fn::Sub` text would therefore produce a string the writer's half can never
  // equal, i.e. a key that looks present and never matches. Both halves instead
  // reach `splitGetAttStringForm` with the IDENTICAL substring.
  //
  // EXACTLY ONE PLACEHOLDER AND NOTHING ELSE. A template with surrounding text
  // (`sub-${Child.Outputs.Foo}-end`) resolves to a value that merely EMBEDS the
  // producer's token rather than BEING it, and `recordCrossStackExpression` is
  // whole-token only -- so such a leaf has no single expression to persist and
  // is refused here. `${!Literal}` is CloudFormation's ESCAPE and never resolves
  // anything, so it refuses on the `!` group. A `${Child}` Ref form refuses
  // because `splitGetAttStringForm` requires a dotted attribute -- there is no
  // `Fn::GetAtt` writer behind it.
  //
  // THE 2-ARG `[template, vars]` FORM IS ACCEPTED, but ONLY when the
  // placeholder is genuinely UNBOUND by the variable map. The test follows the
  // WRITER's, as a conservative SUPERSET (see the `in` note below):
  // `resolveSub` consults the map FIRST and a bound variable wins outright, so
  // a bound placeholder never reaches `resolveGetAtt` and no key was ever
  // recorded for it -- while an UNBOUND one falls through to the same-stack
  // lookup and IS keyed, identically to the bare-string form. An
  // earlier revision refused the whole 2-arg form on that first fact alone,
  // which left the unbound spelling in exactly the collapse this arm exists to
  // close (found by review; this PR created that population too, since
  // pre-#2270 the placeholder stayed literal).
  //
  // Dropping the guard and keying every 2-arg form would be the WRONG fix and
  // is worse than the bug: it would certify a leaf the writer never recorded,
  // i.e. attach some other leaf's expression to a bound-variable value. On this
  // path over-redaction beats under-redaction in the wrong direction --
  // `resolveReplayProps` re-resolves the persisted expression and `cdkd drift
  // --revert` PUSHES that baseline back to AWS.
  if (key === 'Fn::Sub') {
    const raw = source[key];
    let template: string | undefined;
    let variables: Record<string, unknown> | undefined;
    if (typeof raw === 'string') {
      template = raw;
    } else if (Array.isArray(raw) && raw.length === 2 && isPlainObject(raw[1])) {
      // Shapes outside `[string, object]` are left refused, but NOT because the
      // writer never records them -- measured, that is only true of some. Arity
      // 1, a `null` / number / string second element and a non-string template
      // all THROW during resolution (0 keys recorded; since issue #2739 the
      // primitive / `null` second element is an explicit refusal in
      // `resolveSub` rather than an incidental `TypeError`). But `['${A.B}', ['x']]`
      // and a 3-element array both RESOLVE cleanly and ARE recorded, because
      // `resolveSub` destructures the first two elements and `Object.entries`
      // does not throw on an array. Those are refused here for a different
      // reason: CloudFormation rejects them, so the population is not worth
      // widening acceptance for. The refusal degrades to the plaintext-keyed
      // value scan -- whose dominant failure is COLLAPSE onto a colliding
      // sibling, not under-redaction (that is only the empty-map case). It is
      // still the better direction than certifying a key the writer never
      // recorded, on a path where `drift --revert` pushes the baseline to AWS.
      if (typeof raw[0] !== 'string') return undefined;
      template = raw[0];
      variables = raw[1];
    }
    if (template === undefined) return undefined;
    const only = /^\$\{(!)?([^}]*)\}$/.exec(template);
    if (only === null || only[1] === '!') return undefined;
    const varName = only[2] ?? '';
    // `in` over `(variables ?? {})`, NOT guarded on `variables !== undefined`:
    // the bare-string form has no map, and the test still runs there as the
    // RETAINED CONSERVATIVE REFUSAL described below -- an earlier revision
    // skipped it for that form and left the identical hole one line over.
    // (`resolveSub` tests its own map on both forms too, but since issue
    // #2739 that map is a null-prototype copy, so the two tests are no longer
    // the same predicate; see the next paragraph for why this one stays.)
    //
    // NOT the writer's predicate character for character, and the difference
    // is in the SAFE direction. Since issue #2739 the writer resolves into a
    // null-prototype copy of this map, so its `in` sees OWN keys only and an
    // INHERITED binding falls through to `Ref` / `GetAtt` resolution like any
    // unbound placeholder -- recorded the ordinary way. This reader tests the
    // caller's plain object, where `in` also answers for an inherited key, so
    // it refuses a SUPERSET of what the writer substitutes. That over-refusal
    // costs only the value scan, and widening to `Object.hasOwn` would be a
    // change made for a population no CloudFormation template produces
    // (`JSON.parse` builds no prototype chain; it makes `__proto__` an OWN
    // key), on a path where `drift --revert` pushes the baseline to AWS. So
    // the wider test stays, as the conservative spelling rather than as a
    // mirror of the writer.
    if (varName in (variables ?? {})) return undefined;
    const split = splitGetAttStringForm(varName);
    if (split === undefined) return undefined;
    return ['Fn::GetAtt', split.logicalId, split.attributeName].join(CROSS_STACK_KEY_SEPARATOR);
  }

  // A `Ref` to a NESTED-STACK CHILD's own template PARAMETER (issue
  // [#2291](https://github.com/go-to-k/cdkd/issues/2291)).
  //
  // This is the DOWNWARD twin of the three arms above, and it is a cross-stack
  // leaf for exactly their reason: the value the leaf reads was produced by
  // ANOTHER stack's resolution. The parent resolves the child's `Parameters`
  // block and hands the child PLAINTEXT, so the child's source leaf is
  // `{Ref: <ParamName>}` -- an intrinsic OBJECT that carries no text about the
  // producer's `{{resolve:...}}` string at all. `intrinsicSkeletonPattern`
  // therefore cannot describe it (it has no literal segments to match a
  // candidate against), so before this arm the leaf fell to the plaintext-keyed
  // value scan. Two parameters resolving to ONE plaintext -- the same secret
  // and JSON key at two version-stage spellings, where `...:stage::` and
  // `...:stage:AWSCURRENT:` resolve identically -- therefore collapsed onto
  // whichever expression the parent recorded last, and `resolveReplayProps`
  // re-resolves the survivor, so `cdkd drift --revert` / rollback pushes the
  // WRONG secret VERSION to the live resource.
  //
  // BOTH SIDES COMPUTE FROM THE PARAMETER NAME. The writer is
  // {@link recordNestedStackParameterExpressions}, which keys the parent's
  // `Properties.Parameters` entries by NAME and reaches this function through
  // `crossStackSourceKey({ Ref: name })`; the persist path hands over the
  // child's template source leaf. Both are the same string by construction,
  // which is the property the `Fn::ImportValue` arm's note above is about.
  //
  // A `Ref` to a RESOURCE keys here too, and the reason that is safe is NOT the
  // one an earlier revision of this comment gave. It claimed CloudFormation
  // requires `Parameters` and `Resources` logical ids to be unique across one
  // template, so the two populations could not overlap. cdkd never submits a
  // template to CloudFormation, so it inherits no such validation, and
  // `IntrinsicFunctionResolver.resolveRef` gives a RESOURCE precedence over a
  // same-named PARAMETER -- so a colliding template resolves the RESOURCE while
  // this key still spells the parameter name, and the association IS reached
  // (measured in review).
  //
  // What actually fences it is {@link positionByCrossStackSource}'s conditions
  // 1 and 2: the leaf's resolved value must be a plaintext in THIS resource's
  // bag AND must equal the plaintext the association was recorded against. For
  // a `Ref` to a resource that value is the resource's PHYSICAL ID, so the
  // collision only certifies anything if a physical id is byte-identical to the
  // inherited secret -- at which point every plaintext-keyed path in this module
  // already rewrites it, and the answer taken is the expression that value was
  // genuinely resolved from. The guard is the VALUE test, not a namespace claim.
  //
  // A pseudo parameter (`{Ref: 'AWS::Region'}`) is likewise keyed and, unlike
  // the resource case, is verified inert: no writer ever records a pseudo name,
  // so the lookup always misses. It is deliberately NOT special-cased -- a name
  // test here would be a second spelling of "what the writer records", and the
  // writer is the authority.
  if (key === 'Ref') {
    const parameterName = literalStringOrUndefined(source[key]);
    if (parameterName === undefined) return undefined;
    return ['Ref', parameterName].join(CROSS_STACK_KEY_SEPARATOR);
  }

  return undefined;
}

/**
 * Remember, FOR THE PASS THAT OWNS `secrets`, that the cross-stack source leaf
 * keyed by `key` reads a producer value that IS the whole `{{resolve:...}}`
 * token `expression`, and that this pass saw it resolve to `plaintext`. Called
 * by the resolver, and only for a token it PROVED secret.
 *
 * `secrets` is the pass's own {@link RecordedSecretValues} bag, used as the
 * SCOPE KEY — the same object the redaction path will be handed. See
 * {@link crossStackAssociations} for why the scope, not the pairing, is what
 * makes this sound.
 */
export function recordCrossStackExpression(
  secrets: RecordedSecretValues,
  key: string,
  expression: string,
  plaintext: string
): void {
  // SHAPE INVARIANT, at the store boundary rather than at the caller. The two
  // payload parameters are both `string`, so the type system cannot see a
  // SWAPPED call — and a swap is not merely a wrong answer here: the reader
  // returns `expression` to be persisted, so a stored `{expression: <plaintext>}`
  // writes a SECRET into `state.json` as soon as a token-shaped bag satisfies
  // the conditions above it (the issue #1917 shape does). Unreachable from the
  // one caller today; this makes it unreachable from any caller, which is the
  // difference between a guarded call site and an invariant.
  //
  // It NARROWS rather than closes, and the residual is worth naming: a swap
  // whose plaintext is ITSELF a complete `{{resolve:...}}` token passes this
  // test, because issue #1917 exists precisely because a secret's VALUE can look
  // like one and nothing distinguishes them from the string alone. So this takes
  // a swap from "persists any secret" to "persists a token-shaped secret", and
  // the seam's own gate covers the rest.
  if (!isSingleDynamicReferenceToken(expression)) return;

  let associations = crossStackAssociations.get(secrets);
  if (associations === undefined) {
    associations = new Map();
    crossStackAssociations.set(secrets, associations);
  }
  storeAssociation(associations, key, expression, plaintext);
}

/**
 * The store's WRITE rule, shared by {@link recordCrossStackExpression} and
 * {@link recordNestedStackParameterExpressions} so the two tables cannot drift
 * apart on what a second sighting means.
 *
 * A key recorded against a DIFFERENT (expression, plaintext) pair is POISONED
 * to {@link CONFLICTING_CROSS_STACK} rather than overwritten; an already
 * poisoned key stays poisoned, because a third sighting cannot un-contradict
 * the first two. Every reader refuses a poisoned key, which degrades to the
 * value scan — today's behaviour — rather than guessing between the two.
 *
 * WHAT IS AND IS NOT FENCED, stated because a reader would otherwise assume the
 * whole thing is (review of issue #2291). The POISON-vs-OVERWRITE decision IS
 * fenced: a second sighting under a THIRD expression makes the two outcomes
 * differ (poison refuses and falls back; overwriting would certify the third),
 * and a case asserts it. Nothing fences the branch from
 * {@link recordNestedStackParameterExpressions}'s side in PRODUCTION, because
 * that writer runs once per resource bag and `Object.entries` cannot yield one
 * name twice — the poison is reachable only through this module's API. It is
 * kept as an INVARIANT, not claimed as covered behaviour.
 *
 * The `isSingleDynamicReferenceToken` shape invariant is deliberately NOT here:
 * it belongs to each writer, which is where the parameters are named and where
 * a swap could be introduced. One writer stores a NON-token on purpose:
 * {@link recordNestedStackParameterExpressions}'s sub-floor carry records a
 * parameter's literal FRAME (`port:{{resolve:...}}`, issue #3079), the same
 * string its whole-value entry writes, so a reader returning it persists what
 * the entry would have.
 */
export function storeAssociation(
  associations: CrossStackAssociations,
  key: string,
  expression: string,
  plaintext: string
): void {
  const seen = associations.get(key);
  if (seen === undefined) {
    associations.set(key, { expression, plaintext });
    return;
  }
  if (typeof seen === 'symbol') return;
  if (seen.expression !== expression || seen.plaintext !== plaintext) {
    associations.set(key, CONFLICTING_CROSS_STACK);
  }
}
