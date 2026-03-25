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
  TagRoleCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
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
   * Shorten role name if it exceeds IAM's 64-character limit
   *
   * Strategy: Keep prefix + hash suffix to maintain uniqueness
   */
  private shortenRoleName(roleName: string): string {
    const MAX_LENGTH = 64;

    if (roleName.length <= MAX_LENGTH) {
      return roleName;
    }

    // Create a short hash from the full name
    const hash = Buffer.from(roleName)
      .toString('base64')
      .replace(/[^a-zA-Z0-9]/g, '')
      .substring(0, 8);

    // Keep prefix + hash to maintain readability and uniqueness
    const maxPrefixLength = MAX_LENGTH - hash.length - 1; // -1 for separator
    const prefix = roleName.substring(0, maxPrefixLength);

    const shortened = `${prefix}-${hash}`;
    this.logger.warn(`Role name "${roleName}" exceeds 64 chars, shortened to "${shortened}"`);

    return shortened;
  }

  /**
   * Create an IAM role
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.info(`Creating IAM role ${logicalId}`);

    const rawRoleName = (properties['RoleName'] as string | undefined) || logicalId;
    const roleName = this.shortenRoleName(rawRoleName);
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

      this.logger.info(`Successfully created IAM role ${logicalId}: ${roleName}`);

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
    this.logger.info(`Updating IAM role ${logicalId}: ${physicalId}`);

    const newRoleName = (properties['RoleName'] as string | undefined) || logicalId;

    // Check if role name changed (requires replacement)
    if (newRoleName !== physicalId) {
      this.logger.info(`Role name changed, replacing role: ${physicalId} -> ${newRoleName}`);

      // Create new role
      const createResult = await this.create(logicalId, resourceType, properties);

      // TODO: Improve old role deletion handling
      // Currently we silently ignore deletion failures, which can lead to resource leaks.
      // Should either:
      // 1. Fail the update operation if old role can't be deleted
      // 2. Track orphaned resources in state for later cleanup
      // 3. Implement a cleanup mechanism for failed deletions

      // Delete old role (best effort)
      try {
        await this.delete(logicalId, physicalId, resourceType);
      } catch (error) {
        this.logger.warn(`Failed to delete old role ${physicalId}: ${String(error)}`);
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

      this.logger.info(`Successfully updated IAM role ${logicalId}`);

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
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.info(`Deleting IAM role ${logicalId}: ${physicalId}`);

    try {
      // Check if role exists
      try {
        await this.iamClient.send(new GetRoleCommand({ RoleName: physicalId }));
      } catch (error) {
        if (error instanceof NoSuchEntityException) {
          this.logger.info(`Role ${physicalId} does not exist, skipping deletion`);
          return;
        }
        throw error;
      }

      // Detach all managed policies
      const attachedPolicies = await this.iamClient.send(
        new ListAttachedRolePoliciesCommand({ RoleName: physicalId })
      );
      for (const policy of attachedPolicies.AttachedPolicies || []) {
        if (policy.PolicyArn) {
          await this.iamClient.send(
            new DetachRolePolicyCommand({
              RoleName: physicalId,
              PolicyArn: policy.PolicyArn,
            })
          );
          this.logger.debug(`Detached managed policy ${policy.PolicyArn}`);
        }
      }

      // Delete all inline policies
      const inlinePolicies = await this.iamClient.send(
        new ListRolePoliciesCommand({ RoleName: physicalId })
      );
      for (const policyName of inlinePolicies.PolicyNames || []) {
        await this.iamClient.send(
          new DeleteRolePolicyCommand({
            RoleName: physicalId,
            PolicyName: policyName,
          })
        );
        this.logger.debug(`Deleted inline policy ${policyName}`);
      }

      // Delete role
      await this.iamClient.send(new DeleteRoleCommand({ RoleName: physicalId }));

      this.logger.info(`Successfully deleted IAM role ${logicalId}`);
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
