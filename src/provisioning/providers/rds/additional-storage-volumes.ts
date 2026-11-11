import { isDeepStrictEqual } from 'node:util';
import type {
  AdditionalStorageVolume,
  DBInstance,
  ModifyAdditionalStorageVolume,
} from '@aws-sdk/client-rds';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { ProvisioningError } from '../../../utils/error-handler.js';

/**
 * go-to-k/cdkd#5640: `AWS::RDS::DBInstance` `AdditionalStorageVolumes`, wired
 * to what CloudFormation's handler was MEASURED to send (CloudTrail, SQL
 * Server SE, us-east-1, 2026-11-11):
 *
 * - CREATE passes the declared list on `CreateDBInstance` itself, the string
 *   `AllocatedStorage` as a number; no follow-up modify.
 * - UPDATE sends one `ModifyDBInstance` (`ApplyImmediately`) carrying only the
 *   CHANGED and NEW volumes, each with every member its template entry
 *   declares; an unchanged volume is omitted. A volume dropped from the list,
 *   and every previous volume when the whole property is removed, goes as
 *   `{ VolumeName, SetForDelete: true }`. Volumes are keyed by `VolumeName`.
 * - The update waits for the instance to settle after such a modify.
 *
 * CFn spells the IOPS member `Iops`, the SDK `IOPS`.
 */

/** The numeric members of a volume; CFn types `AllocatedStorage` as a string. */
const NUMERIC_MEMBERS = [
  ['AllocatedStorage', 'AllocatedStorage'],
  ['Iops', 'IOPS'],
  ['MaxAllocatedStorage', 'MaxAllocatedStorage'],
  ['StorageThroughput', 'StorageThroughput'],
] as const;

/** A whole number from a template value (a number or its decimal string). */
function wholeNumber(value: unknown): number | 'malformed' {
  if (typeof value === 'number') return Number.isInteger(value) ? value : 'malformed';
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return 'malformed';
}

/**
 * The `AdditionalStorageVolumes` of a bag in the SDK shape: `undefined` when
 * absent, `'malformed'` when it is not a list of objects each naming a
 * distinct `VolumeName`, with whole-number numeric members and a string
 * `StorageType`. The read-only `StorageOperationStatus` /
 * `StorageOperationPercentProgress` are dropped: no request carries them.
 */
export function additionalStorageVolumeList(
  value: unknown
): AdditionalStorageVolume[] | undefined | 'malformed' {
  if (value == null) return undefined;
  if (!Array.isArray(value)) return 'malformed';
  const out: AdditionalStorageVolume[] = [];
  const names = new Set<string>();
  for (const item of value as unknown[]) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return 'malformed';
    const entry = item as Record<string, unknown>;
    const name = entry['VolumeName'];
    if (typeof name !== 'string' || name === '' || names.has(name)) return 'malformed';
    names.add(name);
    const volume: AdditionalStorageVolume = { VolumeName: name };
    for (const [cfn, sdk] of NUMERIC_MEMBERS) {
      if (entry[cfn] == null) continue;
      const parsed = wholeNumber(entry[cfn]);
      if (parsed === 'malformed') return 'malformed';
      volume[sdk] = parsed;
    }
    const storageType = entry['StorageType'];
    if (storageType != null) {
      if (typeof storageType !== 'string') return 'malformed';
      volume.StorageType = storageType;
    }
    out.push(volume);
  }
  return out;
}

/** A malformed list's refusal text. */
function refusalText(resourceType: string, logicalId: string): string {
  return `${resourceType} ${logicalId}: AdditionalStorageVolumes must be a list of { VolumeName, StorageType, AllocatedStorage, Iops, MaxAllocatedStorage, StorageThroughput } objects with distinct VolumeName values and whole-number sizes`;
}

/**
 * The CREATE's `AdditionalStorageVolumes`, or a non-retryable refusal before
 * any call. Refused on a rollback replay too: RDS takes nothing else, so the
 * replay could not have applied it either. A declared empty list goes out as
 * declared.
 */
export function desiredAdditionalStorageVolumes(
  properties: Record<string, unknown>,
  resourceType: string,
  logicalId: string
): AdditionalStorageVolume[] | undefined {
  const volumes = additionalStorageVolumeList(properties['AdditionalStorageVolumes']);
  if (volumes === 'malformed')
    throw markNonRetryable(
      new ProvisioningError(refusalText(resourceType, logicalId), resourceType, logicalId)
    );
  return volumes;
}

/**
 * The update's two volume lists, or a non-retryable refusal: `undefined` when
 * the bag holds the list unchanged (nothing to send). Run by `updateDBInstance`
 * before any call (the pre-flight), and again by
 * {@link additionalStorageVolumeChanges}, which narrows through it; a pure
 * function, so the second run repeats the first's answer. Refused, on every
 * path:
 *
 * - a malformed DESIRED list the update would send: read as empty it would
 *   delete every volume;
 * - a CASE-ONLY rename (`rdsdbdata2` to `RDSDBDATA2`): keyed by exact name,
 *   the update would send the new name in full beside `SetForDelete` for the
 *   old one, and if RDS folds the case both name one volume, whose data the
 *   delete would destroy. A malformed record is not compared (that arm
 *   deletes nothing).
 */
export function sendableVolumeLists(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  resourceType: string,
  logicalId: string,
  physicalId: string
):
  | {
      desired: AdditionalStorageVolume[] | undefined;
      previous: AdditionalStorageVolume[] | undefined | 'malformed';
    }
  | undefined {
  const desiredRaw = properties['AdditionalStorageVolumes'];
  const previousRaw = previousProperties['AdditionalStorageVolumes'];
  if (isDeepStrictEqual(desiredRaw, previousRaw)) return undefined;
  const desired = additionalStorageVolumeList(desiredRaw);
  if (desired === 'malformed') {
    throw markNonRetryable(
      new ProvisioningError(
        refusalText(resourceType, logicalId),
        resourceType,
        logicalId,
        physicalId
      )
    );
  }
  const previous = additionalStorageVolumeList(previousRaw);
  if (previous !== 'malformed' && previous !== undefined && desired !== undefined) {
    const before = new Set(previous.map((volume) => volume.VolumeName));
    const after = new Set(desired.map((volume) => volume.VolumeName));
    for (const name of after) {
      if (name === undefined || before.has(name)) continue;
      const renamed = [...before].find(
        (old) => old !== undefined && !after.has(old) && old.toLowerCase() === name.toLowerCase()
      );
      if (renamed !== undefined) {
        throw markNonRetryable(
          new ProvisioningError(
            safeMsg`${resourceType} ${logicalId}: AdditionalStorageVolumes renames volume ${renamed} to ${name} by case only, which would delete ${renamed} while RDS may read both names as one volume; keep the recorded spelling`,
            resourceType,
            logicalId,
            physicalId
          )
        );
      }
    }
  }
  return { desired, previous };
}

/** How the caller's desired bag came about (`UpdateContext`). */
export interface VolumeChangeSource {
  /** A rollback replay: the desired bag is the record the update left. */
  rollback: boolean;
  /** `drift --revert`: the desired bag is a recorded readback. */
  fromReadback: boolean;
}

/** Whether a desired volume differs from the previous one in a member it declares. */
function declaredMemberChanged(
  volume: AdditionalStorageVolume,
  old: AdditionalStorageVolume
): boolean {
  return (Object.keys(volume) as (keyof AdditionalStorageVolume)[]).some((key) => {
    const value = volume[key];
    if (value === undefined) return false;
    // RDS reads a storage type in any case (the readback spells it lower case).
    if (key === 'StorageType' && typeof old.StorageType === 'string') {
      return String(value).toLowerCase() !== old.StorageType.toLowerCase();
    }
    return value !== old[key];
  });
}

/**
 * The ModifyDBInstance `AdditionalStorageVolumes` of an update, as
 * CloudFormation sends it (see the module comment): each desired volume that
 * is new, or whose entry differs from the previous one of the same name in a
 * member it declares, in full; each previous volume the desired list no
 * longer names, set for delete. `undefined` when nothing changed. A member the
 * desired entry no longer declares is no change, as for the instance's own
 * storage members (`diff(previous, desired)` is null for a removal): RDS
 * keeps the live value, and a readback's defaults (3000 IOPS) never read as
 * one.
 *
 * Never a shrink RDS refuses: an existing volume sent with an unchanged size,
 * or on a rollback replay, carries the larger of its declared, previous (on a
 * replay) and live size, since storage autoscaling (`MaxAllocatedStorage`) may
 * have grown it. A replay therefore never undoes a grow, the way the handler's
 * rollback arm treats the instance's own `AllocatedStorage`. Only the SIZE is
 * lifted: a replay re-sends the volume's other changed members (`Iops`,
 * `StorageThroughput`, `StorageType`) as the record holds them. A replay
 * deletes only a volume the live instance lists.
 *
 * A malformed DESIRED list is refused before any call, on every path: read as
 * empty it would delete every volume. One the record holds unchanged sends
 * nothing. A malformed RECORDED list is replaced by the LIVE volumes the
 * desired list names, so it only adds or changes: a live volume the template
 * does not name is left in place with a warning, never deleted. Likewise on
 * `drift --revert`, whose previous side is the live readback: a volume added
 * outside cdkd holds data no template ever declared, so the revert leaves it
 * in place with a warning rather than deleting it.
 */
export async function additionalStorageVolumeChanges(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  readLive: () => Promise<DBInstance | undefined>,
  source: VolumeChangeSource,
  resourceType: string,
  logicalId: string,
  physicalId: string,
  warn: (message: string) => void
): Promise<ModifyAdditionalStorageVolume[] | undefined> {
  // Already run before any call (the pre-flight); here it only narrows.
  const lists = sendableVolumeLists(
    properties,
    previousProperties,
    resourceType,
    logicalId,
    physicalId
  );
  if (lists === undefined) return undefined;
  const { desired } = lists;
  let liveRead: Promise<DBInstance | undefined> | undefined;
  const liveVolumes = async () => (await (liveRead ??= readLive()))?.AdditionalStorageVolumes ?? [];
  const named = new Set((desired ?? []).map((volume) => volume.VolumeName));
  let previous = lists.previous;
  const deletes = !source.fromReadback;
  if (previous === 'malformed') {
    // Only the volumes the desired list names, so none is deleted.
    const live = await liveVolumes();
    const unnamed = live
      .map((volume) => volume.VolumeName)
      .filter((name): name is string => name !== undefined && !named.has(name));
    if (unnamed.length > 0) {
      warn(
        safeMsg`${logicalId}: the recorded AdditionalStorageVolumes is unreadable, so additional storage volume(s) ${unnamed.join(', ')} the template does not declare are left in place rather than deleted`
      );
    }
    previous = live
      .filter((volume) => volume.VolumeName !== undefined && named.has(volume.VolumeName))
      .map((volume) => liveVolume(volume));
  }
  const before = new Map((previous ?? []).map((volume) => [volume.VolumeName, volume]));
  const out: ModifyAdditionalStorageVolume[] = [];
  for (const declared of desired ?? []) {
    const old = before.get(declared.VolumeName);
    if (old === undefined) {
      out.push(declared);
      continue;
    }
    let volume = declared;
    if (
      source.rollback &&
      volume.AllocatedStorage !== undefined &&
      old.AllocatedStorage !== undefined &&
      old.AllocatedStorage > volume.AllocatedStorage
    ) {
      volume = { ...volume, AllocatedStorage: old.AllocatedStorage };
    }
    if (!declaredMemberChanged(volume, old)) continue;
    if (
      volume.AllocatedStorage !== undefined &&
      (source.rollback || volume.AllocatedStorage === old.AllocatedStorage)
    ) {
      const live = (await liveVolumes()).find((item) => item.VolumeName === volume.VolumeName);
      if (live?.AllocatedStorage !== undefined && live.AllocatedStorage > volume.AllocatedStorage) {
        volume = { ...volume, AllocatedStorage: live.AllocatedStorage };
      }
    }
    out.push(volume);
  }
  const removed = (previous ?? []).filter((volume) => !named.has(volume.VolumeName));
  if (deletes) {
    // A rollback replay deletes only a volume the live instance lists: the
    // failed update may have stopped before the volume it added was created,
    // and RDS refuses a delete of a volume it does not have, which would fail
    // the whole rollback.
    const listed = source.rollback
      ? new Set((await liveVolumes()).map((volume) => volume.VolumeName))
      : undefined;
    for (const volume of removed) {
      if (listed !== undefined && !listed.has(volume.VolumeName)) continue;
      out.push({ VolumeName: volume.VolumeName, SetForDelete: true });
    }
  } else if (source.fromReadback && removed.length > 0) {
    warn(
      safeMsg`${logicalId}: drift --revert leaves additional storage volume(s) ${removed.map((volume) => volume.VolumeName).join(', ')} in place: they are not in the recorded configuration, and deleting one discards its data. Delete it with ModifyDBInstance (SetForDelete) if that is intended`
    );
  }
  return out.length > 0 ? out : undefined;
}

/** A live volume in the request shape (status members dropped). */
function liveVolume(
  volume: NonNullable<DBInstance['AdditionalStorageVolumes']>[number]
): AdditionalStorageVolume {
  const out: AdditionalStorageVolume = { VolumeName: volume.VolumeName };
  for (const [, sdk] of NUMERIC_MEMBERS) {
    if (volume[sdk] !== undefined) out[sdk] = volume[sdk];
  }
  if (volume.StorageType !== undefined) out.StorageType = volume.StorageType;
  return out;
}

/**
 * The instance's `AdditionalStorageVolumes` in the CFn shape, or `undefined`
 * when it has none. `StorageVolumeStatus` and the `StorageOperation*`
 * progress members are status, not configuration, and are not read.
 * `AllocatedStorage` reads as the number RDS answers, as the instance's own
 * `AllocatedStorage` does.
 */
export function readAdditionalStorageVolumes(
  instance: DBInstance
): Record<string, unknown>[] | undefined {
  const live = instance.AdditionalStorageVolumes;
  if (live === undefined || live.length === 0) return undefined;
  return live.map((volume) => {
    const out: Record<string, unknown> = {};
    if (volume.VolumeName !== undefined) out['VolumeName'] = volume.VolumeName;
    if (volume.StorageType !== undefined) out['StorageType'] = volume.StorageType;
    for (const [cfn, sdk] of NUMERIC_MEMBERS) {
      if (volume[sdk] !== undefined) out[cfn] = volume[sdk];
    }
    return out;
  });
}

/** Quiet reads in a row after which a volume change no read showed under way counts as applied. */
const QUIET_READS = 3;

/** Whether an instance read shows a modification under way. */
function changeUnderWay(instance: DBInstance): boolean {
  return (
    instance.DBInstanceStatus !== 'available' ||
    (instance.PendingModifiedValues?.AdditionalStorageVolumes ?? []).length > 0
  );
}

/**
 * A predicate for whether a volume change applied immediately has settled,
 * as CloudFormation's update stabilizes (`available`, no change pending):
 * the instance `available` with no volume change pending, every volume the
 * update set for delete gone from the live list, and every other sent volume
 * listed live at its sent size and type. A live size ABOVE the sent one counts
 * (storage autoscaling may have grown it). Since the instance may still read
 * `available` before RDS registers the change, the predicate also needs the
 * change seen under way (on the instance ModifyDBInstance returned or on a
 * read), or else {@link QUIET_READS} quiet reads in a row. One predicate per
 * wait: it keeps that count.
 */
export function additionalStorageVolumesSettled(
  sent: readonly ModifyAdditionalStorageVolume[],
  modified: DBInstance | undefined
): (instance: DBInstance) => boolean {
  let changeSeen = modified !== undefined && changeUnderWay(modified);
  let quietReads = 0;
  return (instance) => {
    if (changeUnderWay(instance)) {
      changeSeen = true;
      return false;
    }
    const live = instance.AdditionalStorageVolumes ?? [];
    const applied = sent.every((volume) => {
      const match = live.find((item) => item.VolumeName === volume.VolumeName);
      if (volume.SetForDelete === true) return match === undefined;
      if (match === undefined) return false;
      if (
        volume.AllocatedStorage !== undefined &&
        (match.AllocatedStorage === undefined || match.AllocatedStorage < volume.AllocatedStorage)
      ) {
        return false;
      }
      return (
        volume.StorageType === undefined ||
        match.StorageType?.toLowerCase() === volume.StorageType.toLowerCase()
      );
    });
    if (!applied) return false;
    if (changeSeen) return true;
    quietReads += 1;
    return quietReads >= QUIET_READS;
  };
}

/**
 * Drift: the baseline's volumes with numeric strings folded to numbers (a
 * template spells `AllocatedStorage` as a string, the readback a number) and
 * `StorageType` folded to lower case.
 * Anything else is left as it is.
 */
export function canonicalAdditionalStorageVolumes(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return (value as unknown[]).map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    const entry = { ...(item as Record<string, unknown>) };
    for (const [cfn] of NUMERIC_MEMBERS) {
      const member = entry[cfn];
      if (typeof member === 'string' && /^\d+$/.test(member.trim())) {
        entry[cfn] = Number(member.trim());
      }
    }
    // RDS reads a storage type in any case, and the readback spells it lower
    // case, as the update and the settle wait compare it.
    if (typeof entry['StorageType'] === 'string') {
      entry['StorageType'] = entry['StorageType'].toLowerCase();
    }
    return entry;
  });
}

/**
 * Drift: RDS lists every member of a live volume, defaults included (3000
 * IOPS, 125 MiB/s on gp3), while a template entry may declare only some. Each
 * live volume keeps the members its same-named baseline entry declares, so a
 * declared value that differs still reads as drift and an undeclared default
 * never does; a live volume the baseline does not name is kept whole. A side
 * that is not a list of objects is left as it is.
 */
export function withDeclaredVolumeMembers(
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>
): Record<string, unknown> {
  const declared = baseline['AdditionalStorageVolumes'];
  const live = aws['AdditionalStorageVolumes'];
  if (!Array.isArray(declared) || !Array.isArray(live)) return aws;
  const members = new Map<unknown, string[]>();
  for (const item of declared as unknown[]) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return aws;
    const entry = item as Record<string, unknown>;
    members.set(
      entry['VolumeName'],
      Object.keys(entry).filter((key) => entry[key] !== undefined)
    );
  }
  let changed = false;
  const narrowed = (live as unknown[]).map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    const entry = item as Record<string, unknown>;
    const keys = members.get(entry['VolumeName']);
    if (keys === undefined) return item;
    const out: Record<string, unknown> = {};
    for (const key of keys) if (key in entry) out[key] = entry[key];
    if (Object.keys(out).length !== Object.keys(entry).length) changed = true;
    return out;
  });
  return changed ? { ...aws, AdditionalStorageVolumes: narrowed } : aws;
}
