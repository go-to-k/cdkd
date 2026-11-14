import type { WAFv2WebACLProvider } from '../wafv2-provider.js';
import {
  UpdateWebACLCommand,
  GetWebACLCommand,
  TagResourceCommand,
  UntagResourceCommand,
  type Tag,
  type DefaultAction,
  type VisibilityConfig,
  type CaptchaConfig,
  type ChallengeConfig,
  type CustomResponseBody,
  type AssociationConfig,
  type DataProtectionConfig,
  type OnSourceDDoSProtectionConfig,
  type MonetizationConfig,
} from '@aws-sdk/client-wafv2';
import { definedAttributes } from '../../attribute-map.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch } from '../../region-check.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../../tag-list.js';
import type { ResourceUpdateResult, UpdateContext } from '../../../types/resource.js';
import { parseWebACLArn } from '../wafv2-arn.js';
import { sanitizeDescription, applicationConfigForUpdate, toSdkRules } from './shared.js';

/**
 * Update a WAFv2 WebACL
 *
 * Name and Scope are immutable - changes to those require replacement.
 * UpdateWebACL requires LockToken obtained from GetWebACL.
 */
export async function update(
  this: WAFv2WebACLProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating WAFv2 WebACL ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#2613: the update addresses the web ACL by the name, id and
  // scope inside the recorded ARN, so a client in another region than the
  // state record would send `GetWebACL`, `UpdateWebACL` and the tag writes to
  // a region this record was not written through. A CLOUDFRONT-scope web ACL
  // goes through the same client (there is no us-east-1 routing here), so it
  // is compared the same way. Outside the try: a refusal is not an AWS
  // failure to re-label. Refuse before any call; the client's region is
  // resolved only when there is one to compare with.
  assertRegionMatch(
    context?.expectedRegion ? await this.getClient().config.region() : undefined,
    context?.expectedRegion,
    resourceType,
    logicalId,
    physicalId,
    'pre-update'
  );
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

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
        Description: sanitizeDescription(properties['Description']),
        Rules: toSdkRules(properties['Rules']),
        VisibilityConfig: properties['VisibilityConfig'] as VisibilityConfig,
        CustomResponseBodies: properties['CustomResponseBodies'] as
          | Record<string, CustomResponseBody>
          | undefined,
        CaptchaConfig: properties['CaptchaConfig'] as CaptchaConfig | undefined,
        ChallengeConfig: properties['ChallengeConfig'] as ChallengeConfig | undefined,
        TokenDomains: properties['TokenDomains'] as string[] | undefined,
        AssociationConfig: properties['AssociationConfig'] as AssociationConfig | undefined,
        DataProtectionConfig: properties['DataProtectionConfig'] as
          | DataProtectionConfig
          | undefined,
        OnSourceDDoSProtectionConfig: properties['OnSourceDDoSProtectionConfig'] as
          | OnSourceDDoSProtectionConfig
          | undefined,
        ApplicationConfig: applicationConfigForUpdate(
          properties['ApplicationConfig'],
          previousProperties['ApplicationConfig']
        ),
        MonetizationConfig: properties['MonetizationConfig'] as MonetizationConfig | undefined,
      })
    );

    // Apply tag diff. WAFv2 uses TagResource / UntagResource keyed by
    // ResourceARN (the physicalId is the WebACL ARN).
    await this.applyTagDiff(
      physicalId,
      resourceType,
      logicalId,
      previousProperties['Tags'],
      properties['Tags']
    );

    this.logger.debug(`Successfully updated WAFv2 WebACL ${logicalId}`);

    // `Capacity` follows the rules, so the pre-update read above is stale
    // for it: read it again (issue #6238). The update already landed, so a
    // failed read omits the attribute rather than failing it; the #1852
    // heal fills it on the next deploy that reads it.
    let capacity: number | undefined;
    try {
      capacity = (
        await this.getClient().send(new GetWebACLCommand({ Name: name, Scope: scope, Id: id }))
      ).WebACL?.Capacity;
    } catch (readError) {
      this.logger.debug(
        safeMsg`Could not read the capacity of ${logicalId} after update: ${describeAwsFailure(readError).detail}`
      );
    }

    return {
      physicalId,
      wasReplaced: false,
      attributes: definedAttributes({
        Arn: physicalId,
        Id: id,
        LabelNamespace: getResponse.WebACL?.LabelNamespace,
        Capacity: capacity,
      }),
    };
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update WAFv2 WebACL ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * Apply a diff between old and new CFn-shape Tags arrays via WAFv2's
 * `TagResource` / `UntagResource` APIs (keyed by `ResourceARN`). Both
 * sides are read through `planTagDiff` (go-to-k/cdkd#3994): an unreadable
 * record untags nothing.
 */
export async function applyTagDiff(
  this: WAFv2WebACLProvider,
  arn: string,
  resourceType: string,
  logicalId: string,
  oldTagsRaw: unknown,
  newTagsRaw: unknown
): Promise<void> {
  const plan = planTagDiff(oldTagsRaw, newTagsRaw);
  const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
  if (tagWarning !== undefined) {
    this.logger.warn(tagWarning);
  }
  const tagsToAdd: Tag[] = [...plan.set].map(([Key, Value]) => ({ Key, Value }));
  const tagsToRemove = plan.remove;

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
