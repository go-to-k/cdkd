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
 *      by an explicit `--force-stateful-recreation` flag. The sync
 *      first-cut runs from the recorded properties alone; the live
 *      `s3:ListObjectsV2` probe (issue [#648]) promotes a `null`
 *      reason to `'has-objects'` when a bucket actually contains data.
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

import { ListObjectVersionsCommand, type S3Client } from '@aws-sdk/client-s3';
import type { CloudFormationTemplate } from '../types/resource.js';
import type { StackState } from '../types/state.js';
import {
  isStatefulRecreateTargetSync,
  renderStatefulReason,
  MULTI_REGION_RECREATE_BLOCKED_TYPES,
  type StatefulReason,
} from '../provisioning/stateful-types.js';
import { findActionableSilentDrops } from '../provisioning/property-coverage.js';
import { getLogger } from '../utils/logger.js';
import type { Logger } from '../types/config.js';

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
}

/**
 * Plan-time validation of the user's recreate-via-cc-api list.
 *
 * Pure with respect to AWS — does NOT probe S3 bucket emptiness. Wrap
 * the result with {@link probeAndRevalidateStateful} to promote S3
 * targets' `statefulReason` via a live `s3:ListObjectsV2` round-trip
 * before rendering errors. The deploy command does this; the validator
 * itself stays sync so unit tests don't need an S3 mock.
 *
 * Input order is preserved; duplicate logical ids in the user's input
 * are deduplicated.
 */
const EMPTY_ALLOW_SET: ReadonlySet<string> = new Set();

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
  const blockedAlreadySdk: RecreateTarget[] = [];
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
    blockedAlreadySdk,
    blockedNoSdkProvider,
    conflictingDirections,
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
 * Async S3 object probe (issue [#648]).
 *
 * For every `AWS::S3::Bucket` target whose sync {@link StatefulReason}
 * is `null` (the sync map defers — see {@link isStatefulRecreateTargetSync}),
 * issues a single-page `ListObjectVersions(MaxKeys=1)` against the
 * bucket's recorded physical id. When the bucket has at least one
 * current object, prior version, OR delete-marker, promotes the
 * target's `statefulReason` to `'has-objects'`.
 *
 * Uses `ListObjectVersions` rather than `ListObjectsV2` so the probe
 * mirrors the s3-bucket-provider's `emptyBucket` view: a versioned
 * bucket whose current keys have all been soft-deleted (so
 * `ListObjectsV2.KeyCount === 0`) still holds prior versions +
 * delete-markers that the destroy + recreate cycle would lose. Using
 * the same listing API as the provider ensures the probe and the
 * destroy path agree on "empty".
 *
 * **Soft-fail on probe errors**: if `ListObjectVersions` throws
 * (permission denied, bucket-not-found mid-flight, transient network
 * error), logs a warn and leaves the target's `statefulReason` at the
 * sync result (`null`). The user can decide to proceed without the
 * probe by passing `--force-stateful-recreation`.
 *
 * Returns a NEW array of targets; the input is not mutated. Non-S3
 * targets and S3 targets whose sync reason is already non-null are
 * passed through unchanged.
 */
export async function probeStatefulRecreateTargetsAsync(
  targets: ReadonlyArray<RecreateTarget>,
  s3Client: S3Client,
  logger: Logger = getLogger().child('recreate-targets')
): Promise<RecreateTarget[]> {
  const promoted: RecreateTarget[] = [];
  for (const target of targets) {
    if (target.resourceType !== 'AWS::S3::Bucket' || target.statefulReason !== null) {
      promoted.push({ ...target });
      continue;
    }
    try {
      const result = await s3Client.send(
        new ListObjectVersionsCommand({
          Bucket: target.physicalId,
          MaxKeys: 1,
        })
      );
      const hasVersions = (result.Versions?.length ?? 0) > 0;
      const hasDeleteMarkers = (result.DeleteMarkers?.length ?? 0) > 0;
      if (hasVersions || hasDeleteMarkers) {
        promoted.push({ ...target, statefulReason: 'has-objects' });
      } else {
        promoted.push({ ...target });
      }
    } catch (e) {
      logger.warn(
        `--recreate-via-cc-api / --recreate-via-sdk-provider: live S3 probe failed for ${target.logicalId} ` +
          `(bucket ${target.physicalId}); leaving stateful guard at the sync ` +
          `result. If the bucket might be non-empty, re-run with ` +
          `--force-stateful-recreation. Underlying error: ` +
          `${e instanceof Error ? e.message : String(e)}`
      );
      promoted.push({ ...target });
    }
  }
  return promoted;
}

/**
 * Async re-validation of the stateful-guard slice of a
 * {@link RecreateTargetsValidation}, after promoting S3 bucket reasons
 * via {@link probeStatefulRecreateTargetsAsync}.
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
  s3Client: S3Client;
  forceStatefulRecreation: boolean;
}): Promise<RecreateTargetsValidation> {
  if (input.forceStatefulRecreation) return input.validation;
  const promoted = await probeStatefulRecreateTargetsAsync(
    input.validation.targets,
    input.s3Client
  );
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
