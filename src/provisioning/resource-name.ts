import { createHash } from 'node:crypto';

/**
 * Current stack name for resource name generation.
 * Set by deploy-engine before provisioning resources.
 */
let currentStackName: string | undefined;

/**
 * Set the current stack name for resource name generation.
 */
export function setCurrentStackName(stackName: string): void {
  currentStackName = stackName;
}

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
 * Generates names in CloudFormation-compatible format:
 * `{StackName}-{LogicalId}-{Hash}` (truncated to maxLength).
 *
 * @param name The raw name (from properties or logicalId fallback)
 * @param options Length and character constraints
 * @returns A sanitized, truncated name that fits the constraints
 */
export function generateResourceName(name: string, options: ResourceNameOptions): string {
  const { maxLength, lowercase = false, allowedPattern = /[^a-zA-Z0-9-]/g } = options;

  // Include stack name for uniqueness (like CloudFormation does)
  const fullName = currentStackName ? `${currentStackName}-${name}` : name;

  let sanitized = fullName.replace(allowedPattern, '-');
  if (lowercase) {
    sanitized = sanitized.toLowerCase();
  }

  // Remove leading/trailing hyphens
  sanitized = sanitized.replace(/^-+|-+$/g, '');

  if (sanitized.length <= maxLength) {
    return sanitized;
  }

  // Truncate with hash suffix for uniqueness
  const hash = createHash('sha256').update(fullName).digest('hex').substring(0, 8);
  const maxPrefixLength = maxLength - hash.length - 1; // -1 for separator
  const prefix = sanitized.substring(0, maxPrefixLength).replace(/-+$/, '');

  return `${prefix}-${hash}`;
}
