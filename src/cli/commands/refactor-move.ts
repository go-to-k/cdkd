/**
 * `cdkd refactor` across stacks (go-to-k/cdkd#5202): a record the source
 * stack's template no longer declares is moved into the destination stack
 * whose template newly declares a resource of the same type, when the
 * destination's diff then shows that resource unchanged.
 *
 * Planning reads only; the apply locks every stack it writes and saves the
 * SOURCES before the DESTINATIONS. An interruption between the two therefore
 * leaves a moved resource recorded in neither stack -- untouched in AWS and
 * recoverable with `cdkd import` -- never in both, where the source's next
 * deploy would delete the resource the destination now owns. A destination
 * save that fails restores the sources already written.
 */
import { CdkdError } from '../../utils/error-handler.js';
import { displayAwsMessage, safeMsg } from '../../utils/display-safe.js';
import { getLogger } from '../../utils/logger.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import {
  isPairableType,
  looselyEqual,
  type AmbiguousGroup,
  type RefusedOverride,
} from '../../analyzer/refactor-pairing.js';
import {
  applyLogicalIdRenames,
  insertMovedRecords,
  removeMovedRecords,
} from '../../state/logical-id-rename.js';
import {
  refuseMalformedOrphanRecords,
  refuseMalformedOrphans,
  refuseMalformedState,
} from '../../state/malformed-resources-bag.js';
import type { LockRecoveryContext } from '../../state/lock-contention-message.js';
import { producerRecordKey } from '../../state/record-keys.js';
import type { LockManager } from '../../state/lock-manager.js';
import type { S3StateBackend } from '../../state/s3-state-backend.js';
import type { ResourceState, StackState } from '../../types/state.js';
import type { ProposedMove, StackRefactorPlan } from './refactor.js';

/** A move the user named in the mapping file. */
export interface MoveOverride {
  /** The mapping environment's region; both stacks are in it. */
  region: string;
  fromStack: string;
  from: string;
  toStack: string;
  to: string;
}

/** A move refused, with the reason. */
export interface RefusedMove extends RefusedOverride {
  fromStack: string;
  toStack: string;
}

/** A detected move whose destination still changes: left for the deploy. */
export interface DifferingMove {
  move: ProposedMove;
  paths: string[];
}

/** Look-alikes across stacks no rule can split. */
export interface AmbiguousMoveGroup extends AmbiguousGroup {
  /** `Stack.LogicalId` locations, not bare logical ids. */
  from: string[];
  to: string[];
  /** The plan the sample mapping file's environment comes from. */
  plan: StackRefactorPlan;
}

export interface MovePlan {
  moves: ProposedMove[];
  differing: DifferingMove[];
  refused: RefusedMove[];
  ambiguous: AmbiguousMoveGroup[];
}

const location = (stack: string, logicalId: string): string => `${stack}.${logicalId}`;

/**
 * Plan the moves between `plans`, the stacks one run selected. `envOf` keys a
 * plan by account and region: a move never leaves its environment. Fills each
 * plan's `movesOut` / `movesIn` with the confirmed moves.
 */
export async function planMoves(
  plans: readonly StackRefactorPlan[],
  envOf: (plan: StackRefactorPlan) => string,
  overrides: readonly MoveOverride[]
): Promise<MovePlan> {
  const planAt = (stack: string, region: string): StackRefactorPlan | undefined =>
    plans.find((p) => p.stackName === stack && p.region === region);
  const result: MovePlan = { moves: [], differing: [], refused: [], ambiguous: [] };
  const takenFrom = new Set<string>();
  const takenTo = new Set<string>();
  const candidates: ProposedMove[] = [];

  const move = (
    source: StackRefactorPlan,
    from: string,
    dest: StackRefactorPlan,
    to: string,
    resourceType: string,
    origin: ProposedMove['source']
  ): ProposedMove => ({
    fromStack: source.stackName,
    fromRegion: source.region,
    from,
    toStack: dest.stackName,
    toRegion: dest.region,
    to,
    resourceType,
    source: origin,
  });

  for (const o of overrides) {
    const source = planAt(o.fromStack, o.region);
    const dest = planAt(o.toStack, o.region);
    const refuse = (reason: string): void => {
      result.refused.push({
        fromStack: o.fromStack,
        from: o.from,
        toStack: o.toStack,
        to: o.to,
        reason,
      });
    };
    if (source === undefined || dest === undefined) {
      refuse('both stacks must be selected and hold cdkd state; a refactor never creates a stack');
      continue;
    }
    if (envOf(source) !== envOf(dest)) {
      refuse('the two stacks are in different accounts or regions');
      continue;
    }
    const d = source.unpaired.deletes.find((x) => x.logicalId === o.from);
    const c = dest.unpaired.creates.find((x) => x.logicalId === o.to);
    if (d === undefined) {
      refuse(
        `${o.from} is not a resource ${o.fromStack}'s state holds and its template no longer declares`
      );
    } else if (c === undefined) {
      refuse(
        `${o.to} is not a resource ${o.toStack}'s template declares and its state does not hold`
      );
    } else if (d.resourceType !== c.resourceType) {
      refuse(`the types differ (${d.resourceType} and ${c.resourceType})`);
    } else if (!isPairableType(d.resourceType)) {
      refuse(`cdkd refactor cannot move a ${d.resourceType} resource`);
    } else if (
      takenFrom.has(location(o.fromStack, o.from)) ||
      takenTo.has(location(o.toStack, o.to))
    ) {
      refuse('the mapping names one of these locations more than once');
    } else {
      takenFrom.add(location(o.fromStack, o.from));
      takenTo.add(location(o.toStack, o.to));
      candidates.push(move(source, o.from, dest, o.to, d.resourceType, 'override'));
    }
  }

  // Detection, per environment and type, over rows of DIFFERENT stacks only:
  // a row's own stack was already searched by the in-stack pass.
  const envs = new Set(plans.map(envOf));
  for (const env of envs) {
    const envPlans = plans.filter((p) => envOf(p) === env);
    const deletes = envPlans.flatMap((plan) =>
      plan.unpaired.deletes
        .filter((d) => !takenFrom.has(location(plan.stackName, d.logicalId)))
        .map((d) => ({ plan, row: d }))
    );
    const creates = envPlans.flatMap((plan) =>
      plan.unpaired.creates
        .filter((c) => !takenTo.has(location(plan.stackName, c.logicalId)))
        .map((c) => ({ plan, row: c }))
    );
    const types = [...new Set(creates.map((c) => c.row.resourceType))].sort();
    for (const type of types) {
      if (!isPairableType(type)) continue;
      const ds = deletes.filter((d) => d.row.resourceType === type);
      const cs = creates.filter((c) => c.row.resourceType === type);
      if (ds.length === 0 || cs.length === 0) continue;
      if (ds.length === 1 && cs.length === 1) {
        if (ds[0]!.plan !== cs[0]!.plan) {
          candidates.push(
            move(
              ds[0]!.plan,
              ds[0]!.row.logicalId,
              cs[0]!.plan,
              cs[0]!.row.logicalId,
              type,
              'detected'
            )
          );
        }
        continue;
      }
      const matchesOf = new Map<(typeof cs)[number], Array<(typeof ds)[number]>>();
      const claims = new Map<(typeof ds)[number], number>();
      for (const c of cs) {
        const matches = ds.filter(
          (d) => d.plan !== c.plan && looselyEqual(c.row.properties, d.row.properties)
        );
        matchesOf.set(c, matches);
        for (const d of matches) claims.set(d, (claims.get(d) ?? 0) + 1);
      }
      const groupFrom = new Set<string>();
      const groupTo = new Set<string>();
      let groupPlan: StackRefactorPlan | undefined;
      for (const c of cs) {
        const matches = matchesOf.get(c) ?? [];
        if (matches.length === 0) continue;
        if (matches.length === 1 && claims.get(matches[0]!) === 1) {
          const d = matches[0]!;
          candidates.push(move(d.plan, d.row.logicalId, c.plan, c.row.logicalId, type, 'detected'));
          continue;
        }
        groupTo.add(location(c.plan.stackName, c.row.logicalId));
        for (const d of matches) {
          groupFrom.add(location(d.plan.stackName, d.row.logicalId));
          groupPlan ??= d.plan;
        }
      }
      if (groupTo.size > 0 && groupPlan !== undefined) {
        result.ambiguous.push({
          resourceType: type,
          from: [...groupFrom].sort(),
          to: [...groupTo].sort(),
          plan: groupPlan,
        });
      }
    }
  }

  // Confirm per destination, re-diffing after each drop as the in-stack pass
  // does: a moved resource can reference another moved one.
  let kept = candidates;
  for (;;) {
    const failed: ProposedMove[] = [];
    for (const dest of plans) {
      const incoming = kept.filter(
        (m) => m.toStack === dest.stackName && m.toRegion === dest.region
      );
      if (incoming.length === 0) continue;
      const renamed = applyLogicalIdRenames(
        dest.state,
        dest.renames.map(({ from, to }) => ({ from, to })),
        dest.template
      );
      const withMoves = insertMovedRecords(
        renamed,
        incoming.map((m) => ({
          from: m.from,
          to: m.to,
          record: planAt(m.fromStack, m.fromRegion)!.state.resources[m.from]!,
        })),
        dest.template
      );
      const { changes } = await dest.diff(withMoves);
      for (const m of incoming) {
        const change = changes.get(m.to);
        if (change?.changeType === 'NO_CHANGE') continue;
        failed.push(m);
        const paths = (change?.propertyChanges ?? []).map((p) => p.path);
        for (const a of change?.attributeChanges ?? []) paths.push(a.attribute);
        if (paths.length === 0) paths.push(`(${change?.changeType ?? 'not in the diff'})`);
        if (m.source === 'override') {
          result.refused.push({
            fromStack: m.fromStack,
            from: m.from,
            toStack: m.toStack,
            to: m.to,
            reason:
              `its properties also changed (${paths.join(', ')}); cdkd refactor keeps only an ` +
              'unchanged resource. Revert the property change, run cdkd refactor, then deploy ' +
              'the change',
          });
        } else {
          result.differing.push({ move: m, paths });
        }
      }
    }
    if (failed.length === 0) break;
    kept = kept.filter((m) => !failed.includes(m));
  }

  for (const m of kept) {
    planAt(m.fromStack, m.fromRegion)!.movesOut.push(m);
    planAt(m.toStack, m.toRegion)!.movesIn.push(m);
  }
  result.moves = kept;

  const both = plans.filter((p) => p.movesOut.length > 0 && p.movesIn.length > 0);
  if (both.length > 0) {
    throw new CdkdError(
      safeMsg`cdkd refactor refused: ${both.map((p) => p.stackName).join(', ')} would both lose ` +
        'and gain a resource in one run, so nothing was written. Refactor one direction at a ' +
        'time: select only the stacks of one move direction, or name one direction in the ' +
        'mapping file.',
      'REFACTOR_REFUSED'
    );
  }
  return result;
}

/** The move lines `cdkd refactor` prints. Exported for its unit tests. */
export function renderMovePlan(plan: MovePlan): string[] {
  const lines: string[] = [];
  if (
    plan.moves.length === 0 &&
    plan.differing.length === 0 &&
    plan.refused.length === 0 &&
    plan.ambiguous.length === 0
  ) {
    return lines;
  }
  lines.push('Moves between stacks');
  for (const m of plan.moves) {
    lines.push(
      safeMsg`  ${m.fromStack}.${m.from} -> ${m.toStack}.${m.to}  (${m.resourceType}${m.source === 'override' ? ', from the mapping file' : ''})`
    );
  }
  for (const { move: m, paths } of plan.differing) {
    lines.push(
      safeMsg`  Not moved: ${m.fromStack}.${m.from} -> ${m.toStack}.${m.to} (${m.resourceType}) also ` +
        safeMsg`changes ${paths.join(', ')}. cdkd refactor keeps only an unchanged resource: revert ` +
        'the property change, run cdkd refactor, then deploy the change.'
    );
  }
  for (const group of plan.ambiguous) {
    lines.push(
      safeMsg`  Ambiguous (${group.resourceType}): ${group.from.join(', ')} could each be ` +
        safeMsg`${group.to.join(', ')}. Name the pairs with --override-file.`
    );
  }
  for (const r of plan.refused) {
    lines.push(safeMsg`  Refused: ${r.fromStack}.${r.from} -> ${r.toStack}.${r.to}: ${r.reason}.`);
  }
  return lines;
}

type MoveBackend = Pick<
  S3StateBackend,
  'getState' | 'saveState' | 'rotateCreateTokenNonce' | 'loadRollbackJournal'
>;

const lockKey = (p: StackRefactorPlan): string => producerRecordKey(p.stackName, p.region);

/**
 * Apply every plan of a run that moves a record between stacks, as one unit:
 * lock every stack (in a fixed order, so two runs cannot deadlock), re-read
 * each record and refuse unless its ETag is the one planned from, then save
 * the sources (and rename-only stacks) before the destinations. A failed
 * destination save restores each source already written, conditional on the
 * ETag that save returned.
 */
export async function applyMoveGroup(input: {
  plans: readonly StackRefactorPlan[];
  stateBackend: MoveBackend;
  lockManager: Pick<LockManager, 'acquireLock' | 'releaseLock'>;
  recovery: LockRecoveryContext;
  contentionMessage: (plan: StackRefactorPlan) => Promise<string>;
}): Promise<void> {
  const { stateBackend, lockManager, recovery, contentionMessage } = input;
  const logger = getLogger();
  const owner = `${process.env['USER'] || 'unknown'}@${process.env['HOSTNAME'] || 'host'}:${process.pid}`;
  const plans = [...input.plans].sort((a, b) => (lockKey(a) < lockKey(b) ? -1 : 1));
  const locked: StackRefactorPlan[] = [];
  try {
    for (const plan of plans) {
      const acquired = await lockManager.acquireLock(
        plan.stackName,
        plan.region,
        owner,
        'refactor'
      );
      if (!acquired) throw new Error(await contentionMessage(plan));
      locked.push(plan);
    }

    const loaded = new Map<StackRefactorPlan, { state: StackState; migrationPending?: boolean }>();
    for (const plan of plans) {
      const stateData = await stateBackend.getState(plan.stackName, plan.region);
      if (!stateData || stateData.etag !== plan.etag) {
        throw new CdkdError(
          safeMsg`The state of stack ${plan.stackName} (${plan.region}) changed after cdkd ` +
            'refactor planned it, so nothing was written. Re-run cdkd refactor.',
          'REFACTOR_STATE_CHANGED'
        );
      }
      refuseMalformedState(stateData.state, plan.stackName, plan.region, recovery);
      refuseMalformedOrphans(stateData.state, plan.stackName, plan.region, recovery);
      refuseMalformedOrphanRecords(stateData.state, plan.stackName, plan.region, recovery);
      if ((await stateBackend.loadRollbackJournal(plan.stackName, plan.region)) !== null) {
        throw new CdkdError(
          safeMsg`cdkd refactor refused stack ${plan.stackName} (${plan.region}): an earlier ` +
            safeMsg`deploy left a rollback journal, so nothing was written. Run 'cdkd rollback ` +
            safeMsg`${plan.stackName}' or a successful 'cdkd deploy' first.`,
          'REFACTOR_REFUSED'
        );
      }
      loaded.set(plan, {
        state: stateData.state,
        ...(stateData.migrationPending && { migrationPending: true }),
      });
    }

    const recordOf = (stack: string, region: string, logicalId: string): ResourceState => {
      const plan = plans.find((p) => p.stackName === stack && p.region === region)!;
      return loaded.get(plan)!.state.resources[logicalId]!;
    };
    const next = new Map<StackRefactorPlan, StackState>();
    for (const plan of plans) {
      let state = applyLogicalIdRenames(
        loaded.get(plan)!.state,
        plan.renames.map(({ from, to }) => ({ from, to })),
        plan.template
      );
      if (plan.movesOut.length > 0) {
        state = removeMovedRecords(
          state,
          plan.movesOut.map(({ from, to }) => ({ from, to }))
        );
      }
      if (plan.movesIn.length > 0) {
        state = insertMovedRecords(
          state,
          plan.movesIn.map((m) => ({
            from: m.from,
            to: m.to,
            record: recordOf(m.fromStack, m.fromRegion, m.from),
          })),
          plan.template
        );
      }
      next.set(plan, state);
    }

    // Sources (and rename-only stacks) first, destinations last.
    const order = [
      ...plans.filter((p) => p.movesIn.length === 0),
      ...plans.filter((p) => p.movesIn.length > 0),
    ];
    const written: Array<{ plan: StackRefactorPlan; etag: string }> = [];
    for (const plan of order) {
      const leaving = [...plan.renames.map((r) => r.from), ...plan.movesOut.map((m) => m.from)];
      try {
        if (leaving.length > 0) {
          await stateBackend.rotateCreateTokenNonce(plan.stackName, plan.region, leaving);
        }
        const etag = await stateBackend.saveState(plan.stackName, plan.region, next.get(plan)!, {
          expectedEtag: plan.etag,
          ...(loaded.get(plan)!.migrationPending && { migrateLegacy: true }),
        });
        written.push({ plan, etag });
      } catch (error) {
        if (!written.some((w) => w.plan.movesOut.length > 0)) throw error;
        // A save failed after a source dropped its record: put the sources
        // back, so a resource is never left recorded nowhere.
        const unrestored: string[] = [];
        for (const w of written) {
          if (w.plan.movesOut.length === 0) continue;
          try {
            await stateBackend.saveState(
              w.plan.stackName,
              w.plan.region,
              loaded.get(w.plan)!.state,
              {
                expectedEtag: w.etag,
              }
            );
          } catch {
            unrestored.push(`${w.plan.stackName} (${w.plan.region})`);
          }
        }
        throw new CdkdError(
          safeMsg`cdkd refactor could not save stack ${plan.stackName} (${plan.region}): ` +
            safeMsg`${(error as Error).message}. ` +
            (unrestored.length === 0
              ? 'The source stacks were restored, so no record moved; re-run cdkd refactor.'
              : safeMsg`The source stacks ${unrestored.join(', ')} could not be restored: the ` +
                'moved resources are still in AWS but in no cdkd state. Adopt each into the ' +
                "destination stack with 'cdkd import', or restore the source's previous " +
                'state.json version from the versioned state bucket.'),
          'REFACTOR_PARTIAL'
        );
      }
    }
  } finally {
    for (const plan of [...locked].reverse()) {
      await lockManager.releaseLock(plan.stackName, plan.region).catch((err: unknown) => {
        logger.warn(
          safeMsg`Failed to release lock: ${displayAwsMessage(describeAwsFailure(err).detail)}`
        );
      });
    }
  }
}
