import {
  IMPLICIT_DELETE_DEPENDENCIES,
  computeImplicitDeleteEdges,
} from '../../analyzer/implicit-delete-deps.js';
import type { Logger } from '../../types/config.js';
import type { ResourceState, StackState } from '../../types/state.js';
import { DagExecutor } from '../dag-executor.js';
import { safeMsg } from '../../utils/display-safe.js';

/**
 * Build a per-resource map of "must be deleted before me" dependencies for
 * the DELETE phase, derived from state-recorded dependencies plus implicit
 * type-based ordering rules.
 *
 * For a resource X, the returned set contains every resource Y such that Y
 * must finish deleting before X starts — i.e., Y depends on X (or is otherwise
 * required to vanish first per implicit type rules).
 */
/**
 * Returns true if the executor still has un-started pending nodes —
 * used to distinguish "SIGINT cancelled real work" from "SIGINT landed
 * after all nodes already completed" (the latter should not error).
 */
export function hasPending<T>(executor: DagExecutor<T>): boolean {
  for (const node of executor.values()) {
    if (node.state === 'pending') return true;
  }
  return false;
}

/**
 * go-to-k/cdkd#6244: for each of `ids`, the NEAREST dependencies that are
 * members of the phase being executed, walking THROUGH every non-member
 * (a `NO_CHANGE` row) instead of dropping it. An unchanged resource is
 * already satisfied only for itself: when it reads a changed resource and a
 * changed resource reads it (`MyRes` → a `cr.Provider` framework function →
 * the `onEvent` function), the reader must still wait for the changed one
 * behind it, as CloudFormation orders them.
 *
 * Memoized per non-member node, so a large template walks each unchanged node
 * once; a cycle guard keeps a malformed graph from recursing forever (the
 * executor reports the deadlock itself).
 */
export function nearestMemberDependencies(
  ids: Iterable<string>,
  dependenciesOf: (id: string) => readonly string[],
  isMember: (id: string) => boolean
): Map<string, Set<string>> {
  const through = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const collect = (deps: readonly string[], into: Set<string>): void => {
    for (const dep of deps) {
      if (isMember(dep)) {
        into.add(dep);
        continue;
      }
      for (const reached of membersBehind(dep)) into.add(reached);
    }
  };
  const membersBehind = (id: string): Set<string> => {
    const cached = through.get(id);
    if (cached) return cached;
    const reached = new Set<string>();
    if (visiting.has(id)) return reached;
    visiting.add(id);
    collect(dependenciesOf(id), reached);
    visiting.delete(id);
    through.set(id, reached);
    return reached;
  };
  const result = new Map<string, Set<string>>();
  for (const id of ids) {
    const reached = new Set<string>();
    collect(dependenciesOf(id), reached);
    reached.delete(id);
    result.set(id, reached);
  }
  return result;
}

export function buildDeletionDependencies(
  deleteIds: Set<string>,
  state: StackState,
  logger: Pick<Logger, 'debug'>
): Map<string, Set<string>> {
  const dependedBy = new Map<string, Set<string>>();
  for (const id of deleteIds) {
    dependedBy.set(id, new Set());
  }

  for (const id of deleteIds) {
    const resource = state.resources[id];
    if (!resource?.dependencies) continue;
    for (const dep of resource.dependencies) {
      if (!deleteIds.has(dep)) continue;
      // id depends on dep → dep must be deleted AFTER id (i.e., id is in dep's deletion deps)
      dependedBy.get(dep)!.add(id);
    }
  }

  addImplicitDeleteDependencies(deleteIds, state, dependedBy, logger);

  return dependedBy;
}

/**
 * Add implicit delete dependency edges based on resource type relationships.
 *
 * Some AWS resources have ordering constraints during deletion that are NOT
 * expressed via Ref/GetAtt in CloudFormation templates. For example, an
 * InternetGateway cannot be deleted until its VPCGatewayAttachment is removed,
 * even though the attachment references the IGW (not the other way around).
 *
 * This method inspects resource types and adds edges so that dependents
 * (e.g., VPCGatewayAttachment) are deleted BEFORE the resources they implicitly
 * depend on (e.g., InternetGateway).
 */
export function addImplicitDeleteDependencies(
  deleteIds: Set<string>,
  state: StackState,
  dependedBy: Map<string, Set<string>>,
  logger: Pick<Logger, 'debug'>
): void {
  // Build a type → logical IDs index for resources being deleted
  const typeToIds = new Map<string, string[]>();
  for (const id of deleteIds) {
    const resource = state.resources[id];
    if (!resource) continue;
    const ids = typeToIds.get(resource.resourceType) ?? [];
    ids.push(id);
    typeToIds.set(resource.resourceType, ids);
  }

  for (const id of deleteIds) {
    const resource = state.resources[id];
    if (!resource) continue;

    const mustDeleteAfter = IMPLICIT_DELETE_DEPENDENCIES[resource.resourceType];
    if (!mustDeleteAfter) continue;

    for (const depType of mustDeleteAfter) {
      const depIds = typeToIds.get(depType);
      if (!depIds) continue;

      for (const depId of depIds) {
        // depId (of depType) must be deleted BEFORE id (of resource.resourceType)
        // In the dependedBy map: id is "depended on" by depId
        // meaning depId will be picked first (deleted first)
        if (!dependedBy.has(id)) dependedBy.set(id, new Set());
        if (!dependedBy.get(id)!.has(depId)) {
          dependedBy.get(id)!.add(depId);
          logger.debug(
            safeMsg`Implicit delete dependency: ${depId} (${depType}) must be deleted before ${id} (${resource.resourceType})`
          );
        }
      }
    }
  }

  // Per-resource implicit delete edges that cannot be inferred from a
  // type-pair rule (e.g. CompositeAlarm -> the metric alarms its AlarmRule
  // references by name, which carry no Ref / Fn::GetAtt edge).
  const scoped: Record<string, ResourceState> = {};
  for (const id of deleteIds) {
    const resource = state.resources[id];
    if (resource) scoped[id] = resource;
  }
  for (const { before, after } of computeImplicitDeleteEdges(scoped)) {
    // `before` must be deleted before `after`, so `before` is in `after`'s
    // deletion deps (picked / deleted first).
    if (!dependedBy.has(after)) dependedBy.set(after, new Set());
    if (!dependedBy.get(after)!.has(before)) {
      dependedBy.get(after)!.add(before);
      logger.debug(
        safeMsg`Implicit delete dependency: ${before} (${scoped[before]?.resourceType}) must be deleted before ${after} (${scoped[after]?.resourceType})`
      );
    }
  }
}
