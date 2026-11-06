import type { Route53Provider } from '../route53-provider.js';
import {
  GetHostedZoneCommand,
  ListQueryLoggingConfigsCommand,
  ListResourceRecordSetsCommand,
  ListTagsForResourceCommand,
  type RRType,
} from '@aws-sdk/client-route-53';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import { canonicalizeRoute53QueryName as canonicalizeQueryName } from '../../composite-id.js';
import type { ResourceNotFound } from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { isUsableAttemptedName } from '../../../state/unsettled-properties.js';
import {
  ACCELERATED_RECOVERY_ON_STATUSES,
  normalizeRecordName,
  declaresNoVpcs,
  declaredVpcIds,
} from './shared.js';

/**
 * Read the AWS-current Route 53 resource configuration in CFn-property shape.
 *
 * Dispatch per resource type:
 *  - `HostedZone` → `GetHostedZone` (Name, HostedZoneConfig{Comment,
 *    PrivateZone}, VPCs from `VPCs[]`, HostedZoneTags via
 *    `ListTagsForResource(ResourceType=hostedzone, ResourceId=<idTail>)`
 *    with `aws:*` filtered out and the key omitted when empty).
 *    QueryLoggingConfig is surfaced via a follow-up
 *    `ListQueryLoggingConfigs(HostedZoneId)` (filter to the one
 *    config per zone — CFn enforces 0 or 1 — and reshape
 *    `CloudWatchLogsLogGroupArn` to match cdkd state).
 *  - `RecordSet` → `ListResourceRecordSets` filtered to the exact
 *    `(name, type)` pair from the composite physicalId
 *    (`{zoneId}|{name}|{type}`), or — for a state record carrying
 *    CloudFormation's scalar physicalId, written by `cdkd import`
 *    before issue #1658 — from the recorded properties, so drift is
 *    reported for those records instead of silently skipped.
 *    Surfaces TTL, ResourceRecords (with
 *    `[{Value}]` -> string[] re-shape to match cdkd state), AliasTarget,
 *    Weight, Region, Failover, MultiValueAnswer, HealthCheckId,
 *    GeoLocation, GeoProximityLocation, CidrRoutingConfig, SetIdentifier.
 *
 * Returns `RESOURCE_NOT_FOUND` when the zone (or the parent zone of a
 * record) is gone (`NoSuchHostedZone`); `undefined` for another type, a
 * record whose zone cannot be resolved, or a record the bounded listing
 * window does not show (cdkd's matcher, not AWS, missed it).
 */
export async function readCurrentState(
  this: Route53Provider,
  physicalId: string,
  _logicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  switch (resourceType) {
    case 'AWS::Route53::HostedZone':
      return this.readHostedZone(physicalId, properties);
    case 'AWS::Route53::RecordSet':
      return this.readRecordSet(physicalId, properties);
    default:
      return undefined;
  }
}

/**
 * go-to-k/cdkd#5487: `readCurrentState` for the engine's convergence step,
 * with two differences. A failed `QueryLoggingConfig` read throws, where
 * `readCurrentState` reports no config, which would make an unsettled removal
 * skip the delete. And `VPCs` keeps only what the record, the template or an
 * earlier attempt (#5498) names: the convergence puts this on the previous
 * side, so a VPC associated out of band would read as dropped by the
 * template. A desired side declaring no VPCs leaves them out, since nothing
 * applies them (see {@link VPCS_KEPT_ON_REMOVAL_NOTE}) and nothing can settle.
 */
export async function readUnsettled(
  this: Route53Provider,
  physicalId: string,
  logicalId: string,
  resourceType: string,
  names: ReadonlySet<string>,
  recordedProperties?: Record<string, unknown>,
  desiredProperties?: Record<string, unknown>,
  attemptedItems?: ReadonlyMap<string, ReadonlySet<string>>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  if (resourceType !== 'AWS::Route53::HostedZone') {
    return this.readCurrentState(physicalId, logicalId, resourceType, recordedProperties);
  }
  const live = await this.readHostedZone(
    physicalId,
    recordedProperties,
    names.has('QueryLoggingConfig')
  );
  if (live === undefined || live === RESOURCE_NOT_FOUND) return live;
  if (!names.has('VPCs') || !Array.isArray(live['VPCs'])) return live;
  const { VPCs: liveVpcs, ...rest } = live;
  if (declaresNoVpcs(desiredProperties?.['VPCs'])) return rest;
  const named = new Set<unknown>([
    ...declaredVpcIds(recordedProperties?.['VPCs']),
    ...declaredVpcIds(desiredProperties?.['VPCs']),
    ...[...(attemptedItems?.get('VPCs') ?? [])].filter(isUsableAttemptedName),
  ]);
  return {
    ...rest,
    VPCs: (liveVpcs as Array<Record<string, unknown>>).filter((vpc) => named.has(vpc['VPCId'])),
  };
}

/** A zone's associations carry no order, in the template or in AWS's answer. */
export function getDriftUnorderedPaths(this: Route53Provider, resourceType: string): string[] {
  return resourceType === 'AWS::Route53::HostedZone' ? ['VPCs'] : [];
}

export async function readHostedZone(
  this: Route53Provider,
  physicalId: string,
  properties?: Record<string, unknown>,
  throwOnFailedQueryLoggingRead = false
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let resp;
  try {
    resp = await this.getClient().send(new GetHostedZoneCommand({ Id: physicalId }));
  } catch (err) {
    if (err instanceof Error && err.name === 'NoSuchHostedZone') return RESOURCE_NOT_FOUND;
    throw err;
  }
  if (!resp.HostedZone) return undefined;

  const result: Record<string, unknown> = {};
  if (resp.HostedZone.Name !== undefined) result['Name'] = resp.HostedZone.Name;
  {
    const cfg: Record<string, unknown> = {
      Comment: resp.HostedZone.Config?.Comment ?? '',
    };
    if (resp.HostedZone.Config?.PrivateZone !== undefined) {
      cfg['PrivateZone'] = resp.HostedZone.Config.PrivateZone;
    }
    result['HostedZoneConfig'] = cfg;
  }
  // go-to-k/cdkd#2762: `DelegationSet.Id` is present only for a zone on a
  // reusable delegation set, and always as `/delegationset/<id>` whichever
  // form created it (measured us-east-1, 2026-10-27). Emitted bare, as Cloud
  // Control reports it, unless the declaration spells this same id in the
  // prefixed form: CreateHostedZone accepts both, and a record in the other
  // spelling would never match the readback. Immutable on create, so no
  // placeholder.
  if (resp.DelegationSet?.Id !== undefined) {
    const bare = resp.DelegationSet.Id.replace(/^\/delegationset\//, '');
    result['DelegationSetId'] =
      properties?.['DelegationSetId'] === `/delegationset/${bare}`
        ? `/delegationset/${bare}`
        : bare;
  }
  // `HostedZoneFeatures.EnableAcceleratedRecovery`: emit-when-present
  // (gated on `!== undefined`, NOT a default-when-absent placeholder).
  // GetHostedZone returns `HostedZone.Features?.AcceleratedRecoveryStatus`
  // only when the feature was explicitly toggled (zones older than the
  // 2025 feature launch may return undefined indefinitely); emitting a
  // phantom `{ EnableAcceleratedRecovery: false }` placeholder would force
  // guaranteed drift on every clean run for the typical zone that never
  // opted in. The read-side status maps onto the template's boolean
  // (issue #5465): an enabling transition is the declared `true`.
  const acceleratedRecoveryStatus = resp.HostedZone.Features?.AcceleratedRecoveryStatus;
  if (acceleratedRecoveryStatus !== undefined) {
    result['HostedZoneFeatures'] = {
      EnableAcceleratedRecovery: ACCELERATED_RECOVERY_ON_STATUSES.has(acceleratedRecoveryStatus),
    };
  }

  // Class 1: VPCs is a private-zone-only field. AWS rejects
  // AssociateVPCWithHostedZone on public zones, and emitting an empty
  // [] placeholder on a public zone fires false drift against state
  // that has no VPCs key. Gate on PrivateZone === true (the
  // discriminator) so public zones don't carry the placeholder.
  if (resp.HostedZone.Config?.PrivateZone === true) {
    result['VPCs'] = (resp.VPCs ?? []).map((v) => {
      const out: Record<string, unknown> = {};
      if (v.VPCId !== undefined) out['VPCId'] = v.VPCId;
      if (v.VPCRegion !== undefined) out['VPCRegion'] = v.VPCRegion;
      return out;
    });
  }

  // HostedZoneTags via ListTagsForResource. Route 53 ResourceId is the
  // zone id WITHOUT the "/hostedzone/" prefix.
  const idTail = physicalId.replace(/^\/hostedzone\//, '');
  try {
    const tagsResp = await this.getClient().send(
      new ListTagsForResourceCommand({ ResourceType: 'hostedzone', ResourceId: idTail })
    );
    const tags = normalizeAwsTagsToCfn(tagsResp.ResourceTagSet?.Tags);
    result['HostedZoneTags'] = tags;
  } catch (err) {
    this.logger.debug(
      `Route53 ListTagsForResource(${idTail}) failed: ${describeAwsFailure(err).detail}`
    );
  }

  // QueryLoggingConfig via ListQueryLoggingConfigs filtered to this
  // zone. CFn enforces 0 or 1 config per zone. Always-emit `{}`
  // placeholder when AWS has none — the union-walk on the v3
  // observedProperties baseline catches a console-side ADD of a
  // CloudWatchLogsLogGroupArn against the empty placeholder.
  try {
    const qlcResp = await this.getClient().send(
      new ListQueryLoggingConfigsCommand({ HostedZoneId: idTail })
    );
    const qlc = qlcResp.QueryLoggingConfigs?.[0];
    if (qlc?.CloudWatchLogsLogGroupArn) {
      result['QueryLoggingConfig'] = {
        CloudWatchLogsLogGroupArn: qlc.CloudWatchLogsLogGroupArn,
      };
    } else {
      result['QueryLoggingConfig'] = {};
    }
  } catch (err) {
    this.logger.debug(
      `Route53 ListQueryLoggingConfigs(${idTail}) failed: ${describeAwsFailure(err).detail}`
    );
    if (throwOnFailedQueryLoggingRead) throw err;
    result['QueryLoggingConfig'] = {};
  }

  return result;
}

export async function readRecordSet(
  this: Route53Provider,
  physicalId: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const identity = await this.resolveRecordSetIdentity(physicalId, properties);
  if (!identity) return undefined;
  return this.readRecordSetAt(identity, properties);
}

/** {@link readRecordSet} for an identity already resolved. */
export async function readRecordSetAt(
  this: Route53Provider,
  identity: { hostedZoneId: string; name: string; type: string },
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const { hostedZoneId, name, type } = identity;
  // Weighted / latency / failover / geo records share name + type and
  // differ only by SetIdentifier, so without it the read returns whichever
  // sibling sorts first — and `drift --revert` then hands THAT record to
  // `update()` as the previous side (issue #3741 review). Match the recorded
  // SetIdentifier (absent means "the record without one") whenever the
  // recorded bag is present and readable; with no bag (the import
  // verification), a malformed value or a redacted `{{resolve:...}}` one
  // (`recordIdentityChanged`'s uncomparable case), keep the name + type match.
  const recordedSetIdentifier = properties?.['SetIdentifier'];
  const matchSetIdentifier =
    properties !== undefined &&
    (recordedSetIdentifier === undefined ||
      (typeof recordedSetIdentifier === 'string' && !recordedSetIdentifier.includes('{{resolve:')));
  const setIdentifier =
    typeof recordedSetIdentifier === 'string' ? recordedSetIdentifier : undefined;

  let resp;
  try {
    resp = await this.getClient().send(
      new ListResourceRecordSetsCommand({
        HostedZoneId: hostedZoneId,
        // Encoded start key, for the reason `canonicalizeQueryName`
        // records: AWS orders records on the name it STORES, so a template
        // spelling `*.example.com` positions at `*` (0x2A) while the record
        // sits at `\\052…` (0x5C) — every sibling whose first label starts
        // with `-` / `+` / a digit / an upper-case letter falls between
        // them, and a bounded page skips the record we asked for. Decoding
        // on the COMPARE side alone cannot fix that; the query has to
        // return the record first.
        StartRecordName: canonicalizeQueryName(name),
        StartRecordType: type as RRType,
        ...(matchSetIdentifier &&
          setIdentifier !== undefined && { StartRecordIdentifier: setIdentifier }),
        // Still > 1 after the encoding fix: a name can also carry escapes
        // this helper does not encode, and a few extra rows are free.
        MaxItems: 5,
      })
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'NoSuchHostedZone') return RESOURCE_NOT_FOUND;
    throw err;
  }

  // ListResourceRecordSets returns records in lexicographic order starting
  // at StartRecordName/Type; the first match is exact only when both name
  // and type match what we asked for. Compare on the fully-qualified name:
  // AWS always reports the trailing dot, a template may declare it either
  // way, and the composite physicalId carries whatever the template wrote.
  const wantedName = normalizeRecordName(name);
  const recordSet = resp.ResourceRecordSets?.find(
    (r) =>
      r.Name !== undefined &&
      normalizeRecordName(r.Name) === wantedName &&
      r.Type === type &&
      (!matchSetIdentifier || r.SetIdentifier === setIdentifier)
  );
  // A miss in this bounded window is cdkd's matcher failing to find the
  // record (a name escape the query does not encode, a page boundary), not
  // AWS saying it is gone: keep "cannot tell" (go-to-k/cdkd#4283).
  if (!recordSet) return undefined;

  const result: Record<string, unknown> = {
    HostedZoneId: hostedZoneId,
    Name: name,
    Type: type,
  };
  // Class 1: TTL and ResourceRecords are mutually exclusive with
  // AliasTarget — AWS rejects ChangeResourceRecordSets that carries
  // both. Gate the standard-record fields on `!AliasTarget` so an
  // alias record's observed snapshot does NOT carry placeholder
  // `TTL` / `ResourceRecords: []` that would (a) fire false drift
  // against state which legitimately lacks those keys and (b) round-
  // trip into a structurally-invalid ChangeResourceRecordSets input
  // if buildResourceRecordSet is ever changed to forward both.
  if (!recordSet.AliasTarget) {
    if (recordSet.TTL !== undefined) result['TTL'] = recordSet.TTL;
    // CFn / cdkd state shape is string[]; SDK is [{Value}].
    result['ResourceRecords'] = (recordSet.ResourceRecords ?? [])
      .map((r) => r.Value)
      .filter((v): v is string => typeof v === 'string');
  }
  if (recordSet.AliasTarget) {
    const at: Record<string, unknown> = {};
    if (recordSet.AliasTarget.HostedZoneId !== undefined) {
      at['HostedZoneId'] = recordSet.AliasTarget.HostedZoneId;
    }
    if (recordSet.AliasTarget.DNSName !== undefined) {
      at['DNSName'] = recordSet.AliasTarget.DNSName;
    }
    if (recordSet.AliasTarget.EvaluateTargetHealth !== undefined) {
      at['EvaluateTargetHealth'] = recordSet.AliasTarget.EvaluateTargetHealth;
    }
    result['AliasTarget'] = at;
  }
  if (recordSet.SetIdentifier !== undefined) result['SetIdentifier'] = recordSet.SetIdentifier;
  if (recordSet.Weight !== undefined) result['Weight'] = recordSet.Weight;
  if (recordSet.Region !== undefined) result['Region'] = recordSet.Region;
  if (recordSet.Failover !== undefined) result['Failover'] = recordSet.Failover;
  if (recordSet.MultiValueAnswer !== undefined) {
    result['MultiValueAnswer'] = recordSet.MultiValueAnswer;
  }
  if (recordSet.HealthCheckId !== undefined) result['HealthCheckId'] = recordSet.HealthCheckId;
  if (recordSet.GeoLocation) {
    const geo: Record<string, unknown> = {};
    if (recordSet.GeoLocation.ContinentCode !== undefined) {
      geo['ContinentCode'] = recordSet.GeoLocation.ContinentCode;
    }
    if (recordSet.GeoLocation.CountryCode !== undefined) {
      geo['CountryCode'] = recordSet.GeoLocation.CountryCode;
    }
    if (recordSet.GeoLocation.SubdivisionCode !== undefined) {
      geo['SubdivisionCode'] = recordSet.GeoLocation.SubdivisionCode;
    }
    result['GeoLocation'] = geo;
  }
  if (recordSet.GeoProximityLocation) {
    const gpl: Record<string, unknown> = {};
    if (recordSet.GeoProximityLocation.AWSRegion !== undefined) {
      gpl['AWSRegion'] = recordSet.GeoProximityLocation.AWSRegion;
    }
    if (recordSet.GeoProximityLocation.LocalZoneGroup !== undefined) {
      gpl['LocalZoneGroup'] = recordSet.GeoProximityLocation.LocalZoneGroup;
    }
    if (recordSet.GeoProximityLocation.Coordinates) {
      const coords: Record<string, unknown> = {};
      if (recordSet.GeoProximityLocation.Coordinates.Latitude !== undefined) {
        coords['Latitude'] = recordSet.GeoProximityLocation.Coordinates.Latitude;
      }
      if (recordSet.GeoProximityLocation.Coordinates.Longitude !== undefined) {
        coords['Longitude'] = recordSet.GeoProximityLocation.Coordinates.Longitude;
      }
      gpl['Coordinates'] = coords;
    }
    if (recordSet.GeoProximityLocation.Bias !== undefined) {
      gpl['Bias'] = recordSet.GeoProximityLocation.Bias;
    }
    result['GeoProximityLocation'] = gpl;
  }
  if (recordSet.CidrRoutingConfig) {
    const crc: Record<string, unknown> = {};
    if (recordSet.CidrRoutingConfig.CollectionId !== undefined) {
      crc['CollectionId'] = recordSet.CidrRoutingConfig.CollectionId;
    }
    if (recordSet.CidrRoutingConfig.LocationName !== undefined) {
      crc['LocationName'] = recordSet.CidrRoutingConfig.LocationName;
    }
    result['CidrRoutingConfig'] = crc;
  }
  return result;
}
