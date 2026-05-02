import {
  IAMClient,
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
  PutGroupPolicyCommand,
  DeleteGroupPolicyCommand,
  PutUserPolicyCommand,
  DeleteUserPolicyCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
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
  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::IAM::Policy', new Set(['PolicyName', 'PolicyDocument', 'Roles', 'Groups', 'Users'])],
  ]);

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
    this.logger.debug(`Creating IAM policy ${logicalId}`);

    const policyName =
      (properties['PolicyName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 64 });
    const policyDocument = properties['PolicyDocument'];
    const roles = properties['Roles'] as string[] | undefined;
    const groups = properties['Groups'] as string[] | undefined;
    const users = properties['Users'] as string[] | undefined;

    if (!policyDocument) {
      throw new ProvisioningError(
        `PolicyDocument is required for IAM policy ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // At least one of Roles, Groups, or Users must be specified
    const hasTargets =
      (roles && roles.length > 0) || (groups && groups.length > 0) || (users && users.length > 0);
    if (!hasTargets) {
      throw new ProvisioningError(
        `At least one of Roles, Groups, or Users is required for IAM policy ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      // Serialize policy document
      const policyDoc =
        typeof policyDocument === 'string' ? policyDocument : JSON.stringify(policyDocument);

      // Attach policy to all roles
      // Note: AWS::IAM::Policy in CloudFormation is actually an inline policy
      if (roles) {
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
      }

      // Attach policy to all groups
      if (groups) {
        for (const groupName of groups) {
          await this.iamClient.send(
            new PutGroupPolicyCommand({
              GroupName: groupName,
              PolicyName: policyName,
              PolicyDocument: policyDoc,
            })
          );
          this.logger.debug(`Attached inline policy ${policyName} to group ${groupName}`);
        }
      }

      // Attach policy to all users
      if (users) {
        for (const userName of users) {
          await this.iamClient.send(
            new PutUserPolicyCommand({
              UserName: userName,
              PolicyName: policyName,
              PolicyDocument: policyDoc,
            })
          );
          this.logger.debug(`Attached inline policy ${policyName} to user ${userName}`);
        }
      }

      this.logger.debug(`Successfully created IAM policy ${logicalId}: ${policyName}`);

      // For inline policies, physical ID is the policy name
      const physicalId = policyName;

      return {
        physicalId,
        attributes: {
          PolicyName: policyName,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create IAM policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        policyName,
        cause
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
    this.logger.debug(`Updating IAM policy ${logicalId}: ${physicalId}`);

    const newPolicyName =
      (properties['PolicyName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 64 });
    const newRoles = properties['Roles'] as string[] | undefined;
    const oldRoles = previousProperties['Roles'] as string[] | undefined;
    const newGroups = properties['Groups'] as string[] | undefined;
    const oldGroups = previousProperties['Groups'] as string[] | undefined;
    const newUsers = properties['Users'] as string[] | undefined;
    const oldUsers = previousProperties['Users'] as string[] | undefined;
    const policyDocument = properties['PolicyDocument'];

    if (!policyDocument) {
      throw new ProvisioningError(
        `PolicyDocument is required for IAM policy ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    // At least one of Roles, Groups, or Users must be specified
    const hasTargets =
      (newRoles && newRoles.length > 0) ||
      (newGroups && newGroups.length > 0) ||
      (newUsers && newUsers.length > 0);
    if (!hasTargets) {
      throw new ProvisioningError(
        `At least one of Roles, Groups, or Users is required for IAM policy ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      // Serialize policy document
      const policyDoc =
        typeof policyDocument === 'string' ? policyDocument : JSON.stringify(policyDocument);

      // Derive old policy name from physical ID (may contain ':roleName' suffix from old format)
      const oldPolicyName = physicalId.includes(':') ? physicalId.split(':')[0] : physicalId;

      // ── Roles ──
      const newRoleSet = new Set(newRoles || []);
      const oldRoleSet = new Set(oldRoles || []);

      // Attach/update policy on current roles
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

      // Remove policy from old roles no longer in the list
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

      // ── Groups ──
      const newGroupSet = new Set(newGroups || []);
      const oldGroupSet = new Set(oldGroups || []);

      // Attach/update policy on current groups
      for (const groupName of newGroupSet) {
        await this.iamClient.send(
          new PutGroupPolicyCommand({
            GroupName: groupName,
            PolicyName: newPolicyName,
            PolicyDocument: policyDoc,
          })
        );
        this.logger.debug(`Attached inline policy ${newPolicyName} to group ${groupName}`);
      }

      // Remove policy from old groups no longer in the list
      for (const groupName of oldGroupSet) {
        if (!newGroupSet.has(groupName)) {
          try {
            await this.iamClient.send(
              new DeleteGroupPolicyCommand({
                GroupName: groupName,
                PolicyName: oldPolicyName,
              })
            );
            this.logger.debug(`Removed inline policy ${oldPolicyName} from group ${groupName}`);
          } catch (error) {
            if (!(error instanceof NoSuchEntityException)) {
              throw error;
            }
          }
        }
      }

      // ── Users ──
      const newUserSet = new Set(newUsers || []);
      const oldUserSet = new Set(oldUsers || []);

      // Attach/update policy on current users
      for (const userName of newUserSet) {
        await this.iamClient.send(
          new PutUserPolicyCommand({
            UserName: userName,
            PolicyName: newPolicyName,
            PolicyDocument: policyDoc,
          })
        );
        this.logger.debug(`Attached inline policy ${newPolicyName} to user ${userName}`);
      }

      // Remove policy from old users no longer in the list
      for (const userName of oldUserSet) {
        if (!newUserSet.has(userName)) {
          try {
            await this.iamClient.send(
              new DeleteUserPolicyCommand({
                UserName: userName,
                PolicyName: oldPolicyName,
              })
            );
            this.logger.debug(`Removed inline policy ${oldPolicyName} from user ${userName}`);
          } catch (error) {
            if (!(error instanceof NoSuchEntityException)) {
              throw error;
            }
          }
        }
      }

      this.logger.debug(`Successfully updated IAM policy ${logicalId}`);

      const newPhysicalId = newPolicyName;

      return {
        physicalId: newPhysicalId,
        wasReplaced: false,
        attributes: {
          PolicyName: newPolicyName,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update IAM policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete an IAM inline policy
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting IAM policy ${logicalId}: ${physicalId}`);

    // Physical ID is the policy name (new format) or "policyName:roleName" (old format)
    const policyName = physicalId.includes(':') ? physicalId.split(':')[0] : physicalId;

    if (!policyName) {
      this.logger.warn(`Invalid physical ID format: ${physicalId}, skipping deletion`);
      return;
    }

    // Each per-target loop swallows NoSuchEntityException as idempotent
    // delete success. A region mismatch would otherwise let *every* such
    // exception slip through silently and orphan the underlying inline
    // policy attachments. Assert region once up front: IAM is global, but
    // the client region is still meaningful when the destroy run is
    // pointing at a different account/region than where the stack was
    // deployed.
    const onNotFound = async (target: string): Promise<void> => {
      const clientRegion = await this.iamClient.config.region();
      assertRegionMatch(
        clientRegion,
        context?.expectedRegion,
        resourceType,
        logicalId,
        `${physicalId} (${target})`
      );
    };

    try {
      // Get target lists from properties (state stores these)
      const roles = properties?.['Roles'] as string[] | undefined;
      const groups = properties?.['Groups'] as string[] | undefined;
      const users = properties?.['Users'] as string[] | undefined;

      // If no properties available, try legacy format (physicalId = "policyName:roleName")
      if (!roles && !groups && !users && physicalId.includes(':')) {
        const firstRole = physicalId.split(':')[1];
        if (firstRole) {
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
              await onNotFound(`role ${firstRole}`);
            } else {
              throw error;
            }
          }
        }
      }

      // Delete from all roles
      if (roles) {
        for (const roleName of roles) {
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
              await onNotFound(`role ${roleName}`);
            } else {
              throw error;
            }
          }
        }
      }

      // Delete from all groups
      if (groups) {
        for (const groupName of groups) {
          try {
            await this.iamClient.send(
              new DeleteGroupPolicyCommand({
                GroupName: groupName,
                PolicyName: policyName,
              })
            );
            this.logger.debug(`Deleted inline policy ${policyName} from group ${groupName}`);
          } catch (error) {
            if (error instanceof NoSuchEntityException) {
              await onNotFound(`group ${groupName}`);
            } else {
              throw error;
            }
          }
        }
      }

      // Delete from all users
      if (users) {
        for (const userName of users) {
          try {
            await this.iamClient.send(
              new DeleteUserPolicyCommand({
                UserName: userName,
                PolicyName: policyName,
              })
            );
            this.logger.debug(`Deleted inline policy ${policyName} from user ${userName}`);
          } catch (error) {
            if (error instanceof NoSuchEntityException) {
              await onNotFound(`user ${userName}`);
            } else {
              throw error;
            }
          }
        }
      }

      this.logger.debug(`Successfully deleted IAM policy ${logicalId}`);
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete IAM policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Adopt an existing IAM inline policy into cdkd state.
   *
   * **Explicit override only.** `AWS::IAM::Policy` in CloudFormation is an
   * inline policy attached to roles / groups / users — not a standalone
   * resource. Inline policies are not taggable and have no global identity,
   * so tag-based auto-lookup via `aws:cdk:path` is not feasible. Users
   * adopting inline policies must pass `--resource <logicalId>=<policyName>`
   * (the physical id is the policy name itself).
   *
   * For standalone managed policies (`AWS::IAM::ManagedPolicy`), the
   * Cloud Control API fallback handles import via the same explicit
   * override mode.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      return { physicalId: input.knownPhysicalId, attributes: {} };
    }
    return null;
  }
}
