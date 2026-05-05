import { Command, Option } from 'commander';
import {
  commonOptions,
  deprecatedRegionOption,
  stateOptions,
  warnIfDeprecatedRegion,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { CdkdError, withErrorHandling } from '../../utils/error-handler.js';
import { S3StateBackend, type StackStateRef } from '../../state/s3-state-backend.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { resolveStateBucketWithDefault } from '../config-loader.js';
import { ProviderRegistry } from '../../provisioning/provider-registry.js';
import { registerAllProviders } from '../../provisioning/register-providers.js';
import { calculateResourceDrift, type PropertyDrift } from '../../analyzer/drift-calculator.js';
import { withStackName } from '../../provisioning/resource-name.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import type { StackState } from '../../types/state.js';

/**
 * Per-resource drift outcome surfaced by the drift command.
 *
 * The three terminal states are:
 *   - `drifted` — at least one property differs between state and AWS.
 *   - `clean` — every state-recorded property matches AWS.
 *   - `unsupported` — the provider does not implement `readCurrentState`
 *     yet (the optional method returned `undefined`). Reported separately
 *     so users see what's still uncovered.
 */
type DriftOutcome =
  | { kind: 'drifted'; logicalId: string; resourceType: string; changes: PropertyDrift[] }
  | { kind: 'clean'; logicalId: string; resourceType: string }
  | { kind: 'unsupported'; logicalId: string; resourceType: string };

/**
 * Aggregated drift report for one stack — what gets printed (or emitted as
 * JSON) for that stack. Aggregation across multiple stacks happens in the
 * top-level command driver.
 */
interface StackDriftReport {
  stackName: string;
  region: string;
  outcomes: DriftOutcome[];
}

/**
 * Distinguish "drift detected" (exit 1) from "command crashed" (exit 1
 * via the default handler) so the drift command can fail fast and the
 * top-level handler doesn't add a stack trace for the expected case.
 *
 * Carries no message of its own — the command body printed the report
 * before throwing, so the handler suppresses the duplicate `error()`.
 */
class DriftDetectedError extends CdkdError {
  readonly silent: boolean = true;

  constructor() {
    super('drift detected', 'DRIFT_DETECTED');
    this.name = 'DriftDetectedError';
    Object.setPrototypeOf(this, DriftDetectedError.prototype);
  }
}

/**
 * `cdkd drift <stack> [<stack>...]` command implementation.
 *
 * Reads each named stack's state from S3, asks every resource's provider
 * for its `readCurrentState` snapshot, and compares against the
 * state-recorded `properties`. Outputs a per-stack report and exits with:
 *
 *   - 0 — every inspected stack has zero drift.
 *   - 1 — at least one resource drifted, OR the command crashed (no state,
 *         AWS error, bad arguments, etc.). Both go through the default
 *         error handler. Drift detection emits the rich human report
 *         before throwing a `silent: true` error so the report is the
 *         only output for the drift case.
 *
 * Detection only — `--accept` / `--revert` are out of scope for this PR
 * and will be added in a follow-up.
 */
async function driftCommand(
  stacks: string[],
  options: {
    all?: boolean;
    json: boolean;
    stateBucket?: string;
    statePrefix: string;
    region?: string;
    stackRegion?: string;
    profile?: string;
    verbose: boolean;
    yes?: boolean;
    roleArn?: string;
  }
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) {
    logger.setLevel('debug');
  }

  warnIfDeprecatedRegion(options);

  if (!options.all && stacks.length === 0) {
    throw new Error('Stack name is required. Usage: cdkd drift <stack> [<stack>...] | --all');
  }

  // Resolve --role-arn / CDKD_ROLE_ARN before any AWS call.
  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

  const awsClients = new AwsClients({
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  try {
    const region = options.region || process.env['AWS_REGION'] || 'us-east-1';
    const bucket = await resolveStateBucketWithDefault(options.stateBucket, region);
    const prefix = options.statePrefix;

    const stateBackend = new S3StateBackend(
      awsClients.s3,
      { bucket, prefix },
      {
        region,
        ...(options.profile && { profile: options.profile }),
      }
    );
    await stateBackend.verifyBucketExists();

    const providerRegistry = new ProviderRegistry();
    registerAllProviders(providerRegistry);
    providerRegistry.setCustomResourceResponseBucket(bucket);

    const stateRefs = await stateBackend.listStacks();
    const targetRefs = resolveTargetRefs(stacks, stateRefs, options);

    const reports: StackDriftReport[] = [];
    for (const ref of targetRefs) {
      if (!ref.region) {
        // Legacy `version: 1` records have no region in their key — same
        // gap surfaced by `state show`. Tell the user how to migrate.
        throw new Error(
          `Stack '${ref.stackName}' has only a legacy state record without a region. ` +
            `Run 'cdkd deploy ${ref.stackName}' (or any cdkd write) to migrate it to the region-scoped layout, ` +
            `then re-run drift detection.`
        );
      }
      const report = await runDriftForStack(
        ref.stackName,
        ref.region,
        stateBackend,
        providerRegistry
      );
      reports.push(report);
    }

    if (options.json) {
      writeJsonReport(reports);
    } else {
      writeHumanReport(reports);
    }

    const drifted = reports.some((r) => r.outcomes.some((o) => o.kind === 'drifted'));
    if (drifted) {
      throw new DriftDetectedError();
    }
  } finally {
    awsClients.destroy();
  }
}

/**
 * Resolve the set of `(stackName, region)` pairs the command should
 * inspect. With `--all`, every state record qualifies; without `--all`,
 * each positional pattern is matched against the state index using the
 * same exact-name + region disambiguation rules as `state destroy`.
 */
function resolveTargetRefs(
  stacks: string[],
  stateRefs: StackStateRef[],
  options: { all?: boolean; stackRegion?: string }
): StackStateRef[] {
  if (options.all) {
    if (stateRefs.length === 0) {
      throw new Error('No stacks found in state bucket.');
    }
    if (options.stackRegion) {
      return stateRefs.filter((r) => r.region === options.stackRegion);
    }
    return stateRefs;
  }

  const out: StackStateRef[] = [];
  for (const stackName of stacks) {
    const matches = stateRefs.filter((r) => r.stackName === stackName);
    if (matches.length === 0) {
      throw new Error(
        `No state found for stack '${stackName}'. Run 'cdkd state list' to see available stacks.`
      );
    }
    if (options.stackRegion) {
      const ref = matches.find((r) => r.region === options.stackRegion);
      if (!ref) {
        const seen = matches.map((r) => r.region ?? '(legacy)').join(', ');
        throw new Error(
          `No state found for stack '${stackName}' in region '${options.stackRegion}'. ` +
            `Available regions: ${seen}.`
        );
      }
      out.push(ref);
      continue;
    }
    if (matches.length === 1) {
      out.push(matches[0]!);
      continue;
    }
    const regions = matches.map((r) => r.region ?? '(legacy)').join(', ');
    throw new Error(
      `Stack '${stackName}' has state in multiple regions: ${regions}. ` +
        `Re-run with --stack-region <region> to disambiguate.`
    );
  }
  return out;
}

/**
 * Run drift detection for one stack and shape the per-resource outcomes
 * into a {@link StackDriftReport}.
 */
async function runDriftForStack(
  stackName: string,
  region: string,
  stateBackend: S3StateBackend,
  providerRegistry: ProviderRegistry
): Promise<StackDriftReport> {
  const result = await stateBackend.getState(stackName, region);
  if (!result) {
    throw new Error(
      `No state found for stack '${stackName}' (${region}). Run 'cdkd state list' to see available stacks.`
    );
  }

  return await withStackName(stackName, async () => {
    const outcomes: DriftOutcome[] = [];
    const state: StackState = result.state;
    const entries = Object.entries(state.resources ?? {}).sort(([a], [b]) => a.localeCompare(b));

    for (const [logicalId, resource] of entries) {
      if (providerRegistry.shouldSkipResource(resource.resourceType)) {
        continue;
      }
      let provider;
      try {
        provider = providerRegistry.getProvider(resource.resourceType);
      } catch {
        outcomes.push({
          kind: 'unsupported',
          logicalId,
          resourceType: resource.resourceType,
        });
        continue;
      }

      if (!provider.readCurrentState) {
        outcomes.push({
          kind: 'unsupported',
          logicalId,
          resourceType: resource.resourceType,
        });
        continue;
      }

      const aws = await provider.readCurrentState(
        resource.physicalId,
        logicalId,
        resource.resourceType
      );
      if (aws === undefined) {
        outcomes.push({
          kind: 'unsupported',
          logicalId,
          resourceType: resource.resourceType,
        });
        continue;
      }

      const changes = calculateResourceDrift(resource.properties ?? {}, aws);
      if (changes.length === 0) {
        outcomes.push({ kind: 'clean', logicalId, resourceType: resource.resourceType });
      } else {
        outcomes.push({
          kind: 'drifted',
          logicalId,
          resourceType: resource.resourceType,
          changes,
        });
      }
    }

    return { stackName, region, outcomes };
  });
}

/**
 * JSON output shape — stable contract for tooling. Each stack carries
 * separate `drifted` / `notSupported` arrays so consumers don't have to
 * filter by `kind`.
 */
interface StackDriftJson {
  stack: string;
  region: string;
  drifted: Array<{
    logicalId: string;
    type: string;
    changes: Array<{ path: string; stateValue: unknown; awsValue: unknown }>;
  }>;
  clean: Array<{ logicalId: string; type: string }>;
  notSupported: Array<{ logicalId: string; type: string }>;
}

function writeJsonReport(reports: StackDriftReport[]): void {
  const payload: StackDriftJson[] = reports.map((r) => {
    const drifted = r.outcomes
      .filter((o): o is Extract<DriftOutcome, { kind: 'drifted' }> => o.kind === 'drifted')
      .map((o) => ({ logicalId: o.logicalId, type: o.resourceType, changes: o.changes }));
    const clean = r.outcomes
      .filter((o): o is Extract<DriftOutcome, { kind: 'clean' }> => o.kind === 'clean')
      .map((o) => ({ logicalId: o.logicalId, type: o.resourceType }));
    const notSupported = r.outcomes
      .filter((o): o is Extract<DriftOutcome, { kind: 'unsupported' }> => o.kind === 'unsupported')
      .map((o) => ({ logicalId: o.logicalId, type: o.resourceType }));
    return { stack: r.stackName, region: r.region, drifted, clean, notSupported };
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function writeHumanReport(reports: StackDriftReport[]): void {
  for (const report of reports) {
    const drifted = report.outcomes.filter(
      (o): o is Extract<DriftOutcome, { kind: 'drifted' }> => o.kind === 'drifted'
    );
    const unsupported = report.outcomes.filter(
      (o): o is Extract<DriftOutcome, { kind: 'unsupported' }> => o.kind === 'unsupported'
    );
    const total = report.outcomes.length;

    if (drifted.length === 0) {
      process.stdout.write(
        `✓ ${report.stackName} (${report.region}): no drift detected ` +
          `(${total} resource${total === 1 ? '' : 's'} checked, ${unsupported.length} unsupported)\n`
      );
    } else {
      const word = drifted.length === 1 ? 'resource' : 'resources';
      process.stdout.write(
        `\n⚠ ${report.stackName} (${report.region}): drift detected on ${drifted.length} ${word}\n\n`
      );
      for (const o of drifted) {
        process.stdout.write(`  ~ ${o.logicalId} (${o.resourceType})\n`);
        for (const change of o.changes) {
          process.stdout.write(`    - ${change.path}: ${formatScalar(change.stateValue)}\n`);
          process.stdout.write(`    + ${change.path}: ${formatScalar(change.awsValue)}\n`);
        }
        process.stdout.write('\n');
      }
    }

    if (unsupported.length > 0) {
      process.stdout.write(
        `\n  ${unsupported.length} resource(s) reported as drift unknown — ` +
          `provider does not yet support drift detection:\n`
      );
      for (const o of unsupported) {
        process.stdout.write(`    ? ${o.logicalId} (${o.resourceType})\n`);
      }
    }
  }
}

/**
 * Render a value for the `+/-` lines in the human-readable diff. Scalars
 * pass through; structured values are JSON-encoded inline so a multi-line
 * value doesn't break the visual alignment.
 */
function formatScalar(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * Reusable `--stack-region <region>` option (mirrors `state show`).
 */
function stackRegionOption(): Option {
  return new Option(
    '--stack-region <region>',
    'Region of the stack record to inspect. Required when the same stack name has state in multiple regions.'
  );
}

/**
 * Create the `drift` command.
 */
export function createDriftCommand(): Command {
  const cmd = new Command('drift')
    .description(
      'Detect drift between cdkd state and AWS reality. Exits 0 when no drift, 1 when drift is detected.'
    )
    .argument('[stacks...]', 'Stack name(s) to check (physical CloudFormation names)')
    .option('--all', 'Check every stack in the state bucket', false)
    .option('--json', 'Output as JSON', false)
    .addOption(stackRegionOption())
    .action(withErrorHandling(driftCommand));

  [...commonOptions, ...stateOptions].forEach((opt) => cmd.addOption(opt));

  cmd.addOption(deprecatedRegionOption);

  return cmd;
}
