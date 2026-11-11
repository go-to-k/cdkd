import { CdkdError } from '../../../utils/error-handler.js';
import { safeMsg } from '../../../utils/display-safe.js';
import type { LockRecoveryContext } from '../../../state/lock-contention-message.js';
import {
  refuseMalformedOrphanRecords,
  refuseMalformedOrphans,
} from '../../../state/malformed-resources-bag.js';
import { applyLogicalIdRenames, type LogicalIdRename } from '../../../state/logical-id-rename.js';
import {
  changedReferenceInDiff,
  changedReferencePath,
  changedReferenceReason,
  propertiesChangedReason,
  proposeRenames,
  referencedLogicalIds,
  type AmbiguousGroup,
  type ProposedRename,
  type RefactorCreateSide,
  type RefactorDeleteSide,
  type RefusedOverride,
} from '../../../analyzer/refactor-pairing.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import type { ResourceChange, StackState } from '../../../types/state.js';

export { referencedLogicalIds };

/**
 * The diff `cdkd refactor` plans against: `computeStackDiff`'s changes for one
 * stack over a given record. Injected so the planner is testable without AWS.
 */
export type RefactorDiffFn = (state: StackState) => Promise<{
  changes: Map<string, ResourceChange>;
  blocking: string[];
}>;

/** A rename the confirming diff rejected, with the properties it would change. */
export interface DifferingRename {
  rename: ProposedRename;
  /** The property paths (or attributes) the next deploy would change. */
  paths: string[];
}

/** A detected rename left out, with the reason. */
export interface SkippedRename {
  rename: ProposedRename;
  reason: string;
}

/** What `cdkd refactor` will do to one stack, and why it leaves the rest. */
export interface StackRefactorPlan {
  stackName: string;
  region: string;
  /** The record's ETag the plan was computed from; the apply refuses any other. */
  etag: string;
  /** Renames the confirming diff showed to be no-change. */
  renames: ProposedRename[];
  /**
   * Detected look-alikes whose properties differ, or that reference a resource
   * the next deploy changes (go-to-k/cdkd#6097): left for the deploy.
   */
  differing: DifferingRename[];
  /** Detected renames left out for another reason (a rollback-orphan record). */
  skipped: SkippedRename[];
  ambiguous: AmbiguousGroup[];
  /** User-named pairs refused, including those whose properties differ. */
  refusedOverrides: RefusedOverride[];
  /**
   * Template resources that reference a renamed one and still change after
   * the renames: a warning that a named pair may be the wrong way round.
   */
  stillChanging: string[];
  template: CloudFormationTemplate;
  /**
   * The DELETE and CREATE rows no in-stack rename took, the candidates for a
   * move between stacks (go-to-k/cdkd#5202). A look-alike whose properties
   * differ stays a candidate: its match may be in another stack.
   */
  unpaired: { creates: RefactorCreateSide[]; deletes: RefactorDeleteSide[] };
  /** Records moving out of this stack to another (filled by `planMoves`). */
  movesOut: ProposedMove[];
  /** Records moving into this stack from another (filled by `planMoves`). */
  movesIn: ProposedMove[];
  /** The record the plan read, for the move confirmation; never saved. */
  state: StackState;
  /** The stack's diff, for the move confirmation. */
  diff: RefactorDiffFn;
}

/** A record moving between two stacks of one environment. */
export interface ProposedMove {
  fromStack: string;
  fromRegion: string;
  from: string;
  toStack: string;
  toRegion: string;
  to: string;
  resourceType: string;
  source: 'detected' | 'override';
}

/** The changes a rename's new logical id still shows, as paths. */
function changedPaths(change: ResourceChange | undefined): string[] {
  if (change === undefined) return ['(not in the diff)'];
  const paths = (change.propertyChanges ?? []).map((p) => p.path);
  for (const a of change.attributeChanges ?? []) paths.push(a.attribute);
  return paths.length > 0 ? paths : [`(${change.changeType})`];
}

/**
 * Plan one stack's refactor from its record and template (go-to-k/cdkd#5201).
 *
 * Every proposed rename is applied to an in-memory copy of the record and
 * kept only when the diff over it shows the new logical id unchanged; a
 * look-alike group the proposal could not split is then split by the same
 * diff, pair by pair. Nothing here writes.
 */
export async function planStackRefactor(input: {
  stackName: string;
  region: string;
  state: StackState;
  etag: string;
  template: CloudFormationTemplate;
  overrides: ReadonlyArray<{ from: string; to: string }>;
  diff: RefactorDiffFn;
  recovery?: LockRecoveryContext;
}): Promise<StackRefactorPlan> {
  const { stackName, region, state, etag, template, overrides, diff, recovery } = input;
  // The plan reads the rollback-orphan records and the rename rewrites them,
  // so a container or row no reader can use is refused, never carried.
  refuseMalformedOrphans(state, stackName, region, recovery);
  refuseMalformedOrphanRecords(state, stackName, region, recovery);

  const base = await diff(state);
  if (base.blocking.length > 0) {
    throw new CdkdError(
      safeMsg`cdkd refactor refused stack ${stackName} (${region}): ` +
        `'cdkd diff' reports a condition 'cdkd deploy' refuses to start on. ` +
        `Resolve what 'cdkd diff ${stackName}' reports, then re-run cdkd refactor.`,
      'REFACTOR_REFUSED'
    );
  }

  // A rollback-orphan record (`orphans`) is re-adopted by the next deploy
  // under its own logical id, so its CREATE row is not a free destination.
  const orphanIds = new Set(
    (Array.isArray(state.orphans) ? state.orphans : [])
      .map((o) => (o !== null && typeof o === 'object' ? o.logicalId : undefined))
      .filter((id): id is string => typeof id === 'string')
  );
  const creates: RefactorCreateSide[] = [];
  const deletes: RefactorDeleteSide[] = [];
  for (const change of base.changes.values()) {
    if (change.changeType === 'CREATE' && !orphanIds.has(change.logicalId)) {
      creates.push({
        logicalId: change.logicalId,
        resourceType: change.resourceType,
        properties: change.desiredProperties ?? {},
      });
    } else if (change.changeType === 'DELETE') {
      const record = state.resources[change.logicalId];
      deletes.push({
        logicalId: change.logicalId,
        resourceType: change.resourceType,
        properties:
          record !== undefined &&
          record.properties !== null &&
          typeof record.properties === 'object'
            ? record.properties
            : {},
      });
    }
  }

  const proposal = proposeRenames(creates, deletes, overrides);
  const refusedOverrides = [...proposal.refusedOverrides];
  const differing: DifferingRename[] = [];
  const skipped: SkippedRename[] = [];
  const candidates = proposal.renames.filter((r) => {
    if (!orphanIds.has(r.from)) return true;
    const reason = `a rollback-orphan record also names ${r.from}; run 'cdkd deploy' first to settle it`;
    if (r.source === 'override') refusedOverrides.push({ from: r.from, to: r.to, reason });
    else skipped.push({ rename: r, reason });
    return false;
  });

  // Keep only the renames the diff over the renamed record shows unchanged,
  // re-diffing after each drop: a dropped rename can be what a kept one's
  // reference resolved through. With `checkReferences`, also drop one whose
  // new side references a resource the diff still changes (go-to-k/cdkd#6097):
  // as in `cdk refactor`, that is a new resource (a Lambda version after a code
  // change), not a renamed one. Only once every pair is settled, since a
  // look-alike the loop below has yet to split still reads as a CREATE.
  const confirm = async (
    proposed: readonly ProposedRename[],
    checkReferences = false
  ): Promise<{ kept: ProposedRename[]; changes: Map<string, ResourceChange> | undefined }> => {
    let kept = [...proposed];
    while (kept.length > 0) {
      const renamed = applyLogicalIdRenames(state, toLogicalIdRenames(kept), template);
      const { changes } = await diff(renamed);
      const refOf = new Map<ProposedRename, string>();
      const failed = kept.filter((r) => {
        if (changes.get(r.to)?.changeType !== 'NO_CHANGE') return true;
        const ref = checkReferences ? changedReferenceInDiff(template, r.to, changes) : undefined;
        if (ref !== undefined) refOf.set(r, ref);
        return ref !== undefined;
      });
      if (failed.length === 0) return { kept, changes };
      for (const rename of failed) {
        const ref = refOf.get(rename);
        const paths =
          ref === undefined ? changedPaths(changes.get(rename.to)) : [changedReferencePath(ref)];
        if (rename.source === 'override') {
          refusedOverrides.push({
            from: rename.from,
            to: rename.to,
            reason:
              ref === undefined ? propertiesChangedReason(paths) : changedReferenceReason(ref),
          });
        } else {
          differing.push({ rename, paths });
        }
      }
      kept = kept.filter((r) => !failed.includes(r));
    }
    return { kept, changes: undefined };
  };

  let { kept: renames, changes: confirmed } = await confirm(candidates);

  // Split a look-alike group with the diff itself: try each new logical id
  // against each old one, on top of the renames already kept, and pair the
  // ones that match exactly one way. Two resources that differ only in what
  // they reference look alike to the proposal (an unresolved reference
  // matches anything) and are told apart here. Bounded, so a large group
  // costs at most MAX_TRIAL_DIFFS diffs; what the budget does not reach
  // stays ambiguous, which writes nothing.
  let ambiguous = proposal.ambiguous;
  let budget = MAX_TRIAL_DIFFS;
  for (;;) {
    const takenFrom = new Set(renames.map((r) => r.from));
    const takenTo = new Set(renames.map((r) => r.to));
    const accepted: ProposedRename[] = [];
    const remaining: AmbiguousGroup[] = [];
    for (const group of ambiguous) {
      const froms = group.from.filter((id) => !takenFrom.has(id));
      const tos = group.to.filter((id) => !takenTo.has(id));
      if (froms.length === 0 || tos.length === 0) continue;
      if (froms.length * tos.length > budget) {
        remaining.push({ resourceType: group.resourceType, from: froms, to: tos });
        continue;
      }
      const passing = new Map<string, string[]>();
      for (const to of tos) {
        const matches: string[] = [];
        for (const from of froms) {
          budget -= 1;
          const trial = applyLogicalIdRenames(
            state,
            [...toLogicalIdRenames(renames), { from, to }],
            template
          );
          const { changes } = await diff(trial);
          if (changes.get(to)?.changeType === 'NO_CHANGE') matches.push(from);
        }
        passing.set(to, matches);
      }
      const claims = new Map<string, number>();
      for (const matches of passing.values()) {
        for (const from of matches) claims.set(from, (claims.get(from) ?? 0) + 1);
      }
      const leftFrom = new Set<string>();
      const leftTo: string[] = [];
      for (const [to, matches] of passing) {
        if (matches.length === 0) continue;
        if (matches.length === 1 && claims.get(matches[0]!) === 1) {
          accepted.push({
            from: matches[0]!,
            to,
            resourceType: group.resourceType,
            source: 'detected',
          });
          continue;
        }
        leftTo.push(to);
        for (const from of matches) leftFrom.add(from);
      }
      if (leftTo.length > 0) {
        remaining.push({
          resourceType: group.resourceType,
          from: [...leftFrom].sort(),
          to: leftTo.sort(),
        });
      }
    }
    ambiguous = remaining;
    if (accepted.length === 0) break;
    ({ kept: renames, changes: confirmed } = await confirm([...renames, ...accepted]));
  }
  const settled = confirmed;
  if (settled && renames.some((r) => changedReferenceInDiff(template, r.to, settled))) {
    ({ kept: renames, changes: confirmed } = await confirm(renames, true));
  }

  // A resource that references a renamed one and still changes after the
  // renames points at a pair that may be wrong: a mapping file can name two
  // look-alikes the wrong way round, and each still shows no change itself.
  const renamedTo = new Set(renames.map((r) => r.to));
  const stillChanging =
    confirmed === undefined
      ? []
      : [...confirmed.values()]
          .filter(
            (change) =>
              (change.changeType === 'UPDATE' || change.changeType === 'CREATE') &&
              !renamedTo.has(change.logicalId) &&
              [...referencedLogicalIds(template, change.logicalId)].some((id) => renamedTo.has(id))
          )
          .map((change) => change.logicalId)
          .sort();

  const takenTo = new Set([
    ...renames.map((r) => r.to),
    ...skipped.map((x) => x.rename.to),
    ...ambiguous.flatMap((g) => g.to),
    ...overrides.map((o) => o.to),
  ]);
  const takenFrom = new Set([
    ...renames.map((r) => r.from),
    ...skipped.map((x) => x.rename.from),
    ...ambiguous.flatMap((g) => g.from),
    ...overrides.map((o) => o.from),
    ...orphanIds,
  ]);

  return {
    stackName,
    region,
    etag,
    renames,
    differing,
    skipped,
    ambiguous,
    refusedOverrides,
    stillChanging,
    template,
    unpaired: {
      creates: creates.filter((c) => !takenTo.has(c.logicalId)),
      deletes: deletes.filter((d) => !takenFrom.has(d.logicalId)),
    },
    movesOut: [],
    movesIn: [],
    state,
    diff,
  };
}

/** The most trial diffs one stack's look-alike groups may cost. */
const MAX_TRIAL_DIFFS = 64;

export function toLogicalIdRenames(renames: readonly ProposedRename[]): LogicalIdRename[] {
  return renames.map(({ from, to }) => ({ from, to }));
}
