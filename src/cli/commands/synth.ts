import { Command } from 'commander';
import { writeFileSync } from 'fs';
import { join } from 'path';
import {
  annotationMessageOptions,
  appOptions,
  commonOptions,
  contextOptions,
  deprecatedRegionOption,
  parseContextOptions,
  warnIfDeprecatedRegion,
} from '../options.js';
import { getLogger, reserveStdoutForPayload } from '../../utils/logger.js';
import { bold, green } from '../../utils/colors.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { foldRegionOption } from '../region-options.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import {
  Synthesizer,
  synthesisStatusMessage,
  type SynthesisOptions,
} from '../../synthesis/synthesizer.js';
import { AssemblyReader } from '../../synthesis/assembly-reader.js';
import { processStackMessages } from '../../synthesis/stack-messages.js';
import { resolveApp } from '../config-loader.js';
import { toYaml } from '../../utils/yaml.js';
import type { CloudFormationTemplate } from '../../types/resource.js';

/**
 * Count deployable resources in a synth template.
 *
 * Excludes `AWS::CDK::Metadata` (CDK-injected construct-tree marker; cdkd deploy
 * also filters this out, so the two commands stay in sync — see
 * deploy-engine.ts `validateResourceTypes` call site).
 */
export function countDeployableResources(template: CloudFormationTemplate): number {
  return Object.values(template.Resources ?? {}).filter((r) => r.Type !== 'AWS::CDK::Metadata')
    .length;
}

/**
 * Synth command implementation
 */
async function synthCommand(options: {
  app?: string;
  output: string;
  verbose: boolean;
  region?: string;
  profile?: string;
  roleArn?: string;
  context?: string[];
  strict?: boolean;
  ignoreErrors?: boolean;
}): Promise<void> {
  const logger = getLogger();

  if (options.verbose) {
    logger.setLevel('debug');
  }

  // Issue #2410: on `cdkd synth`, stdout MEANS "the CloudFormation template"
  // and nothing else — matching `cdk synth`, which prints only the template
  // there and routes every log line to stderr. Unlike the issue-#2280 sites
  // this reservation is UNCONDITIONAL: the payload has no `--json` flag to
  // key off, so the default output contract itself moves. Claimed before the
  // `Synthesizing CDK app...` line below and before synthesis runs at all —
  // `app-executor.ts` re-emits the CDK app's stderr (bundling progress,
  // warnings) at INFO, so a DEFAULT run put prose inside the document with no
  // `--verbose` involved. NOT sufficient on its own for `cdkd synth | yq`:
  // `toYaml` still leaves YAML indicator characters unquoted, so a template
  // containing `"*"` emits a bare `- *` a parser rejects — a serializer
  // defect, tracked as
  // [#2421](https://github.com/go-to-k/cdkd/issues/2421).
  //
  // Accepted consequence, stated because it is a real behavior change rather
  // than an oversight: in the MULTI-stack case nothing at all is written to
  // stdout (the template is emitted only for a single stack, below) and the
  // whole `Synthesis complete!` summary block goes to stderr. stdout on
  // `synth` is the template or it is empty; the summary is never a payload.
  // Lines are MOVED, not suppressed — a terminal shows exactly what it did
  // before, and `2>&1` restores the old single-stream view.
  reserveStdoutForPayload();

  // PR 5: --region is deprecated on non-bootstrap commands. Warn but keep
  // the rest of the pipeline working as before.
  warnIfDeprecatedRegion(options);

  // Resolve --role-arn / CDKD_ROLE_ARN before any AWS call.
  // Issue #2065 - fold `--region` ONCE, at the boundary, so no raw spelling
  // reaches an SDK client, an ARN segment or a state key. Rationale (and why
  // this is per-command rather than per-consumer) in `src/cli/region-options.ts`.
  foldRegionOption(options);
  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

  // Resolve --app from CLI, env, or cdk.json
  const app = resolveApp(options.app);
  if (!app) {
    throw new Error(
      'No app command specified. Use --app, set CDKD_APP env var, or add "app" to cdk.json'
    );
  }
  options.app = app;

  logger.info(synthesisStatusMessage(app, 'Synthesizing CDK app...'));
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

  // CDK CLI parity (issue #1228): surface Annotations messages — print
  // warnings/infos, refuse to emit a template when any stack carries an
  // error annotation (`cdk synth` fails with "Found errors" too).
  // #1230: `--strict` also fails on warnings; `--ignore-errors` never fails.
  processStackMessages(stacks, logger, {
    strict: options.strict === true,
    ignoreErrors: options.ignoreErrors === true,
  });

  // Print YAML template to stdout (like CDK CLI) for single stack
  if (stacks.length === 1) {
    const template = stacks[0]!.template;
    process.stdout.write(toYaml(template));
  }

  logger.info(`\n${green('✓')} ${bold('Synthesis complete!')} Found ${stacks.length} stack(s):`);

  for (const stack of stacks) {
    const resourceCount = countDeployableResources(stack.template);
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
  [...commonOptions, ...appOptions, ...contextOptions, ...annotationMessageOptions].forEach((opt) =>
    cmd.addOption(opt)
  );

  // --region is deprecated for synth (PR 5). Accepted for backward
  // compatibility; warning emitted at runtime via warnIfDeprecatedRegion.
  cmd.addOption(deprecatedRegionOption);

  return cmd;
}
