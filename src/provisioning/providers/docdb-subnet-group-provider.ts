import {
  DocDBClient,
  CreateDBSubnetGroupCommand,
  DeleteDBSubnetGroupCommand,
  DescribeDBSubnetGroupsCommand,
  ModifyDBSubnetGroupCommand,
} from '@aws-sdk/client-docdb';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import { clearOnUpdateRemoval } from '../update-removal.js';
import { resolveExplicitPhysicalId } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { applyDocDBTagDiff, attachDocDBTags, isDocDBNotFoundError } from './docdb-shared.js';
import { safeMsg } from '../../utils/display-safe.js';

/**
 * AWS DocumentDB DB subnet group provider (`AWS::DocDB::DBSubnetGroup`).
 *
 * A class of its own, split from `DocDBProvider` (issue #3866), because the
 * Cloud Control fallback is decided per PROVIDER: the DB cluster and instance
 * are `NON_PROVISIONABLE` and their provider declares `disableCcApiFallback`,
 * while this type has Cloud Control handlers and keeps the #614 auto-route,
 * `--recreate-via-cc-api` and the unrecognized-property route.
 */
export class DocDBSubnetGroupProvider implements ResourceProvider {
  private docdbClient?: DocDBClient;
  private readonly providerRegion = ambientRegion();
  private logger = getLogger().child('DocDBSubnetGroupProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::DocDB::DBSubnetGroup',
      new Set(['DBSubnetGroupName', 'DBSubnetGroupDescription', 'SubnetIds', 'Tags']),
    ],
  ]);

  private getClient(): DocDBClient {
    if (!this.docdbClient) {
      this.docdbClient = new DocDBClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.docdbClient;
  }

  private buildTags(properties: Record<string, unknown>): Array<{ Key: string; Value: string }> {
    if (!properties['Tags']) return [];
    return properties['Tags'] as Array<{ Key: string; Value: string }>;
  }

  /** The one type this provider serves; anything else is a registration bug. */
  private assertType(resourceType: string, logicalId: string, physicalId?: string): void {
    if (resourceType !== 'AWS::DocDB::DBSubnetGroup') {
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId,
        physicalId
      );
    }
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.assertType(resourceType, logicalId);
    this.logger.debug(safeMsg`Creating DocDB DBSubnetGroup ${logicalId}`);

    const dbSubnetGroupName =
      (properties['DBSubnetGroupName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 255, lowercase: true });

    try {
      const tags = this.buildTags(properties);

      await this.getClient().send(
        new CreateDBSubnetGroupCommand({
          DBSubnetGroupName: dbSubnetGroupName,
          DBSubnetGroupDescription:
            (properties['DBSubnetGroupDescription'] as string) || `Subnet group for ${logicalId}`,
          SubnetIds: properties['SubnetIds'] as string[],
          ...(tags.length > 0 && { Tags: tags }),
        })
      );

      this.logger.debug(
        safeMsg`Successfully created DocDB DBSubnetGroup ${logicalId}: ${dbSubnetGroupName}`
      );

      return {
        physicalId: dbSubnetGroupName,
        attributes: {
          DBSubnetGroupName: dbSubnetGroupName,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create DocDB DBSubnetGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        dbSubnetGroupName,
        cause
      );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.assertType(resourceType, logicalId, physicalId);
    this.logger.debug(safeMsg`Updating DocDB DBSubnetGroup ${logicalId}: ${physicalId}`);

    try {
      // Class 2 — `SubnetIds: []` would be rejected by AWS as a structurally
      // invalid input (DBSubnetGroup requires ≥ 2 subnets in distinct AZs).
      // Skip the field when empty so the ModifyDBSubnetGroup call is a no-op
      // for the subnet list (description-only updates are legitimate).
      const subnetIds = properties['SubnetIds'] as string[] | undefined;
      const sendSubnetIds = subnetIds !== undefined && subnetIds.length > 0;
      const modifyInput = {
        DBSubnetGroupName: physicalId,
        // #1160 reset-on-removal: CFn declares DBSubnetGroupDescription
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

      // Apply tag diff. DocDB uses ARN-keyed AddTagsToResource /
      // RemoveTagsFromResource. DescribeDBSubnetGroups returns the ARN.
      const desc = await this.getClient().send(
        new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: physicalId })
      );
      const arn = desc.DBSubnetGroups?.[0]?.DBSubnetGroupArn;
      if (arn) {
        await applyDocDBTagDiff(
          this.getClient(),
          this.logger,
          arn,
          previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
          properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
        );
      }

      this.logger.debug(safeMsg`Successfully updated DocDB DBSubnetGroup ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          DBSubnetGroupName: physicalId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update DocDB DBSubnetGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.assertType(resourceType, logicalId, physicalId);
    this.logger.debug(safeMsg`Deleting DocDB DBSubnetGroup ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new DeleteDBSubnetGroupCommand({
          DBSubnetGroupName: physicalId,
        })
      );
      this.logger.debug(safeMsg`Successfully deleted DocDB DBSubnetGroup ${logicalId}`);
    } catch (error) {
      if (isDocDBNotFoundError(error, 'DBSubnetGroupNotFoundFault')) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(
          safeMsg`DocDB DBSubnetGroup ${physicalId} does not exist, skipping deletion`
        );
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete DocDB DBSubnetGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Adopt an existing DocDB DB subnet group into cdkd state. The
   * `DBSubnetGroupName` is usually present in CDK templates and is resolved
   * via a `DescribeDBSubnetGroups` existence check. There is no
   * `aws:cdk:path` tag fallback: AWS rejects `aws:`-prefixed tag writes, so
   * that tag never exists on a real resource and the walk could not match
   * (issue #1134).
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.resourceType !== 'AWS::DocDB::DBSubnetGroup') return null;
    const explicit = resolveExplicitPhysicalId(input, 'DBSubnetGroupName');
    if (explicit) {
      try {
        await this.getClient().send(
          new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: explicit })
        );
        return { physicalId: explicit, attributes: {} };
      } catch (err) {
        if ((err as { name?: string }).name === 'DBSubnetGroupNotFoundFault') return null;
        throw err;
      }
    }
    // A DBSubnetGroup reaching here needs an explicit `--resource` override
    // or a `DBSubnetGroupName` in the template.
    return null;
  }

  /**
   * Read the AWS-current DB subnet group in CFn-property shape: the keys
   * `create()` accepts, plus `Tags` via a follow-up
   * `ListTagsForResource(ResourceName=arn)`. Returns `undefined` when the
   * group is gone (`DBSubnetGroupNotFoundFault`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    if (resourceType !== 'AWS::DocDB::DBSubnetGroup') return undefined;
    let resp: {
      DBSubnetGroups?: Array<{
        DBSubnetGroupName?: string;
        DBSubnetGroupArn?: string;
        DBSubnetGroupDescription?: string;
        Subnets?: Array<{ SubnetIdentifier?: string }>;
      }>;
    };
    try {
      resp = (await this.getClient().send(
        new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: physicalId })
      )) as unknown as typeof resp;
    } catch (err) {
      if (isDocDBNotFoundError(err, 'DBSubnetGroupNotFoundFault')) return undefined;
      throw err;
    }
    const sg = resp.DBSubnetGroups?.[0];
    if (!sg) return undefined;

    const result: Record<string, unknown> = {};
    if (sg.DBSubnetGroupName !== undefined) result['DBSubnetGroupName'] = sg.DBSubnetGroupName;
    if (sg.DBSubnetGroupDescription !== undefined) {
      result['DBSubnetGroupDescription'] = sg.DBSubnetGroupDescription;
    }
    result['SubnetIds'] = (sg.Subnets ?? [])
      .map((s) => s.SubnetIdentifier)
      .filter((id): id is string => !!id);
    if (sg.DBSubnetGroupArn) {
      await attachDocDBTags(this.getClient(), this.logger, result, sg.DBSubnetGroupArn);
    }
    return result;
  }
}
