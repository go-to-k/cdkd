import { resolve } from 'node:path';
import { Command, Option } from 'commander';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { withErrorHandling, LocalMigrateError } from '../../utils/error-handler.js';
import { getLogger } from '../../utils/logger.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { AwsClients } from '../../utils/aws-clients.js';
import { resolveStateBucketWithDefault } from '../config-loader.js';
import { runImport, type RunImportOptions } from './import.js';
import { retireCloudFormationStack } from './retire-cfn-stack.js';
import { runMigrateLibrary, type RunMigrateLibraryResult } from './migrate/index.js';
import { buildResourceMapping, type ResourceMappingResult } from './migrate/resource-mapper.js';
import {
  readMappingFile,
  writeMappingFile,
  RESOURCE_MAPPING_FILENAME,
} from './migrate/resource-mapping-file.js';

/**
 * Raw CLI options shape after Commander parsing. Mirrors the flag set
 * documented in [docs/design/465-cfn-migrate.md](../../../docs/design/465-cfn-migrate.md) §3
 * minus the negated-default fields Commander handles as boolean
 * (`--retire-cfn-stack` etc.).
 */
export interface MigrateCommandOptions {
  fromCfnStack?: string;
  outputDir?: string;
  language?: 'typescript';
  region?: string;
  account?: string;
  retireCfnStack?: boolean;
  filter?: string[];
  skipInstall?: boolean;
  skipSynth?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  cdkBin?: string;
  resourceMapping?: string;
  stateBucket?: string;
  statePrefix?: string;
  profile?: string;
  roleArn?: string;
  verbose?: boolean;
}

/**
 * `cdkd migrate --from-cfn-stack <name>` end-to-end orchestrator.
 *
 * Closes the CLI half of [#465](https://github.com/go-to-k/cdkd/issues/465).
 * Reads the source CFn stack, runs upstream `cdk migrate` via the PR A
 * library, builds the source → synth logical-ID mapping with the 2-pass
 * algorithm, writes a `cdkd-resource-mapping.json` audit file, prompts
 * for confirmation, invokes `cdkd import` to write state under the
 * synth logical IDs, and (when `--retire-cfn-stack` is set) finally
 * retires the source CFn stack so management responsibility transfers
 * fully to cdkd.
 *
 * AWS resources are never modified — the migration is a metadata
 * transfer only. See [docs/design/465-cfn-migrate.md](../../../docs/design/465-cfn-migrate.md) §7
 * for the post-migration state matrix.
 */
export async function migrateCommandAction(
  positionalStack: string | undefined,
  options: MigrateCommandOptions
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) {
    logger.setLevel('debug');
    process.env['CDKD_NO_LIVE'] = '1';
  }

  // ---- Flag parse + mutual-exclusion guards ----
  // `--from-cfn-stack` is the canonical entrypoint; the positional arg
  // mirrors `cdkd import <stack>`'s shape (so users coming from the
  // import command can rely on muscle memory).
  const sourceCfnStackName = options.fromCfnStack ?? positionalStack;
  if (!sourceCfnStackName) {
    throw new LocalMigrateError(
      'Missing required argument: --from-cfn-stack <name> (or pass the stack name positionally).'
    );
  }
  if (options.retireCfnStack && options.skipSynth) {
    throw new LocalMigrateError(
      '--retire-cfn-stack is incompatible with --skip-synth: the post-state-write retirement ' +
        '(UpdateStack + DeleteStack) cannot run without a synthesized template + cdkd state.'
    );
  }
  if (options.retireCfnStack && options.dryRun) {
    throw new LocalMigrateError(
      '--retire-cfn-stack is incompatible with --dry-run: retirement issues real AWS calls ' +
        '(UpdateStack injects Retain policies, then DeleteStack).'
    );
  }
  if (options.retireCfnStack && options.filter && options.filter.length > 0) {
    throw new LocalMigrateError(
      '--retire-cfn-stack is incompatible with --filter: a partial migration that retires the ' +
        'whole source CFn stack would strand the un-migrated resources. Drop one of the flags ' +
        'or migrate the rest of the stack first.'
    );
  }

  // ---- Role-arn assume up front so all later AWS clients inherit creds ----
  await applyRoleArnIfSet({
    roleArn: options.roleArn,
    region: options.region,
  });

  // ---- Region resolution (mirrors cdkd import / deploy) ----
  const region = options.region || process.env['AWS_REGION'] || 'us-east-1';

  // ---- Output dir resolution (default = cwd + <sourceCfnStackName>) ----
  const outputDir = resolve(options.outputDir ?? sourceCfnStackName);
  logger.info(`[migrate] Source CFn stack: ${sourceCfnStackName}`);
  logger.info(`[migrate] Output directory: ${outputDir}`);

  // ---- Phase 1 + 2: codegen + synth via PR A library ----
  // PR A's runMigrateLibrary handles `cdk` CLI version check, CFn stack
  // pre-fetch, hard-reject of CR / nested-stack / non-terminal-state,
  // output-dir-non-empty refusal, `cdk migrate` subprocess, optional
  // `npm install`, and `cdk synth`. Returns every artifact this
  // orchestrator needs to drive the mapping + import + retire path.
  const libResult: RunMigrateLibraryResult = await runMigrateLibrary({
    fromCfnStack: sourceCfnStackName,
    outputDir,
    language: options.language ?? 'typescript',
    ...(options.region && { region: options.region }),
    ...(options.account && { account: options.account }),
    ...(options.filter && options.filter.length > 0 && { filters: options.filter }),
    ...(options.profile && { profile: options.profile }),
    ...(options.cdkBin && { cdkBinPath: options.cdkBin }),
    skipInstall: options.skipInstall ?? false,
    skipSynth: options.skipSynth ?? false,
  });

  if (options.skipSynth || !libResult.templateBody) {
    logger.info(
      `[migrate] --skip-synth: generated CDK app at ${libResult.outputDir}. ` +
        `Re-run without --skip-synth to write cdkd state.`
    );
    return;
  }

  // ---- Resource-mapping (Pass 1 + Pass 2 + overrides) ----
  // Optional `--resource-mapping <file>` lets users supply explicit
  // pairings up front. Useful for re-running after a partial-failure
  // run hand-edits the previously-written sidecar file.
  let overrides: Record<string, string> | undefined;
  if (options.resourceMapping) {
    const mappingPath = resolve(options.resourceMapping);
    logger.info(`[migrate] Loading user-supplied resource mapping from ${mappingPath}`);
    const file = readMappingFile(mappingPath);
    overrides = file.mapping;
  }

  let mappingResult: ResourceMappingResult;
  try {
    mappingResult = buildResourceMapping({
      sourceCfnTemplate: libResult.sourceCfnTemplate,
      synthTemplate: libResult.templateBody,
      sourceResources: libResult.sourceResources,
      ...(overrides && { overrides }),
    });
  } catch (err) {
    // Override-validation failure (typo'd source / synth id) — surface
    // as `LocalMigrateError` so the CLI handler routes it through the
    // standard exit-code-2 path.
    const detail = err instanceof Error ? err.message : String(err);
    throw new LocalMigrateError(detail);
  }

  // Default output stack name = the source CFn stack name. PR B does
  // not surface a separate `--output-stack-name` flag (would be useful
  // for renaming on migration but is out of scope here; the design doc
  // tracks the case under open question 2).
  const outputStack = sourceCfnStackName;

  // Always write the mapping file before any state write so the user
  // has an auditable record on EVERY path (success / partial failure /
  // full failure / dry-run / "no" at confirmation).
  const mappingFilePath = writeMappingFile(libResult.outputDir, {
    sourceStack: sourceCfnStackName,
    outputStack,
    result: mappingResult,
  });
  logger.info(`[migrate] Resource mapping written to ${mappingFilePath}`);

  if (mappingResult.unmatched.length > 0) {
    const lines = mappingResult.unmatched.map((u) => {
      const candidatesStr =
        u.candidates.length > 0
          ? ` (synth candidates of same Type: ${u.candidates.join(', ')})`
          : ' (no synth resource has the same Type)';
      return `  - ${u.sourceLogicalId} (${u.resourceType}) [${u.reason}]${candidatesStr}`;
    });
    // m5: Thread the resolved mappingFilePath (honors --output-dir) into
    // the error body so the recovery command is copy-pasteable verbatim
    // regardless of whether the user supplied a custom output directory.
    throw new LocalMigrateError(
      `Could not auto-map ${mappingResult.unmatched.length} of ${
        mappingResult.unmatched.length + mappingResult.pairs.length
      } source resource(s) to the synthesized CDK template:\n` +
        `${lines.join('\n')}\n\n` +
        `Edit '${mappingFilePath}'\n` +
        `to add the correct '<sourceLogicalId>: <synthLogicalId>' pairs under "mapping", then re-run:\n` +
        `  cdkd migrate --from-cfn-stack ${sourceCfnStackName} --resource-mapping ${mappingFilePath} --output-dir ${libResult.outputDir}\n` +
        `(The --output-dir override re-uses the already-generated CDK code; drop it if you let the default location be used.)`
    );
  }

  // ---- Print the resolved mapping table (skippable with -y) ----
  printMappingTable(mappingResult, sourceCfnStackName, outputStack);

  if (options.dryRun) {
    logger.info(
      `[migrate] --dry-run: would import ${mappingResult.pairs.length} resource(s) into ` +
        `cdkd state under stack '${outputStack}' (region '${region}'). State NOT written.`
    );
    return;
  }

  if (!options.yes) {
    const ok = await promptConfirm(
      `Import ${mappingResult.pairs.length} resource(s) into cdkd state for stack ` +
        `'${outputStack}' (${region})?`
    );
    if (!ok) {
      logger.info('[migrate] Cancelled by user. No state written.');
      return;
    }
  }

  // ---- Phase 3: cdkd import via the runImport library export ----
  // The import flow re-synthesizes from the generated CDK app's
  // cdk.out directory (passed via `--app`), so we point it at the same
  // assembly the library just wrote. The `resourceMappingInline` field
  // carries our `{synthLogicalId: physicalId}` map so cdkd's import
  // selects every resource via physical-id override + selective-mode
  // semantics — matching the canonical `cdkd import --resource-mapping`
  // shape.
  const importMapping: Record<string, string> = {};
  for (const p of mappingResult.pairs) {
    importMapping[p.synthLogicalId] = p.physicalId;
  }

  // m4: Resolve the state bucket once up-front so a single STS hop
  // covers BOTH the import flow AND the (optional) retire flow. Without
  // this, the retire branch called resolveStateBucketWithDefault again
  // and paid for a redundant STS GetCallerIdentity.
  const resolvedStateBucket = await resolveStateBucketWithDefault(options.stateBucket, region);

  const importOptions: RunImportOptions = {
    app: libResult.assemblyDir,
    statePrefix: options.statePrefix ?? 'cdkd',
    resourceMappingInline: JSON.stringify(importMapping),
    auto: false,
    dryRun: false,
    yes: true, // already prompted above; the import flow's prompt would double-prompt.
    force: false,
    verbose: options.verbose ?? false,
    stateBucket: resolvedStateBucket,
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
    ...(options.roleArn && { roleArn: options.roleArn }),
  };
  await runImport(outputStack, importOptions);

  // ---- Phase 4 (optional): retire the source CFn stack ----
  // Done AFTER state write so a failure here leaves the user with a
  // working cdkd state record they can re-run against. Mirrors the
  // post-state-write retirement that `cdkd import --migrate-from-cloudformation`
  // already does — same `retireCloudFormationStack(...)` helper.
  if (options.retireCfnStack) {
    logger.info(`[migrate] Retiring source CloudFormation stack '${sourceCfnStackName}'...`);
    const cfnConfig: { region?: string; profile?: string } = {};
    if (options.region) cfnConfig.region = options.region;
    if (options.profile) cfnConfig.profile = options.profile;
    const awsClients = new AwsClients(cfnConfig);
    const cfnClient: CloudFormationClient = awsClients.cloudFormation;
    try {
      // Reuse cdkd's state bucket as transient storage for the
      // Retain-injected template when it exceeds the 51,200-byte
      // inline UpdateStack limit (same plumbing as `cdkd import
      // --migrate-from-cloudformation`). Resolved once above (m4).
      await retireCloudFormationStack({
        cfnStackName: sourceCfnStackName,
        cfnClient,
        yes: options.yes ?? false,
        stateBucket: resolvedStateBucket,
        ...(options.profile && { s3ClientOpts: { profile: options.profile } }),
      });
    } finally {
      awsClients.destroy();
    }
  }

  logger.info(
    `[migrate] Migrated ${mappingResult.pairs.length} resource(s) from CloudFormation ` +
      `stack '${sourceCfnStackName}' to cdkd state for stack '${outputStack}'.`
  );
  logger.info(`[migrate] Generated CDK app at ${libResult.outputDir}`);
  if (!options.retireCfnStack) {
    logger.info(
      `[migrate] Source CloudFormation stack '${sourceCfnStackName}' is unchanged. ` +
        `Re-run with --retire-cfn-stack to retire it (or do so manually later).`
    );
  }
}

/**
 * Print a tabular `(sourceLogicalId → synthLogicalId  physicalId)`
 * summary so users can see what's about to be imported before the
 * confirmation prompt. Matches the visual shape of `cdkd import`'s
 * summary table for consistency.
 */
function printMappingTable(
  result: ResourceMappingResult,
  sourceStack: string,
  outputStack: string
): void {
  const logger = getLogger();
  logger.info('');
  logger.info(`[migrate] Resolved mapping (${sourceStack} → ${outputStack}):`);
  for (const p of result.pairs) {
    logger.info(
      `  ${p.sourceLogicalId} → ${p.synthLogicalId}  [${p.resourceType}]  ${p.physicalId}`
    );
  }
  logger.info('');
}

/**
 * Minimal `(y/N)` confirmation prompt using `node:readline`. Mirrors
 * the shape of [src/cli/commands/import.ts](import.ts)'s `confirmPrompt`
 * so the user UX is consistent across the import + migrate surfaces.
 * Non-TTY callers (CI) should pass `--yes` to skip this entirely.
 */
async function promptConfirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new LocalMigrateError(
      `Non-interactive shell detected and --yes was not supplied. ` +
        `Re-run with --yes to confirm: "${message}"`
    );
  }
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${message} (y/N) `);
    const v = answer.trim().toLowerCase();
    return v === 'y' || v === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * Commander factory for `cdkd migrate`. Registered in `src/cli/index.ts`
 * alongside the existing top-level commands. Matches the design doc §3
 * flag set; the action handler routes through {@link migrateCommandAction}
 * via `withErrorHandling` so library callers see exceptions but CLI
 * callers get the standard exit-code-2 routing.
 */
export function createMigrateCommand(): Command {
  const cmd = new Command('migrate')
    .description(
      'Adopt a plain (non-CDK) CloudFormation stack into a cdkd-managed CDK app. ' +
        'Generates new CDK code via upstream `cdk migrate`, builds a logical-ID mapping ' +
        'between the source CFn template and the synth template, writes cdkd state, and ' +
        '(optionally) retires the source CFn stack. AWS resources are never modified.'
    )
    .argument('[stack]', 'Source CFn stack name. Alias for --from-cfn-stack.')
    .addOption(
      new Option(
        '--from-cfn-stack <name>',
        'Source CloudFormation stack name to adopt. Required (or pass positionally).'
      )
    )
    .addOption(
      new Option(
        '--output-dir <dir>',
        'Directory to write the generated CDK app to. Defaults to <cwd>/<CfnStackName>.'
      )
    )
    .addOption(
      new Option('--language <choice>', 'Generated code language. v1: typescript only.')
        .choices(['typescript'])
        .default('typescript')
    )
    .addOption(new Option('--region <region>', 'AWS region. Defaults to AWS_REGION env / profile.'))
    .addOption(new Option('--account <id>', 'AWS account ID. Auto-detected via STS when omitted.'))
    .addOption(
      new Option(
        '--retire-cfn-stack',
        'After cdkd state is written, inject DeletionPolicy=Retain on every ' +
          'resource in the source CFn stack and DeleteStack. AWS resources stay; ' +
          'the CFn stack record is gone. Off by default.'
      ).default(false)
    )
    .addOption(
      new Option(
        '--filter <key=value>',
        'Pass-through to `cdk migrate --filter` for resource subsetting. Repeatable.'
      )
        .argParser((value: string, previous: string[] | undefined) => [...(previous ?? []), value])
        .default([] as string[])
    )
    .addOption(new Option('--skip-install', 'Skip `npm install` after codegen.').default(false))
    .addOption(
      new Option(
        '--skip-synth',
        'Skip `cdk synth` (does NOT write cdkd state). Mutually exclusive with --retire-cfn-stack.'
      ).default(false)
    )
    .addOption(
      new Option(
        '--dry-run',
        'Print the import plan without writing state or retiring the CFn stack. ' +
          'Mutually exclusive with --retire-cfn-stack.'
      ).default(false)
    )
    .addOption(
      new Option('-y, --yes', 'Auto-confirm the import + retirement prompts.').default(false)
    )
    .addOption(new Option('--cdk-bin <path>', 'Override the `cdk` binary path.'))
    .addOption(
      new Option(
        '--resource-mapping <file>',
        'Path to a JSON file of {sourceLogicalId: synthLogicalId} overrides. ' +
          `Same shape as the auto-written ${RESOURCE_MAPPING_FILENAME}.`
      )
    )
    .addOption(
      new Option('--state-bucket <name>', 'cdkd state bucket. Defaults to cdkd-state-<accountId>.')
    )
    .addOption(
      new Option('--state-prefix <prefix>', 'cdkd state prefix inside the bucket.').default('cdkd')
    )
    .addOption(new Option('--profile <name>', 'AWS profile name.'))
    .addOption(new Option('--role-arn <arn>', 'IAM role to assume before any AWS call.'))
    .addOption(new Option('--verbose', 'Enable debug-level logging.').default(false))
    .action(withErrorHandling(migrateCommandAction));

  return cmd;
}

/**
 * Re-export the helpers downstream tooling may consume — keeps the
 * migrate module surface narrow but lets the integ harness (or third-
 * party orchestrators) reuse the same building blocks.
 */
export { RESOURCE_MAPPING_FILENAME, readMappingFile, writeMappingFile };
