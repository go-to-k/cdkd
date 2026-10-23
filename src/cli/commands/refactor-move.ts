/**
 * `cdkd refactor` across stacks (go-to-k/cdkd#5202): a record the source
 * stack's template no longer declares is moved into the destination stack
 * whose template newly declares a resource of the same type, when the
 * destination's diff then shows that resource unchanged.
 *
 * Planning reads only. The apply lists each move in the shared refactor
 * marker before writing any record, then marks it in the SOURCE record, so an
 * interruption at any point leaves the move listed: the deploy and destroy of
 * BOTH stacks refuse, and the next `cdkd refactor` with either stack selected
 * finishes it (go-to-k/cdkd#5212).
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
import type { PendingMoveOut, ResourceState, StackState } from '../../types/state.js';
import { hasPendingMovesOut, pendingMovesOutOf } from '../../state/pending-moves.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import {
  refactorMarkerMovesOf,
  sameMove,
  updateRefactorMarker,
  type RefactorMarkerMove,
} from '../../state/refactor-marker.js';
import { stackInstanceIdCarriedFrom } from '../../types/state.js';
import type { ProposedMove, StackRefactorPlan } from './refactor.js';

/** A move the user named in the mapping file. */
export interface MoveOverride {
  /** The mapping environment's region; both stacks are in it. */
  region: string;
  /**
   * The mapping environment's key, in `envOf`'s spelling: both stacks must be
   * in exactly this account and region.
   */
  env: string;
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

/** A row's identity across a run: stack, region and logical id. */
const rowKey = (stack: string, region: string, logicalId: string): string =>
  JSON.stringify([stack, region, logicalId]);
/** The `Stack.LogicalId` location a mapping file spells. */
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
    if (envOf(source) !== o.env || envOf(dest) !== o.env) {
      refuse("the two stacks are not both in the mapping environment's account and region");
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
      takenFrom.has(rowKey(o.fromStack, source.region, o.from)) ||
      takenTo.has(rowKey(o.toStack, dest.region, o.to))
    ) {
      refuse('the mapping names one of these locations more than once');
    } else {
      takenFrom.add(rowKey(o.fromStack, source.region, o.from));
      takenTo.add(rowKey(o.toStack, dest.region, o.to));
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
        .filter((d) => !takenFrom.has(rowKey(plan.stackName, plan.region, d.logicalId)))
        .map((d) => ({ plan, row: d }))
    );
    const creates = envPlans.flatMap((plan) =>
      plan.unpaired.creates
        .filter((c) => !takenTo.has(rowKey(plan.stackName, plan.region, c.logicalId)))
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
          source: producerRecordKey(m.fromStack, m.fromRegion),
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
  | 'getState'
  | 'saveState'
  | 'rotateCreateTokenNonce'
  | 'loadRollbackJournal'
  | 'getRefactorMarker'
  | 'saveRefactorMarker'
>;

const lockKey = (p: StackRefactorPlan): string => producerRecordKey(p.stackName, p.region);

/** One marked move per record leaving a source. */
function marksFor(plan: StackRefactorPlan, startedAt: number): PendingMoveOut[] {
  return plan.movesOut.map((m) => ({
    from: m.from,
    toStack: m.toStack,
    toRegion: m.toRegion,
    to: m.to,
    startedAt,
  }));
}

/** `state` with `marks` appended to its pending moves. */
function withMarks(state: StackState, marks: readonly PendingMoveOut[]): StackState {
  if (marks.length === 0) return state;
  const { moves } = pendingMovesOutOf(state);
  return { ...state, ...stackInstanceIdCarriedFrom(state), pendingMovesOut: [...moves, ...marks] };
}

/** `state` with the moves of `done` (by source logical id) taken off its pending moves. */
function withoutMarks(state: StackState, done: ReadonlySet<string>): StackState {
  const { moves } = pendingMovesOutOf(state);
  const left = moves.filter((m) => !done.has(m.from));
  const { pendingMovesOut: _dropped, ...rest } = state;
  void _dropped;
  // Carried from `rest`, which no longer holds the field this drops.
  const carried = { ...rest, ...stackInstanceIdCarriedFrom(rest) };
  return left.length > 0 ? { ...carried, pendingMovesOut: left } : carried;
}

/**
 * Apply every plan of a run that moves a record between stacks
 * (go-to-k/cdkd#5202, made interruption-safe by go-to-k/cdkd#5212):
 *
 * - lock every stack (in a fixed order, so two runs cannot deadlock) and
 *   re-read each record, refusing unless its ETag is the one planned from;
 * 1. list every move in the shared refactor marker;
 * 2. save each SOURCE with its renames and a `pendingMovesOut` entry per
 *    moving record, the record still in `resources` (rename-only stacks are
 *    saved here too, complete);
 * 3. save each DESTINATION with its renames and the moved records;
 * 4. save each source again without the moved records and their entries;
 * 5. unlist the moves.
 *
 * From step 1 on, `cdkd deploy` / `cdkd destroy` of either stack refuse: a
 * record held by both stacks can never be deleted by the source, and a
 * destination whose record knows nothing yet cannot create the resource
 * again. A failure or an interruption at any step leaves a state the next
 * `cdkd refactor` with either stack selected finishes
 * ({@link finishInterruptedMoves}). Nothing here touches AWS.
 */
export async function applyMoveGroup(input: {
  plans: readonly StackRefactorPlan[];
  stateBackend: MoveBackend;
  lockManager: Pick<LockManager, 'acquireLock' | 'releaseLock'>;
  recovery: LockRecoveryContext;
  contentionMessage: (plan: StackRefactorPlan) => Promise<string>;
  now?: () => number;
}): Promise<void> {
  const { stateBackend, lockManager, recovery, contentionMessage } = input;
  const plans = [...input.plans].sort((a, b) => (lockKey(a) < lockKey(b) ? -1 : 1));
  await withLocks(plans, lockManager, contentionMessage, async () => {
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
      refuseReadForWrite(stateData.state, plan.stackName, plan.region, recovery);
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
    const renamed = (plan: StackRefactorPlan): StackState =>
      applyLogicalIdRenames(
        loaded.get(plan)!.state,
        plan.renames.map(({ from, to }) => ({ from, to })),
        plan.template
      );
    const startedAt = (input.now ?? Date.now)();
    const written: string[] = [];
    const fail = (plan: StackRefactorPlan, error: unknown): CdkdError => {
      const sources = plans.filter((p) => p.movesOut.length > 0).map((p) => p.stackName);
      return new CdkdError(
        safeMsg`cdkd refactor could not save stack ${plan.stackName} (${plan.region}): ` +
          safeMsg`${(error as Error).message}.\n` +
          (written.length > 0
            ? safeMsg`Written before the failure: ${written.join(', ')}.\n`
            : '') +
          safeMsg`Any move that started is recorded in its source stack (${sources.join(', ')}), ` +
          "whose 'cdkd deploy' and 'cdkd destroy' refuse until it is finished. Re-run " +
          safeMsg`'cdkd refactor ${sources.join(' ')}' to finish it.`,
        'REFACTOR_PARTIAL'
      );
    };
    const save = async (
      plan: StackRefactorPlan,
      state: StackState,
      expectedEtag: string
    ): Promise<string> => {
      try {
        const etag = await stateBackend.saveState(plan.stackName, plan.region, state, {
          expectedEtag,
          ...(loaded.get(plan)!.migrationPending && { migrateLegacy: true }),
        });
        written.push(`${plan.stackName} (${plan.region})`);
        return etag;
      } catch (error) {
        throw fail(plan, error);
      }
    };

    // Step 1: the shared marker, before any record (go-to-k/cdkd#5212): from
    // here on a deploy or destroy of ANY stack a move involves refuses,
    // including a destination whose own record knows nothing of the move.
    const markerMoves: RefactorMarkerMove[] = plans.flatMap((p) =>
      p.movesOut.map((m) => ({
        fromStack: m.fromStack,
        fromRegion: m.fromRegion,
        from: m.from,
        toStack: m.toStack,
        toRegion: m.toRegion,
        to: m.to,
        startedAt,
      }))
    );
    if (markerMoves.length > 0) {
      await updateRefactorMarker(stateBackend, (moves) => [
        ...moves.filter((m) => !markerMoves.some((n) => sameMove(m, n))),
        ...markerMoves,
      ]);
    }
    // Step 2: the sources, marked, and the rename-only stacks.
    const sourceEtags = new Map<StackRefactorPlan, string>();
    const marked = new Map<StackRefactorPlan, StackState>();
    for (const plan of plans.filter((p) => p.movesIn.length === 0)) {
      const leaving = [...plan.renames.map((r) => r.from), ...plan.movesOut.map((m) => m.from)];
      if (leaving.length > 0) {
        await stateBackend.rotateCreateTokenNonce(plan.stackName, plan.region, leaving);
      }
      const state = withMarks(renamed(plan), marksFor(plan, startedAt));
      marked.set(plan, state);
      sourceEtags.set(plan, await save(plan, state, plan.etag));
    }
    // Step 3: the destinations.
    for (const plan of plans.filter((p) => p.movesIn.length > 0)) {
      if (plan.renames.length > 0) {
        await stateBackend.rotateCreateTokenNonce(
          plan.stackName,
          plan.region,
          plan.renames.map((r) => r.from)
        );
      }
      const state = insertMovedRecords(
        renamed(plan),
        plan.movesIn.map((m) => ({
          from: m.from,
          to: m.to,
          record: recordOf(m.fromStack, m.fromRegion, m.from),
          source: producerRecordKey(m.fromStack, m.fromRegion),
        })),
        plan.template
      );
      await save(plan, state, plan.etag);
    }
    // Step 4: the sources, without the moved records and their marks.
    for (const plan of plans.filter((p) => p.movesOut.length > 0)) {
      const state = withoutMarks(
        removeMovedRecords(
          marked.get(plan)!,
          plan.movesOut.map(({ from, to }) => ({ from, to }))
        ),
        new Set(plan.movesOut.map((m) => m.from))
      );
      await save(plan, state, sourceEtags.get(plan)!);
    }
    // Step 5: the marker, without these moves. A failure here leaves every
    // record complete and the marker stale: the next `cdkd refactor` of a
    // source finds nothing to do and clears it.
    if (markerMoves.length > 0) {
      try {
        await updateRefactorMarker(stateBackend, (moves) =>
          moves.filter((m) => !markerMoves.some((n) => sameMove(m, n)))
        );
      } catch (error) {
        throw new CdkdError(
          safeMsg`Every record of the refactor was written, but the refactor marker could not ` +
            safeMsg`be cleared: ${(error as Error).message}. Until it is, deploy and destroy of ` +
            'the moved stacks refuse; re-run cdkd refactor to clear it.',
          'REFACTOR_PARTIAL'
        );
      }
    }
  });
}

/** Refuse a record this writer cannot safely rewrite. */
function refuseReadForWrite(
  state: StackState,
  stackName: string,
  region: string,
  recovery: LockRecoveryContext
): void {
  refuseMalformedState(state, stackName, region, recovery);
  refuseMalformedOrphans(state, stackName, region, recovery);
  refuseMalformedOrphanRecords(state, stackName, region, recovery);
}

/** Hold the locks of `plans` (already in lock order) around `fn`, releasing every one taken. */
async function withLocks<P extends { stackName: string; region: string }, T>(
  plans: readonly P[],
  lockManager: Pick<LockManager, 'acquireLock' | 'releaseLock'>,
  contentionMessage: (plan: P) => Promise<string>,
  fn: () => Promise<T>
): Promise<T> {
  const logger = getLogger();
  const owner = `${process.env['USER'] || 'unknown'}@${process.env['HOSTNAME'] || 'host'}:${process.pid}`;
  const locked: P[] = [];
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
    return await fn();
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

/** A finished, or refused, interrupted move. */
export interface FinishedMove {
  fromStack: string;
  fromRegion: string;
  from: string;
  toStack: string;
  toRegion: string;
  to: string;
}

/**
 * Finish the moves an interrupted `cdkd refactor` left recorded in a source
 * stack's `pendingMovesOut` (go-to-k/cdkd#5212). Under the source's and every
 * destination's lock, for each entry:
 *
 * - the destination already holds the record under the same physical id:
 *   nothing to add;
 * - the destination holds no record under that id: the source's record is
 *   added there;
 * - the destination holds a DIFFERENT resource under that id (a deploy
 *   created one before the move finished): refused, naming both ids, and the
 *   entry is kept;
 * - the source no longer holds the record: the entry is dropped when the
 *   destination holds one, refused when neither does.
 *
 * Then the source drops the finished records and their entries. Destinations
 * are saved before the source, so a failure here leaves entries the next run
 * finishes again. Nothing touches AWS.
 */
export async function finishPendingMoves(input: {
  stackName: string;
  region: string;
  /**
   * Moves out of this stack the shared refactor marker lists. A run killed
   * after writing the marker and before marking the source leaves them only
   * there; they are finished exactly as a marked move is.
   */
  markerMoves?: readonly PendingMoveOut[];
  /**
   * Whether the destination's synthesized template declares `logicalId` with
   * `resourceType`. A record is added to a destination only when it does: a
   * move is otherwise trusted on its listing alone, and a crafted listing
   * could carry another stack's record into this one.
   */
  declaresInDestination: (
    stackName: string,
    region: string,
    logicalId: string,
    resourceType: string
  ) => boolean;
  stateBackend: Pick<S3StateBackend, 'getState' | 'saveState'>;
  lockManager: Pick<LockManager, 'acquireLock' | 'releaseLock'>;
  recovery: LockRecoveryContext;
  contentionMessage: (stack: { stackName: string; region: string }) => Promise<string>;
}): Promise<{ finished: FinishedMove[] }> {
  const { stackName, region, stateBackend, lockManager, recovery, contentionMessage } = input;
  const finishedOf = (m: PendingMoveOut): FinishedMove => ({
    fromStack: stackName,
    fromRegion: region,
    from: m.from,
    toStack: m.toStack,
    toRegion: m.toRegion,
    to: m.to,
  });
  const first = await stateBackend.getState(stackName, region);
  if (!first) {
    // The source's record is gone (destroyed after the move started). A
    // marker move whose destination holds the record is finished; any other
    // cannot be, and stays listed so the destination keeps refusing.
    const finished: FinishedMove[] = [];
    const stuck: string[] = [];
    for (const m of input.markerMoves ?? []) {
      const dest = await stateBackend.getState(m.toStack, m.toRegion);
      if (dest !== null && Object.hasOwn(dest.state.resources, m.to)) {
        finished.push(finishedOf(m));
      } else {
        stuck.push(safeMsg`${stackName}.${m.from} -> ${m.toStack}.${m.to}`);
      }
    }
    if (stuck.length > 0) {
      throw new CdkdError(
        safeMsg`cdkd refactor cannot finish ${stuck.join(', ')}: ${stackName} (${region}) has ` +
          'no cdkd state any more and the destination does not record the resource. If the ' +
          'resource is still in AWS, adopt it into the destination with cdkd import; then remove ' +
          'the move from the refactor marker in the state bucket.',
        'REFACTOR_REFUSED'
      );
    }
    return { finished };
  }
  const { moves: marked, malformed } = pendingMovesOutOf(first.state);
  const moves = [
    ...marked,
    ...(input.markerMoves ?? []).filter((m) => !marked.some((n) => n.from === m.from)),
  ];
  if (malformed) {
    throw new CdkdError(
      safeMsg`Stack ${stackName} (${region}) records an unfinished cdkd refactor move this ` +
        'binary cannot read (its pendingMovesOut field is malformed), so nothing was written. ' +
        'Inspect the record with cdkd state show and repair it by hand.',
      'REFACTOR_REFUSED'
    );
  }
  if (moves.length === 0) return { finished: [] };

  const keyOf = (s: { stackName: string; region: string }): string =>
    producerRecordKey(s.stackName, s.region);
  const stacks = new Map<string, { stackName: string; region: string }>();
  stacks.set(keyOf({ stackName, region }), { stackName, region });
  for (const m of moves)
    stacks.set(keyOf({ stackName: m.toStack, region: m.toRegion }), {
      stackName: m.toStack,
      region: m.toRegion,
    });
  const ordered = [...stacks.values()].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1));

  return withLocks(ordered, lockManager, contentionMessage, async () => {
    const read = new Map<string, { state: StackState; etag: string; migrationPending?: boolean }>();
    for (const s of ordered) {
      const data = await stateBackend.getState(s.stackName, s.region);
      if (data) {
        refuseReadForWrite(data.state, s.stackName, s.region, recovery);
        read.set(keyOf(s), {
          state: data.state,
          etag: data.etag,
          ...(data.migrationPending && { migrationPending: true }),
        });
      }
    }
    const source = read.get(keyOf({ stackName, region }));
    if (!source) return { finished: [] };
    const currentMarked = pendingMovesOutOf(source.state).moves;
    const current = [
      ...currentMarked,
      ...(input.markerMoves ?? []).filter((m) => !currentMarked.some((n) => n.from === m.from)),
    ];
    const refusals: string[] = [];
    const finished: FinishedMove[] = [];
    const additions = new Map<
      string,
      Array<{ from: string; to: string; record: ResourceState; source: string }>
    >();
    for (const m of current) {
      const destKey = keyOf({ stackName: m.toStack, region: m.toRegion });
      const dest = read.get(destKey);
      const record = Object.hasOwn(source.state.resources, m.from)
        ? source.state.resources[m.from]
        : undefined;
      const held =
        dest !== undefined && Object.hasOwn(dest.state.resources, m.to)
          ? dest.state.resources[m.to]
          : undefined;
      const describe = safeMsg`${stackName}.${m.from} -> ${m.toStack}.${m.to}`;
      if (dest === undefined) {
        refusals.push(safeMsg`${describe}: ${m.toStack} (${m.toRegion}) has no cdkd state`);
      } else if (record === undefined) {
        if (held === undefined) {
          refusals.push(
            safeMsg`${describe}: neither stack records the resource; adopt it into ${m.toStack} with cdkd import`
          );
        } else {
          finished.push(finishedOf(m));
        }
      } else if (
        held === undefined &&
        !input.declaresInDestination(m.toStack, m.toRegion, m.to, record.resourceType)
      ) {
        refusals.push(
          safeMsg`${describe}: ${m.toStack}'s template does not declare ${m.to} as a ` +
            safeMsg`${record.resourceType}, so the record is not moved there. Check the move, ` +
            'and the CDK app the run synthesized'
        );
      } else if (held === undefined) {
        const list = additions.get(destKey) ?? [];
        list.push({ from: m.from, to: m.to, record, source: keyOf({ stackName, region }) });
        additions.set(destKey, list);
        finished.push(finishedOf(m));
      } else if (held.physicalId !== record.physicalId) {
        refusals.push(
          safeMsg`${describe}: ${m.toStack} already holds a different resource under ${m.to} ` +
            '(created by a deploy before the move finished). Delete or orphan that resource in ' +
            safeMsg`${m.toStack}, then re-run cdkd refactor`
        );
      } else {
        finished.push(finishedOf(m));
      }
    }
    for (const [destKey, list] of additions) {
      const dest = read.get(destKey)!;
      const s = stacks.get(destKey)!;
      await stateBackend.saveState(
        s.stackName,
        s.region,
        insertMovedRecords(dest.state, list, { Resources: {} }),
        { expectedEtag: dest.etag, ...(dest.migrationPending && { migrateLegacy: true }) }
      );
    }
    if (finished.length > 0) {
      const done = new Set(finished.map((f) => f.from));
      const leaving = finished
        .filter((f) => Object.hasOwn(source.state.resources, f.from))
        .map(({ from, to }) => ({ from, to }));
      await stateBackend.saveState(
        stackName,
        region,
        withoutMarks(
          leaving.length > 0 ? removeMovedRecords(source.state, leaving) : source.state,
          done
        ),
        { expectedEtag: source.etag, ...(source.migrationPending && { migrateLegacy: true }) }
      );
    }
    if (refusals.length > 0) {
      const error = new CdkdError(
        safeMsg`cdkd refactor could not finish ${refusals.length} interrupted move(s) out of ` +
          safeMsg`${stackName} (${region}); they stay recorded, so the deploy and destroy of ` +
          'both stacks keep refusing' +
          (finished.length > 0 ? safeMsg` (${finished.length} other move(s) were finished)` : '') +
          ':\n' +
          refusals.map((r) => `  ${r}.`).join('\n'),
        'REFACTOR_REFUSED'
      );
      // The moves that DID finish are written; the caller unlists them.
      Object.assign(error, { finishedMoves: finished });
      throw error;
    }
    return { finished };
  });
}

/**
 * Finish, before anything is planned, every interrupted move that involves a
 * stack of this run (go-to-k/cdkd#5212). A move is known from its source
 * record's mark or from the shared marker (which a run killed before marking
 * the source leaves alone); one whose source OR destination is selected is
 * finished, and each finished move is unlisted. Under `dryRun` nothing is
 * written: the moves that would be finished are returned as `pending`.
 * Exported for its unit tests.
 */
export async function finishInterruptedMoves(input: {
  selected: ReadonlyArray<{ stackName: string; region: string }>;
  templateOf: (stackName: string, region: string) => CloudFormationTemplate | undefined;
  dryRun: boolean;
  stateBackend: Pick<
    S3StateBackend,
    'getState' | 'saveState' | 'getRefactorMarker' | 'saveRefactorMarker' | 'refactorMarkerKey'
  >;
  lockManager: Pick<LockManager, 'acquireLock' | 'releaseLock'>;
  recovery: LockRecoveryContext;
  contentionMessage: (stack: { stackName: string; region: string }) => Promise<string>;
}): Promise<{ finished: FinishedMove[]; pending: FinishedMove[] }> {
  const { stateBackend } = input;
  const marker = await stateBackend.getRefactorMarker();
  const parsed =
    marker === null ? { moves: [], malformed: false } : refactorMarkerMovesOf(marker.body);
  if (parsed.malformed) {
    throw new CdkdError(
      safeMsg`The cdkd refactor marker ${stateBackend.refactorMarkerKey()} cannot be read, so ` +
        'cdkd refactor cannot tell which moves are unfinished; nothing was written. Inspect it ' +
        'in the state bucket, and delete it once no move is in progress.',
      'REFACTOR_REFUSED'
    );
  }
  const keyOf = (stackName: string, region: string): string => producerRecordKey(stackName, region);
  const selected = new Set(input.selected.map((s) => keyOf(s.stackName, s.region)));
  const sources = new Map<
    string,
    { stackName: string; region: string; markerMoves: PendingMoveOut[]; marked: PendingMoveOut[] }
  >();
  for (const s of input.selected) {
    const current = await stateBackend.getState(s.stackName, s.region);
    const marked = current ? pendingMovesOutOf(current.state).moves : [];
    if (current && hasPendingMovesOut(current.state)) {
      sources.set(keyOf(s.stackName, s.region), { ...s, markerMoves: [], marked });
    }
  }
  for (const m of parsed.moves) {
    if (
      !selected.has(keyOf(m.fromStack, m.fromRegion)) &&
      !selected.has(keyOf(m.toStack, m.toRegion))
    ) {
      continue;
    }
    const key = keyOf(m.fromStack, m.fromRegion);
    const entry = sources.get(key) ?? {
      stackName: m.fromStack,
      region: m.fromRegion,
      markerMoves: [],
      marked: [],
    };
    entry.markerMoves.push({
      from: m.from,
      toStack: m.toStack,
      toRegion: m.toRegion,
      to: m.to,
      startedAt: m.startedAt,
    });
    sources.set(key, entry);
  }
  const declaresInDestination = (
    stackName: string,
    region: string,
    logicalId: string,
    resourceType: string
  ): boolean => {
    const template = input.templateOf(stackName, region);
    const resources = template?.Resources ?? {};
    return (
      Object.hasOwn(resources, logicalId) &&
      (resources[logicalId] as { Type?: unknown }).Type === resourceType
    );
  };

  const finished: FinishedMove[] = [];
  const pending: FinishedMove[] = [];
  for (const source of sources.values()) {
    if (input.dryRun) {
      for (const m of [
        ...source.marked,
        ...source.markerMoves.filter((x) => !source.marked.some((y) => y.from === x.from)),
      ]) {
        pending.push({
          fromStack: source.stackName,
          fromRegion: source.region,
          from: m.from,
          toStack: m.toStack,
          toRegion: m.toRegion,
          to: m.to,
        });
      }
      continue;
    }
    let result: { finished: FinishedMove[] };
    try {
      result = await finishPendingMoves({
        stackName: source.stackName,
        region: source.region,
        markerMoves: source.markerMoves,
        declaresInDestination,
        stateBackend,
        lockManager: input.lockManager,
        recovery: input.recovery,
        contentionMessage: input.contentionMessage,
      });
    } catch (error) {
      // Some moves of this source may have finished before the refusal;
      // they are written, so unlist them before the refusal surfaces.
      const done = (error as { finishedMoves?: FinishedMove[] }).finishedMoves ?? [];
      if (done.length > 0) {
        await updateRefactorMarker(stateBackend, (moves) =>
          moves.filter((m) => !done.some((f) => sameMove(m, f)))
        );
      }
      throw error;
    }
    if (result.finished.length > 0) {
      await updateRefactorMarker(stateBackend, (moves) =>
        moves.filter((m) => !result.finished.some((f) => sameMove(m, f)))
      );
    }
    finished.push(...result.finished);
  }
  return { finished, pending };
}
