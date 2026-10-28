/**
 * go-to-k/cdkd#5380 / #5487: the previous side an `update()` diffs against,
 * with each key an earlier failed update left unsettled
 * (`UpdateContext.unsettledProperties`) taken from what AWS holds NOW.
 *
 * A provider that decides per key "did this change?" by comparing the
 * desired bag with the recorded one cannot converge an unsettled key: the
 * record keeps the value from before the failed update, which often equals
 * the template being deployed, so the comparison finds nothing to send while
 * AWS may hold the attempted value. Substituting the live readback for those
 * keys, and only those, lets the provider's own comparison and its own
 * removal handling decide what to send. A key the readback does not report
 * (a write-only property, a ZIP function's `Code`) is removed from the
 * previous side, so a desired value is sent again.
 *
 * The read happens only when some key is unsettled, so an ordinary update
 * makes no extra call. A readback that cannot be taken refuses the update
 * before any write: the success that followed would clear the names without
 * having converged them.
 */
import type { ResourceNotFound, UpdateContext } from '../types/resource.js';
import { ProvisioningError } from '../utils/error-handler.js';

export async function previousWithLiveUnsettled(
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined,
  readLive: () => Promise<Record<string, unknown> | ResourceNotFound | undefined>,
  identity: { resourceType: string; logicalId: string; physicalId: string },
  overrides: Readonly<Record<string, () => Promise<unknown>>> = {}
): Promise<Record<string, unknown>> {
  const names = context?.unsettledProperties;
  if (names === undefined || names.size === 0) return previousProperties;
  const live = await readLive();
  if (live === undefined || typeof live !== 'object' || live === null || Array.isArray(live)) {
    throw new ProvisioningError(
      `${identity.logicalId} (${identity.resourceType}): an earlier failed update left ` +
        `${[...names].sort().join(', ')} unsettled, and the resource could not be read to ` +
        `converge ${names.size === 1 ? 'it' : 'them'} — nothing was updated. Re-run the deploy.`,
      identity.resourceType,
      identity.logicalId,
      identity.physicalId
    );
  }
  const previous = { ...previousProperties };
  for (const name of names) {
    const override = Object.hasOwn(overrides, name) ? overrides[name] : undefined;
    const value =
      override !== undefined ? await override() : (live as Record<string, unknown>)[name];
    if (override === undefined && !Object.hasOwn(live, name)) {
      delete previous[name];
    } else if (value === undefined) {
      delete previous[name];
    } else {
      previous[name] = value;
    }
  }
  return previous;
}
