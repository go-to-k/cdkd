import * as readline from 'node:readline/promises';
import { Command, Option } from 'commander';
import {
  commonOptions,
  deprecatedRegionOption,
  stateOptions,
  warnIfDeprecatedRegion,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import {
  CdkdError,
  PartialFailureError,
  ResourceUpdateNotSupportedError,
  withErrorHandling,
} from '../../utils/error-handler.js';
import { S3StateBackend, type StackStateRef } from '../../state/s3-state-backend.js';
import { LockManager } from '../../state/lock-manager.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { resolveStateBucketWithDefault } from '../config-loader.js';
import { ProviderRegistry } from '../../provisioning/provider-registry.js';
import { registerAllProviders } from '../../provisioning/register-providers.js';
import { calculateResourceDrift, type PropertyDrift } from '../../analyzer/drift-calculator.js';
import { CC_API_FALLBACK_DENY_LIST } from '../../analyzer/drift-cc-api-deny-list.js';
import { stripCcApiAwsManagedFields } from '../../analyzer/cc-api-strip.js';
import { CloudControlProvider } from '../../provisioning/cloud-control-provider.js';
import { withStackName } from '../../provisioning/resource-name.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { withRetry } from '../../deployment/retry.js';
import type { ResourceProvider } from '../../types/resource.js';
import type { ResourceState, StackState } from '../../types/state.js';

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
  | {
      kind: 'drifted';
      logicalId: string;
      resourceType: string;
      changes: PropertyDrift[];
      /**
       * Snapshot of AWS-current properties returned by the provider's
       * `readCurrentState`. Captured here so `--revert` can pass it to
       * `provider.update` as the `previousProperties` argument without
       * re-issuing the read.
       */
      awsProperties: Record<string, unknown>;
    }
  | { kind: 'clean'; logicalId: string; resourceType: string }
  | { kind: 'unsupported'; logicalId: string; resourceType: string };

/**
 * Aggregated drift report for one stack — what gets printed (or emitted as
 * JSON) for that stack. Aggregation across multiple stacks happens in the
 * top-level command driver.
 *
 * `state` and `etag` are kept on the report so the resolution paths
 * (`--accept`, `--revert`) can reuse the already-loaded state without
 * re-reading from S3 — and `etag` is required for the optimistic-lock
 * `IfMatch` write on `--accept`.
 */
interface StackDriftReport {
  stackName: string;
  region: string;
  outcomes: DriftOutcome[];
  /** State that drift was computed against. Populated on every report. */
  state: StackState;
  /** S3 ETag of the state read; needed for `--accept`'s conditional write. */
  etag: string;
  /** When the state was loaded from the legacy v1 key — forwarded to saveState. */
  migrationPending: boolean;
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
 * `cdkd drift [<stack>...]` command implementation.
 *
 * Three operating modes (mutually exclusive):
 *
 *   1. **Detection only** (default) — reads each named stack's state from
 *      S3, asks every resource's provider for its `readCurrentState`
 *      snapshot, and compares against the state-recorded `properties`.
 *      Outputs a per-stack report and exits with `0` when no drift, `1`
 *      when drift is detected (rich human report is the only output).
 *
 *   2. **`--accept`** — state ← AWS. For each drifted property, write
 *      the AWS-current value back into cdkd state. Use this when the
 *      user manually changed something in the AWS console and wants
 *      cdkd state to "catch up" without re-deploying. Requires a stack
 *      lock. Confirms with the user unless `-y/--yes`.
 *
 *   3. **`--revert`** — AWS ← state. For each drifted resource, call
 *      `provider.update` with the cdkd-state values to push them back
 *      into AWS. Use this to undo a manual AWS console change. Requires
 *      a stack lock. Per-resource failures are collected and surface as
 *      `PartialFailureError` (exit 2) at the end of the run; one
 *      resource's failure does not abort the rest.
 *
 * `--accept` and `--revert` are mutually exclusive. Both honor `--dry-run`
 * (print the planned mutations, exit 0 without acquiring a lock).
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
    accept?: boolean;
    revert?: boolean;
    dryRun?: boolean;
    concurrency?: number;
  }
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) {
    logger.setLevel('debug');
  }

  warnIfDeprecatedRegion(options);

  if (options.accept && options.revert) {
    throw new Error(
      '--accept and --revert are mutually exclusive. ' +
        'Use --accept to update cdkd state from AWS, or --revert to push cdkd state values back into AWS.'
    );
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
    const stateConfig = { bucket, prefix };

    const stateBackend = new S3StateBackend(awsClients.s3, stateConfig, {
      region,
      ...(options.profile && { profile: options.profile }),
    });
    await stateBackend.verifyBucketExists();

    const providerRegistry = new ProviderRegistry();
    registerAllProviders(providerRegistry);
    providerRegistry.setCustomResourceResponseBucket(bucket);

    // PR J: shared CC API fallback used when an SDK provider doesn't
    // implement readCurrentState yet. Constructed once per command so we
    // don't re-instantiate the underlying CloudControl client per stack.
    const ccApiFallback = new CloudControlProvider();

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
        providerRegistry,
        ccApiFallback
      );
      reports.push(report);
    }

    if (options.json) {
      writeJsonReport(reports);
    } else {
      writeHumanReport(reports);
    }

    // Detection-only path: exit 0 / 1 based on whether drift was found,
    // regardless of subsequent flags. `--accept` / `--revert` take over
    // below if requested.
    const drifted = reports.some((r) => r.outcomes.some((o) => o.kind === 'drifted'));

    if (!options.accept && !options.revert) {
      if (drifted) {
        throw new DriftDetectedError();
      }
      return;
    }

    // Resolution path. Both flags share the prompt + lock + state-loaded
    // reports; the per-resource action differs.
    if (!drifted) {
      logger.info(
        options.accept
          ? 'No drift detected — nothing to accept.'
          : 'No drift detected — nothing to revert.'
      );
      return;
    }

    if (options.accept) {
      await runAccept(reports, stateBackend, stateConfig, awsClients, options);
    } else {
      await runRevert(reports, providerRegistry, stateConfig, awsClients, options);
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

  // No positional args and no --all: mirror `cdkd deploy` / `cdkd destroy`'s
  // single-stack auto-detect. Use state as the source of truth (drift is
  // state-driven, no synth involved).
  if (stacks.length === 0) {
    const candidates = options.stackRegion
      ? stateRefs.filter((r) => r.region === options.stackRegion)
      : stateRefs;
    if (candidates.length === 0) {
      throw new Error(
        'No stacks found in state bucket. Run `cdkd deploy` first, or pass --all explicitly.'
      );
    }
    if (candidates.length === 1) {
      return [candidates[0]!];
    }
    const listing = candidates
      .map((r) => `${r.stackName}${r.region ? ` (${r.region})` : ''}`)
      .join(', ');
    throw new Error(
      `Multiple stacks found in state: ${listing}. Specify stack name(s) or use --all.`
    );
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
 * into a {@link StackDriftReport}. The state object + etag are stored on
 * the report so `--accept` can write back without a re-read, and
 * `--revert` can pass the captured AWS-current snapshot to
 * `provider.update` as the `previousProperties` argument.
 */
async function runDriftForStack(
  stackName: string,
  region: string,
  stateBackend: S3StateBackend,
  providerRegistry: ProviderRegistry,
  ccApiFallback: CloudControlProvider
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

      // First try the SDK provider's first-class readCurrentState (PR G's
      // 4-arg signature). When the SDK Provider hasn't shipped its own
      // readCurrentState yet, fall back to the Cloud Control API provider
      // (PR F). The fallback is gated by two false-drift guards (PR J):
      //
      //   1. Deny-list (`CC_API_FALLBACK_DENY_LIST`) — types with verified
      //      structural divergence between CC API response shape and the
      //      CFn-template shape cdkd state stores (e.g.
      //      `AWS::IAM::ManagedPolicy`'s URL-encoded `PolicyDocument`)
      //      short-circuit to "drift unknown" so they don't fire false
      //      positives every run.
      //   2. Strip (`stripCcApiAwsManagedFields`) — generic AWS-managed
      //      fields (timestamps, generated identifiers, runtime status)
      //      are removed from CC API responses before the comparator sees
      //      them.
      let aws: Record<string, unknown> | undefined;
      if (provider.readCurrentState) {
        aws = await provider.readCurrentState(
          resource.physicalId,
          logicalId,
          resource.resourceType,
          resource.properties ?? {}
        );
      } else {
        // CloudFormation `Custom::*` resource types cannot be read back via
        // the CC API at all — `cloudformation:GetResource` rejects them
        // with `ValidationException` because its `typeName` regex demands
        // `<A>::<B>::<C>` and Custom resources only have two segments.
        // Mark as drift-unknown so users with Custom resources in a stack
        // (typical: `aws-cdk-lib`'s S3 auto-delete-objects helper) don't
        // get a hard crash on `cdkd drift`. Real drift on a Custom
        // Resource would require re-invoking its handler Lambda, which
        // is out of scope for the drift command anyway.
        if (resource.resourceType.startsWith('Custom::')) {
          outcomes.push({
            kind: 'unsupported',
            logicalId,
            resourceType: resource.resourceType,
          });
          continue;
        }
        if (CC_API_FALLBACK_DENY_LIST[resource.resourceType]) {
          outcomes.push({
            kind: 'unsupported',
            logicalId,
            resourceType: resource.resourceType,
          });
          continue;
        }
        const ccApiAws = await ccApiFallback.readCurrentState(
          resource.physicalId,
          logicalId,
          resource.resourceType,
          resource.properties ?? {}
        );
        if (ccApiAws === undefined) {
          outcomes.push({
            kind: 'unsupported',
            logicalId,
            resourceType: resource.resourceType,
          });
          continue;
        }
        aws = stripCcApiAwsManagedFields(resource.resourceType, ccApiAws);
      }

      if (aws === undefined) {
        outcomes.push({
          kind: 'unsupported',
          logicalId,
          resourceType: resource.resourceType,
        });
        continue;
      }

      // Providers can declare state property paths they cannot read back
      // from AWS (e.g. Lambda `Code`, Secrets Manager `SecretString`). The
      // CC-API fallback has no provider-specific intuition here — only the
      // SDK provider's getDriftUnknownPaths is consulted.
      const ignorePaths = provider.getDriftUnknownPaths
        ? provider.getDriftUnknownPaths(resource.resourceType)
        : [];
      // Prefer the observedProperties baseline (deploy-time AWS snapshot)
      // when present — this is what makes "console-side change to a key
      // the user did not template" surface as drift, instead of being
      // silently ignored because the key is absent from `properties`.
      // Resources written by an older binary (or by a provider without
      // readCurrentState) lack observedProperties; falling back to
      // `properties` preserves the pre-v3 behavior for those.
      const baseline = resource.observedProperties ?? resource.properties ?? {};
      const changes = calculateResourceDrift(baseline, aws, { ignorePaths });
      if (changes.length === 0) {
        outcomes.push({ kind: 'clean', logicalId, resourceType: resource.resourceType });
      } else {
        outcomes.push({
          kind: 'drifted',
          logicalId,
          resourceType: resource.resourceType,
          changes,
          awsProperties: aws,
        });
      }
    }

    return {
      stackName,
      region,
      outcomes,
      state,
      etag: result.etag,
      migrationPending: result.migrationPending ?? false,
    };
  });
}

/**
 * Set a value at a dotted path inside a plain object, creating intermediate
 * objects as needed. Mirrors `lodash.set` for the subset of paths the drift
 * comparator actually emits — dotted nested keys, no array indices.
 *
 * The drift comparator (`src/analyzer/drift-calculator.ts`) only synthesizes
 * paths through plain objects; arrays and scalars surface as a single drift
 * entry on the parent path. So we do not need to parse `[i]` segments.
 */
function setAtPath(target: Record<string, unknown>, path: string, value: unknown): void {
  if (path.length === 0) {
    return;
  }
  const segments = path.split('.');
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i]!;
    const next = cursor[key];
    if (next === undefined || next === null || typeof next !== 'object' || Array.isArray(next)) {
      const fresh: Record<string, unknown> = {};
      cursor[key] = fresh;
      cursor = fresh;
    } else {
      cursor = next as Record<string, unknown>;
    }
  }
  cursor[segments[segments.length - 1]!] = value;
}

/**
 * `--accept`: state ← AWS.
 *
 * For each drifted resource, walk every property drift and write the
 * AWS-current value into the state-side `properties` map. Then, under a
 * stack lock, persist the updated state via `S3StateBackend.saveState`
 * with the captured etag (optimistic locking).
 *
 * `--dry-run` short-circuits before the lock and the write.
 */
async function runAccept(
  reports: StackDriftReport[],
  stateBackend: S3StateBackend,
  stateConfig: { bucket: string; prefix: string },
  awsClients: AwsClients,
  options: { yes?: boolean; dryRun?: boolean }
): Promise<void> {
  const logger = getLogger();

  // Print a per-resource summary of the planned state mutations BEFORE we
  // ask for confirmation (or short-circuit on --dry-run). Mirrors `cdkd
  // import`'s confirm-then-write flow.
  printAcceptPlan(reports);

  if (options.dryRun) {
    logger.info('--dry-run: state will NOT be written. Re-run without --dry-run to apply.');
    return;
  }

  if (!options.yes) {
    const ok = await confirmPrompt(`Update cdkd state with the AWS-current values shown above?`);
    if (!ok) {
      logger.info('Aborted.');
      return;
    }
  }

  const lockManager = new LockManager(awsClients.s3, stateConfig);
  const owner = `${process.env['USER'] || 'unknown'}@${process.env['HOSTNAME'] || 'host'}:${process.pid}`;

  for (const report of reports) {
    const driftedOutcomes = report.outcomes.filter(
      (o): o is Extract<DriftOutcome, { kind: 'drifted' }> => o.kind === 'drifted'
    );
    if (driftedOutcomes.length === 0) {
      continue;
    }

    await lockManager.acquireLock(report.stackName, report.region, owner, 'drift-accept');
    try {
      // Build the mutated resources map. The drift comparator's baseline
      // is `observedProperties ?? properties` (see runDriftForStack), so
      // `--accept` mutates `observedProperties` to match AWS-current and
      // leaves `properties` (= the user's last-deployed template intent)
      // untouched. For resources that have no observedProperties yet
      // (older binary's state, or providers without readCurrentState),
      // `--accept` falls back to mutating `properties` — which matches
      // the pre-v3 behavior for those resources.
      const resources: Record<string, ResourceState> = { ...report.state.resources };
      for (const outcome of driftedOutcomes) {
        const existing = resources[outcome.logicalId];
        if (!existing) continue;
        const hasObserved = existing.observedProperties !== undefined;
        const baselineSource = hasObserved
          ? existing.observedProperties
          : (existing.properties ?? {});
        const newBaseline = JSON.parse(JSON.stringify(baselineSource)) as Record<string, unknown>;
        for (const change of outcome.changes) {
          setAtPath(newBaseline, change.path, change.awsValue);
        }
        resources[outcome.logicalId] = hasObserved
          ? { ...existing, observedProperties: newBaseline }
          : { ...existing, properties: newBaseline };
      }

      const newState: StackState = {
        ...report.state,
        resources,
        lastModified: Date.now(),
      };

      const saveOptions: { expectedEtag?: string; migrateLegacy?: boolean } = {
        expectedEtag: report.etag,
      };
      if (report.migrationPending) {
        saveOptions.migrateLegacy = true;
      }
      await stateBackend.saveState(report.stackName, report.region, newState, saveOptions);
      logger.info(
        `✓ State updated for ${report.stackName} (${report.region}): ` +
          `accepted drift on ${driftedOutcomes.length} resource(s).`
      );
    } finally {
      await lockManager.releaseLock(report.stackName, report.region).catch((err) => {
        logger.warn(
          `Failed to release lock for ${report.stackName} (${report.region}): ` +
            (err instanceof Error ? err.message : String(err))
        );
      });
    }
  }
}

/**
 * `--revert`: AWS ← state.
 *
 * For each drifted resource, call `provider.update(logicalId, physicalId,
 * resourceType, properties /*new*\/, previousProperties /*old*\/)` with:
 *   - `properties` = state-recorded properties (the desired truth)
 *   - `previousProperties` = AWS-current properties (the previous-known
 *     truth, captured during the drift read so we don't re-issue it)
 *
 * Per-resource failures are collected and surface as `PartialFailureError`
 * (exit 2) at the end. State is NOT updated by `--revert` — once the
 * update succeeds, AWS values match state by definition.
 *
 * The per-stack lock is acquired before any update so a concurrent
 * `cdkd deploy` cannot race the in-flight property changes.
 */
async function runRevert(
  reports: StackDriftReport[],
  providerRegistry: ProviderRegistry,
  stateConfig: { bucket: string; prefix: string },
  awsClients: AwsClients,
  options: { yes?: boolean; dryRun?: boolean; concurrency?: number }
): Promise<void> {
  const logger = getLogger();

  printRevertPlan(reports);

  if (options.dryRun) {
    logger.info('--dry-run: AWS will NOT be modified. Re-run without --dry-run to apply.');
    return;
  }

  if (!options.yes) {
    const ok = await confirmPrompt(
      `Push cdkd state values back into AWS for the resources shown above?`
    );
    if (!ok) {
      logger.info('Aborted.');
      return;
    }
  }

  const lockManager = new LockManager(awsClients.s3, stateConfig);
  const owner = `${process.env['USER'] || 'unknown'}@${process.env['HOSTNAME'] || 'host'}:${process.pid}`;
  const concurrency = Math.max(1, options.concurrency ?? 4);

  let totalFailed = 0;
  let totalUnsupported = 0;
  let totalSucceeded = 0;

  for (const report of reports) {
    const driftedOutcomes = report.outcomes.filter(
      (o): o is Extract<DriftOutcome, { kind: 'drifted' }> => o.kind === 'drifted'
    );
    if (driftedOutcomes.length === 0) {
      continue;
    }

    await lockManager.acquireLock(report.stackName, report.region, owner, 'drift-revert');
    try {
      const tasks = driftedOutcomes.map((outcome) => async () => {
        const stateResource = report.state.resources[outcome.logicalId];
        if (!stateResource) {
          // Defensive: drift detection saw the resource in state earlier,
          // but if something racey happened between read and now treat it
          // as a per-resource failure rather than aborting the whole run.
          totalFailed++;
          logger.error(
            `  ✗ ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): ` +
              `resource missing from state; skipped.`
          );
          return;
        }
        const provider: ResourceProvider = providerRegistry.getProvider(outcome.resourceType);
        // The baseline drift was computed against — `observedProperties`
        // when present, else `properties` — is the right "desired" value
        // to push back to AWS. Using `properties` alone would push the
        // last-deployed template intent and miss any AWS-side defaults
        // we captured at deploy time but never wrote into the template.
        const desiredProperties =
          stateResource.observedProperties ?? stateResource.properties ?? {};
        try {
          await withRetry(
            () =>
              provider.update(
                outcome.logicalId,
                stateResource.physicalId,
                outcome.resourceType,
                desiredProperties,
                outcome.awsProperties
              ),
            outcome.logicalId,
            { logger: { debug: (msg) => logger.debug(msg) } }
          );
          totalSucceeded++;
          logger.info(
            `  ✓ ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): reverted.`
          );
        } catch (err) {
          // Distinguish "the AWS update failed" from "this resource type
          // does not support in-place update at all". The latter cannot be
          // fixed by retrying; the user has to redeploy with --replace.
          if (err instanceof ResourceUpdateNotSupportedError) {
            totalUnsupported++;
            logger.warn(
              `  ⊘ ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): could not revert — ${err.message}`
            );
            return;
          }
          totalFailed++;
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(
            `  ✗ ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): AWS update failed — ${msg}`
          );
        }
      });

      await runWithConcurrency(tasks, concurrency);
    } finally {
      await lockManager.releaseLock(report.stackName, report.region).catch((err) => {
        logger.warn(
          `Failed to release lock for ${report.stackName} (${report.region}): ` +
            (err instanceof Error ? err.message : String(err))
        );
      });
    }
  }

  const summaryParts = [`${totalSucceeded} reverted`];
  if (totalUnsupported > 0) summaryParts.push(`${totalUnsupported} update-not-supported`);
  if (totalFailed > 0) summaryParts.push(`${totalFailed} failed`);
  logger.info(`\nRevert summary: ${summaryParts.join(', ')}.`);

  if (totalUnsupported > 0) {
    logger.warn(
      `${totalUnsupported} resource(s) cannot be reverted in place — re-deploy the stack with cdkd deploy --replace, ` +
        `or destroy + redeploy to push the cdkd-state values back into AWS.`
    );
  }

  if (totalFailed > 0 || totalUnsupported > 0) {
    throw new PartialFailureError(
      `Revert completed with ${totalFailed + totalUnsupported} resource error(s) ` +
        `(${totalFailed} AWS update failure(s), ${totalUnsupported} update-not-supported). ` +
        `Re-run 'cdkd drift <stack>' to see the remaining drift, then 'cdkd drift <stack> --revert' to retry.`
    );
  }
}

/**
 * Print the planned state mutations for `--accept` (no AWS calls). One
 * line per resource per property path, mirroring the human report's
 * +/- diff format but flipped: the value on disk after this command
 * runs is the `+` side.
 */
function printAcceptPlan(reports: StackDriftReport[]): void {
  for (const report of reports) {
    const drifted = report.outcomes.filter(
      (o): o is Extract<DriftOutcome, { kind: 'drifted' }> => o.kind === 'drifted'
    );
    if (drifted.length === 0) continue;
    process.stdout.write(
      `\nPlan (--accept): update cdkd state for ${report.stackName} (${report.region}):\n`
    );
    for (const o of drifted) {
      process.stdout.write(`  ~ ${o.logicalId} (${o.resourceType})\n`);
      for (const change of o.changes) {
        process.stdout.write(
          `    ${change.path}: ${formatScalar(change.stateValue)} -> ${formatScalar(change.awsValue)}\n`
        );
      }
    }
  }
}

/**
 * Print the planned `provider.update` calls for `--revert` (no AWS calls).
 * One line per resource summarising how many property paths will be
 * overwritten on the AWS side.
 */
function printRevertPlan(reports: StackDriftReport[]): void {
  for (const report of reports) {
    const drifted = report.outcomes.filter(
      (o): o is Extract<DriftOutcome, { kind: 'drifted' }> => o.kind === 'drifted'
    );
    if (drifted.length === 0) continue;
    process.stdout.write(
      `\nPlan (--revert): push cdkd state values back into AWS for ${report.stackName} (${report.region}):\n`
    );
    for (const o of drifted) {
      const word = o.changes.length === 1 ? 'property path' : 'property paths';
      process.stdout.write(
        `  → provider.update on ${o.logicalId} (${o.resourceType}): revert ${o.changes.length} ${word}\n`
      );
      for (const change of o.changes) {
        process.stdout.write(
          `    ${change.path}: ${formatScalar(change.awsValue)} -> ${formatScalar(change.stateValue)}\n`
        );
      }
    }
  }
}

/**
 * Run a list of zero-arg async tasks with a concurrency cap. Tasks are
 * allowed to throw; failure handling is the caller's responsibility (the
 * revert path catches per-task errors inside the task body).
 */
async function runWithConcurrency(
  tasks: Array<() => Promise<void>>,
  concurrency: number
): Promise<void> {
  const queue = [...tasks];
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
    workers.push(
      (async (): Promise<void> => {
        while (queue.length > 0) {
          const task = queue.shift();
          if (!task) break;
          await task();
        }
      })()
    );
  }
  await Promise.all(workers);
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
      'Detect drift between cdkd state and AWS reality. Exits 0 when no drift, 1 when drift is detected. ' +
        'Pass --accept to update cdkd state from AWS, or --revert to push cdkd state values back into AWS.'
    )
    .argument('[stacks...]', 'Stack name(s) to check (physical CloudFormation names)')
    .option('--all', 'Check every stack in the state bucket', false)
    .option('--json', 'Output as JSON', false)
    .option(
      '--accept',
      'Update cdkd state with the AWS-current values for every drifted property (state ← AWS). ' +
        'Mutually exclusive with --revert.',
      false
    )
    .option(
      '--revert',
      'Push cdkd state values back into AWS via provider.update for every drifted resource (AWS ← state). ' +
        'Mutually exclusive with --accept.',
      false
    )
    .option(
      '--dry-run',
      'Print the planned mutations without acquiring a lock or hitting AWS / S3. ' +
        'Honored by --accept and --revert.',
      false
    )
    .option(
      '--concurrency <number>',
      'Maximum concurrent provider.update calls during --revert',
      (value) => parseInt(value, 10),
      4
    )
    .addOption(stackRegionOption())
    .action(withErrorHandling(driftCommand));

  [...commonOptions, ...stateOptions].forEach((opt) => cmd.addOption(opt));

  cmd.addOption(deprecatedRegionOption);

  return cmd;
}
