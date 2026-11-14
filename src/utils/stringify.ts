/**
 * Attribute names whose VALUES must never reach a log line, even at debug
 * level. `Fn::GetAtt` resolution debug-logs the resolved value, and some
 * attributes carry live long-lived credentials — the first was
 * `AWS::IAM::AccessKey.SecretAccessKey` (issue #1323), where a `--verbose`
 * deploy (or a CI log) would otherwise print a usable IAM secret key.
 * Matched against the ATTRIBUTE NAME (not the value), so legitimate
 * non-secret attributes keep full debug output.
 */
const SENSITIVE_ATTRIBUTE_NAME = /secret|password|credential/i;

/**
 * Names that MATCH the sensitive pattern but denote identifiers, not the
 * credential material itself (`SecretArn`, `MasterUserSecret.SecretArn`,
 * `SecretId`, ...). ARNs / ids are load-bearing debug output — redacting them
 * would hurt debuggability without protecting anything.
 */
const NON_SENSITIVE_SUFFIX = /(arn|id|name|url|alias|status)$/i;

/**
 * Whether an attribute NAME looks credential-bearing (see
 * {@link SENSITIVE_ATTRIBUTE_NAME}) — the one predicate behind
 * {@link stringifyAttributeForLog}, shared so a reader deciding whether to
 * SERVE such a value cannot disagree with the one deciding whether to print it.
 */
export function isSensitiveAttributeName(attributeName: string): boolean {
  return SENSITIVE_ATTRIBUTE_NAME.test(attributeName) && !NON_SENSITIVE_SUFFIX.test(attributeName);
}

/**
 * Attributes whose recorded VALUE is a secret although their NAME does not
 * pass `isSensitiveAttributeName` — so the name rule cannot see them. Keyed by
 * resource type, read by own key. `AWS::AppSync::ApiKey`'s `ApiKey` is the
 * `x-api-key` value itself, recorded in plaintext at create.
 * `AWS::EC2::IpamExternalResourceVerificationToken`'s `TokenValue` is a
 * credential Cloud Control records in plaintext (`cloud-control-provider.ts`);
 * that type has no `getAttribute`, so every read of it reaches `--force`'s
 * cache fallback. `AWS::IVS::StreamKey`'s `Value` is the stream key itself
 * (Cloud-Control-routed; `docs/_generated/provider-coverage.json` lists it).
 */
const SECRET_VALUED_ATTRIBUTES: ReadonlyMap<string, readonly string[]> = new Map([
  ['AWS::AppSync::ApiKey', ['ApiKey']],
  ['AWS::EC2::IpamExternalResourceVerificationToken', ['TokenValue']],
  ['AWS::IVS::StreamKey', ['Value']],
]);

/**
 * Whether `attribute` of `resourceType` records a secret VALUE under a name
 * {@link isSensitiveAttributeName} cannot see (see the map above).
 */
export function isSecretValuedAttribute(
  resourceType: string | undefined,
  attribute: string
): boolean {
  if (resourceType === undefined) return false;
  return SECRET_VALUED_ATTRIBUTES.get(resourceType)?.includes(attribute) === true;
}

/**
 * Render an attribute value for a debug log line, redacting values whose
 * attribute name looks credential-bearing (see
 * {@link SENSITIVE_ATTRIBUTE_NAME}).
 */
export function stringifyAttributeForLog(attributeName: string, value: unknown): string {
  if (isSensitiveAttributeName(attributeName)) {
    return '<redacted>';
  }
  return stringifyValue(value);
}

export function stringifyValue(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    case 'symbol':
      return value.toString();
    case 'undefined':
      return 'undefined';
    case 'function':
      return value.name ? `[Function: ${value.name}]` : '[Function]';
    case 'object':
      if (value === null) return 'null';
      try {
        const json = JSON.stringify(value);
        if (json !== undefined) return json;
      } catch {
        // Fall through to a stable object tag when JSON serialization fails.
      }
      return Object.prototype.toString.call(value);
  }
}
