import { readFileSync } from 'node:fs';
import * as readline from 'node:readline/promises';
import { Command } from 'commander';
import {
  appOptions,
  commonOptions,
  contextOptions,
  parseContextOptions,
  stateOptions,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { Synthesizer } from '../../synthesis/synthesizer.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { LockManager } from '../../state/lock-manager.js';
import { ProviderRegistry } from '../../provisioning/provider-registry.js';
import { registerAllProviders } from '../../provisioning/register-providers.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { TemplateParser } from '../../analyzer/template-parser.js';
import { resolveApp, resolveStateBucketWithDefault } from '../config-loader.js';
import type {
  CloudFormationTemplate,
  ResourceImportInput,
  ResourceImportResult,
  TemplateResource,
} from '../../types/resource.js';
import type { ResourceState, StackState } from '../../types/state.js';

interface ImportOptions {
  app?: string;
  output?: string;
  stateBucket?: string;
  statePrefix: string;
  region?: string;
  profile?: string;
  resource?: string[];
  resourceMapping?: string;
  /**
   * When true, resources NOT in `--resource` / `--resource-mapping` still
   * go through tag-based auto-import. Default is `false` for CDK CLI parity:
   * when explicit overrides are supplied, only those resources are imported
   * and the rest are skipped (left for the next deploy to create). Pass
   * `--auto` to opt back into hybrid mode (current pre-PR behavior).
   *
   * No-flag invocation (`cdkd import MyStack`) always auto-imports
   * everything via tags — this flag only matters once at least one of
   * `--resource` / `--resource-mapping` is also supplied.
   */
  auto: boolean;
  dryRun: boolean;
  yes: boolean;
  force: boolean;
  verbose: boolean;
  context?: string[];
}

/**
 * Outcome category for one logicalId, used to summarise the run.
 *
 * `imported` — resource found and added to state.
 * `skipped-no-impl` — provider doesn't implement `import`.
 * `skipped-not-found` — provider returned `null` (no matching AWS resource).
 * `skipped-out-of-scope` — explicit-override mode and this resource was not
 *    listed; user opted not to import it. Kept distinct from
 *    `skipped-not-found` because it doesn't reflect AWS state.
 * `failed` — provider threw; logged but lets the rest of the stack proceed.
 */

type ImportOutcome =
  | 'imported'
  | 'skipped-no-impl'
  | 'skipped-not-found'
  | 'skipped-out-of-scope'
  | 'failed';

interface ImportRow {
  logicalId: string;
  resourceType: string;
  outcome: ImportOutcome;
  physicalId?: string;
  reason?: string;
}

async function importCommand(stackArg: string | undefined, options: ImportOptions): Promise<void> {
  const logger = getLogger();
  if (options.verbose) {
    logger.setLevel('debug');
    process.env['CDKD_NO_LIVE'] = '1';
  }

  // Region falls through CLI flag → env → us-east-1, the same chain as deploy.
  const region = options.region || process.env['AWS_REGION'] || 'us-east-1';

  const stateBucket = await resolveStateBucketWithDefault(options.stateBucket, region);

  if (options.region) {
    process.env['AWS_REGION'] = options.region;
    process.env['AWS_DEFAULT_REGION'] = options.region;
  }
  const awsClients = new AwsClients({
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  try {
    const stateConfig = { bucket: stateBucket, prefix: options.statePrefix };
    const stateBackend = new S3StateBackend(awsClients.s3, stateConfig, {
      ...(options.region && { region: options.region }),
      ...(options.profile && { profile: options.profile }),
    });
    await stateBackend.verifyBucketExists();
    const lockManager = new LockManager(awsClients.s3, stateConfig);
    const providerRegistry = new ProviderRegistry();
    registerAllProviders(providerRegistry);

    // Synth — required for import: we need logicalId/resourceType/dependencies
    // from the template. Without it, the user would have to specify everything
    // manually, which is the use case we explicitly avoid.
    const appCmd = options.app || resolveApp();
    if (!appCmd) {
      throw new Error(
        '`cdkd state import` requires a CDK app: pass --app or set it in cdk.json. ' +
          'The template is read to find logical IDs, resource types, and dependencies.'
      );
    }

    logger.info('Synthesizing CDK app to read template...');
    const synthesizer = new Synthesizer();
    const context = parseContextOptions(options.context);
    const result = await synthesizer.synthesize({
      app: appCmd,
      output: options.output || 'cdk.out',
      ...(Object.keys(context).length > 0 && { context }),
    });

    // Stack selection: prefer explicit positional, otherwise auto-pick a single
    // stack when the assembly carries exactly one. Multi-stack assemblies must
    // disambiguate — tag-based imports are per-stack and ambiguity here is
    // worth a clear error rather than guessing.
    let stackInfo;
    if (stackArg) {
      stackInfo = result.stacks.find((s) => s.stackName === stackArg || s.displayName === stackArg);
      if (!stackInfo) {
        throw new Error(
          `Stack '${stackArg}' not found in synthesized app. ` +
            `Available: ${result.stacks.map((s) => s.stackName).join(', ')}`
        );
      }
    } else if (result.stacks.length === 1) {
      stackInfo = result.stacks[0]!;
    } else {
      throw new Error(
        `Multiple stacks found: ${result.stacks.map((s) => s.stackName).join(', ')}. ` +
          `Specify the stack name as a positional argument.`
      );
    }
    const targetRegion = stackInfo.region || region;

    logger.info(`Target stack: ${stackInfo.stackName} (${targetRegion})`);

    // Existing-state guard. `cdkd state import` is destructive on the state
    // file (it overwrites the entire resource map), so we refuse unless the
    // user passes --force. The check is strict on the new region-prefixed key
    // first, then the legacy key — see S3StateBackend.stateExists.
    const existing = await stateBackend.stateExists(stackInfo.stackName, targetRegion);
    if (existing && !options.force) {
      throw new Error(
        `State already exists for stack '${stackInfo.stackName}' (${targetRegion}). ` +
          `Pass --force to overwrite. (cdkd state import rebuilds the resource map from AWS, ` +
          `so the existing state — including any drift you've manually edited — will be lost.)`
      );
    }

    // Parse user-supplied physical-id overrides up front so any syntax error
    // surfaces before we make AWS calls.
    const overrides = parseResourceOverrides(options.resource, options.resourceMapping);
    if (overrides.size > 0) {
      logger.debug(`User-supplied physical IDs: ${[...overrides.keys()].join(', ')}`);
    }

    // Selective vs auto mode. CDK CLI parity: when the user passes
    // `--resource X=Y` (or `--resource-mapping`), only those resources are
    // imported; the rest are skipped (and will be CREATEd on the next
    // deploy). The user can opt into the old hybrid behavior — explicit
    // overrides PLUS tag-based auto-import for everything else — with
    // `--auto`. With no overrides at all, auto mode is implied (the user
    // is asking cdkd to find every resource by tag).
    const selectiveMode = overrides.size > 0 && !options.auto;
    if (selectiveMode) {
      logger.info(
        `Selective mode: only importing the ${overrides.size} resource(s) you listed ` +
          `(${[...overrides.keys()].join(', ')}). ` +
          `Pass --auto to also tag-import the rest.`
      );
    }

    const template = stackInfo.template;
    const templateParser = new TemplateParser();
    const resources = collectImportableResources(template);

    logger.info(`Found ${resources.length} resource(s) in template`);

    // Validate that every override key actually exists in the template —
    // a typo'd logical ID would otherwise be silently ignored in selective
    // mode and the user wouldn't know why their import "did nothing".
    const templateLogicalIds = new Set(resources.map((r) => r.logicalId));
    for (const overrideId of overrides.keys()) {
      if (!templateLogicalIds.has(overrideId)) {
        throw new Error(
          `--resource / --resource-mapping references logical ID '${overrideId}' ` +
            `which is not in the synthesized template for stack '${stackInfo.stackName}'. ` +
            `Available IDs: ${[...templateLogicalIds].join(', ')}`
        );
      }
    }

    // Acquire the lock up front — even in dry-run we want to fail fast if
    // another process is mid-deploy (the dry-run plan would lie about the
    // current AWS state otherwise).
    const owner = `${process.env['USER'] || 'unknown'}@${process.env['HOSTNAME'] || 'host'}:${process.pid}`;
    await lockManager.acquireLock(stackInfo.stackName, targetRegion, owner, 'import');

    try {
      const rows: ImportRow[] = [];
      for (const { logicalId, resource } of resources) {
        // Selective mode: skip resources not in overrides up front. They
        // never hit the provider, so the summary correctly distinguishes
        // "out of scope" from "AWS not found".
        if (selectiveMode && !overrides.has(logicalId)) {
          rows.push({
            logicalId,
            resourceType: resource.Type,
            outcome: 'skipped-out-of-scope',
            reason: 'not in --resource / --resource-mapping (use --auto to include)',
          });
          continue;
        }

        const outcome = await importOne({
          logicalId,
          resource,
          stackName: stackInfo.stackName,
          region: targetRegion,
          providerRegistry,
          override: overrides.get(logicalId),
        });
        rows.push(outcome);
      }

      printSummary(rows);

      if (options.dryRun) {
        logger.info('--dry-run: state will NOT be written. Re-run without --dry-run to apply.');
        return;
      }

      const importedRows = rows.filter((r) => r.outcome === 'imported');
      if (importedRows.length === 0) {
        logger.warn('No resources were successfully imported. State will not be written.');
        return;
      }

      if (!options.yes) {
        const ok = await confirmPrompt(
          `Write state for ${stackInfo.stackName} (${targetRegion}) ` +
            `with ${importedRows.length} resource(s)?`
        );
        if (!ok) {
          logger.info('Import cancelled.');
          return;
        }
      }

      const stackState = buildStackState(
        stackInfo.stackName,
        targetRegion,
        rows,
        templateParser,
        template
      );

      // No `expectedEtag`: --force bypasses the optimistic-lock check on
      // purpose (the user has acknowledged they're overwriting). For the
      // create-from-empty case, the absence of `expectedEtag` is what tells
      // saveState to use IfNoneMatch.
      await stateBackend.saveState(stackInfo.stackName, targetRegion, stackState);
      logger.info(`✓ State written: ${stackInfo.stackName} (${targetRegion})`);
      logger.info(
        `  ${importedRows.length} resource(s) imported. ` +
          `Run 'cdkd diff' to see how the imported state lines up with the template.`
      );
    } finally {
      await lockManager.releaseLock(stackInfo.stackName, targetRegion).catch((err) => {
        logger.warn(`Failed to release lock: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  } finally {
    awsClients.destroy();
  }
}

interface ImportTask {
  logicalId: string;
  resource: TemplateResource;
  stackName: string;
  region: string;
  providerRegistry: ProviderRegistry;
  override: string | undefined;
}

async function importOne(task: ImportTask): Promise<ImportRow> {
  const logger = getLogger();
  const { logicalId, resource, stackName, region, providerRegistry, override } = task;

  if (!providerRegistry.hasProvider(resource.Type)) {
    return {
      logicalId,
      resourceType: resource.Type,
      outcome: 'skipped-no-impl',
      reason: 'no provider registered',
    };
  }

  const provider = providerRegistry.getProvider(resource.Type);
  if (!provider.import) {
    return {
      logicalId,
      resourceType: resource.Type,
      outcome: 'skipped-no-impl',
      reason: `provider does not implement import (yet)`,
    };
  }

  const cdkPath = readCdkPath(resource);
  const input: ResourceImportInput = {
    logicalId,
    resourceType: resource.Type,
    cdkPath,
    stackName,
    region,
    properties: resource.Properties ?? {},
    ...(override !== undefined && { knownPhysicalId: override }),
  };

  try {
    const result: ResourceImportResult | null = await provider.import(input);
    if (!result) {
      return {
        logicalId,
        resourceType: resource.Type,
        outcome: 'skipped-not-found',
        reason: 'no matching AWS resource',
      };
    }
    return {
      logicalId,
      resourceType: resource.Type,
      outcome: 'imported',
      physicalId: result.physicalId,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to import ${logicalId} (${resource.Type}): ${msg}`);
    return {
      logicalId,
      resourceType: resource.Type,
      outcome: 'failed',
      reason: msg,
    };
  }
}

/**
 * Parse `--resource MyBucket=my-bucket-name` flags (repeatable) and
 * `--resource-mapping <file>` JSON file into a single map.
 *
 * The JSON file is `{ "<logicalId>": "<physicalId>", ... }` for CDK CLI
 * `cdk import --resource-mapping` parity.
 *
 * `--resource` flags take precedence over the file when a logicalId appears
 * in both — explicit-on-CLI wins.
 */
function parseResourceOverrides(
  flags: string[] | undefined,
  mappingFile: string | undefined
): Map<string, string> {
  const map = new Map<string, string>();

  if (mappingFile) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(mappingFile, 'utf-8'));
    } catch (err) {
      throw new Error(
        `Failed to read --resource-mapping file '${mappingFile}': ` +
          (err instanceof Error ? err.message : String(err))
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        `--resource-mapping file '${mappingFile}' must be a JSON object {logicalId: physicalId}`
      );
    }
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        throw new Error(
          `--resource-mapping: value for '${key}' must be a string, got ${typeof value}`
        );
      }
      map.set(key, value);
    }
  }

  for (const entry of flags ?? []) {
    const eq = entry.indexOf('=');
    if (eq <= 0 || eq === entry.length - 1) {
      throw new Error(`--resource expects 'logicalId=physicalId', got '${entry}'`);
    }
    map.set(entry.slice(0, eq), entry.slice(eq + 1));
  }

  return map;
}

/**
 * Pull the `aws:cdk:path` value CDK puts in every resource's Metadata.
 *
 * Returns an empty string when not found — providers fall back to other
 * lookup strategies (explicit name, `--resource` override) in that case.
 */
function readCdkPath(resource: TemplateResource): string {
  const meta = resource.Metadata;
  if (!meta) return '';
  const v = (meta as { 'aws:cdk:path'?: unknown })['aws:cdk:path'];
  return typeof v === 'string' ? v : '';
}

/**
 * Walk the template's `Resources` and return the entries we should attempt
 * to import. Filters out CDK metadata sentinels (`AWS::CDK::Metadata`) which
 * are not real AWS resources.
 */
function collectImportableResources(
  template: CloudFormationTemplate
): { logicalId: string; resource: TemplateResource }[] {
  const out: { logicalId: string; resource: TemplateResource }[] = [];
  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    if (resource.Type === 'AWS::CDK::Metadata') continue;
    out.push({ logicalId, resource });
  }
  return out;
}

/**
 * Compose a `StackState` from the per-resource import outcomes plus
 * dependency info recovered from the template.
 *
 * `failed` and `skipped-*` rows are dropped — they are not part of state.
 * Outputs are intentionally not populated: they're computed at deploy time
 * from each resource's attributes, and `cdkd diff` will surface any drift.
 */
function buildStackState(
  stackName: string,
  region: string,
  rows: ImportRow[],
  templateParser: TemplateParser,
  template: CloudFormationTemplate
): StackState {
  const resources: Record<string, ResourceState> = {};
  for (const row of rows) {
    if (row.outcome !== 'imported' || !row.physicalId) continue;
    const tmplResource = template.Resources[row.logicalId];
    if (!tmplResource) continue;
    const deps = templateParser.extractDependencies(tmplResource);
    resources[row.logicalId] = {
      physicalId: row.physicalId,
      resourceType: row.resourceType,
      properties: tmplResource.Properties ?? {},
      attributes: {},
      dependencies: [...deps],
    };
  }
  return {
    version: 2,
    stackName,
    region,
    resources,
    outputs: {},
    lastModified: Date.now(),
  };
}

function printSummary(rows: ImportRow[]): void {
  const logger = getLogger();
  const counts = {
    imported: 0,
    'skipped-no-impl': 0,
    'skipped-not-found': 0,
    'skipped-out-of-scope': 0,
    failed: 0,
  } as Record<ImportOutcome, number>;

  logger.info('');
  logger.info('Import plan:');
  for (const r of rows) {
    counts[r.outcome]++;
    const tag = formatOutcome(r.outcome);
    const detail =
      r.outcome === 'imported' ? ` (${r.physicalId})` : r.reason ? ` — ${r.reason}` : '';
    logger.info(`  ${tag} ${r.logicalId} (${r.resourceType})${detail}`);
  }
  logger.info('');
  logger.info(
    `Summary: ${counts.imported} imported, ${counts['skipped-not-found']} not found, ` +
      `${counts['skipped-no-impl']} unsupported, ` +
      `${counts['skipped-out-of-scope']} out of scope, ${counts.failed} failed`
  );
}

function formatOutcome(outcome: ImportOutcome): string {
  switch (outcome) {
    case 'imported':
      return '✓';
    case 'skipped-not-found':
      return '·';
    case 'skipped-no-impl':
      return '?';
    case 'skipped-out-of-scope':
      return '-';
    case 'failed':
      return '✗';
  }
}

async function confirmPrompt(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await rl.question(`${prompt} [y/N] `);
    return /^y(es)?$/i.test(ans.trim());
  } finally {
    rl.close();
  }
}

/**
 * Create the `cdkd import` top-level command.
 *
 * Sits at the top level (not under `cdkd state`) because, like `deploy` /
 * `destroy` / `diff` / `synth`, it requires a CDK app to synthesize: the
 * template is read to find logical IDs, resource types, and dependencies.
 * (`cdkd state ...` subcommands are reserved for state-only operations
 * that don't need the CDK code.)
 *
 * Three usage modes:
 *
 *   1. **Auto mode** (no overrides): `cdkd import MyStack`
 *      Imports every resource in the template via tag-based lookup
 *      (`aws:cdk:path`). cdkd's value-add over CDK CLI — useful for
 *      adopting a whole stack that was previously deployed by `cdk deploy`.
 *
 *   2. **Selective mode** (CDK CLI parity, default when overrides given):
 *      `cdkd import MyStack --resource MyBucket=my-bucket-name`
 *      `cdkd import MyStack --resource-mapping mapping.json`
 *      ONLY the listed resources are imported; the rest are skipped
 *      ("out of scope") and will be CREATEd on the next deploy. Matches
 *      `cdk import --resource-mapping` semantics.
 *
 *   3. **Hybrid mode** (`--auto` with overrides):
 *      `cdkd import MyStack --resource MyBucket=name --auto`
 *      Listed resources use the explicit physical id; all other
 *      resources still go through tag-based auto-import. The pre-PR
 *      default behavior, now opt-in.
 */
export function createImportCommand(): Command {
  const cmd = new Command('import')
    .description(
      'Adopt already-deployed AWS resources into cdkd state. Reads the CDK app to find ' +
        'logical IDs, resource types, and dependencies. With no flags, imports every ' +
        'resource via the aws:cdk:path tag. With --resource / --resource-mapping, only ' +
        'the listed resources are imported (CDK CLI parity); pass --auto to also tag-import the rest.'
    )
    .argument(
      '[stack]',
      'Stack to import. Optional when the synthesized app contains exactly one stack.'
    )
    .option(
      '--resource <id=physical>',
      'Explicit physical-id override for one logical ID. Repeatable. ' +
        'When at least one --resource is given, only listed resources are imported ' +
        '(CDK CLI parity). Pass --auto to also tag-import everything else.',
      collectMultiple,
      [] as string[]
    )
    .option(
      '--resource-mapping <file>',
      'Path to a JSON file of {logicalId: physicalId} overrides ' +
        '(CDK CLI `cdk import --resource-mapping` compatible). ' +
        'Implies selective mode unless --auto is set.'
    )
    .option(
      '--auto',
      'Hybrid mode: when explicit overrides are supplied, ALSO tag-import ' +
        'every other resource in the template. Without this flag, --resource / ' +
        '--resource-mapping behave as a whitelist (CDK CLI parity).',
      false
    )
    .option('--dry-run', 'Show planned imports without writing state', false)
    .option(
      '--force',
      'Overwrite an existing state record. Without this, an existing state file aborts the import.',
      false
    )
    .action(withErrorHandling(importCommand));

  // Re-use the same option set as `deploy` / `destroy` for parity.
  [...commonOptions, ...appOptions, ...stateOptions, ...contextOptions].forEach((o) =>
    cmd.addOption(o)
  );

  return cmd;
}

function collectMultiple(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}
