import type { DeployEngine } from '../deploy-engine.js';
import { timePhaseSync } from '../../utils/phase-timings.js';
import { canonicalizeRegion } from '../../utils/aws-partition.js';
import {
  redactForState,
  scrubResourceRecord,
  isSameGenerationBag,
  redactionClaimOf,
  type ScrubGenerationClaims,
  type RecordedSecretValues,
} from '../secret-redaction.js';
import { outputMapsEqual } from '../deploy-value-equality.js';
import {
  KEEP_REFERENCE_PROVENANCE,
  outputProvenanceForPersist,
  provenanceForWrittenRecord,
  withReferenceProvenance,
} from '../reference-provenance-record.js';
import {
  isWrittenFromDeployedTemplate,
  withMaskedPropertyFingerprints,
} from '../masked-property-fingerprints.js';
import {
  type ReferenceProvenance,
  type StackState,
  type StateImportEntry,
  type StateOutputReadEntry,
  type ResourceState,
  stackInstanceIdCarriedFrom,
} from '../../types/state.js';
import { constructPathOf, withConstructPath } from '../../analyzer/destructive-changes.js';
import { injectiveKey } from '../../state/record-keys.js';
import { absorbOutputsPassSecrets, allRecordedSecrets, redactOutputs } from './masking.js';
import { applyNoEchoPersist, noEchoPositionSources, withNoEchoExactEchoes } from './noecho.js';
import { withNoEchoValueMacs } from '../noecho-value-macs.js';
import {
  isSupersededHeldBySameType,
  isSupersededResourceRecord,
  withoutSuperseded,
} from '../superseded-resources.js';

/**
 * The `imports` / `outputReads` records to persist on a save that is NOT the
 * final success save — the UNION of the pre-deploy snapshot and what THIS
 * session resolved (issue
 * [#2057](https://github.com/go-to-k/cdkd/issues/2057) review).
 *
 * Every non-success save used to write `currentState.imports` /
 * `currentState.outputReads` verbatim, i.e. the PRE-DEPLOY snapshot, while
 * writing the POST-deploy `newResources` beside it. So a deploy that
 * introduced a cross-stack read and then failed persisted resources built FROM
 * that read next to a record that does not mention it. Two consequences, and
 * only the first is about #2057:
 *
 *  1. A rollback journal exists only after a FAILED deploy, so
 *     `producerRegionsFromState` saw an empty list on exactly the deploy
 *     that introduces a cross-region secret read — and
 *     `classifyReplaySecretRegion` answered `local`, resolving the producer's
 *     region-less expression in the consumer's region. The refusal was inert
 *     where it mattered most.
 *  2. INDEPENDENT PRE-EXISTING BUG. `state.imports[]` is what
 *     `findActiveImportConsumers` (`src/cli/commands/destroy-runner.ts`) scans
 *     to refuse destroying a producer while a consumer still imports from it,
 *     and `state.outputReads[]` is what `findDownstreamConsumers`
 *     (`src/cli/commands/recreate-downstream-consumers.ts`) enumerates. A
 *     failed deploy therefore silently DOWNGRADED a fresh strong reference to
 *     no reference: the consumer's resource is live and recorded, its import is
 *     not, and `cdkd destroy` on the producer sails through the strong-ref
 *     pre-flight. This exists on main today, with or without #2057.
 *
 * DIRECTION OF THE RESIDUAL, stated rather than left to be discovered: a union
 * never drops a record, so a stack that STOPS reading across a region keeps the
 * stale entry until its next SUCCESSFUL deploy, whose save replaces the list
 * wholesale (`imports: [...this.recordedImports]`). Until then a purely-local
 * rollback can be refused on the strength of a read the template no longer has.
 * That is the fail-closed side — a clear error naming the region to reconcile,
 * versus a silent wrong-secret write — and the same asymmetry already justifies
 * preserving the snapshot at all (dropping it would strip a live strong-ref
 * record on every diff-clean deploy).
 *
 * THE RULE IS "EVERY SAVE EXCEPT THE TERMINAL SUCCESS ONE", and it is stated
 * that way rather than as "every non-success save" because the latter is loose
 * in both directions: the diff-clean no-change save in `doDeploy` is a SUCCESS
 * outcome and unions anyway (nothing was re-resolved, so the union is an
 * identity there and one rule beats an exception), while
 * `persistStateAfterOutputFailure` looks like a success save — provisioning
 * was clean — and is not one.
 *
 * THE ENUMERATION IS NOT KEPT HERE, DELIBERATELY. Two prose counts in this
 * lane were measured wrong (an "ALL FIVE" that missed
 * `persistStateAfterOutputFailure`, and a "three post-rollback saves" that is
 * two), and each wrong count is worse than none: it is the sentence a reader
 * uses to conclude the rule is already applied everywhere.
 * `tests/unit/deployment/deploy-engine-cross-stack-read-writers.test.ts`
 * derives the set instead — it SCANS this file for every `imports:` /
 * `outputReads:` object key that writes a VALUE and fails on any that is not
 * the one allow-listed success-path write, with a positive control proving the
 * scan can see a violation. A save site added here fails that test rather than
 * escaping silently, so the authority on "where is this applied" is a grep the
 * test performs, not a number anybody has to maintain.
 */
export function crossStackReadsForPartialSave(
  previous: StackState,
  recordedImports: readonly StateImportEntry[],
  recordedOutputReads: readonly StateOutputReadEntry[],
  /**
   * Normalize a NAME for the identity key ONLY -- entries are still STORED
   * verbatim, the same compare-normalized / store-verbatim split this
   * function already makes for the region.
   *
   * Issue [#3289](https://github.com/go-to-k/cdkd/issues/3289) made it
   * necessary. `previous` is a persisted record, so its names are REDACTED;
   * `recorded` is this run's in-memory bag, so its names are PLAINTEXT. Keyed
   * raw, the two spellings of ONE reference carry different keys, both
   * survive the union, and `redactStateForPersist` then rewrites the
   * plaintext one into a byte-identical DUPLICATE -- a doubled row in the
   * destroy refusal and in the recreate prompt, on every deploy after the
   * first. Measured before this parameter existed; the union never drops, so
   * nothing downstream would have removed it.
   *
   * REQUIRED, not defaulted to identity. A default here would be a branch no
   * probe can red -- all seven call sites pass one, so nothing would exercise
   * it -- which is the shape this change already deleted an empty-bag arm for.
   * A caller holding no secrets gets identity from
   * `crossStackReadKeyNormalizer` itself, where the emptiness is DECIDED.
   */
  normalizeName: (name: string) => string
): Pick<StackState, 'imports' | 'outputReads'> {
  // The stack segment is normalized for `outputReads` and NOT for `imports`,
  // matching exactly which fields the persist redaction rewrites. Normalizing
  // both was tried and is wrong in the direction that DROPS a record:
  // `imports[].sourceStack` is stored verbatim forever, so normalizing it makes
  // the key space coarser than the value space -- two distinct producer names
  // whose plaintexts share one expression collapse onto one key, and the union
  // drops a genuinely distinct destroy-blocking import. That also contradicts
  // this change's own argument for leaving that field alone.
  //
  // ENCODED, not separated (go-to-k/cdkd#3496). `previous` comes from
  // persisted JSON that `parseState` only casts, so no half is guaranteed free
  // of a NUL. The old NUL-joined key could collide only when an entry's
  // STACK or REGION half carries a NUL (splitting at the first two NULs
  // recovers every field otherwise, whatever the name half holds). No
  // CDK-synthesized stack name or canonical region does; cdkd validates no
  // prebuilt-assembly stack-name charset, so only a hand-written assembly or a
  // hand-edited / corrupted record can. So this is defence against a MALFORMED
  // entry shadowing a genuine one, not a live fail-open: the union keeps the
  // first of two colliding entries, and `state.imports` is what
  // `destroy-runner` refuses a destroy on. `injectiveKey` cannot collide.
  const importKey = (e: StateImportEntry): string =>
    injectiveKey(e.sourceStack, canonicalizeRegion(e.sourceRegion), normalizeName(e.exportName));
  const outputReadKey = (e: StateOutputReadEntry): string =>
    injectiveKey(
      normalizeName(e.sourceStack),
      canonicalizeRegion(e.sourceRegion),
      normalizeName(e.outputName)
    );
  const imports = unionCrossStackReads(previous.imports, recordedImports, importKey);
  const outputReads = unionCrossStackReads(
    previous.outputReads,
    recordedOutputReads,
    outputReadKey
  );
  return {
    // Omitted rather than written empty, matching what every one of these save
    // sites did before: an absent field and an empty array are different
    // records to a reader that predates the field.
    ...(imports.length > 0 && { imports }),
    ...(outputReads.length > 0 && { outputReads }),
  };
}

/**
 * Concatenate two cross-stack-read lists, dropping a later duplicate of an
 * identity an earlier entry already carries. First-seen wins, so the PRE-DEPLOY
 * spelling of a region survives — entries are COMPARED on a canonicalized
 * region but STORED verbatim, mirroring `producerRegionsFromState`.
 */
function unionCrossStackReads<T>(
  previous: readonly T[] | undefined,
  recorded: readonly T[],
  identity: (entry: T) => string
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const entry of [...(previous ?? []), ...recorded]) {
    // `previous` comes from persisted JSON, and `parseState` only CASTS — it
    // does not validate the element shape. A `null` / non-object element in a
    // hand-edited `state.imports` would make `identity` throw where the old
    // code copied the array verbatim. Every call site sits inside a try/catch
    // whose catch only warns, so the blast radius was a skipped save rather
    // than a crash, but a save skipped for this reason is a strong-reference
    // record silently not written.
    if (entry === null || typeof entry !== 'object') continue;
    const key = identity(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

export function redactStateForPersist(this: DeployEngine, state: StackState): StackState {
  const resources: Record<string, ResourceState> = {};
  // go-to-k/cdkd#6146: which `NoEcho` parameters each property reads, for the
  // MAC stamp. Read whenever the stack has `NoEcho` parameters, even on a run
  // whose MACs failed, so a key the provider left unsent keeps its entry (a
  // stack with none reads nothing and stamps nothing).
  const macSources =
    this.noEchoRun.noEchoMacs === undefined
      ? undefined
      : noEchoPositionSources(this.noEchoRun, state.resources);
  for (const [logicalId, record] of Object.entries(state.resources)) {
    // Redact each record ONLY with the secrets substituted during that
    // resource's own resolution — see the `SecretsRunState.perResourceSecrets` doc.
    const secrets = this.secretsRun.perResourceSecrets.get(logicalId);
    // The template bag is the POSITION source (#1904); when this resource was
    // not resolved this deploy there is none, and `scrubResourceRecord` falls
    // back to the record's own `properties` for the observed bag (#1900).
    const templateProps = this.secretsRun.perResourceTemplateProps.get(logicalId);
    // Issue #1852: merged BEFORE the scrub, so a healed value enters the
    // same pass a provider-recorded attribute does. That pass has no needles
    // for an UNCHANGED record (nothing resolved for it this deploy), so what
    // keeps a sensitive value out is the read itself: masked keys are
    // dropped in `readRecordAttributes`, and custom resources / nested stacks
    // are never read.
    const healed = this.attributeHealer.withHealedAttributes(logicalId, record);
    const scrubbed = scrubResourceRecord(
      healed,
      secrets ?? new Map<string, string>(),
      // No template bag means this resource was not resolved this deploy (an
      // UNCHANGED one). `scrubResourceRecord` then falls back to the record's
      // own already-redacted properties as the observed bag's source, which is
      // the #1900 path — so do NOT "simplify" this to `templateProps!`.
      templateProps,
      undefined,
      // go-to-k/cdkd#5047: the walk reads no mark, so the claims the record's
      // bags carry (`propertiesToRecord`, `drainObservedCaptures`) are stated
      // here, off the very objects those producers installed.
      sameGenerationClaimsOf(healed)
    );
    // go-to-k/cdkd#4451: the masked properties' template fingerprints, read
    // off the SCRUBBED bag (only it holds `***`), and rebuilt only for a
    // record this deploy wrote; a failed update keeps the previous bag and
    // its previous fingerprints. This resource's needles refuse a hash to a
    // template value that holds one as a literal.
    // go-to-k/cdkd#4043 / #2449: the `NoEcho` arms, BEFORE the fingerprints,
    // which read the `***` keys of the persisted bag.
    const noEchoScrubbed = applyNoEchoPersist(
      this.noEchoRun,
      this.noEchoDeps(),
      logicalId,
      record,
      // go-to-k/cdkd#4656: this deploy's echo-fidelity verdicts join the
      // record's own; only this loop's records are the ones it read back.
      withNoEchoExactEchoes(this.noEchoRun, logicalId, scrubbed),
      templateProps,
      state.resources,
      secrets
    );
    resources[logicalId] = withReferenceProvenance(
      withConstructPath(
        // go-to-k/cdkd#6146: the `NoEcho` value MACs, rebuilt only for a
        // record this deploy wrote; a property its provider left unsent keeps
        // its previous entry.
        withNoEchoValueMacs(
          withMaskedPropertyFingerprints(
            noEchoScrubbed,
            record.properties,
            templateProps,
            secrets,
            this.secretsRun.fingerprintNoEchoValues,
            this.secretsRun.perResourceInputFingerprints.get(logicalId)
          ),
          record.properties,
          templateProps,
          macSources,
          this.noEchoRun.noEchoMacs?.settled(),
          this.noEchoRun.noEchoMacKept.get(logicalId),
          this.noEchoRun.noEchoMacInputBindings.get(logicalId)
        ),
        constructPathOf(this.noEchoRun.constructPathTemplate, logicalId)
      ),
      this.referenceProvenanceToPersist(logicalId, record, noEchoScrubbed, secrets)
    );
  }
  // `outputs` is also secret-bearing: a `CfnOutput` whose Value resolves a
  // SECRET dynamic reference (`{{resolve:secretsmanager:...}}`, or a
  // `{{resolve:ssm:...}}` pointing at a `SecureString` parameter — issue
  // #1901 — including an Fn::Sub/Join embedding one) stores the resolved
  // plaintext, which would otherwise reach
  // state.json / the exports index / the deploy summary. Redact it with the
  // OUTPUTS' own secrets map (a literal output equal to a secret is not
  // recorded there, so it is not touched).
  // `orphans` carries a whole `ResourceState` each (issue #2934), so it is
  // secret-bearing in exactly the way `resources` is — and it is a TOP-LEVEL
  // field, which means the `...state` spread below would otherwise carry it
  // through this choke point UNTOUCHED. That matters most on the path that
  // creates the records: the automatic rollback captures from the in-memory
  // map, which holds REAL resolved values by design (see the create site's
  // "The REAL attribute values, deliberately" note), so an unscrubbed entry
  // writes secret plaintext into state.json — the GHSA-p5qg-v9gv-hc7w class.
  //
  // Keyed by the record's own logical id AND its resource TYPE. The id alone
  // is not enough: a CDK refactor can reuse a logical id for an unrelated
  // resource, and then this deploy's maps hold the NEW resource's needles and
  // template bag. Scrubbing the old record with those splices a new secret's
  // plaintext into the old record's literals wherever it coincides as a
  // substring — the over-redaction / coinciding-literal class — and picks a
  // position source that describes a different resource entirely.
  //
  // When the type matches, the maps describe the same resource and their
  // needles are the right ones. When it does not (and in the ordinary case,
  // where the orphan is not in this deploy's template at all), both miss and
  // `scrubResourceRecord` takes the #1900 fall-back, treating the record's own
  // already-redacted properties as the observed bag's source. That is correct
  // rather than merely tolerable: a record minted by an earlier rollback was
  // already scrubbed when it was written, so the identity return preserves it.
  const orphanEntries = state.orphans;
  // go-to-k/cdkd#5111: shared with `supersededResources` below.
  const scrubDroppedRecord = (entry: {
    logicalId: string;
    state: ResourceState;
  }): ResourceState => {
    // Did THIS deploy resolve that logical id, as that same TYPE? Only then
    // do the needles describe this record.
    //
    // Keyed on what the deploy RESOLVED, not on `state.resources`: an orphan
    // is by definition absent from `resources`, so that spelling read false
    // for the record being MINTED — the needles went empty and the plaintext
    // survived. Measured by `tests/integration/retain-orphan-secret`.
    const sameResource =
      this.secretsRun.perResourceResolvedType.get(entry.logicalId) === entry.state.resourceType;
    const orphanTemplateProps = sameResource
      ? this.secretsRun.perResourceTemplateProps.get(entry.logicalId)
      : undefined;
    return (
      // go-to-k/cdkd#4451: a record THIS deploy created and its rollback
      // orphaned carries a bag this deploy wrote, so it gets its masked
      // properties' fingerprints here too, or a later adoption backfills
      // them from whatever template that deploy carries.
      withMaskedPropertyFingerprints(
        // go-to-k/cdkd#4043 (review M4): the `NoEcho` arms too, positioned
        // by today's template while it still names the logical id as that
        // type.
        applyNoEchoPersist(
          this.noEchoRun,
          this.noEchoDeps(),
          entry.logicalId,
          entry.state,
          scrubResourceRecord(
            entry.state,
            (sameResource ? this.secretsRun.perResourceSecrets.get(entry.logicalId) : undefined) ??
              new Map<string, string>(),
            orphanTemplateProps,
            undefined,
            sameGenerationClaimsOf(entry.state)
          ),
          orphanTemplateProps,
          state.resources
        ),
        entry.state.properties,
        orphanTemplateProps,
        sameResource ? this.secretsRun.perResourceSecrets.get(entry.logicalId) : undefined,
        sameResource ? this.secretsRun.fingerprintNoEchoValues : undefined,
        sameResource ? this.secretsRun.perResourceInputFingerprints.get(entry.logicalId) : undefined
      )
    );
  };
  const orphans = orphanEntries?.map((entry) => ({ ...entry, state: scrubDroppedRecord(entry) }));
  // go-to-k/cdkd#5111: a superseded resource's record is secret-bearing in
  // exactly the way an orphan's is, and scrubbed the same way. One a record
  // holds again (a rollback took it back) is not persisted: it is no longer
  // superseded, and a later deploy must not delete it.
  const superseded = Array.isArray(state.supersededResources)
    ? state.supersededResources.flatMap((entry) => {
        // A malformed entry is the reader's to skip, never this writer's to drop.
        if (!isSupersededResourceRecord(entry)) return [entry];
        if (isSupersededHeldBySameType(entry, state.resources)) return [];
        return [{ ...entry, state: scrubDroppedRecord(entry) }];
      })
    : undefined;
  // ORDER IS LOAD-BEARING, and it is the opposite of how this read when the
  // cross-stack redaction was added (issue
  // [#3289](https://github.com/go-to-k/cdkd/issues/3289), security review).
  // `absorbOutputsPassSecrets` is the only writer of `outputSecrets`, and on
  // THIS path `redactOutputs` is what calls it — so a cross-stack redaction
  // evaluated first reads that bag EMPTY. (`crossStackReadKeyNormalizer`
  // calls the absorb itself, for the same reason one level earlier.) The success path hides it (the
  // outputs pass drains earlier there), but `persistStateAfterOutputFailure`
  // reaches here from the `catch` with nothing absorbed, and that is exactly
  // the shape this redaction exists for: an `Fn::GetStackOutput` whose
  // StackName an `Fn::Sub` built from a secret, in a deploy whose outputs
  // pass then threw. Redact the outputs FIRST so the bag is filled.
  const outputs = redactOutputs(this.maskingDeps(), state.outputs);
  const crossStackReads = this.redactCrossStackReads(state);
  // State schema v12: written from the bag this save persists, per key.
  const { outputReferenceProvenance: _incoming, supersededResources: _superseded, ...rest } = state;
  // go-to-k/cdkd#5111: written below from the filtered set only.
  const outputReferenceProvenance = this.outputReferenceProvenanceFor(state.outputs, outputs);
  return {
    ...rest,
    // go-to-k/cdkd#5111: `supersededResources` is written below, filtered.
    ...stackInstanceIdCarriedFrom(withoutSuperseded(state)),
    resources,
    outputs,
    ...(orphans === undefined ? {} : { orphans }),
    // A malformed (non-array) field is carried verbatim, never dropped here.
    ...(superseded === undefined
      ? _superseded !== undefined && { supersededResources: _superseded }
      : superseded.length > 0 && { supersededResources: superseded }),
    ...crossStackReads,
    ...(outputReferenceProvenance !== undefined && { outputReferenceProvenance }),
  };
}

/**
 * State schema v12 (go-to-k/cdkd#4847 / #4852): the
 * `outputReferenceProvenance` a save persists beside `outputs` (the bag as
 * the save holds it) / `redacted` (as it will persist):
 *
 * - a bag this deploy resolved: per key, from that output's own sink;
 * - the loaded record's bag, carried: its field verbatim, or, when the
 *   record has none (written before v12) and this deploy resolved an EQUAL
 *   bag, that resolution's (the outputs' share of the migration);
 * - anything else (a merge): none.
 */
export function outputReferenceProvenanceFor(
  this: DeployEngine,
  outputs: Record<string, unknown>,
  redacted: Record<string, unknown>
): Record<string, Record<string, ReferenceProvenance>> | undefined {
  const sinkOf = (outputKey: string): RecordedSecretValues | undefined =>
    this.outputsRun.outputProvenanceSinks.get(outputKey);
  const baseline = this.provenanceBaseline;
  if (
    !this.outputsRun.outputsResolvedThisRun.has(outputs) &&
    baseline !== undefined &&
    outputs === baseline.outputs &&
    baseline.outputReferenceProvenance === undefined &&
    !baseline.tokenFree &&
    this.outputsRun.resolvedOutputsBag !== undefined &&
    outputMapsEqual(redactOutputs(this.maskingDeps(), this.outputsRun.resolvedOutputsBag), redacted)
  ) {
    return outputProvenanceForPersist({
      outputs: redacted,
      resolvedThisRun: true,
      carriedFrom: undefined,
      sinkOf,
    });
  }
  return outputProvenanceForPersist({
    outputs: redacted,
    resolvedThisRun: this.outputsRun.outputsResolvedThisRun.has(outputs),
    carriedFrom: baseline !== undefined && outputs === baseline.outputs ? baseline : undefined,
    sinkOf,
  });
}

/**
 * State schema v12 (go-to-k/cdkd#4847 / #4852): the `referenceProvenance`
 * one record persists. A record this deploy WROTE (its `properties` bag is
 * marked same-generation, or written from this deploy's template through a
 * provider's `effectiveProperties`) takes this pass's entries for the tokens its
 * scrubbed form holds; an in-place update keeps every generation a
 * create-only path may still hold. A record it did NOT write keeps its
 * field verbatim and is never walked: `perResourceSecrets` is filled before
 * an update's skip return and never cleared, so without the gate a skipped
 * record would take versions it was never sent.
 *
 * Returns `KEEP` for "leave the record's own field as it is".
 */
export function referenceProvenanceToPersist(
  this: DeployEngine,
  logicalId: string,
  record: ResourceState,
  scrubbed: ResourceState,
  secrets: RecordedSecretValues | undefined
): Record<string, ReferenceProvenance> | undefined | typeof KEEP_REFERENCE_PROVENANCE {
  // A provider's `effectiveProperties` replacement is written too
  // (`isWrittenFromDeployedTemplate`) but is not same-generation: it may
  // carry the previous record's leaves, so on an in-place update every
  // token takes the union rule.
  const sameGeneration = isSameGenerationBag(record.properties);
  if (!sameGeneration && !isWrittenFromDeployedTemplate(record.properties)) {
    return KEEP_REFERENCE_PROVENANCE;
  }
  const previous = Object.hasOwn(this.healBaseline, logicalId)
    ? this.healBaseline[logicalId]
    : undefined;
  // An update whose provider sent NOTHING (Cloud Control's empty patch,
  // go-to-k/cdkd#4443) left AWS as the previous record describes it.
  if (this.replacementRun.updatesThatSentNothing.has(logicalId) && previous !== undefined) {
    return previous.referenceProvenance;
  }
  // `update-in-place.ts` records the paths for every in-place write that
  // holds pass provenance or a previous field, the only writes that reach
  // the union; `'all'` is the conservative answer for any other.
  const createOnly = sameGeneration
    ? this.replacementRun.inPlaceCreateOnlyPaths.get(logicalId)
    : 'all';
  const inPlace =
    this.replacementRun.updateWasReplaced.get(logicalId) === false && previous !== undefined
      ? {
          createOnly: createOnly ?? ('all' as const),
          attributesCarried:
            record.attributes !== undefined && record.attributes === previous.attributes,
        }
      : undefined;
  return provenanceForWrittenRecord({
    record: scrubbed,
    secrets,
    previous,
    inPlace,
    // A stack loaded off the token-free fast path walks a record only when
    // this pass recorded provenance for it.
    walkWithoutPassProvenance: this.provenanceBaseline?.tokenFree !== true,
  });
}

/**
 * Redact the TEMPLATE-DERIVED names in `state.imports` / `state.outputReads`
 * (issue [#3289](https://github.com/go-to-k/cdkd/issues/3289)).
 *
 * Both lists rode the `...state` spread unredacted, so a reference whose name
 * an `Fn::Sub` assembled around a resolved secret persisted that secret in
 * plaintext, durably. The fields are NOT symmetric and the issue as filed
 * named the wrong ones, so the provenance of each is stated here rather than
 * left to be re-derived:
 *
 * - `imports[].exportName` IS template-derived (`resolveValue` on the
 *   `Fn::ImportValue` argument), so it leaks. Its `sourceStack` /
 *   `sourceRegion` are NOT: `recordImport` takes them from the exports index
 *   entry or the state scan, i.e. from the producer's own record.
 * - `outputReads[]` has TWO leaking fields: `outputName` AND `sourceStack`,
 *   both `resolveValue` on `Fn::GetStackOutput` arguments. `sourceRegion` is
 *   template-derived too but passes `isClientSafeRegion` before it can be
 *   recorded, and it is read STRUCTURALLY (`producerRegionsFromState` keys a
 *   secret-region decision on it), so it is deliberately left alone.
 *
 * REDACTION HAPPENS HERE, at the persist choke point, and must not move to
 * record time: `crossStackReadsForPartialSave` / `unionCrossStackReads` dedup
 * on the (source stack, region, name) triple, so changing a value mid-run makes
 * the union write BOTH spellings, and its first-seen-wins merge would keep
 * whichever arrived first.
 *
 * `outputReads[].sourceStack` is both a leak and the literal match key
 * `findDownstreamConsumers` compares against, so redacting it necessarily
 * stops that match. That reader reports rather than drops — see
 * `recreate-downstream-consumers.ts`; a consumer vanishing from a DATA-LOSS
 * prompt is a worse failure than one it cannot name precisely.
 *
 * The union bag is every secret THIS deploy resolved, because a
 * cross-stack reference can sit in a resource property (recorded per logical
 * id) or in an Output (recorded in the outputs pass), and the entry carries
 * no logical id to narrow it by.
 */
export function redactCrossStackReads(
  this: DeployEngine,
  state: StackState
): Pick<StackState, 'imports' | 'outputReads'> {
  if (state.imports === undefined && state.outputReads === undefined) return {};
  const secrets = allRecordedSecrets(this.secretsRun, this.maskingDeps());
  // No early return for an EMPTY bag. There was one, returning the lists
  // verbatim, and it was behaviourally DEAD: the caller spreads `...state`
  // first, so an absent key here leaves the original in place either way.
  // A branch no probe can red is worse than no branch -- a test naming it
  // passes through the spread instead and reads as coverage (measured in
  // review: inserting `return {}` there left the whole suite green).
  // The map below is identity work on an empty bag.
  // Field-by-field rather than handing the whole entry to
  // `redactSecretsForState`: the walk would also rewrite `sourceRegion` and
  // `imports[].sourceStack`, which are not template-derived and are read as
  // match keys. Each field is a bare string, so the value scan is the only
  // arm that can apply and a source bag would buy nothing.
  const redact = (value: string): string =>
    redactForState(value, { provenance: 'value-scan', secrets: secrets });
  return {
    ...(state.imports === undefined
      ? {}
      : {
          imports: state.imports.map((entry) => ({
            ...entry,
            exportName: redact(entry.exportName),
          })),
        }),
    ...(state.outputReads === undefined
      ? {}
      : {
          outputReads: state.outputReads.map((entry) => ({
            ...entry,
            sourceStack: redact(entry.sourceStack),
            outputName: redact(entry.outputName),
          })),
        }),
  };
}

/**
 * The name normalizer `crossStackReadsForPartialSave` keys its union on
 * (issue [#3289](https://github.com/go-to-k/cdkd/issues/3289)).
 *
 * It applies the SAME redaction the persist path applies, so a name this run
 * holds in plaintext and the name the previous record holds redacted produce
 * ONE key. Without it the union keeps both and the persist redaction makes
 * them identical duplicates. The parameter's own doc carries the measurement.
 *
 * Returns identity when this deploy resolved no secret, which keeps the key
 * byte-identical to the pre-#3289 one for every stack that has none.
 */
export function crossStackReadKeyNormalizer(this: DeployEngine): (name: string) => string {
  // ABSORB FIRST, the same reason `redactOutputs` does and the same reason
  // the persist order was corrected: `outputSecrets` is written only by
  // `absorbOutputsPassSecrets`, and every caller of THIS method evaluates it
  // inside a state literal -- i.e. BEFORE `withParentInfo` reaches
  // `redactStateForPersist`. Without the drain the bag is empty here, the
  // identity arm below is taken, and the duplicate this normalizer exists to
  // stop survives on exactly the path the round-1 blocker was on: a
  // `Fn::GetStackOutput` in a `CfnOutput.Value` (so the needle is in the
  // outputs pass only) on a deploy whose outputs pass then threw.
  //
  // Fixing the persist order and leaving this one is how the same defect
  // shipped twice in one PR. Calling the absorb from both places is safe:
  // measured, a second call re-sets equal entries and `recordResolvedPair`
  // leaves an unchanged pair alone, so it invents no CONFLICTING marker.
  absorbOutputsPassSecrets(this.maskingDeps());
  const secrets = allRecordedSecrets(this.secretsRun, this.maskingDeps());
  if (secrets.size === 0) return (name) => name;
  return (name) => redactForState(name, { provenance: 'value-scan', secrets: secrets });
}

/**
 * Stamp `parentStack` / `parentLogicalId` / `parentRegion` (schema v6+)
 * onto a state object that's about to be saved, when this engine was
 * constructed with `options.parentStackInfo` (= it's deploying a
 * nested-stack child). Returns the state unchanged for top-level
 * deploys so the three v6 fields stay absent from non-child state files.
 *
 * ALSO the single choke point where resolved SECRET plaintext is redacted out
 * of the persisted state (GHSA fix): every `stateBackend.saveState` call in
 * this engine wraps its state through here, so redacting `resources` once here
 * covers `properties` / `attributes` / `observedProperties` across every
 * create / update / replacement / rollback / observed-capture path uniformly —
 * including the async observed-capture drain that runs after the resolver
 * context is gone (which is why the secret map is session-wide).
 */
export function withParentInfo(this: DeployEngine, state: StackState): StackState {
  // go-to-k/cdkd#5200: CPU on the event loop, once per save.
  const redacted = timePhaseSync('state saves (every stack)', 'redact for persist', () =>
    this.redactStateForPersist(state)
  );
  if (!this.options.parentStackInfo) return redacted;
  const { parentStack, parentLogicalId, parentRegion } = this.options.parentStackInfo;
  return {
    ...redacted,
    ...stackInstanceIdCarriedFrom(redacted),
    parentStack,
    parentLogicalId,
    parentRegion,
  };
}

/**
 * What the deploy engine's producer marks say about a record's two walked
 * bags, as {@link scrubResourceRecord}'s explicit claims (go-to-k/cdkd#5047).
 */
function sameGenerationClaimsOf(record: ResourceState): ScrubGenerationClaims {
  return {
    // A provider's leaf-certified `effectiveProperties` too (go-to-k/cdkd#5063).
    properties: redactionClaimOf(record.properties),
    observed: isSameGenerationBag(record.observedProperties) ? 'same-generation' : 'unproven',
  };
}
