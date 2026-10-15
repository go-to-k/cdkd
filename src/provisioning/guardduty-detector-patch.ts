import { isDeepStrictEqual } from 'node:util';
import { markNonRetryable } from '../deployment/retryable-errors.js';
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
 * `readback` (`cdkd drift --revert`, go-to-k/cdkd#4921): the desired bag is
 * the AWS snapshot with the drifted keys overlaid, so a key the patch has no op
 * on is NOT drifted and holds exactly what was read back (both keys, on every
 * read measured). It is removed instead of added: `UpdateDetector` leaves an omitted
 * setting as it is. A drifted `Features` op carries the whole baseline list,
 * read back too (both runtime features), so its value is narrowed to the
 * entries that differ, by `Name`, from the `previous` (AWS-current) list (an
 * entry without a string `Name`, a non-list current value, or an op with no
 * list value, such as a `remove`, keeps the op as it was), and a drifted
 * `DataSources` beside a surviving `Features` op is removed. When NO entry
 * differs, the drift is only in order or in entries GuardDuty added, which
 * `UpdateDetector` cannot undo, so the revert is refused rather than reported
 * as done (go-to-k/cdkd#4935 M1). An undrifted key the AWS-current bag lacks
 * gets no `remove`, which would fail on a missing path (RFC 6902). Not handled: a drift that
 * switched the runtime monitoring mode changes both runtime features, and
 * reverting it still sends both.
 *
 * Every other type and an empty patch are returned unchanged (same array).
 */
export function withGuardDutyDetectorReadBackOps(
  resourceType: string,
  patch: JsonPatchOp[],
  desired: Record<string, unknown>,
  readback?: { previous: Record<string, unknown> }
): JsonPatchOp[] {
  if (resourceType !== DETECTOR_TYPE || patch.length === 0) return patch;

  let out = patch;
  if (readback) {
    out = patch.map((op) =>
      op.path === '/Features' ? narrowToChangedFeatures(op, readback.previous['Features']) : op
    );
    // Toggling a feature that also has a legacy `DataSources` counterpart
    // (S3 logs, EKS audit logs, EBS malware protection) drifts BOTH keys, and
    // the two are refused together: send the `Features` revert alone, which
    // restores the `DataSources` view with it.
    if (out.some((op) => op.path === '/Features' && op.op !== 'remove')) {
      out = out.map((op) =>
        op.path === '/DataSources' ? { op: 'remove', path: '/DataSources' } : op
      );
    }
  }

  const extra: JsonPatchOp[] = [];
  for (const key of READ_BACK_KEYS) {
    // The generator emits top-level ops only (`json-patch-generator.ts`).
    if (out.some((op) => op.path === `/${key}`)) continue;
    // A `remove` fails (RFC 6902) if the read model lacks the key. Both keys
    // were present on every read measured, but only in the aws partition's
    // us-east-1 and us-west-2: a missing-path error from another region or
    // partition starts here.
    if (readback) {
      if (Object.prototype.hasOwnProperty.call(readback.previous, key)) {
        extra.push({ op: 'remove', path: `/${key}` });
      }
      continue;
    }
    extra.push(
      Object.prototype.hasOwnProperty.call(desired, key)
        ? { op: 'add', path: `/${key}`, value: desired[key] }
        : { op: 'remove', path: `/${key}` }
    );
  }
  return extra.length === 0 && out === patch ? patch : [...out, ...extra];
}

/**
 * Keep only the `Features` entries that differ from the same-`Name` entry of
 * the AWS-current list; none differing is refused (see the caller's doc). An
 * entry without a string `Name`, or a current value that is not a list, keeps
 * the op as it was.
 */
function narrowToChangedFeatures(op: JsonPatchOp, current: unknown): JsonPatchOp {
  if (!Array.isArray(op.value) || !Array.isArray(current)) return op;
  // A nameless live entry lands under `undefined`, a key the loop below
  // never reads: it returns first on a nameless desired entry.
  const byName = new Map<string | undefined, unknown>();
  for (const entry of current) byName.set(featureName(entry), entry);
  const changed: unknown[] = [];
  for (const entry of op.value as unknown[]) {
    const name = featureName(entry);
    if (name === undefined) return op;
    if (!isDeepStrictEqual(entry, byName.get(name))) changed.push(entry);
  }
  if (changed.length === 0) {
    throw markNonRetryable(
      new Error(
        'cannot revert Features: the live list differs from the recorded baseline only in the ' +
          'order of its entries or in entries GuardDuty added, which UpdateDetector cannot undo, ' +
          'so nothing on this detector was reverted. cdkd drift --accept would record the live ' +
          'list, but it records the live value of EVERY drifted property of the stack, not only ' +
          'Features: revert any other drift on this detector first (for example with ' +
          'aws guardduty update-detector), then run it.'
      )
    );
  }
  return { ...op, value: changed };
}

function featureName(entry: unknown): string | undefined {
  // A primitive reads `Name` as `undefined`; only null and undefined need `?.`.
  const name = (entry as Record<string, unknown> | null | undefined)?.['Name'];
  return typeof name === 'string' ? name : undefined;
}
