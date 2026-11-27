import { type DeployEngine } from '../../deploy-engine.js';
import { ccBrokenReason } from '../../../provisioning/provider-registry.js';
import {
  recordedProtectionEvidence,
  recordedProtectionNote,
} from '../../../provisioning/recorded-protection.js';
import {
  isStatefulRecreateTargetForReplace,
  renderStatefulReason,
  STATEFUL_REPLACE_LEFTOVERS,
} from '../../../provisioning/stateful-types.js';
import { type ResourceChange, type ResourceState } from '../../../types/state.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  SPEC_REPLACEMENT_CFN_KEEPS_NAME,
  SPEC_REPLACEMENT_CFN_MEASURED,
} from '../../../analyzer/replacement-rules/spec-replacement-properties.generated.js';
import { CdkdError } from '../../../utils/error-handler.js';
import { markRefusedBeforeApplying } from '../../prior-attempt-scope.js';
import { markNonRetryable } from '../../retryable-errors.js';

/**
 * The CloudFormation-measured replacement paths (`SPEC_REPLACEMENT_CFN_MEASURED`)
 * at or under the top-level property of `pc`: the property itself, or each
 * nested member whose value differs between the change's old and new values
 * (both resolved, as the diff compared them; `128` and `"128"` are equal).
 */
function measuredPathsChanged(
  resourceType: string,
  pc: { path: string; oldValue?: unknown; newValue?: unknown }
): string[] {
  if (SPEC_REPLACEMENT_CFN_MEASURED.has(`${resourceType}#${pc.path}`)) return [pc.path];
  const prefix = `${resourceType}#${pc.path}.`;
  const at = (value: unknown, path: readonly string[]): unknown =>
    path.reduce<unknown>(
      (v, k) =>
        typeof v === 'object' && v !== null && !Array.isArray(v)
          ? (v as Record<string, unknown>)[k]
          : undefined,
      value
    );
  return [...SPEC_REPLACEMENT_CFN_MEASURED]
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(resourceType.length + 1))
    .filter((path) => {
      const sub = path.split('.').slice(1);
      return !sameValue(at(pc.oldValue, sub), at(pc.newValue, sub));
    })
    .sort();
}

/** Structural equality reading a number and its string spelling as one value. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => sameValue(v, b[i]))
    );
  }
  if (typeof a === 'object' || typeof b === 'object') {
    if (typeof a !== 'object' || typeof b !== 'object') return false;
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    return (
      ka.length === kb.length &&
      ka.every((k) =>
        sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
      )
    );
  }
  return String(a) === String(b);
}

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
      // go-to-k/cdkd#7100: a property the registry schema calls mutable that a
      // CloudFormation execution was measured replacing on. Say so, since the
      // user may expect the in-place update the schema suggests; only a
      // measured row may claim it.
      // A nested measured row (go-to-k/cdkd#7083, an FSx file system's
      // `LustreConfiguration.ImportPath`) names the member that changed: its
      // property change is keyed by the top-level property.
      const measuredReplaced = (change.propertyChanges ?? [])
        .filter((pc) => pc.requiresReplacement)
        .flatMap((pc) => measuredPathsChanged(oldResourceType, pc));
      // go-to-k/cdkd#7126: measured replacing, but CloudFormation's
      // replacement then fails on the name it keeps, so no data is lost there.
      const replacing = (change.propertyChanges ?? []).filter((pc) => pc.requiresReplacement);
      // Not when the same deploy changes that name: CloudFormation's
      // replacement then succeeds, and loses the data like any other.
      const keptNames = replacing.flatMap((pc) => {
        const name = SPEC_REPLACEMENT_CFN_KEEPS_NAME.get([oldResourceType, pc.path].join('#'));
        return name === undefined || replacing.some((other) => other.path === name)
          ? []
          : [{ path: pc.path, name }];
      });
      const keptNameList = [...new Set(keptNames.map((k) => k.name))].join(' / ');
      const leftovers = STATEFUL_REPLACE_LEFTOVERS.get(oldResourceType);
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
              (measuredReplaced.length > 0
                ? safeMsg`CloudFormation was measured replacing it on a ${measuredReplaced.join(' / ')} change, so the data is lost there as well. `
                : '') +
              (keptNames.length > 0
                ? safeMsg`CloudFormation was measured replacing it on a ${keptNames.map((k) => k.path).join(' / ')} change, and failing that replacement on the ${keptNameList} it keeps (AlreadyExists): it replaces only when the name changes too. `
                : '') +
              // go-to-k/cdkd#7126: what the replacement's delete leaves behind.
              (leftovers !== undefined ? safeMsg`On a replacement, ${leftovers}. ` : '') +
              (protection
                ? safeMsg`${recordedProtectionNote(protection, '--force-stateful-recreation')} Or change ` +
                  `the resource's definition to avoid the immutable-property change.`
                : keptNames.length > 0
                  ? // The flag alone cannot replace it: the create-first
                    // replacement collides on the kept name, as CloudFormation's does.
                    safeMsg`--force-stateful-recreation alone cannot replace it: the new resource ` +
                    safeMsg`would keep the same ${keptNameList} and ` +
                    `collide with the old one (AlreadyExists). Change ` +
                    safeMsg`${keptNameList} as well and re-run ` +
                    `with --force-stateful-recreation to confirm the data loss, or change the ` +
                    `resource definition to avoid the immutable-property change.`
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
