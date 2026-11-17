import type { ResourceChange, ResourceState } from '../../types/state.js';
import {
  planSubscriptionAttributes,
  recordedSubscriptionAttributes,
} from '../../provisioning/providers/sns-subscription/attribute-plan.js';

/**
 * go-to-k/cdkd#6509: mark an UPDATE that the resource's provider carries out by
 * re-creating the resource inside its own `update()`, so `cdkd diff`, its
 * `--fail-on destructive` and the deploy's `--require-approval destructive`
 * report the replacement the deploy makes.
 *
 * Display only: it sets `providerReplacement`, never `requiresReplacement`,
 * because the ENGINE must not replace these. An SNS subscription is replaced
 * delete-first by its provider: the engine's create-first order would subscribe
 * the same endpoint to the same topic again, which SNS refuses while the old
 * subscription exists.
 *
 * The deploy plans against the attributes AWS holds; this predicts from the
 * state record, as every other diff verdict does. A resource the engine
 * replaces anyway, or one recorded on Cloud Control (whose update is not the
 * SDK provider's), is left alone. Idempotent.
 */
export function markProviderReplacements(
  changes: Map<string, ResourceChange>,
  records: Readonly<Record<string, ResourceState>>
): void {
  for (const [logicalId, change] of changes) {
    if (change.changeType !== 'UPDATE') continue;
    if (change.resourceType !== 'AWS::SNS::Subscription') continue;
    const record = Object.hasOwn(records, logicalId) ? records[logicalId] : undefined;
    if (record === undefined || record.resourceType !== change.resourceType) continue;
    if (record.provisionedBy === 'cc-api') continue;
    if ((change.propertyChanges ?? []).some((pc) => pc.requiresReplacement)) continue;
    const recorded: Record<string, unknown> = { ...(change.currentProperties ?? {}) };
    // A template that dropped its `FilterPolicy` leaves the live scope in
    // place (the provider does not reset a scope with no policy), so the
    // record no longer names it: read it from the AWS snapshot instead.
    const observed = record.observedProperties;
    const observedScope =
      typeof observed === 'object' && observed !== null ? observed['FilterPolicyScope'] : undefined;
    if (recorded['FilterPolicyScope'] === undefined && typeof observedScope === 'string') {
      recorded['FilterPolicyScope'] = observedScope;
    }
    const plan = planSubscriptionAttributes(
      recordedSubscriptionAttributes(recorded),
      change.desiredProperties ?? {}
    );
    if (plan.kind === 'replace') change.providerReplacement = plan.reason;
    else delete change.providerReplacement;
  }
}
