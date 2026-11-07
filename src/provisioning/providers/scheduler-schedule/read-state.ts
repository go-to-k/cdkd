import type { SchedulerScheduleProvider } from '../scheduler-schedule-provider.js';
import { GetScheduleCommand, ResourceNotFoundException } from '@aws-sdk/client-scheduler';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { resolveExplicitPhysicalId } from '../../import-helpers.js';
import type {
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { RECORDED_CREATION_DATE_KEY } from './shared.js';

/**
 * Attribute fallback. `Arn` is cached in state at create/update time, so
 * this only fires for imported/degraded records. A bare schedule name
 * cannot be resolved to its group here (no properties in this signature),
 * so the lookup tries the default group and fails with an actionable
 * message for custom-group schedules.
 */
export async function getAttribute(
  this: SchedulerScheduleProvider,
  physicalId: string,
  resourceType: string,
  attributeName: string,
  logicalId: string
): Promise<unknown> {
  if (attributeName !== 'Arn') {
    throw new ProvisioningError(
      `Unknown attribute ${attributeName} for ${resourceType}`,
      resourceType,
      logicalId,
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
    throw this.wrapCaughtError(
      undefined,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to resolve Arn for Schedule ${physicalId}: ${text}${text.endsWith('.') ? '' : '.'}${customGroupHint}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * Drift read-back. `properties` carries the state-recorded GroupName, so
 * custom-group schedules are addressable here (unlike getAttribute).
 */
export async function readCurrentState(
  this: SchedulerScheduleProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
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
      return RESOURCE_NOT_FOUND;
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
export async function importImpl(
  this: SchedulerScheduleProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
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
      // The creation date too, as create() records it (go-to-k/cdkd#4275): a
      // re-import replaces the recorded attributes.
      attributes: {
        ...(response.Arn && { Arn: response.Arn }),
        ...(response.CreationDate instanceof Date &&
          !Number.isNaN(response.CreationDate.getTime()) && {
            [RECORDED_CREATION_DATE_KEY]: response.CreationDate.toISOString(),
          }),
      },
    };
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return null;
    throw error;
  }
}
