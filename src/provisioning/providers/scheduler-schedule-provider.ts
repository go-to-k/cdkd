import {
  SchedulerClient,
  CreateScheduleCommand,
  UpdateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  ResourceNotFoundException,
  type CreateScheduleCommandInput,
  type UpdateScheduleCommandInput,
  type Target,
  type FlexibleTimeWindow,
} from '@aws-sdk/client-scheduler';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { resolveExplicitPhysicalId } from '../import-helpers.js';
import { generateResourceName } from '../resource-name.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * SDK Provider for AWS::Scheduler::Schedule.
 *
 * Why an SDK provider instead of the Cloud Control fallback (issue #961):
 * the type's registry `primaryIdentifier` is `/properties/Name` ONLY, but
 * the AWS read/update/delete handlers resolve a bare Name against the
 * DEFAULT schedule group. A schedule created with `GroupName` set to a
 * custom group is therefore unaddressable via Cloud Control — no identifier
 * form works (bare name -> NotFound in the default group; `grp|name` ->
 * ValidationException; the ARN fails the name-pattern check; the schema has
 * no additionalIdentifiers). Empirically: CC UPDATE failed NotFound, and CC
 * DELETE landed FAILED/NotFound which the delete path swallowed as
 * idempotent success — silently orphaning a LIVE schedule that keeps firing
 * its target. CloudFormation is unaffected because its handler invocations
 * carry the full previous resource model (including GroupName); the
 * Scheduler SDK APIs all accept an explicit `GroupName` parameter, which
 * this provider threads from the resource properties.
 *
 * physicalId is the schedule NAME (matches CFn: `Ref` returns the Name, and
 * pre-existing Cloud-Control-provisioned state also stored the bare name, so
 * no state migration is needed). GroupName is recovered from `properties`
 * on update/delete/readCurrentState — the state record always carries the
 * resolved properties.
 *
 * A GroupName change is rejected with `ResourceUpdateNotSupportedError`:
 * `UpdateSchedule` uses GroupName to ADDRESS the schedule (a different
 * group means "a different schedule"), so an in-place move between groups
 * is impossible at the API level. The deploy engine's `--replace` fallback
 * recreates the schedule in the new group.
 */
export class SchedulerScheduleProvider implements ResourceProvider {
  private client: SchedulerClient | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('SchedulerScheduleProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Scheduler::Schedule',
      new Set([
        'Name',
        'GroupName',
        'Description',
        'ScheduleExpression',
        'ScheduleExpressionTimezone',
        'StartDate',
        'EndDate',
        'State',
        'KmsKeyArn',
        'FlexibleTimeWindow',
        'Target',
      ]),
    ],
  ]);

  private getClient(): SchedulerClient {
    if (!this.client) {
      this.client = new SchedulerClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
  }

  /**
   * Extract the GroupName a schedule lives in from its CFn properties.
   * Absent GroupName means the default group — the SDK accepts an omitted
   * GroupName with the same semantics, so `undefined` passes through.
   */
  private groupNameOf(properties: Record<string, unknown> | undefined): string | undefined {
    const group = properties?.['GroupName'];
    return typeof group === 'string' && group.length > 0 ? group : undefined;
  }

  /**
   * Map the CFn property shape to the Scheduler SDK input shape. The two
   * are PascalCase-identical except `StartDate` / `EndDate`, which CFn
   * carries as ISO strings and the SDK types as `Date`.
   */
  private toSdkFields(
    properties: Record<string, unknown>
  ): Omit<CreateScheduleCommandInput, 'Name' | 'GroupName' | 'ClientToken'> {
    return {
      ScheduleExpression: properties['ScheduleExpression'] as string,
      FlexibleTimeWindow: properties['FlexibleTimeWindow'] as FlexibleTimeWindow,
      Target: properties['Target'] as Target,
      ...(properties['Description'] !== undefined && {
        Description: properties['Description'] as string,
      }),
      ...(properties['ScheduleExpressionTimezone'] !== undefined && {
        ScheduleExpressionTimezone: properties['ScheduleExpressionTimezone'] as string,
      }),
      ...(properties['StartDate'] !== undefined && {
        StartDate: new Date(properties['StartDate'] as string),
      }),
      ...(properties['EndDate'] !== undefined && {
        EndDate: new Date(properties['EndDate'] as string),
      }),
      ...(properties['State'] !== undefined && {
        State: properties['State'] as CreateScheduleCommandInput['State'],
      }),
      ...(properties['KmsKeyArn'] !== undefined && {
        KmsKeyArn: properties['KmsKeyArn'] as string,
      }),
    };
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    // Schedule names: <= 64 chars, ^[0-9a-zA-Z-_.]+$ — generateResourceName's
    // stack-prefixed output satisfies both.
    const name =
      (properties['Name'] as string | undefined) ??
      generateResourceName(logicalId, { maxLength: 64 });
    const groupName = this.groupNameOf(properties);

    this.logger.debug(
      `Creating Schedule ${logicalId}: ${name}${groupName ? ` (group: ${groupName})` : ''}`
    );

    try {
      const response = await this.getClient().send(
        new CreateScheduleCommand({
          Name: name,
          ...(groupName && { GroupName: groupName }),
          ...this.toSdkFields(properties),
        })
      );

      return {
        physicalId: name,
        attributes: {
          // CFn's only GetAtt for the type. CreateSchedule always returns it.
          Arn: response.ScheduleArn ?? '',
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Schedule ${logicalId}: ${cause?.message ?? String(error)}`,
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
    const groupName = this.groupNameOf(properties);
    const previousGroupName = this.groupNameOf(previousProperties);

    if (groupName !== previousGroupName) {
      // GroupName is how the API ADDRESSES the schedule — there is no
      // in-place move between groups. The engine's --replace fallback
      // recreates the schedule in the new group.
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        `GroupName addresses the schedule (${previousGroupName ?? 'default'} -> ${groupName ?? 'default'}); ` +
          `re-run with \`cdkd deploy --replace ${logicalId}\` to recreate it in the new group`
      );
    }

    this.logger.debug(
      `Updating Schedule ${logicalId}: ${physicalId}${groupName ? ` (group: ${groupName})` : ''}`
    );

    try {
      // UpdateSchedule is a full-replace API: unspecified fields reset to
      // their defaults, so always send the complete desired configuration.
      const input: UpdateScheduleCommandInput = {
        Name: physicalId,
        ...(groupName && { GroupName: groupName }),
        ...this.toSdkFields(properties),
      };
      const response = await this.getClient().send(new UpdateScheduleCommand(input));

      return {
        physicalId,
        wasReplaced: false,
        attributes: { Arn: response.ScheduleArn ?? '' },
      };
    } catch (error) {
      if (error instanceof ResourceUpdateNotSupportedError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Schedule ${logicalId}: ${cause?.message ?? String(error)}`,
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
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    const groupName = this.groupNameOf(properties);

    this.logger.debug(
      `Deleting Schedule ${logicalId}: ${physicalId}${groupName ? ` (group: ${groupName})` : ''}`
    );

    try {
      await this.getClient().send(
        new DeleteScheduleCommand({
          Name: physicalId,
          ...(groupName && { GroupName: groupName }),
        })
      );
      this.logger.debug(`Deleted Schedule ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Schedule ${logicalId} already deleted (not found), treating as success`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Schedule ${logicalId}: ${cause?.message ?? String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Attribute fallback. `Arn` is cached in state at create/update time, so
   * this only fires for imported/degraded records. A bare schedule name
   * cannot be resolved to its group here (no properties in this signature),
   * so the lookup tries the default group and fails with an actionable
   * message for custom-group schedules.
   */
  async getAttribute(
    physicalId: string,
    resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName !== 'Arn') {
      throw new ProvisioningError(
        `Unknown attribute ${attributeName} for ${resourceType}`,
        resourceType,
        physicalId
      );
    }
    try {
      const response = await this.getClient().send(new GetScheduleCommand({ Name: physicalId }));
      return response.Arn;
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to resolve Arn for Schedule ${physicalId}: ${cause?.message ?? String(error)}. ` +
          `Schedules in a custom group cannot be looked up by bare name; the Arn is normally served from cdkd state attributes.`,
        resourceType,
        physicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Drift read-back. `properties` carries the state-recorded GroupName, so
   * custom-group schedules are addressable here (unlike getAttribute).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    const groupName = this.groupNameOf(properties);
    try {
      const response = await this.getClient().send(
        new GetScheduleCommand({
          Name: physicalId,
          ...(groupName && { GroupName: groupName }),
        })
      );
      return {
        Name: response.Name,
        ...(response.GroupName !== undefined &&
          response.GroupName !== 'default' && { GroupName: response.GroupName }),
        ...(response.Description !== undefined && { Description: response.Description }),
        ...(response.ScheduleExpression !== undefined && {
          ScheduleExpression: response.ScheduleExpression,
        }),
        ...(response.ScheduleExpressionTimezone !== undefined && {
          ScheduleExpressionTimezone: response.ScheduleExpressionTimezone,
        }),
        ...(response.StartDate !== undefined && {
          StartDate: response.StartDate.toISOString(),
        }),
        ...(response.EndDate !== undefined && { EndDate: response.EndDate.toISOString() }),
        ...(response.State !== undefined && { State: response.State }),
        ...(response.KmsKeyArn !== undefined && { KmsKeyArn: response.KmsKeyArn }),
        ...(response.FlexibleTimeWindow !== undefined && {
          FlexibleTimeWindow: response.FlexibleTimeWindow,
        }),
        ...(response.Target !== undefined && { Target: response.Target }),
      };
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        return undefined; // drift unknown — resource gone
      }
      throw error;
    }
  }

  /**
   * Import by explicit physical id (`--resource <logicalId>=<name>` or the
   * template's `Name` property). The schedule's group is read from the
   * template properties, so custom-group schedules import correctly.
   *
   * No tag-based auto-lookup: EventBridge Scheduler schedules do not
   * support resource tags, so there is no `aws:cdk:path` to match.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'Name');
    if (!explicit) return null;

    const groupName = this.groupNameOf(input.properties);
    try {
      const response = await this.getClient().send(
        new GetScheduleCommand({
          Name: explicit,
          ...(groupName && { GroupName: groupName }),
        })
      );
      return {
        physicalId: explicit,
        attributes: { Arn: response.Arn ?? '' },
      };
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return null;
      throw error;
    }
  }
}
