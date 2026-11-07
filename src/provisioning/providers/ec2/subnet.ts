import {
  CreateSubnetCommand,
  DeleteSubnetCommand,
  DescribeSubnetsCommand,
  ModifySubnetAttributeCommand,
  type CreateSubnetCommandOutput,
  type Subnet,
} from '@aws-sdk/client-ec2';
import { canonicalizeIpv6Cidr } from '../../../utils/ipv6-cidr.js';
import {
  CdkdError,
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { coerceCfnBoolean, configBooleanRefusal, configStringRefusal } from '../../config-shape.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import { replayedSendWindow } from '../ambiguous-create.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import type {
  CreateContext,
  UpdateContext,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import { definedAttributes } from '../../attribute-map.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import {
  SUBNET_CREATE_ONLY_SENT,
  SUBNET_NOT_FOUND_NAMES,
  type SubnetOrphanMatch,
  createSubnetLatch,
  ec2IdsCreatedByThisProcess,
  isNamedError,
  replayedRecordNote,
  sameCreateOnlySent,
} from './common.js';
import {
  AAAA_MEMBER,
  type SubnetDetachAttribute,
  readSubnetCreateInputs,
  subnetPrivateDnsMemberValue,
  subnetPrivateDnsOptionsRefusal,
} from './subnet-support.js';
import type { EC2Provider } from '../ec2-provider.js';

/** go-to-k/cdkd#5632: reads of a pool-allocated subnet for its IPv6 association (~20 s). */
const SUBNET_POOL_ASSOCIATION_READS = 10;

// ─── AWS::EC2::Subnet ─────────────────────────────────────────────

/** Refuse malformed template values; a state replay keeps the last usable value. */
export async function prepareSubnetProperties(
  this: EC2Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext | UpdateContext,
  physicalId?: string,
  previousProperties?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  let prepared = properties;
  for (const key of [
    'EnableDns64',
    'Ipv6CidrBlock',
    'AssignIpv6AddressOnCreation',
    'Ipv6Native',
    'PrivateDnsNameOptionsOnLaunch',
  ]) {
    const refusal = (bag: Record<string, unknown>) =>
      key === 'Ipv6CidrBlock'
        ? configStringRefusal(bag, key, '<unset>', 'Subnet')
        : key === 'PrivateDnsNameOptionsOnLaunch'
          ? subnetPrivateDnsOptionsRefusal(bag[key])
          : configBooleanRefusal(bag, key, 'Subnet');
    const message = refusal(properties);
    if (message === undefined) continue;
    if (context?.replayingState !== true) {
      throw new ProvisioningError(message, resourceType, logicalId, physicalId);
    }
    this.logger.warn(
      safeMsg`${logicalId}: ${message}; leaving ${key} unchanged during state replay`
    );
    prepared = { ...prepared };
    delete prepared[key];
    if (previousProperties?.[key] !== undefined) {
      // An absent previous value stays absent. A corrupt recorded value
      // needs the live baseline rather than a default on an existing subnet.
      const baseline =
        refusal(previousProperties) === undefined
          ? previousProperties
          : await this.readSubnetCurrentState(physicalId!);
      if (baseline && baseline !== RESOURCE_NOT_FOUND && baseline[key] !== undefined) {
        prepared[key] = baseline[key];
      } else if (baseline === undefined || baseline === RESOURCE_NOT_FOUND) {
        throw new ProvisioningError(
          `Cannot read ${key} for Subnet ${logicalId}; retry after DescribeSubnets succeeds`,
          resourceType,
          logicalId,
          physicalId
        );
      }
    }
  }
  return prepared;
}

export async function createSubnet(
  this: EC2Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating Subnet ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);
  const prepared = await this.prepareSubnetProperties(logicalId, resourceType, properties, context);

  const vpcId = properties['VpcId'] as string;
  const cidrBlock = properties['CidrBlock'] as string | undefined;
  // go-to-k/cdkd#5632: an IPv6-only subnet has no IPv4 block.
  const ipv6Native = coerceCfnBoolean(prepared['Ipv6Native']);
  // go-to-k/cdkd#5632: the zone by id and the IPAM allocations. A malformed
  // value is refused before any call, on a rollback replay too: dropping it
  // would place or allocate the subnet somewhere the record never named.
  const read = readSubnetCreateInputs(properties, resourceType);
  if ('refusal' in read) {
    throw markNonRetryable(
      new ProvisioningError(
        `${read.refusal}. The Subnet ${logicalId} was not created.${replayedRecordNote(context)}`,
        resourceType,
        logicalId
      )
    );
  }
  const inputs = read.inputs;

  if (!vpcId || (!cidrBlock && inputs.ipv4PoolId === undefined && ipv6Native !== true)) {
    throw new ProvisioningError(
      `VpcId and CidrBlock are required for Subnet ${logicalId} (CidrBlock may be omitted only when Ipv6Native is true or Ipv4IpamPoolId is set)`,
      resourceType,
      logicalId
    );
  }
  // The orphan lookup's key: a CIDR cannot repeat in one VPC, IPv4 or IPv6.
  // go-to-k/cdkd#5632: a pool-allocated subnet has no CIDR to match before
  // the create, so it is matched on the pool's own allocations.
  const orphanCidr: SubnetOrphanMatch | undefined = cidrBlock
    ? { cidr: cidrBlock, family: 'ipv4' as const }
    : inputs.ipv4PoolId !== undefined
      ? { ipamPoolId: inputs.ipv4PoolId }
      : typeof prepared['Ipv6CidrBlock'] === 'string'
        ? { cidr: prepared['Ipv6CidrBlock'], family: 'ipv6' as const }
        : inputs.ipv6PoolId !== undefined
          ? { ipamPoolId: inputs.ipv6PoolId }
          : undefined;

  // go-to-k/cdkd#4583: set only when the wiring-failure cleanup could not
  // delete the subnet this call created.
  let leftBehindId: string | undefined;
  try {
    const createClient = await this.getCreateClient();
    // Issue #2080: after an earlier ambiguous attempt, name the subnet it
    // may have made. The create below then fails with
    // `InvalidSubnet.Conflict` if it did, and that error names no subnet.
    const orphanWindow = createSubnetLatch.take(logicalId);
    if (orphanWindow !== undefined && orphanCidr !== undefined) {
      await this.reportPossibleOrphanSubnets(
        logicalId,
        vpcId,
        orphanCidr,
        desiredTags,
        orphanWindow,
        context
      );
    }
    const attemptStartMs = Date.now();
    let response: CreateSubnetCommandOutput;
    let tagsApplied: boolean;
    try {
      ({ response, tagsApplied } = await this.sendTaggedCreate(
        logicalId,
        'subnet',
        desiredTags,
        (TagSpecifications) =>
          createClient.send(
            new CreateSubnetCommand({
              VpcId: vpcId,
              CidrBlock: cidrBlock || undefined,
              Ipv6CidrBlock: prepared['Ipv6CidrBlock'] as string | undefined,
              Ipv6Native: ipv6Native,
              AvailabilityZone: (properties['AvailabilityZone'] as string) ?? undefined,
              ...(inputs.availabilityZoneId !== undefined && {
                AvailabilityZoneId: inputs.availabilityZoneId,
              }),
              ...(inputs.ipv4PoolId !== undefined && { Ipv4IpamPoolId: inputs.ipv4PoolId }),
              ...(inputs.ipv4NetmaskLength !== undefined && {
                Ipv4NetmaskLength: inputs.ipv4NetmaskLength,
              }),
              ...(inputs.ipv6PoolId !== undefined && { Ipv6IpamPoolId: inputs.ipv6PoolId }),
              ...(inputs.ipv6NetmaskLength !== undefined && {
                Ipv6NetmaskLength: inputs.ipv6NetmaskLength,
              }),
              ...(TagSpecifications && { TagSpecifications }),
            })
          )
      ));
    } catch (error) {
      createSubnetLatch.noteFailure(logicalId, error, attemptStartMs, orphanWindow);
      throw error;
    }

    const subnetId = response.Subnet!.SubnetId!;
    ec2IdsCreatedByThisProcess.add(subnetId);
    // go-to-k/cdkd#5511: report before the replay lookup and wiring.
    reportCreatedResource(logicalId, resourceType, subnetId);
    // Issue #4687: the SDK replayed this CreateSubnet inside its `send`, so
    // an earlier attempt may have made one too. Detection only.
    const subnetReplayWindow = replayedSendWindow(response, attemptStartMs);
    if (subnetReplayWindow !== undefined && orphanCidr !== undefined) {
      await this.reportPossibleOrphanSubnets(
        logicalId,
        vpcId,
        orphanCidr,
        desiredTags,
        subnetReplayWindow,
        context
      );
    }
    const availabilityZone = response.Subnet!.AvailabilityZone!;

    // CreateSubnetCommand has succeeded — AWS has now committed the
    // Subnet. If applyTags / ModifySubnetAttribute throws, the subnet
    // exists on AWS but cdkd state will NOT, and the next redeploy
    // would create a NEW subnet (subnets have no `EntityAlreadyExists`
    // semantics — every CreateSubnet returns a fresh SubnetId) leaving
    // the first orphaned. Wrap wiring in an inner try/catch that issues
    // a best-effort `DeleteSubnetCommand` before re-throwing the
    // original error. A freshly-created subnet has no ENIs / route
    // associations attached, so a single DeleteSubnet suffices.
    try {
      // Apply tags the create did not carry (go-to-k/cdkd#4971)
      if (!tagsApplied)
        await this.applyTags(
          subnetId,
          desiredTags,
          logicalId,
          maskerOrIdentity(context?.maskSecrets)
        );

      // The observed-state capture must not record an associating block as
      // absent, and DNS64 wiring needs the IPv6 association ready (#5778).
      // go-to-k/cdkd#5632: so does a block allocated from an IPv6 pool.
      if (prepared['Ipv6CidrBlock'] !== undefined || inputs.ipv6PoolId !== undefined) {
        let associationId = response.Subnet?.Ipv6CidrBlockAssociationSet?.[0]?.AssociationId;
        // go-to-k/cdkd#5632: CreateSubnet's response names a pool-allocated
        // IPv6 block's association, in state `associating`, for a
        // dual-stack and an IPv6-only subnet alike (measured, us-east-1,
        // 2026-11-07, #5945). The lookup stays as a fallback: a missing one
        // is read for before the create is called failed.
        for (
          let attempt = 1;
          !associationId &&
          inputs.ipv6PoolId !== undefined &&
          attempt <= SUBNET_POOL_ASSOCIATION_READS;
          attempt++
        ) {
          if (attempt > 1) await this.sleep(2000);
          // A read this soon after the create can miss the subnet itself.
          const live = await this.ec2Client
            .send(new DescribeSubnetsCommand({ SubnetIds: [subnetId] }))
            .catch((error: unknown) => {
              if (isNamedError(error, SUBNET_NOT_FOUND_NAMES)) return undefined;
              throw error;
            });
          associationId = live?.Subnets?.[0]?.Ipv6CidrBlockAssociationSet?.[0]?.AssociationId;
        }
        if (!associationId) {
          throw new ProvisioningError(
            `CreateSubnet returned no IPv6 association ID for ${logicalId}`,
            resourceType,
            logicalId,
            subnetId
          );
        }
        await this.waitForSubnetIpv6Association(
          logicalId,
          subnetId,
          resourceType,
          associationId,
          'associated'
        );
      }

      // Set MapPublicIpOnLaunch if specified
      const mapPublicIp = properties['MapPublicIpOnLaunch'];
      if (mapPublicIp === true || mapPublicIp === 'true') {
        await this.ec2Client.send(
          new ModifySubnetAttributeCommand({
            SubnetId: subnetId,
            MapPublicIpOnLaunch: { Value: true },
          })
        );
        // Issue #1299: don't return until the write is READABLE — the
        // deploy engine's async observed-state capture races this modify
        // and would otherwise persist the stale `false` as the drift
        // baseline (phantom drift on every later `cdkd drift`).
        await this.waitForSubnetAttribute(subnetId, true);
      }
      const dns64 = coerceCfnBoolean(prepared['EnableDns64']);
      if (dns64 !== undefined) {
        await this.ec2Client.send(
          new ModifySubnetAttributeCommand({
            SubnetId: subnetId,
            EnableDns64: { Value: dns64 },
          })
        );
        await this.waitForSubnetAttribute(subnetId, dns64, 'EnableDns64');
      }
      // go-to-k/cdkd#5632: sent only where it differs from what the new
      // subnet holds — false on a dual-stack subnet, while an IPv6-only one
      // may start with it on, so there an unreported value is not assumed.
      const assignIpv6 = coerceCfnBoolean(prepared['AssignIpv6AddressOnCreation']);
      const createdAssign =
        response.Subnet?.AssignIpv6AddressOnCreation ?? (ipv6Native === true ? undefined : false);
      if (assignIpv6 !== undefined && assignIpv6 !== createdAssign) {
        await this.writeSubnetAttribute(subnetId, 'AssignIpv6AddressOnCreation', assignIpv6);
      }
      await this.applySubnetPrivateDnsOptions(
        subnetId,
        prepared['PrivateDnsNameOptionsOnLaunch'],
        undefined,
        false
      );
    } catch (innerError) {
      try {
        await this.ec2Client.send(new DeleteSubnetCommand({ SubnetId: subnetId }));
        retractCreatedResource(logicalId, resourceType, subnetId);
        this.logger.debug(
          `Cleaned up partially-created Subnet ${logicalId} (${subnetId}) after wiring failure`
        );
      } catch (cleanupError) {
        leftBehindId = subnetId;
        const cleanupHead = `Failed to clean up partially-created Subnet ${logicalId} (${subnetId}): `;
        this.logger.warn(
          `${cleanupHead}${this.warnFailureSentence(cleanupHead, cleanupError, maskerOrIdentity(context?.maskSecrets))} Manual deletion may be required before the next deploy: ${pasteableAwsCommand()`aws ec2 delete-subnet --subnet-id ${subnetId}`.render()}`
        );
      }
      // The resource itself was created: an "already exists" from its wiring
      // is an auxiliary object's, not this resource's name collision (#3826).
      throw markAuxiliaryFailure(innerError, logicalId);
    }

    this.logger.debug(`Successfully created Subnet ${logicalId}: ${subnetId}`);

    return {
      physicalId: subnetId,
      ...(prepared !== properties && { effectiveProperties: prepared }),
      // go-to-k/cdkd#5632: the create-only members `Fn::GetAtt` reads. An
      // IPAM-allocated CIDR is known only from the CreateSubnet response, and
      // the resolver's Subnet arm builds none of them from the subnet id. The
      // response's CIDR is EC2's canonical form, which is what CloudFormation
      // returns for a declared one too.
      attributes: definedAttributes({
        SubnetId: subnetId,
        AvailabilityZone: availabilityZone,
        AvailabilityZoneId: response.Subnet?.AvailabilityZoneId,
        CidrBlock: response.Subnet?.CidrBlock ?? (cidrBlock || undefined),
        VpcId: response.Subnet?.VpcId ?? vpcId,
      }),
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create Subnet ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
    if (leftBehindId !== undefined) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, leftBehindId);
      // go-to-k/cdkd#5632: terminal for a pool-allocated subnet, as for an
      // IPAM VPC (#4945): no CIDR collides, so a retry makes another subnet.
      if (orphanCidr !== undefined && 'ipamPoolId' in orphanCidr) markNonRetryable(thrown);
    }
    throw thrown;
  }
}

export async function updateSubnet(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating Subnet ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
  let prepared = await this.prepareSubnetProperties(
    logicalId,
    resourceType,
    properties,
    context,
    physicalId,
    previousProperties
  );

  try {
    // VpcId / CidrBlock / AvailabilityZone and (go-to-k/cdkd#5632) the zone
    // id and IPAM inputs are CREATE-only. The diff layer normally routes a
    // change on them to replacement (hand rule in `replacement-rules.ts` +
    // the registry-schema createOnly fallback), but `cdkd drift --revert`
    // calls `update()` without that classification, so guard here too
    // rather than silently no-op'ing. Compared only when both sides carry
    // the key: neither pool id has a readback.
    for (const createOnly of SUBNET_CREATE_ONLY_SENT) {
      const next = properties[createOnly];
      const prev = previousProperties[createOnly];
      if (next !== undefined && prev !== undefined && !sameCreateOnlySent(createOnly, next, prev)) {
        throw new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          `destroy + redeploy the Subnet (and the resources that depend on it). ${createOnly} is immutable in AWS`
        );
      }
    }
    // go-to-k/cdkd#5632: compared as booleans, since CFn spells one either way.
    const nextNative = coerceCfnBoolean(prepared['Ipv6Native']);
    const prevNative = coerceCfnBoolean(previousProperties['Ipv6Native']);
    if (nextNative !== undefined && prevNative !== undefined && nextNative !== prevNative) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        'destroy + redeploy the Subnet (and the resources that depend on it). Ipv6Native is immutable in AWS'
      );
    }
    // go-to-k/cdkd#5632: an IPv6-only subnet cannot move its IPv6 block in
    // place. EC2 refuses the detach while auto-assign is on, and refuses
    // turning auto-assign off on an IPv6-native subnet (both measured,
    // us-east-1). The schema does not mark Ipv6CidrBlock create-only, so the
    // diff reads this as an update: refuse it before any call. A state
    // replay or a read-back revert cannot edit the template, so it keeps the
    // live block and warns instead.
    const canonicalBlock = (v: unknown): unknown =>
      typeof v === 'string' ? (canonicalizeIpv6Cidr(v) ?? v) : v;
    if (
      (nextNative === true || prevNative === true) &&
      prepared['Ipv6CidrBlock'] === properties['Ipv6CidrBlock'] &&
      canonicalBlock(prepared['Ipv6CidrBlock']) !==
        canonicalBlock(previousProperties['Ipv6CidrBlock'])
    ) {
      if (context?.replayingState !== true && context?.desiredFromAwsReadback !== true) {
        throw new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          'destroy + redeploy the Subnet (and the resources that depend on it). An IPv6-only (Ipv6Native) subnet cannot change its Ipv6CidrBlock in place: EC2 refuses to detach its block'
        );
      }
      this.logger.warn(
        safeMsg`${logicalId}: an IPv6-only (Ipv6Native) subnet cannot change its Ipv6CidrBlock in place; leaving the current block`
      );
      prepared = { ...prepared };
      if (previousProperties['Ipv6CidrBlock'] === undefined) delete prepared['Ipv6CidrBlock'];
      else prepared['Ipv6CidrBlock'] = previousProperties['Ipv6CidrBlock'];
    }

    // MapPublicIpOnLaunch IS mutable via ModifySubnetAttribute (issue
    // #1300). Coerce the CFn string-or-bool spelling and treat an absent
    // value as the AWS default `false` (CFn resets a removed property to
    // its default), diff-based so a no-op round-trip (`update(state,
    // state)` from `cdkd drift --revert`) sends zero mutating calls.
    const asBool = (v: unknown): boolean => v === true || v === 'true';
    const newMapPublicIp = asBool(properties['MapPublicIpOnLaunch']);
    const oldMapPublicIp = asBool(previousProperties['MapPublicIpOnLaunch']);
    if (newMapPublicIp !== oldMapPublicIp) {
      await this.ec2Client.send(
        new ModifySubnetAttributeCommand({
          SubnetId: physicalId,
          MapPublicIpOnLaunch: { Value: newMapPublicIp },
        })
      );
      await this.waitForSubnetAttribute(physicalId, newMapPublicIp);
    }

    // CloudFormation preserves DNS64 when the property is removed (#5632).
    const dns64 = coerceCfnBoolean(prepared['EnableDns64']);
    const keptDns64 = prepared['EnableDns64'] !== properties['EnableDns64'];
    let previousDns64 = coerceCfnBoolean(previousProperties['EnableDns64']);
    if (!keptDns64 && dns64 !== undefined && context?.unsettledProperties?.has('EnableDns64')) {
      const live = await this.readSubnetCurrentState(physicalId, new Set(['EnableDns64']));
      if (live === RESOURCE_NOT_FOUND || live === undefined) {
        throw new ProvisioningError(
          'Subnet was not returned by DescribeSubnets; retry the subnet read',
          resourceType,
          logicalId,
          physicalId
        );
      }
      previousDns64 = live['EnableDns64'] as boolean;
    }
    const changedDns64 = !keptDns64 && dns64 !== undefined && dns64 !== previousDns64;
    const applyDns64 = async (value: boolean): Promise<void> => {
      context?.markUnsettled?.('EnableDns64');
      await this.ec2Client.send(
        new ModifySubnetAttributeCommand({ SubnetId: physicalId, EnableDns64: { Value: value } })
      );
      await this.waitForSubnetAttribute(physicalId, value, 'EnableDns64');
    };
    // Disable first; enabling requires the new IPv6 association ready.
    if (changedDns64 && dns64 === false) await applyDns64(false);

    // go-to-k/cdkd#5632: like DNS64, a removed property leaves the live
    // value alone; a changed one is written (false before the IPv6 block
    // changes, true after it). An unsettled earlier attempt re-sends the
    // desired value, which converges whatever AWS holds.
    const assignIpv6 = coerceCfnBoolean(prepared['AssignIpv6AddressOnCreation']);
    const changedAssignIpv6 =
      prepared['AssignIpv6AddressOnCreation'] === properties['AssignIpv6AddressOnCreation'] &&
      assignIpv6 !== undefined &&
      (assignIpv6 !== coerceCfnBoolean(previousProperties['AssignIpv6AddressOnCreation']) ||
        context?.unsettledProperties?.has('AssignIpv6AddressOnCreation') === true);
    const applyAssignIpv6 = async (value: boolean): Promise<void> => {
      context?.markUnsettled?.('AssignIpv6AddressOnCreation');
      await this.writeSubnetAttribute(physicalId, 'AssignIpv6AddressOnCreation', value);
    };
    if (changedAssignIpv6 && assignIpv6 === false) await applyAssignIpv6(false);
    // A replay-retained block keeps its baseline without a write; its
    // record disables also go before the IPv6 block change.
    const applyPrivateDns = async (pass: 'disable' | 'rest', skipAaaaOn = false): Promise<void> => {
      if (prepared['PrivateDnsNameOptionsOnLaunch'] !== properties['PrivateDnsNameOptionsOnLaunch'])
        return;
      await this.applySubnetPrivateDnsOptions(
        physicalId,
        prepared['PrivateDnsNameOptionsOnLaunch'],
        previousProperties['PrivateDnsNameOptionsOnLaunch'],
        context?.unsettledProperties?.has('PrivateDnsNameOptionsOnLaunch') === true,
        context?.markUnsettled,
        pass,
        skipAaaaOn
      );
    };
    await applyPrivateDns('disable');

    // A replay-skipped field retains its baseline without issuing a write.
    const keptIpv6 = prepared['Ipv6CidrBlock'] !== properties['Ipv6CidrBlock'];
    const attached = prepared['Ipv6CidrBlock'] !== undefined;
    const declaredAaaa = subnetPrivateDnsMemberValue(
      prepared['PrivateDnsNameOptionsOnLaunch'],
      AAAA_MEMBER
    );
    const declaredDetachValue = (attribute: SubnetDetachAttribute): boolean | undefined =>
      attribute === 'EnableResourceNameDnsAAAARecordOnLaunch'
        ? (declaredAaaa as boolean | undefined)
        : coerceCfnBoolean(prepared[attribute]);
    const restore = new Set<SubnetDetachAttribute>();
    if (
      !keptIpv6 &&
      (prepared['Ipv6CidrBlock'] !== previousProperties['Ipv6CidrBlock'] ||
        context?.unsettledProperties?.has('Ipv6CidrBlock'))
    ) {
      const cleared = await this.updateSubnetIpv6CidrBlock(
        logicalId,
        physicalId,
        resourceType,
        prepared['Ipv6CidrBlock'] as string | undefined,
        true,
        context?.markUnsettled
      );
      // go-to-k/cdkd#5632: the detach turned off what blocks it. With a new
      // block attached, restore each unless the template now says false (an
      // undeclared value is left as it was, as on removal); with no block
      // left they stay off.
      for (const attribute of cleared) {
        if (attached && declaredDetachValue(attribute) !== false) restore.add(attribute);
      }
    }
    // An earlier attempt interrupted after that clear left an undeclared
    // value off. For these two only the clear marks an undeclared one
    // unsettled (the AAAA record shares its key with the other private DNS
    // members, so it is not covered): put it back once the block is
    // attached, unless the record said false.
    for (const attribute of ['EnableDns64', 'AssignIpv6AddressOnCreation'] as const) {
      if (
        declaredDetachValue(attribute) === undefined &&
        attached &&
        context?.unsettledProperties?.has(attribute) === true &&
        coerceCfnBoolean(previousProperties[attribute]) !== false
      ) {
        restore.add(attribute);
      }
    }
    // With no IPv6 block, EC2 refuses auto-assign, the AAAA record or DNS64
    // on, so those true writes are skipped (every retry would fail the same
    // way) and a warning says so. A template without Ipv6CidrBlock may still
    // have a block from an AWS::EC2::SubnetCidrBlock resource, so only the
    // live subnet decides; it is read only when one of the three is
    // declared true.
    const declaredAssign = declaredDetachValue('AssignIpv6AddressOnCreation');
    let blockless = false;
    let liveSubnet: Subnet | undefined;
    if (
      prepared['Ipv6CidrBlock'] === undefined &&
      coerceCfnBoolean(prepared['Ipv6Native']) !== true &&
      (declaredAssign === true || declaredAaaa === true || dns64 === true)
    ) {
      const live = await this.ec2Client.send(
        new DescribeSubnetsCommand({ SubnetIds: [physicalId] })
      );
      liveSubnet = live.Subnets?.[0];
      blockless = !(liveSubnet?.Ipv6CidrBlockAssociationSet ?? []).some(
        (association) => association.Ipv6CidrBlockState?.State === 'associated'
      );
    }
    // go-to-k/cdkd#5843: a declared true the live subnet holds off is sent
    // again even when the record already says true. A record written before
    // the narrowing below keeps true over a live false (the write was skipped
    // while the block was missing), so the record alone never re-sends it.
    // It also turns back on a value someone switched off out of band, which
    // drift would otherwise report; such a re-send is logged at debug level.
    const keptAssign =
      prepared['AssignIpv6AddressOnCreation'] !== properties['AssignIpv6AddressOnCreation'];
    const keptDns =
      prepared['PrivateDnsNameOptionsOnLaunch'] !== properties['PrivateDnsNameOptionsOnLaunch'];
    const liveOffAssign =
      !keptAssign && declaredAssign === true && liveSubnet?.AssignIpv6AddressOnCreation === false;
    const liveOffDns64 = !keptDns64 && dns64 === true && liveSubnet?.EnableDns64 === false;
    const liveOffAaaa =
      !keptDns &&
      declaredAaaa === true &&
      liveSubnet?.PrivateDnsNameOptionsOnLaunch?.EnableResourceNameDnsAAAARecord === false;
    const recordAssignOn =
      restore.has('AssignIpv6AddressOnCreation') || (changedAssignIpv6 && assignIpv6 === true);
    const wantsAssignOn = recordAssignOn || liveOffAssign;
    const wantsAaaaOn =
      restore.has('EnableResourceNameDnsAAAARecordOnLaunch') ||
      (declaredAaaa === true &&
        (subnetPrivateDnsMemberValue(
          previousProperties['PrivateDnsNameOptionsOnLaunch'],
          AAAA_MEMBER
        ) !== true ||
          context?.unsettledProperties?.has('PrivateDnsNameOptionsOnLaunch') === true));
    // EC2 refuses each of the three on with no IPv6 block (InvalidParameterValue,
    // measured), so a true write is skipped, announced, and RECORDED as the
    // false AWS holds (go-to-k/cdkd#5843): the next deploy then diffs the
    // template's true against it and sends the write once a block is there,
    // e.g. one an AWS::EC2::SubnetCidrBlock attached after this update.
    // CloudFormation fails the deploy instead; this gave way to converging.
    // No canonicalizeDesiredProperties counterpart, on purpose: that resurfacing
    // diff IS the retry, and all three are mutable, so it is an update.
    let recorded = prepared;
    const skipOn = (key: string, value: unknown, member: string): void => {
      this.logger.warn(
        safeMsg`Subnet ${logicalId}: ${member} is true but the subnet has no IPv6 block, so EC2 cannot keep it on; it stays off until a deploy finds a block`
      );
      recorded = { ...recorded, [key]: value };
    };
    if (blockless && declaredAssign === true) {
      skipOn('AssignIpv6AddressOnCreation', false, 'AssignIpv6AddressOnCreation');
    }
    if (blockless && declaredAaaa === true) {
      skipOn(
        'PrivateDnsNameOptionsOnLaunch',
        {
          ...(recorded['PrivateDnsNameOptionsOnLaunch'] as Record<string, unknown>),
          [AAAA_MEMBER.member]: false,
        },
        'PrivateDnsNameOptionsOnLaunch.EnableResourceNameDnsAAAARecord'
      );
    }
    const recordDns64On = restore.has('EnableDns64') || (changedDns64 && dns64 === true);
    const wantsDns64On = recordDns64On || liveOffDns64;
    if (blockless && dns64 === true) skipOn('EnableDns64', false, 'EnableDns64');
    const resendAaaa = liveOffAaaa && !wantsAaaaOn && !blockless;
    for (const [member, liveOnly] of [
      ['EnableDns64', liveOffDns64 && !recordDns64On],
      ['AssignIpv6AddressOnCreation', liveOffAssign && !recordAssignOn],
      ['PrivateDnsNameOptionsOnLaunch.EnableResourceNameDnsAAAARecord', resendAaaa],
    ] as const) {
      if (liveOnly && !blockless) {
        this.logger.debug(
          safeMsg`Subnet ${logicalId}: ${member} is declared true but the live subnet holds it off; sending it again`
        );
      }
    }
    if (wantsDns64On && !blockless) await applyDns64(true);
    if (wantsAssignOn && !blockless) await applyAssignIpv6(true);
    if (restore.has('EnableResourceNameDnsAAAARecordOnLaunch') || resendAaaa) {
      context?.markUnsettled?.('PrivateDnsNameOptionsOnLaunch');
      await this.writeSubnetAttribute(physicalId, 'EnableResourceNameDnsAAAARecordOnLaunch', true);
    }
    await applyPrivateDns('rest', blockless);

    // Update tags (diff add/remove against previousProperties)
    await this.applyTagDiff(
      physicalId,
      resourceType,
      logicalId,
      previousProperties['Tags'],
      properties['Tags'],
      maskerOrIdentity(context?.maskSecrets)
    );

    this.logger.debug(`Successfully updated Subnet ${logicalId}`);

    // No `attributes` on purpose: an in-place update never invalidates the
    // create-time attributes (SubnetId / AvailabilityZone), and returning a
    // partial set here would REPLACE the stored ones (see the deploy
    // engine's carriedAttributes note — the FSx attribute-wipe incident).
    return {
      physicalId,
      wasReplaced: false,
      ...(recorded !== properties && { effectiveProperties: recorded }),
    };
  } catch (error) {
    if (error instanceof CdkdError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update Subnet ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/** The {@link EC2Provider} methods this module defines. */
export const subnetMethods = { prepareSubnetProperties, createSubnet, updateSubnet };
