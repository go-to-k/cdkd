/**
 * go-to-k/cdkd#6437: the ASG's reading of its `UpdatePolicy`, shared by the
 * provider's `update()` and the deploy engine (its hint and the
 * `AutoScalingReplacingUpdate` routing in
 * `src/deployment/deploy-engine/update-policy.ts`). Import-free on purpose:
 * the engine loads providers lazily, and importing `update.ts` from it would
 * load the Auto Scaling SDK client on every deploy.
 */

/**
 * `IgnoreUnmodifiedGroupSizeProperties` set to the literal `true` (or the
 * string `'true'`, as a template may spell a boolean). An intrinsic there is
 * not resolved and reads as unset, the pre-#6437 behaviour of sending every
 * size property.
 */
export function ignoresUnmodifiedGroupSize(
  updatePolicy: Readonly<Record<string, unknown>> | undefined
): boolean {
  const scheduled = updatePolicy?.['AutoScalingScheduledAction'];
  if (typeof scheduled !== 'object' || scheduled === null) return false;
  const flag = (scheduled as Record<string, unknown>)['IgnoreUnmodifiedGroupSizeProperties'];
  return flag === true || flag === 'true';
}

/**
 * `AutoScalingReplacingUpdate.WillReplace` set to the literal `true` (or
 * `'true'`). CloudFormation: "If both the `AutoScalingReplacingUpdate` and
 * `AutoScalingRollingUpdate` policies are specified, setting the
 * `WillReplace` property to `true` gives `AutoScalingReplacingUpdate`
 * precedence." An intrinsic reads as unset.
 */
export function willReplaceGroup(
  updatePolicy: Readonly<Record<string, unknown>> | undefined
): boolean {
  const replacing = updatePolicy?.['AutoScalingReplacingUpdate'];
  if (typeof replacing !== 'object' || replacing === null) return false;
  const flag = (replacing as Record<string, unknown>)['WillReplace'];
  return flag === true || flag === 'true';
}

/**
 * The `AutoScalingRollingUpdate` block when it governs the update: an object,
 * and not overridden by `WillReplace: true` (see {@link willReplaceGroup}).
 */
export function rollingUpdatePolicy(
  updatePolicy: Readonly<Record<string, unknown>> | undefined
): Readonly<Record<string, unknown>> | undefined {
  const rolling = updatePolicy?.['AutoScalingRollingUpdate'];
  if (typeof rolling !== 'object' || rolling === null || Array.isArray(rolling)) return undefined;
  if (willReplaceGroup(updatePolicy)) return undefined;
  return rolling as Record<string, unknown>;
}

/**
 * The properties whose change makes CloudFormation apply an
 * `AutoScalingReplacingUpdate` / `AutoScalingRollingUpdate` (the UpdatePolicy
 * attribute page: "Change the Auto Scaling group's
 * AWS::AutoScaling::LaunchConfiguration", "`VPCZoneIdentifier`",
 * "`LaunchTemplate`", "`PlacementGroup`"). The page's fifth case, "an Auto
 * Scaling group that contains instances that don't match the current
 * `LaunchConfiguration`", needs a live read of every instance and is not
 * applied by cdkd.
 */
export const REPLACEMENT_TRIGGER_PROPERTIES: readonly string[] = [
  'LaunchConfigurationName',
  'LaunchTemplate',
  'VPCZoneIdentifier',
  'PlacementGroup',
];

/**
 * CloudFormation's trigger list for `AutoScalingInstanceRefresh`:
 * "CloudFormation performs an instance refresh only when you update one of the
 * following properties".
 */
export const INSTANCE_REFRESH_TRIGGER_PROPERTIES: readonly string[] = [
  'LaunchTemplate',
  'MixedInstancesPolicy',
  'VPCZoneIdentifier',
  'AvailabilityZones',
  'AvailabilityZoneIds',
  'PlacementGroup',
];

/** Properties compared as a set: their order is not a change. */
const SET_VALUED = new Set(['VPCZoneIdentifier', 'AvailabilityZones', 'AvailabilityZoneIds']);

/**
 * The `keys` whose value differs between the two bags, in `keys` order. A
 * scalar is compared by its text (`2` and `'2'` are one launch template
 * version), and `VPCZoneIdentifier` / `AvailabilityZones` /
 * `AvailabilityZoneIds` as a set, in either spelling (a list or the
 * comma-joined string).
 */
export function changedTriggers(
  keys: readonly string[],
  desired: Readonly<Record<string, unknown>>,
  previous: Readonly<Record<string, unknown>>
): string[] {
  return keys.filter((key) =>
    SET_VALUED.has(key)
      ? subnetSetKey(desired[key]) !== subnetSetKey(previous[key])
      : scalarTextKey(desired[key]) !== scalarTextKey(previous[key])
  );
}

/** A value's text with object keys sorted and every number / boolean as a string. */
function scalarTextKey(value: unknown): string {
  if (value === undefined || value === null) return '';
  return JSON.stringify(canonical(value));
}

function canonical(value: unknown): unknown {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

function subnetSetKey(value: unknown): string {
  const ids = Array.isArray(value)
    ? value.map((v) => (typeof v === 'string' ? v.trim() : scalarTextKey(v)))
    : typeof value === 'string'
      ? value.split(',').map((v) => v.trim())
      : value === undefined || value === null
        ? []
        : [scalarTextKey(value)];
  return JSON.stringify([...new Set(ids.filter((id) => id.length > 0))].sort());
}
