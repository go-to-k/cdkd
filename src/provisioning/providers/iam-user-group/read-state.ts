import type { IAMUserGroupProvider } from '../iam-user-group-provider.js';
import {
  GetUserCommand,
  GetGroupCommand,
  GetLoginProfileCommand,
  ListAttachedGroupPoliciesCommand,
  ListAttachedUserPoliciesCommand,
  ListUserPoliciesCommand,
  GetUserPolicyCommand,
  ListGroupPoliciesCommand,
  GetGroupPolicyCommand,
  ListGroupsForUserCommand,
  NoSuchEntityException,
  type Tag,
} from '@aws-sdk/client-iam';
import { collectInlinePolicyNamesManagedBySiblings } from '../iam-role-provider.js';
import {
  collectGroupsAddedBySiblings,
  collectManagedPolicyArnsAttachedBySiblings,
  withoutSiblingAttachedArns,
  withoutSiblingOwned,
} from '../../iam-sibling-managed-policies.js';
import type { ResourceNotFound, ResourceIdentityVerdict } from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import {
  type UserOrGroupType,
  isUserOrGroupName,
  isUserOrGroupType,
  userOrGroupIdentityToken,
} from './shared.js';
import { warnUnsettledMember } from '../../settle-after-own-write.js';
import {
  principalOwnWriteMembers,
  settleOwnWriteMembers,
  stringListMember,
} from '../../settle-own-write-members.js';
import { readPrincipalLists } from '../../iam-policy-targets.js';
import { takeOwnWriteRemovals } from '../../own-write-removals.js';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import { coerceCfnBoolean } from '../../config-shape.js';

/**
 * go-to-k/cdkd#4606: whether the user or group a failed CREATE journaled is
 * the one the record under the same logical id holds (a fix-forward that
 * created a new one there under another name).
 *
 * Only `AWS::IAM::User` and `AWS::IAM::Group`; both ids must be NAMES of
 * that type (the physical id this provider records), else `'unknown'`, and
 * so are two names differing only in case: IAM treats those as one entity,
 * and this check does not decide on IAM's case rules. Equal names are
 * `'same'` without a read: whatever holds the name now is the record's, and
 * deleting by that name would delete it. A user or group name is unique per
 * account (case-insensitively), and a rename (`UpdateUser` /
 * `UpdateGroup`) is never issued by cdkd. After the region check the
 * record's entity must read back (else `'unknown'`); the journaled one is
 * `'same'` when it reads back under the record's id, `'different'` under
 * another, and `'different'` when IAM reports it gone: the record's entity
 * answers to its own, other, name. Any other read failure throws, which the
 * caller reads as `'unknown'`.
 */
export async function isSameResource(
  this: IAMUserGroupProvider,
  journaledPhysicalId: string,
  record: { physicalId: string },
  resourceType: string,
  context: { expectedRegion: string }
): Promise<ResourceIdentityVerdict> {
  if (!isUserOrGroupType(resourceType)) return 'unknown';
  if (
    !isUserOrGroupName(resourceType, journaledPhysicalId) ||
    !isUserOrGroupName(resourceType, record.physicalId)
  ) {
    return 'unknown';
  }
  if (journaledPhysicalId === record.physicalId) return 'same';
  if (journaledPhysicalId.toLowerCase() === record.physicalId.toLowerCase()) return 'unknown';
  const clientRegion = await this.iamClient.config.region();
  if (clientRegion !== context.expectedRegion) return 'unknown';
  const recordId = await this.readIdIfExists(resourceType, record.physicalId);
  if (recordId === undefined) return 'unknown';
  const journaledId = await this.readIdIfExists(resourceType, journaledPhysicalId);
  if (journaledId === undefined) return 'different';
  // Unreachable as 'same' while the names differ beyond case; kept so the
  // verdict rests on AWS's answer.
  return journaledId === recordId ? 'same' : 'different';
}

/**
 * go-to-k/cdkd#4655 / #4606: the user's `UserId` or the group's `GroupId`
 * ({@link userOrGroupIdentityToken}). One re-created under the name answers
 * with another, so the settle keeps it rather than deleting it as the failed
 * CREATE's orphan. A failed CREATE's own token comes from its `CreateUser` /
 * `CreateGroup` response, on the failure's mark (`markCreatedBeforeFailure`);
 * this is the live read.
 *
 * `undefined` for another type (`AWS::IAM::UserToGroupAddition` included),
 * an id that is not a name of the type, or a client in another region than
 * `expectedRegion` (IAM is global, but the check keeps every identity read
 * on the stack's own client). `RESOURCE_NOT_FOUND` only on
 * `NoSuchEntityException`; any other failure, a response naming another
 * entity, and one with no id throw.
 */
export async function resourceIdentity(
  this: IAMUserGroupProvider,
  physicalId: string,
  resourceType: string,
  context: { expectedRegion: string }
): Promise<string | ResourceNotFound | undefined> {
  if (!isUserOrGroupType(resourceType) || !isUserOrGroupName(resourceType, physicalId)) {
    return undefined;
  }
  const clientRegion = await this.iamClient.config.region();
  if (clientRegion !== context.expectedRegion) return undefined;
  const id = await this.readIdIfExists(resourceType, physicalId);
  return id === undefined ? RESOURCE_NOT_FOUND : id;
}

/**
 * The user's `UserId` (`GetUser`) or the group's `GroupId` (`GetGroup`,
 * one member page at most), or `undefined` when IAM answers
 * `NoSuchEntityException`. Any other failure, a response naming another
 * entity, and one with no id throw: "could not read" never reads as "gone".
 */
export async function readIdIfExists(
  this: IAMUserGroupProvider,
  resourceType: UserOrGroupType,
  name: string
): Promise<string | undefined> {
  let answeredName: string | undefined;
  let id: string | undefined;
  try {
    if (resourceType === 'AWS::IAM::User') {
      const response = await this.iamClient.send(new GetUserCommand({ UserName: name }));
      answeredName = response.User?.UserName;
      id = response.User?.UserId;
    } else {
      const response = await this.iamClient.send(
        new GetGroupCommand({ GroupName: name, MaxItems: 1 })
      );
      answeredName = response.Group?.GroupName;
      id = response.Group?.GroupId;
    }
  } catch (error) {
    if (error instanceof NoSuchEntityException) return undefined;
    throw error;
  }
  const noun = resourceType === 'AWS::IAM::User' ? 'user' : 'group';
  if (answeredName !== name) {
    throw new Error(`IAM answered for another ${noun} than the one asked for`);
  }
  const token = userOrGroupIdentityToken(id);
  if (token === undefined) {
    throw new Error(`IAM returned no ${noun === 'user' ? 'UserId' : 'GroupId'}`);
  }
  return token;
}

/**
 * Read the AWS-current configuration for an IAM user / group /
 * UserToGroupAddition in CFn-property shape.
 *
 *  - **AWS::IAM::User**: `GetUser` for `UserName`, `Path`,
 *    `PermissionsBoundary` (re-shaped from `PermissionsBoundary.Arn`,
 *    always-emit `''` placeholder so console-side ADD on a user
 *    deployed without a boundary surfaces as drift);
 *    `ListAttachedUserPolicies` for `ManagedPolicyArns`;
 *    `ListGroupsForUser` for `Groups`; `ListUserPolicies` +
 *    `GetUserPolicy` per name for inline `Policies` (URL-decoded +
 *    JSON-parsed, capped at IAM's documented 10-per-user limit, order
 *    reconciled against state's `Policies` array); `Tags` from `GetUser`;
 *    `LoginProfile.PasswordResetRequired` via `GetLoginProfile` (for a
 *    record declaring none: `{}` when the user has one, `null` when not (go-to-k/cdkd#6755;
 *    the password is write-only).
 *  - **AWS::IAM::Group**: `GetGroup` for `GroupName`, `Path`;
 *    `ListAttachedGroupPolicies` for `ManagedPolicyArns`;
 *    `ListGroupPolicies` + `GetGroupPolicy` per name for inline
 *    `Policies`.
 *  - **AWS::IAM::UserToGroupAddition**: `ListGroupsForUser` for each
 *    recorded user, for `GroupName` and the `Users` still in it
 *    (go-to-k/cdkd#6769; {@link readUserToGroupAdditionState}).
 *
 * On the capture right after cdkd's own write (`context.afterOwnWrite`,
 * go-to-k/cdkd#6609) each declared member that disagrees is re-read alone
 * (`settle-own-write-members.ts`); every other read takes the first answer.
 *
 * Returns `RESOURCE_NOT_FOUND` when the user / group is gone
 * (`NoSuchEntityException`).
 */
export async function readCurrentState(
  this: IAMUserGroupProvider,
  physicalId: string,
  logicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: import('../../../types/resource.js').ReadCurrentStateContext
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  switch (resourceType) {
    case 'AWS::IAM::User':
      return this.readUserCurrentState(physicalId, properties, context, logicalId);
    case 'AWS::IAM::Group':
      return this.readGroupCurrentState(physicalId, properties, context, logicalId);
    case 'AWS::IAM::UserToGroupAddition':
      return readUserToGroupAdditionState.call(this, logicalId, properties, context);
    default:
      this.logger.debug(
        `readCurrentState: unsupported resource type ${resourceType} for ${logicalId}`
      );
      return undefined;
  }
}

/**
 * An `AWS::IAM::UserToGroupAddition`'s membership (go-to-k/cdkd#6769). Its
 * physical id is the logical id, so the address is the record's `GroupName`
 * and `Users`: `ListGroupsForUser` (paginated) for each recorded user, and
 * `Users` is the recorded users still in the group, in recorded order. IAM
 * names are case-insensitive, so a user is a member when a group of the
 * recorded name in any case lists it. A user IAM no longer has
 * (`NoSuchEntityException`) is no member; any other failure throws.
 *
 * A record whose `GroupName` or `Users` is not a list of IAM names (a
 * redacted or secret-derived entry, go-to-k/cdkd#4150) cannot be addressed:
 * `undefined`, drift unknown, never a guess. `RESOURCE_NOT_FOUND` only when
 * no recorded user is in the group and `GetGroup` says the group is gone; a
 * group still there with every user removed reads as `Users: []`, which
 * `drift --revert` can re-add.
 *
 * On the capture right after cdkd's own write (`context.afterOwnWrite`) a
 * declared user not listed yet is re-read on the settle schedule, as a
 * user's `Groups` is.
 */
async function readUserToGroupAdditionState(
  this: IAMUserGroupProvider,
  logicalId: string,
  properties: Record<string, unknown> | undefined,
  context: import('../../../types/resource.js').ReadCurrentStateContext | undefined
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const groupName = properties?.['GroupName'];
  if (typeof groupName !== 'string' || !isUserOrGroupName('AWS::IAM::Group', groupName)) {
    return undefined;
  }
  const read = readPrincipalLists({ Users: properties?.['Users'] });
  const declared = 'malformed' in read ? undefined : read.lists.Users;
  if (declared === undefined || !declared.every((u) => isUserOrGroupName('AWS::IAM::User', u))) {
    return undefined;
  }
  const fold = (name: string): string => name.toLowerCase();
  const wanted = fold(groupName);
  const isMember = async (userName: string): Promise<boolean> => {
    let marker: string | undefined;
    try {
      do {
        const resp = await this.iamClient.send(
          new ListGroupsForUserCommand({ UserName: userName, ...(marker && { Marker: marker }) })
        );
        if ((resp.Groups ?? []).some((g) => g.GroupName && fold(g.GroupName) === wanted)) {
          return true;
        }
        marker = resp.IsTruncated === true ? resp.Marker : undefined;
      } while (marker);
    } catch (err) {
      if (err instanceof NoSuchEntityException) return false;
      throw err;
    }
    return false;
  };
  const readUsers = async (): Promise<string[]> => {
    const members = await Promise.all(declared.map(isMember));
    return declared.filter((_, i) => members[i]);
  };

  // `GetGroup` directly, not `readIdIfExists`: that one refuses an answer
  // whose name differs in case, and IAM matches a group name in any case.
  const groupGone = async (): Promise<boolean> => {
    try {
      await this.iamClient.send(new GetGroupCommand({ GroupName: groupName, MaxItems: 1 }));
      return false;
    } catch (err) {
      if (err instanceof NoSuchEntityException) return true;
      throw err;
    }
  };
  const users = await readUsers();
  if (users.length === 0 && declared.length > 0 && (await groupGone())) {
    return RESOURCE_NOT_FOUND;
  }
  const result: Record<string, unknown> = { GroupName: groupName, Users: users };
  if (context?.afterOwnWrite === true) {
    await settleOwnWriteMembers(
      result,
      [
        stringListMember(
          'Users',
          declared,
          async () => ({ value: await readUsers() }),
          undefined,
          fold
        ),
      ],
      this.ownWriteRereadDelaysMs,
      (key) => warnUnsettledMember(this.logger, logicalId, 'AWS::IAM::UserToGroupAddition', key)
    );
  }
  return result;
}

export async function readUserCurrentState(
  this: IAMUserGroupProvider,
  physicalId: string,
  properties?: Record<string, unknown>,
  context?: import('../../../types/resource.js').ReadCurrentStateContext,
  logicalId = physicalId
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  // go-to-k/cdkd#6609: what the write removed, taken before the first await
  // (`own-write-removals.ts`).
  const removed =
    context?.afterOwnWrite === true
      ? takeOwnWriteRemovals('AWS::IAM::User', physicalId)
      : undefined;
  let user;
  try {
    const resp = await this.iamClient.send(new GetUserCommand({ UserName: physicalId }));
    user = resp.User;
  } catch (err) {
    if (err instanceof NoSuchEntityException) return RESOURCE_NOT_FOUND;
    throw err;
  }
  if (!user) return undefined;

  const result: Record<string, unknown> = {};
  if (user.UserName !== undefined) result['UserName'] = user.UserName;
  if (user.Path !== undefined) result['Path'] = user.Path;
  // Always-emit so a console-side ADD on a user deployed without a
  // boundary surfaces as drift (top-level walk is state-keys-only).
  result['PermissionsBoundary'] = user.PermissionsBoundary?.PermissionsBoundaryArn ?? '';
  const ownWrite = context?.afterOwnWrite === true;
  const tags = readbackUserTags(user.Tags, properties, ownWrite);
  if (tags !== undefined) result['Tags'] = tags;
  if (properties?.['LoginProfile'] != null) {
    const profile = await readLoginProfile.call(this, physicalId, properties, ownWrite);
    if (profile !== undefined) result['LoginProfile'] = profile;
  } else {
    result['LoginProfile'] = await readUndeclaredLoginProfile.call(
      this,
      physicalId,
      ownWrite && removed?.has('LoginProfile') === true
    );
  }

  const reads = userMemberReads.call(this, physicalId, properties, context);
  try {
    result['ManagedPolicyArns'] = await reads.managedPolicyArns();
  } catch (err) {
    if (!(err instanceof NoSuchEntityException)) throw err;
  }

  try {
    result['Groups'] = await reads.groups();
  } catch (err) {
    if (!(err instanceof NoSuchEntityException)) throw err;
  }

  // Inline Policies — same pattern as IAMRoleProvider.readCurrentState.
  // Capped at IAM's 10-per-user limit; ListUserPolicies is paginated for
  // forward-compat.
  try {
    result['Policies'] = await reads.policies();
  } catch (err) {
    if (!(err instanceof NoSuchEntityException)) throw err;
  }

  if (context?.afterOwnWrite === true && properties !== undefined) {
    await settleOwnWriteMembers(
      result,
      principalOwnWriteMembers(
        properties,
        {
          boundary: async () => {
            const resp = await this.iamClient.send(new GetUserCommand({ UserName: physicalId }));
            return resp.User
              ? { value: resp.User.PermissionsBoundary?.PermissionsBoundaryArn ?? '' }
              : 'failed';
          },
          managedPolicyArns: async () => ({ value: await reads.managedPolicyArns() }),
          groups: async () => ({ value: await reads.groups() }),
          policies: async () => ({ value: await reads.policies() }),
        },
        removed
      ),
      this.ownWriteRereadDelaysMs,
      (key) => warnUnsettledMember(this.logger, logicalId, 'AWS::IAM::User', key)
    );
  }
  return result;
}

/**
 * The user's `Tags`, from the `GetUser` response (go-to-k/cdkd#6755): the
 * reserved `aws:` tags dropped, and the key omitted when none is left, so a
 * template declaring none is not compared against `[]`. On the capture right
 * after cdkd's own write (`afterOwnWrite`) a read whose tags differ from the
 * declared list keeps the declared one: IAM reads lag its writes, and a lagging
 * read frozen into the baseline would report every later read as drift.
 */
function readbackUserTags(
  awsTags: readonly Tag[] | undefined,
  properties: Record<string, unknown> | undefined,
  afterOwnWrite: boolean
): unknown[] | undefined {
  const tags = normalizeAwsTagsToCfn(awsTags);
  const declared = properties?.['Tags'];
  // A template declaring no tags had its last ones removed by this write, so
  // a read still showing them is the lag too: no baseline key, not the old tags.
  if (afterOwnWrite && properties !== undefined && declared == null) return undefined;
  const bag =
    afterOwnWrite && Array.isArray(declared) && !sameTagSet(tags, declared) ? declared : tags;
  return bag.length > 0 ? bag : undefined;
}

/** Whether two tag lists hold the same `Key` / `Value` pairs, in any order. */
function sameTagSet(a: readonly unknown[], b: readonly unknown[]): boolean {
  const pairs = (list: readonly unknown[]): string =>
    JSON.stringify(
      list
        .map((entry) => {
          const tag = (entry ?? {}) as Record<string, unknown>;
          return JSON.stringify([tag['Key'], tag['Value'] ?? '']);
        })
        .sort()
    );
  return pairs(a) === pairs(b);
}

/**
 * The user's `LoginProfile` (go-to-k/cdkd#6755) for a record that declares
 * one (a record declaring none: {@link readUndeclaredLoginProfile}).
 * `PasswordResetRequired` alone: `Password` is write-only and
 * `getDriftUnknownPaths` declares it. `undefined` when the user has no login
 * profile (`NoSuchEntityException`), so a profile deleted out of band reads
 * as the declared one gone; any other failure throws, since omitting the key
 * would read as that deletion. A declared `PasswordResetRequired: true` read
 * back `false` reads as `true`: IAM clears it when the user changes the
 * password at sign-in. On the capture right after cdkd's own write a
 * profile not visible yet, or one whose flag differs from the declared one
 * (`UpdateLoginProfile` not visible yet), keeps the declared shape, as the
 * tags do.
 */
async function readLoginProfile(
  this: IAMUserGroupProvider,
  userName: string,
  properties: Record<string, unknown>,
  afterOwnWrite: boolean
): Promise<Record<string, unknown> | undefined> {
  const declared = properties['LoginProfile'] as Record<string, unknown>;
  const declaredShape = {
    PasswordResetRequired: coerceCfnBoolean(declared['PasswordResetRequired']) === true,
  };
  let read: Record<string, unknown> | undefined;
  try {
    const resp = await this.iamClient.send(new GetLoginProfileCommand({ UserName: userName }));
    // One-directional: IAM itself clears a required reset once the user sets
    // a new password at sign-in, so a declared `true` read back `false` is
    // that, not drift; reporting it would flag every user who has signed in
    // once, and `--revert` would force another reset. A declared `false`
    // read back `true` is still drift.
    const live = resp.LoginProfile?.PasswordResetRequired === true;
    read = { PasswordResetRequired: live || declaredShape.PasswordResetRequired };
  } catch (err) {
    if (!(err instanceof NoSuchEntityException)) throw err;
  }
  if (!afterOwnWrite) return read;
  return read?.['PasswordResetRequired'] === declaredShape.PasswordResetRequired
    ? read
    : declaredShape;
}

/**
 * The `LoginProfile` of a user whose record declares none (go-to-k/cdkd#6755):
 * `null` when the user has no login profile (`NoSuchEntityException`), else
 * `{}`: its presence only. Never the write-only password: `GetLoginProfile`
 * returns none. Not `PasswordResetRequired` either: IAM clears a required
 * reset itself at the user's first sign-in, so an `--accept`ed `true` would
 * then read as drift on every run, and `--revert` would force the reset again
 * (the declared reader handles that one-directionally; with no template value
 * there is nothing to anchor it to). `{}` and `null` still differ, so an add
 * or a removal is drift.
 *
 * Always emitted, so the observed baseline holds `null` for a user deployed
 * without console access. `null` is an empty value the comparator skips for
 * an undeclared key (go-to-k/cdkd#1498) unless the type lists the key as
 * compared (`UNDECLARED_EMPTY_COMPARED_KEYS`, which lists `LoginProfile` for
 * `AWS::IAM::User`: no other resource and no AWS process creates a login
 * profile). A profile added out of band then reads as drift, and
 * `drift --revert` sends `null`, which `update()` turns into one
 * `DeleteLoginProfile`. A baseline written before this change has no
 * `LoginProfile` key; the top-level walk visits only the baseline's keys, so
 * it is not compared there until the next capture. Nor is it compared on the
 * template-only baseline (no `observedProperties`). A profile added out of
 * band and not reported before a deploy that updates the user is captured
 * into that deploy's baseline, as any other undeclared key is.
 *
 * Any failure other than `NoSuchEntityException` throws (go-to-k/cdkd#6696):
 * `null` would read as "no profile" and hide one.
 *
 * `removedByOwnWrite`: on the capture right after an update that deleted the
 * profile (the template dropped `LoginProfile`), `null` without a read, so a
 * read still showing the deleted profile is not frozen into the baseline.
 */
async function readUndeclaredLoginProfile(
  this: IAMUserGroupProvider,
  userName: string,
  removedByOwnWrite: boolean
): Promise<Record<string, unknown> | null> {
  if (removedByOwnWrite) return null;
  try {
    await this.iamClient.send(new GetLoginProfileCommand({ UserName: userName }));
    return {};
  } catch (err) {
    if (err instanceof NoSuchEntityException) return null;
    throw err;
  }
}

/**
 * Drift paths no read answers: a user's `LoginProfile.Password`, write-only in
 * IAM (go-to-k/cdkd#6755).
 */
export function getDriftUnknownPaths(this: IAMUserGroupProvider, resourceType: string): string[] {
  return resourceType === 'AWS::IAM::User' ? ['LoginProfile.Password'] : [];
}

/**
 * The user's list members, each its own read: attached managed policy ARNs
 * minus a sibling `AWS::IAM::ManagedPolicy`'s `Users` attach
 * (go-to-k/cdkd#6324), group names minus a group a sibling
 * `AWS::IAM::UserToGroupAddition` adds the user to (go-to-k/cdkd#6328), and
 * the inline policies.
 */
function userMemberReads(
  this: IAMUserGroupProvider,
  physicalId: string,
  properties: Record<string, unknown> | undefined,
  context: import('../../../types/resource.js').ReadCurrentStateContext | undefined
): {
  managedPolicyArns: () => Promise<string[]>;
  groups: () => Promise<string[]>;
  policies: () => Promise<Array<{ PolicyName: string; PolicyDocument: unknown }>>;
} {
  return {
    managedPolicyArns: async () => {
      const attached = await this.iamClient.send(
        new ListAttachedUserPoliciesCommand({ UserName: physicalId })
      );
      const arns = (attached.AttachedPolicies ?? [])
        .map((p) => p.PolicyArn)
        .filter((arn): arn is string => !!arn);
      return withoutSiblingAttachedArns(
        arns,
        collectManagedPolicyArnsAttachedBySiblings(physicalId, context, 'Users'),
        properties
      );
    },
    groups: async () => {
      const groups = await this.iamClient.send(
        new ListGroupsForUserCommand({ UserName: physicalId })
      );
      const names = (groups.Groups ?? []).map((g) => g.GroupName).filter((n): n is string => !!n);
      return withoutSiblingOwned(
        names,
        collectGroupsAddedBySiblings(physicalId, context),
        properties,
        'Groups',
        true
      );
    },
    policies: () =>
      this.collectInlinePolicies(
        'user',
        physicalId,
        (properties?.['Policies'] as Array<{ PolicyName?: string }> | undefined) ?? [],
        context
      ),
  };
}

export async function readGroupCurrentState(
  this: IAMUserGroupProvider,
  physicalId: string,
  properties?: Record<string, unknown>,
  context?: import('../../../types/resource.js').ReadCurrentStateContext,
  logicalId = physicalId
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  // go-to-k/cdkd#6609: taken before the first await, as for a user.
  const removed =
    context?.afterOwnWrite === true
      ? takeOwnWriteRemovals('AWS::IAM::Group', physicalId)
      : undefined;
  let group;
  try {
    const resp = await this.iamClient.send(new GetGroupCommand({ GroupName: physicalId }));
    group = resp.Group;
  } catch (err) {
    if (err instanceof NoSuchEntityException) return RESOURCE_NOT_FOUND;
    throw err;
  }
  if (!group) return undefined;

  const result: Record<string, unknown> = {};
  if (group.GroupName !== undefined) result['GroupName'] = group.GroupName;
  if (group.Path !== undefined) result['Path'] = group.Path;

  // go-to-k/cdkd#6324: minus a sibling `AWS::IAM::ManagedPolicy`'s `Groups` attach.
  const managedPolicyArns = async (): Promise<string[]> => {
    const attached = await this.iamClient.send(
      new ListAttachedGroupPoliciesCommand({ GroupName: physicalId })
    );
    const arns = (attached.AttachedPolicies ?? [])
      .map((p) => p.PolicyArn)
      .filter((arn): arn is string => !!arn);
    return withoutSiblingAttachedArns(
      arns,
      collectManagedPolicyArnsAttachedBySiblings(physicalId, context, 'Groups'),
      properties
    );
  };
  const policies = (): Promise<Array<{ PolicyName: string; PolicyDocument: unknown }>> =>
    this.collectInlinePolicies(
      'group',
      physicalId,
      (properties?.['Policies'] as Array<{ PolicyName?: string }> | undefined) ?? [],
      context
    );
  try {
    result['ManagedPolicyArns'] = await managedPolicyArns();
  } catch (err) {
    if (!(err instanceof NoSuchEntityException)) throw err;
  }

  try {
    result['Policies'] = await policies();
  } catch (err) {
    if (!(err instanceof NoSuchEntityException)) throw err;
  }

  if (context?.afterOwnWrite === true && properties !== undefined) {
    await settleOwnWriteMembers(
      result,
      principalOwnWriteMembers(
        properties,
        {
          managedPolicyArns: async () => ({ value: await managedPolicyArns() }),
          policies: async () => ({ value: await policies() }),
        },
        removed
      ),
      this.ownWriteRereadDelaysMs,
      (key) => warnUnsettledMember(this.logger, logicalId, 'AWS::IAM::Group', key)
    );
  }
  return result;
}

/**
 * Shared inline-policy fetcher for User / Group readCurrentState.
 * Mirrors `IAMRoleProvider.readCurrentState`'s inline-policy handling:
 * paginated `List*Policies` for names → parallel `Get*Policy` per name
 * for bodies (URL-decoded + JSON-parsed) → reconcile order against
 * `statePolicies` so a positional compare doesn't fire false drift on
 * the lexicographic order returned by AWS.
 *
 * Issue #323: filters out policies whose name matches an
 * `AWS::IAM::Policy` sibling in the same stack (via `Users`/`Groups`
 * attachment field), so policies attached by `iam.Policy({ users: [u] })` /
 * `groups: [g]` don't fire false drift on the User / Group itself.
 */
export async function collectInlinePolicies(
  this: IAMUserGroupProvider,
  kind: 'user' | 'group',
  physicalId: string,
  statePolicies: Array<{ PolicyName?: string }>,
  context: import('../../../types/resource.js').ReadCurrentStateContext | undefined
): Promise<Array<{ PolicyName: string; PolicyDocument: unknown }>> {
  const policyNames: string[] = [];
  let marker: string | undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const listResp =
      kind === 'user'
        ? await this.iamClient.send(
            new ListUserPoliciesCommand({
              UserName: physicalId,
              ...(marker ? { Marker: marker } : {}),
            })
          )
        : await this.iamClient.send(
            new ListGroupPoliciesCommand({
              GroupName: physicalId,
              ...(marker ? { Marker: marker } : {}),
            })
          );
    for (const name of listResp.PolicyNames ?? []) policyNames.push(name);
    if (!listResp.IsTruncated) break;
    marker = listResp.Marker;
  }

  const managedByOtherResource = collectInlinePolicyNamesManagedBySiblings(
    physicalId,
    context,
    kind === 'user' ? 'Users' : 'Groups'
  );
  const filteredNames = policyNames.filter((n) => !managedByOtherResource.has(n));

  const bodies = new Map<string, unknown>();
  await Promise.all(
    filteredNames.map(async (name) => {
      const resp =
        kind === 'user'
          ? await this.iamClient.send(
              new GetUserPolicyCommand({ UserName: physicalId, PolicyName: name })
            )
          : await this.iamClient.send(
              new GetGroupPolicyCommand({ GroupName: physicalId, PolicyName: name })
            );
      if (!resp.PolicyDocument) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(decodeURIComponent(resp.PolicyDocument));
      } catch {
        parsed = resp.PolicyDocument;
      }
      bodies.set(name, parsed);
    })
  );

  const remaining = new Set(bodies.keys());
  const inline: Array<{ PolicyName: string; PolicyDocument: unknown }> = [];
  for (const sp of statePolicies) {
    const name = sp?.PolicyName;
    if (typeof name !== 'string') continue;
    if (bodies.has(name)) {
      inline.push({ PolicyName: name, PolicyDocument: bodies.get(name) });
      remaining.delete(name);
    }
  }
  for (const name of [...remaining].sort()) {
    inline.push({ PolicyName: name, PolicyDocument: bodies.get(name) });
  }
  return inline;
}
