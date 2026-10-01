import { type DeployEngine, InterruptedError } from './deploy-engine.js';
import type { ProvisionCounts, ResourceOutcomeSignal } from './deploy-engine.js';
import { withUnchangedSecretPrincipalLists } from '../provisioning/iam-policy-targets.js';
import { isInterruptedWaitError } from '../provisioning/interrupt-watch.js';
import {
  withoutAcceptedSilentDropProperties,
  withoutSilentDropProperties,
} from '../provisioning/property-coverage.js';
import { STICKY_CC_MIGRATION_EXEMPT, ccBrokenReason } from '../provisioning/provider-registry.js';
import {
  applyDefaultNameForFallback,
  withoutGeneratedFallbackName,
} from '../provisioning/resource-name.js';
import {
  isStatefulRecreateTargetForReplace,
  renderStatefulReason,
} from '../provisioning/stateful-types.js';
import { isWaitAbandonedError } from '../provisioning/wait-abandoned.js';
import type {
  CloudFormationTemplate,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
} from '../types/resource.js';
import {
  type PropertyChange,
  type ResourceChange,
  type ResourceState,
  hasUnverifiableParameterRefusal,
} from '../types/state.js';
import { bold, gray, green, yellow } from '../utils/colors.js';
import { safeMsg } from '../utils/display-safe.js';
import { CdkdError, ResourceUpdateNotSupportedError } from '../utils/error-handler.js';
import { getLiveRenderer } from '../utils/live-renderer.js';
import { formatResourceLine } from '../utils/resource-line.js';
import { deleteSkipReason, deleteSkippedMessage } from './delete-outcome.js';
import { collisionLine, markOwnLines } from './collision-text.js';
import { logicalIdShown, resourceTypeShown } from '../provisioning/composite-id.js';
import { physicalIdShownBesideCommand } from '../utils/pasteable-command.js';
import {
  type FreshNoEchoCeilingVerdict,
  type FreshNoEchoReadback,
  isReplacementCeiling,
  keyOrderFreeJson,
  liveHoldsFreshLeaves,
} from './deploy-value-equality.js';
import {
  renderNameHeldElsewhere,
  replacementOldHoldsSentName,
  replacementRequestsDifferentName,
} from './replacement-name-holder.js';
import { withCurrentResourceSecrets } from './resource-secrets-scope.js';
import { withRetry } from './retry.js';
import {
  isMarkedNonRetryable,
  isNameCollisionErrorFrom,
  isRecreateRetryableError,
  isUpdateUnsupportedError,
  markNonRetryable,
} from './retryable-errors.js';
import {
  carriesFreshNoEchoValue,
  createSecretMasker,
  freshNoEchoLeafPositions,
  markSameGenerationBag,
  maskSecretsInText,
  recordNestedStackParameterExpressions,
  redactSecretsForState,
} from './secret-redaction.js';
import { equalIdNamesDifferentResources, equalIdNamesSameResource } from './type-change-guard.js';
import { updatePartialMessage, updatePartialReason } from './update-outcome.js';

declare module './deploy-engine.js' {
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
  const currentPropsAsWritten =
    currentResource.provisionedBy === 'cc-api'
      ? currentProps
      : withoutSilentDropProperties(resourceType, currentProps);

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
  // The recreate flags are read below this skip (the issue #2651 class),
  // but for a resource whose TYPE is unchanged a `--recreate-via-*`
  // target this narrowing could absorb is not reachable from the CLI:
  // `--recreate-via-cc-api` with `--prefer-sdk-route` on the same
  // resource is `ambiguousIntent` whenever the template carries the
  // allow-listed drop (a check made against the RECORDED type), and
  // `--recreate-via-sdk-provider` is `blockedAlreadySdk` for every record
  // not on 'cc-api', a superset of the records narrowed here (which also
  // need an allow set and a removable drop). Both refuse at pre-flight
  // with `RECREATE_TARGETS_INVALID` -- see
  // `src/deployment/recreate-targets.ts`. A TYPE change does reach this
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
  // Read INSIDE `case 'UPDATE'`, and only after the no-op short-circuit
  // above: a named target whose diff is NO_CHANGE is silently ignored
  // (issue [#2651](https://github.com/go-to-k/cdkd/issues/2651)) -- which is also why any test or fixture measuring
  // this flag must give the target a real property change, or it
  // measures nothing.
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
  const needsReplacement = propertyDrivenReplacement || recreateFlagged;

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

  if (needsReplacement) {
    // Stateful guard for PROPERTY-DRIVEN replacement (an immutable /
    // createOnly property changed in the template). DELETE+CREATEing a
    // stateful type (RDS / EFS / Secret / SSM Parameter / Kinesis / etc.)
    // loses all of its data, so — mirroring the `--replace` and
    // `--recreate-via-*` paths — require `--force-stateful-recreation` to
    // confirm the data loss. Only the property-driven case is gated here:
    // the `--recreate-via-*` flags run their own pre-flight stateful probe
    // (`probeStatefulRecreateTargetsAsync`) before the deploy, so a
    // recreate-flagged target has already been validated. Uses the
    // conservative mid-deploy variant (treats a non-probed S3 bucket, and
    // a log group whose recorded retention does not already settle it, as
    // stateful) since the diff loop has no chance to run the async
    // emptiness probes. A `Retain` UpdateReplacePolicy is exempt: the
    // old resource + its data survive the replacement (orphaned, not
    // deleted), so there is no data loss to confirm. `Snapshot` is NOT
    // exempt: cdkd DOES take a final snapshot on the replacement delete
    // (issue #1354), but a snapshot is a point-in-time copy, not a
    // surviving resource — the live resource is still destroyed and
    // recreated, so the consent flag is still the right gate.
    if (propertyDrivenReplacement && !recreateFlagged && updateReplacePolicy !== 'Retain') {
      // Three arguments, not two (issue [#2521]): the guard's log-group arm
      // reads a positive `RetentionInDays` out of EITHER recorded bag, so
      // the observed one -- where an out-of-band `put-retention-policy`, or
      // an import whose template never declared the property, puts it -- has
      // to travel with the recorded one. `currentProps` stays the recorded
      // bag exactly as before; `currentResource` is this UPDATE branch's
      // state record, the only place the observed bag exists.
      // The OLD type (issue #2668): the guard asks what the resource being
      // destroyed HOLDS, and that resource is the state record's. Keyed
      // on the template's type, a stateful-to-non-stateful Type change
      // escaped the guard entirely, and the reverse refused a deploy that
      // destroys nothing stateful.
      const statefulReason = isStatefulRecreateTargetForReplace(
        oldResourceType,
        currentProps,
        currentResource.observedProperties
      );
      if (statefulReason && this.options.forceStatefulRecreation !== true) {
        const immutableProps =
          change.propertyChanges
            ?.filter((pc) => pc.requiresReplacement)
            .map((pc) => pc.path)
            .join(', ') || 'Type';
        // `markNonRetryable`: the verdict is computed from a CLI flag and
        // a state-recorded property bag, neither of which a retry can
        // change — and the message interpolates a template-controlled
        // logical id into text the SUBSTRING-matching retry classifiers
        // read. The twin marker sits on the update-failure fallback's
        // guard below; both are declarations, not fixes for an observed
        // retry (the throws are outside `withRetry` today, but a nested
        // stack's child engine re-throws into the parent's).
        throw markNonRetryable(
          new CdkdError(
            `${logicalId} (${oldResourceType}) requires replacement (immutable property changed: ` +
              `${immutableProps}${typeChanged ? `, to ${resourceType}` : ''}) but it is a stateful resource — ` +
              `${renderStatefulReason(statefulReason)}. Re-run with ` +
              `--force-stateful-recreation to confirm the data loss, or change the resource ` +
              `definition to avoid the immutable-property change.`,
            'STATEFUL_REPLACE_BLOCKED'
          )
        );
      }
    }

    // Issue #3899: `--recreate-via-cc-api` deletes the old resource FIRST
    // and then creates through Cloud Control, pinned by `forceCcApi`
    // below, which the registry honours before it consults whether Cloud
    // Control can create the type at all. `validateRecreateTargets`
    // refuses such a type pre-flight (#3887); this is the same verdict
    // at the delete, so a caller that skips the validator cannot delete
    // a resource that is then never recreated.
    if (recreateViaCcApi) {
      const noCcRoute = this.providerRegistry.ccRouteUnavailableReason(resourceType);
      if (noCcRoute !== undefined) {
        throw markNonRetryable(
          new CdkdError(
            `--recreate-via-cc-api cannot recreate ${logicalId} (${resourceType}): Cloud ` +
              `Control API cannot create this type (${noCcRoute}). Nothing was deleted. ` +
              `Drop ${logicalId} from --recreate-via-cc-api.`,
            'RECREATE_TARGETS_INVALID'
          )
        );
      }
      // Issue #4119: routing ignores the flag for this type, so the
      // recreate would delete and recreate it on the SDK route.
      const ccBroken = ccBrokenReason(resourceType);
      if (ccBroken !== undefined) {
        throw markNonRetryable(
          new CdkdError(
            `--recreate-via-cc-api cannot move ${logicalId} (${resourceType}) to Cloud ` +
              `Control: ${ccBroken}, so cdkd keeps it on its SDK provider. Nothing was ` +
              `deleted. Drop ${logicalId} from --recreate-via-cc-api.`,
            'RECREATE_TARGETS_INVALID'
          )
        );
      }
    }

    // Resource replacement: DELETE old → CREATE new
    let replacementReason: string;
    if (recreateViaCcApi) {
      replacementReason = '--recreate-via-cc-api flag (mid-life SDK→CC migration)';
    } else if (recreateViaSdkProvider) {
      // #651 reverse direction.
      replacementReason = '--recreate-via-sdk-provider flag (mid-life CC→SDK migration)';
    } else {
      replacementReason = `immutable properties changed: ${change.propertyChanges
        ?.filter((pc) => pc.requiresReplacement)
        .map((pc) => pc.path)
        .join(', ')}`;
    }
    this.logger.info(
      `Replacing ${logicalId} (${typeChanged ? `${oldResourceType} -> ${resourceType}` : resourceType}) - ${replacementReason}`
    );

    // The new (replacement) resource gets a fresh routing decision —
    // a property the SDK provider used to silent-drop may now be
    // wired, or vice versa. The OLD resource's delete uses the
    // state-recorded layer (sticky) so a CC-managed legacy is
    // deleted via CC even if the template now would land on SDK.
    //
    // When the recreate is driven by `--recreate-via-cc-api`, pass
    // an explicit `provisionedBy: 'cc-api'` hint so the routing
    // decision tree's rule 2 ("sticky CC") returns CC even when
    // the template itself has no silent-drop property. The new
    // physical id then stamps `provisionedBy: 'cc-api'` on state
    // and all subsequent ops stick to CC.
    //
    // #651: `--recreate-via-sdk-provider` is the reverse — force
    // `provisionedBy: 'sdk'` so the routing decision returns the
    // SDK provider even though the current state record sticks at
    // 'cc-api'. The new physical id stamps `provisionedBy: 'sdk'`.
    const recreateDirectionHint: 'sdk' | 'cc-api' | undefined = recreateViaCcApi
      ? 'cc-api'
      : recreateViaSdkProvider
        ? 'sdk'
        : undefined;
    const replaceDecision = this.providerRegistry.getProviderFor({
      resourceType,
      properties: resolvedProps,
      ...(recreateDirectionHint && { provisionedBy: recreateDirectionHint }),
      // Issue #3713: the baseline an unrecognized property is compared
      // against. A replacement mints a NEW physical resource, but one
      // replacing a resource that deployed with the key unchanged keeps
      // its route — on presence, a typo CloudFormation would reject but
      // the SDK route tolerated would fail the replacement instead.
      // Inert for the sticky-escape: without a `'cc-api'` record hint
      // rule 2 is not consulted, and with one `forceCcApi` pins it.
      previousProperties: currentResource.properties,
      // Issue #2719: `--recreate-via-cc-api` passes `provisionedBy:
      // 'cc-api'` as a HINT, and for a type with an `'sdk-coverage'`
      // exemption the sticky-escape would read that hint and divert the
      // resource straight back to the SDK provider -- turning the user's
      // explicit "recreate this through Cloud Control" into a no-op.
      // Pinning here is what keeps the flag meaning what it says.
      ...(recreateViaCcApi && { forceCcApi: true }),
    });
    const replaceProvider = replaceDecision.provider;
    const replaceProps =
      replaceDecision.provisionedBy === 'cc-api'
        ? this.preparePropertiesForCcApi(resourceType, resolvedProps, logicalId)
        : resolvedProps;

    // Order: property-driven replacement (immutable prop changed)
    // creates the NEW resource first so the old survives a CREATE
    // failure — matches CFn's safe-replacement order. The
    // `--recreate-via-cc-api` flag (#615) instead destroys the OLD
    // resource first: the user-named recreate target almost always
    // has a user-supplied physical name (e.g. `functionName: 'foo'`),
    // and a create-first attempt with the same name collides with
    // the existing resource. Brief deletion-window downtime is the
    // explicit cost of opting into recreate; the design doc § 2
    // calls this out as "Old physical resource: destroyed via SDK
    // Provider ... New physical resource: created via CC API",
    // i.e. destroy-then-create — except when the template also renames
    // the target (go-to-k/cdkd#3931): the old resource then does not
    // hold the new name, so `createFirstThenDeleteOld` creates first.
    // (`updateReplacePolicy` is read once above, before the stateful
    // guard, and reused here.)
    //
    // Issue #2668: BOTH inputs come from the state record. The layer
    // always did; the TYPE used to be the template's, so on a Type change
    // the old resource's delete was dispatched at the NEW type's provider
    // — a loud API error, a silent leak, or (where the two types'
    // physical-id namespaces overlap) the deletion of an unrelated live
    // resource of the new type.
    const oldDeleteProvider = this.providerRegistry.getProviderFor({
      resourceType: oldResourceType,
      provisionedBy: currentResource.provisionedBy,
    }).provider;

    // Whether an EQUAL physical id on the two halves names the SAME
    // resource — what the two name-idempotent guards below assume. True
    // within one type; across a Type change only for the custom-resource
    // family (`equalIdNamesSameResource` has the reasoning).
    const equalIdIsSameResource = equalIdNamesSameResource({
      oldType: oldResourceType,
      newType: resourceType,
      createLayer: replaceDecision.provisionedBy,
      // Issue #3892: a Glue table's id is placed by DatabaseName, so an
      // equal id can be a genuinely new table in another database.
      oldProperties: currentResource.properties,
      newProperties: resolvedProps,
      physicalId: currentResource.physicalId,
    });

    // go-to-k/cdkd#3937 / #3931: a name KNOWN to move off the one the old
    // resource holds, probed where the create would adopt a taken one.
    // Before any arm below creates or deletes anything.
    const nameChange = await this.checkedReplacementNameChange({
      logicalId,
      resourceType,
      oldResourceType,
      stackName,
      currentResource,
      desiredProperties: resolvedProps,
      createProvider: replaceProvider,
      createdVia: replaceDecision.provisionedBy,
      createProps: replaceProps,
      secrets: updateSecrets,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- shape varies by ResourceProvider impl
    let createResult: any;
    if (recreateFlagged && nameChange !== undefined) {
      // go-to-k/cdkd#3931: the destroy-then-create below exists to free
      // a name the old resource holds; this one moves to another, so the
      // old resource is deleted only once its replacement exists — and,
      // under Retain, a collision is refused at once rather than retried
      // as a late name release.
      const retainOld = updateReplacePolicy === 'Retain';
      const recreateFlagName = recreateViaCcApi
        ? '--recreate-via-cc-api'
        : '--recreate-via-sdk-provider';
      if (retainOld) {
        // Issue #2603, as on the destroy-then-create arm.
        this.retainedOldOnReplacement.add(logicalId);
        this.logger.warn(
          safeMsg`  ⚠ ${logicalId} has UpdateReplacePolicy: Retain — ${recreateFlagName} leaves the old physical resource (${currentResource.physicalId}) in place, no longer tracked by cdkd.`
        );
      }
      createResult = await this.createFirstThenDeleteOld({
        retainOld,
        logicalId,
        resourceType,
        oldResourceType,
        currentResource,
        createProvider: replaceProvider,
        createProps: replaceProps,
        deleteProvider: oldDeleteProvider,
        deleteProperties: currentResource.properties,
        secrets: updateSecrets,
        change: nameChange,
        equalIdIsSameResource,
        snapshotPolicy: updateReplacePolicy,
        deletePolicy: updateReplacePolicy,
        trigger: recreateFlagName,
      });
    } else if (recreateFlagged) {
      // Destroy-then-create path. Same `UpdateReplacePolicy:
      // Retain` semantics — retained old resources leak (named the
      // same as the new); document via warning. CFn would refuse a
      // Retain + replace combo at template-author time; cdkd warns
      // and proceeds since the user explicitly opted in.
      const recreateFlagName = recreateViaCcApi
        ? '--recreate-via-cc-api'
        : '--recreate-via-sdk-provider';
      if (updateReplacePolicy === 'Retain') {
        // Issue #2603: the delete below is SKIPPED, so record that this
        // deploy left the old resource alive — the rollback classifier
        // reads this rather than re-deriving the verdict from the
        // previous state record's policy.
        this.retainedOldOnReplacement.add(logicalId);
        this.logger.warn(
          `  ⚠ ${logicalId} has UpdateReplacePolicy: Retain — ${recreateFlagName} will ` +
            `leak the old physical resource (${currentResource.physicalId}). The new ` +
            `resource shares the same name where applicable; if the type ` +
            `has user-supplied names (e.g. functionName, bucketName), the create will ` +
            `deterministically collide with the retained orphan.`
        );
      } else {
        this.logger.info(
          `  Destroying old ${logicalId} (${currentResource.physicalId}) before recreate...`
        );
        // `UpdateReplacePolicy: Snapshot` (issue #1354): snapshot the
        // old resource before the recreate's delete. OUTSIDE the try
        // so a snapshot failure/refusal keeps its typed
        // FINAL_SNAPSHOT_* error instead of being rewrapped as a
        // delete failure that never happened.
        const recreateFinalSnapshotId = await this.prepareFinalSnapshotForDelete(
          logicalId,
          oldResourceType,
          currentResource,
          updateReplacePolicy
        );
        let recreateDeleteResult: void | ResourceDeleteResult;
        try {
          recreateDeleteResult = await oldDeleteProvider.delete(
            logicalId,
            currentResource.physicalId,
            oldResourceType,
            currentResource.properties,
            {
              expectedRegion: this.stackRegion,
              forceDataDelete: this.options.forceStatefulRecreation === true,
              ...(recreateFinalSnapshotId !== undefined && {
                finalSnapshotIdentifier: recreateFinalSnapshotId,
              }),
              ...this.replacementDeleteContext(updateReplacePolicy),
              recordedAttributes: currentResource.attributes,
            }
          );
        } catch (deleteError) {
          // Re-throw so the deploy engine's existing rollback path
          // sees the failure — recreate's destroy is load-bearing
          // (without it the subsequent create collides with the
          // pre-existing resource), so a swallowed failure would
          // produce a confusing AlreadyExists later.
          throw new Error(
            `Failed to destroy old resource ${logicalId} (${currentResource.physicalId}) ` +
              `during ${recreateFlagName}: ` +
              `${deleteError instanceof Error ? deleteError.message : String(deleteError)}`
          );
        }
        // Issue #1762: same reasoning as the delete-first fallback —
        // this destroy is load-bearing, so a skip has to fail the
        // resource rather than let the create run beside a live old one.
        const recreateSkipReason = deleteSkipReason(recreateDeleteResult);
        if (recreateSkipReason !== undefined) {
          throw new Error(
            deleteSkippedMessage(
              logicalId,
              currentResource.physicalId,
              recreateSkipReason,
              `during ${recreateFlagName}`
            )
          );
        }
        this.logger.info(`  ${green('✓')} Old resource deleted`);
      }

      this.logger.info(`  Creating new ${logicalId}...`);
      // Delete-then-create just released the old resource's name, so
      // the re-create can hit a late name release ("already exists"
      // from an async delete) or the SQS 60s same-name cooldown
      // (QueueDeletedRecently, issue #1214). The inner retry matches
      // the cooldown — and since issue #2116 it rides the name-cooldown
      // grid (2s/4s/8s then 10s, ≈64s), not the generic ~47s one it used
      // to inherit, so the inner loop alone now covers the 60s window
      // rather than typically ending inside it.
      //
      // This outer loop is kept anyway, and the reason has MOVED rather
      // than disappeared: it is no longer "the inner budget is too
      // short" but that the outer filter is `isRecreateRetryableError`,
      // which also covers the late name RELEASE ("already exists" from
      // an async delete) that the inner default classifier deliberately
      // rejects. Note the two now COMPOUND — the outer loop re-enters an
      // inner loop that is itself 64s — measured at 640s total sleep on
      // a cooldown, inside the 30-minute per-resource deadline. See
      // `NAME_COOLDOWN_INITIAL_DELAY_MS` in retry.ts.
      createResult = await withRetry(
        () =>
          this.withRetry(
            () =>
              withCurrentResourceSecrets(updateSecrets, () =>
                replaceProvider.create(logicalId, resourceType, replaceProps, {
                  maskSecrets: createSecretMasker(updateSecrets),
                })
              ),
            logicalId,
            undefined,
            undefined,
            replaceProvider
          ),
        logicalId,
        {
          maxRetries: 8,
          initialDelayMs: 2_000,
          maxDelayMs: 10_000,
          // Issue #2038, same reason as the --replace fallback above --
          // and bound to `updateSecrets`, the bag this UPDATE resolved
          // with and the very one the `createSecretMasker` one statement
          // up is built from, rather than looked up by logical id.
          logger: this.maskingRetryLoggerFor(updateSecrets),
          isInterrupted: () => this.interrupted,
          onInterrupted: () => new InterruptedError(this.interruptCause ?? 'user'),
          isRetryable: isRecreateRetryableError,
        }
      );

      // Issue #1238: under `UpdateReplacePolicy: Retain` the old
      // resource was NOT destroyed above, so a name-idempotent Create
      // API (e.g. SQS CreateQueue with an unchanged QueueName) can
      // silently return the EXISTING resource instead of colliding.
      // Recording that id as the "new" resource would re-adopt the
      // resource the Retain policy just orphaned — without the new
      // properties ever being applied. Fail before the state
      // bookkeeping runs; the old resource and its state record stay
      // intact.
      //
      // `equalIdIsSameResource` (issue #2668): across a Type change an
      // equal id is a coincidence of two namespaces, and the create was a
      // genuine one — the custom-resource family excepted.
      if (
        equalIdIsSameResource &&
        updateReplacePolicy === 'Retain' &&
        createResult.physicalId === currentResource.physicalId
      ) {
        throw new CdkdError(
          `${logicalId} (${resourceType}) recreate returned the existing resource ` +
            `(${currentResource.physicalId}) instead of creating a new one — its Create ` +
            `API is name-idempotent — and UpdateReplacePolicy: Retain means the old ` +
            `resource was never destroyed, so the new properties were not applied. ` +
            `Rename the resource in your CDK code (or remove the explicit physical ` +
            `name) so the recreate can produce a genuinely new resource.`,
          'NAMED_REPLACEMENT_IDEMPOTENT_CREATE'
        );
      }
    } else {
      // Property-driven replacement: create-then-destroy (CFn
      // safe-replacement order — keeps the old alive if CREATE
      // fails so the deploy can roll back to it cleanly).
      this.logger.info(`  Creating new ${logicalId}...`);
      let deletedOldFirst = false;
      try {
        createResult = await this.withRetry(
          () =>
            withCurrentResourceSecrets(updateSecrets, () =>
              replaceProvider.create(logicalId, resourceType, replaceProps, {
                maskSecrets: createSecretMasker(updateSecrets),
              })
            ),
          logicalId,
          undefined,
          undefined,
          replaceProvider
        );
      } catch (createError) {
        // The AWS text every refusal below quotes: masked FIRST (the
        // create was handed resolved values), then rendered display-safe,
        // collapsed and bounded (`collisionLine`, shared with the rollback
        // twin), on a line of its own and inside a JSON boundary, since an
        // AWS message can echo a template value and these refusals name
        // `cdkd deploy --replace` (go-to-k/cdkd#4291, go-to-k/cdkd#3950's S1
        // rule).
        const createCollisionLine = collisionLine(
          maskSecretsInText(
            createError instanceof Error ? createError.message : String(createError),
            updateSecrets
          )
        );
        // How these refusals name the resource beside that command: itself
        // when plain, a description otherwise (go-to-k/cdkd#4291).
        const refusalHead = `${logicalIdShown(logicalId)} (${resourceTypeShown(resourceType)})`;
        // A custom-named resource cannot be safely replaced: the
        // create-first attempt collides with the old resource still
        // holding the name. CloudFormation refuses this same shape
        // ("cannot update a stack when a custom-named resource
        // requires replacing"); surface an equally clear error —
        // with a working one-command escape hatch CFn lacks —
        // instead of the raw AlreadyExists (issue #960 follow-up).
        //
        // NOTE: the detection is a HEURISTIC — an "already
        // exists" raised by something other than the replaced
        // resource's own name (e.g. an externally-owned sibling)
        // also matches. So delete-first fires only under the explicit
        // --replace opt-in, targets only the state-recorded old
        // physicalId, after the stateful guard, and only once
        // `replacementOldHoldsSentName` proves that old resource holds
        // the name the create sent (issue #3979).
        // Reads the ERROR, not the rendered message: ELBv2 states the
        // collision in prose the message matcher cannot see and must not
        // be widened to see, and the name is dropped by the provider wrap
        // (issue go-to-k/cdkd#3208).
        const nameCollision = isNameCollisionErrorFrom(createError, logicalId);
        if (!nameCollision) throw createError;
        // Retain pins the old resource (and its name) in place, so a
        // same-name replacement can never proceed under any flag.
        // (Snapshot is not special-cased HERE — the old resource is
        // still deleted so the name frees up; the delete-first helper
        // takes its final snapshot first, issue #1354.)
        const nameOrigin = this.replacementNameOrigin(logicalId, currentResource.physicalId);
        // Issue #2668: across a Type change the old resource can hold the
        // name only where the two types share a name space; every other
        // pair is refused by the #3979 holder proof below, whose
        // diagnosis names both types.
        // Issue #3808: every message below, and the `--replace`
        // delete-first retry, presume the old resource holds the name.
        // When the template's explicit name says otherwise, the holder
        // is another resource: refuse under every flag and policy, since
        // deleting the old resource first would only destroy it and hit
        // the same collision. Nothing has been deleted at this point.
        const nameHeldElsewhere = replacementRequestsDifferentName({
          oldResourceType,
          newResourceType: resourceType,
          desiredProperties: resolvedProps,
          recorded: currentResource.properties,
          observed: currentResource.observedProperties,
          physicalId: currentResource.physicalId,
        });
        if (nameHeldElsewhere !== undefined) {
          // Marked: a template value and a recorded name decide it, and
          // the message quotes the create's collision text, which the
          // recreate retry classifier treats as retryable.
          throw markOwnLines(
            markNonRetryable(
              new CdkdError(
                // The provider's text is on its own line below, and the command
                // carries no backtick wrapper: pasted, a backtick span is command
                // SUBSTITUTION (go-to-k/cdkd#3436, go-to-k/cdkd#4291). Masked at
                // construction, like the holder refusal below: the names come
                // from the resolved bag.
                maskSecretsInText(
                  `${refusalHead} requires replacement, but the create-first ` +
                    `attempt collided (the provider text is on the Underlying collision line ` +
                    `below). ${renderNameHeldElsewhere(nameHeldElsewhere)}` +
                    (this.options.replace === true
                      ? ` — so --replace was NOT applied and nothing was deleted.`
                      : updateReplacePolicy === 'Retain'
                        ? ` — so removing UpdateReplacePolicy: Retain and re-running with ` +
                          `cdkd deploy --replace would delete this resource and still collide.`
                        : ` — so cdkd deploy --replace would delete this resource and still ` +
                          `collide.`) +
                    ` Choose a name no other resource holds, or delete the resource holding it if ` +
                    `it is yours.` +
                    `\nUnderlying collision: ${createCollisionLine}`,
                  updateSecrets
                ),
                'NAMED_REPLACEMENT_COLLISION',
                // Chained like the fallback twin, so the persisted event
                // names the AWS rejection; safe because the refusal is
                // marked, which the retry classifiers read first.
                createError instanceof Error ? createError : undefined
              )
            )
          );
        }
        // Issue #3979: the check above refuses only a KNOWN different
        // explicit name. With no name in the template, or one a
        // rewriting provider (IAM, ELBv2) sends under this deploy's
        // stack scope and prefix flag, the collision may be with an
        // orphan of an earlier attempt, a replayed create or a
        // squatter — and deleting the old resource then destroys a live
        // resource that never held the name, and collides again. So
        // prove the old resource holds the name the create SENT, here in
        // the create's own async scope, and refuse when it is not proven.
        // Ahead of the Retain and no-flag refusals too: both presume
        // the old resource holds the name, and the no-flag one advises
        // the `--replace` this check would then refuse.
        const holder = replacementOldHoldsSentName({
          createType: resourceType,
          holderType: oldResourceType,
          requested: replaceProps,
          // A nameless SDK create: the name the provider mints, trusted
          // only for a type audited to mint cdkd's rule verbatim.
          generated: applyDefaultNameForFallback(logicalId, resourceType, resolvedProps),
          recorded: currentResource.properties,
          observed: currentResource.observedProperties,
          physicalId: currentResource.physicalId,
          logicalId,
          createdVia: replaceDecision.provisionedBy,
          holderVia: currentResource.provisionedBy,
          mask: (value) => maskSecretsInText(value, updateSecrets),
        });
        if (!holder.holds) {
          // No backtick wrapper on the command (go-to-k/cdkd#3436).
          const flagClause =
            this.options.replace === true
              ? ` --replace was NOT applied and nothing was deleted.`
              : updateReplacePolicy === 'Retain'
                ? ` Nothing was deleted. UpdateReplacePolicy: Retain keeps the resource ` +
                  `being replaced in place; removing it and re-running with ` +
                  `cdkd deploy --replace would refuse the same way rather than delete it.`
                : ` Nothing was deleted, and cdkd deploy --replace would refuse the ` +
                  `same way rather than delete it.`;
          throw markOwnLines(
            markNonRetryable(
              new CdkdError(
                // Masked at construction: the create's collision text can
                // echo a resolved value.
                maskSecretsInText(
                  // The rollback twin's shape (go-to-k/cdkd#4214, here
                  // go-to-k/cdkd#4291): the diagnosis quotes names from the
                  // records in JSON quotes and the provider text can echo a
                  // template value, so each is on a line of its own, and this
                  // line, which names cdkd deploy --replace, shows neither.
                  `${refusalHead} requires ` +
                    `replacement, but the create-first attempt collided (why is on the ` +
                    `Collision diagnosis line below) — ` +
                    (holder.known
                      ? `so another resource holds the colliding name (an orphan of an ` +
                        `earlier attempt, or one made outside this stack), and deleting the ` +
                        `resource being replaced would destroy it and collide again.` +
                        flagClause +
                        ` Remove or rename the resource holding that name if it is yours, ` +
                        `then re-run the deploy.`
                      : `so if another resource holds the name it collided on (an orphan of an ` +
                        `earlier attempt, or one made outside this stack), deleting the ` +
                        `resource being replaced would destroy it and collide again.` +
                        flagClause +
                        ` Remove or rename whatever holds that name if it is yours — if ` +
                        `that is the resource being replaced itself, delete it by hand — ` +
                        `then re-run the deploy.`) +
                    `\nCollision diagnosis: ${holder.diagnosis}` +
                    `\nUnderlying collision: ${createCollisionLine}`,
                  updateSecrets
                ),
                'NAMED_REPLACEMENT_COLLISION',
                // Chained like the #3808 refusal above: marked, so the
                // retry classifiers never read the collision text.
                createError instanceof Error ? createError : undefined
              )
            )
          );
        }
        if (updateReplacePolicy === 'Retain') {
          // No command on this line: the id is shown as recorded.
          const retainNameOrigin = this.replacementNameOrigin(
            logicalId,
            currentResource.physicalId,
            {
              besideCommand: false,
            }
          );
          throw new CdkdError(
            `${logicalId} (${resourceType}) requires replacement, but its physical name ` +
              `is still held by the existing resource AND UpdateReplacePolicy: Retain ` +
              `pins that resource in place. ${retainNameOrigin.descriptor}. ` +
              `${retainNameOrigin.remedy} — with Retain, the old resource keeps the name, so a ` +
              `same-name replacement can never proceed.`,
            'NAMED_REPLACEMENT_COLLISION'
          );
        }
        if (this.options.replace !== true) {
          throw markOwnLines(
            new CdkdError(
              // As the two refusals above: the head and the physical id (in
              // `nameOrigin.descriptor`) are shown only when plain, the provider
              // text is on its own line, the command has no backtick wrapper,
              // and the whole is masked at construction (go-to-k/cdkd#4291).
              maskSecretsInText(
                `${refusalHead} requires replacement, but the create-first ` +
                  `attempt collided with the existing resource (the provider text is on the ` +
                  `Underlying collision line below). ` +
                  `${nameOrigin.descriptor}, so the CloudFormation-style safe replacement ` +
                  `order (create the new resource before deleting the old) cannot reuse the ` +
                  `occupied name — CloudFormation refuses this shape with "cannot update a ` +
                  `stack when a custom-named resource requires replacing". ` +
                  `${nameOrigin.remedy}, or re-run with cdkd deploy --replace to delete ` +
                  `the old resource FIRST and recreate it under the same name (the resource ` +
                  `is briefly unavailable while it is recreated).` +
                  `\nUnderlying collision: ${createCollisionLine}`,
                updateSecrets
              ),
              'NAMED_REPLACEMENT_COLLISION'
            )
          );
        }
        // --replace opt-in: the user accepts delete-first semantics
        // (the stateful guard for this property-driven replacement
        // already ran above). Delete the old holder — proven above —
        // then re-create.
        // "named" not "custom-named": the name may be cdkd's own
        // derivation, and this line PRINTS the physical id, so a user
        // reading it against a template that declares no such name was
        // being told it was theirs (issue #1636).
        this.logger.info(
          `  Create-first collided with the existing resource's name and --replace is ` +
            `set — deleting old ${logicalId} (${currentResource.physicalId}) first...`
        );
        deletedOldFirst = true;
        createResult = await this.replaceDeleteFirstAndRecreate(
          logicalId,
          resourceType,
          oldResourceType,
          currentResource,
          oldDeleteProvider,
          replaceProvider,
          replaceProps,
          updateSecrets,
          updateReplacePolicy
        );
      }

      // Issue #1238: a name-idempotent Create API (e.g. SQS
      // CreateQueue with an unchanged QueueName) does NOT collide
      // when the template carries an explicit physical name — it
      // silently returns the OLD resource's physicalId as the "new"
      // one. The "new" resource IS the old one, so the delete-old
      // step below would destroy the very resource the deploy just
      // reported as created, and state would keep pointing at a
      // deleted resource (observed live with a FIFO queue). Mirror
      // the create-first collision handling above: hard-fail under
      // Retain, fail with the rename / --replace remediation without
      // the opt-in, and fall back to delete-first + re-create under
      // --replace. Skipped when the old resource was already deleted
      // (delete-first fallback) — there, re-acquiring the same
      // physical id under the same name is the expected outcome. Skipped
      // too when `equalIdIsSameResource` is false (issue #2668): across
      // two types an equal id is two resources (custom resources
      // excepted), so the "new" one is NOT the old one and the delete-old
      // step below is aimed — through the OLD type's provider — at the
      // right one.
      if (
        equalIdIsSameResource &&
        !deletedOldFirst &&
        createResult.physicalId === currentResource.physicalId
      ) {
        if (updateReplacePolicy === 'Retain') {
          // No command on this line: the id is shown as recorded, in both
          // places it appears.
          const idempotentNameOrigin = this.replacementNameOrigin(
            logicalId,
            currentResource.physicalId,
            { besideCommand: false }
          );
          throw new CdkdError(
            `${logicalId} (${resourceType}) requires replacement, but its Create API is ` +
              `name-idempotent: the create-first attempt returned the existing resource ` +
              `(${currentResource.physicalId}) instead of creating a new one, and ` +
              `UpdateReplacePolicy: Retain pins that resource in place. ` +
              `${idempotentNameOrigin.descriptor}. ${idempotentNameOrigin.remedy} — with ` +
              `Retain, the old resource keeps the name, so a same-name replacement can ` +
              `never proceed.`,
            'NAMED_REPLACEMENT_IDEMPOTENT_CREATE'
          );
        }
        if (this.options.replace !== true) {
          // This line names `cdkd deploy --replace`: the head and both copies
          // of the physical id are shown only when plain, the command carries
          // no backtick wrapper, and the whole is masked at construction
          // (go-to-k/cdkd#4291's sibling, code review of #4342).
          const idempotentNameOrigin = this.replacementNameOrigin(
            logicalId,
            currentResource.physicalId
          );
          const returnedId =
            physicalIdShownBesideCommand(currentResource.physicalId) ??
            'a physical id that is not a plain identifier';
          throw new CdkdError(
            maskSecretsInText(
              `${logicalIdShown(logicalId)} (${resourceTypeShown(resourceType)}) requires ` +
                `replacement, but its Create API is ` +
                `name-idempotent: the create-first attempt returned the EXISTING resource ` +
                `(${returnedId}) instead of creating a new one, so deleting ` +
                `the "old" resource would silently destroy the resource the deploy just ` +
                `reported as created. ${idempotentNameOrigin.descriptor}; ` +
                `${idempotentNameOrigin.remedy}, or re-run with ` +
                `cdkd deploy --replace to delete the old resource FIRST and recreate ` +
                `it under the same name (the resource is briefly unavailable while it is ` +
                `recreated). Note: this branch is also reached when the old resource was ` +
                `deleted out-of-band and the physical id is name-derived — there the ` +
                `create was a genuine fresh create; --replace converges that case too.`,
              updateSecrets
            ),
            'NAMED_REPLACEMENT_IDEMPOTENT_CREATE'
          );
        }
        // --replace opt-in: same delete-first fallback as the
        // collision path — the "created" resource is the old one, so
        // deleting the old physical id releases the name, and the
        // re-create applies the new properties for real.
        this.logger.info(
          `  Create-first returned the existing resource (name-idempotent Create API) ` +
            `and --replace is set — deleting old ${logicalId} ` +
            `(${currentResource.physicalId}) first...`
        );
        deletedOldFirst = true;
        createResult = await this.replaceDeleteFirstAndRecreate(
          logicalId,
          resourceType,
          oldResourceType,
          currentResource,
          oldDeleteProvider,
          replaceProvider,
          replaceProps,
          updateSecrets,
          updateReplacePolicy
        );
      }

      if (deletedOldFirst) {
        // Old resource is already gone (delete-first fallback above).
      } else if (updateReplacePolicy === 'Retain') {
        // Issue #2603: same record as the `--recreate-via-*` arm above —
        // the cleanup delete is skipped, so the rollback must re-adopt
        // rather than re-create.
        this.retainedOldOnReplacement.add(logicalId);
        this.logger.info(
          `  Retaining old ${logicalId} (${currentResource.physicalId}) - UpdateReplacePolicy: Retain`
        );
      } else {
        this.logger.info(`  Deleting old ${logicalId} (${currentResource.physicalId})...`);
        // `UpdateReplacePolicy: Snapshot` (issue #1354): snapshot the
        // old resource before the post-replacement cleanup delete.
        // Two failure classes, deliberately handled differently:
        //   - a REFUSAL (`FINAL_SNAPSHOT_UNSUPPORTED` — cc-api routing
        //     or a type cdkd cannot snapshot) is a CONFIGURATION error
        //     the user must resolve, so it propagates and fails the
        //     resource, matching CloudFormation failing the update.
        //   - a transient snapshot failure / timeout degrades to this
        //     site's existing warn-and-continue policy, but SKIPS the
        //     delete: the old resource stays alive (leaked, warned)
        //     rather than being deleted without its promised snapshot.
        let cleanupFinalSnapshotId: string | undefined;
        let snapshotBlockedDelete = false;
        try {
          cleanupFinalSnapshotId = await this.prepareFinalSnapshotForDelete(
            logicalId,
            oldResourceType,
            currentResource,
            updateReplacePolicy
          );
        } catch (snapshotError) {
          if (
            snapshotError instanceof CdkdError &&
            snapshotError.code === 'FINAL_SNAPSHOT_UNSUPPORTED'
          ) {
            throw snapshotError;
          }
          snapshotBlockedDelete = true;
          this.logger.warn(
            `  ⚠ Final snapshot for old ${logicalId} (${currentResource.physicalId}) ` +
              `failed: ${snapshotError instanceof Error ? snapshotError.message : String(snapshotError)}. ` +
              `The old resource was NOT deleted (UpdateReplacePolicy: Snapshot) — delete it ` +
              `manually once you have a snapshot; it is no longer tracked in state.`
          );
        }
        if (!snapshotBlockedDelete) {
          await this.deleteReplacedAfterCreate(
            logicalId,
            oldResourceType,
            currentResource,
            oldDeleteProvider,
            currentResource.properties,
            cleanupFinalSnapshotId,
            updateReplacePolicy,
            updateSecrets
          );
        }
      }
    }

    // Issue #2274: the replacement path re-CREATES, so the fresh create
    // result carries its own `NoEcho` declaration and must register it —
    // the create arm's registration is in a different `case` and does not
    // run here.
    this.registerNoEchoAttributes(logicalId, createResult, updateSecrets, resolvedProps);

    stateResources[logicalId] = {
      physicalId: createResult.physicalId,
      resourceType,
      properties: this.propertiesToRecord(
        resolvedProps,
        createResult,
        resourceType,
        replaceDecision.provisionedBy
      ),
      ...(createResult.attributes && { attributes: createResult.attributes }),
      ...(dependencies && dependencies.length > 0 && { dependencies }),
      ...this.extractTemplateAttributes(template, logicalId),
      provisionedBy: replaceDecision.provisionedBy,
    };
    this.recordInlinePolicyWrite(logicalId, 'create');

    this.kickOffObservedCapture(
      replaceProvider,
      logicalId,
      createResult.physicalId,
      resourceType,
      resolvedProps,
      { afterOwnWrite: true }
    );

    if (counts) counts.updated++;
    if (progress) progress.current++;
    const replacePrefix = progress ? `[${progress.current}/${progress.total}] ` : '  ';
    renderer.removeTask(logicalId);
    this.logger.info(
      `${replacePrefix}${yellow('↻')} ${bold(logicalId)} ${gray(`(${resourceType})`)} ${yellow('replaced')}`
    );
  } else {
    // Normal update (in-place).
    //
    // For an existing resource, the layer is sticky: if it was first
    // created via Cloud Control (because of silent-drop properties at
    // CREATE time), the update stays on Cloud Control. If it was
    // SDK-managed and the user has since added a silent-drop property,
    // we re-evaluate via `getProviderFor` — which will auto-route
    // through Cloud Control as long as the user hasn't overridden
    // via `--allow-unsupported-properties`. Once a resource flips
    // to CC mid-life, it stays there (the state record's
    // `provisionedBy: 'cc-api'` written below sticks).
    this.logger.debug(`Updating ${logicalId} (${resourceType})`);
    const updateDecision = this.providerRegistry.getProviderFor({
      resourceType,
      properties: resolvedProps,
      provisionedBy: currentResource.provisionedBy,
      // Issue #2719: the RECORD's bag, not the diff's current side. It is
      // the resolved desired bag of the last successful deploy, so a
      // property applied under Cloud Control and since deleted from the
      // template is still visible here -- which is the one case a
      // desired-only flip condition gets wrong (see
      // `GetProviderForInput.previousProperties`).
      previousProperties: currentResource.properties,
      ...(this.isPinnedToCcApi(stackName, logicalId) && { forceCcApi: true }),
    });
    if (updateDecision.sdkMigration === true) {
      // The ONLY reader of `sdkMigration`, and the reason the field
      // exists: without it this deploy moves a live resource between
      // provisioning layers and says so only at debug level. It fires
      // once, because the record says 'sdk' from this write on.
      //
      // The wording is per MODE, because the two flips happen for
      // opposite reasons and only one of them can be declined. A first
      // revision printed the coverage sentence for both and told a
      // 'cc-broken' user to pass `--pin-cc-api`, which that mode
      // deliberately ignores -- recommending a flag that silently no-ops
      // is the same class of defect as the typo this lane just closed.
      // Exhaustive rather than a ternary: a THIRD mode added later would
      // otherwise inherit the coverage wording AND a `--pin-cc-api`
      // suggestion, which is precisely the wrong-remedy defect this
      // per-mode split exists to fix. `exemptMode` cannot be undefined
      // here — `sdkMigration` is set only after `wouldReturnToSdkProvider`
      // found an entry in this same table — but the default arm keeps
      // that from being load-bearing.
      const exemptMode = STICKY_CC_MIGRATION_EXEMPT.get(resourceType)?.mode;
      const preserved = 'The physical id is preserved';
      let message: string;
      switch (exemptMode) {
        case 'cc-broken':
          message =
            `${logicalId} (${resourceType}): moving to the SDK provider — Cloud ` +
            `Control cannot manage this type correctly. ${preserved}, and this ` +
            `routing is not optional.`;
          break;
        case 'sdk-coverage':
          message =
            `${logicalId} (${resourceType}): returning to the SDK provider — cdkd now ` +
            `covers every property this resource uses. ${preserved}; pass ` +
            `--pin-cc-api ${logicalId} to decline this for a deploy.`;
          break;
        default:
          message = `${logicalId} (${resourceType}): moving to the SDK provider. ${preserved}.`;
      }
      this.logger.info(message);
    }
    const updateProvider = updateDecision.provider;
    const updateProps =
      updateDecision.provisionedBy === 'cc-api'
        ? withoutGeneratedFallbackName(
            resourceType,
            resolvedProps,
            this.preparePropertiesForCcApi(resourceType, resolvedProps, logicalId)
          )
        : resolvedProps;
    // The previous side the provider diffs against, with each create-only
    // path AWS confirmed holding its fresh `NoEcho` value set to the
    // value being sent (go-to-k/cdkd#3729). The record holds `***` there,
    // and a provider comparing `***` with the plaintext would see a
    // create-only change: ACM and IAM ManagedPolicy re-create inside
    // their own `update()` (bypassing `UpdateReplacePolicy: Retain` and
    // the stateful guard), and Cloud Control would patch a create-only
    // path. In memory only: nothing persists this bag, and the provider's
    // masker already holds the value as a needle.
    //
    // And for a type whose provider has no live source for a recorded
    // principal list (IAM::Policy, UserToGroupAddition), an entry state
    // holds as a secret reference the template still spells the same
    // way is dropped from the previous side (go-to-k/cdkd#4064): the
    // record's `{{resolve:...}}` is not a name, so every in-place update
    // was refused, and the desired side names that principal too.
    const { previous: previousForUpdate, dropped: droppedPrincipalKinds } =
      withUnchangedSecretPrincipalLists(
        resourceType,
        currentResource.physicalId,
        noEchoHeldPaths.size === 0
          ? currentPropsAsWritten
          : {
              ...currentPropsAsWritten,
              ...Object.fromEntries(
                [...noEchoHeldPaths]
                  .filter((path) => Object.prototype.hasOwnProperty.call(updateProps, path))
                  .map((path) => [path, updateProps[path]])
              ),
            },
        desiredForSkipCheckAsWritten
      );
    if (droppedPrincipalKinds.length > 0) {
      // Kinds only, never names. A secret whose value changed since the
      // last deploy under the same reference is not visible here: the
      // record keeps only the reference.
      const kinds = droppedPrincipalKinds.join(' / ');
      this.logger.warn(
        safeMsg`${logicalId} (${resourceType}): the recorded ${kinds} holds a secret reference the template still spells the same way, so cdkd re-applies it to the principals this deploy resolved it to and removes it from none of them. If that secret's value changed since the last deploy, a principal only the OLD value named still has the policy or membership: remove it from that principal by hand.`
      );
    }

    let result;
    let resultProvisionedBy = updateDecision.provisionedBy;
    // The provider the observed-properties capture below reads the
    // resource back through (issue #2616's neighbour, issue #2608). It
    // moves in LOCKSTEP with `resultProvisionedBy`: both are reassigned
    // together on the update-failure replacement fallback, from the SAME
    // routing decision, so the layer the capture reads and the layer the
    // state record is stamped with cannot disagree by construction.
    //
    // Before this it was hard-wired to `updateProvider` at the call site
    // — the provider that just FAILED the update — so a replacement that
    // re-routed read the NEW physical resource through the OLD layer
    // while state named the new one. The capture then either returned
    // nothing (a provider asked to read a type it does not handle) or a
    // differently-shaped bag than the record's layer implies, and
    // `observedProperties` is what `cdkd drift` and the next deploy's
    // diff compare against — the phantom-drift class of issue #1591.
    //
    // Bound from the decision rather than re-derived with
    // `getProviderFor({ resourceType, provisionedBy: resultProvisionedBy })`:
    // that re-read is NOT an identity for every type. A
    // `STICKY_CC_MIGRATION_EXEMPT` type asked for
    // `provisionedBy: 'cc-api'` can deliberately fall through to its SDK
    // provider. That is the `'cc-broken'` case (`AWS::Scheduler::Schedule`),
    // whose escape is unconditional, so the re-read would reintroduce
    // exactly the mismatch it was meant to close.
    //
    // NOT the `'sdk-coverage'` case, despite the symmetry: this re-read
    // passes NO property bags, and that mode's flip requires both of
    // them, so it would refuse. An earlier revision of this comment said
    // the opposite and contradicted its own sibling at the
    // observed-capture site, which relies on that same no-bags refusal. The property-driven replacement
    // twin above passes `replaceProvider` for the same reason.
    let captureProvider = updateProvider;
    const inlinePolicyClaimed = this.inlinePolicyClaimedFor(
      resourceType,
      logicalId,
      stateResources
    );
    try {
      result = await this.withRetry(
        () =>
          // The UPDATE twin of the CREATE call's async-local scope (issue
          // #1903). Both paths bind it or a nested stack that already
          // exists silently keeps persisting the parent's plaintext.
          withCurrentResourceSecrets(updateSecrets, () =>
            updateProvider.update(
              logicalId,
              currentResource.physicalId,
              resourceType,
              updateProps,
              // `currentPropsAsWritten` (issue #2750): the ONE consumer
              // of the previous side that is asking what AWS holds.
              // `CloudControlProvider.update` diffs this into a JSON
              // Patch, so a key the SDK route never wrote must be absent
              // here or the patch omits it and the auto-route sends
              // nothing for it. `previousForUpdate` differs from it only
              // at confirmed NoEcho paths (go-to-k/cdkd#3729), and at an
              // IAM::Policy / UserToGroupAddition principal list whose
              // unchanged secret reference was dropped (go-to-k/cdkd#4064).
              previousForUpdate,
              // The UPDATE twin of the CREATE call's masker (issue #1932
              // item 3): same resolved bag, same exposure, so the contract
              // is applied on both or it has a hole in the shape of
              // whichever path a given deploy takes.
              //
              // `expectedRegion` (issue #2301 item 1) is the same value
              // this file already hands every `DeleteContext` it builds:
              // the region this stack's state was read under and is
              // written back to. The update is addressed BY
              // `currentResource.physicalId`, a state-recorded id, so it
              // carries the same wrong-region hazard the delete sites do
              // -- misapplied configuration rather than destruction, but
              // on a resource cdkd does not manage. Typed `string`, so a
              // caller with no region hands over `''`; the guard treats
              // that as absent and proceeds.
              //
              // `recordedAttributes` (issue #4051): the identity evidence
              // of the record `currentResource.physicalId` came from.
              {
                maskSecrets: createSecretMasker(updateSecrets),
                expectedRegion: this.stackRegion,
                recordedAttributes: currentResource.attributes,
                ...(inlinePolicyClaimed && { inlinePolicyClaimed }),
              }
            )
          ),
        logicalId,
        undefined,
        undefined,
        updateProvider
      );
    } catch (updateError) {
      // If UPDATE is not supported, fall back to a replacement. Two
      // triggers:
      //   1. CC API `UnsupportedActionException` — auto-fallback, needs
      //      no flag to REACH the replacement (issue #2514 left that
      //      half unchanged; only the stateful guard below became common
      //      to both triggers).
      //   2. An SDK provider throwing a typed
      //      `ResourceUpdateNotSupportedError` (an immutable property
      //      changed on a type with no replacement rule) — gated on the
      //      user opting in via `--replace`, because for some of these
      //      types the replacement is a data-losing DELETE + CREATE.
      //
      // Trigger 1 is classified STRUCTURALLY since issue #2520:
      // `isUpdateUnsupportedError` walks the bounded cause chain for the
      // exception NAME (and the async `ccErrorCode`), because the
      // provider's wrapper never copies the name into its message — the
      // predicate's old `includes('UnsupportedActionException')` half
      // therefore matched nothing cdkd produces. AWS's prose is not read
      // at all (issue #3810): a message can quote template-chosen text.
      //
      // `logicalId` is passed because a chain walk is otherwise WIDER
      // than the message read it replaces: a nested stack's child deploy
      // runs inside THIS `provider.update()` call, so a child resource's
      // Cloud Control rejection is reachable down the parent's cause
      // chain — and reading it here would DELETE + CREATE the whole
      // child stack. The classifier's doc comment carries that, the
      // measured wire shape, and the codes it deliberately refuses.
      const ccUnsupported = isUpdateUnsupportedError(updateError, logicalId);
      const typedUnsupported = updateError instanceof ResourceUpdateNotSupportedError;
      const replaceOptIn = typedUnsupported && this.options.replace === true;
      if (ccUnsupported || replaceOptIn) {
        // `UpdateReplacePolicy: Retain` on the fallback replacement
        // (issue #2518). Until this landed, the fallback deleted the old
        // resource whatever the policy said, while every OTHER
        // replacement path in this engine honoured `Retain`: the
        // property-driven cleanup below logs "Retaining old ...", the
        // `--recreate-via-*` path warns and leaks it, and both
        // delete-first fallbacks refuse the replacement outright. The
        // same template attribute therefore decided retention on one
        // path and nothing on the other, so a resource the user
        // explicitly marked to survive its replacement was destroyed —
        // and for a stateful type, its data with it.
        //
        // Two things made honouring it the right arm rather than
        // refusing the replacement outright:
        //   - It is what the SIBLING path already does. A refusal here
        //     would have swapped one internal divergence (retain there,
        //     delete here) for another (retain there, refuse here), and
        //     CloudFormation itself retains on replacement.
        //   - `rollback-executor.ts`'s replacement rollback ALREADY
        //     assumes it: an op classified `reverse-replacement-readopt`
        //     deletes the new resource and points state back at the old
        //     physical id WITHOUT re-creating it. With the old resource
        //     deleted, that rollback re-adopted a dead id. (That verdict
        //     was read off `previousState.updateReplacePolicy` until
        //     issue #2603 moved it onto the record this path now writes
        //     — see `retainedOldOnReplacement`, set on the arm below.)
        //
        // So under `Retain` this path becomes create-ONLY: the old
        // resource is left in place (orphaned, exactly as the
        // property-driven path leaves it) and only the replacement
        // create runs. `Retain` and `Snapshot` are alternative values of
        // one attribute, so nothing is skipped by not preparing a final
        // snapshot on this arm.
        //
        // The order flip is safe in the same direction as the
        // property-driven path's: creating first keeps the old resource
        // alive if the create fails. What it CANNOT do is reuse a
        // physical name the retained resource still holds, so both
        // shapes that follow from that are refused LOUDLY below with the
        // same error codes the property-driven path already uses.
        //
        // TEMPLATE ONLY, via the shared `updateReplacePolicy` binding —
        // the same read the property-driven guard's exemption uses, so
        // the two ask "what is the user applying NOW?" of one value.
        // Only `'Retain'` is honoured: `RetainExceptOnCreate` is a
        // `DeletionPolicy` value CloudFormation rejects for
        // `UpdateReplacePolicy`, so it cannot reach here.
        const retainOldOnReplace = updateReplacePolicy === 'Retain';
        // Stateful guard for BOTH triggers (issue #2514). A stateful
        // type (RDS / DynamoDB / EFS / etc.) must not be silently
        // DELETE+CREATEd — require --force-stateful-recreation.
        //
        // It used to sit inside `if (replaceOptIn)`, so the CC
        // auto-fallback recreated a stateful resource on a plain
        // `cdkd deploy` with neither `--replace` nor
        // `--force-stateful-recreation`, while the SAME type behind an
        // SDK provider was refused twice over. The discriminator was
        // neither the resource nor the user's intent but which
        // provisioning layer the type happened to route through — and
        // routing is re-decided every deploy (`provisionedBy` is
        // recorded, not pinned), so the guard's presence was not
        // something a user could reason about. The delete below is
        // identical on both triggers, so the data-loss consent belongs
        // to the REPLACEMENT, not to the trigger.
        //
        // Conservative variant: this fires mid-deploy with no chance to
        // run either async emptiness probe, so a deferred S3 bucket — and
        // likewise a log group with no recorded retention, CloudWatch
        // Logs' never-expire (issue #2558) — is treated as stateful
        // (block unless forced).
        //
        // `UpdateReplacePolicy: Retain` IS an exemption here since issue
        // #2518, exactly as it is on the property-driven replacement
        // guard above and for the same reason: the old resource and its
        // data survive the replacement (orphaned, not deleted), so there
        // is no data loss for `--force-stateful-recreation` to confirm.
        // Demanding the consent flag for a replacement that destroys
        // nothing would be a refusal whose only remedy is a flag that
        // means "yes, lose the data" — advice that was actively wrong
        // for the one user who had already asked to keep it.
        //
        // `Snapshot` stays NON-exempt on both paths: cdkd does take the
        // final snapshot, but a snapshot is a point-in-time copy, not a
        // surviving resource.
        const statefulReason = retainOldOnReplace
          ? null
          : isStatefulRecreateTargetForReplace(
              resourceType,
              currentProps,
              // The observed bag, for the same reason the property-driven
              // guard above passes it (issue [#2521]).
              currentResource.observedProperties
            );
        if (statefulReason && this.options.forceStatefulRecreation !== true) {
          // No `Retain` note here any more (issue #2518): reaching this
          // throw MEANS the template is not applying `Retain`, because
          // `retainOldOnReplace` short-circuits `statefulReason` to
          // `null` above. The note this replaced said "Retain does NOT
          // protect this path", which is now false — and it was advice
          // whose remedy (`--force-stateful-recreation`) deleted the very
          // resource the user had asked to keep.
          //
          // The `Retain` read stays TEMPLATE ONLY — deliberately no
          // `?? currentResource.updateReplacePolicy` fallback, which is
          // where the snapshot attribute a few lines below DOES fall
          // back to state. The two decisions are not the same shape:
          // omitting a promised snapshot is destructive, so that read is
          // conservative, while this one describes the attribute the user
          // is applying NOW. Falling back to state would retain a
          // resource on the strength of a policy the template being
          // applied has since dropped.
          //
          // Hence the shared `updateReplacePolicy` binding, read once in
          // this UPDATE branch's own scope: it IS the template-only read,
          // so the property-driven guard's exemption and this path's ask
          // the same question of the same value, and a future change to
          // one cannot leave the other on an older spelling. The snapshot
          // read below is the deliberate exception and stays spelled out
          // with its state fallback.
          //
          // `markNonRetryable` for the same reason as the property-driven
          // guard's twin above: a flag plus a state-recorded bag decide
          // it, and the message carries a template-controlled logical id
          // into substring-matching classifiers.
          throw markNonRetryable(
            new CdkdError(
              replaceOptIn
                ? `--replace would DELETE + CREATE the stateful resource ${logicalId} ` +
                    `(${resourceType}) — ${renderStatefulReason(statefulReason)}. Re-run with ` +
                    `--force-stateful-recreation to confirm the data loss, or change the ` +
                    `resource definition to avoid the immutable-property change.`
                : `${logicalId} (${resourceType}) cannot be updated in place by the ` +
                    `provisioning layer it routes through, so applying this change would ` +
                    `DELETE + CREATE it — but it is a stateful resource: ` +
                    `${renderStatefulReason(statefulReason)}. Re-run with ` +
                    `--force-stateful-recreation to confirm the data loss, or change the ` +
                    `resource definition to avoid the update.`,
              'STATEFUL_REPLACE_BLOCKED',
              // Chain the rejection that routed us here: the message
              // above names no layer and no AWS text, so this is the
              // only place that rejection is retained.
              //
              // Where it actually SURFACES is narrower than the terminal
              // output: `formatError` (`src/utils/error-handler.ts`)
              // renders exactly ONE `Caused by:` level, and the error the
              // CLI prints is the `ProvisioningError` this method's catch
              // wraps the refusal in — so that one level is the refusal's
              // own message and the raw Cloud Control text stays a hop
              // below it, unprinted. It DOES reach the persisted
              // `RESOURCE_FAILED` event: `extractDeploymentEventError`
              // walks the whole chain for `awsErrorCode` / `requestId`,
              // so `cdkd events` can name the AWS rejection behind the
              // refusal (pinned in `tests/unit/types/deployment-events.test.ts`).
              //
              // Safe to chain now that the refusal is marked:
              // `isMarkedNonRetryable` is consulted before any chain-text
              // classification, and `ccUnsupported` reads only the
              // exception NAME and `ccErrorCode` down the chain, never a
              // message (issue #3810).
              updateError instanceof Error ? updateError : undefined
            )
          );
        }
        // The replacement create gets a fresh routing decision, against
        // the record as its unrecognized-property baseline (issue #3713,
        // same reason as `replaceDecision`). Taken before anything is
        // deleted, since the name check below needs its route.
        const replDecision = this.providerRegistry.getProviderFor({
          resourceType,
          properties: resolvedProps,
          previousProperties: currentResource.properties,
        });
        const replProvider = replDecision.provider;
        const replProps =
          replDecision.provisionedBy === 'cc-api'
            ? this.preparePropertiesForCcApi(resourceType, resolvedProps, logicalId)
            : resolvedProps;
        // go-to-k/cdkd#3937 / #3931, as on the property-driven path: a
        // name known to move off the old resource's, probed where the
        // create would adopt a taken one. Under Retain it only probes.
        const fallbackNameChange = await this.checkedReplacementNameChange({
          logicalId,
          resourceType,
          oldResourceType: resourceType,
          stackName,
          currentResource,
          desiredProperties: resolvedProps,
          createProvider: replProvider,
          createdVia: replDecision.provisionedBy,
          createProps: replProps,
          secrets: updateSecrets,
        });
        const createFirst = !retainOldOnReplace && fallbackNameChange !== undefined;
        this.logger.info(
          retainOldOnReplace
            ? `UPDATE not supported for ${logicalId} (${resourceType}), replacing ` +
                `(CREATE only — UpdateReplacePolicy: Retain keeps the old resource)`
            : createFirst
              ? safeMsg`UPDATE not supported for ${logicalId} (${resourceType}), replacing (CREATE → DELETE — the new name differs from the old resource's)`
              : `UPDATE not supported for ${logicalId} (${resourceType}), replacing (DELETE → CREATE)`
        );
        if (!retainOldOnReplace && !createFirst) {
          // `UpdateReplacePolicy: Snapshot` (issue #1354): snapshot the
          // old resource before the fallback replacement's delete. The
          // TEMPLATE is authoritative here — unlike a destroy, an update
          // necessarily has the resource in the template, and the
          // attribute being applied is the desired one (state records
          // only what the LAST deploy used, so a template that just
          // gained `Snapshot` must not be overridden by a stale
          // `Delete`). State is the fallback for a template that omits
          // the attribute, and this is the ONLY snapshot read on the
          // replacement paths that has one: every other site above passes
          // the shared `updateReplacePolicy` binding, which is template-only.
          // The divergence is deliberate — omitting a promised snapshot is
          // destructive, so this read is conservative, while the `Retain`
          // decision above only describes what the user is applying now.
          //
          // Unreachable under `Retain` (issue #2518) and not merely
          // skipped: `UpdateReplacePolicy` is ONE attribute, so a
          // template applying `Retain` is not applying `Snapshot`, and
          // the state fallback cannot reintroduce it — `??` only fires
          // when the template omits the attribute entirely, which is
          // exactly when `retainOldOnReplace` is false.
          const fallbackUpdateReplacePolicy =
            template?.Resources?.[logicalId]?.UpdateReplacePolicy ??
            currentResource.updateReplacePolicy;
          const fallbackFinalSnapshotId = await this.prepareFinalSnapshotForDelete(
            logicalId,
            resourceType,
            currentResource,
            fallbackUpdateReplacePolicy
          );
          // Initialized because the catch below can leave it unassigned.
          let fallbackDeleteResult: void | ResourceDeleteResult = undefined;
          try {
            fallbackDeleteResult = await updateProvider.delete(
              logicalId,
              currentResource.physicalId,
              resourceType,
              currentProps,
              {
                expectedRegion: this.stackRegion,
                forceDataDelete: this.options.forceStatefulRecreation === true,
                ...(fallbackFinalSnapshotId !== undefined && {
                  finalSnapshotIdentifier: fallbackFinalSnapshotId,
                }),
                ...this.replacementDeleteContext(fallbackUpdateReplacePolicy),
                recordedAttributes: currentResource.attributes,
              }
            );
          } catch (deleteError) {
            // If old resource doesn't exist (already deleted), proceed with CREATE
            const deleteMsg =
              deleteError instanceof Error ? deleteError.message : String(deleteError);
            // Typed check FIRST, and this arm is the worst of the four
            // already-deleted classifiers to get wrong (issue
            // go-to-k/cdkd#3236): reading "already gone" here does not
            // merely drop a state row, it proceeds to CREATE the
            // replacement BESIDE an old resource whose delete may still
            // be running. A `CloudControlWaitAbandonedError` says
            // exactly that — cdkd stopped watching an operation still in
            // flight — and its message interpolates the LOGICAL ID, so a
            // construct named `PageNotFound` satisfies the bare
            // `NotFound` needle below. The substring match cannot be
            // made safe; any needle can appear in a user-chosen name.
            //
            // This arm carried NO typed guard at all, unlike its two
            // siblings — so `isInterruptedWaitError` and
            // `isMarkedNonRetryable` join it here for the same reasons
            // those siblings state.
            if (
              !isWaitAbandonedError(deleteError) &&
              !isInterruptedWaitError(deleteError) &&
              !isMarkedNonRetryable(deleteError) &&
              (deleteMsg.includes('does not exist') ||
                deleteMsg.includes('not found') ||
                deleteMsg.includes('NotFound'))
            ) {
              this.logger.debug(`Old resource ${logicalId} already gone, proceeding with CREATE`);
            } else {
              throw deleteError;
            }
          }
          // Issue #1762: a skip fails the resource here too — the CREATE
          // below re-provisions the resource, so proceeding would leave
          // the old one alive and untracked. Deliberately OUTSIDE the
          // catch: the classifier above reads "already gone" out of an
          // error MESSAGE, and a skip must never be read that way.
          const fallbackSkipReason = deleteSkipReason(fallbackDeleteResult);
          if (fallbackSkipReason !== undefined) {
            throw new Error(
              deleteSkippedMessage(
                logicalId,
                currentResource.physicalId,
                fallbackSkipReason,
                'during the UPDATE-not-supported replacement'
              )
            );
          }
        }
        // Set only on the retain arm; drives the `partial` outcome below.
        let retainedSurvivorReason: string | undefined;
        let createResult: ResourceCreateResult;
        try {
          createResult =
            createFirst && fallbackNameChange !== undefined
              ? await this.createFirstThenDeleteOld({
                  logicalId,
                  resourceType,
                  oldResourceType: resourceType,
                  currentResource,
                  createProvider: replProvider,
                  createProps: replProps,
                  deleteProvider: updateProvider,
                  deleteProperties: currentProps,
                  secrets: updateSecrets,
                  change: fallbackNameChange,
                  equalIdIsSameResource: !equalIdNamesDifferentResources({
                    resourceType,
                    physicalId: currentResource.physicalId,
                    oldProperties: currentResource.properties,
                    newProperties: resolvedProps,
                  }),
                  // The same state fallback as the DELETE → CREATE arm's
                  // snapshot read, for the same reason.
                  snapshotPolicy:
                    template?.Resources?.[logicalId]?.UpdateReplacePolicy ??
                    currentResource.updateReplacePolicy,
                  deletePolicy:
                    template?.Resources?.[logicalId]?.UpdateReplacePolicy ??
                    currentResource.updateReplacePolicy,
                  trigger: 'the provisioning layer cannot update it in place',
                })
              : await this.withRetry(
                  () =>
                    withCurrentResourceSecrets(updateSecrets, () =>
                      replProvider.create(logicalId, resourceType, replProps, {
                        maskSecrets: createSecretMasker(updateSecrets),
                      })
                    ),
                  logicalId,
                  undefined,
                  undefined,
                  replProvider
                );
        } catch (createError) {
          // The create-first arm's errors are already its own, and the
          // old resource is untouched there.
          if (createFirst) throw createError;
          // Only `Retain` turned this into a create-FIRST path, so only
          // `Retain` owes the name-collision translation (issue #2518).
          // Without it the user reads a raw `AlreadyExists` and has no
          // way to connect it to the policy that caused it.
          if (!retainOldOnReplace) {
            // ...but the NON-Retain arm owes the other half (issue
            // #2616): it is the DELETE → CREATE order, so by the time
            // this runs the old resource is GONE. Two sub-paths reach
            // here and the wording covers both: the delete above
            // succeeded, OR it rejected with a not-found the block's
            // classifier read as "already gone" — where something ELSE
            // removed the resource. So the sentence names NO actor: it
            // states only that the resource is gone, which is true on
            // both sub-paths and is the fact the user needs. Two review
            // rounds landed here — "already deleted the old resource"
            // and then "replacement removed the old resource" both keep
            // the replacement as the subject of the removal, which the
            // second sub-path falsifies. Handing back the
            // provider's raw create error leaves the user unable to tell
            // "the replacement never started" from "the replacement
            // destroyed the old resource and then failed" — which is
            // exactly what decides whether a re-run is safe and whether
            // anything downstream is now dangling. `--replace`'s
            // delete-first fallback ({@link replaceDeleteFirstAndRecreate})
            // wraps the identical situation, so this is the same
            // contract, not a new one -- but NOT the same sentence, and
            // the difference is deliberate: that sibling still says
            // "already deleted the old resource", which is correct
            // THERE because its delete catch rethrows unconditionally,
            // so the only way past it is a delete that succeeded. This
            // arm has an "already gone" classifier, so it cannot name an
            // actor (see below).
            //
            // Issue #2038: masked at construction, for the same reason as
            // that sibling — the create was handed the RESOLVED
            // `replProps`, so the AWS message this echoes can carry a
            // substituted secret.
            //
            // CHAINED, unlike that sibling: the arm this replaces
            // rethrew `createError` itself, so its `$metadata` /
            // `Code` reached `extractDeploymentEventError` and the
            // persisted `RESOURCE_FAILED` event named the AWS rejection.
            // Wrapping without a `cause` would have silently traded that
            // for the sentence. Safe to chain here: nothing between this
            // throw and the DAG executor re-classifies it — the retry
            // lives INSIDE `this.withRetry` above, which has already
            // given up — so no substring classifier reads the cause's
            // text (contrast the `Retain` arm below, which needs
            // `markNonRetryable` because its refusal quotes name-cooldown
            // spellings the retry loop WOULD act on).
            //
            // Chained UNMASKED, unlike the rollback executor's twin which
            // wraps its cause in `maskSecretsInError` -- a deliberate
            // asymmetry, recorded because three separate review passes
            // raised it. This throw is inside `provisionUpdate`;
            // further up, `provisionResource`'s catch re-wraps it with
            // `maskSecretsInError` over the cause CHAIN, so every link
            // the walk reaches is masked before anything leaves that
            // method (bounded — see `maskSecretsInError`'s own contract
            // for the depth cap and its non-`Error` carve-out; this
            // chain is 3 deep). The rollback executor has no such
            // boundary — `replaySingle`'s catch masks TEXT and swallows —
            // which is why its sites mask per site. The MESSAGE is still
            // masked at construction here, which is what issue #2616
            // requires.
            throw new Error(
              maskSecretsInText(
                `Failed to create ${logicalId} after the UPDATE-not-supported ` +
                  `replacement: the old resource (${currentResource.physicalId}) ` +
                  `is now gone. Cause: ` +
                  `${createError instanceof Error ? createError.message : String(createError)}. ` +
                  `Re-run the deploy to create it fresh.`,
                updateSecrets
              ),
              { cause: createError instanceof Error ? createError : undefined }
            );
          }
          // Same HEURISTIC, and the same bounded blast radius, as
          // the property-driven create-first path's: a false positive
          // only rewrites the error text — nothing destructive follows
          // either branch here, because this arm never deletes.
          if (!isNameCollisionErrorFrom(createError, logicalId)) throw createError;
          // Issue #3808, as on the property-driven path: when the
          // template's explicit name is not the one the retained resource
          // holds, "remove Retain so cdkd deletes the old resource first"
          // would destroy it and still collide.
          const nameHeldElsewhere = replacementRequestsDifferentName({
            oldResourceType: resourceType,
            newResourceType: resourceType,
            desiredProperties: resolvedProps,
            recorded: currentResource.properties,
            observed: currentResource.observedProperties,
            physicalId: currentResource.physicalId,
          });
          if (nameHeldElsewhere !== undefined) {
            throw markNonRetryable(
              new CdkdError(
                `${logicalId} (${resourceType}) requires replacement because the ` +
                  `provisioning layer cannot update it in place, but the create collided. ` +
                  `${renderNameHeldElsewhere(nameHeldElsewhere)} — so removing ` +
                  `UpdateReplacePolicy: Retain would delete this resource and still ` +
                  `collide. Choose a name no other resource holds, or delete the resource ` +
                  `holding it if it is yours.`,
                'NAMED_REPLACEMENT_COLLISION',
                createError instanceof Error ? createError : undefined
              )
            );
          }
          // No command on this line: the id is shown as recorded.
          const nameOrigin = this.replacementNameOrigin(logicalId, currentResource.physicalId, {
            besideCommand: false,
          });
          // Verbatim the property-driven twin's verdict and code: with
          // Retain the old resource keeps the name, so a same-name
          // replacement can never proceed — under ANY flag, since the
          // only escape hatches (`--replace`, `--force-stateful-
          // recreation`) both work by deleting the resource Retain
          // pins in place.
          //
          // `markNonRetryable` for the same reason as the stateful
          // guard's refusal above: a template attribute and a physical
          // name decide it, neither of which a retry can change, and the
          // message interpolates a template-controlled logical id — plus
          // the name-collision text of its own `cause` — into exactly
          // what the SUBSTRING-matching retry classifiers read. Chaining
          // the create rejection is what makes the refusal diagnosable
          // (`extractDeploymentEventError` walks the chain for
          // `awsErrorCode`), and it is safe only BECAUSE of the marker:
          // `isNameCooldownError`'s spellings are retryable, so an
          // unmarked refusal carrying one would burn the full 64s
          // schedule on a path that cannot succeed.
          throw markNonRetryable(
            new CdkdError(
              `${logicalId} (${resourceType}) requires replacement because the ` +
                `provisioning layer cannot update it in place — but its physical name ` +
                `is still held by the existing resource AND ` +
                `UpdateReplacePolicy: Retain pins that resource in place. ` +
                `${nameOrigin.descriptor}. ${nameOrigin.remedy} — with Retain, the old ` +
                `resource keeps the name, so a same-name replacement can never proceed. ` +
                `Removing UpdateReplacePolicy: Retain lets cdkd delete the old resource ` +
                `first, which destroys it and any data it holds.`,
              'NAMED_REPLACEMENT_COLLISION',
              createError instanceof Error ? createError : undefined
            )
          );
        }
        if (retainOldOnReplace) {
          // Issue #1238's shape, on this path: a name-idempotent Create
          // API (e.g. SQS `CreateQueue` with an unchanged `QueueName`)
          // returns the EXISTING resource instead of colliding. With the
          // old resource retained, recording that id as the "new" one
          // would re-adopt the very resource Retain just orphaned —
          // without the new properties ever being applied — so fail
          // before any state bookkeeping runs. The property-driven twin
          // makes the same call with the same code.
          if (
            createResult.physicalId === currentResource.physicalId &&
            // Issue #3892: an equal id can still be a NEW table (Glue).
            !equalIdNamesDifferentResources({
              resourceType,
              physicalId: currentResource.physicalId,
              oldProperties: currentResource.properties,
              newProperties: resolvedProps,
            })
          ) {
            // No command on this line: the id is shown as recorded.
            const idempotentNameOrigin = this.replacementNameOrigin(
              logicalId,
              currentResource.physicalId,
              { besideCommand: false }
            );
            // Marked for the same reason as its collision sibling: the
            // verdict is two recorded physical ids plus a template
            // attribute, and the message carries template-controlled
            // text into the substring classifiers. Nothing to chain —
            // the create SUCCEEDED; the failure is what it returned.
            throw markNonRetryable(
              new CdkdError(
                `${logicalId} (${resourceType}) requires replacement, but its Create ` +
                  `API is name-idempotent: the create returned the existing resource ` +
                  `(${currentResource.physicalId}) instead of creating a new one, and ` +
                  `UpdateReplacePolicy: Retain pins that resource in place, so the new ` +
                  `properties were not applied. ${idempotentNameOrigin.descriptor}. ` +
                  `${idempotentNameOrigin.remedy} — with Retain, the old resource keeps ` +
                  `the name, so a same-name replacement can never proceed.`,
                'NAMED_REPLACEMENT_IDEMPOTENT_CREATE'
              )
            );
          }
          // Issue #2603: the third and last engine path that leaves the
          // old physical resource alive on a replacement. Recorded AFTER
          // the idempotent-create refusal above, which throws — a
          // resource that fails never reaches `completedOperations`, so
          // the placement is belt-and-braces rather than load-bearing.
          this.retainedOldOnReplacement.add(logicalId);
          // WARN, not info, and louder than the line the property-driven
          // cleanup prints. The two arms leak identically, but they are
          // reached on completely different terms: the property-driven
          // one requires the user to have changed an immutable property,
          // which `cdkd diff` shows them beforehand, while THIS arm
          // fires on `ccUnsupported` ALONE — no flag, no diff signal,
          // nothing the user did on purpose. A plain `cdkd deploy` that
          // changes an ordinary property on a `Retain`-declaring cluster
          // now creates a SECOND cluster and leaves the first running,
          // where before this PR it hard-refused with
          // STATEFUL_REPLACE_BLOCKED. Same `⚠` shape as the
          // `--recreate-via-*` leak warning above, which announces the
          // strictly LESS surprising version of this outcome.
          this.logger.warn(
            `  ⚠ ${logicalId} has UpdateReplacePolicy: Retain — the old physical ` +
              `resource (${currentResource.physicalId}) is RETAINED and is no longer ` +
              `tracked by cdkd: it keeps running and incurring cost, and ` +
              `\`cdkd destroy\` will not remove it. Delete it yourself once you no ` +
              `longer need its data.`
          );
          // ...and declare it through the channel that survives the
          // terminal (issue #1819). `updatePartial`'s contract is
          // literally this shape — "updated, but something the update
          // owned survives untracked" — so the row prints
          // `partial (<reason>)` instead of `updated`, the run summary
          // counts it under "of which left an orphaned predecessor", and
          // a `RESOURCE_SKIPPED` event lands in the durable store
          // carrying the SURVIVOR's physical id and routing layer, which
          // is the one datum a cleanup pass needs.
          //
          // TWO consequences, stated because neither is cosmetic:
          //   - a TOP-LEVEL stack's deploy EXITS 2
          //     (`--allow-unaddressed` opts out), the same code
          //     `cdkd destroy` returns for a skipped delete. Correct
          //     here and arguably more so: a skipped delete self-heals
          //     on the next run, while this survivor is untracked, so
          //     nothing will ever retry it.
          //     SCOPED to top-level deliberately — inside a NESTED
          //     stack it is false today, and this arm is what turns
          //     that from an internal detail into a stated contract.
          //     `NestedStackProvider.runChildDeploy` is `Promise<void>`
          //     and DISCARDS the child engine's `DeployResult`, and its
          //     `update()` returns no `outcome`, so a child's
          //     `updatePartial` never reaches the parent's counter:
          //     the child logs the warn and the `partial (...)` row from
          //     its own logger while the run still exits 0 over a live
          //     untracked resource. Pre-existing and filed as issue
          //     [#1989](https://github.com/go-to-k/cdkd/issues/1989),
          //     which this arm is folded into as a row; rolling the
          //     child counts up is a behaviour change to a path this
          //     change does not touch.
          //   - it makes this arm LOUDER than the property-driven twin,
          //     which retains with only an info line. Deliberate, on the
          //     trigger asymmetry above, and recorded rather than
          //     silently unified — bringing the twin along is a
          //     behaviour change to a path this PR does not otherwise
          //     touch.
          retainedSurvivorReason =
            `UpdateReplacePolicy: Retain kept the old ${resourceType} ` +
            `(${currentResource.physicalId}), now untracked by cdkd`;
        }
        // Annotated rather than inferred: `result` is an evolving `let`,
        // and a conditional spread makes the literal's type a union that
        // TS then checks against the wrong constituent.
        const replacementResult: ResourceUpdateResult = {
          physicalId: createResult.physicalId,
          wasReplaced: true,
          // Spread rather than assigned: under `exactOptionalPropertyTypes`
          // an explicit `undefined` is not assignable to an optional
          // property. Behaviorally identical — the reader below is
          // `result.attributes ?? ...`, which cannot tell absent from
          // undefined.
          ...(createResult.attributes && { attributes: createResult.attributes }),
          // The create's own `NoEcho` declaration, carried for the same
          // reason the property-driven twin passes `createResult` whole:
          // this literal REPLACES the update result, so a declaration
          // dropped here never reaches `registerNoEchoAttributes` below
          // and the replacement's sensitive attributes land UNMASKED in
          // `state.json`. Found by review on this PR; the omission
          // pre-dates it, but `Retain` makes this block the only thing
          // that runs on the path, so leaving it would ship a literal
          // known to be wrong in the hunk being rewritten.
          ...(createResult.noEchoAttributes === true && { noEchoAttributes: true }),
          ...(createResult.noEchoAttributeNames && {
            noEchoAttributeNames: createResult.noEchoAttributeNames,
          }),
          // The `'partial'` arm of the outcome union, set only when the
          // retain branch above ran. A ternary rather than a conditional
          // spread: `ResourceUpdateResult` intersects a DISCRIMINATED
          // union, and spreading `outcome`/`reason` conditionally makes
          // the literal's type a union TS then checks against the wrong
          // constituent — the same trap the annotation above exists for.
          ...(retainedSurvivorReason !== undefined
            ? ({ outcome: 'partial', reason: retainedSurvivorReason } as const)
            : ({ outcome: 'updated' } as const)),
        };
        // Carried explicitly: this literal REPLACES the update result, so
        // a narrowing the replacement create announced would be dropped
        // on the floor and the desired bag recorded instead — silently
        // re-introducing the phantom drift (#1591).
        if (createResult.effectiveProperties) {
          replacementResult.effectiveProperties = createResult.effectiveProperties;
        }
        result = replacementResult;
        resultProvisionedBy = replDecision.provisionedBy;
        // Issue #2608: same decision, same statement — the two must not
        // be separable by a later edit.
        captureProvider = replProvider;
      } else {
        throw updateError;
      }
    }

    if (result.wasReplaced) {
      this.logger.info(
        `Resource ${logicalId} was replaced: ${currentResource.physicalId} -> ${result.physicalId}`
      );
    }

    // Issue #3462 — the ONE refusal class an in-place UPDATE may not
    // clear. The rebuild below enumerates its fields, which is what
    // clears every other `observedBaselineRefused` (see
    // `drainObservedCaptures`); for an unverifiable-parameter refusal
    // that is the leak. `cdkd import` refused because a template
    // parameter was not provably deployed at its `Default`, and a
    // top-level deploy binds that SAME `Default` (a nested child is handed
    // its values by the parent, where keeping the refusal is merely
    // conservative): the record's placeholder leaf is unchanged, so the
    // provider need not have rewritten it, AWS can still hold the
    // deployed value there, and a readback positioned against the
    // placeholder pairs it as an ordinary drifted literal. The engine
    // cannot know which leaves a provider wrote, so NO in-place update
    // discharges it, whatever it changed.
    //
    // A replacement does, but only one that is EVIDENCED: `wasReplaced`
    // AND a physical id that actually changed, so the capture below reads
    // a resource built from the bag cdkd sent. The flag alone is not
    // trusted: `S3BucketProvider.update` answers `wasReplaced: true` with
    // the OLD id when the bound `BucketName` differs from it — exactly
    // this class's shape, a name bound to a placeholder — having created
    // nothing, and the capture would then read the old bucket. Both
    // half-signals (the flag with the same id, a new id without the
    // flag, the update-unsupported fallback re-creating under the same
    // name) KEEP the refusal: the fail-closed reading.
    //
    // A marker an older cdkd recorded WITHOUT a reason reaches this line
    // already read: `stampReasonlessParameterRefusals` ran at deploy
    // start (issue #3468).
    const dischargedByReplacement =
      result.wasReplaced === true && result.physicalId !== currentResource.physicalId;
    const keepsParameterRefusal =
      !dischargedByReplacement && hasUnverifiableParameterRefusal(currentResource);

    // Attributes: prefer the update result's fresh set; when the
    // provider returned none AND the resource was updated IN PLACE,
    // carry the previously-stored (create-time) attributes forward —
    // an in-place update never invalidates them, and dropping them
    // would degrade every later Fn::GetAtt on this resource to the
    // physical-id fallback (observed live: an FSx update wiped
    // LustreMountName / DNSName and the stack outputs regressed to
    // the file-system id). A REPLACED resource must NOT inherit the
    // old resource's attributes — its create result is authoritative
    // (and absent attributes stay absent).
    const carriedAttributes =
      result.attributes ?? (result.wasReplaced ? undefined : currentResource.attributes);

    // Issue #2274: registered against `carriedAttributes`, not
    // `result.attributes`, because those are the values that land in the
    // record — and the whole point of the needles is to redact what is
    // PERSISTED. The two differ exactly when a provider declared `NoEcho`
    // and returned no fresh attributes, where the carried-forward set is
    // what state keeps.
    this.registerNoEchoAttributes(
      logicalId,
      {
        ...(carriedAttributes && { attributes: carriedAttributes }),
        ...(result.noEchoAttributes === true && { noEchoAttributes: true }),
        ...(result.noEchoAttributeNames && {
          noEchoAttributeNames: result.noEchoAttributeNames,
        }),
      },
      updateSecrets,
      resolvedProps
    );

    stateResources[logicalId] = {
      physicalId: result.physicalId,
      resourceType,
      properties: this.propertiesToRecord(resolvedProps, result, resourceType, resultProvisionedBy),
      ...(carriedAttributes && { attributes: carriedAttributes }),
      ...(dependencies && dependencies.length > 0 && { dependencies }),
      ...this.extractTemplateAttributes(template, logicalId),
      provisionedBy: resultProvisionedBy,
      ...(keepsParameterRefusal && {
        observedBaselineRefused: true as const,
        observedBaselineRefusalReason: 'unverifiable-parameter' as const,
      }),
    };
    // 'update' even after the replacement fallback: a principal then
    // claims only on its own `Policies` change (the fewer claims).
    if (updatePartialReason(result) === undefined) {
      this.recordInlinePolicyWrite(logicalId, 'update');
    }

    if (keepsParameterRefusal) {
      // No readback is TAKEN, not merely not persisted: a value that is
      // never read cannot reach the record, the journal, an event or a
      // log line by any route.
      this.logger.debug(
        `observedProperties capture SKIPPED for updated ${logicalId} (${resourceType}): 'cdkd import' refused its baseline because a template parameter was not provably deployed at its 'Default', and this deploy bound the same 'Default' — an in-place update cannot show that AWS no longer holds the deployed value. The refusal stands until the resource is replaced or re-imported against a CloudFormation stack that proves the parameter.`
      );
    }
    const updateCaptureSiblings = keepsParameterRefusal
      ? undefined
      : await this.buildObservedCaptureSiblings(
          resourceType,
          logicalId,
          result.physicalId,
          template,
          stateResources,
          stackName,
          parameterValues,
          conditions
        );
    // `captureProvider`, NOT `updateProvider`: on the plain in-place
    // path they are the same binding, and on the replacement fallback
    // this is the provider that actually created `result.physicalId`
    // and the layer `provisionedBy` above was stamped with (issue
    // #2608).
    if (!keepsParameterRefusal) {
      this.kickOffObservedCapture(
        captureProvider,
        logicalId,
        result.physicalId,
        resourceType,
        resolvedProps,
        { ...updateCaptureSiblings, afterOwnWrite: true }
      );
    }

    // Issue #1819: the provider may have updated the resource and left
    // something behind. The row still counts as an update for ordering
    // and state purposes, but it is not a clean one, so it gets its own
    // counter and its own status line rather than printing `updated`
    // over a survivor the user is never told about.
    const updatePartial = updatePartialReason(result);
    if (counts) {
      if (updatePartial !== undefined) counts.updatePartial++;
      else counts.updated++;
    }
    if (progress) progress.current++;
    const updatePrefix = progress ? `[${progress.current}/${progress.total}] ` : '  ';
    renderer.removeTask(logicalId);
    if (updatePartial !== undefined) {
      this.logger.warn(
        `${updatePrefix}${formatResourceLine('updated', logicalId, resourceType)} ` +
          updatePartialMessage(updatePartial)
      );
      return { updatePartial };
    }
    this.logger.info(`${updatePrefix}${formatResourceLine('updated', logicalId, resourceType)}`);
  }
  return;
}
