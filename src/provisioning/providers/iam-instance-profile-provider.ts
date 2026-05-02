import {
  IAMClient,
  CreateInstanceProfileCommand,
  DeleteInstanceProfileCommand,
  GetInstanceProfileCommand,
  ListInstanceProfilesCommand,
  AddRoleToInstanceProfileCommand,
  RemoveRoleFromInstanceProfileCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import { matchesCdkPath, resolveExplicitPhysicalId } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * AWS IAM InstanceProfile Provider
 *
 * Implements resource provisioning for AWS::IAM::InstanceProfile using the IAM SDK.
 * This is required because IAM InstanceProfile is not supported by Cloud Control API.
 */
export class IAMInstanceProfileProvider implements ResourceProvider {
  private iamClient: IAMClient;
  private logger = getLogger().child('IAMInstanceProfileProvider');
  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::IAM::InstanceProfile', new Set(['InstanceProfileName', 'Path', 'Roles'])],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.iamClient = awsClients.iam;
  }

  /**
   * Create an IAM instance profile
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating IAM instance profile ${logicalId}`);

    const instanceProfileName = generateResourceName(
      (properties['InstanceProfileName'] as string | undefined) || logicalId,
      { maxLength: 128 }
    );
    const path = (properties['Path'] as string | undefined) || '/';
    const roles = properties['Roles'] as string[] | undefined;

    try {
      // Create instance profile
      const response = await this.iamClient.send(
        new CreateInstanceProfileCommand({
          InstanceProfileName: instanceProfileName,
          Path: path,
        })
      );

      this.logger.debug(`Created IAM instance profile: ${instanceProfileName}`);

      // Add roles to instance profile
      if (roles && Array.isArray(roles)) {
        for (const roleName of roles) {
          await this.iamClient.send(
            new AddRoleToInstanceProfileCommand({
              InstanceProfileName: instanceProfileName,
              RoleName: roleName,
            })
          );
          this.logger.debug(`Added role ${roleName} to instance profile ${instanceProfileName}`);
        }
      }

      this.logger.debug(
        `Successfully created IAM instance profile ${logicalId}: ${instanceProfileName}`
      );

      return {
        physicalId: instanceProfileName,
        attributes: {
          Arn: response.InstanceProfile?.Arn,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create IAM instance profile ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        instanceProfileName,
        cause
      );
    }
  }

  /**
   * Update an IAM instance profile
   *
   * Instance profile name and path are immutable. Only role membership can be updated.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating IAM instance profile ${logicalId}: ${physicalId}`);

    const newRoles = (properties['Roles'] as string[] | undefined) || [];
    const oldRoles = (previousProperties['Roles'] as string[] | undefined) || [];

    try {
      // Remove old roles that are no longer in the list
      for (const roleName of oldRoles) {
        if (!newRoles.includes(roleName)) {
          try {
            await this.iamClient.send(
              new RemoveRoleFromInstanceProfileCommand({
                InstanceProfileName: physicalId,
                RoleName: roleName,
              })
            );
            this.logger.debug(`Removed role ${roleName} from instance profile ${physicalId}`);
          } catch (error) {
            if (!(error instanceof NoSuchEntityException)) {
              throw error;
            }
            this.logger.debug(
              `Role ${roleName} already removed from instance profile ${physicalId}`
            );
          }
        }
      }

      // Add new roles that were not previously attached
      for (const roleName of newRoles) {
        if (!oldRoles.includes(roleName)) {
          await this.iamClient.send(
            new AddRoleToInstanceProfileCommand({
              InstanceProfileName: physicalId,
              RoleName: roleName,
            })
          );
          this.logger.debug(`Added role ${roleName} to instance profile ${physicalId}`);
        }
      }

      this.logger.debug(`Successfully updated IAM instance profile ${logicalId}`);

      // Get updated instance profile info for attributes
      const getResponse = await this.iamClient.send(
        new GetInstanceProfileCommand({ InstanceProfileName: physicalId })
      );

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: getResponse.InstanceProfile?.Arn,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update IAM instance profile ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete an IAM instance profile
   *
   * Before deleting, removes all roles from the instance profile.
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting IAM instance profile ${logicalId}: ${physicalId}`);

    try {
      // Get current instance profile to find attached roles
      let roles: string[] = [];
      try {
        const response = await this.iamClient.send(
          new GetInstanceProfileCommand({ InstanceProfileName: physicalId })
        );
        roles =
          response.InstanceProfile?.Roles?.map((r) => r.RoleName).filter(
            (name): name is string => !!name
          ) || [];
      } catch (error) {
        if (error instanceof NoSuchEntityException) {
          const clientRegion = await this.iamClient.config.region();
          assertRegionMatch(
            clientRegion,
            context?.expectedRegion,
            resourceType,
            logicalId,
            physicalId
          );
          this.logger.debug(`Instance profile ${physicalId} does not exist, skipping deletion`);
          return;
        }
        throw error;
      }

      // Remove all roles from instance profile
      for (const roleName of roles) {
        try {
          await this.iamClient.send(
            new RemoveRoleFromInstanceProfileCommand({
              InstanceProfileName: physicalId,
              RoleName: roleName,
            })
          );
          this.logger.debug(`Removed role ${roleName} from instance profile ${physicalId}`);
        } catch (error) {
          if (!(error instanceof NoSuchEntityException)) {
            throw error;
          }
        }
      }

      // Delete instance profile
      await this.iamClient.send(
        new DeleteInstanceProfileCommand({ InstanceProfileName: physicalId })
      );

      this.logger.debug(`Successfully deleted IAM instance profile ${logicalId}`);
    } catch (error) {
      if (error instanceof NoSuchEntityException) {
        const clientRegion = await this.iamClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Instance profile ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete IAM instance profile ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Adopt an existing IAM instance profile into cdkd state.
   *
   * Lookup order:
   *  1. `--resource` override or `Properties.InstanceProfileName` → verify
   *     via `GetInstanceProfile`.
   *  2. `ListInstanceProfiles` paginator + match `aws:cdk:path` against the
   *     `InstanceProfile.Tags` array returned inline (no separate
   *     `ListInstanceProfileTags` call needed).
   *
   * IAM is global; this walks every instance profile in the account once.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'InstanceProfileName');
    if (explicit) {
      try {
        await this.iamClient.send(new GetInstanceProfileCommand({ InstanceProfileName: explicit }));
        return { physicalId: explicit, attributes: {} };
      } catch (err) {
        if (err instanceof NoSuchEntityException) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    let marker: string | undefined;
    do {
      const list = await this.iamClient.send(
        new ListInstanceProfilesCommand({ ...(marker && { Marker: marker }) })
      );
      for (const profile of list.InstanceProfiles ?? []) {
        if (!profile.InstanceProfileName) continue;
        if (matchesCdkPath(profile.Tags, input.cdkPath)) {
          return { physicalId: profile.InstanceProfileName, attributes: {} };
        }
      }
      marker = list.IsTruncated ? list.Marker : undefined;
    } while (marker);
    return null;
  }
}
