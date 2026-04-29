import { Command } from 'commander';
import { appOptions, commonOptions, contextOptions, parseContextOptions } from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { Synthesizer, type SynthesisOptions } from '../../synthesis/synthesizer.js';
import type { StackInfo } from '../../synthesis/assembly-reader.js';
import { resolveApp } from '../config-loader.js';
import { matchStacks, describeStack } from '../stack-matcher.js';
import { toYaml } from '../../utils/yaml.js';

/**
 * Long-form stack record matching CDK CLI's `cdk list --long` shape.
 *
 * See aws-cdk-cli/packages/aws-cdk/lib/cli/cdk-toolkit.ts (`list` method).
 */
interface LongStackRecord {
  id: string;
  name: string;
  environment: {
    account: string;
    region: string;
  };
  dependencies?: string[];
}

/**
 * Compact dependency record used when only `--show-dependencies` is set
 * (without `--long`).
 */
interface DependencyRecord {
  id: string;
  dependencies: string[];
}

/**
 * Sort stacks in dependency (topological) order so a stack always appears
 * AFTER the stacks it depends on. Falls back to discovery order on cycles
 * (which the synthesizer would have rejected anyway).
 */
function sortByDependency(stacks: StackInfo[]): StackInfo[] {
  const byName = new Map(stacks.map((s) => [s.stackName, s]));
  const visited = new Set<string>();
  const result: StackInfo[] = [];

  const visit = (stack: StackInfo, ancestors: Set<string>): void => {
    if (visited.has(stack.stackName)) return;
    if (ancestors.has(stack.stackName)) return; // cycle guard
    ancestors.add(stack.stackName);
    for (const depName of stack.dependencyNames) {
      const dep = byName.get(depName);
      if (dep) visit(dep, ancestors);
    }
    ancestors.delete(stack.stackName);
    if (!visited.has(stack.stackName)) {
      visited.add(stack.stackName);
      result.push(stack);
    }
  };

  for (const stack of stacks) {
    visit(stack, new Set());
  }

  return result;
}

/**
 * Convert a StackInfo to its `--long` JSON representation.
 */
function toLongRecord(stack: StackInfo, includeDeps: boolean): LongStackRecord {
  const record: LongStackRecord = {
    id: stack.displayName,
    name: stack.stackName,
    environment: {
      account: stack.account ?? 'unknown-account',
      region: stack.region ?? 'unknown-region',
    },
  };
  if (includeDeps) {
    record.dependencies = [...stack.dependencyNames];
  }
  return record;
}

/**
 * List command implementation
 */
async function listCommand(
  patterns: string[],
  options: {
    app?: string;
    output: string;
    verbose: boolean;
    region?: string;
    profile?: string;
    context?: string[];
    long: boolean;
    showDependencies: boolean;
    json: boolean;
  }
): Promise<void> {
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

  logger.debug('Listing stacks...');
  logger.debug('App command:', app);

  // Synthesize CDK app
  const synthesizer = new Synthesizer();
  const context = parseContextOptions(options.context);
  const synthOptions: SynthesisOptions = {
    app,
    output: options.output,
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
    ...(Object.keys(context).length > 0 && { context }),
  };

  const result = await synthesizer.synthesize(synthOptions);
  const allStacks = result.stacks;

  if (allStacks.length === 0) {
    throw new Error('No stacks found in assembly');
  }

  // Filter by patterns if provided. Patterns match against displayName (when
  // they contain '/') or stackName (otherwise) — same routing rules as
  // deploy / diff / destroy (see src/cli/stack-matcher.ts).
  const selected = patterns.length > 0 ? matchStacks(allStacks, patterns) : allStacks;

  if (selected.length === 0) {
    throw new Error(
      `No stacks matching ${patterns.join(', ')} found in assembly. ` +
        `Available: ${allStacks.map(describeStack).join(', ')}`
    );
  }

  // Sort by dependency order so output is deterministic and a stack never
  // precedes a stack it depends on.
  const sorted = sortByDependency(selected);

  // Output mode selection (mirrors CDK CLI):
  // - --long → full record per stack (id, name, environment, [dependencies])
  // - --show-dependencies (without --long) → {id, dependencies} per stack
  // - default → bare displayName, one per line
  // - --json switches the structured outputs to JSON instead of YAML.
  if (options.long) {
    const records = sorted.map((s) => toLongRecord(s, options.showDependencies));
    emitStructured(records, options.json);
    return;
  }

  if (options.showDependencies) {
    const records: DependencyRecord[] = sorted.map((s) => ({
      id: s.displayName,
      dependencies: [...s.dependencyNames],
    }));
    emitStructured(records, options.json);
    return;
  }

  for (const stack of sorted) {
    process.stdout.write(`${stack.displayName}\n`);
  }
}

/**
 * Emit a structured payload as either YAML (default, CDK CLI parity) or
 * JSON. Routed via stdout so `cdkd list` output is pipeable.
 */
function emitStructured(payload: unknown, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  // toYaml emits a leading newline for non-empty arrays/objects; trim so
  // the output starts at column 0 like CDK CLI does.
  const yaml = toYaml(payload).replace(/^\n/, '');
  process.stdout.write(yaml);
}

/**
 * Create list command
 *
 * Mirrors `cdk list` / `cdk ls` from the AWS CDK CLI. Default output is one
 * stack id (display path) per line; `--long` / `--show-dependencies` switch
 * to a structured YAML payload (or JSON with `--json`).
 */
export function createListCommand(): Command {
  const cmd = new Command('list')
    .alias('ls')
    .description('List all stacks in the CDK app')
    .argument(
      '[stacks...]',
      "Stack name pattern(s). Accepts physical CloudFormation names (e.g. 'MyStage-Api') or CDK display paths (e.g. 'MyStage/Api'). Supports wildcards (e.g. 'MyStage/*')."
    )
    .option('-l, --long', 'Display environment information for each stack', false)
    .option('-d, --show-dependencies', 'Display stack dependency information for each stack', false)
    .option('--json', 'Output as JSON instead of YAML for --long / --show-dependencies', false)
    .action(withErrorHandling(listCommand));

  // Reuse standard options. Note: list doesn't need --state-bucket / --stack
  // / deploy options — it's a pure local synth + render command.
  [...commonOptions, ...appOptions, ...contextOptions].forEach((opt) => cmd.addOption(opt));

  return cmd;
}
