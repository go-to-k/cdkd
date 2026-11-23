import { isAwsAuthoredFailure } from '../../../utils/aws-failure-text.js';
import { removeProtectionTypes } from '../../../provisioning/remove-protection-types.js';

/**
 * The phrases AWS uses when it refuses a delete because the resource's own
 * protection flag is on (issue #6855). Each needs its separator, so a logical
 * id such as `DeletionProtectionTable` echoed into a message does not match.
 */
const PROTECTION_REFUSAL_TEXT =
  /\bdeletion[ -]protection\b|\btermination[ -]protection\b|\bprotected against deletion\b|\bdisableApiTermination\b|\bprevent-all-deletion\b/i;

/** How deep the cause chain is walked; a provider wraps the SDK error once or twice. */
const MAX_CAUSE_DEPTH = 8;

/**
 * Whether a link's text was written by AWS: an SDK service error, or a Cloud
 * Control handler's failure, whose message carries the handler's
 * `StatusMessage`. cdkd's own wrappers interpolate template values, so their
 * text is never read here.
 */
function isAwsWrittenLink(link: Error): boolean {
  return isAwsAuthoredFailure(link) || link.name === 'CloudControlOperationFailedError';
}

/** True when AWS refused the delete because the resource's protection flag is on. */
export function isProtectionRefusal(error: unknown): boolean {
  let link: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && link instanceof Error; depth++) {
    if (isAwsWrittenLink(link) && PROTECTION_REFUSAL_TEXT.test(link.message)) return true;
    link = link.cause;
  }
  return false;
}

/**
 * The line a destroy prints under a delete AWS refused for the resource's
 * deletion protection (issue #6855). The failure itself shows only AWS's
 * error code, as AWS text is withheld below `--verbose`, so without this the
 * reader learns neither the cause nor the flag that removes it. The text is
 * cdkd's own and quotes nothing AWS wrote.
 *
 * `undefined` when `--remove-protection` was already passed (the flip ran and
 * the delete failed anyway, so the flag is not the way out), for a type the
 * flag does not cover, or when the failure is not a protection refusal.
 */
export function protectionRefusalHint(
  error: unknown,
  resourceType: string,
  removeProtection: boolean | undefined
): string | undefined {
  if (removeProtection === true) return undefined;
  if (!removeProtectionTypes().includes(resourceType)) return undefined;
  if (!isProtectionRefusal(error)) return undefined;
  return (
    'AWS refused the delete because deletion protection is on for this resource. ' +
    'Re-run the destroy with --remove-protection to turn it off and delete it.'
  );
}
