/**
 * An `AWS::EC2::NetworkInterface` `PrivateIpAddresses` change that Cloud
 * Control reports as SUCCESS without applying (go-to-k/cdkd#7099). Measured in
 * us-east-1 on 2026-11-27: adding or changing a secondary address returned
 * SUCCESS, and DescribeNetworkInterfaces still showed the primary only.
 * CloudFormation applies the same template change in place (UPDATE_COMPLETE,
 * same interface id, the secondary present), so cdkd applies it too, through
 * EC2 `AssignPrivateIpAddresses` / `UnassignPrivateIpAddresses`, once Cloud
 * Control has returned. Measured on the same interface: both calls take effect
 * at once, and Cloud Control's GetResource returns the new list right after.
 *
 * The difference is taken from the LIVE list (unassigning only what the
 * template removed), so a
 * run that failed halfway converges on the next deploy: the caller runs this
 * also when the template changed the list and the live list differs from it,
 * whether or not the live list still equals the previous one. Addresses are
 * assigned before any is unassigned: a refused assignment then leaves the
 * interface as it was, never short of an address it serves. Only an
 * unattached interface was measured. On an attached one at its instance
 * type's address limit, the assignment is expected to refuse a swap before
 * anything changes, but that is unmeasured. `AllowReassignment` stays off,
 * so an address another interface holds is refused, never taken from it.
 * One consequence: moving an address from interface A to interface B in one
 * deploy can be refused, because nothing orders B's assignment after A's
 * unassignment. That fails safe (the refused assignment changes nothing on B,
 * and no address is taken from A). It converges under `--no-rollback` (the
 * next deploy finds A's unassignment done), or when the removal from A and
 * the addition to B go in two deploys. The default rollback reverts A's
 * update, which assigns the address back to A, so the next deploy can repeat
 * the same conflict. What CloudFormation does for such a move is unmeasured.
 *
 * Only an explicit secondary list is handled. A desired side that also
 * declares `SecondaryPrivateIpAddressCount` (AWS picks those addresses), lacks
 * exactly one primary entry, or names a different primary (`PrivateIpAddress`
 * is create-only, and EC2 refuses to unassign a primary) is left to the
 * caller's `[cc-silent-noop]` failure.
 */
import { ProvisioningError } from '../../utils/error-handler.js';
import { canonicalizeRegion } from '../../utils/aws-partition.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { maskCallerIdentity } from './caller-identity.js';

export const NETWORK_INTERFACE_TYPE = 'AWS::EC2::NetworkInterface';
export const SECONDARY_ADDRESS_KEY = 'PrivateIpAddresses';

/** The secondary addresses to assign and unassign so `live` matches `desired`. */
export interface SecondaryAddressPlan {
  assign: string[];
  unassign: string[];
}

interface AddressList {
  primary: string;
  secondaries: Set<string>;
}

/** A `PrivateIpAddresses` list's primary and secondaries, or undefined for any other shape. */
function addressList(value: unknown): AddressList | undefined {
  if (!Array.isArray(value)) return undefined;
  const primaries: string[] = [];
  const secondaries = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const { PrivateIpAddress: address, Primary: primary } = entry as Record<string, unknown>;
    if (typeof address !== 'string' || address === '') return undefined;
    if (primary === true || primary === 'true') primaries.push(address);
    else if (primary === false || primary === 'false' || primary === undefined) {
      secondaries.add(address);
    } else return undefined;
  }
  if (primaries.length !== 1) return undefined;
  const primary = primaries[0]!;
  secondaries.delete(primary);
  return { primary, secondaries };
}

/**
 * The plan that makes `live`'s secondary addresses `desired`'s, empty when
 * they already match, or undefined when this fixup does not cover the shape.
 */
export function secondaryAddressPlan(
  desired: Readonly<Record<string, unknown>>,
  live: Readonly<Record<string, unknown>> | undefined,
  previous?: Readonly<Record<string, unknown>>
): SecondaryAddressPlan | undefined {
  if (live === undefined) return undefined;
  if (desired['SecondaryPrivateIpAddressCount'] !== undefined) return undefined;
  const want = addressList(desired[SECONDARY_ADDRESS_KEY]);
  const have = addressList(live[SECONDARY_ADDRESS_KEY]);
  if (want === undefined || have === undefined || want.primary !== have.primary) return undefined;
  // With `previous`, only an address the template REMOVED is unassigned: one
  // added outside cdkd (it may carry an Elastic IP association) is left, as a
  // deploy that does not touch the list leaves it. A `drift --revert` passes
  // the read-back as `previous`, so it still reverts such an address.
  const was = previous === undefined ? undefined : addressList(previous[SECONDARY_ADDRESS_KEY]);
  if (previous !== undefined && was === undefined) return undefined;
  return {
    assign: [...want.secondaries].filter((a) => !have.secondaries.has(a)).sort(),
    unassign: [...have.secondaries]
      .filter((a) => !want.secondaries.has(a) && (was === undefined || was.secondaries.has(a)))
      .sort(),
  };
}

/**
 * The template changed the secondary-address list (`previous` and `desired`
 * differ as sets) and the live list is not yet `desired`'s.
 */
export function secondaryAddressesNeedApplying(
  previous: Readonly<Record<string, unknown>>,
  desired: Readonly<Record<string, unknown>>,
  live: Readonly<Record<string, unknown>> | undefined
): boolean {
  const changed = secondaryAddressPlan(desired, previous);
  if (changed === undefined || changed.assign.length + changed.unassign.length === 0) return false;
  const plan = secondaryAddressPlan(desired, live, previous);
  return plan !== undefined && plan.assign.length + plan.unassign.length > 0;
}

/** The EC2 calls this fixup sends; a seam for tests. */
export interface SecondaryAddressClient {
  assign(networkInterfaceId: string, addresses: string[]): Promise<void>;
  unassign(networkInterfaceId: string, addresses: string[]): Promise<void>;
  destroy(): void;
}

/** An EC2 client in the Cloud Control client's region. */
export async function secondaryAddressClient(
  regionOf: () => Promise<string | undefined>
): Promise<SecondaryAddressClient | undefined> {
  let region: string | undefined;
  try {
    region = canonicalizeRegion((await regionOf())?.trim());
  } catch {
    region = undefined;
  }
  if (region === undefined || region === '') return undefined;
  const { EC2Client, AssignPrivateIpAddressesCommand, UnassignPrivateIpAddressesCommand } =
    await import('@aws-sdk/client-ec2');
  const ec2 = new EC2Client({ ...ambientClientDefaults(), region });
  return {
    async assign(id, addresses) {
      await ec2.send(
        new AssignPrivateIpAddressesCommand({
          NetworkInterfaceId: id,
          PrivateIpAddresses: addresses,
          AllowReassignment: false,
        })
      );
    },
    async unassign(id, addresses) {
      await ec2.send(
        new UnassignPrivateIpAddressesCommand({
          NetworkInterfaceId: id,
          PrivateIpAddresses: addresses,
        })
      );
    },
    destroy() {
      ec2.destroy();
    },
  };
}

/**
 * Apply `plan` to the interface. A refused call fails the update, naming the
 * EC2 operation and AWS's reason (caller identity masked).
 */
export async function applySecondaryAddressPlan(
  client: SecondaryAddressClient,
  plan: SecondaryAddressPlan,
  ids: { logicalId: string; physicalId: string }
): Promise<void> {
  const steps: Array<[string, string[], (id: string, a: string[]) => Promise<void>]> = [
    ['AssignPrivateIpAddresses', plan.assign, (id, a) => client.assign(id, a)],
    ['UnassignPrivateIpAddresses', plan.unassign, (id, a) => client.unassign(id, a)],
  ];
  for (const [operation, addresses, send] of steps) {
    if (addresses.length === 0) continue;
    try {
      await send(ids.physicalId, addresses);
    } catch (error) {
      throw new ProvisioningError(
        `Failed to update resource ${ids.logicalId}: Cloud Control did not apply the ${SECONDARY_ADDRESS_KEY} change, and EC2 ${operation} (${addresses.join(', ')}) was refused: ${maskCallerIdentity(describeAwsFailure(error).detail)} (go-to-k/cdkd#7099). The record keeps the previous values.`,
        NETWORK_INTERFACE_TYPE,
        ids.logicalId,
        ids.physicalId,
        error instanceof Error ? error : undefined
      );
    }
  }
}

const READBACK_ATTEMPTS = 3;
const READBACK_DELAY_MS = 1000;

/**
 * Apply an unapplied `PrivateIpAddresses` change through EC2, then re-read the
 * interface. Returns the fresh read model once its secondary addresses are the
 * desired ones, so the caller drops the key from its unapplied list; undefined
 * when this fixup does not cover the shape or the region cannot be resolved,
 * leaving the caller's `[cc-silent-noop]` failure. A refused EC2 call throws,
 * and so does a re-read that still lacks the change EC2 accepted.
 */
export async function applyUnappliedSecondaryAddresses(input: {
  previous: Readonly<Record<string, unknown>>;
  desired: Readonly<Record<string, unknown>>;
  live: Readonly<Record<string, unknown>> | undefined;
  ids: { logicalId: string; physicalId: string };
  regionOf: () => Promise<string | undefined>;
  reread: () => Promise<Record<string, unknown> | undefined>;
  debug: (message: string) => void;
  clientFor?: typeof secondaryAddressClient;
  delayMs?: number;
}): Promise<Record<string, unknown> | undefined> {
  const plan = secondaryAddressPlan(input.desired, input.live, input.previous);
  if (plan === undefined) return undefined;
  if (plan.assign.length === 0 && plan.unassign.length === 0) return { ...input.live };
  const client = await (input.clientFor ?? secondaryAddressClient)(input.regionOf);
  if (client === undefined) return undefined;
  try {
    await applySecondaryAddressPlan(client, plan, input.ids);
  } finally {
    client.destroy();
  }
  input.debug(
    `${input.ids.logicalId}: applied the ${SECONDARY_ADDRESS_KEY} change Cloud Control left unapplied through EC2 (assigned ${plan.assign.length}, unassigned ${plan.unassign.length}; go-to-k/cdkd#7099)`
  );
  for (let attempt = 1; attempt <= READBACK_ATTEMPTS; attempt++) {
    const fresh = await input.reread();
    const left = secondaryAddressPlan(input.desired, fresh, input.previous);
    if (fresh !== undefined && left?.assign.length === 0 && left.unassign.length === 0) {
      return fresh;
    }
    if (attempt < READBACK_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, input.delayMs ?? READBACK_DELAY_MS));
    }
  }
  throw new ProvisioningError(
    `Failed to update resource ${input.ids.logicalId}: EC2 accepted the ${SECONDARY_ADDRESS_KEY} change Cloud Control left unapplied, but Cloud Control's read of the interface does not show it yet (go-to-k/cdkd#7099). The record keeps the previous values; the next deploy compares the live addresses again.`,
    NETWORK_INTERFACE_TYPE,
    input.ids.logicalId,
    input.ids.physicalId
  );
}
