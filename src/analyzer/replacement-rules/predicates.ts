import { isDeepStrictEqual } from 'node:util';
import { sameLambdaFunctionAddress } from '../../utils/lambda-function-name.js';
import type { ReplacementSiblings } from './types.js';

/**
 * Conditional-replacement predicate for `AWS::EC2::VPC.InstanceTenancy`
 * (issue [#5449](https://github.com/go-to-k/cdkd/issues/5449)). MEASURED
 * against CloudFormation (us-east-1, 2026-10-28; change sets say
 * `Replacement: Conditional`): `default` -> `dedicated` creates a new VPC,
 * while `dedicated` -> `default` and a removal from `dedicated` keep the VPC
 * and change it in place (ModifyVpcTenancy). An absent value is `default`.
 */
export function vpcInstanceTenancyChangeReplaces(oldValue: unknown, newValue: unknown): boolean {
  const tenancyOf = (v: unknown): string => (v == null ? 'default' : String(v));
  return tenancyOf(newValue) !== 'default' && tenancyOf(newValue) !== tenancyOf(oldValue);
}

/**
 * Conditional-replacement predicate for `AWS::EC2::Instance.SecurityGroupIds`
 * (issue [#5446](https://github.com/go-to-k/cdkd/issues/5446)). MEASURED
 * against CloudFormation (us-east-1, 2026-10-28, change sets say
 * `Replacement: Conditional`): with a `SubnetId` the groups change in place
 * with no interruption (vary, add, and a removal, which leaves the VPC's
 * `default` group); with NO `SubnetId` (an instance launched into the default
 * VPC) the same vary and the removal create a new instance. Without the
 * sibling bags the common case (a `SubnetId`, which CDK's L2 always emits)
 * answers in place.
 */
export function instanceSecurityGroupIdsChangeReplaces(
  oldValue: unknown,
  newValue: unknown,
  siblings?: ReplacementSiblings
): boolean {
  if (siblings === undefined) return false;
  // A reorder of the same groups is no change, as `EC2Provider` compares
  // them (not measured against CloudFormation; replacing over it would
  // destroy an instance for nothing).
  if (Array.isArray(oldValue) && Array.isArray(newValue)) {
    const before = new Set(oldValue.map(String));
    const after = new Set(newValue.map(String));
    if (before.size === after.size && [...before].every((g) => after.has(g))) return false;
  }
  return siblings.newProperties['SubnetId'] == null;
}

/**
 * Conditional-replacement predicate for `AWS::EC2::Instance.Tenancy` (issue
 * [#5630](https://github.com/go-to-k/cdkd/issues/5630)). MEASURED against
 * CloudFormation (us-east-1, 2026-11-04, a t3.nano; change sets say
 * `Replacement: Conditional`): removing a declared `default` and adding
 * `default` to an instance without it both create a new instance.
 *
 * - A RECORDED value changed to or from `default` (a removal included)
 *   replaces, as CloudFormation does.
 * - A change between two non-default values (`dedicated` <-> `host`) is NOT
 *   measured (it needs a Dedicated Host): CloudFormation may apply it in place
 *   with ModifyInstancePlacement on a stopped instance. It does not replace
 *   here, and `EC2Provider` refuses it before any call rather than guess.
 * - A value the RECORD lacks does not replace: a record written by an earlier
 *   cdkd under `--prefer-sdk-route` dropped a declared Tenancy (it was
 *   SDK-unwired), so the template's value may be what AWS already holds.
 *   `EC2Provider` reads the live tenancy and refuses (`cdkd deploy --replace`
 *   opts in) only when it differs.
 */
export function instanceTenancyChangeReplaces(oldValue: unknown, newValue: unknown): boolean {
  if (oldValue == null) return false;
  if (newValue == null) return true;
  const text = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));
  const before = text(oldValue);
  const after = text(newValue);
  if (before === after) return false;
  return before === 'default' || after === 'default';
}

/**
 * Conditional-replacement predicate for
 * `AWS::EC2::Instance.PrivateDnsNameOptions` (issue
 * [#5630](https://github.com/go-to-k/cdkd/issues/5630)). MEASURED against
 * CloudFormation (us-east-1, 2026-11-04, a t3.nano): removing the whole block
 * creates a new instance (the new one takes the subnet's defaults), while
 * adding it or changing a member keeps the instance (`EC2Provider` applies
 * those with ModifyPrivateDnsNameOptions, a HostnameType change with a stop and
 * a start). A block the RECORD lacks is never a removal.
 */
export function instancePrivateDnsNameOptionsChangeReplaces(
  oldValue: unknown,
  newValue: unknown
): boolean {
  return oldValue != null && newValue == null;
}

/**
 * Conditional-replacement predicate for
 * `AWS::EC2::Instance.BlockDeviceMappings` (issue
 * [#5446](https://github.com/go-to-k/cdkd/issues/5446)). MEASURED against
 * CloudFormation (us-east-1, 2026-10-28): a change to `Ebs.DeleteOnTermination`
 * alone updates in place with no interruption; a `VolumeSize` change, adding a
 * device, and removing the property create a new instance. So anything but a
 * `DeleteOnTermination`-only change replaces; `EC2Provider` applies that one
 * with `ModifyInstanceAttribute`.
 */
export function instanceBlockDeviceMappingsChangeReplaces(
  oldValue: unknown,
  newValue: unknown
): boolean {
  return !blockDeviceMappingsDifferOnlyInDeleteOnTermination(oldValue, newValue);
}

/**
 * True when both are lists of the same devices, in the same order, equal in
 * everything but `Ebs.DeleteOnTermination`. Scalars compare as strings, so
 * CloudFormation's stringly-typed `"8"` equals `8`.
 */
export function blockDeviceMappingsDifferOnlyInDeleteOnTermination(
  oldValue: unknown,
  newValue: unknown
): boolean {
  if (!Array.isArray(oldValue) || !Array.isArray(newValue)) return false;
  if (oldValue.length !== newValue.length) return false;
  const strip = (m: unknown): unknown => {
    if (m === null || typeof m !== 'object' || Array.isArray(m)) return m;
    const out: Record<string, unknown> = { ...(m as Record<string, unknown>) };
    const ebs = out['Ebs'];
    if (ebs !== null && typeof ebs === 'object' && !Array.isArray(ebs)) {
      const rest: Record<string, unknown> = { ...(ebs as Record<string, unknown>) };
      delete rest['DeleteOnTermination'];
      out['Ebs'] = rest;
    }
    return out;
  };
  return oldValue.every((m, i) =>
    isDeepStrictEqual(scalarsAsStrings(strip(m)), scalarsAsStrings(strip(newValue[i])))
  );
}

function scalarsAsStrings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scalarsAsStrings);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, scalarsAsStrings(v)])
    );
  }
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : value;
}

/**
 * Conditional-replacement predicate for `AWS::DynamoDB::Table.AttributeDefinitions`.
 *
 * Returns true only when an attribute present in BOTH the old and new definition
 * lists changed its `AttributeType` (e.g. `S` -> `N`). Adding a brand-new attribute
 * (to back a new GSI) or removing one (when a GSI is dropped) returns false — those
 * are in-place `UpdateTable` operations, matching CloudFormation's "No interruption"
 * update behavior for this property.
 */
/**
 * Conditional-replacement predicate for `AWS::Lambda::Function.DurableConfig`.
 *
 * Returns true only when the block's PRESENCE toggles — added to a function
 * that had none, or dropped from one that had it. A change with the block
 * present on both sides (e.g. `ExecutionTimeout` 3600 -> 7200) is an in-place
 * `UpdateFunctionConfiguration`.
 *
 * Both toggle directions were established by live probe (us-east-1,
 * 2026-08-11), and neither is expressible as an in-place update:
 *
 *  - ADD: AWS rejects it outright — "You cannot add a durable configuration to
 *    a function that was originally created with no durable configuration"
 *    (`InvalidParameterValueException`). Classifying this in-place would make
 *    the deploy fail rather than converge.
 *  - REMOVE: `UpdateFunctionConfiguration` treats the omitted member as "no
 *    change" and KEEPS the live config, and there is no reset payload (the
 *    required `ExecutionTimeout` rejects an empty object). Classifying this
 *    in-place would report success while the function keeps a durable config
 *    the template no longer declares — the #1160 silent-drop class.
 *
 * A non-object on either side (an unresolved intrinsic) is compared on
 * presence alone, which is the conservative direction: it can over-report a
 * replacement, never silently skip a required one.
 */
export function durableConfigPresenceToggled(oldValue: unknown, newValue: unknown): boolean {
  return (oldValue == null) !== (newValue == null);
}

/**
 * Conditional-replacement predicate for `AWS::Lambda::EventInvokeConfig.FunctionName`
 * (issue [#4118](https://github.com/go-to-k/cdkd/issues/4118)).
 *
 * Lambda accepts the function as a name, a full ARN or a partial ARN
 * (`<account>:function:<name>`), so a template can re-spell the SAME function.
 * Treating that as a replacement is destructive: the create-first half Puts the
 * config onto the function, then the old half's delete removes it from the
 * same function, leaving none. Only a change of the function NAME replaces.
 *
 * Two ARNs must also agree on partition, region and account. A bare name
 * against an ARN cannot be confirmed here, so the provider's `update()`
 * resolves both spellings with `GetFunction` before its Put and refuses when
 * they are different functions.
 *
 * A QUALIFIED ARN (`...:function:<name>:<qualifier>`) is compared verbatim, as
 * is anything that is not a string (an unresolved intrinsic), so it still
 * replaces. For this type that is a known RESIDUAL, not a safe default: a
 * replacement onto the same target Puts the config and then deletes it.
 *
 * A call with NO value on either side (`undefined`, `undefined`) is the diff's
 * promoted-dependent probe -- the function this config points at is being
 * replaced, so the value WILL move once it resolves -- and answers `true`; the
 * engine's replacement ceiling lowers it when the value turns out unmoved.
 */
export function eventInvokeConfigFunctionChanged(oldValue: unknown, newValue: unknown): boolean {
  if (oldValue === undefined && newValue === undefined) return true;
  if (typeof oldValue === 'string' && typeof newValue === 'string') {
    return !sameLambdaFunctionAddress(oldValue, newValue);
  }
  return JSON.stringify(oldValue) !== JSON.stringify(newValue);
}

export function attributeTypeChangedForSharedAttribute(
  oldValue: unknown,
  newValue: unknown
): boolean {
  const toTypeMap = (value: unknown): Map<string, string> => {
    const map = new Map<string, string>();
    if (Array.isArray(value)) {
      for (const def of value) {
        if (def && typeof def === 'object') {
          const name = (def as Record<string, unknown>)['AttributeName'];
          const type = (def as Record<string, unknown>)['AttributeType'];
          if (typeof name === 'string' && typeof type === 'string') {
            map.set(name, type);
          }
        }
      }
    }
    return map;
  };

  const oldTypes = toTypeMap(oldValue);
  const newTypes = toTypeMap(newValue);
  for (const [name, oldType] of oldTypes) {
    const newType = newTypes.get(name);
    if (newType !== undefined && newType !== oldType) {
      return true;
    }
  }
  return false;
}

/**
 * Conditional-replacement predicate for
 * `AWS::DynamoDB::GlobalTable.LocalSecondaryIndexes` (go-to-k/cdkd#5489).
 *
 * The CFn schema lists the property as `conditionalCreateOnlyProperties`, and
 * a CloudFormation A/B (us-east-1 + us-west-2, 2026-10-28) measured both
 * directions: REMOVING a declared list replaced the table, while ADDING one
 * failed the update in place ("LocalSecondaryIndex template can be updated
 * only to values matching existing resource"). So only a non-empty list going
 * to absent / `[]` replaces; an added or changed list stays an update, which
 * the provider refuses before any call.
 */
export function globalTableLocalSecondaryIndexesRemoved(
  oldValue: unknown,
  newValue: unknown
): boolean {
  const declares = (value: unknown): boolean => Array.isArray(value) && value.length > 0;
  return (
    declares(oldValue) &&
    (newValue === undefined ||
      newValue === null ||
      (Array.isArray(newValue) && newValue.length === 0))
  );
}

/**
 * Conditional-replacement predicate for `AWS::Budgets::Budget.Budget`.
 *
 * The budget name (`Budget.BudgetName`, nested) is the physical id and is
 * createOnly — only a name change forces replacement; every other edit
 * inside the `Budget` block (limit, period, type, filters) is an in-place
 * `UpdateBudget`. A one-sided explicit name (added or removed) is treated as
 * a change: the other side's effective name was the cdkd-generated fallback,
 * which cannot match a user-supplied name.
 */
export function budgetNameChanged(oldValue: unknown, newValue: unknown): boolean {
  const nameOf = (value: unknown): string | undefined => {
    if (value === null || typeof value !== 'object') return undefined;
    const name = (value as Record<string, unknown>)['BudgetName'];
    return typeof name === 'string' ? name : undefined;
  };
  const oldName = nameOf(oldValue);
  const newName = nameOf(newValue);
  if (oldName === undefined && newName === undefined) return false;
  return oldName !== newName;
}

/**
 * Conditional-replacement predicate for `AWS::IAM::Role.Path` (issue
 * [#4739](https://github.com/go-to-k/cdkd/issues/4739)).
 *
 * `Path` is createOnly: IAM has no call that moves a role to another path, so
 * a change is a replacement, and it goes through the engine's create-first
 * replacement and its guards. Classified as updateable, it reached the
 * provider's own re-create, which asks for the name the live role still holds
 * (IAM role names are unique whatever the path) and fails `EntityAlreadyExists`.
 *
 * An absent or empty `Path` is the IAM default `/`, which the provider sends
 * the same way, so `/` to absent (or back) is no change and replaces nothing.
 * Any other difference, a non-string side included, is a replacement.
 */
export function iamRolePathChanged(oldValue: unknown, newValue: unknown): boolean {
  const effective = (value: unknown): unknown =>
    value === undefined || value === null || value === '' ? '/' : value;
  const oldPath = effective(oldValue);
  const newPath = effective(newValue);
  if (typeof oldPath === 'string' && typeof newPath === 'string') return oldPath !== newPath;
  return !isDeepStrictEqual(oldPath, newPath);
}

/**
 * Conditional-replacement predicate for `AWS::Glue::Table.TableInput` (issue
 * [#3750](https://github.com/go-to-k/cdkd/issues/3750)).
 *
 * The table's name lives NESTED at `TableInput.Name`, while the registry
 * schema marks only the TOP-LEVEL `Name` createOnly, so without this rule a
 * rename diffs as an in-place update. MEASURED against CloudFormation (#3750
 * thread): a `TableInput.Name` change REPLACES the table (the change set says
 * `Replacement: Conditional`; execution creates the new name and deletes the
 * old one). Every other `TableInput` edit stays in place.
 *
 * Glue folds table names to lowercase, so a case-only difference is the SAME
 * table and is not a replacement. The fold here is FULL Unicode, deliberately
 * wider than the provider's ASCII-only update-path check: every doubt must
 * land on `false`, because the provider then refuses a rename it cannot vouch
 * for (loud and safe), while a wrong `true` plans a DELETE of a table nobody
 * renamed. For the same reason a side whose name is absent or not a string
 * (an unresolved intrinsic) answers `false`.
 */
export function glueTableNameChanged(oldValue: unknown, newValue: unknown): boolean {
  const nameOf = (value: unknown): string | undefined => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const name = (value as Record<string, unknown>)['Name'];
    return typeof name === 'string' ? name : undefined;
  };
  const oldName = nameOf(oldValue);
  const newName = nameOf(newValue);
  if (oldName === undefined || newName === undefined) return false;
  return oldName.toLowerCase() !== newName.toLowerCase();
}

/**
 * Whether an `AWS::EC2::NatGateway` change ADDS `AvailabilityZoneAddresses` to
 * a gateway recorded without it — a regional gateway in automatic mode, which
 * CloudFormation replaces for that change (go-to-k/cdkd#2762). The predicate
 * sees one property, not the mode, so it also answers `true` for a ZONAL
 * gateway gaining the property; that case is unmeasured, and the replacement's
 * create is left for AWS to refuse.
 */
export function natZoneAddressesAddedToAutomaticGateway(
  oldValue: unknown,
  newValue: unknown
): boolean {
  return oldValue == null && newValue != null;
}

/**
 * Conditional-replacement predicate for `AWS::ECS::Service.LaunchType` (issue
 * [#5392](https://github.com/go-to-k/cdkd/issues/5392)).
 *
 * `UpdateService` has no `launchType` member, and the registry schema does not
 * mark the property createOnly, so without this rule a change diffs as an
 * in-place update that AWS never sees. MEASURED against CloudFormation
 * (us-east-1, 2026-10-27; every change set said `Replacement: Conditional`):
 *
 *  - VARY (`EC2` -> `EXTERNAL`) and ADD (absent -> `EC2`) REPLACE the service,
 *    the add even when the live launch type already was `EC2`.
 *  - REMOVE (`EXTERNAL` -> absent) updates in place and the service KEEPS
 *    `EXTERNAL`, so an in-place update sending nothing is parity (the provider
 *    has no removal default for it).
 *
 * So a replacement is planned exactly when the new value is present and
 * differs. The deploy diff resolves intrinsics before asking; only a value
 * still unresolved there (an intrinsic object on one side) compares unequal
 * and replaces, the conservative direction for a value AWS cannot update.
 */
export function ecsServiceLaunchTypeSetOrChanged(oldValue: unknown, newValue: unknown): boolean {
  return newValue != null && !isDeepStrictEqual(oldValue, newValue);
}

/**
 * `Instances` members CloudFormation updates in place (go-to-k/cdkd#5418; the
 * measurement is on {@link emrClusterInstancesReplaced}).
 */
const EMR_INSTANCES_IN_PLACE_MEMBERS = [
  'TerminationProtected',
  'UnhealthyNodeReplacement',
] as const;
/** Members of a CORE or TASK instance group CloudFormation updates in place. */
const EMR_GROUP_IN_PLACE_MEMBERS = ['InstanceCount', 'AutoScalingPolicy'] as const;
/** Members of a CORE or TASK instance fleet CloudFormation updates in place. */
const EMR_FLEET_IN_PLACE_MEMBERS = ['TargetOnDemandCapacity', 'TargetSpotCapacity'] as const;

/** A copy of a plain object without `keys`; anything else is returned as is. */
function withoutKeys(value: unknown, keys: readonly string[]): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of keys) delete copy[key];
  return copy;
}

/**
 * `Instances` with every member CloudFormation updates in place removed.
 * `TaskInstanceGroups` / `TaskInstanceFleets` are compared in list order, so a
 * reorder of the same entries classifies as a replacement (unmeasured; a plain
 * deploy then stops at the stateful-recreate guard's `STATEFUL_REPLACE_BLOCKED`).
 */
function emrInstancesReplacingPart(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const instances = withoutKeys(value, EMR_INSTANCES_IN_PLACE_MEMBERS) as Record<string, unknown>;
  const strip = (key: string, keys: readonly string[]): void => {
    if (!(key in instances)) return;
    const member = instances[key];
    instances[key] = Array.isArray(member)
      ? member.map((entry) => withoutKeys(entry, keys))
      : withoutKeys(member, keys);
  };
  strip('CoreInstanceGroup', EMR_GROUP_IN_PLACE_MEMBERS);
  strip('TaskInstanceGroups', EMR_GROUP_IN_PLACE_MEMBERS);
  strip('CoreInstanceFleet', EMR_FLEET_IN_PLACE_MEMBERS);
  strip('TaskInstanceFleets', EMR_FLEET_IN_PLACE_MEMBERS);
  return instances;
}

/**
 * The move half of the conditional-replacement rule for
 * `AWS::ElastiCache::CacheCluster.PreferredAvailabilityZones` (issue #5458).
 *
 * True when the list moves to zones that share NONE with the previous list.
 * Real CloudFormation change-set executions (memcached, us-east-1), each a
 * `Replacement: Conditional` change set:
 *
 *  - REPLACED: `[1c, 1a]` -> `[1b]` (2 -> 1 nodes); `[1b]` -> `[1c]`
 *    (1 -> 1); `[1a]` -> `[1b]` with the cluster's only live node ALREADY in
 *    1b (moved there outside the template), so the comparison is with the
 *    previous TEMPLATE list, not the live nodes.
 *  - IN PLACE: `[1c, 1b]` -> `[1b, 1b]`; `[1a, 1b, 1c]` -> `[1a, 1c]`;
 *    absent -> `[1b]` and absent -> `[1c, 1b]`.
 *
 * So an absent or empty list on either side is no move (a REMOVAL is
 * {@link elastiCachePreferredAvailabilityZonesRemovedFromSingleAz}'s), nor is
 * any list sharing a zone with the previous one (order and repeats are
 * irrelevant). A side that is not a list of strings (a value still
 * unresolved at diff time, an intrinsic object) answers `false`, as the
 * Glue table-name predicate does: a wrong `true` plans the delete of a
 * stateful cluster that is not moving, while a wrong `false` sends the move
 * to the in-place update, which AWS refuses loudly.
 */
export function elastiCachePreferredAvailabilityZonesMovedToDisjoint(
  oldValue: unknown,
  newValue: unknown
): boolean {
  if (!Array.isArray(oldValue) || !Array.isArray(newValue)) return false;
  if (oldValue.length === 0 || newValue.length === 0) return false;
  if (![...oldValue, ...newValue].every((z) => typeof z === 'string')) return false;
  return !newValue.some((z) => oldValue.includes(z));
}

/**
 * Whether an `AWS::ElastiCache::CacheCluster` template change leaves a
 * memcached cluster single-az (by value or by default) with no zone at all:
 * with a previous `AZMode: single-az`, the condition under which
 * CloudFormation REPLACES the cluster for an `AZMode` or
 * `PreferredAvailabilityZones` removal (issue #5558). Real CloudFormation
 * stack updates (memcached 1.6.22, cache.t3.micro, us-east-1, 2026-10-30; the
 * replacing rows show CreateCacheCluster plus DeleteCacheCluster in
 * CloudTrail, the in-place rows a lone ModifyCacheCluster), the 1-node
 * `single-az` and 2-node `cross-az` rows each alone and again beside a
 * changed PreferredMaintenanceWindow, with the same outcome both times:
 *
 *  - REPLACED (`single-az`): `PreferredAvailabilityZones` `[1a]` -> absent
 *    (1 node) and `[1a, 1a]` -> absent (2 nodes); `AZMode` removed with no
 *    zone list (1 node and 2 nodes); both removed together (1 node).
 *  - IN PLACE (`single-az`, 1 node): `AZMode` removed with `[1a]` kept.
 *  - IN PLACE (`cross-az`, 2 nodes): `PreferredAvailabilityZones`
 *    `[1a, 1b]` -> absent (and #5458's `[1c, 1b]` -> absent); `AZMode`
 *    removed, with or without a kept zone list. The nodes stay where they are.
 *
 * The node count plays no part. No measured row named the singular
 * `PreferredAvailabilityZone` on either side or used another engine, so
 * either keeps the in-place update; so does an empty new list or a move to
 * `cross-az` in the same change (all unmeasured). An absent previous
 * `AZMode` beside a zone list is a template CloudFormation refuses at create
 * ("To specify PreferredAvailabilityZones, AZMode must be specified"), so
 * each predicate requires the literal previous `single-az`. Without the
 * sibling bags there is nothing to read, so the answer is `false`.
 */
function elastiCacheLeftSingleAzWithoutZones(siblings: ReplacementSiblings | undefined): boolean {
  if (siblings === undefined) return false;
  const { oldProperties: prev, newProperties: next } = siblings;
  return (
    prev['Engine'] === 'memcached' &&
    next['Engine'] === 'memcached' &&
    prev['PreferredAvailabilityZone'] == null &&
    next['PreferredAvailabilityZone'] == null &&
    next['PreferredAvailabilityZones'] == null &&
    (next['AZMode'] == null || next['AZMode'] === 'single-az')
  );
}

/**
 * Conditional-replacement predicate for
 * `AWS::ElastiCache::CacheCluster.AZMode` (issue #5558): `single-az` removed
 * from a template that names no zone replaces the cluster (see
 * {@link elastiCacheLeftSingleAzWithoutZones}). Any other change keeps the
 * in-place update it had before (unmeasured).
 */
export function elastiCacheAzModeRemovedFromSingleAz(
  oldValue: unknown,
  newValue: unknown,
  siblings?: ReplacementSiblings
): boolean {
  return (
    oldValue === 'single-az' && newValue == null && elastiCacheLeftSingleAzWithoutZones(siblings)
  );
}

/**
 * The `PreferredAvailabilityZones` removal half of the CacheCluster rule
 * (issue #5558): a non-empty list removed from a `single-az` cluster's
 * template replaces it (see {@link elastiCacheLeftSingleAzWithoutZones}).
 */
export function elastiCachePreferredAvailabilityZonesRemovedFromSingleAz(
  oldValue: unknown,
  newValue: unknown,
  siblings?: ReplacementSiblings
): boolean {
  return (
    Array.isArray(oldValue) &&
    oldValue.length > 0 &&
    newValue == null &&
    siblings?.oldProperties['AZMode'] === 'single-az' &&
    elastiCacheLeftSingleAzWithoutZones(siblings)
  );
}

/**
 * `AWS::ElastiCache::CacheCluster.PreferredAvailabilityZones`: a move to
 * disjoint zones (#5458) or a removal from a `single-az` cluster (#5558).
 */
export function elastiCachePreferredAvailabilityZonesReplaced(
  oldValue: unknown,
  newValue: unknown,
  siblings?: ReplacementSiblings
): boolean {
  return (
    elastiCachePreferredAvailabilityZonesMovedToDisjoint(oldValue, newValue) ||
    elastiCachePreferredAvailabilityZonesRemovedFromSingleAz(oldValue, newValue, siblings)
  );
}

/**
 * Conditional-replacement predicate for `AWS::EMR::Cluster.Instances` (issue
 * [#5418](https://github.com/go-to-k/cdkd/issues/5418)).
 *
 * The registry schema marks no `Instances` path createOnly and the
 * CloudFormation reference says "No interruption" for every member, yet
 * CloudFormation REPLACES the cluster for most of them. MEASURED (raw
 * CloudFormation change-set executions, us-east-1, 2026-10-27; every change set
 * said `Replacement: Conditional` on `Instances`, so only the execution tells):
 *
 *  - REPLACED: `AdditionalMasterSecurityGroups` added, a task instance group
 *    added, `KeepJobFlowAliveWhenNoSteps` true -> false.
 *  - IN PLACE: `InstanceCount` of the core group and of a task group,
 *    `AutoScalingPolicy` added to the core group, `TargetOnDemandCapacity` of
 *    the core fleet and of a task fleet, `UnhealthyNodeReplacement` added.
 *  - `TerminationProtected` is in place (`SetTerminationProtection`).
 *
 * The reference's notes on `TaskInstanceGroups` / `TaskInstanceFleets` agree:
 * only `InstanceCount` and `AutoScalingPolicy` (groups) and the two target
 * capacities (fleets) are mutable, anything else replaces. Neither covers the
 * master group or fleet (unmeasured), whose every change is left to replace.
 *
 * So the members CloudFormation updates in place are removed from both sides
 * and any remaining difference replaces. Compared strictly, as the diff
 * compares the whole property: a value still unresolved there (an intrinsic
 * object) differs from a concrete one and replaces, the conservative direction
 * for a member AWS cannot update.
 *
 * A call with NO value on either side (`undefined`, `undefined`) is the
 * diff's promoted-dependent probe: a resource the block references (a subnet,
 * a security group) is being replaced, so its id WILL move, and CloudFormation
 * replaces the cluster for that. It answers `true`; the engine lowers the
 * ceiling, through this same predicate, when the resolved move is in place.
 */
export function emrClusterInstancesReplaced(oldValue: unknown, newValue: unknown): boolean {
  if (oldValue === undefined && newValue === undefined) return true;
  return !isDeepStrictEqual(
    emrInstancesReplacingPart(oldValue),
    emrInstancesReplacingPart(newValue)
  );
}

/*
 * RDS `Engine` mutability (issue #5467), transcribed from CloudFormation's own
 * RDS handlers, aws-cloudformation/aws-cloudformation-resource-providers-rds
 * at commit 5a410e843efb90076c1c4d322707bc989e5a058b:
 * `aws-rds-dbcluster/.../dbcluster/util/ImmutabilityHelper.java`
 * `isEngineMutable` and `aws-rds-dbinstance/.../dbinstance/util/ImmutabilityHelper.java`
 * `isEngineMutable`. An immutable change fails the update `NotUpdatable`,
 * which CloudFormation turns into a replacement (the change set's
 * `Replacement: Conditional`). MEASURED (us-east-1, 2026-10-28): DBCluster
 * aurora-mysql to aurora-postgresql and DBInstance mysql to mariadb both
 * created a new physical resource. Comparisons keep the handlers' letter-case
 * rules (`Objects.equal` is exact, `equalsIgnoreCase` is not).
 *
 * One deliberate difference: an `Engine` absent on either side never replaces
 * here. The DBInstance handler then compares against the LIVE engine, which a
 * template diff cannot see, and a replacement destroys the database.
 */
const AURORA = 'aurora';
const AURORA_MYSQL = 'aurora-mysql';
const DEPRECATED_ORACLE_SE_ENGINES: ReadonlySet<string> = new Set(['oracle-se', 'oracle-se1']);
const ORACLE_SE2 = 'oracle-se2';
const ORACLE_CDB_CONVERSIONS: ReadonlyMap<string, string> = new Map([
  ['oracle-ee', 'oracle-ee-cdb'],
  ['oracle-se2', 'oracle-se2-cdb'],
]);
const ORACLE_CDB_ENGINES: ReadonlySet<string> = new Set(ORACLE_CDB_CONVERSIONS.values());

/** Both `Engine` values as strings, or `undefined` when either is absent. */
function enginePair(oldValue: unknown, newValue: unknown): [string, string] | undefined {
  return typeof oldValue === 'string' && typeof newValue === 'string'
    ? [oldValue, newValue]
    : undefined;
}

/** The DBCluster handler's `isEngineMutable`: unchanged, or `aurora` to `aurora-mysql`. */
export function dbClusterEngineChangeReplaces(oldValue: unknown, newValue: unknown): boolean {
  const pair = enginePair(oldValue, newValue);
  if (pair === undefined) return false;
  const [before, after] = pair;
  return !(before === after || (before === AURORA && after === AURORA_MYSQL));
}

/**
 * Whether a DBInstance `Engine` change is one the handler applies in place
 * while the engine string changes, so `ModifyDBInstance` carries the new one
 * (the handler sends `engine(diff(previous, desired))`).
 */
export function dbInstanceEngineChangeIsInPlace(oldValue: unknown, newValue: unknown): boolean {
  const pair = enginePair(oldValue, newValue);
  if (pair === undefined) return false;
  const [before, after] = pair;
  const from = before.toLowerCase();
  const to = after.toLowerCase();
  return (
    before === after ||
    // isUpgradeToAuroraMySQL (exact case)
    (before === AURORA && after === AURORA_MYSQL) ||
    // isUpgradeToOracleSE2
    (DEPRECATED_ORACLE_SE_ENGINES.has(from) && to === ORACLE_SE2) ||
    // isOracleConvertToCDB
    ORACLE_CDB_CONVERSIONS.get(from) === to ||
    // isOracleCDBMutable: a CDB engine re-spelled in another case
    (from === to && ORACLE_CDB_ENGINES.has(to))
  );
}

/** The DBInstance handler's `isEngineMutable`, negated. */
export function dbInstanceEngineChangeReplaces(oldValue: unknown, newValue: unknown): boolean {
  if (enginePair(oldValue, newValue) === undefined) return false;
  return !dbInstanceEngineChangeIsInPlace(oldValue, newValue);
}
