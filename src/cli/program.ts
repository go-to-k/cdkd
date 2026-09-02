import { Command } from 'commander';

import { getCdkdVersion } from '../version.js';

import { createBootstrapCommand } from './commands/bootstrap.js';
import { createSynthCommand } from './commands/synth.js';
import { createListCommand } from './commands/list.js';
import { createDeployCommand } from './commands/deploy.js';
import { createDiffCommand } from './commands/diff.js';
import { createScrubCommand } from './commands/scrub.js';
import { createDriftCommand } from './commands/drift.js';
import { createDestroyCommand } from './commands/destroy.js';
import { createRollbackCommand } from './commands/rollback.js';
import { createEventsCommand } from './commands/events.js';
import { createGcCommand } from './commands/gc.js';
import { createOrphanCommand } from './commands/orphan.js';
import { createPublishAssetsCommand } from './commands/publish-assets.js';
import { createForceUnlockCommand } from './commands/force-unlock.js';
import { createStateCommand } from './commands/state.js';
import { createImportCommand } from './commands/import.js';
import { createLocalCommand } from './commands/local-invoke.js';
import { createExportCommand } from './commands/export.js';
import { createMigrateCommand } from './commands/migrate-command.js';

/**
 * Builds the full `cdkd` command tree.
 *
 * Lives in its own module rather than in `index.ts` because importing
 * `index.ts` runs `main()` as a side effect — the same reason
 * `pipe-close-handler.ts` was split out. Tooling can import this one safely.
 *
 * The consumer that motivated the split is
 * `scripts/check-integ-cli-flags.ts`, which validates every CLI invocation in
 * the integ fixtures against the option set of the subcommand that actually
 * declares the flag. Reading the real tree matters: `--help` omits hidden
 * options, and `src/cli/options.ts` is a flat global list with no command
 * attachment — so a flag declared there but never attached to a given
 * subcommand (the `cdkd import --region` case, which silently meant an entire
 * fixture's import round-trip never ran) is invisible to both.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('cdkd')
    .description(
      'Drop-in CDK CLI for existing CDK apps - up to 15x faster deploys via direct AWS SDK calls instead of CloudFormation'
    )
    // `getCdkdVersion()` carries the `typeof` guard the build-time define
    // needs: this module is imported directly by unit tests, where tsdown's
    // `define` has not run and a bare reference would throw ReferenceError. The
    // built bundle still gets the real version substituted (verified: `cdkd
    // --version` reports package.json's value, and the fallback string does not
    // appear in dist/). `src/cli/index.ts` answers a bare `--version` from the
    // same helper without importing this module at all.
    .version(getCdkdVersion());

  program.hook('preAction', (_thisCommand, actionCommand) => {
    const { profile } = actionCommand.optsWithGlobals<{ profile?: string }>();
    if (profile !== undefined) {
      process.env['AWS_PROFILE'] = profile;
    }
  });

  program.addCommand(createBootstrapCommand());
  program.addCommand(createSynthCommand());
  program.addCommand(createListCommand());
  program.addCommand(createDeployCommand());
  program.addCommand(createDiffCommand());
  program.addCommand(createDriftCommand());
  program.addCommand(createDestroyCommand());
  program.addCommand(createRollbackCommand());
  program.addCommand(createScrubCommand());
  program.addCommand(createEventsCommand());
  program.addCommand(createGcCommand());
  program.addCommand(createOrphanCommand());
  program.addCommand(createImportCommand());
  program.addCommand(createPublishAssetsCommand());
  program.addCommand(createForceUnlockCommand());
  program.addCommand(createStateCommand());
  program.addCommand(createLocalCommand());
  program.addCommand(createExportCommand());
  program.addCommand(createMigrateCommand());

  return program;
}
