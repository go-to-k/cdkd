import { getLogger } from '../../../utils/logger.js';
import { CdkdError } from '../../../utils/error-handler.js';
import { displayAwsMessage, safeMsg } from '../../../utils/display-safe.js';
import { cdkdRemedy, pasteableCommand } from '../../../utils/pasteable-command.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { S3StateBackend } from '../../../state/s3-state-backend.js';
import { LockManager } from '../../../state/lock-manager.js';
import type { LockRecoveryContext } from '../../../state/lock-contention-message.js';
import {
  refuseMalformedOrphanRecords,
  refuseMalformedOrphans,
  refuseMalformedState,
} from '../../../state/malformed-resources-bag.js';
import { applyLogicalIdRenames } from '../../../state/logical-id-rename.js';
import {
  differingRemedy,
  mappingPairs,
  type MappingEnvironment,
} from '../../../analyzer/refactor-pairing.js';
import type { AmbiguousMoveGroup, MoveOverride } from '../refactor-move.js';
import { toLogicalIdRenames, type StackRefactorPlan } from './plan.js';

/**
 * Apply a plan under the stack's lock (go-to-k/cdkd#5201). The record is
 * re-read under the lock and must carry the ETag the plan was computed from:
 * a deploy that ran in between changed what the plan describes, so the
 * apply refuses rather than renaming against a record it did not check. The
 * save is conditional on that same ETag.
 */
export async function applyStackRefactor(input: {
  plan: StackRefactorPlan;
  stateBackend: Pick<
    S3StateBackend,
    'getState' | 'saveState' | 'rotateCreateTokenNonce' | 'loadRollbackJournal'
  >;
  lockManager: Pick<LockManager, 'acquireLock' | 'releaseLock'>;
  recovery: LockRecoveryContext;
  contentionMessage: () => Promise<string>;
}): Promise<void> {
  const { plan, stateBackend, lockManager, contentionMessage } = input;
  const logger = getLogger();
  const owner = `${process.env['USER'] || 'unknown'}@${process.env['HOSTNAME'] || 'host'}:${process.pid}`;
  const acquired = await lockManager.acquireLock(plan.stackName, plan.region, owner, 'refactor');
  if (!acquired) throw new Error(await contentionMessage());
  try {
    const stateData = await stateBackend.getState(plan.stackName, plan.region);
    if (!stateData || stateData.etag !== plan.etag) {
      throw new CdkdError(
        safeMsg`The state of stack ${plan.stackName} (${plan.region}) changed after cdkd ` +
          `refactor planned it, so nothing was written for this stack. Re-run ${cdkdRemedy('cdkd refactor')}.`,
        'REFACTOR_STATE_CHANGED'
      );
    }
    refuseMalformedState(stateData.state, plan.stackName, plan.region, input.recovery);
    refuseMalformedOrphans(stateData.state, plan.stackName, plan.region, input.recovery);
    refuseMalformedOrphanRecords(stateData.state, plan.stackName, plan.region, input.recovery);
    // Re-checked under the lock: a deploy that failed before its first state
    // save leaves a journal without moving the ETag.
    if ((await stateBackend.loadRollbackJournal(plan.stackName, plan.region)) !== null) {
      throw rollbackJournalRefusal(plan.stackName, plan.region);
    }
    const renamed = applyLogicalIdRenames(
      stateData.state,
      toLogicalIdRenames(plan.renames),
      plan.template
    );
    // The renamed resources still hold the create tokens their OLD logical
    // ids sent (EFS, FSx, CloudFront OAI), so a later create of an old id must
    // send new ones -- as `cdkd orphan` does for the ids that leave a stack.
    await stateBackend.rotateCreateTokenNonce(
      plan.stackName,
      plan.region,
      plan.renames.map((r) => r.from)
    );
    await stateBackend.saveState(plan.stackName, plan.region, renamed, {
      expectedEtag: plan.etag,
      ...(stateData.migrationPending && { migrateLegacy: true }),
    });
  } finally {
    await lockManager.releaseLock(plan.stackName, plan.region).catch((err: unknown) => {
      logger.warn(
        safeMsg`Failed to release lock: ${displayAwsMessage(describeAwsFailure(err).detail)}`
      );
    });
  }
}

/** The refusal for a stack an earlier deploy left a rollback journal on. */
export function rollbackJournalRefusal(stackName: string, region: string): CdkdError {
  return new CdkdError(
    safeMsg`cdkd refactor refused stack ${stackName} (${region}): an earlier deploy left a ` +
      safeMsg`rollback journal, so nothing was written for this stack. Run '${pasteableCommand('cdkd rollback', [{ value: stackName, hole: 'stack', opts: { patternMatched: true } }]).command}' ` +
      `or a successful '${cdkdRemedy('cdkd deploy')}' first.`,
    'REFACTOR_REFUSED'
  );
}

/** The plan as the lines `cdkd refactor` prints. Exported for its unit tests. */
export function renderRefactorPlan(plan: StackRefactorPlan): string[] {
  const lines: string[] = [safeMsg`Stack ${plan.stackName} (${plan.region})`];
  if (plan.renames.length === 0) lines.push('  No resource to refactor.');
  for (const r of plan.renames) {
    lines.push(
      safeMsg`  ${r.from} -> ${r.to}  (${r.resourceType}${r.source === 'override' ? ', from the mapping file' : ''})`
    );
  }
  for (const { rename, paths } of plan.differing) {
    lines.push(
      safeMsg`  Not refactored: ${rename.from} -> ${rename.to} (${rename.resourceType}) also changes ` +
        safeMsg`${paths.join(', ')}. ` +
        differingRemedy(paths)
    );
  }
  for (const { rename, reason } of plan.skipped) {
    lines.push(
      safeMsg`  Not refactored: ${rename.from} -> ${rename.to} (${rename.resourceType}): ${reason}.`
    );
  }
  for (const group of plan.ambiguous) {
    lines.push(
      safeMsg`  Ambiguous (${group.resourceType}): ${group.from.join(', ')} could each be ` +
        safeMsg`${group.to.join(', ')}. Name the pairs with --override-file.`
    );
  }
  for (const refused of plan.refusedOverrides) {
    lines.push(safeMsg`  Refused: ${refused.from} -> ${refused.to}: ${refused.reason}.`);
  }
  if (plan.stillChanging.length > 0) {
    lines.push(
      safeMsg`  Warning: ${plan.stillChanging.join(', ')} reference a renamed resource and still ` +
        'change on the next deploy. Check that each pair above names the resource you meant; ' +
        "'cdkd diff' after the refactor shows the change."
    );
  }
  return lines;
}

/**
 * A sample mapping file for the ambiguous groups of `plans`, one environment
 * per stack (its own account and region). Exported for its unit tests.
 */
export function sampleMappingFile(
  plans: ReadonlyArray<{ plan: StackRefactorPlan; account: string }>,
  moveGroups: ReadonlyArray<{ group: AmbiguousMoveGroup; account: string }> = []
): string {
  const moveEnvironments = moveGroups.map(({ group, account }) => {
    const resources: Record<string, string> = {};
    group.from.forEach((from, i) => {
      Object.defineProperty(resources, from, {
        value: group.to[i] ?? group.to[0]!,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    });
    return { account, region: group.plan.region, resources };
  });
  const stackEnvironments = plans
    .filter(({ plan }) => plan.ambiguous.length > 0)
    .map(({ plan, account }) => {
      const resources: Record<string, string> = {};
      for (const group of plan.ambiguous) {
        group.from.forEach((from, i) => {
          const to = group.to[i] ?? group.to[0]!;
          Object.defineProperty(resources, `${plan.stackName}.${from}`, {
            value: `${plan.stackName}.${to}`,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        });
      }
      return { account, region: plan.region, resources };
    });
  return JSON.stringify({ environments: [...stackEnvironments, ...moveEnvironments] }, null, 2);
}

/**
 * The user-named pairs WITHIN one stack: the mapping environment whose
 * account and region are the stack's. A pair between two stacks is a move,
 * collected by {@link moveOverridesOf} instead.
 */
export function overridesForStack(
  environments: readonly MappingEnvironment[],
  stackName: string,
  account: string,
  region: string,
  revert: boolean
): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  for (const env of environments) {
    if (env.account !== account || env.region !== region) continue;
    for (const pair of mappingPairs(env.resources, revert)) {
      if (pair.fromStack !== stackName || pair.toStack !== stackName) continue;
      out.push({ from: pair.from, to: pair.to });
    }
  }
  return out;
}

/**
 * The user-named moves between two stacks, for every environment whose
 * account is one of `accounts` (go-to-k/cdkd#5202). Exported for its unit
 * tests.
 */
export function moveOverridesOf(
  environments: readonly MappingEnvironment[],
  accounts: ReadonlySet<string>,
  revert: boolean
): MoveOverride[] {
  const out: MoveOverride[] = [];
  for (const env of environments) {
    if (!accounts.has(env.account)) continue;
    for (const pair of mappingPairs(env.resources, revert)) {
      if (pair.fromStack === pair.toStack) continue;
      out.push({ region: env.region, env: envKey(env.account, env.region), ...pair });
    }
  }
  return out;
}

/** One environment's key: an account and a region. */
export function envKey(account: string | undefined, region: string): string {
  return JSON.stringify([account, region]);
}
