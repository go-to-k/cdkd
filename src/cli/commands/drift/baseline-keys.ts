/**
 * `cdkd drift`: per-type uncompared keys and the declared-property helpers.
 * Split out of `../drift.ts`, which re-exports the public names.
 */
import { hasOwnKey } from '../../../utils/own-keys.js';
import type { ResourceState } from '../../../types/state.js';
import { coerceCfnBoolean } from '../../../provisioning/config-shape.js';

/**
 * Per resource type, the top-level keys drift never compares unless the
 * template declares them on the resource (go-to-k/cdkd#5736, #5741).
 *
 * `AWS::S3::Bucket` `NotificationConfiguration`: CDK's
 * `bucket.addEventNotification(...)` (and `eventBridgeEnabled`) does not declare
 * it on the bucket. A `Custom::S3BucketNotifications` resource calls
 * `PutBucketNotificationConfiguration` after the bucket settles, and that
 * custom resource can live in ANOTHER stack (`Bucket.fromBucketName(...)
 * .addEventNotification(...)`, `Managed: false`), in a stack cdkd does not
 * manage, or be any other tool. The bucket's observed baseline is captured
 * before any of them runs and still holds a non-empty value
 * (`readNotification` always emits `EventBridgeConfiguration`), so
 * {@link undeclaredEmptyObservedKeys} does not skip it.
 */
const UNDECLARED_UNCOMPARED_KEYS: Readonly<Record<string, readonly string[]>> = {
  'AWS::S3::Bucket': ['NotificationConfiguration'],
};

/**
 * The top-level keys drift must NOT compare on one resource: its type's
 * {@link UNDECLARED_UNCOMPARED_KEYS} entries that its state `properties` (the
 * template) does not declare (go-to-k/cdkd#5741).
 *
 * WHY: comparing them reported another writer's configuration as drift, and
 * `drift --revert` wrote the baseline back and DELETED that writer's live
 * configuration. Scanning the state for the writing custom resource (#5736's
 * first rule, same stack only) cannot see every writer — another stack's state,
 * a CloudFormation-deployed stack, a non-CDK tool — and each one it misses is a
 * deletion path. CloudFormation drift compares only the properties the
 * template declares, so it reports nothing here either. A key the template DOES
 * declare is still compared, as it would be in CloudFormation.
 *
 * The rule reads only state, so a stack deployed with the old baseline is fixed
 * without a redeploy, and `--revert` / `--accept` never act on the key: both
 * work from the detected changes. It applies to an SDK-provisioned and a Cloud
 * Control-provisioned record alike. A record whose `properties` is not a plain
 * object gets no skip.
 */
export function undeclaredUncomparedDriftKeys(resourceType: string, properties: unknown): string[] {
  const keys = hasOwnKey(UNDECLARED_UNCOMPARED_KEYS, resourceType)
    ? UNDECLARED_UNCOMPARED_KEYS[resourceType]!
    : [];
  if (keys.length === 0) return [];
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    return [];
  }
  return keys.filter((key) => !hasOwnKey(properties as Record<string, unknown>, key));
}

/**
 * The top-level keys drift must NOT compare on one resource because its
 * observed baseline holds a value an earlier cdkd recorded by mistake
 * (go-to-k/cdkd#5749). Today one rule: an `AWS::Lambda::EventSourceMapping`
 * whose baseline holds `Enabled: false` while the template does not declare
 * `Enabled: false` and the live mapping reads `Enabled: true`.
 *
 * WHY: before #5737 the post-create baseline was read while the mapping was
 * still `Creating` and recorded `Enabled: false` for every mapping the
 * template leaves enabled. A no-change deploy never re-reads it, so on such a
 * stack `cdkd drift` reported `Enabled: false -> true` and `--revert` sent
 * `Enabled: false`, stopping the consumer. CloudFormation compares the live
 * value with the template (absent means `true`), so it reports nothing here.
 *
 * Read with {@link coerceCfnBoolean}, the reading the provider's
 * `enabledFromState` gives the template value. A template declaring
 * `Enabled: false` keeps the normal comparison, as does a live mapping that
 * reads disabled, so a disable cdkd did not make is still reported against a
 * `true` baseline. What the rule cannot tell apart: a disable that was
 * accepted into the baseline and then re-enabled outside cdkd. Re-enabling
 * against the template's own default is not reported, which is what
 * CloudFormation would say too. A live `true` also comes from a mapping still
 * `Creating` / `Updating` under such a template (`enabledFromState` answers
 * the template's value there); skipping the key then is no loss, since the
 * comparison would have reported the same stale `false -> true`.
 *
 * Read-only and per resource: nothing is written to state. `--revert` and
 * `--accept` act only on detected changes, so neither touches the key. The
 * baseline is rewritten by the next update deploy of the mapping or by
 * `cdkd state refresh-observed`. Only the observed baseline can carry the
 * artifact; the `properties` fallback is the template itself.
 */
export function preFixBaselineUncomparedDriftKeys(
  resourceType: string,
  observed: Record<string, unknown> | undefined,
  properties: unknown,
  aws: Record<string, unknown>
): string[] {
  if (resourceType !== 'AWS::Lambda::EventSourceMapping') return [];
  if (observed === undefined) return [];
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    return [];
  }
  const declared = hasOwnKey(properties as Record<string, unknown>, 'Enabled')
    ? coerceCfnBoolean((properties as Record<string, unknown>)['Enabled'])
    : undefined;
  const recorded = hasOwnKey(observed, 'Enabled')
    ? coerceCfnBoolean(observed['Enabled'])
    : undefined;
  const live = hasOwnKey(aws, 'Enabled') ? aws['Enabled'] : undefined;
  return recorded === false && declared !== false && live === true ? ['Enabled'] : [];
}

/**
 * The physical ids of every record of `resources` OTHER than `logicalId`'s
 * (go-to-k/cdkd#4810). Drift resolves state with no resource records, so no
 * `Ref` / `Fn::GetAtt` read records a copy; each of these ids is stored in
 * plaintext in its own record, so a reader's copy of one adds nothing to
 * state. The record's OWN id is left out, as a deploy records none: a
 * resource never reads itself.
 */
export function otherPhysicalIds(
  resources: Record<string, ResourceState> | undefined,
  logicalId: string
): string[] {
  const ids: string[] = [];
  for (const [id, record] of Object.entries(resources ?? {})) {
    if (id !== logicalId && typeof record?.physicalId === 'string') ids.push(record.physicalId);
  }
  return ids;
}

/**
 * The top-level keys `properties` (a record's template side) declares EMPTY:
 * `''`, `[]`, `{}`, or a JSON string of an empty list or object
 * (`UpdateContext.declaredEmptyProperties`, go-to-k/cdkd#4884). A key whose
 * value is anything else, unparsable or a mask included, is not in it.
 */
export function declaredEmptyProperties(properties: unknown): ReadonlySet<string> {
  const out = new Set<string>();
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    return out;
  }
  const isEmpty = (v: unknown): boolean =>
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);
  for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
    if (typeof value === 'string') {
      if (value.trim() === '') {
        out.add(key);
        continue;
      }
      try {
        if (isEmpty(JSON.parse(value) as unknown)) out.add(key);
      } catch {
        // Not JSON: a declared value, not an empty one.
      }
    } else if (isEmpty(value)) {
      out.add(key);
    }
  }
  return out;
}

/**
 * The top-level keys `properties` (a record's template side) declares as the
 * boolean `true`: `true` or the string `'true'`
 * (`UpdateContext.declaredTrueProperties`, go-to-k/cdkd#5707). Anything else,
 * `'True'`, a mask, an intrinsic or a nested `true` included, is not in it.
 * On a record with no `observedProperties`, `properties` can also hold a value
 * `cdkd drift --accept` wrote from the readback, which then counts.
 */
export function declaredTrueProperties(properties: unknown): ReadonlySet<string> {
  const out = new Set<string>();
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    return out;
  }
  for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
    if (value === true || value === 'true') out.add(key);
  }
  return out;
}
