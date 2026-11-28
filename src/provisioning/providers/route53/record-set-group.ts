import type { Route53Provider } from '../route53-provider.js';
import {
  ChangeResourceRecordSetsCommand,
  type Change,
  type ResourceRecordSet,
} from '@aws-sdk/client-route-53';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markNameCollision } from '../../../deployment/retryable-errors.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import type {
  ResourceCreateResult,
  ResourceDeleteResult,
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
import { createMaskedLogSinks } from '../../masked-retry-logger.js';
import { markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { changeIdOf, waitForRoute53ChangeInsync } from './change-wait.js';
import {
  redactedDeleteAddressFields,
  redactedDeleteAddressSkip,
} from '../../redacted-delete-address.js';
import {
  isZoneDisabledForMutationError,
  HostedZoneNameNotFoundError,
  isCnameConflictRefusal,
  CNAME_CONFLICT_COLLISION_NOTE,
  bareHostedZoneId,
  zoneReferenceChanged,
  recordedZoneForSwitch,
  refuseCfnUnresolvableZoneName,
  withTemplateAliasConflicts,
} from './shared.js';
import {
  RECORD_SET_GROUP_TYPE,
  RECORD_IDENTITY_FIELDS,
  RECORD_VALUE_FIELDS,
  recordSetGroupCompositeId,
  generatedGroupName,
  parseRecordSetGroupCompositeId,
  existingGroupName,
  groupRecordSets,
  recordSetKey,
  groupZoneProperties,
  recordBag,
  groupRefusalError,
  sameRecordSet,
  updateBatchClient,
  isUnambiguousClientRefusal,
  isRecordNotFoundRefusal,
  groupSubject,
} from './record-set-group-shape.js';

// ─── AWS::Route53::RecordSetGroup ──────────────────────────────────
//
// A group has no AWS-side entity: it is the set of records its `RecordSets`
// list names, all in ONE hosted zone. Every write is one
// `ChangeResourceRecordSets` batch, which Route 53 applies all or nothing, so
// a refused record leaves the whole group as it was.
//
// The physicalId is `<hostedZoneId>|<groupName>`: the zone the records were
// written to, so update / delete / drift never re-resolve a `HostedZoneName`
// (which can match a public and a private zone of one name), plus the group's
// name, which `Ref` returns. CloudFormation's `Ref` is a generated
// `<StackName>-<LogicalId>-<suffix>` naming nothing in AWS; cdkd generates the
// same shape (`generateResourceName`), and an imported group keeps
// CloudFormation's own name (go-to-k/cdkd#6530). Neither segment can carry `|`.

/** The usable entries of `RecordSets` (none when it is not a list). */
function listedRecords(properties: Record<string, unknown>): Record<string, unknown>[] {
  const parsed = groupRecordSets(properties);
  return 'refusal' in parsed ? [] : parsed.records;
}

/**
 * The group shapes CloudFormation refuses (go-to-k/cdkd#6540, measured):
 * - a zone key on a `RecordSets` entry ("Encountered unsupported property
 *   HostedZoneName" / "... HostedZoneId");
 * - a group naming neither or both of `HostedZoneId` / `HostedZoneName`
 *   ("Exactly one of HostedZoneId and HostedZoneName must be specified");
 * - an empty or absent `RecordSets` ("Property RecordSets cannot be empty.");
 * - a group `HostedZoneName` other than the zone's exact spelling.
 * Template paths only; a state record warns.
 */
function refuseCfnGroupZoneShape(
  provider: Route53Provider,
  properties: Record<string, unknown>,
  records: Record<string, unknown>[],
  logicalId: string,
  resourceType: string,
  physicalId: string | undefined,
  stateBorne: boolean
): void {
  const refuse = (message: string) => {
    if (stateBorne) provider.logger.warn(safeMsg`${message}. Proceeding for this state replay.`);
    else throw groupRefusalError(message, logicalId, physicalId);
  };
  const index = records.findIndex(
    (record) => record['HostedZoneName'] !== undefined || record['HostedZoneId'] !== undefined
  );
  if (index >= 0) {
    refuse(
      `Record set group ${logicalId}: RecordSets[${index}] declares a hosted zone, which ` +
        `CloudFormation refuses as an unsupported property of a group's record; name the zone ` +
        `on the group`
    );
  }
  const zoneKeys = ['HostedZoneId', 'HostedZoneName'].filter((k) => properties[k] !== undefined);
  if (zoneKeys.length !== 1) {
    refuse(
      `Record set group ${logicalId}: exactly one of HostedZoneId and HostedZoneName must be ` +
        `specified (the group names ${zoneKeys.length === 0 ? 'neither' : 'both'})`
    );
  }
  // Only an absent or empty list is "empty"; a malformed one keeps
  // `desiredGroup`'s own message.
  const listed = properties['RecordSets'];
  if (listed === undefined || listed === null || (Array.isArray(listed) && listed.length === 0)) {
    refuse(`Record set group ${logicalId}: RecordSets cannot be empty`);
  }
  refuseCfnUnresolvableZoneName(
    provider,
    properties['HostedZoneName'],
    'Record set group',
    logicalId,
    resourceType,
    physicalId,
    stateBorne
  );
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

export async function createRecordSetGroup(
  this: Route53Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  mask: ((text: string) => string) | undefined,
  replayingState = false
): Promise<ResourceCreateResult> {
  this.logger.debug(safeMsg`Creating Route 53 record set group ${logicalId}`);

  // CloudFormation's own refusals first, then cdkd's shape checks.
  refuseCfnGroupZoneShape(
    this,
    properties,
    listedRecords(properties),
    logicalId,
    resourceType,
    undefined,
    replayingState
  );
  const { records, zone } = desiredGroup(properties, logicalId, undefined);
  // Unambiguous, as CloudFormation: a split-horizon name is refused (#6540),
  // on a replay too (the stated exception: the alternative is guessing the
  // zone the records are written into).
  const hostedZoneId = await this.resolveHostedZoneId(zone, logicalId, resourceType, undefined, {
    requireUnambiguousZoneName: true,
    subject: groupSubject,
  });
  const compositeId = recordSetGroupCompositeId(hostedZoneId, generatedGroupName(logicalId));

  // Route 53 refuses an empty change batch, and a group with no records holds
  // nothing in AWS, so there is nothing to write.
  if (records.length === 0) {
    this.logger.debug(
      safeMsg`Record set group ${logicalId} declares no records; nothing to create`
    );
    return { physicalId: compositeId, attributes: {} };
  }

  let changeId: string | undefined;
  try {
    const comment = properties['Comment'];
    const created = await this.getClient().send(
      new ChangeResourceRecordSetsCommand({
        HostedZoneId: hostedZoneId,
        ChangeBatch: {
          ...(typeof comment === 'string' && comment ? { Comment: comment } : {}),
          Changes: records.map((record): Change => ({
            Action: 'CREATE',
            ResourceRecordSet: replayingState
              ? this.buildResourceRecordSet(recordBag(record))
              : withTemplateAliasConflicts(this.buildResourceRecordSet(recordBag(record)), record),
          })),
        },
      })
    );
    changeId = changeIdOf(created);
    this.logger.debug(safeMsg`Successfully created record set group ${logicalId}: ${compositeId}`);
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

  // go-to-k/cdkd#7132: under --full-wait, as CloudFormation does. Only a
  // Ctrl-C throws here, and the records are live by then.
  try {
    await waitForRoute53ChangeInsync(
      this.getClient(),
      changeId,
      `record set group ${logicalId}`,
      createMaskedLogSinks(this.logger, mask)
    );
  } catch (error) {
    throw markCreatedBeforeFailure(error, logicalId, resourceType, compositeId);
  }
  return { physicalId: compositeId, attributes: {} };
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

  refuseCfnGroupZoneShape(
    this,
    properties,
    listedRecords(properties),
    logicalId,
    resourceType,
    physicalId,
    context?.replayingState === true || context?.desiredFromAwsReadback === true
  );
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
  const compositeId = recordSetGroupCompositeId(
    hostedZoneId,
    existingGroupName(physicalId, logicalId)
  );

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

  let changeId: string | undefined;
  try {
    const desiredKeys = new Set<string>();
    const changes: Change[] = [];
    for (const record of records) {
      const key = recordSetKey(record) as string;
      desiredKeys.add(key);
      const built = this.buildResourceRecordSet(recordBag(record));
      const stateBorne =
        context?.replayingState === true || context?.desiredFromAwsReadback === true;
      const desired = stateBorne ? built : withTemplateAliasConflicts(built, record);
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
      const updated = await updateBatchClient(this).send(
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
      changeId = changeIdOf(updated);
    }

    this.logger.debug(safeMsg`Successfully updated record set group ${logicalId}`);
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

  // go-to-k/cdkd#7132: under --full-wait, as CloudFormation does; nothing to
  // wait on when the update sent no batch.
  await waitForRoute53ChangeInsync(
    this.getClient(),
    changeId,
    `record set group ${logicalId}`,
    createMaskedLogSinks(this.logger, context?.maskSecrets)
  );
  return { physicalId: compositeId, wasReplaced: false, attributes: {} };
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

  const changeIds: Array<string | undefined> = [];
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
        changeIds.push(changeIdOf(await send(sets)));
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
        changeIds.push(changeIdOf(await send(sets)));
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

  // go-to-k/cdkd#7132: under --full-wait, as CloudFormation's delete does;
  // a record-by-record delete's changes propagate in parallel.
  const log = createMaskedLogSinks(this.logger, context?.maskSecrets);
  for (const changeId of changeIds) {
    await waitForRoute53ChangeInsync(
      this.getClient(),
      changeId,
      `record set group ${logicalId} deletion`,
      log
    );
  }
}

/** The brand `resolveHostedZoneId` puts on a failed listing (route53/resolve.ts). */
const HOSTED_ZONE_LOOKUP_FAILED = Symbol.for('cdkd.route53.hostedZoneLookupFailed');

function isHostedZoneLookupFailure(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as Record<symbol, unknown>)[HOSTED_ZONE_LOOKUP_FAILED] === true
  );
}

/**
 * The live state of every recorded record, in recorded order, as
 * `{ RecordSets: [...] }`. A record the lookup cannot place makes the whole
 * answer "cannot tell" (`undefined`), as for `AWS::Route53::RecordSet`
 * (go-to-k/cdkd#4283); one proven gone is left out (go-to-k/cdkd#6660), and
 * a group with none left, or a missing zone, is `RESOURCE_NOT_FOUND`. A zone
 * the template cannot resolve is "cannot tell" too, but a hosted-zone listing
 * that FAILED throws (go-to-k/cdkd#6759), so `cdkd drift` reports
 * `readFailed` with its cause rather than an unknown.
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
  } catch (err) {
    // A failed listing rethrows; a refusal from the template alone is "cannot tell".
    if (!(err instanceof ProvisioningError) || isHostedZoneLookupFailure(err)) {
      throw err;
    }
    return undefined;
  }

  const observed: Record<string, unknown>[] = [];
  for (const record of parsed.records) {
    const name = record['Name'];
    const type = record['Type'];
    if (typeof name !== 'string' || typeof type !== 'string') return undefined;
    const live = await this.readRecordSetAt({ hostedZoneId, name, type }, recordBag(record));
    if (live === undefined) return undefined;
    // go-to-k/cdkd#6660: a member PROVEN gone is left out, so drift reports
    // the group's `RecordSets` changed (and the other members' values with
    // it) and `--revert` re-creates the member; only a group with no member
    // left is gone. A missing zone answers `RESOURCE_NOT_FOUND` for every
    // member, which lands there too.
    if (live === RESOURCE_NOT_FOUND) continue;
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
  if (observed.length === 0 && parsed.records.length > 0) return RESOURCE_NOT_FOUND;
  // go-to-k/cdkd#6681: echo the zone key the group declares, as a member's is
  // above. The read is the deploy's drift baseline and `drift --revert`'s
  // desired bag; without it the revert's update sees a group naming no zone.
  const groupZone: Record<string, unknown> = {};
  for (const key of ['HostedZoneId', 'HostedZoneName'] as const) {
    if (properties?.[key] !== undefined) groupZone[key] = properties[key];
  }
  return { ...groupZone, RecordSets: observed };
}
