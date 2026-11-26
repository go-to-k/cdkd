/**
 * `AWS::EC2::Instance` `EbsOptimized` update planning (go-to-k/cdkd#7023),
 * kept beside `instance-update.ts`, whose `planInstanceMemberUpdates` calls it.
 */
import { ProvisioningError } from '../../../utils/error-handler.js';
import { coerceCfnBoolean, configBooleanRefusal } from '../../config-shape.js';
import type { UpdateContext } from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { type InstanceMemberPlan, refusedBeforeApplying } from './instance-support.js';
import type { EC2Provider } from '../ec2-provider.js';

/**
 * go-to-k/cdkd#7023: plan an `EbsOptimized` change. EC2 changes it only on a
 * stopped instance, and CloudFormation applies it in place with a stop and a
 * start (measured us-east-1, 2026-11-26, a t3.micro: unset -> `true` kept the
 * instance and moved its launch time), so it goes out in the stop -> modify ->
 * start window an InstanceType change takes; `prepareInstanceMemberUpdates`
 * drops it when the instance already has the value.
 *
 * true -> false and false -> true are in place too. A REMOVAL fails the
 * CloudFormation update ("No attributes specified", measured the same day), so
 * a forward update refuses it before any call, as `InstanceType`'s; a rollback
 * revert keeps the live value and warns.
 */
export function planInstanceEbsOptimized(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context: UpdateContext | undefined,
  plan: InstanceMemberPlan,
  changed: (key: string, same: (a: unknown, b: unknown) => boolean) => boolean,
  standInSkips: (key: string) => boolean
): void {
  const key = 'EbsOptimized';
  // Two readable booleans compare by value ('true' is true); an unreadable
  // side never equals anything, so it reaches the refusal below.
  const same = (a: unknown, b: unknown): boolean => {
    const x = coerceCfnBoolean(a);
    return x !== undefined && x === coerceCfnBoolean(b);
  };
  if (!changed(key, same)) return;
  const raw = properties[key];
  if (raw === undefined) {
    if (context?.replayingState === true) {
      this.logger.warn(
        safeMsg`${logicalId} (${resourceType}): the state being restored does not declare ${key}; the rollback leaves it at its current AWS value.`
      );
      return;
    }
    throw refusedBeforeApplying(
      new ProvisioningError(
        safeMsg`${logicalId} (${resourceType}): ${key} was removed from the template, and CloudFormation fails that update for an existing instance. Keep it declared (set it to false to turn EBS optimization off). The instance was not updated.`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }
  // A recorded stand-in ({{resolve:...}} or the mask) gets the shared
  // refusal / rollback warning every other member gives it.
  if (standInSkips(key)) return;
  const want = coerceCfnBoolean(raw);
  if (want === undefined) {
    const refusal = configBooleanRefusal(properties, key, resourceType);
    if (context?.replayingState === true || context?.desiredFromAwsReadback === true) {
      this.logger.warn(
        safeMsg`${logicalId} (${resourceType}): ${refusal ?? `${key} is not a boolean`}; it is left at its current AWS value.`
      );
      return;
    }
    throw refusedBeforeApplying(
      new ProvisioningError(
        `${refusal ?? `${resourceType}.${key} must be a boolean`}. The instance ${logicalId} was not updated.`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }
  plan.ebsOptimized = want;
}

/** The {@link EC2Provider} methods this module defines. */
export const instanceEbsOptimizedMethods = {
  planInstanceEbsOptimized,
};
