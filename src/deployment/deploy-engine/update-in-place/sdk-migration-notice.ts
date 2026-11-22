import { STICKY_CC_MIGRATION_EXEMPT } from '../../../provisioning/provider-registry.js';
import { safeMsg } from '../../../utils/display-safe.js';

/**
 * The line an update that moves a Cloud Control record to its SDK provider
 * prints (`updateInPlace`, split out of it).
 *
 * The ONLY reader of `sdkMigration`, and the reason the field exists: without
 * it this deploy moves a live resource between provisioning layers and says so
 * only at debug level. It fires once, because the record says 'sdk' from this
 * write on.
 *
 * The wording is per MODE, because the two flips happen for opposite reasons
 * and only one of them can be declined. A first revision printed the coverage
 * sentence for both and told a 'cc-broken' user to pass `--pin-cc-api`, which
 * that mode deliberately ignores -- recommending a flag that silently no-ops
 * is the same class of defect as the typo this lane just closed. Exhaustive
 * rather than a ternary: a THIRD mode added later would otherwise inherit the
 * coverage wording AND a `--pin-cc-api` suggestion, which is precisely the
 * wrong-remedy defect this per-mode split exists to fix. `exemptMode` cannot
 * be undefined here — `sdkMigration` is set only after
 * `wouldReturnToSdkProvider` found an entry in this same table — but the
 * default arm keeps that from being load-bearing.
 */
export function sdkMigrationNotice(
  logicalId: string,
  resourceType: string,
  idPreserved: boolean
): string {
  const exemptMode = STICKY_CC_MIGRATION_EXEMPT.get(resourceType)?.mode;
  const preserved = idPreserved
    ? 'The physical id is preserved'
    : "The resource is kept in place, and its recorded physical id takes the SDK provider's form";
  switch (exemptMode) {
    case 'cc-broken':
      return (
        safeMsg`${logicalId} (${resourceType}): moving to the SDK provider — Cloud ` +
        `Control cannot manage this type correctly. ${preserved}, and this ` +
        `routing is not optional.`
      );
    case 'sdk-coverage':
      return (
        safeMsg`${logicalId} (${resourceType}): returning to the SDK provider — cdkd now ` +
        `covers every property this resource uses. ${preserved}; pass ` +
        safeMsg`--pin-cc-api ${logicalId} to decline this for a deploy.`
      );
    default:
      return safeMsg`${logicalId} (${resourceType}): moving to the SDK provider. ${preserved}.`;
  }
}
