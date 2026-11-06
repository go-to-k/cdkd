import type { FSxFileSystemProvider } from '../fsx-filesystem-provider.js';
import {
  DeleteFileSystemCommand,
  FileSystemNotFound,
  type DeleteFileSystemOpenZFSOption,
} from '@aws-sdk/client-fsx';
import { safeMsg } from '../../../utils/display-safe.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { markNotGone } from '../../not-gone.js';

export async function deleteImpl(
  this: FSxFileSystemProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting FSx FileSystem ${logicalId}: ${physicalId}`);

  try {
    // The final backup keeps the API defaults, as CloudFormation does
    // (SCRATCH Lustre deployments have no final backup; PERSISTENT
    // deployments take the API-default one): the CFn schema has no
    // SkipFinalBackup / FinalBackupTags property. The one delete-time
    // property it has is OpenZFSConfiguration.Options, which CFn documents
    // as the way to delete a file system with child volumes
    // (DELETE_CHILD_VOLUMES_AND_SNAPSHOTS; go-to-k/cdkd#5431).
    const openZfsOptions = this.toDeleteOpenZFSOptions(properties);
    await this.getClient().send(
      new DeleteFileSystemCommand({
        FileSystemId: physicalId,
        ...(openZfsOptions && { OpenZFSConfiguration: { Options: openZfsOptions } }),
      })
    );
  } catch (error) {
    if (error instanceof FileSystemNotFound) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      if (context?.failedCreateOrphan === true) {
        // go-to-k/cdkd#4606: a journaled orphan already gone settles with
        // exit 0, so say so once. Masked by the caller's printing bag.
        this.logger.info(
          safeMsg`  FSx file system ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
        );
      } else {
        this.logger.debug(`FSx FileSystem ${physicalId} does not exist, skipping deletion`);
      }
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete FSx FileSystem ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    // The wrap names an AWS failure by its CLASS, and the delete classifiers
    // read `NotFound` in a message as "already deleted": only the typed
    // `FileSystemNotFound` above means this file system is gone (go-to-k/cdkd#2319).
    throw error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
  }

  // Deletion is async — poll until the file system is GONE. A timeout is
  // a hard error (never warn-and-continue): a half-deleted FSx file
  // system keeps billing and the destroy must not report success.
  await this.waitForFileSystemDeleted(physicalId, logicalId, resourceType, context?.maskSecrets);

  this.logger.debug(`Successfully deleted FSx FileSystem ${logicalId}`);
}

/**
 * The recorded `OpenZFSConfiguration.Options` to send on DeleteFileSystem
 * (go-to-k/cdkd#5431), or undefined when none is declared. A record from
 * before the option existed, or a non-OpenZFS file system, sends none.
 */
export function toDeleteOpenZFSOptions(
  this: FSxFileSystemProvider,
  properties: Record<string, unknown> | undefined
): DeleteFileSystemOpenZFSOption[] | undefined {
  if (properties?.['FileSystemType'] !== 'OPENZFS') return undefined;
  const config = properties['OpenZFSConfiguration'];
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return undefined;
  const options = (config as Record<string, unknown>)['Options'];
  if (!Array.isArray(options) || options.length === 0) return undefined;
  return options.map((o) => String(o)) as DeleteFileSystemOpenZFSOption[];
}
