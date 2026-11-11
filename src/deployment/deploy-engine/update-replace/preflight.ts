import { type DeployEngine } from '../../deploy-engine.js';
import { ccBrokenReason } from '../../../provisioning/provider-registry.js';
import {
  recordedProtectionEvidence,
  recordedProtectionNote,
} from '../../../provisioning/recorded-protection.js';
import {
  isStatefulRecreateTargetForReplace,
  renderStatefulReason,
} from '../../../provisioning/stateful-types.js';
import { type ResourceChange, type ResourceState } from '../../../types/state.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { CdkdError } from '../../../utils/error-handler.js';
import { markRefusedBeforeApplying } from '../../prior-attempt-scope.js';
import { markNonRetryable } from '../../retryable-errors.js';

/**
 * `updateByReplacement`'s pre-flight refusals (`update-replace.ts`), split out
 * of it (go-to-k/cdkd#5835): the stateful guard and the `--recreate-via-cc-api`
 * route checks, run before anything is created or deleted.
 */
export function refuseUnsafeReplacement(
  engine: DeployEngine,
  {
    change,
    currentProps,
    currentResource,
    logicalId,
    oldResourceType,
    propertyDrivenReplacement,
    recreateFlagged,
    recreateViaCcApi,
    resourceType,
    typeChanged,
    updateReplacePolicy,
  }: {
    change: ResourceChange;
    currentProps: Record<string, unknown>;
    currentResource: ResourceState;
    logicalId: string;
    oldResourceType: string;
    propertyDrivenReplacement: boolean | undefined;
    recreateFlagged: boolean;
    recreateViaCcApi: boolean;
    resourceType: string;
    typeChanged: boolean;
    updateReplacePolicy: 'Delete' | 'Retain' | 'Snapshot' | undefined;
  }
): void {
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
    if (statefulReason && engine.options.forceStatefulRecreation !== true) {
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
      // `markRefusedBeforeApplying` (#6118): this runs before any delete or
      // create, so the journal keeps no failed-op bag and no `--revert-failed`
      // remedy is printed. The `RECREATE_TARGETS_INVALID` throws below match.
      // Issue #2610 site 9: the advised flag cannot remove a resource AWS
      // protects, since the replacement's delete never carries
      // `removeProtection`. Read off the OLD resource's record, like the guard.
      const protection = recordedProtectionEvidence(
        oldResourceType,
        currentProps,
        currentResource.observedProperties,
        engine.stackRegion
      );
      throw markRefusedBeforeApplying(
        markNonRetryable(
          new CdkdError(
            safeMsg`${logicalId} (${oldResourceType}) requires replacement (immutable property changed: ${immutableProps}${typeChanged ? `, to ${resourceType}` : ''}) but it is a stateful resource — ` +
              safeMsg`${renderStatefulReason(statefulReason)}. ` +
              (protection
                ? safeMsg`${recordedProtectionNote(protection, '--force-stateful-recreation')} Or change ` +
                  `the resource's definition to avoid the immutable-property change.`
                : `Re-run with --force-stateful-recreation to confirm the data loss, or change the ` +
                  `resource definition to avoid the immutable-property change.`),
            'STATEFUL_REPLACE_BLOCKED'
          )
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
    const noCcRoute = engine.providerRegistry.ccRouteUnavailableReason(resourceType);
    if (noCcRoute !== undefined) {
      throw markRefusedBeforeApplying(
        markNonRetryable(
          new CdkdError(
            safeMsg`--recreate-via-cc-api cannot recreate ${logicalId} (${resourceType}): Cloud ` +
              safeMsg`Control API cannot create this type (${noCcRoute}). Nothing was deleted. ` +
              safeMsg`Drop ${logicalId} from --recreate-via-cc-api.`,
            'RECREATE_TARGETS_INVALID'
          )
        )
      );
    }
    // Issue #4119: routing ignores the flag for this type, so the
    // recreate would delete and recreate it on the SDK route.
    const ccBroken = ccBrokenReason(resourceType);
    if (ccBroken !== undefined) {
      throw markRefusedBeforeApplying(
        markNonRetryable(
          new CdkdError(
            safeMsg`--recreate-via-cc-api cannot move ${logicalId} (${resourceType}) to Cloud ` +
              safeMsg`Control: ${ccBroken}, so cdkd keeps it on its SDK provider. Nothing was ` +
              safeMsg`deleted. Drop ${logicalId} from --recreate-via-cc-api.`,
            'RECREATE_TARGETS_INVALID'
          )
        )
      );
    }
  }
}
