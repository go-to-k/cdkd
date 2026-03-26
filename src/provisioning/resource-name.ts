import { createHash } from 'node:crypto';

/**
 * Options for generating a resource name.
 */
export interface ResourceNameOptions {
  /** Maximum length for the name (e.g., 32 for ALB/TG, 64 for IAM, 63 for S3) */
  maxLength: number;
  /** Whether to force lowercase (e.g., S3 buckets) */
  lowercase?: boolean;
  /** Allowed character regex pattern. Characters not matching will be removed.
   *  Default: /[^a-zA-Z0-9-]/ (alphanumeric + hyphen) */
  allowedPattern?: RegExp;
}

/**
 * Generate a unique resource name from the logical ID.
 *
 * When CDK doesn't specify a Name property, CloudFormation auto-generates one
 * like `{StackName}-{LogicalId}-{Hash}`. Since cdkd bypasses CloudFormation,
 * we generate names ourselves.
 *
 * Strategy: If the name fits within maxLength, use as-is (after sanitization).
 * Otherwise, truncate and append a hash suffix for uniqueness.
 *
 * @param name The raw name (from properties or logicalId fallback)
 * @param options Length and character constraints
 * @returns A sanitized, truncated name that fits the constraints
 */
export function generateResourceName(name: string, options: ResourceNameOptions): string {
  const { maxLength, lowercase = false, allowedPattern = /[^a-zA-Z0-9-]/g } = options;

  let sanitized = name.replace(allowedPattern, '-');
  if (lowercase) {
    sanitized = sanitized.toLowerCase();
  }

  // Remove leading/trailing hyphens
  sanitized = sanitized.replace(/^-+|-+$/g, '');

  if (sanitized.length <= maxLength) {
    return sanitized;
  }

  // Truncate with hash suffix for uniqueness
  const hash = createHash('sha256').update(name).digest('hex').substring(0, 8);
  const maxPrefixLength = maxLength - hash.length - 1; // -1 for separator
  const prefix = sanitized.substring(0, maxPrefixLength).replace(/-+$/, '');

  return `${prefix}-${hash}`;
}
