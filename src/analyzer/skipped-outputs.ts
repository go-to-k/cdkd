/**
 * The record `cdkd deploy` leaves behind for an Output it could NOT resolve
 * and SKIPPED, and the digest `cdkd diff` compares it against (issue
 * [#2740](https://github.com/go-to-k/cdkd/issues/2740)).
 *
 * The deploy side (`DeployEngine.handleOutputResolutionFailure`, default arm)
 * warns, stores `undefined` for the key and moves on, so a re-resolved
 * `state.outputs` lacks it (the no-change path keeps the previous bag whole
 * when any output fails, so a key that resolved on an EARLIER deploy can keep
 * its value beside a record — the reader checks absence first and ignores the
 * record then). The diff side resolves outputs with `skipDynamicReferences`, so a
 * failure that happens INSIDE a secret lookup — a JSON key the secret does not
 * hold, a reference assembled from another secret's value — does not reproduce
 * there: the value assembles into its token, the key is absent from state, and
 * `computeOutputsDiff` pushed an `ADD` the deploy would never perform, on every
 * run of an unchanged stack. The diff cannot tell from assembly alone that the
 * deploy would fail (a composed string carrying a secret reference is a
 * legitimate output), so it learns what the deploy learned instead:
 * `StackState.skippedOutputs` maps each skipped key to a digest of the
 * template inputs its resolution read, and the diff trusts the record only
 * while that digest is unchanged.
 *
 * ## What the digest covers, and why
 *
 * `skippedOutputDigest` hashes the output's OWN entry (`Value`, `Export`,
 * `Condition`, whatever else it declares) together with every top-level
 * template section EXCEPT `Resources` and `Outputs`:
 *
 * - The entry itself: repairing the `Value` expression is the obvious repair.
 *   The `Export.Name` is in it too, because the alias pass routes an
 *   `Export.Name` failure through the same handler, which blanks the output's
 *   own key even when its value resolved — so a repaired or removed export
 *   name must invalidate the record as well.
 * - `Parameters` (a `Ref`-built reference repaired through a parameter
 *   default), `Conditions` (an `Fn::If` whose branch flips), `Mappings` (an
 *   `Fn::FindInMap`-built key), and the remaining sections for the same
 *   reason, spelled as one rule rather than a list that drifts: everything an
 *   output's resolution can read besides resources. One VALUE inside them is
 *   excluded — the `Default` of a `NoEcho: true` parameter, hashed as a
 *   constant; see `withNoEchoDefaultsMasked` for why. That is the POSITION,
 *   not the parameter: its `AllowedValues`, and any literal an author puts in
 *   `Conditions`, `Rules` or `Metadata`, are hashed as before.
 * - NOT `Resources`: hashing the section would invalidate the record on every
 *   unrelated resource edit. The output CAN be repaired from that side —
 *   `collectSkippedOutputs` records both skip arms, and the quiet one is an
 *   `Fn::GetAtt` whose attribute `constructAttribute` could not build — so a
 *   digest alone would keep binding while the next deploy publishes the row
 *   and its `Export.Name`, the phantom's inverse. {@link
 *   bindingSkippedOutputs} closes that with the CHANGE MAP rather than the
 *   digest: a key whose entry references a logical id with a pending resource
 *   change does not bind. The diff has that map (it ran the resource diff
 *   first); the deploy does not need it, because a stack with any resource
 *   change takes the path that re-resolves every output and rewrites the
 *   record. REFERENCE, not repair: whether an edit could actually make the
 *   output resolvable is undecidable from a template, so an unrelated edit to
 *   a referenced resource un-binds too and the key can preview as an `ADD`
 *   again. The cost is bounded — a run with a changed resource is already
 *   reporting that row, so `--fail` exits 1 regardless — while the case it
 *   buys depends on whether the diff can resolve the output at all. For an
 *   output reading an attribute that does not exist yet — the SECOND skip arm
 *   this record covers, not the secret lookup issue #2740 was filed on — it is
 *   the VERDICT and not the row: unresolvable in
 *   both readings, so bound the diff reports the outputs settled while the
 *   next deploy is about to publish that key and its `Export.Name`. For an
 *   output the diff CAN resolve, whose reference is to a name rather than to
 *   a pending attribute (an `Fn::Sub` over an SSM parameter's name, say), the
 *   row IS the difference and reappears as an `ADD` the moment the record
 *   stops binding.
 * - NOT the sibling `Outputs`: a CloudFormation output cannot reference
 *   another output, so a sibling change cannot repair this one, and excluding
 *   them keeps an unrelated output edit from producing a one-run phantom.
 *
 * What the digest CANNOT see is a repair outside the template — the secret
 * gained the JSON key, the SSM parameter was created, a parameter VALUE
 * handed to the engine rather than declared changed (a nested stack's inputs
 * from its parent, `DeployEngineOptions.parameters`; `Parameters`
 * DECLARATIONS are hashed, supplied values are not), or **cdkd itself was
 * upgraded**: the quiet skip arm is `constructAttribute` returning nothing,
 * so a provider that gains that attribute repairs the output while neither
 * the template nor any resource moves.
 *
 * They are blind spots for three different reasons, and only the first is
 * about knowledge. The secret's key set and the SSM parameter's existence
 * need the external lookup the diff deliberately refuses to make. A supplied
 * parameter VALUE is not one of those — a nested stack's inputs are resolved
 * and forwarded to the child diff (`resolveChildStackParameters`) — it is
 * simply outside what the digest hashes, because hashing values would make
 * the record depend on a caller's arguments rather than on the template. And
 * the writing binary's version is knowable and merely unstored: keeping it
 * beside the digest and un-binding on mismatch would close that one. All four
 * end the same way: the record keeps binding until the next deploy re-resolves
 * the output, and that deploy publishes the key — unless a SIBLING output is
 * still unresolved on a run with no resource change, where the engine keeps
 * the previous outputs bag wholesale and the key stays unpublished for a
 * further run (go-to-k/cdkd#2771, pre-existing and not introduced here).
 * Documented as the accepted limitation in `docs/cli-diff.md`; it is narrower
 * than the pre-#2740 behaviour, where the diff was wrong on EVERY run.
 *
 * A repair on the RESOURCE side is NOT on that list either, but the reason is
 * narrower than it first looks. The change map above closes it only when the
 * repair arrives WITH a template resource change, which is what makes the
 * resource show on the diff at all. An OUT-OF-BAND state write does not:
 * every writer that rebuilds state outside a deploy DROPS the record rather
 * than carry it (one enumerated exception, the partial-destroy snapshot, is
 * explained with the field) — `cdkd import` refreshes `attributes` for the
 * resources it imports, `cdkd drift --accept` rewrites the properties an
 * attribute may be built from, `cdkd rollback`'s replacement arm rebuilds a
 * record with the attributes a FRESH create returned, and the rest are listed
 * with the field.
 * Dropping returns those keys to pre-#2740 behaviour until the next deploy
 * recomputes the record — a row where the diff can resolve them, the ordinary
 * whole-section suppression where it cannot — which is what keeps a
 * resource-side repair out of the list above.
 *
 * The rule is flat and it is meant to be: EVERY writer that rebuilds state
 * outside a deploy drops the record, the partial-destroy snapshot being the
 * one enumerated exception — the full list lives with the field, in
 * `StackState.skippedOutputs`. Three per-writer arguments for carrying it were
 * written during review, which is the reason for the flat rule rather than an
 * aside: two were shown wrong (substituting a value repairs an output whose
 * enclosing intrinsic was choking on what was there; scrubbing a plaintext
 * back to its expression rewrites a string outputs read verbatim) and the
 * third — deleting a property EXPOSING an attribute of the same name — could
 * not be settled either way, which argues for flatness at least as strongly.
 *
 * ## Where the digest must be taken from
 *
 * The template AS HANDED to the engine / to `computeStackDiff` — before
 * parameter binding, condition evaluation or any output resolution. The
 * INVARIANT, and the reason both callers `structuredClone` rather than pass
 * their live object: **no resolution may be visible to the digest, on either
 * side, and both sides must take it at the same point of their own flow.**
 * Two independent reasons, neither of which depends on any particular
 * resolver doing the writing: a digest that could see a resolved value would
 * (1) differ between the two sides, which computes a record the diff can
 * never re-derive, and (2) fingerprint a secret into `state.json`, since a
 * resolved value can be a decrypted one.
 *
 * The clone is therefore NOT dead weight even while no resolver mutates its
 * input. It used to be load-bearing against a live rewrite — `resolveSub`
 * substituted into the caller's two-argument `Fn::Sub` variable map until
 * go-to-k/cdkd#2764 gave it a fresh object — and the protection was never
 * derived from that call site: it is derived from the invariant above, which
 * a future in-place optimisation anywhere in either flow would silently
 * violate. `tests/unit/cli/diff-recursive-skipped-outputs.test.ts` pins the
 * current no-mutation contract from the other direction (the template handed
 * to `computeStackDiff` comes back byte-identical), so reintroducing a
 * rewrite reds a test rather than moving a digest;
 * `tests/unit/deployment/deploy-engine-skipped-outputs.test.ts` INJECTS a
 * rewrite through its resolver mock and requires the recorded digest to equal
 * a fresh parse's, which pins the ordering itself.
 *
 * Given that contract the hash covers template text only. It is over
 * canonical JSON (object keys sorted at every level), so a template
 * re-serialised with keys in another order digests identically.
 *
 * ## What the diff does with a binding record
 *
 * It previews the key as ABSENT — no row — because that is exactly what the
 * deploy will leave in state. It does NOT flag the section as failed: a
 * sibling output that genuinely changed still renders, and `--fail` still
 * exits 1 for it. A record whose digest no longer matches is simply ignored:
 * the output is previewed under the ordinary rules again (usually an `ADD`;
 * an intrinsic `Export.Name` the diff still cannot resolve keeps omitting the
 * section, as before), the next deploy re-decides it —
 * publishing it if the repair took, or recording it again under the new
 * digest — and the diff follows that decision.
 */

import { createHash } from 'node:crypto';
import type { CloudFormationTemplate, TemplateOutput } from '../types/resource.js';

/**
 * JSON with object keys sorted at every level. Arrays keep their order (an
 * `Fn::Join` list is positional). `undefined` members are dropped, as
 * `JSON.stringify` drops them, so a parsed template and its in-memory twin
 * digest identically.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      // Null-prototype (the issue #1943 class): a template key spelled
      // `__proto__` — a `Mappings` entry, say — would hit the prototype
      // SETTER of a plain `{}` and vanish from the digest, so a repair through
      // that entry would never unbind the record.
      const sorted: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

/** The constant a `NoEcho` `Default` is hashed as. Its text is irrelevant; that
 * it is CONSTANT is the point. */
const NO_ECHO_DEFAULT_MASK = '<cdkd:noecho-default>';

/**
 * `Parameters` with every `NoEcho: true` parameter's `Default` replaced by a
 * constant, for hashing only.
 *
 * The pre-resolution snapshot already keeps RESOLVED secret values out of the
 * digest. An authored `Default` under `NoEcho: true` is not one of those — it
 * is template text, and it went into the hash. With the rest of the
 * non-`Resources` sections known, a reader of `state.json` holds a confirm
 * ORACLE for a low-entropy default: guess it, recompute, compare.
 *
 * This does NOT claim the value is otherwise absent from state — a parameter a
 * resource reads can persist its RESOLVED default in that resource's
 * properties, and parameter `NoEcho` is outside the state-redaction model
 * either way. What it claims is narrower and still worth having: this record
 * must not ADD an oracle of its own for the case where the value is not
 * already there.
 *
 * The cost, stated rather than hidden: changing ONLY such a default no longer
 * moves the digest, so the record keeps binding through that edit until the
 * next deploy re-resolves the output. That is the same bounded staleness the
 * documented blind spots carry.
 *
 * Everything else about the parameter is still hashed — its `Type`, its
 * `AllowedValues`, the `NoEcho` flag itself — so a parameter appearing,
 * disappearing or changing shape still un-binds. Unmatched parameter content
 * hashes exactly as before: the map is rebuilt, but the canonicaliser sorts
 * keys and ignores prototypes, so a template with no `NoEcho` default gets the
 * digest it always had.
 */
function withNoEchoDefaultsMasked(parameters: unknown): unknown {
  // Four live guards, each observable through the digest and pinned. Three
  // on the container: `null` would throw in `Object.entries`; a primitive
  // would come back as `{}` instead of itself; an array would come back keyed
  // by index, which the canonicaliser hashes differently from the array. One
  // on the declaration: `typeof body === 'object' && body !== null`, because
  // bracket access on `undefined` THROWS — an in-memory template can carry an
  // `undefined` member, the shape `canonicalJson`'s own doc contemplates — and
  // on `null` too. Nothing else is guarded, on purpose: a primitive or array
  // declaration cannot carry `NoEcho: true` through bracket access, so a guard
  // for it could never change an outcome.
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
    return parameters;
  }
  const masked: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [name, decl] of Object.entries(parameters as Record<string, unknown>)) {
    const body = decl as Record<string, unknown> | null;
    masked[name] =
      typeof body === 'object' && body !== null && body['NoEcho'] === true && 'Default' in body
        ? { ...body, Default: NO_ECHO_DEFAULT_MASK }
        : decl;
  }
  return masked;
}

/**
 * The digest recorded in `StackState.skippedOutputs[outputKey]` by the deploy
 * and recomputed by the diff — see the module doc for what it covers. Both
 * sides call THIS function, so the coverage is spelled once.
 *
 * `template` must be the pre-resolution snapshot the module doc describes.
 */
export function skippedOutputDigest(template: CloudFormationTemplate, outputKey: string): string {
  // `Object.create(null)`, like the canonicaliser and the record below: a
  // top-level section literally named `__proto__` would otherwise hit the
  // prototype setter and vanish from the digest, so a repair through it could
  // never un-bind.
  const sections: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [section, body] of Object.entries(template)) {
    if (section === 'Resources' || section === 'Outputs') continue;
    sections[section] = section === 'Parameters' ? withNoEchoDefaultsMasked(body) : body;
  }
  const entry = template.Outputs?.[outputKey];
  return createHash('sha256')
    .update(canonicalJson({ output: entry, template: sections }))
    .digest('hex');
}

/**
 * The record a deploy writes for the bag `resolveOutputs` produced: every key
 * whose value is `undefined`, mapped to its digest. Two arms write that value:
 * the default arm of `handleOutputResolutionFailure` (the resolver THREW —
 * warned, and refused under `--strict-getatt`), and a resolver that returned
 * `undefined` outright without throwing (an attribute it could construct
 * nothing for, `constructAttribute`'s empty arm — no warn, no strict refusal).
 * Both leave the key out of a re-resolved bag (the no-change path may keep a
 * previous value under it, see the module doc), and that path's
 * `resolutionFailed` treats both the same, so this record does too: the
 * question it answers is "will the next deploy leave this key absent?", and
 * the answer is yes either way. `undefined` (the field OMITTED) when nothing
 * was skipped, so a record that carries the field says at least one output
 * was skipped.
 *
 * `template` must be the pre-resolution snapshot (see the module doc).
 */
export function collectSkippedOutputs(
  template: CloudFormationTemplate,
  resolvedOutputs: Record<string, unknown>
): Record<string, string> | undefined {
  let record: Record<string, string> | undefined;
  for (const [outputKey, value] of Object.entries(resolvedOutputs)) {
    if (value !== undefined) continue;
    // `Object.create(null)`, like the bag it reads and the canonicaliser
    // below: a template MAY declare an Output named `__proto__`, and on a
    // plain object this write would hit the prototype setter and drop the
    // very key being recorded. An object spread and `JSON.stringify` both
    // carry it out of here as an own data property.
    record ??= Object.create(null) as Record<string, string>;
    record[outputKey] = skippedOutputDigest(template, outputKey);
  }
  return record;
}

/**
 * Every resource logical id an output entry could reference, from `Ref`,
 * either `Fn::GetAtt` spelling, and an `Fn::Sub` placeholder, walked to any
 * depth over the whole entry (`Value`, `Export.Name` and anything else it
 * declares).
 *
 * A deliberate SUPERSET: an `Fn::Sub` placeholder naming a template
 * PARAMETER, or a `Ref` to one, lands here too, since telling the two apart
 * needs the `Parameters` section and the answer only ever widens the set. The
 * one consumer intersects it with the ids that actually have a pending
 * RESOURCE change, so a name that is not a resource cannot match, and a
 * parameter deliberately named after a changed resource merely un-binds one
 * record — the direction that previews a row rather than hiding one. Pseudo
 * parameters (`AWS::…`) and the `${!Literal}` escape are dropped.
 */
export function referencedLogicalIds(entry: TemplateOutput | undefined): Set<string> {
  const ids = new Set<string>();
  const addName = (name: string): void => {
    const logicalId = name.split('.')[0];
    // An empty name is not a reference: `${}` is legal text and `Ref: ''`
    // names nothing, and adding `''` would match no logical id while making
    // the set's contents a lie.
    if (logicalId !== undefined && logicalId !== '' && !logicalId.startsWith('AWS::')) {
      ids.add(logicalId);
    }
  };
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const obj = value as Record<string, unknown>;
    if (typeof obj['Ref'] === 'string') addName(obj['Ref']);
    const getAtt = obj['Fn::GetAtt'];
    if (typeof getAtt === 'string') {
      // The whole string, split by `addName` at the first dot — which is
      // exactly what `splitGetAttStringForm` computes for a valid
      // `A.Attribute`, so routing through it would add a branch with no
      // outcome of its own. What it WOULD add is a refusal: it returns
      // `undefined` for a dotless `Fn::GetAtt: 'A'`, and dropping such a
      // reference BINDS a record the resource change should have released —
      // the silent direction. Invalid CloudFormation either way; this walker
      // simply has no narrowing arm.
      addName(getAtt);
    } else if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') {
      addName(getAtt[0]);
    }
    for (const [key, nested] of Object.entries(obj)) {
      if (key === 'Fn::Sub') {
        walkSub(nested);
        continue;
      }
      walk(nested);
    }
  };
  /**
   * `Fn::Sub` in both spellings. Handled here rather than by the generic walk
   * because the two-argument form's second element is a VARIABLE MAP, not a
   * template fragment: its KEYS are variable names, so letting the generic
   * walk see `{ Ref: 'Unrelated' }` there would read a variable literally
   * named `Ref` as a `Ref` intrinsic. The map's VALUES are walked, since the
   * resolver resolves them.
   */
  const walkSub = (sub: unknown): void => {
    const isPair = Array.isArray(sub);
    const subTemplate = typeof sub === 'string' ? sub : isPair ? sub[0] : undefined;
    const variableMap =
      isPair && sub[1] !== null && typeof sub[1] === 'object'
        ? (sub[1] as Record<string, unknown>)
        : undefined;
    if (typeof subTemplate === 'string') {
      // The variable map SHADOWS the template: a placeholder it declares is
      // that variable, never a resource, so collecting it would let an
      // unrelated resource of the same name un-bind the record.
      //
      // Matched on the COMPLETE placeholder text, which is what `resolveSub`
      // itself tests (`varNameStr in variables`, before any `Ref` / `GetAtt`
      // fallback). Matching a leading segment instead would be wrong in both
      // directions: `${A.Arn}` with a map declaring `A` is a real `GetAtt` on
      // `A` that must still be collected, and a map declaring `A.Arn` really
      // does shadow `${A.Arn}`. OWN keys only, mirroring the resolver's own
      // object, so nothing inherited can shadow a real reference.
      const declaredVars = new Set(variableMap === undefined ? [] : Object.keys(variableMap));
      for (const [, placeholder] of subTemplate.matchAll(/\$\{([^}]*)\}/g)) {
        // `${!Literal}` is CloudFormation's escape, not a reference.
        if (placeholder === undefined || placeholder.startsWith('!')) continue;
        if (declaredVars.has(placeholder)) continue;
        addName(placeholder);
      }
    }
    // Everything else in the node, generically: `sub[0]` when it is NOT a
    // plain string (CDK emits an `Fn::Join` there whenever the template string
    // interpolates a token), the variable map's VALUES, and any element past
    // index 1 — a shape CloudFormation does not define, walked anyway because
    // every other arm of this walker is a deliberate superset and narrowing
    // here is the one place it could silently lose a reference.
    if (isPair) {
      for (const [index, element] of sub.entries()) {
        if (index === 1) {
          if (variableMap !== undefined) {
            for (const declared of Object.values(variableMap)) walk(declared);
          }
          continue;
        }
        // No type narrowing here: `walk` returns immediately on anything
        // that is not an array or object, so a `string` element costs one
        // call and skipping it could never change an outcome — an unpinnable
        // clause, which is worse than the call it saves.
        walk(element);
      }
    } else {
      // Everything that is not a pair. For the ordinary STRING form the
      // placeholder pass above has already done the work and `walk` returns
      // immediately, so this costs one call — the same trade as the loop
      // above, and the reason there is no guard here.
      //
      // What it exists for is the third shape: an `Fn::Sub` whose value is a
      // plain OBJECT. `subTemplate` is `undefined` for it and `isPair` is
      // false, so before this arm nothing walked it and every reference inside
      // was silently lost — the BINDING direction, which is the one the rest
      // of this walker exists to refuse. Invalid CloudFormation today.
      walk(sub);
    }
  };
  walk(entry);
  return ids;
}

/**
 * The keys of a `StackState.skippedOutputs` record that still BIND against
 * today's template: recorded digest equal to the digest of the same key over
 * `pristineTemplate`, which must be the pre-resolution snapshot the module doc
 * describes. A key the template no longer declares is skipped outright — the
 * record is inert for it, and the next deploy clears it. The diff passes the
 * result to `resolveTemplateOutputs`, which adds the one check only state can
 * answer — that the key is still absent from the stored bag.
 *
 * `changedLogicalIds` is the second half of the binding rule, and the one the
 * digest structurally cannot carry (see the module doc's `Resources` bullet):
 * the logical ids this run's resource diff reports as changing. An output
 * whose entry references one of them does NOT bind, because the deploy that
 * follows takes the changed-resources path, re-resolves every output, and may
 * publish the very key the record would have hidden. Omitted by a caller with
 * no resource diff in hand — every such caller today is a test asserting the
 * digest half alone.
 */
export function bindingSkippedOutputs(
  pristineTemplate: CloudFormationTemplate,
  record: Record<string, string> | undefined,
  changedLogicalIds?: ReadonlySet<string>
): Set<string> {
  const binding = new Set<string>();
  if (record === null || record === undefined) return binding;
  const declared = pristineTemplate.Outputs ?? {};
  for (const [outputKey, digest] of Object.entries(record)) {
    // OWN property: an output reachable only through the prototype chain is
    // not a declaration, and `Outputs?.[key]` alone would accept one.
    if (!Object.prototype.hasOwnProperty.call(declared, outputKey)) continue;
    const entry = declared[outputKey];
    if (digest !== skippedOutputDigest(pristineTemplate, outputKey)) continue;
    if (
      changedLogicalIds !== undefined &&
      [...referencedLogicalIds(entry)].some((id) => changedLogicalIds.has(id))
    ) {
      continue;
    }
    binding.add(outputKey);
  }
  return binding;
}

/**
 * Whether two records — either possibly absent — describe the same skipped
 * set with the same digests. The no-change deploy path persists on a
 * difference here: it is the ONLY save trigger for this field on that path,
 * because a skipped output switches the outputs-changed trigger off.
 */
export function skippedOutputsEqual(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined
): boolean {
  // An EMPTY record and an absent one describe the same thing — nothing was
  // skipped — so they compare equal: a carried or hand-edited `{}` would
  // otherwise differ from this pass's `undefined` and buy one spurious save
  // per deploy until something else wrote the record. `null` (hand-edited
  // state) normalizes with them rather than throwing out of `Object.keys`,
  // which would crash `cdkd deploy` on the field an operator is most likely
  // to edit by hand.
  const aKeys = a === null || a === undefined ? [] : Object.keys(a);
  const bKeys = b === null || b === undefined ? [] : Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (k) => Object.prototype.hasOwnProperty.call(b as object, k) && a?.[k] === b?.[k]
  );
}
