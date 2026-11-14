import { commandHole, pasteableCommand, proseQuoted } from '../utils/pasteable-command.js';
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
 * otherwise the command keeps a quoted `'<logicalId>'` hole. The stack and
 * region are always quoted holes, and the command carries the run's typed
 * flags (go-to-k/cdkd#6262), so it is printed unwrapped.
 *
 * Returns `<command>, which drops ...` -- a noun phrase plus clause each
 * caller places after its own verb ("clear it with ...", "drop the record
 * with ...").
 */
export function stateOrphanRecordRemedy(
  context: DeleteContext | undefined,
  logicalId: string
): string {
  const resource = {
    flag: '--resource',
    value: logicalId,
    hole: 'logicalId',
    opts: { plainIdent: true },
  } as const;
  const target = [{ hole: 'stack' }, { flag: '--stack-region', hole: 'region' }] as const;
  if (context?.stackDestroy === true) {
    const built = pasteableCommand('cdkd state orphan', [resource]).withheld.length === 0;
    const resourceArg = `--resource ${built ? logicalId : commandHole('logicalId')}`;
    return (
      `${pasteableCommand('cdkd state orphan', [...target]).command}, which drops every record ` +
      `the stack still has in that region, not just this one (add ${proseQuoted(resourceArg)} to ` +
      `drop only this one)`
    );
  }
  // ONE sentence: several callers place this inside a parenthesis.
  return (
    `${pasteableCommand('cdkd state orphan', [...target, resource]).command}, which drops only this ` +
    `record — never run it without --resource on a stack that is still deployed, where that drops ` +
    `every resource's record and the next deploy re-creates or collides with all of them`
  );
}
