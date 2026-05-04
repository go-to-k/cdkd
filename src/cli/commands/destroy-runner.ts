import * as readline from 'node:readline/promises';
import { getLogger } from '../../utils/logger.js';
import { getLiveRenderer } from '../../utils/live-renderer.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import type { S3StateBackend } from '../../state/s3-state-backend.js';
import type { LockManager } from '../../state/lock-manager.js';
import { DagBuilder } from '../../analyzer/dag-builder.js';
import { IMPLICIT_DELETE_DEPENDENCIES } from '../../analyzer/implicit-delete-deps.js';
import { ProviderRegistry } from '../../provisioning/provider-registry.js';
import { registerAllProviders } from '../../provisioning/register-providers.js';
import type { StackState } from '../../types/state.js';
import { withResourceDeadline } from '../../deployment/resource-deadline.js';
import {
  DEFAULT_RESOURCE_WARN_AFTER_MS,
  DEFAULT_RESOURCE_TIMEOUT_MS,
} from '../../deployment/deploy-engine.js';
import { ProvisioningError, ResourceTimeoutError } from '../../utils/error-handler.js';

/**
 * Execution context passed by the caller (`cdkd destroy` or
 * `cdkd state destroy`) to the shared per-stack destroy runner.
 *
 * The state backend, lock manager, and "base" AWS clients are owned by the
 * caller — the runner only borrows them. The runner is responsible for
 * spinning up a region-scoped `AwsClients` / `ProviderRegistry` if a stack's
 * state pinpoints a different region from the caller's, and for tearing
 * those down on its way out.
 */
export interface DestroyRunnerContext {
  stateBackend: S3StateBackend;
  lockManager: LockManager;

  /**
   * Caller's existing provider registry (already wired up against `baseAwsClients`).
   * Reused when the stack's state has no region or matches `baseRegion`.
   */
  providerRegistry: ProviderRegistry;

  /** Caller's existing AWS clients. */
  baseAwsClients: AwsClients;

  /**
   * The region the caller is operating in. When the loaded `StackState.region`
   * differs, the runner switches to a region-scoped `AwsClients` for the
   * destroy and restores `baseAwsClients` afterwards.
   */
  baseRegion: string;

  /** Caller's --profile, if any. */
  profile?: string;

  /** State bucket — needed for custom-resource ResponseURL pre-signing. */
  stateBucket: string;

  /**
   * Skip the interactive confirmation prompt. Both `cdkd destroy --yes / --force`
   * and `cdkd state destroy --yes` map to true.
   */
  skipConfirmation: boolean;

  /**
   * Per-resource warn threshold (ms). Mirrors `DeployEngineOptions` so
   * `cdkd destroy` exposes the same `--resource-warn-after` UX as
   * `cdkd deploy`. Defaults to {@link DEFAULT_RESOURCE_WARN_AFTER_MS}.
   */
  resourceWarnAfterMs?: number;

  /**
   * Per-resource hard timeout (ms). Mirrors `DeployEngineOptions` so
   * `cdkd destroy` exposes the same `--resource-timeout` UX as
   * `cdkd deploy`. Defaults to {@link DEFAULT_RESOURCE_TIMEOUT_MS}.
   */
  resourceTimeoutMs?: number;

  /**
   * Per-resource-type warn-after override map. Same semantics as
   * `DeployEngineOptions.resourceWarnAfterByType` — the value for the
   * resource's `resourceType` (if present) supersedes
   * `resourceWarnAfterMs` at the per-resource delete site.
   */
  resourceWarnAfterByType?: Record<string, number>;

  /**
   * Per-resource-type hard-timeout override map. Same semantics as
   * `DeployEngineOptions.resourceTimeoutByType` — the value for the
   * resource's `resourceType` (if present) supersedes
   * `resourceTimeoutMs` at the per-resource delete site.
   */
  resourceTimeoutByType?: Record<string, number>;
}

/**
 * Outcome of destroying a single stack.
 */
export interface DestroyRunnerResult {
  /** Stack name we operated on. */
  stackName: string;
  /** True if the user declined the confirmation prompt — caller may skip cleanup. */
  cancelled: boolean;
  /** True if the stack already had no resources and we just dropped the state file. */
  skippedEmpty: boolean;
  /** Number of resources successfully deleted (idempotent "already gone" counts). */
  deletedCount: number;
  /** Number of resources that failed to delete. State is preserved on >0 errors. */
  errorCount: number;
}

/**
 * Run the destroy lifecycle for one stack against an already-loaded
 * `StackState`, reusing the caller's state backend / lock manager.
 *
 * Hoisted from `cdkd destroy` so the new `cdkd state destroy` subcommand
 * can call into the exact same per-stack pipeline without depending on
 * synth or the CDK app. The state-source split is the only meaningful
 * difference between the two commands — everything from "prompt the user"
 * onwards is identical.
 *
 * Side effects:
 * - Acquires (and releases) the stack's S3 lock.
 * - Switches `process.env.AWS_REGION` for the duration of the destroy when
 *   the stack's recorded region differs from `baseRegion`. Restored in the
 *   `finally` block.
 * - On full success, deletes the state file. On any failure, the state
 *   file is preserved so the user can retry.
 */
export async function runDestroyForStack(
  stackName: string,
  state: StackState,
  ctx: DestroyRunnerContext
): Promise<DestroyRunnerResult> {
  const logger = getLogger();
  const result: DestroyRunnerResult = {
    stackName,
    cancelled: false,
    skippedEmpty: false,
    deletedCount: 0,
    errorCount: 0,
  };

  const resourceCount = Object.keys(state.resources).length;
  // Region is load-bearing on the new state-key layout (PR 1). Fall back to
  // the caller's baseRegion only for legacy `version: 1` records that never
  // recorded one.
  const regionForState = state.region ?? ctx.baseRegion;
  if (resourceCount === 0) {
    logger.info(`Stack ${stackName} has no resources, cleaning up state...`);
    await ctx.stateBackend.deleteState(stackName, regionForState);
    logger.info('✓ State deleted');
    result.skippedEmpty = true;
    return result;
  }

  logger.info(`\nResources to be deleted (${resourceCount}):`);
  for (const [logicalId, resource] of Object.entries(state.resources)) {
    logger.info(`  - ${logicalId} (${resource.resourceType})`);
  }

  if (!ctx.skipConfirmation) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await rl.question(
      `\nAre you sure you want to destroy stack "${stackName}" and delete all ${resourceCount} resources? (Y/n): `
    );
    rl.close();
    const trimmed = answer.trim().toLowerCase();
    if (trimmed === 'n' || trimmed === 'no') {
      logger.info('Destroy cancelled');
      result.cancelled = true;
      return result;
    }
  }

  // Switch region if stack was deployed to a different one.
  const stackRegion = state.region;
  let destroyProviderRegistry = ctx.providerRegistry;
  let destroyAwsClients: AwsClients | undefined;
  if (stackRegion && stackRegion !== ctx.baseRegion) {
    logger.info(`Stack region: ${stackRegion}`);
    process.env['AWS_REGION'] = stackRegion;
    process.env['AWS_DEFAULT_REGION'] = stackRegion;

    destroyAwsClients = new AwsClients({
      region: stackRegion,
      ...(ctx.profile && { profile: ctx.profile }),
    });
    setAwsClients(destroyAwsClients);

    destroyProviderRegistry = new ProviderRegistry();
    registerAllProviders(destroyProviderRegistry);
    destroyProviderRegistry.setCustomResourceResponseBucket(ctx.stateBucket);
  }

  logger.info(`\nAcquiring lock for stack ${stackName}...`);
  await ctx.lockManager.acquireLock(stackName, regionForState, undefined, 'destroy');

  // Live progress renderer (multi-line in-flight display at bottom of TTY).
  // Self-disables on non-TTY and when CDKD_NO_LIVE=1 is set.
  const renderer = getLiveRenderer();
  renderer.start();

  try {
    logger.info('Building dependency graph...');

    const template = {
      AWSTemplateFormatVersion: '2010-09-09',
      Resources: {} as Record<
        string,
        { Type: string; Properties: Record<string, unknown>; DependsOn?: string[] }
      >,
    };

    for (const [logicalId, resource] of Object.entries(state.resources)) {
      template.Resources[logicalId] = {
        Type: resource.resourceType,
        Properties: resource.properties || {},
        ...(resource.dependencies &&
          resource.dependencies.length > 0 && {
            DependsOn: resource.dependencies,
          }),
      };
    }

    // Type-based implicit deletion ordering (shared with deploy DELETE phase).
    const typeToLogicalIds = new Map<string, string[]>();
    for (const [logicalId, resource] of Object.entries(state.resources)) {
      const ids = typeToLogicalIds.get(resource.resourceType) ?? [];
      ids.push(logicalId);
      typeToLogicalIds.set(resource.resourceType, ids);
    }

    for (const [logicalId, resource] of Object.entries(state.resources)) {
      const mustDeleteAfter = IMPLICIT_DELETE_DEPENDENCIES[resource.resourceType];
      if (!mustDeleteAfter) continue;

      for (const depType of mustDeleteAfter) {
        const depIds = typeToLogicalIds.get(depType);
        if (!depIds) continue;
        for (const depId of depIds) {
          const existing = template.Resources[depId]?.DependsOn ?? [];
          const depsArray = Array.isArray(existing) ? existing : [existing];
          if (!depsArray.includes(logicalId)) {
            template.Resources[depId] = {
              ...template.Resources[depId]!,
              DependsOn: [...depsArray, logicalId],
            };
            logger.debug(
              `Implicit delete dependency: ${depId} (${depType}) must be deleted before ${logicalId} (${resource.resourceType})`
            );
          }
        }
      }
    }

    const dagBuilder = new DagBuilder();
    const graph = dagBuilder.buildGraph(template);
    const executionLevels = dagBuilder.getExecutionLevels(graph);

    logger.debug(`Dependency graph: ${executionLevels.length} level(s)`);

    // Process levels in reverse order for deletion.
    for (let levelIndex = executionLevels.length - 1; levelIndex >= 0; levelIndex--) {
      const level = executionLevels[levelIndex];
      if (!level) continue;

      logger.debug(
        `Deletion level ${executionLevels.length - levelIndex}/${executionLevels.length} (${level.length} resources)`
      );

      const stackRegion = state.region ?? ctx.baseRegion;

      const deletePromises = level.map(async (logicalId) => {
        const resource = state.resources[logicalId];
        if (!resource) {
          logger.warn(`Resource ${logicalId} not found in state, skipping`);
          return;
        }

        const baseLabel = `Deleting ${logicalId} (${resource.resourceType})`;
        renderer.addTask(logicalId, baseLabel);
        try {
          const provider = destroyProviderRegistry.getProvider(resource.resourceType);

          // Per-resource-type overrides (v2) win over the global default.
          // Resolution order:
          //   1. per-type CLI override (`--resource-timeout TYPE=DURATION`).
          //   2. provider self-report raised against the global default
          //      (`max(getMinResourceTimeoutMs(), globalCli)`).
          //   3. CLI global default (`--resource-timeout 30m`).
          //   4. compile-time default (DEFAULT_RESOURCE_*_MS).
          const providerMinTimeoutMs = provider.getMinResourceTimeoutMs?.() ?? 0;
          const warnAfterMs =
            ctx.resourceWarnAfterByType?.[resource.resourceType] ??
            ctx.resourceWarnAfterMs ??
            DEFAULT_RESOURCE_WARN_AFTER_MS;
          const globalTimeoutMs = ctx.resourceTimeoutMs ?? DEFAULT_RESOURCE_TIMEOUT_MS;
          const timeoutMs =
            ctx.resourceTimeoutByType?.[resource.resourceType] ??
            Math.max(providerMinTimeoutMs, globalTimeoutMs);

          // Wrap the entire retry loop in the per-resource deadline so a
          // genuinely-stuck delete (e.g. a hung Custom Resource handler or
          // a Cloud-Control polling loop that never terminates) aborts
          // instead of holding the destroy forever.
          await withResourceDeadline(
            async () => {
              // Retry DELETE for transient errors (throttle, dependency race).
              // Providers that opt out of outer retry (e.g. Custom Resources,
              // whose delete generates a fresh pre-signed S3 URL each call)
              // run exactly once.
              const maxAttempts = provider.disableOuterRetry ? 0 : 3;
              let lastDeleteError: unknown;
              for (let attempt = 0; attempt <= maxAttempts; attempt++) {
                try {
                  await provider.delete(
                    logicalId,
                    resource.physicalId,
                    resource.resourceType,
                    resource.properties
                  );
                  lastDeleteError = null;
                  break;
                } catch (retryError) {
                  lastDeleteError = retryError;
                  const msg = retryError instanceof Error ? retryError.message : String(retryError);
                  const isRetryable =
                    msg.includes('Too Many Requests') ||
                    msg.includes('has dependencies') ||
                    msg.includes("can't be deleted since") ||
                    msg.includes('DependencyViolation');
                  if (!isRetryable || attempt >= maxAttempts) break;
                  const delay = 5000 * Math.pow(2, attempt);
                  logger.debug(
                    `  ⏳ Retrying delete ${logicalId} in ${delay / 1000}s (attempt ${attempt + 1}/${maxAttempts})`
                  );
                  await new Promise((resolve) => setTimeout(resolve, delay));
                }
              }
              if (lastDeleteError) throw lastDeleteError;
            },
            {
              warnAfterMs,
              timeoutMs,
              onWarn: (elapsedMs) => {
                const minutes = Math.max(1, Math.round(elapsedMs / 60_000));
                renderer.updateTaskLabel(
                  logicalId,
                  `${baseLabel} [taking longer than expected, ${minutes}m+]`
                );
                renderer.printAbove(() => {
                  logger.warn(
                    `${logicalId} (${resource.resourceType}) has been deleting for ${minutes}m — still waiting`
                  );
                });
              },
              onTimeout: (elapsedMs) =>
                new ResourceTimeoutError(
                  logicalId,
                  resource.resourceType,
                  stackRegion,
                  elapsedMs,
                  'DELETE',
                  timeoutMs
                ),
            }
          );

          renderer.removeTask(logicalId);
          logger.info(`  ✅ ${logicalId} (${resource.resourceType}) deleted`);
          result.deletedCount++;
        } catch (error) {
          renderer.removeTask(logicalId);
          const msg = error instanceof Error ? error.message : String(error);
          // Treat "not found" as already deleted.
          if (
            msg.includes('does not exist') ||
            msg.includes('not found') ||
            msg.includes('No policy found') ||
            msg.includes('NoSuchEntity') ||
            msg.includes('NotFoundException')
          ) {
            logger.debug(`  ${logicalId} already deleted, removing from state`);
            result.deletedCount++;
          } else if (error instanceof ResourceTimeoutError) {
            // Surface the actionable timeout message wrapped as a
            // ProvisioningError (parity with deploy's failure path) and
            // count it as an error so the state file is preserved.
            const wrapped = new ProvisioningError(
              error.message,
              resource.resourceType,
              logicalId,
              resource.physicalId,
              error
            );
            logger.error(`  ✗ Failed to delete ${logicalId}:`, wrapped.message);
            result.errorCount++;
          } else {
            logger.error(`  ✗ Failed to delete ${logicalId}:`, String(error));
            result.errorCount++;
          }
        } finally {
          renderer.removeTask(logicalId);
        }
      });

      await Promise.all(deletePromises);
    }

    if (result.errorCount === 0) {
      await ctx.stateBackend.deleteState(stackName, regionForState);
      logger.debug('State deleted');
    } else {
      logger.warn(`${result.errorCount} resource(s) failed to delete. State preserved.`);
    }

    // Summary glyph distinguishes clean destroy (✓) from partial failure
    // (⚠). The CLI's exit code reflects the same split (0 vs 2) — see
    // PartialFailureError in src/utils/error-handler.ts. Without the
    // visual marker, a partial failure scrolls past in the same shape
    // as a successful destroy and gets missed in CI / bench output.
    if (result.errorCount === 0) {
      logger.info(
        `\n✓ Stack ${stackName} destroyed (${result.deletedCount} deleted, ${result.errorCount} errors)`
      );
    } else {
      logger.warn(
        `\n⚠ Stack ${stackName} partially destroyed (${result.deletedCount} deleted, ${result.errorCount} errors). ` +
          `State preserved — re-run 'cdkd destroy' / 'cdkd state destroy' to clean up.`
      );
    }
  } finally {
    // Stop live renderer before releasing the lock so any pending in-flight
    // task lines are cleared cleanly.
    renderer.stop();

    logger.debug('Releasing lock...');
    await ctx.lockManager.releaseLock(stackName, regionForState);

    // Restore base region/clients if we switched.
    if (destroyAwsClients) {
      destroyAwsClients.destroy();
      process.env['AWS_REGION'] = ctx.baseRegion;
      process.env['AWS_DEFAULT_REGION'] = ctx.baseRegion;
      setAwsClients(ctx.baseAwsClients);
    }
  }

  return result;
}
