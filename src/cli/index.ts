import { Command } from 'commander';
import { createBootstrapCommand } from './commands/bootstrap.js';
import { createSynthCommand } from './commands/synth.js';
import { createDeployCommand } from './commands/deploy.js';
import { createDiffCommand } from './commands/diff.js';
import { createDestroyCommand } from './commands/destroy.js';
import { createPublishAssetsCommand } from './commands/publish-assets.js';

/**
 * Main CLI program
 */
async function main(): Promise<void> {
  const program = new Command();

  program
    .name('cdkq')
    .description('CDK Quick Deploy - Deploy AWS CDK apps directly via SDK/Cloud Control API')
    .version('0.1.0');

  // Add commands
  program.addCommand(createBootstrapCommand());
  program.addCommand(createSynthCommand());
  program.addCommand(createDeployCommand());
  program.addCommand(createDiffCommand());
  program.addCommand(createDestroyCommand());
  program.addCommand(createPublishAssetsCommand());

  await program.parseAsync(process.argv);
}

// Run the CLI
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
