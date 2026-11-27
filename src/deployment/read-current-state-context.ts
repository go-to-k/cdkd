import { isReadableResourceEntry } from '../state/malformed-resources-bag.js';
import type { ReadCurrentStateContext } from '../types/resource.js';
import type { StackState } from '../types/state.js';

/**
 * Issue #323: build the cross-resource context passed to
 * `provider.readCurrentState` so IAM Role / User / Group readers can
 * filter out inline policies managed by a sibling `AWS::IAM::Policy`
 * resource. `excludedLogicalId` is the resource being read — it's
 * omitted from the siblings map so a self-reference can never collide.
 *
 * Built from STATE, not a template: `cdkd drift`, `cdkd import`,
 * `cdkd state refresh-observed` and the rollback replay's baseline refresh
 * (go-to-k/cdkd#6526) all read it, so the baseline a rollback writes is
 * filtered exactly as the drift read that later compares against it.
 */
export function buildReadCurrentStateContext(
  state: Pick<StackState, 'resources'>,
  excludedLogicalId: string
): ReadCurrentStateContext {
  const siblings: NonNullable<ReadCurrentStateContext['siblings']> = {};
  for (const [lid, res] of Object.entries(state.resources ?? {})) {
    if (lid === excludedLogicalId) continue;
    // go-to-k/cdkd#3018, and this one IS at the loop rather than at a load,
    // deliberately: the helper is EXPORTED and its callers reach it with
    // different guarantees — `cdkd drift` and `cdkd state refresh-observed`
    // settle the record's shape at their own load sites, while `cdkd import`
    // hands it a record it is midway through building.
    //
    // TWO outcomes, not one, and the second is why a `try` around the next lines
    // would not do instead: a `null` sibling CRASHES on `res.resourceType`,
    // while a string, a number, a list or an OBJECT WITH NO TYPE does NOT — it
    // yields `undefined` for every field it lacks and enters the map as a
    // sibling record naming no resource. A provider reading that map to resolve
    // a cross-resource reference is then answered about a resource that does
    // not exist. The predicate asks for the resource TYPE for that reason: it
    // is the field every reader of an entry touches first.
    if (!isReadableResourceEntry(res)) continue;
    siblings[lid] = {
      resourceType: res.resourceType,
      physicalId: res.physicalId,
      properties: res.properties ?? {},
      attributes: res.attributes ?? {},
    };
  }
  // go-to-k/cdkd#4447: the read resource's own recorded attributes, through
  // the same readability gate as a sibling's.
  const own: unknown = (state.resources ?? {})[excludedLogicalId];
  const ownRecord = (
    key: 'attributes' | 'observedProperties'
  ): Record<string, unknown> | undefined => {
    const value = isReadableResourceEntry(own) ? (own as Record<string, unknown>)[key] : undefined;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  };
  const ownAttributes = ownRecord('attributes');
  // go-to-k/cdkd#6616: the own drift baseline, through the same gate.
  const ownObserved = ownRecord('observedProperties');
  // go-to-k/cdkd#7061: the own record's secrecy provenance, as stored, so a
  // provider asks `recordedSecrecyOf` rather than the value's text alone.
  // Set only when the record holds either field.
  const ownFields = isReadableResourceEntry(own) ? (own as Record<string, unknown>) : {};
  const noEchoLeaves = ownFields['noEchoLeaves'];
  const maskedPropertyFingerprints = ownFields['maskedPropertyFingerprints'];
  const ownProvenance =
    noEchoLeaves !== undefined || maskedPropertyFingerprints !== undefined
      ? { noEchoLeaves, maskedPropertyFingerprints }
      : undefined;
  // go-to-k/cdkd#6641: a Cloud Control readback assigns no rule by id.
  const ccApiRead =
    isReadableResourceEntry(own) && (own as { provisionedBy?: unknown }).provisionedBy === 'cc-api';
  return {
    siblings,
    ...(ccApiRead && { ccApiRead: true }),
    ...(ownAttributes && { attributes: ownAttributes }),
    ...(ownObserved && { driftBaseline: ownObserved }),
    ...(ownProvenance && { provenance: ownProvenance }),
  };
}
