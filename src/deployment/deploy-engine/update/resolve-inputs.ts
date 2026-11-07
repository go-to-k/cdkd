import { childLostWithRecreatedParent } from '../../child-of-recreated-parent.js';
import { type DeployEngine } from '../../deploy-engine.js';
import { noteSecretNamedRecord, registerNoEchoAttributes, secretNameBagFor } from '../masking.js';
import { auditResolvedAssetReferences } from '../record-shape.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import { type ResourceChange, type ResourceState } from '../../../types/state.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { getLiveRenderer } from '../../../utils/live-renderer.js';
import { keyOrderFreeJson } from '../../deploy-value-equality.js';
import {
  canonicalCoordinates,
  carriesSecretMask,
  noEchoCoordinatesOf,
  noEchoLeavesOf,
  recordNestedStackParameterExpressions,
  valueAtCoordinate,
  recordPassedNoEchoParameters,
} from '../../secret-redaction.js';
import {
  classifyPassedParameters,
  inputFingerprinter,
  maskedInputFingerprintsFor,
  movedMaskedProperties,
  possiblyMaskedKeys,
  recordPassedParameterClasses,
} from '../../masked-property-fingerprints.js';
import {
  buildResolverContext,
  maskedInputSources,
  printNestedStackReadsOnly,
} from '../resolver-context.js';
import { noEchoAttributeOverridesFor, noEchoPositionSources } from '../noecho.js';
import { isWhollyMask } from './helpers.js';

/**
 * The first phase of `provisionUpdate`: the record, the resolved bag and
 * where its `NoEcho` values sit. Split out of `deploy-engine/update.ts`
 * (go-to-k/cdkd#5835); the statements run in their original order.
 */
export async function resolveUpdateInputs(
  engine: DeployEngine,
  logicalId: string,
  change: ResourceChange,
  stateResources: Record<string, ResourceState>,
  stackName: string,
  template?: CloudFormationTemplate,
  parameterValues?: Record<string, unknown>,
  conditions?: Record<string, boolean>
) {
  const resourceType = change.resourceType;
  // Existing state record (UPDATE / DELETE) — load-bearing for the
  // sticky `provisionedBy` routing introduced in #614: a resource
  // first created via Cloud Control (because its template had
  // SDK-unwired properties at the time) stays on Cloud Control for
  // every subsequent update / delete, even if the SDK provider has
  // since gained property coverage.
  const existingState = stateResources[logicalId];
  const renderer = getLiveRenderer();
  const currentResource = existingState;
  if (!currentResource) {
    throw new Error(safeMsg`Cannot update ${logicalId}: resource not found in state`);
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
  // WRITTEN removed. For a resource recorded on that route an SDK-unwired
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
  // by `tests/unit/provisioning/sdk-unwired-guard-key-disjointness.test.ts`
  // — but "inert today" is not a reason to widen a guard's input.
  //
  // Bound BELOW, once the resolved bag exists: a create-only drop stays in
  // it only while this deploy still accepts it (issue #2790), which is a
  // question about the desired side.

  // Resolve intrinsic functions in properties
  const context = buildResolverContext(
    engine.resolverContextDeps(),
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
  engine.secretsRun.perResourceSecrets.set(logicalId, updateSecrets);
  // go-to-k/cdkd#4043 §3.3: what a HELD producer's declared `NoEcho`
  // attributes serve this resolution, read back from AWS (never persisted).
  const noEchoOverrides = await noEchoAttributeOverridesFor(
    engine.noEchoRun,
    engine.noEchoDeps(),
    desiredProps,
    stateResources,
    stackName
  );
  if (noEchoOverrides !== undefined) context.noEchoAttributeOverrides = noEchoOverrides;
  printNestedStackReadsOnly(context, resourceType, secretNameBagFor(engine.secretsRun, logicalId));
  const resolvedProps = (await engine.resolver.resolve(desiredProps, context)) as Record<
    string,
    unknown
  >;
  // go-to-k/cdkd#3869: the name this deploy resolved, before the provider
  // prints it (a rename, or a replacement's new resource).
  noteSecretNamedRecord(engine.secretsRun, logicalId, {
    resourceType,
    physicalId: stateResources[logicalId]?.physicalId,
    properties: resolvedProps,
  });
  // The #2274 refusal of a redacted read runs BELOW the no-change skip
  // (go-to-k/cdkd#3662), not here; see the note at that call.
  // Same position source on the UPDATE path (#1904).
  engine.secretsRun.perResourceTemplateProps.set(logicalId, desiredProps);
  engine.secretsRun.perResourceResolvedType.set(logicalId, resourceType);
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

  auditResolvedAssetReferences(engine.options, logicalId, resourceType, resolvedProps);

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
    recreatedUnderSameId: engine.replacementRun.recreatedUnderSameId,
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
  registerNoEchoAttributes(
    engine.secretsRun,
    engine.maskingDeps(),
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
  const noEchoSources = noEchoPositionSources(
    engine.noEchoRun,
    stateResources,
    template,
    conditions
  );
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
    engine.noEchoRun.noEchoPositionedValues.set(
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
    template &&
    maskedInputSources(
      engine.resolverContextDeps(),
      template,
      stateResources,
      conditions,
      stackName
    );
  const fingerprints = fingerprintSources && inputFingerprinter(desiredProps, fingerprintSources);
  const movedMasked = new Set(
    await movedMaskedProperties(currentResource, desiredProps, fingerprints)
  );
  // What the save stamps if this deploy writes the record: the input
  // fingerprint of each property it may record as the mask.
  if (fingerprints !== undefined) {
    engine.secretsRun.perResourceInputFingerprints.set(
      logicalId,
      await maskedInputFingerprintsFor(
        possiblyMaskedKeys(resolvedProps, [
          updateSecrets,
          engine.secretsRun.fingerprintNoEchoValues,
          engine.options.inheritedSecrets,
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
      noEchoPositionSources(engine.noEchoRun, stateResources)
    );
  }
  if (fingerprintSources !== undefined && resourceType === 'AWS::CloudFormation::Stack') {
    recordPassedParameterClasses(
      updateSecrets,
      await classifyPassedParameters(desiredProps['Parameters'], fingerprintSources)
    );
  }
  return {
    resourceType,
    renderer,
    currentResource,
    oldResourceType,
    typeChanged,
    desiredProps,
    currentProps,
    context,
    updateSecrets,
    resolvedProps,
    lostChild,
    lostWithParent,
    noEchoSources,
    parameterCoordinates,
    attributeCoordinates,
    staleCoordinates,
    comparisonCoordinates,
    movedMasked,
  };
}

/** What {@link resolveUpdateInputs} hands the later phases. */
export type ResolvedUpdateInputs = Awaited<ReturnType<typeof resolveUpdateInputs>>;
