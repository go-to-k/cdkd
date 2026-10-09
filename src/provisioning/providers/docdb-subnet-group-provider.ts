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
  ResourceNotFound,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';
import { refuseMalformedDesiredTags } from '../tag-list.js';
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
  private createClient?: DocDBClient;
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
      // Built together with the create client, so both capture the identity
      // active at this ONE call (issue #4639).
      this.docdbClient = new DocDBClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
      this.createClient = withoutServerErrorRetries(
        new DocDBClient({
          ...ambientClientDefaults(),
          ...(this.providerRegion ? { region: this.providerRegion } : {}),
        })
      );
    }
    return this.docdbClient;
  }

  /**
   * The client `CreateDBSubnetGroup` goes through: SDK retries on, except a 5xx
   * (`withoutServerErrorRetries`, issue #4639). Separate so every other call
   * keeps the full SDK retry.
   *
   * It carries no idempotency token, and the subnet group name is unique per
   * account and region, so the SDK's own replay of a 5xx whose request had
   * succeeded collides with what the first send made, and that "already
   * exists" surfaced from the engine's FIRST attempt as a name somebody else
   * holds. Refused here, the 5xx reaches the deploy engine's retry, which
   * marks the create as possibly replayed (`withRetry`, #3978). Nothing is
   * adopted on that collision: a name is not attribution
   * (`docs/_contents/provider-rules.md`, "Adopt only on EXACT attribution").
   */
  private getCreateClient(): DocDBClient {
    this.getClient();
    return this.createClient as DocDBClient;
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
    // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
    const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

    const dbSubnetGroupName =
      (properties['DBSubnetGroupName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 255, lowercase: true });

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
    // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
    refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

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
          resourceType,
          logicalId,
          previousProperties['Tags'],
          properties['Tags']
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
   * `ListTagsForResource(ResourceName=arn)`. Returns `RESOURCE_NOT_FOUND` when
   * the group is gone (`DBSubnetGroupNotFoundFault` or an empty list).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
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
      // go-to-k/cdkd#4283: only the fault NAME proves the resource is gone;
      // the looser message match keeps its old "cannot tell" answer.
      if ((err as { name?: unknown } | null)?.name === 'DBSubnetGroupNotFoundFault')
        return RESOURCE_NOT_FOUND;
      if (isDocDBNotFoundError(err, 'DBSubnetGroupNotFoundFault')) return undefined;
      throw err;
    }
    const sg = resp.DBSubnetGroups?.[0];
    if (!sg) return RESOURCE_NOT_FOUND;

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
