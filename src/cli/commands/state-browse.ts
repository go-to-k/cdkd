/**
 * `cdkd state browse` (go-to-k/cdkd#5199): pick a stack from the state bucket
 * with the keyboard, then view its resources or its record, without copying a
 * stack name between commands.
 *
 * Every view is the output of the matching non-interactive command
 * (`cdkd state resources`, `--long`, `cdkd state show`), printed by the same
 * code against the one backend this command set up, so nothing is rendered or
 * redacted differently. The only reads are the ones those commands make: one
 * listing for the picker, and each view's own.
 */
import type { StackStateRef } from '../../state/s3-state-backend.js';
import { CdkdError } from '../../utils/error-handler.js';
import {
  isInteractiveTerminal,
  selectFromList,
  type SelectItem,
  type SelectStreams,
} from '../interactive-select.js';

/** The views a picked stack offers. */
export type BrowseView = 'resources' | 'resources-long' | 'show';

const VIEW_ITEMS: SelectItem<BrowseView | 'back'>[] = [
  { label: 'Resources (logical id, type, physical id)', value: 'resources' },
  { label: 'Resources with dependencies and attributes', value: 'resources-long' },
  { label: 'Full state record (cdkd state show)', value: 'show' },
  { label: 'Back to the stack list', value: 'back' },
];

export interface BrowseDeps {
  streams: SelectStreams;
  /** The stacks in the state bucket, sorted as `cdkd state list` sorts them. */
  listStacks: () => Promise<StackStateRef[]>;
  /** One stack's label in the picker, display-safe. */
  label: (ref: StackStateRef) => string;
  /** Print `view` for the stack, exactly as its non-interactive command does. */
  printView: (view: BrowseView, ref: StackStateRef) => Promise<void>;
  /** Report a view that failed, then return to the menu. */
  reportError: (error: unknown) => void;
}

/** The refusal on a run without a terminal: name the commands that work there. */
export function nonInteractiveBrowseRefusal(): CdkdError {
  return new CdkdError(
    'cdkd state browse needs an interactive terminal. Without one, use ' +
      'cdkd state list, cdkd state resources <stack> and cdkd state show <stack>.',
    'NON_INTERACTIVE'
  );
}

/**
 * The picker loop: stacks, then a stack's views, until Esc on the stack list
 * or Ctrl+C anywhere.
 */
export async function runStateBrowse(deps: BrowseDeps): Promise<void> {
  if (!isInteractiveTerminal(deps.streams)) throw nonInteractiveBrowseRefusal();
  const refs = await deps.listStacks();
  if (refs.length === 0) {
    deps.streams.output.write('No stacks in the state bucket.\n');
    return;
  }
  const stackItems = refs.map((ref) => ({ label: deps.label(ref), value: ref }));
  for (;;) {
    const stack = await selectFromList('Select a stack:', stackItems, deps.streams);
    if (stack.kind !== 'picked') return;
    for (;;) {
      const title = `${deps.label(stack.value)}:`;
      const view = await selectFromList(title, VIEW_ITEMS, deps.streams);
      if (view.kind === 'quit') return;
      if (view.kind === 'back' || view.value === 'back') break;
      deps.streams.output.write(`\n${title}\n`);
      try {
        await deps.printView(view.value, stack.value);
      } catch (error) {
        deps.reportError(error);
      }
      deps.streams.output.write('\n');
    }
  }
}
