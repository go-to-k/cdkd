/**
 * `TimeToLiveSpecification` planning shared by `AWS::DynamoDB::Table` and
 * `AWS::DynamoDB::GlobalTable` (issue #5447). TTL never rides on
 * CreateTable / UpdateTable: it is the separate `UpdateTimeToLive` API, which
 * needs an `AttributeName` even to DISABLE TTL, while the CFn schema requires
 * only `Enabled`. Each provider sends the planned call through its own
 * retry / error wrapping.
 */

/** Normalize a `TimeToLiveSpecification` value into `{ enabled, attributeName }`. */
export function readTtlSpec(spec: unknown): {
  enabled: boolean;
  attributeName: string | undefined;
} {
  if (spec === undefined || spec === null) {
    return { enabled: false, attributeName: undefined };
  }
  const s = spec as Record<string, unknown>;
  const rawName = s['AttributeName'];
  const attributeName = typeof rawName === 'string' && rawName !== '' ? rawName : undefined;
  // CFn `Enabled` is a boolean for CDK L2 synth, but a hand-written L1
  // template can carry the stringified `"true"` / `"false"`. `Boolean("false")`
  // is `true`, so coerce strings case-insensitively rather than via the bare
  // `Boolean()` cast (which would treat `"false"` as enabled and either
  // re-enable a disabled TTL or fire the rename guard spuriously). Absent
  // `Enabled` defaults to `true` (CFn default).
  const rawEnabled = s['Enabled'];
  const enabled =
    rawEnabled === undefined
      ? true
      : typeof rawEnabled === 'string'
        ? rawEnabled.toLowerCase() === 'true'
        : Boolean(rawEnabled);
  return { enabled, attributeName };
}

/**
 * The `UpdateTimeToLive` call a TTL change needs:
 *
 * - `enable` / `disable` carry the attribute name to send;
 * - `disable-live` means the name is unknown (no enabled spec was recorded):
 *   read it with `DescribeTimeToLive` and disable only when TTL is
 *   `ENABLED` / `ENABLING`;
 * - `none` sends nothing.
 *
 * Disabling a TTL that is not enabled is refused by AWS ("TimeToLive is
 * already disabled"), so a desired-disabled spec sends nothing on create (a
 * new table starts with TTL disabled) nor when the recorded spec was already
 * disabled.
 */
export type TtlPlan =
  | { kind: 'none' }
  | { kind: 'enable'; attributeName: string }
  | { kind: 'disable'; attributeName: string }
  | { kind: 'disable-live' };

/**
 * Plan the TTL call for a desired spec. `previousSpec` is the recorded spec on
 * update; `mode: 'create'` means a brand-new table. Called only when the spec
 * changed.
 */
export function planTimeToLive(
  spec: unknown,
  previousSpec: unknown,
  mode: 'create' | 'update'
): TtlPlan {
  const desiredPresent = spec !== undefined && spec !== null;
  const desired = readTtlSpec(spec);
  if (desiredPresent && desired.enabled) {
    // `Enabled: true` without a name is unsendable; nothing to do.
    return desired.attributeName
      ? { kind: 'enable', attributeName: desired.attributeName }
      : { kind: 'none' };
  }

  // Desired state: TTL disabled, either `Enabled: false` or the whole block
  // removed (CloudFormation disables TTL on a removal too).
  if (mode === 'create') return { kind: 'none' };

  const previousPresent = previousSpec !== undefined && previousSpec !== null;
  const previous = readTtlSpec(previousSpec);
  if (previousPresent && previous.enabled && previous.attributeName) {
    // The disable must name the attribute TTL is ACTIVE on, which is the
    // recorded one, not a name the desired disabled spec may carry.
    return { kind: 'disable', attributeName: previous.attributeName };
  }
  if (previousPresent && !previous.enabled) {
    // Recorded as disabled already.
    return { kind: 'none' };
  }
  if (!desiredPresent) {
    // Removal of a block that never sent an enable (`Enabled: true` with no
    // name): nothing was enabled by this template.
    return { kind: 'none' };
  }
  // `Enabled: false` newly declared on a table whose template never enabled
  // TTL: the live state is the only source of the attribute name.
  return { kind: 'disable-live' };
}
