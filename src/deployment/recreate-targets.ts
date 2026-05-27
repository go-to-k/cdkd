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
 *      is in {@link STATEFUL_TYPES} (or conditionally stateful — S3
 *      bucket with objects, LogGroup with retention) MUST be matched
 *      by an explicit `--force-stateful-recreation` flag. The probe
 *      for S3 / LogGroup conditional state runs synchronously off the
 *      recorded properties; the live `ListObjectsV2` probe for S3
 *      buckets is deferred to a follow-up issue (v1 sync-defers).
 *   4. Multi-region refusal: every named target whose resource type
 *      is in {@link MULTI_REGION_RECREATE_BLOCKED_TYPES} (e.g.
 *      `AWS::DynamoDB::GlobalTable`) is refused outright. Out of
 *      scope for v1; no `--force-stateful-recreation` bypass since
 *      this is a structural limitation, not a data-loss footgun.
 *
 * Plus one cross-flag invariant: `--recreate-via-cc-api MyLambda`
 * combined with `--allow-unsupported-properties AWS::Lambda::Function:LoggingConfig`
 * on a resource whose template carries `LoggingConfig` is **ambiguous
 * intent** — does the user want SDK + silent drop, or CC migration?
 * Fail fast and let the user pick one strategy per resource.
 */

import type { CloudFormationTemplate } from '../types/resource.js';
import type { StackState } from '../types/state.js';
import {
  isStatefulRecreateTargetSync,
  renderStatefulReason,
  MULTI_REGION_RECREATE_BLOCKED_TYPES,
  type StatefulReason,
} from '../provisioning/stateful-types.js';
import { findActionableSilentDrops } from '../provisioning/property-coverage.js';

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
}

/**
 * Plan-time validation of the user's recreate-via-cc-api list.
 *
 * Pure with respect to AWS — does NOT probe S3 bucket emptiness. The
 * S3 conditional check is deferred to a follow-up issue (the live
 * `s3:ListObjectsV2` probe is out of scope for v1).
 *
 * Input order is preserved; duplicate logical ids in the user's input
 * are deduplicated.
 */
const EMPTY_ALLOW_SET: ReadonlySet<string> = new Set();

export function validateRecreateTargets(input: {
  template: CloudFormationTemplate;
  state: StackState;
  recreateViaCcApi: ReadonlyArray<string>;
  allowUnsupportedProperties: ReadonlySet<string>;
  forceStatefulRecreation: boolean;
}): RecreateTargetsValidation {
  const seen = new Set<string>();
  const targets: RecreateTarget[] = [];
  const unknownLogicalIds: string[] = [];
  const missingFromState: string[] = [];
  const ambiguousIntent: AmbiguousIntentOverlap[] = [];
  const blockedStatefulTargets: Array<
    RecreateTarget & { statefulReason: Exclude<StatefulReason, null> }
  > = [];
  const blockedMultiRegionTargets: Array<RecreateTarget> = [];

  for (const logicalId of input.recreateViaCcApi) {
    if (seen.has(logicalId)) continue;
    seen.add(logicalId);

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
    };
    targets.push(target);

    // Multi-region refusal (design §8 — out of scope for v1). Refused
    // regardless of `--force-stateful-recreation`; the user has no
    // bypass flag for this category by design.
    if (MULTI_REGION_RECREATE_BLOCKED_TYPES.has(resourceType)) {
      blockedMultiRegionTargets.push(target);
    }

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
    blockedStatefulTargets,
    blockedMultiRegionTargets,
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

  if (validation.unknownLogicalIds.length > 0) {
    lines.push(
      `--recreate-via-cc-api named ${validation.unknownLogicalIds.length} ` +
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
  }

  if (validation.missingFromState.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `--recreate-via-cc-api named ${validation.missingFromState.length} ` +
        `logical id(s) the template declares but cdkd state has no record of:`
    );
    for (const id of validation.missingFromState) {
      lines.push(`  - ${id}`);
    }
    lines.push(
      `  These are fresh CREATEs on the next deploy — recreate has nothing ` +
        `to destroy first. Remove the --recreate-via-cc-api flag for these ` +
        `resources; the new auto-route via Cloud Control (#614) handles ` +
        `fresh deploys.`
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
      `--recreate-via-cc-api would destroy + recreate ` +
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

  if (validation.blockedMultiRegionTargets.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `--recreate-via-cc-api refuses to operate on ` +
        `${validation.blockedMultiRegionTargets.length} multi-region resource(s) — ` +
        `out of scope for v1 of this flag (the destroy + recreate cycle across ` +
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

  return lines.length > 0 ? lines.join('\n') : null;
}
