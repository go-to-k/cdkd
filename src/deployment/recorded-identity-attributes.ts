import { mentionsMask } from './secret-redaction/recorded-secrecy.js';
import { holdsSecretDerivedEntry } from '../provisioning/iam-policy-targets.js';
import { isoTimestampAttribute } from '../provisioning/attribute-timestamp.js';

/**
 * go-to-k/cdkd#6393 / #6655: per type, the recorded attribute holding the
 * identity AWS mints per resource, so a same-named successor (the name
 * deleted and taken again, by this stack or anyone else) carries another one.
 * Imports only leaves: the rollback's survivor check, the provider deletes
 * and the deploy's update carry all read it.
 *
 * Each value is exactly the token that type's SDK provider's
 * `resourceIdentity` reads live (#4655), raw, with no normalization on either
 * side:
 * - `AWS::IAM::Role` `RoleId`: `roleIdentityToken(GetRole.Role.RoleId)`; the
 *   create / update record `Role.RoleId` as returned.
 * - `AWS::IAM::ManagedPolicy` `PolicyId`: `policyIdentityToken(GetPolicy
 *   .Policy.PolicyId)`; the record holds `policyIdentityToken` of the same
 *   field (`managedPolicyAttributes`).
 * - `AWS::DynamoDB::Table` `TableId`: `readTableIdIfExists` returns
 *   `DescribeTable.Table.TableId`; the create / update record that field.
 * - `AWS::RDS::DBInstance` `DbiResourceId` / `AWS::RDS::DBCluster`
 *   `DBClusterResourceId`: `readDbResourceIdIfExists` returns the describe's
 *   `DbiResourceId` / `DbClusterResourceId`; `dbInstanceAttributes` /
 *   `dbClusterAttributes` record the same members.
 * - `AWS::IAM::User` `UserId` / `AWS::IAM::Group` `GroupId`:
 *   `userOrGroupIdentityToken(GetUser.User.UserId / GetGroup.Group.GroupId)`;
 *   the create, update and import record `userOrGroupIdentityToken` of the
 *   same field.
 * - `AWS::IAM::InstanceProfile` `InstanceProfileId`:
 *   `instanceProfileIdentityToken(GetInstanceProfile.InstanceProfile
 *   .InstanceProfileId)`; the create, update and import record the same.
 * - `AWS::Logs::LogGroup` `LogGroupIdentity` (go-to-k/cdkd#6665): no id is
 *   minted, so the token is `<logGroupArn>@<creationTime epoch ms>`
 *   (`logGroupIdentityToken`, the `resourceIdentity` the provider had
 *   already); the create, update and import record it from their own
 *   `DescribeLogGroups`.
 * - `AWS::StepFunctions::StateMachine` `CreationDate` /
 *   `AWS::ECR::Repository` `CreatedAt` (go-to-k/cdkd#6665):
 *   {@link identityTimestamp} of `DescribeStateMachine.creationDate` /
 *   `DescribeRepositories.repositories[].createdAt`; the create, update and
 *   import record the same of their own response.
 *
 * A type whose physical id is already AWS-minted (a KMS key id) needs none;
 * one whose every id is name-derived (an SNS topic ARN) has none to compare.
 * Add a type only when its SDK provider records the attribute at create,
 * its `resourceIdentity` token equals it, and its `import()` returns the
 * attribute under the same key in the same format, or not at all (a
 * re-adoption compares the import's value with the recorded one).
 *
 * Trust on first use: a record without the id (one written before cdkd
 * recorded it) acquires it once from a read the deploy makes while acting on
 * the resource (an update's result, the `Fn::GetAtt` heal); a legacy record
 * is deleted by name anyway, so withholding it buys no safety. A recorded id
 * is never replaced from a live read ({@link keepRecordedIdentity}).
 */
export const SURVIVOR_IDENTITY_ATTRIBUTES: Readonly<Record<string, string>> = {
  'AWS::IAM::Role': 'RoleId',
  'AWS::IAM::ManagedPolicy': 'PolicyId',
  'AWS::DynamoDB::Table': 'TableId',
  'AWS::RDS::DBInstance': 'DbiResourceId',
  'AWS::RDS::DBCluster': 'DBClusterResourceId',
  'AWS::IAM::User': 'UserId',
  'AWS::IAM::Group': 'GroupId',
  'AWS::IAM::InstanceProfile': 'InstanceProfileId',
  'AWS::Logs::LogGroup': 'LogGroupIdentity',
  'AWS::StepFunctions::StateMachine': 'CreationDate',
  'AWS::ECR::Repository': 'CreatedAt',
};

/**
 * go-to-k/cdkd#6665: a creation timestamp as an identity value, ISO UTC at
 * whole-second precision (`2026-11-21T03:04:05Z`), or `undefined` for no /
 * an invalid date. The fraction is dropped so a create response and a later
 * describe cannot disagree on precision alone: a differing value refuses
 * the delete, and a same-name successor created within the same second is
 * not a case this check claims.
 */
export function identityTimestamp(value: Date | undefined | null): string | undefined {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return undefined;
  return isoTimestampAttribute(new Date(Math.floor(value.getTime() / 1000) * 1000));
}

/** Is `key` the identity attribute {@link SURVIVOR_IDENTITY_ATTRIBUTES} lists for `resourceType`? */
export function isRecordedIdentityAttribute(resourceType: string, key: string): boolean {
  return (
    Object.hasOwn(SURVIVOR_IDENTITY_ATTRIBUTES, resourceType) &&
    SURVIVOR_IDENTITY_ATTRIBUTES[resourceType] === key
  );
}

/**
 * go-to-k/cdkd#6655: the attributes to record after an IN-PLACE update (or
 * revert) of a `resourceType` resource, `next` being what the provider
 * returned. A recorded identity id is never replaced: an in-place update
 * cannot change an AWS-minted id, so a different returned value is evidence
 * the update reached another resource under the same name (`onDiffering` is
 * told, so the caller can warn). A record without one acquires the returned
 * value (trust on first use). A replacement's result is not passed here: its
 * new resource's id is the one to record.
 */
export function keepRecordedIdentity(
  resourceType: string,
  previous: Readonly<Record<string, unknown>> | undefined,
  next: Record<string, unknown>,
  onDiffering?: (attribute: string) => void
): Record<string, unknown> {
  if (!Object.hasOwn(SURVIVOR_IDENTITY_ATTRIBUTES, resourceType)) return next;
  const key = SURVIVOR_IDENTITY_ATTRIBUTES[resourceType]!;
  const held = previous !== undefined && Object.hasOwn(previous, key) ? previous[key] : undefined;
  // A masked, secret-reference or empty value is no id: acquired over, never warned on.
  const recorded = isUsableIdentityValue(held) ? held : undefined;
  if (recorded === undefined || next[key] === recorded) return next;
  if (Object.hasOwn(next, key) && next[key] !== undefined) onDiffering?.(key);
  return { ...next, [key]: recorded };
}

/**
 * The attributes an UPDATE result leaves on the record: a replacement's own
 * (absent stays absent); in place, the returned set or else the recorded one,
 * with a recorded identity id kept ({@link keepRecordedIdentity}).
 */
export function attributesAfterUpdate(
  resourceType: string,
  previous: Record<string, unknown> | undefined,
  result: { attributes?: Record<string, unknown> | undefined; wasReplaced?: boolean | undefined },
  onDiffering?: (attribute: string) => void
): Record<string, unknown> | undefined {
  if (result.wasReplaced) return result.attributes;
  const next = result.attributes ?? previous;
  return next === undefined
    ? undefined
    : keepRecordedIdentity(resourceType, previous, next, onDiffering);
}

/**
 * go-to-k/cdkd#6655: `attributes` without `resourceType`'s identity id, for a
 * record whose resource is PROVEN gone: a delete-first replacement
 * (`oldDeletedBeforeCreate`) deleted it, so its id names nothing, and a
 * same-name re-create that then failed is not recorded anywhere else. Kept,
 * the dead id would refuse that new resource's delete; without it the record
 * deletes by name and acquires the live id on its next update. The input
 * itself when there is nothing to drop.
 */
export function withoutDeadIdentity(
  resourceType: string,
  attributes: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (attributes === undefined || !Object.hasOwn(SURVIVOR_IDENTITY_ATTRIBUTES, resourceType)) {
    return attributes;
  }
  const key = SURVIVOR_IDENTITY_ATTRIBUTES[resourceType]!;
  if (!Object.hasOwn(attributes, key)) return attributes;
  const { [key]: _dead, ...rest } = attributes;
  return rest;
}

/**
 * go-to-k/cdkd#6655: the attributes a rollback's delete of a delete-first
 * replacement's NEW resource passes as `recordedAttributes`. The record's own,
 * unless its identity id is still the OLD record's: that resource was deleted
 * first, so the id is dead and would refuse the new resource's delete.
 */
export function newCopyDeleteAttributes(
  resourceType: string,
  current: Record<string, unknown> | undefined,
  oldDeletedBeforeCreate: boolean | undefined,
  previous: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (
    oldDeletedBeforeCreate !== true ||
    !Object.hasOwn(SURVIVOR_IDENTITY_ATTRIBUTES, resourceType)
  ) {
    return current;
  }
  const key = SURVIVOR_IDENTITY_ATTRIBUTES[resourceType]!;
  return current?.[key] !== undefined && current[key] === previous?.[key]
    ? withoutDeadIdentity(resourceType, current)
    : current;
}

/**
 * Whether a recorded identity value is an id: a non-empty string carrying no
 * cdkd mask (`SECRET_MASK`, anywhere in it) and no secret reference. The ONE
 * predicate the delete compare (`recordedIdentityId`) and the update carry
 * ({@link keepRecordedIdentity}) read.
 */
export function isUsableIdentityValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value !== '' &&
    !mentionsMask(value) &&
    !holdsSecretDerivedEntry(value)
  );
}

/**
 * go-to-k/cdkd#6655: the attributes of a record whose resource a delete-first
 * replacement deleted before its create failed. Its identity id, when still
 * the deleted old record's (`previous`), is dead: replaced by the id the
 * failed create reported for the same-name resource it made (`madeIdentity`),
 * else dropped. Dropping (a create that adopted a prior attempt's resource or
 * timed out leaves no mark) returns to the by-name delete main had; keeping
 * the dead id would refuse our own resource. Residual, as on main: a stranger
 * that takes the name after a delete-first create that made nothing is
 * deleted by name. Any other value (the record already moved to the new
 * resource) is left alone. The input itself when nothing changes.
 */
export function replaceDeadIdentity(
  resourceType: string,
  attributes: Record<string, unknown> | undefined,
  previous: Record<string, unknown> | undefined,
  madeIdentity: string | undefined
): Record<string, unknown> | undefined {
  const dropped = newCopyDeleteAttributes(resourceType, attributes, true, previous);
  if (dropped === attributes || madeIdentity === undefined || madeIdentity === '') return dropped;
  return { ...dropped, [SURVIVOR_IDENTITY_ATTRIBUTES[resourceType]!]: madeIdentity };
}
