import {
  IAMClient,
  CreateUserCommand,
  DeleteUserCommand,
  GetUserCommand,
  CreateGroupCommand,
  DeleteGroupCommand,
  GetGroupCommand,
  AttachGroupPolicyCommand,
  DetachGroupPolicyCommand,
  ListAttachedGroupPoliciesCommand,
  AttachUserPolicyCommand,
  DetachUserPolicyCommand,
  ListAttachedUserPoliciesCommand,
  PutUserPolicyCommand,
  DeleteUserPolicyCommand,
  ListUserPoliciesCommand,
  PutGroupPolicyCommand,
  DeleteGroupPolicyCommand,
  ListGroupPoliciesCommand,
  CreateLoginProfileCommand,
  UpdateLoginProfileCommand,
  AddUserToGroupCommand,
  RemoveUserFromGroupCommand,
  ListGroupsForUserCommand,
  DeleteLoginProfileCommand,
  ListAccessKeysCommand,
  DeleteAccessKeyCommand,
  NoSuchEntityException,
  TagUserCommand,
  PutUserPermissionsBoundaryCommand,
  DeleteUserPermissionsBoundaryCommand,
} from '@aws-sdk/client-iam';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { generateResourceName } from '../resource-name.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

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
  private iamClient: IAMClient;
  private logger = getLogger().child('IAMUserGroupProvider');

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

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::IAM::User':
        return this.createUser(logicalId, resourceType, properties);
      case 'AWS::IAM::Group':
        return this.createGroup(logicalId, resourceType, properties);
      case 'AWS::IAM::UserToGroupAddition':
        return this.createUserToGroupAddition(logicalId, resourceType, properties);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId
        );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    switch (resourceType) {
      case 'AWS::IAM::User':
        return this.updateUser(logicalId, physicalId, resourceType, properties, previousProperties);
      case 'AWS::IAM::Group':
        return this.updateGroup(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::IAM::UserToGroupAddition':
        return this.updateUserToGroupAddition(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::IAM::User':
        return this.deleteUser(logicalId, physicalId, resourceType);
      case 'AWS::IAM::Group':
        return this.deleteGroup(logicalId, physicalId, resourceType);
      case 'AWS::IAM::UserToGroupAddition':
        return this.deleteUserToGroupAddition(logicalId, physicalId, resourceType, properties);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  // ─── AWS::IAM::User ──────────────────────────────────────────────

  private async createUser(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating IAM user ${logicalId}`);

    const userName = generateResourceName(
      (properties['UserName'] as string | undefined) || logicalId,
      { maxLength: 64 }
    );

    try {
      const createParams: {
        UserName: string;
        Path?: string;
        Tags?: Array<{ Key: string; Value: string }>;
      } = {
        UserName: userName,
      };

      if (properties['Path']) {
        createParams.Path = properties['Path'] as string;
      }

      const tags = properties['Tags'] as Array<{ Key: string; Value: string }> | undefined;
      if (tags && Array.isArray(tags)) {
        createParams.Tags = tags;
      }

      const response = await this.iamClient.send(new CreateUserCommand(createParams));

      // Set permissions boundary if specified
      const permissionsBoundary = properties['PermissionsBoundary'] as string | undefined;
      if (permissionsBoundary) {
        await this.iamClient.send(
          new PutUserPermissionsBoundaryCommand({
            UserName: userName,
            PermissionsBoundary: permissionsBoundary,
          })
        );
        this.logger.debug(`Set permissions boundary on user ${userName}`);
      }

      // Create login profile if specified
      const loginProfile = properties['LoginProfile'] as
        | { Password: string; PasswordResetRequired?: boolean }
        | undefined;
      if (loginProfile) {
        await this.iamClient.send(
          new CreateLoginProfileCommand({
            UserName: userName,
            Password: loginProfile.Password,
            PasswordResetRequired: loginProfile.PasswordResetRequired ?? false,
          })
        );
        this.logger.debug(`Created login profile for user ${userName}`);
      }

      // Attach managed policies if specified
      const managedPolicyArns = properties['ManagedPolicyArns'] as string[] | undefined;
      if (managedPolicyArns && Array.isArray(managedPolicyArns)) {
        for (const policyArn of managedPolicyArns) {
          await this.iamClient.send(
            new AttachUserPolicyCommand({
              UserName: userName,
              PolicyArn: policyArn,
            })
          );
          this.logger.debug(`Attached managed policy ${policyArn} to user ${userName}`);
        }
      }

      // Add user to groups if specified
      const userGroups = properties['Groups'] as string[] | undefined;
      if (userGroups && Array.isArray(userGroups)) {
        for (const groupName of userGroups) {
          await this.iamClient.send(
            new AddUserToGroupCommand({
              UserName: userName,
              GroupName: groupName,
            })
          );
          this.logger.debug(`Added user ${userName} to group ${groupName}`);
        }
      }

      // Add inline policies if specified
      const policies = properties['Policies'] as
        | Array<{ PolicyName: string; PolicyDocument: unknown }>
        | undefined;
      if (policies && Array.isArray(policies)) {
        for (const policy of policies) {
          const policyDoc =
            typeof policy.PolicyDocument === 'string'
              ? policy.PolicyDocument
              : JSON.stringify(policy.PolicyDocument);
          await this.iamClient.send(
            new PutUserPolicyCommand({
              UserName: userName,
              PolicyName: policy.PolicyName,
              PolicyDocument: policyDoc,
            })
          );
          this.logger.debug(`Added inline policy ${policy.PolicyName} to user ${userName}`);
        }
      }

      this.logger.debug(`Successfully created IAM user ${logicalId}: ${userName}`);

      return {
        physicalId: userName,
        attributes: {
          Arn: response.User?.Arn,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create IAM user ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        userName,
        cause
      );
    }
  }

  private async updateUser(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating IAM user ${logicalId}: ${physicalId}`);

    try {
      // Update tags if specified
      const tags = properties['Tags'] as Array<{ Key: string; Value: string }> | undefined;
      if (tags && Array.isArray(tags)) {
        await this.iamClient.send(
          new TagUserCommand({
            UserName: physicalId,
            Tags: tags,
          })
        );
        this.logger.debug(`Tagged user ${physicalId}`);
      }

      // Update permissions boundary
      const newPermBoundary = properties['PermissionsBoundary'] as string | undefined;
      const oldPermBoundary = previousProperties['PermissionsBoundary'] as string | undefined;
      if (newPermBoundary !== oldPermBoundary) {
        if (newPermBoundary) {
          await this.iamClient.send(
            new PutUserPermissionsBoundaryCommand({
              UserName: physicalId,
              PermissionsBoundary: newPermBoundary,
            })
          );
          this.logger.debug(`Updated permissions boundary on user ${physicalId}`);
        } else if (oldPermBoundary) {
          await this.iamClient.send(
            new DeleteUserPermissionsBoundaryCommand({ UserName: physicalId })
          );
          this.logger.debug(`Removed permissions boundary from user ${physicalId}`);
        }
      }

      // Update login profile
      const newLoginProfile = properties['LoginProfile'] as
        | { Password: string; PasswordResetRequired?: boolean }
        | undefined;
      const oldLoginProfile = previousProperties['LoginProfile'] as
        | { Password: string; PasswordResetRequired?: boolean }
        | undefined;
      if (newLoginProfile && !oldLoginProfile) {
        await this.iamClient.send(
          new CreateLoginProfileCommand({
            UserName: physicalId,
            Password: newLoginProfile.Password,
            PasswordResetRequired: newLoginProfile.PasswordResetRequired ?? false,
          })
        );
        this.logger.debug(`Created login profile for user ${physicalId}`);
      } else if (newLoginProfile && oldLoginProfile) {
        await this.iamClient.send(
          new UpdateLoginProfileCommand({
            UserName: physicalId,
            Password: newLoginProfile.Password,
            PasswordResetRequired: newLoginProfile.PasswordResetRequired ?? false,
          })
        );
        this.logger.debug(`Updated login profile for user ${physicalId}`);
      } else if (!newLoginProfile && oldLoginProfile) {
        try {
          await this.iamClient.send(new DeleteLoginProfileCommand({ UserName: physicalId }));
          this.logger.debug(`Deleted login profile for user ${physicalId}`);
        } catch (error) {
          if (!(error instanceof NoSuchEntityException)) {
            throw error;
          }
        }
      }

      // Update managed policies
      await this.updateUserManagedPolicies(
        physicalId,
        properties['ManagedPolicyArns'] as string[] | undefined,
        previousProperties['ManagedPolicyArns'] as string[] | undefined
      );

      // Update groups
      await this.updateUserGroups(
        physicalId,
        properties['Groups'] as string[] | undefined,
        previousProperties['Groups'] as string[] | undefined
      );

      // Update inline policies
      await this.updateUserInlinePolicies(
        physicalId,
        properties['Policies'] as
          | Array<{ PolicyName: string; PolicyDocument: unknown }>
          | undefined,
        previousProperties['Policies'] as
          | Array<{ PolicyName: string; PolicyDocument: unknown }>
          | undefined
      );

      // Get updated user info
      const getUserResponse = await this.iamClient.send(
        new GetUserCommand({ UserName: physicalId })
      );

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: getUserResponse.User?.Arn,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update IAM user ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteUser(
    logicalId: string,
    physicalId: string,
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Deleting IAM user ${logicalId}: ${physicalId}`);

    try {
      // Check if user exists
      try {
        await this.iamClient.send(new GetUserCommand({ UserName: physicalId }));
      } catch (error) {
        if (error instanceof NoSuchEntityException) {
          this.logger.debug(`User ${physicalId} does not exist, skipping deletion`);
          return;
        }
        throw error;
      }

      // Step 1: Remove from all groups
      await this.removeUserFromAllGroups(physicalId);

      // Step 2: Detach all managed policies
      await this.detachAllUserPolicies(physicalId);

      // Step 3: Delete all inline policies
      await this.deleteAllUserInlinePolicies(physicalId);

      // Step 4: Delete login profile if exists
      try {
        await this.iamClient.send(new DeleteLoginProfileCommand({ UserName: physicalId }));
        this.logger.debug(`Deleted login profile for user ${physicalId}`);
      } catch (error) {
        if (!(error instanceof NoSuchEntityException)) {
          throw error;
        }
      }

      // Step 5: Delete all access keys
      await this.deleteAllAccessKeys(physicalId);

      // Step 6: Delete permissions boundary if exists
      try {
        await this.iamClient.send(
          new DeleteUserPermissionsBoundaryCommand({ UserName: physicalId })
        );
      } catch (error) {
        if (!(error instanceof NoSuchEntityException)) {
          throw error;
        }
      }

      // Step 7: Delete the user
      await this.iamClient.send(new DeleteUserCommand({ UserName: physicalId }));

      this.logger.debug(`Successfully deleted IAM user ${logicalId}`);
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete IAM user ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async removeUserFromAllGroups(userName: string): Promise<void> {
    try {
      const response = await this.iamClient.send(
        new ListGroupsForUserCommand({ UserName: userName })
      );

      const groups = response.Groups || [];
      for (const group of groups) {
        if (group.GroupName) {
          try {
            await this.iamClient.send(
              new RemoveUserFromGroupCommand({
                UserName: userName,
                GroupName: group.GroupName,
              })
            );
            this.logger.debug(`Removed user ${userName} from group ${group.GroupName}`);
          } catch (error) {
            if (!(error instanceof NoSuchEntityException)) {
              throw error;
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof NoSuchEntityException) {
        return;
      }
      throw error;
    }
  }

  private async deleteAllAccessKeys(userName: string): Promise<void> {
    try {
      const response = await this.iamClient.send(new ListAccessKeysCommand({ UserName: userName }));

      const keys = response.AccessKeyMetadata || [];
      for (const key of keys) {
        if (key.AccessKeyId) {
          await this.iamClient.send(
            new DeleteAccessKeyCommand({
              UserName: userName,
              AccessKeyId: key.AccessKeyId,
            })
          );
          this.logger.debug(`Deleted access key ${key.AccessKeyId} for user ${userName}`);
        }
      }
    } catch (error) {
      if (error instanceof NoSuchEntityException) {
        return;
      }
      throw error;
    }
  }

  private async detachAllUserPolicies(userName: string): Promise<void> {
    try {
      const response = await this.iamClient.send(
        new ListAttachedUserPoliciesCommand({ UserName: userName })
      );

      const policies = response.AttachedPolicies || [];
      for (const policy of policies) {
        if (policy.PolicyArn) {
          try {
            await this.iamClient.send(
              new DetachUserPolicyCommand({
                UserName: userName,
                PolicyArn: policy.PolicyArn,
              })
            );
            this.logger.debug(`Detached managed policy ${policy.PolicyArn} from user ${userName}`);
          } catch (error) {
            if (!(error instanceof NoSuchEntityException)) {
              throw error;
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof NoSuchEntityException) {
        return;
      }
      throw error;
    }
  }

  private async deleteAllUserInlinePolicies(userName: string): Promise<void> {
    try {
      const response = await this.iamClient.send(
        new ListUserPoliciesCommand({ UserName: userName })
      );

      const policyNames = response.PolicyNames || [];
      for (const policyName of policyNames) {
        try {
          await this.iamClient.send(
            new DeleteUserPolicyCommand({
              UserName: userName,
              PolicyName: policyName,
            })
          );
          this.logger.debug(`Deleted inline policy ${policyName} from user ${userName}`);
        } catch (error) {
          if (!(error instanceof NoSuchEntityException)) {
            throw error;
          }
        }
      }
    } catch (error) {
      if (error instanceof NoSuchEntityException) {
        return;
      }
      throw error;
    }
  }

  private async updateUserManagedPolicies(
    userName: string,
    newPolicies: string[] | undefined,
    oldPolicies: string[] | undefined
  ): Promise<void> {
    const newSet = new Set(newPolicies || []);
    const oldSet = new Set(oldPolicies || []);

    // Attach new policies
    for (const policyArn of newSet) {
      if (!oldSet.has(policyArn)) {
        await this.iamClient.send(
          new AttachUserPolicyCommand({
            UserName: userName,
            PolicyArn: policyArn,
          })
        );
        this.logger.debug(`Attached managed policy ${policyArn} to user ${userName}`);
      }
    }

    // Detach removed policies
    for (const policyArn of oldSet) {
      if (!newSet.has(policyArn)) {
        try {
          await this.iamClient.send(
            new DetachUserPolicyCommand({
              UserName: userName,
              PolicyArn: policyArn,
            })
          );
          this.logger.debug(`Detached managed policy ${policyArn} from user ${userName}`);
        } catch (error) {
          if (!(error instanceof NoSuchEntityException)) {
            throw error;
          }
        }
      }
    }
  }

  private async updateUserGroups(
    userName: string,
    newGroups: string[] | undefined,
    oldGroups: string[] | undefined
  ): Promise<void> {
    const newSet = new Set(newGroups || []);
    const oldSet = new Set(oldGroups || []);

    // Add to new groups
    for (const groupName of newSet) {
      if (!oldSet.has(groupName)) {
        await this.iamClient.send(
          new AddUserToGroupCommand({
            UserName: userName,
            GroupName: groupName,
          })
        );
        this.logger.debug(`Added user ${userName} to group ${groupName}`);
      }
    }

    // Remove from old groups
    for (const groupName of oldSet) {
      if (!newSet.has(groupName)) {
        try {
          await this.iamClient.send(
            new RemoveUserFromGroupCommand({
              UserName: userName,
              GroupName: groupName,
            })
          );
          this.logger.debug(`Removed user ${userName} from group ${groupName}`);
        } catch (error) {
          if (!(error instanceof NoSuchEntityException)) {
            throw error;
          }
        }
      }
    }
  }

  private async updateUserInlinePolicies(
    userName: string,
    newPolicies: Array<{ PolicyName: string; PolicyDocument: unknown }> | undefined,
    oldPolicies: Array<{ PolicyName: string; PolicyDocument: unknown }> | undefined
  ): Promise<void> {
    const newMap = new Map((newPolicies || []).map((p) => [p.PolicyName, p.PolicyDocument]));
    const oldMap = new Map((oldPolicies || []).map((p) => [p.PolicyName, p.PolicyDocument]));

    // Add or update policies
    for (const [policyName, policyDoc] of newMap) {
      const policyDocument = typeof policyDoc === 'string' ? policyDoc : JSON.stringify(policyDoc);
      await this.iamClient.send(
        new PutUserPolicyCommand({
          UserName: userName,
          PolicyName: policyName,
          PolicyDocument: policyDocument,
        })
      );
      this.logger.debug(`Updated inline policy ${policyName} on user ${userName}`);
    }

    // Delete removed policies
    for (const policyName of oldMap.keys()) {
      if (!newMap.has(policyName)) {
        try {
          await this.iamClient.send(
            new DeleteUserPolicyCommand({
              UserName: userName,
              PolicyName: policyName,
            })
          );
          this.logger.debug(`Deleted inline policy ${policyName} from user ${userName}`);
        } catch (error) {
          if (!(error instanceof NoSuchEntityException)) {
            throw error;
          }
        }
      }
    }
  }

  // ─── AWS::IAM::Group ─────────────────────────────────────────────

  private async createGroup(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating IAM group ${logicalId}`);

    const groupName = generateResourceName(
      (properties['GroupName'] as string | undefined) || logicalId,
      { maxLength: 128 }
    );

    try {
      const createParams: {
        GroupName: string;
        Path?: string;
      } = {
        GroupName: groupName,
      };

      if (properties['Path']) {
        createParams.Path = properties['Path'] as string;
      }

      const response = await this.iamClient.send(new CreateGroupCommand(createParams));

      // Attach managed policies if specified
      const managedPolicyArns = properties['ManagedPolicyArns'] as string[] | undefined;
      if (managedPolicyArns && Array.isArray(managedPolicyArns)) {
        for (const policyArn of managedPolicyArns) {
          await this.iamClient.send(
            new AttachGroupPolicyCommand({
              GroupName: groupName,
              PolicyArn: policyArn,
            })
          );
          this.logger.debug(`Attached managed policy ${policyArn} to group ${groupName}`);
        }
      }

      // Add inline policies if specified
      const policies = properties['Policies'] as
        | Array<{ PolicyName: string; PolicyDocument: unknown }>
        | undefined;
      if (policies && Array.isArray(policies)) {
        for (const policy of policies) {
          const policyDoc =
            typeof policy.PolicyDocument === 'string'
              ? policy.PolicyDocument
              : JSON.stringify(policy.PolicyDocument);
          await this.iamClient.send(
            new PutGroupPolicyCommand({
              GroupName: groupName,
              PolicyName: policy.PolicyName,
              PolicyDocument: policyDoc,
            })
          );
          this.logger.debug(`Added inline policy ${policy.PolicyName} to group ${groupName}`);
        }
      }

      this.logger.debug(`Successfully created IAM group ${logicalId}: ${groupName}`);

      return {
        physicalId: groupName,
        attributes: {
          Arn: response.Group?.Arn,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create IAM group ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        groupName,
        cause
      );
    }
  }

  private async updateGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating IAM group ${logicalId}: ${physicalId}`);

    try {
      // Update managed policies
      await this.updateGroupManagedPolicies(
        physicalId,
        properties['ManagedPolicyArns'] as string[] | undefined,
        previousProperties['ManagedPolicyArns'] as string[] | undefined
      );

      // Update inline policies
      await this.updateGroupInlinePolicies(
        physicalId,
        properties['Policies'] as
          | Array<{ PolicyName: string; PolicyDocument: unknown }>
          | undefined,
        previousProperties['Policies'] as
          | Array<{ PolicyName: string; PolicyDocument: unknown }>
          | undefined
      );

      // Get updated group info
      const getGroupResponse = await this.iamClient.send(
        new GetGroupCommand({ GroupName: physicalId })
      );

      this.logger.debug(`Successfully updated IAM group ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: getGroupResponse.Group?.Arn,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update IAM group ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Deleting IAM group ${logicalId}: ${physicalId}`);

    try {
      // Step 1: Detach all managed policies
      await this.detachAllGroupPolicies(physicalId);

      // Step 2: Delete all inline policies
      await this.deleteAllGroupInlinePolicies(physicalId);

      // Step 3: Remove all users from group
      await this.removeAllUsersFromGroup(physicalId);

      // Step 4: Delete the group
      await this.iamClient.send(new DeleteGroupCommand({ GroupName: physicalId }));

      this.logger.debug(`Successfully deleted IAM group ${logicalId}`);
    } catch (error) {
      if (error instanceof NoSuchEntityException) {
        this.logger.debug(`Group ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete IAM group ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async detachAllGroupPolicies(groupName: string): Promise<void> {
    try {
      const response = await this.iamClient.send(
        new ListAttachedGroupPoliciesCommand({ GroupName: groupName })
      );

      const policies = response.AttachedPolicies || [];
      for (const policy of policies) {
        if (policy.PolicyArn) {
          try {
            await this.iamClient.send(
              new DetachGroupPolicyCommand({
                GroupName: groupName,
                PolicyArn: policy.PolicyArn,
              })
            );
            this.logger.debug(
              `Detached managed policy ${policy.PolicyArn} from group ${groupName}`
            );
          } catch (error) {
            if (!(error instanceof NoSuchEntityException)) {
              throw error;
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof NoSuchEntityException) {
        return;
      }
      throw error;
    }
  }

  private async removeAllUsersFromGroup(groupName: string): Promise<void> {
    try {
      const response = await this.iamClient.send(new GetGroupCommand({ GroupName: groupName }));

      const users = response.Users || [];
      for (const user of users) {
        if (user.UserName) {
          try {
            await this.iamClient.send(
              new RemoveUserFromGroupCommand({
                GroupName: groupName,
                UserName: user.UserName,
              })
            );
            this.logger.debug(`Removed user ${user.UserName} from group ${groupName}`);
          } catch (error) {
            if (!(error instanceof NoSuchEntityException)) {
              throw error;
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof NoSuchEntityException) {
        return;
      }
      throw error;
    }
  }

  private async updateGroupManagedPolicies(
    groupName: string,
    newPolicies: string[] | undefined,
    oldPolicies: string[] | undefined
  ): Promise<void> {
    const newSet = new Set(newPolicies || []);
    const oldSet = new Set(oldPolicies || []);

    // Attach new policies
    for (const policyArn of newSet) {
      if (!oldSet.has(policyArn)) {
        await this.iamClient.send(
          new AttachGroupPolicyCommand({
            GroupName: groupName,
            PolicyArn: policyArn,
          })
        );
        this.logger.debug(`Attached managed policy ${policyArn} to group ${groupName}`);
      }
    }

    // Detach removed policies
    for (const policyArn of oldSet) {
      if (!newSet.has(policyArn)) {
        await this.iamClient.send(
          new DetachGroupPolicyCommand({
            GroupName: groupName,
            PolicyArn: policyArn,
          })
        );
        this.logger.debug(`Detached managed policy ${policyArn} from group ${groupName}`);
      }
    }
  }

  private async deleteAllGroupInlinePolicies(groupName: string): Promise<void> {
    try {
      const response = await this.iamClient.send(
        new ListGroupPoliciesCommand({ GroupName: groupName })
      );

      const policyNames = response.PolicyNames || [];
      for (const policyName of policyNames) {
        try {
          await this.iamClient.send(
            new DeleteGroupPolicyCommand({
              GroupName: groupName,
              PolicyName: policyName,
            })
          );
          this.logger.debug(`Deleted inline policy ${policyName} from group ${groupName}`);
        } catch (error) {
          if (!(error instanceof NoSuchEntityException)) {
            throw error;
          }
        }
      }
    } catch (error) {
      if (error instanceof NoSuchEntityException) {
        return;
      }
      throw error;
    }
  }

  private async updateGroupInlinePolicies(
    groupName: string,
    newPolicies: Array<{ PolicyName: string; PolicyDocument: unknown }> | undefined,
    oldPolicies: Array<{ PolicyName: string; PolicyDocument: unknown }> | undefined
  ): Promise<void> {
    const newMap = new Map((newPolicies || []).map((p) => [p.PolicyName, p.PolicyDocument]));
    const oldMap = new Map((oldPolicies || []).map((p) => [p.PolicyName, p.PolicyDocument]));

    // Add or update policies
    for (const [policyName, policyDoc] of newMap) {
      const policyDocument = typeof policyDoc === 'string' ? policyDoc : JSON.stringify(policyDoc);
      await this.iamClient.send(
        new PutGroupPolicyCommand({
          GroupName: groupName,
          PolicyName: policyName,
          PolicyDocument: policyDocument,
        })
      );
      this.logger.debug(`Updated inline policy ${policyName} on group ${groupName}`);
    }

    // Delete removed policies
    for (const policyName of oldMap.keys()) {
      if (!newMap.has(policyName)) {
        try {
          await this.iamClient.send(
            new DeleteGroupPolicyCommand({
              GroupName: groupName,
              PolicyName: policyName,
            })
          );
          this.logger.debug(`Deleted inline policy ${policyName} from group ${groupName}`);
        } catch (error) {
          if (!(error instanceof NoSuchEntityException)) {
            throw error;
          }
        }
      }
    }
  }

  // ─── AWS::IAM::UserToGroupAddition ────────────────────────────────

  private async createUserToGroupAddition(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating IAM UserToGroupAddition ${logicalId}`);

    const groupName = properties['GroupName'] as string;
    const users = properties['Users'] as string[];

    if (!groupName) {
      throw new ProvisioningError(
        `GroupName is required for ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    if (!users || !Array.isArray(users) || users.length === 0) {
      throw new ProvisioningError(`Users is required for ${logicalId}`, resourceType, logicalId);
    }

    try {
      for (const userName of users) {
        await this.iamClient.send(
          new AddUserToGroupCommand({
            GroupName: groupName,
            UserName: userName,
          })
        );
        this.logger.debug(`Added user ${userName} to group ${groupName}`);
      }

      this.logger.debug(`Successfully created IAM UserToGroupAddition ${logicalId}`);

      // Physical ID is the logical ID (no AWS-generated ID for this resource)
      return {
        physicalId: logicalId,
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create IAM UserToGroupAddition ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async updateUserToGroupAddition(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating IAM UserToGroupAddition ${logicalId}`);

    const groupName = properties['GroupName'] as string;
    const newUsers = new Set((properties['Users'] as string[]) || []);
    const oldGroupName = previousProperties['GroupName'] as string;
    const oldUsers = new Set((previousProperties['Users'] as string[]) || []);

    try {
      // If group changed, remove from old group and add to new group
      if (oldGroupName && oldGroupName !== groupName) {
        for (const userName of oldUsers) {
          try {
            await this.iamClient.send(
              new RemoveUserFromGroupCommand({
                GroupName: oldGroupName,
                UserName: userName,
              })
            );
          } catch (error) {
            if (!(error instanceof NoSuchEntityException)) {
              throw error;
            }
          }
        }
        for (const userName of newUsers) {
          await this.iamClient.send(
            new AddUserToGroupCommand({
              GroupName: groupName,
              UserName: userName,
            })
          );
        }
      } else {
        // Same group: add new users, remove old users
        for (const userName of newUsers) {
          if (!oldUsers.has(userName)) {
            await this.iamClient.send(
              new AddUserToGroupCommand({
                GroupName: groupName,
                UserName: userName,
              })
            );
            this.logger.debug(`Added user ${userName} to group ${groupName}`);
          }
        }
        for (const userName of oldUsers) {
          if (!newUsers.has(userName)) {
            try {
              await this.iamClient.send(
                new RemoveUserFromGroupCommand({
                  GroupName: groupName,
                  UserName: userName,
                })
              );
              this.logger.debug(`Removed user ${userName} from group ${groupName}`);
            } catch (error) {
              if (!(error instanceof NoSuchEntityException)) {
                throw error;
              }
            }
          }
        }
      }

      return {
        physicalId,
        wasReplaced: false,
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update IAM UserToGroupAddition ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteUserToGroupAddition(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.debug(`Deleting IAM UserToGroupAddition ${logicalId}`);

    if (!properties) {
      this.logger.debug(`No properties for UserToGroupAddition ${logicalId}, skipping deletion`);
      return;
    }

    const groupName = properties['GroupName'] as string;
    const users = properties['Users'] as string[];

    if (!groupName || !users) {
      this.logger.debug(`Missing GroupName or Users for ${logicalId}, skipping deletion`);
      return;
    }

    try {
      for (const userName of users) {
        try {
          await this.iamClient.send(
            new RemoveUserFromGroupCommand({
              GroupName: groupName,
              UserName: userName,
            })
          );
          this.logger.debug(`Removed user ${userName} from group ${groupName}`);
        } catch (error) {
          if (!(error instanceof NoSuchEntityException)) {
            throw error;
          }
        }
      }

      this.logger.debug(`Successfully deleted IAM UserToGroupAddition ${logicalId}`);
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete IAM UserToGroupAddition ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }
}
