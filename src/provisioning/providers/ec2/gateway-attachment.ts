import {
  DescribeInternetGatewaysCommand,
  AttachInternetGatewayCommand,
  DetachInternetGatewayCommand,
  AttachVpnGatewayCommand,
  DetachVpnGatewayCommand,
  DescribeVpnGatewaysCommand,
} from '@aws-sdk/client-ec2';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { compositeIdFormatMessage, packCompositeId } from '../../composite-id.js';
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
import { isEc2NotFoundCode, isNamedError } from './common.js';
import {
  EC2_VPC_GATEWAY_ATTACHMENT_ID_FORMAT,
  VPN_DETACH_IN_PROGRESS_ERRORS,
  VPN_GATEWAY_ATTACHMENT_WAIT_MS,
} from './network-support.js';
import type { EC2Provider } from '../ec2-provider.js';

// ─── AWS::EC2::VPCGatewayAttachment ───────────────────────────────

/**
 * Which gateway an attachment's template bag names. CloudFormation's
 * documentation takes exactly one of `InternetGatewayId` / `VpnGatewayId`
 * ("You must specify either InternetGatewayId or VpnGatewayId, but not
 * both"), so a bag naming both or neither is refused before any AWS call.
 */
export function resolveVpcGatewayAttachmentTarget(
  this: EC2Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>
): { vpcId: string; kind: 'igw' | 'vgw'; gatewayId: string } {
  const vpcId = properties['VpcId'];
  const igw = properties['InternetGatewayId'];
  const vgw = properties['VpnGatewayId'];
  const hasIgw = typeof igw === 'string' && igw !== '';
  const hasVgw = typeof vgw === 'string' && vgw !== '';
  if (typeof vpcId !== 'string' || vpcId === '' || hasIgw === hasVgw) {
    throw new ProvisioningError(
      hasIgw && hasVgw
        ? `VPCGatewayAttachment ${logicalId} specifies both InternetGatewayId and VpnGatewayId; CloudFormation accepts exactly one`
        : `VpcId and exactly one of InternetGatewayId / VpnGatewayId are required for VPCGatewayAttachment ${logicalId}`,
      resourceType,
      logicalId
    );
  }
  return hasIgw
    ? { vpcId, kind: 'igw', gatewayId: igw }
    : { vpcId, kind: 'vgw', gatewayId: vgw as string };
}

export async function createVpcGatewayAttachment(
  this: EC2Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating VPCGatewayAttachment ${logicalId}`);

  const { vpcId, kind, gatewayId } = this.resolveVpcGatewayAttachmentTarget(
    logicalId,
    resourceType,
    properties
  );

  // Both segments are AWS-generated (`igw-...` / `vgw-...` / `vpc-...`), so
  // neither is pipe-capable and this is uniform defense-in-depth (issue
  // #1672). Computed before the AWS call so a refusal cannot leave an
  // attachment AWS has already made without a state record.
  const physicalId = packCompositeId(
    resourceType,
    logicalId,
    [
      { name: kind === 'igw' ? 'internetGatewayId' : 'vpnGatewayId', value: gatewayId },
      { name: 'vpcId', value: vpcId },
    ],
    {
      // Issue #2176: the refusal QUOTES the offending segment value, on the
      // thrown arm (durable) and the warn arm (terminal) alike, so the masker
      // goes through unconditionally -- it is absent on the paths that have no
      // context, where it degrades to identity.
      maskSecrets: context?.maskSecrets,
      ...(context?.replayingState === true && {
        onRefusal: (message: string) => this.logger.warn(message),
      }),
    }
  );

  let attachSent = false;
  try {
    if (kind === 'igw') {
      await this.ec2Client.send(
        new AttachInternetGatewayCommand({ VpcId: vpcId, InternetGatewayId: gatewayId })
      );
    } else {
      // `AttachVpnGateway` answers `attaching`; a `Route` through the
      // gateway is only accepted once the attachment is `attached`, so the
      // create waits for that state.
      await this.ec2Client.send(
        new AttachVpnGatewayCommand({ VpcId: vpcId, VpnGatewayId: gatewayId })
      );
      attachSent = true;
      // go-to-k/cdkd#5511: report before the attachment wait.
      reportCreatedResource(logicalId, resourceType, physicalId);
      await this.waitForVpnGatewayAttachment(gatewayId, vpcId, 'attached', logicalId);
    }

    this.logger.debug(`Successfully created VPCGatewayAttachment ${logicalId}: ${physicalId}`);

    return {
      physicalId,
      attributes: {},
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create VPCGatewayAttachment ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
    // The attach call succeeded and only the wait failed: the attachment
    // exists in AWS, so the record must say so for a later destroy to detach it.
    if (attachSent) markCreatedBeforeFailure(thrown, logicalId, resourceType, physicalId);
    throw thrown;
  }
}

/**
 * Poll `DescribeVpnGateways` until the gateway's attachment to `vpcId`
 * reaches `target`. `detached` also counts an attachment AWS no longer
 * lists, or a gateway it no longer knows, as reached. Throws when the state
 * is not reached within {@link VPN_GATEWAY_ATTACHMENT_WAIT_MS}.
 */
export async function waitForVpnGatewayAttachment(
  this: EC2Provider,
  vpnGatewayId: string,
  vpcId: string,
  target: 'attached' | 'detached',
  logicalId: string,
  redetach?: () => Promise<unknown>
): Promise<void> {
  const started = Date.now();
  let redetachSent = false;
  let delay = 2000;
  let last = 'unknown';
  for (;;) {
    // Every entry for this VPC, not the first: a `detached` entry left by an
    // earlier attachment can sit beside the current one.
    let states: string[];
    try {
      const resp = await this.ec2Client.send(
        new DescribeVpnGatewaysCommand({ VpnGatewayIds: [vpnGatewayId] })
      );
      states = (resp.VpnGateways?.[0]?.VpcAttachments ?? [])
        .filter((a) => a.VpcId === vpcId)
        .map((a) => String(a.State));
    } catch (error) {
      // Only EC2's own `*.NotFound` code proves the gateway is gone (#4283).
      if (target === 'detached' && isEc2NotFoundCode(error)) return;
      throw error;
    }
    if (target === 'attached' && states.includes('attached')) return;
    if (target === 'detached' && states.every((st) => st === 'detached')) return;
    // A detach refused as `IncorrectState` while the attachment was still
    // `attaching` (an interrupted create) never took: once it reads
    // `attached`, send the detach again, once.
    if (target === 'detached' && redetach && !redetachSent && states.includes('attached')) {
      redetachSent = true;
      try {
        await redetach();
      } catch (error) {
        // Already `detaching` (a lagging read) or already gone: keep polling.
        if (!isNamedError(error, VPN_DETACH_IN_PROGRESS_ERRORS) && !isEc2NotFoundCode(error)) {
          throw error;
        }
      }
    }
    last = states.length === 0 ? 'absent' : states.join(', ');
    if (Date.now() - started >= VPN_GATEWAY_ATTACHMENT_WAIT_MS) {
      throw new Error(
        `VPN gateway ${vpnGatewayId} attachment to ${vpcId} did not reach '${target}' within ` +
          `${VPN_GATEWAY_ATTACHMENT_WAIT_MS / 60000} minutes (last state: ${last}) for ${logicalId}`
      );
    }
    await this.sleep(delay);
    delay = Math.min(delay * 2, 10000);
  }
}

/**
 * Split an attachment physicalId into its gateway kind, gateway, and VPC.
 *
 * cdkd's own packer writes `<igw-…|vgw-…>|<vpcId>`. A Cloud-Control-written
 * record carries the attachment TYPE token instead (`IGW` / `VGW`, or the
 * never-written `InternetGateway` / `VPN` aliases `export.ts` also accepts);
 * a pre-v7 record of that shape has no `provisionedBy` and reaches this
 * provider (go-to-k/cdkd#2762 review). A token is never sent to AWS as a
 * gateway id: `gatewayId` is `undefined` and the caller resolves it from the
 * VPC. Anything else is refused with the format message.
 */
export function parseVpcGatewayAttachmentId(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string
): { kind: 'igw' | 'vgw'; gatewayId: string | undefined; vpcId: string } {
  const parts = physicalId.split('|');
  const [first, vpcId] = parts;
  if (parts.length === 2 && first && vpcId) {
    if (first.startsWith('igw-')) return { kind: 'igw', gatewayId: first, vpcId };
    if (first.startsWith('vgw-')) return { kind: 'vgw', gatewayId: first, vpcId };
    if (first === 'IGW' || first === 'InternetGateway') {
      return { kind: 'igw', gatewayId: undefined, vpcId };
    }
    if (first === 'VGW' || first === 'VPN') return { kind: 'vgw', gatewayId: undefined, vpcId };
  }
  throw new ProvisioningError(
    compositeIdFormatMessage(EC2_VPC_GATEWAY_ATTACHMENT_ID_FORMAT, logicalId, physicalId),
    resourceType,
    logicalId,
    physicalId
  );
}

/**
 * The gateway of `kind` AWS reports attached to `vpcId` (an
 * `attachment.vpc-id` filter), for a record that names only the attachment
 * type. `includeDetaching` also counts a VPN attachment still `detaching`,
 * which a delete must wait out. `undefined` when none is.
 */
export async function findAttachedGatewayId(
  this: EC2Provider,
  kind: 'igw' | 'vgw',
  vpcId: string,
  includeDetaching: boolean
): Promise<string | undefined> {
  const filter = { Filters: [{ Name: 'attachment.vpc-id', Values: [vpcId] }] };
  if (kind === 'igw') {
    const resp = await this.ec2Client.send(new DescribeInternetGatewaysCommand(filter));
    return resp.InternetGateways?.find((g) =>
      g.Attachments?.some(
        (a) => a.VpcId === vpcId && ['available', 'attached'].includes(String(a.State))
      )
    )?.InternetGatewayId;
  }
  const live = includeDetaching
    ? ['attaching', 'attached', 'detaching']
    : ['attaching', 'attached'];
  const resp = await this.ec2Client.send(new DescribeVpnGatewaysCommand(filter));
  return resp.VpnGateways?.find(
    (g) =>
      g.State !== 'deleted' &&
      g.VpcAttachments?.some((a) => a.VpcId === vpcId && live.includes(String(a.State)))
  )?.VpnGatewayId;
}

/** The gateway id of `kind` a record's own properties name, when well-formed. */
export function recordedGatewayIdOf(
  this: EC2Provider,
  kind: 'igw' | 'vgw',
  properties: Record<string, unknown> | undefined
): string | undefined {
  const value = properties?.[kind === 'igw' ? 'InternetGatewayId' : 'VpnGatewayId'];
  return typeof value === 'string' && value.startsWith(`${kind}-`) ? value : undefined;
}

/**
 * The gateway a type-token record (`VGW|vpc-…`) denotes, for a detach.
 *
 * Pinned to the id the record's own properties name: a shared VPC can hold
 * another stack's gateway by the time this runs (the record's own detached
 * out of band), and the `attachment.vpc-id` filter would return THAT one.
 * The pinned id is detached by id, so an attachment AWS no longer has
 * answers not-found instead of hitting a foreign gateway. With no recorded
 * id, an empty filter answer is `undefined` (the caller confirms the region
 * before reading it as gone), and a gateway the filter does find is
 * refused: nothing proves it is this stack's.
 */
export async function resolveTokenRecordGateway(
  this: EC2Provider,
  kind: 'igw' | 'vgw',
  vpcId: string,
  recordedProperties: Record<string, unknown> | undefined,
  logicalId: string,
  resourceType: string,
  physicalId: string
): Promise<string | undefined> {
  const recorded = this.recordedGatewayIdOf(kind, recordedProperties);
  if (recorded !== undefined) return recorded;
  const found = await this.findAttachedGatewayId(kind, vpcId, true);
  if (found === undefined) return undefined;
  throw new ProvisioningError(
    `VPCGatewayAttachment ${logicalId}: the record names only the attachment type and no ` +
      `${kind === 'igw' ? 'InternetGatewayId' : 'VpnGatewayId'}, and ${found} is attached to ` +
      `${vpcId}. cdkd cannot tell whether it is this stack's gateway, so it does not detach it. ` +
      `Detach it yourself if it is, or correct the record (cdkd state show).`,
    resourceType,
    logicalId,
    physicalId
  );
}

/** Whether `gatewayId` is attached (or, for a VPN gateway, attaching) to `vpcId`. */
export async function isGatewayAttached(
  this: EC2Provider,
  kind: 'igw' | 'vgw',
  gatewayId: string,
  vpcId: string
): Promise<boolean> {
  if (kind === 'igw') {
    const resp = await this.ec2Client.send(
      new DescribeInternetGatewaysCommand({ InternetGatewayIds: [gatewayId] })
    );
    return (
      resp.InternetGateways?.[0]?.Attachments?.some(
        (a) => a.VpcId === vpcId && ['available', 'attached'].includes(String(a.State))
      ) ?? false
    );
  }
  const resp = await this.ec2Client.send(
    new DescribeVpnGatewaysCommand({ VpnGatewayIds: [gatewayId] })
  );
  return (
    resp.VpnGateways?.[0]?.VpcAttachments?.some(
      (a) => a.VpcId === vpcId && (a.State === 'attached' || a.State === 'attaching')
    ) ?? false
  );
}

/**
 * Attach `gatewayId` to `vpcId` (a VPN gateway also waits for `attached`).
 * Skips the attach call when AWS already reports it attached, so a deploy
 * re-running an interrupted swap converges instead of being refused.
 */
export async function attachVpcGateway(
  this: EC2Provider,
  kind: 'igw' | 'vgw',
  gatewayId: string,
  vpcId: string,
  logicalId: string,
  onAttachSent?: () => void
): Promise<void> {
  if (!(await this.isGatewayAttached(kind, gatewayId, vpcId))) {
    if (kind === 'igw') {
      await this.ec2Client.send(
        new AttachInternetGatewayCommand({ VpcId: vpcId, InternetGatewayId: gatewayId })
      );
      onAttachSent?.();
      return;
    }
    await this.ec2Client.send(
      new AttachVpnGatewayCommand({ VpcId: vpcId, VpnGatewayId: gatewayId })
    );
    onAttachSent?.();
  }
  if (kind === 'vgw') {
    await this.waitForVpnGatewayAttachment(gatewayId, vpcId, 'attached', logicalId);
  }
}

/**
 * Detach `gatewayId` from `vpcId`; a VPN gateway also waits for `detached`.
 * A not-found answer is confirmed against the recorded region before it is
 * read as "already detached". Raw AWS errors propagate: the caller wraps.
 */
export async function detachVpcGateway(
  this: EC2Provider,
  kind: 'igw' | 'vgw',
  gatewayId: string,
  vpcId: string,
  logicalId: string,
  resourceType: string,
  physicalId: string,
  expectedRegion: string | undefined
): Promise<void> {
  const isVpnGateway = kind === 'vgw';
  let detachRefusedAsIncorrectState = false;
  try {
    await this.withDependencyViolationRetry(
      () =>
        isVpnGateway
          ? this.ec2Client.send(
              new DetachVpnGatewayCommand({ VpnGatewayId: gatewayId, VpcId: vpcId })
            )
          : this.ec2Client.send(
              new DetachInternetGatewayCommand({ InternetGatewayId: gatewayId, VpcId: vpcId })
            ),
      {
        description: `${isVpnGateway ? 'DetachVpnGateway' : 'DetachInternetGateway'} ${logicalId} (${gatewayId} from ${vpcId})`,
      }
    );
  } catch (error) {
    // A VPN detach skips to the wait only on EC2's own `*.NotFound` code: a
    // looser match would wait out the full cap on an attachment AWS still
    // holds and then hide the real refusal. `IncorrectState` (an attachment
    // an interrupted earlier destroy left `detaching`) goes to the wait too.
    if (isVpnGateway && isNamedError(error, VPN_DETACH_IN_PROGRESS_ERRORS)) {
      detachRefusedAsIncorrectState = true;
      this.logger.debug(
        safeMsg`DetachVpnGateway ${logicalId}: attachment not detachable now, waiting`
      );
    } else {
      const notFound = isVpnGateway ? isEc2NotFoundCode(error) : this.isNotFoundError(error);
      if (!notFound) throw error;
      const clientRegion = await this.ec2Client.config.region();
      assertRegionMatch(clientRegion, expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`VPCGatewayAttachment ${physicalId} does not exist, skipping detach`);
      // A not-found VPN detach can also be an attachment left `detaching`,
      // so the wait below still runs for it.
      if (!isVpnGateway) return;
    }
  }

  if (isVpnGateway) {
    // `DetachVpnGateway` answers `detaching`. Until `detached`, AWS refuses
    // both `DeleteVpnGateway` and `DeleteVpc`, which run next in reverse
    // dependency order. The re-sent detach only after a refused first one:
    // after a detach AWS accepted, a lagging `attached` read would draw
    // `IncorrectState`.
    await this.waitForVpnGatewayAttachment(
      gatewayId,
      vpcId,
      'detached',
      logicalId,
      detachRefusedAsIncorrectState
        ? () =>
            this.ec2Client.send(
              new DetachVpnGatewayCommand({ VpnGatewayId: gatewayId, VpcId: vpcId })
            )
        : undefined
    );
  }
}

/**
 * Best-effort recovery after a failed in-place gateway swap, so AWS matches
 * the record, which still names the OLD gateway: detach the new gateway if
 * this swap attached it (its attach can be accepted while the wait fails),
 * then re-attach the old one (skipped when still attached). The warn names
 * what a re-read finds attached. Never throws: the swap's own error is the
 * one the caller reports.
 *
 * Worst case, a same-kind VPN swap chains three
 * {@link VPN_GATEWAY_ATTACHMENT_WAIT_MS} waits (the failed attach, this
 * detach, this re-attach), so the per-resource `--resource-timeout` can cut
 * the recovery short. The record still names the old gateway and every step
 * here is idempotent, so a redeploy converges.
 */
export async function recoverFailedGatewaySwap(
  this: EC2Provider,
  swap: {
    logicalId: string;
    resourceType: string;
    physicalId: string;
    vpcId: string;
    desired: { kind: 'igw' | 'vgw'; gatewayId: string };
    old: { kind: 'igw' | 'vgw'; id: string } | undefined;
    newAttachSent: boolean;
    expectedRegion: string | undefined;
  }
): Promise<void> {
  const { logicalId, vpcId, desired, old } = swap;
  const attempt = async (what: string, step: () => Promise<void>): Promise<void> => {
    try {
      await step();
    } catch (error) {
      this.logger.debug(
        safeMsg`VPCGatewayAttachment ${logicalId}: ${what} failed: ${describeAwsFailure(error).detail}`
      );
    }
  };
  if (swap.newAttachSent) {
    await attempt(`detaching the new gateway ${desired.gatewayId}`, () =>
      this.detachVpcGateway(
        desired.kind,
        desired.gatewayId,
        vpcId,
        logicalId,
        swap.resourceType,
        swap.physicalId,
        swap.expectedRegion
      )
    );
  }
  if (old !== undefined) {
    await attempt(`re-attaching the previous gateway ${old.id}`, () =>
      this.attachVpcGateway(old.kind, old.id, vpcId, logicalId)
    );
  }
  const attached: string[] = [];
  for (const g of [
    ...(old ? [{ kind: old.kind, id: old.id }] : []),
    { kind: desired.kind, id: desired.gatewayId },
  ]) {
    try {
      if (await this.isGatewayAttached(g.kind, g.id, vpcId)) attached.push(g.id);
    } catch {
      attached.push(`${g.id} (unreadable)`);
    }
  }
  if (old !== undefined && attached.length === 1 && attached[0] === old.id) {
    this.logger.warn(
      safeMsg`VPCGatewayAttachment ${logicalId}: the gateway swap failed; the previous gateway ${old.id} is attached again, as the record says`
    );
    return;
  }
  const list = attached.length === 0 ? 'none' : attached.join(', ');
  const previous = old?.id ?? 'none';
  this.logger.warn(
    safeMsg`VPCGatewayAttachment ${logicalId}: the gateway swap failed and VPC ${vpcId} now has attached: ${list}. The record still names the previous gateway (${previous}), the template the new one (${desired.gatewayId}). Redeploy before any destroy: a destroy detaches only ${previous}, and ${desired.gatewayId} left attached blocks DeleteVpc.`
  );
}

/**
 * Swap the attached gateway in place (go-to-k/cdkd#5216). CloudFormation
 * documents `InternetGatewayId` and `VpnGatewayId` as "Update requires: No
 * interruption" and only `VpcId` as create-only, and a create-first
 * replacement cannot work here: AWS allows one internet gateway and one VPN
 * gateway per VPC, so the new attach would be refused.
 *
 * The physicalId names the gateway, so the result carries the NEW
 * `<gatewayId>|<vpcId>` with `wasReplaced: false`; the engine records it.
 *
 * - Same kind (VPN to VPN, IGW to IGW): detach the old gateway first, which
 *   AWS requires, then attach the new one.
 * - Different kinds: a VPC holds one of each, so the new gateway is attached
 *   first and the old one detached after it.
 *
 * On a failure the record still names the old gateway, so
 * {@link recoverFailedGatewaySwap} puts AWS back to match it: the new gateway
 * is detached again if this swap attached it, and the old one re-attached.
 *
 * Every attach skips a gateway AWS already reports attached, so re-running
 * an interrupted swap converges.
 */
export async function updateVpcGatewayAttachment(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  const desired = this.resolveVpcGatewayAttachmentTarget(logicalId, resourceType, properties);
  const recorded = this.parseVpcGatewayAttachmentId(logicalId, physicalId, resourceType);
  if (desired.vpcId !== recorded.vpcId) {
    // `VpcId` is create-only, so the engine replaces before calling here.
    throw new ResourceUpdateNotSupportedError(
      resourceType,
      logicalId,
      'VpcId is create-only: destroy + redeploy the VPCGatewayAttachment.'
    );
  }
  const newPhysicalId = packCompositeId(
    resourceType,
    logicalId,
    [
      {
        name: desired.kind === 'igw' ? 'internetGatewayId' : 'vpnGatewayId',
        value: desired.gatewayId,
      },
      { name: 'vpcId', value: desired.vpcId },
    ],
    { maskSecrets: context?.maskSecrets }
  );
  const vpcId = desired.vpcId;

  try {
    const oldGatewayId =
      recorded.gatewayId ??
      (await this.resolveTokenRecordGateway(
        recorded.kind,
        vpcId,
        previousProperties,
        logicalId,
        resourceType,
        physicalId
      ));
    if (recorded.kind === desired.kind && oldGatewayId === desired.gatewayId) {
      // Not trusted from the record alone: a rollback reverting a failed
      // swap lands here, and AWS may hold no gateway. The attach skips one
      // AWS already reports attached.
      await this.attachVpcGateway(desired.kind, desired.gatewayId, vpcId, logicalId);
      return { physicalId: newPhysicalId, wasReplaced: false };
    }
    const detachOld = async (): Promise<void> => {
      if (oldGatewayId === undefined) return;
      // An old gateway no longer attached (a swap whose restore failed, then
      // a redeploy) is not detached again: AWS refuses that as not attached.
      // A VPN gateway still `detaching` is waited out instead.
      if (!(await this.isGatewayAttached(recorded.kind, oldGatewayId, vpcId))) {
        if (recorded.kind === 'vgw') {
          await this.waitForVpnGatewayAttachment(oldGatewayId, vpcId, 'detached', logicalId);
        }
        return;
      }
      await this.detachVpcGateway(
        recorded.kind,
        oldGatewayId,
        vpcId,
        logicalId,
        resourceType,
        physicalId,
        context?.expectedRegion
      );
    };
    let newAttachSent = false;
    const attachNew = (): Promise<void> =>
      this.attachVpcGateway(desired.kind, desired.gatewayId, vpcId, logicalId, () => {
        newAttachSent = true;
      });

    try {
      if (recorded.kind !== desired.kind) {
        await attachNew();
        await detachOld();
      } else {
        await detachOld();
        await attachNew();
      }
    } catch (swapError) {
      await this.recoverFailedGatewaySwap({
        logicalId,
        resourceType,
        physicalId: newPhysicalId,
        vpcId,
        desired,
        old: oldGatewayId === undefined ? undefined : { kind: recorded.kind, id: oldGatewayId },
        newAttachSent,
        expectedRegion: context?.expectedRegion,
      });
      throw swapError;
    }
    this.logger.debug(
      safeMsg`Swapped VPCGatewayAttachment ${logicalId} in place: ${physicalId} -> ${newPhysicalId}`
    );
    return { physicalId: newPhysicalId, wasReplaced: false };
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update VPCGatewayAttachment ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

export async function deleteVpcGatewayAttachment(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown> | undefined,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting VPCGatewayAttachment ${logicalId}: ${physicalId}`);

  const {
    kind,
    gatewayId: recordedGatewayId,
    vpcId,
  } = this.parseVpcGatewayAttachmentId(logicalId, physicalId, resourceType);

  try {
    const gatewayId =
      recordedGatewayId ??
      (await this.resolveTokenRecordGateway(
        kind,
        vpcId,
        properties,
        logicalId,
        resourceType,
        physicalId
      ));
    if (gatewayId === undefined) {
      // A type-token record (`VGW|vpc-…`) whose VPC has no such gateway: the
      // empty filter answer is only "gone" in the region the record names.
      const clientRegion = await this.ec2Client.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(
        safeMsg`VPCGatewayAttachment ${physicalId}: no gateway attached, skipping detach`
      );
      return;
    }
    await this.detachVpcGateway(
      kind,
      gatewayId,
      vpcId,
      logicalId,
      resourceType,
      physicalId,
      context?.expectedRegion
    );
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapDeleteError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete VPCGatewayAttachment ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
  this.logger.debug(`Successfully deleted VPCGatewayAttachment ${logicalId}`);
}

/** The {@link EC2Provider} methods this module defines. */
export const gatewayAttachmentMethods = {
  resolveVpcGatewayAttachmentTarget,
  createVpcGatewayAttachment,
  waitForVpnGatewayAttachment,
  parseVpcGatewayAttachmentId,
  findAttachedGatewayId,
  recordedGatewayIdOf,
  resolveTokenRecordGateway,
  isGatewayAttached,
  attachVpcGateway,
  detachVpcGateway,
  recoverFailedGatewaySwap,
  updateVpcGatewayAttachment,
  deleteVpcGatewayAttachment,
};
