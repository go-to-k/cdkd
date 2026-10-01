import type { DeployEngine } from '../deploy-engine.js';
import {
  IMPLICIT_DELETE_DEPENDENCIES,
  computeImplicitDeleteEdges,
} from '../../analyzer/implicit-delete-deps.js';
import type { ResourceState, StackState } from '../../types/state.js';
import { DagExecutor } from '../dag-executor.js';

declare module '../deploy-engine.js' {
  interface DeployEngine {
    /** @internal */
    hasPending: OmitThisParameter<typeof hasPending>;
    /** @internal */
    buildDeletionDependencies: OmitThisParameter<typeof buildDeletionDependencies>;
    /** @internal */
    addImplicitDeleteDependencies: OmitThisParameter<typeof addImplicitDeleteDependencies>;
  }
}

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
/** @internal */
export function hasPending<T>(this: DeployEngine, executor: DagExecutor<T>): boolean {
  for (const node of executor.values()) {
    if (node.state === 'pending') return true;
  }
  return false;
}

/** @internal */
export function buildDeletionDependencies(
  this: DeployEngine,
  deleteIds: Set<string>,
  state: StackState
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

  this.addImplicitDeleteDependencies(deleteIds, state, dependedBy);

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
  this: DeployEngine,
  deleteIds: Set<string>,
  state: StackState,
  dependedBy: Map<string, Set<string>>
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
          this.logger.debug(
            `Implicit delete dependency: ${depId} (${depType}) must be deleted before ${id} (${resource.resourceType})`
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
      this.logger.debug(
        `Implicit delete dependency: ${before} (${scoped[before]?.resourceType}) must be deleted before ${after} (${scoped[after]?.resourceType})`
      );
    }
  }
}
