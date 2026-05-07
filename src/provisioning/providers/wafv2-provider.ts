import {
  WAFV2Client,
  CreateWebACLCommand,
  UpdateWebACLCommand,
  DeleteWebACLCommand,
  GetWebACLCommand,
  ListWebACLsCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
  UntagResourceCommand,
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
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import { matchesCdkPath, normalizeAwsTagsToCfn } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
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
    previousProperties: Record<string, unknown>
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

      // Apply tag diff. WAFv2 uses TagResource / UntagResource keyed by
      // ResourceARN (the physicalId is the WebACL ARN).
      await this.applyTagDiff(
        physicalId,
        previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
        properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
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
    _properties?: Record<string, unknown>,
    context?: DeleteContext
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
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
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

  /**
   * Apply a diff between old and new CFn-shape Tags arrays via WAFv2's
   * `TagResource` / `UntagResource` APIs (keyed by `ResourceARN`).
   */
  private async applyTagDiff(
    arn: string,
    oldTagsRaw: Array<{ Key?: string; Value?: string }> | undefined,
    newTagsRaw: Array<{ Key?: string; Value?: string }> | undefined
  ): Promise<void> {
    const toMap = (
      tags: Array<{ Key?: string; Value?: string }> | undefined
    ): Map<string, string> => {
      const m = new Map<string, string>();
      for (const t of tags ?? []) {
        if (t.Key !== undefined && t.Value !== undefined) m.set(t.Key, t.Value);
      }
      return m;
    };

    const oldMap = toMap(oldTagsRaw);
    const newMap = toMap(newTagsRaw);

    const tagsToAdd: Tag[] = [];
    for (const [k, v] of newMap) {
      if (oldMap.get(k) !== v) tagsToAdd.push({ Key: k, Value: v });
    }
    const tagsToRemove: string[] = [];
    for (const k of oldMap.keys()) {
      if (!newMap.has(k)) tagsToRemove.push(k);
    }

    if (tagsToRemove.length > 0) {
      await this.getClient().send(
        new UntagResourceCommand({ ResourceARN: arn, TagKeys: tagsToRemove })
      );
      this.logger.debug(`Removed ${tagsToRemove.length} tag(s) from WAFv2 WebACL ${arn}`);
    }
    if (tagsToAdd.length > 0) {
      await this.getClient().send(new TagResourceCommand({ ResourceARN: arn, Tags: tagsToAdd }));
      this.logger.debug(`Added/updated ${tagsToAdd.length} tag(s) on WAFv2 WebACL ${arn}`);
    }
  }

  /**
   * Read the AWS-current WAFv2 WebACL configuration in CFn-property shape.
   *
   * The cdkd physicalId is the WebACL ARN; we parse it back to
   * `(id, name, scope)` and call `GetWebACL`. The response holds Name,
   * Description, DefaultAction, Rules, VisibilityConfig,
   * CustomResponseBodies, CaptchaConfig, ChallengeConfig, TokenDomains,
   * and AssociationConfig — every key cdkd state declares as
   * `handledProperties`. `Scope` is recovered from the ARN parse.
   *
   * Tags are surfaced via a follow-up `ListTagsForResource(ResourceARN)`
   * call. CDK's `aws:*` auto-tags are filtered out and the result key is
   * omitted when AWS reports no user tags. Returns `undefined`
   * when the ARN can't be parsed or the WebACL is gone
   * (`WAFNonexistentItemException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let id: string;
    let name: string;
    let scope: Scope;
    try {
      ({ id, name, scope } = parseWebACLArn(physicalId));
    } catch {
      return undefined;
    }

    let webACL;
    try {
      const resp = await this.getClient().send(
        new GetWebACLCommand({ Id: id, Name: name, Scope: scope })
      );
      webACL = resp.WebACL;
    } catch (err) {
      if (err instanceof WAFNonexistentItemException) return undefined;
      throw err;
    }
    if (!webACL) return undefined;

    const result: Record<string, unknown> = {};
    if (webACL.Name !== undefined) result['Name'] = webACL.Name;
    result['Scope'] = scope;
    result['Description'] = webACL.Description ?? '';
    if (webACL.DefaultAction) {
      result['DefaultAction'] = webACL.DefaultAction as unknown as Record<string, unknown>;
    }
    result['Rules'] = (webACL.Rules ?? []).map((r) => r as unknown as Record<string, unknown>);
    if (webACL.VisibilityConfig) {
      result['VisibilityConfig'] = webACL.VisibilityConfig as unknown as Record<string, unknown>;
    }
    result['CustomResponseBodies'] = (webACL.CustomResponseBodies ?? {}) as Record<string, unknown>;
    if (webACL.CaptchaConfig) {
      result['CaptchaConfig'] = webACL.CaptchaConfig as unknown as Record<string, unknown>;
    }
    if (webACL.ChallengeConfig) {
      result['ChallengeConfig'] = webACL.ChallengeConfig as unknown as Record<string, unknown>;
    }
    result['TokenDomains'] = webACL.TokenDomains ? [...webACL.TokenDomains] : [];
    if (webACL.AssociationConfig) {
      result['AssociationConfig'] = webACL.AssociationConfig as unknown as Record<string, unknown>;
    }

    // Tags via ListTagsForResource (the WebACL ARN is the physicalId).
    try {
      const tagsResp = await this.getClient().send(
        new ListTagsForResourceCommand({ ResourceARN: physicalId })
      );
      const tags = normalizeAwsTagsToCfn(tagsResp.TagInfoForResource?.TagList);
      result['Tags'] = tags;
    } catch (err) {
      this.logger.debug(
        `WAFv2 ListTagsForResource(${physicalId}) failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    return result;
  }

  /**
   * Adopt an existing WAFv2 WebACL into cdkd state.
   *
   * Lookup order:
   *  1. `--resource <id>=<arn>` override → verify with `GetWebACL` (parses
   *     Name/Id/Scope back out of the ARN).
   *  2. Walk `ListWebACLs(Scope)` → match `aws:cdk:path` via
   *     `ListTagsForResource(ResourceARN)` (returns
   *     `TagInfoForResource.TagList`, standard `Key`/`Value` shape).
   *
   * `Scope` is required by `ListWebACLs` — read from
   * `Properties.Scope` (`REGIONAL` is the default).
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      try {
        const { id, name, scope } = parseWebACLArn(input.knownPhysicalId);
        await this.getClient().send(new GetWebACLCommand({ Id: id, Name: name, Scope: scope }));
        return { physicalId: input.knownPhysicalId, attributes: {} };
      } catch (err) {
        if (err instanceof WAFNonexistentItemException) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    const scope = ((input.properties['Scope'] as string | undefined) || 'REGIONAL') as Scope;

    let nextMarker: string | undefined;
    do {
      const list = await this.getClient().send(
        new ListWebACLsCommand({ Scope: scope, ...(nextMarker && { NextMarker: nextMarker }) })
      );
      for (const item of list.WebACLs ?? []) {
        if (!item.ARN) continue;
        const tagsResp = await this.getClient().send(
          new ListTagsForResourceCommand({ ResourceARN: item.ARN })
        );
        const tagList = tagsResp.TagInfoForResource?.TagList;
        if (matchesCdkPath(tagList, input.cdkPath)) {
          return { physicalId: item.ARN, attributes: {} };
        }
      }
      nextMarker = list.NextMarker;
    } while (nextMarker);
    return null;
  }
}
