import type { ResourceChange, ResourceState } from '../../types/state.js';
import {
  planSubscriptionAttributes,
  recordedSubscriptionAttributes,
} from '../../provisioning/providers/sns-subscription/attribute-plan.js';

/**
 * go-to-k/cdkd#6509: why the resource's provider carries out this UPDATE by
 * re-creating the resource inside its own `update()`, or `undefined`. Read by
 * `cdkd diff`, its `--fail-on destructive` and the deploy's
 * `--require-approval destructive` through `ResourceChange.providerReplacement`.
 *
 * Display only: it never sets `requiresReplacement`, because the ENGINE must
 * not replace these. An SNS subscription is replaced delete-first by its
 * provider: the engine's create-first order would subscribe the same endpoint
 * to the same topic again, which SNS refuses while the old subscription
 * exists.
 *
 * `desired` is the RESOLVED template bag, what `update()` is handed (an
 * `Fn::If` to `AWS::NoValue` is an absent key there). The deploy plans
 * against the attributes AWS holds; this predicts from the state record, as
 * every other diff verdict does. A record of another type, or one on Cloud
 * Control (whose update is not the SDK provider's), answers `undefined`.
 */
export function providerReplacementReason(
  resourceType: string,
  record: ResourceState,
  desired: Readonly<Record<string, unknown>>
): string | undefined {
  if (resourceType !== 'AWS::SNS::Subscription') return undefined;
  if (record.resourceType !== resourceType || record.provisionedBy === 'cc-api') return undefined;
  const plan = planSubscriptionAttributes(
    recordedSubscriptionAttributes(record.properties ?? {}),
    desired
  );
  return plan.kind === 'replace' ? plan.reason : undefined;
}

/**
 * Drop the mark from a change the engine replaces anyway (a create-only
 * property, a promoted replacement): it is a replacement already, and the
 * provider's `update()` never runs for it. Run after the replacement passes.
 */
export function dropSupersededProviderReplacements(changes: Map<string, ResourceChange>): void {
  for (const change of changes.values()) {
    if (change.providerReplacement === undefined) continue;
    if ((change.propertyChanges ?? []).some((pc) => pc.requiresReplacement)) {
      delete change.providerReplacement;
    }
  }
}
