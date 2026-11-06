import type { NeptuneProvider } from '../neptune-provider.js';
import {
  CreateDBSubnetGroupCommand,
  DeleteDBSubnetGroupCommand,
  DescribeDBSubnetGroupsCommand,
  ModifyDBSubnetGroupCommand,
} from '@aws-sdk/client-neptune';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { generatedNameFor } from '../../resource-name.js';
import { clearOnUpdateRemoval } from '../../update-removal.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import type { ResourceCreateResult, ResourceUpdateResult } from '../../../types/resource.js';

// ─── DBSubnetGroup ────────────────────────────────────────────────

export async function createDBSubnetGroup(
  this: NeptuneProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  mask: ((text: string) => string) | undefined
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating Neptune DBSubnetGroup ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  const dbSubnetGroupName =
    (properties['DBSubnetGroupName'] as string | undefined) ||
    generatedNameFor('AWS::Neptune::DBSubnetGroup', logicalId);

  try {
    await this.getCreateClient().send(
      new CreateDBSubnetGroupCommand({
        DBSubnetGroupName: dbSubnetGroupName,
        DBSubnetGroupDescription:
          (properties['DBSubnetGroupDescription'] as string) || `Subnet group for ${logicalId}`,
        SubnetIds: properties['SubnetIds'] as string[],
        ...(tags.length > 0 && { Tags: tags }),
      })
    );

    this.logger.debug(
      `Successfully created Neptune DBSubnetGroup ${logicalId}: ${dbSubnetGroupName}`
    );

    return {
      physicalId: dbSubnetGroupName,
      attributes: {
        DBSubnetGroupName: dbSubnetGroupName,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create Neptune DBSubnetGroup ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          dbSubnetGroupName,
          cause
        )
    );
  }
}

export async function updateDBSubnetGroup(
  this: NeptuneProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  mask: ((text: string) => string) | undefined
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating Neptune DBSubnetGroup ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

  try {
    // Class 2 — `SubnetIds: []` would be rejected by AWS as a
    // structurally invalid input (DBSubnetGroup requires ≥ 2 subnets in
    // distinct AZs). Skip the field when empty so description-only
    // updates work.
    const subnetIds = properties['SubnetIds'] as string[] | undefined;
    const sendSubnetIds = subnetIds !== undefined && subnetIds.length > 0;
    const modifyInput = {
      DBSubnetGroupName: physicalId,
      // #1160 reset-on-removal (kept; not measurable in the #5004 A/B):
      // CFn declares DBSubnetGroupDescription
      // required, so a CFn-valid template can never remove it — but
      // cdkd's create() tolerates absence with the `Subnet group for
      // <logicalId>` fallback, so removal resets to the same fallback for
      // create/update parity instead of silently keeping the old value.
      DBSubnetGroupDescription: clearOnUpdateRemoval(
        properties['DBSubnetGroupDescription'] as string | undefined,
        previousProperties['DBSubnetGroupDescription'] as string | undefined,
        `Subnet group for ${logicalId}`
      ),
      ...(sendSubnetIds && { SubnetIds: subnetIds }),
    } as ConstructorParameters<typeof ModifyDBSubnetGroupCommand>[0];
    await this.getClient().send(new ModifyDBSubnetGroupCommand(modifyInput));

    const desc = await this.getClient().send(
      new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: physicalId })
    );
    const arn = desc.DBSubnetGroups?.[0]?.DBSubnetGroupArn;
    if (arn) {
      await this.applyTagDiff(
        arn,
        resourceType,
        logicalId,
        previousProperties['Tags'],
        properties['Tags']
      );
    }

    this.logger.debug(`Successfully updated Neptune DBSubnetGroup ${logicalId}`);

    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        DBSubnetGroupName: physicalId,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update Neptune DBSubnetGroup ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

export async function deleteDBSubnetGroup(
  this: NeptuneProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting Neptune DBSubnetGroup ${logicalId}: ${physicalId}`);

  try {
    await this.getClient().send(
      new DeleteDBSubnetGroupCommand({
        DBSubnetGroupName: physicalId,
      })
    );
    this.logger.debug(`Successfully deleted Neptune DBSubnetGroup ${logicalId}`);
  } catch (error) {
    if (this.isNotFoundError(error, 'DBSubnetGroupNotFoundFault')) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`Neptune DBSubnetGroup ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapDeleteError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete Neptune DBSubnetGroup ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
