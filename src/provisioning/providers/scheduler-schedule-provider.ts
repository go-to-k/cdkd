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
import { awsClientDefaults } from '../../utils/aws-client-defaults.js';
import { displaySafe } from '../../utils/display-safe.js';
import { UNRENDERABLE, shellQuote } from '../../state/lock-contention-message.js';

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
 * the physicalId is stable across the migration). Because pre-existing
 * records say `provisionedBy: 'cc-api'`, the type is ALSO exempted from the
 * sticky cc-api routing rule (see STICKY_CC_MIGRATION_EXEMPT in
 * provider-registry.ts) — without the exemption the broken CC path would
 * keep serving existing schedules. GroupName is recovered from `properties`
 * on update/delete/readCurrentState — the state record carries the resolved
 * properties.
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
      this.client = new SchedulerClient({
        ...awsClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
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
   * are PascalCase-identical except `StartDate` / `EndDate` (CFn carries
   * ISO strings, the SDK types `Date`) and the Target's ECS sub-shapes
   * (camelCase islands in the SDK model — see {@link toSdkTarget},
   * issue #1382).
   */
  private toSdkFields(
    properties: Record<string, unknown>
  ): Omit<CreateScheduleCommandInput, 'Name' | 'GroupName' | 'ClientToken'> {
    return {
      ScheduleExpression: properties['ScheduleExpression'] as string,
      FlexibleTimeWindow: properties['FlexibleTimeWindow'] as FlexibleTimeWindow,
      Target: this.toSdkTarget(properties['Target'] as Record<string, unknown>),
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

  /**
   * Convert the CFn-shaped `Target` blob's ECS sub-shapes to the SDK shape
   * (issue #1382). `@aws-sdk/client-scheduler` is PascalCase except a few
   * camelCase islands the CFn schema spells PascalCase; the SDK serializer
   * silently drops unknown keys, so a Fargate target's
   * `NetworkConfiguration.AwsvpcConfiguration` never reached AWS and
   * CreateSchedule rejected with "Parameter NetworkConfiguration must be
   * specified".
   */
  private toSdkTarget(target: Record<string, unknown>): Target {
    const ecs = target['EcsParameters'] as Record<string, unknown> | undefined;
    if (!ecs) return target as unknown as Target;
    const result: Record<string, unknown> = { ...ecs };
    const network = result['NetworkConfiguration'] as Record<string, unknown> | undefined;
    if (network && network['AwsvpcConfiguration'] !== undefined) {
      const { AwsvpcConfiguration, ...restNetwork } = network;
      result['NetworkConfiguration'] = {
        ...restNetwork,
        awsvpcConfiguration: AwsvpcConfiguration,
      };
    }
    if (Array.isArray(result['PlacementStrategy'])) {
      result['PlacementStrategy'] = (result['PlacementStrategy'] as Record<string, unknown>[]).map(
        (item) => this.renameItemKeys(item, ['Type', 'Field'], 'lower')
      );
    }
    if (Array.isArray(result['PlacementConstraints'])) {
      result['PlacementConstraints'] = (
        result['PlacementConstraints'] as Record<string, unknown>[]
      ).map((item) => this.renameItemKeys(item, ['Type', 'Expression'], 'lower'));
    }
    if (Array.isArray(result['CapacityProviderStrategy'])) {
      result['CapacityProviderStrategy'] = (
        result['CapacityProviderStrategy'] as Record<string, unknown>[]
      ).map((item) => this.renameItemKeys(item, ['CapacityProvider', 'Weight', 'Base'], 'lower'));
    }
    return { ...target, EcsParameters: result } as unknown as Target;
  }

  /**
   * Inverse of {@link toSdkTarget} for `readCurrentState`: GetSchedule
   * returns the SDK spellings, but drift compares against the state's CFn
   * spellings — without the re-map every ECS Fargate schedule would report
   * phantom drift on `AwsvpcConfiguration` after deploy.
   */
  private toCfnTarget(target: Target): Record<string, unknown> {
    const raw = target as unknown as Record<string, unknown>;
    const ecs = raw['EcsParameters'] as Record<string, unknown> | undefined;
    if (!ecs) return raw;
    const result: Record<string, unknown> = { ...ecs };
    const network = result['NetworkConfiguration'] as Record<string, unknown> | undefined;
    if (network && network['awsvpcConfiguration'] !== undefined) {
      const { awsvpcConfiguration, ...restNetwork } = network;
      result['NetworkConfiguration'] = {
        ...restNetwork,
        AwsvpcConfiguration: awsvpcConfiguration,
      };
    }
    if (Array.isArray(result['PlacementStrategy'])) {
      result['PlacementStrategy'] = (result['PlacementStrategy'] as Record<string, unknown>[]).map(
        (item) => this.renameItemKeys(item, ['type', 'field'], 'upper')
      );
    }
    if (Array.isArray(result['PlacementConstraints'])) {
      result['PlacementConstraints'] = (
        result['PlacementConstraints'] as Record<string, unknown>[]
      ).map((item) => this.renameItemKeys(item, ['type', 'expression'], 'upper'));
    }
    if (Array.isArray(result['CapacityProviderStrategy'])) {
      result['CapacityProviderStrategy'] = (
        result['CapacityProviderStrategy'] as Record<string, unknown>[]
      ).map((item) => this.renameItemKeys(item, ['capacityProvider', 'weight', 'base'], 'upper'));
    }
    return { ...raw, EcsParameters: result };
  }

  /**
   * Flip the first letter's case on the listed keys of one array item
   * (`Type` <-> `type`, `CapacityProvider` <-> `capacityProvider`); keys
   * not listed (or absent) pass through unchanged.
   */
  private renameItemKeys(
    item: Record<string, unknown>,
    keys: string[],
    direction: 'lower' | 'upper'
  ): Record<string, unknown> {
    const result: Record<string, unknown> = { ...item };
    for (const key of keys) {
      if (result[key] !== undefined) {
        const flipped =
          direction === 'lower'
            ? key.charAt(0).toLowerCase() + key.slice(1)
            : key.charAt(0).toUpperCase() + key.slice(1);
        result[flipped] = result[key];
        delete result[key];
      }
    }
    return result;
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
        // CFn's only GetAtt for the type. CreateSchedule always returns it in
        // practice; if it ever does not, omit the key rather than storing ''
        // (an empty string would satisfy the resolver's flat-attribute lookup
        // and shadow constructAttribute's fallback).
        attributes: response.ScheduleArn ? { Arn: response.ScheduleArn } : {},
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
        // Issue [#2610] site 13, the twin of
        // `dlm-lifecycle-policy-provider.ts`'s: `--replace` is a BOOLEAN option
        // and `cdkd deploy` takes `[stacks...]`, so the appended logical id was
        // parsed as a STACK NAME. The head of
        // `ResourceUpdateNotSupportedError` already names the resource.
        `GroupName addresses the schedule (${previousGroupName ?? 'default'} -> ${groupName ?? 'default'}); ` +
          `re-run with \`cdkd deploy --replace\` to recreate it in the new group ` +
          `(--replace is a boolean flag and takes no resource id; it applies to every ` +
          `resource in the run whose in-place update is refused)`
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
        attributes: response.ScheduleArn ? { Arn: response.ScheduleArn } : {},
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
    if (properties === undefined) {
      // A degraded state record without properties cannot recover the group.
      // The delete below targets the DEFAULT group; a custom-group schedule
      // would then hit the NotFound-idempotent branch and be left behind —
      // surface that instead of staying silent (the #961 orphan shape).
      // The manual-recovery hint names a DELETE, which makes it the
      // highest-consequence paste in this file, and `physicalId` is a
      // `state.json` value. Same treatment as the issue [#2610] replacement
      // advice: sanitize, shell-quote, and SUPPRESS the command when
      // sanitizing changes the id, because a delete naming a sanitized name
      // would remove a DIFFERENT schedule. It was previously interpolated
      // UNQUOTED, so a name carrying a space split the arguments.
      const safeId = displaySafe(physicalId, { asciiOnly: true });
      const manualHint =
        safeId && safeId === physicalId
          ? `If the schedule lives in a custom group, delete it manually: ` +
            `aws scheduler delete-schedule --name ${shellQuote(safeId)} --group-name <group>`
          : `If the schedule lives in a custom group, delete it manually via the console: the ` +
            `name recorded for it cannot be reproduced safely on a command line.`;
      this.logger.warn(
        // `safeId`, not a second `displaySafe(physicalId, ...)` call: one
        // sanitization, one value. `|| UNRENDERABLE` matches
        // `lock-manager.ts`'s treatment of the same case -- a fully
        // unrenderable id must not render as an empty `''`, which reads as a
        // schedule with no name rather than as one that cannot be named.
        `State record for Schedule ${logicalId} carries no properties — deleting ` +
          `'${safeId || UNRENDERABLE}' from the default group. ${manualHint}`
      );
    }

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
      const customGroupHint =
        error instanceof ResourceNotFoundException
          ? ' Schedules in a custom group cannot be looked up by bare name; the Arn is normally served from cdkd state attributes.'
          : '';
      throw new ProvisioningError(
        `Failed to resolve Arn for Schedule ${physicalId}: ${cause?.message ?? String(error)}.${customGroupHint}`,
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
      // GroupName normalization: AWS reports 'default' for schedules in the
      // default group, but a template that OMITS GroupName must not drift
      // against it. When the state properties explicitly carry GroupName
      // (even 'default'), keep the read-back value so an explicit template
      // value keeps comparing.
      const stateHasGroupName = properties?.['GroupName'] !== undefined;
      return {
        Name: response.Name,
        ...(response.GroupName !== undefined &&
          (stateHasGroupName || response.GroupName !== 'default') && {
            GroupName: response.GroupName,
          }),
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
        ...(response.Target !== undefined && { Target: this.toCfnTarget(response.Target) }),
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
        // Omit Arn rather than persisting `''` when the read-back lacks it:
        // the intrinsic resolver treats any non-undefined flat attribute as
        // a hit, so an empty string would beat constructAttribute's fallback
        // and Fn::GetAtt would resolve to ''.
        attributes: response.Arn ? { Arn: response.Arn } : {},
      };
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return null;
      throw error;
    }
  }
}
