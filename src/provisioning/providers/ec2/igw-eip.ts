import {
  CreateInternetGatewayCommand,
  DeleteInternetGatewayCommand,
  AllocateAddressCommand,
  ReleaseAddressCommand,
  DescribeAddressesCommand,
  AssociateAddressCommand,
  DisassociateAddressCommand,
  type AllocateAddressCommandInput,
  type AllocateAddressCommandOutput,
  type CreateInternetGatewayCommandOutput,
} from '@aws-sdk/client-ec2';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { replayWarn, requireConfigString } from '../../config-shape.js';
import { packCompositeId, type CompositeIdOptions } from '../../composite-id.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import { replayedSendWindow } from '../ambiguous-create.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import type {
  CreateContext,
  UpdateContext,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../../types/resource.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { displayIdent, safeMsg } from '../../../utils/display-safe.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import { isThrottlingError, markNonRetryable } from '../../../deployment/retryable-errors.js';
import { withRetry } from '../../../deployment/retry.js';
import { startInterruptWatch } from '../../interrupt-watch.js';
import {
  allocateAddressLatch,
  createInternetGatewayLatch,
  ec2IdsCreatedByThisProcess,
} from './common.js';
import type { EC2Provider } from '../ec2-provider.js';

// ─── AWS::EC2::InternetGateway ────────────────────────────────────

export async function createInternetGateway(
  this: EC2Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating InternetGateway ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  try {
    const createClient = await this.getCreateClient();
    // Issue #2080: after an earlier ambiguous attempt, name the gateway it
    // may have made before a second CreateInternetGateway is sent.
    const orphanWindow = createInternetGatewayLatch.take(logicalId);
    if (orphanWindow !== undefined) {
      await this.reportPossibleOrphanInternetGateways(
        logicalId,
        desiredTags,
        orphanWindow,
        context
      );
    }
    const attemptStartMs = Date.now();
    let response: CreateInternetGatewayCommandOutput;
    let tagsApplied: boolean;
    try {
      ({ response, tagsApplied } = await this.sendTaggedCreate(
        logicalId,
        'internet-gateway',
        desiredTags,
        (TagSpecifications) =>
          createClient.send(
            new CreateInternetGatewayCommand(TagSpecifications ? { TagSpecifications } : {})
          )
      ));
    } catch (error) {
      createInternetGatewayLatch.noteFailure(logicalId, error, attemptStartMs, orphanWindow);
      throw error;
    }
    const igwId = response.InternetGateway!.InternetGatewayId!;
    ec2IdsCreatedByThisProcess.add(igwId);
    // Issue #4687: the SDK replayed this CreateInternetGateway inside its `send`, so
    // an earlier attempt may have made one too. Detection only.
    const igwReplayWindow = replayedSendWindow(response, attemptStartMs);
    if (igwReplayWindow !== undefined) {
      await this.reportPossibleOrphanInternetGateways(
        logicalId,
        desiredTags,
        igwReplayWindow,
        context
      );
    }

    // Apply tags the create did not carry (go-to-k/cdkd#4971)
    if (!tagsApplied)
      await this.applyTags(igwId, desiredTags, logicalId, maskerOrIdentity(context?.maskSecrets));

    this.logger.debug(`Successfully created InternetGateway ${logicalId}: ${igwId}`);

    return {
      physicalId: igwId,
      attributes: {
        InternetGatewayId: igwId,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create InternetGateway ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

/**
 * In-place update of a type whose only mutable property is `Tags`
 * (InternetGateway, RouteTable, NetworkAcl; go-to-k/cdkd#5448). CloudFormation
 * applies a tag change in place through CreateTags / DeleteTags, so cdkd
 * does too. `vpcIdCreateOnly` says the registry schema marks `VpcId`
 * create-only (RouteTable, NetworkAcl): the diff layer routes a change on it
 * to replacement, but `cdkd drift --revert` calls `update()` without that
 * classification, so a change on it is refused here rather than silently
 * no-op'd.
 */
export async function updateTagsOnly(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  vpcIdCreateOnly: boolean,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  const label = resourceType.slice('AWS::EC2::'.length);
  this.logger.debug(safeMsg`Updating ${label} ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
  if (vpcIdCreateOnly) {
    const next = properties['VpcId'];
    const prev = previousProperties['VpcId'];
    if (next !== undefined && prev !== undefined && next !== prev) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        `destroy + redeploy the ${label} (and the resources that depend on it). VpcId is immutable in AWS`
      );
    }
  }
  await this.applyTagDiff(
    physicalId,
    resourceType,
    logicalId,
    previousProperties['Tags'],
    properties['Tags'],
    maskerOrIdentity(context?.maskSecrets)
  );
  // No `attributes`: an in-place tag change invalidates none of the
  // create-time ones, and a partial set would REPLACE the stored ones.
  return { physicalId, wasReplaced: false };
}

export async function deleteInternetGateway(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting InternetGateway ${logicalId}: ${physicalId}`);

  try {
    await this.withDependencyViolationRetry(
      () =>
        this.ec2Client.send(new DeleteInternetGatewayCommand({ InternetGatewayId: physicalId })),
      { description: `DeleteInternetGateway ${logicalId} (${physicalId})` }
    );
    this.logger.debug(`Successfully deleted InternetGateway ${logicalId}`);
  } catch (error) {
    if (this.isNotFoundError(error)) {
      const clientRegion = await this.ec2Client.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`InternetGateway ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapDeleteError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete InternetGateway ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

// ─── AWS::EC2::EIP ────────────────────────────────────────────────
//
// Elastic IPs allocate synchronously (AllocateAddress returns the id + IP
// immediately), so an SDK provider skips the Cloud Control async-polling
// backoff (~20s for an instant resource) that the CC fallback pays. This
// matters because an EIP feeds the NAT Gateway on the critical path.
//
// physicalId is the composite `PublicIp|AllocationId`, matching the shape the
// Cloud Control fallback produced (see cloud-control-provider.ts), so Ref /
// GetAtt resolution and existing state stay byte-compatible.

/**
 * Both segments are AWS-generated (a dotted-quad address and an
 * `eipalloc-...` id), so neither can carry cdkd's `|` separator and the
 * refusal below is a fence rather than a live guard (issue #1672). It is
 * applied uniformly with the rest of the composite-packing sites so a future
 * id-shape change cannot quietly reintroduce the ambiguity; for the same
 * reason it is safe on BOTH callers — `createEip` (post-`AllocateAddress`)
 * and `import()` (post-`DescribeAddresses`) — even though a throw on either
 * would arrive after the AWS call.
 */
export function eipPhysicalId(
  this: EC2Provider,
  logicalId: string,
  publicIp: string,
  allocationId: string,
  options?: CompositeIdOptions
): string {
  return packCompositeId(
    'AWS::EC2::EIP',
    logicalId,
    [
      { name: 'publicIp', value: publicIp },
      { name: 'allocationId', value: allocationId },
    ],
    options
  );
}

export function parseEipPhysicalId(
  this: EC2Provider,
  physicalId: string
): {
  publicIp?: string | undefined;
  allocationId?: string | undefined;
} {
  if (physicalId.includes('|')) {
    const [publicIp, allocationId] = physicalId.split('|');
    return { publicIp, allocationId };
  }
  // Tolerate a bare allocation id (eipalloc-…) or a bare public IP.
  if (physicalId.startsWith('eipalloc-')) return { allocationId: physicalId };
  return { publicIp: physicalId };
}

export async function createEip(
  this: EC2Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating EIP ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  let allocationId: string;
  let publicIp: string;
  // Set once the create call returns: a later failure is an auxiliary
  // call's (the association), not this address's (#3826).
  let created = false;
  let createdId: string | undefined;
  let allocatedId: string | undefined;
  try {
    const input: AllocateAddressCommandInput = {
      Domain: requireConfigString(
        properties['Domain'],
        'vpc',
        'AWS::EC2::EIP Domain',
        replayWarn(this.logger, context)
      ) as 'vpc' | 'standard',
      NetworkBorderGroup: properties['NetworkBorderGroup'] as string | undefined,
      PublicIpv4Pool: properties['PublicIpv4Pool'] as string | undefined,
    };
    const createClient = await this.getCreateClient();
    // Issue #2080: after an earlier ambiguous attempt, name the address it
    // may have allocated before a second AllocateAddress is sent.
    const orphanWindow = allocateAddressLatch.take(logicalId);
    if (orphanWindow !== undefined) {
      await this.reportPossibleOrphanAddresses(
        logicalId,
        input,
        desiredTags,
        orphanWindow,
        context
      );
    }
    const attemptStartMs = Date.now();
    let response: AllocateAddressCommandOutput;
    let tagsApplied: boolean;
    try {
      ({ response, tagsApplied } = await this.sendTaggedCreate(
        logicalId,
        'elastic-ip',
        desiredTags,
        (TagSpecifications) =>
          createClient.send(
            new AllocateAddressCommand(TagSpecifications ? { ...input, TagSpecifications } : input)
          )
      ));
    } catch (error) {
      allocateAddressLatch.noteFailure(logicalId, error, attemptStartMs, orphanWindow);
      throw error;
    }

    created = true;
    allocationId = response.AllocationId!;
    allocatedId = allocationId;
    publicIp = response.PublicIp!;
    // go-to-k/cdkd#4583: the id delete() takes, should a later call fail.
    // `deleteEip` also accepts a bare allocation id, the fallback if the
    // composite fence ever refused.
    try {
      createdId = this.eipPhysicalId(logicalId, publicIp, allocationId);
    } catch {
      createdId = allocationId;
    }
    // go-to-k/cdkd#5511: report before the replay lookup, tags and association.
    reportCreatedResource(logicalId, resourceType, createdId);
    ec2IdsCreatedByThisProcess.add(allocationId);
    // Issue #4687: the SDK replayed this AllocateAddress inside its `send`, so
    // an earlier attempt may have made one too. Detection only.
    const eipReplayWindow = replayedSendWindow(response, attemptStartMs);
    if (eipReplayWindow !== undefined) {
      await this.reportPossibleOrphanAddresses(
        logicalId,
        input,
        desiredTags,
        eipReplayWindow,
        context
      );
    }

    // Tags the create did not carry (go-to-k/cdkd#4971)
    if (!tagsApplied)
      await this.applyTags(
        allocationId,
        desiredTags,
        logicalId,
        maskerOrIdentity(context?.maskSecrets)
      );

    // Associate to an instance on the fast SDK path, keeping EIP+InstanceId
    // off the ~20s Cloud Control async-poll route.
    //
    // This used to lean on "the EIP depends on the instance in the DAG, so
    // it is already running by now". Gating the instance `running` wait on
    // --no-wait falsified that: the dependency only guarantees the instance
    // has been CREATED, and AssociateAddress rejects a `pending` instance
    // with IncorrectInstanceState. That code is not in the retryable table,
    // so the outer withRetry does not absorb it -- the create would throw
    // and roll the stack back. Same failure mode as the instance-profile
    // association (issue #1279), which is the sibling site the wait-gating
    // work already had to fix; this one was missed because no integ
    // exercises --no-wait against an Instance+EIP stack.
    //
    // Handled the same way as #1279: skip under --no-wait and hand the user
    // the exact repair command, rather than silently reintroducing a wait
    // that --no-wait explicitly asked to skip.
    const instanceId = properties['InstanceId'] as string | undefined;
    if (instanceId) {
      if (process.env['CDKD_NO_WAIT'] === 'true') {
        this.logger.warn(
          // The PROSE copy of the template's InstanceId renders through
          // `displayIdent`: under --no-wait AWS never saw it, so nothing has
          // validated it, and a control byte there forges terminal lines
          // beside the command (#3136).
          `EIP ${logicalId} (${allocationId}) was NOT associated with ${displayIdent(instanceId)}: --no-wait skips the instance running-state wait, and AssociateAddress rejects an instance that is not yet running. Verify and associate once the instance is running: ${pasteableAwsCommand(context?.maskSecrets)`aws ec2 describe-instances --instance-ids ${instanceId} --query 'Reservations[].Instances[].State.Name' && aws ec2 associate-address --allocation-id ${allocationId} --instance-id ${instanceId}`.render()}`
        );
      } else {
        await this.ec2Client.send(
          new AssociateAddressCommand({ AllocationId: allocationId, InstanceId: instanceId })
        );
        this.logger.debug(`Associated EIP ${logicalId} (${allocationId}) to ${instanceId}`);
      }
    }

    this.logger.debug(`Successfully created EIP ${logicalId}: ${allocationId} (${publicIp})`);
  } catch (error) {
    if (created) markAuxiliaryFailure(error, logicalId);
    // go-to-k/cdkd#4945: release the address a later call (tags, the
    // association) failed after, so a transient failure stays retryable.
    // An address the association did attach is refused here and kept.
    if (createdId !== undefined && allocatedId !== undefined) {
      try {
        // Throttles retried: the usual failure here is a `RequestLimitExceeded`
        // the SDK gave up on, which this call would hit too. A NotFound is
        // NOT read as released: a just-allocated address can read so.
        const releaseId = allocatedId;
        const watch = startInterruptWatch(`EIP ${logicalId} release`);
        try {
          await withRetry(
            () => this.ec2Client.send(new ReleaseAddressCommand({ AllocationId: releaseId })),
            logicalId,
            {
              maxRetries: 4,
              initialDelayMs: 500,
              isRetryable: (_text, releaseError) => isThrottlingError(releaseError),
              isInterrupted: watch.isInterrupted,
              onInterrupted: watch.onInterrupted,
            }
          );
        } finally {
          watch.dispose();
        }
        retractCreatedResource(logicalId, resourceType, createdId);
        createdId = undefined;
        this.logger.debug(safeMsg`Released partially-created EIP ${logicalId} (${allocatedId})`);
      } catch (cleanupError) {
        const cleanupText = this.warnFailureSentence(
          `Failed to release partially-created EIP ${logicalId} (${allocatedId}): `,
          cleanupError,
          maskerOrIdentity(context?.maskSecrets)
        );
        this.logger.warn(
          safeMsg`Failed to release partially-created EIP ${logicalId} (${allocatedId}): ${cleanupText} Manual release may be required: ${pasteableAwsCommand(context?.maskSecrets)`aws ec2 release-address --allocation-id ${allocatedId}`.render()}`
        );
      }
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create EIP ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
    if (createdId !== undefined) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, createdId);
      // go-to-k/cdkd#4945: terminal. AllocateAddress sends no token, so the
      // engine's retry would allocate another address while the journal names one.
      markNonRetryable(thrown);
    }
    throw thrown;
  }

  // The second of the two sites whose segments only exist after the AWS
  // call, and OUTSIDE the try for the same reason as AppSync's ApiKey (issue
  // #1672): that `catch` re-wraps anything thrown as
  // `ProvisioningError('Failed to create EIP …')`, which would mis-report a
  // refusal as an allocation failure for an address AWS had already handed
  // out. Both segments come from `AllocateAddress`, so the refusal is a
  // fence rather than a live guard.
  return {
    physicalId: this.eipPhysicalId(
      logicalId,
      publicIp,
      allocationId,
      // A reverse-replacement rollback creates from a STATE record, so the
      // refusal downgrades to a warning.
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
    ),
    attributes: {
      AllocationId: allocationId,
      PublicIp: publicIp,
    },
  };
}

export async function updateEip(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // Tags and InstanceId (association) are mutable in place. NetworkBorderGroup
  // is create-only (the replacement path). A Domain or PublicIpv4Pool change
  // is deliberately not applied: CloudFormation neither replaces the address
  // nor changes it (go-to-k/cdkd#5449, measured: change set "Modify,
  // RequiresRecreation: Never", and the executed update kept the same
  // allocation, domain and pool), and AWS has no call to move one.
  this.logger.debug(`Updating EIP ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
  const { allocationId } = this.parseEipPhysicalId(physicalId);
  if (allocationId) {
    await this.applyTagDiff(
      allocationId,
      resourceType,
      logicalId,
      previousProperties['Tags'],
      properties['Tags'],
      maskerOrIdentity(context?.maskSecrets)
    );

    const oldInstanceId = previousProperties['InstanceId'] as string | undefined;
    const newInstanceId = properties['InstanceId'] as string | undefined;
    if (oldInstanceId !== newInstanceId) {
      if (newInstanceId) {
        // Associate (or re-associate to a different instance). Same
        // pending-instance hazard as createEip's association: under
        // --no-wait a target instance created in this deploy may still be
        // `pending`, and AssociateAddress rejects that with
        // IncorrectInstanceState (not in the retryable table). Unlike the
        // create path, the target here is often an EXISTING running
        // instance (repointing an EIP), so an unconditional skip would
        // break associations that succeed today -- attempt first, and only
        // degrade to the skip-and-warn remedy when AWS actually rejects the
        // not-yet-running instance under --no-wait.
        try {
          await this.ec2Client.send(
            new AssociateAddressCommand({
              AllocationId: allocationId,
              InstanceId: newInstanceId,
              AllowReassociation: true,
            })
          );
        } catch (error) {
          if (process.env['CDKD_NO_WAIT'] === 'true' && this.isIncorrectInstanceStateError(error)) {
            this.logger.warn(
              `EIP ${logicalId} (${displayIdent(allocationId)}) was NOT associated with ${displayIdent(newInstanceId)}: --no-wait skips the instance running-state wait, and AssociateAddress rejects an instance that is not yet running. Verify and associate once the instance is running: ${pasteableAwsCommand()`aws ec2 describe-instances --instance-ids ${newInstanceId} --query 'Reservations[].Instances[].State.Name' && aws ec2 associate-address --allocation-id ${allocationId} --instance-id ${newInstanceId} --allow-reassociation`.render()}`
            );
          } else {
            throw error;
          }
        }
      } else {
        // InstanceId removed → disassociate via the current AssociationId.
        const desc = await this.ec2Client.send(
          new DescribeAddressesCommand({ AllocationIds: [allocationId] })
        );
        const associationId = desc.Addresses?.[0]?.AssociationId;
        if (associationId) {
          await this.ec2Client.send(
            new DisassociateAddressCommand({ AssociationId: associationId })
          );
        }
      }
    }
  }
  return { physicalId, wasReplaced: false };
}

export async function deleteEip(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting EIP ${logicalId}: ${physicalId}`);
  const parsed = this.parseEipPhysicalId(physicalId);
  let allocationId = parsed.allocationId;

  // cdkd always stores the composite `IP|AllocationId`, but tolerate a
  // bare-public-IP physical id by resolving its allocation id first —
  // ReleaseAddress requires the allocation id for a VPC EIP.
  if (!allocationId && parsed.publicIp) {
    const lookup = await this.ec2Client.send(
      new DescribeAddressesCommand({ PublicIps: [parsed.publicIp] })
    );
    allocationId = lookup.Addresses?.[0]?.AllocationId;
    if (!allocationId) {
      this.logger.debug(`EIP ${physicalId} not found on lookup, skipping deletion`);
      return;
    }
  }

  try {
    await this.withDependencyViolationRetry(
      () => this.ec2Client.send(new ReleaseAddressCommand({ AllocationId: allocationId })),
      { description: `ReleaseAddress ${logicalId} (${allocationId})` }
    );
    this.logger.debug(`Successfully deleted EIP ${logicalId}`);
  } catch (error) {
    if (this.isNotFoundError(error)) {
      const clientRegion = await this.ec2Client.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      if (context?.failedCreateOrphan === true) {
        // go-to-k/cdkd#4606: a journaled orphan already gone settles with
        // exit 0, so say so once. Masked by the caller's printing bag.
        this.logger.info(
          safeMsg`  Elastic IP ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
        );
      } else {
        this.logger.debug(`EIP ${physicalId} does not exist, skipping deletion`);
      }
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapDeleteError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete EIP ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

export async function getEipAttribute(
  this: EC2Provider,
  physicalId: string,
  attributeName: string
): Promise<unknown> {
  const { publicIp, allocationId } = this.parseEipPhysicalId(physicalId);
  if (attributeName === 'AllocationId' && allocationId) return allocationId;
  if (attributeName === 'PublicIp' && publicIp) return publicIp;

  // Fall back to a live read for anything not encoded in the physical id.
  const filter = allocationId
    ? { AllocationIds: [allocationId] }
    : { PublicIps: publicIp ? [publicIp] : [] };
  const response = await this.ec2Client.send(new DescribeAddressesCommand(filter));
  const addr = response.Addresses?.[0];
  if (!addr) return undefined;
  switch (attributeName) {
    case 'AllocationId':
      return addr.AllocationId;
    case 'PublicIp':
      return addr.PublicIp;
    default:
      return undefined;
  }
}

/** The {@link EC2Provider} methods this module defines. */
export const igwEipMethods = {
  createInternetGateway,
  updateTagsOnly,
  deleteInternetGateway,
  eipPhysicalId,
  parseEipPhysicalId,
  createEip,
  updateEip,
  deleteEip,
  getEipAttribute,
};
