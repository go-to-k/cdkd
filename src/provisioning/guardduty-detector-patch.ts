import type { JsonPatchOp } from './json-patch-generator.js';

const DETECTOR_TYPE = 'AWS::GuardDuty::Detector';

/** The read-back keys `UpdateDetector` refuses beside each other. */
const READ_BACK_KEYS = ['Features', 'DataSources'] as const;

/**
 * Extend a Cloud Control update patch for `AWS::GuardDuty::Detector` so the
 * keys GuardDuty fills in on read never reach `UpdateDetector` (issue
 * [#4910](https://github.com/go-to-k/cdkd/issues/4910)).
 *
 * Cloud Control applies the patch on top of the model its read handler
 * returns, and for a detector that model carried both `DataSources` and the
 * FULL `Features` list on every read measured (see the remove ops below) (every feature GuardDuty knows,
 * `EKS_RUNTIME_MONITORING` and `RUNTIME_MONITORING` both included), whichever
 * of them the template declares. `UpdateDetector` refuses a request carrying
 * `DataSources` beside `Features`, and one carrying both runtime features, so
 * a patch that leaves `Features` as read fails, and so does one that sends any
 * `Features` beside the read-back `DataSources`.
 *
 * For each of the two keys the patch has no op on, a non-empty patch gets
 * `add /<key>` with the desired value when the desired properties declare it
 * (`add` replaces an existing member, RFC 6902), and `remove /<key>` when they
 * do not. The request then carries what the template declares, as a
 * CloudFormation update does. Measured on all three template shapes: `Features`
 * only, `DataSources` only, and neither.
 *
 * Settings the template does not mention keep their AWS value: measured for
 * the features the template omits and for `RDS_DATA_RISK`, which GuardDuty
 * enables under `RDS_LOGIN_EVENTS` (the `guardduty-detector-update` fixture).
 *
 * Every other type and an empty patch are returned unchanged (same array).
 */
export function withGuardDutyDetectorReadBackOps(
  resourceType: string,
  patch: JsonPatchOp[],
  desired: Record<string, unknown>
): JsonPatchOp[] {
  if (resourceType !== DETECTOR_TYPE || patch.length === 0) return patch;

  const extra: JsonPatchOp[] = [];
  for (const key of READ_BACK_KEYS) {
    // The generator emits top-level ops only (`json-patch-generator.ts`).
    if (patch.some((op) => op.path === `/${key}`)) continue;
    // A `remove` fails (RFC 6902) if the read model lacks the key. Both keys
    // were present on every read measured, but only in the aws partition's
    // us-east-1 and us-west-2: a missing-path error from another region or
    // partition starts here.
    extra.push(
      Object.prototype.hasOwnProperty.call(desired, key)
        ? { op: 'add', path: `/${key}`, value: desired[key] }
        : { op: 'remove', path: `/${key}` }
    );
  }
  return extra.length === 0 ? patch : [...patch, ...extra];
}
