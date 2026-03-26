import {
  IAMClient,
  CreateRoleCommand,
  UpdateRoleCommand,
  DeleteRoleCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
  ListRolePoliciesCommand,
  AttachRolePolicyCommand,
  DetachRolePolicyCommand,
  ListAttachedRolePoliciesCommand,
  ListInstanceProfilesForRoleCommand,
  RemoveRoleFromInstanceProfileCommand,
  TagRoleCommand,
  NoSuchEntityException,
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
 * AWS IAM Role Provider
 *
 * Implements resource provisioning for AWS::IAM::Role using the IAM SDK.
 * This is required because IAM Role is not supported by Cloud Control API.
 */
export class IAMRoleProvider implements ResourceProvider {
  private iamClient: IAMClient;
  private logger = getLogger().child('IAMRoleProvider');

  constructor() {
    // Use global AWS clients manager for better resource management
    const awsClients = getAwsClients();
    this.iamClient = awsClients.iam;
  }

  /**
   * Create an IAM role
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating IAM role ${logicalId}`);

    const roleName = generateResourceName(
      (properties['RoleName'] as string | undefined) || logicalId,
      { maxLength: 64 }
    );
    const assumeRolePolicyDocument = properties['AssumeRolePolicyDocument'];

    if (!assumeRolePolicyDocument) {
      throw new ProvisioningError(
        `AssumeRolePolicyDocument is required for IAM role ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      // Serialize policy document
      const policyDocument =
        typeof assumeRolePolicyDocument === 'string'
          ? assumeRolePolicyDocument
          : JSON.stringify(assumeRolePolicyDocument);

      // Create role
      const createParams: {
        RoleName: string;
        AssumeRolePolicyDocument: string;
        Description?: string;
        MaxSessionDuration?: number;
        Path?: string;
        PermissionsBoundary?: string;
      } = {
        RoleName: roleName,
        AssumeRolePolicyDocument: policyDocument,
      };

      if (properties['Description']) {
        createParams.Description = properties['Description'] as string;
      }
      if (properties['MaxSessionDuration']) {
        createParams.MaxSessionDuration = properties['MaxSessionDuration'] as number;
      }
      if (properties['Path']) {
        createParams.Path = properties['Path'] as string;
      }
      if (properties['PermissionsBoundary']) {
        createParams.PermissionsBoundary = properties['PermissionsBoundary'] as string;
      }

      const response = await this.iamClient.send(new CreateRoleCommand(createParams));

      this.logger.debug(`Created IAM role: ${roleName}`);

      // Attach managed policies if specified
      const managedPolicyArns = properties['ManagedPolicyArns'] as string[] | undefined;
      if (managedPolicyArns && Array.isArray(managedPolicyArns)) {
        for (const policyArn of managedPolicyArns) {
          await this.iamClient.send(
            new AttachRolePolicyCommand({
              RoleName: roleName,
              PolicyArn: policyArn,
            })
          );
          this.logger.debug(`Attached managed policy ${policyArn} to role ${roleName}`);
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
            new PutRolePolicyCommand({
              RoleName: roleName,
              PolicyName: policy.PolicyName,
              PolicyDocument: policyDoc,
            })
          );
          this.logger.debug(`Added inline policy ${policy.PolicyName} to role ${roleName}`);
        }
      }

      // Add tags if specified
      const tags = properties['Tags'] as Array<{ Key: string; Value: string }> | undefined;
      if (tags && Array.isArray(tags)) {
        await this.iamClient.send(
          new TagRoleCommand({
            RoleName: roleName,
            Tags: tags,
          })
        );
        this.logger.debug(`Tagged role ${roleName}`);
      }

      this.logger.debug(`Successfully created IAM role ${logicalId}: ${roleName}`);

      const attributes = {
        Arn: response.Role?.Arn,
        RoleId: response.Role?.RoleId,
      };

      return {
        physicalId: roleName,
        attributes,
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create IAM role ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        roleName,
        cause
      );
    }
  }

  /**
   * Update an IAM role
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating IAM role ${logicalId}: ${physicalId}`);

    const newRoleName = generateResourceName(
      (properties['RoleName'] as string | undefined) || logicalId,
      { maxLength: 64 }
    );

    // Check if role name changed (requires replacement)
    if (newRoleName !== physicalId) {
      this.logger.debug(`Role name changed, replacing role: ${physicalId} -> ${newRoleName}`);

      // Create new role
      const createResult = await this.create(logicalId, resourceType, properties);

      // Delete old role with full cleanup (managed policies, inline policies, instance profiles)
      try {
        await this.delete(logicalId, physicalId, resourceType);
      } catch (error) {
        this.logger.warn(
          `Failed to delete old role ${physicalId} during replacement: ${String(error)}. ` +
            `The old role may be orphaned and require manual cleanup.`
        );
      }

      const result: ResourceUpdateResult = {
        physicalId: createResult.physicalId,
        wasReplaced: true,
      };

      if (createResult.attributes) {
        result.attributes = createResult.attributes;
      }

      return result;
    }

    try {
      // Update role properties
      const updateParams: {
        RoleName: string;
        Description?: string;
        MaxSessionDuration?: number;
      } = {
        RoleName: physicalId,
      };

      if (properties['Description']) {
        updateParams.Description = properties['Description'] as string;
      }
      if (properties['MaxSessionDuration']) {
        updateParams.MaxSessionDuration = properties['MaxSessionDuration'] as number;
      }

      await this.iamClient.send(new UpdateRoleCommand(updateParams));

      // Update managed policies
      await this.updateManagedPolicies(
        physicalId,
        properties['ManagedPolicyArns'] as string[] | undefined,
        previousProperties['ManagedPolicyArns'] as string[] | undefined
      );

      // Update inline policies
      await this.updateInlinePolicies(
        physicalId,
        properties['Policies'] as
          | Array<{ PolicyName: string; PolicyDocument: unknown }>
          | undefined,
        previousProperties['Policies'] as
          | Array<{ PolicyName: string; PolicyDocument: unknown }>
          | undefined
      );

      this.logger.debug(`Successfully updated IAM role ${logicalId}`);

      // Get updated role info
      const getRoleResponse = await this.iamClient.send(
        new GetRoleCommand({ RoleName: physicalId })
      );

      const attributes = {
        Arn: getRoleResponse.Role?.Arn,
        RoleId: getRoleResponse.Role?.RoleId,
      };

      return {
        physicalId,
        wasReplaced: false,
        attributes,
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update IAM role ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete an IAM role
   *
   * Before deleting, performs full cleanup:
   * 1. Detach all managed policies
   * 2. Delete all inline policies
   * 3. Remove role from all instance profiles
   * 4. Delete the role itself
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.debug(`Deleting IAM role ${logicalId}: ${physicalId}`);

    try {
      // Check if role exists
      try {
        await this.iamClient.send(new GetRoleCommand({ RoleName: physicalId }));
      } catch (error) {
        if (error instanceof NoSuchEntityException) {
          this.logger.debug(`Role ${physicalId} does not exist, skipping deletion`);
          return;
        }
        throw error;
      }

      // Step 1: Detach all managed policies
      await this.detachAllManagedPolicies(physicalId);

      // Step 2: Delete all inline policies
      await this.deleteAllInlinePolicies(physicalId);

      // Step 3: Remove role from all instance profiles
      await this.removeFromAllInstanceProfiles(physicalId);

      // Step 4: Delete the role
      await this.iamClient.send(new DeleteRoleCommand({ RoleName: physicalId }));

      this.logger.debug(`Successfully deleted IAM role ${logicalId}`);
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete IAM role ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Detach all managed policies from the role
   */
  private async detachAllManagedPolicies(roleName: string): Promise<void> {
    this.logger.debug(`Detaching all managed policies from role ${roleName}`);

    try {
      const attachedPolicies = await this.iamClient.send(
        new ListAttachedRolePoliciesCommand({ RoleName: roleName })
      );

      const policies = attachedPolicies.AttachedPolicies || [];
      if (policies.length === 0) {
        this.logger.debug(`No managed policies attached to role ${roleName}`);
        return;
      }

      for (const policy of policies) {
        if (policy.PolicyArn) {
          try {
            await this.iamClient.send(
              new DetachRolePolicyCommand({
                RoleName: roleName,
                PolicyArn: policy.PolicyArn,
              })
            );
            this.logger.debug(`Detached managed policy ${policy.PolicyArn} from role ${roleName}`);
          } catch (error) {
            if (error instanceof NoSuchEntityException) {
              this.logger.debug(
                `Managed policy ${policy.PolicyArn} already detached from role ${roleName}`
              );
            } else {
              throw error;
            }
          }
        }
      }

      this.logger.debug(`Detached ${policies.length} managed policies from role ${roleName}`);
    } catch (error) {
      if (error instanceof NoSuchEntityException) {
        this.logger.debug(`Role ${roleName} not found when detaching managed policies`);
        return;
      }
      throw error;
    }
  }

  /**
   * Delete all inline policies from the role
   */
  private async deleteAllInlinePolicies(roleName: string): Promise<void> {
    this.logger.debug(`Deleting all inline policies from role ${roleName}`);

    try {
      const inlinePolicies = await this.iamClient.send(
        new ListRolePoliciesCommand({ RoleName: roleName })
      );

      const policyNames = inlinePolicies.PolicyNames || [];
      if (policyNames.length === 0) {
        this.logger.debug(`No inline policies on role ${roleName}`);
        return;
      }

      for (const policyName of policyNames) {
        try {
          await this.iamClient.send(
            new DeleteRolePolicyCommand({
              RoleName: roleName,
              PolicyName: policyName,
            })
          );
          this.logger.debug(`Deleted inline policy ${policyName} from role ${roleName}`);
        } catch (error) {
          if (error instanceof NoSuchEntityException) {
            this.logger.debug(`Inline policy ${policyName} already deleted from role ${roleName}`);
          } else {
            throw error;
          }
        }
      }

      this.logger.debug(`Deleted ${policyNames.length} inline policies from role ${roleName}`);
    } catch (error) {
      if (error instanceof NoSuchEntityException) {
        this.logger.debug(`Role ${roleName} not found when deleting inline policies`);
        return;
      }
      throw error;
    }
  }

  /**
   * Remove the role from all instance profiles
   */
  private async removeFromAllInstanceProfiles(roleName: string): Promise<void> {
    this.logger.debug(`Removing role ${roleName} from all instance profiles`);

    try {
      const instanceProfiles = await this.iamClient.send(
        new ListInstanceProfilesForRoleCommand({ RoleName: roleName })
      );

      const profiles = instanceProfiles.InstanceProfiles || [];
      if (profiles.length === 0) {
        this.logger.debug(`No instance profiles associated with role ${roleName}`);
        return;
      }

      for (const profile of profiles) {
        if (profile.InstanceProfileName) {
          try {
            await this.iamClient.send(
              new RemoveRoleFromInstanceProfileCommand({
                RoleName: roleName,
                InstanceProfileName: profile.InstanceProfileName,
              })
            );
            this.logger.debug(
              `Removed role ${roleName} from instance profile ${profile.InstanceProfileName}`
            );
          } catch (error) {
            if (error instanceof NoSuchEntityException) {
              this.logger.debug(
                `Role ${roleName} already removed from instance profile ${profile.InstanceProfileName}`
              );
            } else {
              throw error;
            }
          }
        }
      }

      this.logger.debug(`Removed role ${roleName} from ${profiles.length} instance profiles`);
    } catch (error) {
      if (error instanceof NoSuchEntityException) {
        this.logger.debug(`Role ${roleName} not found when removing from instance profiles`);
        return;
      }
      throw error;
    }
  }

  /**
   * Update managed policies attached to role
   */
  private async updateManagedPolicies(
    roleName: string,
    newPolicies: string[] | undefined,
    oldPolicies: string[] | undefined
  ): Promise<void> {
    const newSet = new Set(newPolicies || []);
    const oldSet = new Set(oldPolicies || []);

    // Attach new policies
    for (const policyArn of newSet) {
      if (!oldSet.has(policyArn)) {
        await this.iamClient.send(
          new AttachRolePolicyCommand({
            RoleName: roleName,
            PolicyArn: policyArn,
          })
        );
        this.logger.debug(`Attached managed policy ${policyArn}`);
      }
    }

    // Detach removed policies
    for (const policyArn of oldSet) {
      if (!newSet.has(policyArn)) {
        await this.iamClient.send(
          new DetachRolePolicyCommand({
            RoleName: roleName,
            PolicyArn: policyArn,
          })
        );
        this.logger.debug(`Detached managed policy ${policyArn}`);
      }
    }
  }

  /**
   * Update inline policies
   */
  private async updateInlinePolicies(
    roleName: string,
    newPolicies: Array<{ PolicyName: string; PolicyDocument: unknown }> | undefined,
    oldPolicies: Array<{ PolicyName: string; PolicyDocument: unknown }> | undefined
  ): Promise<void> {
    const newMap = new Map((newPolicies || []).map((p) => [p.PolicyName, p.PolicyDocument]));
    const oldMap = new Map((oldPolicies || []).map((p) => [p.PolicyName, p.PolicyDocument]));

    // Add or update policies
    for (const [policyName, policyDoc] of newMap) {
      const policyDocument = typeof policyDoc === 'string' ? policyDoc : JSON.stringify(policyDoc);

      await this.iamClient.send(
        new PutRolePolicyCommand({
          RoleName: roleName,
          PolicyName: policyName,
          PolicyDocument: policyDocument,
        })
      );
      this.logger.debug(`Updated inline policy ${policyName}`);
    }

    // Delete removed policies
    for (const policyName of oldMap.keys()) {
      if (!newMap.has(policyName)) {
        await this.iamClient.send(
          new DeleteRolePolicyCommand({
            RoleName: roleName,
            PolicyName: policyName,
          })
        );
        this.logger.debug(`Deleted inline policy ${policyName}`);
      }
    }
  }
}
