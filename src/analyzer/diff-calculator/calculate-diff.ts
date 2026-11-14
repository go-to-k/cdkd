import type { CloudFormationTemplate } from '../../types/resource.js';
import type { StackState, ResourceChange, PropertyChange } from '../../types/state.js';
import { acceptedCreateOnlyDropsOf } from '../../types/state.js';
import {
  withoutAcceptedSdkUnwiredProperties,
  withoutUnwrittenSdkUnwiredProperties,
} from '../../provisioning/property-coverage.js';
import {
  refuseMalformedResourceEntriesForDeploy,
  refuseMalformedResourceProperties,
} from '../../state/malformed-resources-bag.js';
import {
  inputFingerprinter,
  movedMaskedProperties,
  type MaskedInputSources,
} from '../../deployment/masked-property-fingerprints.js';
import type { MaskerFn } from '../../provisioning/masked-retry-logger.js';
import { safeMsg } from '../../utils/display-safe.js';
import type { LockRecoveryContext } from '../../state/lock-contention-message.js';
import { isPlainReferenceTo } from '../../deployment/recreate-target-readers.js';
import { unsettledPropertiesOf } from '../../state/unsettled-properties.js';
import type { ReadProvenanceSources } from '../read-provenance-promotion.js';
import { DiffCalculator } from '../diff-calculator.js';
import {
  type IntrinsicResolveFn,
  type CanonicalizePropertiesFn,
  type NoEchoCompareFn,
  siblingsOf,
} from './shared.js';

/**
 * Calculate changes needed to reach desired state
 *
 * @param currentState Current stack state (use existing state or create a new StackState with empty resources for new stacks)
 * @param desiredTemplate Desired CloudFormation template
 * @param resolveFn Optional intrinsic resolver. When provided, desired properties are
 *                  resolved against current state before comparison so that changes
 *                  buried inside intrinsics (e.g. `Fn::Join` literal args) are detected.
 *                  If resolution throws for a given property value, the unresolved
 *                  value is used (falling back to the original "assume equal" behavior).
 * @param canonicalizeProperties Optional per-type normalization applied to BOTH
 *                  comparison sides (issue #1591) — see {@link CanonicalizePropertiesFn}
 *                  for why one-sided normalization breaks the very population it is
 *                  meant to fix. Injected as a function rather than as a provider
 *                  registry so the analyzer layer keeps no dependency on the
 *                  provisioning layer.
 * @param allowedUnsupportedProperties the deploy's
 *                  `--allow-unsupported-properties` set, as `<Type>:<Prop>`
 *                  tokens (issue #2750). Passed as DATA, not as a function:
 *                  the rule it feeds lives in `property-coverage.ts`, which
 *                  this module already reaches for `create-only-properties`,
 *                  so injecting a predicate would create a second spelling of
 *                  the routing question. `cdkd diff` registers no such flag
 *                  and correctly passes nothing — its preview is the
 *                  flag-less deploy.
 * @returns Map of logical ID to resource change
 */
export async function calculateDiff(
  this: DiffCalculator,
  currentState: StackState,
  desiredTemplate: CloudFormationTemplate,
  resolveFn?: IntrinsicResolveFn,
  canonicalizeProperties?: CanonicalizePropertiesFn,
  allowedUnsupportedProperties?: ReadonlySet<string>,
  /**
   * Template parameters whose value carries a `NoEcho` value supplied in
   * THIS deploy (go-to-k/cdkd#3717) — only a nested child engine passes any.
   * Such a value compares `***` against the recorded `***`, so a resource
   * reading the parameter diffs NO_CHANGE however the value moved; each one
   * is promoted instead, and the engine decides from the resolved value.
   */
  freshParameters?: ReadonlySet<string>,
  /**
   * The PRINTING masker over the bag `resolveFn` records into
   * (go-to-k/cdkd#4049): the deploy's diff resolver resolves a `Ref` to a
   * `NoEcho` parameter to its plaintext and records it there as a log-only
   * needle, and the replacement debug line below prints resolved values.
   * It masks the LOG LINE only; the returned changes carry the values
   * unmasked, since the engine compares and provisions from them. Absent
   * prints unmasked, as before.
   */
  maskForLog?: MaskerFn,
  /**
   * The `--recreate-via-*` targets of THIS stack (go-to-k/cdkd#4383),
   * already scoped by the caller to the stack the ids were validated
   * against. The flag moves a resource between provisioning layers, which
   * is no template edit, so nothing in the diff says it will be replaced;
   * but it is destroyed and re-created, and a type whose physical id AWS
   * assigns (`restApiId`, a security group's `GroupId`) comes back under a
   * new one. Each target with a record to recreate (a `NO_CHANGE` or
   * `UPDATE` row) seeds the replacement pass as a property-driven
   * replacement would, so its `Ref` / `Fn::GetAtt` readers are promoted.
   * The target's own row is left as diffed: the engine routes it to the
   * replacement from the flag, not from this set.
   */
  recreateTargets?: ReadonlySet<string>,
  /**
   * Where a masked property's resolved inputs come from (go-to-k/cdkd#4543):
   * with it, a record's layout-2 fingerprint is compared against today's
   * inputs, so a changed parameter, a replaced resource's `Ref` or a flipped
   * condition behind unchanged template text diffs. Each layout-1
   * fingerprint whose text is unchanged is re-baselined into `rebaselined`
   * (logical id -> property -> fingerprint), which only the deploy passes
   * and stamps. Absent, a layout-2 fingerprint reads as unmoved.
   */
  maskedInputs?: {
    sources: MaskedInputSources;
    rebaselined?: Map<string, Record<string, string>>;
  },
  /**
   * The run's account flags (go-to-k/cdkd#4159), carried on the two
   * refusals' `cdkd state show` pointer. Trusted CLI values, unlike the
   * record's own identity fields, so they ride where the identity does not.
   */
  refusalRecovery?: LockRecoveryContext,
  /**
   * go-to-k/cdkd#4043: rewrites both compared bags the way the persist side
   * stores a `NoEcho` value (see {@link NoEchoCompareFn}). Absent compares
   * them as resolved.
   */
  noEchoCompare?: NoEchoCompareFn,
  /**
   * State schema v12 (go-to-k/cdkd#4852): the domain members outside this
   * stack's records for the read-provenance arm (a nested child's inherited
   * snapshot, a producer output's provenance). Absent, the arm reads this
   * stack's records only.
   */
  readProvenance?: ReadProvenanceSources,
  /**
   * go-to-k/cdkd#6282: nested-stack rows whose child holds a pre-#6272 SSM
   * parameter name (`checkNestedSsmNames`). Each one diffed `NO_CHANGE` or
   * `UPDATE` is an UPDATE marked `nestedChildHeal`, before the promotion
   * passes, so a reader of its `Outputs.<Key>` is promoted as for any
   * updated nested stack.
   */
  forcedNestedChildRuns?: ReadonlySet<string>
): Promise<Map<string, ResourceChange>> {
  const changes = new Map<string, ResourceChange>();

  // REFUSE a record whose `properties` bag cannot be read as a map, before
  // anything dereferences it (issue
  // [#3191](https://github.com/go-to-k/cdkd/issues/3191)).
  //
  // WHY HERE AND NOT ON THE FIVE READS. `currentResource.properties` is read
  // five times below — the type-change UPDATE, the SDK-unwired narrowing
  // pair, and the UPDATE / NO_CHANGE / DELETE records — and a guard on each
  // is the shape `src/state/malformed-resources-bag.ts`'s header records as
  // INERT: the first cut of go-to-k/cdkd#3018 put `?? {}` on twelve
  // `Object.entries` sites and every flow had already dereferenced the
  // container a line earlier. This is the point where `currentState` ENTERS
  // this module, so one call dominates all five reads AND the comparison
  // they feed.
  //
  // WHY A REFUSAL. A non-object bag compares unequal to any desired object,
  // so every property the template declares reads as absent-in-current; a
  // create-only one among them (`AWS::S3::Bucket`'s `BucketName` is the
  // measured case) is turned into `requiresReplacement: true` by
  // `compareProperties` below, and `DeployEngine` REPLACES the live
  // resource. Reading the bag as empty instead does not avoid that —
  // measured, a stored `[]` and a stored `5` enumerate no keys and reach the
  // identical replacement verdict — so a planted or torn record must stop
  // the run rather than be repaired into one.
  // `refuseMalformedResourceProperties`'s own doc carries the measurement
  // and the cost of refusing.
  //
  // There are exactly TWO callers of this method
  // (`grep -rn '\.calculateDiff(' src/`): `deploy-engine.ts`, which
  // provisions — a nested child reaches it through its own child engine —
  // and `diff-recursive.ts`, which does not. The read-only one repairs and
  // warns BEFORE calling, at its own load AND again after it splices adopted
  // rollback orphans in, which is the read-only / write-capable split this
  // module's siblings already take. A new caller that forgets gets the
  // refusal, which is the fail-safe direction.
  //
  // NO IDENTITY IS PASSED, and that is the decision rather than an
  // omission. The only stack name and region in reach are
  // `currentState.stackName` / `.region`, fields of the very record being
  // declared malformed, which `parseStateBody` never validates — so a
  // planted one would make the refusal name a DIFFERENT, healthy stack and
  // aim its pasteable remedy at that record instead (review of #3191).
  // `stackClause` in `src/state/malformed-resources-bag.ts` carries the
  // full reasoning and the shape a later lane threads a TRUSTED pair into.
  //
  // WHAT THIS DOES NOT GUARD, stated because everything above reads as "the
  // deploy diff is now covered" and it is only covered ONE LEVEL DOWN.
  // `unreadableResourcePropertyBags` walks ENTRIES, so it returns `[]` when
  // the ROOT `resources` bag is itself unreadable — its own doc ends "What a
  // caller must not do is take only this one". Neither caller takes only
  // this one any more: `deploy-engine.ts` calls
  // `refuseMalformedResourcesForDeploy` at its state load, above this call
  // (go-to-k/cdkd#3161), and `diff-recursive.ts` repairs the root bag and
  // warns before it. So this method is still reachable ONLY with a readable
  // root bag, and a guard for that class here would be a second spelling of
  // a decision made one layer up, where it also dominates every read of the
  // bag between the two (five, measured 2026-09-17 over comment-stripped
  // source; re-derive rather than trusting this figure).
  //
  // The ENTRY refusal comes first (go-to-k/cdkd#3314). A row that is not a
  // readable resource record reads as absent at the lookup below and is
  // planned as a CREATE of a resource cdkd already manages. A row with no
  // `resourceType` is planned as a type-change replacement. Same placement
  // and same no-identity decision as the `properties` refusal. It goes first
  // so a typeless row with a torn map is reported as the row it is.
  // `DeployEngine` also refuses at its state load, which a deploy reaches
  // first: two walks between that load and this call died on such a row.
  refuseMalformedResourceEntriesForDeploy(currentState, undefined, undefined, refusalRecovery);
  refuseMalformedResourceProperties(currentState, undefined, undefined, refusalRecovery);

  const currentResources = currentState.resources;
  const desiredResources = desiredTemplate.Resources;

  this.logger.debug('Calculating diff...');
  this.logger.debug(`Current resources: ${Object.keys(currentResources).length}`);
  this.logger.debug(`Desired resources: ${Object.keys(desiredResources).length}`);

  // Track which resources we've seen
  const processedLogicalIds = new Set<string>();

  // Snapshot each resource's `Fn::GetAtt` / `Fn::Sub`-`${X.Attr}` references
  // from the RAW template, in one pass, for promoteInPlaceAttributeDependents
  // below: it needs the references a property DECLARED, while the comparison
  // loop works on RESOLVED values, where a GetAtt to an
  // in-place-referenceable resource has already been replaced by its resolved
  // current value. A PRECOMPUTATION rather than a rescue — that function also
  // receives `desiredTemplate` and could re-extract from it, since the raw
  // template survives the loop: the `try` arm clones, and the `catch` arm
  // only aliases the leaf into a bag no consumer mutates.
  // (This note used to say the loop "mutates in place" the desired property
  // intrinsics. It has not since go-to-k/cdkd#939 added the clone in the same
  // change that wrote the note; BEFORE that commit the loop ran the real
  // resolver over the template leaf itself, and `resolveSub` wrote its
  // resolved values back into the caller's `Fn::Sub` variable map.)
  const rawGetAttRefs = new Map<string, Map<string, Map<string, Set<string>>>>();
  for (const [logicalId, desiredResource] of Object.entries(desiredResources)) {
    if (desiredResource.Type === 'AWS::CDK::Metadata') continue;
    const perProp = new Map<string, Map<string, Set<string>>>();
    for (const [propKey, propValue] of Object.entries(desiredResource.Properties ?? {})) {
      const refs = DiffCalculator.extractGetAttRefs(propValue);
      if (refs.size > 0) perProp.set(propKey, refs);
    }
    if (perProp.size > 0) rawGetAttRefs.set(logicalId, perProp);
  }

  // Check for CREATE and UPDATE
  for (const [logicalId, desiredResource] of Object.entries(desiredResources)) {
    // Skip CDK metadata resources (they don't actually deploy anything)
    if (desiredResource.Type === 'AWS::CDK::Metadata') {
      this.logger.debug(`Skipping metadata resource: ${logicalId}`);
      processedLogicalIds.add(logicalId);
      continue;
    }

    processedLogicalIds.add(logicalId);

    const currentResource = currentResources[logicalId];

    if (!currentResource) {
      // Resource doesn't exist in current state -> CREATE
      changes.set(logicalId, {
        logicalId,
        changeType: 'CREATE',
        resourceType: desiredResource.Type,
        desiredProperties: desiredResource.Properties || {},
      });
      this.logger.debug(`CREATE: ${logicalId} (${desiredResource.Type})`);
    } else if (currentResource.resourceType !== desiredResource.Type) {
      // Resource type changed -> requires replacement (DELETE + CREATE)
      // For simplicity, we'll mark this as UPDATE with requiresReplacement
      const propertyChanges: PropertyChange[] = [
        {
          path: 'Type',
          oldValue: currentResource.resourceType,
          newValue: desiredResource.Type,
          requiresReplacement: true,
        },
      ];

      changes.set(logicalId, {
        logicalId,
        changeType: 'UPDATE',
        resourceType: desiredResource.Type,
        currentProperties: currentResource.properties,
        desiredProperties: desiredResource.Properties || {},
        propertyChanges,
      });
      this.logger.debug(
        `UPDATE (Type change): ${logicalId} (from ${currentResource.resourceType} to ${desiredResource.Type})`
      );
    } else {
      // Resource exists with same type -> check properties.
      //
      // State stores already-resolved values (e.g. "my-bucket-value"), while the
      // template holds unresolved intrinsics (e.g. { "Fn::Join": [...] }). When an
      // intrinsic wraps literal content that changed (e.g. "-value" -> "-value2"),
      // a naive comparison would short-circuit on the intrinsic node and miss the
      // change. Resolving desired props against current state first avoids that.
      const rawDesiredProps = desiredResource.Properties || {};
      const resolvedDesiredProps = resolveFn
        ? await this.resolveBestEffort(rawDesiredProps, resolveFn)
        : rawDesiredProps;
      // Narrow the same way the provider narrows what it SENDS, so a
      // deliberate narrowing (issue #1591) is not re-read as a change the
      // user made. Applied AFTER resolution: the provider decides on
      // resolved values, so deciding on an unresolved intrinsic here would
      // disagree with it.
      //
      // BOTH SIDES, which is the whole rule and not a symmetry nicety.
      // Narrowing only the desired side fixes the freshly-written record and
      // BREAKS the population this exists for: a state record written before
      // the provider started narrowing still carries every key, so the loser
      // reads as REMOVED, and for a create-only property that is a
      // REPLACEMENT whose create the engine issues with no context — landing
      // on the provider's create-path refusal and failing a deploy that was
      // green the day before. State can only carry the wider bag when it is
      // junk, so narrowing it here is safe.
      // `drift-normalize.ts` records the same rule for ordering.
      //
      // NOT self-healing, and the comment used to claim otherwise: an
      // otherwise-unchanged template now diffs NO_CHANGE, so no write happens
      // and the wide record survives. `cdkd drift --revert` is what clears
      // it. That residue is the (#1612) already-junk class.
      //
      // The CURRENT side is left alone for a cc-api-routed resource:
      // `CloudControlProvider` sends and records the FULL bag and reports no
      // `effectiveProperties`, so its record is not a narrowing artifact and
      // narrowing it here would hide a real difference.
      // Issue #2750, applied BEFORE the provider narrowing above and gated on
      // the SAME `provisionedBy !== 'cc-api'` question, because it asks the
      // same thing one layer down: does this bag describe the SDK route, on
      // which an SDK-unwired property never reaches AWS?
      //
      // The two sides take DIFFERENT rules and the asymmetry is the fix:
      //
      // - RECORD side, every SDK-unwired property for the type (a create-only one
      //   only once this deploy stops accepting it). A resource recorded
      //   `provisionedBy: 'sdk'` cannot have had one written, whatever flags
      //   were passed then, so its presence is junk — and removing it is what
      //   makes a record written before this fix heal: the key reads as an
      //   ADDITION, so the deploy is no longer NO_CHANGE, the auto-route
      //   fires, and Cloud Control sends the property.
      // - DESIRED side, only the drops THIS deploy opted into. An un-allowed
      //   drop auto-routes the resource to Cloud Control, which forwards the
      //   full map, so narrowing it here would hide a real difference — the
      //   same reason the current side is skipped for a `cc-api` record.
      //
      // Both sides narrowed together is what keeps a flag-ful redeploy quiet:
      // record-side alone would report the template's key as added on EVERY
      // deploy, and for a create-only property that is a REPLACEMENT of a
      // resource nobody touched (`CanonicalizePropertiesFn`'s contract in
      // src/types/resource.ts spells out that failure for issue #1591).
      const sdkRouted = currentResource.provisionedBy !== 'cc-api';
      const desiredAfterDrops =
        sdkRouted && allowedUnsupportedProperties
          ? withoutAcceptedSdkUnwiredProperties(
              desiredResource.Type,
              resolvedDesiredProps,
              allowedUnsupportedProperties,
              currentResource.properties
            )
          : resolvedDesiredProps;
      // A create-only drop the record names in `acceptedCreateOnlyDrops`
      // stays on the record side only while THIS deploy accepts it, so a
      // flag removed since reads it as an addition, which is a replacement
      // the engine refuses unless opted into (issue #2790). No allow set
      // (`cdkd diff`) is the flag-less deploy.
      const currentAfterDrops = sdkRouted
        ? withoutUnwrittenSdkUnwiredProperties(
            desiredResource.Type,
            currentResource.properties,
            resolvedDesiredProps,
            allowedUnsupportedProperties ?? new Set<string>(),
            acceptedCreateOnlyDropsOf(currentResource)
          )
        : currentResource.properties;

      const desiredPropsForCompare = canonicalizeProperties
        ? canonicalizeProperties(desiredResource.Type, desiredAfterDrops)
        : desiredAfterDrops;
      const currentPropsForCompare =
        canonicalizeProperties && sdkRouted
          ? canonicalizeProperties(desiredResource.Type, currentAfterDrops)
          : currentAfterDrops;

      // ANNOUNCE the narrowing. The whole design rests on it being a
      // deliberate, stated decision (`EffectivePropertiesResult`'s contract);
      // on the provisioning path the provider's warn arm says so, but this
      // path never calls the provider — so without this, a template edit to a
      // LOSING key is discarded with zero output, and a user "fixing" the
      // wrong destination key would see cdkd report nothing at all.
      //
      // Announce only a LOSSY narrowing — one that DROPS a declared key. A
      // narrowing that rewrites a value IN PLACE (issue #1633: an unquoted
      // YAML `IpProtocol: -1` is stringified to `'-1'` before it is sent) is
      // not lossy, and every clause of the message below is false for it:
      // the value IS sent, it is NOT ignored, and a change to it DOES take
      // effect. Warning there fired on every `cdkd diff` and every `cdkd
      // deploy` of an otherwise-unchanged stack, telling the user their
      // template was broken when it was not.
      //
      // The key-set test is what separates the two, and it needs no provider
      // opt-in: `narrowRouteDestinations` deletes the losing destination
      // keys, while `narrowIngressIpProtocol` returns the same key set.
      // Measured against `desiredAfterDrops`, NOT the raw resolved bag: the
      // #2750 narrowing above also drops keys, and they must not reach this
      // warning. Its remedy ("Fix the template to declare only what the
      // resource supports") is wrong for a drop the user opted INTO, and
      // `ProviderRegistry.reportSdkUnwiredDecisions` already warns about
      // those every deploy with the accurate wording.
      const droppedKeys = canonicalizeProperties
        ? Object.keys(desiredAfterDrops).filter(
            (key) => !Object.hasOwn(desiredPropsForCompare, key)
          )
        : [];
      if (droppedKeys.length > 0) {
        this.logger.warn(
          `${logicalId} (${desiredResource.Type}): part of the declared properties cannot be ` +
            `sent as declared and is ignored when comparing against deployed state — the ` +
            `provider narrows them (${droppedKeys.join(', ')}). Fix the template to declare ` +
            `only what the resource supports; until then changes to the ignored keys have ` +
            `no effect.`
        );
      } else if (
        canonicalizeProperties &&
        !this.valuesEqual(desiredPropsForCompare, desiredAfterDrops)
      ) {
        this.logger.debug(
          `${logicalId} (${desiredResource.Type}): the provider normalizes part of the ` +
            `declared properties before sending them; the comparison uses the normalized ` +
            `form. Nothing is dropped.`
        );
      }

      // go-to-k/cdkd#4043: compare what the persist side WRITES. A leaf a
      // `NoEcho` source served is `***` in state, so the desired side is
      // masked the same way, and a pre-v11 record's stored plaintext is
      // read as the migration witness. Supplied by the caller, which holds
      // the template's `NoEcho` declarations and the deploy's verdicts.
      const noEchoCompared = noEchoCompare?.({
        logicalId,
        resourceType: desiredResource.Type,
        templateProperties: rawDesiredProps,
        desired: desiredPropsForCompare,
        current: currentPropsForCompare,
      });
      const desiredCompared = noEchoCompared?.desired ?? desiredPropsForCompare;
      const currentCompared = noEchoCompared?.current ?? currentPropsForCompare;
      const propertyChanges = await this.compareProperties(
        desiredResource.Type,
        currentCompared,
        desiredCompared,
        maskForLog
      );
      // go-to-k/cdkd#4451: a property the record holds as `***` compares
      // equal to a template that resolves to `***` whatever the edit around
      // the secret reference. The record's fingerprint of the UNRESOLVED
      // template value it was written from says whether that edit happened.
      // Only a property both compared sides still hold equal is added; a
      // record with no fingerprint (an older cdkd's) adds nothing.
      // go-to-k/cdkd#4543: and, where the record's fingerprint covers the
      // inputs, whether a parameter, a referenced resource or a condition
      // behind that text moved.
      const reported = new Set(propertyChanges.map((pc) => pc.path));
      const rebaselined: Array<[string, string]> = [];
      const moved = await movedMaskedProperties(
        currentResource,
        rawDesiredProps,
        maskedInputs && inputFingerprinter(rawDesiredProps, maskedInputs.sources),
        maskedInputs?.rebaselined && ((key, fingerprint) => rebaselined.push([key, fingerprint]))
      );
      if (rebaselined.length > 0) {
        maskedInputs!.rebaselined!.set(logicalId, Object.fromEntries(rebaselined));
      }
      for (const key of moved) {
        if (reported.has(key)) continue;
        if (!Object.hasOwn(currentCompared, key)) continue;
        if (!Object.hasOwn(desiredCompared, key)) continue;
        const oldValue = currentCompared[key];
        const newValue = desiredCompared[key];
        propertyChanges.push({
          path: key,
          oldValue,
          newValue,
          requiresReplacement: await this.maskedEditRequiresReplacement(
            desiredResource.Type,
            key,
            oldValue,
            newValue,
            { oldProperties: currentCompared, newProperties: desiredCompared }
          ),
          maskedExpressionChanged: true,
        });
        this.logger.debug(
          safeMsg`${logicalId}: ${key} is recorded masked and its template expression or a resolved input changed`
        );
      }
      // go-to-k/cdkd#5380: a key an earlier failed update left unsettled
      // may hold either side in AWS, so it is an in-place change even when
      // the template and the record agree: the deploy re-sends it and the
      // provider converges it against AWS.
      const listed = new Set(propertyChanges.map((pc) => pc.path));
      for (const key of unsettledPropertiesOf(currentResource)) {
        if (listed.has(key)) continue;
        propertyChanges.push({
          path: key,
          oldValue: currentCompared[key],
          newValue: desiredCompared[key],
          requiresReplacement: false,
          unsettled: true,
        });
        this.logger.debug(
          safeMsg`${logicalId}: ${key} is unsettled after a failed update and is sent again`
        );
      }

      // Schema v5+ template-attribute diff: `DeletionPolicy` /
      // `UpdateReplacePolicy` may change without any property change. cdkd
      // pre-v5 silently reported `No changes detected` for those, so a
      // user who removed `RemovalPolicy.DESTROY` from their CDK code saw
      // nothing happen on the next deploy. Detect them here too so the
      // attribute flip is surfaced (and the deploy engine refreshes the
      // value in state).
      const attributeChanges = this.compareAttributes(currentResource, desiredResource);

      if (propertyChanges.length > 0 || attributeChanges.length > 0) {
        // Property and/or attribute changed -> UPDATE
        changes.set(logicalId, {
          logicalId,
          changeType: 'UPDATE',
          resourceType: desiredResource.Type,
          currentProperties: currentResource.properties,
          desiredProperties: rawDesiredProps,
          propertyChanges,
          ...(attributeChanges.length > 0 && { attributeChanges }),
        });
        this.logger.debug(
          `UPDATE: ${logicalId} (${propertyChanges.length} property changes, ${attributeChanges.length} attribute changes)`
        );
      } else {
        // No changes -> NO_CHANGE
        changes.set(logicalId, {
          logicalId,
          changeType: 'NO_CHANGE',
          resourceType: desiredResource.Type,
          currentProperties: currentResource.properties,
          desiredProperties: rawDesiredProps,
        });
        this.logger.debug(`NO_CHANGE: ${logicalId}`);
      }
    }
  }

  // Check for DELETE (resources in current state but not in desired template)
  for (const [logicalId, currentResource] of Object.entries(currentResources)) {
    if (!processedLogicalIds.has(logicalId)) {
      changes.set(logicalId, {
        logicalId,
        changeType: 'DELETE',
        resourceType: currentResource.resourceType,
        currentProperties: currentResource.properties,
      });
      this.logger.debug(`DELETE: ${logicalId} (${currentResource.resourceType})`);
    }
  }

  for (const logicalId of forcedNestedChildRuns ?? []) {
    const change = changes.get(logicalId);
    if (change?.resourceType !== 'AWS::CloudFormation::Stack') continue;
    if (change.changeType === 'NO_CHANGE') {
      change.changeType = 'UPDATE';
      change.propertyChanges = [];
    }
    if (change.changeType === 'UPDATE') change.nestedChildHeal = true;
  }

  // The `--recreate-via-*` targets that seed the replacement pass below
  // (go-to-k/cdkd#4383). A recreate target with no record to recreate (a
  // CREATE or DELETE row, or none) replaces nothing, so it seeds nothing.
  const forcedReplacements = new Set<string>();
  for (const logicalId of recreateTargets ?? []) {
    const changeType = changes.get(logicalId)?.changeType;
    if (changeType === 'NO_CHANGE' || changeType === 'UPDATE') forcedReplacements.add(logicalId);
  }

  // Propagate replacements to dependents (issue #807): a dependent whose
  // only "change" is a Ref / Fn::GetAtt to a resource that will be
  // REPLACED resolves against CURRENT state above and lands on NO_CHANGE,
  // even though the reference's value (new physical ID / ARN) WILL change.
  //
  // Propagate IN-PLACE attribute changes to dependents (bug-hunt 2026-06-29):
  // a dependent that embeds `Fn::GetAtt[Up, Attr]` (e.g. an SSM Parameter whose
  // Value is `Fn::Sub[..., {V: Fn::GetAtt[Base, Value]}]`) resolves against the
  // CURRENT state above, so when `Up`'s in-place UPDATE changes the property
  // `Attr` names, the dependent's resolved value DID change but it lands on
  // NO_CHANGE and never re-provisions -> stale. Unlike a replacement (where the
  // physical id always changes, so EVERY reference is affected), here only a
  // GetAtt whose attribute NAME matches a CHANGED property of the upstream is
  // affected -- a `Ref` (physical id, unchanged in-place) or a GetAtt of an
  // unchanged / computed attribute (e.g. a Lambda `Arn`, which does not move on
  // an in-place Description update) is correctly left NO_CHANGE.
  //
  // Run to a FIXPOINT (issue #3631). An in-place promotion can create an
  // upstream either pass seeds from: a nested stack whose `Parameters` read
  // a sibling stack's output becomes an in-place UPDATE, which makes a
  // reader of ITS outputs stale in turn, and a promotion whose referencing
  // property is create-only is a REPLACEMENT, whose `Ref` readers only the
  // replacement pass promotes. The replacement pass is transitive on its own
  // and runs before each in-place pass, so the in-place pass's verdict alone
  // decides whether another round is needed. It skips a path already
  // present, so the loop ends at the latest once every referencing property
  // carries a change.
  // State schema v12 (go-to-k/cdkd#4852): the READ-PROVENANCE arm, ONCE and
  // BEFORE the fixpoint, from records alone (no AWS call but a gated producer
  // state read): a reader whose recorded `readVersions` its upstreams no
  // longer hold is promoted, and the passes below carry the promotion on
  // transitively. Its rows seed the create-only load below, so each
  // synthetic change's ceiling is set once that load is in hand.
  const provenanceChanges = await this.promoteReadProvenanceDependents(
    changes,
    currentState,
    desiredTemplate,
    readProvenance
  );
  // The schema createOnly paths both promotion passes consult for a type the
  // registry does not classify (go-to-k/cdkd#3803), loaded once here because
  // the passes are synchronous.
  const syntheticCreateOnlyPaths = await this.loadSyntheticCreateOnlyPaths(
    changes,
    desiredTemplate,
    rawGetAttRefs,
    freshParameters,
    forcedReplacements
  );
  // The replacement CEILING of a read-derived create-only leaf (#4701's
  // `isPlainReferenceTo` for the write-only exclusion), as a replacement
  // pass sets it: the engine keeps it only when the value it is served moved.
  for (const { change, pc, upstreams } of provenanceChanges) {
    const templateValue = desiredTemplate.Resources[change.logicalId]?.Properties?.[pc.path];
    pc.requiresReplacement = this.syntheticRequiresReplacement(
      change.resourceType,
      pc.path,
      syntheticCreateOnlyPaths,
      upstreams.some((id) =>
        isPlainReferenceTo(templateValue, id, desiredTemplate.Resources[id]?.Type)
      ),
      siblingsOf(change)
    );
  }
  do {
    this.promoteReplacementDependents(
      changes,
      desiredTemplate,
      syntheticCreateOnlyPaths,
      forcedReplacements
    );
  } while (
    this.promoteInPlaceAttributeDependents(
      changes,
      desiredTemplate,
      rawGetAttRefs,
      syntheticCreateOnlyPaths,
      freshParameters
    )
  );

  const summary = this.getSummary(changes);
  this.logger.debug(
    `Diff calculated: ${summary.create} CREATE, ${summary.update} UPDATE, ${summary.delete} DELETE, ${summary.noChange} NO_CHANGE`
  );

  return changes;
}
