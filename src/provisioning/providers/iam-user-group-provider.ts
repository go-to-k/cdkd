import { IAMClient } from '@aws-sdk/client-iam';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { IamCreateClientCache } from './iam-create-client.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type { DeleteContext } from '../region-check.js';
import type { MaskedLogSinks, MaskerFn } from '../masked-retry-logger.js';
import type { DeleteProgress } from '../delete-started.js';
import type {
  CreateContext,
  UpdateContext,
  InlinePolicyClaimed,
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceDeleteResult,
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
  ResourceIdentityVerdict,
} from '../../types/resource.js';
import { type UserOrGroupType } from './iam-user-group/shared.js';
import {
  wrapMaskedError,
  cleanupFailureText,
  create,
  update,
  deleteImpl,
} from './iam-user-group/core.js';
import { createUser } from './iam-user-group/user-create.js';
import {
  updateUser,
  applyUserTagDiff,
  updateUserManagedPolicies,
  updateUserGroups,
  updateUserInlinePolicies,
} from './iam-user-group/user-update.js';
import {
  deleteUser,
  readLiveGroups,
  removeUserFromAllGroups,
  deleteAllAccessKeys,
  detachAllUserPolicies,
  deleteAllUserInlinePolicies,
} from './iam-user-group/user-delete.js';
import {
  createGroup,
  updateGroup,
  deleteGroup,
  detachAllGroupPolicies,
  removeAllUsersFromGroup,
  updateGroupManagedPolicies,
  deleteAllGroupInlinePolicies,
  updateGroupInlinePolicies,
} from './iam-user-group/group.js';
import {
  createUserToGroupAddition,
  updateUserToGroupAddition,
  deleteUserToGroupAddition,
} from './iam-user-group/user-to-group-addition.js';
import {
  isSameResource,
  resourceIdentity,
  readIdIfExists,
  readCurrentState,
  readUserCurrentState,
  readGroupCurrentState,
  collectInlinePolicies,
} from './iam-user-group/read-state.js';
import {
  importImpl,
  importUser,
  importGroup,
  importUserToGroupAddition,
} from './iam-user-group/import.js';
export {
  MEMBERSHIP_NO_PROPERTIES_SKIP_REASON,
  MEMBERSHIP_MISSING_FIELDS_SKIP_REASON,
  MEMBERSHIP_MALFORMED_USERS_SKIP_REASON,
  MEMBERSHIP_SECRET_USER_NOT_MEMBER_SKIP_REASON,
} from './iam-user-group/shared.js';

/**
 * AWS IAM User / Group / UserToGroupAddition Provider
 *
 * Implements resource provisioning for:
 * - AWS::IAM::User
 * - AWS::IAM::Group
 * - AWS::IAM::UserToGroupAddition
 *
 * Uses multi-resource-type dispatch pattern.
 */
export class IAMUserGroupProvider implements ResourceProvider {
  iamClient: IAMClient;
  /** `CreateUser` / `CreateGroup` goes through this client, which refuses the SDK retry of a 5xx (issue #4639). */
  readonly createClient = new IamCreateClientCache(() => this.iamClient);
  logger: ConsoleLogger = getLogger().child('IAMUserGroupProvider');

  wrapMaskedError(
    mask: MaskerFn,
    error: unknown,
    build: (maskedText: string) => ProvisioningError
  ): ProvisioningError {
    return wrapMaskedError.call(this, mask, error, build);
  }

  cleanupFailureText(
    head: string,
    cleanupError: unknown,
    log: { mask: MaskerFn; debug: (message: string) => void }
  ): string {
    return cleanupFailureText.call(this, head, cleanupError, log);
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::IAM::User',
      new Set([
        'UserName',
        'Path',
        'Tags',
        'LoginProfile',
        'ManagedPolicyArns',
        'Groups',
        'Policies',
        'PermissionsBoundary',
      ]),
    ],
    ['AWS::IAM::Group', new Set(['GroupName', 'Path', 'ManagedPolicyArns', 'Policies'])],
    ['AWS::IAM::UserToGroupAddition', new Set(['GroupName', 'Users'])],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.iamClient = awsClients.iam;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return update.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  // ─── AWS::IAM::User ──────────────────────────────────────────────

  createUser(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceCreateResult> {
    return createUser.call(this, logicalId, resourceType, properties, log);
  }

  updateUser(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    log: MaskedLogSinks,
    claimed: InlinePolicyClaimed | undefined
  ): Promise<ResourceUpdateResult> {
    return updateUser.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      log,
      claimed
    );
  }

  deleteUser(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    return deleteUser.call(this, logicalId, physicalId, resourceType, context);
  }

  readLiveGroups(userName: string): Promise<string[]> {
    return readLiveGroups.call(this, userName);
  }

  removeUserFromAllGroups(
    userName: string,
    log: MaskedLogSinks,
    progress?: DeleteProgress
  ): Promise<void> {
    return removeUserFromAllGroups.call(this, userName, log, progress);
  }

  deleteAllAccessKeys(
    userName: string,
    log: MaskedLogSinks,
    progress?: DeleteProgress
  ): Promise<void> {
    return deleteAllAccessKeys.call(this, userName, log, progress);
  }

  detachAllUserPolicies(
    userName: string,
    log: MaskedLogSinks,
    progress?: DeleteProgress
  ): Promise<void> {
    return detachAllUserPolicies.call(this, userName, log, progress);
  }

  deleteAllUserInlinePolicies(
    userName: string,
    log: MaskedLogSinks,
    progress?: DeleteProgress
  ): Promise<void> {
    return deleteAllUserInlinePolicies.call(this, userName, log, progress);
  }

  applyUserTagDiff(
    userName: string,
    resourceType: string,
    logicalId: string,
    oldTagsRaw: unknown,
    newTagsRaw: unknown,
    log: MaskedLogSinks
  ): Promise<void> {
    return applyUserTagDiff.call(
      this,
      userName,
      resourceType,
      logicalId,
      oldTagsRaw,
      newTagsRaw,
      log
    );
  }

  updateUserManagedPolicies(
    userName: string,
    newPolicies: string[] | undefined,
    oldPolicies: string[] | undefined,
    log: MaskedLogSinks
  ): Promise<void> {
    return updateUserManagedPolicies.call(this, userName, newPolicies, oldPolicies, log);
  }

  updateUserGroups(
    userName: string,
    newGroups: string[] | undefined,
    oldGroups: string[] | undefined,
    log: MaskedLogSinks
  ): Promise<void> {
    return updateUserGroups.call(this, userName, newGroups, oldGroups, log);
  }

  updateUserInlinePolicies(
    userName: string,
    newPolicies: Array<{ PolicyName: string; PolicyDocument: unknown }> | undefined,
    oldPolicies: Array<{ PolicyName: string; PolicyDocument: unknown }> | undefined,
    log: MaskedLogSinks,
    claimed: InlinePolicyClaimed | undefined
  ): Promise<void> {
    return updateUserInlinePolicies.call(this, userName, newPolicies, oldPolicies, log, claimed);
  }

  // ─── AWS::IAM::Group ─────────────────────────────────────────────

  createGroup(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceCreateResult> {
    return createGroup.call(this, logicalId, resourceType, properties, log);
  }

  updateGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    log: MaskedLogSinks,
    claimed: InlinePolicyClaimed | undefined
  ): Promise<ResourceUpdateResult> {
    return updateGroup.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      log,
      claimed
    );
  }

  deleteGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    return deleteGroup.call(this, logicalId, physicalId, resourceType, context);
  }

  detachAllGroupPolicies(
    groupName: string,
    log: MaskedLogSinks,
    progress?: DeleteProgress
  ): Promise<void> {
    return detachAllGroupPolicies.call(this, groupName, log, progress);
  }

  removeAllUsersFromGroup(
    groupName: string,
    log: MaskedLogSinks,
    progress?: DeleteProgress
  ): Promise<void> {
    return removeAllUsersFromGroup.call(this, groupName, log, progress);
  }

  updateGroupManagedPolicies(
    groupName: string,
    newPolicies: string[] | undefined,
    oldPolicies: string[] | undefined,
    log: MaskedLogSinks
  ): Promise<void> {
    return updateGroupManagedPolicies.call(this, groupName, newPolicies, oldPolicies, log);
  }

  deleteAllGroupInlinePolicies(
    groupName: string,
    log: MaskedLogSinks,
    progress?: DeleteProgress
  ): Promise<void> {
    return deleteAllGroupInlinePolicies.call(this, groupName, log, progress);
  }

  updateGroupInlinePolicies(
    groupName: string,
    newPolicies: Array<{ PolicyName: string; PolicyDocument: unknown }> | undefined,
    oldPolicies: Array<{ PolicyName: string; PolicyDocument: unknown }> | undefined,
    log: MaskedLogSinks,
    claimed: InlinePolicyClaimed | undefined
  ): Promise<void> {
    return updateGroupInlinePolicies.call(this, groupName, newPolicies, oldPolicies, log, claimed);
  }

  // ─── AWS::IAM::UserToGroupAddition ────────────────────────────────

  createUserToGroupAddition(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceCreateResult> {
    return createUserToGroupAddition.call(this, logicalId, resourceType, properties, log);
  }

  updateUserToGroupAddition(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceUpdateResult> {
    return updateUserToGroupAddition.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      log
    );
  }

  deleteUserToGroupAddition(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    return deleteUserToGroupAddition.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      context
    );
  }

  // ─── Identity (go-to-k/cdkd#4606) ────────────────────────────────

  isSameResource(
    journaledPhysicalId: string,
    record: { physicalId: string },
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<ResourceIdentityVerdict> {
    return isSameResource.call(this, journaledPhysicalId, record, resourceType, context);
  }

  resourceIdentity(
    physicalId: string,
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<string | ResourceNotFound | undefined> {
    return resourceIdentity.call(this, physicalId, resourceType, context);
  }

  readIdIfExists(resourceType: UserOrGroupType, name: string): Promise<string | undefined> {
    return readIdIfExists.call(this, resourceType, name);
  }

  // ─── readCurrentState dispatch ───────────────────────────────────

  readCurrentState(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: import('../../types/resource.js').ReadCurrentStateContext
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, logicalId, resourceType, properties, context);
  }

  readUserCurrentState(
    physicalId: string,
    properties?: Record<string, unknown>,
    context?: import('../../types/resource.js').ReadCurrentStateContext
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readUserCurrentState.call(this, physicalId, properties, context);
  }

  readGroupCurrentState(
    physicalId: string,
    properties?: Record<string, unknown>,
    context?: import('../../types/resource.js').ReadCurrentStateContext
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readGroupCurrentState.call(this, physicalId, properties, context);
  }

  collectInlinePolicies(
    kind: 'user' | 'group',
    physicalId: string,
    statePolicies: Array<{ PolicyName?: string }>,
    context: import('../../types/resource.js').ReadCurrentStateContext | undefined
  ): Promise<Array<{ PolicyName: string; PolicyDocument: unknown }>> {
    return collectInlinePolicies.call(this, kind, physicalId, statePolicies, context);
  }

  // ─── Import dispatch ──────────────────────────────────────────────

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }

  importUser(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importUser.call(this, input);
  }

  importGroup(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importGroup.call(this, input);
  }

  importUserToGroupAddition(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importUserToGroupAddition.call(this, input);
  }
}
