import {
  secretSafeKeyDisplay,
  type SecretSafeKeyDisplay,
} from '../../deployment/outputs-export-alias.js';
import type { RecordedSecretValues } from '../../deployment/secret-redaction.js';
import { isReadableBag } from '../../state/malformed-resources-bag.js';
import { isSecretBearingReferenceString as isSecretDynamicReference } from '../../deployment/no-change-outputs-merge.js';
import { keepsSecretReferenceToken } from '../../deployment/intrinsic-resolver/context.js';
import type { OutputChange } from './types.js';
import {
  addStringLeaves,
  containsSecretReferenceText,
  holdsPlainSsmToken,
  isWholeSecretReferenceToken,
  secretSpanInStoredKey,
  storedSecretTokenIsExpression,
  valuesEqual,
} from './values.js';

/**
 * Compare the persisted Outputs bag against the one the next deploy would
 * write, key by key (issue #1921).
 *
 * Compares BAG KEYS rather than template output names on purpose. The bag is
 * what actually lands in `StackState.outputs` AND what
 * `ExportIndexStore.updateForStack` publishes, so a key-level comparison is
 * exactly the `outputMapsEqual` predicate the deploy engine gates its persist
 * on — no interpretive layer in between that could drift from apply semantics.
 * The practical payoff is that the motivating #875 case shows the user the
 * literal export name their downstream `Fn::ImportValue` needs.
 *
 * ## Withholding legacy secret plaintext
 *
 * This is the first code path that DISPLAYS a stored output value, and
 * `cdkd diff` is routinely run in CI — so a value that turns out to be secret
 * plaintext would land in build logs. `StackState.outputs` is only guaranteed
 * redacted for records written after the GHSA fix; an older binary persisted
 * the RESOLVED plaintext, which is the condition `cdkd scrub` repairs.
 *
 * Two independent signals identify such a record, and BOTH are needed:
 *
 * - the desired side is still a secret-bearing expression per
 *   {@link isSecretReferenceText} (this resolver runs with
 *   `skipDynamicReferences`, so a `SecureString` ssm token counts, issue
 *   #4056) while the stored side is not; and
 * - `secretSourceKeys` — the template itself declares the key's value as such a
 *   reference. This one reaches a case the first cannot: a condition-skipped
 *   secret output has NO desired side at all and would otherwise print in full
 *   as a REMOVE row.
 *
 * A hit on either makes the WHOLE record suspect, not just that key: the
 * record was written by a pre-GHSA binary, so every value in it is unredacted.
 * Withholding is therefore record-level. The change is still REPORTED — only
 * the value is withheld — so `--fail` and the exports story are unaffected.
 *
 * A third input forces the same verdict: `forceLegacyRecord`, set by the
 * no-change merge preview (issue #3101) when a value it carried from state for
 * a failed output, an export alias included, is not itself a secret expression.
 * The first signal reads a carried key's desired side, which is then the stored
 * value, so evidence only its resolved value held is gone; and where a resolved
 * secret expression can come from (a stored attribute, a parameter, another
 * stack's outputs) is not enumerable. Nothing short of the carried key's own stored expression can
 * excuse it — the one value the per-key veto below would have excused.
 *
 * ## The key today's template cannot account for (issue #1948)
 *
 * Neither signal above covers an output DELETED from the template, and an
 * earlier revision of this note claimed `secretSourceKeys` did — a false
 * coverage claim, which is exactly what lets a reader conclude the case is
 * handled. It structurally cannot: that set is built from DECLARATIONS, and a
 * deleted output declares nothing, so a record whose ONLY secret-bearing output
 * has since been removed is judged not-legacy and its stored pre-GHSA plaintext
 * renders as the `old:` side of a REMOVE row.
 *
 * The signal has to come from the STORED bag, and the honest statement about
 * the stored bag is that the case is UNDECIDABLE there: post-GHSA a secret
 * output stores its `{{resolve:...}}` EXPRESSION, but pre-GHSA it stores a
 * plaintext, and a plaintext is indistinguishable from an ordinary string. So
 * this is a REFUSAL rather than a detection — a stored key the template cannot
 * account for has its value withheld — bounded by two gates that keep it off
 * the common benign case (deleting an output is a normal refactor):
 *
 * - `templateHasSecretReference` — the template must still prove this stack
 *   handles secrets AT ALL (anywhere, `Resources` included). An ordinary stack
 *   with no secret reference keeps printing its REMOVE values.
 * - no stored value is itself a secret-bearing expression. One that is
 *   exonerates the record, read as evidence that the last write redacted the
 *   whole bag. A bag resolved whole by one post-GHSA pass earns that reading,
 *   and the no-change path's partial persist (issue #2771) refuses to carry a
 *   previous value into a bag it is about to give its FIRST expression. The
 *   reading is not unconditional: see the scrub and kept-whole residuals
 *   below. The refusal lives in `src/deployment/no-change-outputs-merge.ts`,
 *   beside the predicate both sides read.
 *
 *   That reasoning holds for a DEPLOY write and is weaker for a `cdkd scrub`
 *   one, which rewrites `state.outputs` IN PLACE: scrub redacts what it has a
 *   needle or a template position for. A key today's template cannot name
 *   whose value it cannot identify is DROPPED (go-to-k/cdkd#4120), except
 *   one it rewrote only in part (the text it keeps beside the reference is
 *   withheld per key below), one that may be a live export alias this run
 *   could not reproduce, one
 *   another stack still reads, every one when the other records could not be
 *   read, and one whose NAME holds a secret (#1919) — so a scrubbed bag
 *   holding one redacted key can still exonerate such a kept key's surviving
 *   plaintext. Scrub reports each of those as a finding, never clean. Recorded rather than closed: removing the
 *   exoneration would withhold values on every clean post-GHSA record in a
 *   secret-handling stack, which is the larger harm.
 *   The deploy's own save belongs to the same class when the no-change path
 *   keeps a previous bag whole: its value scan can redact one stored value into
 *   an expression while another stored plaintext, which no needle names,
 *   survives beside it. The partial persist refuses to CREATE that shape
 *   (issue #2771); a kept-whole save can still create it.
 *
 * Withholding here is PER-KEY, unlike the record-level arms above, and the
 * asymmetry follows from what each concludes: those conclude the record was
 * written by a pre-GHSA binary (a claim about the whole bag), while this one
 * concludes only that THIS key is undecidable. So a secret-handling stack that
 * deletes an ordinary output withholds that one row's value and prints the
 * rest.
 *
 * Residual, stated because the gate is what buys the low false-positive rate:
 * a stack whose ONLY secret reference WAS the deleted output has no secret left
 * in its template, so nothing here fires. Closing it would mean withholding
 * every REMOVE value on every stack, which is a worse trade.
 */
export function computeOutputsDiff(
  current: Record<string, unknown> | undefined,
  desired: Record<string, unknown>,
  exportNames: ReadonlySet<string>,
  secretSourceKeys: ReadonlySet<string> = new Set(),
  unaccountableScan: {
    declaredKeys?: ReadonlySet<string>;
    templateHasSecretReference?: boolean;
    /**
     * Treat the record as pre-GHSA whatever pass 1 finds. Set by the no-change
     * merge preview (issue #3101) when a value it carried from state for a failed
     * output, an export alias included, is not a secret expression: pass 1 reads
     * `desired`, and a carried key's desired side is the stored value, so
     * evidence only its resolved value held is gone.
     */
    forceLegacyRecord?: boolean;
    /** {@link ResolvedTemplateOutputs.secretBearingExportNames} (issue #4015). */
    secretBearingExportNames?: readonly string[];
    /** {@link ResolvedTemplateOutputs.refusedNoEchoExportNames} (go-to-k/cdkd#4657). */
    refusedNoEchoExportNames?: readonly string[];
    /** {@link ResolvedTemplateOutputs.exportNameReadsNoEcho} (go-to-k/cdkd#4723). */
    exportNameReadsNoEcho?: boolean;
    /**
     * The record's `exportNames` (schema v9+), or `undefined` when it records
     * none: which stored keys are export ALIASES (issue #4015).
     */
    storedExportNames?: readonly string[] | undefined;
  } = {}
): OutputChange[] {
  const changes: OutputChange[] = [];
  // `isReadableBag`, NOT the `?? {}` that stood here (go-to-k/cdkd#3189). The
  // parameter's TYPE says a bag, but its only production argument is
  // `StackState.outputs` read out of an unchecked cast — `parseStateBody`
  // validates the root object and the schema version and nothing inside — so a
  // hand-edited or truncated record reached the two walks below holding a
  // string or a list, which `Object.entries` enumerates as readily as a map:
  // `'abcdef'` produced six REMOVE rows named `"0"`..`"5"`, each printing a
  // character of the record as its `old:` side, and `--fail` exited 1 on them.
  //
  // SECOND line of defence, not the fix: the fix is at the LOAD, in
  // `diff-recursive.ts`'s `loadStateOrEmpty`, which is what WARNS and what
  // covers the lookups this function's caller makes against the same bag one
  // call earlier. This one keeps the fabrication out of a direct caller that
  // never passed through that load. It reads the SHARED predicate rather than
  // re-spelling the plain-object test, so the two cannot drift.
  // `current !== undefined` is NOT redundant, and reads as if it were —
  // `isReadableBag(undefined)` is already false, so it changes no VERDICT. It is
  // there for the TYPE: `isReadableBag` returns `boolean` rather than a type
  // predicate (deliberately — it is shared with callers that pass `unknown`), so
  // without this conjunct the true branch is still `... | undefined` and the
  // assignment needs an `as` cast. Deleting it therefore does not simplify the
  // line, it re-introduces the cast (review of go-to-k/cdkd#3194, which read it
  // as dead code).
  const currentBag: Record<string, unknown> =
    current !== undefined && isReadableBag(current) ? current : {};

  // Pass 1: is this a pre-GHSA record? See the "Withholding" note above.
  // Named, because issue #4015's corpus reads the keys that TRIGGER it.
  const provesLegacy = ([name, oldValue]: [string, unknown]): boolean => {
    // LEAF granularity on the VETO, deep on both positive arms — and the
    // asymmetry is the point rather than an oversight. Widening this one (as an
    // earlier revision did) makes a CONTAINER holding any expression leaf vote
    // "already redacted", so a partially-redacted bag —
    // `["{{resolve:secretsmanager:A}}", "prod-<plaintext>"]`, the residue
    // `cdkd scrub` itself admits it can leave — is read as post-GHSA and its
    // plaintext leaf then prints in a rendered row. A veto must be harder to
    // earn than a suspicion.
    //
    // Both arms read the secret's TOKEN, not only its `secretsmanager` /
    // `ssm-secure` spelling (issue #4056's sweep). `desired` is RESOLVED text,
    // where a plain `{{resolve:ssm:...}}` survives only for a `SecureString`,
    // so a record an older binary wrote with that parameter's plaintext printed
    // it as the `old:` side of a MODIFY row. The stored side reads that token
    // as an expression too, or a post-#1901 record storing it would be judged
    // pre-GHSA by its own desired side and lose every previous value -- but
    // only in the shape `storedSecretTokenIsExpression` accepts, never on a
    // substring hit beside text that may be plaintext, whatever the token's
    // spelling (issue #4101: the spelling arm vetoed on one and printed the
    // plaintext beside it).
    if (typeof oldValue === 'string' && storedSecretTokenIsExpression(oldValue, desired[name])) {
      return false;
    }
    return containsSecretReferenceText(desired[name]) || secretSourceKeys.has(name);
  };
  const legacyRecord =
    unaccountableScan.forceLegacyRecord === true || Object.entries(currentBag).some(provesLegacy);

  // Pass 2: the issue #1948 exoneration, RECORD-level unlike the per-key veto
  // above, and it has to be: the question is whether the LAST write redacted,
  // and one redacted key is read as answering it for the whole bag — a reading
  // with the residuals the note above names (issue #2771 refuses the merge that
  // would add one). Same LEAF granularity, so a container holding an expression
  // still does not earn it. A key earns it only in the shape the pass-1 veto
  // accepts (issue #4101): the shared `bagHoldsSecretExpression` is a substring
  // spelling test, so a stored `{{resolve:secretsmanager:A}}-<plaintext>` of a
  // REMOVED output exonerated its own record and printed on the REMOVE row.
  // That helper stays as-is for its deploy-side readers.
  //
  // And only a plain `ssm` token earns it (issue #4108): a `secretsmanager` /
  // `ssm-secure` expression proves the write came after the GHSA fix, not
  // after #1901, and a binary between the two stored a `SecureString`
  // parameter's PLAINTEXT beside that correctly redacted expression. A stored
  // plain `ssm` token is written only after #1901 (before it, every plain ssm
  // reference resolved): by a deploy, whose no-change merge refuses to put a
  // first one beside a carried value (`bagHoldsSecretExpression` counts it),
  // or by `cdkd scrub`, which drops an undeclared key it cannot identify but
  // keeps the kinds the note above names (the scrub residual). So it
  // is the strongest evidence the bag is redacted, not a proof. A record with
  // none keeps the unaccountable-key signal:
  // fail-closed, costing a removed output's value in a `secretsmanager`-only
  // stack.
  const recordProvesPost1901 = Object.entries(currentBag).some(
    ([name, value]) =>
      typeof value === 'string' &&
      holdsPlainSsmToken(value) &&
      storedSecretTokenIsExpression(value, desired[name])
  );
  const declaredKeys = unaccountableScan.declaredKeys ?? new Set<string>();
  // A key's OWN stored value can prove it unsafe whatever the record's verdict:
  // a secret token outside the shape `storedSecretTokenIsExpression` accepts
  // is what a pre-#1901 deploy wrote around a plaintext (issue #4101), and that
  // same deploy stored a sibling's whole token, which exonerates the record.
  // So this refusal is per key, for a declared key too (its template value may
  // since have turned public, so pass 1 has no desired-side signal), and is
  // gated by neither the exoneration nor the template. One whole token is
  // never refused here: it has no room for a plaintext. A CONTAINER is read
  // leaf by leaf with no desired side to line up against, so any leaf holding
  // a secret token beside other text withholds it (fail-closed; a pre-#1901
  // deploy's value scan wrote the same shape inside an array or object).
  const leafCarriesSecret = (leaf: string): boolean =>
    (isSecretDynamicReference(leaf) || keepsSecretReferenceToken(leaf)) &&
    !isWholeSecretReferenceToken(leaf);
  const anyLeafCarriesSecret = (value: unknown): boolean => {
    if (typeof value === 'string') return leafCarriesSecret(value);
    if (Array.isArray(value)) return value.some(anyLeafCarriesSecret);
    if (value !== null && typeof value === 'object') {
      return Object.values(value as Record<string, unknown>).some(anyLeafCarriesSecret);
    }
    return false;
  };
  const ownValueHidesSecret = (name: string): boolean => {
    const value = currentBag[name];
    if (typeof value !== 'string') return anyLeafCarriesSecret(value);
    return (
      leafCarriesSecret(value) &&
      !storedSecretTokenIsExpression(
        value,
        Object.prototype.hasOwnProperty.call(desired, name) ? desired[name] : undefined
      )
    );
  };
  const unaccountable = (name: string): boolean =>
    !declaredKeys.has(name) &&
    !Object.prototype.hasOwnProperty.call(desired, name) &&
    ((unaccountableScan.templateHasSecretReference === true && !recordProvesPost1901) ||
      ownValueHidesSecret(name));

  // THE KEY'S OWN VERDICT (issue #4015). A stored key is printed as a row
  // name, and a binary from before issue #1919 (or #2889) could publish an
  // alias key holding a resolved secret -- which no redaction pass rewrites,
  // since they all walk VALUES. So every row name goes through
  // `secretSafeKeyDisplay`, and the renderers print its verdict-bound text.
  //
  // The CORPUS is what this diff can know without fetching a secret, which it
  // must not do (the GHSA fix resolves with `skipDynamicReferences`):
  //
  // - in a record judged pre-GHSA, the stored values of the keys that proved
  //   it (the template declares them secret, so their stored value IS the
  //   plaintext), or the whole bag when the merge preview FORCED the verdict,
  //   whose evidence is gone by construction. Tested against every row name;
  // - the stored value of each key the template cannot account for, and the
  //   span an older binary substituted for the `{{resolve:...}}` tokens of a
  //   secret-bearing `Export.Name` (`secretSpanInStoredKey`, FORCE-MASK so a
  //   span below the containment floor is still masked). Tested ONLY against a
  //   name that is neither declared nor desired: resolution substituted no
  //   plaintext into any other, and a deleted `Stage: prod` must not mask an
  //   ADD `prod-ApiUrl` under a false "contains a secret" label.
  //
  // OVER-MASKING, stated, fail-closed on purpose: the span needs only the
  // literal ends to match, so a stale sibling alias sharing them is masked
  // too; and one removed output's stored value found inside ANOTHER removed
  // output's logical id masks that id (`Deleted: 'prod'` beside a removed
  // `prodOldApi`).
  //
  // Then a REFUSAL over what the corpus cannot see: see `withholdsAliasName`.
  const recordCorpus: RecordedSecretValues = new Map();
  const unaccountedCorpus: RecordedSecretValues = new Map();
  for (const entry of Object.entries(currentBag)) {
    // `provesLegacy(entry)` implies `legacyRecord`, so it needs no conjunct.
    if (unaccountableScan.forceLegacyRecord === true || provesLegacy(entry)) {
      addStringLeaves(entry[1], recordCorpus);
    }
    if (unaccountable(entry[0])) addStringLeaves(entry[1], unaccountedCorpus);
  }
  // Built ONCE, so every unaccountable row shares one map and the detection
  // cache `secretSafeKeyDisplay` keys by map identity hits.
  const unaccountedNameCorpus: RecordedSecretValues = new Map([
    ...recordCorpus,
    ...unaccountedCorpus,
  ]);
  const accountable = (name: string): boolean =>
    declaredKeys.has(name) || Object.prototype.hasOwnProperty.call(desired, name);

  // THE ALIAS-NAME REFUSAL (issue #4015, maintainer decision). A stored key
  // holding a secret the corpus cannot see -- its `Export.Name` since removed
  // or edited, or a LITERAL one containing the plaintext, on a record whose
  // values were redacted -- has its NAME withheld, when ALL hold: a REMOVE
  // row (implied by the next: an ADD or MODIFY key is desired, so accountable),
  // a key the template does not account for, a template that references
  // a secret, and a key that can only be an export ALIAS: carrying a character
  // a CloudFormation Output logical id cannot (outside `[A-Za-z0-9]`), and,
  // when the record lists `exportNames` (v9+), listed there. A plain Output
  // logical id is never withheld HERE -- not even one listed in `exportNames`,
  // which a self-aliased output (`exportName` equal to its own id) puts there.
  // `withholdsRotatedNoEchoAlias` below can withhold one (go-to-k/cdkd#4723).
  //
  // TWO BOUNDS remain, each printing unless the corpus or the span covers it:
  // - an alphanumeric-only alias key, which reads as an Output logical id;
  // - any alias in a stack whose template no longer references a secret by a
  //   spelling `templateHasSecretReference` knows (`secretsmanager` /
  //   `ssm-secure`) -- including one whose only secret is a plain
  //   `{{resolve:ssm:...}}` to a `SecureString`.
  const storedExportNames =
    unaccountableScan.storedExportNames === undefined
      ? undefined
      : new Set(unaccountableScan.storedExportNames);
  const withholdsAliasName = (name: string): boolean =>
    unaccountableScan.templateHasSecretReference === true &&
    !accountable(name) &&
    /[^A-Za-z0-9]/.test(name) &&
    (storedExportNames === undefined || storedExportNames.has(name));

  // A name this pass refused for a `NoEcho` reason holds the value, which a
  // 1-3 character value's containment floor cannot mask (go-to-k/cdkd#4657):
  // the REMOVE row of an alias an older binary published under it is withheld.
  const refusedNoEchoNames = new Set(unaccountableScan.refusedNoEchoExportNames ?? []);
  // That set holds TODAY's value only. An alias published while the value was
  // another one spells the OLD value, which nothing here can match
  // (go-to-k/cdkd#4723), so while any declared name reads a `NoEcho`
  // parameter, every stored alias the template cannot account for is
  // withheld. STACK-WIDE, not per owning output: state records no alias's
  // owner, and a value match misses an owner since renamed or removed. No
  // `[A-Za-z0-9]` exemption either: `x${Short}y` publishes `xaby`. Bound,
  // stated: a template that no longer declares such a name withholds nothing.
  const withholdsRotatedNoEchoAlias = (name: string): boolean =>
    unaccountableScan.exportNameReadsNoEcho === true &&
    !accountable(name) &&
    (storedExportNames === undefined || storedExportNames.has(name));
  const nameDisplay = (name: string): { nameDisplay?: SecretSafeKeyDisplay } => {
    if (
      withholdsAliasName(name) ||
      refusedNoEchoNames.has(name) ||
      withholdsRotatedNoEchoAlias(name)
    ) {
      return { nameDisplay: { kind: 'withheld' } };
    }
    let corpus = recordCorpus;
    let forceMask: RecordedSecretValues | undefined;
    if (!accountable(name)) {
      corpus = unaccountedNameCorpus;
      forceMask = new Map();
      for (const exportName of unaccountableScan.secretBearingExportNames ?? []) {
        const span = secretSpanInStoredKey(name, exportName);
        if (span !== undefined) forceMask.set(span, exportName);
      }
    }
    const display = secretSafeKeyDisplay(
      name,
      corpus,
      forceMask !== undefined && forceMask.size > 0 ? forceMask : undefined
    );
    return display.kind === 'safe' ? {} : { nameDisplay: display };
  };

  const push = (change: OutputChange): void => {
    const shown: OutputChange = { ...change, ...nameDisplay(change.name) };
    if (
      change.changeType !== 'ADD' &&
      (legacyRecord || unaccountable(change.name) || ownValueHidesSecret(change.name))
    ) {
      const { oldValue: _dropped, ...rest } = shown;
      changes.push({ ...rest, oldValueRedacted: true });
      return;
    }
    changes.push(shown);
  };

  for (const [name, newValue] of Object.entries(desired)) {
    const isExport = exportNames.has(name);
    if (!Object.prototype.hasOwnProperty.call(currentBag, name)) {
      // An ADD has no stored side, so there is nothing to withhold.
      changes.push({
        name,
        changeType: 'ADD',
        newValue,
        isExport,
        ...nameDisplay(name),
      });
      continue;
    }
    const oldValue = currentBag[name];
    if (!valuesEqual(oldValue, newValue)) {
      push({ name, changeType: 'MODIFY', oldValue, newValue, isExport });
    }
  }

  for (const [name, oldValue] of Object.entries(currentBag)) {
    if (Object.prototype.hasOwnProperty.call(desired, name)) continue;
    push({ name, changeType: 'REMOVE', oldValue, isExport: false });
  }

  return changes;
}
