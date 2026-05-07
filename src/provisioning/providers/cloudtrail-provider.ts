import {
  CloudTrailClient,
  CreateTrailCommand,
  DeleteTrailCommand,
  UpdateTrailCommand,
  StartLoggingCommand,
  StopLoggingCommand,
  PutEventSelectorsCommand,
  PutInsightSelectorsCommand,
  GetTrailCommand,
  GetTrailStatusCommand,
  GetEventSelectorsCommand,
  ListTrailsCommand,
  ListTagsCommand,
  TrailNotFoundException,
  type EventSelector,
  type InsightSelector,
} from '@aws-sdk/client-cloudtrail';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import {
  matchesCdkPath,
  normalizeAwsTagsToCfn,
  resolveExplicitPhysicalId,
} from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * SDK Provider for AWS CloudTrail resources
 *
 * Supports:
 * - AWS::CloudTrail::Trail
 *
 * CloudTrail CreateTrail/UpdateTrail are synchronous - the CC API adds
 * unnecessary polling overhead for operations that complete immediately.
 */
export class CloudTrailProvider implements ResourceProvider {
  private client: CloudTrailClient | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('CloudTrailProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::CloudTrail::Trail',
      new Set([
        'S3BucketName',
        'TrailName',
        'S3KeyPrefix',
        'IsMultiRegionTrail',
        'IncludeGlobalServiceEvents',
        'EnableLogFileValidation',
        'IsLogging',
        'Tags',
        'CloudWatchLogsLogGroupArn',
        'CloudWatchLogsRoleArn',
        'KMSKeyId',
        'SnsTopicName',
        'EventSelectors',
        'InsightSelectors',
        'IsOrganizationTrail',
      ]),
    ],
  ]);

  private getClient(): CloudTrailClient {
    if (!this.client) {
      this.client = new CloudTrailClient(
        this.providerRegion ? { region: this.providerRegion } : {}
      );
    }
    return this.client;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating CloudTrail Trail ${logicalId}`);

    const s3BucketName = properties['S3BucketName'] as string | undefined;
    if (!s3BucketName) {
      throw new ProvisioningError(
        `S3BucketName is required for CloudTrail Trail ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const trailName = properties['TrailName'] as string | undefined;
    const s3KeyPrefix = properties['S3KeyPrefix'] as string | undefined;
    const isMultiRegionTrail = properties['IsMultiRegionTrail'] as boolean | undefined;
    const includeGlobalServiceEvents = properties['IncludeGlobalServiceEvents'] as
      | boolean
      | undefined;
    const enableLogFileValidation = properties['EnableLogFileValidation'] as boolean | undefined;
    const isLogging = properties['IsLogging'] as boolean | undefined;
    const tags = properties['Tags'] as Array<{ Key: string; Value: string }> | undefined;
    const cloudWatchLogsLogGroupArn = properties['CloudWatchLogsLogGroupArn'] as string | undefined;
    const cloudWatchLogsRoleArn = properties['CloudWatchLogsRoleArn'] as string | undefined;
    const kmsKeyId = properties['KMSKeyId'] as string | undefined;
    const snsTopicName = properties['SnsTopicName'] as string | undefined;
    const isOrganizationTrail = properties['IsOrganizationTrail'] as boolean | undefined;
    const eventSelectors = properties['EventSelectors'] as EventSelector[] | undefined;
    const insightSelectors = properties['InsightSelectors'] as InsightSelector[] | undefined;

    try {
      const result = await this.getClient().send(
        new CreateTrailCommand({
          Name: trailName ?? logicalId,
          S3BucketName: s3BucketName,
          S3KeyPrefix: s3KeyPrefix,
          IsMultiRegionTrail: isMultiRegionTrail,
          IncludeGlobalServiceEvents: includeGlobalServiceEvents,
          EnableLogFileValidation: enableLogFileValidation,
          TagsList: tags ? tags.map((t) => ({ Key: t.Key, Value: t.Value })) : undefined,
          CloudWatchLogsLogGroupArn: cloudWatchLogsLogGroupArn,
          CloudWatchLogsRoleArn: cloudWatchLogsRoleArn,
          KmsKeyId: kmsKeyId,
          SnsTopicName: snsTopicName,
          IsOrganizationTrail: isOrganizationTrail,
        })
      );

      const trailArn = result.TrailARN!;

      // Apply EventSelectors if specified (requires separate API call)
      if (eventSelectors && eventSelectors.length > 0) {
        this.logger.debug(`Setting event selectors for CloudTrail Trail ${logicalId}`);
        await this.getClient().send(
          new PutEventSelectorsCommand({
            TrailName: trailArn,
            EventSelectors: eventSelectors,
          })
        );
      }

      // Apply InsightSelectors if specified (requires separate API call)
      if (insightSelectors && insightSelectors.length > 0) {
        this.logger.debug(`Setting insight selectors for CloudTrail Trail ${logicalId}`);
        await this.getClient().send(
          new PutInsightSelectorsCommand({
            TrailName: trailArn,
            InsightSelectors: insightSelectors,
          })
        );
      }

      // Start logging if IsLogging is true (default behavior)
      if (isLogging !== false) {
        this.logger.debug(`Starting logging for CloudTrail Trail ${logicalId}`);
        await this.getClient().send(new StartLoggingCommand({ Name: trailArn }));
      }

      this.logger.debug(`Successfully created CloudTrail Trail ${logicalId}: ${trailArn}`);

      return {
        physicalId: trailArn,
        attributes: {
          Arn: trailArn,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create CloudTrail Trail ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
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
    this.logger.debug(`Updating CloudTrail Trail ${logicalId}: ${physicalId}`);

    const s3BucketName = properties['S3BucketName'] as string | undefined;
    const s3KeyPrefix = properties['S3KeyPrefix'] as string | undefined;
    const isMultiRegionTrail = properties['IsMultiRegionTrail'] as boolean | undefined;
    const includeGlobalServiceEvents = properties['IncludeGlobalServiceEvents'] as
      | boolean
      | undefined;
    const enableLogFileValidation = properties['EnableLogFileValidation'] as boolean | undefined;
    const isLogging = properties['IsLogging'] as boolean | undefined;
    const cloudWatchLogsLogGroupArn = properties['CloudWatchLogsLogGroupArn'] as string | undefined;
    const cloudWatchLogsRoleArn = properties['CloudWatchLogsRoleArn'] as string | undefined;
    const kmsKeyId = properties['KMSKeyId'] as string | undefined;
    const snsTopicName = properties['SnsTopicName'] as string | undefined;
    const isOrganizationTrail = properties['IsOrganizationTrail'] as boolean | undefined;

    try {
      await this.getClient().send(
        new UpdateTrailCommand({
          Name: physicalId,
          S3BucketName: s3BucketName,
          S3KeyPrefix: s3KeyPrefix,
          IsMultiRegionTrail: isMultiRegionTrail,
          IncludeGlobalServiceEvents: includeGlobalServiceEvents,
          EnableLogFileValidation: enableLogFileValidation,
          CloudWatchLogsLogGroupArn: cloudWatchLogsLogGroupArn,
          CloudWatchLogsRoleArn: cloudWatchLogsRoleArn,
          KmsKeyId: kmsKeyId,
          SnsTopicName: snsTopicName,
          IsOrganizationTrail: isOrganizationTrail,
        })
      );

      // Update EventSelectors if changed
      const newEventSelectors = properties['EventSelectors'] as EventSelector[] | undefined;
      const oldEventSelectors = previousProperties['EventSelectors'] as EventSelector[] | undefined;
      if (JSON.stringify(newEventSelectors) !== JSON.stringify(oldEventSelectors)) {
        if (newEventSelectors && newEventSelectors.length > 0) {
          this.logger.debug(`Updating event selectors for CloudTrail Trail ${logicalId}`);
          await this.getClient().send(
            new PutEventSelectorsCommand({
              TrailName: physicalId,
              EventSelectors: newEventSelectors,
            })
          );
        }
      }

      // Update InsightSelectors if changed
      const newInsightSelectors = properties['InsightSelectors'] as InsightSelector[] | undefined;
      const oldInsightSelectors = previousProperties['InsightSelectors'] as
        | InsightSelector[]
        | undefined;
      if (JSON.stringify(newInsightSelectors) !== JSON.stringify(oldInsightSelectors)) {
        if (newInsightSelectors && newInsightSelectors.length > 0) {
          this.logger.debug(`Updating insight selectors for CloudTrail Trail ${logicalId}`);
          await this.getClient().send(
            new PutInsightSelectorsCommand({
              TrailName: physicalId,
              InsightSelectors: newInsightSelectors,
            })
          );
        }
      }

      // Handle IsLogging changes
      const oldIsLogging = previousProperties['IsLogging'] as boolean | undefined;
      if (isLogging !== oldIsLogging) {
        if (isLogging === false) {
          this.logger.debug(`Stopping logging for CloudTrail Trail ${logicalId}`);
          await this.getClient().send(new StopLoggingCommand({ Name: physicalId }));
        } else {
          this.logger.debug(`Starting logging for CloudTrail Trail ${logicalId}`);
          await this.getClient().send(new StartLoggingCommand({ Name: physicalId }));
        }
      }

      this.logger.debug(`Successfully updated CloudTrail Trail ${logicalId}`);

      return { physicalId, wasReplaced: false };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update CloudTrail Trail ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
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
    this.logger.debug(`Deleting CloudTrail Trail ${logicalId}: ${physicalId}`);

    try {
      // Stop logging before deletion (ignore errors)
      try {
        await this.getClient().send(new StopLoggingCommand({ Name: physicalId }));
      } catch {
        // Ignore errors when stopping logging
      }

      await this.getClient().send(new DeleteTrailCommand({ Name: physicalId }));
      this.logger.debug(`Successfully deleted CloudTrail Trail ${logicalId}`);
    } catch (error) {
      if (error instanceof TrailNotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`CloudTrail Trail ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete CloudTrail Trail ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  getAttribute(
    _physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    // Arn is stored in attributes during create
    return Promise.resolve(attributeName);
  }

  /**
   * Adopt an existing CloudTrail trail into cdkd state.
   *
   * Lookup order:
   *  1. `--resource` override or `Properties.TrailName` → verify via `GetTrail`.
   *  2. `ListTrails` + `ListTags` (CloudTrail uses `Tag[]` arrays per ARN),
   *     match `aws:cdk:path` tag.
   */
  /**
   * Read the AWS-current CloudTrail Trail configuration in CFn-property shape.
   *
   * Issues `GetTrail`, plus best-effort `GetTrailStatus` (for `IsLogging`)
   * and `GetEventSelectors` (for `EventSelectors`). Each enrichment call is
   * wrapped in its own try/catch so an "AccessDenied" or other transient
   * error on the secondary calls omits that key without failing the
   * whole snapshot — the comparator only descends into keys present in
   * state.
   *
   * Mapping: AWS `GetTrail` returns `KmsKeyId` (lowercase `s`) while CFn
   * uses `KMSKeyId`; we re-shape the key. SnsTopicARN is the Trail's
   * derived field; the cdkd state property is `SnsTopicName` so we
   * surface `SnsTopicName` directly from `GetTrail.SnsTopicName`.
   *
   * Tags are surfaced via a follow-up `ListTags(ResourceIdList=[arn])` call
   * (using the trail ARN from the same `GetTrail` response). CDK's `aws:*`
   * auto-tags are filtered out and the result key is omitted when AWS
   * reports no user tags.
   *
   * `InsightSelectors` is skipped for v1 (separate call + shape mapping
   * still TBD).
   *
   * Returns `undefined` when the trail is gone (`TrailNotFoundException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let trail;
    try {
      const resp = await this.getClient().send(new GetTrailCommand({ Name: physicalId }));
      trail = resp.Trail;
    } catch (err) {
      if (err instanceof TrailNotFoundException) return undefined;
      throw err;
    }
    if (!trail) return undefined;

    const result: Record<string, unknown> = {};
    if (trail.Name !== undefined) result['TrailName'] = trail.Name;
    if (trail.S3BucketName !== undefined) result['S3BucketName'] = trail.S3BucketName;
    if (trail.S3KeyPrefix !== undefined) result['S3KeyPrefix'] = trail.S3KeyPrefix;
    if (trail.IsMultiRegionTrail !== undefined) {
      result['IsMultiRegionTrail'] = trail.IsMultiRegionTrail;
    }
    if (trail.IncludeGlobalServiceEvents !== undefined) {
      result['IncludeGlobalServiceEvents'] = trail.IncludeGlobalServiceEvents;
    }
    if (trail.LogFileValidationEnabled !== undefined) {
      result['EnableLogFileValidation'] = trail.LogFileValidationEnabled;
    }
    if (trail.CloudWatchLogsLogGroupArn !== undefined) {
      result['CloudWatchLogsLogGroupArn'] = trail.CloudWatchLogsLogGroupArn;
    }
    if (trail.CloudWatchLogsRoleArn !== undefined) {
      result['CloudWatchLogsRoleArn'] = trail.CloudWatchLogsRoleArn;
    }
    if (trail.KmsKeyId !== undefined) result['KMSKeyId'] = trail.KmsKeyId;
    if (trail.SnsTopicName !== undefined) result['SnsTopicName'] = trail.SnsTopicName;
    if (trail.IsOrganizationTrail !== undefined) {
      result['IsOrganizationTrail'] = trail.IsOrganizationTrail;
    }

    // IsLogging — separate call. Treat any error as "feature not configured"
    // and omit the key.
    try {
      const status = await this.getClient().send(new GetTrailStatusCommand({ Name: physicalId }));
      if (status.IsLogging !== undefined) result['IsLogging'] = status.IsLogging;
    } catch {
      // Best-effort.
    }

    // EventSelectors — separate call. AWS returns either `EventSelectors`
    // or `AdvancedEventSelectors` (mutually exclusive). cdkd state's CFn
    // shape is `EventSelectors` only, so surface only that variant.
    try {
      const sel = await this.getClient().send(
        new GetEventSelectorsCommand({ TrailName: physicalId })
      );
      if (sel.EventSelectors && sel.EventSelectors.length > 0) {
        result['EventSelectors'] = sel.EventSelectors.map(
          (es) => es as unknown as Record<string, unknown>
        );
      }
    } catch {
      // Best-effort.
    }

    // Tags via ListTags. Requires the trail ARN.
    if (trail.TrailARN) {
      try {
        const tagsResp = await this.getClient().send(
          new ListTagsCommand({ ResourceIdList: [trail.TrailARN] })
        );
        const tags = normalizeAwsTagsToCfn(tagsResp.ResourceTagList?.[0]?.TagsList);
        result['Tags'] = tags;
      } catch (err) {
        this.logger.debug(
          `CloudTrail ListTags(${trail.TrailARN}) failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return result;
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'TrailName');
    if (explicit) {
      try {
        await this.getClient().send(new GetTrailCommand({ Name: explicit }));
        return { physicalId: explicit, attributes: {} };
      } catch (err) {
        if (err instanceof TrailNotFoundException) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    let nextToken: string | undefined;
    do {
      const list = await this.getClient().send(
        new ListTrailsCommand({ ...(nextToken && { NextToken: nextToken }) })
      );
      for (const trail of list.Trails ?? []) {
        if (!trail.TrailARN || !trail.Name) continue;
        try {
          const tagsResp = await this.getClient().send(
            new ListTagsCommand({ ResourceIdList: [trail.TrailARN] })
          );
          const list2 = tagsResp.ResourceTagList?.[0];
          if (matchesCdkPath(list2?.TagsList, input.cdkPath)) {
            return { physicalId: trail.Name, attributes: {} };
          }
        } catch (err) {
          if (err instanceof TrailNotFoundException) continue;
          throw err;
        }
      }
      nextToken = list.NextToken;
    } while (nextToken);
    return null;
  }
}
