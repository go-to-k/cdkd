import type { WAFv2WebACLProvider } from '../wafv2-provider.js';
import {
  CreateWebACLCommand,
  GetWebACLCommand,
  type Tag,
  type DefaultAction,
  type VisibilityConfig,
  type Scope,
  type CaptchaConfig,
  type ChallengeConfig,
  type CustomResponseBody,
  type AssociationConfig,
  type DataProtectionConfig,
  type OnSourceDDoSProtectionConfig,
  type ApplicationConfig,
  type MonetizationConfig,
} from '@aws-sdk/client-wafv2';
import { definedAttributes } from '../../attribute-map.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { replayWarn, requireConfigString } from '../../config-shape.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { generatedNameFor } from '../../resource-name.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import type { ResourceCreateResult, CreateContext } from '../../../types/resource.js';
import { sanitizeDescription, toSdkRules } from './shared.js';

/**
 * Create a WAFv2 WebACL
 */
export async function create(
  this: WAFv2WebACLProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating WAFv2 WebACL ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  const name =
    (properties['Name'] as string | undefined) || generatedNameFor('AWS::WAFv2::WebACL', logicalId);
  // `replayWarn`: the rollback executor's reverse-replacement arm revives
  // the OLD resource from `previousState.properties`, which the user cannot
  // edit from the template — a hard refusal there would leave the resource
  // unrestorable (issue #1544). Template-path creates keep the refusal.
  const scope = requireConfigString(
    properties['Scope'],
    'REGIONAL',
    'AWS::WAFv2::WebACL Scope',
    replayWarn(this.logger, context)
  ) as Scope;

  try {
    // Build tags
    const tags: Tag[] = desiredTags.map((tag) => ({ Key: tag.Key, Value: tag.Value }));

    const response = await this.getCreateClient().send(
      new CreateWebACLCommand({
        Name: name,
        Scope: scope,
        DefaultAction: properties['DefaultAction'] as DefaultAction,
        Description: sanitizeDescription(properties['Description']),
        Rules: toSdkRules(properties['Rules']),
        VisibilityConfig: properties['VisibilityConfig'] as VisibilityConfig,
        ...(tags.length > 0 && { Tags: tags }),
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
        ApplicationConfig: properties['ApplicationConfig'] as ApplicationConfig | undefined,
        MonetizationConfig: properties['MonetizationConfig'] as MonetizationConfig | undefined,
      })
    );

    const summary = response.Summary;
    if (!summary?.ARN || !summary?.Id) {
      throw new Error('CreateWebACL did not return Summary with ARN and Id');
    }

    this.logger.debug(`Successfully created WAFv2 WebACL ${logicalId}: ${summary.ARN}`);

    // `LabelNamespace` is not a `WebACLSummary` member, so the value read
    // off the summary here before was always absent (issue #3627): read it
    // from `GetWebACL`. The web ACL exists by now, so a failed read omits
    // the attribute rather than failing the create; the #1852 heal fills it.
    // `Capacity` (the WCUs the rules consume) is read off the same call: it
    // is a CloudFormation `Fn::GetAtt` attribute (issue #6238).
    let labelNamespace: string | undefined;
    let capacity: number | undefined;
    try {
      const webAcl = (
        await this.getClient().send(
          new GetWebACLCommand({ Id: summary.Id, Name: name, Scope: scope })
        )
      ).WebACL;
      labelNamespace = webAcl?.LabelNamespace;
      capacity = webAcl?.Capacity;
    } catch (readError) {
      this.logger.debug(
        `Could not read the label namespace of ${logicalId} after create: ${describeAwsFailure(readError).detail}`
      );
    }

    return {
      physicalId: summary.ARN,
      attributes: definedAttributes({
        Arn: summary.ARN,
        Id: summary.Id,
        LabelNamespace: labelNamespace,
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
          `Failed to create WAFv2 WebACL ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}
