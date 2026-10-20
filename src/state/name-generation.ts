/**
 * Per-resource name generations (state schema v13, go-to-k/cdkd#5064 phase 2).
 *
 * On a stack with a `stackInstanceId`, cdkd generates
 * `{stackName}-{logicalId}-{suffix}` for a resource its template does not
 * name, the suffix hashing the id, the logical id and the resource's name
 * GENERATION (`stackInstanceNameSuffix`). A first create takes generation 0.
 * A replacement creates the new resource at the next generation -- a new
 * name, so it is created before the old one is deleted, as CloudFormation
 * does -- and a logical id re-added after its record left the stack takes the
 * generation after the one it retired at. Each is a pure function of the state
 * record, so a re-run after a crash derives the same name again and meets (or
 * adopts, through the generated-name guard's ledger) its own resource.
 *
 * Legacy stacks (no id) never read or write any of this.
 */
import type { ResourceState, StackOrphanRecord, StackState } from '../types/state.js';
import { displayIdent } from '../utils/display-safe.js';
import {
  isNameGeneration,
  stackInstanceNameSuffix,
  type StackScope,
} from '../provisioning/resource-name.js';

/**
 * A recorded name generation that is not a non-negative integer, or one so
 * large that the generation after it is not a safe integer.
 */
export class MalformedNameGenerationError extends Error {
  constructor(where: string, reason: 'malformed' | 'exhausted' = 'malformed') {
    // A state-chosen key: rendered display-safe.
    super(
      `The state record holds a name generation for ${displayIdent(where)} that is ` +
        (reason === 'exhausted'
          ? 'too large to derive the next one from (the next is not a safe integer). '
          : 'not a non-negative integer. ') +
        'cdkd does not guess which name the resource was given, since the next ' +
        "replacement's name derives from it; restore the field from an earlier version of " +
        'state.json.'
    );
    this.name = 'MalformedNameGenerationError';
  }
}

/**
 * The generation after `generation`. Throws when that is not a non-negative
 * safe integer, so no unsafe value is derived from, bound or written.
 */
function generationAfter(generation: number, logicalId: string): number {
  const next = generation + 1;
  if (!isNameGeneration(next)) throw new MalformedNameGenerationError(logicalId, 'exhausted');
  return next;
}

/**
 * A record's name generation: absent = 0. A PRESENT value that is not a
 * non-negative integer throws: read as 0, a replacement would ask for the
 * name the first generation held.
 */
export function nameGenerationOf(
  record: Pick<ResourceState, 'nameGeneration'>,
  logicalId: string
): number {
  const value = record.nameGeneration;
  if (value === undefined) return 0;
  if (!isNameGeneration(value)) throw new MalformedNameGenerationError(logicalId);
  return value;
}

/** The highest generation a record's resource ever reached (`max(nameGeneration, nameGenerationHigh)`). */
export function nameGenerationHighWaterOf(
  record: Pick<ResourceState, 'nameGeneration' | 'nameGenerationHigh'>,
  logicalId: string
): number {
  const generation = nameGenerationOf(record, logicalId);
  const high = record.nameGenerationHigh;
  if (high === undefined) return generation;
  if (!isNameGeneration(high)) throw new MalformedNameGenerationError(logicalId);
  return Math.max(generation, high);
}

/**
 * A stack's retired generations, validated: absent = none. A malformed
 * container or entry throws, for the reason {@link nameGenerationOf} does.
 */
export function retiredNameGenerationsOf(
  state: Pick<StackState, 'retiredNameGenerations'>
): ReadonlyMap<string, number> {
  const raw = state.retiredNameGenerations;
  const out = new Map<string, number>();
  if (raw === undefined) return out;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MalformedNameGenerationError('retiredNameGenerations');
  }
  for (const [logicalId, value] of Object.entries(raw)) {
    if (!isNameGeneration(value)) throw new MalformedNameGenerationError(logicalId);
    out.set(logicalId, value);
  }
  return out;
}

/**
 * The generation each logical id's generated name is derived at, from a
 * stack's record: a resource's own generation, a re-added id's retired
 * generation + 1, nothing (= 0) for an id never seen. The value a
 * `StackScope` with a stack instance id carries as `nameGenerations`
 * ({@link nameScopeOf}).
 */
export function nameGenerationsOf(
  state: Pick<StackState, 'resources' | 'retiredNameGenerations'>
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const [logicalId, retired] of retiredNameGenerationsOf(state)) {
    out.set(logicalId, generationAfter(retired, logicalId));
  }
  for (const [logicalId, record] of Object.entries(state.resources ?? {})) {
    if (record === null || typeof record !== 'object') continue;
    out.set(logicalId, nameGenerationOf(record, logicalId));
  }
  return out;
}

/**
 * The generation a replacement of `logicalId` creates its new resource at:
 * one past the highest the record ever reached, skipping any generation whose
 * suffix the record's own physical id already carries (a resource `cdkd
 * import` adopted under a later generation's name records none). A pure
 * function of the record, so a re-run after a crash derives it again.
 */
export function nextNameGeneration(
  record: Pick<ResourceState, 'nameGeneration' | 'nameGenerationHigh' | 'physicalId'>,
  logicalId: string,
  stackInstanceId: string
): number {
  let next = generationAfter(nameGenerationHighWaterOf(record, logicalId), logicalId);
  const physicalId = typeof record.physicalId === 'string' ? record.physicalId.toLowerCase() : '';
  while (physicalId.includes(stackInstanceNameSuffix(stackInstanceId, logicalId, next))) {
    next = generationAfter(next, logicalId);
  }
  return next;
}

/**
 * What a replacement of `record` creates its new resource at, and the fields
 * the new record carries: the next generation on a stack with an instance id,
 * unless the old resource is already gone with its parent (`keepsName`, a
 * re-create under the same name), which carries the record's own fields. A
 * legacy stack (no id) moves nothing.
 */
export function replacementNameGeneration(
  record: ResourceState,
  logicalId: string,
  stackInstanceId: string | undefined,
  keepsName: boolean
): {
  generation: number | undefined;
  fields: Pick<ResourceState, 'nameGeneration' | 'nameGenerationHigh'>;
} {
  if (stackInstanceId === undefined || keepsName) {
    return { generation: undefined, fields: nameGenerationCarriedFrom(record) };
  }
  const generation = nextNameGeneration(record, logicalId, stackInstanceId);
  return { generation, fields: nameGenerationField(generation) };
}

/**
 * The name-generation fields of a record WRITTEN at `generation`: none for 0,
 * the value otherwise. Spread into a record a create or replacement builds.
 */
export function nameGenerationField(generation: number): Pick<ResourceState, 'nameGeneration'> {
  return generation === 0 ? {} : { nameGeneration: generation };
}

/**
 * Carry a record's name-generation fields across a field-by-field rebuild of
 * the SAME resource (an in-place update, a re-import of the same physical id,
 * a drift or refresh writer): absent stays absent, present stays verbatim.
 * Every writer that enumerates `ResourceState` fields spreads this
 * (`tests/unit/state/stack-instance-id-carriers.test.ts`).
 */
export function nameGenerationCarriedFrom(
  previous: Pick<ResourceState, 'nameGeneration' | 'nameGenerationHigh'> | null | undefined
): Pick<ResourceState, 'nameGeneration' | 'nameGenerationHigh'> {
  return {
    ...(previous?.nameGeneration !== undefined && { nameGeneration: previous.nameGeneration }),
    ...(previous?.nameGenerationHigh !== undefined && {
      nameGenerationHigh: previous.nameGenerationHigh,
    }),
  };
}

/**
 * `record` restored by a rollback after a replacement created generation
 * `reached`: the high-water mark is raised to it, so the next replacement goes
 * past the name the rolled-back copy held. `reached` undefined (a legacy
 * stack, or a journal an older binary wrote) or not above the record's own
 * high-water mark returns `record` unchanged.
 */
export function withNameGenerationReached<T extends ResourceState>(
  record: T,
  logicalId: string,
  reached: number | undefined
): T {
  if (reached === undefined || !isNameGeneration(reached)) return record;
  if (reached <= nameGenerationHighWaterOf(record, logicalId)) return record;
  return { ...record, nameGenerationHigh: reached };
}

/**
 * The `retiredNameGenerations` field after `leaving` records left a stack with
 * a `stackInstanceId`: each logical id at the highest generation either side
 * knows. `{}` for a legacy stack or when nothing left, so a record that never
 * retired anything stays byte-identical.
 */
export function retiredNameGenerationsAfter(
  state: Pick<StackState, 'stackInstanceId' | 'retiredNameGenerations'>,
  leaving: Iterable<{
    logicalId: string;
    record: Pick<ResourceState, 'nameGeneration' | 'nameGenerationHigh'>;
  }>
): Pick<StackState, 'retiredNameGenerations'> {
  if (state.stackInstanceId === undefined) return {};
  const retired = new Map(retiredNameGenerationsOf(state));
  let changed = false;
  for (const { logicalId, record } of leaving) {
    const reached = nameGenerationHighWaterOf(record, logicalId);
    const before = retired.get(logicalId);
    if (before !== undefined && before >= reached) continue;
    retired.set(logicalId, reached);
    changed = true;
  }
  if (!changed) {
    return state.retiredNameGenerations === undefined
      ? {}
      : { retiredNameGenerations: state.retiredNameGenerations };
  }
  return { retiredNameGenerations: Object.fromEntries(retired) };
}

/**
 * The naming scope of `state`'s stack: its name, its lifetime's id (`undefined`
 * for a legacy record) and, beside an id, its name generations. For a command
 * that derives names against a record it read (drift, refresh, rollback).
 */
export function nameScopeOf(
  stackName: string,
  stackInstanceId: string | undefined,
  state: Pick<StackState, 'resources' | 'retiredNameGenerations'> | null | undefined
): StackScope {
  return {
    stackName,
    stackInstanceId,
    nameGenerations:
      stackInstanceId === undefined ? undefined : nameGenerationsOf(state ?? { resources: {} }),
  };
}

/**
 * A CREATE a rollback took back (deleted, or left in AWS with its record
 * dropped): the record it removed, `undefined` for a create that never saved
 * one, and the generation the journaled op names (a failed CREATE's).
 */
export interface RolledBackCreate {
  logicalId: string;
  record: Pick<ResourceState, 'nameGeneration' | 'nameGenerationHigh'> | undefined;
  nameGeneration?: unknown;
}

/**
 * The highest generation a rolled-back create reached: its record's high-water
 * mark or its op's generation, 0 for neither. A malformed value is skipped,
 * never thrown: a rollback that already took the resource back must still
 * save.
 */
function rolledBackCreateReached(create: RolledBackCreate): number {
  let reached = 0;
  for (const value of [
    create.record?.nameGeneration,
    create.record?.nameGenerationHigh,
    create.nameGeneration,
  ]) {
    if (isNameGeneration(value)) reached = Math.max(reached, value);
  }
  return reached;
}

/**
 * The `retiredNameGenerations` field after a rollback. Each logical id
 * retires at the generation it reached when the rollback:
 *
 * - left `orphaned` records in AWS (`DeletionPolicy: Retain`): nothing takes
 *   such a resource back implicitly (only `cdkd import` does), so a later
 *   create asks for a new name and leaves the orphan alone;
 * - took back a CREATE (`rolledBackCreates`): as CloudFormation names a
 *   re-create anew, the next create of the logical id asks for the next
 *   generation's name, never the one a just-deleted resource held (an SQS
 *   queue or a Secrets Manager secret refuses that name for a while).
 *
 * `{}` on a legacy stack. Spread AFTER `stackInstanceIdCarriedFrom`, which
 * carries the field it extends.
 */
export function retiredAfterRollback(
  state: Pick<StackState, 'stackInstanceId' | 'retiredNameGenerations'>,
  orphaned: readonly StackOrphanRecord[],
  rolledBackCreates: readonly RolledBackCreate[] = []
): Pick<StackState, 'retiredNameGenerations'> {
  return retiredNameGenerationsAfter(state, [
    ...orphaned.map((o) => ({ logicalId: o.logicalId, record: o.state })),
    ...rolledBackCreates.map((c) => ({
      logicalId: c.logicalId,
      record: { nameGenerationHigh: rolledBackCreateReached(c) },
    })),
  ]);
}

/**
 * A record that REPLACES `previous` under another physical id outside a
 * replacement (`cdkd import` adopting another resource): no generation of its
 * own, the highest one `previous` reached as its high-water mark. `{}` when
 * that is 0.
 */
export function nameGenerationReachedField(
  previous: Pick<ResourceState, 'nameGeneration' | 'nameGenerationHigh'>,
  logicalId: string
): Pick<ResourceState, 'nameGenerationHigh'> {
  const reached = nameGenerationHighWaterOf(previous, logicalId);
  return reached === 0 ? {} : { nameGenerationHigh: reached };
}

/**
 * The `retiredNameGenerations` field of a record a partial destroy keeps: every
 * record of `state` missing from `remaining` left the stack. A malformed
 * generation never stops a destroy: the field is then carried as it was.
 */
export function retiredNameGenerationsLeaving(
  state: Pick<StackState, 'stackInstanceId' | 'retiredNameGenerations' | 'resources'>,
  remaining: Readonly<Record<string, unknown>>
): Pick<StackState, 'retiredNameGenerations'> {
  try {
    return retiredNameGenerationsAfter(
      state,
      Object.entries(state.resources ?? {})
        .filter(
          ([logicalId, record]) =>
            !Object.hasOwn(remaining, logicalId) && record !== null && typeof record === 'object'
        )
        .map(([logicalId, record]) => ({ logicalId, record }))
    );
  } catch {
    return state.retiredNameGenerations === undefined
      ? {}
      : { retiredNameGenerations: state.retiredNameGenerations };
  }
}
