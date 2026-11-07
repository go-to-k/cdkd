import type { SchedulerScheduleProvider } from '../scheduler-schedule-provider.js';
import { CreateScheduleCommand } from '@aws-sdk/client-scheduler';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { generatedNameFor } from '../../resource-name.js';
import type { CreateContext, ResourceCreateResult } from '../../../types/resource.js';
import { RECORDED_CREATION_DATE_KEY } from './shared.js';

export async function create(
  this: SchedulerScheduleProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  // Schedule names: <= 64 chars, ^[0-9a-zA-Z-_.]+$ — generateResourceName's
  // stack-prefixed output satisfies both.
  const name =
    (properties['Name'] as string | undefined) ??
    generatedNameFor('AWS::Scheduler::Schedule', logicalId);
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

    const creationDate = await this.creationDateBestEffort(logicalId, name, groupName);
    return {
      physicalId: name,
      // CFn's only GetAtt for the type. CreateSchedule always returns it in
      // practice; if it ever does not, omit the key rather than storing ''
      // (an empty string would satisfy the resolver's flat-attribute lookup
      // and shadow constructAttribute's fallback).
      attributes: {
        ...(response.ScheduleArn && { Arn: response.ScheduleArn }),
        ...(creationDate !== undefined && { [RECORDED_CREATION_DATE_KEY]: creationDate }),
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create Schedule ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}
