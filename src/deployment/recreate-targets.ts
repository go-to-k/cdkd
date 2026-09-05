/**
 * Pre-flight validation for `--recreate-via-cc-api <LogicalId>` deploy
 * flag (issue [#615]).
 *
 * Three things to validate before the deploy engine acts on the user's
 * recreate list:
 *
 *   1. Every named logical id MUST exist in the synth template. A typo
 *      should fail fast, not silently skip.
 *   2. Every named logical id MUST exist in cdkd state (the recreate
 *      operation requires an existing physical resource to destroy +
 *      recreate). A logical id in the template but absent from state
 *      is a CREATE on the next deploy regardless — recreate is a
 *      no-op for fresh deploys and should error out with a clear
 *      message rather than silently apply.
 *   3. Stateful-resource guard: every named target whose resource type
 *      is in {@link STATEFUL_TYPES} (or conditionally stateful — an S3
 *      bucket holding objects, a LogGroup with retention or with log
 *      streams) MUST be matched by an explicit
 *      `--force-stateful-recreation` flag. The sync first-cut runs from
 *      the recorded properties alone; the live probes promote a `null`
 *      reason afterwards — `s3:ListObjectVersions` to `'has-objects'`
 *      when a bucket actually contains data (issue [#648]), and
 *      `logs:DescribeLogStreams` to `'has-log-events'` when a log group
 *      is not provably empty (issue [#2558]).
 *   4. Multi-region refusal: every named target whose resource type
 *      is in {@link MULTI_REGION_RECREATE_BLOCKED_TYPES} (e.g.
 *      `AWS::DynamoDB::GlobalTable`) is refused outright. Out of
 *      scope for v1; no `--force-stateful-recreation` bypass since
 *      this is a structural limitation, not a data-loss footgun.
 *
 * Plus one cross-flag invariant: `--recreate-via-cc-api MyLambda`
 * combined with `--allow-unsupported-properties AWS::Lambda::Function:RuntimeManagementConfig`
 * on a resource whose template carries `RuntimeManagementConfig` is **ambiguous
 * intent** — does the user want SDK + silent drop, or CC migration?
 * Fail fast and let the user pick one strategy per resource.
 */

import {
  ListObjectVersionsCommand,
  NoSuchBucket,
  NotFound,
  type S3Client,
} from '@aws-sdk/client-s3';
import {
  DescribeLogStreamsCommand,
  ResourceNotFoundException as LogsResourceNotFoundException,
  type CloudWatchLogsClient,
} from '@aws-sdk/client-cloudwatch-logs';
import type { CloudFormationTemplate } from '../types/resource.js';
import type { StackState } from '../types/state.js';
import {
  isStatefulRecreateTargetSync,
  renderStatefulReason,
  MULTI_REGION_RECREATE_BLOCKED_TYPES,
  type StatefulReason,
} from '../provisioning/stateful-types.js';
import { findActionableSilentDrops } from '../provisioning/property-coverage.js';
import { assertRegionMatch } from '../provisioning/region-check.js';
import { canonicalizeRegion } from '../utils/aws-partition.js';
import { getLogger } from '../utils/logger.js';
import type { Logger } from '../types/config.js';
import { withRetry } from './retry.js';
import { isThrottlingError } from './retryable-errors.js';

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
}

/**
 * One ambiguous-intent overlap: the resource is named in both
 * `--recreate-via-cc-api` AND its `<Type>:<Prop>` is in
 * `--allow-unsupported-properties` AND the template uses that property.
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
  /** Overlaps between --recreate-via-cc-api and --allow-unsupported-properties. */
  ambiguousIntent: AmbiguousIntentOverlap[];
  /**
   * Inverse ambiguous-intent (#651): `--recreate-via-sdk-provider <id>`
   * named on a resource whose template uses a silent-drop property
   * that is NOT in `--allow-unsupported-properties`. The post-recreate
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
   * recorded `provisionedBy` is already `'cc-api'`. Forward migration
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
   * reason. The type is not in `STATEFUL_TYPES`, so nothing else stops it, and
   * honoring it would route the whole child stack through the replacement
   * path: `NestedStackProvider.delete` tears down every resource the child
   * owns, under the CHILD's own policies and with no per-resource consent
   * screen, and the re-create would then be asked of a layer that does not
   * implement cdkd's nested-stack semantics at all. A user who wants a child's
   * resource recreated has to name it in a deploy of that resource's own
   * stack, which nested children do not get.
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
 * unknown-id note renders (`nestedStackLogicalIds`), and those two must
 * describe the same set of resources or the note names ids the validator would
 * not refuse — so within this module it is spelled once. It is spelled again
 * per module elsewhere (`intrinsic-function-resolver.ts`,
 * `secret-redaction.ts`, `destroy-runner.ts`); the one EXPORTED copy lives in
 * `src/cli/commands/retire-cfn-stack.ts`, and importing a CLI command module
 * from the deployment layer would invert the dependency direction, which is
 * why every sibling here declares its own.
 */
const NESTED_STACK_RESOURCE_TYPE = 'AWS::CloudFormation::Stack';

/**
 * Plan-time validation of the user's recreate-via-cc-api list.
 *
 * Pure with respect to AWS — does NOT probe S3 bucket emptiness, nor
 * log-group emptiness. Wrap the result with
 * {@link probeAndRevalidateStateful} to promote deferred targets'
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
   * on Tier 2 CC-only types. Optional — when omitted (legacy callers),
   * the SDK-provider check is skipped and the blockedNoSdkProvider list
   * stays empty.
   */
  hasSdkProvider?: (resourceType: string) => boolean;
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
      statefulReason: isStatefulRecreateTargetSync(resourceType, recordedResource.properties),
      direction,
    };
    targets.push(target);

    // Multi-region refusal (design §8 — out of scope for v1). Refused
    // regardless of `--force-stateful-recreation`; the user has no
    // bypass flag for this category by design. Applies to BOTH directions.
    if (MULTI_REGION_RECREATE_BLOCKED_TYPES.has(resourceType)) {
      blockedMultiRegionTargets.push(target);
    }

    // Nested-stack refusal (issue [#2567]). Same "no bypass flag" shape as the
    // multi-region category above; see `blockedNestedStackTargets` for why the
    // operation is not merely out of scope but destructive. Keyed on the STATE
    // record's type, like every other check here, so a row cdkd recorded as a
    // nested stack is refused even if the template has since changed.
    if (resourceType === NESTED_STACK_RESOURCE_TYPE) {
      blockedNestedStackTargets.push(target);
    }

    if (direction === 'to-cc-api') {
      // Ambiguous-intent overlap with --allow-unsupported-properties.
      // The overlap only fires when the template carries a silent-drop
      // property AND that property is in the override allow-set —
      // matching what the routing decision would actually do.
      const actionableDrops = findActionableSilentDrops(
        resourceType,
        templateResource.Properties,
        // For the overlap check we want to surface every drop that the
        // user explicitly put in the allow-set, NOT filter them out. So
        // we pass an empty allow-set to the helper and post-filter.
        EMPTY_ALLOW_SET
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
      if (recordedResource.provisionedBy === 'cc-api') {
        blockedAlreadyCcApi.push(target);
      }
    } else {
      // #651 inverse ambiguous-intent: the template uses a silent-drop
      // property that is NOT in `--allow-unsupported-properties`. The
      // default-on auto-route would immediately re-route the resource
      // back to CC after the recreate. Refuse the round-trip.
      const actionableDrops = findActionableSilentDrops(
        resourceType,
        templateResource.Properties,
        input.allowUnsupportedProperties
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
    conflictingDirections,
    nestedStackLogicalIds: Object.entries(input.template.Resources ?? {})
      .filter(([, resource]) => resource?.Type === NESTED_STACK_RESOURCE_TYPE)
      .map(([id]) => id),
  };
}

/**
 * Render the validation failures into a single multi-line error
 * message. Returns `null` when the validation was clean (no errors).
 * The deploy command throws this string as the message of a
 * `ProvisioningError` so the surface is `cdkd deploy` exit code 1
 * with the same shape as other pre-flight failures.
 */
export function renderRecreateTargetsErrors(validation: RecreateTargetsValidation): string | null {
  const lines: string[] = [];

  // Reviewer caught: shared error categories (unknownLogicalIds /
  // missingFromState / blockedStatefulTargets) can be triggered by EITHER
  // direction's list, so the prefix needs to be neutral — naming
  // `--recreate-via-cc-api` when the user only passed
  // `--recreate-via-sdk-provider` is misleading. Use the umbrella prefix.
  const FLAG_UMBRELLA = '--recreate-via-cc-api / --recreate-via-sdk-provider';

  if (validation.unknownLogicalIds.length > 0) {
    lines.push(
      `${FLAG_UMBRELLA} named ${validation.unknownLogicalIds.length} ` +
        `logical id(s) not present in the synth template:`
    );
    for (const id of validation.unknownLogicalIds) {
      lines.push(`  - ${id}`);
    }
    lines.push(
      `  Fix: confirm each id exists in the template (CDK display path is the ` +
        `parent; the logical id is the CFn-emitted name, e.g. ` +
        `cdkd synth | jq '.Resources | keys'). Recreate operates on the ` +
        `synth template's logical ids, not CDK display paths.`
    );
    // Issue [#2567] — one unknown-id shape is not a typo and cannot be fixed
    // by re-reading the template: a resource that lives inside a NESTED stack.
    // The flags name logical ids of the stack being deployed, and the engine
    // matches them only against that stack, so a child's resource is not
    // addressable from here. Only shown when the template actually declares a
    // nested stack, so an ordinary typo keeps the plain message.
    if (validation.nestedStackLogicalIds.length > 0) {
      lines.push(
        `  Note: resources inside a nested stack are NOT addressable — the ` +
          `flags name logical ids of the stack being deployed, and this ` +
          `template's nested stack(s) (` +
          `${validation.nestedStackLogicalIds.join(', ')}) carry their own. ` +
          `A logical id that a nested child happens to share with a top-level ` +
          `resource recreates the TOP-LEVEL one only, and the nested stack ` +
          `row itself is refused as a target. An id belonging to a DIFFERENT ` +
          `stack of this deploy lands here too: every named stack validates ` +
          `the whole flag list, and one unknown id fails the entire run.`
      );
    }
  }

  if (validation.missingFromState.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `${FLAG_UMBRELLA} named ${validation.missingFromState.length} ` +
        `logical id(s) the template declares but cdkd state has no record of:`
    );
    for (const id of validation.missingFromState) {
      lines.push(`  - ${id}`);
    }
    lines.push(
      `  These are fresh CREATEs on the next deploy — recreate has nothing ` +
        `to destroy first. Remove the flag for these resources; the auto-route ` +
        `via Cloud Control (#614) handles fresh deploys for silent-drop properties, ` +
        `and SDK Provider is the default for everything else.`
    );
  }

  if (validation.ambiguousIntent.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `Ambiguous intent — ${validation.ambiguousIntent.length} resource(s) ` +
        `are named in BOTH --recreate-via-cc-api and ` +
        `--allow-unsupported-properties with the same Type:Prop on a ` +
        `silent-drop property the template uses:`
    );
    for (const overlap of validation.ambiguousIntent) {
      lines.push(
        `  - ${overlap.logicalId} (${overlap.resourceType}) — both ` +
          `--recreate-via-cc-api ${overlap.logicalId} (would migrate to CC, ` +
          `honoring ${overlap.property}) AND ` +
          `--allow-unsupported-properties ${overlap.resourceType}:${overlap.property} ` +
          `(would keep on SDK, accepting silent drop)`
      );
    }
    lines.push(`  Fix: pick ONE strategy per resource.`);
  }

  if (validation.blockedStatefulTargets.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `${FLAG_UMBRELLA} would destroy + recreate ` +
        `${validation.blockedStatefulTargets.length} stateful resource(s). ` +
        `Recreate loses ALL data — no automatic data migration. Re-run with ` +
        `--force-stateful-recreation to acknowledge the data-loss footgun.`
    );
    for (const blocked of validation.blockedStatefulTargets) {
      lines.push(
        `  - ${blocked.logicalId} (${blocked.resourceType}) — ` +
          `${renderStatefulReason(blocked.statefulReason)}`
      );
    }
  }

  if (validation.blockedNestedStackTargets.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `${FLAG_UMBRELLA} refuses to operate on ` +
        `${validation.blockedNestedStackTargets.length} nested-stack resource(s):`
    );
    for (const blocked of validation.blockedNestedStackTargets) {
      lines.push(`  - ${blocked.logicalId} (${blocked.resourceType})`);
    }
    lines.push(
      `  Recreating one would DELETE the whole child stack — every resource it ` +
        `owns, with no per-resource confirmation — and re-create it through a ` +
        `layer that does not implement cdkd's nested-stack handling. There is ` +
        `no --force-stateful-recreation bypass. A resource inside a child is ` +
        `not addressable by these flags at all.`
    );
  }

  if (validation.blockedMultiRegionTargets.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `--recreate-via-cc-api / --recreate-via-sdk-provider refuses to operate on ` +
        `${validation.blockedMultiRegionTargets.length} multi-region resource(s) — ` +
        `out of scope for v1 of these flags (the destroy + recreate cycle across ` +
        `replica regions is more involved than the single-region path):`
    );
    for (const blocked of validation.blockedMultiRegionTargets) {
      lines.push(`  - ${blocked.logicalId} (${blocked.resourceType})`);
    }
    lines.push(
      `  No --force-stateful-recreation bypass — this category is structurally ` +
        `unsupported in v1. File an issue if you need this path.`
    );
  }

  // #651 reverse-direction errors.
  if (validation.conflictingDirections.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `Conflicting recreate direction — ${validation.conflictingDirections.length} ` +
        `logical id(s) named in BOTH --recreate-via-cc-api AND ` +
        `--recreate-via-sdk-provider:`
    );
    for (const id of validation.conflictingDirections) {
      lines.push(`  - ${id}`);
    }
    lines.push(
      `  Fix: pick ONE direction per resource. The two flags drive opposite ` +
        `provisionedBy targets ('cc-api' vs 'sdk').`
    );
  }

  if (validation.blockedAlreadySdk.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `--recreate-via-sdk-provider named ${validation.blockedAlreadySdk.length} ` +
        `resource(s) that are NOT currently sticky on Cloud Control API (the ` +
        `reverse migration is a no-op):`
    );
    for (const blocked of validation.blockedAlreadySdk) {
      lines.push(`  - ${blocked.logicalId} (${blocked.resourceType})`);
    }
    lines.push(
      `  Fix: remove --recreate-via-sdk-provider <id> for these resources. ` +
        `They are already SDK-managed (or pre-v7 legacy state, treated as SDK).`
    );
  }

  // #665 — mirror of blockedAlreadySdk for the forward direction.
  if (validation.blockedAlreadyCcApi.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `--recreate-via-cc-api named ${validation.blockedAlreadyCcApi.length} ` +
        `resource(s) that are ALREADY sticky on Cloud Control API (the ` +
        `migration is a no-op):`
    );
    for (const blocked of validation.blockedAlreadyCcApi) {
      lines.push(`  - ${blocked.logicalId} (${blocked.resourceType})`);
    }
    lines.push(
      `  Fix: remove --recreate-via-cc-api <id> for these resources. ` +
        `They are already CC-managed; a destroy + recreate cycle would ` +
        `produce the same end state at the cost of unnecessary downtime.`
    );
  }

  if (validation.blockedNoSdkProvider.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `--recreate-via-sdk-provider named ${validation.blockedNoSdkProvider.length} ` +
        `resource(s) of types cdkd has no SDK provider for (Tier 2 CC-only):`
    );
    for (const blocked of validation.blockedNoSdkProvider) {
      lines.push(`  - ${blocked.logicalId} (${blocked.resourceType})`);
    }
    lines.push(
      `  Fix: remove --recreate-via-sdk-provider <id> for these resources. ` +
        `The destroy + recreate would route via Cloud Control anyway — there's ` +
        `no SDK alternative available.`
    );
  }

  if (validation.ambiguousIntentSdk.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `Inverse ambiguous intent — ${validation.ambiguousIntentSdk.length} ` +
        `--recreate-via-sdk-provider target(s) would IMMEDIATELY be re-routed ` +
        `back to Cloud Control after the recreate because their template uses ` +
        `silent-drop properties NOT in --allow-unsupported-properties:`
    );
    for (const overlap of validation.ambiguousIntentSdk) {
      lines.push(
        `  - ${overlap.logicalId} (${overlap.resourceType}) — template uses ` +
          `${overlap.property}; the default-on CC auto-route would re-route ` +
          `the recreated resource back to CC immediately`
      );
    }
    lines.push(
      `  Fix: pass --allow-unsupported-properties <Type>:<Prop> for each ` +
        `silent-drop property so the recreated resource stays on SDK with the ` +
        `property explicitly dropped. Or drop --recreate-via-sdk-provider — ` +
        `the resource already routes via CC and honors the property.`
    );
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * Trim-then-lower-case, the pair `CloudControlProvider` applies to both sides
 * of its own region assert. `canonicalizeRegion` only lower-cases, so a state
 * record carrying stray whitespace would still fail a `!==` compare.
 */
function foldRegion(region: string | undefined): string | undefined {
  return canonicalizeRegion(region?.trim());
}

/**
 * Clients the plan-time stateful probes need, one per conditionally
 * stateful type. Bundled rather than passed positionally so a third
 * conditional type cannot be added by widening a parameter list nobody
 * updates at the call sites.
 */
export interface StatefulProbeClients {
  /** `AWS::S3::Bucket` object probe (issue [#648]). */
  s3: S3Client;
  /** `AWS::Logs::LogGroup` log-stream probe (issue [#2558]). */
  cloudWatchLogs: CloudWatchLogsClient;
  /**
   * Sleep seam for the probes' throttle retry (issue [#2566]), threaded
   * straight through to {@link withRetry}. Production leaves it unset and
   * gets the real timer; a unit test injects a no-op so asserting the retry
   * costs no wall-clock. It lives on the CLIENTS bag rather than in a fourth
   * parameter because it is the same kind of thing as the clients — an
   * injected dependency of the probe, not a behaviour knob a user chooses.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * `StackState.region` — the region the recorded resources are expected to
   * live in. Not a client, but it belongs to the same bag for the same reason
   * `DeleteContext` carries it: the ONLY consumer is the `not-found`-means-gone
   * inference below, and `region-check.ts` exists precisely to stop that
   * inference being drawn from a client pointing somewhere else. Optional, and
   * an absent value preserves the pre-check behaviour, matching
   * `DeleteContext.expectedRegion`'s own back-compat contract — where ABSENT
   * includes a blank string, since the value is folded before the guard reads
   * it and a whitespace-only region can match nothing.
   *
   * DEFENCE IN DEPTH, stated precisely rather than implied: today's single
   * caller passes the PERSISTED `state.region` of the record it fetched under
   * the same `stackRegion` key the client is built for, so the two normally
   * agree and the refuse arm is not reached. Normally, not always — a record
   * written by hand or by another tool can carry a different region, and that
   * is the case the arm exists for. It also guards the inference itself: this
   * function is exported, and the next caller need not share that derivation.
   *
   * ONE live path reaches the ABSENT case rather than merely the hand-written
   * one, and it is recorded here rather than left for a reader to derive: a
   * LEGACY pre-v2 state record carries no `region` field at all
   * (`s3-state-backend.ts`'s legacy fallback returns a v1 blob whose key layout
   * was not region-scoped), so `deploy.ts` passes `undefined` and the guard is
   * INERT for that record. Inert, not unsound: the client this probe uses and
   * the client the recreate's DELETE will use are the same stack-region
   * clients, so a not-found seen here is a not-found in the region the deploy
   * is about to act in. The check buys nothing there because there is no
   * second region for it to disagree with — not because the inference got
   * weaker.
   */
  expectedRegion?: string | undefined;
}

/**
 * Async emptiness probes for the two conditionally stateful types
 * (issues [#648] / [#2558]).
 *
 * For every target whose sync {@link StatefulReason} is `null` — which for
 * these two types means DEFER, not "not stateful" (see
 * {@link isStatefulRecreateTargetSync}) — issues one single-page listing and
 * promotes the reason when the resource is not provably empty:
 *
 *   - `AWS::S3::Bucket` → `ListObjectVersions(MaxKeys=1)` against the
 *     bucket's recorded physical id, promoting to `'has-objects'` when the
 *     bucket has at least one current object, prior version, OR
 *     delete-marker. `ListObjectVersions` rather than `ListObjectsV2` so the
 *     probe mirrors the s3-bucket-provider's `emptyBucket` view: a versioned
 *     bucket whose current keys have all been soft-deleted (so
 *     `ListObjectsV2.KeyCount === 0`) still holds prior versions +
 *     delete-markers that the destroy + recreate cycle would lose. Using the
 *     same listing API as the provider ensures the probe and the destroy path
 *     agree on "empty".
 *   - `AWS::Logs::LogGroup` → `DescribeLogStreams(limit=1)` against the log
 *     group's recorded name. Only ONE response shape leaves the target
 *     un-promoted: a PRESENT, zero-length `logStreams` with no `nextToken`.
 *     A page with a stream, an ABSENT `logStreams` (the SDK types it
 *     optional), and a zero-length page carrying a continuation token all
 *     promote to `'has-log-events'` — the last two are non-answers, and an
 *     unprovable emptiness must not read as empty. **Stream presence, not
 *     `storedBytes`,** and the choice is load-bearing in both directions:
 *       * Every log event belongs to a log stream, so ZERO streams is a
 *         structural proof that the group holds no events — the only kind of
 *         "empty" this guard may act on.
 *       * `LogStream.storedBytes` cannot be used at all: the SDK still
 *         declares the field, and the AWS API reference says "As of June 17,
 *         2019, this parameter is no longer supported for log streams, and is
 *         always reported as zero" (quoted verbatim in
 *         `@aws-sdk/client-cloudwatch-logs`'s own `LogStream.storedBytes`
 *         JSDoc, which also marks it `@deprecated`). A probe reading it would
 *         report EVERY log group empty.
 *       * The same SDK note says the log GROUP's own `storedBytes` is "not
 *         affected", so that field is not ruled out the way the stream's is —
 *         but cdkd does not read it either, and the ground is not a claim
 *         about how fresh it is (this repo has measured nothing about that).
 *         Stream presence needs no size semantics at all: zero streams is a
 *         STRUCTURAL proof, and it over-blocks rather than under-blocks (a
 *         group holding only empty streams counts as non-empty), which is the
 *         side this guard must err on.
 *
 * **Probe failures fail CLOSED for the log group, OPEN for the bucket**, and
 * the divergence is deliberate rather than an oversight. The bucket's
 * soft-fail is pre-existing shipped behaviour (issue [#648]) documented on
 * `docs/cli-deploy-safety.md`; the log group's arm is new with issue [#2558],
 * whose whole subject is that an unprovable emptiness must not read as empty.
 * So a failed `DescribeLogStreams` (permission denied, throttling) warns AND
 * promotes to `'has-log-events'`: the user gets a refusal naming the remedies,
 * not a silent recreate. The ONE carve-out is a typed
 * `ResourceNotFoundException`, which is an ANSWER rather than a failure to get
 * one — a log group AWS says does not exist provably holds no events.
 *
 * Returns a NEW array of targets; the input is not mutated. Targets of other
 * types, and targets whose sync reason is already non-null, are passed through
 * unchanged — including a `'has-retention'` log group, whose verdict the bag
 * already settled and no probe may weaken.
 */
export async function probeStatefulRecreateTargetsAsync(
  targets: ReadonlyArray<RecreateTarget>,
  clients: StatefulProbeClients,
  logger: Logger = getLogger().child('recreate-targets')
): Promise<RecreateTarget[]> {
  const promoted: RecreateTarget[] = [];
  // Both probes retry a THROTTLE (issue [#2566]). A rate limit is the one
  // failure here that a retry can clear, and the two arms answer a throttle
  // differently by design -- the bucket falls through to its open failure
  // arm, the log group to a refusal -- so an unretried throttle silently
  // widens the S3 hole in one arm and refuses a deploy the user asked for in
  // the other. Deliberately NOT the shared transient table: every other error
  // here is either an answer (`ResourceNotFoundException`) or something a
  // second identical call will not change, and this runs on the pre-flight
  // path where a user is waiting.
  //
  // "Throttle" means what `isThrottlingError` means -- a throttling error
  // NAME or a 429/503 -- and not the shared table's `Rate exceeded` MESSAGE
  // backstop, which a custom `isRetryable` replaces rather than extends. Both
  // services this probes raise a canonical name (`SlowDown` / a 503 for S3,
  // `ThrottlingException` for CloudWatch Logs), so the narrower reading
  // covers them; a rate limit arriving with a generic name would not retry.
  //
  // 3 retries = 4 attempts, sleeping 0.5s + 1s + 2s = 3.5s at worst, per
  // target. `logger` is threaded so that wait is visible under `--verbose`
  // instead of reading as a hang.
  const probeRetryOptions = {
    maxRetries: 3,
    initialDelayMs: 500,
    logger,
    // `(classificationText, error)` — the ERROR is the second argument, and
    // reading the first would hand `isThrottlingError` a string with no
    // `.name` and classify every throttle as non-retryable. Same spelling the
    // other narrow throttle-only call sites use.
    isRetryable: (_message: string, error: unknown) => isThrottlingError(error),
    ...(clients.sleep && { sleep: clients.sleep }),
  };
  for (const target of targets) {
    if (target.statefulReason !== null) {
      promoted.push({ ...target });
      continue;
    }
    if (target.resourceType === 'AWS::S3::Bucket') {
      try {
        const result = await withRetry(
          () =>
            clients.s3.send(
              new ListObjectVersionsCommand({
                Bucket: target.physicalId,
                MaxKeys: 1,
              })
            ),
          target.logicalId,
          probeRetryOptions
        );
        // ONE of the log-group arm's two non-answers applies here; the other
        // does NOT, and issue [#2578] asked for both. The difference is how
        // each API encodes "none", which is a wire fact rather than a style:
        //
        //   - An ABSENT `Versions` / `DeleteMarkers` is NOT a non-answer.
        //     S3 OMITS an empty collection rather than sending an empty array
        //     — measured 2026-09-05, `us-east-1`, read-only
        //     `ListObjectVersions(MaxKeys=1)` through this same client: a
        //     bucket holding versions and no delete markers answered
        //     `Versions` present with one entry and `DeleteMarkers` absent
        //     from the response entirely. So an empty bucket omits BOTH, and
        //     requiring a PRESENT empty pair — the shape the log-group arm
        //     requires, correctly, because CloudWatch Logs sends `logStreams`
        //     present-and-empty — would make EVERY empty bucket read as not
        //     provably empty and turn this conditional arm into an
        //     unconditional refusal. Reading absence as zero is right here.
        //
        //   - A CONTINUATION marker with no entry in either array IS a
        //     non-answer, exactly as it is there: the listing is unfinished,
        //     so this page's emptiness is not the BUCKET's emptiness. That
        //     half was the real defect and is what this check adds.
        //
        // The fail-OPEN posture of the `catch` below is unchanged (issue
        // [#648], published in `docs/cli-deploy-safety.md`): this is about a
        // response that arrived, not about a probe that failed.
        const hasVersions = (result.Versions?.length ?? 0) > 0;
        const hasDeleteMarkers = (result.DeleteMarkers?.length ?? 0) > 0;
        // Truthiness, not `!== undefined`, so an empty-string marker reads as
        // ABSENT — the same reading the log-group twin's `!result.nextToken`
        // gives the same shape. Measured: a complete listing carries
        // `IsTruncated: false` and neither marker at all, so the two spellings
        // agree today; they disagree only on a `''` marker, where
        // `!== undefined` would refuse a genuinely empty bucket.
        const truncated =
          result.IsTruncated === true || !!result.NextKeyMarker || !!result.NextVersionIdMarker;
        if (hasVersions || hasDeleteMarkers) {
          promoted.push({ ...target, statefulReason: 'has-objects' });
        } else if (truncated) {
          // Warned rather than passed silently, as the log-group arm does:
          // the user is about to be refused, and the refusal alone would not
          // say that the API answered without answering.
          logger.warn(
            `--recreate-via-cc-api / --recreate-via-sdk-provider: S3 answered the emptiness probe ` +
              `for ${target.logicalId} (bucket ${target.physicalId}) without settling it (an empty ` +
              `page carrying a continuation marker); treating the bucket as NOT provably empty. ` +
              `Re-run to retry the probe, or — only if the bucket really is disposable — re-run ` +
              `with --force-stateful-recreation (that flag has NO per-resource granularity and ` +
              `clears the guard for every target in the run).`
          );
          promoted.push({ ...target, statefulReason: 'has-objects' });
        } else {
          promoted.push({ ...target });
        }
      } catch (e) {
        // A not-found is an ANSWER, not a failure to get one: AWS says the
        // bucket does not exist, so it provably holds nothing and the
        // recreate's delete can lose nothing. Passing it through silently
        // matches what the log-group arm already does with its own typed
        // `ResourceNotFoundException` — without this, issue [#2595]'s new row
        // would tell a user cdkd "does not know" about a bucket AWS just said
        // is gone, which is the over-warning that trains people to ignore the
        // line the issue added.
        //
        // Typed, never a message heuristic: a substring match on "not found"
        // would also swallow a permission error worded that way. Both classes
        // because the two verbs differ — `ListObjectVersions` raises
        // `NoSuchBucket`, while the SDK surfaces a bare 404 as `NotFound`.
        //
        // Deliberately NOT region-guarded, unlike the log-group twin: that arm
        // clears a stateful verdict on a not-found, so a wrong-region client
        // could turn a refusal into a pass. Here the verdict is already `null`
        // and stays `null` — the only thing this decides is whether the plan
        // prints an UNKNOWN row, so a wrong-region not-found costs a missing
        // warning, not a lost refusal.
        if (e instanceof NoSuchBucket || e instanceof NotFound) {
          promoted.push({ ...target });
          continue;
        }
        logger.warn(
          `--recreate-via-cc-api / --recreate-via-sdk-provider: live S3 probe failed for ${target.logicalId} ` +
            `(bucket ${target.physicalId}); leaving stateful guard at the sync ` +
            `result. If the bucket might be non-empty, re-run with ` +
            `--force-stateful-recreation. Underlying error: ` +
            `${e instanceof Error ? e.message : String(e)}`
        );
        // The verdict stays `null` — the fail-OPEN posture is unchanged — but
        // the target now CARRIES the fact that nothing was established, so
        // the confirm prompt can say so instead of rendering it identically
        // to a bucket measured empty (issue [#2595]).
        promoted.push({ ...target, probeUnresolved: true });
      }
      continue;
    }
    if (target.resourceType === 'AWS::Logs::LogGroup') {
      try {
        const result = await withRetry(
          () =>
            clients.cloudWatchLogs.send(
              new DescribeLogStreamsCommand({
                logGroupName: target.physicalId,
                limit: 1,
              })
            ),
          target.logicalId,
          probeRetryOptions
        );
        // Only ONE response shape proves the group empty: a PRESENT,
        // zero-length `logStreams` with no continuation token. The other two
        // shapes are non-answers, and reading either as "empty" is the same
        // mistake issue [#2558] exists to retire:
        //   - `logStreams` ABSENT. The SDK types the field optional
        //     (`DescribeLogStreamsResponse.logStreams?: LogStream[]`), so an
        //     omitted field is a legal response that says nothing about the
        //     group's contents. `?.length ?? 0` used to read it as zero.
        //   - a zero-length page carrying `nextToken`. A continuation token
        //     means the listing is not finished, so this page's emptiness is
        //     not the GROUP's emptiness.
        // Anything that is not the proof promotes to `'has-log-events'`, whose
        // rendered text — "not provably empty" — is exactly what happened.
        const streams = result.logStreams;
        const provablyEmpty = streams !== undefined && streams.length === 0 && !result.nextToken;
        if (provablyEmpty) {
          promoted.push({ ...target });
        } else if (streams !== undefined && streams.length > 0) {
          promoted.push({ ...target, statefulReason: 'has-log-events' });
        } else {
          // The non-answer shapes. Warned rather than passed silently: the
          // user is about to be refused, and the refusal alone would not say
          // that the API answered without answering.
          logger.warn(
            `--recreate-via-cc-api / --recreate-via-sdk-provider: CloudWatch Logs answered the ` +
              `emptiness probe for ${target.logicalId} (log group ${target.physicalId}) without ` +
              `settling it (${streams === undefined ? 'no logStreams field in the response' : 'an empty page carrying a continuation token'}); ` +
              `treating the log group as NOT provably empty. An unset or zero RetentionInDays is ` +
              `CloudWatch Logs' "never expire", so an unprovable emptiness must not read as empty. ` +
              `Re-run to retry the probe, or — only if the log group really is disposable — re-run ` +
              `with --force-stateful-recreation (that flag has NO per-resource granularity and ` +
              `clears the guard for every target in the run).`
          );
          promoted.push({ ...target, statefulReason: 'has-log-events' });
        }
      } catch (e) {
        if (e instanceof LogsResourceNotFoundException) {
          // The one error that is itself an ANSWER rather than a failure to
          // get one: AWS says the log group does not exist, so it provably
          // holds no events and the recreate's delete can lose nothing. Typed
          // check, not a message heuristic — the SDK exports the class and a
          // substring match on "does not exist" would also swallow a
          // permission error worded that way. Leaving the reason at `null`
          // matches what the S3 arm does for a missing bucket, where the
          // general soft-fail covers the same case.
          //
          // Guarded by the same `assertRegionMatch` helper the DELETE path
          // calls before trusting its own `ResourceNotFoundException`
          // (`LogsLogGroupProvider.delete`): `region-check.ts` exists so a
          // not-found is not read as "gone" when the client is simply pointing
          // at the wrong region. The HELPER is shared; the terms are not. Two
          // deliberate differences, both in this direction:
          //   - this site folds BOTH sides through `foldRegion` first (see
          //     below), where the delete path passes both raw — so
          //     `US-EAST-1` vs `us-east-1` matches here and refuses there;
          //   - the delete path THROWS on a mismatch; this one cannot — the
          //     probe's contract is that it never does — so a failed check
          //     falls back to the arm this whole branch is an exception to.
          let regionVerified = true;
          // FOLDED before the guard, as `CloudControlProvider` does: a
          // whitespace-only recorded region carries no information, so the
          // check must treat it as absent rather than compare against it.
          const recordedRegion = foldRegion(clients.expectedRegion);
          if (recordedRegion) {
            // Both sides trimmed and lower-cased through the local
            // `foldRegion`, the same pair `CloudControlProvider` applies before
            // its own region assert: a CDK manifest may spell the region
            // `US-EAST-1` while the SDK client resolves `us-east-1`, and
            // `assertRegionMatch` compares with `!==`. An un-folded compare
            // would refuse a genuinely absent log group and answer with the
            // one remedy that clears the data guard for every target in the
            // run. The CLIENT side of the fold is defensive — `AwsClients`
            // already lower-cases what it is handed (it does NOT trim) — and
            // only the recorded side has a live path to an unfolded value.
            let clientRegion: string | undefined;
            try {
              clientRegion = foldRegion(await clients.cloudWatchLogs.config.region());
              assertRegionMatch(
                clientRegion,
                recordedRegion,
                target.resourceType,
                target.logicalId,
                target.physicalId
              );
            } catch {
              // `assertRegionMatch` is used as a PREDICATE here, and its own
              // message is deliberately not relayed: it is written for the
              // DELETE path ("rerun the destroy with the correct region"),
              // which is not the command the user is running. The refusal is
              // re-worded for the deploy pre-flight instead, and it never
              // throws — the probe's contract — so a rejected `config.region()`
              // lands here too and is answered the same conservative way.
              regionVerified = false;
              // Two causes reach this catch and they need different remedies:
              // a genuine mismatch, and a client whose region never resolved at
              // all (a rejected `config.region()`, or a caller whose client has
              // no `config`). Telling the second one to "fix the region
              // mismatch" names a mismatch that was never established.
              // A TRUTHINESS test, not a null check: an empty-string region
              // is unresolved too, and falsiness is what
              // `assertRegionMatch`'s own unknown-region branch keys on.
              const cause = clientRegion
                ? `the client region (${clientRegion}) does not match the region cdkd state ` +
                  `records for it (${recordedRegion}) — a not-found from the wrong ` +
                  `region says nothing about the log group. Fix the region mismatch, or`
                : `the CloudWatch Logs client's own region could not be resolved, so the ` +
                  `not-found cannot be attributed to the region cdkd state records ` +
                  `(${recordedRegion}). Fix the client's region configuration, or`;
              logger.warn(
                `--recreate-via-cc-api / --recreate-via-sdk-provider: CloudWatch Logs reported ` +
                  `${target.logicalId} (log group ${target.physicalId}) missing, but ${cause} ` +
                  `re-run with --force-stateful-recreation if the log group really is disposable ` +
                  `(that flag clears the data guard for every target in the run). Until then it ` +
                  `is treated as NOT provably empty.`
              );
            }
          }
          if (regionVerified) {
            logger.debug(
              `--recreate-via-cc-api / --recreate-via-sdk-provider: log group ${target.physicalId} ` +
                `(${target.logicalId}) does not exist, so it holds no events — not stateful.`
            );
            promoted.push({ ...target });
            continue;
          }
          promoted.push({ ...target, statefulReason: 'has-log-events' });
          continue;
        }
        logger.warn(
          `--recreate-via-cc-api / --recreate-via-sdk-provider: live CloudWatch Logs probe failed for ` +
            `${target.logicalId} (log group ${target.physicalId}); treating the log group as ` +
            `NOT provably empty. An unset or zero RetentionInDays is CloudWatch Logs' ` +
            `"never expire", so an unprovable emptiness must not read as empty. Fixes, cheapest ` +
            `first: grant logs:DescribeLogStreams and re-run, or re-run as-is if this was ` +
            `transient (CloudWatch Logs throttles this API aggressively). Only if the log group ` +
            `really is disposable, re-run with --force-stateful-recreation — that flag has NO ` +
            `per-resource granularity and clears the guard for every target in the run. ` +
            `Underlying error: ${e instanceof Error ? e.message : String(e)}`
        );
        promoted.push({ ...target, statefulReason: 'has-log-events' });
      }
      continue;
    }
    promoted.push({ ...target });
  }
  return promoted;
}

/**
 * Async re-validation of the stateful-guard slice of a
 * {@link RecreateTargetsValidation}, after promoting the deferred S3 bucket
 * and log group reasons via {@link probeStatefulRecreateTargetsAsync}.
 *
 * Skips the probe entirely when `forceStatefulRecreation: true` — the
 * sync validation already omits the blocked list in that case, and
 * skipping avoids an unnecessary AWS round-trip (plus permission-denied
 * warn-and-skip cycle on low-privilege CI roles).
 *
 * Returns a NEW validation; the input is not mutated. Non-stateful
 * categories (`unknownLogicalIds` / `missingFromState` /
 * `ambiguousIntent` / `blockedMultiRegionTargets`) are preserved verbatim.
 */
export async function probeAndRevalidateStateful(input: {
  validation: RecreateTargetsValidation;
  clients: StatefulProbeClients;
  forceStatefulRecreation: boolean;
}): Promise<RecreateTargetsValidation> {
  if (input.forceStatefulRecreation) return input.validation;
  const promoted = await probeStatefulRecreateTargetsAsync(input.validation.targets, input.clients);
  const blockedStatefulTargets = promoted.filter(
    (t): t is RecreateTarget & { statefulReason: Exclude<StatefulReason, null> } =>
      t.statefulReason !== null
  );
  return {
    ...input.validation,
    targets: promoted,
    blockedStatefulTargets,
  };
}
