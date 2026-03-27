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
  AddUserToGroupCommand,
  RemoveUserFromGroupCommand,
  ListGroupsForUserCommand,
  DeleteLoginProfileCommand,
  ListAccessKeysCommand,
  DeleteAccessKeyCommand,
  NoSuchEntityException,
  TagUserCommand,
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
        return this.updateUser(logicalId, physicalId, resourceType, properties);
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
    properties: Record<string, unknown>
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

      // Step 2: Delete login profile if exists
      try {
        await this.iamClient.send(new DeleteLoginProfileCommand({ UserName: physicalId }));
        this.logger.debug(`Deleted login profile for user ${physicalId}`);
      } catch (error) {
        if (!(error instanceof NoSuchEntityException)) {
          throw error;
        }
      }

      // Step 3: Delete all access keys
      await this.deleteAllAccessKeys(physicalId);

      // Step 4: Delete the user
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

      // Step 2: Remove all users from group
      await this.removeAllUsersFromGroup(physicalId);

      // Step 3: Delete the group
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
