import type { EFSProvider } from '../efs-provider.js';
import {
  CreateMountTargetCommand,
  DeleteMountTargetCommand,
  DescribeMountTargetsCommand,
  ModifyMountTargetSecurityGroupsCommand,
  MountTargetNotFound,
  type IpAddressType,
} from '@aws-sdk/client-efs';
import { definedAttributes } from '../../attribute-map.js';
import { replayWarn, requireConfigString } from '../../config-shape.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import type {
  ResourceCreateResult,
  ResourceUpdateResult,
  CreateContext,
} from '../../../types/resource.js';
import { createMaskedLogSinks, type MaskedLogSinks } from '../../masked-retry-logger.js';
import { markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource } from '../../created-resource-sink.js';

export async function updateMountTarget(
  this: EFSProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  log: MaskedLogSinks
): Promise<ResourceUpdateResult> {
  log.debug(`Updating EFS MountTarget ${logicalId}: ${physicalId}`);

  const securityGroups = properties['SecurityGroups'] as string[] | undefined;
  if (securityGroups === undefined) {
    // Nothing mutable to apply (IpAddress / IpAddressType / Ipv6Address /
    // SubnetId / FileSystemId are immutable on MountTarget). Silent success keeps `cdkd drift
    // --revert` consistent with the wider provider convention when
    // only immutable fields differ.
    log.debug(`No mutable diff for EFS MountTarget ${logicalId}, skipping update`);
    return { physicalId, wasReplaced: false };
  }

  try {
    await this.getClient().send(
      new ModifyMountTargetSecurityGroupsCommand({
        MountTargetId: physicalId,
        SecurityGroups: securityGroups,
      })
    );

    log.debug(`Successfully updated EFS MountTarget ${logicalId}`);

    return { physicalId, wasReplaced: false };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update EFS MountTarget ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

// ─── AWS::EFS::MountTarget ─────────────────────────────────────────

export async function createMountTarget(
  this: EFSProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  log: MaskedLogSinks,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  log.debug(`Creating EFS MountTarget ${logicalId}`);

  const fileSystemId = properties['FileSystemId'] as string | undefined;
  if (!fileSystemId) {
    throw new ProvisioningError(
      `FileSystemId is required for EFS MountTarget ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  const subnetId = properties['SubnetId'] as string | undefined;
  if (!subnetId) {
    throw new ProvisioningError(
      `SubnetId is required for EFS MountTarget ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  const securityGroups = properties['SecurityGroups'] as string[] | undefined;
  // go-to-k/cdkd#2762: create-only addressing (declaring any of the three
  // used to route the mount target through Cloud Control). Each is sent
  // only when declared, so an undeclared one keeps AWS's default (an IPv4
  // mount target at an address it picks). A non-string is refused, not
  // dropped: dropping it would create the mount target at an address the
  // template did not ask for, and none of the three can be changed later.
  const ipAddress = this.optionalMountTargetString(
    properties['IpAddress'],
    'IpAddress',
    logicalId,
    context
  );
  const ipAddressType = this.optionalMountTargetString(
    properties['IpAddressType'],
    'IpAddressType',
    logicalId,
    context
  );
  const ipv6Address = this.optionalMountTargetString(
    properties['Ipv6Address'],
    'Ipv6Address',
    logicalId,
    context
  );

  // go-to-k/cdkd#4583: set once CreateMountTarget returned; nothing below
  // deletes it, so a failed wait leaves it with no state record.
  let createdMountTargetId: string | undefined;
  try {
    const response = await this.getMountTargetCreateClient().send(
      new CreateMountTargetCommand({
        FileSystemId: fileSystemId,
        SubnetId: subnetId,
        SecurityGroups: securityGroups,
        ...(ipAddress !== undefined ? { IpAddress: ipAddress } : {}),
        ...(ipAddressType !== undefined ? { IpAddressType: ipAddressType as IpAddressType } : {}),
        ...(ipv6Address !== undefined ? { Ipv6Address: ipv6Address } : {}),
      })
    );

    const mountTargetId = response.MountTargetId!;
    createdMountTargetId = mountTargetId;
    reportCreatedResource(logicalId, resourceType, mountTargetId); // go-to-k/cdkd#5511
    log.debug(
      `Created EFS MountTarget ${logicalId}: ${mountTargetId}, waiting for available state`
    );

    // Poll until mount target is available
    await this.waitForMountTargetAvailable(mountTargetId, logicalId, resourceType, log);

    log.debug(`Successfully created EFS MountTarget ${logicalId}: ${mountTargetId}`);

    // `Fn::GetAtt [MountTarget, IpAddress]` (go-to-k/cdkd#2762): without it
    // the resolver fell back to the mount target id. An IPv6-only mount
    // target has no IPv4 address, so it records none, and its GetAtt still
    // takes the resolver's unknown-attribute fallback (after one
    // stale-attribute read through `import()`), as before this change.
    return {
      physicalId: mountTargetId,
      attributes: definedAttributes({ IpAddress: response.IpAddress }),
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    const thrown =
      error instanceof ProvisioningError
        ? error
        : this.wrapMaskedError(
            log,
            error,
            (text) =>
              new ProvisioningError(
                `Failed to create EFS MountTarget ${logicalId}: ${text}`,
                resourceType,
                logicalId,
                undefined,
                cause
              )
          );
    if (createdMountTargetId) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, createdMountTargetId);
    }
    throw thrown;
  }
}

/**
 * A MountTarget string property, or `undefined` when undeclared (or blank).
 * Anything else (a number, an unresolved intrinsic object) is refused, and
 * only warned about when `create()` replays a state record.
 */
export function optionalMountTargetString(
  this: EFSProvider,
  value: unknown,
  key: 'IpAddress' | 'IpAddressType' | 'Ipv6Address',
  logicalId: string,
  context: CreateContext | undefined
): string | undefined {
  let read: string;
  try {
    read = requireConfigString(
      value,
      '',
      `AWS::EFS::MountTarget ${key}`,
      replayWarn(this.logger, context)
    );
  } catch (error) {
    throw new ProvisioningError(
      `EFS MountTarget ${logicalId}: ${describeAwsFailure(error).detail}`,
      'AWS::EFS::MountTarget',
      logicalId,
      undefined,
      error instanceof Error ? error : undefined
    );
  }
  return read === '' ? undefined : read;
}

export async function waitForMountTargetAvailable(
  this: EFSProvider,
  mountTargetId: string,
  logicalId: string,
  resourceType: string,
  log: MaskedLogSinks
): Promise<void> {
  const pollIntervalMs = 5000;
  const maxWaitMs = 120000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const response = await this.getClient().send(
      new DescribeMountTargetsCommand({
        MountTargetId: mountTargetId,
      })
    );

    const mountTarget = response.MountTargets?.[0];
    if (mountTarget?.LifeCycleState === 'available') {
      return;
    }

    log.debug(
      `MountTarget ${mountTargetId} state: ${mountTarget?.LifeCycleState ?? 'unknown'}, waiting...`
    );

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new ProvisioningError(
    `Timed out waiting for EFS MountTarget ${mountTargetId} to become available (120s)`,
    resourceType,
    logicalId,
    mountTargetId
  );
}

export async function deleteMountTarget(
  this: EFSProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting EFS MountTarget ${logicalId}: ${physicalId}`);

  try {
    await this.getClient().send(
      new DeleteMountTargetCommand({
        MountTargetId: physicalId,
      })
    );

    // Wait for mount target to be fully deleted
    await this.waitForMountTargetDeleted(physicalId, logicalId);

    this.logger.debug(`Successfully deleted EFS MountTarget ${logicalId}`);
  } catch (error) {
    if (error instanceof MountTargetNotFound) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`EFS MountTarget ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const log = createMaskedLogSinks(this.logger, context?.maskSecrets);
    throw this.wrapDeleteError(
      log,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete EFS MountTarget ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

export async function waitForMountTargetDeleted(
  this: EFSProvider,
  mountTargetId: string,
  logicalId: string
): Promise<void> {
  const pollIntervalMs = 5000;
  const maxWaitMs = 120000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const response = await this.getClient().send(
        new DescribeMountTargetsCommand({
          MountTargetId: mountTargetId,
        })
      );

      const mountTarget = response.MountTargets?.[0];
      if (!mountTarget) {
        return;
      }

      this.logger.debug(
        `MountTarget ${mountTargetId} state: ${mountTarget.LifeCycleState ?? 'unknown'}, waiting for deletion...`
      );
    } catch (error) {
      if (error instanceof MountTargetNotFound) {
        return;
      }
      throw error;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  this.logger.warn(
    `Timed out waiting for EFS MountTarget ${mountTargetId} deletion for ${logicalId} (120s)`
  );
}
