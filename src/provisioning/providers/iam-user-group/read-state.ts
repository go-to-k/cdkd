import type { IAMUserGroupProvider } from '../iam-user-group-provider.js';
import {
  GetUserCommand,
  GetGroupCommand,
  ListAttachedGroupPoliciesCommand,
  ListAttachedUserPoliciesCommand,
  ListUserPoliciesCommand,
  GetUserPolicyCommand,
  ListGroupPoliciesCommand,
  GetGroupPolicyCommand,
  ListGroupsForUserCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';
import { collectInlinePolicyNamesManagedBySiblings } from '../iam-role-provider.js';
import type { ResourceNotFound, ResourceIdentityVerdict } from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import {
  type UserOrGroupType,
  isUserOrGroupName,
  isUserOrGroupType,
  userOrGroupIdentityToken,
} from './shared.js';

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
 *    reconciled against state's `Policies` array). `Tags` and
 *    `LoginProfile` remain omitted — Tags will land in a follow-up,
 *    LoginProfile contains a one-time password we never want to surface
 *    through drift.
 *  - **AWS::IAM::Group**: `GetGroup` for `GroupName`, `Path`;
 *    `ListAttachedGroupPolicies` for `ManagedPolicyArns`;
 *    `ListGroupPolicies` + `GetGroupPolicy` per name for inline
 *    `Policies`.
 *  - **AWS::IAM::UserToGroupAddition**: SKIPPED — returns `undefined`
 *    because the resource is metadata-only (group-membership attachments
 *    written via `AddUserToGroup`). A meaningful drift check would
 *    require both the `GroupName` and the source-of-truth `Users` list
 *    from state, neither of which `readCurrentState` receives. The
 *    drift comparator falls back to "drift unknown" and the user can
 *    inspect the membership manually.
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
      return this.readUserCurrentState(physicalId, properties, context);
    case 'AWS::IAM::Group':
      return this.readGroupCurrentState(physicalId, properties, context);
    case 'AWS::IAM::UserToGroupAddition':
      // Membership-only resource. See JSDoc above.
      return undefined;
    default:
      this.logger.debug(
        `readCurrentState: unsupported resource type ${resourceType} for ${logicalId}`
      );
      return undefined;
  }
}

export async function readUserCurrentState(
  this: IAMUserGroupProvider,
  physicalId: string,
  properties?: Record<string, unknown>,
  context?: import('../../../types/resource.js').ReadCurrentStateContext
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
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

  try {
    const attached = await this.iamClient.send(
      new ListAttachedUserPoliciesCommand({ UserName: physicalId })
    );
    const arns = (attached.AttachedPolicies ?? [])
      .map((p) => p.PolicyArn)
      .filter((arn): arn is string => !!arn);
    result['ManagedPolicyArns'] = arns;
  } catch (err) {
    if (!(err instanceof NoSuchEntityException)) throw err;
  }

  try {
    const groups = await this.iamClient.send(
      new ListGroupsForUserCommand({ UserName: physicalId })
    );
    const names = (groups.Groups ?? []).map((g) => g.GroupName).filter((n): n is string => !!n);
    result['Groups'] = names;
  } catch (err) {
    if (!(err instanceof NoSuchEntityException)) throw err;
  }

  // Inline Policies — same pattern as IAMRoleProvider.readCurrentState.
  // Capped at IAM's 10-per-user limit; ListUserPolicies is paginated for
  // forward-compat.
  try {
    const inline = await this.collectInlinePolicies(
      'user',
      physicalId,
      (properties?.['Policies'] as Array<{ PolicyName?: string }> | undefined) ?? [],
      context
    );
    result['Policies'] = inline;
  } catch (err) {
    if (!(err instanceof NoSuchEntityException)) throw err;
  }

  return result;
}

export async function readGroupCurrentState(
  this: IAMUserGroupProvider,
  physicalId: string,
  properties?: Record<string, unknown>,
  context?: import('../../../types/resource.js').ReadCurrentStateContext
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
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

  try {
    const attached = await this.iamClient.send(
      new ListAttachedGroupPoliciesCommand({ GroupName: physicalId })
    );
    const arns = (attached.AttachedPolicies ?? [])
      .map((p) => p.PolicyArn)
      .filter((arn): arn is string => !!arn);
    result['ManagedPolicyArns'] = arns;
  } catch (err) {
    if (!(err instanceof NoSuchEntityException)) throw err;
  }

  try {
    const inline = await this.collectInlinePolicies(
      'group',
      physicalId,
      (properties?.['Policies'] as Array<{ PolicyName?: string }> | undefined) ?? [],
      context
    );
    result['Policies'] = inline;
  } catch (err) {
    if (!(err instanceof NoSuchEntityException)) throw err;
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
