import { childLostWithRecreatedParent, survivesParent } from '../child-of-recreated-parent.js';
import { type DeployEngine } from '../deploy-engine.js';
import type { ProvisionCounts, ResourceOutcomeSignal } from '../deploy-engine.js';
import {
  findActionableSilentDrops,
  unwrittenCreateOnlyReplacement,
  withoutAcceptedSilentDropProperties,
  withoutUnwrittenSilentDropProperties,
} from '../../provisioning/property-coverage.js';
import { CdkdError } from '../../utils/error-handler.js';
import { markNonRetryable } from '../retryable-errors.js';
import { markRefusedBeforeApplying } from '../prior-attempt-scope.js';
import {
  recordedProtectionEvidence,
  recordedProtectionNote,
} from '../../provisioning/recorded-protection.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import {
  acceptedCreateOnlyDropsOf,
  type PropertyChange,
  type ResourceChange,
  type ResourceState,
} from '../../types/state.js';
import { safeMsg } from '../../utils/display-safe.js';
import { getLiveRenderer } from '../../utils/live-renderer.js';
import { formatResourceLine } from '../../utils/resource-line.js';
import {
  type FreshNoEchoCeilingVerdict,
  type FreshNoEchoReadback,
  isReplacementCeiling,
  keyOrderFreeJson,
  liveHoldsFreshLeaves,
} from '../deploy-value-equality.js';
import {
  carriesFreshNoEchoValue,
  freshNoEchoLeafPositions,
  markSameGenerationBag,
  recordNestedStackParameterExpressions,
  redactSecretsForState,
} from '../secret-redaction.js';

declare module '../deploy-engine.js' {
  interface DeployEngine {
    /** @internal */
    provisionUpdate: OmitThisParameter<typeof provisionUpdate>;
  }
}

/** The `UPDATE` arm of `DeployEngine.provisionResourceBody` (#4200 phase 3a). */
export async function provisionUpdate(
  this: DeployEngine,
  logicalId: string,
  change: ResourceChange,
  stateResources: Record<string, ResourceState>,
  stackName: string,
  template?: CloudFormationTemplate,
  parameterValues?: Record<string, unknown>,
  conditions?: Record<string, boolean>,
  counts?: ProvisionCounts,
  progress?: { current: number; total: number }
): Promise<ResourceOutcomeSignal | void> {
  const resourceType = change.resourceType;
  // Existing state record (UPDATE / DELETE) — load-bearing for the
  // sticky `provisionedBy` routing introduced in #614: a resource
  // first created via Cloud Control (because its template had
  // silent-drop properties at the time) stays on Cloud Control for
  // every subsequent update / delete, even if the SDK provider has
  // since gained property coverage.
  const existingState = stateResources[logicalId];
  const renderer = getLiveRenderer();
  const currentResource = existingState;
  if (!currentResource) {
    throw new Error(`Cannot update ${logicalId}: resource not found in state`);
  }
  // Issue #2668: on a `Type` change the diff emits an UPDATE whose
  // `resourceType` is the TEMPLATE's (new) type, while the resource that
  // EXISTS is the state record's. The two halves of the replacement
  // route on different types: everything aimed at the OLD physical
  // resource (its delete, final snapshot, stateful guard) takes
  // `oldResourceType`, and the create takes `resourceType`. Design:
  // docs/design/2668-type-change-routing.md.
  const oldResourceType = currentResource.resourceType;
  const typeChanged = oldResourceType !== resourceType;

  const desiredProps = change.desiredProperties || {};
  const currentProps = change.currentProperties || {};
  // Issue #2750: the same bag with the keys the SDK route cannot have
  // WRITTEN removed. For a resource recorded on that route a silent-drop
  // key is junk by construction, and left in it makes the Cloud Control
  // auto-route inert on a record written before this fix:
  // `CloudControlProvider.update` builds its JSON Patch from the previous
  // side, finds the property identical on both sides, and omits it, so
  // the deploy reports success having sent nothing for it. A `cc-api`
  // record is left alone — Cloud Control sends the full map, so its bag
  // really does describe AWS.
  //
  // A SEPARATE binding rather than a narrowed `currentProps`, and the
  // scope is the point: only the two consumers that ask "what does AWS
  // hold, so what must this update send" take it — the no-op skip below
  // and the provider `update()` call. Everything else in this arm keeps
  // the RECORDED bag, in particular `isStatefulRecreateTargetForReplace`
  // (a data-loss guard, which asks what the resource HOLDS) and the
  // replacement path's `delete()` (whose providers read the recorded tags
  // to decide whether emptying is consented to). Narrowing those is inert
  // today — every key either reads is `handled` for its own type, fenced
  // by `tests/unit/provisioning/silent-drop-guard-key-disjointness.test.ts`
  // — but "inert today" is not a reason to widen a guard's input.
  //
  // Bound BELOW, once the resolved bag exists: a create-only drop stays in
  // it only while this deploy still accepts it (issue #2790), which is a
  // question about the desired side.

  // Resolve intrinsic functions in properties
  const context = this.buildResolverContext(
    {
      template: template!,
      resources: stateResources,
      ...(parameterValues && { parameters: parameterValues }),
      ...(conditions && { conditions }),
      // THE OTHER OPT-IN SITE — this arm calls
      // `refuseRedactedAttributeReads` below.
      redactedAttributeReads: [],
    },
    stackName
  );

  // Issue #2038 review: registered BEFORE `resolve`, same reason as the
  // CREATE path above — the resolver fills this map in place, and a throw
  // from inside `resolve()` after a substitution otherwise reaches the
  // shared catch with an empty bag.
  const updateSecrets = context.recordedSecretValues ?? new Map<string, string>();
  this.perResourceSecrets.set(logicalId, updateSecrets);
  const resolvedProps = (await this.resolver.resolve(desiredProps, context)) as Record<
    string,
    unknown
  >;
  // The #2274 refusal of a redacted read runs BELOW the no-change skip
  // (go-to-k/cdkd#3662), not here; see the note at that call.
  // Same position source on the UPDATE path (#1904).
  this.perResourceTemplateProps.set(logicalId, desiredProps);
  this.perResourceResolvedType.set(logicalId, resourceType);
  // Issue #2291: for an `AWS::CloudFormation::Stack` row, remember which
  // `{{resolve:...}}` expression each `Parameters` entry was resolved
  // FROM, keyed by the child's parameter NAME. The bag above is keyed by
  // PLAINTEXT, so two parameters resolving to one value have already
  // collapsed there — the parent's own template is the only uncollapsed
  // source left, and this is the last point at which both it and the
  // resolved values are in hand. `withCurrentResourceSecrets` binds THIS
  // bag around the provider call below, so the child engine reads the
  // associations off the same object. No-op for every other type.
  recordNestedStackParameterExpressions(updateSecrets, resourceType, resolvedProps, desiredProps);

  this.auditResolvedAssetReferences(logicalId, resourceType, resolvedProps);

  // Re-check diff after resolving intrinsic functions
  // DiffCalculator compares unresolved template vs resolved state, which may produce false positives.
  // Compare the REDACTED resolved bag (secret plaintext -> `{{resolve:...}}`
  // expression) against the stored side, which also holds the expression
  // (GHSA fix): a rotated secret behind an unchanged reference is a no-op,
  // matching CloudFormation, rather than a spurious UPDATE every deploy.
  // POSITIONED by the same template bag the persist path uses (#1910):
  // `currentProps` comes from state, which since #1904 holds each leaf's
  // OWN expression, so a value-only redaction here collapses a coinciding
  // pair onto the survivor and the comparison can never match — a
  // redundant UPDATE on every deploy of such a resource.
  //
  // `currentPropsAsWritten`, not the recorded bag (issue #2750): on a
  // record a pre-fix binary poisoned, the never-written key is present on
  // BOTH sides here, so the recorded bag makes this skip fire and the
  // deploy short-circuits before any provider is chosen — the auto-route
  // never runs and the property still does not reach AWS. This is the
  // second gate the healing path has to clear, after the diff's own.
  //
  // Issue #2516: the compared bag is a marked shallow COPY of the resolved
  // bag. The stored side holds an embedded 1-3 character secret as its
  // token once a deploy under this fix has written it, and the desired
  // side can only match that spelling if the walk knows the bag is this
  // pass's own — otherwise the leaf reads `port:42` against
  // `port:{{resolve:...}}` and the resource takes a redundant UPDATE on
  // every deploy. A COPY rather than `resolvedProps` itself, because the
  // mark is permanent on its object and the provider call below has not
  // happened yet: `propertiesToRecord` decides, after it, whether the
  // object state holds earns the mark.
  //
  // Issue #2809: the DESIRED operand is narrowed too, so the two sides
  // describe the same thing. `currentPropsAsWritten` removed the silent
  // drops the SDK route cannot have written; left alone, the desired side
  // still carried an allow-listed REMOVABLE drop, the strings could never
  // be equal, and this skip — with the attribute-only branch nested inside
  // it — was unreachable for such a resource. That cost a redundant
  // `provider.update()`, and on a type whose `update()` re-creates
  // (`AWS::SNS::Subscription`, where `Region` is such a drop) it turned a
  // `DeletionPolicy`-only flip into a destroy-and-recreate.
  //
  // The ALLOW SET rather than every removable drop: the diff's own
  // desired-side rule (`DiffCalculator`, issue #2750), deliberately NOT
  // the record side's. An un-allowed drop auto-routes the resource to
  // Cloud Control, which DOES write the key, so removing it here would
  // hide a real difference and skip an update that must be sent; the
  // helper removes nothing at all while any drop is un-allowed, since the
  // route is per resource. Skipped for a RECORD on 'cc-api' -- the same
  // recorded-marker test `currentPropsAsWritten` makes (an absent marker
  // counts as SDK), so both operands are narrowed for the same records.
  // `?.()` for the test doubles, as at the diff call: a double without
  // the method compares the full bag.
  //
  // A `--recreate-via-*` target never takes this skip (issue #2651): the
  // flag asks for a destroy + recreate whatever the properties say, and an
  // unchanged bag is the usual case — `promoteRecreateTargets` turns the
  // diff's NO_CHANGE for such a target into an UPDATE precisely so it
  // reaches the recreate below. A TYPE change does reach this
  // arm (the diff emits it as an UPDATE carrying `Type`), and this skip
  // compares properties only — so it is gated on `!typeChanged` below
  // (issue #3036): two types whose bags compare equal are still two
  // different resources, and skipping left AWS and the record on the OLD
  // type under a green deploy.
  //
  // The MASK-ONLY class is the exception to "compare the redacted bag"
  // (go-to-k/cdkd#3662). A `NoEcho` custom resource's value redacts to
  // `***`, which identifies nothing, so `***` equal to a recorded `***`
  // says nothing about the value: a handler that re-ran in THIS deploy and
  // returned a new token compared equal, the update was skipped, and the
  // live resource kept the old token under a green deploy. A resolved
  // bag carrying a `NoEcho` value supplied in THIS deploy (a handler
  // that ran in this process, or an output recovered from one) therefore
  // never takes the skip; a value from an earlier run resolves as the
  // mask itself, a redacted read. Only that population counts: the
  // mask-only class also holds DERIVED needles (`Fn::Base64` over a
  // `{{resolve:...}}` input), and counting those updated such a resource
  // on every deploy. The cost is a redundant update when the handler
  // returned the same value: the record holds only the mask, so there is
  // nothing here to compare the value with. A create-only property is the
  // exception, where the cost would be a REPLACEMENT: the ceiling block
  // below reads the resource back from AWS to decide that one
  // (go-to-k/cdkd#3729).
  // go-to-k/cdkd#4411: a resource AWS stores INSIDE a parent this deploy
  // destroyed and re-created under the same physical id (a fixed-name
  // function recreated, and its `AWS::Lambda::Permission`) went with the old
  // parent. Its references resolve exactly as recorded, so neither skip below
  // may fire and no ceiling may lower it: it is re-created, without deleting
  // the old one, which no longer exists.
  // A child naming several parents (`reput`) only bypasses the skips: its
  // in-place update writes the policy to each parent it names. One that
  // survives the parent (`reattach`, go-to-k/cdkd#4461) bypasses them too,
  // and its update attaches it to the re-created parent again.
  //
  // Only when the parent-naming value did NOT move: a child the same deploy
  // re-points from a surviving parent to the recreated one still has its old
  // copy on the surviving parent, and takes the ordinary replacement, whose
  // delete removes that copy. A `reattach` child takes no such gate: it is
  // never replaced, and its update drops from the recorded side only names
  // that the record AND the template give to a re-created parent, so a list
  // the same deploy also edits (`[R]` -> `[R, X]`) attaches R again as well.
  const lostCandidate = childLostWithRecreatedParent({
    resourceType,
    templateProperties: desiredProps,
    recreatedUnderSameId: this.recreatedUnderSameId,
    recordedTypeOf: (id) =>
      Object.hasOwn(stateResources, id) ? stateResources[id]?.resourceType : undefined,
    conditions,
  });
  const lostChild =
    lostCandidate?.mode === 'reattach' ||
    (lostCandidate !== undefined &&
      Object.hasOwn(resolvedProps, lostCandidate.property) &&
      Object.hasOwn(currentProps, lostCandidate.property) &&
      keyOrderFreeJson(resolvedProps[lostCandidate.property]) ===
        keyOrderFreeJson(currentProps[lostCandidate.property]))
      ? lostCandidate
      : undefined;
  const lostWithParent = lostChild?.mode === 'recreate' ? lostChild.parent : undefined;
  const suppliesFreshMaskOnlyValue = carriesFreshNoEchoValue(resolvedProps, updateSecrets);
  const desiredForSkipCheck = redactSecretsForState(
    markSameGenerationBag({ ...resolvedProps }),
    updateSecrets,
    desiredProps
  );
  const allowedSilentDrops = this.providerRegistry.getAllowedUnsupportedProperties?.();
  const desiredForSkipCheckAsWritten =
    currentResource.provisionedBy !== 'cc-api' && allowedSilentDrops
      ? withoutAcceptedSilentDropProperties(
          resourceType,
          desiredForSkipCheck,
          allowedSilentDrops,
          currentResource.properties
        )
      : desiredForSkipCheck;
  // The allow set the diff narrowed by; a test double without the getter
  // reads as the flag-less deploy, as `cdkd diff` does. The diff decided
  // "accepted" over its best-effort resolution, this over the full one: an
  // UNRECOGNIZED key still behind an intrinsic there can answer differently
  // here, and then the diff carries no replacement row for the #2790 refusal
  // below to see. That needs a schema-unknown key behind an intrinsic on a
  // type with a create-only drop.
  const allowedForRecord = allowedSilentDrops ?? new Set<string>();
  // The create-only drops this record PROVES were never sent (#2790); the
  // diff reads the same field, so both decide on the same evidence.
  const createOnlyEvidence = acceptedCreateOnlyDropsOf(currentResource);
  const currentPropsAsWritten =
    currentResource.provisionedBy === 'cc-api'
      ? currentProps
      : withoutUnwrittenSilentDropProperties(
          resourceType,
          currentProps,
          desiredForSkipCheck,
          allowedForRecord,
          createOnlyEvidence
        );
  // The metadata-only arm both no-change skips share: refresh the record's
  // template attributes and call no provider.
  const applyAttributeOnlyUpdate = (
    attributeChanges: NonNullable<typeof change.attributeChanges>
  ): void => {
    const attrSummary = attributeChanges
      .map((a) => `${a.attribute}: ${a.oldValue ?? '(unset)'} → ${a.newValue ?? '(unset)'}`)
      .join(', ');
    this.logger.info(safeMsg`  ↻ ${logicalId} (${resourceType}) attribute update: ${attrSummary}`);
    stateResources[logicalId] = {
      ...currentResource,
      ...this.extractTemplateAttributes(template, logicalId),
    };
    if (counts) counts.updated++;
    if (progress) progress.current++;
    const attrPrefix = progress ? `[${progress.current}/${progress.total}] ` : '  ';
    renderer.removeTask(logicalId);
    this.logger.info(
      safeMsg`${attrPrefix}${formatResourceLine('updated', logicalId, resourceType, 'updated (metadata)')}`
    );
  };
  if (
    !typeChanged &&
    !suppliesFreshMaskOnlyValue &&
    lostChild === undefined &&
    this.recreateDirectionFor(stackName, logicalId) === undefined &&
    keyOrderFreeJson(desiredForSkipCheckAsWritten) === keyOrderFreeJson(currentPropsAsWritten)
  ) {
    // Attribute-only change (schema v5+): `DeletionPolicy` /
    // `UpdateReplacePolicy` may have flipped without any AWS-side
    // property change. There is no per-resource AWS API for those —
    // refresh cdkd state alone and skip the provider call.
    if (change.attributeChanges && change.attributeChanges.length > 0) {
      applyAttributeOnlyUpdate(change.attributeChanges);
      return;
    }
    this.logger.debug(
      `Skipping ${logicalId}: no actual changes after intrinsic function resolution`
    );
    if (counts) counts.skipped++;
    return;
  }

  // Issue #2274: the UPDATE twin of the CREATE arm's refusal — same
  // reason, and needed on BOTH because an existing dependent whose OTHER
  // properties changed is the commonest way to reach a redacted read.
  //
  // AFTER the no-change skip, not before it (go-to-k/cdkd#3662). The
  // refusal exists so the literal `***` is never SENT; a skip sends
  // nothing and leaves the record as it was. Refusing first failed a
  // deploy over a dependent the diff promoted only speculatively (a
  // reader of a nested stack's `Outputs.<Key>`, issue #3631) whose
  // resolved bag, masked read included, equals its record. A redacted
  // read resolves to the literal mask, so it passes the skip only where
  // the record holds the mask at that same position and nothing else
  // moved, which is exactly the case with nothing to send.
  this.refuseRedactedAttributeReads(logicalId, resourceType, context);

  // #1198: snapshot the attempted (resolved) properties so a failed
  // UPDATE can be journaled with what it tried to apply (load-bearing
  // for the --revert-failed patch generation). Below the refusal, as it
  // was before the refusal moved: a refused UPDATE attempted nothing.
  this.attemptedResolvedProps.set(logicalId, resolvedProps);

  // A synthetic change's `requiresReplacement` is a CEILING
  // (go-to-k/cdkd#3662): the diff promoted this reader because an
  // attribute it reads MAY move (`inPlacePropagated`, e.g. a custom
  // resource's `Data`, a nested stack's outputs) or because a resource it
  // references was to be replaced (`replacementPropagated`), and a
  // create-only reading property then asked for a replacement whatever
  // the value turned out to be. The skip above only covers a reader with
  // NOTHING else moving; once another property changes, an unmoved value
  // would have destroyed and re-created the resource. The resolved value
  // is in hand now, so a path whose redacted value equals the record is
  // lowered to an in-place change.
  //
  // A path carrying a `NoEcho` value supplied in this deploy needs a
  // second witness (go-to-k/cdkd#3729). Its record holds `***`, and the
  // mask identifies nothing, so equal redacted values say only that the
  // OTHER leaves did not move. The resource is read back from AWS (once,
  // however many such paths it has), and the ceiling is lowered only when
  // AWS holds exactly this value at every fresh position. Nothing
  // derived from the value is stored, so there is nothing in state to
  // guess against. Every case the readback cannot confirm keeps the
  // replacement: no readback for the type, a write-only property, a
  // failed or slow read, or a different value.
  //
  // The same witness answers one change that is NOT a ceiling: a
  // create-only path the diff called changed only because it compared a
  // fresh `NoEcho` plaintext with the recorded `***`. A consumer's
  // `Fn::ImportValue` of a masked output this process recovered is that
  // shape. Such a path enters this block only when it holds a fresh leaf
  // AND its redacted value equals the record, so a real edit anywhere
  // else in it keeps the replacement exactly as before.
  // The paths whose fresh `NoEcho` leaves AWS confirmed, for the skip
  // below the block.
  const noEchoHeldPaths = new Set<string>();
  if (change.propertyChanges?.some((pc) => pc.requiresReplacement) === true) {
    let readback: Promise<FreshNoEchoReadback> | undefined;
    const lowered: PropertyChange[] = [];
    for (const pc of change.propertyChanges) {
      if (!pc.requiresReplacement) {
        lowered.push(pc);
        continue;
      }
      const freshLeaves = freshNoEchoLeafPositions(resolvedProps[pc.path], updateSecrets);
      if (!isReplacementCeiling(pc) && freshLeaves.length === 0) {
        lowered.push(pc);
        continue;
      }
      // The non-NoEcho half first, unchanged: a moved leaf keeps the
      // replacement whatever AWS holds at the masked ones.
      const moved =
        keyOrderFreeJson(desiredForSkipCheckAsWritten[pc.path]) !==
        keyOrderFreeJson(currentPropsAsWritten[pc.path]);
      // A propagated CEILING whose value MOVED is kept, unless the type's
      // own conditional rule reads the move as in place (issue #4134) --
      // the same predicate the diff applies to a template edit. A
      // property with no conditional rule answers `undefined` and keeps
      // it; a template-diff replacement is the diff's verdict already.
      const conditionalVerdict =
        moved && !typeChanged && isReplacementCeiling(pc)
          ? this.diffCalculator.conditionalReplacementVerdict?.(
              resourceType,
              pc.path,
              currentPropsAsWritten[pc.path],
              desiredForSkipCheckAsWritten[pc.path]
            )
          : undefined;
      if (moved && conditionalVerdict !== false) {
        lowered.push(pc);
        continue;
      }
      if (freshLeaves.length > 0) {
        // A Type change replaces anyway, and the record's provider
        // describes the OLD type: no read, and nothing to report.
        if (typeChanged) {
          lowered.push(pc);
          continue;
        }
        readback ??= this.readReaderForFreshNoEchoCeiling(
          logicalId,
          currentResource,
          updateSecrets
        );
        const read = await readback;
        let verdict: FreshNoEchoCeilingVerdict;
        if ('failure' in read) {
          verdict = read.failure;
        } else if (!Object.prototype.hasOwnProperty.call(read.live, pc.path)) {
          verdict = 'not-readable';
        } else {
          verdict = liveHoldsFreshLeaves(read.live[pc.path], freshLeaves) ? 'held' : 'differs';
        }
        if (verdict !== 'held') {
          // WARN, not debug: this is what turns the update into a
          // replacement, and a `Replacing` label must never be
          // unexplained. The id, the path and the class only.
          this.logger.warn(
            safeMsg`${logicalId}.${pc.path} carries a NoEcho value that AWS could not confirm unchanged (${verdict}): replacement kept.`
          );
          lowered.push(pc);
          continue;
        }
        this.logger.debug(
          safeMsg`${logicalId}.${pc.path} carries a NoEcho value AWS already holds: not replaced.`
        );
        noEchoHeldPaths.add(pc.path);
      }
      lowered.push({ ...pc, requiresReplacement: false });
    }
    change.propertyChanges = lowered;
  }

  // The no-change skip above could not trust the mask. Once AWS has
  // confirmed every fresh `NoEcho` leaf the bag carries, and every other
  // leaf equals the record, there is nothing to send, so the same skip
  // applies here. Without it the provider would be called with an
  // unchanged bag: a redundant update, or, for a type with no update API
  // (`AWS::Lambda::LayerVersion`), a refusal the update-failure fallback
  // turns back into the replacement this block just avoided. A fresh
  // leaf outside a confirmed path (an updatable property nobody read
  // back) keeps the update, as before (go-to-k/cdkd#3729).
  //
  // A `--recreate-via-*` target is never skipped here: before this skip
  // existed a fresh value always reached the recreate below, and a named
  // recreate must not be dropped because a value turned out unchanged.
  // An attribute-only change (`DeletionPolicy`, ...) takes the same
  // metadata arm as the skip above, for the same no-update-API reason.
  if (
    noEchoHeldPaths.size > 0 &&
    !typeChanged &&
    lostChild === undefined &&
    this.recreateDirectionFor(stackName, logicalId) === undefined &&
    keyOrderFreeJson(desiredForSkipCheckAsWritten) === keyOrderFreeJson(currentPropsAsWritten) &&
    Object.entries(resolvedProps).every(
      ([key, value]) =>
        noEchoHeldPaths.has(key) || freshNoEchoLeafPositions(value, updateSecrets).length === 0
    )
  ) {
    this.logger.debug(
      safeMsg`Skipping ${logicalId}: AWS already holds every NoEcho value it carries, and nothing else changed`
    );
    // Nothing was attempted, as on the skip above the refusal.
    this.attemptedResolvedProps.delete(logicalId);
    if (change.attributeChanges && change.attributeChanges.length > 0) {
      applyAttributeOnlyUpdate(change.attributeChanges);
      return;
    }
    if (counts) counts.skipped++;
    return;
  }

  // Check if this update requires resource replacement (immutable property changed)
  // `typeChanged ||` (issue #3036): a Type change is a replacement by
  // definition, never an in-place update — the in-place arm below would
  // hand the OLD physical id to the NEW type's `update()`. Read from the
  // record rather than trusted to the diff's synthetic `Type` row, so a
  // change-shape that omits the row cannot route there.
  const propertyDrivenReplacement =
    typeChanged || change.propertyChanges?.some((pc) => pc.requiresReplacement);
  // Issue [#2567] — the recreate targets apply ONLY to the stack the
  // pre-flight validated them against. This engine instance may be a
  // NESTED child (`NestedStackProvider.runChildDeploy` spreads the
  // parent's options into it, and the child deploys under
  // `<parent>~<logicalId>`), where the ids were never validated: neither
  // the child's template, nor its state record, nor its live emptiness
  // was ever looked at. Unscoped, a child resource sharing a logical id
  // with a validated parent one was treated as recreate-flagged — and
  // `recreateFlagged` is what SKIPS the stateful guard below.
  //
  // Read INSIDE `case 'UPDATE'`: a target the diff called NO_CHANGE gets
  // here because `promoteRecreateTargets` made it an UPDATE, and the
  // no-op skips above exempt it (issue #2651).
  const recreateTargets =
    this.options.recreateTargets?.stackName === stackName
      ? this.options.recreateTargets
      : undefined;
  // Issue [#615] — the user explicitly named this resource via
  // `--recreate-via-cc-api <LogicalId>` so this deploy MUST destroy
  // + recreate it through Cloud Control regardless of whether the
  // template's diff would otherwise drive a replacement.
  const recreateViaCcApi = recreateTargets?.viaCcApi.has(logicalId) ?? false;
  // #651 reverse direction. Mutually exclusive with `recreateViaCcApi`
  // — the pre-flight validator rejects any logical id named in both
  // lists, so at most one of these two booleans is true at a time.
  const recreateViaSdkProvider = recreateTargets?.viaSdkProvider.has(logicalId) ?? false;
  const recreateFlagged = recreateViaCcApi || recreateViaSdkProvider;
  const needsReplacement =
    propertyDrivenReplacement || recreateFlagged || lostWithParent !== undefined;

  // Issue #2790: a replacement driven ONLY by create-only properties an
  // earlier deploy accepted dropping (`--prefer-sdk-route`) and
  // the template still asks for unchanged. AWS never held them, and the only
  // thing that moved is that the flag went away — so destroying and
  // re-creating the resource is not something cdkd does on its own. Refused
  // before anything is deleted; `--replace` or `--recreate-via-cc-api` opts
  // in, and the stateful guard still applies on that path.
  //
  // Any OTHER replacement-requiring change lets it through: that replacement
  // happens anyway, and its create applies these properties too.
  if (
    propertyDrivenReplacement &&
    !typeChanged &&
    !recreateFlagged &&
    lostWithParent === undefined &&
    this.options.replace !== true &&
    currentResource.provisionedBy !== 'cc-api'
  ) {
    const unwritten = unwrittenCreateOnlyReplacement(
      resourceType,
      currentProps,
      desiredForSkipCheck,
      allowedForRecord,
      createOnlyEvidence,
      (change.propertyChanges ?? []).filter((pc) => pc.requiresReplacement).map((pc) => pc.path)
    );
    if (unwritten.length > 0) {
      // Marked refused-before-applying: nothing was sent, so the journal
      // must not record this resolved bag as an attempt a `--revert-failed`
      // or a later create would act on.
      throw markRefusedBeforeApplying(
        markNonRetryable(
          new CdkdError(
            unwrittenCreateOnlyRefusal({
              logicalId,
              resourceType,
              unwritten,
              routeDriving: findActionableSilentDrops(
                resourceType,
                desiredForSkipCheck,
                allowedForRecord,
                currentProps
              ).map(({ property }) => property),
              nested: this.options.parentStackInfo !== undefined,
              // Issue #2610: the replacement's delete never clears a
              // deletion protection, so the remedy says so where the record
              // shows one -- as the stateful guard does.
              protectionEvidence: recordedProtectionEvidence(
                resourceType,
                currentProps,
                currentResource.observedProperties,
                this.stackRegion
              ),
            }),
            'CREATE_ONLY_DROP_NEEDS_REPLACEMENT'
          )
        )
      );
    }
  }

  // The label `provisionResource` chose left ceilings out; one that
  // stood (the value moved, or it is a fresh `NoEcho` value AWS could
  // not confirm unchanged) turns this into a replacement, so say so.
  const liveLabel = this.liveTaskLabels.get(logicalId);
  if (needsReplacement && liveLabel !== undefined && !liveLabel.replacing) {
    const routing = this.peekRoutingForLabel(
      change,
      currentResource,
      stackName,
      logicalId,
      true,
      this.recreateDirectionFor(stackName, logicalId)
    );
    const label = `Replacing ${logicalId} (${resourceType})${routing === 'cc-api' ? ' [CC API]' : ''}`;
    this.liveTaskLabels.set(logicalId, {
      label,
      replacing: true,
      ...(liveLabel.warnSuffix !== undefined && { warnSuffix: liveLabel.warnSuffix }),
    });
    // Keep a slow-resource warning the deadline wrapper already added.
    renderer.updateTaskLabel(logicalId, `${label}${liveLabel.warnSuffix ?? ''}`);
  } else if (!needsReplacement && liveLabel !== undefined && liveLabel.replacing) {
    // The other direction (go-to-k/cdkd#3729): a create-only change the
    // label counted as a replacement was lowered above, because AWS
    // already holds the fresh `NoEcho` value there.
    const routing = this.peekRoutingForLabel(
      change,
      currentResource,
      stackName,
      logicalId,
      false,
      this.recreateDirectionFor(stackName, logicalId)
    );
    const label = `Updating ${logicalId} (${resourceType})${routing === 'cc-api' ? ' [CC API]' : ''}`;
    this.liveTaskLabels.set(logicalId, {
      label,
      replacing: false,
      ...(liveLabel.warnSuffix !== undefined && { warnSuffix: liveLabel.warnSuffix }),
    });
    renderer.updateTaskLabel(logicalId, `${label}${liveLabel.warnSuffix ?? ''}`);
  }

  // Extract ALL dependencies from template (Ref, Fn::GetAtt, DependsOn)
  const dependencies = this.extractAllDependencies(template, logicalId);

  // `UpdateReplacePolicy: Retain` orphans the OLD physical resource on a
  // replacement (the create-first path below leaves it in place — see the
  // "Retaining old" branch), so a property-driven replacement of a
  // Retain-policy resource loses NO data. Read it here so the stateful
  // guard can honor it, and reused by every later site that asks what
  // policy the user is applying NOW: the replace/delete sites below and
  // the update-failure fallback's `Retain` note. The ONE read that does
  // not use it is the fallback's SNAPSHOT read, which falls back to
  // `currentResource.updateReplacePolicy`; the reason is stated at that
  // call site.
  const updateReplacePolicy = template?.Resources?.[logicalId]?.UpdateReplacePolicy;

  // go-to-k/cdkd#4443: a lost child counts as restored once its own write
  // returned; one this deploy never reaches (it failed first) is forgotten
  // from state by the failure path, so the next deploy creates it.
  const markRestored = <T>(outcome: T): T => {
    if (lostChild === undefined) return outcome;
    if (this.updatesThatSentNothing.has(logicalId)) {
      // The provider sent nothing (Cloud Control's patch from record to
      // template is empty), so nothing reached the recreated parent: say so
      // rather than report it restored. A failed deploy reads the same set.
      // A resource merely attached to the parent (go-to-k/cdkd#4461) is not
      // pointed at a recreate flag: re-creating it to redo one attach would,
      // for an IAM user, revoke its access keys.
      this.logger.warn(
        survivesParent(resourceType)
          ? safeMsg`  ⚠ ${logicalId} lost its attachment to ${lostChild.parent}, which was re-created, but its update sent no change (it is recorded on Cloud Control, which patches record against template); it may no longer be attached to ${lostChild.parent}. Attach it there by hand.`
          : safeMsg`  ⚠ ${logicalId} went with ${lostChild.parent}, which was re-created, but its update sent no change (it is recorded on Cloud Control, which patches record against template); its policy may be missing from ${lostChild.parent}. Re-run with --recreate-via-sdk-provider ${logicalId} to write it again.`
      );
      return outcome;
    }
    this.restoredLostChildren.add(logicalId);
    return outcome;
  };
  if (needsReplacement) {
    return markRestored(
      await this.updateByReplacement({
        change,
        counts,
        currentProps,
        currentResource,
        dependencies,
        logicalId,
        oldResourceType,
        progress,
        propertyDrivenReplacement,
        recreateFlagged,
        recreateViaCcApi,
        recreateViaSdkProvider,
        renderer,
        resolvedProps,
        resourceType,
        stackName,
        stateResources,
        template,
        typeChanged,
        updateReplacePolicy,
        updateSecrets,
        lostWithParent,
      })
    );
  }
  return markRestored(
    await this.updateInPlace({
      conditions,
      counts,
      currentProps,
      currentPropsAsWritten,
      currentResource,
      dependencies,
      desiredForSkipCheckAsWritten,
      logicalId,
      noEchoHeldPaths,
      parameterValues,
      progress,
      renderer,
      resolvedProps,
      resourceType,
      stackName,
      stateResources,
      template,
      updateReplacePolicy,
      updateSecrets,
      reattach: lostChild?.mode === 'reattach',
    })
  );
}

/**
 * The text of the issue #2790 refusal. Exported for its unit test.
 *
 * It states only what holds in every case it fires on: the record holds the
 * key, the SDK provider never writes it, and this deploy routes the resource
 * through Cloud Control. It does NOT claim this deploy's flags omit the key,
 * since a sibling drop the flags do not cover routes the resource just the
 * same.
 *
 * `routeDriving` is every key that sends the resource to Cloud Control on this
 * deploy. Keeping the resource on its SDK provider needs ALL of them, and the
 * unwritten ones, allow-listed, since the route is per resource, so the
 * keep-dropping remedy names the union. `nested` drops `--recreate-via-cc-api`,
 * which cannot address a resource inside a nested stack's child.
 * `protectionEvidence` is `recordedProtectionEvidence`'s answer for the record.
 *
 * @internal
 */
export function unwrittenCreateOnlyRefusal(input: {
  logicalId: string;
  resourceType: string;
  unwritten: readonly string[];
  routeDriving: readonly string[];
  nested: boolean;
  protectionEvidence?: string | undefined;
}): string {
  const { logicalId, resourceType, unwritten, routeDriving, nested, protectionEvidence } = input;
  const one = unwritten.length === 1;
  const list = unwritten.join(', ');
  const keep = [...new Set([...unwritten, ...routeDriving])]
    .sort((a, b) => a.localeCompare(b))
    .map((property) => `${resourceType}:${property}`)
    .join(',');
  // `--recreate-via-cc-api` deletes the old resource first; `--replace` takes
  // the property-driven path, which creates the new one first and so collides
  // where the new one must hold a unique value the old one still holds (a
  // subnet's CIDR block, a fixed name). Inside a nested child only `--replace`
  // reaches the resource.
  const replaceFlags = nested
    ? '--replace (which creates the new resource before deleting the old one, so a ' +
      'resource holding a unique value such as a fixed name or CIDR block collides)'
    : `--recreate-via-cc-api ${logicalId}, which deletes the old resource first ` +
      '(--replace also works, but creates the new one first, so a resource holding a ' +
      'unique value such as a fixed name or CIDR block collides)';
  const routed = [...routeDriving].sort((a, b) => a.localeCompare(b)).join(', ');
  return (
    `${logicalId} (${resourceType}): ${list} ${one ? 'is' : 'are'} create-only, and the ` +
    `state record holds ${one ? 'it' : 'them'} although this type's SDK provider never ` +
    `writes ${one ? 'it' : 'them'}, so AWS does not. This deploy routes the resource through ` +
    `Cloud Control (--prefer-sdk-route does not cover ${routed}), and applying a create-only ` +
    `property means replacing the resource, which cdkd does not do on its own. This ` +
    `resource was not changed. To replace it and apply ${list}, re-run with ${replaceFlags}; a ` +
    `stateful resource also needs --force-stateful-recreation.` +
    (protectionEvidence !== undefined
      ? ` ${recordedProtectionNote(protectionEvidence, nested ? '--replace' : `--recreate-via-cc-api ${logicalId} or --replace`)}`
      : '') +
    ` To keep dropping ${one ? 'it' : 'them'}, re-run with --prefer-sdk-route ${keep}.`
  );
}
