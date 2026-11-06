import { isPlainImportValue, VALUE_NOT_SHOWN } from '../../import-helpers.js';

/**
 * A distribution id as the lines naming `--resource-timeout`, `--full-wait`
 * or an `aws` command print it: itself when plain, described otherwise
 * (go-to-k/cdkd#4295). It is the `state.json` physical id, which nothing
 * validates, and printed raw beside a pasteable flag its `$( )` ran.
 */
export function shownId(id: string): string {
  return isPlainImportValue(id) ? id : VALUE_NOT_SHOWN;
}

/**
 * Top-level `DistributionConfig` fields that are a BARE ARRAY in the CFn
 * template but a `{ Quantity, Items }` wrapper in the SDK shape — so
 * `convertToSdkFormat` wraps them and `convertToCfnFormat` unwraps them.
 *
 * `OriginGroups` is deliberately NOT here (issue #873): unlike `Origins` /
 * `CacheBehaviors` / `Aliases` / `CustomErrorResponses` (bare lists in CFn), the
 * CFn `DistributionConfig.OriginGroups` property is ITSELF a `{ Quantity, Items }`
 * object, and so are its nested `Members` and `FailoverCriteria.StatusCodes`.
 * CDK synthesizes that full `{ Quantity, Items }` shape and `GetDistributionConfig`
 * returns the same, so OriginGroups must pass through UNTOUCHED in both
 * directions — unwrapping it (it was incorrectly listed here before) turned the
 * read-back OriginGroups into a bare array that no longer matched the template's
 * `{ Quantity, Items }`, firing phantom drift.
 */
export const QUANTITY_ITEM_FIELDS = [
  'Origins',
  'CacheBehaviors',
  'CustomErrorResponses',
  'Aliases',
];

/**
 * A CloudFront exception class that says a referenced entity is missing
 * (`EntityNotFound`, `NoSuch*`, `TrustedKeyGroupDoesNotExist`, ...), checked
 * against `UpdateDistributionCommand`'s `@throws` (go-to-k/cdkd#5222).
 */
export const DEPENDENCY_MISSING_CLASS = /NotFound|^NoSuch|DoesNotExist/;

/**
 * `ViewerCertificate` members whose ACRONYM CASING differs between the CFn
 * resource schema and the CloudFront API (issue #1370). The CFn template
 * carries the left-hand spelling; the SDK model only knows the right-hand
 * one, so an unrenamed key silently never reaches AWS — a custom-domain
 * distribution then fails to create ("Your ViewerCertificate is missing one
 * of ACMCertificateArn, IAMCertificateId, or CloudFrontDefaultCertificate").
 */
export const VIEWER_CERTIFICATE_CFN_TO_SDK: Record<string, string> = {
  AcmCertificateArn: 'ACMCertificateArn',
  SslSupportMethod: 'SSLSupportMethod',
  IamCertificateId: 'IAMCertificateId',
};

/**
 * Top-level `DistributionConfig` members with the same CFn-vs-SDK casing
 * divergence (issue #1370): the template's `IPV6Enabled` is `IsIPV6Enabled`
 * in the SDK model, so it was silently dropped (IPv6 ended up disabled).
 */
export const TOP_LEVEL_CFN_TO_SDK: Record<string, string> = {
  IPV6Enabled: 'IsIPV6Enabled',
};

/**
 * CloudFormation defaults applied when a top-level `DistributionConfig`
 * member present in the PREVIOUS template is REMOVED from the new one
 * (issue #1371). `UpdateDistribution` is a read-modify-write API taking the
 * complete config, so the update path merges the template over the live
 * config — but a member the user deleted from the template must reset to
 * its CloudFormation default (CFn semantics), not silently keep its live
 * value. Values are in SDK shape.
 *
 * Sources: the AWS::CloudFront::Distribution registry schema `default`
 * annotations (Comment / DefaultRootObject / HttpVersion / PriceClass /
 * Restrictions / ViewerCertificate / WebACLId — verified via
 * `cloudformation:DescribeType`, 2026-08-09); list members reset to the
 * empty `{ Quantity: 0, Items: [] }` wrapper (removing a list property
 * means "no items"); `Logging` to the API's documented off shape. Removed
 * members with NO entry here (e.g. `IsIPV6Enabled` / `Staging` — no
 * schema-documented default) keep their live value with a warning: a
 * visible conservative choice, never a silent guess.
 */
export const REMOVAL_RESET_DEFAULTS: Record<string, unknown> = {
  Aliases: { Quantity: 0, Items: [] },
  CacheBehaviors: { Quantity: 0, Items: [] },
  Comment: '',
  CustomErrorResponses: { Quantity: 0, Items: [] },
  DefaultRootObject: '',
  HttpVersion: 'http1.1',
  Logging: { Enabled: false, IncludeCookies: false, Bucket: '', Prefix: '' },
  OriginGroups: { Quantity: 0, Items: [] },
  PriceClass: 'PriceClass_All',
  Restrictions: { GeoRestriction: { RestrictionType: 'none', Quantity: 0, Items: [] } },
  ViewerCertificate: { CloudFrontDefaultCertificate: true },
  WebACLId: '',
};

/**
 * Nested fields inside each CacheBehavior / DefaultCacheBehavior that use
 * the Quantity + Items pattern.
 */
export const CACHE_BEHAVIOR_QUANTITY_FIELDS = [
  'AllowedMethods',
  'CachedMethods',
  'LambdaFunctionAssociations',
  'FunctionAssociations',
  'ForwardedValues.Headers',
  'ForwardedValues.QueryStringCacheKeys',
  'ForwardedValues.Cookies.WhitelistedNames',
  'TrustedSigners',
  'TrustedKeyGroups',
];

/**
 * The cache-behavior wrappers whose SDK shape carries a derived `Enabled`
 * beside `{ Quantity, Items }` (issue #5393).
 */
export const TRUSTED_SIGNER_FIELDS = ['TrustedSigners', 'TrustedKeyGroups'] as const;
