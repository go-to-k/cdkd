import type { Route53Provider } from '../route53-provider.js';
import type {
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { isMatchableSetIdentifier } from './shared.js';
import {
  recordSetGroupCompositeId,
  parseRecordSetGroupCompositeId,
  existingGroupName,
  groupRecordSets,
  groupZoneProperties,
  groupSubject,
} from './record-set-group-shape.js';
import { readRecordSetGroup } from './record-set-group.js';

// ─── AWS::Route53::RecordSetGroup import ───────────────────────────
// Split from record-set-group.ts (src file size cap).

/**
 * Auto-mode adoption of a group (go-to-k/cdkd#6662). A group is no AWS
 * object, only its records, which the template names exactly: the zone
 * resolves from the template (the import loop substitutes a `Ref` to a zone
 * adopted earlier in the run), and the group is adopted only when EVERY
 * record is live, named by its logical id. Anything less
 * declines (`null`), a failed zone lookup included; a failed record read
 * propagates.
 */
async function importRecordSetGroupFromTemplate(
  this: Route53Provider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const parsed = groupRecordSets(input.properties);
  if ('refusal' in parsed || parsed.records.length === 0) return null;
  const zoneProps = groupZoneProperties(input.properties, parsed.records);
  if ('refusal' in zoneProps) return null;
  // An unresolved SetIdentifier cannot pick one record among its siblings.
  if (
    parsed.records.some(
      (r) => r['SetIdentifier'] !== undefined && !isMatchableSetIdentifier(r['SetIdentifier'])
    )
  ) {
    return null;
  }
  let hostedZoneId: string;
  try {
    hostedZoneId = await this.resolveHostedZoneId(
      zoneProps.zone,
      input.logicalId,
      input.resourceType,
      input.logicalId,
      { requireUnambiguousZoneName: true, subject: groupSubject }
    );
  } catch {
    return null;
  }
  // The logical id names the group: a deploy's generated name needs the
  // stack's name generations, which an import has not read, and every reader
  // accepts the logical id (`namesThisGroup`).
  const physicalId = recordSetGroupCompositeId(hostedZoneId, input.logicalId);
  const observed = await readRecordSetGroup.call(
    this,
    physicalId,
    input.logicalId,
    input.properties
  );
  if (
    !observed ||
    observed === RESOURCE_NOT_FOUND ||
    !Array.isArray(observed['RecordSets']) ||
    observed['RecordSets'].length !== parsed.records.length
  ) {
    return null;
  }
  return { physicalId, attributes: {} };
}

/**
 * Adopt an existing group (`cdkd import --resource <id>=<physicalId>`). The
 * supplied id is CloudFormation's group name (or a cdkd id); the zone and the
 * records come from the template, every record is verified live, and the
 * recorded id is cdkd's composite. Anything cdkd cannot verify keeps the
 * supplied id verbatim, which delete and drift resolve through the recorded
 * properties. With no id, {@link importRecordSetGroupFromTemplate}.
 */
export async function importRecordSetGroup(
  this: Route53Provider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const known = input.knownPhysicalId;
  if (!known) return importRecordSetGroupFromTemplate.call(this, input);

  const adoptVerbatim = (reason: string): ResourceImportResult => {
    this.logger.warn(
      safeMsg`Record set group ${input.logicalId}: could not verify physical id '${known}' (${reason}). Adopting it as-is.`
    );
    return { physicalId: known, attributes: {} };
  };

  // A cdkd id's zone segment is what delete addresses, so an unverified one is
  // never adopted: a wrong zone answers `NoSuchHostedZone`, which delete reads
  // as already gone while the real records stay live.
  const knownComposite = parseRecordSetGroupCompositeId(known, input.logicalId);
  const decline = (reason: string): null => {
    this.logger.warn(
      safeMsg`Record set group ${input.logicalId}: could not verify physical id '${known}' (${reason}). Not importing it.`
    );
    return null;
  };
  const unverified = (reason: string) => (knownComposite ? decline(reason) : adoptVerbatim(reason));

  const parsed = groupRecordSets(input.properties);
  if ('refusal' in parsed) return unverified(parsed.refusal);
  const zoneProps = groupZoneProperties(input.properties, parsed.records);
  if ('refusal' in zoneProps) return unverified(zoneProps.refusal);

  let hostedZoneId: string;
  if (knownComposite) {
    hostedZoneId = knownComposite.hostedZoneId;
  } else {
    try {
      hostedZoneId = await this.resolveHostedZoneId(
        zoneProps.zone,
        input.logicalId,
        input.resourceType,
        known,
        { requireUnambiguousZoneName: true, subject: groupSubject }
      );
    } catch {
      return adoptVerbatim('the template does not unambiguously resolve to a hosted zone');
    }
  }

  let observed: Record<string, unknown> | ResourceNotFound | undefined;
  try {
    observed = await readRecordSetGroup.call(
      this,
      recordSetGroupCompositeId(hostedZoneId, existingGroupName(known, input.logicalId)),
      input.logicalId,
      input.properties
    );
  } catch (err) {
    const head = `Record set group ${input.logicalId}: verification of '${known}' failed: `;
    const reason = `verification failed: ${this.warnFailureText(head, err, undefined).replace(/\.$/, '')}`;
    return unverified(reason);
  }
  // A read leaves out a member proven gone (go-to-k/cdkd#6660), so a short
  // list is a group missing a record, which adoption must not vouch for.
  if (
    !observed ||
    observed === RESOURCE_NOT_FOUND ||
    !Array.isArray(observed['RecordSets']) ||
    observed['RecordSets'].length !== parsed.records.length
  ) {
    const reason = 'not every record was found under the resolved hosted zone';
    return unverified(reason);
  }
  return {
    physicalId: recordSetGroupCompositeId(hostedZoneId, existingGroupName(known, input.logicalId)),
    attributes: {},
  };
}
