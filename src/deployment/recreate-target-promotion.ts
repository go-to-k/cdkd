import type { ResourceChange } from '../types/state.js';
import type { DeployEngineOptions } from './deploy-engine/options.js';

/** A `--recreate-via-*` target this deploy cannot recreate, and why. */
export interface UnreachedRecreateTarget {
  logicalId: string;
  flag: '--recreate-via-cc-api' | '--recreate-via-sdk-provider';
  /** The diff's verdict for the id, or `undefined` when the diff has no row for it. */
  changeType: ResourceChange['changeType'] | undefined;
}

/**
 * go-to-k/cdkd#4383: the `--recreate-via-*` target ids of `stackName`, for
 * the diff to seed the replacement pass with, so a target's same-stack
 * `Ref` / `Fn::GetAtt` readers are re-provisioned against the id the
 * recreate mints. `undefined` for any other stack — a nested child engine
 * receives the parent's option bag, and the ids were validated against the
 * parent's template only (issue #2567).
 */
export function recreateTargetIdsFor(
  recreateTargets: DeployEngineOptions['recreateTargets'],
  stackName: string
): ReadonlySet<string> | undefined {
  if (recreateTargets === undefined || recreateTargets.stackName !== stackName) return undefined;
  const ids = new Set([...recreateTargets.viaCcApi, ...recreateTargets.viaSdkProvider]);
  return ids.size > 0 ? ids : undefined;
}

/**
 * Issue #2651: make every validated `--recreate-via-*` target reach the
 * UPDATE arm, where the recreate is decided.
 *
 * The flag moves a resource between provisioning layers, which is not a
 * template edit, so the diff ordinarily calls the target NO_CHANGE — and a
 * NO_CHANGE row is never dispatched. Before this, the deploy printed the
 * consented per-target plan, then "No changes detected", and exited 0 with
 * the record still on the old layer. Such a row is turned into an UPDATE
 * carrying no property change; the UPDATE arm then routes it to the
 * replacement because the id is flagged.
 *
 * A target whose row is anything else is returned rather than promoted, so
 * the caller can say so rather than drop the flag in silence: a CREATE row
 * has no record to recreate, a DELETE row is a resource this deploy removes
 * (a `Condition` that now evaluates false, for one), and no row at all means
 * the id is not in this deploy.
 *
 * Scoped by `stackName` exactly as the UPDATE arm reads the targets
 * (issue #2567): a nested child engine receives the parent's option bag,
 * and its template never validated these ids.
 *
 * Mutates `changes` in place, as the diff calculator's own promotion passes do.
 */
export function promoteRecreateTargets(
  changes: Map<string, ResourceChange>,
  recreateTargets: DeployEngineOptions['recreateTargets'],
  stackName: string
): { promoted: string[]; unreached: UnreachedRecreateTarget[] } {
  const promoted: string[] = [];
  const unreached: UnreachedRecreateTarget[] = [];
  if (recreateTargets === undefined || recreateTargets.stackName !== stackName) {
    return { promoted, unreached };
  }
  const named: Array<[string, UnreachedRecreateTarget['flag']]> = [
    ...[...recreateTargets.viaCcApi].map((id): [string, UnreachedRecreateTarget['flag']] => [
      id,
      '--recreate-via-cc-api',
    ]),
    ...[...recreateTargets.viaSdkProvider].map((id): [string, UnreachedRecreateTarget['flag']] => [
      id,
      '--recreate-via-sdk-provider',
    ]),
  ];
  for (const [logicalId, flag] of named) {
    const change = changes.get(logicalId);
    if (change?.changeType === 'NO_CHANGE') {
      change.changeType = 'UPDATE';
      change.propertyChanges = [];
      promoted.push(logicalId);
    } else if (change?.changeType !== 'UPDATE') {
      unreached.push({ logicalId, flag, changeType: change?.changeType });
    }
  }
  return { promoted, unreached };
}
