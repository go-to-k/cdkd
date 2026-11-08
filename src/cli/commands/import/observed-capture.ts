import { getLogger } from '../../../utils/logger.js';
import { ProviderRegistry } from '../../../provisioning/provider-registry.js';
import {
  maskReadbackAtCoordinates,
  noEchoLeavesOf,
  redactForState,
  type RecordedSecretValues,
} from '../../../deployment/secret-redaction.js';
import { buildReadCurrentStateContext } from '../drift.js';
import { logicalIdShown, resourceTypeShown } from '../../../provisioning/composite-id.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { hasUnverifiableParameterRefusal, type StackState } from '../../../types/state.js';
import { secretNamePrintingBags } from '../../../deployment/secret-name-needles.js';
import { withPrintingSecrets } from '../../../deployment/resource-secrets-scope.js';
import type { ObservedBaselineRefusals } from './types.js';

/**
 * The empty secrets map the observed-capture redaction below passes. Shared
 * and module-level because `redactSecretsForState` only ever READS its map,
 * and because an empty one is not an oversight here but the POSITION-only
 * configuration the call site's note argues for. (`cdkd state
 * refresh-observed` passes a per-record empty map instead, carrying a public
 * ssm proof by identity, issue #2036. This capture needs none: a record whose
 * `properties` still spell a public reference here was refused a baseline by
 * the resolve walk's lost-opener arm, preserved selective-import records
 * included, since that walk re-resolves every record in the stack.)
 */
const NO_RECORDED_SECRETS: RecordedSecretValues = new Map();

/**
 * Populate `observedProperties` for every resource in a freshly-built
 * import StackState by calling the matching provider's
 * `readCurrentState`. Mirrors what `cdkd deploy` does after each
 * create/update so the very first `cdkd drift` run after import has a
 * real AWS-current baseline (instead of falling back to template
 * `properties` and silently missing console-side changes).
 *
 * Synchronous + parallel — import is rare enough that the few extra
 * seconds for `Promise.all` over the imported set are amortized into
 * the user's adoption workflow. Per-resource errors are swallowed
 * (logged at debug) so a single readCurrentState failure does not abort
 * the import; the affected resource simply lands without
 * `observedProperties` and the next deploy will populate it.
 *
 * Resources whose provider does not implement `readCurrentState`
 * (incremental rollout — see `ResourceProvider.readCurrentState`'s
 * doc-comment) keep `observedProperties: undefined`; the drift comparator
 * falls back to `properties` for those, matching pre-v3 behavior.
 *
 * Exported for unit testing -- internal to the command flow otherwise. The
 * input-space matrix drives THIS function rather than replaying its
 * `redactSecretsForState` call by hand, so a change to the arguments it passes
 * cannot leave that fence green.
 *
 * Every captured bag is REDACTED before it lands on the record, and a resource
 * whose redaction POSITION SOURCE is unusable is skipped entirely — see the
 * call site's own note (issue
 * [#2828](https://github.com/go-to-k/cdkd/issues/2828)).
 */
export async function captureObservedForImportedResources(
  stackState: StackState,
  providerRegistry: ProviderRegistry,
  logger: ReturnType<typeof getLogger>,
  unsafeObservedBaselineLogicalIds: ObservedBaselineRefusals,
  rebuiltLogicalIds: ReadonlySet<string>
): Promise<void> {
  const entries = Object.entries(stackState.resources ?? {});
  if (entries.length === 0) return;
  // go-to-k/cdkd#3869: each read runs under the record's printing bag, as
  // `cdkd drift` does: the provider's own lines name the physical id, which
  // for a resource named from a secret (or a reader of one) no recorded
  // plaintext spells. Log-only needles, so the redaction below never reads
  // them.
  const printingBagOf = secretNamePrintingBags(stackState.resources ?? {}, undefined);

  await Promise.all(
    entries.map(([logicalId, resource]) =>
      withPrintingSecrets(printingBagOf(logicalId), async () => {
        // NO BASELINE where the position source cannot vouch for the readback
        // (issue #2828 review). The redaction below is POSITION-based — its only
        // evidence is that `resource.properties` SPELL the dynamic reference —
        // and `resolveImportedProperties` decides, per resource, whether they
        // still do; its doc block carries the rule and the two measured arms it
        // is drawn from. Where they do not, `redactSecretsForState` finds no
        // reference to substitute.
        //
        // WHAT HAPPENS NEXT DIFFERS BY ARM, and conflating them is what an
        // earlier revision of this sentence did. On the LOST-OPENER arm the
        // readback comes back UNCHANGED and the DECRYPTED value is persisted in
        // the clear -- that is the disclosure this skip exists to stop. On the
        // THROW arm the source leaf is typically a RAW intrinsic OBJECT against a
        // STRING readback, which since #2885 is an uncertified position and is
        // MASKED rather than persisted; the four `closedByMask` rows of the
        // refusal matrix exist to prove exactly that. The skip is still right for
        // both -- a masked baseline is a cost, not a fix -- but only the first
        // arm is a leak.
        //
        // The COST is not nothing, and saying so matters because the cheaper
        // reading invites someone to widen the skip. A resource skipped here
        // falls back to comparing `properties` — which on the throw arm are the
        // RAW intrinsics, so `cdkd drift` reports phantom drift on it where a
        // captured baseline would have been clean. That is a real (small)
        // regression, taken deliberately against a plaintext disclosure. The
        // throw arm now pays it for EVERY throwing resource, including ones with
        // no dynamic reference at all: narrowing it to "carries a reference" was
        // tried and leaked, because a reference can be sourced from a parameter
        // `Default` or a `Mappings` entry the raw bag never mentions.
        //
        // TWO MORE consumers, named rather than left to be discovered. This list
        // is the ones MEASURED, not a proof there are no others.
        //
        // BOTH ARE ABOUT THE SKIP, not about the mask #2885 introduced, and the
        // mask case is strictly bounded for them: each reads a field the mask
        // cannot occupy or cannot make worse -- `RetentionInDays` is NUMERIC and
        // {@link refuseUncertifiedSubtree} masks STRING leaves only, and for the
        // boolean-ish protection fields an ABSENT key (what the skip leaves) is
        // already the degraded read these bullets describe, so a masked string in
        // its place adds nothing. That is why they are stated once, here, rather
        // than repeated against the mask.
        //
        //  - `countProtectedResources` in `destroy-runner/helpers.ts` reads
        //    `observedProperties` as its fallback for `DeletionProtection` /
        //    `LoadBalancerAttributes`, so a refused resource whose protection was
        //    set OUT OF BAND is missing from the destroy prompt's protected
        //    count. Not data loss -- AWS still refuses the delete -- but the
        //    prompt under-reports.
        //  - `logGroupHasPositiveRetention` in `stateful-types.ts` reads it for
        //    `AWS::Logs::LogGroup`'s `RetentionInDays`, and that file's own doc
        //    names the import case as the reason it does. A refused LogGroup
        //    loses the `has-retention` fast path and its recreate prompt degrades.
        //
        // A THIRD cost, and the only one that can reach LIVE AWS: a refused
        // resource has raw `properties` and no baseline, so `cdkd drift --revert`
        // takes the RAW bag as its revert baseline and
        // `resolveStateSecretExpressions` re-resolves only `{{resolve:` STRINGS
        // -- an `Fn::Join` OBJECT walks through into `provider.update`. Issue
        // [#2855](https://github.com/go-to-k/cdkd/issues/2855); whether that
        // update fails loudly or corrupts silently is deliberately recorded there
        // as UNMEASURED rather than guessed at here.
        //
        // EVERY earned refusal in the input-space matrix is proved to have really
        // leaked -- that file asserts it row by row, and its count is the one that
        // holds. No count is repeated here: a previous revision stated one, it was
        // wrong, and this repo's rule is that a drifted count is DELETED rather
        // than recounted.
        //
        // A REFUSED record ends with NO baseline, on BOTH skip arms below, and
        // the arms DROP one rather than merely not writing it (issue
        // [#2872](https://github.com/go-to-k/cdkd/issues/2872)). A FRESHLY
        // imported record has none to drop: `buildStackState`'s literal
        // enumerates its fields and `observedProperties` is not one. A record
        // PRESERVED by a selective merge is copied wholesale from
        // `existingState.resources`, so it arrives with whatever baseline it
        // already had — including a pre-GHSA plaintext one, or one a pre-#2854
        // import captured against a placeholder `Default` — and a bare skip would
        // leave that baseline in `state.json`. It was captured against the very
        // `properties` the refusal distrusts, so it is not evidence either. The
        // accepted cost: drift has no baseline for that record until a
        // CREATE / UPDATE deploy or a proving re-import restores one.
        //
        // THE MISSING BASELINE USED NOT TO BE PERMANENT, AND THAT WAS THE
        // RESIDUE: the deploy-start auto-refresh and `cdkd state
        // refresh-observed` both fill a missing baseline against the record's
        // `properties`, which after a refusal can hold the wrong-branch LITERAL
        // the refusal distrusted — and neither writer holds the template
        // evidence this walk refused on, nor could it (issue
        // [#2944](https://github.com/go-to-k/cdkd/issues/2944)). So the refusal
        // is RECORDED on the state record below, in the only thing that survives
        // between this process and theirs: `observedBaselineRefused` (schema
        // v10+), whose type doc carries the full argument. Both writers skip a
        // marked record; a deploy that CREATEs or UPDATEs the resource clears
        // it, because that deploy holds the template evidence this walk lacked.
        // Schema v10+ (issue #2944), and THIS ARM IS THE FIFTH REFILL WRITER —
        // `cdkd import` itself, found by the adversarial review of the fix for
        // the other four rather than by the issue.
        //
        // `unsafeObservedBaselineLogicalIds` describes only what THIS run's
        // resolve could see. A record PRESERVED by a selective merge is seeded
        // from `existingState.resources` by `buildStackState` and is overwritten
        // only when a row re-imported it, so its `properties` are a PREVIOUS
        // run's downgraded output — a plain `dev-placeholder` literal. Re-solving
        // that literal trips no arm (no throw, openers 0 -> 0, nothing
        // discarded), so the id is absent from this run's set, and without this
        // gate the loop below would capture a readback positioned against it —
        // persisting the decrypted value, the byte-identical configuration the
        // `schema-v9-to-v10-migration` integ reproduces one command over — and
        // the `delete` further down would then LAUNDER the marker, standing the
        // other four writers down permanently.
        //
        // `rebuiltLogicalIds` is the discriminator the set cannot supply: the
        // rows this run actually imported, whose `properties` were rebuilt from
        // the template. A marked record OUTSIDE it keeps its marker and its
        // refusal; only a rebuilt one can earn a clear.
        const preservedRefusal =
          resource.observedBaselineRefused === true && !rebuiltLogicalIds.has(logicalId);
        if (preservedRefusal) {
          // Issue #2872: `delete`, so the key is ABSENT from the persisted JSON.
          delete resource.observedProperties;
          logger.debug(
            // Names `cdkd import`, so the id and type are shown only when plain
            // (go-to-k/cdkd#4226).
            `observedProperties capture SKIPPED for preserved ${logicalIdShown(logicalId)} (${resourceTypeShown(resource.resourceType)}): a previous 'cdkd import' run refused this record's baseline and this run did not re-import it, so its recorded properties are still the ones that refusal distrusted. Re-import it, or deploy a change to it, to restore a baseline — unless its refusal is an unverifiable-parameter one, which only a replacement or a proving re-import discharges.`
          );
          return;
        }
        // Issue #3462 — whether an UNVERIFIABLE-PARAMETER refusal stands for this
        // rebuilt record. Two sources: ARM 4 named it THIS run, or
        // `buildStackState` carried one from the prior record (same physical id)
        // and this run had NO deployed-parameter source to re-judge it with. A
        // carried refusal is discharged only by a run that HAD a source and whose
        // ARM 4 then did not name the resource — the parameter was PROVEN to be
        // the bound `Default`. "ARM 4 did not name it" with no source means
        // nothing was judged.
        const refusals = unsafeObservedBaselineLogicalIds;
        const parameterRefusalStands =
          refusals.unverifiableParameter.has(logicalId) ||
          (hasUnverifiableParameterRefusal(resource) && !refusals.hadDeployedParameterSource);
        if (unsafeObservedBaselineLogicalIds.has(logicalId) || parameterRefusalStands) {
          // Set BEFORE the early return, and set on the record rather than
          // returned to the caller, because the caller hands this same object to
          // `saveState` — the set that drove the skip describes THIS run's
          // resolution and is discarded with it.
          resource.observedBaselineRefused = true;
          // The reason is written ONLY beside the marker, and a carried
          // `unverifiable-parameter` is REPLACED when this run refuses for another
          // arm while having proven the parameter: a stale reason would make that
          // refusal permanent for no cause.
          // Issue #3468: a refusal by another arm alone records ITS reason, so
          // that no marker this binary writes is reason-less — an absent reason
          // is read fail closed. ARM 4 wins when both fired.
          resource.observedBaselineRefusalReason = parameterRefusalStands
            ? 'unverifiable-parameter'
            : 'incomplete-resolution';
          // Issue #2872: a no-op for a rebuilt record; a PRESERVED one this run
          // refused can carry a baseline the refusal distrusts.
          delete resource.observedProperties;
          logger.debug(
            `observedProperties capture SKIPPED for imported ${logicalId} (${resource.resourceType}): the recorded properties cannot be shown to spell every dynamic reference the deployed resource was built from, so they cannot position a redaction — capturing an AWS readback against them could persist a resolved secret in plaintext. Drift will compare against the recorded properties for this resource until ${
              parameterRefusalStands
                ? `it is REPLACED, or re-imported while a CloudFormation stack can prove its parameters were deployed at their 'Default' — an in-place deploy binds the same 'Default' and cannot restore the baseline`
                : `the next successful deploy`
            }.`
          );
          return;
        }
        // Schema v10+ (issue #2944). CLEARED HERE, not on capture success, and the
        // difference is a defect a review round found: reaching this line already
        // means the record was REBUILT from the template this run AND this run's
        // resolve did not refuse it, which is exactly the evidence the marker was
        // waiting for. Gating the clear on the capture SUCCEEDING instead made it
        // a permanent brand for any resource whose provider has no
        // `readCurrentState`, whose readback came back `undefined`, or whose read
        // threw — their `properties` are this run's trustworthy resolution, yet
        // `drift --accept` / `--revert` would refuse them forever and only a
        // CREATE / UPDATE deploy could clear it. That contradicts the field's own
        // "refusal record, not a brand" contract.
        //
        // `delete` rather than `= undefined`: the field must be ABSENT from the
        // persisted JSON, which is what a reader tests.
        delete resource.observedBaselineRefused;
        // Issue #3462: never left behind without its marker.
        delete resource.observedBaselineRefusalReason;
        try {
          const provider = providerRegistry.getProviderFor({
            resourceType: resource.resourceType,
            provisionedBy: resource.provisionedBy,
          }).provider;
          if (!provider.readCurrentState) return;
          const observed = await provider.readCurrentState(
            resource.physicalId,
            logicalId,
            resource.resourceType,
            resource.properties ?? {},
            // Issue #323: pass cross-resource context so IAM providers
            // can filter inline policies managed by sibling
            // AWS::IAM::Policy resources. By the time this runs, every
            // imported resource is already in stackState.resources, so
            // the sibling lookup is complete.
            buildReadCurrentStateContext(stackState, logicalId)
          );
          // A resource AWS reports gone (go-to-k/cdkd#4283) has no baseline to
          // record: left without one, like an unimplemented read.
          if (observed !== undefined && observed !== RESOURCE_NOT_FOUND) {
            // GHSA-p5qg-v9gv-hc7w (issue #2828), the `cdkd import` twin of the
            // `cdkd state refresh-observed` writer issue #1926 closed. The
            // readback is what AWS actually holds, so for a resource whose
            // template property is a `{{resolve:secretsmanager:...}}` reference —
            // or a `{{resolve:ssm:...}}` naming a `SecureString` — it is the
            // DECRYPTED value, and persisting it verbatim writes the plaintext
            // into `state.json`. This writer reached the redaction module along
            // NO path before this line, even though the sibling `properties`
            // walk in `resolveImportedProperties` (which runs BEFORE this one at
            // both call sites) has redacted since the original GHSA fix.
            //
            // The map is EMPTY by construction (`NO_RECORDED_SECRETS`): the
            // per-resource maps the resolve walk records into are scoped to that
            // walk, so POSITION is the whole mechanism here — exactly the
            // configuration `cdkd state refresh-observed` and the deploy's own
            // `drainObservedCaptures` persist under. `resource.properties` is
            // this record's own redacted bag, so where it holds the unresolved
            // expression, walking the observed bag against it rewrites the
            // plaintext AWS echoes back onto that expression with no secret fetch
            // and no value matching.
            //
            // "Where it holds" is deliberate. An earlier revision said the skip
            // above GUARANTEES it; it does not, and the WHAT CAN STILL GO WRONG
            // block on `resolveImportedProperties` lists the ways -- the
            // properties may hold a literal, or the walk may be unable to pair
            // the readback against them, with the skip never firing.
            //
            // `STATE_SOURCED_BASELINE_RULES` is the row this write site occupies
            // in `secret-redaction/rules.ts`'s generation table ("observed walk,
            // own-record source"). The BASELINE constant, not the plain readback
            // one, because DESTINATION is what selects it and this writer has
            // exactly one: `observedProperties`, which is a drift BASELINE and
            // nothing else. `cdkd drift --accept` passes the other constant
            // because it writes its result into `properties` for a record with no
            // baseline, where a mask is a regression; that is not this site
            // (issue [#2885](https://github.com/go-to-k/cdkd/issues/2885), the
            // residue issue [#2852](https://github.com/go-to-k/cdkd/issues/2852)
            // left). What the mask costs, what it spares and what it masks are
            // `refuseUncertifiedSubtree`'s to document and are not repeated here.
            //
            // WHAT IS LOCAL is WHICH of this command's resources it can reach,
            // and the answer is a population DISJOINT from the skip above: that
            // one refuses a baseline outright, while this reaches a resource the
            // classifier ADMITS whose readback the position walk then cannot
            // pair. Such a resource keeps its record AND its baseline, with
            // `SECRET_MASK` at the leaves that could not be certified. No count
            // is given for either population, and the skip's own note one screen
            // up says why.
            //
            // The remedy for a masked leaf is a deploy that actually CREATES or
            // UPDATES that resource, not any `cdkd deploy`:
            // `kickOffAutoRefreshObservedProperties` skips a record whose
            // `observedProperties` is already defined, and a mask is defined.
            // go-to-k/cdkd#4043 Phase C: masked at every coordinate the record
            // marks, through each list's identity field (the whole list where
            // nothing pairs), as the deploy's capture is.
            const marked = noEchoLeavesOf(resource) ?? [];
            resource.observedProperties = redactForState(
              marked.length > 0
                ? maskReadbackAtCoordinates(observed, resource.properties ?? {}, marked)
                : observed,
              {
                provenance: 'state-baseline',
                secrets: NO_RECORDED_SECRETS,
                source: resource.properties ?? {},
              }
            );
          }
        } catch (err) {
          // NAME AND SHAPE, never the message. The sibling warn in
          // `resolveImportedProperties` masks with `maskSecretsInText`; that is
          // not available here, because the secrets map on this path is EMPTY by
          // construction, so there is no needle set to mask against. And the
          // message can carry a plaintext: a provider's `readCurrentState` that
          // rethrows a `JSON.parse` failure (`CloudControlProvider`'s did until
          // issue #5254) carries V8's `SyntaxError`, which embeds an input
          // snippet -- measured on node
          // v24.19.0, `JSON.parse('{"Password": SUPER-SECRET-abc}')` reports
          // `..."assword": SUPER-SECR"...`. So log what identifies the failure
          // without quoting the input, the way `parseResourceModel` already does.
          logger.debug(
            `observedProperties capture for imported ${logicalId} (${resource.resourceType}) failed: ${err instanceof Error ? err.name : typeof err} — drift will fall back to template properties for this resource until the next successful deploy.`
          );
        }
      })
    )
  );
}
