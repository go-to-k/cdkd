import * as readline from 'node:readline/promises';
import { Command, Option } from 'commander';
import {
  commonOptions,
  stateOptions,
  deprecatedRegionOption,
  warnIfDeprecatedRegion,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { PartialFailureError, withErrorHandling } from '../../utils/error-handler.js';
import { ProviderRegistry } from '../../provisioning/provider-registry.js';
import { registerAllProviders } from '../../provisioning/register-providers.js';
import { withNestedStackContext } from '../../provisioning/nested-stack-context.js';
import { withStackName } from '../../provisioning/resource-name.js';
import { setupStateBackend, resolveSingleRegion } from './state.js';
import { startRunRecorder } from './deployment-events-run.js';
import {
  replayRollback,
  replayFailedOperations,
  planRollback,
  planFailedOps,
  type RollbackExecutorContext,
  type RollbackPlanItem,
  type FailedOpPlanItem,
} from '../../deployment/rollback-executor.js';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  type ResourceState,
  type StackState,
} from '../../types/state.js';
import type { StackStateRef } from '../../state/s3-state-backend.js';

interface RollbackOptions {
  force?: boolean;
  yes?: boolean;
  orphan?: string[];
  revertFailed?: boolean;
  stackRegion?: string;
  stateBucket?: string;
  statePrefix: string;
  region?: string;
  profile?: string;
  roleArn?: string;
  verbose: boolean;
}

/**
 * `--stack-region <region>` — disambiguate when the same stackName has state
 * in multiple regions (same pattern + messages as the `state` subcommands).
 */
function stackRegionOption(): Option {
  return new Option(
    '--stack-region <region>',
    'Region of the target stack when the same name has state in multiple regions'
  );
}

/**
 * Discover every stack that currently has a rollback journal. One raw key
 * listing under the prefix (journals live at
 * `{prefix}/{stackName}/{region}/rollback-journal.json`), parsed back to
 * `(stackName, region)` refs.
 */
async function findJournalCandidates(
  backend: Awaited<ReturnType<typeof setupStateBackend>>['stateBackend'],
  prefix: string
): Promise<StackStateRef[]> {
  const keys = await backend.listRawKeys(`${prefix}/`);
  const refs: StackStateRef[] = [];
  const suffix = '/rollback-journal.json';
  const seen = new Set<string>();
  for (const key of keys) {
    if (!key.endsWith(suffix)) continue;
    const rest = key.slice(prefix.length + 1, key.length - suffix.length);
    const segments = rest.split('/');
    // {stackName}/{region}
    if (segments.length !== 2) continue;
    const [stackName, region] = segments;
    if (!stackName || !region) continue;
    const dedupe = `${stackName}\0${region}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    refs.push({ stackName, region });
  }
  return refs;
}

/** Human label for a planned rollback action (plan preview). */
function actionLabel(item: RollbackPlanItem): string {
  const { op, action, replacement } = item;
  const rep = replacement ? ' [replacement occurred, best-effort revert]' : '';
  switch (action) {
    case 'delete':
      return `  - delete   ${op.logicalId} (${op.resourceType})${rep}`;
    case 'orphan-retain':
      return `  - orphan   ${op.logicalId} (${op.resourceType}) [DeletionPolicy Retain/Snapshot — left in AWS]`;
    case 'orphan-flag':
      return `  - orphan   ${op.logicalId} (${op.resourceType}) [--orphan]`;
    case 'revert':
      return `  - revert   ${op.logicalId} (${op.resourceType})${rep}`;
    case 'reverse-replacement':
      return `  - reverse-replace ${op.logicalId} (${op.resourceType}) [re-create old resource, delete new]`;
    case 'reverse-replacement-readopt':
      return `  - reverse-replace ${op.logicalId} (${op.resourceType}) [delete new, re-adopt retained old resource]`;
    case 'unrecoverable-delete':
      return `  - (cannot restore) ${op.logicalId} (${op.resourceType}) — was DELETED, unrecoverable`;
    case 'skip-mismatch':
      return `  - skip     ${op.logicalId} (${op.resourceType}) — physical id changed, needs manual attention`;
    case 'skip-absent':
      return `  - skip     ${op.logicalId} (${op.resourceType}) — no longer in state`;
    case 'skip-already-done':
      return `  - skip     ${op.logicalId} (${op.resourceType}) — already reverted`;
  }
}

/** Human label for a planned FAILED-op revert (issue #1198, --revert-failed). */
function failedActionLabel(item: FailedOpPlanItem): string {
  const { op, action } = item;
  switch (action) {
    case 'revert-failed-update':
      return `  - revert   ${op.logicalId} (${op.resourceType}) [FAILED update — remote state unknown, force-applying previous properties]`;
    case 'delete-failed-create':
      return `  - delete   ${op.logicalId} (${op.resourceType}) [FAILED create]`;
    case 'skip-failed-unknown':
      return `  - skip     ${op.logicalId} (${op.resourceType}) — failed CREATE recorded no physical id`;
    case 'skip-failed-noop':
      return `  - skip     ${op.logicalId} (${op.resourceType}) — failed ${op.changeType} left nothing to revert`;
    case 'skip-failed-absent':
      return `  - skip     ${op.logicalId} (${op.resourceType}) — no previous state available`;
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} (y/N): `);
    const t = answer.trim().toLowerCase();
    return t === 'y' || t === 'yes';
  } finally {
    rl.close();
  }
}

export async function rollbackCommand(
  stackArg: string | undefined,
  options: RollbackOptions
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) {
    logger.setLevel('debug');
    process.env['CDKD_NO_LIVE'] = '1';
  }
  warnIfDeprecatedRegion(options);

  const setup = await setupStateBackend(options);
  const skipConfirmation = options.force === true || options.yes === true;

  try {
    // 1. Resolve the target stack + region.
    let ref: StackStateRef;
    if (stackArg) {
      const refs = await setup.stateBackend.listStacks();
      ref = resolveSingleRegion(stackArg, refs, options.stackRegion);
    } else {
      const candidates = await findJournalCandidates(setup.stateBackend, setup.prefix);
      const scoped = options.stackRegion
        ? candidates.filter((c) => c.region === options.stackRegion)
        : candidates;
      if (scoped.length === 0) {
        logger.info(
          'Nothing to roll back — no stack has a rollback journal. ' +
            "Run 'cdkd deploy' to (re)deploy, or 'cdkd destroy' to clean up."
        );
        return;
      }
      if (scoped.length > 1) {
        const list = scoped.map((c) => `  - ${c.stackName} (${c.region})`).join('\n');
        throw new Error(
          `Multiple stacks have a rollback journal. Pick one:\n${list}\n` +
            `Re-run 'cdkd rollback <stack>' (add --stack-region if the same name spans regions).`
        );
      }
      ref = scoped[0]!;
    }
    const stackName = ref.stackName;
    const region = ref.region ?? setup.region;

    // 2. Register providers (exactly like deploy / destroy).
    const providerRegistry = new ProviderRegistry();
    registerAllProviders(providerRegistry);
    providerRegistry.setCustomResourceResponseBucket(setup.bucket);

    // 3. Acquire the stack lock for the whole replay.
    await setup.lockManager.acquireLockWithRetry(stackName, region, undefined, 'rollback');

    let interrupted = false;
    const sigintHandler = () => {
      process.stderr.write('\nInterrupted — stopping rollback after the current operation...\n');
      interrupted = true;
    };
    process.on('SIGINT', sigintHandler);

    try {
      // 4. Load state + journal (write order guarantees state exists first).
      // A newer-version journal throws UnknownRollbackJournalVersionError from
      // loadRollbackJournal → parseRollbackJournal; it propagates as a hard
      // error telling the user to upgrade cdkd.
      const stateData = await setup.stateBackend.getState(stackName, region);
      const journal = await setup.stateBackend.loadRollbackJournal(stackName, region);
      if (!journal || journal.segments.length === 0) {
        throw new Error(
          `Nothing to roll back for '${stackName}' (${region}). ` +
            "Run 'cdkd deploy' to (re)deploy, or 'cdkd destroy' to clean up."
        );
      }
      if (!stateData) {
        throw new Error(
          `Rollback journal exists for '${stackName}' (${region}) but its state.json is missing ` +
            `(keys: ${setup.prefix}/${stackName}/${region}/state.json and .../rollback-journal.json). ` +
            `State appears corrupted — inspect the bucket manually.`
        );
      }
      const baseState = stateData.state;
      const stateResources: Record<string, ResourceState> = { ...baseState.resources };
      const orphanLogicalIds = new Set(options.orphan ?? []);

      // Informational role-arn note (issue #1183): the newest segment recorded
      // a role, but --role-arn was not passed this run.
      const newestSegment = journal.segments[journal.segments.length - 1]!;
      if (newestSegment.roleArn && !options.roleArn) {
        logger.info(
          `Note: the failed deploy ran with --role-arn ${newestSegment.roleArn}; ` +
            `this rollback is running with ambient credentials (pass --role-arn to match).`
        );
      }

      // 5. Plan — newest-first, one block per segment.
      logger.info(`\nRollback plan for '${stackName}' (${region}):`);
      // Plan preview walks a COPY of state so it does not disturb replay.
      const planStateView: Record<string, ResourceState> = { ...stateResources };
      for (let s = journal.segments.length - 1; s >= 0; s--) {
        const segment = journal.segments[s]!;
        logger.info(
          `\n  Segment ${s + 1}/${journal.segments.length} (${segment.reason}${segment.runId ? `, run ${segment.runId}` : ''}):`
        );
        // #1198: the segment's FAILED in-flight op(s) come first (they are
        // the newest work of the failed deploy).
        if (segment.failedOperations && segment.failedOperations.length > 0) {
          if (options.revertFailed) {
            const failedPlan = planFailedOps(segment.failedOperations, planStateView);
            for (const item of failedPlan) logger.info(failedActionLabel(item));
            applyFailedPlanToPreview(failedPlan, planStateView);
          } else {
            for (const fop of segment.failedOperations) {
              logger.info(
                `  - (left as-is) ${fop.logicalId} (${fop.resourceType}) — its ${fop.changeType} ` +
                  `FAILED mid-deploy; pass --revert-failed to attempt reverting it`
              );
            }
          }
        }
        const plan = planRollback(segment.operations, planStateView, orphanLogicalIds);
        for (const item of plan) logger.info(actionLabel(item));
        // Apply the segment's effect to the preview so an earlier segment's
        // plan reflects the later segment's already-unwound state.
        applyPlanToPreview(plan, planStateView);
      }
      logger.info('');

      if (!skipConfirmation) {
        const ok = await confirm(`Roll back '${stackName}' (${region})?`);
        if (!ok) {
          logger.info('Rollback cancelled');
          return;
        }
      }

      // 6. Events recorder for this rollback run.
      const eventRecorder = startRunRecorder({
        backend: setup.stateBackend,
        stackName,
        region,
        command: 'rollback',
      })!;

      const ctx: RollbackExecutorContext = {
        providerRegistry,
        region,
        logger: logger.child('rollback'),
        recordEvent: (e) => eventRecorder.record(e),
      };

      // 7. Serialized incremental state save after every mutating op.
      //
      // Best-effort by design: the AWS revert already succeeded by the time
      // this runs, so a state-save failure must NOT be counted as a rollback
      // failure (which would block the segment pop and mislabel a clean revert
      // as a per-op failure). It also must not desync `currentEtag`: on a
      // conflict we re-read the fresh ETag and retry once (mirrors the deploy
      // engine's post-rollback save) so a single transient blip cannot cascade
      // every remaining op into a 412. `afterOp` therefore never throws.
      let currentEtag = stateData.etag;
      const saveState = async (): Promise<void> => {
        const next = (): StackState => ({
          ...baseState,
          version: STATE_SCHEMA_VERSION_CURRENT,
          region,
          resources: { ...stateResources },
          lastModified: Date.now(),
        });
        try {
          currentEtag = await setup.stateBackend.saveState(stackName, region, next(), {
            ...(currentEtag !== undefined && { expectedEtag: currentEtag }),
          });
        } catch {
          try {
            const fresh = await setup.stateBackend.getState(stackName, region);
            currentEtag = await setup.stateBackend.saveState(stackName, region, next(), {
              ...(fresh?.etag !== undefined && { expectedEtag: fresh.etag }),
            });
          } catch (retryError) {
            logger.warn(
              `Failed to persist state after a rollback operation: ${retryError instanceof Error ? retryError.message : String(retryError)}. ` +
                `The resource was reverted in AWS; re-run 'cdkd rollback ${stackName}' to reconcile state.`
            );
          }
        }
      };

      // 8. Replay segments strictly newest-first; pop each after a clean run.
      const oldestInitialDeploy = journal.segments[0]?.initialDeploy === true;
      let totalFailures = 0;
      let totalWarnings = 0;
      try {
        while (journal.segments.length > 0) {
          if (interrupted) break;
          const segment = journal.segments[journal.segments.length - 1]!;
          const result = await withNestedStackContext(
            {
              stateBackend: setup.stateBackend,
              lockManager: setup.lockManager,
              providerRegistry,
              parentStackName: stackName,
              parentRegion: region,
              accountId: 'unknown',
              awsClients: setup.awsClients,
              stateBucket: setup.bucket,
              exportIndexStore: setup.exportIndexStore,
              destroyOptions: {
                ...(options.profile && { profile: options.profile }),
              },
            },
            () =>
              withStackName(stackName, async () => {
                // #1198: revert the segment's FAILED in-flight op(s) first
                // (opt-in). Their revert is independent of the completed-op
                // replay (one op per resource per deploy), so a failed-op
                // revert failure still lets the completed ops replay — the
                // summed failure count keeps the segment from popping.
                let failedOpFailures = 0;
                let failedOpWarnings = 0;
                if (
                  options.revertFailed &&
                  segment.failedOperations &&
                  segment.failedOperations.length > 0
                ) {
                  const failedResult = await replayFailedOperations(
                    segment.failedOperations,
                    stateResources,
                    stackName,
                    ctx,
                    { afterOp: saveState, isInterrupted: () => interrupted }
                  );
                  failedOpFailures = failedResult.failures;
                  failedOpWarnings = failedResult.warnings;
                  if (failedResult.interrupted) {
                    return {
                      failures: failedOpFailures,
                      warnings: failedOpWarnings,
                      interrupted: true,
                    };
                  }
                }
                const replayResult = await replayRollback(
                  segment.operations,
                  stateResources,
                  stackName,
                  ctx,
                  {
                    orphanLogicalIds,
                    afterOp: saveState,
                    isInterrupted: () => interrupted,
                  }
                );
                return {
                  failures: replayResult.failures + failedOpFailures,
                  warnings: replayResult.warnings + failedOpWarnings,
                  interrupted: replayResult.interrupted,
                };
              })
          );
          totalFailures += result.failures;
          totalWarnings += result.warnings;
          if (result.interrupted) {
            interrupted = true;
            break;
          }
          if (result.failures > 0) {
            // A per-op failure keeps this (and older) segment(s) for a re-run.
            break;
          }
          // Segment fully replayed — pop it (persists the shortened journal).
          await setup.stateBackend.popRollbackJournalSegment(stackName, region);
          journal.segments.pop();
        }
      } finally {
        await eventRecorder.finalize(totalFailures > 0 || interrupted ? 'FAILED' : 'SUCCEEDED');
      }

      // 9. Terminal state: an initial-deploy rollback that emptied state
      // deletes state.json so `cdkd list` shows no ghost stack.
      if (
        journal.segments.length === 0 &&
        oldestInitialDeploy &&
        Object.keys(stateResources).length === 0
      ) {
        await setup.stateBackend.deleteState(stackName, region);
        logger.info(`State for '${stackName}' (${region}) removed (stack fully rolled back).`);
      }

      // 10. Exit codes.
      if (interrupted) {
        throw new PartialFailureError(
          `Rollback interrupted. Journal preserved — re-run 'cdkd rollback ${stackName}' to finish.`
        );
      }
      if (totalFailures > 0) {
        throw new PartialFailureError(
          `Rollback completed with ${totalFailures} failed operation(s). Journal preserved — ` +
            `re-run 'cdkd rollback ${stackName}' to retry.`
        );
      }
      if (totalWarnings > 0) {
        throw new PartialFailureError(
          `Rollback completed with ${totalWarnings} skipped/unrecoverable operation(s) (see warnings above).`
        );
      }
      logger.info(`\nRollback of '${stackName}' (${region}) complete.`);
    } finally {
      process.removeListener('SIGINT', sigintHandler);
      await setup.lockManager.releaseLock(stackName, region).catch((err) => {
        logger.warn(
          `Failed to release lock for '${stackName}' (${region}): ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }
  } finally {
    setup.dispose();
  }
}

/**
 * Apply a planned segment's effect to the plan-preview state so the NEXT
 * (older) segment's plan is classified against already-unwound state.
 * Mirrors what `replayRollback` mutates, without touching AWS.
 */
function applyPlanToPreview(
  plan: RollbackPlanItem[],
  previewState: Record<string, ResourceState>
): void {
  for (const item of plan) {
    const { op, action } = item;
    switch (action) {
      case 'delete':
      case 'orphan-retain':
      case 'orphan-flag':
        if (op.changeType === 'CREATE') delete previewState[op.logicalId];
        break;
      case 'revert':
      case 'reverse-replacement':
      case 'reverse-replacement-readopt':
        if (op.previousState) previewState[op.logicalId] = op.previousState;
        break;
      default:
        break;
    }
  }
}

/**
 * Apply a planned FAILED-op revert's effect to the plan-preview state
 * (issue #1198). Mirrors `replayFailedOperations` without touching AWS.
 */
function applyFailedPlanToPreview(
  plan: FailedOpPlanItem[],
  previewState: Record<string, ResourceState>
): void {
  for (const item of plan) {
    const { op, action } = item;
    switch (action) {
      case 'delete-failed-create':
        delete previewState[op.logicalId];
        break;
      case 'revert-failed-update':
        if (op.previousState) previewState[op.logicalId] = op.previousState;
        break;
      default:
        break;
    }
  }
}

export function createRollbackCommand(): Command {
  const cmd = new Command('rollback')
    .description(
      'Revert a stack to its pre-deploy state after a failed --no-rollback / interrupted deploy ' +
        'or a partially-failed automatic rollback (state-driven, no synth needed).'
    )
    .argument('[stack]', 'Stack name to roll back (defaults to the single journaled stack)')
    .addOption(new Option('--force', 'Skip the confirmation prompt').default(false))
    .addOption(
      new Option(
        '--orphan <logicalId>',
        'Skip the given resource during replay (repeatable). Mirrors cdk rollback --orphan.'
      ).argParser((value: string, previous: string[] | undefined) => [...(previous ?? []), value])
    )
    .addOption(
      new Option(
        '--revert-failed',
        'Also attempt to revert the resource whose operation FAILED mid-deploy. Off by ' +
          'default: the remote state of the failed resource is unknown, so force-applying ' +
          'its previous state is opt-in.'
      ).default(false)
    )
    .addOption(stackRegionOption())
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  cdkd rollback MyStack',
        '  cdkd rollback                       # single journaled stack',
        '  cdkd rollback MyStack --force',
        '  cdkd rollback MyStack --orphan MyBucket --orphan MyTable',
        '  cdkd rollback MyStack --revert-failed   # also revert the failed in-flight resource',
        '  cdkd rollback MyStack --stack-region us-west-2',
        '',
        'Exit codes: 0 = clean, 2 = partial (journal kept for re-run), 1 = hard error.',
      ].join('\n')
    )
    .action(withErrorHandling(rollbackCommand));

  [...commonOptions, ...stateOptions].forEach((opt) => cmd.addOption(opt));
  cmd.addOption(deprecatedRegionOption);
  return cmd;
}
