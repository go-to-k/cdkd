import { type DeployEngine } from '../../deploy-engine.js';
import type { ResourceState } from '../../../types/state.js';
import { safeMsg } from '../../../utils/display-safe.js';

/**
 * The `UpdateContext.markUnsettled` / `markAttempted` sinks of an in-place
 * update (go-to-k/cdkd#5380, #5498), split out of `update-in-place.ts`.
 */
export function unsettledMarkSinks(
  engine: DeployEngine,
  logicalId: string,
  resolvedProps: Record<string, unknown>,
  currentResource: ResourceState
): {
  markUnsettled: (propertyName: string) => void;
  markAttempted: (path: string, items: readonly string[]) => void;
} {
  return {
    // go-to-k/cdkd#5380: the sink lives on the engine, so a mark
    // outlives this call's promise (deadline race, Ctrl-C, retry).
    markUnsettled: (propertyName: string) => {
      if (typeof propertyName !== 'string' || propertyName === '') return;
      // Only a top-level key this update sends or the record holds:
      // anything else names no property this resource has, and the
      // record must not carry it into every later deploy's diff. (A
      // name the record already carries unsettled stays by the union
      // at the failure save.)
      if (
        !Object.hasOwn(resolvedProps, propertyName) &&
        !Object.hasOwn(currentResource.properties ?? {}, propertyName)
      ) {
        engine.logger.debug(
          safeMsg`${logicalId}: ignored an unsettled mark for ${propertyName}, which is not one of its properties`
        );
        return;
      }
      let marks = engine.unsettledMarks.get(logicalId);
      if (marks === undefined) {
        marks = new Set();
        engine.unsettledMarks.set(logicalId, marks);
      }
      marks.add(propertyName);
    },
    // go-to-k/cdkd#5498: the items a resolved call added, per path.
    markAttempted: (path: string, items: readonly string[]) => {
      if (typeof path !== 'string' || path === '') return;
      let byPath = engine.unsettledItemMarks.get(logicalId);
      if (byPath === undefined) {
        byPath = new Map();
        engine.unsettledItemMarks.set(logicalId, byPath);
      }
      const names = byPath.get(path) ?? new Set<string>();
      for (const item of items) if (typeof item === 'string' && item !== '') names.add(item);
      byPath.set(path, names);
    },
  };
}
