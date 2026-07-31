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
 * Render an attribute value for a debug log line, redacting values whose
 * attribute name looks credential-bearing (see
 * {@link SENSITIVE_ATTRIBUTE_NAME}).
 */
export function stringifyAttributeForLog(attributeName: string, value: unknown): string {
  if (SENSITIVE_ATTRIBUTE_NAME.test(attributeName) && !NON_SENSITIVE_SUFFIX.test(attributeName)) {
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
