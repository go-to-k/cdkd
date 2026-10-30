/**
 * Replacement rules for AWS resource types
 *
 * Defines which property changes require resource replacement (delete + recreate)
 * vs. in-place updates.
 *
 * Based on CloudFormation update behaviors:
 * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-updating-stacks-update-behaviors.html
 */

import { isDeepStrictEqual } from 'node:util';
import { getLogger } from '../utils/logger.js';
import { sameLambdaFunctionAddress } from '../utils/lambda-function-name.js';

/**
 * The whole property bags of the resource whose property a conditional
 * predicate judges, for a rule whose answer depends on a SIBLING property
 * (issue #5446: an `AWS::EC2::Instance` `SecurityGroupIds` change replaces the
 * instance only when it has no `SubnetId`). Absent where the caller judges a
 * value outside a diff; a predicate then answers for the common case.
 */
export interface ReplacementSiblings {
  readonly oldProperties: Readonly<Record<string, unknown>>;
  readonly newProperties: Readonly<Record<string, unknown>>;
}

type ConditionalReplacement = (
  oldValue: unknown,
  newValue: unknown,
  siblings?: ReplacementSiblings
) => boolean;

/**
 * Resource replacement rule
 */
interface ReplacementRule {
  /** Properties that always require replacement when changed */
  replacementProperties: Set<string>;
  /** Properties that never require replacement */
  updateableProperties?: Set<string>;
  /** Custom logic for conditional replacement */
  conditionalReplacements?: Map<string, ConditionalReplacement>;
}

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
function elastiCachePreferredAvailabilityZonesReplaced(
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

/**
 * Replacement rules registry
 *
 * Maps resource types to their replacement rules
 */
export class ReplacementRulesRegistry {
  private logger = getLogger().child('ReplacementRulesRegistry');
  private rules = new Map<string, ReplacementRule>();

  constructor() {
    this.initializeRules();
  }

  /**
   * Check if a property change requires replacement
   */
  requiresReplacement(
    resourceType: string,
    propertyPath: string,
    oldValue: unknown,
    newValue: unknown,
    siblings?: ReplacementSiblings
  ): boolean {
    const rule = this.rules.get(resourceType);

    if (!rule) {
      // No specific rule for this resource type
      // Conservative approach: assume replacement may be required
      this.logger.debug(
        `No replacement rule for ${resourceType}, conservatively assuming replacement may be required for ${propertyPath}`
      );
      return false; // Default to updateable for unknown types
    }

    // Check if property always requires replacement
    if (rule.replacementProperties.has(propertyPath)) {
      this.logger.debug(`Property ${propertyPath} of ${resourceType} requires replacement`);
      return true;
    }

    // Check if property is explicitly updateable
    if (rule.updateableProperties?.has(propertyPath)) {
      return false;
    }

    // Check conditional replacements
    if (rule.conditionalReplacements?.has(propertyPath)) {
      const condition = rule.conditionalReplacements.get(propertyPath);
      if (condition) {
        const requires = condition(oldValue, newValue, siblings);
        this.logger.debug(
          `Conditional replacement for ${propertyPath} of ${resourceType}: ${requires}`
        );
        return requires;
      }
    }

    // If not explicitly defined, assume it's updateable
    return false;
  }

  /**
   * The type's `conditionalReplacements` predicate for `propertyPath`, applied
   * to two concrete values, or `undefined` when the property has none (issue
   * [#4134](https://github.com/go-to-k/cdkd/issues/4134)). Deliberately not
   * {@link requiresReplacement}: that one answers `false` for an unclassified
   * property, which a caller outside the diff cannot tell from "in place".
   */
  conditionalReplacementVerdict(
    resourceType: string,
    propertyPath: string,
    oldValue: unknown,
    newValue: unknown,
    siblings?: ReplacementSiblings
  ): boolean | undefined {
    const condition = this.rules.get(resourceType)?.conditionalReplacements?.get(propertyPath);
    return condition === undefined ? undefined : condition(oldValue, newValue, siblings);
  }

  /**
   * Whether the registry has an EXPLICIT opinion about a property's
   * replacement behavior — i.e. the type has a rule AND the property is listed
   * in its `replacementProperties`, `updateableProperties`, OR
   * `conditionalReplacements`. Returns false for an unknown type, or for a
   * known type whose rule does not mention the property (the "default to
   * updateable" fall-through inside {@link requiresReplacement}).
   *
   * The diff calculator uses this to decide whether the CFn-schema
   * `createOnlyProperties` fallback may apply: the schema only fills the GAP
   * where the registry has no opinion, so a deliberate `updateableProperties`
   * (or conditional) classification is never overridden by the fallback.
   */
  isClassified(resourceType: string, propertyPath: string): boolean {
    const rule = this.rules.get(resourceType);
    if (!rule) return false;
    return (
      rule.replacementProperties.has(propertyPath) ||
      (rule.updateableProperties?.has(propertyPath) ?? false) ||
      (rule.conditionalReplacements?.has(propertyPath) ?? false)
    );
  }

  /**
   * Initialize replacement rules for common AWS resource types
   */
  private initializeRules(): void {
    // S3 Bucket
    this.rules.set('AWS::S3::Bucket', {
      replacementProperties: new Set([
        'BucketName', // Changing bucket name requires replacement
      ]),
      updateableProperties: new Set([
        'Tags',
        'VersioningConfiguration',
        'LifecycleConfiguration',
        'PublicAccessBlockConfiguration',
        'BucketEncryption',
        'LoggingConfiguration',
        'WebsiteConfiguration',
        'CorsConfiguration',
        'NotificationConfiguration',
      ]),
    });

    // Lambda Function
    this.rules.set('AWS::Lambda::Function', {
      replacementProperties: new Set([
        'FunctionName', // Changing function name requires replacement
        // Create-only in the CFn registry schema AND in the SDK: the member
        // exists on CreateFunctionRequest and NOT on
        // UpdateFunctionConfigurationRequest, so there is no in-place path
        // (issue #609).
        'TenancyConfig',
      ]),
      updateableProperties: new Set([
        'Code',
        'Handler',
        'Runtime',
        'Description',
        'Timeout',
        'MemorySize',
        'Role',
        'Environment',
        'Tags',
        'VpcConfig',
        'DeadLetterConfig',
        'TracingConfig',
        'Layers',
        'FileSystemConfigs',
        // Architectures is mutable in place (CFn "Update requires: No
        // interruption") — the provider re-sends the code with the new
        // instruction set via UpdateFunctionCode. Classified explicitly
        // (rather than relying on the DescribeType createOnly fallback) so
        // the intent is pinned and the classification is free of a network
        // round-trip.
        'Architectures',
        // Both are mutable in place, each via its own control-plane API
        // (PutFunctionCodeSigningConfig / DeleteFunctionCodeSigningConfig and
        // PutRuntimeManagementConfig) rather than
        // UpdateFunctionConfiguration — issue #609.
        'CodeSigningConfigArn',
        'RuntimeManagementConfig',
      ]),
      conditionalReplacements: new Map([['DurableConfig', durableConfigPresenceToggled]]),
    });

    // Lambda LayerVersion — fully immutable on AWS. There is no
    // UpdateLayerVersion API; every property change requires a fresh
    // PublishLayerVersion (a new version with a new LayerVersionArn). In
    // CloudFormation EVERY property of AWS::Lambda::LayerVersion is
    // "Update requires: Replacement", so a content/runtime/name change
    // must drive a replacement (and `promoteReplacementDependents` then
    // re-points any consuming function at the new version ARN), matching
    // `cdk deploy`'s transparent layer-version bump. Without this rule the
    // change is misclassified as an in-place update and the provider's
    // update() hard-fails with an "immutable" error (issue surfaced by a
    // LayerVersion content change being undeployable).
    this.rules.set('AWS::Lambda::LayerVersion', {
      replacementProperties: new Set([
        'Content',
        'LayerName',
        'Description',
        'CompatibleRuntimes',
        'CompatibleArchitectures',
        'LicenseInfo',
      ]),
    });

    // Lambda Version — a published version is a point-in-time snapshot, so
    // all five of its CREATE-ONLY properties (`FunctionName` / `Description` /
    // `CodeSha256` / `ProvisionedConcurrencyConfig` / `RuntimePolicy`) are
    // "Update requires: Replacement" in CloudFormation; a change to any of
    // them publishes a new version. (The registry schema also exposes one
    // in-place-mutable property, `FunctionScalingConfig` — deliberately left
    // OUT of this set so a change to it is NOT misclassified as a
    // replacement.) CDK normally bumps the Version's logical id on code change
    // (create-new + delete-old) so this rule rarely fires, but a hand-authored
    // template that edits a create-only Version property in place would
    // otherwise be misclassified as an updateable change.
    this.rules.set('AWS::Lambda::Version', {
      replacementProperties: new Set([
        'CodeSha256',
        'Description',
        'FunctionName',
        'ProvisionedConcurrencyConfig',
        'RuntimePolicy',
      ]),
    });

    // Lambda EventInvokeConfig — the async-invoke configuration is keyed by
    // (FunctionName, Qualifier), both CREATE-ONLY in CloudFormation ("Update
    // requires: Replacement"): a change to either targets a different
    // function/alias, so it must DELETE the old config + CREATE the new one
    // rather than an in-place Put (which would attach a config to the new
    // target while orphaning the old function's config). The remaining three
    // properties (`MaximumEventAgeInSeconds` / `MaximumRetryAttempts` /
    // `DestinationConfig`) are updated in place via PutFunctionEventInvokeConfig
    // (a full-replace write). Without this rule the registry defaults the type
    // to fully-updateable, which is correct for the three mutable props but
    // would silently in-place-update an immutable FunctionName/Qualifier change.
    // FunctionName replaces only when the function NAME changes: a re-spelling
    // (name <-> ARN) is the same function, and a replacement there would Put
    // the config and then delete it again (issue #4118).
    this.rules.set('AWS::Lambda::EventInvokeConfig', {
      replacementProperties: new Set(['Qualifier']),
      conditionalReplacements: new Map([['FunctionName', eventInvokeConfigFunctionChanged]]),
      updateableProperties: new Set([
        'MaximumEventAgeInSeconds',
        'MaximumRetryAttempts',
        'DestinationConfig',
      ]),
    });

    // DynamoDB GlobalTable (go-to-k/cdkd#5489). No property is listed outright:
    // the schema's `createOnlyProperties` fallback still covers `TableName`,
    // since it applies to every property this rule leaves unclassified. The
    // type is stateful, so the replacement still needs
    // `--force-stateful-recreation`.
    this.rules.set('AWS::DynamoDB::GlobalTable', {
      replacementProperties: new Set(),
      conditionalReplacements: new Map([
        ['LocalSecondaryIndexes', globalTableLocalSecondaryIndexesRemoved],
      ]),
    });

    // DynamoDB Table
    this.rules.set('AWS::DynamoDB::Table', {
      replacementProperties: new Set([
        'TableName', // Changing table name requires replacement
        'KeySchema', // Changing the table's primary key requires replacement
      ]),
      updateableProperties: new Set([
        'BillingMode',
        'ProvisionedThroughput',
        // Adding / removing a Global Secondary Index is an in-place UpdateTable
        // (one GSI per call, async) — NOT a replacement. The provider's update()
        // applies these via GlobalSecondaryIndexUpdates.
        'GlobalSecondaryIndexes',
        // NOT a replacement, matching CloudFormation (go-to-k/cdkd#5354): its
        // change set reports `RequiresRecreation: Never` for an LSI change and
        // the update then FAILS. So the diff routes it to the provider's
        // update(), which refuses it the same way, before any call.
        'LocalSecondaryIndexes',
        'StreamSpecification',
        'SSESpecification',
        'Tags',
        'TimeToLiveSpecification',
        'PointInTimeRecoverySpecification',
      ]),
      conditionalReplacements: new Map([
        // AttributeDefinitions is NOT a blanket replacement trigger. CloudFormation's
        // update behavior for it is "No interruption": adding an attribute (to back a
        // new GSI) or removing one (when a GSI is dropped) is an in-place update. The
        // ONLY case needing replacement is changing the TYPE of an attribute that
        // exists on both sides — DynamoDB rejects an in-place type change on an
        // attribute that participates in the table key or an index. A key attribute
        // NAME change instead surfaces as a KeySchema diff (handled above).
        ['AttributeDefinitions', attributeTypeChangedForSharedAttribute],
      ]),
    });

    // SQS Queue
    this.rules.set('AWS::SQS::Queue', {
      replacementProperties: new Set([
        'QueueName', // Changing queue name requires replacement
        'FifoQueue', // Changing FIFO attribute requires replacement
      ]),
      updateableProperties: new Set([
        'DelaySeconds',
        'MaximumMessageSize',
        'MessageRetentionPeriod',
        'ReceiveMessageWaitTimeSeconds',
        'VisibilityTimeout',
        'RedrivePolicy',
        'Tags',
        // FIFO-only, but mutable in place: CFn documents it as "Update
        // requires: No interruption" and the registry schema's
        // createOnlyProperties is only [FifoQueue, QueueName].
        // SetQueueAttributes flips it on a live FIFO queue (live-verified
        // 2026-07-27, issue #1237). Classifying it as replacement would
        // DELETE the queue (message loss) on a toggle, and made the
        // provider's #1160 removal reset unreachable via a plain deploy.
        'ContentBasedDeduplication',
      ]),
    });

    // IAM Role
    this.rules.set('AWS::IAM::Role', {
      replacementProperties: new Set([
        'RoleName', // Changing role name requires replacement
      ]),
      updateableProperties: new Set([
        'AssumeRolePolicyDocument',
        'Description',
        'ManagedPolicyArns',
        'MaxSessionDuration',
        'PermissionsBoundary',
        'Policies',
        'Tags',
      ]),
      conditionalReplacements: new Map([['Path', iamRolePathChanged]]),
    });

    // SNS Topic
    this.rules.set('AWS::SNS::Topic', {
      replacementProperties: new Set([
        'TopicName', // Changing topic name requires replacement
      ]),
      updateableProperties: new Set(['DisplayName', 'Subscription', 'KmsMasterKeyId', 'Tags']),
    });

    // CodeCommit Repository
    this.rules.set('AWS::CodeCommit::Repository', {
      replacementProperties: new Set([]),
      updateableProperties: new Set([
        // CFn docs: every property is "Update requires: No interruption" and
        // the registry schema's createOnlyProperties is EMPTY — including
        // RepositoryName (CFn renames in place via UpdateRepositoryName;
        // classifying a rename as replacement would DELETE the repository
        // and its entire git history). Docs-verified 2026-07-17 (issue #1045).
        'RepositoryName',
        'RepositoryDescription',
        'KmsKeyId',
        'Tags',
      ]),
    });

    // ECR Repository
    this.rules.set('AWS::ECR::Repository', {
      replacementProperties: new Set([
        'RepositoryName', // Changing repository name requires replacement
      ]),
      updateableProperties: new Set([
        'ImageScanningConfiguration',
        'ImageTagMutability',
        'LifecyclePolicy',
        'RepositoryPolicyText',
        'Tags',
      ]),
    });

    // CloudWatch Log Group
    this.rules.set('AWS::Logs::LogGroup', {
      replacementProperties: new Set([
        'LogGroupName', // Changing log group name requires replacement
      ]),
      updateableProperties: new Set(['RetentionInDays', 'KmsKeyId']),
    });

    // Kinesis Stream — Name is immutable (CFn "Update requires: Replacement").
    // Without this rule the registry defaulted the type to updateable, so a
    // stream rename was attempted as an in-place update: AWS has no rename API,
    // so the change was silently dropped and cdkd's state diverged (state recorded
    // the new name while the stream kept the old one). All other Kinesis stream
    // properties are in-place updatable.
    this.rules.set('AWS::Kinesis::Stream', {
      replacementProperties: new Set([
        'Name', // Renaming a stream requires replacement
      ]),
      updateableProperties: new Set([
        'RetentionPeriodHours',
        'ShardCount',
        'StreamModeDetails',
        'StreamEncryption',
        'Tags',
      ]),
    });

    // SecretsManager Secret — Name is immutable (CFn "Update requires:
    // Replacement"). Same silent-divergence class as Kinesis::Stream above: a
    // rename was attempted in-place (no AWS rename API) and dropped. The secret
    // value / description / replica / KMS key are all in-place updatable.
    this.rules.set('AWS::SecretsManager::Secret', {
      replacementProperties: new Set([
        'Name', // Renaming a secret requires replacement
      ]),
      updateableProperties: new Set([
        'Description',
        'KmsKeyId',
        'SecretString',
        'GenerateSecretString',
        'ReplicaRegions',
        'Tags',
      ]),
    });

    // Step Functions State Machine — StateMachineName + StateMachineType are
    // immutable (CFn "Update requires: Replacement"). Same silent-divergence
    // class as Kinesis/Secret above: a rename was attempted as an in-place
    // UpdateStateMachine (which has no Name parameter) and dropped. The
    // definition / role / logging / tracing are all in-place updatable.
    this.rules.set('AWS::StepFunctions::StateMachine', {
      replacementProperties: new Set([
        'StateMachineName', // Renaming requires replacement
        'StateMachineType', // STANDARD <-> EXPRESS requires replacement
      ]),
      updateableProperties: new Set([
        'DefinitionString',
        'DefinitionS3Location',
        'Definition',
        'DefinitionSubstitutions',
        'RoleArn',
        'LoggingConfiguration',
        'TracingConfiguration',
        'Tags',
        'EncryptionConfiguration',
      ]),
    });

    // EventBridge Rule — Name + EventBusName are immutable (CFn "Update
    // requires: Replacement"). A rename was attempted as an in-place PutRule
    // with the NEW name, which CREATES a second rule and orphans the old one.
    // Schedule / pattern / targets / state are in-place updatable.
    this.rules.set('AWS::Events::Rule', {
      replacementProperties: new Set([
        'Name', // Renaming requires replacement
        'EventBusName', // Moving to a different bus requires replacement
      ]),
      updateableProperties: new Set([
        'ScheduleExpression',
        'EventPattern',
        'State',
        'Description',
        'Targets',
        'RoleArn',
      ]),
    });

    // SSM Parameter — Name is immutable (CFn "Update requires: Replacement").
    // A rename was attempted in-place and the new-named parameter was never
    // created (or the old one left untouched), diverging state from AWS.
    this.rules.set('AWS::SSM::Parameter', {
      replacementProperties: new Set([
        'Name', // Renaming requires replacement
      ]),
      updateableProperties: new Set([
        'Value',
        'Description',
        'Type',
        'Tier',
        'AllowedPattern',
        'Policies',
        'DataType',
        'Tags',
      ]),
    });

    // Budgets Budget — the budget NAME is the physical id and is createOnly
    // (a rename must be delete + recreate: UpdateBudget addresses the budget
    // BY name, so an in-place rename would silently create nothing and
    // diverge state from AWS). The name lives NESTED at Budget.BudgetName, so
    // a conditional rule inspects the top-level `Budget` value: only a
    // BudgetName change forces replacement — limit / period / type edits are
    // in-place `UpdateBudget` calls. NotificationsWithSubscribers is
    // createOnly for CloudFormation, but cdkd's provider reconciles it
    // in place (CreateNotification / DeleteNotification / CreateSubscriber /
    // DeleteSubscriber), hence updateable here.
    this.rules.set('AWS::Budgets::Budget', {
      replacementProperties: new Set<string>(),
      updateableProperties: new Set(['NotificationsWithSubscribers', 'ResourceTags']),
      conditionalReplacements: new Map([['Budget', budgetNameChanged]]),
    });

    // Glue Table — the name is NESTED at `TableInput.Name` and the registry
    // schema's createOnly `Name` is the top-level one CDK does not emit, so a
    // rename needs this conditional rule to replace (issue #3750, measured
    // against CloudFormation). Only `TableInput` is classified here; the
    // schema fallback still decides `CatalogId` / `DatabaseName` / `Name`.
    // `AWS::Glue::Connection` needs no entry: its schema lists the nested
    // `ConnectionInput/Name` createOnly path, which the fallback compares at
    // path granularity. `AWS::Glue::Database` deliberately has none either:
    // CloudFormation does NOT replace on `DatabaseInput.Name` (the update
    // fails), so cdkd's provider refuses it instead.
    this.rules.set('AWS::Glue::Table', {
      replacementProperties: new Set<string>(),
      conditionalReplacements: new Map([['TableInput', glueTableNameChanged]]),
    });

    // CloudWatch Alarm — AlarmName is immutable (CFn "Update requires:
    // Replacement"). A rename was attempted as an in-place PutMetricAlarm with
    // the NEW name, which CREATES a second alarm and orphans the old one.
    // Everything else about an alarm is in-place updatable.
    this.rules.set('AWS::CloudWatch::Alarm', {
      replacementProperties: new Set([
        'AlarmName', // Renaming requires replacement
      ]),
      updateableProperties: new Set([
        'ComparisonOperator',
        'EvaluationPeriods',
        'DatapointsToAlarm',
        'Threshold',
        'TreatMissingData',
        'MetricName',
        'Namespace',
        'Period',
        'Statistic',
        'ExtendedStatistic',
        'Dimensions',
        'Metrics',
        'AlarmDescription',
        'ActionsEnabled',
        'AlarmActions',
        'OKActions',
        'InsufficientDataActions',
        'Unit',
        'EvaluateLowSampleCountPercentile',
        'ThresholdMetricId',
        'Tags',
      ]),
    });

    // API Gateway RestApi
    this.rules.set('AWS::ApiGateway::RestApi', {
      replacementProperties: new Set([
        'Name', // Changing API name can require replacement in some cases
      ]),
      updateableProperties: new Set([
        'Description',
        'Policy',
        'EndpointConfiguration',
        'BinaryMediaTypes',
        'MinimumCompressionSize',
        'Tags',
      ]),
    });

    // AppSync GraphQLApi — `ApiType` and `Visibility` are fixed at creation
    // (AWS documents both as "cannot be changed once the API has been
    // created", and `UpdateGraphqlApi` has no member for either). The
    // create-only FALLBACK in `create-only-properties.ts` cannot cover this:
    // the registry schema for this type ships an EMPTY `createOnlyProperties`
    // list, so an unclassified change would be routed to an in-place UPDATE
    // that silently drops the new value. `Name` is deliberately left
    // unclassified: it renames the API in place via `UpdateGraphqlApi`,
    // keeping the API id, as CloudFormation does (go-to-k/cdkd#5359).
    this.rules.set('AWS::AppSync::GraphQLApi', {
      replacementProperties: new Set(['ApiType', 'Visibility']),
      updateableProperties: new Set([
        'AuthenticationType',
        'LogConfig',
        'XrayEnabled',
        'Tags',
        'UserPoolConfig',
        'OpenIDConnectConfig',
        'LambdaAuthorizerConfig',
        'AdditionalAuthenticationProviders',
        'EnhancedMetricsConfig',
        'EnvironmentVariables',
        'IntrospectionConfig',
        'QueryDepthLimit',
        'ResolverCountLimit',
        'OwnerContact',
        'MergedApiExecutionRoleArn',
      ]),
    });

    // RDS DBProxy — EngineFamily + VpcSubnetIds + DBProxyName +
    // EndpointNetworkType + TargetConnectionNetworkType are immutable on AWS.
    // ModifyDBProxy only accepts Auth / DefaultAuthScheme / RequireTLS /
    // IdleClientTimeout / DebugLogging / RoleArn / SecurityGroups (+
    // NewDBProxyName rename, which cdkd does not implement). A diff in any other
    // field needs replacement.
    this.rules.set('AWS::RDS::DBProxy', {
      // EndpointNetworkType / TargetConnectionNetworkType are create-only in the
      // CFn schema and ModifyDBProxy has no such member; named here, not left to
      // the create-only fallback, so the replacement does not hinge on a
      // DescribeType answer (go-to-k/cdkd#2762).
      replacementProperties: new Set([
        'DBProxyName',
        'EngineFamily',
        'VpcSubnetIds',
        'EndpointNetworkType',
        'TargetConnectionNetworkType',
      ]),
    });

    // RDS DBProxyEndpoint — DBProxyName + DBProxyEndpointName + VpcSubnetIds +
    // TargetRole + EndpointNetworkType are immutable. ModifyDBProxyEndpoint only
    // accepts VpcSecurityGroupIds (+ rename, not implemented). EndpointNetworkType
    // is named here, not left to the create-only fallback, so the replacement
    // does not hinge on a DescribeType answer (go-to-k/cdkd#2762).
    this.rules.set('AWS::RDS::DBProxyEndpoint', {
      replacementProperties: new Set([
        'DBProxyName',
        'DBProxyEndpointName',
        'VpcSubnetIds',
        'TargetRole',
        'EndpointNetworkType',
      ]),
    });

    // S3 Tables Table — the registry schema's createOnly list (TableName and
    // Namespace are renamed in place). Named here so a change to IcebergMetadata /
    // StorageClassConfiguration / WithoutMetadata (sent only on CreateTable)
    // still replaces when DescribeType cannot answer (go-to-k/cdkd#2762).
    this.rules.set('AWS::S3Tables::Table', {
      replacementProperties: new Set([
        'TableBucketARN',
        'OpenTableFormat',
        'IcebergMetadata',
        'StorageClassConfiguration',
        'WithoutMetadata',
      ]),
    });

    // RDS DBProxyTargetGroup — DBProxyName + TargetGroupName are identity
    // fields. AWS rejects modifications to them; only ConnectionPoolConfig +
    // registered targets (Cluster/Instance Identifiers) are mutable.
    this.rules.set('AWS::RDS::DBProxyTargetGroup', {
      replacementProperties: new Set(['DBProxyName', 'TargetGroupName']),
    });

    // EC2 VPC (issue #5449) — InstanceTenancy is not createOnly in the registry
    // schema, but only a change TO `default` is in place; see the predicate.
    // The registry schema's createOnly list is named here too, so the
    // classification survives a DescribeType failure (as for the Subnet).
    this.rules.set('AWS::EC2::VPC', {
      replacementProperties: new Set([
        'CidrBlock',
        'Ipv4IpamPoolId',
        'Ipv4NetmaskLength',
        'VpcEncryptionControl',
      ]),
      conditionalReplacements: new Map([['InstanceTenancy', vpcInstanceTenancyChangeReplaces]]),
    });

    // RDS DBCluster / DBInstance `Engine` (issue #5467): not createOnly in the
    // CFn schema, but CloudFormation replaces a change its handlers call
    // immutable (measured, and transcribed from the handlers; see the
    // predicates). Every other property keeps the schema createOnly fallback,
    // since these rules name only `Engine`. Both types are stateful, so the
    // replacement still needs `--force-stateful-recreation`.
    this.rules.set('AWS::RDS::DBCluster', {
      replacementProperties: new Set(),
      conditionalReplacements: new Map<string, ConditionalReplacement>([
        ['Engine', dbClusterEngineChangeReplaces],
      ]),
    });
    this.rules.set('AWS::RDS::DBInstance', {
      replacementProperties: new Set(),
      conditionalReplacements: new Map<string, ConditionalReplacement>([
        ['Engine', dbInstanceEngineChangeReplaces],
      ]),
    });

    // EC2 Subnet — VpcId / CidrBlock / AvailabilityZone are createOnly per
    // the CFn registry schema (the DescribeType fallback already classifies
    // them); named here so the classification survives a DescribeType
    // failure. MapPublicIpOnLaunch is mutable in place via
    // ModifySubnetAttribute and Tags via CreateTags/DeleteTags — both wired
    // through EC2Provider.updateSubnet (issue #1300); declaring them
    // updateable pins that routing against future createOnly-fallback drift.
    this.rules.set('AWS::EC2::Subnet', {
      replacementProperties: new Set(['VpcId', 'CidrBlock', 'AvailabilityZone']),
      updateableProperties: new Set(['MapPublicIpOnLaunch', 'Tags']),
    });

    // EC2 Instance — EbsOptimized can only be changed on a STOPPED instance
    // (a running instance returns IncorrectInstanceState). `updateInstance`
    // stops an instance only for an InstanceType / UserData change (issue
    // #5446, measured), and an EbsOptimized change was not measured against
    // CloudFormation, so it stays routed to replacement
    // (the create path sets it on the new instance). The other four #609
    // security-backfill props (DisableApiTermination / Monitoring /
    // MetadataOptions / CreditSpecification) ARE mutable in-place on a running
    // instance and are handled by EC2Provider.updateInstanceSecurityProps.
    //
    // AvailabilityZone / ImageId / SubnetId / KeyName are immutable: the CFn
    // registry schema lists all four under `createOnlyProperties`, so the
    // `create-only-properties.ts` DescribeType fallback already classifies
    // them as replacements. They are ALSO named here so the classification
    // survives a DescribeType failure (missing `cloudformation:DescribeType`
    // permission, or a throttle that outlasts the retry) — the fallback
    // degrades to an empty create-only list, and without a hand rule the
    // change would be classified in-place, where `updateInstance` silently
    // ignores it: state records the new value while AWS keeps the old one.
    this.rules.set('AWS::EC2::Instance', {
      replacementProperties: new Set([
        'EbsOptimized',
        'AvailabilityZone',
        'ImageId',
        'SubnetId',
        'KeyName',
        // Issue #1281: createOnly per the CFn schema, and updateInstance has
        // no ENI-modification path -- an in-place classification would leave
        // state recording the new value while AWS keeps the old one.
        'NetworkInterfaces',
      ]),
      // Issue #5446: InstanceType / UserData (a stop-modify-start),
      // IamInstanceProfile and, with a SubnetId, SecurityGroupIds update in
      // place in `updateInstance`; see the two predicates for what replaces.
      conditionalReplacements: new Map<string, ConditionalReplacement>([
        ['SecurityGroupIds', instanceSecurityGroupIdsChangeReplaces],
        ['BlockDeviceMappings', instanceBlockDeviceMappingsChangeReplaces],
      ]),
    });

    // EC2 NatGateway (go-to-k/cdkd#2762) — the registry schema leaves
    // `AvailabilityZoneAddresses` mutable, and on a gateway created with it
    // CloudFormation associates / releases zone addresses in place. ADDING it
    // to a regional gateway created without it (automatic zone expansion)
    // makes CloudFormation create a new gateway instead (real CloudFormation
    // A/B on #2762): no API switches a gateway out of automatic mode.
    // Removing it is left in place, where `EC2Provider` refuses it as
    // CloudFormation fails it.
    this.rules.set('AWS::EC2::NatGateway', {
      replacementProperties: new Set(),
      conditionalReplacements: new Map([
        ['AvailabilityZoneAddresses', natZoneAddressesAddedToAutomaticGateway],
      ]),
    });

    // EC2 Volume — the CFn registry schema for this type declares NO
    // `createOnlyProperties` at all (live-verified 2026-08-03 via
    // `describe-type --type-name AWS::EC2::Volume`, which returns
    // `createOnlyProperties: null`), so the `create-only-properties.ts`
    // DescribeType fallback has nothing to classify and every change looked
    // in-place-updatable. An immutable-property change therefore reached the
    // update handler and AWS rejected the deploy with "Volume properties
    // other than AutoEnableIO, type, size, and IOPS cannot be updated" —
    // where CloudFormation REPLACES the volume for the same edit (issue
    // #1356). The six properties below are the ones CFn documents as
    // "Update requires: Replacement"; they are identity / encryption /
    // seed-data fields no `ModifyVolume` call can change.
    //
    // Deliberately conservative: the remaining schema properties
    // (`MultiAttachEnabled`, `SourceVolumeId`, `VolumeInitializationRate`)
    // are left UNCLASSIFIED rather than guessed at. Misclassifying a mutable
    // property as a replacement would DELETE a data-bearing volume, whereas
    // leaving one unclassified keeps today's graceful degradation (attempt
    // the update, surface AWS's error) and still lets the schema fallback
    // pick it up if AWS ever populates `createOnlyProperties`.
    //
    // A volume replacement is real data loss, so `AWS::EC2::Volume` is also
    // in `STATEFUL_TYPES` — the deploy engine's property-driven replacement
    // path requires `--force-stateful-recreation` to confirm it.
    this.rules.set('AWS::EC2::Volume', {
      replacementProperties: new Set([
        'AvailabilityZone',
        'AvailabilityZoneId',
        'Encrypted',
        'KmsKeyId',
        'OutpostArn',
        'SnapshotId',
      ]),
      updateableProperties: new Set([
        // ModifyVolume's mutable set (the AWS rejection message names four of
        // these five: AutoEnableIO / type / size / IOPS) plus tags via
        // CreateTags / DeleteTags. Pinning them here permanently bypasses the
        // schema fallback for these names — acceptable because AWS documents
        // every one as "Update requires: No interruption", and the opposite
        // error (a mutable property classified as a replacement) destroys data.
        'AutoEnableIO',
        'Iops',
        'Size',
        'Throughput',
        'VolumeType',
        'Tags',
      ]),
    });

    // ECS Task Definition
    this.rules.set('AWS::ECS::TaskDefinition', {
      replacementProperties: new Set([
        // Task definitions are immutable - any change requires replacement
        'Family',
        'ContainerDefinitions',
        'Cpu',
        'Memory',
        'NetworkMode',
        'RequiresCompatibilities',
        'ExecutionRoleArn',
        'TaskRoleArn',
        'Volumes',
      ]),
    });

    // ECS Service — `LaunchType` replaces when set or changed, and stays in
    // place when removed (issue #5392; see the predicate). Every other
    // property stays with the schema fallback.
    this.rules.set('AWS::ECS::Service', {
      replacementProperties: new Set(),
      conditionalReplacements: new Map([['LaunchType', ecsServiceLaunchTypeSetOrChanged]]),
    });

    // ElastiCache CacheCluster — a `PreferredAvailabilityZones` move to zones
    // the previous list does not name replaces the cluster (issue #5458), and
    // so does removing `AZMode` or `PreferredAvailabilityZones` from a
    // `single-az` cluster left with no zone list (issue #5558; see the
    // predicates). Every other
    // property stays with the schema fallback.
    this.rules.set('AWS::ElastiCache::CacheCluster', {
      replacementProperties: new Set(),
      conditionalReplacements: new Map<string, ConditionalReplacement>([
        ['AZMode', elastiCacheAzModeRemovedFromSingleAz],
        ['PreferredAvailabilityZones', elastiCachePreferredAvailabilityZonesReplaced],
      ]),
    });

    // EMR Cluster — an `Instances` change replaces unless only members
    // CloudFormation updates in place moved (issue #5418; see the predicate).
    // Every other property stays with the schema fallback.
    this.rules.set('AWS::EMR::Cluster', {
      replacementProperties: new Set(),
      conditionalReplacements: new Map([['Instances', emrClusterInstancesReplaced]]),
    });

    // ELBv2 ListenerRule — `ListenerArn` is create-only (and write-only). The
    // schema fallback replaces on it as a plain reference (go-to-k/cdkd#4701),
    // but the committed create-only snapshot has no ListenerRule, so with
    // `DescribeType` denied only this entry does. When the listener is replaced (a
    // `--recreate-via-*` target, or a `LoadBalancerArn` change), AWS deletes
    // its rules with the old one, so the rule must be re-created on the new
    // listener — an in-place update of the deleted rule fails `NotFound`
    // (go-to-k/cdkd#4689). Only `ListenerArn` is named: the other properties
    // stay with the schema fallback.
    this.rules.set('AWS::ElasticLoadBalancingV2::ListenerRule', {
      replacementProperties: new Set(['ListenerArn']),
    });

    // Add more resource types as needed
    this.logger.debug(`Initialized replacement rules for ${this.rules.size} resource types`);
  }
}
