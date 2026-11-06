import type { Route53Provider } from '../route53-provider.js';
import {
  ChangeResourceRecordSetsCommand,
  ListResourceRecordSetsCommand,
  type Change,
  type ResourceRecordSet,
  type RRType,
} from '@aws-sdk/client-route-53';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markNameCollision } from '../../../deployment/retryable-errors.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { canonicalizeRoute53QueryName as canonicalizeQueryName } from '../../composite-id.js';
import type {
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  UpdateContext,
} from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  redactedDeleteAddressFields,
  redactedDeleteAddressSkip,
} from '../../redacted-delete-address.js';
import {
  isZoneDisabledForMutationError,
  HostedZoneNameNotFoundError,
  parseRecordSetCompositeId,
  recordSetCompositeId,
  normalizeRecordName,
  isCnameConflictRefusal,
  CNAME_CONFLICT_COLLISION_NOTE,
  recordIdentityChanged,
} from './shared.js';

// ─── AWS::Route53::RecordSet ───────────────────────────────────────
export async function createRecordSet(
  this: Route53Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  mask: ((text: string) => string) | undefined
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating Route 53 record set ${logicalId}`);

  const hostedZoneId = await this.resolveHostedZoneId(properties, logicalId, resourceType);

  const recordName = properties['Name'] as string;
  const recordType = properties['Type'] as string;

  // Built directly rather than through `packCompositeId`, which would refuse
  // a record name carrying `|` (issue #3890): every reader of this id places
  // the name between the first and the last separator and anchors it on the
  // recorded `Name` / `Type` (`parseRecordSetCompositeId`).
  const compositeId = recordSetCompositeId(hostedZoneId, recordName, recordType);

  try {
    const resourceRecordSet = this.buildResourceRecordSet(properties);

    const comment = properties['Comment'] as string | undefined;

    await this.getClient().send(
      new ChangeResourceRecordSetsCommand({
        HostedZoneId: hostedZoneId,
        ChangeBatch: {
          ...(comment ? { Comment: comment } : {}),
          Changes: [
            {
              Action: 'CREATE',
              ResourceRecordSet: resourceRecordSet,
            },
          ],
        },
      })
    );

    this.logger.debug(`Successfully created record set ${logicalId}: ${compositeId}`);

    return {
      physicalId: compositeId,
      attributes: {},
    };
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    const cause = error instanceof Error ? error : undefined;
    const cnameConflict = isCnameConflictRefusal(error);
    const wrapped = this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create record set ${logicalId}` +
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

export async function updateRecordSet(
  this: Route53Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating Route 53 record set ${logicalId}: ${physicalId}`);

  const hostedZoneId = await this.resolveHostedZoneId(
    properties,
    logicalId,
    resourceType,
    physicalId
  );

  const recordName = properties['Name'] as string;
  const recordType = properties['Type'] as string;

  // Re-built from the new `Name` / `Type`, which the engine records beside
  // it, so the id always anchors on its own record (issue #3890; see the
  // create site).
  const compositeId = recordSetCompositeId(hostedZoneId, recordName, recordType);

  // Issue #3741: Route 53 keys a record on name + type + SetIdentifier, so a
  // change to any of the three is a DIFFERENT record, and the UPSERT below
  // would create it beside the old one — which stayed live, untracked, and
  // out of `cdkd destroy`'s reach. CloudFormation replaces the record (live
  // A/B on the issue), so this deletes the old record and creates the new
  // one in ONE atomic ChangeBatch rather than reporting a replacement to the
  // engine: the engine's replacement creates first, which Route 53 refuses
  // whenever the two records conflict (an A -> CNAME swap on one name, or a
  // simple record becoming a weighted one), while a batch is applied all or
  // nothing, so a refused CREATE leaves the old record serving.
  //
  // Never on `cdkd drift --revert` (`desiredFromAwsReadback`): it restores a
  // record's VALUES, never its identity, and there the previous side is a
  // readback whose identity is only as good as the lookup that produced it.
  const identityChanged =
    context?.desiredFromAwsReadback !== true &&
    recordIdentityChanged(previousProperties, properties);

  try {
    const resourceRecordSet = this.buildResourceRecordSet(properties);

    const comment = properties['Comment'] as string | undefined;

    // The DELETE carries the LIVE record verbatim — Route 53 refuses a DELETE
    // whose values differ from what it holds, and the recorded properties
    // can lag the live record (an out-of-band edit, or an earlier binary's
    // narrowing). No live old record (already removed, or a retry after a
    // batch that committed before state was saved) leaves only the new
    // record to write, which the UPSERT does idempotently.
    const liveOldRecord = identityChanged
      ? await this.findLiveRecordSet(hostedZoneId, previousProperties)
      : undefined;
    if (identityChanged && !liveOldRecord) {
      this.logger.debug(
        safeMsg`Record set ${logicalId}: the previous record is not live in ${hostedZoneId}; writing the renamed record only`
      );
    }
    const changes: Change[] = liveOldRecord
      ? [
          { Action: 'DELETE', ResourceRecordSet: liveOldRecord },
          { Action: 'CREATE', ResourceRecordSet: resourceRecordSet },
        ]
      : [{ Action: 'UPSERT', ResourceRecordSet: resourceRecordSet }];

    await this.getClient().send(
      new ChangeResourceRecordSetsCommand({
        HostedZoneId: hostedZoneId,
        ChangeBatch: {
          ...(comment ? { Comment: comment } : {}),
          Changes: changes,
        },
      })
    );

    this.logger.debug(`Successfully updated record set ${logicalId}`);

    return {
      physicalId: compositeId,
      // A renamed record IS a new physical record, whatever the composite id
      // (which omits SetIdentifier) says. For a SetIdentifier-only rename the
      // id is unchanged, so the engine logs "replaced: X -> X".
      wasReplaced: identityChanged,
      attributes: {},
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update record set ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * The live record `properties` identify (name, type, SetIdentifier), exactly
 * as Route 53 holds it — what a DELETE must carry — or `undefined` when no
 * such record exists.
 */
export async function findLiveRecordSet(
  this: Route53Provider,
  hostedZoneId: string,
  properties: Record<string, unknown>
): Promise<ResourceRecordSet | undefined> {
  const name = properties['Name'] as string;
  const type = properties['Type'] as string;
  const setIdentifier =
    typeof properties['SetIdentifier'] === 'string' ? properties['SetIdentifier'] : undefined;
  const resp = await this.getClient().send(
    new ListResourceRecordSetsCommand({
      HostedZoneId: hostedZoneId,
      // Encoded start key: see `canonicalizeQueryName` and `readRecordSet`.
      StartRecordName: canonicalizeQueryName(name),
      StartRecordType: type as RRType,
      ...(setIdentifier !== undefined && { StartRecordIdentifier: setIdentifier }),
      MaxItems: 5,
    })
  );
  const wantedName = normalizeRecordName(name);
  return resp.ResourceRecordSets?.find(
    (r) =>
      r.Name !== undefined &&
      normalizeRecordName(r.Name) === wantedName &&
      r.Type === type &&
      r.SetIdentifier === setIdentifier
  );
}

export async function deleteRecordSet(
  this: Route53Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  this.logger.debug(`Deleting Route 53 record set ${logicalId}: ${physicalId}`);

  // We need the full record details for DELETE action
  if (!properties) {
    throw new ProvisioningError(
      `Properties required to delete record set ${logicalId}`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  // go-to-k/cdkd#3952: a record-set DELETE must match the live record set
  // EXACTLY, so every field `buildResourceRecordSet` sends is part of the
  // address, and the InvalidChangeBatch arm below reads any mismatch as
  // "already deleted" -- a TXT value (or a HealthCheckId, a Weight) holding
  // the mask of a NoEcho value would DROP the record over a live DNS record.
  const redactedSkip = redactedDeleteAddressSkip(
    this.logger,
    logicalId,
    'Route 53 record set',
    redactedDeleteAddressFields({
      Name: properties['Name'],
      Type: properties['Type'],
      TTL: properties['TTL'],
      ResourceRecords: properties['ResourceRecords'],
      AliasTarget: properties['AliasTarget'],
      SetIdentifier: properties['SetIdentifier'],
      Weight: properties['Weight'],
      Region: properties['Region'],
      Failover: properties['Failover'],
      MultiValueAnswer: properties['MultiValueAnswer'],
      HealthCheckId: properties['HealthCheckId'],
      GeoLocation: properties['GeoLocation'],
      GeoProximityLocation: properties['GeoProximityLocation'],
      CidrRoutingConfig: properties['CidrRoutingConfig'],
    })
  );
  if (redactedSkip) return redactedSkip;

  // Parse composite ID: hostedZoneId|name|type. A physicalId that is NOT
  // the composite is CloudFormation's own form (the record name alone —
  // what `Ref` returns), written into state by `cdkd import` before issue
  // #1658. Throwing there left every migrated stack undestroyable, so fall
  // back to resolving the zone from the recorded properties — the delete
  // only needs segment 1; `Name` / `Type` come from `properties` anyway.
  // The parse is CROSS-CHECKED against the recorded properties (issue #1711):
  // three non-empty segments is not proof of a composite, so a record NAME
  // carrying two pipes — `a|b|c.example.com.`, the CloudFormation physicalId
  // `--migrate-from-cloudformation` pre-populates — decoded to hosted zone
  // `a`, and this delete then issued `ChangeResourceRecordSets` against a
  // zone that does not exist, took the `NoSuchHostedZone` already-deleted arm
  // and reported SUCCESS while the real record stayed live and billing. This
  // is the site where that class actually costs something, which is why the
  // check is applied at all three parse sites rather than only at `import`.
  const parsedComposite = parseRecordSetCompositeId(physicalId);
  const composite =
    parsedComposite && this.compositeAgreesWithTemplate(parsedComposite, properties)
      ? parsedComposite
      : undefined;
  let hostedZoneId: string;
  if (composite) {
    hostedZoneId = composite.hostedZoneId;
  } else {
    // The zone comes from the recorded properties only on this arm; a
    // composite physicalId above already addresses it (#3952).
    const redactedZoneSkip = redactedDeleteAddressSkip(
      this.logger,
      logicalId,
      'Route 53 record set',
      redactedDeleteAddressFields({
        HostedZoneId: properties['HostedZoneId'],
        HostedZoneName: properties['HostedZoneName'],
      })
    );
    if (redactedZoneSkip) return redactedZoneSkip;
    try {
      hostedZoneId = await this.resolveHostedZoneId(
        properties,
        logicalId,
        resourceType,
        physicalId,
        {
          // A DELETE resolved from a name must not guess between a public
          // and a private zone of the same name — deleting from the wrong
          // one is unrecoverable, and this fallback is what newly routes
          // delete here.
          requireUnambiguousZoneName: true,
        }
      );
    } catch (error) {
      if (error instanceof HostedZoneNameNotFoundError) {
        // The zone is gone, so its records are too. Delete is idempotent.
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        // WARN, not debug: this drops the state row, so if the diagnosis is
        // ever wrong the record is silently orphaned in AWS.
        this.logger.warn(
          `Hosted zone "${String(properties?.['HostedZoneName'])}" for record set ${logicalId} ` +
            `(${physicalId}) no longer exists; treating the record as already deleted and ` +
            `dropping it from state.`
        );
        return;
      }
      throw error;
    }
  }

  try {
    const resourceRecordSet = this.buildResourceRecordSet(properties);

    const sendDelete = () =>
      this.getClient().send(
        new ChangeResourceRecordSetsCommand({
          HostedZoneId: hostedZoneId,
          ChangeBatch: {
            Changes: [
              {
                Action: 'DELETE',
                ResourceRecordSet: resourceRecordSet,
              },
            ],
          },
        })
      );

    try {
      await sendDelete();
    } catch (error) {
      // While the zone's AcceleratedRecoveryStatus is transitioning
      // (ENABLING / DISABLING / *_HOSTED_ZONE_LOCKED), Route 53 refuses
      // EVERY mutation with "HostedZone <id> is marked disabled for
      // mutation" (issue #1467). Record sets are deleted BEFORE the zone
      // in the destroy DAG, so the zone-side pre-delete guard
      // (`ensureAcceleratedRecoveryDisabledForDelete`) never runs first.
      // Wait for the transition to settle (ENABLED is fine — mutations
      // are allowed again; deliberately NOT disabling the feature here,
      // since a record-only delete must not flip a zone-level setting),
      // then retry the change once.
      if (!isZoneDisabledForMutationError(error)) throw error;
      this.logger.info(
        `Hosted zone ${hostedZoneId} is mid AcceleratedRecovery transition (marked disabled for mutation); waiting for it to settle before retrying delete of record set ${logicalId}`
      );
      await this.waitForAcceleratedRecoveryMutable(hostedZoneId, logicalId, resourceType);
      await sendDelete();
    }

    this.logger.debug(`Successfully deleted record set ${logicalId}`);
  } catch (error) {
    // Treat "not found" errors as success for idempotency
    if (
      error instanceof Error &&
      (error.name === 'InvalidChangeBatch' || error.message.includes('it was not found'))
    ) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`Record set ${physicalId} does not exist, skipping deletion`);
      return;
    }
    if (error instanceof Error && error.name === 'NoSuchHostedZone') {
      this.logger.debug(
        `Hosted zone for record set ${physicalId} does not exist, skipping deletion`
      );
      return;
    }
    // Preserve actionable ProvisioningError messages thrown by
    // `waitForAcceleratedRecoveryMutable` (the `*_FAILED`
    // operator-recovery prompt and the settle timeout) — re-wrapping them
    // with the generic "Failed to delete record set" prefix would bury the
    // actionable text in the `cause` chain and swap the error's physicalId
    // from the zone id to the composite record id. Mirrors the same guard
    // in `deleteHostedZone`.
    if (error instanceof ProvisioningError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapDeleteError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete record set ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

/**
 * Build a ResourceRecordSet object from CDK properties.
 *
 * Handles conversion of CDK-style ResourceRecords (array of strings)
 * to SDK-style ResourceRecords (array of {Value}).
 * Also handles routing policy properties: Weight, Region, Failover,
 * MultiValueAnswer, GeoLocation, GeoProximityLocation, CidrRoutingConfig,
 * SetIdentifier, and HealthCheckId.
 */
export function buildResourceRecordSet(
  this: Route53Provider,
  properties: Record<string, unknown>
): ResourceRecordSet {
  const name = properties['Name'] as string;
  const type = properties['Type'] as string;
  const ttl = properties['TTL'] as string | number | undefined;
  const resourceRecords = properties['ResourceRecords'] as unknown[] | undefined;
  const aliasTarget = properties['AliasTarget'] as Record<string, unknown> | undefined;

  const recordSet: ResourceRecordSet = {
    Name: name,
    Type: type as RRType,
  };

  if (aliasTarget) {
    recordSet.AliasTarget = {
      HostedZoneId: aliasTarget['HostedZoneId'] as string,
      DNSName: aliasTarget['DNSName'] as string,
      EvaluateTargetHealth: (aliasTarget['EvaluateTargetHealth'] as boolean) ?? false,
    };
  } else {
    // Standard record with TTL and ResourceRecords
    if (ttl !== undefined) {
      recordSet.TTL = Number(ttl);
    }

    if (resourceRecords) {
      // CDK provides ResourceRecords as array of strings,
      // SDK expects array of {Value: string}
      recordSet.ResourceRecords = resourceRecords.map((record) => {
        if (typeof record === 'string') {
          return { Value: record };
        }
        // Already in {Value: string} format
        return record as { Value: string };
      });
    }
  }

  // Routing policy properties — use `!== undefined` (not truthy) so a
  // valid falsy value from observedProperties (e.g. weight=0) is not
  // silently dropped on `cdkd drift --revert` round-trips.
  const setIdentifier = properties['SetIdentifier'] as string | undefined;
  if (setIdentifier !== undefined) {
    recordSet.SetIdentifier = setIdentifier;
  }

  const weight = properties['Weight'] as number | string | undefined;
  if (weight !== undefined) {
    recordSet.Weight = Number(weight);
  }

  const region = properties['Region'] as string | undefined;
  if (region !== undefined) {
    recordSet.Region = region as ResourceRecordSet['Region'];
  }

  const failover = properties['Failover'] as string | undefined;
  if (failover !== undefined) {
    recordSet.Failover = failover as ResourceRecordSet['Failover'];
  }

  const multiValueAnswer = properties['MultiValueAnswer'] as boolean | string | undefined;
  if (multiValueAnswer !== undefined) {
    recordSet.MultiValueAnswer =
      typeof multiValueAnswer === 'string'
        ? multiValueAnswer.toLowerCase() === 'true'
        : multiValueAnswer;
  }

  const healthCheckId = properties['HealthCheckId'] as string | undefined;
  if (healthCheckId !== undefined) {
    recordSet.HealthCheckId = healthCheckId;
  }

  const geoLocation = properties['GeoLocation'] as Record<string, unknown> | undefined;
  if (geoLocation) {
    recordSet.GeoLocation = {
      ...(geoLocation['ContinentCode'] !== undefined
        ? { ContinentCode: geoLocation['ContinentCode'] as string }
        : {}),
      ...(geoLocation['CountryCode'] !== undefined
        ? { CountryCode: geoLocation['CountryCode'] as string }
        : {}),
      ...(geoLocation['SubdivisionCode'] !== undefined
        ? { SubdivisionCode: geoLocation['SubdivisionCode'] as string }
        : {}),
    };
  }

  // Geoproximity routing — the CFn `GeoProximityLocation` object shares the
  // SDK PascalCase shape (`AWSRegion` / `LocalZoneGroup` /
  // `Coordinates: { Latitude, Longitude }` / `Bias`). Map each sub-field
  // when present (omit-when-absent) so a falsy value (e.g. `Bias: 0`) is not
  // dropped. AWS requires exactly one anchor (AWSRegion / LocalZoneGroup /
  // Coordinates) per request; cdkd forwards whatever the template supplied.
  const geoProximityLocation = properties['GeoProximityLocation'] as
    | Record<string, unknown>
    | undefined;
  if (geoProximityLocation) {
    const gpl: ResourceRecordSet['GeoProximityLocation'] = {};
    if (geoProximityLocation['AWSRegion'] !== undefined) {
      gpl.AWSRegion = geoProximityLocation['AWSRegion'] as string;
    }
    if (geoProximityLocation['LocalZoneGroup'] !== undefined) {
      gpl.LocalZoneGroup = geoProximityLocation['LocalZoneGroup'] as string;
    }
    const coordinates = geoProximityLocation['Coordinates'] as Record<string, unknown> | undefined;
    if (coordinates) {
      gpl.Coordinates = {
        Latitude: coordinates['Latitude'] as string,
        Longitude: coordinates['Longitude'] as string,
      };
    }
    if (geoProximityLocation['Bias'] !== undefined) {
      gpl.Bias = Number(geoProximityLocation['Bias']);
    }
    recordSet.GeoProximityLocation = gpl;
  }

  // CIDR routing — the CFn `CidrRoutingConfig` object shares the SDK
  // PascalCase shape (`CollectionId` / `LocationName`). Map each sub-field
  // when present (omit-when-absent). CIDR routing is a routing policy, so a
  // `CidrRoutingConfig` RecordSet REQUIRES a `SetIdentifier` and the named
  // `CollectionId` must reference an existing `AWS::Route53::CidrCollection`
  // (Cloud-Control-provisioned by cdkd); cdkd forwards whatever the template
  // supplied and lets AWS validate.
  const cidrRoutingConfig = properties['CidrRoutingConfig'] as Record<string, unknown> | undefined;
  if (cidrRoutingConfig) {
    const crc: ResourceRecordSet['CidrRoutingConfig'] = {} as NonNullable<
      ResourceRecordSet['CidrRoutingConfig']
    >;
    if (cidrRoutingConfig['CollectionId'] !== undefined) {
      crc.CollectionId = cidrRoutingConfig['CollectionId'] as string;
    }
    if (cidrRoutingConfig['LocationName'] !== undefined) {
      crc.LocationName = cidrRoutingConfig['LocationName'] as string;
    }
    recordSet.CidrRoutingConfig = crc;
  }

  return recordSet;
}
