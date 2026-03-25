import {
  IAMClient,
  CreatePolicyCommand,
  DeletePolicyCommand,
  GetPolicyCommand,
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
  GetRolePolicyCommand,
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
 * AWS IAM Policy Provider
 *
 * Implements resource provisioning for AWS::IAM::Policy using the IAM SDK.
 * This is required because IAM Policy is not supported by Cloud Control API.
 *
 * Note: AWS::IAM::Policy in CloudFormation is an inline policy attached to roles/users/groups,
 * not a managed policy (AWS::IAM::ManagedPolicy).
 */
export class IAMPolicyProvider implements ResourceProvider {
  private iamClient: IAMClient;
  private logger = getLogger().child('IAMPolicyProvider');

  constructor() {
    // Use global AWS clients manager for better resource management
    const awsClients = getAwsClients();
    this.iamClient = awsClients.iam;
  }

  /**
   * Create an IAM inline policy
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.info(`Creating IAM policy ${logicalId}`);

    const policyName = (properties['PolicyName'] as string | undefined) || logicalId;
    const policyDocument = properties['PolicyDocument'];
    const roles = properties['Roles'] as string[] | undefined;

    if (!policyDocument) {
      throw new ProvisioningError(
        `PolicyDocument is required for IAM policy ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    if (!roles || roles.length === 0) {
      throw new ProvisioningError(
        `Roles is required for IAM policy ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      // Serialize policy document
      const policyDoc =
        typeof policyDocument === 'string'
          ? policyDocument
          : JSON.stringify(policyDocument);

      // Attach policy to all roles
      // Note: AWS::IAM::Policy in CloudFormation is actually an inline policy
      for (const roleName of roles) {
        await this.iamClient.send(
          new PutRolePolicyCommand({
            RoleName: roleName,
            PolicyName: policyName,
            PolicyDocument: policyDoc,
          })
        );
        this.logger.debug(`Attached inline policy ${policyName} to role ${roleName}`);
      }

      this.logger.info(`Successfully created IAM policy ${logicalId}: ${policyName}`);

      // For inline policies, physical ID is a combination of policy name and first role
      const physicalId = `${policyName}:${roles[0]}`;

      return {
        physicalId,
        attributes: {
          PolicyName: policyName,
        },
      };
    } catch (error) {
      throw new ProvisioningError(
        `Failed to create IAM policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        policyName,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Update an IAM inline policy
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.info(`Updating IAM policy ${logicalId}: ${physicalId}`);

    const newPolicyName = (properties['PolicyName'] as string | undefined) || logicalId;
    const newRoles = properties['Roles'] as string[] | undefined;
    const oldRoles = previousProperties['Roles'] as string[] | undefined;
    const policyDocument = properties['PolicyDocument'];

    if (!policyDocument) {
      throw new ProvisioningError(
        `PolicyDocument is required for IAM policy ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    if (!newRoles || newRoles.length === 0) {
      throw new ProvisioningError(
        `Roles is required for IAM policy ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      // Serialize policy document
      const policyDoc =
        typeof policyDocument === 'string'
          ? policyDocument
          : JSON.stringify(policyDocument);

      const newRoleSet = new Set(newRoles);
      const oldRoleSet = new Set(oldRoles || []);

      // Attach policy to new roles
      for (const roleName of newRoleSet) {
        await this.iamClient.send(
          new PutRolePolicyCommand({
            RoleName: roleName,
            PolicyName: newPolicyName,
            PolicyDocument: policyDoc,
          })
        );
        this.logger.debug(`Attached inline policy ${newPolicyName} to role ${roleName}`);
      }

      // Remove policy from old roles that are no longer in the list
      const [oldPolicyName] = physicalId.split(':');
      for (const roleName of oldRoleSet) {
        if (!newRoleSet.has(roleName)) {
          try {
            await this.iamClient.send(
              new DeleteRolePolicyCommand({
                RoleName: roleName,
                PolicyName: oldPolicyName,
              })
            );
            this.logger.debug(`Removed inline policy ${oldPolicyName} from role ${roleName}`);
          } catch (error) {
            if (!(error instanceof NoSuchEntityException)) {
              throw error;
            }
          }
        }
      }

      this.logger.info(`Successfully updated IAM policy ${logicalId}`);

      const newPhysicalId = `${newPolicyName}:${newRoles[0]}`;

      return {
        physicalId: newPhysicalId,
        wasReplaced: false,
        attributes: {
          PolicyName: newPolicyName,
        },
      };
    } catch (error) {
      throw new ProvisioningError(
        `Failed to update IAM policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Delete an IAM inline policy
   */
  async delete(logicalId: string, physicalId: string, resourceType: string): Promise<void> {
    this.logger.info(`Deleting IAM policy ${logicalId}: ${physicalId}`);

    // Parse physical ID to get policy name and role
    const [policyName, firstRole] = physicalId.split(':');

    if (!policyName || !firstRole) {
      this.logger.warn(`Invalid physical ID format: ${physicalId}, skipping deletion`);
      return;
    }

    try {
      // We need to get the list of roles this policy is attached to
      // Since we only store the first role in physical ID, we need to try deleting from that role
      // This is a limitation - if the policy was attached to multiple roles, we might leak

      try {
        await this.iamClient.send(
          new DeleteRolePolicyCommand({
            RoleName: firstRole,
            PolicyName: policyName,
          })
        );
        this.logger.debug(`Deleted inline policy ${policyName} from role ${firstRole}`);
      } catch (error) {
        if (error instanceof NoSuchEntityException) {
          this.logger.info(`Policy ${policyName} on role ${firstRole} does not exist, skipping`);
        } else {
          throw error;
        }
      }

      this.logger.info(`Successfully deleted IAM policy ${logicalId}`);
    } catch (error) {
      throw new ProvisioningError(
        `Failed to delete IAM policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        error instanceof Error ? error : undefined
      );
    }
  }
}
