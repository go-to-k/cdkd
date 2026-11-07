import {
  SchedulerClient,
  type CreateScheduleCommandInput,
  type Target,
} from '@aws-sdk/client-scheduler';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { type DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  UpdateContext,
  ResourceNotFound,
} from '../../types/resource.js';
import { type MaskerFn } from '../masked-retry-logger.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import {
  wrapCaughtError,
  toSdkFields,
  toSdkTarget,
  toCfnTarget,
  renameItemKeys,
  readIdentity,
  creationDateBestEffort,
  type ScheduleIdentity,
} from './scheduler-schedule/shared.js';
import { create } from './scheduler-schedule/create.js';
import {
  wrapUnconfirmedGroupError,
  refuseUnconfirmed,
  confirmRecordedSchedule,
  referenceRepointed,
  update,
} from './scheduler-schedule/update.js';
import { deleteByRecordedIdentity, deleteImpl } from './scheduler-schedule/delete.js';
import { getAttribute, readCurrentState, importImpl } from './scheduler-schedule/read-state.js';

export {
  RECORDED_CREATION_DATE_KEY,
  NO_REGION_FOR_SCHEDULE_SEARCH_SKIP_REASON,
  AMBIGUOUS_SCHEDULE_SKIP_REASON,
} from './scheduler-schedule/shared.js';

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
 *
 * A secret-derived GroupName is recorded as its `{{resolve:...}}` reference
 * and reaches `update()` resolved, so the two never compare equal
 * (go-to-k/cdkd#4275). The schedule's identity is then the creation date
 * cdkd recorded for it ({@link RECORDED_CREATION_DATE_KEY}): the update goes
 * ahead only when the schedule the resolved group holds under this name has
 * that creation date, so a rotated secret naming another environment's
 * group is never written to.
 */
export class SchedulerScheduleProvider implements ResourceProvider {
  private client: SchedulerClient | undefined;
  private readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('SchedulerScheduleProvider');

  wrapCaughtError(
    mask: MaskerFn | undefined,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    return wrapCaughtError.call(this, mask, error, build);
  }

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

  getClient(): SchedulerClient {
    if (!this.client) {
      this.client = new SchedulerClient({
        ...ambientClientDefaults(),
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
  groupNameOf(properties: Record<string, unknown> | undefined): string | undefined {
    const group = properties?.['GroupName'];
    return typeof group === 'string' && group.length > 0 ? group : undefined;
  }

  toSdkFields(
    properties: Record<string, unknown>
  ): Omit<CreateScheduleCommandInput, 'Name' | 'GroupName' | 'ClientToken'> {
    return toSdkFields.call(this, properties);
  }

  toSdkTarget(target: Record<string, unknown>): Target {
    return toSdkTarget.call(this, target);
  }

  toCfnTarget(target: Target): Record<string, unknown> {
    return toCfnTarget.call(this, target);
  }

  renameItemKeys(
    item: Record<string, unknown>,
    keys: string[],
    direction: 'lower' | 'upper'
  ): Record<string, unknown> {
    return renameItemKeys.call(this, item, keys, direction);
  }

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  readIdentity(name: string, groupName: string | undefined): Promise<ScheduleIdentity> {
    return readIdentity.call(this, name, groupName);
  }

  /** The one wait this provider makes (a read-back retry, a re-list). */
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Waits before each re-read of {@link creationDateBestEffort}; tests shorten them. */
  readBackDelaysMs: readonly number[] = [500, 1_000];

  creationDateBestEffort(
    logicalId: string,
    name: string,
    groupName: string | undefined
  ): Promise<string | undefined> {
    return creationDateBestEffort.call(this, logicalId, name, groupName);
  }

  wrapUnconfirmedGroupError(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    error: unknown,
    mask: (text: string) => string
  ): ProvisioningError {
    return wrapUnconfirmedGroupError.call(this, logicalId, physicalId, resourceType, error, mask);
  }

  refuseUnconfirmed(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    finding: string,
    secretDerived: boolean,
    remedy: string
  ): never {
    return refuseUnconfirmed.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      finding,
      secretDerived,
      remedy
    );
  }

  confirmRecordedSchedule(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    groupName: string | undefined,
    recorded: ScheduleIdentity,
    mask: (text: string) => string
  ): Promise<'confirmed' | 'absent' | 'undated'> {
    return confirmRecordedSchedule.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      groupName,
      recorded,
      mask
    );
  }

  referenceRepointed(desiredGroup: string | undefined, recordedGroup: unknown): boolean {
    return referenceRepointed.call(this, desiredGroup, recordedGroup);
  }

  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return update.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }

  deleteByRecordedIdentity(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    recorded: ScheduleIdentity,
    context: DeleteContext | undefined
  ): Promise<void | ResourceDeleteResult> {
    return deleteByRecordedIdentity.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      recorded,
      context
    );
  }

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  getAttribute(
    physicalId: string,
    resourceType: string,
    attributeName: string,
    logicalId: string
  ): Promise<unknown> {
    return getAttribute.call(this, physicalId, resourceType, attributeName, logicalId);
  }

  readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, _resourceType, properties);
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }
}
