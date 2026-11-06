import { type NatGatewayAddress, type NatGateway } from '@aws-sdk/client-ec2';
import { definedAttributes } from '../../attribute-map.js';

/** `DescribeNatGateways`'s answer for a gateway id EC2 no longer lists. */
export const NAT_GATEWAY_NOT_FOUND_NAMES: ReadonlySet<string> = new Set(['NatGatewayNotFound']);

/**
 * One `AWS::EC2::NatGateway.AvailabilityZoneAddresses` entry (a regional NAT
 * gateway's per-zone Elastic IPs, go-to-k/cdkd#2762). The zone is named by
 * `AvailabilityZone`, `AvailabilityZoneId` or both, exactly as declared.
 */
export interface NatZoneAddressEntry {
  availabilityZone?: string;
  availabilityZoneId?: string;
  allocationIds: string[];
}

/** The three answers a guard over `AvailabilityZoneAddresses` gives. */
export type NatZoneAddressRead =
  | { kind: 'absent' }
  | { kind: 'usable'; entries: NatZoneAddressEntry[] }
  | { kind: 'unusable'; reason: string };

/**
 * Read a CFn `AvailabilityZoneAddresses` value. `null` / `undefined` is
 * ABSENT; anything else that is not a non-empty list of entries, each naming
 * a zone and a non-empty `AllocationIds` list of strings, is UNUSABLE — never
 * read as empty, since an empty desired set would release every address the
 * gateway holds.
 */
export function readNatZoneAddresses(raw: unknown): NatZoneAddressRead {
  if (raw === undefined || raw === null) return { kind: 'absent' };
  const unusable = (reason: string): NatZoneAddressRead => ({ kind: 'unusable', reason });
  if (!Array.isArray(raw)) return unusable('is not a list');
  if (raw.length === 0) return unusable('is an empty list');
  const entries: NatZoneAddressEntry[] = [];
  const seen = new Set<string>();
  for (const [index, item] of raw.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return unusable(`entry ${index} is not an object`);
    }
    const record = item as Record<string, unknown>;
    const zone = record['AvailabilityZone'];
    const zoneId = record['AvailabilityZoneId'];
    if (zone !== undefined && (typeof zone !== 'string' || zone === '')) {
      return unusable(`entry ${index}'s AvailabilityZone is not a zone name`);
    }
    if (zoneId !== undefined && (typeof zoneId !== 'string' || zoneId === '')) {
      return unusable(`entry ${index}'s AvailabilityZoneId is not a zone id`);
    }
    if (zone === undefined && zoneId === undefined) {
      return unusable(`entry ${index} names neither AvailabilityZone nor AvailabilityZoneId`);
    }
    const ids = record['AllocationIds'];
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.some((id) => typeof id !== 'string' || id === '')
    ) {
      return unusable(`entry ${index}'s AllocationIds is not a non-empty list of allocation ids`);
    }
    for (const id of ids as string[]) {
      if (seen.has(id)) return unusable(`declares allocation id ${id} more than once`);
      seen.add(id);
    }
    entries.push({
      ...(zone !== undefined && { availabilityZone: zone }),
      ...(zoneId !== undefined && { availabilityZoneId: zoneId }),
      allocationIds: [...(ids as string[])],
    });
  }
  return { kind: 'usable', entries };
}

/**
 * The `Fn::GetAtt` attributes of a described NAT gateway (go-to-k/cdkd#2762):
 * `RouteTableId` (the route table AWS creates for a regional gateway), the two
 * automatic-mode flags, and — for a zonal gateway, whose one interface it
 * names — `EniId`. A regional gateway's `EniId` is left unanswered: which of
 * its per-zone interfaces CloudFormation reports is not documented.
 */
export function natGatewayAttributes(gateway: NatGateway): Record<string, unknown> {
  const addresses = gateway.NatGatewayAddresses ?? [];
  const primary = addresses.find((a) => a.IsPrimary === true) ?? addresses[0];
  return definedAttributes({
    NatGatewayId: gateway.NatGatewayId,
    EniId: gateway.AvailabilityMode === 'regional' ? undefined : primary?.NetworkInterfaceId,
    RouteTableId: gateway.RouteTableId,
    AutoProvisionZones: gateway.AutoProvisionZones,
    AutoScalingIps: gateway.AutoScalingIps,
  });
}

/**
 * The bound on ALL the waits one regional NAT gateway address update makes
 * for an association or a release to settle before a call AWS would otherwise
 * refuse (one took about five minutes when measured on #2762): 15 minutes in
 * 10 s polls, shared, so the update stays inside the default 30-minute
 * --resource-timeout.
 */
export const NAT_ADDRESS_SETTLE_POLLS = 90;
export const NAT_ADDRESS_SETTLE_DELAY_MS = 10_000;
/** Polls an address just associated may stay unlisted by DescribeNatGateways (1 minute). */
export const NAT_ADDRESS_UNLISTED_POLLS = 6;

/** Whether a live NAT gateway address sits in the zone an entry names. */
function natAddressInZone(address: NatGatewayAddress, entry: NatZoneAddressEntry): boolean {
  return (
    (entry.availabilityZone !== undefined && address.AvailabilityZone === entry.availabilityZone) ||
    (entry.availabilityZoneId !== undefined &&
      address.AvailabilityZoneId === entry.availabilityZoneId)
  );
}

/**
 * A live address the gateway still HOLDS: one being released (or whose
 * association failed) no longer counts.
 */
export function natAddressHeld(address: NatGatewayAddress): boolean {
  return (
    typeof address.AllocationId === 'string' &&
    address.Status !== 'disassociating' &&
    address.Status !== 'failed'
  );
}

/** The calls that move a regional NAT gateway's live addresses to `desired`. */
export interface NatZoneAddressPlan {
  associate: NatZoneAddressEntry[];
  disassociate: { allocationId: string; associationId: string | undefined }[];
  /** Allocation ids declared in one zone while the gateway holds them in another. */
  moved: string[];
  /**
   * Declared allocation ids AWS is still RELEASING from this gateway: AWS
   * refuses to associate one until the release finishes, so the update waits.
   */
  awaitingRelease: string[];
  /**
   * Whether an address the gateway KEEPS is already associated. AWS refuses a
   * release leaving the gateway no associated address, and one still being
   * associated does not count (measured on #2762), so a release swapping out
   * the last settled address must wait for an added one first.
   */
  keptSettled: boolean;
}

/**
 * Plan a regional NAT gateway's `AvailabilityZoneAddresses` update against the
 * LIVE addresses (`DescribeNatGateways`), not the recorded ones: an address
 * AWS still holds is the one a release must name, by its association id.
 */
export function planNatZoneAddressUpdate(
  desired: NatZoneAddressEntry[],
  live: NatGatewayAddress[]
): NatZoneAddressPlan {
  const held = live.filter(natAddressHeld);
  const associate: NatZoneAddressEntry[] = [];
  const moved: string[] = [];
  const awaitingRelease: string[] = [];
  const wanted = new Set<string>();
  for (const entry of desired) {
    const missing: string[] = [];
    for (const allocationId of entry.allocationIds) {
      wanted.add(allocationId);
      const holder = held.find((a) => a.AllocationId === allocationId);
      if (holder === undefined) {
        missing.push(allocationId);
        if (live.some((a) => a.AllocationId === allocationId && a.Status === 'disassociating')) {
          awaitingRelease.push(allocationId);
        }
      } else if (!natAddressInZone(holder, entry)) moved.push(allocationId);
    }
    if (missing.length > 0) associate.push({ ...entry, allocationIds: missing });
  }
  const disassociate = held
    .filter((a) => !wanted.has(a.AllocationId!))
    .map((a) => ({ allocationId: a.AllocationId!, associationId: a.AssociationId }));
  const keptSettled = held.some((a) => wanted.has(a.AllocationId!) && a.Status === 'succeeded');
  return { associate, disassociate, moved, awaitingRelease, keptSettled };
}

/**
 * The `AvailabilityZoneAddresses` a regional NAT gateway's live addresses
 * read back as, in the template's shape: one entry per zone, spelled the way
 * the RECORDED entry for that zone spells it (`AvailabilityZone` otherwise),
 * in the recorded order with unrecorded zones and allocation ids appended.
 */
export function readbackNatZoneAddresses(
  live: NatGatewayAddress[],
  recorded: NatZoneAddressEntry[]
): Record<string, unknown>[] {
  // An address naming no zone cannot be placed in any entry.
  const held = live
    .filter(natAddressHeld)
    .filter((a) => a.AvailabilityZone !== undefined || a.AvailabilityZoneId !== undefined);
  const out: Record<string, unknown>[] = [];
  const emit = (entry: NatZoneAddressEntry, addresses: NatGatewayAddress[]): void => {
    if (addresses.length === 0) return;
    const ids = addresses.map((a) => a.AllocationId!);
    const ordered = [
      ...entry.allocationIds.filter((id) => ids.includes(id)),
      ...ids.filter((id) => !entry.allocationIds.includes(id)),
    ];
    out.push({
      ...(entry.availabilityZone !== undefined && { AvailabilityZone: entry.availabilityZone }),
      ...(entry.availabilityZoneId !== undefined && {
        AvailabilityZoneId: entry.availabilityZoneId,
      }),
      AllocationIds: ordered,
    });
  };
  let rest = held;
  for (const entry of recorded) {
    emit(
      entry,
      rest.filter((a) => natAddressInZone(a, entry))
    );
    rest = rest.filter((a) => !natAddressInZone(a, entry));
  }
  const zones = [...new Set(rest.map((a) => a.AvailabilityZone ?? a.AvailabilityZoneId ?? ''))];
  for (const zone of zones) {
    const inZone = rest.filter((a) => (a.AvailabilityZone ?? a.AvailabilityZoneId ?? '') === zone);
    const first = inZone[0]!;
    emit(
      first.AvailabilityZone !== undefined
        ? { availabilityZone: first.AvailabilityZone, allocationIds: [] }
        : { availabilityZoneId: first.AvailabilityZoneId!, allocationIds: [] },
      inZone
    );
  }
  return out;
}
