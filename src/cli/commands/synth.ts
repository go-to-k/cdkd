import { Command } from 'commander';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { appOptions, commonOptions, contextOptions, parseContextOptions } from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { Synthesizer, type SynthesisOptions } from '../../synthesis/synthesizer.js';
import { AssemblyReader } from '../../synthesis/assembly-reader.js';
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
 * Simple JSON to YAML converter (CDK CLI compatible output)
 */
function toYaml(obj: unknown, indent = 0): string {
  const prefix = '  '.repeat(indent);

  if (obj === null || obj === undefined) return 'null\n';
  if (typeof obj === 'boolean') return `${obj}\n`;
  if (typeof obj === 'number') return `"${obj}"\n`;
  if (typeof obj === 'string') {
    // Strings that need quoting
    if (obj.includes('\n')) {
      // Multi-line: use single quotes with escaped content
      return `'${obj.replace(/'/g, "''")}'\n`;
    }
    if (obj.startsWith('{') || obj.startsWith('[') || obj.startsWith('"')) {
      // JSON-like strings: use single quotes (like CDK CLI)
      return `'${obj.replace(/'/g, "''")}'\n`;
    }
    if (obj.includes('#') || obj === '' || obj === 'true' || obj === 'false' || obj === 'null') {
      return `"${obj}"\n`;
    }
    // Plain string (no quoting needed for colons in values like AWS::S3::Bucket)
    return `${obj}\n`;
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]\n';
    let result = '\n';
    for (const item of obj) {
      const value = toYaml(item, indent + 1).trimStart();
      result += `${prefix}- ${value}`;
    }
    return result;
  }

  if (typeof obj === 'object') {
    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length === 0) return '{}\n';
    let result = '\n';
    for (const [key, value] of entries) {
      // Keys with special chars need quoting, but AWS:: style keys don't
      const safeKey = key.includes(' ') ? `"${key}"` : key;
      if (typeof value === 'object' && value !== null) {
        result += `${prefix}${safeKey}:${toYaml(value, indent + 1)}`;
      } else {
        result += `${prefix}${safeKey}: ${toYaml(value, indent + 1).trimStart()}`;
      }
    }
    return result;
  }

  return `${String(obj)}\n`;
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
