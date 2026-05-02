import {
  LambdaClient,
  PublishLayerVersionCommand,
  DeleteLayerVersionCommand,
  GetLayerVersionByArnCommand,
  ListLayersCommand,
  ListTagsCommand,
  ResourceNotFoundException,
  type LayerVersionContentInput,
  type Runtime,
  type Architecture,
} from '@aws-sdk/client-lambda';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import { CDK_PATH_TAG } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * AWS Lambda LayerVersion Provider
 *
 * Implements resource provisioning for AWS::Lambda::LayerVersion using the Lambda SDK.
 * WHY: PublishLayerVersion is synchronous - the CC API does not support this resource type.
 *
 * Note: Lambda LayerVersions are immutable. Updates publish a new version (new ARN).
 * Deletes target the specific version extracted from the ARN.
 */
export class LambdaLayerVersionProvider implements ResourceProvider {
  private lambdaClient: LambdaClient;
  private logger = getLogger().child('LambdaLayerVersionProvider');
  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Lambda::LayerVersion',
      new Set([
        'LayerName',
        'Content',
        'CompatibleRuntimes',
        'CompatibleArchitectures',
        'Description',
        'LicenseInfo',
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.lambdaClient = awsClients.lambda;
  }

  /**
   * Create a Lambda layer version
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Lambda layer version ${logicalId}`);

    const layerName =
      (properties['LayerName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 64 });

    const content = properties['Content'] as Record<string, unknown> | undefined;
    if (!content) {
      throw new ProvisioningError(
        `Content is required for Lambda layer version ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const contentInput: LayerVersionContentInput = {};
      if (content['S3Bucket']) contentInput.S3Bucket = content['S3Bucket'] as string;
      if (content['S3Key']) contentInput.S3Key = content['S3Key'] as string;
      if (content['S3ObjectVersion'])
        contentInput.S3ObjectVersion = content['S3ObjectVersion'] as string;

      const response = await this.lambdaClient.send(
        new PublishLayerVersionCommand({
          LayerName: layerName,
          Content: contentInput,
          CompatibleRuntimes: properties['CompatibleRuntimes'] as Runtime[] | undefined,
          CompatibleArchitectures: properties['CompatibleArchitectures'] as
            | Architecture[]
            | undefined,
          Description: properties['Description'] as string | undefined,
          LicenseInfo: properties['LicenseInfo'] as string | undefined,
        })
      );

      const layerVersionArn = response.LayerVersionArn!;
      this.logger.debug(
        `Successfully created Lambda layer version ${logicalId}: ${layerVersionArn}`
      );

      return {
        physicalId: layerVersionArn,
        attributes: {
          LayerVersionArn: layerVersionArn,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Lambda layer version ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update a Lambda layer version
   *
   * Lambda layer versions are immutable. An update publishes a new version.
   * The new LayerVersionArn becomes the physical ID.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Lambda layer version ${logicalId}: ${physicalId}`);

    // Layer versions are immutable - publish a new version
    const createResult = await this.create(logicalId, resourceType, properties);

    return {
      physicalId: createResult.physicalId,
      wasReplaced: true,
      attributes: createResult.attributes ?? {},
    };
  }

  /**
   * Delete a Lambda layer version
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Lambda layer version ${logicalId}: ${physicalId}`);

    // Extract layer name and version number from the ARN
    // ARN format: arn:aws:lambda:region:account:layer:name:version
    const arnParts = physicalId.split(':');
    if (arnParts.length < 8) {
      this.logger.warn(`Invalid LayerVersionArn format: ${physicalId}, skipping deletion`);
      return;
    }
    const layerName = arnParts[6]!;
    const versionNumber = parseInt(arnParts[7]!, 10);

    if (isNaN(versionNumber)) {
      this.logger.warn(`Could not parse version number from ARN: ${physicalId}, skipping deletion`);
      return;
    }

    try {
      await this.lambdaClient.send(
        new DeleteLayerVersionCommand({
          LayerName: layerName,
          VersionNumber: versionNumber,
        })
      );
      this.logger.debug(`Successfully deleted Lambda layer version ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.lambdaClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Lambda layer version ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Lambda layer version ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Adopt an existing Lambda layer version into cdkd state.
   *
   * Lookup order:
   *  1. `--resource <id>=<layerVersionArn>` override → verify with
   *     `GetLayerVersionByArn`. (Note: there is no `LayerName` field that
   *     uniquely names a *version*; a layer name resolves to the latest
   *     version, so an explicit ARN is the only unambiguous override.)
   *  2. `ListLayers` paginator + `ListTags(Resource: layerArn)` (which
   *     returns a `Tags: Record<string,string>` map keyed by tag name).
   *     Match `aws:cdk:path` and adopt `LatestMatchingVersion.LayerVersionArn`.
   *
   * **Caveat**: Lambda layer versions are immutable, so auto-lookup adopts
   * the LATEST version of the named layer that carries the matching CDK
   * path tag. If the user's CDK app has since published newer versions
   * outside cdkd's tracking, the adopted physical id may be stale; pass
   * `--resource <id>=<arn>` to pin a specific version.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      try {
        await this.lambdaClient.send(
          new GetLayerVersionByArnCommand({ Arn: input.knownPhysicalId })
        );
        return { physicalId: input.knownPhysicalId, attributes: {} };
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    let marker: string | undefined;
    do {
      const list = await this.lambdaClient.send(
        new ListLayersCommand({ ...(marker && { Marker: marker }) })
      );
      for (const layer of list.Layers ?? []) {
        if (!layer.LayerArn || !layer.LatestMatchingVersion?.LayerVersionArn) continue;
        try {
          const tagsResp = await this.lambdaClient.send(
            new ListTagsCommand({ Resource: layer.LayerArn })
          );
          if (tagsResp.Tags?.[CDK_PATH_TAG] === input.cdkPath) {
            return {
              physicalId: layer.LatestMatchingVersion.LayerVersionArn,
              attributes: {},
            };
          }
        } catch (err) {
          if (err instanceof ResourceNotFoundException) continue;
          throw err;
        }
      }
      marker = list.NextMarker;
    } while (marker);
    return null;
  }
}
