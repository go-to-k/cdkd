import type { Subnet } from '@aws-sdk/client-ec2';
import {
  AssociateSubnetCidrBlockCommand,
  DisassociateSubnetCidrBlockCommand,
  DeleteSubnetCommand,
  DescribeSubnetsCommand,
  ModifySubnetAttributeCommand,
  DescribeNetworkInterfacesCommand,
  DeleteNetworkInterfaceCommand,
  type HostnameType,
} from '@aws-sdk/client-ec2';
import {
  enclosingDeadlineExpired,
  enclosingDeadlineRemainingMs,
} from '../../../deployment/resource-deadline.js';
import { canonicalizeIpv6Cidr } from '../../../utils/ipv6-cidr.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import type { UpdateContext } from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { isInterruptedWaitError, startInterruptWatch } from '../../interrupt-watch.js';
import { SUBNET_NOT_FOUND_NAMES, isNamedError } from './common.js';
import {
  AAAA_MEMBER,
  SUBNET_DETACH_BLOCKERS,
  SUBNET_PRIVATE_DNS_MEMBERS,
  type SubnetDetachAttribute,
  type SubnetPrivateDnsField,
  subnetPrivateDnsMemberValue,
} from './subnet-support.js';
import type { EC2Provider } from '../ec2-provider.js';

export async function updateSubnetIpv6CidrBlock(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  desired: string | undefined,
  recoverOnFailure = true,
  markUnsettled?: UpdateContext['markUnsettled']
): Promise<ReadonlySet<SubnetDetachAttribute>> {
  let response = await this.ec2Client.send(new DescribeSubnetsCommand({ SubnetIds: [physicalId] }));
  let subnet = response.Subnets?.[0];
  // A previous attempt may have stopped while AWS was still changing the
  // association. Settle that attempt before choosing what to detach/attach.
  for (const pending of subnet?.Ipv6CidrBlockAssociationSet ?? []) {
    const state = pending.Ipv6CidrBlockState?.State;
    if (pending.AssociationId && (state === 'associating' || state === 'disassociating')) {
      await this.waitForSubnetIpv6Association(
        logicalId,
        physicalId,
        resourceType,
        pending.AssociationId,
        state === 'associating' ? 'associated' : 'disassociated'
      );
      response = await this.ec2Client.send(new DescribeSubnetsCommand({ SubnetIds: [physicalId] }));
      subnet = response.Subnets?.[0];
    }
  }
  if (!subnet) {
    throw new ProvisioningError(
      `Subnet ${logicalId} was not returned by DescribeSubnets`,
      resourceType,
      logicalId,
      physicalId
    );
  }
  // Old disassociated entries remain in this array. Never use its first item.
  const current = subnet.Ipv6CidrBlockAssociationSet?.find(
    (association) => association.Ipv6CidrBlockState?.State === 'associated'
  );
  if (current?.Ipv6CidrBlock === desired) return new Set();
  const currentCidr = current?.Ipv6CidrBlock;
  const canonicalCurrent =
    currentCidr === undefined ? undefined : canonicalizeIpv6Cidr(currentCidr);
  if (
    canonicalCurrent !== undefined &&
    desired !== undefined &&
    canonicalCurrent === canonicalizeIpv6Cidr(desired)
  )
    return new Set();
  // go-to-k/cdkd#5632: EC2 refuses DisassociateSubnetCidrBlock while any
  // SUBNET_DETACH_BLOCKERS attribute is on (`InvalidCidrBlock.InUse`), so
  // each live-on one is turned off first; the caller decides whether to turn
  // it back on. The CloudFormation AWS::EC2::Subnet handler source is not
  // published, so this follows the measured EC2 behavior.
  const cleared = new Set<SubnetDetachAttribute>();
  try {
    if (current) {
      if (!current.AssociationId) {
        throw new ProvisioningError(
          `Subnet ${logicalId} has no IPv6 association ID; retry DescribeSubnets`,
          resourceType,
          logicalId,
          physicalId
        );
      }
      for (const blocker of SUBNET_DETACH_BLOCKERS) {
        if (blocker.live(subnet) !== true) continue;
        // EC2 refuses turning auto-assign off on an IPv6-native subnet; the
        // update path refuses its block change before reaching here.
        if (blocker.attribute === 'AssignIpv6AddressOnCreation' && subnet.Ipv6Native === true) {
          continue;
        }
        markUnsettled?.(blocker.unsettledKey);
        await this.writeSubnetAttribute(physicalId, blocker.attribute, false);
        cleared.add(blocker.attribute);
      }
      markUnsettled?.('Ipv6CidrBlock');
      await this.ec2Client.send(
        new DisassociateSubnetCidrBlockCommand({ AssociationId: current.AssociationId })
      );
      await this.waitForSubnetIpv6Association(
        logicalId,
        physicalId,
        resourceType,
        current.AssociationId,
        'disassociated'
      );
    }
    if (desired !== undefined) {
      markUnsettled?.('Ipv6CidrBlock');
      const associated = await this.ec2Client.send(
        new AssociateSubnetCidrBlockCommand({
          SubnetId: physicalId,
          Ipv6CidrBlock: desired,
        })
      );
      const associationId = associated.Ipv6CidrBlockAssociation?.AssociationId;
      if (!associationId) {
        throw new ProvisioningError(
          `AssociateSubnetCidrBlock returned no association ID for ${logicalId}`,
          resourceType,
          logicalId,
          physicalId
        );
      }
      await this.waitForSubnetIpv6Association(
        logicalId,
        physicalId,
        resourceType,
        associationId,
        'associated'
      );
    }
    return cleared;
  } catch (error) {
    // A failed attach must not silently leave the old record on a subnet
    // with no IPv6 block. Recover only the live block this call detached,
    // and what it turned off for the detach.
    if (
      current?.Ipv6CidrBlock !== undefined &&
      recoverOnFailure &&
      !isInterruptedWaitError(error) &&
      !enclosingDeadlineExpired()
    ) {
      try {
        await this.updateSubnetIpv6CidrBlock(
          logicalId,
          physicalId,
          resourceType,
          current.Ipv6CidrBlock,
          false,
          markUnsettled
        );
        for (const attribute of cleared) {
          await this.writeSubnetAttribute(physicalId, attribute, true);
        }
      } catch {
        this.logger.warn(
          safeMsg`Subnet ${logicalId}: IPv6 association recovery failed; inspect DescribeSubnets and redeploy before using the subnet`
        );
      }
    }
    throw error;
  }
}

/** Association changes are asynchronous; a new block cannot overlap the old one. */
export async function waitForSubnetIpv6Association(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  associationId: string,
  target: 'associated' | 'disassociated'
): Promise<void> {
  const watch = startInterruptWatch(`Subnet ${logicalId} IPv6 association wait`);
  try {
    for (let attempt = 0; attempt < 30; attempt++) {
      if (watch.isInterrupted()) throw watch.onInterrupted();
      if (enclosingDeadlineExpired()) break;
      const response = await this.ec2Client.send(
        new DescribeSubnetsCommand({ SubnetIds: [physicalId] })
      );
      const subnet = response.Subnets?.[0];
      const association = subnet?.Ipv6CidrBlockAssociationSet?.find(
        (item) => item.AssociationId === associationId
      );
      const state = association?.Ipv6CidrBlockState?.State;
      if (subnet && (state === target || (target === 'disassociated' && association === undefined)))
        return;
      if (state === 'failed' || state === 'failing') {
        throw new ProvisioningError(
          `IPv6 association change failed for Subnet ${logicalId}; inspect DescribeSubnets`,
          resourceType,
          logicalId,
          physicalId
        );
      }
      if (attempt < 29)
        await this.sleep(Math.max(0, Math.min(1000, enclosingDeadlineRemainingMs())));
    }
    throw markNonRetryable(
      new ProvisioningError(
        `Timed out waiting for Subnet ${logicalId} IPv6 association to be ${target}; inspect DescribeSubnets before retrying`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  } finally {
    watch.dispose();
  }
}

/** One `ModifySubnetAttribute` boolean write, then its read-back wait. */
export async function writeSubnetAttribute(
  this: EC2Provider,
  subnetId: string,
  attribute: SubnetDetachAttribute,
  value: boolean
): Promise<void> {
  await this.ec2Client.send(
    new ModifySubnetAttributeCommand({ SubnetId: subnetId, [attribute]: { Value: value } })
  );
  await this.waitForSubnetAttribute(subnetId, value, attribute);
}

/**
 * go-to-k/cdkd#5632: write each `PrivateDnsNameOptionsOnLaunch` member the
 * desired block declares and `previous` does not hold (every declared one
 * when `resend`), one `ModifySubnetAttribute` per member. A member the block
 * omits is left as AWS holds it, as for a removed `EnableDns64`. `pass`
 * splits an update around an IPv6 block change: `disable` writes only the
 * `false` record members, `rest` everything else.
 */
export async function applySubnetPrivateDnsOptions(
  this: EC2Provider,
  subnetId: string,
  desired: unknown,
  previous: unknown,
  resend: boolean,
  markUnsettled?: UpdateContext['markUnsettled'],
  pass: 'all' | 'disable' | 'rest' = 'all',
  skipAaaaOn = false
): Promise<void> {
  for (const member of SUBNET_PRIVATE_DNS_MEMBERS) {
    const value = subnetPrivateDnsMemberValue(desired, member);
    if (value === undefined) continue;
    if (skipAaaaOn && member === AAAA_MEMBER && value === true) continue;
    if (pass !== 'all' && (value === false) !== (pass === 'disable')) continue;
    if (!resend && value === subnetPrivateDnsMemberValue(previous, member)) continue;
    markUnsettled?.('PrivateDnsNameOptionsOnLaunch');
    await this.ec2Client.send(
      new ModifySubnetAttributeCommand({
        SubnetId: subnetId,
        ...(member.kind === 'string'
          ? { [member.field]: value as HostnameType }
          : { [member.field]: { Value: value as boolean } }),
      })
    );
    await this.waitForSubnetAttribute(subnetId, value, member.field);
  }
}

/**
 * Read back a subnet attribute until AWS reflects the value a
 * `ModifySubnetAttribute` just wrote (issue #1299). EC2 `Describe*` is
 * eventually consistent, so the deploy engine's async observed-state
 * capture (`kickOffObservedCapture` → `readCurrentState` →
 * `DescribeSubnets`), which fires milliseconds after `create()` /
 * `update()` returns, could read the STALE pre-modify value and persist
 * it as the drift baseline — every later `cdkd drift` then reported
 * phantom `MapPublicIpOnLaunch` drift on a resource nothing touched.
 *
 * Bounded and best-effort: the first read usually already reflects the
 * write (zero added latency beyond one DescribeSubnets round trip); on
 * exhaustion we log and return — behavior then degrades to the pre-fix
 * race instead of failing a deploy over a read-side consistency lag.
 */
export async function waitForSubnetAttribute(
  this: EC2Provider,
  subnetId: string,
  expected: boolean | string,
  attribute:
    | 'MapPublicIpOnLaunch'
    | 'EnableDns64'
    | 'AssignIpv6AddressOnCreation'
    | SubnetPrivateDnsField = 'MapPublicIpOnLaunch'
): Promise<void> {
  const maxAttempts = 6;
  const read = (subnet: Subnet | undefined): unknown => {
    const dns = SUBNET_PRIVATE_DNS_MEMBERS.find((m) => m.field === attribute);
    if (dns !== undefined) return subnet?.PrivateDnsNameOptionsOnLaunch?.[dns.member];
    return subnet?.[attribute as 'MapPublicIpOnLaunch' | 'EnableDns64'];
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await this.ec2Client.send(new DescribeSubnetsCommand({ SubnetIds: [subnetId] }));
      if (read(resp.Subnets?.[0]) === expected) return;
    } catch (error) {
      this.logger.debug(
        `${attribute} read-back for ${subnetId} failed (attempt ${attempt}/${maxAttempts}): ${describeAwsFailure(error).detail}`
      );
      return;
    }
    if (attempt < maxAttempts) {
      await this.sleep(100 * 2 ** (attempt - 1));
    }
  }
  this.logger.debug(
    `${attribute} update not yet visible on ${subnetId} after ${maxAttempts} reads — the observed-state capture may record the stale value`
  );
}

export async function deleteSubnet(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting Subnet ${logicalId}: ${physicalId}`);

  // Subnet deletes commonly fail with "has dependencies" when Lambda
  // hyperplane ENIs are still attached. The Lambda provider tries to
  // clean those up first, but its budget is finite and AWS's ENI release
  // is asynchronous — by the time we get here, leftover ENIs may still
  // exist. Retry with a side-channel: best-effort delete remaining
  // Lambda-managed ENIs in the subnet, sleep, then retry the subnet.
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await this.ec2Client.send(new DeleteSubnetCommand({ SubnetId: physicalId }));
      this.logger.debug(`Successfully deleted Subnet ${logicalId}`);
      return;
    } catch (error) {
      // go-to-k/cdkd#4606: a journaled orphan counts as gone only on
      // EC2's own not-found code; the broad matcher's message
      // substrings would clear a live orphan from the journal.
      if (
        this.isNotFoundError(error) &&
        (context?.failedCreateOrphan !== true || isNamedError(error, SUBNET_NOT_FOUND_NAMES))
      ) {
        const clientRegion = await this.ec2Client.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        if (context?.failedCreateOrphan === true) {
          // go-to-k/cdkd#4606: a journaled orphan already gone settles with
          // exit 0, so say so once. Masked by the caller's printing bag.
          this.logger.info(
            safeMsg`  Subnet ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
          );
        } else {
          this.logger.debug(`Subnet ${physicalId} does not exist, skipping deletion`);
        }
        return;
      }
      // `.detail`, never `.summary`: the substring test below is what keeps this
      // degradation alive, and it matches AWS's OWN wording. Byte-identical to
      // the ternary it replaced, minus that ternary's throw.
      // The thrown `ProvisioningError` further down names an AWS-authored
      // failure by its class only (`wrapCaughtError`, go-to-k/cdkd#2319).
      const msg = describeAwsFailure(error).detail;
      const isDependencyError =
        msg.includes('has dependencies') || msg.includes('DependencyViolation');
      if (isDependencyError && attempt < maxAttempts) {
        await this.cleanupSubnetLambdaEnis(physicalId);
        this.logger.debug(
          `Subnet ${physicalId} has dependencies (attempt ${attempt}/${maxAttempts}), retrying in ${attempt * 5}s...`
        );
        await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
        continue;
      }
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapDeleteError(
        maskerOrIdentity(context?.maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete Subnet ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }
}

/**
 * Best-effort: list Lambda-managed ENIs in the given subnet and try to
 * delete each one. Used as a side-channel cleanup when DeleteSubnet
 * fails with "has dependencies" — the Lambda provider's own ENI cleanup
 * may have run out of budget before AWS finished detaching, so a second
 * attempt from the subnet side typically succeeds a few seconds later
 * once the ENIs flip from `in-use` to `available`.
 */
export async function cleanupSubnetLambdaEnis(this: EC2Provider, subnetId: string): Promise<void> {
  let enis: { id: string; status: string }[];
  try {
    const resp = await this.ec2Client.send(
      new DescribeNetworkInterfacesCommand({
        Filters: [
          { Name: 'subnet-id', Values: [subnetId] },
          // `description` filter is the only reliable way to find Lambda
          // hyperplane ENIs — `requester-id` does not actually contain the
          // string "awslambda" (it is an AROA principal id).
          { Name: 'description', Values: ['AWS Lambda VPC ENI-*'] },
        ],
      })
    );
    enis = (resp.NetworkInterfaces ?? [])
      .filter((ni) => ni.NetworkInterfaceId)
      .map((ni) => ({ id: ni.NetworkInterfaceId!, status: ni.Status ?? 'unknown' }));
  } catch (err) {
    this.logger.debug(
      `cleanupSubnetLambdaEnis: DescribeNetworkInterfaces failed for ${subnetId}: ${
        describeAwsFailure(err).detail
      }`
    );
    return;
  }
  if (enis.length === 0) return;
  await Promise.all(
    enis.map(async (eni) => {
      try {
        await this.ec2Client.send(
          new DeleteNetworkInterfaceCommand({ NetworkInterfaceId: eni.id })
        );
        this.logger.debug(
          `cleanupSubnetLambdaEnis: deleted Lambda ENI ${eni.id} in subnet ${subnetId}`
        );
      } catch (err) {
        this.logger.debug(
          `cleanupSubnetLambdaEnis: ENI ${eni.id} (status=${eni.status}) not yet deletable: ${
            describeAwsFailure(err).detail
          }`
        );
      }
    })
  );
}

export async function getSubnetAttribute(
  this: EC2Provider,
  physicalId: string,
  attributeName: string
): Promise<unknown> {
  if (attributeName === 'SubnetId') return physicalId;

  try {
    const response = await this.ec2Client.send(
      new DescribeSubnetsCommand({ SubnetIds: [physicalId] })
    );
    const subnet = response.Subnets?.[0];
    if (!subnet) return undefined;

    if (attributeName === 'AvailabilityZone') return subnet.AvailabilityZone;
    return undefined;
  } catch {
    return undefined;
  }
}

/** The {@link EC2Provider} methods this module defines. */
export const subnetAttributesMethods = {
  updateSubnetIpv6CidrBlock,
  waitForSubnetIpv6Association,
  writeSubnetAttribute,
  applySubnetPrivateDnsOptions,
  waitForSubnetAttribute,
  deleteSubnet,
  cleanupSubnetLambdaEnis,
  getSubnetAttribute,
};
