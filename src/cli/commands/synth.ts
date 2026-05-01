import { Command } from 'commander';
import { writeFileSync } from 'fs';
import { join } from 'path';
import {
  appOptions,
  commonOptions,
  contextOptions,
  deprecatedRegionOption,
  parseContextOptions,
  warnIfDeprecatedRegion,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { Synthesizer, type SynthesisOptions } from '../../synthesis/synthesizer.js';
import { AssemblyReader } from '../../synthesis/assembly-reader.js';
import { resolveApp } from '../config-loader.js';
import { toYaml } from '../../utils/yaml.js';

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

  // PR 5: --region is deprecated on non-bootstrap commands. Warn but keep
  // the rest of the pipeline working as before.
  warnIfDeprecatedRegion(options);

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
  const assemblyReader = new AssemblyReader();

  // Synthesize CDK app
  const context = parseContextOptions(options.context);
  const synthOptions: SynthesisOptions = {
    app: options.app,
    output: options.output,
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
    ...(Object.keys(context).length > 0 && { context }),
  };

  const result = await synthesizer.synthesize(synthOptions);
  const { stacks, assemblyDir } = result;

  // Print YAML template to stdout (like CDK CLI) for single stack
  if (stacks.length === 1) {
    const template = stacks[0]!.template;
    process.stdout.write(toYaml(template));
  }

  logger.info(`\n✅ Synthesis complete! Found ${stacks.length} stack(s):`);

  for (const stack of stacks) {
    const resourceCount = Object.keys(stack.template.Resources ?? {}).length;
    const outputCount = Object.keys(stack.template.Outputs ?? {}).length;

    logger.info(`  • ${stack.stackName}`);
    logger.info(`    - Resources: ${resourceCount}`);
    logger.info(`    - Outputs: ${outputCount}`);
    logger.info(`    - Has assets: ${assemblyReader.hasAssets(stack) ? 'Yes' : 'No'}`);

    if (options.verbose) {
      const templatePath = join(options.output, `${stack.stackName}.template.json`);
      writeFileSync(templatePath, JSON.stringify(stack.template, null, 2));
      logger.debug(`    - Template written to: ${templatePath}`);
    }
  }

  logger.info(`\nOutput: ${assemblyDir}`);
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

  // --region is deprecated for synth (PR 5). Accepted for backward
  // compatibility; warning emitted at runtime via warnIfDeprecatedRegion.
  cmd.addOption(deprecatedRegionOption);

  return cmd;
}
