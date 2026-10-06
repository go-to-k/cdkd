import { carriesSecretMask, dynamicReferenceTokens } from '../deployment/secret-redaction.js';
import type { ResourceDeleteResult } from '../types/resource.js';
import { safeMsg } from '../utils/display-safe.js';
import type { DeleteContext } from './region-check.js';
import { stateOrphanRecordRemedy } from './state-orphan-remedy.js';

/**
 * A recorded property a `delete()` ADDRESSES the resource through, that cdkd
 * itself redacted before persisting it (go-to-k/cdkd#3952).
 *
 * State keeps two redacted spellings: the mask `***` for a `NoEcho` value a
 * resource read (issue #2274; whole-leaf, or the whole leaf that embeds one,
 * #2453), and the `{{resolve:...}}` EXPRESSION of a secret dynamic reference.
 * Neither names anything in AWS. Sent as a name or a record value, the call
 * fails with an error that says nothing about the redaction -- or, on an arm
 * that reads a not-found as "already deleted", DROPS the record over a live
 * resource: a Route 53 `DELETE` whose record value is `***` answers
 * `InvalidChangeBatch ... not found`.
 *
 * `CustomResourceProvider.delete` carries its own two arms for `ServiceToken`
 * (#3938, #3960) with custom-resource-specific remedies; this is the shared
 * check for every other provider.
 */
export function isRedactedRecordedValue(value: unknown): boolean {
  if (carriesSecretMask(value)) return true;
  let text: string | undefined;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return false;
  }
  return text !== undefined && dynamicReferenceTokens(text).length > 0;
}

/**
 * The short `ResourceDeleteResult.reason` every provider reports for the skip
 * below. Fixed wording, no interpolation: a reason is rendered into an `Error`
 * whose catch classifies "already deleted" by SUBSTRING
 * (`.claude/rules/provider-delete-path.md`).
 */
export const REDACTED_DELETE_ADDRESS_SKIP_REASON =
  'redacted address property in state — no delete issued';

/**
 * The names of `fields` whose recorded value {@link isRedactedRecordedValue},
 * in the caller's order. Pass the caller's OWN literal reads of the bag
 * (`{ RestApiId: properties['RestApiId'] }`) so the wiring walk still sees
 * which property feeds the call.
 */
export function redactedDeleteAddressFields(fields: Record<string, unknown>): string[] {
  return Object.keys(fields).filter((key) => isRedactedRecordedValue(fields[key]));
}

/**
 * Warn and return the skip for a delete whose address `redactedFields` could
 * not be read because cdkd redacted them. Returns `undefined` when the list is
 * empty, so a call site reads `const skip = ...; if (skip) return skip;`.
 *
 * Names the FIELDS, never their values: the value is the mask or a reference
 * expression, and a reference names a secret. The remedies hold on every path
 * this is reached from: re-deploying rewrites the same redaction, so the way
 * out is removing the resource by hand and dropping the record. Which
 * `cdkd state orphan` form drops it depends on the phase: `context` is the
 * caller's `DeleteContext` ({@link stateOrphanRecordRemedy}, go-to-k/cdkd#4602).
 */
export function redactedDeleteAddressSkip(
  logger: { warn: (message: string) => void },
  logicalId: string,
  what: string,
  redactedFields: readonly string[],
  context?: DeleteContext
): ResourceDeleteResult | undefined {
  if (redactedFields.length === 0) return undefined;
  logger.warn(
    safeMsg`${what} ${logicalId} is recorded in state with ${redactedFields.join(', ')} ` +
      `redacted (the '***' mask of a NoEcho value it read, or a secret '{{resolve:...}}' ` +
      `reference), which names nothing in AWS; skipping deletion — no AWS call is issued, so ` +
      `the resource is LEFT IN PLACE unless a parent resource this run also deletes removes ` +
      `it (then only the record is stale). Re-deploying records the same redaction again. The ` +
      `state record is KEPT and the run reports the skip: on 'cdkd destroy' / 'cdkd state ` +
      `destroy' (which exits non-zero) and, since issue 1762, on the plain DELETE of a ` +
      `resource removed from the template during cdkd deploy. Remove the resource by hand, ` +
      safeMsg`then drop the record with ${stateOrphanRecordRemedy(context, logicalId)}. ` +
      `NOTE a deploy-side REPLACEMENT or ` +
      `rollback delete instead FAILS the resource ` +
      `(https://github.com/go-to-k/cdkd/issues/1762) — the old resource is left untracked ` +
      `there, so remove it by hand.`
  );
  return { outcome: 'skipped', reason: REDACTED_DELETE_ADDRESS_SKIP_REASON };
}
