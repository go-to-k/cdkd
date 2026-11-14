import type { WAFv2WebACLProvider } from '../wafv2-provider.js';
import {
  GetWebACLCommand,
  ListTagsForResourceCommand,
  WAFNonexistentItemException,
  type Scope,
} from '@aws-sdk/client-wafv2';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import type {
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { parseWebACLArn } from '../wafv2-arn.js';
import { toCfnDataProtectionConfig, toCfnRules, webAclAttributes } from './shared.js';

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
 * when the ARN can't be parsed, and `RESOURCE_NOT_FOUND` when the WebACL
 * is gone (`WAFNonexistentItemException`).
 */
export async function readCurrentState(
  this: WAFv2WebACLProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string,
  // The state-recorded baseline. Load-bearing, not decoration: the AWS
  // `Rules` blob cannot say whether the template spelled a byte-match
  // needle `SearchString` or `SearchStringBase64` (identical bytes), so
  // the reverse mapping is baseline-driven. See {@link toCfnRules}.
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const { id, name, scope } = parseWebACLArn(physicalId);
  if (!id || !name) return undefined;

  let webACL;
  try {
    const resp = await this.getClient().send(
      new GetWebACLCommand({ Id: id, Name: name, Scope: scope })
    );
    webACL = resp.WebACL;
  } catch (err) {
    if (err instanceof WAFNonexistentItemException) return RESOURCE_NOT_FOUND;
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
  result['Rules'] = toCfnRules(webACL.Rules ?? [], properties?.['Rules']);
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
  // Issue #2762: the four members below share their CFn and SDK spelling at
  // every depth, so each reads back verbatim. Emitted only when AWS reports
  // one, as CaptchaConfig is: an empty placeholder would be no valid value to
  // send back on `drift --revert` (`DataProtections` takes at least one entry).
  if (webACL.DataProtectionConfig) {
    result['DataProtectionConfig'] = toCfnDataProtectionConfig(
      webACL.DataProtectionConfig as unknown as Record<string, unknown>,
      properties?.['DataProtectionConfig']
    );
  }
  if (webACL.OnSourceDDoSProtectionConfig) {
    result['OnSourceDDoSProtectionConfig'] =
      webACL.OnSourceDDoSProtectionConfig as unknown as Record<string, unknown>;
  }
  if (webACL.ApplicationConfig) {
    result['ApplicationConfig'] = webACL.ApplicationConfig as unknown as Record<string, unknown>;
  }
  if (webACL.MonetizationConfig) {
    result['MonetizationConfig'] = webACL.MonetizationConfig as unknown as Record<string, unknown>;
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
      `WAFv2 ListTagsForResource(${physicalId}) failed: ${describeAwsFailure(err).detail}`
    );
  }

  return result;
}

/**
 * Adopt an existing WAFv2 WebACL into cdkd state.
 *
 * Lookup order:
 *  1. `--resource <id>=<arn>` override → verify with `GetWebACL` (parses
 *     Name/Id/Scope back out of the ARN). CloudFormation's compound
 *     `name|id|scope` physical id — what `--migrate-from-cloudformation`
 *     passes — is accepted too and recorded under the ARN (issue #3627).
 */
export async function importImpl(
  this: WAFv2WebACLProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  if (input.knownPhysicalId) {
    try {
      // CloudFormation's physical id is the compound `name|id|scope`
      // (`--migrate-from-cloudformation` hands it over verbatim), which
      // `parseWebACLArn` cannot read; cdkd's is the ARN (issue #3627).
      const compound = /^([^|]+)\|([^|]+)\|(REGIONAL|CLOUDFRONT)$/.exec(input.knownPhysicalId);
      const { id, name, scope } = compound
        ? { name: compound[1]!, id: compound[2]!, scope: compound[3] as Scope }
        : parseWebACLArn(input.knownPhysicalId);
      if (!id || !name) return null;
      const resp = await this.getClient().send(
        new GetWebACLCommand({ Id: id, Name: name, Scope: scope })
      );
      const arn = resp.WebACL?.ARN;
      if (!arn) return null;
      // Recorded under cdkd's ARN form, which every CRUD path parses, with the
      // map `create()` / `update()` record.
      return {
        physicalId: arn,
        attributes: webAclAttributes(arn, resp.WebACL?.Id, resp.WebACL),
      };
    } catch (err) {
      if (err instanceof WAFNonexistentItemException) return null;
      throw err;
    }
  }

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // DescribeStackResources or the template's physical-name property; a WebACL
  // reaching here needs an explicit `--resource <id>=<arn>` override.
  return null;
}
