import type { CloudFrontDistributionProvider } from '../cloudfront-distribution-provider.js';
import { TOP_LEVEL_CFN_TO_SDK, REMOVAL_RESET_DEFAULTS } from './shared.js';

/**
 * Build the complete SDK-shape `DistributionConfig` for an update
 * (issue #1371). Per top-level member:
 *
 * - present in the new template          -> template value (authority)
 * - removed since the previous template  -> CloudFormation default
 *   ({@link REMOVAL_RESET_DEFAULTS}); a member with no known default keeps
 *   its live value with a WARN (visible, never a silent decision)
 * - never templated                      -> live value from `currentConfig`
 *   (the AWS-side default filled at create, or an out-of-band setting cdkd
 *   never managed)
 *
 * One deliberate exception to the never-templated rule: `Comment` is
 * always present in `templateSdk` ({@link convertToSdkFormat} injects
 * `''` when absent — the SDK requires a non-null string), so an
 * untemplated Comment resets to `''` rather than keeping the live value.
 * That matches its CFn registry-schema default and the pre-merge
 * behavior.
 *
 * `CallerReference` is always preserved from the current config (a
 * create-time idempotency token the template never carries).
 */
export function mergeUpdateConfig(
  this: CloudFrontDistributionProvider,
  currentConfig: Record<string, unknown>,
  newDistributionConfig: Record<string, unknown>,
  previousDistributionConfig: Record<string, unknown>,
  logicalId: string
): Record<string, unknown> {
  const templateSdk = this.convertToSdkFormat(newDistributionConfig);
  const previousSdk = this.convertToSdkFormat(previousDistributionConfig);

  const merged: Record<string, unknown> = { ...currentConfig };

  for (const key of Object.keys(previousSdk)) {
    // `Object.hasOwn`, not `in` (issue #3515), on BOTH tests and together:
    // `in` answers true for an inherited `Object.prototype` member, so a
    // removed key named `constructor` was skipped as still templated, and
    // fixing only the first test would send it into `structuredClone` of the
    // inherited `Object` function (a DataCloneError) via the second.
    if (Object.hasOwn(templateSdk, key) || key === 'CallerReference') continue;
    if (Object.hasOwn(REMOVAL_RESET_DEFAULTS, key)) {
      merged[key] = structuredClone(REMOVAL_RESET_DEFAULTS[key]);
    } else {
      // Report the key in its CFn/template spelling (the user removes
      // `IPV6Enabled`, not the SDK's `IsIPV6Enabled`).
      const cfnKey =
        Object.entries(TOP_LEVEL_CFN_TO_SDK).find(([, sdkKey]) => sdkKey === key)?.[0] ?? key;
      this.logger.warn(
        `CloudFront Distribution ${logicalId}: '${cfnKey}' was removed from the template but has ` +
          `no known CloudFormation default; keeping the live value. Set the property explicitly ` +
          `in the template to control it.`
      );
    }
  }

  Object.assign(merged, templateSdk);
  merged['CallerReference'] = currentConfig['CallerReference'];
  this.completeRequiredUpdateFields(merged);
  return merged;
}

/**
 * Fill the sub-fields `UpdateDistribution` REQUIRES but a CFn template
 * legitimately omits (issue #1371, second layer). The top-level merge
 * makes the payload complete per member, but the template-authoritative
 * `Origins` / `DefaultCacheBehavior` / `CacheBehaviors` members carry the
 * template's SPARSE sub-shapes, and the API — which accepts them sparse
 * on CREATE — rejects an update with per-field errors ("The
 * 'OriginCustomHeaders' field is missing", "OriginReadTimeout is required
 * for updates", "The parameter SmoothStreaming flag is missing", ...).
 *
 * The set below is the EMPIRICALLY REQUIRED list (probed live against
 * UpdateDistribution, 2026-08-09) plus its symmetric CFn-default
 * companions (`FunctionAssociations` / `TrustedSigners` /
 * `TrustedKeyGroups` — same association/signer family, filled with the
 * same disabled/empty CFn defaults CloudFormation submits for an
 * omitted property). Values a template DOES carry always win — every
 * fill is absent-only. Legacy `ForwardedValues`-mode TTLs are
 * deliberately NOT filled (they are forbidden alongside `CachePolicyId`,
 * so a wrong guess would break the modern mode; a legacy template that
 * needs them fails loudly and can be added here).
 */
export function completeRequiredUpdateFields(
  this: CloudFrontDistributionProvider,
  config: Record<string, unknown>
): void {
  const origins = config['Origins'] as Record<string, unknown> | undefined;
  if (origins && Array.isArray(origins['Items'])) {
    origins['Items'] = (origins['Items'] as Record<string, unknown>[]).map((origin) => {
      const o = { ...origin };
      if (o['OriginPath'] === undefined) o['OriginPath'] = '';
      if (o['CustomHeaders'] === undefined) o['CustomHeaders'] = { Quantity: 0, Items: [] };
      if (o['CustomOriginConfig'] && typeof o['CustomOriginConfig'] === 'object') {
        const c = { ...(o['CustomOriginConfig'] as Record<string, unknown>) };
        if (c['OriginReadTimeout'] === undefined) c['OriginReadTimeout'] = 30;
        if (c['OriginKeepaliveTimeout'] === undefined) c['OriginKeepaliveTimeout'] = 5;
        o['CustomOriginConfig'] = c;
      }
      return o;
    });
  }

  const fillBehavior = (behavior: Record<string, unknown>): Record<string, unknown> => {
    const b = { ...behavior };
    if (b['SmoothStreaming'] === undefined) b['SmoothStreaming'] = false;
    if (b['FieldLevelEncryptionId'] === undefined) b['FieldLevelEncryptionId'] = '';
    if (b['LambdaFunctionAssociations'] === undefined) {
      b['LambdaFunctionAssociations'] = { Quantity: 0, Items: [] };
    }
    if (b['FunctionAssociations'] === undefined) {
      b['FunctionAssociations'] = { Quantity: 0, Items: [] };
    }
    if (b['TrustedSigners'] === undefined) {
      b['TrustedSigners'] = { Enabled: false, Quantity: 0 };
    }
    if (b['TrustedKeyGroups'] === undefined) {
      b['TrustedKeyGroups'] = { Enabled: false, Quantity: 0 };
    }
    if (b['AllowedMethods'] === undefined) {
      b['AllowedMethods'] = {
        Quantity: 2,
        Items: ['GET', 'HEAD'],
        CachedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] },
      };
    } else if (
      b['AllowedMethods'] &&
      typeof b['AllowedMethods'] === 'object' &&
      (b['AllowedMethods'] as Record<string, unknown>)['CachedMethods'] === undefined
    ) {
      // Template carried AllowedMethods but no CachedMethods sibling —
      // fill the nested CFn default (GET, HEAD).
      b['AllowedMethods'] = {
        ...(b['AllowedMethods'] as Record<string, unknown>),
        CachedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] },
      };
    }
    return b;
  };

  if (config['DefaultCacheBehavior'] && typeof config['DefaultCacheBehavior'] === 'object') {
    config['DefaultCacheBehavior'] = fillBehavior(
      config['DefaultCacheBehavior'] as Record<string, unknown>
    );
  }
  const cacheBehaviors = config['CacheBehaviors'] as Record<string, unknown> | undefined;
  if (cacheBehaviors && Array.isArray(cacheBehaviors['Items'])) {
    cacheBehaviors['Items'] = (cacheBehaviors['Items'] as Record<string, unknown>[]).map((cb) =>
      fillBehavior(cb)
    );
  }
}
