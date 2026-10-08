import { childLostWithRecreatedParent, survivesParent } from '../child-of-recreated-parent.js';
import { type DeployEngine } from '../deploy-engine.js';
import type { ProvisionCounts, ResourceOutcomeSignal } from '../deploy-engine.js';
import {
  findActionableSilentDrops,
  unwrittenCreateOnlyReplacement,
  withoutAcceptedSilentDropProperties,
  withoutUnwrittenSilentDropProperties,
} from '../../provisioning/property-coverage.js';
import {
  STATE_RESOURCES_MALFORMED,
  hasAddressablePhysicalId,
  unaddressableUpdateRefusalMessage,
} from '../../state/malformed-resources-bag.js';
import { CdkdError } from '../../utils/error-handler.js';
import { getCreateOnlyPropertyPaths } from '../../provisioning/create-only-properties.js';
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
  SECRET_MASK,
  canonicalCoordinates,
  carriesSecretMask,
  createSecretMasker,
  freshNoEchoLeafPositions,
  type FreshNoEchoLeaf,
  markSameGenerationBag,
  maskAtCoordinates,
  noEchoCoordinatesOf,
  noEchoLeavesOf,
  recordNestedStackParameterExpressions,
  redactSecretsForState,
  valueAtCoordinate,
  witnessNormalize,
  withoutNoEchoParameterEntries,
  recordPassedNoEchoParameters,
  recordLogOnlyValue,
  maskSecretsInText,
  type RecordedSecretValues,
} from '../secret-redaction.js';
import {
  classifyPassedParameters,
  inputFingerprinter,
  maskedInputFingerprintsFor,
  movedMaskedProperties,
  possiblyMaskedKeys,
  recordPassedParameterClasses,
} from '../masked-property-fingerprints.js';
import { printNestedStackReadsOnly } from './resolver-context.js';
import { echoFidelityCandidates, noEchoExactEchoLeavesOf, provesEchoChangeAt } from './noecho.js';
import { approveLateReplacement } from '../deployment-approval.js';
import {
  diffMovedServiceToken,
  renderServiceTokenRefusal,
  SERVICE_TOKEN_CHANGE_REFUSED,
  serviceTokenUpdateRefusal,
} from '../custom-resource-service-token.js';

declare module '../deploy-engine.js' {
  interface DeployEngine {
    /** @internal */
    provisionUpdate: OmitThisParameter<typeof provisionUpdate>;
  }
}

/**
 * Is `value` the mask at every leaf (a scalar `***`, or a list / object of
 * nothing but masks, as `maskWholeValue` writes a list parameter)?
 */
function isWhollyMask(value: unknown): boolean {
  if (value === SECRET_MASK) return true;
  if (Array.isArray(value)) return value.length > 0 && value.every(isWhollyMask);
  if (value !== null && typeof value === 'object') {
    const children = Object.values(value as Record<string, unknown>);
    return children.length > 0 && children.every(isWhollyMask);
  }
  return false;
}

/** A copy of `bag` with the leaf at `coordinate` set to `value` (containers copied on the path). */
function setAtCoordinate(
  bag: Record<string, unknown>,
  coordinate: readonly (string | number)[],
  value: unknown
): Record<string, unknown> {
  const write = (node: unknown, depth: number): unknown => {
    if (depth === coordinate.length) return value;
    const segment = coordinate[depth]!;
    if (Array.isArray(node) && typeof segment === 'number') {
      const copy = [...node];
      copy[segment] = write(node[segment], depth + 1);
      return copy;
    }
    if (node !== null && typeof node === 'object' && typeof segment === 'string') {
      const record = node as Record<string, unknown>;
      return { ...record, [segment]: write(record[segment], depth + 1) };
    }
    return node;
  };
  return write(bag, 0) as Record<string, unknown>;
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
  // go-to-k/cdkd#4043 §3.3: what a HELD producer's declared `NoEcho`
  // attributes serve this resolution, read back from AWS (never persisted).
  const noEchoOverrides = await this.noEchoAttributeOverridesFor(
    desiredProps,
    stateResources,
    stackName
  );
  if (noEchoOverrides !== undefined) context.noEchoAttributeOverrides = noEchoOverrides;
  printNestedStackReadsOnly(context, resourceType, this.secretNameBagFor(logicalId));
  const resolvedProps = (await this.resolver.resolve(desiredProps, context)) as Record<
    string,
    unknown
  >;
  // go-to-k/cdkd#3869: the name this deploy resolved, before the provider
  // prints it (a rename, or a replacement's new resource).
  this.noteSecretNamedRecord(logicalId, {
    resourceType,
    physicalId: stateResources[logicalId]?.physicalId,
    properties: resolvedProps,
  });
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
  // go-to-k/cdkd#4043 §3.3: an attribute the RECORD holds that echoes a
  // `NoEcho` value this resource was given is declared now, before any skip,
  // so a held (or witness-confirmed) producer still masks it on the save and
  // its same-stack readers position it. A provider result re-declares below.
  this.registerNoEchoAttributes(
    logicalId,
    Object.assign(
      currentResource.attributes === undefined ? {} : { attributes: currentResource.attributes },
      { physicalId: currentResource.physicalId }
    ),
    updateSecrets,
    resolvedProps
  );
  // go-to-k/cdkd#4043: where a `NoEcho` PARAMETER (or an attribute declared
  // `NoEcho`) served this bag, by template position. The persisted bag holds
  // `***` at each, so the comparison side does too.
  const noEchoSources = this.noEchoPositionSources(stateResources, template, conditions);
  // Two classes, positioned separately: a PARAMETER's value, and an attribute
  // a producer declared `NoEcho` (the custom-resource class of #3729).
  const parameterCoordinates =
    noEchoSources === undefined
      ? []
      : canonicalCoordinates(
          noEchoCoordinatesOf(desiredProps, resolvedProps, {
            parameters: noEchoSources.parameters,
            ...(noEchoSources.conditions !== undefined && {
              conditions: noEchoSources.conditions,
            }),
          })
        );
  const attributeCoordinates =
    noEchoSources?.attributeIsNoEcho === undefined
      ? []
      : canonicalCoordinates(
          noEchoCoordinatesOf(desiredProps, resolvedProps, {
            parameters: new Set(),
            attributeIsNoEcho: noEchoSources.attributeIsNoEcho,
          })
        );
  const noEchoCoordinates = canonicalCoordinates([
    ...parameterCoordinates,
    ...attributeCoordinates,
  ]);
  // go-to-k/cdkd#4043: a coordinate the RECORD marks, where it holds `***`,
  // that no `NoEcho` source serves any more (`NoEcho` removed from the
  // parameter, or the reference replaced by an equal literal). The mask
  // proves nothing about the value, so the leaf is read back like a
  // parameter's, never replaced on the mask's word.
  const staleCoordinates = (noEchoLeavesOf(currentResource) ?? []).filter((coordinate) => {
    if (noEchoCoordinates.some((known) => keyOrderFreeJson(known) === keyOrderFreeJson(coordinate)))
      return false;
    if (!isWhollyMask(valueAtCoordinate(currentProps, coordinate))) return false;
    const resolved = valueAtCoordinate(resolvedProps, coordinate);
    return resolved !== undefined && !carriesSecretMask(resolved);
  });
  const comparisonCoordinates = canonicalCoordinates([...noEchoCoordinates, ...staleCoordinates]);
  if (parameterCoordinates.length > 0) {
    this.noEchoPositionedValues.set(
      logicalId,
      new Set(
        parameterCoordinates.map((coordinate) =>
          keyOrderFreeJson(valueAtCoordinate(resolvedProps, coordinate))
        )
      )
    );
  }
  // go-to-k/cdkd#4451: a property the record holds as `***` whose UNRESOLVED
  // template value moved since it was written. Its redacted value compares
  // `***` with `***` whatever the edit (the text around a secret reference
  // inside one `Fn::Base64`, or the reference's target), so neither skip
  // below may fire for it. A record with no fingerprint (an older cdkd's)
  // reads as unmoved, the comparison it always had.
  // go-to-k/cdkd#4543: a bound input fingerprint also covers the property's
  // resolved non-secret inputs, read here against THIS deploy's state, so a
  // `Ref` to a resource the deploy just replaced (the diff saw the old one)
  // moves it too.
  const fingerprintSources =
    template && this.maskedInputSources(template, stateResources, conditions, stackName);
  const fingerprints = fingerprintSources && inputFingerprinter(desiredProps, fingerprintSources);
  const movedMasked = new Set(
    await movedMaskedProperties(currentResource, desiredProps, fingerprints)
  );
  // What the save stamps if this deploy writes the record: the input
  // fingerprint of each property it may record as the mask.
  if (fingerprints !== undefined) {
    this.perResourceInputFingerprints.set(
      logicalId,
      await maskedInputFingerprintsFor(
        possiblyMaskedKeys(resolvedProps, [
          updateSecrets,
          this.fingerprintNoEchoValues,
          this.options.inheritedSecrets,
        ]),
        fingerprints
      )
    );
  }
  // go-to-k/cdkd#4543: for a nested-stack row, how each value it passes may
  // enter the child's input fingerprints, read off THIS (the parent's)
  // template, recorded on the bag the provider call is bound to, where the
  // child engine reads it.
  // go-to-k/cdkd#4043 (review round 9): and which of them carry a `NoEcho`
  // value, so the child positions them as `NoEcho` parameters.
  if (resourceType === 'AWS::CloudFormation::Stack') {
    recordPassedNoEchoParameters(
      updateSecrets,
      desiredProps['Parameters'],
      this.noEchoPositionSources(stateResources)
    );
  }
  if (fingerprintSources !== undefined && resourceType === 'AWS::CloudFormation::Stack') {
    recordPassedParameterClasses(
      updateSecrets,
      await classifyPassedParameters(desiredProps['Parameters'], fingerprintSources)
    );
  }
  const desiredForSkipCheck = maskAtCoordinates(
    redactSecretsForState(markSameGenerationBag({ ...resolvedProps }), updateSecrets, desiredProps),
    comparisonCoordinates
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
  const recordedAsWritten =
    currentResource.provisionedBy === 'cc-api'
      ? currentProps
      : withoutUnwrittenSilentDropProperties(
          resourceType,
          currentProps,
          desiredForSkipCheck,
          allowedForRecord,
          createOnlyEvidence
        );
  // go-to-k/cdkd#4043 (the MIGRATION WITNESS, review B2): a record no v11
  // binary wrote carries no `noEchoLeaves`, and where this deploy persists
  // `***` it may still hold the plaintext it last SENT. Compared with what the
  // persist walk writes WITHOUT the `NoEcho` arms (the dynamic-reference
  // form), an equal leaf is an unchanged value with no readback, and a
  // different one a change the comparison below sees as moved.
  const unmarkedRecord = noEchoLeavesOf(currentResource) === undefined;
  const todayAsWritten = unmarkedRecord
    ? redactSecretsForState(
        markSameGenerationBag({ ...resolvedProps }),
        withoutNoEchoParameterEntries(updateSecrets),
        desiredProps
      )
    : undefined;
  const witness =
    todayAsWritten === undefined
      ? undefined
      : witnessNormalize(recordedAsWritten, todayAsWritten, desiredForSkipCheckAsWritten);
  const currentPropsAsWritten =
    witness === undefined ? recordedAsWritten : (witness.current as Record<string, unknown>);
  // go-to-k/cdkd#4741: a witness that DIFFERS keeps the record's stored
  // plaintext, the PREVIOUS value of a `NoEcho` position, on the side handed
  // to the provider as the previous properties (and to a replacement's
  // delete), and no bag knew it. It goes into this resource's PRINT-ONLY bag,
  // the derived-name registry `provisionResource` binds around the whole
  // resource body: every log line there (a provider's own included), the
  // resource's errors and its events mask it. Not into `updateSecrets`, which
  // persisting and deciding readers walk (the fingerprint refusal, a nested
  // child's inherited bag). A shape-moved coordinate names a whole list or
  // object, so only its leaves the desired side does not hold are recorded.
  // The log-only floor applies: a whole printed text equal to it is masked at
  // any length, an embedded occurrence only from `MIN_NEEDLE_LENGTH`
  // characters.
  for (const coordinate of witness?.differing ?? []) {
    const desiredAt = valueAtCoordinate(desiredForSkipCheckAsWritten, coordinate);
    recordPreviousNoEchoLeaves(
      this.secretNameBagFor(logicalId),
      valueAtCoordinate(recordedAsWritten, coordinate),
      scalarLeavesOf(desiredAt),
      updateSecrets,
      desiredAt !== SECRET_MASK
    );
  }
  // The fresh `NoEcho` leaves, by class. The custom-resource class (a
  // handler's `Data`, a recovered output) keeps the go-to-k/cdkd#3729 table;
  // the PARAMETER class is read back whatever the property's replacement
  // class, and a create-only property it feeds is never replaced on a
  // readback's word (maintainer decision on #4043) unless that readback is
  // proven exact (`noEchoExactEchoLeaves`, #4656).
  // A positional leaf of the attribute class: a value supplied in this run
  // that no needle keys (a `Number`, a value under the floor).
  const positionalLeavesAt = (
    coordinates: readonly (readonly (string | number)[])[],
    key: string
  ): FreshNoEchoLeaf[] =>
    coordinates
      .filter((coordinate) => coordinate[0] === key)
      .flatMap((coordinate) => {
        const plaintext = valueAtCoordinate(resolvedProps, coordinate);
        return plaintext === undefined || carriesSecretMask(plaintext)
          ? []
          : [{ path: coordinate.slice(1), plaintext }];
      });
  // The migration witness, per leaf: a pre-v11 record's stored plaintext at
  // the leaf equals what the dynamic-reference persist form holds there.
  const witnessConfirms = (key: string, leaf: FreshNoEchoLeaf): boolean => {
    if (todayAsWritten === undefined) return false;
    const full = [key, ...leaf.path];
    const stored = valueAtCoordinate(recordedAsWritten, full);
    return (
      stored !== undefined &&
      !carriesSecretMask(stored) &&
      keyOrderFreeJson(stored) === keyOrderFreeJson(valueAtCoordinate(todayAsWritten, full))
    );
  };
  const otherFreshAt = (key: string): FreshNoEchoLeaf[] => {
    const leaves = freshNoEchoLeafPositions(resolvedProps[key], updateSecrets, 'other');
    for (const leaf of positionalLeavesAt(attributeCoordinates, key)) {
      if (!leaves.some((known) => keyOrderFreeJson(known.path) === keyOrderFreeJson(leaf.path))) {
        leaves.push(leaf);
      }
    }
    // A pre-v11 reader of a declared attribute whose stored value is the
    // same is unchanged too (the witness covers both classes).
    return leaves.filter((leaf) => !witnessConfirms(key, leaf));
  };
  const pendingParameterLeaves = new Map<string, FreshNoEchoLeaf[]>();
  const addParameterLeaf = (key: string, leaf: FreshNoEchoLeaf): void => {
    if (witnessConfirms(key, leaf)) return; // the witness confirmed it
    const list = pendingParameterLeaves.get(key) ?? [];
    if (!list.some((known) => keyOrderFreeJson(known.path) === keyOrderFreeJson(leaf.path))) {
      list.push(leaf);
    }
    pendingParameterLeaves.set(key, list);
  };
  for (const key of Object.keys(resolvedProps)) {
    // A redacted read (the mask itself, out of a previous run's record) is
    // no value supplied in this deploy, which `positionalLeavesAt` skips.
    for (const leaf of positionalLeavesAt(parameterCoordinates, key)) addParameterLeaf(key, leaf);
    for (const leaf of positionalLeavesAt(staleCoordinates, key)) addParameterLeaf(key, leaf);
    for (const leaf of freshNoEchoLeafPositions(resolvedProps[key], updateSecrets, 'parameter')) {
      const covered = parameterCoordinates.some(
        (coordinate) =>
          coordinate[0] === key &&
          coordinate.length - 1 <= leaf.path.length &&
          coordinate.slice(1).every((segment, i) => segment === leaf.path[i])
      );
      if (!covered) addParameterLeaf(key, leaf);
    }
  }
  // A pre-v11 record whose stored plaintext DIFFERS from a `NoEcho` parameter
  // value this deploy supplies: exact evidence the value changed (maintainer
  // decision on #4043, design §9 item 6), so a create-only path it feeds is
  // replaced as before, and the replacement names that cause, never the value.
  // The cause a differing witness names (review round 9 m4): the PARAMETER's
  // value only where the position is a bare `Ref` to a `NoEcho` parameter, so
  // the stored value at it is exactly that parameter's last value. Any other
  // form (an `Fn::Sub` around it) may have moved for its template text alone.
  const witnessCauseAt = (key: string): 'parameter' | 'position' | undefined => {
    let cause: 'parameter' | 'position' | undefined;
    for (const coordinate of witness?.differing ?? []) {
      if (coordinate[0] !== key) continue;
      const rest = coordinate.slice(1);
      const pending = (pendingParameterLeaves.get(key) ?? []).some((leaf) => {
        const shorter = rest.length <= leaf.path.length ? rest : leaf.path;
        const longer = shorter === rest ? leaf.path : rest;
        return shorter.every((segment, i) => segment === longer[i]);
      });
      if (!pending) continue;
      const node = valueAtCoordinate(desiredProps, coordinate);
      const bareRef =
        node !== null &&
        typeof node === 'object' &&
        !Array.isArray(node) &&
        Object.keys(node).length === 1 &&
        typeof (node as Record<string, unknown>)['Ref'] === 'string' &&
        noEchoSources?.parameters.has((node as Record<string, string>)['Ref']!) === true;
      if (bareRef) return 'parameter';
      cause = 'position';
    }
    return cause;
  };
  const warnWitnessReplacement = (key: string): void => {
    const cause = witnessCauseAt(key);
    if (cause === undefined) return;
    this.logger.warn(
      cause === 'parameter'
        ? safeMsg`${logicalId}.${key} is a create-only property, and a NoEcho parameter's value changed since the last deploy: ${logicalId} is replaced.`
        : safeMsg`${logicalId}.${key} is a create-only property, and the value at its NoEcho position changed since the last deploy: ${logicalId} is replaced.`
    );
  };
  const suppliesFreshMaskOnlyValue =
    pendingParameterLeaves.size > 0 ||
    Object.keys(resolvedProps).some((key) => otherFreshAt(key).length > 0);
  // What both no-change skips require of the bags: equal redacted values, and
  // no masked property whose template expression moved (go-to-k/cdkd#4451),
  // since `***` equals `***` whatever the edit. ONE predicate, so the two
  // skips cannot disagree on it.
  const recordMatchesDesired =
    movedMasked.size === 0 &&
    keyOrderFreeJson(desiredForSkipCheckAsWritten) === keyOrderFreeJson(currentPropsAsWritten);
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
  // The type's create-only paths (the committed snapshot when DescribeType
  // fails), read when a `NoEcho` parameter serves this bag.
  const schemaCreateOnly =
    pendingParameterLeaves.size === 0 && parameterCoordinates.length === 0
      ? []
      : await getCreateOnlyPropertyPaths(resourceType).catch(
          () => [] as ReadonlyArray<readonly string[]>
        );
  // go-to-k/cdkd#4656: the create-only `NoEcho` parameter coordinates whose
  // echo fidelity a readback may prove.
  const echoCandidates = echoFidelityCandidates(
    parameterCoordinates,
    resolvedProps,
    schemaCreateOnly
  );
  // The ONE readback of this resource for its `NoEcho` leaves, shared by every
  // block below. It hands the provider the RECORD, never the resolved bag. A
  // pre-v11 record still holds the plaintext it last sent, so it is handed a
  // copy with `***` at every `NoEcho` parameter coordinate (#4656, rule 1):
  // a provider that echoes its argument then reports the mask.
  const readbackRecord =
    unmarkedRecord && parameterCoordinates.length > 0
      ? {
          ...currentResource,
          properties: maskAtCoordinates(currentResource.properties, parameterCoordinates),
        }
      : currentResource;
  let readback: Promise<FreshNoEchoReadback> | undefined;
  const readOnce = (): Promise<FreshNoEchoReadback> =>
    (readback ??= this.readReaderForFreshNoEchoCeiling(
      logicalId,
      readbackRecord,
      updateSecrets
    ).then((read) => {
      // Every coordinate this read echoed exactly gains the flag; a differing
      // or failed one changes nothing.
      this.noteNoEchoExactEchoes(
        logicalId,
        currentResource.physicalId,
        read,
        readbackRecord.properties,
        echoCandidates,
        'add'
      );
      return read;
    }));
  // go-to-k/cdkd#4656: a create-only `NoEcho` parameter leaf this record's
  // provider was PROVEN to echo exactly (`noEchoExactEchoLeaves`), which the
  // readback now reports holding a different string: a change, not a
  // provider's normalization, so the path is replaced as before Phase B. Only
  // a whole-string leaf the record holds as `***` is eligible, as when the
  // flag was set (a value-arm leaf there would be a stale coordinate).
  const exactEchoCoordinates = new Set(
    (noEchoExactEchoLeavesOf(currentResource) ?? []).map((c) => JSON.stringify(c))
  );
  const provenChangedAt = (key: string, read: FreshNoEchoReadback | undefined): boolean => {
    if (exactEchoCoordinates.size === 0 || read === undefined || 'failure' in read) return false;
    return (pendingParameterLeaves.get(key) ?? []).some((leaf) => {
      const full = [key, ...leaf.path];
      if (!exactEchoCoordinates.has(JSON.stringify(full))) return false;
      const [candidate] = echoFidelityCandidates([full], resolvedProps, schemaCreateOnly);
      return (
        candidate !== undefined &&
        provesEchoChangeAt(read.live, readbackRecord.properties, candidate)
      );
    });
  };
  // A replacement the readback proves is decided here, after
  // `--require-approval` asked about the diff, which could not read AWS and
  // showed none. So it is asked about now (`approveLateReplacement`), ONCE for
  // the resource, whichever of its paths proved it: one answer replaces the
  // resource or keeps it. A kept one warns why; the rest of the deploy goes on.
  // A resource another path replaces anyway (a create-only template edit, a
  // `--recreate-via-*` target), the up-front prompt already asked about: it is
  // replaced without a second question, and nothing says it is kept.
  let replacedAnyway = false;
  let lateApproval: Promise<boolean> | undefined;
  const approveReplacementOf = (pc: PropertyChange): Promise<boolean> => {
    if (replacedAnyway) return Promise.resolve(true);
    const { noEchoPromoted: _promoted, ...asReplacement } = pc;
    lateApproval ??= approveLateReplacement({
      options: this.options,
      stackName,
      change: {
        ...change,
        changeType: 'UPDATE',
        propertyChanges: [{ ...asReplacement, requiresReplacement: true }],
      },
      records: stateResources,
      template,
    });
    return lateApproval;
  };
  const lateReplacementDeclined = new Set<string>();
  // Why a `differs` on such a path is not acted on: the warning names it.
  const differsWhy = (key: string): string =>
    lateReplacementDeclined.has(key)
      ? `differs; the replacement was not approved (--require-approval=${this.options.requireApproval ?? 'never'})`
      : 'differs; the provider is not known to report this property exactly, so the difference may be its normalization';
  // go-to-k/cdkd#4656: the MIGRATION deploy of a pre-v11 record takes the
  // echo-fidelity readback even when its witness settles every value (so no
  // block below would read), before the skip just below can return.
  if (
    unmarkedRecord &&
    !typeChanged &&
    echoCandidates.length > 0 &&
    hasAddressablePhysicalId(currentResource)
  ) {
    await readOnce();
  }
  if (
    !typeChanged &&
    !suppliesFreshMaskOnlyValue &&
    lostChild === undefined &&
    this.recreateDirectionFor(stackName, logicalId) === undefined &&
    recordMatchesDesired
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

  // go-to-k/cdkd#3211: a record with no usable physical id cannot be
  // ADDRESSED, and every arm below hands it to a provider (the in-place
  // update, the replacement's delete of the old resource, the NoEcho
  // readback). Below the no-change skip, which sends nothing, and above the
  // first of them. Refused rather than skipped, unlike the DELETE arm: a
  // skip would end the deploy without the template's change. The RECORD's
  // type decides the nested-stack exemption, as in `cdkd destroy`: that
  // provider finds its child by name and never addresses AWS by the id. Not a
  // record on Cloud Control, which does.
  if (
    !(
      currentResource.resourceType === 'AWS::CloudFormation::Stack' &&
      currentResource.provisionedBy !== 'cc-api'
    ) &&
    !hasAddressablePhysicalId(currentResource)
  ) {
    throw markRefusedBeforeApplying(
      markNonRetryable(
        new CdkdError(
          unaddressableUpdateRefusalMessage(
            stackName,
            this.stackRegion,
            logicalId,
            oldResourceType,
            this.options.refusalRecovery
          ),
          STATE_RESOURCES_MALFORMED
        )
      )
    );
  }

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
  // The create-only paths a `NoEcho` PARAMETER value feeds, taken before the
  // block below can lower them: the parameter block after it decides them.
  // Create-only by the type's SCHEMA (the committed snapshot when DescribeType
  // fails), not by the diff's replacement flag: a write-only create-only
  // property raises no ceiling in the diff, nor does any whole-property path
  // when the lookup fails, and maintainer decision 1 covers both (never sent
  // as an in-place change, never replaced; warned).
  const isSchemaCreateOnly = (key: string): boolean =>
    (pendingParameterLeaves.get(key) ?? []).some((leaf) => {
      const full = [key, ...leaf.path.map(String)];
      return schemaCreateOnly.some(
        (path) => path.length <= full.length && path.every((segment, i) => segment === full[i])
      );
    });
  const parameterCreateOnlyPaths = new Set(
    (change.propertyChanges ?? [])
      .filter(
        (pc) =>
          (pc.requiresReplacement || isSchemaCreateOnly(pc.path)) &&
          pendingParameterLeaves.has(pc.path) &&
          otherFreshAt(pc.path).length === 0
      )
      .map((pc) => pc.path)
  );
  if (change.propertyChanges?.some((pc) => pc.requiresReplacement) === true) {
    const lowered: PropertyChange[] = [];
    for (const pc of change.propertyChanges) {
      if (!pc.requiresReplacement || parameterCreateOnlyPaths.has(pc.path)) {
        lowered.push(pc);
        continue;
      }
      // A path carrying BOTH classes is confirmed only when every leaf holds:
      // the parameter leaves join the custom-resource ones here.
      const freshLeaves = [
        ...otherFreshAt(pc.path),
        ...(pendingParameterLeaves.get(pc.path) ?? []),
      ];
      if (!isReplacementCeiling(pc) && freshLeaves.length === 0) {
        lowered.push(pc);
        continue;
      }
      // The non-NoEcho half first, unchanged: a moved leaf keeps the
      // replacement whatever AWS holds at the masked ones.
      // A masked property whose template moved (go-to-k/cdkd#4451) moved,
      // whatever its two `***` say.
      const moved =
        movedMasked.has(pc.path) ||
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
        warnWitnessReplacement(pc.path);
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
        const read = await readOnce();
        let verdict: FreshNoEchoCeilingVerdict;
        if ('failure' in read) {
          verdict = read.failure;
        } else if (!Object.prototype.hasOwnProperty.call(read.live, pc.path)) {
          verdict = 'not-readable';
        } else {
          verdict = liveHoldsFreshLeaves(read.live[pc.path], freshLeaves) ? 'held' : 'differs';
        }
        // A mixed path whose custom-resource leaves AWS holds, and whose only
        // unconfirmed leaves are a `NoEcho` PARAMETER's: the parameter class's
        // rule (maintainer decision 1 on #4043) — never replaced on a
        // readback's word, warned on every deploy.
        const parameterLeaves = pendingParameterLeaves.get(pc.path) ?? [];
        if (
          verdict === 'differs' &&
          parameterLeaves.length > 0 &&
          !('failure' in read) &&
          liveHoldsFreshLeaves(read.live[pc.path], otherFreshAt(pc.path))
        ) {
          this.logger.warn(
            safeMsg`${logicalId}.${pc.path} is a create-only property fed by a NoEcho parameter, and cdkd cannot confirm AWS holds its current value (differs). It is not replaced, so a change to that value is not applied: to apply one, deploy with --recreate-via-cc-api ${logicalId} or --recreate-via-sdk-provider ${logicalId}.`
          );
          noEchoHeldPaths.add(pc.path);
          lowered.push({ ...pc, requiresReplacement: false });
          continue;
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

  // go-to-k/cdkd#4043 §4.2: the PARAMETER class. The resource is read back
  // (once, shared with the block above) when a create-only path carries such
  // a value, or when nothing else moved, which is when the readback alone
  // decides between sending and skipping. Another moved leaf sends the update
  // anyway, with the value in hand.
  const parameterSettledPaths = new Set<string>();
  // Keys whose every pending leaf AWS confirmed holding (`held`).
  const parameterHeldKeys = new Set<string>();
  const parameterUnreadablePaths: string[] = [];
  if (pendingParameterLeaves.size > 0 && !typeChanged) {
    const mustRead = parameterCreateOnlyPaths.size > 0 || recordMatchesDesired;
    const read = mustRead ? await readOnce() : undefined;
    const verdictAt = (key: string): FreshNoEchoCeilingVerdict => {
      if (read === undefined) return 'not-readable';
      if ('failure' in read) return read.failure;
      if (!Object.prototype.hasOwnProperty.call(read.live, key)) return 'not-readable';
      return liveHoldsFreshLeaves(read.live[key], pendingParameterLeaves.get(key) ?? [])
        ? 'held'
        : 'differs';
    };
    const lowered: PropertyChange[] = [];
    // A leaf OTHER than the `NoEcho` one moved (a template edit, or a
    // pre-v11 record's witness that differs, an exact change): the
    // replacement stands, as CloudFormation would replace.
    const movedAt = (path: string): boolean =>
      movedMasked.has(path) ||
      keyOrderFreeJson(desiredForSkipCheckAsWritten[path]) !==
        keyOrderFreeJson(currentPropsAsWritten[path]);
    replacedAnyway =
      this.recreateDirectionFor(stackName, logicalId) !== undefined ||
      lostWithParent !== undefined ||
      (change.propertyChanges ?? []).some(
        (other) =>
          other.requiresReplacement &&
          (!parameterCreateOnlyPaths.has(other.path) || movedAt(other.path))
      );
    for (const pc of change.propertyChanges ?? []) {
      if (!parameterCreateOnlyPaths.has(pc.path)) {
        lowered.push(pc);
        continue;
      }
      const moved = movedAt(pc.path);
      if (moved) {
        // go-to-k/cdkd#4737: the path is create-only by the SCHEMA, while the
        // diff decided whether it replaces (registry first, then a whole
        // create-only property). A path the diff did not mark (a Budget's
        // `NotificationsWithSubscribers`, which the registry updates in place)
        // is sent as an update, so the line saying it is replaced would be
        // false.
        if (pc.requiresReplacement) warnWitnessReplacement(pc.path);
        lowered.push(pc);
        continue;
      }
      const verdict = verdictAt(pc.path);
      if (verdict === 'read-failed') {
        throw markNonRetryable(
          new CdkdError(
            safeMsg`${logicalId}.${pc.path} is a create-only property a NoEcho parameter feeds, and reading the resource back from AWS to compare it failed. cdkd does not replace a resource on a failed read: re-run the deploy.`,
            'NOECHO_READBACK_FAILED'
          )
        );
      }
      if (verdict === 'held') {
        parameterHeldKeys.add(pc.path);
        this.logger.debug(
          safeMsg`${logicalId}.${pc.path} carries a NoEcho parameter value AWS already holds: not replaced.`
        );
      } else if (
        verdict === 'differs' &&
        provenChangedAt(pc.path, read) &&
        (await approveReplacementOf(pc))
      ) {
        // go-to-k/cdkd#4656: the provider echoes this leaf exactly, so the
        // difference is the value's. The id, the path and the cause only.
        this.logger.warn(
          safeMsg`${logicalId}.${pc.path} is a create-only property fed by a NoEcho parameter, and AWS, which reports it exactly, holds a different value: ${logicalId} is replaced.`
        );
        lowered.push({ ...pc, requiresReplacement: true });
        continue;
      } else {
        // Maintainer decision 1 on #4043: never replaced on a readback's
        // word, whether it could not read the property or read a different
        // value (a provider may normalize what it echoes). Every deploy says so,
        // and a `differs` names why it is not trusted (#4656).
        const staleOnly = staleCoordinates.some((coordinate) => coordinate[0] === pc.path);
        if (verdict === 'differs' && provenChangedAt(pc.path, read)) {
          lateReplacementDeclined.add(pc.path);
        }
        const why = verdict === 'differs' ? differsWhy(pc.path) : verdict;
        this.logger.warn(
          staleOnly
            ? safeMsg`${logicalId}.${pc.path} is a create-only property whose recorded value is only the NoEcho mask, and cdkd cannot confirm AWS holds its current value (${why}). It is not replaced, so a change to that value is not applied: to apply one, deploy with --recreate-via-cc-api ${logicalId} or --recreate-via-sdk-provider ${logicalId}.`
            : safeMsg`${logicalId}.${pc.path} is a create-only property fed by a NoEcho parameter, and cdkd cannot confirm AWS holds its current value (${why}). It is not replaced, so a change to that value is not applied: to apply one, deploy with --recreate-via-cc-api ${logicalId} or --recreate-via-sdk-provider ${logicalId}.`
        );
      }
      parameterSettledPaths.add(pc.path);
      lowered.push({ ...pc, requiresReplacement: false });
    }
    if (change.propertyChanges !== undefined) change.propertyChanges = lowered;
    if (read !== undefined) {
      for (const key of pendingParameterLeaves.keys()) {
        if (parameterCreateOnlyPaths.has(key)) continue;
        // A custom-resource leaf beside it keeps the #3729 rule (an updatable
        // path nobody read back for it is sent).
        if (otherFreshAt(key).length > 0) continue;
        const verdict = verdictAt(key);
        if (verdict === 'held') {
          parameterSettledPaths.add(key);
          parameterHeldKeys.add(key);
        } else if (verdict === 'not-readable') parameterUnreadablePaths.push(key);
      }
    }
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
  const confirmedPaths = new Set([...noEchoHeldPaths, ...parameterSettledPaths]);
  if (
    confirmedPaths.size > 0 &&
    !typeChanged &&
    lostChild === undefined &&
    this.recreateDirectionFor(stackName, logicalId) === undefined &&
    recordMatchesDesired &&
    Object.keys(resolvedProps).every(
      (key) =>
        confirmedPaths.has(key) ||
        (otherFreshAt(key).length === 0 && !pendingParameterLeaves.has(key))
    )
  ) {
    this.logger.debug(
      safeMsg`Skipping ${logicalId}: AWS already holds every NoEcho value it carries, and nothing else changed`
    );
    // go-to-k/cdkd#4043 (review round 8 m2): a STALE coordinate (the record
    // holds `***` where no NoEcho source serves the leaf any more) that AWS
    // confirmed holding the resolved value is rewritten to that value and
    // unmarked, so the diff stops comparing `***` with it on every run.
    const staleHeld = staleCoordinates.filter(
      (coordinate) => typeof coordinate[0] === 'string' && parameterHeldKeys.has(coordinate[0])
    );
    if (staleHeld.length > 0) {
      let properties = currentResource.properties;
      for (const coordinate of staleHeld) {
        properties = setAtCoordinate(
          properties,
          coordinate,
          valueAtCoordinate(resolvedProps, coordinate)
        );
      }
      const remaining = (noEchoLeavesOf(currentResource) ?? []).filter(
        (coordinate) =>
          !staleHeld.some((stale) => keyOrderFreeJson(stale) === keyOrderFreeJson(coordinate))
      );
      const { noEchoLeaves: _dropped, ...rest } = currentResource;
      stateResources[logicalId] = {
        ...rest,
        properties,
        ...(remaining.length > 0 && { noEchoLeaves: remaining.map((c) => [...c]) }),
      };
    }
    // Nothing was attempted, as on the skip above the refusal.
    this.attemptedResolvedProps.delete(logicalId);
    if (change.attributeChanges && change.attributeChanges.length > 0) {
      applyAttributeOnlyUpdate(change.attributeChanges);
      return;
    }
    if (counts) counts.skipped++;
    return;
  }

  // Maintainer decision 4 on #4043: an updatable property AWS does not report
  // (write-only, or a type with no readback) is re-sent on every deploy, and
  // one line per resource says why the update ran.
  if (recordMatchesDesired && parameterUnreadablePaths.length > 0) {
    this.logger.info(
      safeMsg`  ${logicalId}: re-sending ${parameterUnreadablePaths.join(', ')}, fed by a NoEcho parameter. AWS does not report the value back, so cdkd cannot tell whether it changed.`
    );
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
  // go-to-k/cdkd#4749: the plan refused every ServiceToken change it could
  // judge; this one sees the RESOLVED token, so a token reading a resource
  // this deploy replaced or created (a renamed backing Lambda) is refused
  // here, before the handler is invoked. Nothing was sent, so the journal
  // must not record the bag as an attempt.
  const serviceTokenRefusal = serviceTokenUpdateRefusal({
    logicalId,
    resourceType,
    recordedType: currentResource.resourceType,
    recorded: currentResource.properties?.['ServiceToken'],
    desired: resolvedProps['ServiceToken'],
    diffSawTokenChange: diffMovedServiceToken(change),
  });
  if (serviceTokenRefusal !== undefined) {
    throw markRefusedBeforeApplying(
      markNonRetryable(
        new CdkdError(
          renderServiceTokenRefusal(
            [serviceTokenRefusal],
            stackName,
            createSecretMasker(updateSecrets)
          ),
          SERVICE_TOKEN_CHANGE_REFUSED
        )
      )
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
      // go-to-k/cdkd#4043: the parameter-class paths settled above too, so a
      // provider never diffs `***` against the value it is sent (a create-only
      // path cdkd said it will not replace included).
      noEchoHeldPaths: confirmedPaths,
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
  // the property-driven path, which creates the new one first. A NAME
  // collision there is retried delete-first under `--replace`, but any other
  // unique value the old one still holds (a subnet's CIDR block) collides.
  // Inside a nested child only `--replace` reaches the resource.
  const replaceFlags = nested
    ? '--replace (which creates the new resource before deleting the old one, so a ' +
      'resource holding a unique value other than its name, such as a CIDR block, collides)'
    : `--recreate-via-cc-api ${logicalId}, which deletes the old resource first ` +
      '(--replace also works, but creates the new one first, so a resource holding a ' +
      'unique value other than its name, such as a CIDR block, collides)';
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

/**
 * The printed form of every string and number leaf of `value`, at any depth.
 * A boolean is left out: `true` would mask every line saying it.
 */
function scalarLeavesOf(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') into.add(value);
  else if (typeof value === 'number') into.add(String(value));
  else if (Array.isArray(value)) for (const item of value) scalarLeavesOf(item, into);
  else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) scalarLeavesOf(item, into);
  }
  return into;
}

/**
 * Records each scalar leaf of `stored` (a pre-v11 record's stored plaintext at
 * a `NoEcho` position its migration witness found different,
 * go-to-k/cdkd#4741) as a LOG-ONLY needle of the print-only `registry`, except
 * the mask itself and any leaf the desired side holds in the clear at the same
 * coordinate: a shape-moved list or object is compared whole, and its other
 * leaves (`EMAIL`, a threshold) are not the secret. There (`shapeMoved`) a
 * `"true"` / `"false"` string is skipped too, like a boolean: a sibling flag
 * would mask every line saying it. A whole-leaf position records it, being
 * the value itself.
 */
function recordPreviousNoEchoLeaves(
  registry: RecordedSecretValues,
  stored: unknown,
  desiredLeaves: ReadonlySet<string>,
  resolution: RecordedSecretValues,
  shapeMoved: boolean
): void {
  for (const leaf of scalarLeavesOf(stored)) {
    if (leaf === SECRET_MASK || desiredLeaves.has(leaf)) continue;
    if (shapeMoved && (leaf === 'true' || leaf === 'false')) continue;
    recordLogOnlyValue(registry, leaf);
    // A site masking with the resolution bag alone (a provider's capability,
    // a delete error) runs first and can cut a secret embedded in the leaf,
    // leaving a text the whole-leaf needle no longer matches: that spelling
    // is recorded too.
    const partlyMasked = maskSecretsInText(leaf, resolution);
    if (partlyMasked !== leaf && partlyMasked !== SECRET_MASK) {
      recordLogOnlyValue(registry, partlyMasked);
    }
  }
}
