import type { CloudFormationTemplate } from '../../../types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../types/state.js';
import { findActionableSdkUnwired } from '../../../provisioning/property-coverage.js';
import { wouldReturnToSdkProvider } from '../../../provisioning/provider-registry.js';
import { NESTED_STACK_RESOURCE_TYPE } from '../retire-cfn-stack.js';
import type { CcRouteUnavailableReason } from './types.js';
import { EMPTY_ALLOW_SET } from './refusals.js';

/**
 * The one spelling of the routing token for a resource leaving Cloud Control
 * (issue #2719). A literal, because `collectCcApiRoutes` writes it and
 * `annotateRouting` special-cases it, and the integ fixture greps for it --
 * three places that must agree on a string.
 */
export const SDK_MIGRATION_TOKEN = 'returning to SDK provider';

/**
 * Does the deploy REPLACE this row? The same test the engine's live label
 * applies before dispatch (`needsReplacement` in `deploy-engine/provision.ts`'s
 * `provisionResource`), less the `--recreate-via-*` half, which `cdkd diff`
 * does not take: an `UPDATE` with a create-only property change, or whose
 * recorded type differs from the template's.
 *
 * A replacement CEILING is left out, as the label leaves it out: a
 * `requiresReplacement` the diff set on a propagated value before it could be
 * read (`replacementPropagated` / `inPlacePropagated`, go-to-k/cdkd#3662)
 * replaces only if the value moves, which only the deploy learns, and until
 * then the resource is updated in place, where the recorded route stands.
 */
function diffReplaces(change: ResourceChange | undefined, record: ResourceState): boolean {
  if (change?.changeType !== 'UPDATE') return false;
  if (record.resourceType !== change.resourceType) return true;
  return (
    change.propertyChanges?.some(
      (pc) =>
        pc.requiresReplacement && pc.inPlacePropagated !== true && pc.replacementPropagated !== true
    ) ?? false
  );
}

/**
 * Walk every resource in `template` and return the logicalId → annotation
 * source map that #614's auto-fallback would route via Cloud Control API.
 *
 * Two annotation sources are merged into one map so the diff renderer
 * matches the live-progress label and the design §8 statement that the
 * `[via CC API: ...]` tag "stays visible whenever the resource has the
 * `provisionedBy: 'cc-api'` state field set OR is being introduced via the
 * auto-route":
 *
 *  - **Fresh hits**: a resource whose template uses one or more
 *    SDK-unwired top-level CFn properties. Annotation value is the list
 *    of property names (e.g. `Body`).
 *  - **Sticky hits**: a resource whose deployed state records
 *    `provisionedBy: 'cc-api'` (from a prior deploy) even when the
 *    current template's SDK-unwired set is empty. Annotation value is
 *    the single token `sticky` so the renderer prints `[via CC API:
 *    sticky]` — the routing decision is unchanged but the tag stays
 *    visible per #614's sticky-state semantics.
 *
 * When both sources fire on the same resource, the fresh-hit prop list
 * wins (more informative). Empty allow-set:
 * `--allow-unsupported-properties` is a deploy-only flag, so diff
 * renders every actionable drop as an auto-route hint.
 *
 * A row the diff REPLACES takes no sticky hit (go-to-k/cdkd#3453): the deploy
 * routes the NEW physical resource with no recorded layer (`replaceDecision`
 * in `deploy-engine.ts`, mirrored by its live label), because stickiness
 * spares an EXISTING resource from churn and a replacement is not that. The
 * old record's layer — on a `Type` change, a record of a different type — says
 * nothing about where the create goes. The fresh-hit arm is unchanged, since
 * the replacement reads the same template bag against the same baseline.
 *
 * A fresh hit on a type with no Cloud Control route gets no annotation at all
 * (go-to-k/cdkd#5600): the flag-less deploy this preview stands for refuses the
 * resource, whatever its record's layer, so it takes no route at all.
 * {@link findUnroutableDropRefusals} warns about it instead.
 *
 * Excludes `AWS::CDK::Metadata` (filtered like the deploy pre-flight); also
 * excludes `AWS::CloudFormation::Stack` rows since nested-stack children
 * recurse through their own templates rather than carrying CC-routable
 * properties on the parent's row.
 */
export function collectCcApiRoutes(
  template: CloudFormationTemplate,
  state: StackState,
  /**
   * The diff computed from this same template and state. REQUIRED, so a
   * caller cannot forget it and put the old record's route back on every
   * replaced row.
   */
  changes: ReadonlyMap<string, ResourceChange>,
  /** REQUIRED for the same reason: without it a refused type wears a route. */
  ccRouteUnavailableReason: CcRouteUnavailableReason
): Map<string, string[]> {
  const hits = new Map<string, string[]>();
  for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
    if (!resource) continue;
    if (resource.Type === 'AWS::CDK::Metadata') continue;
    if (resource.Type === NESTED_STACK_RESOURCE_TYPE) continue;
    // The record's bag is the baseline an unrecognized property is compared
    // against, as `getProviderFor` does on the update path (issue #3713).
    const drops = findActionableSdkUnwired(
      resource.Type,
      resource.Properties,
      EMPTY_ALLOW_SET,
      state.resources[logicalId]?.properties
    );
    if (drops.length > 0) {
      if (ccRouteUnavailableReason(resource.Type) === undefined) {
        hits.set(
          logicalId,
          drops.map((d) => d.property)
        );
      }
      continue;
    }
    // Sticky-CC fallback: no fresh SDK-unwired hit, but the deployed state
    // pins routing to CC API → next op (UPDATE) still goes via CC API per
    // `getProviderFor` rule 2 (sticky). Surface the tag with the
    // distinguishing `sticky` token so the user can tell this case apart
    // from a fresh auto-route.
    const record = state.resources[logicalId];
    if (record?.provisionedBy === 'cc-api' && !diffReplaces(changes.get(logicalId), record)) {
      // ...unless the type is exempt AND this resource's own property bags say
      // the flip is safe, in which case the next op leaves Cloud Control
      // instead of staying on it (issue #2719). Before that check existed this
      // arm read the record alone, so `AWS::Scheduler::Schedule` -- exempt
      // since issue #961 -- was rendered `[via CC API: sticky]` while
      // `getProviderFor` routed it to the SDK provider: the annotation stated
      // the opposite of what the deploy would do.
      // No allow-set is threaded, matching the `findActionableSdkUnwired` call
      // above and for the same structural reason: `cdkd diff` has no
      // `--allow-unsupported-properties` flag, so there is nothing to thread.
      // Inert today (an admitted `'sdk-coverage'` type has an empty sdkUnwired
      // map, so the allow set cannot change the answer) and it would diverge
      // from the deploy only for a future exempt type with a real drop — which
      // the admission bar in docs/provider-rules.md already discourages.
      const leaving = wouldReturnToSdkProvider({
        resourceType: resource.Type,
        // `?? {}` matches the engine's `change.desiredProperties || {}`
        // (deploy-engine.ts). Without it a template resource with NO
        // `Properties` block passes `undefined`, the predicate's
        // no-desired-bag gate returns false, and the annotation prints
        // `sticky` for a resource the deploy will flip -- the exact
        // inverse-of-truth this arm was changed to stop printing, one level
        // above the shared predicate. Reachable by removing the last property
        // from a cc-api-recorded resource.
        desiredProperties: resource.Properties ?? {},
        previousProperties: record.properties,
      });
      hits.set(logicalId, [leaving ? SDK_MIGRATION_TOKEN : 'sticky']);
    }
  }
  return hits;
}
