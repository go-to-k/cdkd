import { Command } from 'commander';

// Injected at build time by esbuild `define` from package.json
declare const __CDKD_VERSION__: string;

import { createBootstrapCommand } from './commands/bootstrap.js';
import { createSynthCommand } from './commands/synth.js';
import { createListCommand } from './commands/list.js';
import { createDeployCommand } from './commands/deploy.js';
import { createDiffCommand } from './commands/diff.js';
import { createDestroyCommand } from './commands/destroy.js';
import { createOrphanCommand } from './commands/orphan.js';
import { createPublishAssetsCommand } from './commands/publish-assets.js';
import { createForceUnlockCommand } from './commands/force-unlock.js';
import { createStateCommand } from './commands/state.js';
import { createImportCommand } from './commands/import.js';

const SUBCOMMANDS = new Set([
  'bootstrap',
  'synth',
  'list',
  'ls',
  'deploy',
  'diff',
  'destroy',
  'orphan',
  'import',
  'publish-assets',
  'force-unlock',
  'state',
]);

/**
 * Reorder args so options before the subcommand are moved after it.
 * e.g., `cdkd -c ENV=dev deploy` → `cdkd deploy -c ENV=dev`
 */
function reorderArgs(argv: string[]): string[] {
  // argv[0] = node, argv[1] = script, rest = user args
  const prefix = argv.slice(0, 2);
  const userArgs = argv.slice(2);

  // Find the subcommand index
  const cmdIndex = userArgs.findIndex((arg) => SUBCOMMANDS.has(arg));
  if (cmdIndex <= 0) return argv; // No reordering needed

  const beforeCmd = userArgs.slice(0, cmdIndex);
  const cmdAndAfter = userArgs.slice(cmdIndex);
  return [...prefix, ...cmdAndAfter, ...beforeCmd];
}

/**
 * Main CLI program
 */
async function main(): Promise<void> {
  const program = new Command();

  program
    .name('cdkd')
    .description('CDK Direct - Deploy AWS CDK apps directly via SDK/Cloud Control API')
    .version(__CDKD_VERSION__);

  // Add commands
  program.addCommand(createBootstrapCommand());
  program.addCommand(createSynthCommand());
  program.addCommand(createListCommand());
  program.addCommand(createDeployCommand());
  program.addCommand(createDiffCommand());
  program.addCommand(createDestroyCommand());
  program.addCommand(createOrphanCommand());
  program.addCommand(createImportCommand());
  program.addCommand(createPublishAssetsCommand());
  program.addCommand(createForceUnlockCommand());
  program.addCommand(createStateCommand());

  // Reorder args: move options before subcommand to after it
  // This allows `cdkd -c key=value deploy` like CDK CLI
  const args = reorderArgs(process.argv);
  await program.parseAsync(args);
}

// Run the CLI
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
