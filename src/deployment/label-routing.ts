import type { ProviderRegistry } from '../provisioning/provider-registry.js';
import type { ResourceChange, ResourceState } from '../types/state.js';

/**
 * Best-effort routing inference for the live-progress task label
 * (#614 §9). Mirrors the routing decision tree but is purely cosmetic:
 * errors here never surface — when the inference fails we return
 * `undefined` and the label gets no `[CC API]` tag. The real
 * `getProviderFor` call inside the deploy/destroy critical path is the
 * load-bearing dispatch.
 *
 * Inputs:
 * - CREATE / UPDATE → template-side `desiredProperties` (top-level CFn
 *   property names; intrinsic resolution does not change those, so we
 *   can route ahead of the resolver run).
 * - DELETE → sticky `provisionedBy` from the existing-state record.
 *
 * Exported so {@link DeployEngine.peekRoutingForLabel} stays a 1-line
 * delegate and the routing-inference logic is directly unit-testable
 * without standing up a full DeployEngine harness.
 */
/** The only two fields {@link deriveLabelRouting} reads off a state record. */
export type LabelRoutingState = Partial<Pick<ResourceState, 'provisionedBy' | 'properties'>>;

export function deriveLabelRouting(
  change: ResourceChange,
  // Only these two fields are read, and BOTH optional, which is what the
  // function already assumes (`existingState?.provisionedBy`,
  // `existingState?.properties`). Saying so lets `peekRoutingForLabel` pass the
  // recreate hint as a real object instead of an `as ResourceState` cast over
  // four missing required fields -- a cast that also typechecked clean for
  // `{}`, and whose replacement immediately caught that the hint record has no
  // `properties`, which is exactly the mirror `replaceDecision` needs.
  existingState: LabelRoutingState | undefined,
  registry: Pick<ProviderRegistry, 'getProviderFor'>,
  forceCcApi = false
): 'sdk' | 'cc-api' | undefined {
  try {
    if (change.changeType === 'DELETE') {
      return existingState?.provisionedBy;
    }
    const decision = registry.getProviderFor({
      resourceType: change.resourceType,
      // `?? {}` matches the dispatch's `change.desiredProperties || {}`. Safe
      // today only because `DiffCalculator` always populates the field, which
      // is the kind of "safe because of somewhere else" that made the
      // diff-renderer copy of this same normalization a real bug.
      properties: change.desiredProperties ?? {},
      provisionedBy: existingState?.provisionedBy,
      // Issue #2719: the label must be computed from the SAME inputs as the
      // dispatch, or it describes a decision that will not be taken. Both were
      // omitted in the first revision of this change.
      //
      // The live case is `--pin-cc-api`: the dispatch forces Cloud Control and,
      // without `forceCcApi` here, the label computed `sdk` and dropped the
      // `[CC API]` tag from a resource still going through Cloud Control. NOT
      // `--recreate-via-cc-api`, which an earlier revision of this comment
      // cited: that flag is refused at pre-flight on a record already `cc-api`
      // (`blockedAlreadyCcApi`), and on a record that says `'sdk'` the
      // exemption never engages. Note the scope of that claim -- it is about
      // THIS label path. The dispatch's own replacement site DOES feed
      // `forceCcApi` from `recreateViaCcApi`, deliberately and load-bearingly;
      // what does not reach here is `recreateTargets`.
      previousProperties: existingState?.properties,
      forceCcApi,
    });
    return decision.provisionedBy;
  } catch {
    return undefined;
  }
}
