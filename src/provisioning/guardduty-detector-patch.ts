import type { JsonPatchOp } from './json-patch-generator.js';

const DETECTOR_TYPE = 'AWS::GuardDuty::Detector';

/**
 * Extend a Cloud Control update patch for `AWS::GuardDuty::Detector` so the
 * keys GuardDuty fills in on read never reach `UpdateDetector` (issue
 * [#4910](https://github.com/go-to-k/cdkd/issues/4910)).
 *
 * Cloud Control applies the patch on top of the model its read handler
 * returns, and for a detector that model carries two keys the template never
 * declared: `DataSources` (derived from the enabled features) and the FULL
 * `Features` list (every feature GuardDuty knows, `EKS_RUNTIME_MONITORING` and
 * `RUNTIME_MONITORING` both included). `UpdateDetector` refuses a request
 * carrying `DataSources` beside `Features`, and one carrying both runtime
 * features, so a patch that leaves either key as read fails — a scalar-only
 * change leaves both, a `Features` change leaves `DataSources`.
 *
 * Applies only when the desired properties declare `Features` as a list and do
 * not declare `DataSources` (the shape CDK's `CfnDetector` examples use, and
 * the only one measured), and only to a non-empty patch: it adds
 * `add /Features` with the desired list when the patch has no `/Features` op,
 * and `remove /DataSources` when it has no `/DataSources` op. `add` replaces
 * an existing member (RFC 6902), and the read model always carries both keys —
 * after an update too — so neither op can miss its target.
 *
 * A feature setting the template does not mention keeps its AWS value:
 * `UpdateDetector` leaves an omitted feature or additional configuration as it
 * is (measured on `RDS_LOGIN_EVENTS`' `RDS_DATA_RISK`).
 *
 * Every other type, the legacy `DataSources`-only shape, and an empty patch
 * are returned unchanged (same array).
 */
export function withGuardDutyDetectorReadBackOps(
  resourceType: string,
  patch: JsonPatchOp[],
  desired: Record<string, unknown>
): JsonPatchOp[] {
  if (resourceType !== DETECTOR_TYPE || patch.length === 0) return patch;
  if (!Array.isArray(desired['Features'])) return patch;
  if (Object.prototype.hasOwnProperty.call(desired, 'DataSources')) return patch;

  const touches = (key: string): boolean =>
    patch.some((op) => op.path === `/${key}` || op.path.startsWith(`/${key}/`));

  const extra: JsonPatchOp[] = [];
  if (!touches('Features')) {
    extra.push({ op: 'add', path: '/Features', value: desired['Features'] });
  }
  if (!touches('DataSources')) {
    extra.push({ op: 'remove', path: '/DataSources' });
  }
  return extra.length === 0 ? patch : [...patch, ...extra];
}
