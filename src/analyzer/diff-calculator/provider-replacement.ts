import type { ResourceChange, ResourceState } from '../../types/state.js';
import {
  planSubscriptionAttributes,
  recordedSubscriptionAttributes,
} from '../../provisioning/providers/sns-subscription/attribute-plan.js';
import { normalizeRecordName } from '../../provisioning/providers/route53/record-name.js';

/**
 * Why a type's SDK provider carries out this UPDATE by re-creating the
 * resource inside its own `update()`, or `undefined`: the recorded properties
 * against the RESOLVED desired bag `update()` is handed.
 */
type ProviderReplacementPlanner = (
  recorded: Readonly<Record<string, unknown>>,
  desired: Readonly<Record<string, unknown>>
) => string | undefined;

/**
 * go-to-k/cdkd#6509: an SNS subscription's attribute plan, shared with the
 * provider. The deploy plans against the attributes AWS holds; this predicts
 * from the state record, as every other diff verdict does.
 */
const snsSubscriptionReplacement: ProviderReplacementPlanner = (recorded, desired) => {
  const plan = planSubscriptionAttributes(recordedSubscriptionAttributes(recorded), desired);
  return plan.kind === 'replace' ? plan.reason : undefined;
};

/**
 * go-to-k/cdkd#6656: a record set whose `Name` changed is a different Route 53
 * record, which `updateRecordSet` deletes and creates in one change batch
 * (`recordIdentityChanged`'s name arm: both names and both types readable, and
 * the names differ once canonicalized). CloudFormation replaces it too. A
 * `Type` or `SetIdentifier` change takes the same batch, but there
 * CloudFormation shows an update and the name never stops resolving, so it is
 * not marked.
 */
const recordSetRenameReplacement: ProviderReplacementPlanner = (recorded, desired) => {
  const comparable = (value: unknown): value is string =>
    typeof value === 'string' && value !== '' && !value.includes('{{resolve:');
  const [prevName, name] = [recorded['Name'], desired['Name']];
  if (!comparable(prevName) || !comparable(name)) return undefined;
  if (!comparable(recorded['Type']) || !comparable(desired['Type'])) return undefined;
  return normalizeRecordName(prevName) !== normalizeRecordName(name)
    ? 'its Name changed, and Route 53 keys a record on its name'
    : undefined;
};

interface ProviderReplacementEntry {
  /**
   * The top-level properties whose change the planner can answer with a
   * replacement. `scripts/gen-provider-replace-branches.ts` reads them as the
   * diff's verdict for the provider's replace branch, so they stay string
   * literals, and each is pinned by a unit test of the planner.
   */
  readonly properties: readonly string[];
  readonly plan: ProviderReplacementPlanner;
  /**
   * go-to-k/cdkd#6713: when `update()` deletes the old resource, for the
   * plan's note (a reviewed early delete in
   * `scripts/check-replaced-delete-deferral.ts`).
   */
  readonly oldDeleted: 'before-create' | 'during-deploy';
}

/**
 * The types whose provider replaces inside `update()` for a change the
 * engine must not replace itself (it would create first: SNS refuses the same
 * endpoint subscribed to the same topic twice, and Route 53 a record
 * conflicting with the live one). The generator reads the keys as text too.
 */
// Each planner property needs its CloudFormation evidence in
// `../replacement-rules/evidence.ts` (go-to-k/cdkd#7038).
export const PROVIDER_REPLACEMENT_PLANNERS: ReadonlyMap<string, ProviderReplacementEntry> = new Map(
  [
    [
      'AWS::SNS::Subscription',
      {
        // A removed attribute SNS cannot reset, and a new FilterPolicy with a
        // FilterPolicyScope change (`attribute-plan.ts`).
        properties: [
          'DeliveryPolicy',
          'FilterPolicy',
          'FilterPolicyScope',
          'ReplayPolicy',
          'SubscriptionRoleArn',
        ],
        plan: snsSubscriptionReplacement,
        // `replace()` unsubscribes before it subscribes again.
        oldDeleted: 'before-create',
      },
    ],
    [
      'AWS::Route53::RecordSet',
      // One change batch deletes the old record and creates the new one.
      { properties: ['Name'], plan: recordSetRenameReplacement, oldDeleted: 'during-deploy' },
    ],
  ]
);

/**
 * go-to-k/cdkd#6713: when a type's provider deletes the old resource in a
 * `providerReplacement` update, or `undefined` for a type with no planner
 * (the legacy-handle heal, which deletes nothing).
 */
export function providerReplacementOldDeleted(
  resourceType: string
): 'before-create' | 'during-deploy' | undefined {
  return PROVIDER_REPLACEMENT_PLANNERS.get(resourceType)?.oldDeleted;
}

/**
 * go-to-k/cdkd#6509: why the resource's provider carries out this UPDATE by
 * re-creating the resource inside its own `update()`, or `undefined`. Read by
 * `cdkd diff`, its `--fail-on destructive` and the deploy's
 * `--require-approval destructive` through `ResourceChange.providerReplacement`.
 *
 * Display only: it never sets `requiresReplacement`, because the ENGINE must
 * not replace these (see {@link PROVIDER_REPLACEMENT_PLANNERS}).
 *
 * `desired` is the RESOLVED template bag, what `update()` is handed (an
 * `Fn::If` to `AWS::NoValue` is an absent key there). A record of another
 * type, or one on Cloud Control (whose update is not the SDK provider's),
 * answers `undefined`.
 */
export function providerReplacementReason(
  resourceType: string,
  record: ResourceState,
  desired: Readonly<Record<string, unknown>>
): string | undefined {
  const entry = PROVIDER_REPLACEMENT_PLANNERS.get(resourceType);
  if (entry === undefined) return undefined;
  if (record.resourceType !== resourceType || record.provisionedBy === 'cc-api') return undefined;
  return entry.plan(record.properties ?? {}, desired);
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
