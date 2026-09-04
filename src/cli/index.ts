#!/usr/bin/env node

import { installPipeCloseHandler } from './pipe-close-handler.js';
import { getCdkdVersion, isVersionOnlyInvocation } from '../version.js';

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
  'events',
  'rollback',
  'scrub',
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

  // `cdkd --version` needs nothing but a string the build already baked in,
  // yet the command tree it would otherwise import costs ~1s of Node module
  // resolution before any cdkd code runs (measured 2026-08-25 on Node 24.15:
  // ~1020ms total, of which ~48ms is Node startup, ~3ms is buildProgram() and
  // the rest is the loader reading and compiling the externalised @aws-sdk/*
  // graph that every command module pulls in). Answering before that import
  // keeps the flag at Node-startup cost. `program.js` is therefore imported
  // dynamically: a static import is hoisted and would evaluate the same graph
  // regardless of what this function decides.
  if (isVersionOnlyInvocation(process.argv.slice(2))) {
    console.log(getCdkdVersion());
    return;
  }

  const { buildProgram } = await import('./program.js');
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
