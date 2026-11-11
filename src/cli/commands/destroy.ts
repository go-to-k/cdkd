import { Command } from 'commander';
import { commandHole } from '../../utils/pasteable-command.js';
import {
  appOptions,
  commonOptions,
  deprecatedRegionOption,
  stateOptions,
  stackOptions,
  destroyOptions,
  resourceTimeoutOptions,
  skipFinalSnapshotOption,
  contextOptions,
  exclusivelyOption,
} from '../options.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { destroyCommand } from './destroy/command.js';

export {
  orderConsumersBeforeProducers,
  plannedDestroyRegion,
  purgeEventsAfterDestroy,
} from './destroy/helpers.js';

/**
 * Create destroy command
 */
export function createDestroyCommand(): Command {
  const cmd = new Command('destroy')
    .description('Destroy all resources in the stack')
    .argument(
      '[stacks...]',
      "Stack name(s) to destroy. Accepts CDK display paths (e.g. 'MyStage/Api') with wildcards ('MyStage/*', '**'), or exact physical CloudFormation names (e.g. 'MyStage-Api')."
    )
    .option('--all', "Destroy every top-level stack (top-level only; Stage stacks: '**')", false)
    .option(
      '--purge-events',
      "After a clean destroy, also delete the stack's deployment-event history, " +
        "purging every earlier version under the stack's deployments/ " +
        'prefix on a versioned state bucket too unless a warning says otherwise. By default ' +
        'events survive destroy as post-mortem context. ' +
        'Skipped when the destroy fails or is interrupted (those events aid the retry). ' +
        // TWO corrections here, and the second overturned the first.
        //
        // The ARITY is `<stack>`: `createEventsPruneCommand` declares
        // `.argument('<stack>', ...)` -- exactly one stack, and REQUIRED. An
        // earlier round of this PR wrote `[stacks...]` and claimed in the
        // comment, the body and the changelog that it agreed with `--help`. It
        // did not (review measured it, M2), and `[...]` is a bracket GLOB when
        // pasted. Derive the spelling from the command, never from a sibling
        // that happens to be variadic.
        //
        // The HOLE is quoted. A bare `<stack>` followed by a flag is the
        // redirection shape go-to-k/cdkd#3436 measured: pasted where a file
        // named `stack` exists, the `>` takes `--all` as an output TARGET and
        // creates it BEFORE the binary runs. (Measured with a stubbed `cdkd`
        // that exits 0; the real binary exits 1 with `missing required
        // argument 'stack'`, since the redirection swallowed the argument --
        // and the file is created either way. An earlier version of this
        // comment gave only the stub's exit code.) The earlier comment argued this is `--help`
        // text stating a grammar, so Commander's bare rendering was the fix --
        // but that argument does not survive measurement, and BOTH spellings I
        // reached for first are worse than they look. Under bash, with a
        // stubbed `cdkd`: `cdkd state orphan <stacks...> --all` creates a file
        // called `--all` -- the dots are part of the redirect's word, not an
        // escape from it (the stub exits 0; the real binary exits 1 for the
        // swallowed argument, with the file created all the same). And `[stacks...]` is not inert either: it is a
        // bracket EXPRESSION matching ONE character drawn from `s t a c k .`,
        // so in a directory holding a file named `s` it expands to `s` and
        // silently retargets the command rather than failing. (Two earlier
        // versions of this comment got that wrong in opposite directions --
        // "matches nothing", then "matches any one-character filename".)
        //
        // `state.ts`'s three `Usage:` lines are quoted now for the same reason.
        // A third wrong claim of mine held that their `| --all` made them
        // unrunnable; a pipeline's right-hand failure does not stop the LEFT
        // side, so `cdkd state destroy <expansion>` would still have run.
        // `commandHole` prints
        // `'<stack>'`: same grammar, same arity, and a shell strips the quotes
        // rather than passing them, so a reader who types the line verbatim
        // gets what they meant.
        `Equivalent for an already-destroyed stack: cdkd events prune ${commandHole('stack')} --all.`,
      false
    )
    .action(withErrorHandling(destroyCommand));

  [
    ...commonOptions,
    ...appOptions,
    ...stateOptions,
    ...stackOptions,
    ...destroyOptions,
    exclusivelyOption('destroy'),
    ...resourceTimeoutOptions,
    skipFinalSnapshotOption,
    ...contextOptions,
  ].forEach((opt) => cmd.addOption(opt));

  // --region is deprecated for destroy (PR 5). Accepted for backward
  // compatibility; warning emitted at runtime via warnIfDeprecatedRegion.
  cmd.addOption(deprecatedRegionOption);

  return cmd;
}
