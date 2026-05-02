import {
  IAMClient,
  CreateRoleCommand,
  UpdateRoleCommand,
  UpdateAssumeRolePolicyCommand,
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
  UntagRoleCommand,
  PutRolePermissionsBoundaryCommand,
  DeleteRolePermissionsBoundaryCommand,
  ListRolesCommand,
  ListRoleTagsCommand,
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
 * AWS IAM Role Provider
 *
 * Implements resource provisioning for AWS::IAM::Role using the IAM SDK.
 * This is required because IAM Role is not supported by Cloud Control API.
 */
export class IAMRoleProvider implements ResourceProvider {
  private iamClient: IAMClient;
  private logger = getLogger().child('IAMRoleProvider');
  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::IAM::Role',
      new Set([
        'RoleName',
        'AssumeRolePolicyDocument',
        'Description',
        'MaxSessionDuration',
        'Path',
        'PermissionsBoundary',
        'ManagedPolicyArns',
        'Policies',
        'Tags',
      ]),
    ],
  ]);

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

    // Check if immutable properties changed (requires replacement)
    // RoleName and Path are immutable - cannot be changed after creation
    const newPath = (properties['Path'] as string | undefined) || '/';
    const oldPath = (previousProperties['Path'] as string | undefined) || '/';
    const needsReplacement = newRoleName !== physicalId || newPath !== oldPath;

    if (needsReplacement) {
      const reason = newRoleName !== physicalId ? 'RoleName' : 'Path';
      this.logger.debug(
        `${reason} changed, replacing role: ${physicalId} (${reason}: ${reason === 'RoleName' ? `${physicalId} -> ${newRoleName}` : `${oldPath} -> ${newPath}`})`
      );

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
      // Update role properties (Description, MaxSessionDuration)
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

      // Update AssumeRolePolicyDocument if changed
      const newAssumePolicy = properties['AssumeRolePolicyDocument'];
      const oldAssumePolicy = previousProperties['AssumeRolePolicyDocument'];
      if (newAssumePolicy) {
        const newPolicyStr =
          typeof newAssumePolicy === 'string' ? newAssumePolicy : JSON.stringify(newAssumePolicy);
        const oldPolicyStr = oldAssumePolicy
          ? typeof oldAssumePolicy === 'string'
            ? oldAssumePolicy
            : JSON.stringify(oldAssumePolicy)
          : '';

        if (newPolicyStr !== oldPolicyStr) {
          await this.iamClient.send(
            new UpdateAssumeRolePolicyCommand({
              RoleName: physicalId,
              PolicyDocument: newPolicyStr,
            })
          );
          this.logger.debug(`Updated assume role policy for ${physicalId}`);
        }
      }

      // Update PermissionsBoundary
      const newBoundary = properties['PermissionsBoundary'] as string | undefined;
      const oldBoundary = previousProperties['PermissionsBoundary'] as string | undefined;
      if (newBoundary !== oldBoundary) {
        if (newBoundary) {
          await this.iamClient.send(
            new PutRolePermissionsBoundaryCommand({
              RoleName: physicalId,
              PermissionsBoundary: newBoundary,
            })
          );
          this.logger.debug(`Set permissions boundary for ${physicalId}: ${newBoundary}`);
        } else if (oldBoundary) {
          await this.iamClient.send(
            new DeleteRolePermissionsBoundaryCommand({
              RoleName: physicalId,
            })
          );
          this.logger.debug(`Removed permissions boundary from ${physicalId}`);
        }
      }

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

      // Update tags
      await this.updateTags(
        physicalId,
        properties['Tags'] as Array<{ Key: string; Value: string }> | undefined,
        previousProperties['Tags'] as Array<{ Key: string; Value: string }> | undefined
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
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting IAM role ${logicalId}: ${physicalId}`);

    try {
      // Check if role exists
      try {
        await this.iamClient.send(new GetRoleCommand({ RoleName: physicalId }));
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

  /**
   * Update tags on the role
   */
  private async updateTags(
    roleName: string,
    newTags: Array<{ Key: string; Value: string }> | undefined,
    oldTags: Array<{ Key: string; Value: string }> | undefined
  ): Promise<void> {
    const newTagMap = new Map((newTags || []).map((t) => [t.Key, t.Value]));
    const oldTagMap = new Map((oldTags || []).map((t) => [t.Key, t.Value]));

    // Find tags to remove (present in old but not in new)
    const tagsToRemove: string[] = [];
    for (const key of oldTagMap.keys()) {
      if (!newTagMap.has(key)) {
        tagsToRemove.push(key);
      }
    }

    // Find tags to add/update (new or changed value)
    const tagsToAdd: Array<{ Key: string; Value: string }> = [];
    for (const [key, value] of newTagMap) {
      if (oldTagMap.get(key) !== value) {
        tagsToAdd.push({ Key: key, Value: value });
      }
    }

    if (tagsToRemove.length > 0) {
      await this.iamClient.send(
        new UntagRoleCommand({
          RoleName: roleName,
          TagKeys: tagsToRemove,
        })
      );
      this.logger.debug(`Removed ${tagsToRemove.length} tags from role ${roleName}`);
    }

    if (tagsToAdd.length > 0) {
      await this.iamClient.send(
        new TagRoleCommand({
          RoleName: roleName,
          Tags: tagsToAdd,
        })
      );
      this.logger.debug(`Added/updated ${tagsToAdd.length} tags on role ${roleName}`);
    }
  }

  /**
   * Resolve a single `Fn::GetAtt` attribute for an existing IAM role.
   *
   * CloudFormation's `AWS::IAM::Role` exposes `Arn` and `RoleId`; both are
   * available from the `GetRole` response. See:
   * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iam-role.html#aws-resource-iam-role-return-values
   *
   * Used by `cdkd orphan` to live-fetch attribute values that need to be
   * substituted into sibling references.
   */
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    try {
      const resp = await this.iamClient.send(new GetRoleCommand({ RoleName: physicalId }));
      switch (attributeName) {
        case 'Arn':
          return resp.Role?.Arn;
        case 'RoleId':
          return resp.Role?.RoleId;
        default:
          return undefined;
      }
    } catch (err) {
      if (err instanceof NoSuchEntityException) return undefined;
      throw err;
    }
  }

  /**
   * Adopt an existing IAM role into cdkd state.
   *
   * Lookup order:
   *  1. `--resource` override or `Properties.RoleName` → use directly,
   *     verify via `GetRole`.
   *  2. `ListRoles` + `ListRoleTags`, match `aws:cdk:path` tag.
   *
   * `ListRoles` is paginated and IAM is global (no region scoping), so this
   * walks every role in the account once. Acceptable for the cardinalities
   * we expect (typically <100 roles per account); larger accounts may want
   * to provide `--resource` overrides instead.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'RoleName');
    if (explicit) {
      try {
        await this.iamClient.send(new GetRoleCommand({ RoleName: explicit }));
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
        new ListRolesCommand({ ...(marker && { Marker: marker }) })
      );
      for (const role of list.Roles ?? []) {
        if (!role.RoleName) continue;
        try {
          const tags = await this.iamClient.send(
            new ListRoleTagsCommand({ RoleName: role.RoleName })
          );
          if (matchesCdkPath(tags.Tags, input.cdkPath)) {
            return { physicalId: role.RoleName, attributes: {} };
          }
        } catch (err) {
          if (err instanceof NoSuchEntityException) continue;
          throw err;
        }
      }
      marker = list.IsTruncated ? list.Marker : undefined;
    } while (marker);
    return null;
  }
}
