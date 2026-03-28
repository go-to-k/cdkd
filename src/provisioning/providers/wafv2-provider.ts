import {
  WAFV2Client,
  CreateWebACLCommand,
  UpdateWebACLCommand,
  DeleteWebACLCommand,
  GetWebACLCommand,
  WAFNonexistentItemException,
  type Tag,
  type Rule,
  type DefaultAction,
  type VisibilityConfig,
  type Scope,
  type CaptchaConfig,
  type ChallengeConfig,
  type CustomResponseBody,
  type AssociationConfig,
} from '@aws-sdk/client-wafv2';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { generateResourceName } from '../resource-name.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * Parse WAFv2 WebACL ARN to extract Id, Name, and Scope.
 *
 * ARN format:
 *   arn:aws:wafv2:{region}:{account}:regional/webacl/{name}/{id}
 *   arn:aws:wafv2:{region}:{account}:global/webacl/{name}/{id}
 */
function parseWebACLArn(arn: string): { id: string; name: string; scope: Scope } {
  // Example: arn:aws:wafv2:us-east-1:123456789012:regional/webacl/my-acl/abc-123
  const parts = arn.split(':');
  // parts[5] = "regional/webacl/my-acl/abc-123" or "global/webacl/my-acl/abc-123"
  const resourcePart = parts.slice(5).join(':');
  const segments = resourcePart.split('/');
  // segments: ["regional", "webacl", "my-acl", "abc-123"]
  const scopeRaw = segments[0]!; // "regional" or "global"
  const name = segments[2]!;
  const id = segments[3]!;

  const scope: Scope = scopeRaw === 'global' ? 'CLOUDFRONT' : 'REGIONAL';

  return { id, name, scope };
}

/**
 * AWS WAFv2 WebACL Provider
 *
 * Implements resource provisioning for AWS::WAFv2::WebACL using the WAFv2 SDK.
 * WHY: WAFv2 CreateWebACL is synchronous - the CC API adds unnecessary polling
 * overhead for an operation that completes immediately.
 * This SDK provider eliminates that polling and returns instantly.
 */
export class WAFv2WebACLProvider implements ResourceProvider {
  private wafv2Client?: WAFV2Client;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('WAFv2WebACLProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::WAFv2::WebACL',
      new Set([
        'Name',
        'Scope',
        'Tags',
        'DefaultAction',
        'Description',
        'Rules',
        'VisibilityConfig',
        'CustomResponseBodies',
        'CaptchaConfig',
        'ChallengeConfig',
        'TokenDomains',
        'AssociationConfig',
      ]),
    ],
  ]);

  private getClient(): WAFV2Client {
    if (!this.wafv2Client) {
      this.wafv2Client = new WAFV2Client(
        this.providerRegion ? { region: this.providerRegion } : {}
      );
    }
    return this.wafv2Client;
  }

  /**
   * Create a WAFv2 WebACL
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating WAFv2 WebACL ${logicalId}`);

    const name =
      (properties['Name'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 128 });
    const scope = ((properties['Scope'] as string) || 'REGIONAL') as Scope;

    try {
      // Build tags
      const tags: Tag[] = [];
      if (properties['Tags']) {
        const tagList = properties['Tags'] as Array<{ Key: string; Value: string }>;
        for (const tag of tagList) {
          tags.push({ Key: tag.Key, Value: tag.Value });
        }
      }

      const response = await this.getClient().send(
        new CreateWebACLCommand({
          Name: name,
          Scope: scope,
          DefaultAction: properties['DefaultAction'] as DefaultAction,
          Description: properties['Description'] as string | undefined,
          Rules: (properties['Rules'] as Rule[]) || [],
          VisibilityConfig: properties['VisibilityConfig'] as VisibilityConfig,
          ...(tags.length > 0 && { Tags: tags }),
          CustomResponseBodies: properties['CustomResponseBodies'] as
            | Record<string, CustomResponseBody>
            | undefined,
          CaptchaConfig: properties['CaptchaConfig'] as CaptchaConfig | undefined,
          ChallengeConfig: properties['ChallengeConfig'] as ChallengeConfig | undefined,
          TokenDomains: properties['TokenDomains'] as string[] | undefined,
          AssociationConfig: properties['AssociationConfig'] as AssociationConfig | undefined,
        })
      );

      const summary = response.Summary;
      if (!summary?.ARN || !summary?.Id) {
        throw new Error('CreateWebACL did not return Summary with ARN and Id');
      }

      this.logger.debug(`Successfully created WAFv2 WebACL ${logicalId}: ${summary.ARN}`);

      return {
        physicalId: summary.ARN,
        attributes: {
          Arn: summary.ARN,
          Id: summary.Id,
          LabelNamespace: (summary as Record<string, unknown>)['LabelNamespace'],
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create WAFv2 WebACL ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update a WAFv2 WebACL
   *
   * Name and Scope are immutable - changes to those require replacement.
   * UpdateWebACL requires LockToken obtained from GetWebACL.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating WAFv2 WebACL ${logicalId}: ${physicalId}`);

    try {
      const { id, name, scope } = parseWebACLArn(physicalId);

      // Get current WebACL to obtain LockToken
      const getResponse = await this.getClient().send(
        new GetWebACLCommand({
          Name: name,
          Scope: scope,
          Id: id,
        })
      );

      const lockToken = getResponse.LockToken;
      if (!lockToken) {
        throw new Error('GetWebACL did not return LockToken');
      }

      await this.getClient().send(
        new UpdateWebACLCommand({
          Name: name,
          Scope: scope,
          Id: id,
          LockToken: lockToken,
          DefaultAction: properties['DefaultAction'] as DefaultAction,
          Description: properties['Description'] as string | undefined,
          Rules: (properties['Rules'] as Rule[]) || [],
          VisibilityConfig: properties['VisibilityConfig'] as VisibilityConfig,
          CustomResponseBodies: properties['CustomResponseBodies'] as
            | Record<string, CustomResponseBody>
            | undefined,
          CaptchaConfig: properties['CaptchaConfig'] as CaptchaConfig | undefined,
          ChallengeConfig: properties['ChallengeConfig'] as ChallengeConfig | undefined,
          TokenDomains: properties['TokenDomains'] as string[] | undefined,
          AssociationConfig: properties['AssociationConfig'] as AssociationConfig | undefined,
        })
      );

      this.logger.debug(`Successfully updated WAFv2 WebACL ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: physicalId,
          Id: id,
          LabelNamespace: getResponse.WebACL?.LabelNamespace,
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update WAFv2 WebACL ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete a WAFv2 WebACL
   *
   * DeleteWebACL requires LockToken obtained from GetWebACL.
   * WAFNonexistentItemException is treated as success (idempotent delete).
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.debug(`Deleting WAFv2 WebACL ${logicalId}: ${physicalId}`);

    try {
      const { id, name, scope } = parseWebACLArn(physicalId);

      // Get LockToken
      const getResponse = await this.getClient().send(
        new GetWebACLCommand({
          Name: name,
          Scope: scope,
          Id: id,
        })
      );

      const lockToken = getResponse.LockToken;
      if (!lockToken) {
        throw new Error('GetWebACL did not return LockToken');
      }

      await this.getClient().send(
        new DeleteWebACLCommand({
          Name: name,
          Scope: scope,
          Id: id,
          LockToken: lockToken,
        })
      );

      this.logger.debug(`Successfully deleted WAFv2 WebACL ${logicalId}`);
    } catch (error) {
      if (error instanceof WAFNonexistentItemException) {
        this.logger.debug(`WAFv2 WebACL ${physicalId} does not exist, skipping deletion`);
        return;
      }

      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete WAFv2 WebACL ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }
}
