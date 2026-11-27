import { CreateResourceCommand, DeleteResourceCommand } from '@aws-sdk/client-cloudcontrol';
import type { ProgressEvent } from '@aws-sdk/client-cloudcontrol';
import type { CloudControlProvider } from '../cloud-control-provider.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { displaySafe } from '../../utils/display-safe.js';
import { markNonRetryable } from '../../deployment/retryable-errors.js';
import type { IdLogSink } from './id-log.js';

/**
 * go-to-k/cdkd#7121: an `AWS::LakeFormation::Resource` moving from the
 * service-linked role (`UseServiceLinkedRole: true`) to its own `RoleArn`.
 *
 * Lake Formation's `UpdateResource` refuses to move a registration off the
 * service-linked role ("Resource managed by Service Linked Role", measured),
 * and Cloud Control's update handler calls it: its read model cannot hold the
 * write-only `UseServiceLinkedRole`, so the handler never sees the switch.
 * CloudFormation applies the same change in place by calling
 * `DeregisterResource` and then `RegisterResource` with the new model
 * (CloudTrail, measured), keeping the location's ARN. cdkd does the same through
 * Cloud Control: `DeleteResource` (a deregister) and `CreateResource` with the
 * desired model (a register). Lake Formation permissions granted on the data
 * location survive the deregister (measured).
 *
 * The reverse change (its own role -> the service-linked role) needs nothing
 * here: Cloud Control's update applies it, by the same deregister + register
 * (measured), and that is also what a rollback replay of this switch sends.
 */
export const LAKE_FORMATION_RESOURCE_TYPE = 'AWS::LakeFormation::Resource';

/** The path of Lake Formation's service-linked role, `AWSServiceRoleForLakeFormationDataAccess`. */
const SERVICE_LINKED_ROLE_PATH = ':role/aws-service-role/lakeformation.amazonaws.com/';

/** The model keys a registration carries besides the role, copied back on a restore. */
const REGISTRATION_FLAGS = ['WithFederation', 'HybridAccessEnabled'] as const;

function isTrue(value: unknown): boolean {
  return value === true || value === 'true';
}

function isServiceLinkedRoleArn(value: unknown): boolean {
  return typeof value === 'string' && value.includes(SERVICE_LINKED_ROLE_PATH);
}

/**
 * Whether the template moves the registration to its own role: the desired
 * side names a role that is not the service-linked one and does not ask for
 * the service-linked role, and the role keys changed. Whether the LIVE
 * registration is on the service-linked role is read separately: that, not
 * the previous record, decides the route.
 */
export function movesToOwnRole(
  resourceType: string,
  previous: Record<string, unknown>,
  desired: Record<string, unknown>
): boolean {
  if (resourceType !== LAKE_FORMATION_RESOURCE_TYPE) return false;
  const role = desired['RoleArn'];
  if (typeof role !== 'string' || role === '' || isServiceLinkedRoleArn(role)) return false;
  if (isTrue(desired['UseServiceLinkedRole'])) return false;
  return (
    previous['RoleArn'] !== role ||
    isTrue(previous['UseServiceLinkedRole']) !== isTrue(desired['UseServiceLinkedRole'])
  );
}

/** The registration to restore when the new one fails: the service-linked role, the live flags. */
export function serviceLinkedRestoreModel(
  physicalId: string,
  live: Record<string, unknown>
): Record<string, unknown> {
  const model: Record<string, unknown> = {
    ResourceArn: typeof live['ResourceArn'] === 'string' ? live['ResourceArn'] : physicalId,
    UseServiceLinkedRole: true,
  };
  for (const key of REGISTRATION_FLAGS) {
    if (typeof live[key] === 'boolean') model[key] = live[key];
  }
  return model;
}

export interface LakeFormationRoleSwitchInput {
  logicalId: string;
  physicalId: string;
  resourceType: string;
  /** The desired properties, cleaned for Cloud Control (no nulls). */
  properties: Record<string, unknown>;
  previousProperties: Record<string, unknown>;
  log: IdLogSink;
}

/**
 * Re-register the location with its own role when the live registration is
 * on the service-linked role. Returns the create's final progress event when
 * it did (the update is then complete), or `undefined` when this update is
 * not such a switch and goes through Cloud Control's update as before.
 */
export async function switchLakeFormationOffServiceLinkedRole(
  provider: CloudControlProvider,
  input: LakeFormationRoleSwitchInput
): Promise<ProgressEvent | undefined> {
  const { logicalId, physicalId, resourceType, properties, previousProperties, log } = input;
  if (!movesToOwnRole(resourceType, previousProperties, properties)) return undefined;
  const live = await provider.readCcResourceModel(resourceType, physicalId, log);
  if (live === undefined || !isServiceLinkedRoleArn(live['RoleArn'])) return undefined;

  log.info(
    `${logicalId}: the Lake Formation location moves off the service-linked role, which Lake Formation's UpdateResource refuses; deregistering and registering it with its own role, as CloudFormation does`
  );
  await runCcOperation(provider, 'DELETE', logicalId, resourceType, () =>
    provider.cloudControlClient.send(
      new DeleteResourceCommand({ TypeName: resourceType, Identifier: physicalId })
    )
  );
  try {
    return await runCcOperation(provider, 'CREATE', logicalId, resourceType, () =>
      provider.cloudControlClient.send(
        new CreateResourceCommand({
          TypeName: resourceType,
          DesiredState: JSON.stringify(properties),
        })
      )
    );
  } catch (registerError) {
    // The location is deregistered now. Put the service-linked registration
    // back, so the record (and a rollback replay) still describes AWS.
    try {
      await runCcOperation(provider, 'CREATE', logicalId, resourceType, () =>
        provider.cloudControlClient.send(
          new CreateResourceCommand({
            TypeName: resourceType,
            DesiredState: JSON.stringify(serviceLinkedRestoreModel(physicalId, live)),
          })
        )
      );
    } catch (restoreError) {
      throw markNonRetryable(
        new ProvisioningError(
          `${logicalId}: cdkd deregistered the Lake Formation location to register it with its own role, the register failed (${displaySafe(describeAwsFailure(registerError).detail)}), and registering it back with the service-linked role failed too (${displaySafe(describeAwsFailure(restoreError).detail)}). The location is not registered with Lake Formation now: register it again (aws lakeformation register-resource --resource-arn <the location's ARN> --use-service-linked-role), then re-run the deploy.`,
          resourceType,
          logicalId,
          physicalId,
          registerError instanceof Error ? registerError : undefined
        )
      );
    }
    log.warn(
      `${logicalId}: registering the Lake Formation location with its own role failed; cdkd registered it back with the service-linked role`
    );
    throw registerError;
  }
}

async function runCcOperation(
  provider: CloudControlProvider,
  operation: 'CREATE' | 'DELETE',
  logicalId: string,
  resourceType: string,
  start: () => Promise<{ ProgressEvent?: ProgressEvent | undefined }>
): Promise<ProgressEvent> {
  const response = await start();
  const token = response.ProgressEvent?.RequestToken;
  if (token === undefined || token === '') {
    throw new ProvisioningError(
      `${operation} of ${logicalId}'s Lake Formation registration: no request token received`,
      resourceType,
      logicalId
    );
  }
  return provider.waitForOperation(token, logicalId, operation, resourceType);
}
