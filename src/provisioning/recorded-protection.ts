/**
 * Whether cdkd's record of a resource says it carries a deletion /
 * termination protection flag, for the deploy engine's GENERIC stateful
 * replacement refusals (issue [#2610](https://github.com/go-to-k/cdkd/issues/2610),
 * sites 9-11). Those refusals advise `--force-stateful-recreation` for any
 * stateful type, but the engine never sets `DeleteContext.removeProtection`
 * (`cdkd deploy` registers no `--remove-protection`), so AWS refuses the
 * replacement's delete of a protected resource whatever flags were passed.
 * The provider-level refusals say so through `replacement-protection-advice.ts`;
 * this is the engine's equivalent, read through the shared
 * `protection-flags.ts` table.
 */
import { DELETION_PROTECTION_DOC_POINTER } from './replacement-protection-advice.js';
import {
  PROTECTION_PROPERTY_BY_TYPE,
  isProtectionValueActive,
  perType,
  readProtection,
  type ProtectionLocator,
} from './protection-flags.js';

/**
 * How the evidence names a flag whose locator is a reader rather than a path.
 * Every reader-located type needs an entry; `recorded-protection.test.ts`
 * enforces it.
 */
const READER_LABELS: Record<string, string> = {
  'AWS::DynamoDB::GlobalTable': 'DeletionProtectionEnabled for the deploy region',
  'AWS::ElasticLoadBalancingV2::LoadBalancer': 'LoadBalancerAttributes deletion_protection.enabled',
};

/**
 * Where a replacement's delete is blocked by FEWER values than the destroy
 * prompt counts as protected. An Auto Scaling group's `prevent-force-deletion`
 * stops only a forced delete, and the deploy path's delete does not force one
 * (`asg-provider.ts`'s own replacement refusal reads the same way).
 */
const REPLACEMENT_BLOCKING_VALUES: Record<string, ReadonlySet<unknown>> = {
  'AWS::AutoScaling::AutoScalingGroup': new Set(['prevent-all-deletion']),
};

function labelFor(resourceType: string, locator: ProtectionLocator): string | undefined {
  if (typeof locator === 'string') return locator;
  if (typeof locator === 'function') return perType(READER_LABELS, resourceType);
  return locator.join('.');
}

/** Exported for the coverage test: every reader-located type has a label. */
export function readerLocatedTypesWithoutLabel(): string[] {
  return Object.entries(PROTECTION_PROPERTY_BY_TYPE)
    .filter(([type, locator]) => labelFor(type, locator) === undefined)
    .map(([type]) => type);
}

/**
 * The fragment naming the flag as ON in `bag`, or `undefined`. It shows a value
 * only when that value is a member of a closed set cdkd authored (an enum
 * level), so nothing recorded reaches the message unvetted.
 */
function protectionFragment(
  resourceType: string,
  locator: ProtectionLocator,
  label: string,
  bag: Record<string, unknown> | undefined,
  region: string | undefined
): string | undefined {
  if (bag === undefined) return undefined;
  const value = readProtection(bag, locator, region);
  const blocking = perType(REPLACEMENT_BLOCKING_VALUES, resourceType);
  const on = blocking ? blocking.has(value) : isProtectionValueActive(resourceType, value);
  if (!on) return undefined;
  if (value === true || value === 'true') return `${label}: true`;
  if (typeof value === 'string') return `${label}: ${value}`;
  return `${label} enabled`;
}

/**
 * A clause naming the bag that says `resourceType`'s protection blocks a
 * delete — the recorded properties first, then the AWS read-back cdkd stored
 * after its last write (`observedProperties`) — or `undefined` when neither
 * does. Protection enabled out of band after that read is in neither bag, so
 * such a resource keeps the short advice.
 *
 * `region` is the stack's: `AWS::DynamoDB::GlobalTable` keeps the flag per
 * replica.
 */
export function recordedProtectionEvidence(
  resourceType: string,
  properties: Record<string, unknown> | undefined,
  observedBag: Record<string, unknown> | undefined,
  region: string | undefined
): string | undefined {
  const locator = perType(PROTECTION_PROPERTY_BY_TYPE, resourceType);
  if (locator === undefined) return undefined;
  const label = labelFor(resourceType, locator);
  if (label === undefined) return undefined;
  const recorded = protectionFragment(resourceType, locator, label, properties, region);
  if (recorded) return `cdkd's recorded properties for this resource carry ${recorded}`;
  const observed = protectionFragment(resourceType, locator, label, observedBag, region);
  if (observed) return `the AWS read-back cdkd stored for this resource carries ${observed}`;
  return undefined;
}

/**
 * The note a generic stateful-replacement refusal gives instead of its bare
 * "re-run with `flags`" when {@link recordedProtectionEvidence} found the flag
 * on.
 *
 * It names both outcomes because the engine has both orders: a delete-first
 * replacement fails at the refused delete, while a create-first one completes
 * and only warns that the old resource could not be deleted — leaving it, and
 * its data, in AWS and out of cdkd's state.
 */
export function recordedProtectionNote(evidence: string, flags: string): string {
  return (
    `${evidence}. AWS refuses to delete the resource while that protection is on, and ` +
    `cdkd deploy has no --remove-protection flag to clear it (only cdkd destroy and ` +
    `cdkd state destroy act on one), so ${flags} alone does not remove the old resource: ` +
    `depending on the replacement order, the deploy either fails at that delete or ` +
    `completes leaving the old resource, and its data, in AWS and no longer tracked by ` +
    `cdkd. Read ${DELETION_PROTECTION_DOC_POINTER} before you disable anything, then turn ` +
    `the protection off out of band (the console, or the service's own API) and re-run ` +
    `with ${flags}.`
  );
}
