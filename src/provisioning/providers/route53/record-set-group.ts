import type { Route53Provider } from '../route53-provider.js';
import {
  ChangeResourceRecordSetsCommand,
  Route53Client,
  type Change,
  type ResourceRecordSet,
} from '@aws-sdk/client-route-53';
import { ambientClientDefaults } from '../../../utils/ambient-client-defaults.js';
import { hasReplayMayCollide } from '../../../deployment/retryable-errors.js';
import { withoutServerErrorRetries } from '../ambiguous-create.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markNameCollision } from '../../../deployment/retryable-errors.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import type {
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
  ResourceUpdateResult,
  UpdateContext,
} from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import {
  getPriorAttempts,
  markRefusedBeforeApplying,
} from '../../../deployment/prior-attempt-scope.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  isRedactedRecordedValue,
  redactedDeleteAddressFields,
  redactedDeleteAddressSkip,
} from '../../redacted-delete-address.js';
import {
  isZoneDisabledForMutationError,
  HostedZoneNameNotFoundError,
  normalizeRecordName,
  isCnameConflictRefusal,
  CNAME_CONFLICT_COLLISION_NOTE,
  bareHostedZoneId,
  zoneReferenceChanged,
  recordedZoneForSwitch,
} from './shared.js';

// ─── AWS::Route53::RecordSetGroup ──────────────────────────────────
//
// A group has no AWS-side entity: it is the set of records its `RecordSets`
// list names, all in ONE hosted zone. Every write is one
// `ChangeResourceRecordSets` batch, which Route 53 applies all or nothing, so
// a refused record leaves the whole group as it was.
//
// The physicalId is `<hostedZoneId>|<logicalId>`: the zone the records were
// written to, so update / delete / drift never re-resolve a `HostedZoneName`
// (which can match a public and a private zone of one name), plus the logical
// id, which `Ref` returns (CloudFormation returns a generated group name,
// which names nothing in AWS either). Neither segment can carry `|`.

const RECORD_SET_GROUP_TYPE = 'AWS::Route53::RecordSetGroup';

/** The keys that identify a record inside a hosted zone. */
const RECORD_IDENTITY_FIELDS = ['Name', 'Type', 'SetIdentifier'] as const;

/**
 * The per-record fields a DELETE must match exactly (every field
 * `buildResourceRecordSet` sends), used for the redaction guard when a delete
 * falls back to the recorded values.
 */
const RECORD_VALUE_FIELDS = [
  'TTL',
  'ResourceRecords',
  'AliasTarget',
  'Weight',
  'Region',
  'Failover',
  'MultiValueAnswer',
  'HealthCheckId',
  'GeoLocation',
  'GeoProximityLocation',
  'CidrRoutingConfig',
] as const;

function recordSetGroupCompositeId(hostedZoneId: string, logicalId: string): string {
  return `${hostedZoneId}|${logicalId}`;
}

/**
 * The zone a cdkd-minted id of THIS group names, or `undefined` for any other
 * shape (CloudFormation's generated group name, adopted by `cdkd import`). The
 * second segment must be the group's own logical id: two non-empty segments
 * alone are not proof of a cdkd id (the #1711 class).
 */
function parseRecordSetGroupCompositeId(
  physicalId: string,
  logicalId: string
): { hostedZoneId: string } | undefined {
  const parts = physicalId.split('|');
  if (parts.length !== 2) return undefined;
  const [hostedZoneId, idLogicalId] = parts;
  if (!hostedZoneId || idLogicalId !== logicalId) return undefined;
  return { hostedZoneId };
}

/**
 * The group's `RecordSets` as a list of record bags, or a refusal message
 * when the list (or one entry) is not usable. An ABSENT list is the empty
 * list: CloudFormation does not require the property.
 */
function groupRecordSets(
  properties: Record<string, unknown> | undefined
): { records: Record<string, unknown>[] } | { refusal: string } {
  const raw = properties?.['RecordSets'];
  if (raw === undefined || raw === null) return { records: [] };
  if (!Array.isArray(raw)) return { refusal: 'RecordSets is not a list' };
  const records: Record<string, unknown>[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { refusal: `RecordSets[${index}] is not an object` };
    }
    records.push(entry as Record<string, unknown>);
  }
  return { records };
}

/**
 * A record's identity inside its zone — normalized name, type and
 * SetIdentifier — or `undefined` when it cannot be compared: a missing or
 * non-string field, a redacted dynamic reference (`{{resolve:...}}`), or
 * cdkd's `***` mask (go-to-k/cdkd#3952), either of which would address a
 * record that is not the one recorded.
 */
function recordSetKey(record: Record<string, unknown>): string | undefined {
  const comparable = (value: unknown): value is string =>
    typeof value === 'string' &&
    value !== '' &&
    !value.includes('{{resolve:') &&
    !isRedactedRecordedValue(value);
  const name = record['Name'];
  const type = record['Type'];
  const setIdentifier = record['SetIdentifier'];
  if (!comparable(name) || !comparable(type)) return undefined;
  if (setIdentifier !== undefined && !comparable(setIdentifier)) return undefined;
  return JSON.stringify([normalizeRecordName(name), type, setIdentifier ?? '']);
}

/**
 * The zone properties the group resolves against: the group's own
 * `HostedZoneId` / `HostedZoneName`, else the ones its records declare. A
 * record may repeat the group's zone, but a batch is per zone, so records
 * naming a DIFFERENT zone (or records disagreeing with each other) are
 * refused rather than written to whichever one wins.
 */
function groupZoneProperties(
  properties: Record<string, unknown>,
  records: Record<string, unknown>[]
): { zone: Record<string, unknown> } | { refusal: string } {
  const zone: Record<string, unknown> = {};
  for (const key of ['HostedZoneId', 'HostedZoneName'] as const) {
    const groupValue = properties[key];
    let value: unknown = groupValue;
    for (const [index, record] of records.entries()) {
      const recordValue = record[key];
      if (recordValue === undefined) continue;
      if (value === undefined) {
        value = recordValue;
        continue;
      }
      if (JSON.stringify(recordValue) !== JSON.stringify(value)) {
        return {
          refusal:
            `RecordSets[${index}].${key} differs from the ${key} the rest of the group uses; ` +
            `every record of a RecordSetGroup must be in one hosted zone`,
        };
      }
    }
    if (value !== undefined) zone[key] = value;
  }
  return { zone };
}

/** The bag `buildResourceRecordSet` reads, without the per-record zone keys. */
function recordBag(record: Record<string, unknown>): Record<string, unknown> {
  const { HostedZoneId: _zoneId, HostedZoneName: _zoneName, ...rest } = record;
  return rest;
}

function groupRefusalError(
  message: string,
  logicalId: string,
  physicalId: string | undefined
): ProvisioningError {
  return new ProvisioningError(message, RECORD_SET_GROUP_TYPE, logicalId, physicalId);
}

/**
 * The group's records and zone properties from a DESIRED bag, refusing a
 * malformed list or a record cdkd cannot identify before any AWS call.
 */
function desiredGroup(
  properties: Record<string, unknown>,
  logicalId: string,
  physicalId: string | undefined
): { records: Record<string, unknown>[]; zone: Record<string, unknown> } {
  const parsed = groupRecordSets(properties);
  if ('refusal' in parsed) {
    throw groupRefusalError(
      `Record set group ${logicalId}: ${parsed.refusal}`,
      logicalId,
      physicalId
    );
  }
  for (const [index, record] of parsed.records.entries()) {
    if (recordSetKey(record) === undefined) {
      throw groupRefusalError(
        `Record set group ${logicalId}: RecordSets[${index}] needs a plain string Name and Type ` +
          `(and SetIdentifier, when set) to be written`,
        logicalId,
        physicalId
      );
    }
  }
  const zone = groupZoneProperties(properties, parsed.records);
  if ('refusal' in zone) {
    throw groupRefusalError(
      `Record set group ${logicalId}: ${zone.refusal}`,
      logicalId,
      physicalId
    );
  }
  return { records: parsed.records, zone: zone.zone };
}

const groupSubject = {
  noun: 'record set group',
  remedy: 'set HostedZoneId explicitly',
};

export async function createRecordSetGroup(
  this: Route53Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  mask: ((text: string) => string) | undefined
): Promise<ResourceCreateResult> {
  this.logger.debug(safeMsg`Creating Route 53 record set group ${logicalId}`);

  const { records, zone } = desiredGroup(properties, logicalId, undefined);
  const hostedZoneId = await this.resolveHostedZoneId(zone, logicalId, resourceType, undefined, {
    subject: groupSubject,
  });
  const compositeId = recordSetGroupCompositeId(hostedZoneId, logicalId);

  // Route 53 refuses an empty change batch, and a group with no records holds
  // nothing in AWS, so there is nothing to write.
  if (records.length === 0) {
    this.logger.debug(
      safeMsg`Record set group ${logicalId} declares no records; nothing to create`
    );
    return { physicalId: compositeId, attributes: {} };
  }

  try {
    const comment = properties['Comment'];
    await this.getClient().send(
      new ChangeResourceRecordSetsCommand({
        HostedZoneId: hostedZoneId,
        ChangeBatch: {
          ...(typeof comment === 'string' && comment ? { Comment: comment } : {}),
          Changes: records.map((record): Change => ({
            Action: 'CREATE',
            ResourceRecordSet: this.buildResourceRecordSet(recordBag(record)),
          })),
        },
      })
    );
    this.logger.debug(safeMsg`Successfully created record set group ${logicalId}: ${compositeId}`);
    return { physicalId: compositeId, attributes: {} };
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    const cause = error instanceof Error ? error : undefined;
    const cnameConflict = isCnameConflictRefusal(error);
    const wrapped = this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create record set group ${logicalId}` +
            `${cnameConflict ? CNAME_CONFLICT_COLLISION_NOTE : ''}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
    throw cnameConflict ? markNameCollision(wrapped) : wrapped;
  }
}

/**
 * The zone an existing group lives in: the one its cdkd id names, else (an id
 * `cdkd import` adopted verbatim) the one its recorded zone properties
 * resolve to, refusing a name that matches more than one zone.
 */
async function existingGroupZone(
  this: Route53Provider,
  physicalId: string,
  zone: Record<string, unknown>,
  logicalId: string,
  resourceType: string
): Promise<string> {
  const parsed = parseRecordSetGroupCompositeId(physicalId, logicalId);
  if (parsed) return parsed.hostedZoneId;
  return this.resolveHostedZoneId(zone, logicalId, resourceType, physicalId, {
    requireUnambiguousZoneName: true,
    subject: groupSubject,
  });
}

export async function updateRecordSetGroup(
  this: Route53Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  const progress = { sent: false, clientRefused: false };
  try {
    return await applyRecordSetGroupUpdate.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context,
      progress
    );
  } catch (error) {
    // The journal keeps a failed update's bag as evidence that this stack may
    // have written its records (`ownEarlierWriteMayHold`). A failure before
    // the batch was sent, or a batch Route 53 refused as a client error
    // (applied all or nothing), wrote nothing, so it must not become that
    // evidence; unless an earlier send of this dispatch may have landed.
    const wroteNothing = !progress.sent || progress.clientRefused;
    if (
      error instanceof Error &&
      wroteNothing &&
      getPriorAttempts(logicalId)?.possiblyLanded() !== true
    ) {
      throw markRefusedBeforeApplying(error);
    }
    throw error;
  }
}

async function applyRecordSetGroupUpdate(
  this: Route53Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined,
  progress: { sent: boolean; clientRefused: boolean }
): Promise<ResourceUpdateResult> {
  this.logger.debug(safeMsg`Updating Route 53 record set group ${logicalId}: ${physicalId}`);

  const { records, zone } = desiredGroup(properties, logicalId, physicalId);

  // The previous side is a cdkd STATE record (or, on `drift --revert`, a
  // readback). A record in it cdkd cannot identify would make the batch below
  // either miss a removal or guess which live record to delete, so refuse.
  const previous = groupRecordSets(previousProperties);
  if ('refusal' in previous) {
    throw groupRefusalError(
      `Record set group ${logicalId}: the recorded ${previous.refusal}, so cdkd cannot tell ` +
        `which records to remove`,
      logicalId,
      physicalId
    );
  }
  const previousByKey = new Map<string, Record<string, unknown>>();
  for (const [index, record] of previous.records.entries()) {
    const key = recordSetKey(record);
    if (key === undefined) {
      throw groupRefusalError(
        `Record set group ${logicalId}: recorded RecordSets[${index}] has no readable Name / ` +
          `Type / SetIdentifier, so cdkd cannot tell which live record it is`,
        logicalId,
        physicalId
      );
    }
    previousByKey.set(key, record);
  }

  const hostedZoneId = await existingGroupZone.call(
    this,
    physicalId,
    zone,
    logicalId,
    resourceType
  );
  const compositeId = recordSetGroupCompositeId(hostedZoneId, logicalId);

  // A zone change is a replacement (`replacement-rules/rules.ts`), so reaching
  // here with a desired zone id other than the one the records live in would
  // write them to the old zone while state recorded the new one.
  // A switch between `HostedZoneName` and `HostedZoneId` is not a replacement
  // either (go-to-k/cdkd#6537), so a NAME is resolved too — only when the
  // zone reference changed, so an ordinary update makes no extra call.
  const desiredZoneId = zone['HostedZoneId'];
  let desiredZone: string | undefined =
    typeof desiredZoneId === 'string' ? desiredZoneId : undefined;
  const previousZone = groupZoneProperties(
    previousProperties,
    'refusal' in previous ? [] : previous.records
  );
  if (
    desiredZone === undefined &&
    typeof zone['HostedZoneName'] === 'string' &&
    !('refusal' in previousZone) &&
    zoneReferenceChanged(previousZone.zone, zone)
  ) {
    desiredZone = await this.resolveHostedZoneId(zone, logicalId, resourceType, physicalId, {
      requireUnambiguousZoneName: true,
      subject: groupSubject,
    });
  }
  // The zone the records are in: the cdkd id's, else (an id `cdkd import`
  // adopted verbatim, where `hostedZoneId` above was resolved from the
  // DESIRED side) the recorded reference's, which must resolve.
  let recordedZone = hostedZoneId;
  if (
    !parseRecordSetGroupCompositeId(physicalId, logicalId) &&
    !('refusal' in previousZone) &&
    zoneReferenceChanged(previousZone.zone, zone)
  ) {
    recordedZone = await recordedZoneForSwitch(
      this,
      previousZone.zone,
      logicalId,
      resourceType,
      physicalId,
      'Record set group'
    );
  }
  if (
    desiredZone !== undefined &&
    bareHostedZoneId(desiredZone) !== bareHostedZoneId(recordedZone)
  ) {
    throw groupRefusalError(
      `Record set group ${logicalId}: the template's hosted zone differs from the one its ` +
        `records are in (${recordedZone}). Moving a group to another zone replaces it: name ` +
        `the new zone with the key the group already uses (HostedZoneId or HostedZoneName) so ` +
        `cdkd plans the replacement`,
      logicalId,
      physicalId
    );
  }

  try {
    const desiredKeys = new Set<string>();
    const changes: Change[] = [];
    for (const record of records) {
      const key = recordSetKey(record) as string;
      desiredKeys.add(key);
      const desired = this.buildResourceRecordSet(recordBag(record));
      const recorded = previousByKey.get(key);
      if (recorded === undefined) {
        // CREATE, not UPSERT: a record of this identity that cdkd did not
        // write (another resource's, or an out-of-band one) is refused by
        // Route 53 instead of being taken over. Only on THIS stack's evidence
        // that its own earlier write may have created the record (a failed
        // deploy's journaled bag, or an ambiguous send in this dispatch) is a
        // live record with exactly the desired values taken as that write,
        // committed before its state was saved — never on equal values alone,
        // which an identical record of another owner also has
        // (provider-resource-identity.md).
        const live = (await ownEarlierWriteMayHold(logicalId, key, desired, this))
          ? await this.findLiveRecordSet(hostedZoneId, recordBag(record))
          : undefined;
        if (live && sameRecordSet(live, desired)) {
          this.logger.debug(
            safeMsg`Record set group ${logicalId}: an added record is already live with the desired values; not creating it again`
          );
          continue;
        }
        changes.push({ Action: 'CREATE', ResourceRecordSet: desired });
        continue;
      }
      const before = this.buildResourceRecordSet(recordBag(recorded));
      if (JSON.stringify(before) !== JSON.stringify(desired)) {
        changes.push({ Action: 'UPSERT', ResourceRecordSet: desired });
      }
    }
    for (const [key, recorded] of previousByKey) {
      if (desiredKeys.has(key)) continue;
      // The DELETE carries the LIVE record verbatim: Route 53 refuses a
      // DELETE whose values differ from what it holds, and the record can lag
      // the live one. A record already gone needs no change.
      const live = await this.findLiveRecordSet(hostedZoneId, recordBag(recorded));
      if (live) {
        changes.push({ Action: 'DELETE', ResourceRecordSet: live });
      } else {
        // WARN: the lookup is bounded, so a miss can also be a live record
        // it did not reach, which this update then stops tracking.
        this.logger.warn(
          safeMsg`Record set group ${logicalId}: a record removed from the template was not found in ${hostedZoneId}; nothing was deleted for it`
        );
      }
    }

    if (changes.length > 0) {
      const comment = properties['Comment'];
      progress.sent = true;
      await updateBatchClient(this).send(
        new ChangeResourceRecordSetsCommand({
          HostedZoneId: hostedZoneId,
          ChangeBatch: {
            ...(typeof comment === 'string' && comment ? { Comment: comment } : {}),
            // DELETEs first: a record replaced by one of a conflicting type on
            // the same name (an A becoming a CNAME) is valid only once the old
            // one is gone, and the batch is validated in order.
            Changes: [
              ...changes.filter((c) => c.Action === 'DELETE'),
              ...changes.filter((c) => c.Action !== 'DELETE'),
            ],
          },
        })
      );
    }

    this.logger.debug(safeMsg`Successfully updated record set group ${logicalId}`);
    return { physicalId: compositeId, wasReplaced: false, attributes: {} };
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    // A send failure Route 53 did not author as a client refusal may follow a
    // batch it applied; the engine's retry of this dispatch reads that. A
    // failure before the send (a lookup) applied nothing.
    if (progress.sent) {
      if (isUnambiguousClientRefusal(error)) {
        progress.clientRefused = true;
      } else {
        getPriorAttempts(logicalId)?.notePossiblyLanded();
      }
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update record set group ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * Whether this stack's own earlier write of `logicalId` may have created the
 * record `key` names with the `desired` values: an ambiguous send earlier in
 * this dispatch, or a failed deploy's journaled bag declaring that record
 * with those values. An unreadable journal is no evidence.
 */
async function ownEarlierWriteMayHold(
  logicalId: string,
  key: string,
  desired: ResourceRecordSet,
  provider: Route53Provider
): Promise<boolean> {
  const lookup = getPriorAttempts(logicalId);
  if (!lookup) return false;
  if (lookup.possiblyLanded()) return true;
  let bags: ReadonlyArray<Record<string, unknown>>;
  try {
    bags = await lookup.attempts();
  } catch {
    return false;
  }
  return bags.some((bag) => {
    const parsed = groupRecordSets(bag);
    if ('refusal' in parsed) return false;
    return parsed.records.some(
      (r) =>
        recordSetKey(r) === key &&
        sameRecordSet(provider.buildResourceRecordSet(recordBag(r)), desired)
    );
  });
}

/**
 * Equality of two record sets, insensitive to key order and to the spellings
 * Route 53 rewrites (trailing dot and case of the name and of an alias target).
 */
function sameRecordSet(a: ResourceRecordSet, b: ResourceRecordSet): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])])
    );
  };
  const spell = (r: ResourceRecordSet) =>
    JSON.stringify(
      canonical({
        ...r,
        Name: normalizeRecordName(r.Name ?? ''),
        ...(r.AliasTarget && {
          AliasTarget: {
            ...r.AliasTarget,
            DNSName: normalizeRecordName(r.AliasTarget.DNSName ?? ''),
          },
        }),
      })
    );
  return spell(a) === spell(b);
}

/**
 * The update batch's client. The SDK does not replay a 5xx on it, and stamps
 * `markReplayMayCollide` on every error a `send` throws after an AMBIGUOUS
 * attempt (`withoutServerErrorRetries`), so a refusal can be told apart from
 * one answering a batch an earlier attempt may have committed. One per
 * provider instance, built on first use like `getClient`.
 */
const updateBatchClients = new WeakMap<Route53Provider, Route53Client>();
function updateBatchClient(provider: Route53Provider): Route53Client {
  let client = updateBatchClients.get(provider);
  if (!client) {
    client = withoutServerErrorRetries(
      new Route53Client({
        ...ambientClientDefaults(),
        ...(provider.providerRegion ? { region: provider.providerRegion } : {}),
      })
    );
    updateBatchClients.set(provider, client);
  }
  return client;
}

/**
 * A send failure Route 53 authored as a client refusal with no ambiguous
 * attempt before it in the same `send` — the only case proving the batch
 * applied nothing. After an ambiguous attempt (a 5xx, a reset), "already
 * exists" may be this group's own committed record; after a throttle, which
 * applies nothing, it is still a refusal.
 */
function isUnambiguousClientRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ((error as { $fault?: unknown }).$fault !== 'client') return false;
  return !hasReplayMayCollide(error);
}

/** A Route 53 refusal that the record a DELETE names does not exist. */
function isRecordNotFoundRefusal(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'InvalidChangeBatch' &&
    /but it was not found/i.test(error.message)
  );
}

export async function deleteRecordSetGroup(
  this: Route53Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  this.logger.debug(safeMsg`Deleting Route 53 record set group ${logicalId}: ${physicalId}`);

  if (!properties) {
    throw groupRefusalError(
      `Properties required to delete record set group ${logicalId}`,
      logicalId,
      physicalId
    );
  }
  const parsed = groupRecordSets(properties);
  if ('refusal' in parsed) {
    throw groupRefusalError(
      `Record set group ${logicalId}: the recorded ${parsed.refusal}, so cdkd cannot tell ` +
        `which records to delete`,
      logicalId,
      physicalId
    );
  }
  const records = parsed.records;
  for (const [index, record] of records.entries()) {
    if (recordSetKey(record) !== undefined) continue;
    // go-to-k/cdkd#3952: an identity holding cdkd's redaction would address
    // the wrong record (or none, which reads as deleted).
    const redactedSkip = redactedDeleteAddressSkip(
      this.logger,
      logicalId,
      'Route 53 record set group',
      redactedDeleteAddressFields(
        Object.fromEntries(RECORD_IDENTITY_FIELDS.map((f) => [f, record[f]]))
      )
    );
    if (redactedSkip) return redactedSkip;
    throw groupRefusalError(
      `Record set group ${logicalId}: recorded RecordSets[${index}] has no readable Name / ` +
        `Type / SetIdentifier, so cdkd cannot tell which live record to delete`,
      logicalId,
      physicalId
    );
  }

  const zoneProps = groupZoneProperties(properties, records);
  if ('refusal' in zoneProps) {
    throw groupRefusalError(
      `Record set group ${logicalId}: ${zoneProps.refusal}`,
      logicalId,
      physicalId
    );
  }

  const alreadyGone = async (): Promise<void> => {
    const clientRegion = await this.getClient().config.region();
    assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
  };

  let hostedZoneId: string;
  const composite = parseRecordSetGroupCompositeId(physicalId, logicalId);
  if (composite) {
    hostedZoneId = composite.hostedZoneId;
  } else {
    // The zone comes from the recorded properties only on this arm (#3952).
    const redactedZoneSkip = redactedDeleteAddressSkip(
      this.logger,
      logicalId,
      'Route 53 record set group',
      redactedDeleteAddressFields({
        HostedZoneId: zoneProps.zone['HostedZoneId'],
        HostedZoneName: zoneProps.zone['HostedZoneName'],
      })
    );
    if (redactedZoneSkip) return redactedZoneSkip;
    try {
      hostedZoneId = await existingGroupZone.call(
        this,
        physicalId,
        zoneProps.zone,
        logicalId,
        resourceType
      );
    } catch (error) {
      if (error instanceof HostedZoneNameNotFoundError) {
        // The zone is gone, so its records are too. WARN: this drops the
        // state row, so a wrong diagnosis orphans the records silently.
        await alreadyGone();
        this.logger.warn(
          safeMsg`Hosted zone "${String(zoneProps.zone['HostedZoneName'])}" for record set group ${logicalId} (${physicalId}) no longer exists; treating its records as already deleted and dropping the group from state.`
        );
        return;
      }
      throw error;
    }
  }

  if (records.length === 0) return;

  try {
    // Each DELETE carries the LIVE record when the bounded lookup finds it
    // (the recorded values can lag an out-of-band edit), else the recorded
    // one, which Route 53 answers "not found" for when it is really gone.
    const deletes: Array<{ record: Record<string, unknown>; set: ResourceRecordSet }> = [];
    for (const record of records) {
      const bag = recordBag(record);
      const live = await this.findLiveRecordSet(hostedZoneId, bag);
      if (!live) {
        const redactedSkip = redactedDeleteAddressSkip(
          this.logger,
          logicalId,
          'Route 53 record set group',
          redactedDeleteAddressFields(
            Object.fromEntries(RECORD_VALUE_FIELDS.map((f) => [f, record[f]]))
          )
        );
        if (redactedSkip) return redactedSkip;
      }
      deletes.push({ record, set: live ?? this.buildResourceRecordSet(bag) });
    }

    const send = (sets: ResourceRecordSet[]) =>
      this.getClient().send(
        new ChangeResourceRecordSetsCommand({
          HostedZoneId: hostedZoneId,
          ChangeBatch: {
            Changes: sets.map((set): Change => ({ Action: 'DELETE', ResourceRecordSet: set })),
          },
        })
      );
    const sendSettled = async (sets: ResourceRecordSet[]) => {
      try {
        await send(sets);
      } catch (error) {
        // While the zone's AcceleratedRecoveryStatus is transitioning, Route
        // 53 refuses every mutation (issue #1467); wait it out, then retry
        // once. Records delete before their zone, so the zone-side guard has
        // not run yet. Never flips the zone setting from a record delete.
        if (!isZoneDisabledForMutationError(error)) throw error;
        this.logger.info(
          safeMsg`Hosted zone ${hostedZoneId} is mid AcceleratedRecovery transition (marked disabled for mutation); waiting for it to settle before retrying delete of record set group ${logicalId}`
        );
        await this.waitForAcceleratedRecoveryMutable(hostedZoneId, logicalId, resourceType);
        await send(sets);
      }
    };

    try {
      await sendSettled(deletes.map((d) => d.set));
    } catch (error) {
      if (!isRecordNotFoundRefusal(error)) throw error;
      // The batch is all or nothing, so one record already gone refused the
      // whole of it. Delete record by record, where "not found" is about
      // that record alone.
      this.logger.debug(
        safeMsg`Record set group ${logicalId}: the batch delete named a record that is gone; deleting record by record`
      );
      for (const { set } of deletes) {
        try {
          await sendSettled([set]);
        } catch (perRecordError) {
          if (!isRecordNotFoundRefusal(perRecordError)) throw perRecordError;
          await alreadyGone();
        }
      }
    }
    this.logger.debug(safeMsg`Successfully deleted record set group ${logicalId}`);
  } catch (error) {
    if (error instanceof Error && error.name === 'NoSuchHostedZone') {
      await alreadyGone();
      this.logger.debug(
        safeMsg`Hosted zone for record set group ${physicalId} does not exist, skipping deletion`
      );
      return;
    }
    if (error instanceof ProvisioningError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapDeleteError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete record set group ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * The live state of every recorded record, in recorded order, as
 * `{ RecordSets: [...] }`. A record the bounded lookup cannot find makes the
 * whole answer "cannot tell" (`undefined`), as for `AWS::Route53::RecordSet`
 * (go-to-k/cdkd#4283); a missing zone is `RESOURCE_NOT_FOUND`.
 */
export async function readRecordSetGroup(
  this: Route53Provider,
  physicalId: string,
  logicalId: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const parsed = groupRecordSets(properties);
  if ('refusal' in parsed) return undefined;
  const zoneProps = groupZoneProperties(properties ?? {}, parsed.records);
  if ('refusal' in zoneProps) return undefined;
  let hostedZoneId: string;
  try {
    hostedZoneId = await existingGroupZone.call(
      this,
      physicalId,
      zoneProps.zone,
      logicalId,
      RECORD_SET_GROUP_TYPE
    );
  } catch {
    return undefined;
  }

  const observed: Record<string, unknown>[] = [];
  for (const record of parsed.records) {
    const name = record['Name'];
    const type = record['Type'];
    if (typeof name !== 'string' || typeof type !== 'string') return undefined;
    const live = await this.readRecordSetAt({ hostedZoneId, name, type }, recordBag(record));
    if (live === undefined || live === RESOURCE_NOT_FOUND) return live;
    // `readRecordSetAt` answers for a standalone record; inside a group the
    // zone is the group's, so a record shows one only when it declared one.
    const { HostedZoneId: _zoneId, ...rest } = live;
    observed.push({
      ...rest,
      ...(record['HostedZoneId'] !== undefined ? { HostedZoneId: record['HostedZoneId'] } : {}),
      ...(record['HostedZoneName'] !== undefined
        ? { HostedZoneName: record['HostedZoneName'] }
        : {}),
    });
  }
  return { RecordSets: observed };
}

/**
 * Adopt an existing group (`cdkd import --resource <id>=<physicalId>`).
 * OVERRIDE-ONLY, like `AWS::Route53::RecordSet`: a group has no standalone
 * identity for auto mode to key on. The supplied id is CloudFormation's group
 * name (or a cdkd id); the zone and the records come from the template, every
 * record is verified live, and the recorded id is cdkd's composite. Anything
 * cdkd cannot verify keeps the supplied id verbatim, which delete and drift
 * resolve through the recorded properties.
 */
export async function importRecordSetGroup(
  this: Route53Provider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const known = input.knownPhysicalId;
  if (!known) return null;

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
      recordSetGroupCompositeId(hostedZoneId, input.logicalId),
      input.logicalId,
      input.properties
    );
  } catch (err) {
    const head = `Record set group ${input.logicalId}: verification of '${known}' failed: `;
    const reason = `verification failed: ${this.warnFailureText(head, err, undefined).replace(/\.$/, '')}`;
    return unverified(reason);
  }
  if (!observed || observed === RESOURCE_NOT_FOUND) {
    const reason = 'not every record was found under the resolved hosted zone';
    return unverified(reason);
  }
  return { physicalId: recordSetGroupCompositeId(hostedZoneId, input.logicalId), attributes: {} };
}
