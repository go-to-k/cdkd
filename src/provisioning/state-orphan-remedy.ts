import { isPasteableIdent } from '../utils/display-safe.js';
import type { DeleteContext } from './region-check.js';

/**
 * The `cdkd state orphan` remedy a provider's delete-path skip warning names
 * for dropping the record it kept (go-to-k/cdkd#4602).
 *
 * The whole-stack form, `cdkd state orphan <stack>`, drops the record of EVERY
 * resource in the stack. That is only a reasonable way out on a STACK DESTROY
 * (`DeleteContext.stackDestroy`), where the destroy has already deleted the
 * stack's other resources. Every other delete -- a `cdkd deploy` template
 * removal, replacement or rollback, or a caller that passes no context -- runs
 * against a stack that is still deployed, where the whole-stack form makes the
 * next deploy re-create or collide with every resource in it. There the remedy
 * is the single-record form, `--resource <logicalId>`.
 *
 * The logical id goes into the command only when `isPasteableIdent` admits it;
 * otherwise the command keeps a `<logicalId>` placeholder.
 *
 * Returns `'<command>', which drops ...` -- a noun phrase plus clause each
 * caller places after its own verb ("clear it with ...", "drop the record
 * with ...").
 */
export function stateOrphanRecordRemedy(
  context: DeleteContext | undefined,
  logicalId: string
): string {
  const resourceArg = `--resource ${isPasteableIdent(logicalId) ? logicalId : '<logicalId>'}`;
  if (context?.stackDestroy === true) {
    return (
      `'cdkd state orphan <stack> --stack-region <region>', which drops every record the stack ` +
      `still has in that region, not just this one (add '${resourceArg}' to drop only this one)`
    );
  }
  // ONE sentence: several callers place this inside a parenthesis.
  return (
    `'cdkd state orphan <stack> --stack-region <region> ${resourceArg}', which drops only this ` +
    `record — never run it without --resource on a stack that is still deployed, where that drops ` +
    `every resource's record and the next deploy re-creates or collides with all of them`
  );
}
