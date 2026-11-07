import {
  CreateVpcCommand,
  DeleteVpcCommand,
  ModifyVpcAttributeCommand,
  ModifyVpcTenancyCommand,
  GetIpamPoolAllocationsCommand,
  DescribeVpcsCommand,
  DescribeSecurityGroupsCommand,
  DescribeNetworkAclsCommand,
  type Tenancy,
  type CreateVpcCommandOutput,
  type VpcEncryptionControlConfiguration,
  type VpcEncryptionControlMode,
  type VpcEncryptionControlExclusionStateInput,
} from '@aws-sdk/client-ec2';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import {
  CdkdError,
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { coerceCfnInteger, configIntegerRefusal, configStringRefusal } from '../../config-shape.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import { definedAttributes } from '../../attribute-map.js';
import { replayedSendWindow } from '../ambiguous-create.js';
import { MAX_ORPHAN_LIST_PAGES } from '../orphan-report.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import type {
  CreateContext,
  UpdateContext,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../../types/resource.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { waitForGoneAfterDelete } from '../../delete-gone-wait.js';
import {
  IPAM_POOL_ID_PATTERN,
  IPAM_POOL_NOT_FOUND_NAMES,
  VPC_CREATE_ONLY_SENT,
  VPC_ENCRYPTION_CONTROL_EXCLUSIONS,
  VPC_NOT_FOUND_NAMES,
  type VpcOrphanMatch,
  createVpcLatch,
  ec2IdsCreatedByThisProcess,
  isNamedError,
  replayedRecordNote,
  sameCreateOnlySent,
  vpcIpamReleaseWait,
} from './common.js';
import type { EC2Provider } from '../ec2-provider.js';

/**
 * go-to-k/cdkd#5633: `Ipv4IpamPoolId` and `Ipv4NetmaskLength`, both
 * create-only, onto CreateVpc. A malformed value is refused before any call,
 * on a rollback replay too: CreateVpc rejects it every time, so a replay
 * sending it could not succeed, and dropping it would allocate the VPC's
 * CIDR from somewhere the record never named.
 */
export function readVpcIpamAllocation(
  this: EC2Provider,
  properties: Record<string, unknown>,
  resourceType: string,
  logicalId: string,
  context: CreateContext | undefined
): { poolId?: string; netmaskLength?: number } {
  // A BLANK pool id reads as a value; dropping it would allocate the CIDR
  // from somewhere the template never named (or send no source at all).
  const refusal =
    configStringRefusal(properties, 'Ipv4IpamPoolId', '', resourceType) ??
    (properties['Ipv4IpamPoolId'] === ''
      ? `${resourceType}.Ipv4IpamPoolId must not be blank`
      : undefined) ??
    configIntegerRefusal(properties, 'Ipv4NetmaskLength', resourceType, 0, 32);
  if (refusal !== undefined) {
    throw markNonRetryable(
      new ProvisioningError(
        `${refusal}. The VPC ${logicalId} was not created.${replayedRecordNote(context)}`,
        resourceType,
        logicalId
      )
    );
  }
  const poolId = properties['Ipv4IpamPoolId'];
  const netmaskLength = coerceCfnInteger(properties['Ipv4NetmaskLength']);
  return {
    ...(typeof poolId === 'string' && poolId !== '' && { poolId }),
    ...(netmaskLength !== undefined && { netmaskLength }),
  };
}

/**
 * go-to-k/cdkd#5633: CloudFormation's `VpcEncryptionControl` (create-only)
 * onto CreateVpc's `VpcEncryptionControl`. Only the writable members are
 * sent (`Mode` plus the eight `*Exclusion` switches, same names on both
 * sides); the read-only ones a template cannot set are left out. A
 * malformed block is refused before any call, a replay included, for the
 * reason `readVpcIpamAllocation` gives: dropping it would create the VPC
 * WITHOUT the encryption enforcement the record declares.
 */
export function buildVpcEncryptionControl(
  this: EC2Provider,
  value: unknown,
  resourceType: string,
  logicalId: string,
  context: CreateContext | undefined
): VpcEncryptionControlConfiguration | undefined {
  if (value === undefined || value === null) return undefined;
  const path = `${resourceType} VpcEncryptionControl`;
  const refuse = (reason: string): never => {
    throw markNonRetryable(
      new ProvisioningError(
        `${reason}. The VPC ${logicalId} was not created.${replayedRecordNote(context)}`,
        resourceType,
        logicalId
      )
    );
  };
  const containerRefusal = configStringRefusal(value, 'Mode', '', path);
  if (containerRefusal !== undefined) return refuse(containerRefusal);
  const block = value as Record<string, unknown>;
  // An absent `Mode` is sent absent: whether CreateVpc then refuses it is
  // AWS's answer to give, as it is for CloudFormation's handler. A BLANK one
  // is refused here: it reads as a value, and sending none would hand AWS a
  // different request than the template wrote.
  const mode = block['Mode'];
  if (mode === '') return refuse(`${path}.Mode must not be blank`);
  const config: VpcEncryptionControlConfiguration = {
    Mode: typeof mode === 'string' ? (mode as VpcEncryptionControlMode) : undefined,
  };
  for (const key of VPC_ENCRYPTION_CONTROL_EXCLUSIONS) {
    const memberRefusal = configStringRefusal(block, key, '', path);
    if (memberRefusal !== undefined) return refuse(memberRefusal);
    const member = block[key];
    if (typeof member === 'string' && member !== '') {
      config[key] = member as VpcEncryptionControlExclusionStateInput;
    }
  }
  return config;
}

// ─── AWS::EC2::VPC ────────────────────────────────────────────────

export async function createVpc(
  this: EC2Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating VPC ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  // go-to-k/cdkd#5633: the primary CIDR is either declared or allocated from
  // an IPAM pool (`Ipv4IpamPoolId`, with an optional `Ipv4NetmaskLength`);
  // CreateVpc takes exactly one of the two sources.
  const cidrBlock = properties['CidrBlock'] as string | undefined;
  const ipamAllocation = this.readVpcIpamAllocation(properties, resourceType, logicalId, context);
  if (!cidrBlock && ipamAllocation.poolId === undefined) {
    throw new ProvisioningError(
      `CidrBlock or Ipv4IpamPoolId is required for VPC ${logicalId}`,
      resourceType,
      logicalId
    );
  }
  const encryptionControl = this.buildVpcEncryptionControl(
    properties['VpcEncryptionControl'],
    resourceType,
    logicalId,
    context
  );
  const orphanMatch: VpcOrphanMatch = cidrBlock
    ? { cidrBlock }
    : { ipamPoolId: ipamAllocation.poolId! };

  // go-to-k/cdkd#4583: set only when the wiring-failure cleanup could not
  // delete the VPC this call created.
  let leftBehindId: string | undefined;
  try {
    const createClient = await this.getCreateClient();
    // Issue #2080: after an earlier ambiguous attempt, name the VPC it may
    // have made before a second CreateVpc is sent. Detection only.
    const orphanWindow = createVpcLatch.take(logicalId);
    if (orphanWindow !== undefined) {
      await this.reportPossibleOrphanVpcs(
        logicalId,
        orphanMatch,
        desiredTags,
        orphanWindow,
        context
      );
    }
    const attemptStartMs = Date.now();
    let response: CreateVpcCommandOutput;
    let tagsApplied: boolean;
    try {
      ({ response, tagsApplied } = await this.sendTaggedCreate(
        logicalId,
        'vpc',
        desiredTags,
        (TagSpecifications) =>
          createClient.send(
            new CreateVpcCommand({
              ...(cidrBlock ? { CidrBlock: cidrBlock } : {}),
              ...(ipamAllocation.poolId !== undefined && {
                Ipv4IpamPoolId: ipamAllocation.poolId,
              }),
              ...(ipamAllocation.netmaskLength !== undefined && {
                Ipv4NetmaskLength: ipamAllocation.netmaskLength,
              }),
              ...(encryptionControl !== undefined && { VpcEncryptionControl: encryptionControl }),
              InstanceTenancy: (properties['InstanceTenancy'] as Tenancy) ?? undefined,
              ...(TagSpecifications && { TagSpecifications }),
            })
          )
      ));
    } catch (error) {
      createVpcLatch.noteFailure(logicalId, error, attemptStartMs, orphanWindow);
      throw error;
    }

    const vpcId = response.Vpc!.VpcId!;
    ec2IdsCreatedByThisProcess.add(vpcId);
    // go-to-k/cdkd#5511: report before the replay lookup and wiring.
    reportCreatedResource(logicalId, resourceType, vpcId);
    // Issue #4687: the SDK replayed this CreateVpc inside its `send`, so
    // an earlier attempt may have made one too. Detection only.
    const vpcReplayWindow = replayedSendWindow(response, attemptStartMs);
    if (vpcReplayWindow !== undefined) {
      await this.reportPossibleOrphanVpcs(
        logicalId,
        orphanMatch,
        desiredTags,
        vpcReplayWindow,
        context
      );
    }

    // CreateVpcCommand has succeeded — AWS has now committed the VPC.
    // If any subsequent ModifyVpcAttribute / tag / read call throws, the
    // VPC exists on AWS but cdkd state will NOT (the throw aborts before
    // the success-return). The next redeploy would then re-try CREATE
    // and a new VPC would be created, leaving the first orphaned (VPCs
    // have no `EntityAlreadyExists` semantics — every CreateVpc returns
    // a fresh VpcId — so the orphan accumulates silently). Wrap the
    // wiring in an inner try/catch that issues a best-effort
    // `DeleteVpcCommand` before re-throwing the original error. A
    // freshly-created VPC has no subnets / SGs (except default which
    // CASCADE-delete with the VPC), so a single DeleteVpc suffices.
    // `undefined` until the default security group is read back: the
    // attribute is OMITTED rather than recorded as `''` (issue #3077).
    let defaultSgId: string | undefined;
    try {
      // Apply DNS settings
      if (
        properties['EnableDnsHostnames'] === true ||
        properties['EnableDnsHostnames'] === 'true'
      ) {
        await this.ec2Client.send(
          new ModifyVpcAttributeCommand({
            VpcId: vpcId,
            EnableDnsHostnames: { Value: true },
          })
        );
      }

      if (properties['EnableDnsSupport'] === false || properties['EnableDnsSupport'] === 'false') {
        await this.ec2Client.send(
          new ModifyVpcAttributeCommand({
            VpcId: vpcId,
            EnableDnsSupport: { Value: false },
          })
        );
      }

      // Apply tags the create did not carry (go-to-k/cdkd#4971)
      if (!tagsApplied)
        await this.applyTags(vpcId, desiredTags, logicalId, maskerOrIdentity(context?.maskSecrets));

      // Fetch VPC details for attributes
      await this.ec2Client.send(new DescribeVpcsCommand({ VpcIds: [vpcId] }));

      // Fetch default security group for the VPC
      try {
        const sgResponse = await this.ec2Client.send(
          new DescribeSecurityGroupsCommand({
            Filters: [
              { Name: 'vpc-id', Values: [vpcId] },
              { Name: 'group-name', Values: ['default'] },
            ],
          })
        );
        defaultSgId = sgResponse.SecurityGroups?.[0]?.GroupId;
      } catch {
        this.logger.debug(`Failed to get default SG for VPC ${vpcId}`);
      }
    } catch (innerError) {
      try {
        await this.ec2Client.send(new DeleteVpcCommand({ VpcId: vpcId }));
        retractCreatedResource(logicalId, resourceType, vpcId);
        this.logger.debug(
          `Cleaned up partially-created VPC ${logicalId} (${vpcId}) after wiring failure`
        );
      } catch (cleanupError) {
        leftBehindId = vpcId;
        const cleanupHead = `Failed to clean up partially-created VPC ${logicalId} (${vpcId}): `;
        this.logger.warn(
          `${cleanupHead}${this.warnFailureSentence(cleanupHead, cleanupError, maskerOrIdentity(context?.maskSecrets))} Manual deletion may be required before the next deploy: ${pasteableAwsCommand()`aws ec2 delete-vpc --vpc-id ${vpcId}`.render()}`
        );
      }
      // The resource itself was created: an "already exists" from its wiring
      // is an auxiliary object's, not this resource's name collision (#3826).
      throw markAuxiliaryFailure(innerError, logicalId);
    }

    this.logger.debug(`Successfully created VPC ${logicalId}: ${vpcId}`);

    return {
      physicalId: vpcId,
      // `DefaultNetworkAcl` is deliberately not recorded: nothing reads it
      // back, and a permanent `''` placeholder was the issue #3077 shape --
      // absent, a reference falls to the resolver's `guardedPhysicalIdFallback`
      // (the VPC id, with a warning) instead of resolving to the empty
      // string. `DefaultSecurityGroup` is absent only when the read-back
      // above failed; the resolver's own arm for it then repeats this same
      // filtered `DescribeSecurityGroups` live, and REFUSES (never the VPC
      // id) when that read fails or finds nothing (issue #3096).
      // An IPAM-allocated CIDR is known only from the CreateVpc response.
      attributes: definedAttributes({
        VpcId: vpcId,
        CidrBlock: cidrBlock || response.Vpc?.CidrBlock,
        DefaultSecurityGroup: defaultSgId,
      }),
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create VPC ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
    if (leftBehindId !== undefined) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, leftBehindId);
      // go-to-k/cdkd#4945: terminal. CreateVpc sends no name and no token, so the
      // engine's retry would make another VPC while the journal names one.
      markNonRetryable(thrown);
    }
    throw thrown;
  }
}

export async function updateVpc(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating VPC ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

  try {
    // InstanceTenancy (go-to-k/cdkd#5449; CloudFormation measured on a
    // throwaway stack, us-east-1): `dedicated` -> `default` and a removal
    // from `dedicated` update the VPC in place (ModifyVpcTenancy, the only
    // direction AWS offers); `default` -> `dedicated` creates a new VPC,
    // routed to replacement by `vpcInstanceTenancyChangeReplaces`. Only
    // `cdkd drift --revert` reaches here with that direction, so it is
    // refused, before any call, rather than silently left as is. An absent
    // (or null) value is `default`, as in the replacement predicate; the call itself is sent after the DNS attributes.
    const tenancyOf = (v: unknown): string => (v == null ? 'default' : String(v));
    const newTenancy = tenancyOf(properties['InstanceTenancy']);
    const oldTenancy = tenancyOf(previousProperties['InstanceTenancy']);
    if (newTenancy !== oldTenancy && newTenancy !== 'default') {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        'destroy + redeploy the VPC (and the resources that depend on it). AWS changes InstanceTenancy in place only to default, and CloudFormation creates a new VPC for this change'
      );
    }
    // go-to-k/cdkd#5633: the create-only CreateVpc inputs. The engine
    // replaces the VPC on a change, so only `cdkd drift --revert` reaches
    // here with one; AWS has no call that changes them, so it is refused
    // before any call rather than reported as reverted.
    // `Ipv4IpamPoolId` has no readback (getDriftUnknownPaths), so a revert's
    // AWS-side bag never carries it: compared only when both sides do.
    const createOnlyChanged = VPC_CREATE_ONLY_SENT.filter(
      (key) =>
        !(
          key === 'Ipv4IpamPoolId' &&
          (properties[key] === undefined || previousProperties[key] === undefined)
        ) && !sameCreateOnlySent(key, properties[key], previousProperties[key])
    );
    if (createOnlyChanged.length > 0) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        `destroy + redeploy the VPC (and the resources that depend on it). ${createOnlyChanged.join(', ')} can be set only when the VPC is created, and CloudFormation creates a new VPC for this change`
      );
    }

    // Coerce CFn-string-or-bool ("true" | true) into a real boolean so the
    // diff below treats `"true"` and `true` as the same value.
    const asBool = (v: unknown): boolean | undefined => {
      if (v === undefined) return undefined;
      return v === true || v === 'true';
    };

    // go-to-k/cdkd#5633: an IPAM-allocated VPC declares no CidrBlock; its
    // CIDR (create-only, so unchanged by this update) is read back instead,
    // before any change, so a failed read reports an update that applied nothing.
    // The map REPLACES the record's, so a CidrBlock left out here would be
    // lost to every later `Fn::GetAtt`.
    const declaredCidr = properties['CidrBlock'];
    const cidrBlock =
      typeof declaredCidr === 'string' && declaredCidr !== ''
        ? declaredCidr
        : properties['Ipv4IpamPoolId'] !== undefined
          ? (await this.ec2Client.send(new DescribeVpcsCommand({ VpcIds: [physicalId] })))
              ?.Vpcs?.[0]?.CidrBlock
          : undefined;

    // Update DNS settings — diff-based so a no-op round-trip
    // (`update(state, state)` from `cdkd drift --revert`) produces zero
    // ModifyVpcAttribute calls. AWS treats ModifyVpcAttribute as
    // idempotent, but the canonical round-trip guard ("state==AWS
    // produces zero mutating SDK calls") is the structural check that
    // catches future regressions in the diff logic. A removed attribute
    // arrives here as its `removalDefaults` value (#1160). AWS accepts the
    // two calls in either order (hostnames on with support off included),
    // so no ordering is enforced between them.
    const newDnsHostnames = asBool(properties['EnableDnsHostnames']);
    const oldDnsHostnames = asBool(previousProperties['EnableDnsHostnames']);
    if (newDnsHostnames !== undefined && newDnsHostnames !== oldDnsHostnames) {
      await this.ec2Client.send(
        new ModifyVpcAttributeCommand({
          VpcId: physicalId,
          EnableDnsHostnames: { Value: newDnsHostnames },
        })
      );
    }

    const newDnsSupport = asBool(properties['EnableDnsSupport']);
    const oldDnsSupport = asBool(previousProperties['EnableDnsSupport']);
    if (newDnsSupport !== undefined && newDnsSupport !== oldDnsSupport) {
      await this.ec2Client.send(
        new ModifyVpcAttributeCommand({
          VpcId: physicalId,
          EnableDnsSupport: { Value: newDnsSupport },
        })
      );
    }

    if (newTenancy !== oldTenancy) {
      await this.ec2Client.send(
        new ModifyVpcTenancyCommand({ VpcId: physicalId, InstanceTenancy: 'default' })
      );
    }

    // Update tags (diff add/remove against previousProperties)
    await this.applyTagDiff(
      physicalId,
      resourceType,
      logicalId,
      previousProperties['Tags'],
      properties['Tags'],
      maskerOrIdentity(context?.maskSecrets)
    );

    this.logger.debug(`Successfully updated VPC ${logicalId}`);

    return {
      physicalId,
      wasReplaced: false,
      attributes: definedAttributes({
        VpcId: physicalId,
        CidrBlock: cidrBlock,
      }),
    };
  } catch (error) {
    // The InstanceTenancy refusal is control flow the deploy engine matches
    // BY CLASS; a re-wrap would hide it.
    if (error instanceof CdkdError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update VPC ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

export async function deleteVpc(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext,
  properties?: Record<string, unknown>
): Promise<void> {
  this.logger.debug(`Deleting VPC ${logicalId}: ${physicalId}`);

  // Retry with backoff for DependencyViolation (ENI cleanup, SG deletion delay)
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await this.ec2Client.send(new DeleteVpcCommand({ VpcId: physicalId }));
      this.logger.debug(`Successfully deleted VPC ${logicalId}`);
      await this.waitForVpcIpamRelease(physicalId, resourceType, properties, context);
      return;
    } catch (error) {
      // go-to-k/cdkd#4606: a journaled orphan counts as gone only on
      // EC2's own not-found code; the broad matcher's message
      // substrings would clear a live orphan from the journal.
      if (
        this.isNotFoundError(error) &&
        (context?.failedCreateOrphan !== true || isNamedError(error, VPC_NOT_FOUND_NAMES))
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
            safeMsg`  VPC ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
          );
        } else {
          this.logger.debug(`VPC ${physicalId} does not exist, skipping deletion`);
        }
        return;
      }
      // `.detail`, never `.summary`: the substring test below is what keeps this
      // degradation alive, and it matches AWS's OWN wording. Byte-identical to
      // the ternary it replaced, minus that ternary's throw.
      // The thrown `ProvisioningError` further down names an AWS-authored
      // failure by its class only (`wrapCaughtError`, go-to-k/cdkd#2319).
      const msg = describeAwsFailure(error).detail;
      if (
        (msg.includes('DependencyViolation') || msg.includes('has dependencies')) &&
        attempt < maxAttempts
      ) {
        this.logger.debug(
          `VPC ${physicalId} has dependencies (attempt ${attempt}/${maxAttempts}), retrying in ${attempt * 5}s...`
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
            `Failed to delete VPC ${logicalId}: ${text}`,
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
 * go-to-k/cdkd#5633: an IPAM-allocated VPC's pool allocation outlives
 * `DeleteVpc`, and until it is released the pool refuses to deprovision its
 * CIDR ("The CIDR has one or more allocations."), so a destroy that deletes
 * the `AWS::EC2::IPAMPoolCidr` next fails (the first ec2-vpc-ipam integ
 * did). Whichever resource waits, a stack delete removing both cannot finish
 * before AWS releases the allocation, so this waits here, by the pool's
 * `GetIpamPoolAllocations`. The provider cannot see whether the same run
 * deletes the pool CIDR, so a VPC on a pool another stack owns waits too.
 * CloudFormation's VPC delete handler does not wait (it holds no
 * `ec2:GetIpamPoolAllocations`). A release past this cap is waited out again
 * by the pool CIDR's own delete (go-to-k/cdkd#5975,
 * `ipam-pool-cidr-release.ts`).
 *
 * The delete is ACCEPTED, so the wait follows `delete-gone-wait.ts`: a cap,
 * a Ctrl-C or an unreadable listing (a role without
 * `ec2:GetIpamPoolAllocations`) warns and returns, naming the consequence. A
 * pool already gone counts as released. Only a recorded pool id cdkd can
 * send is waited on: a redacted or `{{resolve:...}}` one is skipped.
 */
export async function waitForVpcIpamRelease(
  this: EC2Provider,
  vpcId: string,
  resourceType: string,
  properties: Record<string, unknown> | undefined,
  context: DeleteContext | undefined
): Promise<void> {
  await this.waitForIpamAllocationRelease(
    [properties?.['Ipv4IpamPoolId']],
    vpcId,
    'VPC',
    'AWS can take about 18 minutes',
    resourceType,
    context
  );
}

/**
 * The wait {@link waitForVpcIpamRelease} describes, for any resource IPAM
 * pools allocated to: until no pool's `GetIpamPoolAllocations` names
 * `resourceId`. go-to-k/cdkd#5632: a deleted subnet's pool allocations wait
 * the same way, since their pool CIDRs cannot be deprovisioned before then.
 * Every pool shares ONE wait, so a subnet holding an IPv4 and an IPv6
 * allocation is capped by one budget, not one per pool, and stays under the
 * per-resource deadline. Only a recorded pool id cdkd can send is waited on:
 * a redacted or `{{resolve:...}}` one is skipped.
 */
export async function waitForIpamAllocationRelease(
  this: EC2Provider,
  poolIds: readonly unknown[],
  resourceId: string,
  noun: string,
  expectedDuration: string,
  resourceType: string,
  context: DeleteContext | undefined
): Promise<void> {
  const pending = new Set(
    poolIds.filter(
      (poolId): poolId is string => typeof poolId === 'string' && IPAM_POOL_ID_PATTERN.test(poolId)
    )
  );
  if (pending.size === 0) return;
  const mask = maskerOrIdentity(context?.maskSecrets);
  const pools = [...pending].join(' and ');
  const plural = pending.size > 1;
  // Said up front: the release takes minutes, and a silent wait reads as a
  // hang. The per-resource warn-after timer repeats the reminder later.
  this.logger.info(
    mask(
      plural
        ? safeMsg`  Waiting for IPAM pools ${pools} to release the allocations of deleted ${noun} ${resourceId}; ${expectedDuration}, and the pool CIDRs cannot be deprovisioned before then`
        : safeMsg`  Waiting for IPAM pool ${pools} to release the allocation of deleted ${noun} ${resourceId}; ${expectedDuration}, and the pool CIDR cannot be deprovisioned before then`
    )
  );
  // One pool's answer: allocated, released, or unknown (a listing cut at the
  // page cap proves nothing about the pages never read).
  const poolState = async (poolId: string): Promise<'allocated' | 'released' | 'unknown'> => {
    try {
      let token: string | undefined;
      let pages = 0;
      do {
        const page = await this.ec2Client.send(
          new GetIpamPoolAllocationsCommand({ IpamPoolId: poolId, NextToken: token })
        );
        if ((page.IpamPoolAllocations ?? []).some((a) => a.ResourceId === resourceId)) {
          return 'allocated';
        }
        token = page.NextToken;
        pages++;
      } while (token && pages < MAX_ORPHAN_LIST_PAGES);
      return token ? 'unknown' : 'released';
    } catch (error) {
      if (isNamedError(error, IPAM_POOL_NOT_FOUND_NAMES)) return 'released';
      throw error;
    }
  };
  await waitForGoneAfterDelete({
    what: mask(
      plural
        ? `the IPAM pool ${pools} allocations of ${noun} ${resourceId}`
        : `the IPAM pool ${pools} allocation of ${noun} ${resourceId}`
    ),
    resourceType,
    consequence: plural
      ? 'AWS releases the allocations on its side; until it does, each pool refuses to deprovision its CIDR ("The CIDR has one or more allocations."), so re-run the destroy if it stops there.'
      : 'AWS releases the allocation on its side; until it does, the pool refuses to deprovision its CIDR ("The CIDR has one or more allocations."), so re-run the destroy if it stops there.',
    describe: async () => {
      let truncated = false;
      for (const poolId of [...pending]) {
        const state = await poolState(poolId);
        if (state === 'allocated') return 'allocated';
        if (state === 'released') pending.delete(poolId);
        else truncated = true;
      }
      return truncated ? 'unknown (allocation listing truncated)' : undefined;
    },
    logger: this.logger,
    pollIntervalMs: vpcIpamReleaseWait.pollIntervalMs,
    maxWaitMs: vpcIpamReleaseWait.maxWaitMs,
  });
}

/**
 * Resolve a single `Fn::GetAtt` attribute for an `AWS::EC2::VPC`.
 *
 * CloudFormation returns `CidrBlock`, `CidrBlockAssociations`,
 * `DefaultNetworkAcl`, `DefaultSecurityGroup`, and `Ipv6CidrBlocks`. See:
 * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-vpc.html#aws-resource-ec2-vpc-return-values
 *
 * `DefaultNetworkAcl` and `DefaultSecurityGroup` previously returned wrong
 * values (DHCP options id and `undefined` respectively); the AWS console
 * surfaces these the same way as CFn — by filtering the relevant
 * `Describe*` API on `vpc-id` + the `default` flag.
 */
export async function getVpcAttribute(
  this: EC2Provider,
  physicalId: string,
  attributeName: string
): Promise<unknown> {
  try {
    switch (attributeName) {
      case 'DefaultNetworkAcl': {
        const resp = await this.ec2Client.send(
          new DescribeNetworkAclsCommand({
            Filters: [
              { Name: 'vpc-id', Values: [physicalId] },
              { Name: 'default', Values: ['true'] },
            ],
          })
        );
        return resp.NetworkAcls?.[0]?.NetworkAclId;
      }
      case 'DefaultSecurityGroup': {
        const resp = await this.ec2Client.send(
          new DescribeSecurityGroupsCommand({
            Filters: [
              { Name: 'vpc-id', Values: [physicalId] },
              { Name: 'group-name', Values: ['default'] },
            ],
          })
        );
        return resp.SecurityGroups?.[0]?.GroupId;
      }
      default: {
        const response = await this.ec2Client.send(
          new DescribeVpcsCommand({ VpcIds: [physicalId] })
        );
        const vpc = response.Vpcs?.[0];
        if (!vpc) return undefined;

        switch (attributeName) {
          case 'CidrBlock':
            return vpc.CidrBlock;
          case 'Ipv6CidrBlocks':
            // Return array of IPv6 CIDR blocks associated with this VPC
            return (
              vpc.Ipv6CidrBlockAssociationSet?.filter(
                (a) => a.Ipv6CidrBlockState?.State === 'associated'
              ).map((a) => a.Ipv6CidrBlock) || []
            );
          case 'CidrBlockAssociations':
            return vpc.CidrBlockAssociationSet?.map((a) => a.AssociationId) || [];
          default:
            return undefined;
        }
      }
    }
  } catch {
    return undefined;
  }
}

/** The {@link EC2Provider} methods this module defines. */
export const vpcMethods = {
  readVpcIpamAllocation,
  buildVpcEncryptionControl,
  createVpc,
  updateVpc,
  deleteVpc,
  waitForVpcIpamRelease,
  waitForIpamAllocationRelease,
  getVpcAttribute,
};
