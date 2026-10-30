/**
 * Which removed resources a `cdkd refactor` would keep (go-to-k/cdkd#5203):
 * the hint `cdkd diff` and `cdkd deploy`'s approval prompt append to a
 * DELETE row, as the AWS CDK CLI appends `(moved to ..., run 'cdk refactor')`.
 *
 * Only the cheap structural pass, on rows a diff already holds: a DELETE
 * pairs with a CREATE of the same type, in any stack of the same environment,
 * whose properties are {@link looselyEqual}, when each is the other's ONLY
 * such candidate. No AWS call. A hint is a suggestion: `cdkd refactor`
 * re-checks every pair with its own diff before writing anything.
 */
import type { ResourceChange } from '../types/state.js';
import type { DestructiveChange } from './destructive-changes.js';
import { displayIdent } from '../utils/display-safe.js';
import {
  isPairableType,
  looselyEqual,
  type RefactorCreateSide,
  type RefactorDeleteSide,
} from './refactor-pairing.js';

/** One stack's unpaired rows, and the environment it deploys to. */
export interface RefactorHintStack {
  /** Keys the result: unique per entry, since one name can deploy to two regions. */
  id: string;
  stackName: string;
  /** Rows pair only within one environment (account and region). */
  env: string;
  creates: readonly RefactorCreateSide[];
  deletes: readonly RefactorDeleteSide[];
}

/** Where a removed resource reappears. */
export interface MovedTo {
  stackName: string;
  logicalId: string;
}

/** stack entry id -> removed logical id -> where it reappears. */
export type RefactorHints = Map<string, Map<string, MovedTo>>;

/** The unambiguous pairs across `stacks`, keyed by the DELETE row's stack entry and id. */
export function findRefactorHints(stacks: readonly RefactorHintStack[]): RefactorHints {
  const hints: RefactorHints = new Map();
  for (const env of new Set(stacks.map((s) => s.env))) {
    const envStacks = stacks.filter((s) => s.env === env);
    const deletes = envStacks.flatMap((s) =>
      s.deletes.filter((d) => isPairableType(d.resourceType)).map((row) => ({ stack: s, row }))
    );
    const creates = envStacks.flatMap((s) =>
      s.creates.filter((c) => isPairableType(c.resourceType)).map((row) => ({ stack: s, row }))
    );
    if (deletes.length === 0 || creates.length === 0) continue;

    const matchesOf = new Map<(typeof creates)[number], Array<(typeof deletes)[number]>>();
    const claims = new Map<(typeof deletes)[number], number>();
    for (const c of creates) {
      const matches = deletes.filter(
        (d) =>
          d.row.resourceType === c.row.resourceType &&
          looselyEqual(c.row.properties, d.row.properties)
      );
      matchesOf.set(c, matches);
      for (const d of matches) claims.set(d, (claims.get(d) ?? 0) + 1);
    }
    for (const c of creates) {
      const matches = matchesOf.get(c) ?? [];
      if (matches.length !== 1 || claims.get(matches[0]!) !== 1) continue;
      const d = matches[0]!;
      let byId = hints.get(d.stack.id);
      if (byId === undefined) {
        byId = new Map();
        hints.set(d.stack.id, byId);
      }
      byId.set(d.row.logicalId, { stackName: c.stack.stackName, logicalId: c.row.logicalId });
    }
  }
  return hints;
}

/** One stack's rows as pairing sides. */
export interface RefactorSides {
  creates: RefactorCreateSide[];
  deletes: RefactorDeleteSide[];
}

/**
 * The logical ids a record's rollback-orphan entries name: the next deploy
 * settles them, so `cdkd refactor` pairs neither side of one (as
 * `planStackRefactor`). Takes the field's value as read, of any shape: an
 * entry that is not an object with a string `logicalId` names nothing.
 */
export function rollbackOrphanIds(orphans: unknown): Set<string> {
  return new Set(
    (Array.isArray(orphans) ? (orphans as unknown[]) : [])
      .map((o) =>
        o !== null && typeof o === 'object' ? (o as { logicalId?: unknown }).logicalId : undefined
      )
      .filter((id): id is string => typeof id === 'string')
  );
}

/**
 * A stack's CREATE and DELETE rows as pairing sides (a DELETE carries the
 * record's properties), leaving out the ids in `exclude`.
 */
export function hintSidesOf(
  changes: Iterable<ResourceChange>,
  exclude: ReadonlySet<string> = new Set()
): RefactorSides {
  const creates: RefactorCreateSide[] = [];
  const deletes: RefactorDeleteSide[] = [];
  for (const change of changes) {
    if (exclude.has(change.logicalId)) continue;
    if (change.changeType === 'CREATE') {
      creates.push({
        logicalId: change.logicalId,
        resourceType: change.resourceType,
        properties: change.desiredProperties ?? {},
      });
    } else if (change.changeType === 'DELETE') {
      deletes.push({
        logicalId: change.logicalId,
        resourceType: change.resourceType,
        properties: change.currentProperties ?? {},
      });
    }
  }
  return { creates, deletes };
}

/** The hint a DELETE row carries, as the AWS CDK CLI words it. */
export function movedToHint(movedTo: MovedTo): string {
  return (
    ` (moved to ${displayIdent(movedTo.stackName)}.${displayIdent(movedTo.logicalId)}, ` +
    "run 'cdkd refactor' to keep it)"
  );
}

/** `changes` with each removal's hint attached; the rest unchanged. */
export function withMovedTo(
  changes: readonly DestructiveChange[],
  hints: ReadonlyMap<string, MovedTo> | undefined
): DestructiveChange[] {
  return changes.map((change) => {
    const movedTo = change.impact === 'WILL_DESTROY' ? hints?.get(change.logicalId) : undefined;
    return movedTo === undefined ? change : { ...change, movedTo };
  });
}
