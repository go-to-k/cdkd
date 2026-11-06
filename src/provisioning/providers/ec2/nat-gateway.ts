import {
  CreateNatGatewayCommand,
  DeleteNatGatewayCommand,
  DescribeNatGatewaysCommand,
  waitUntilNatGatewayAvailable,
  waitUntilNatGatewayDeleted,
  type AvailabilityMode,
  type NatGateway,
  AssociateNatGatewayAddressCommand,
  DisassociateNatGatewayAddressCommand,
} from '@aws-sdk/client-ec2';
import {
  CdkdError,
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import { acquireIdempotencyToken } from '../idempotency-token.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import type {
  CreateContext,
  UpdateContext,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource } from '../../created-resource-sink.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { startInterruptWatch } from '../../interrupt-watch.js';
import {
  NAT_ADDRESS_SETTLE_DELAY_MS,
  NAT_ADDRESS_SETTLE_POLLS,
  NAT_ADDRESS_UNLISTED_POLLS,
  type NatZoneAddressPlan,
  natAddressHeld,
  natGatewayAttributes,
  planNatZoneAddressUpdate,
  readNatZoneAddresses,
} from './nat-support.js';
import type { EC2Provider } from '../ec2-provider.js';

// ─── AWS::EC2::NatGateway ─────────────────────────────────────────
//
// CloudFormation parity: by default we wait for the new NAT gateway to
// reach `available` state before marking the resource created. NAT
// provisioning takes ~1–2 minutes (often the longest single step in a
// VPC stack). Pass `--no-wait` to skip the wait — `CreateNatGateway`
// returns the `NatGatewayId` immediately so dependent Routes /
// Subnets that only need the ID can proceed against a still-`pending`
// gateway. Anything that requires actual NAT-routed egress (e.g. a
// Lambda invocation that hits the internet during deploy) must not
// rely on the gateway being live; with `--no-wait`, AWS continues
// provisioning asynchronously after the deploy returns.

export async function createNatGateway(
  this: EC2Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating NatGateway ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  // go-to-k/cdkd#2762: a REGIONAL gateway is created at the VPC level and
  // takes VpcId, not SubnetId; a zonal one (the default) needs SubnetId.
  const regional = properties['AvailabilityMode'] === 'regional';
  const subnetId = properties['SubnetId'] as string | undefined;
  if (!subnetId && !regional) {
    throw new ProvisioningError(
      `SubnetId is required for NatGateway ${logicalId} (a regional NAT gateway, AvailabilityMode: regional, takes VpcId instead)`,
      resourceType,
      logicalId
    );
  }
  const zoneAddresses = readNatZoneAddresses(properties['AvailabilityZoneAddresses']);
  if (zoneAddresses.kind === 'unusable') {
    throw new ProvisioningError(
      `AvailabilityZoneAddresses of NatGateway ${logicalId} ${zoneAddresses.reason}; each entry needs AvailabilityZone or AvailabilityZoneId and a non-empty AllocationIds list`,
      resourceType,
      logicalId
    );
  }

  // Issue #2039: same duplicate-create window as `RunInstances`, and a
  // duplicate NAT gateway is the second most expensive orphan on the list.
  // Released only on the success path — a wiring failure after the create
  // (tags / the available-state wait) leaves the gateway in place on
  // purpose, so the retry must reuse the token and be handed that same
  // gateway rather than provisioning a second one.
  const natGatewayToken = acquireIdempotencyToken({
    scope: 'CreateNatGateway',
    logicalId,
  });

  // go-to-k/cdkd#4583: the gateway once CreateNatGateway returned; a later
  // failure leaves it in place on purpose (see the token note above).
  let createdId: string | undefined;
  try {
    const { response, tagsApplied } = await this.sendTaggedCreate(
      logicalId,
      'natgateway',
      desiredTags,
      (TagSpecifications) =>
        this.ec2Client.send(
          new CreateNatGatewayCommand({
            ...(TagSpecifications && { TagSpecifications }),
            ClientToken: natGatewayToken.value,
            SubnetId: subnetId,
            AvailabilityMode: properties['AvailabilityMode'] as AvailabilityMode | undefined,
            VpcId: properties['VpcId'] as string | undefined,
            ...(zoneAddresses.kind === 'usable' && {
              AvailabilityZoneAddresses: zoneAddresses.entries.map((entry) => ({
                AvailabilityZone: entry.availabilityZone,
                AvailabilityZoneId: entry.availabilityZoneId,
                AllocationIds: entry.allocationIds,
              })),
            }),
            AllocationId: properties['AllocationId'] as string | undefined,
            ConnectivityType:
              (properties['ConnectivityType'] as 'public' | 'private' | undefined) ?? undefined,
            PrivateIpAddress: properties['PrivateIpAddress'] as string | undefined,
            SecondaryAllocationIds: properties['SecondaryAllocationIds'] as string[] | undefined,
            SecondaryPrivateIpAddresses: properties['SecondaryPrivateIpAddresses'] as
              | string[]
              | undefined,
            SecondaryPrivateIpAddressCount: properties['SecondaryPrivateIpAddressCount'] as
              | number
              | undefined,
          })
        )
    );
    const natGatewayId = response.NatGateway!.NatGatewayId!;
    createdId = natGatewayId;
    // go-to-k/cdkd#5511: report before the tags and the available wait.
    reportCreatedResource(logicalId, resourceType, natGatewayId);

    // Tags the create did not carry (go-to-k/cdkd#4971)
    if (!tagsApplied)
      await this.applyTags(
        natGatewayId,
        desiredTags,
        logicalId,
        maskerOrIdentity(context?.maskSecrets)
      );

    // Wait for `available` state unless --no-wait is set. Same gating
    // pattern as CloudFront / RDS / ElastiCache providers (env var
    // `CDKD_NO_WAIT=true` is set by the CLI when --no-wait is passed).
    // The waiter's last DescribeNatGateways answer carries the computed
    // attributes, so recording them costs no extra call.
    let described: NatGateway | undefined;
    if (process.env['CDKD_NO_WAIT'] !== 'true') {
      this.logger.debug(`Waiting for NatGateway ${natGatewayId} to reach available state...`);
      const waited = await waitUntilNatGatewayAvailable(
        // 15-min cap matches AWS's documented worst case for NAT
        // provisioning. Per-resource `--resource-timeout` (default
        // 30 min) still bounds the outer call as a backstop.
        //
        // minDelay/maxDelay override the AWS SDK defaults (15s / 120s). A NAT
        // typically reaches `available` in ~90s, so the default exponential
        // backoff — whose late polls are up to 120s apart — can detect the
        // ready state up to ~2 min late (and with wild variance depending on
        // where the ready moment falls relative to the sparse poll schedule).
        // That made cdkd systematically slower than tools that poll on a
        // tight interval. The delay is
        // `uniform_random(minDelay, min(minDelay * 2^(attempt-1), maxDelay))`,
        // so the mean detection lag settles at about maxDelay/2 -- 5s here,
        // matching the 10s cap the #1177 sweep applied to the ELBv2 and ECS
        // waiters. This pair was missed by that sweep and kept a 15s cap.
        { client: this.ec2Client, maxWaitTime: 15 * 60, minDelay: 5, maxDelay: 10 },
        { NatGatewayIds: [natGatewayId] }
      );
      described = (waited.reason as { NatGateways?: NatGateway[] } | undefined)?.NatGateways?.find(
        (g) => g.NatGatewayId === natGatewayId
      );
      this.logger.debug(`NatGateway ${natGatewayId} is available`);
    } else {
      this.logger.debug(
        `NatGateway ${natGatewayId} created (skipping available-state wait per --no-wait)`
      );
    }

    this.logger.debug(`Successfully created NatGateway ${logicalId}: ${natGatewayId}`);

    natGatewayToken.release();
    return {
      physicalId: natGatewayId,
      attributes: {
        // Under --no-wait only the create's own answer is in hand: it carries
        // the automatic-mode flags, while RouteTableId (and a zonal EniId)
        // appear once the gateway is available, read by the attribute heal.
        ...natGatewayAttributes(response.NatGateway ?? {}),
        ...(described !== undefined && natGatewayAttributes(described)),
        NatGatewayId: natGatewayId,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create NatGateway ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
    if (createdId !== undefined) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, createdId);
    }
    throw thrown;
  }
}

/**
 * `AWS::EC2::NatGateway` in place: `Tags` and a regional gateway's
 * `AvailabilityZoneAddresses` (go-to-k/cdkd#2762), which the registry schema
 * leaves mutable and CloudFormation updates without replacing the gateway.
 *
 * Every other property is either CREATE-only (the deploy engine's
 * replacement detection routes it to DELETE + CREATE before this method; a
 * change reaching here comes from `cdkd drift --revert`, and silently
 * no-op'ing would read as a reverted drift) or a zonal gateway's secondary
 * addresses, which this provider does not move: both are refused.
 */
export async function updateNatGateway(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  this.logger.debug(safeMsg`Updating NatGateway ${logicalId}: ${physicalId}`);
  const refuse = (property: string): never => {
    throw new ResourceUpdateNotSupportedError(
      resourceType,
      logicalId,
      `destroy + redeploy the NatGateway (and the dependent Routes). cdkd cannot change ${property} of an existing NAT gateway`
    );
  };
  // CREATE-only: a change only when both sides hold a value (a drift
  // --revert bag carries readback keys the record never declared).
  for (const key of [
    'SubnetId',
    'ConnectivityType',
    'AllocationId',
    'PrivateIpAddress',
    'AvailabilityMode',
    'VpcId',
  ]) {
    const next = properties[key];
    const prev = previousProperties[key];
    if (next !== undefined && prev !== undefined && JSON.stringify(next) !== JSON.stringify(prev)) {
      refuse(key);
    }
  }
  // An automatic-mode gateway gaining zone addresses is a REPLACEMENT in
  // CloudFormation (`natZoneAddressesAddedToAutomaticGateway` routes the
  // deploy there); only `cdkd drift --revert` reaches this arm with it.
  if (
    previousProperties['AvailabilityZoneAddresses'] == null &&
    properties['AvailabilityZoneAddresses'] != null
  ) {
    throw new ResourceUpdateNotSupportedError(
      resourceType,
      logicalId,
      'destroy + redeploy the NatGateway (and the dependent Routes). Adding AvailabilityZoneAddresses to a gateway created without it replaces the gateway'
    );
  }
  // Mutable in CloudFormation, not moved here: any difference, an addition
  // or a removal included.
  for (const key of [
    'SecondaryAllocationIds',
    'SecondaryPrivateIpAddresses',
    'SecondaryPrivateIpAddressCount',
  ]) {
    if (JSON.stringify(properties[key]) !== JSON.stringify(previousProperties[key])) {
      refuse(key);
    }
  }

  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
  const mask = maskerOrIdentity(context?.maskSecrets);

  try {
    // The address plan is decided before the first mutating call, so a
    // refusal leaves the gateway untouched.
    let zonePlan: NatZoneAddressPlan | undefined;
    if (
      JSON.stringify(properties['AvailabilityZoneAddresses']) !==
      JSON.stringify(previousProperties['AvailabilityZoneAddresses'])
    ) {
      zonePlan = await this.planNatGatewayZoneAddresses(
        logicalId,
        physicalId,
        resourceType,
        properties['AvailabilityZoneAddresses']
      );
    }

    // Addresses first: a refused address call leaves the tags unchanged too.
    if (zonePlan !== undefined) {
      await this.applyNatGatewayZoneAddresses(logicalId, physicalId, resourceType, zonePlan);
    }

    await this.applyTagDiff(
      physicalId,
      resourceType,
      logicalId,
      previousProperties['Tags'],
      properties['Tags'],
      mask
    );
    this.logger.debug(safeMsg`Successfully updated NatGateway ${logicalId}`);
    return { physicalId, wasReplaced: false };
  } catch (error) {
    if (error instanceof CdkdError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update NatGateway ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * Plan a regional NAT gateway's `AvailabilityZoneAddresses` change against
 * its live addresses, refusing — before any mutating call — a desired value
 * that cannot be read (read as empty it would release every address) and an
 * allocation id declared in a zone other than the one holding it.
 */
export async function planNatGatewayZoneAddresses(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  rawDesired: unknown
): Promise<NatZoneAddressPlan | undefined> {
  const desired = readNatZoneAddresses(rawDesired);
  if (desired.kind === 'unusable') {
    throw markNonRetryable(
      new ProvisioningError(
        `AvailabilityZoneAddresses of NatGateway ${logicalId} ${desired.reason}; each entry needs AvailabilityZone or AvailabilityZoneId and a non-empty AllocationIds list`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }
  if (desired.kind === 'absent') {
    // CloudFormation fails this update too ("AvailabilityZoneAddress cannot
    // be empty when AutoScalingIpsEnabled set to false"; A/B on #2762): a
    // gateway created with explicit zones never returns to automatic mode,
    // and AWS refuses to release its last address.
    throw markNonRetryable(
      new ProvisioningError(
        `NatGateway ${logicalId} cannot drop AvailabilityZoneAddresses: a regional NAT gateway created with explicit zones does not return to automatic zone expansion, and CloudFormation refuses the same update. Keep at least one zone declared, or rename the logical id or change a create-only property to replace the gateway`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }
  const response = await this.ec2Client.send(
    new DescribeNatGatewaysCommand({ NatGatewayIds: [physicalId] })
  );
  const gateway = response.NatGateways?.find((g) => g.NatGatewayId === physicalId);
  if (gateway === undefined) {
    throw new ProvisioningError(
      `NatGateway ${logicalId} (${physicalId}) was not returned by DescribeNatGateways, so its addresses cannot be updated`,
      resourceType,
      logicalId,
      physicalId
    );
  }
  const plan = planNatZoneAddressUpdate(desired.entries, gateway.NatGatewayAddresses ?? []);
  // What the plan saw, at --verbose: the vpc-nat-gateway fixture reads these
  // lines to tell a wait that was needed and skipped from one AWS made moot.
  for (const d of plan.disassociate) {
    const status =
      gateway.NatGatewayAddresses?.find((x) => x.AllocationId === d.allocationId)?.Status ??
      'unknown';
    this.logger.debug(
      safeMsg`NatGateway ${physicalId} plans to release ${d.allocationId} (live status ${status})`
    );
  }
  for (const id of plan.awaitingRelease) {
    this.logger.debug(
      safeMsg`NatGateway ${physicalId} plans to associate ${id}, which AWS is still releasing`
    );
  }
  if (plan.moved.length > 0) {
    throw markNonRetryable(
      new ProvisioningError(
        `NatGateway ${logicalId} declares ${plan.moved.join(', ')} in a different zone from the one that holds it; cdkd does not move an Elastic IP between zones in one update. Remove it from AvailabilityZoneAddresses in one deploy and add it to the new zone in the next`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }
  return plan;
}

/**
 * Run a planned address change: associate first, release second — AWS
 * refuses a release that would leave the gateway without an address.
 *
 * Returns once AWS accepts the calls, without waiting the minutes an
 * association or release takes to settle (CloudFormation waits): the
 * gateway keeps serving its other zones meanwhile. It waits only where AWS
 * would otherwise REFUSE the call (each measured on #2762):
 * - re-associating an address AWS is still releasing waits for the release;
 * - releasing an address still being associated (no association id yet;
 *   e.g. a rollback right after the deploy that added it) waits for the
 *   association;
 * - a release leaving the gateway no associated address
 *   (`NatZoneAddressPlan.keptSettled`) waits until an address the template
 *   keeps has associated.
 */
export async function applyNatGatewayZoneAddresses(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  plan: NatZoneAddressPlan
): Promise<void> {
  // ONE budget for every wait of this update, so their sum stays inside the
  // default 30-minute --resource-timeout and a timeout names the wait.
  const budget = { polls: NAT_ADDRESS_SETTLE_POLLS };
  if (plan.awaitingRelease.length > 0) {
    const ids = new Set(plan.awaitingRelease);
    await this.pollNatGateway(
      logicalId,
      physicalId,
      resourceType,
      budget,
      `the release of ${plan.awaitingRelease.join(', ')}`,
      'nothing was associated or released',
      (gateway) =>
        (gateway.NatGatewayAddresses ?? []).some(
          (a) =>
            typeof a.AllocationId === 'string' &&
            ids.has(a.AllocationId) &&
            a.Status === 'disassociating'
        )
          ? 'wait'
          : 'done'
    );
  }
  for (const entry of plan.associate) {
    await this.ec2Client.send(
      new AssociateNatGatewayAddressCommand({
        NatGatewayId: physicalId,
        AllocationIds: entry.allocationIds,
        AvailabilityZone: entry.availabilityZone,
        AvailabilityZoneId: entry.availabilityZoneId,
      })
    );
  }
  if (plan.disassociate.length === 0) return;

  let associationIds = plan.disassociate
    .map((d) => d.associationId)
    .filter((id): id is string => id !== undefined);
  const unassociated = plan.disassociate.filter((d) => d.associationId === undefined);
  if (unassociated.length > 0) {
    const targets = new Set(unassociated.map((d) => d.allocationId));
    const gateway = await this.pollNatGateway(
      logicalId,
      physicalId,
      resourceType,
      budget,
      `the association of ${unassociated.map((d) => d.allocationId).join(', ')} before releasing it`,
      'the release was not sent',
      (gw) =>
        (gw.NatGatewayAddresses ?? []).some(
          (a) =>
            typeof a.AllocationId === 'string' &&
            targets.has(a.AllocationId) &&
            natAddressHeld(a) &&
            !(a.Status === 'succeeded' && typeof a.AssociationId === 'string')
        )
          ? 'wait'
          : 'done'
    );
    // A target whose association failed (or that AWS already dropped) is no
    // longer held: there is nothing to release for it.
    for (const a of gateway.NatGatewayAddresses ?? []) {
      if (
        typeof a.AllocationId === 'string' &&
        targets.has(a.AllocationId) &&
        natAddressHeld(a) &&
        typeof a.AssociationId === 'string'
      ) {
        associationIds.push(a.AssociationId);
      }
    }
    associationIds = [...new Set(associationIds)];
  }
  if (associationIds.length === 0) return;

  if (!plan.keptSettled) {
    const releasing = new Set(plan.disassociate.map((d) => d.allocationId));
    const added = plan.associate.flatMap((e) => e.allocationIds);
    let unlisted = 0;
    await this.pollNatGateway(
      logicalId,
      physicalId,
      resourceType,
      budget,
      'an address the template keeps to associate before releasing the last associated one',
      'the release was not sent',
      (gw) => {
        const kept = (gw.NatGatewayAddresses ?? []).filter(
          (a) => typeof a.AllocationId === 'string' && !releasing.has(a.AllocationId)
        );
        if (kept.some((a) => a.Status === 'succeeded')) return 'done';
        if (kept.some((a) => a.Status === 'associating')) return 'wait';
        // DescribeNatGateways may not list a just-associated address yet,
        // but only briefly: one it never lists will never settle.
        const missing = added.filter((id) => !kept.some((a) => a.AllocationId === id));
        if (missing.length > 0) {
          unlisted++;
          if (unlisted <= NAT_ADDRESS_UNLISTED_POLLS) return 'wait';
          return markNonRetryable(
            new ProvisioningError(
              `NatGateway ${logicalId} does not list ${missing.join(', ')} after associating it, so its last associated address was not released. Check \`aws ec2 describe-nat-gateways --nat-gateway-ids ${physicalId}\` and re-run the deploy`,
              resourceType,
              logicalId,
              physicalId
            )
          );
        }
        // Only this update's own associations are named: an older failed
        // address is not what kept the release from going ahead.
        const failed = added.filter(
          (id) => kept.find((a) => a.AllocationId === id)?.Status === 'failed'
        );
        return markNonRetryable(
          new ProvisioningError(
            failed.length > 0
              ? `NatGateway ${logicalId} could not associate ${failed.join(', ')}, so its last associated address was not released. Read the failure with \`aws ec2 describe-nat-gateways --nat-gateway-ids ${physicalId}\` and fix the declared Elastic IP`
              : `NatGateway ${logicalId} has no other associated or associating address, so its last associated address was not released. Declare an Elastic IP the gateway can associate`,
            resourceType,
            logicalId,
            physicalId
          )
        );
      }
    );
  }
  await this.ec2Client.send(
    new DisassociateNatGatewayAddressCommand({
      NatGatewayId: physicalId,
      AssociationIds: associationIds,
    })
  );
}

/**
 * Poll `DescribeNatGateways` until `decide` answers `'done'` (returning that
 * read), throwing the error it returns instead. Every wait of one update
 * draws on the same `budget` ({@link NAT_ADDRESS_SETTLE_POLLS} in all), and
 * is Ctrl-C aware; `unsent` says what the timeout leaves undone. A gateway that is gone,
 * deleting or failed ends the wait at once: no address of it will settle.
 */
export async function pollNatGateway(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  budget: { polls: number },
  what: string,
  unsent: string,
  decide: (gateway: NatGateway) => 'done' | 'wait' | ProvisioningError
): Promise<NatGateway> {
  this.logger.debug(safeMsg`Waiting for NatGateway ${physicalId}: ${what}...`);
  const watch = startInterruptWatch(`NatGateway ${logicalId} address wait`);
  try {
    while (budget.polls > 0) {
      budget.polls--;
      if (watch.isInterrupted()) throw watch.onInterrupted();
      const response = await this.ec2Client.send(
        new DescribeNatGatewaysCommand({ NatGatewayIds: [physicalId] })
      );
      const gateway = response.NatGateways?.find((g) => g.NatGatewayId === physicalId);
      if (
        gateway === undefined ||
        gateway.State === 'deleting' ||
        gateway.State === 'deleted' ||
        gateway.State === 'failed'
      ) {
        throw markNonRetryable(
          new ProvisioningError(
            `NatGateway ${logicalId} (${physicalId}) is ${gateway?.State ?? 'no longer returned by DescribeNatGateways'}, so cdkd stopped waiting for ${what}`,
            resourceType,
            logicalId,
            physicalId
          )
        );
      }
      const verdict = decide(gateway);
      if (verdict === 'done') return gateway;
      if (verdict !== 'wait') throw verdict;
      await this.sleep(NAT_ADDRESS_SETTLE_DELAY_MS);
    }
  } finally {
    watch.dispose();
  }
  throw markNonRetryable(
    new ProvisioningError(
      `NatGateway ${logicalId} ran out of its ${(NAT_ADDRESS_SETTLE_POLLS * NAT_ADDRESS_SETTLE_DELAY_MS) / 60000}-minute address wait while waiting for ${what}; ${unsent}. Re-run the deploy once \`aws ec2 describe-nat-gateways --nat-gateway-ids ${physicalId}\` shows its addresses settled`,
      resourceType,
      logicalId,
      physicalId
    )
  );
}

export async function deleteNatGateway(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting NatGateway ${logicalId}: ${physicalId}`);

  try {
    await this.ec2Client.send(new DeleteNatGatewayCommand({ NatGatewayId: physicalId }));
  } catch (error) {
    if (this.isNotFoundError(error)) {
      const clientRegion = await this.ec2Client.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      if (context?.failedCreateOrphan === true) {
        // go-to-k/cdkd#4606: a journaled orphan already gone settles with
        // exit 0, so say so once. Masked by the caller's printing bag.
        this.logger.info(
          safeMsg`  NAT gateway ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
        );
      } else {
        this.logger.debug(`NatGateway ${physicalId} does not exist, skipping deletion`);
      }
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapDeleteError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete NatGateway ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }

  // Wait for the gateway to fully release its ENI / EIP / route
  // table associations BEFORE returning. This wait is INTENTIONALLY
  // not gated on `--no-wait`. NAT Gateway is asymmetric:
  //
  //   - On CREATE, the SDK call returns the NatGatewayId
  //     immediately and downstream Routes accept a still-`pending`
  //     gateway as a target. Skipping the available-state wait is
  //     safe — AWS finishes provisioning asynchronously and the
  //     deploy can return early.
  //   - On DELETE, the same asynchronous teardown blocks every
  //     OTHER destroy that lands in the same VPC. While the
  //     gateway is still in `deleting` state, AWS keeps the ENI
  //     attached to the public subnet and the EIP allocated to
  //     the gateway, so DeleteSubnet / DeleteInternetGateway /
  //     DeleteVpc all return `DependencyViolation`. The deploy
  //     engine then enters a retry storm and the destroy can run
  //     for 15+ minutes before either succeeding or failing
  //     partway through (which is what surfaced in the v0.31
  //     follow-up bench).
  //
  // The right answer is to ALWAYS wait on delete, treating
  // `--no-wait` as a deploy-time-only flag for NAT. CloudFront and
  // RDS leaf resources can safely skip their delete waits because
  // nothing in the destroy DAG depends on them being fully gone.
  this.logger.debug(`Waiting for NatGateway ${physicalId} to reach deleted state...`);
  try {
    await waitUntilNatGatewayDeleted(
      // Tighten the poll interval off the AWS SDK defaults (15s / 120s) for
      // the same reason as the available-state wait above: a sparse late poll
      // adds up to ~2 min of dead time detecting the terminal state. Same 10s
      // cap as that wait, and as the #1177-swept siblings.
      { client: this.ec2Client, maxWaitTime: 15 * 60, minDelay: 5, maxDelay: 10 },
      { NatGatewayIds: [physicalId] }
    );
  } catch (error) {
    // The waiter has no FAILURE acceptor (only `deleted` and
    // `NatGatewayNotFound` end it) and retries every other describe
    // error, so it throws only on TIMEOUT. Treat that as a soft
    // warning — the EC2 console will show the gateway, the user
    // can clean it up manually. We do NOT re-throw because doing
    // so would block downstream Subnet / VPC delete from running,
    // which is worse.
    const waitHead = `Wait for NatGateway ${physicalId} deletion did not complete cleanly: `;
    this.logger.warn(
      `${waitHead}${this.warnFailureSentence(waitHead, error, maskerOrIdentity(context?.maskSecrets))} Proceeding with downstream delete steps.`
    );
  }

  this.logger.debug(`Successfully deleted NatGateway ${logicalId}`);
}

/** The {@link EC2Provider} methods this module defines. */
export const natGatewayMethods = {
  createNatGateway,
  updateNatGateway,
  planNatGatewayZoneAddresses,
  applyNatGatewayZoneAddresses,
  pollNatGateway,
  deleteNatGateway,
};
