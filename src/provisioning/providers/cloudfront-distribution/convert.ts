import type { CloudFrontDistributionProvider } from '../cloudfront-distribution-provider.js';
import {
  QUANTITY_ITEM_FIELDS,
  VIEWER_CERTIFICATE_CFN_TO_SDK,
  TOP_LEVEL_CFN_TO_SDK,
  CACHE_BEHAVIOR_QUANTITY_FIELDS,
  TRUSTED_SIGNER_FIELDS,
} from './shared.js';

/**
 * Convert CDK/CloudFormation DistributionConfig format to SDK format.
 *
 * The main transformation is adding Quantity fields where the SDK expects
 * the { Quantity: N, Items: [...] } pattern, while CDK templates typically
 * provide just the Items array or an object with only Items.
 */
export function convertToSdkFormat(
  this: CloudFrontDistributionProvider,
  config: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...config };

  // Ensure Comment is never null (SDK requires non-null string)
  if (result['Comment'] === null || result['Comment'] === undefined) {
    result['Comment'] = '';
  }

  // CFn -> SDK acronym-casing renames (issue #1370): top-level
  // IPV6Enabled -> IsIPV6Enabled, plus the three ViewerCertificate members.
  for (const [cfnKey, sdkKey] of Object.entries(TOP_LEVEL_CFN_TO_SDK)) {
    if (result[cfnKey] !== undefined) {
      result[sdkKey] = result[cfnKey];
      delete result[cfnKey];
    }
  }
  if (result['ViewerCertificate'] && typeof result['ViewerCertificate'] === 'object') {
    const viewerCertificate = { ...(result['ViewerCertificate'] as Record<string, unknown>) };
    for (const [cfnKey, sdkKey] of Object.entries(VIEWER_CERTIFICATE_CFN_TO_SDK)) {
      if (viewerCertificate[cfnKey] !== undefined) {
        viewerCertificate[sdkKey] = viewerCertificate[cfnKey];
        delete viewerCertificate[cfnKey];
      }
    }
    result['ViewerCertificate'] = viewerCertificate;
  }

  // CFn Restrictions.GeoRestriction carries a bare `Locations` array; the
  // SDK shape is { RestrictionType, Quantity, Items } with Quantity
  // REQUIRED even when zero (issue #1370, same class as the casing gaps).
  if (result['Restrictions'] && typeof result['Restrictions'] === 'object') {
    const restrictions = { ...(result['Restrictions'] as Record<string, unknown>) };
    if (restrictions['GeoRestriction'] && typeof restrictions['GeoRestriction'] === 'object') {
      const geo = { ...(restrictions['GeoRestriction'] as Record<string, unknown>) };
      if (Array.isArray(geo['Locations'])) {
        geo['Items'] = geo['Locations'];
        delete geo['Locations'];
      }
      if (geo['Quantity'] === undefined) {
        geo['Quantity'] = Array.isArray(geo['Items']) ? (geo['Items'] as unknown[]).length : 0;
      }
      restrictions['GeoRestriction'] = geo;
    }
    result['Restrictions'] = restrictions;
  }

  // Ensure Logging has IncludeCookies and Enabled defaults. Copy before
  // filling: the update path now runs state-sourced previousProperties
  // through this method too, and an in-place fill would mutate the caller's
  // nested object.
  if (result['Logging'] && typeof result['Logging'] === 'object') {
    const logging = { ...(result['Logging'] as Record<string, unknown>) };
    if (logging['IncludeCookies'] === undefined) logging['IncludeCookies'] = false;
    if (logging['Enabled'] === undefined) logging['Enabled'] = true;
    if (logging['Prefix'] === undefined) logging['Prefix'] = '';
    result['Logging'] = logging;
  }

  // Convert top-level Quantity + Items fields
  for (const field of QUANTITY_ITEM_FIELDS) {
    if (result[field] !== undefined) {
      result[field] = this.wrapWithQuantity(result[field]);
    }
  }

  // Convert nested Quantity + Items fields inside DefaultCacheBehavior
  if (result['DefaultCacheBehavior'] && typeof result['DefaultCacheBehavior'] === 'object') {
    result['DefaultCacheBehavior'] = this.convertCacheBehavior(
      result['DefaultCacheBehavior'] as Record<string, unknown>
    );
  }

  // Convert nested Quantity + Items fields inside each CacheBehavior.
  // Copy the wrapper first: when the input ALREADY carries { Quantity,
  // Items } (wrapWithQuantity returns it as-is), an in-place Items
  // reassignment would mutate the caller-owned object — same hazard the
  // Logging copy above closes.
  if (result['CacheBehaviors'] && typeof result['CacheBehaviors'] === 'object') {
    const cacheBehaviors = { ...(result['CacheBehaviors'] as Record<string, unknown>) };
    if (Array.isArray(cacheBehaviors['Items'])) {
      cacheBehaviors['Items'] = (cacheBehaviors['Items'] as Record<string, unknown>[]).map((cb) =>
        this.convertCacheBehavior(cb)
      );
    }
    result['CacheBehaviors'] = cacheBehaviors;
  }

  // Convert Origins items - nested Quantity + Items fields (e.g., CustomHeaders)
  if (result['Origins'] && typeof result['Origins'] === 'object') {
    const origins = { ...(result['Origins'] as Record<string, unknown>) };
    if (Array.isArray(origins['Items'])) {
      origins['Items'] = (origins['Items'] as Record<string, unknown>[]).map((origin) =>
        this.convertOrigin(origin)
      );
    }
    result['Origins'] = origins;
  }

  return result;
}

/**
 * Invert {@link convertToSdkFormat}: map an AWS-returned SDK-shape
 * `DistributionConfig` ({@link GetDistributionConfigCommand} output) back
 * into the CloudFormation `DistributionConfig` shape cdkd state stores.
 *
 * The inversion is the mirror image of the create / update conversion:
 * every `{ Quantity, Items }` wrapper becomes its bare `Items` array
 * (top-level list fields + the nested cache-behavior / origin fields),
 * and `CallerReference` is dropped (a create-time idempotency token CDK
 * never templates — see `getDriftUnknownPaths`).
 *
 * Lossiness note: the conversion is NOT perfectly lossless because
 * `convertToSdkFormat` injects SDK-required defaults the CFn template may
 * omit (`Comment: ''`, `Logging.{Enabled,IncludeCookies,Prefix}`,
 * `CustomOriginConfig.HTTP{,S}Port`). Those defaults are preserved on the
 * inverted side, which is correct for the drift comparator: the
 * deploy-time observed baseline (also produced by THIS method) carries the
 * same defaults, so they compare equal. They would only matter against the
 * `properties` fallback baseline (resources with no observedProperties),
 * where an AWS-injected default the template omitted is legitimately a
 * key cdkd never set — but the comparator's state-keys-only walk in that
 * mode never descends into a key absent from the template, so the extra
 * defaults cannot fire false drift there either.
 */
export function convertToCfnFormat(
  this: CloudFrontDistributionProvider,
  config: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...config };

  // Drop the create-time idempotency token (never templated by CDK).
  delete result['CallerReference'];

  // SDK -> CFn acronym-casing inversions (issue #1370). Without these the
  // drift comparator would diff the template's `AcmCertificateArn` /
  // `IPV6Enabled` against the API's `ACMCertificateArn` / `IsIPV6Enabled`
  // and report phantom drift on every read.
  for (const [cfnKey, sdkKey] of Object.entries(TOP_LEVEL_CFN_TO_SDK)) {
    if (result[sdkKey] !== undefined) {
      result[cfnKey] = result[sdkKey];
      delete result[sdkKey];
    }
  }
  if (result['ViewerCertificate'] && typeof result['ViewerCertificate'] === 'object') {
    const viewerCertificate = { ...(result['ViewerCertificate'] as Record<string, unknown>) };
    for (const [cfnKey, sdkKey] of Object.entries(VIEWER_CERTIFICATE_CFN_TO_SDK)) {
      if (viewerCertificate[sdkKey] !== undefined) {
        viewerCertificate[cfnKey] = viewerCertificate[sdkKey];
        delete viewerCertificate[sdkKey];
      }
    }
    result['ViewerCertificate'] = viewerCertificate;
  }

  // Invert the GeoRestriction shape conversion: SDK { RestrictionType,
  // Quantity, Items } back to the CFn { RestrictionType, Locations } form.
  if (result['Restrictions'] && typeof result['Restrictions'] === 'object') {
    const restrictions = { ...(result['Restrictions'] as Record<string, unknown>) };
    if (restrictions['GeoRestriction'] && typeof restrictions['GeoRestriction'] === 'object') {
      const geo = { ...(restrictions['GeoRestriction'] as Record<string, unknown>) };
      if (Array.isArray(geo['Items'])) {
        geo['Locations'] = geo['Items'];
        delete geo['Items'];
      }
      delete geo['Quantity'];
      restrictions['GeoRestriction'] = geo;
    }
    result['Restrictions'] = restrictions;
  }

  // Unwrap top-level Quantity + Items fields back to bare arrays.
  for (const field of QUANTITY_ITEM_FIELDS) {
    if (result[field] !== undefined) {
      result[field] = this.unwrapQuantity(result[field]);
    }
  }

  // Unwrap nested Quantity + Items inside DefaultCacheBehavior.
  if (result['DefaultCacheBehavior'] && typeof result['DefaultCacheBehavior'] === 'object') {
    result['DefaultCacheBehavior'] = this.revertCacheBehavior(
      result['DefaultCacheBehavior'] as Record<string, unknown>
    );
  }

  // Unwrap nested Quantity + Items inside each CacheBehavior (now a bare array).
  if (Array.isArray(result['CacheBehaviors'])) {
    result['CacheBehaviors'] = (result['CacheBehaviors'] as Record<string, unknown>[]).map((cb) =>
      this.revertCacheBehavior(cb)
    );
  }

  // Unwrap nested Quantity + Items inside each Origin (now a bare array).
  if (Array.isArray(result['Origins'])) {
    result['Origins'] = (result['Origins'] as Record<string, unknown>[]).map((origin) =>
      this.revertOrigin(origin)
    );
  }

  return result;
}

/**
 * Inverse of {@link wrapWithQuantity}: a `{ Quantity, Items }` object
 * becomes its bare `Items` array; anything else is returned unchanged.
 */
export function unwrapQuantity(this: CloudFrontDistributionProvider, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj['Items'])) {
      return obj['Items'];
    }
  }
  return value;
}

/**
 * Inverse of {@link convertCacheBehavior}: unwrap the Quantity + Items
 * fields nested inside a CacheBehavior back to bare arrays.
 */
export function revertCacheBehavior(
  this: CloudFrontDistributionProvider,
  behavior: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...behavior };

  // AWS nests `CachedMethods` INSIDE the `AllowedMethods` wrapper
  // ({ Quantity, Items, CachedMethods: { Quantity, Items } }), whereas the
  // CFn shape carries them as SIBLINGS (AllowedMethods + CachedMethods both
  // bare arrays — `convertToSdkFormat` only wraps the two CFn arrays
  // independently and never re-nests). Hoist CachedMethods back out to a
  // sibling before the generic unwrap so the inverted shape matches CFn and
  // a console-side CachedMethods change stays detectable.
  if (result['AllowedMethods'] && typeof result['AllowedMethods'] === 'object') {
    const allowed = result['AllowedMethods'] as Record<string, unknown>;
    if (allowed['CachedMethods'] !== undefined && result['CachedMethods'] === undefined) {
      result['CachedMethods'] = allowed['CachedMethods'];
      const allowedCopy = { ...allowed };
      delete allowedCopy['CachedMethods'];
      result['AllowedMethods'] = allowedCopy;
    }
  }

  for (const fieldPath of CACHE_BEHAVIOR_QUANTITY_FIELDS) {
    // A TrustedSigners / TrustedKeyGroups wrapper whose `Enabled` disagrees
    // with its list (e.g. a signer restriction switched off out of band
    // while the key groups stay listed) has no CFn spelling: keep the raw
    // wrapper so drift reports it instead of reading back the bare list
    // the template declares (issue #5393).
    if ((TRUSTED_SIGNER_FIELDS as readonly string[]).includes(fieldPath)) {
      const w = result[fieldPath];
      if (w && typeof w === 'object' && !Array.isArray(w)) {
        const obj = w as Record<string, unknown>;
        const items = obj['Items'];
        if (
          Array.isArray(items) &&
          typeof obj['Enabled'] === 'boolean' &&
          obj['Enabled'] !== items.length > 0
        ) {
          continue;
        }
      }
    }
    const parts = fieldPath.split('.');
    this.unwrapQuantityAtPath(result, parts);
  }

  return result;
}

/**
 * Inverse of {@link convertOrigin}: unwrap CustomHeaders and
 * CustomOriginConfig.OriginSslProtocols back to bare arrays.
 */
export function revertOrigin(
  this: CloudFrontDistributionProvider,
  origin: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...origin };

  if (result['CustomHeaders'] !== undefined) {
    // Unwrap AND restore the CFn spelling (`OriginCustomHeaders`) so the
    // drift comparator sees the template's key (issue #1373, same
    // pattern as `OriginSSLProtocols` below).
    result['OriginCustomHeaders'] = this.unwrapQuantity(result['CustomHeaders']);
    delete result['CustomHeaders'];
  }

  if (result['CustomOriginConfig'] && typeof result['CustomOriginConfig'] === 'object') {
    const customOriginConfig = { ...(result['CustomOriginConfig'] as Record<string, unknown>) };
    if (customOriginConfig['OriginSslProtocols'] !== undefined) {
      // Unwrap AND restore the CFn spelling (`OriginSSLProtocols`) so the
      // drift comparator sees the template's key (issue #1370).
      customOriginConfig['OriginSSLProtocols'] = this.unwrapQuantity(
        customOriginConfig['OriginSslProtocols']
      );
      delete customOriginConfig['OriginSslProtocols'];
    }
    result['CustomOriginConfig'] = customOriginConfig;
  }

  return result;
}

/**
 * Inverse of {@link applyQuantityAtPath}: unwrap a `{ Quantity, Items }`
 * value at a nested path (e.g. "ForwardedValues.Headers") back to a bare
 * array.
 */
export function unwrapQuantityAtPath(
  this: CloudFrontDistributionProvider,
  obj: Record<string, unknown>,
  path: string[]
): void {
  if (path.length === 0) return;

  if (path.length === 1) {
    const key = path[0]!;
    if (obj[key] !== undefined) {
      obj[key] = this.unwrapQuantity(obj[key]);
    }
    return;
  }

  const [head, ...rest] = path;
  const headKey = head!;
  if (obj[headKey] && typeof obj[headKey] === 'object') {
    const nested = { ...(obj[headKey] as Record<string, unknown>) };
    obj[headKey] = nested;
    this.unwrapQuantityAtPath(nested, rest);
  }
}

/**
 * Wrap a value with the Quantity + Items pattern if needed.
 *
 * Handles three cases:
 * - Array: wrap as { Quantity: len, Items: array }
 * - Object with Items but no Quantity: add Quantity
 * - Already has Quantity: leave as-is
 */
export function wrapWithQuantity(this: CloudFrontDistributionProvider, value: unknown): unknown {
  if (Array.isArray(value)) {
    return { Quantity: value.length, Items: value };
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj['Items']) && obj['Quantity'] === undefined) {
      return { ...obj, Quantity: (obj['Items'] as unknown[]).length };
    }
  }

  return value;
}

/**
 * Convert Quantity + Items fields nested inside a CacheBehavior.
 */
export function convertCacheBehavior(
  this: CloudFrontDistributionProvider,
  behavior: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...behavior };

  for (const fieldPath of CACHE_BEHAVIOR_QUANTITY_FIELDS) {
    const parts = fieldPath.split('.');
    this.applyQuantityAtPath(result, parts);
  }

  // CFn declares `TrustedSigners` / `TrustedKeyGroups` as bare string lists,
  // but the API's wrappers also REQUIRE `Enabled`: a `{ Quantity, Items }`
  // without it is refused as MalformedXML ("Value null at
  // '...trustedKeyGroups.enabled' ... must not be null"), measured against
  // CreateDistribution 2026-10-27 (issue #5393). CFn derives it from the
  // list: a non-empty list restricts viewer access (Enabled: true), an empty
  // one does not (`Enabled: true` with an empty list is refused as
  // InvalidArgument). The CFn schema has no `Enabled` member, so it is
  // ALWAYS derived: a value smuggled in through a non-CFn object shape can
  // neither lift a declared restriction nor enable an empty one.
  for (const key of TRUSTED_SIGNER_FIELDS) {
    const wrapper = result[key];
    if (wrapper && typeof wrapper === 'object' && !Array.isArray(wrapper)) {
      const w = wrapper as Record<string, unknown>;
      // The listed entries decide, not a `Quantity` an object shape carried
      // in (wrapWithQuantity keeps one already present) — and they set
      // `Quantity` too, so the wrapper is never self-inconsistent.
      const items = w['Items'];
      if (Array.isArray(items)) {
        result[key] = { ...w, Quantity: items.length, Enabled: items.length > 0 };
      } else if (typeof w['Quantity'] === 'number') {
        result[key] = { ...w, Enabled: w['Quantity'] > 0 };
      }
    }
  }

  // The CFn shape carries `AllowedMethods` and `CachedMethods` as SIBLING
  // arrays; the SDK nests CachedMethods INSIDE the AllowedMethods wrapper
  // and has no top-level CachedMethods member — an un-nested sibling was
  // silently dropped by the serializer (issue #1370 shape class).
  // `revertCacheBehavior` has always hoisted it back OUT for drift reads;
  // this is the missing forward direction.
  if (result['CachedMethods'] !== undefined) {
    // CachedMethods with NO AllowedMethods sibling is legal CFn
    // (AllowedMethods defaults to GET, HEAD) — synthesize the default
    // wrapper so the nested value still reaches the SDK.
    const allowedMethods: Record<string, unknown> =
      result['AllowedMethods'] && typeof result['AllowedMethods'] === 'object'
        ? { ...(result['AllowedMethods'] as Record<string, unknown>) }
        : { Quantity: 2, Items: ['GET', 'HEAD'] };
    allowedMethods['CachedMethods'] = result['CachedMethods'];
    result['AllowedMethods'] = allowedMethods;
    delete result['CachedMethods'];
  }

  return result;
}

/**
 * Convert nested Quantity + Items fields inside an Origin.
 * Handles CustomHeaders and S3OriginConfig/CustomOriginConfig nested fields.
 */
export function convertOrigin(
  this: CloudFrontDistributionProvider,
  origin: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...origin };

  // The CFn template spelling is `OriginCustomHeaders` (a bare
  // `{HeaderName, HeaderValue}[]`); the SDK member is `CustomHeaders`
  // (issue #1373 nested-key critic catch — before this rename a
  // template's origin custom headers never reached AWS, and the update
  // path's required-field fill actively wiped them with an empty
  // `{Quantity: 0}` wrapper). Rename BEFORE the wrap below.
  if (result['OriginCustomHeaders'] !== undefined) {
    result['CustomHeaders'] = result['OriginCustomHeaders'];
    delete result['OriginCustomHeaders'];
  }

  // CustomHeaders uses the Quantity + Items pattern
  if (result['CustomHeaders'] !== undefined) {
    result['CustomHeaders'] = this.wrapWithQuantity(result['CustomHeaders']);
  }

  // S3OriginConfig does not need Quantity wrapping (it's a simple object)
  // CustomOriginConfig.OriginSslProtocols uses Quantity + Items
  if (result['CustomOriginConfig'] && typeof result['CustomOriginConfig'] === 'object') {
    const customOriginConfig = { ...(result['CustomOriginConfig'] as Record<string, unknown>) };
    // The CFn template spelling is `OriginSSLProtocols` (capital SSL);
    // the SDK member is `OriginSslProtocols` (issue #1370 casing class —
    // before this rename the wrap below could never match a real
    // template and the protocol list was silently dropped).
    if (customOriginConfig['OriginSSLProtocols'] !== undefined) {
      customOriginConfig['OriginSslProtocols'] = customOriginConfig['OriginSSLProtocols'];
      delete customOriginConfig['OriginSSLProtocols'];
    }
    if (customOriginConfig['OriginSslProtocols'] !== undefined) {
      customOriginConfig['OriginSslProtocols'] = this.wrapWithQuantity(
        customOriginConfig['OriginSslProtocols']
      );
    }
    // Ensure HTTPPort and HTTPSPort have defaults (SDK requires non-null values)
    if (customOriginConfig['HTTPPort'] === null || customOriginConfig['HTTPPort'] === undefined) {
      customOriginConfig['HTTPPort'] = 80;
    }
    if (customOriginConfig['HTTPSPort'] === null || customOriginConfig['HTTPSPort'] === undefined) {
      customOriginConfig['HTTPSPort'] = 443;
    }
    result['CustomOriginConfig'] = customOriginConfig;
  }

  return result;
}

/**
 * Apply Quantity wrapping at a nested path (e.g., "ForwardedValues.Headers").
 */
export function applyQuantityAtPath(
  this: CloudFrontDistributionProvider,
  obj: Record<string, unknown>,
  path: string[]
): void {
  if (path.length === 0) return;

  if (path.length === 1) {
    const key = path[0]!;
    if (obj[key] !== undefined) {
      obj[key] = this.wrapWithQuantity(obj[key]);
    }
    return;
  }

  const [head, ...rest] = path;
  const headKey = head!;
  if (obj[headKey] && typeof obj[headKey] === 'object') {
    // Shallow copy the nested object to avoid mutating the original
    const nested = { ...(obj[headKey] as Record<string, unknown>) };
    obj[headKey] = nested;
    this.applyQuantityAtPath(nested, rest);
  }
}
