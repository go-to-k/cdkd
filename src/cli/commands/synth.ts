import { Command } from 'commander';
import { writeFileSync } from 'fs';
import { join } from 'path';
import * as yaml from 'yaml';
import { appOptions, commonOptions, contextOptions, parseContextOptions } from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { Synthesizer, type SynthesisOptions } from '../../synthesis/synthesizer.js';
import { AssemblyLoader } from '../../synthesis/assembly-loader.js';
import { resolveApp } from '../config-loader.js';

/**
 * Synth command implementation
 */
async function synthCommand(options: {
  app?: string;
  output: string;
  verbose: boolean;
  region?: string;
  profile?: string;
  context?: string[];
}): Promise<void> {
  const logger = getLogger();

  if (options.verbose) {
    logger.setLevel('debug');
  }

  // Resolve --app from CLI, env, or cdk.json
  const app = resolveApp(options.app);
  if (!app) {
    throw new Error(
      'No app command specified. Use --app, set CDKD_APP env var, or add "app" to cdk.json'
    );
  }
  options.app = app;

  logger.info('Synthesizing CDK app...');
  logger.debug('App command:', options.app);
  logger.debug('Output directory:', options.output);

  // Create synthesizer
  const synthesizer = new Synthesizer();
  const assemblyLoader = new AssemblyLoader();

  // Synthesize CDK app
  const context = parseContextOptions(options.context);
  const synthOptions: SynthesisOptions = {
    app: options.app,
    output: options.output,
    validateStacks: true,
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
    ...(Object.keys(context).length > 0 && { context }),
  };

  const { cloudAssembly: assembly, dispose } = await synthesizer.synthesize(synthOptions);

  try {
    // Get all stacks
    const stacks = assemblyLoader.getAllStacks(assembly);

    logger.info(`✅ Synthesis complete! Found ${stacks.length} stack(s):`);

    // Display stack information
    for (const stack of stacks) {
      const resourceCount = Object.keys(stack.template.Resources ?? {}).length;
      const outputCount = Object.keys(stack.template.Outputs ?? {}).length;

      logger.info(`  • ${stack.stackName}`);
      logger.info(`    - Resources: ${resourceCount}`);
      logger.info(`    - Outputs: ${outputCount}`);
      logger.info(`    - Has assets: ${assemblyLoader.hasAssets(stack) ? 'Yes' : 'No'}`);

      if (options.verbose) {
        // Write template to output directory for inspection
        const templatePath = join(options.output, `${stack.stackName}.template.json`);
        writeFileSync(templatePath, JSON.stringify(stack.template, null, 2));
        logger.debug(`    - Template written to: ${templatePath}`);
      }
    }

    logger.info(`\nOutput: ${assembly.directory}`);

    // Print YAML template to stdout (like CDK CLI) for single stack
    if (stacks.length === 1) {
      const template = stacks[0]!.template;
      process.stdout.write(yaml.stringify(template));
    }
  } finally {
    await dispose();
  }
}

/**
 * Create synth command
 */
export function createSynthCommand(): Command {
  const cmd = new Command('synth')
    .description('Synthesize CDK app to CloudFormation template')
    .action(withErrorHandling(synthCommand));

  // Add options
  [...commonOptions, ...appOptions, ...contextOptions].forEach((opt) => cmd.addOption(opt));

  return cmd;
}
