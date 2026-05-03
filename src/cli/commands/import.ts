import { readFileSync, writeFileSync } from 'node:fs';
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
import { readCdkPath } from '../cdk-path.js';
import { retireCloudFormationStack, getCloudFormationResourceMapping } from './retire-cfn-stack.js';
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
  resourceMappingInline?: string;
  /**
   * If set, write the resolved `{logicalId: physicalId}` map for every
   * `imported` outcome to this path before the confirmation prompt.
   * Mirrors upstream `cdk import --record-resource-mapping <file>`. The
   * file is written even if the user says "no" to the prompt — the data
   * was resolved either way and is useful for re-runs.
   */
  recordResourceMapping?: string;
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
  /**
   * After successfully writing cdkd state, retire the named CloudFormation
   * stack: inject `DeletionPolicy: Retain` + `UpdateReplacePolicy: Retain`
   * on every resource via UpdateStack, then DeleteStack. AWS resources are
   * left intact (now solely managed by cdkd). Pass `true` to use the cdkd
   * stack name as the CFn stack name (the common case for CDK-deployed
   * stacks); pass a string to override when the CFn stack name differs.
   */
  migrateFromCloudformation?: boolean | string;
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

    // Parse user-supplied physical-id overrides up front so any syntax error
    // surfaces before we make AWS calls.
    const overrides = parseResourceOverrides(
      options.resource,
      options.resourceMapping,
      options.resourceMappingInline
    );
    if (overrides.size > 0) {
      logger.debug(`User-supplied physical IDs: ${[...overrides.keys()].join(', ')}`);
    }

    // Resolve the CloudFormation stack name we're migrating off, when the
    // user opted in. Done up front so we can populate overrides BEFORE the
    // selective-mode decision below.
    const migrationCfnStackName = options.migrateFromCloudformation
      ? typeof options.migrateFromCloudformation === 'string' &&
        options.migrateFromCloudformation.length > 0
        ? options.migrateFromCloudformation
        : stackInfo.stackName
      : undefined;
    if (options.migrateFromCloudformation && options.dryRun) {
      throw new Error(
        '--migrate-from-cloudformation is not compatible with --dry-run: ' +
          'the post-state-write retirement (UpdateStack + DeleteStack) issues real AWS calls. ' +
          'Use plain `cdkd import --dry-run` to preview the import in isolation.'
      );
    }
    // Compute the importable-template set up front. We need it both for
    // the existing-state guard's selective-mode decision below AND for
    // filtering the CFn-derived migration mapping (CFn knows about
    // sentinel resources like `AWS::CDK::Metadata` that cdkd silently
    // skips on import — those mustn't be merged into `overrides` or the
    // typo-validation step would reject them).
    const template = stackInfo.template;
    const templateParser = new TemplateParser();
    const resources = collectImportableResources(template);
    const templateLogicalIds = new Set(resources.map((r) => r.logicalId));
    logger.info(`Found ${resources.length} resource(s) in template`);

    if (migrationCfnStackName) {
      // Pre-populate overrides from the source CFn stack via a single
      // `DescribeStackResources` call. This is the load-bearing piece that
      // makes `cdk deploy`-managed stacks importable by cdkd without per-
      // resource `--resource <id>=<physical>` flags: cdkd's tag-based auto-
      // lookup can't find those resources (upstream `cdk deploy` doesn't
      // propagate `aws:cdk:path` as a real AWS tag, and AWS reserves the
      // `aws:` tag prefix so we can't add it on the way through either),
      // so we ask CloudFormation directly. User-supplied `--resource` /
      // `--resource-mapping` entries take precedence — they were inserted
      // into `overrides` first. Logical IDs CFn knows about but cdkd's
      // import skips (e.g. `AWS::CDK::Metadata`) are filtered out here.
      logger.info(`Resolving physical IDs from CloudFormation stack '${migrationCfnStackName}'...`);
      const cfnMapping = await getCloudFormationResourceMapping(
        migrationCfnStackName,
        awsClients.cloudFormation
      );
      let derived = 0;
      let skippedNonImportable = 0;
      for (const [logicalId, physicalId] of cfnMapping) {
        if (!templateLogicalIds.has(logicalId)) {
          skippedNonImportable++;
          continue;
        }
        if (!overrides.has(logicalId)) {
          overrides.set(logicalId, physicalId);
          derived++;
        }
      }
      const overriddenByUser = cfnMapping.size - derived - skippedNonImportable;
      const detail: string[] = [];
      if (overriddenByUser > 0) detail.push(`${overriddenByUser} already overridden by --resource`);
      if (skippedNonImportable > 0)
        detail.push(`${skippedNonImportable} non-importable (e.g. CDKMetadata)`);
      logger.info(
        `Resolved ${derived} physical ID(s) from CloudFormation` +
          (detail.length > 0 ? ` (${detail.join(', ')})` : '')
      );
    }

    // Selective vs auto mode. CDK CLI parity: when the user passes
    // `--resource X=Y` (or `--resource-mapping`), only those resources are
    // imported; the rest are skipped (and will be CREATEd on the next
    // deploy). The user can opt into the old hybrid behavior — explicit
    // overrides PLUS tag-based auto-import for everything else — with
    // `--auto`. With no overrides at all, auto mode is implied (the user
    // is asking cdkd to find every resource by tag).
    //
    // `--migrate-from-cloudformation` always implies whole-stack auto mode:
    // every CFn-derived override is part of the same migration intent, so
    // the user shouldn't need to also pass `--auto` to avoid selective mode.
    const selectiveMode = overrides.size > 0 && !options.auto && !options.migrateFromCloudformation;
    if (selectiveMode) {
      logger.info(
        `Selective mode: only importing the ${overrides.size} resource(s) you listed ` +
          `(${[...overrides.keys()].join(', ')}). ` +
          `Pass --auto to also tag-import the rest.`
      );
    }

    // Existing-state guard. The previous implementation refused with
    // `--force` required for any pre-existing state and then unconditionally
    // overwrote the entire resource map — which silently dropped unlisted
    // resources in selective mode. The new policy distinguishes destructive
    // from non-destructive cases:
    //
    //   - Selective mode (overrides without --auto) is **non-destructive**:
    //     unlisted resources are preserved on merge. `--force` is only
    //     required when one of the listed resources is already in state
    //     (the merge would overwrite that entry).
    //   - Auto / whole-stack mode is **destructive**: it rebuilds the
    //     resource map from the template, dropping any state entry not
    //     re-imported. `--force` is required whenever existing state exists.
    //
    // We load existing state up front (rather than just checking presence)
    // so we can both (a) merge in selective mode and (b) forward the etag
    // to `saveState` for optimistic locking.
    const existingResult = await stateBackend.getState(stackInfo.stackName, targetRegion);
    const existingState = existingResult?.state ?? null;
    const existingEtag = existingResult?.etag;
    const migrationPending = existingResult?.migrationPending ?? false;

    if (existingState) {
      if (!selectiveMode) {
        // Auto / whole-stack: always destructive when state exists.
        if (!options.force) {
          throw new Error(
            `State already exists for stack '${stackInfo.stackName}' (${targetRegion}). ` +
              `Auto / whole-stack import rebuilds the entire resource map from the template, ` +
              `which would drop any state entry not re-imported. Pass --force to confirm. ` +
              `To add specific resources without affecting unlisted ones, use ` +
              `--resource <id>=<physicalId> (selective merge — no --force needed).`
          );
        }
      } else {
        // Selective merge: non-destructive for unlisted resources. `--force`
        // is only needed when a listed override would overwrite an entry
        // already in state.
        const conflicts = [...overrides.keys()].filter((id) =>
          Object.prototype.hasOwnProperty.call(existingState.resources, id)
        );
        if (conflicts.length > 0 && !options.force) {
          throw new Error(
            `Selective import would overwrite resource(s) already in state: ` +
              `${conflicts.join(', ')}. ` +
              `Pass --force to confirm the overwrite, or remove these IDs from --resource / --resource-mapping.`
          );
        }
        const preservedCount = Object.keys(existingState.resources).filter(
          (id) => !overrides.has(id)
        ).length;
        logger.info(
          `Merging into existing state for ${stackInfo.stackName} (${targetRegion}): ` +
            `preserving ${preservedCount} unlisted resource(s)` +
            (conflicts.length > 0 ? `, overwriting ${conflicts.length} listed entry(ies)` : '')
        );
      }
    }

    // Validate that every override key actually exists in the template —
    // a typo'd logical ID would otherwise be silently ignored in selective
    // mode and the user wouldn't know why their import "did nothing".
    // (`template` / `resources` / `templateLogicalIds` are computed
    // earlier so the migration block can filter out non-importable IDs
    // before they land in `overrides`.)
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

      // Write the resolved logicalId→physicalId mapping out for re-use in
      // CI (mirrors upstream `cdk import --record-resource-mapping`).
      // Done BEFORE any early-return / confirmation: --dry-run, "no" at
      // the prompt, and zero-imports all still produce the file. Empty
      // mapping serializes as `{}` rather than being omitted, so callers
      // can detect "ran but nothing matched" vs "did not run". A write
      // failure here is logged but does NOT abort: the import already
      // happened in memory, and the record file is metadata.
      if (options.recordResourceMapping) {
        writeRecordedMapping(options.recordResourceMapping, rows);
      }

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
        // In a selective merge, the resulting state holds the imported rows
        // PLUS the preserved unlisted entries from existing state. Reflect
        // that in the prompt so the user sees the full impact, not just
        // what's being added in this run.
        const importedCount = importedRows.length;
        const preservedCount =
          selectiveMode && existingState
            ? Object.keys(existingState.resources).filter((id) => !overrides.has(id)).length
            : 0;
        const totalAfter = importedCount + preservedCount;
        const breakdown =
          preservedCount > 0
            ? ` (${importedCount} new/overwritten + ${preservedCount} preserved)`
            : '';
        const ok = await confirmPrompt(
          `Write state for ${stackInfo.stackName} (${targetRegion}) ` +
            `with ${totalAfter} resource(s)${breakdown}?`
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
        template,
        existingState,
        selectiveMode
      );

      // Forward the etag for optimistic locking when state already exists,
      // and trigger legacy-key migration when the existing state was loaded
      // from the v1 layout. For the create-from-empty case, the absence of
      // `expectedEtag` is what tells saveState to use IfNoneMatch.
      const saveOptions: { expectedEtag?: string; migrateLegacy?: boolean } = {};
      if (existingEtag) {
        saveOptions.expectedEtag = existingEtag;
      }
      if (migrationPending) {
        saveOptions.migrateLegacy = true;
      }
      await stateBackend.saveState(stackInfo.stackName, targetRegion, stackState, saveOptions);
      logger.info(`✓ State written: ${stackInfo.stackName} (${targetRegion})`);
      logger.info(
        `  ${importedRows.length} resource(s) imported. ` +
          `Run 'cdkd diff' to see how the imported state lines up with the template.`
      );

      // Optional: retire the source CloudFormation stack now that cdkd state
      // is committed. Done AFTER state write so a failure here leaves the
      // user with a working cdkd state record they can re-run against, or
      // fall back to retiring the CFn stack manually. Stays inside the
      // lock-protected `try` block so a concurrent `cdkd deploy` can't race
      // the post-write CFn calls.
      if (migrationCfnStackName) {
        // Partial-import warning: some template resources didn't make it
        // into cdkd state (AWS-not-found, no provider, or out-of-scope).
        // After DeleteStack those resources keep existing in AWS but are
        // unmanaged by both CFn (Retain causes DeleteStack to skip them)
        // AND cdkd (never written to state). Surface that out loud so the
        // user can either re-import or accept the orphaning intentionally.
        const orphaned = resources.length - importedRows.length;
        if (orphaned > 0) {
          logger.warn(
            `--migrate-from-cloudformation: ${orphaned} of ${resources.length} ` +
              `template resource(s) were NOT imported into cdkd. After the ` +
              `CloudFormation stack is retired, those resources remain in AWS ` +
              `but are unmanaged by both CloudFormation and cdkd.`
          );
        }
        await retireCloudFormationStack({
          cfnStackName: migrationCfnStackName,
          cfnClient: awsClients.cloudFormation,
          yes: options.yes,
        });
      }
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
 * Parse `--resource MyBucket=my-bucket-name` flags (repeatable),
 * `--resource-mapping <file>` JSON file, and `--resource-mapping-inline
 * '<json>'` JSON string into a single override map.
 *
 * The JSON shape (file or inline) is `{ "<logicalId>": "<physicalId>", ... }`
 * for CDK CLI `cdk import --resource-mapping` / `--resource-mapping-inline`
 * parity.
 *
 * `--resource-mapping` and `--resource-mapping-inline` are mutually
 * exclusive (matches upstream `cdk import`): the user picks one source.
 *
 * `--resource` flags take precedence over the JSON source when a logicalId
 * appears in both — explicit-on-CLI wins.
 */
function parseResourceOverrides(
  flags: string[] | undefined,
  mappingFile: string | undefined,
  mappingInline: string | undefined
): Map<string, string> {
  const map = new Map<string, string>();

  if (mappingFile && mappingInline) {
    throw new Error(
      '--resource-mapping and --resource-mapping-inline are mutually exclusive; pass only one.'
    );
  }

  if (mappingFile) {
    let raw: string;
    try {
      raw = readFileSync(mappingFile, 'utf-8');
    } catch (err) {
      throw new Error(
        `Failed to read --resource-mapping file '${mappingFile}': ` +
          (err instanceof Error ? err.message : String(err))
      );
    }
    const parsed = parseMappingJson(raw, `--resource-mapping file '${mappingFile}'`);
    for (const [key, value] of Object.entries(parsed)) {
      map.set(key, value);
    }
  }

  if (mappingInline) {
    const parsed = parseMappingJson(mappingInline, '--resource-mapping-inline');
    for (const [key, value] of Object.entries(parsed)) {
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
 * Parse a `{logicalId: physicalId}` JSON document — either a file body
 * (for `--resource-mapping`) or an inline string (for
 * `--resource-mapping-inline`). The `source` label is woven into error
 * messages so the user can tell which input failed.
 */
function parseMappingJson(raw: string, source: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse ${source} as JSON: ` + (err instanceof Error ? err.message : String(err))
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${source} must be a JSON object {logicalId: physicalId}`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new Error(`${source}: value for '${key}' must be a string, got ${typeof value}`);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Write the resolved `{logicalId: physicalId}` map to disk for re-use
 * (mirrors upstream `cdk import --record-resource-mapping <file>`).
 *
 * Inclusion rules: only `imported` rows. `skipped-*` and `failed` rows
 * are excluded — they do not represent a usable physical id.
 *
 * Format: pretty-printed JSON with 2-space indent + trailing newline,
 * so the file is human-reviewable before the user confirms the import.
 *
 * Failure: logged via `logger.error` but NOT thrown. The import has
 * already resolved every physical id in memory; failing to persist the
 * record file is a metadata problem, not a load-bearing one.
 */
function writeRecordedMapping(filePath: string, rows: ImportRow[]): void {
  const logger = getLogger();
  const map: Record<string, string> = {};
  for (const row of rows) {
    if (row.outcome === 'imported' && row.physicalId) {
      map[row.logicalId] = row.physicalId;
    }
  }
  const body = JSON.stringify(map, null, 2) + '\n';
  try {
    writeFileSync(filePath, body, 'utf-8');
    logger.info(`Wrote resolved mapping to ${filePath} (${Object.keys(map).length} entry(ies))`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      `Failed to write --record-resource-mapping file '${filePath}': ${msg}. ` +
        `Continuing — the import already resolved every physical id in memory.`
    );
  }
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
 *
 * Resource-map composition depends on the mode:
 *   - `selectiveMode && existingState`: existing resources are the merge
 *     base, every entry survives unless explicitly overwritten by an
 *     `imported` row. Non-destructive for unlisted resources.
 *   - Auto / whole-stack: the resource map is rebuilt from scratch so any
 *     state entry not re-imported is dropped (the user opted into this with
 *     `--force`).
 *
 * Outputs are ALWAYS inherited from `existingState` when present — the
 * import flow never derives outputs (they're computed at deploy time from
 * each resource's attributes), so even an auto-mode rebuild has no reason
 * to wipe them.
 */
function buildStackState(
  stackName: string,
  region: string,
  rows: ImportRow[],
  templateParser: TemplateParser,
  template: CloudFormationTemplate,
  existingState: StackState | null,
  selectiveMode: boolean
): StackState {
  const resources: Record<string, ResourceState> =
    selectiveMode && existingState ? { ...existingState.resources } : {};
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
    outputs: existingState?.outputs ?? {},
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
 *      `cdkd import MyStack --resource-mapping-inline '{"MyBucket":"my-bucket-name"}'`
 *      ONLY the listed resources are imported; the rest are skipped
 *      ("out of scope") and will be CREATEd on the next deploy. Matches
 *      `cdk import --resource-mapping` / `--resource-mapping-inline`
 *      semantics.
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
        'Implies selective mode unless --auto is set. ' +
        'Mutually exclusive with --resource-mapping-inline.'
    )
    .option(
      '--resource-mapping-inline <json>',
      'Inline JSON object of {logicalId: physicalId} overrides ' +
        '(CDK CLI `cdk import --resource-mapping-inline` compatible). ' +
        'Same shape as --resource-mapping but supplied as a string — useful ' +
        'for non-TTY CI scripts that do not want a separate file. ' +
        'Implies selective mode unless --auto is set. ' +
        'Mutually exclusive with --resource-mapping.'
    )
    .option(
      '--record-resource-mapping <file>',
      'After cdkd resolves every logical ID (via --resource / --resource-mapping / ' +
        'tag-based auto-lookup), write the resulting {logicalId: physicalId} map ' +
        'to <file> as JSON. Useful in auto / hybrid mode for capturing the ' +
        'tag-resolved mapping and feeding it back as --resource-mapping in ' +
        'non-interactive CI re-runs. Written before the confirmation prompt ' +
        '(so the user can review the file before saying "yes") and even when the ' +
        'user says "no". Mirrors `cdk import --record-resource-mapping`.'
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
      'Confirm a destructive write to existing state. Required for auto / whole-stack ' +
        'import when state already exists (rebuilds the entire resource map). Also required ' +
        'in selective mode if a listed override would overwrite a resource already in state. ' +
        'Not needed for a pure selective merge (adding new resources without touching unlisted entries).',
      false
    )
    .option(
      '--migrate-from-cloudformation [cfn-stack-name]',
      'After cdkd state is written, retire the named CloudFormation stack ' +
        '(deletes the CFn stack record; AWS resources are NOT deleted): ' +
        'inject DeletionPolicy=Retain and UpdateReplacePolicy=Retain on every ' +
        'resource via UpdateStack, then DeleteStack. cdkd takes over management. ' +
        'Pass without a value to use the cdkd stack name as the CFn stack name ' +
        '(the typical case for a CDK app that was previously deployed via ' +
        '`cdk deploy`); pass an explicit value when the CFn stack name differs.'
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
