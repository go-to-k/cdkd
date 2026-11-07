import {
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  GetIpamPoolAllocationsCommand,
  type EC2Client,
} from '@aws-sdk/client-ec2';
import { waitForGoneAfterDelete } from './delete-gone-wait.js';
import { resolvedResourceTimeoutMs } from './resource-timeout-registry.js';
import { safeMsg } from '../utils/display-safe.js';

/** Minimal logger surface used here (avoids coupling to the full Logger type). */
type ReleaseLogger = {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
};

/**
 * go-to-k/cdkd#5975: the text of the `AWS::EC2::IPAMPoolCidr` delete handler's
 * refusal while the pool CIDR still has allocations, as Cloud Control relays
 * it (`Error occurred during operation 'The CIDR has one or more
 * allocations.'`). Copied from cdkd's own red output on the ec2-vpc-ipam integ.
 */
export const IPAM_CIDR_HAS_ALLOCATIONS = 'The CIDR has one or more allocations.';

/**
 * go-to-k/cdkd#5975: how long the `AWS::EC2::IPAMPoolCidr` delete waits, after
 * that refusal, for the pool to release the allocations of VPCs and subnets
 * that are already deleted. The same 25 minutes as the VPC's own wait
 * (`vpcIpamReleaseWait`), under the default 30-minute per-resource deadline,
 * and this one starts when the pool CIDR's delete does, so the two together
 * cover a release of about 50 minutes after `DeleteVpc`. Measured releases:
 * 1092s, about 1153s, about 18 minutes, and once more than 1500s. Exported so
 * tests can shorten it.
 */
export const ipamPoolCidrReleaseWait = { pollIntervalMs: 10_000, maxWaitMs: 25 * 60_000 };

/**
 * The whole budget of one pool CIDR delete's release waits, however many
 * times the delete is re-sent: {@link ipamPoolCidrReleaseWait}'s cap, or half
 * an explicit `--resource-timeout` for the type when that is lower, as
 * `delete-gone-wait.ts` caps a single wait.
 */
export function ipamPoolCidrReleaseBudgetMs(resourceType: string): number {
  const userTimeoutMs = resolvedResourceTimeoutMs(resourceType);
  return userTimeoutMs === undefined
    ? ipamPoolCidrReleaseWait.maxWaitMs
    : Math.min(ipamPoolCidrReleaseWait.maxWaitMs, userTimeoutMs / 2);
}

/** What {@link waitForLingeringIpamAllocations} answers. */
export type IpamReleaseVerdict = 'released' | 'recheck' | 'none' | 'not-released';

/**
 * How many `'recheck'` re-sends one pool CIDR delete may make in all: a
 * handler lagging the listing clears in one or two, while a live allocation
 * beside a released one would otherwise re-send every poll until the budget.
 */
export const MAX_IPAM_RECHECKS = 3;

const IPAM_POOL_ID = /^ipam-pool-[0-9a-z]+$/;
const MAX_ALLOCATION_PAGES = 10;
/** Ids per `DescribeVpcs` / `DescribeSubnets` filter, under EC2's 200-value limit. */
const IDS_PER_DESCRIBE = 100;

/** Which of `ids` a paginated EC2 describe still lists. */
async function liveIds(
  ids: ReadonlySet<string>,
  describe: (
    chunk: string[],
    next: string | undefined
  ) => Promise<{ ids: (string | undefined)[]; next: string | undefined }>
): Promise<Set<string>> {
  const live = new Set<string>();
  const all = [...ids];
  for (let i = 0; i < all.length; i += IDS_PER_DESCRIBE) {
    const chunk = all.slice(i, i + IDS_PER_DESCRIBE);
    let next: string | undefined;
    do {
      const page = await describe(chunk, next);
      for (const id of page.ids) if (id) live.add(id);
      next = page.next;
    } while (next);
  }
  return live;
}

/**
 * The pool id in an `AWS::EC2::IPAMPoolCidr` Cloud Control identifier
 * (`<IpamPoolId>|<IpamPoolCidrId>`), or `undefined` for any other shape.
 */
export function ipamPoolIdOfPoolCidr(physicalId: string): string | undefined {
  const parts = physicalId.split('|');
  if (parts.length !== 2) return undefined;
  const poolId = parts[0]!;
  return IPAM_POOL_ID.test(poolId) ? poolId : undefined;
}

/**
 * The pool's allocations held by a VPC or subnet that is already DELETED: the
 * allocations AWS releases late (go-to-k/cdkd#5633, #5632). Only a resource of
 * the caller's account in the client's region counts, since only there does
 * an empty `DescribeVpcs` / `DescribeSubnets` answer mean "deleted" rather
 * than "not visible from here". Any other allocation (a live resource, a
 * manual allocation, a child pool, another account's or region's resource)
 * is not one AWS is about to release, so it is not waited on, and nor is one
 * that names no region. A listing cut at the page cap answers with what it
 * read. `total` counts every allocation listed, whoever holds it.
 */
export async function lingeringIpamAllocations(
  ec2: EC2Client,
  poolId: string,
  accountId: string,
  region: string
): Promise<{ lingering: string[]; total: number }> {
  const vpcIds = new Set<string>();
  const subnetIds = new Set<string>();
  let token: string | undefined;
  let pages = 0;
  let total = 0;
  do {
    const page = await ec2.send(
      new GetIpamPoolAllocationsCommand({ IpamPoolId: poolId, NextToken: token })
    );
    for (const a of page.IpamPoolAllocations ?? []) {
      total++;
      if (typeof a.ResourceId !== 'string' || a.ResourceId === '') continue;
      if (a.ResourceOwner !== accountId) continue;
      if (a.ResourceRegion !== region) continue;
      if (a.ResourceType === 'vpc') vpcIds.add(a.ResourceId);
      else if (a.ResourceType === 'subnet') subnetIds.add(a.ResourceId);
    }
    token = page.NextToken;
    pages++;
  } while (token && pages < MAX_ALLOCATION_PAGES);

  const liveVpcs = await liveIds(vpcIds, async (ids, next) => {
    const resp = await ec2.send(
      new DescribeVpcsCommand({ Filters: [{ Name: 'vpc-id', Values: ids }], NextToken: next })
    );
    return { ids: (resp.Vpcs ?? []).map((v) => v.VpcId), next: resp.NextToken };
  });
  const liveSubnets = await liveIds(subnetIds, async (ids, next) => {
    const resp = await ec2.send(
      new DescribeSubnetsCommand({
        Filters: [{ Name: 'subnet-id', Values: ids }],
        NextToken: next,
      })
    );
    return { ids: (resp.Subnets ?? []).map((s) => s.SubnetId), next: resp.NextToken };
  });
  const lingering = [
    ...[...vpcIds].filter((id) => !liveVpcs.has(id)),
    ...[...subnetIds].filter((id) => !liveSubnets.has(id)),
  ];
  return { lingering: lingering.sort(), total };
}

/**
 * go-to-k/cdkd#5975: after the `AWS::EC2::IPAMPoolCidr` delete was refused
 * with {@link IPAM_CIDR_HAS_ALLOCATIONS}, wait for the pool to release the
 * allocations of already-deleted VPCs and subnets, so the caller can send the
 * delete again.
 *
 * Answers:
 *  - `'released'`: there were such allocations and AWS has released them all;
 *    re-send the delete.
 *  - `'recheck'`: the first read found none, but the pool lists no allocation
 *    at all, or `afterRelease` says this delete was just re-sent on a release:
 *    the allocation went between the refusal and the read, or the handler's
 *    own check lags the listing. Re-send the delete, one poll interval later.
 *    Only while `allowRecheck`: the caller bounds how many it sends.
 *  - `'none'`: otherwise, when the first read found none: the refusal is not
 *    the release lag (a live or foreign resource holds the CIDR); fail now, as
 *    before.
 *  - `'not-released'`: the wait stopped first (its cap, a Ctrl-C, an
 *    unreadable listing), with `delete-gone-wait.ts`'s warning; fail.
 *
 * Nothing here deletes or releases anything: it reads, and the only write is
 * the caller's re-sent delete of the same pool CIDR.
 */
export async function waitForLingeringIpamAllocations(opts: {
  ec2: EC2Client;
  poolId: string;
  accountId: string;
  region: string;
  resourceType: string;
  logger: ReleaseLogger;
  maxWaitMs: number;
  /** This delete was re-sent on an earlier `'released'` answer. */
  afterRelease?: boolean;
  /** Whether a `'recheck'` may be answered; else such a case is `'none'`. */
  allowRecheck?: boolean;
  sleep?: (ms: number) => Promise<void>;
}): Promise<IpamReleaseVerdict> {
  const startedAt = Date.now();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let sawLingering = false;
  let released = false;
  let lastTotal = 0;
  await waitForGoneAfterDelete({
    what: `the IPAM pool ${opts.poolId} allocations of deleted VPCs and subnets`,
    stopped: `the IPAM pool ${opts.poolId} allocations of deleted VPCs and subnets: cdkd stopped waiting for AWS to release them`,
    resourceType: opts.resourceType,
    consequence: `the pool refuses to deprovision its CIDR ("${IPAM_CIDR_HAS_ALLOCATIONS}") until AWS releases them, so re-run the destroy once it has.`,
    describe: async () => {
      const { lingering, total } = await lingeringIpamAllocations(
        opts.ec2,
        opts.poolId,
        opts.accountId,
        opts.region
      );
      lastTotal = total;
      if (lingering.length === 0) {
        released = true;
        return undefined;
      }
      if (!sawLingering) {
        sawLingering = true;
        // Said up front: the release takes minutes, and a silent wait reads
        // as a hang. AWS-minted ids only.
        opts.logger.info(
          safeMsg`  IPAM pool ${opts.poolId} still holds the allocations of deleted ${lingering.join(', ')}; waiting for AWS to release them (it can take about 20 minutes), then deleting the pool CIDR again`
        );
      }
      return `allocated to ${lingering.join(', ')}`;
    },
    logger: opts.logger,
    pollIntervalMs: ipamPoolCidrReleaseWait.pollIntervalMs,
    maxWaitMs: opts.maxWaitMs,
    sleep,
  });
  if (!released) return 'not-released';
  if (sawLingering) return 'released';
  if (opts.allowRecheck !== true || (lastTotal > 0 && opts.afterRelease !== true)) return 'none';
  const remainingMs = opts.maxWaitMs - (Date.now() - startedAt);
  if (remainingMs <= 0) return 'none';
  await sleep(Math.min(ipamPoolCidrReleaseWait.pollIntervalMs, remainingMs));
  return 'recheck';
}
