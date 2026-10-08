import type { CloudFormationTemplate } from '../../types/resource.js';
import type { StackState } from '../../types/state.js';
import {
  isStatefulRecreateTargetSync,
  MULTI_REGION_RECREATE_BLOCKED_TYPES,
  type StatefulReason,
} from '../../provisioning/stateful-types.js';
import { findActionableSilentDrops } from '../../provisioning/property-coverage.js';
import { recordedProtectionEvidence } from '../../provisioning/recorded-protection.js';
import {
  hasNoCloudControlHandlers,
  NO_CC_HANDLERS_REASON,
} from '../../provisioning/unsupported-types.js';
import { ccBrokenReason, isCustomResource } from '../../provisioning/provider-registry.js';

/**
 * One validated recreate target. The `resourceType` + `physicalId` are
 * resolved from state (not template) so the deploy engine can route
 * the destroy at the right provider without a second lookup.
 */
export interface RecreateTarget {
  logicalId: string;
  resourceType: string;
  /** Physical id from existing state — the resource we'll destroy. */
  physicalId: string;
  /** Sync-derivable stateful reason; `null` if not stateful. */
  statefulReason: StatefulReason;
  /**
   * Migration direction. `'to-cc-api'` is the original #615 SDK → CC
   * flow (named via `--recreate-via-cc-api`); `'to-sdk'` is the #651
   * reverse CC → SDK flow (named via `--recreate-via-sdk-provider`).
   * Drives the deploy-engine's `provisionedBy` override on the
   * post-recreate state record.
   */
  direction: 'to-cc-api' | 'to-sdk';
  /**
   * The live emptiness probe RAN and FAILED, so nothing was established
   * about this resource's contents (issue [#2595]).
   *
   * A sibling field rather than a `StatefulReason` value, and that is the
   * whole design: a reason value would make the target `stateful` and REFUSE
   * it, which is the fail-CLOSED flip this deliberately does not make. The
   * S3 arm fails OPEN by design (issue [#648], published in
   * `docs/cli-deploy-safety.md`) — a role without `s3:ListBucketVersions`
   * must still be able to recreate an empty bucket without
   * `--force-stateful-recreation`. What was wrong was not the routing but
   * the SCREEN: with `statefulReason` left at `null`, a bucket nothing could
   * be learned about was rendered exactly like one the probe measured and
   * found empty, on the one screen a user reads before consenting to a
   * DELETE + CREATE. This field carries the difference to the display
   * without touching the verdict.
   *
   * Only the S3 arm ever sets it. The log-group arm promotes on BOTH of its
   * failure paths, so a failed probe there is already non-`null` and can
   * never reach this state — the fail-closed half of the deliberate
   * asymmetry.
   */
  probeUnresolved?: boolean;
  /**
   * Issue [#2610] site 11: the clause naming the bag that says this resource
   * carries a deletion / termination protection flag, or `undefined`. The
   * recreate's delete never carries `removeProtection`, so the stateful
   * refusal's `--force-stateful-recreation` cannot remove such a resource on
   * its own. Unset under a template `UpdateReplacePolicy: Retain`, where the
   * recreate deletes nothing.
   */
  protectionEvidence?: string;
}

/**
 * One ambiguous-intent overlap: the resource is named in both
 * `--recreate-via-cc-api` AND its `<Type>:<Prop>` is in
 * `--prefer-sdk-route` AND the template uses that property.
 */
export interface AmbiguousIntentOverlap {
  logicalId: string;
  resourceType: string;
  property: string;
}

export interface RecreateTargetsValidation {
  /** Per-target validated descriptors (in input order, deduplicated). */
  targets: RecreateTarget[];
  /** Logical ids the user named but the template does not declare. */
  unknownLogicalIds: string[];
  /** Logical ids named + in template but absent from existing state. */
  missingFromState: string[];
  /** Overlaps between --recreate-via-cc-api and --prefer-sdk-route. */
  ambiguousIntent: AmbiguousIntentOverlap[];
  /**
   * Inverse ambiguous-intent (#651): `--recreate-via-sdk-provider <id>`
   * named on a resource whose template uses a silent-drop property
   * that is NOT in `--prefer-sdk-route`. The post-recreate
   * routing would re-route the resource back to CC API on the very
   * next deploy (or this deploy, in the no-template-change case),
   * making the migration a round-trip. Refuse with an actionable fix.
   */
  ambiguousIntentSdk: AmbiguousIntentOverlap[];
  /** Stateful targets that lack --force-stateful-recreation cover. */
  blockedStatefulTargets: Array<RecreateTarget & { statefulReason: Exclude<StatefulReason, null> }>;
  /**
   * Multi-region targets (e.g. `AWS::DynamoDB::GlobalTable`) the design
   * doc §8 declares out-of-scope for v1. Refusal is NOT bypassable
   * via `--force-stateful-recreation` — the destroy + recreate cycle
   * across replica regions is more involved than the single-region
   * path (out of scope until a follow-up issue).
   */
  blockedMultiRegionTargets: Array<RecreateTarget>;
  /**
   * #651: `--recreate-via-sdk-provider <id>` named on a resource whose
   * recorded `provisionedBy` is NOT `'cc-api'` (i.e. already SDK-managed,
   * or legacy state with no field). Reverse migration is a no-op for
   * these; refuse with a clear message rather than silently destroy +
   * recreate.
   */
  blockedAlreadySdk: RecreateTarget[];
  /**
   * #665: `--recreate-via-cc-api <id>` named on a resource whose
   * recorded `provisionedBy` is already `'cc-api'`, or (go-to-k/cdkd#4706,
   * given `hasSdkProvider`) whose type has no SDK provider. Forward migration
   * is a no-op for these; refuse with a clear message rather than
   * silently destroy + recreate. Mirror of {@link blockedAlreadySdk}
   * for the forward direction, addressing the pre-existing asymmetry
   * in #615.
   */
  blockedAlreadyCcApi: RecreateTarget[];
  /**
   * #651: `--recreate-via-sdk-provider <id>` named on a resource type
   * for which cdkd has no SDK provider registered (Tier 2 CC-only).
   * The destroy + recreate would just route via CC again, making the
   * migration impossible.
   */
  blockedNoSdkProvider: RecreateTarget[];
  /**
   * Issue [#3887]: `--recreate-via-cc-api <id>` named on a resource whose
   * TEMPLATE type Cloud Control cannot create — `NON_PROVISIONABLE` (no
   * handlers) or a provider opting out via `disableCcApiFallback`. The
   * recreate deletes the old resource through its SDK provider FIRST and only
   * then asks Cloud Control to create the new one, which fails: the resource
   * is gone and nothing recreates it. Refused before anything is touched, with
   * no bypass flag. `reason` is the registry's own wording of why.
   */
  blockedNoCcRoute: Array<RecreateTarget & { templateType: string; reason: string }>;
  /**
   * Issue [#4119]: `--recreate-via-cc-api` named a resource whose TEMPLATE
   * type is a `'cc-broken'` sticky exemption. Routing ignores the flag for it,
   * so the recreate would delete the resource and create it again on the SDK
   * route, announced as a migration to Cloud Control. Refused before anything
   * is touched.
   */
  blockedCcBroken: Array<RecreateTarget & { templateType: string }>;
  /**
   * #651: logical id named in BOTH `--recreate-via-cc-api` AND
   * `--recreate-via-sdk-provider`. Ambiguous — pick one direction.
   */
  conflictingDirections: string[];
  /**
   * Issue [#2567]: `--recreate-via-*` named the `AWS::CloudFormation::Stack`
   * row of a NESTED STACK itself.
   *
   * Refused, in both directions, with no `--force-stateful-recreation` bypass —
   * the same shape as {@link blockedMultiRegionTargets} and for a stronger
   * reason. `STATEFUL_TYPES` lists the type (issue #2548), but that refusal
   * is bypassable and this one is not: honoring it would route the whole
   * child stack through the replacement path. `NestedStackProvider.delete`
   * tears down every resource the child owns, under the CHILD's own policies
   * and with no per-resource consent screen, and the re-create would then be
   * asked of a layer that does not implement cdkd's nested-stack semantics at
   * all. A user who wants a child's resource recreated has to name it in a
   * deploy of that resource's own stack, which nested children do not get.
   *
   * The refusal is also what keeps {@link nestedStackLogicalIds} from being a
   * hazard: that note NAMES these ids to the user, and naming them while
   * accepting them would be an invitation.
   */
  blockedNestedStackTargets: RecreateTarget[];
  /**
   * Issue [#2567]: the `AWS::CloudFormation::Stack` logical ids this stack's
   * template declares, in template order. NOT an error category — it is the
   * evidence the unknown-id message needs to explain the one shape a user
   * cannot fix by correcting a typo: a resource that lives INSIDE a nested
   * child, which the flags do not address. The engine matches the validated
   * ids only against the stack they were validated against, so a child's
   * resource is not reachable from the parent's flag; without this hint the
   * user reads `not present in the synth template` and goes looking for a
   * spelling mistake that is not there. Empty for a stack with no nested
   * children, which is what keeps the hint off every ordinary typo.
   */
  nestedStackLogicalIds: string[];
}

const EMPTY_ALLOW_SET: ReadonlySet<string> = new Set();

/**
 * The CFn type of a nested stack's row in its PARENT's template. It decides
 * both the refusal (`blockedNestedStackTargets`) and the evidence the
 * unknown-id note renders (`nestedStackLogicalIds`) — so within this module it
 * is spelled once, or the note could name ids the validator does not refuse.
 *
 * The two are NOT the same set, and deliberately so. The refusal fires when
 * EITHER the state record or the template says nested, because a recreate has
 * two halves with two types (issue #2668): the STATE's type routes the delete
 * of the old resource — `NestedStackProvider` derives `<parent>~<logicalId>`
 * from it — and the TEMPLATE's type routes the create, which for a nested row
 * is a whole child-stack deploy. Either half alone is outside what a recreate
 * is built for. The note keys on the TEMPLATE alone, because it is telling the
 * user what their current template contains. Other modules spell it
 * for themselves rather than sharing one export: this one is exported only to
 * its sibling `render.ts` (the barrel does not re-export it), and the only copy
 * exported to other modules lives in `src/cli/commands/retire-cfn-stack.ts`, and importing a CLI command module
 * from the deployment layer would invert the dependency direction. (No count of
 * the other spellings is given here on purpose — an unfenced number in a
 * comment is a number that goes stale.)
 */
export const NESTED_STACK_RESOURCE_TYPE = 'AWS::CloudFormation::Stack';

/**
 * Plan-time validation of the user's recreate-via-cc-api list.
 *
 * Pure with respect to AWS — does NOT probe S3 bucket emptiness, nor
 * log-group emptiness. Wrap the result with
 * `probeAndRevalidateStateful` (`probe.ts`) to promote deferred targets'
 * `statefulReason` via a live round-trip before rendering errors. The
 * deploy command does this; the validator itself stays sync so unit tests
 * don't need AWS mocks.
 *
 * Input order is preserved; duplicate logical ids in the user's input
 * are deduplicated.
 */
export function validateRecreateTargets(input: {
  template: CloudFormationTemplate;
  state: StackState;
  recreateViaCcApi: ReadonlyArray<string>;
  /** #651: reverse-direction list. Optional for backward compatibility. */
  recreateViaSdkProvider?: ReadonlyArray<string>;
  allowUnsupportedProperties: ReadonlySet<string>;
  forceStatefulRecreation: boolean;
  /**
   * #651: callback to ask whether cdkd has an SDK provider registered
   * for a given resource type. Used to refuse `--recreate-via-sdk-provider`
   * on Tier 2 CC-only types, and `--recreate-via-cc-api` on one whatever its
   * record says (go-to-k/cdkd#4706). Optional — when omitted (legacy
   * callers), both checks are skipped and the blockedNoSdkProvider list
   * stays empty.
   */
  hasSdkProvider?: (resourceType: string) => boolean;
  /**
   * Issue [#3887]: why Cloud Control cannot create `resourceType`, or
   * `undefined` when it can — `ProviderRegistry.ccRouteUnavailableReason`,
   * which also covers a provider's `disableCcApiFallback`. When omitted, the
   * registry-free half ({@link hasNoCloudControlHandlers}) still refuses, so a
   * caller that forgets it cannot re-open the delete-then-fail path for a
   * NON_PROVISIONABLE type.
   */
  ccRouteUnavailableReason?: (resourceType: string) => string | undefined;
}): RecreateTargetsValidation {
  const seenCcApi = new Set<string>(input.recreateViaCcApi);
  const seenSdk = new Set<string>(input.recreateViaSdkProvider ?? []);
  const conflictingDirections = [...seenCcApi].filter((id) => seenSdk.has(id));

  const seen = new Set<string>();
  const targets: RecreateTarget[] = [];
  const unknownLogicalIds: string[] = [];
  const missingFromState: string[] = [];
  const ambiguousIntent: AmbiguousIntentOverlap[] = [];
  const ambiguousIntentSdk: AmbiguousIntentOverlap[] = [];
  const blockedStatefulTargets: Array<
    RecreateTarget & { statefulReason: Exclude<StatefulReason, null> }
  > = [];
  const blockedMultiRegionTargets: Array<RecreateTarget> = [];
  const blockedNestedStackTargets: RecreateTarget[] = [];
  const blockedAlreadySdk: RecreateTarget[] = [];
  const blockedAlreadyCcApi: RecreateTarget[] = [];
  const blockedNoSdkProvider: RecreateTarget[] = [];
  const blockedNoCcRoute: RecreateTargetsValidation['blockedNoCcRoute'] = [];
  const blockedCcBroken: RecreateTargetsValidation['blockedCcBroken'] = [];
  const ccRouteUnavailableReason =
    input.ccRouteUnavailableReason ??
    ((resourceType: string): string | undefined =>
      hasNoCloudControlHandlers(resourceType) ? NO_CC_HANDLERS_REASON : undefined);

  const conflictSet = new Set(conflictingDirections);

  type Direction = 'to-cc-api' | 'to-sdk';
  const namedTargets: Array<{ logicalId: string; direction: Direction }> = [
    ...input.recreateViaCcApi.map((id) => ({ logicalId: id, direction: 'to-cc-api' as const })),
    ...(input.recreateViaSdkProvider ?? []).map((id) => ({
      logicalId: id,
      direction: 'to-sdk' as const,
    })),
  ];

  for (const { logicalId, direction } of namedTargets) {
    if (seen.has(logicalId)) continue;
    seen.add(logicalId);

    // A logical id named in BOTH flags is recorded once in
    // `conflictingDirections` and skipped here — the renderer will
    // surface the conflict; we don't add it to targets[] in either
    // direction.
    if (conflictSet.has(logicalId)) continue;

    const templateResource = input.template.Resources?.[logicalId];
    if (!templateResource) {
      unknownLogicalIds.push(logicalId);
      continue;
    }
    // PRECONDITION, owed by the caller: every row of `input.state.resources`
    // is a readable resource record (go-to-k/cdkd#3202). This falsy test
    // cannot tell an ABSENT row from a `null` one, so a `null` row would be
    // reported as "missing from state" and the renderer would then tell the
    // operator to drop the flag for it — leaving the resource un-recreated
    // with the broken row in place — while a typeless row reaches the
    // confirmation prompt as `resourceType: undefined`. `deploy.ts`, the one
    // caller, refuses both through `refuseMalformedResourcesForDeploy` /
    // `refuseMalformedResourceEntriesForDeploy` on this same record before
    // calling here; a second caller owes the same two calls.
    const recordedResource = input.state.resources[logicalId];
    if (!recordedResource) {
      missingFromState.push(logicalId);
      continue;
    }

    const resourceType = recordedResource.resourceType;
    const target: RecreateTarget = {
      logicalId,
      resourceType,
      physicalId: recordedResource.physicalId,
      // BOTH bags (issue [#2521]): a retention set out of band -- the console,
      // `aws logs put-retention-policy` -- lands in `observedProperties` and in
      // no other bag, and an imported record whose template never declared the
      // property carries it there alone too. Passing `properties` only made the
      // cheap `has-retention` positive unreachable for both, so every such log
      // group paid a `DescribeLogStreams` round-trip that could not change the
      // answer -- and an EMPTY one was allowed through where an identical group
      // with a numerically recorded retention was refused.
      statefulReason: isStatefulRecreateTargetSync(
        resourceType,
        recordedResource.properties,
        recordedResource.observedProperties
      ),
      direction,
    };
    if (templateResource.UpdateReplacePolicy !== 'Retain') {
      const protectionEvidence = recordedProtectionEvidence(
        resourceType,
        recordedResource.properties,
        recordedResource.observedProperties,
        input.state.region
      );
      if (protectionEvidence !== undefined) target.protectionEvidence = protectionEvidence;
    }
    targets.push(target);

    // Multi-region refusal (design §8 — out of scope for v1). Refused
    // regardless of `--force-stateful-recreation`; the user has no
    // bypass flag for this category by design. Applies to BOTH directions.
    if (MULTI_REGION_RECREATE_BLOCKED_TYPES.has(resourceType)) {
      blockedMultiRegionTargets.push(target);
    }

    // Nested-stack refusal (issue [#2567]). Same "no bypass flag" shape as the
    // multi-region category above; see `blockedNestedStackTargets` for why the
    // operation is not merely out of scope but destructive.
    //
    // EITHER type. A recreate's two halves route on two types (issue #2668):
    // the old resource's delete on the STATE record's, the create on the
    // TEMPLATE's. A row RECORDED as a nested stack has its delete owned by
    // `NestedStackProvider`, which destroys `<parent>~<logicalId>` whole; a row
    // whose TEMPLATE now says nested has a whole child-stack deploy as its
    // create half. Neither is a single-resource recreate, so each type alone
    // leaves one of the two open — the same pair `type-change-guard.ts` refuses
    // on the unflagged path, for the reasons stated there.
    const nestedStackRow =
      resourceType === NESTED_STACK_RESOURCE_TYPE ||
      templateResource.Type === NESTED_STACK_RESOURCE_TYPE;
    if (nestedStackRow) {
      blockedNestedStackTargets.push(target);
    }

    if (direction === 'to-cc-api') {
      // Issue [#3887]: the CREATE half runs on Cloud Control with the TEMPLATE's
      // type (issue #2668), after the old resource was already deleted through
      // its SDK provider. A type Cloud Control cannot create would be deleted
      // and never recreated, so refuse here, before anything is touched. A
      // nested-stack row is already refused above, for a reason of its own.
      const noCcRoute = nestedStackRow
        ? undefined
        : ccRouteUnavailableReason(templateResource.Type);
      if (noCcRoute !== undefined) {
        blockedNoCcRoute.push({
          ...target,
          templateType: templateResource.Type,
          reason: noCcRoute,
        });
      } else if (!nestedStackRow && ccBrokenReason(templateResource.Type) !== undefined) {
        blockedCcBroken.push({ ...target, templateType: templateResource.Type });
      }

      // Ambiguous-intent overlap with --prefer-sdk-route.
      // The overlap only fires when the template carries a silent-drop
      // property AND that property is in the override allow-set —
      // matching what the routing decision would actually do.
      const actionableDrops = findActionableSilentDrops(
        resourceType,
        templateResource.Properties,
        // For the overlap check we want to surface every drop that the
        // user explicitly put in the allow-set, NOT filter them out. So
        // we pass an empty allow-set to the helper and post-filter.
        EMPTY_ALLOW_SET,
        // The replacement's own routing baseline (issue #3713).
        recordedResource.properties,
        // This bag is RAW: a value still holding an intrinsic cannot be
        // compared, and for a refusal the safe side is to count it as changed.
        { unresolvedAs: 'changed' }
      );
      for (const { property } of actionableDrops) {
        const allowKey = `${resourceType}:${property}`;
        if (input.allowUnsupportedProperties.has(allowKey)) {
          ambiguousIntent.push({ logicalId, resourceType, property });
        }
      }

      // #665 already-CC refusal (mirror of #651's blockedAlreadySdk):
      // the resource is ALREADY sticky on 'cc-api' so forward migration
      // is a no-op. Refuse rather than silently destroy + recreate
      // (wasted downtime + AWS API churn, identical end state).
      // A cc-broken type is not "already CC-managed" -- its next mutating
      // deploy returns it to its SDK provider -- and `blockedCcBroken` above
      // already refuses it with the true reason.
      //
      // go-to-k/cdkd#4706: so is one whose record says `sdk` but whose type
      // has no SDK provider, in the record or the template: it is managed
      // through Cloud Control whatever the record says (a record an earlier
      // `cdkd import` wrote). Recreated, an Application Auto Scaling target
      // lost its scaling policies for an identical end state.
      const onCcAnyway =
        input.hasSdkProvider !== undefined &&
        !nestedStackRow &&
        !isCustomResource(resourceType) &&
        !input.hasSdkProvider(resourceType) &&
        !input.hasSdkProvider(templateResource.Type);
      if (
        (recordedResource.provisionedBy === 'cc-api' || onCcAnyway) &&
        ccBrokenReason(templateResource.Type) === undefined
      ) {
        blockedAlreadyCcApi.push(target);
      }
    } else {
      // #651 inverse ambiguous-intent: the template uses a silent-drop
      // property that is NOT in `--prefer-sdk-route`. The
      // default-on auto-route would immediately re-route the resource
      // back to CC after the recreate. Refuse the round-trip.
      const actionableDrops = findActionableSilentDrops(
        resourceType,
        templateResource.Properties,
        input.allowUnsupportedProperties,
        // The replacement's own routing baseline (issue #3713): the recreate
        // lands where `replaceDecision` sends it, which compares against it.
        recordedResource.properties,
        // RAW bag, and this arm REFUSES: an uncomparable value counts as
        // changed, so it refuses where the resolved dispatch might route.
        { unresolvedAs: 'changed' }
      );
      for (const { property } of actionableDrops) {
        ambiguousIntentSdk.push({ logicalId, resourceType, property });
      }

      // #651 already-SDK refusal: the resource is NOT on `'cc-api'` so
      // the reverse migration is a no-op. Refuse.
      const currentlyOnCcApi = recordedResource.provisionedBy === 'cc-api';
      if (!currentlyOnCcApi) {
        blockedAlreadySdk.push(target);
      }

      // #651 no-SDK-provider refusal: cdkd has no SDK provider
      // registered for this resource type. The destroy + recreate
      // would just route via CC again — impossible migration.
      if (input.hasSdkProvider && !input.hasSdkProvider(resourceType)) {
        blockedNoSdkProvider.push(target);
      }
    }

    if (target.statefulReason !== null && !input.forceStatefulRecreation) {
      blockedStatefulTargets.push(
        target as RecreateTarget & { statefulReason: Exclude<StatefulReason, null> }
      );
    }
  }

  return {
    targets,
    unknownLogicalIds,
    missingFromState,
    ambiguousIntent,
    ambiguousIntentSdk,
    blockedStatefulTargets,
    blockedMultiRegionTargets,
    blockedNestedStackTargets,
    blockedAlreadySdk,
    blockedAlreadyCcApi,
    blockedNoSdkProvider,
    blockedNoCcRoute,
    blockedCcBroken,
    conflictingDirections,
    nestedStackLogicalIds: Object.entries(input.template.Resources ?? {})
      .filter(([, resource]) => resource?.Type === NESTED_STACK_RESOURCE_TYPE)
      .map(([id]) => id),
  };
}
