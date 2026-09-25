import type { CloudFormationTemplate, TemplateResource } from '../types/resource.js';
import type {
  StackState,
  ChangeType,
  ResourceChange,
  PropertyChange,
  AttributeChange,
  ResourceState,
} from '../types/state.js';
import { getLogger } from '../utils/logger.js';
import { ReplacementRulesRegistry } from './replacement-rules.js';
import { TemplateParser } from './template-parser.js';
import {
  getCreateOnlyPropertyPaths,
  createOnlyChangeRequiresReplacement,
} from '../provisioning/create-only-properties.js';
import {
  withoutAcceptedSilentDropProperties,
  withoutSilentDropProperties,
} from '../provisioning/property-coverage.js';
import {
  refuseMalformedResourceEntriesForDeploy,
  refuseMalformedResourceProperties,
} from '../state/malformed-resources-bag.js';
import { splitGetAttStringForm } from '../deployment/secret-redaction.js';

/**
 * Best-effort resolver for intrinsic functions during diff calculation.
 * Should return the resolved value on success, or the original value if resolution fails.
 * Kept as a callback to avoid circular dependency between analyzer and deployment layers.
 */
export type IntrinsicResolveFn = (value: unknown) => Promise<unknown>;

/**
 * The CloudFormation intrinsic function keys, as a single shared set.
 *
 * Exported so `outputs-diff.ts` detects a surviving intrinsic with exactly the
 * same key list this calculator uses — a second hand-maintained copy is how the
 * two drift into disagreeing about what "unresolved" means.
 */
export const INTRINSIC_KEYS: ReadonlySet<string> = new Set([
  'Ref',
  'Fn::Sub',
  'Fn::GetAtt',
  'Fn::Join',
  'Fn::Select',
  'Fn::Split',
  'Fn::If',
  'Fn::ImportValue',
  'Fn::FindInMap',
  'Fn::Base64',
  'Fn::GetAZs',
  'Fn::Equals',
  'Fn::And',
  'Fn::Or',
  'Fn::Not',
]);

/**
 * Per-type normalization applied to BOTH comparison sides (issue #1591).
 *
 * A provider that deliberately sends LESS than the template declares records
 * the narrowed bag in state (`effectiveProperties`). Without the identical
 * narrowing here the template's extra keys read as a user-made change on every
 * later deploy — and for a create-only property that is a REPLACEMENT, so a
 * previously-green no-op deploy starts destroying and re-creating the resource,
 * or failing outright where the provider refuses the shape on the create path.
 *
 * BOTH sides, not just the desired one: a record written BEFORE the provider
 * started narrowing still carries every key, so a desired-only normalization
 * flips the same difference to a REMOVAL and breaks exactly the population the
 * narrowing exists for. State can only carry the wider bag when it is junk, so
 * normalizing it is safe and the next write self-heals the record.
 * `drift-normalize.ts` records the same both-sides rule for ordering.
 *
 * MUST be pure and synchronous — it runs inside the diff, before any AWS call.
 */
export type CanonicalizePropertiesFn = (
  resourceType: string,
  properties: Record<string, unknown>
) => Record<string, unknown>;

/**
 * Per-type set of computed/derived read-only attributes whose value can change
 * as a side effect of an IN-PLACE update, even though the attribute NAME never
 * appears among the type's template properties (issue #985).
 *
 * The default in-place propagation arm matches a dependent only when the GetAtt
 * attribute NAME equals a template property that CHANGED on the upstream (e.g.
 * an SSM Parameter `Value`). That arm cannot see version-style attributes: an
 * `AWS::EC2::LaunchTemplate` edit changes `LaunchTemplateData`, which bumps the
 * read-only `LatestVersionNumber` from N to N+1 — but `LatestVersionNumber` is
 * NOT a template property, so a dependent reading `Fn::GetAtt[Lt,
 * LatestVersionNumber]` (the canonical `autoscaling.AutoScalingGroup`
 * `LaunchTemplate.Version` shape) is left NO_CHANGE and stays pinned one deploy
 * behind. These attributes resolve LIVE from AWS at deploy time (see the
 * `DescribeLaunchTemplates` special case in intrinsic-function-resolver.ts), so
 * a speculative promotion is safe: the deploy engine re-resolves the dependent
 * against the fresh live value and skips the provider call if it did not move.
 *
 * Keyed by upstream resource type -> the derived attribute names that any
 * in-place UPDATE of that type may move. Kept intentionally narrow (an allow
 * list, not "every read-only attr") so unrelated computed attributes that do
 * NOT track in-place edits (e.g. a Lambda `Arn`) never trigger spurious
 * dependent promotion.
 */
const IN_PLACE_UPDATE_DERIVED_ATTRS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  'AWS::EC2::LaunchTemplate': new Set(['LatestVersionNumber', 'DefaultVersionNumber']),
});

/**
 * The PREFIX twin of {@link IN_PLACE_UPDATE_DERIVED_ATTRS}, for a type whose
 * derived attributes are an open family rather than a fixed list (issue
 * [#3631](https://github.com/go-to-k/cdkd/issues/3631)).
 *
 * A nested stack's `Outputs.<Key>` attributes are the child's outputs, and a
 * child-only change moves them while the parent's `AWS::CloudFormation::Stack`
 * row changes only `TemplateURL` / `Parameters`. The parent's diff runs BEFORE
 * the child deploys, so a reader of `Fn::GetAtt [Child, 'Outputs.<Key>']`
 * resolves against the PREVIOUS value and diffs NO_CHANGE. Which outputs move
 * is decided by the child's own deploy, so it is not knowable here: every
 * reader is promoted, and the deploy engine's re-resolve-and-skip drops the
 * ones whose output did not move.
 */
const IN_PLACE_UPDATE_DERIVED_ATTR_PREFIXES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    'AWS::CloudFormation::Stack': Object.freeze(['Outputs.']),
  });

/**
 * The attribute name {@link DiffCalculator.extractGetAttRefs} records for a
 * `Ref` read (go-to-k/cdkd#3717 / #3722). Not a name any attribute can have, so
 * the property-name, derived-attribute and prefix arms of the in-place pass
 * never match it; only the custom-resource arm (whose physical id the handler
 * may change) and the fresh-parameter arm (a parameter carrying a `NoEcho`
 * value supplied in this deploy) read it.
 */
const REF_READ = '<Ref>';

/**
 * Diff calculator for comparing desired state (template) with current state
 */
export class DiffCalculator {
  private logger = getLogger().child('DiffCalculator');
  private replacementRules = new ReplacementRulesRegistry();
  private parser = new TemplateParser();

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
  async calculateDiff(
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
    freshParameters?: ReadonlySet<string>
  ): Promise<Map<string, ResourceChange>> {
    const changes = new Map<string, ResourceChange>();

    // REFUSE a record whose `properties` bag cannot be read as a map, before
    // anything dereferences it (issue
    // [#3191](https://github.com/go-to-k/cdkd/issues/3191)).
    //
    // WHY HERE AND NOT ON THE FIVE READS. `currentResource.properties` is read
    // five times below — the type-change UPDATE, the silent-drop narrowing
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
    refuseMalformedResourceEntriesForDeploy(currentState, undefined, undefined);
    refuseMalformedResourceProperties(currentState, undefined, undefined);

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
          `UPDATE (Type change): ${logicalId} (${currentResource.resourceType} -> ${desiredResource.Type})`
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
        // which a silent-drop property never reaches AWS?
        //
        // The two sides take DIFFERENT rules and the asymmetry is the fix:
        //
        // - RECORD side, every silent drop for the type. A resource recorded
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
            ? withoutAcceptedSilentDropProperties(
                desiredResource.Type,
                resolvedDesiredProps,
                allowedUnsupportedProperties,
                currentResource.properties
              )
            : resolvedDesiredProps;
        const currentAfterDrops = sdkRouted
          ? withoutSilentDropProperties(desiredResource.Type, currentResource.properties)
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
        // `ProviderRegistry.reportSilentDropDecisions` already warns about
        // those every deploy with the accurate wording.
        const droppedKeys = canonicalizeProperties
          ? Object.keys(desiredAfterDrops).filter((key) => !(key in desiredPropsForCompare))
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

        const propertyChanges = await this.compareProperties(
          desiredResource.Type,
          currentPropsForCompare,
          desiredPropsForCompare
        );

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
    do {
      this.promoteReplacementDependents(changes, desiredTemplate);
    } while (
      this.promoteInPlaceAttributeDependents(
        changes,
        desiredTemplate,
        rawGetAttRefs,
        freshParameters
      )
    );

    const summary = this.getSummary(changes);
    this.logger.debug(
      `Diff calculated: ${summary.create} CREATE, ${summary.update} UPDATE, ${summary.delete} DELETE, ${summary.noChange} NO_CHANGE`
    );

    return changes;
  }

  /**
   * Promote transitive dependents of to-be-replaced resources from
   * NO_CHANGE to UPDATE (issue #807).
   *
   * Diff-time intrinsic resolution runs against the CURRENT state, so a
   * dependent referencing a resource that will be REPLACED (new physical
   * ID — e.g. an `AWS::ECS::TaskDefinition` revision) compares equal and
   * stays NO_CHANGE; the deploy engine then never re-points it at the new
   * physical resource (for ECS: `UpdateService` is never issued and the
   * service keeps running the old, now-deregistered revision).
   * CloudFormation propagates the new physical ID to dependents — mirror
   * that here by walking reverse reference edges (`Ref` / `Fn::GetAtt` /
   * `Fn::Sub` and intrinsics nesting them — the same extraction the DAG
   * builder uses) from every replacement-triggering UPDATE and promoting
   * NO_CHANGE dependents to UPDATE.
   *
   * Promotion is safe even when speculative: the deploy engine re-resolves
   * the promoted resource's properties against the in-flight state map
   * (which the DAG guarantees already carries the dependency's new
   * physical ID) and skips the provider call if nothing actually changed.
   *
   * Promotion is transitive: each referencing property of a promoted
   * dependent is re-evaluated against the replacement rules, and if the
   * dependent is itself replacement-triggering (the referencing property
   * is immutable for its type), its own dependents are promoted in turn.
   * The same re-evaluation also applies to dependents that already had
   * their own (non-replacement) property changes — their referencing
   * property gains a synthetic PropertyChange so a replacement cascade is
   * not masked by an unrelated in-place change.
   */
  private promoteReplacementDependents(
    changes: Map<string, ResourceChange>,
    desiredTemplate: CloudFormationTemplate
  ): void {
    // Seed queue: resources whose computed diff already requires replacement.
    const queue: string[] = [];
    for (const [logicalId, change] of changes) {
      if (
        change.changeType === 'UPDATE' &&
        change.propertyChanges?.some((pc) => pc.requiresReplacement)
      ) {
        queue.push(logicalId);
      }
    }
    if (queue.length === 0) {
      return;
    }

    // Reverse reference edges from the desired template:
    // referencedId -> (dependentId -> top-level property keys referencing it).
    const dependentsOf = new Map<string, Map<string, Set<string>>>();
    for (const [logicalId, resource] of Object.entries(desiredTemplate.Resources)) {
      if (resource.Type === 'AWS::CDK::Metadata') continue;
      for (const [propKey, propValue] of Object.entries(resource.Properties ?? {})) {
        for (const referencedId of this.parser.extractReferences(propValue)) {
          if (referencedId === logicalId) continue; // self-reference defense
          let dependents = dependentsOf.get(referencedId);
          if (!dependents) {
            dependents = new Map();
            dependentsOf.set(referencedId, dependents);
          }
          let propKeys = dependents.get(logicalId);
          if (!propKeys) {
            propKeys = new Set();
            dependents.set(logicalId, propKeys);
          }
          propKeys.add(propKey);
        }
      }
    }

    const enqueued = new Set(queue);
    while (queue.length > 0) {
      const replacedId = queue.shift()!;
      const dependents = dependentsOf.get(replacedId);
      if (!dependents) continue;

      for (const [dependentId, refPropKeys] of dependents) {
        const change = changes.get(dependentId);
        if (!change) continue;
        // CREATE resolves fresh at provisioning time anyway; DELETE is
        // going away — neither needs propagation.
        if (change.changeType !== 'NO_CHANGE' && change.changeType !== 'UPDATE') continue;

        const existingPaths = new Set((change.propertyChanges ?? []).map((pc) => pc.path));
        const syntheticChanges: PropertyChange[] = [];
        for (const propKey of refPropKeys) {
          if (existingPaths.has(propKey)) continue; // already diffed on its own
          const oldValue = change.currentProperties?.[propKey];
          const newValue = change.desiredProperties?.[propKey];
          syntheticChanges.push({
            path: propKey,
            oldValue,
            newValue,
            replacementPropagated: true,
            // Re-evaluate the replacement rules for the dependent itself:
            // if the property carrying the reference is immutable for the
            // dependent's type, the dependent must be replaced too (and
            // its own dependents promoted transitively below).
            //
            // The referencing property's value is NOT actually changing in
            // the template — only the resolved physical ID / ARN it points
            // at will change after the upstream replacement. `oldValue` is
            // the resolved current value (e.g. an old ARN string) while
            // `newValue` is the still-unresolved intrinsic ({Ref: ...}), so
            // feeding both to a conditionalReplacement's `condition(old,
            // new)` would compare a string against an object and reliably
            // (and spuriously) report "changed". We therefore pass
            // undefined/undefined: UNCONDITIONAL replacementProperties match
            // on the property NAME alone and still fire correctly (the
            // immutable-property case this propagation cares about), while
            // conditional rules see no phantom delta and don't over-promote.
            requiresReplacement: this.replacementRules.requiresReplacement(
              change.resourceType,
              propKey,
              undefined,
              undefined
            ),
          });
        }
        if (syntheticChanges.length === 0) continue;

        if (change.changeType === 'NO_CHANGE') {
          change.changeType = 'UPDATE';
          change.propertyChanges = syntheticChanges;
          this.logger.debug(
            `UPDATE (promoted): ${dependentId} references replaced resource ${replacedId} via ${[...refPropKeys].join(', ')}`
          );
        } else {
          change.propertyChanges = [...(change.propertyChanges ?? []), ...syntheticChanges];
          this.logger.debug(
            `UPDATE (augmented): ${dependentId} references replaced resource ${replacedId} via ${[...refPropKeys].join(', ')}`
          );
        }

        if (
          !enqueued.has(dependentId) &&
          change.propertyChanges.some((pc) => pc.requiresReplacement)
        ) {
          enqueued.add(dependentId);
          queue.push(dependentId);
        }
      }
    }
  }

  /**
   * Promote NO_CHANGE dependents of an IN-PLACE update whose referenced ATTRIBUTE
   * either names a changed property (bug-hunt 2026-06-29) OR is a derived
   * read-only attribute the update side-effects (issue #985).
   *
   * Distinct from {@link promoteReplacementDependents}: a replacement changes the
   * physical id, so any reference is affected. An in-place update changes only
   * specific properties, so a dependent is affected in one of two ways when it
   * reads (via `Fn::GetAtt[Up, Attr]` or `Fn::Sub`'s `${Up.Attr}`) an attribute
   * of an updated `Up`:
   *   1. `Attr` NAMES a property that CHANGED in `Up`'s update (e.g. an SSM
   *      Parameter `Value` embedded in a downstream `Fn::Sub`); or
   *   2. `Attr` is a DERIVED read-only attribute of `Up`'s type that an in-place
   *      update side-effects even though it is not a template property — the
   *      per-type {@link IN_PLACE_UPDATE_DERIVED_ATTRS} allow list (issue #985;
   *      e.g. `AWS::EC2::LaunchTemplate.LatestVersionNumber`, which an
   *      `autoscaling.AutoScalingGroup` reads for its `LaunchTemplate.Version`);
   *      or
   *   3. `Attr` starts with a derived-attribute PREFIX of `Up`'s type — the
   *      {@link IN_PLACE_UPDATE_DERIVED_ATTR_PREFIXES} table (issue #3631; a
   *      nested stack's `Outputs.<Key>`); or
   *   4. `Up` is a custom resource, whose attributes are all its handler's
   *      response `Data` (go-to-k/cdkd#3662), and whose `Ref` — the physical
   *      id — its handler may also change on an Update by returning a new
   *      `PhysicalResourceId` (go-to-k/cdkd#3722); or
   *   5. `Up` is a template PARAMETER in `freshParameters`, read by `Ref` or
   *      `${Param}` (go-to-k/cdkd#3717).
   * (Any other `Ref` resolves to a physical id an in-place update keeps, so
   * Ref-only dependents of other types are left NO_CHANGE; likewise a GetAtt
   * of a computed attribute NOT in the allow list, e.g. a Lambda `Arn` on a
   * Description edit.)
   *
   * Promotion is safe even when speculative: the deploy engine re-resolves the
   * promoted resource against the in-flight state and skips the provider call
   * when nothing actually changed. Each synthetic change is marked
   * `inPlacePropagated`, and its `requiresReplacement` is a ceiling the engine
   * lowers when the resolved value equals the record, so an unmoved value never
   * replaces a reader that another edit sent to the provider.
   *
   * One pass is single-hop: `changedPropsByUpstream` is frozen at entry, so a
   * chain `A(in-place) -> B(reads A's changed attr) -> C(reads B's now-changed
   * attr)` promotes B but not C. `calculateDiff` re-runs it to a fixpoint, and
   * the pass after B's promotion sees B as an in-place UPDATE.
   *
   * A dependent reading a MASKED attribute (a `NoEcho` custom resource's
   * value, persisted `***`, issue #2274) is promoted like any other
   * (go-to-k/cdkd#3662). The engine takes its no-change skip BEFORE refusing a
   * redacted read, so a guess whose resolved bag equals the record, mask
   * included, sends nothing; a fresh `NoEcho` value never takes that skip, so
   * one the upstream re-minted in this run reaches AWS. What is left is the
   * refusal's own case: a promoted dependent whose OTHER reads moved while the
   * masked value was not re-minted fails loudly, as an update of it with a
   * changed property already did, rather than keeping the stale values.
   *
   * @returns whether any synthetic PropertyChange was added (the caller's
   *          fixpoint signal).
   */
  private promoteInPlaceAttributeDependents(
    changes: Map<string, ResourceChange>,
    desiredTemplate: CloudFormationTemplate,
    rawGetAttRefs: Map<string, Map<string, Map<string, Set<string>>>>,
    freshParameters?: ReadonlySet<string>
  ): boolean {
    // Per upstream UPDATE: the set of top-level property names that changed.
    const changedPropsByUpstream = new Map<string, Set<string>>();
    // Per upstream in-place UPDATE: its resource type, used to look up the
    // derived-attribute allow list (issue #985). Populated for every UPDATE
    // that is NOT a replacement — a replaced upstream is already handled by
    // promoteReplacementDependents, and its dependents must not be double-promoted.
    const inPlaceUpdateTypeByUpstream = new Map<string, string>();
    for (const [logicalId, change] of changes) {
      if (change.changeType !== 'UPDATE') continue;
      const propertyChanges = change.propertyChanges ?? [];
      const isReplacement = propertyChanges.some((pc) => pc.requiresReplacement);
      if (!isReplacement) inPlaceUpdateTypeByUpstream.set(logicalId, change.resourceType);
      const props = propertyChanges
        .map((pc) => pc.path)
        .filter((p): p is string => typeof p === 'string');
      if (props.length > 0) changedPropsByUpstream.set(logicalId, new Set(props));
    }
    const anyFreshParameter = freshParameters !== undefined && freshParameters.size > 0;
    if (
      changedPropsByUpstream.size === 0 &&
      inPlaceUpdateTypeByUpstream.size === 0 &&
      !anyFreshParameter
    ) {
      return false;
    }
    let added = false;

    for (const [dependentId, perProp] of rawGetAttRefs) {
      const resource = desiredTemplate.Resources[dependentId];
      if (!resource || resource.Type === 'AWS::CDK::Metadata') continue;
      const change = changes.get(dependentId);
      if (!change) continue;
      // CREATE resolves fresh at provision time; DELETE is going away.
      if (change.changeType !== 'NO_CHANGE' && change.changeType !== 'UPDATE') continue;

      const existingPaths = new Set((change.propertyChanges ?? []).map((pc) => pc.path));
      const syntheticChanges: PropertyChange[] = [];

      for (const [propKey, getAttRefs] of perProp) {
        if (existingPaths.has(propKey)) continue; // already diffed on its own
        // Which upstreams + attributes does this property read via GetAtt / Sub?
        let matched = false;
        for (const [upstreamId, attrs] of getAttRefs) {
          if (upstreamId === dependentId) continue; // self-reference defense
          // Arm 1: the referenced attribute names a property that changed.
          const changedProps = changedPropsByUpstream.get(upstreamId);
          if (changedProps && [...attrs].some((attr) => changedProps.has(attr))) {
            matched = true;
            break;
          }
          // Arm 2 (issue #985): the referenced attribute is a derived read-only
          // attribute of the upstream's type that an in-place UPDATE side-effects
          // (e.g. LaunchTemplate LatestVersionNumber) — regardless of WHICH
          // property changed, since any in-place edit can bump it.
          //
          // `Object.hasOwn` on both tables: the type is template text, and a
          // bare lookup of `constructor` answers with `Object`'s own function.
          const upstreamType = inPlaceUpdateTypeByUpstream.get(upstreamId);
          const derivedAttrs =
            upstreamType !== undefined && Object.hasOwn(IN_PLACE_UPDATE_DERIVED_ATTRS, upstreamType)
              ? IN_PLACE_UPDATE_DERIVED_ATTRS[upstreamType]
              : undefined;
          if (derivedAttrs && [...attrs].some((attr) => derivedAttrs.has(attr))) {
            matched = true;
            break;
          }
          // Arm 3 (issue #3631): a derived attribute FAMILY, matched by prefix —
          // a nested stack's `Outputs.<Key>`, which a child-only change moves.
          // Always speculative: which outputs move is the child deploy's to
          // decide. A reader of a `NoEcho` output (persisted `***`, issue #2274)
          // is promoted too; the method doc says what the engine then does with
          // it (go-to-k/cdkd#3662). A promoted reader also re-runs everything
          // the engine does before its no-change skip, e.g. fetching its
          // `{{resolve:...}}` references again.
          const derivedPrefixes =
            upstreamType !== undefined &&
            Object.hasOwn(IN_PLACE_UPDATE_DERIVED_ATTR_PREFIXES, upstreamType)
              ? IN_PLACE_UPDATE_DERIVED_ATTR_PREFIXES[upstreamType]
              : undefined;
          if (
            derivedPrefixes &&
            [...attrs].some((attr) => derivedPrefixes.some((prefix) => attr.startsWith(prefix)))
          ) {
            matched = true;
            break;
          }
          // Arm 4 (go-to-k/cdkd#3662): EVERY attribute of a custom resource. Its
          // attributes are the handler's response `Data`, which an in-place
          // update re-runs, and none of them is a template property, so arms 1-3
          // never see one. Speculative like arm 3: the engine re-resolves the
          // reader against what the handler returned and skips it when nothing
          // moved, except for a `NoEcho` value, whose `***` compares equal to
          // any other.
          //
          // The same holds for its `Ref` (go-to-k/cdkd#3722): the handler may
          // answer an Update with a new `PhysicalResourceId`.
          if (
            upstreamType !== undefined &&
            (upstreamType.startsWith('Custom::') ||
              upstreamType === 'AWS::CloudFormation::CustomResource')
          ) {
            matched = true;
            break;
          }
          // Arm 5 (go-to-k/cdkd#3717): a `Ref` to a PARAMETER carrying a
          // `NoEcho` value supplied in this deploy. Its diff side is `***`
          // against a recorded `***`, so only this promotion reaches the
          // engine, which re-resolves the reader and compares for itself.
          if (
            anyFreshParameter &&
            freshParameters.has(upstreamId) &&
            attrs.has(REF_READ) &&
            !Object.hasOwn(desiredTemplate.Resources, upstreamId)
          ) {
            matched = true;
            break;
          }
        }
        if (!matched) continue;

        syntheticChanges.push({
          path: propKey,
          oldValue: change.currentProperties?.[propKey],
          newValue: change.desiredProperties?.[propKey],
          // Re-evaluate the dependent's own replacement rules: if the referencing
          // property is immutable for its type, the dependent is replaced too.
          // A CEILING (go-to-k/cdkd#3662): the engine drops it when the
          // resolved value turns out equal to the record, which for arms 3 and
          // 4 is the common case (the output or the handler's `Data` did not
          // move) and which a same-deploy edit elsewhere on the reader must not
          // turn into a destroy + recreate.
          requiresReplacement: this.replacementRules.requiresReplacement(
            change.resourceType,
            propKey,
            undefined,
            undefined
          ),
          inPlacePropagated: true,
        });
      }

      if (syntheticChanges.length === 0) continue;
      added = true;

      if (change.changeType === 'NO_CHANGE') {
        change.changeType = 'UPDATE';
        change.propertyChanges = syntheticChanges;
        this.logger.debug(
          `UPDATE (in-place attr propagated): ${dependentId} reads a value that may move in this deploy`
        );
      } else {
        change.propertyChanges = [...(change.propertyChanges ?? []), ...syntheticChanges];
      }
    }
    return added;
  }

  /**
   * Extract `Fn::GetAtt` / `Fn::Sub`-`${X.Attr}` references from a property value
   * as a map of `referencedLogicalId -> set of referenced attribute names`.
   * A plain `Ref` (and a dot-less `${X}`) is recorded under the
   * {@link REF_READ} name, which only the custom-resource and fresh-parameter
   * arms of the in-place pass read (go-to-k/cdkd#3717 / #3722). Recurses into arrays / objects so
   * intrinsics nested inside `Fn::Sub`'s variable map / `Fn::Join` etc. are seen.
   */
  private static extractGetAttRefs(value: unknown): Map<string, Set<string>> {
    const refs = new Map<string, Set<string>>();
    const add = (id: string, attr: string): void => {
      if (id.startsWith('AWS::')) return; // pseudo parameter
      let set = refs.get(id);
      if (!set) {
        set = new Set();
        refs.set(id, set);
      }
      set.add(attr);
    };
    const walk = (v: unknown): void => {
      if (v === null || typeof v !== 'object') return;
      if (Array.isArray(v)) {
        v.forEach(walk);
        return;
      }
      const obj = v as Record<string, unknown>;
      if ('Fn::GetAtt' in obj) {
        const ga = obj['Fn::GetAtt'];
        if (Array.isArray(ga) && typeof ga[0] === 'string' && typeof ga[1] === 'string') {
          add(ga[0], ga[1]);
        } else if (typeof ga === 'string') {
          // The STRING spelling (`!GetAtt A.B`), split by the resolver's own
          // rule, so `Child.Outputs.Foo` reads as `Child` / `Outputs.Foo`.
          const split = splitGetAttStringForm(ga);
          if (split) add(split.logicalId, split.attributeName);
        }
        return;
      }
      if ('Fn::Sub' in obj) {
        const sub = obj['Fn::Sub'];
        let body: string | undefined;
        let mapKeys: Set<string> | undefined;
        if (typeof sub === 'string') {
          body = sub;
        } else if (Array.isArray(sub) && typeof sub[0] === 'string') {
          body = sub[0];
          const vars = sub[1];
          if (vars && typeof vars === 'object' && !Array.isArray(vars)) {
            mapKeys = new Set(Object.keys(vars as Record<string, unknown>));
            Object.values(vars as Record<string, unknown>).forEach(walk);
          }
        }
        if (body !== undefined) {
          for (const m of body.matchAll(/\$\{(!)?([^}]+)\}/g)) {
            if (m[1] === '!') continue; // literal escape
            const placeholder = m[2];
            if (!placeholder) continue;
            const dot = placeholder.indexOf('.');
            if (dot < 0) {
              // `${X}` is a Ref.
              if (!mapKeys?.has(placeholder)) add(placeholder, REF_READ);
              continue;
            }
            const id = placeholder.slice(0, dot);
            const attr = placeholder.slice(dot + 1);
            if (!id || mapKeys?.has(id)) continue;
            add(id, attr);
          }
        }
        return;
      }
      if ('Ref' in obj && Object.keys(obj).length === 1) {
        if (typeof obj['Ref'] === 'string') add(obj['Ref'], REF_READ);
        return;
      }
      Object.values(obj).forEach(walk);
    };
    walk(value);
    return refs;
  }

  /**
   * Best-effort resolution of template property intrinsics against current state.
   *
   * Iterates top-level properties and resolves each independently: if resolution
   * throws (e.g. Ref to a resource that isn't in state yet), the original value
   * is kept so downstream comparison falls back to the "assume intrinsic equals
   * anything" behavior for that one value instead of failing the whole diff.
   */
  private async resolveBestEffort(
    properties: Record<string, unknown>,
    resolveFn: IntrinsicResolveFn
  ): Promise<Record<string, unknown>> {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) {
      try {
        // Resolve a CLONE. The reason is the OWNERSHIP contract, not any
        // resolver's behaviour: this value is a leaf of a template its CALLER
        // still shares with other consumers, so nothing here may let a resolver
        // write through it. Both call sites share it — `cdkd diff` hands the
        // same object on to the Outputs resolution that follows, and `cdkd
        // deploy` re-resolves it against the in-flight state and provisions
        // from it. The deploy one is the consequence with teeth: a
        // resolved current-state value baked in here would still be read as a
        // literal then, and a genuinely-changed dependent of an in-place-updated
        // upstream would be skipped. Cloning makes that impossible whatever the
        // resolver does.
        // (The resolver does not mutate its input today: `resolveSub` wrote back
        // into the caller's `Fn::Sub` variable map until go-to-k/cdkd#2764
        // retired it, and this comment named that write-back. Kept as history so
        // the clone is not read as dead weight. Both directions are fenced:
        // `tests/unit/deployment/intrinsic-sub-variables-not-mutated.test.ts`
        // holds the resolver to it, and deleting this `structuredClone` reds
        // `does NOT mutate the desired template (resolveBestEffort resolves a
        // clone)` in `tests/unit/analyzer/diff-calculator.test.ts`.)
        resolved[key] = await resolveFn(structuredClone(value));
      } catch {
        resolved[key] = value;
      }
    }
    return resolved;
  }

  /**
   * Compare CloudFormation template-level attributes (`DeletionPolicy`,
   * `UpdateReplacePolicy`) between cdkd state and the synth template.
   *
   * Schema v5+ records these in `ResourceState`; state written by an older
   * cdkd binary has the fields undefined. Treating `undefined === undefined`
   * as "no change" means the first post-upgrade deploy of an unchanged
   * template doesn't spuriously fire an attribute diff.
   */
  private compareAttributes(
    currentResource: ResourceState,
    desiredResource: TemplateResource
  ): AttributeChange[] {
    const changes: AttributeChange[] = [];
    if (currentResource.deletionPolicy !== desiredResource.DeletionPolicy) {
      changes.push({
        attribute: 'DeletionPolicy',
        oldValue: currentResource.deletionPolicy,
        newValue: desiredResource.DeletionPolicy,
      });
    }
    if (currentResource.updateReplacePolicy !== desiredResource.UpdateReplacePolicy) {
      changes.push({
        attribute: 'UpdateReplacePolicy',
        oldValue: currentResource.updateReplacePolicy,
        newValue: desiredResource.UpdateReplacePolicy,
      });
    }
    return changes;
  }

  /**
   * Compare properties and return list of changes
   *
   * Uses ReplacementRulesRegistry to determine which property changes require replacement.
   * Reference: https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-updating-stacks-update-behaviors.html
   */
  private async compareProperties(
    resourceType: string,
    currentProperties: Record<string, unknown>,
    desiredProperties: Record<string, unknown>
  ): Promise<PropertyChange[]> {
    const changes: PropertyChange[] = [];

    // Get all property keys
    const allKeys = new Set([...Object.keys(currentProperties), ...Object.keys(desiredProperties)]);

    // Properties to ignore in diff (non-deterministic, changes on every synth)
    const ignoredProperties = new Set<string>();
    if (
      resourceType === 'AWS::CloudFormation::CustomResource' ||
      resourceType.startsWith('Custom::')
    ) {
      ignoredProperties.add('Timestamp');
    }

    // CFn-schema `createOnlyProperties` fallback for replacement detection.
    // The hand-authored `ReplacementRulesRegistry` only covers ~25 types, so an
    // immutable-property change on any OTHER type was previously mis-classified
    // as an in-place UPDATE. We consult the type's CFn registry schema (via
    // DescribeType, cached + graceful-degradation) for any changed property the
    // registry does not explicitly classify, so a createOnly change drives a
    // replacement regardless of whether the type has a hand-written rule.
    // Resolved lazily — only when a changed, registry-unclassified property is
    // actually found — so a no-change / fully-classified diff makes no AWS call.
    // Paths (not top-level reductions): a NESTED createOnly entry only forces
    // replacement when the value AT that path changed — sibling sub-properties
    // stay in-place-updatable (issue #960, AWS::Pipes::Pipe SourceParameters).
    let createOnlyPaths: ReadonlyArray<readonly string[]> | undefined;

    for (const key of allKeys) {
      if (ignoredProperties.has(key)) continue;

      const oldValue = currentProperties[key];
      const newValue = desiredProperties[key];

      if (!this.valuesEqual(oldValue, newValue)) {
        // Check if this property change requires replacement
        let requiresReplacement = this.replacementRules.requiresReplacement(
          resourceType,
          key,
          oldValue,
          newValue
        );

        // Schema fallback: only where the registry has NO explicit opinion (so
        // a deliberate `updateableProperties` / conditional classification is
        // never overridden). A createOnly property change IS a replacement.
        if (!requiresReplacement && !this.replacementRules.isClassified(resourceType, key)) {
          if (createOnlyPaths === undefined) {
            createOnlyPaths = await getCreateOnlyPropertyPaths(resourceType);
          }
          if (
            createOnlyChangeRequiresReplacement(createOnlyPaths, key, oldValue, newValue, (a, b) =>
              this.valuesEqual(a, b)
            )
          ) {
            requiresReplacement = true;
            this.logger.debug(
              `Property ${key} of ${resourceType} changed a createOnly path per the CFn schema — requires replacement`
            );
          }
        }

        changes.push({
          path: key,
          oldValue,
          newValue,
          requiresReplacement,
        });

        if (requiresReplacement) {
          this.logger.debug(
            `Property ${key} of ${resourceType} requires replacement (${JSON.stringify(oldValue)} -> ${JSON.stringify(newValue)})`
          );
        }
      }
    }

    return changes;
  }

  private static readonly INTRINSIC_KEYS = INTRINSIC_KEYS;

  /**
   * Check if a value is itself a CloudFormation intrinsic function.
   * e.g. { "Ref": "MyResource" } or { "Fn::GetAtt": ["Res", "Arn"] }
   * Does NOT match objects that merely contain intrinsics as nested children.
   */
  private static isIntrinsic(value: unknown): boolean {
    if (
      value === null ||
      value === undefined ||
      typeof value !== 'object' ||
      Array.isArray(value)
    ) {
      return false;
    }
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length === 1 && DiffCalculator.INTRINSIC_KEYS.has(keys[0]!);
  }

  /**
   * Deep equality check for values
   *
   * State stores resolved values (`"arn:aws:s3:::my-bucket"`); the synth
   * template holds unresolved intrinsics (`{ "Fn::GetAtt": ["MyBucket", "Arn"] }`).
   * Before reaching this comparator, `resolveBestEffort` already tried to
   * resolve the template side against current state, so a remaining raw
   * intrinsic typically means the resolver couldn't resolve it — most
   * commonly because the intrinsic references a resource NOT YET in state
   * (e.g., a newly-introduced resource the next deploy will CREATE).
   *
   * Two cases when an intrinsic still reaches here:
   *
   * 1. Both sides intrinsic: state was written by an older cdkd that didn't
   *    fully resolve at deploy time. Structural compare suffices —
   *    `Fn::GetAtt: [X, Arn]` matches `Fn::GetAtt: [X, Arn]` byte-for-byte.
   *
   * 2. One side intrinsic, other side concrete: the unresolvable intrinsic
   *    points at something different from what's currently in state. Treat
   *    as NOT equal so the resource is classified as UPDATE.
   *
   * Pre-fix this branch returned `true` (equal) for case 2, which silently
   * dropped real diffs — e.g., when an IAM Policy's `Resource: Fn::GetAtt:
   * [Bucket, Arn]` is rebound to a renamed bucket (logical ID changed
   * because the construct path moved), the resolver couldn't find the new
   * bucket in state and the policy stayed at the old bucket's ARN after
   * deploy. The next CR invocation against the new bucket then failed with
   * AccessDenied because the IAM Policy was never UPDATED.
   */
  private valuesEqual(a: unknown, b: unknown): boolean {
    // Strict equality check
    if (a === b) {
      return true;
    }

    // Null/undefined check
    if (a == null || b == null) {
      return a === b;
    }

    const aIntrinsic = DiffCalculator.isIntrinsic(a);
    const bIntrinsic = DiffCalculator.isIntrinsic(b);
    if (aIntrinsic !== bIntrinsic) {
      // One side intrinsic, other side concrete: changed.
      return false;
    }
    // Both intrinsics OR both concrete: fall through to the standard
    // array / object / primitive compare. For two intrinsics the
    // object-compare path below walks the single intrinsic key and
    // recursively compares its value (arrays positionally; nested
    // objects by key membership, key-order-insensitive — which matters
    // for `Fn::Sub`'s 2-arg form `[template, {VarA, VarB}]` where the
    // variable map's key order can differ between a synth-fresh object
    // literal and a `JSON.parse`'d state record).

    // Array check
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) {
        return false;
      }
      return a.every((val, index) => this.valuesEqual(val, b[index]));
    }

    // Object check — recurse into each key so intrinsics are detected per-value
    if (typeof a === 'object' && typeof b === 'object') {
      const aObj = a as Record<string, unknown>;
      const bObj = b as Record<string, unknown>;

      const aKeys = Object.keys(aObj);
      const bKeys = Object.keys(bObj);

      // SYMMETRIC compare: a key present only in the OLD (state) side is a
      // genuine REMOVAL and must be detected — e.g. a Lambda env var dropped from
      // `Environment.Variables`, which AWS replaces wholesale (the dropped key
      // must reach AWS). The prior asymmetric compare (only walking the new-side
      // keys) silently swallowed nested-map-key removals: top-level property
      // removal + array-element removal were already caught (by the caller's
      // key-union + array-length check), but a key removed from a NESTED object
      // (Environment.Variables, Tags maps, etc.) compared equal and never
      // re-provisioned. cdkd stores the resolved TEMPLATE properties in
      // `state.properties` (AWS-observed defaults live in `observedProperties`),
      // so the old-side keys here are template-derived too — a length mismatch is
      // a real add or remove, not an AWS-added default.
      if (aKeys.length !== bKeys.length) {
        return false; // key added OR removed
      }
      for (const key of bKeys) {
        if (!(key in aObj)) {
          return false; // New key added in template
        }
        if (!this.valuesEqual(aObj[key], bObj[key])) {
          return false;
        }
      }
      return true;
    }

    // Primitive types
    return false;
  }

  /**
   * Get summary of changes
   */
  getSummary(changes: Map<string, ResourceChange>): {
    create: number;
    update: number;
    delete: number;
    noChange: number;
    total: number;
  } {
    const summary = {
      create: 0,
      update: 0,
      delete: 0,
      noChange: 0,
      total: changes.size,
    };

    for (const change of changes.values()) {
      switch (change.changeType) {
        case 'CREATE':
          summary.create++;
          break;
        case 'UPDATE':
          summary.update++;
          break;
        case 'DELETE':
          summary.delete++;
          break;
        case 'NO_CHANGE':
          summary.noChange++;
          break;
      }
    }

    return summary;
  }

  /**
   * Filter changes by type
   */
  filterByType(changes: Map<string, ResourceChange>, type: ChangeType): ResourceChange[] {
    return Array.from(changes.values()).filter((change) => change.changeType === type);
  }

  /**
   * Check if there are any changes
   */
  hasChanges(changes: Map<string, ResourceChange>): boolean {
    return Array.from(changes.values()).some((change) => change.changeType !== 'NO_CHANGE');
  }

  /**
   * Get changes that require replacement
   */
  getReplacementChanges(changes: Map<string, ResourceChange>): ResourceChange[] {
    return Array.from(changes.values()).filter(
      (change) =>
        change.changeType === 'UPDATE' &&
        change.propertyChanges?.some((pc) => pc.requiresReplacement)
    );
  }
}
