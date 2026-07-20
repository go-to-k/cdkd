#!/usr/bin/env node

import { buildProgram } from './program.js';
import { installPipeCloseHandler } from './pipe-close-handler.js';

const SUBCOMMANDS = new Set([
  'bootstrap',
  'synth',
  'list',
  'ls',
  'deploy',
  'diff',
  'drift',
  'destroy',
  'gc',
  'orphan',
  'import',
  'export',
  'publish-assets',
  'force-unlock',
  'state',
  'local',
  'migrate',
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
  installPipeCloseHandler();
  const program = buildProgram();

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
