import type { Route53Provider } from '../route53-provider.js';
import { Route53Client, type ResourceRecordSet } from '@aws-sdk/client-route-53';
import { ambientClientDefaults } from '../../../utils/ambient-client-defaults.js';
import { hasReplayMayCollide } from '../../../deployment/retryable-errors.js';
import { withoutServerErrorRetries } from '../ambiguous-create.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { generateResourceName } from '../../resource-name.js';
import { isRedactedRecordedValue } from '../../redacted-delete-address.js';
import { normalizeRecordName } from './shared.js';

// Pure helpers and the batch client of `AWS::Route53::RecordSetGroup`
// (`record-set-group.ts`): the physical id, the record and zone shapes read
// off a property bag, record equality, and the refusal classifiers.

export const RECORD_SET_GROUP_TYPE = 'AWS::Route53::RecordSetGroup';

/** The keys that identify a record inside a hosted zone. */
export const RECORD_IDENTITY_FIELDS = ['Name', 'Type', 'SetIdentifier'] as const;

/**
 * The per-record fields a DELETE must match exactly (every field
 * `buildResourceRecordSet` sends), used for the redaction guard when a delete
 * falls back to the recorded values.
 */
export const RECORD_VALUE_FIELDS = [
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
  'AZAffinity',
] as const;

export function recordSetGroupCompositeId(hostedZoneId: string, groupName: string): string {
  return `${hostedZoneId}|${groupName}`;
}

/** The longest group name cdkd generates; long enough never to cut the logical id. */
export const GROUP_NAME_MAX_LENGTH = 255;

/** A new group's name, CloudFormation-shaped: `<StackName>-<LogicalId>-<suffix>`. */
export function generatedGroupName(logicalId: string): string {
  return generateResourceName(logicalId, { maxLength: GROUP_NAME_MAX_LENGTH });
}

/**
 * Whether `name` is a name of THIS group: the logical id itself (a group named
 * outside a stack scope) or a hyphen-delimited name carrying it as one
 * segment, which both cdkd's and CloudFormation's generated names do. A
 * logical id holds no hyphen, so a segment match cannot be a fragment.
 */
export function namesThisGroup(name: string, logicalId: string): boolean {
  return name === logicalId || name.split('-').includes(logicalId);
}

/**
 * The zone and name a cdkd-minted id of THIS group carries, or `undefined`
 * for any other shape (CloudFormation's generated group name, adopted by
 * `cdkd import`). The name must be this group's: two non-empty segments alone
 * are not proof of a cdkd id (the #1711 class).
 */
export function parseRecordSetGroupCompositeId(
  physicalId: string,
  logicalId: string
): { hostedZoneId: string; groupName: string } | undefined {
  const parts = physicalId.split('|');
  if (parts.length !== 2) return undefined;
  const [hostedZoneId, groupName] = parts;
  if (!hostedZoneId || !groupName || !namesThisGroup(groupName, logicalId)) return undefined;
  return { hostedZoneId, groupName };
}

/**
 * The name an existing group keeps across an update: its cdkd id's, else the
 * id itself (CloudFormation's group name, adopted verbatim by `cdkd import`,
 * which holds no `|`). A `<zone>|<name>` id this group does not recognise
 * keeps its name segment when that is one plain segment; anything else falls
 * back to the logical id, so the rewritten id always has exactly two segments.
 */
export function existingGroupName(physicalId: string, logicalId: string): string {
  const parsed = parseRecordSetGroupCompositeId(physicalId, logicalId);
  if (parsed) return parsed.groupName;
  if (!physicalId.includes('|')) return physicalId;
  const parts = physicalId.split('|');
  return parts.length === 2 && parts[1] ? parts[1] : logicalId;
}

/**
 * The group's `RecordSets` as a list of record bags, or a refusal message
 * when the list (or one entry) is not usable. An ABSENT list is the empty
 * list here; a template path refuses one, as CloudFormation does (#6540).
 */
export function groupRecordSets(
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
export function recordSetKey(record: Record<string, unknown>): string | undefined {
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
export function groupZoneProperties(
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
export function recordBag(record: Record<string, unknown>): Record<string, unknown> {
  const { HostedZoneId: _zoneId, HostedZoneName: _zoneName, ...rest } = record;
  return rest;
}

export function groupRefusalError(
  message: string,
  logicalId: string,
  physicalId: string | undefined
): ProvisioningError {
  return new ProvisioningError(message, RECORD_SET_GROUP_TYPE, logicalId, physicalId);
}

/**
 * Equality of two record sets, insensitive to key order and to the spellings
 * Route 53 rewrites (trailing dot and case of the name and of an alias target).
 */
export function sameRecordSet(a: ResourceRecordSet, b: ResourceRecordSet): boolean {
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
export function updateBatchClient(provider: Route53Provider): Route53Client {
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
export function isUnambiguousClientRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ((error as { $fault?: unknown }).$fault !== 'client') return false;
  return !hasReplayMayCollide(error);
}

/**
 * A Route 53 refusal of a DELETE whose values differ from the live record's
 * ("... but the values provided do not match the current values", measured
 * 2026-11-18): the recorded values lag an out-of-band edit.
 */
export function isRecordValuesMismatchRefusal(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'InvalidChangeBatch' &&
    /values provided do not match the current values/i.test(error.message)
  );
}

/** A Route 53 refusal that the record a DELETE names does not exist. */
export function isRecordNotFoundRefusal(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'InvalidChangeBatch' &&
    /but it was not found/i.test(error.message)
  );
}

/** How a group names itself in a hosted-zone lookup's refusal. */
export const groupSubject = {
  noun: 'record set group',
  remedy: 'set HostedZoneId explicitly',
};
