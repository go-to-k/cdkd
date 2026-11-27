import {
  CreateResourceCommand,
  DeleteResourceCommand,
  GetResourceCommand,
} from '@aws-sdk/client-cloudcontrol';
import type { ProgressEvent } from '@aws-sdk/client-cloudcontrol';
import type { CloudControlProvider } from '../cloud-control-provider.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { displaySafe } from '../../utils/display-safe.js';
import { markNonRetryable } from '../../deployment/retryable-errors.js';
import type { IdLogSink } from './id-log.js';
import { maskCallerIdentity } from './caller-identity.js';

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

/** The live registration's model, `'gone'` when Cloud Control says NotFound, `undefined` when unreadable. */
async function readLiveRegistration(
  provider: CloudControlProvider,
  resourceType: string,
  physicalId: string,
  log: IdLogSink
): Promise<Record<string, unknown> | 'gone' | undefined> {
  try {
    const response = await provider.cloudControlClient.send(
      new GetResourceCommand({ TypeName: resourceType, Identifier: physicalId })
    );
    const raw = response.ResourceDescription?.Properties;
    if (typeof raw !== 'string' || raw === '') return undefined;
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch (error) {
    if ((error as { name?: unknown } | undefined)?.name === 'ResourceNotFoundException') {
      return 'gone';
    }
    log.debug(
      `Could not read the Lake Formation registration: ${maskCallerIdentity(displaySafe(describeAwsFailure(error).detail))}`
    );
    return undefined;
  }
}

const failureText = (error: unknown): string =>
  maskCallerIdentity(displaySafe(describeAwsFailure(error).detail));

function createRegistration(
  provider: CloudControlProvider,
  logicalId: string,
  resourceType: string,
  model: Record<string, unknown>
): Promise<ProgressEvent> {
  return runCcOperation(provider, 'CREATE', logicalId, resourceType, () =>
    provider.cloudControlClient.send(
      new CreateResourceCommand({ TypeName: resourceType, DesiredState: JSON.stringify(model) })
    )
  );
}

/**
 * Re-register the location with its own role when the live registration is
 * on the service-linked role. Returns the create's final progress event when
 * it did (it takes the update's place), or `undefined` when this update is
 * not such a switch and goes through Cloud Control's update as before.
 *
 * Every update of a registration first reads it. A location Cloud Control
 * reports NotFound (a deploy stopped between this switch's deregister and its
 * register, or a deregister outside cdkd) is registered with the desired
 * model, whichever direction the update goes, instead of failing that update
 * and every later one on NotFound. A deploy whose template holds no change for
 * the registration sends no update, so it cannot see a missing one.
 */
export async function switchLakeFormationOffServiceLinkedRole(
  provider: CloudControlProvider,
  input: LakeFormationRoleSwitchInput
): Promise<ProgressEvent | undefined> {
  const { logicalId, physicalId, resourceType, properties, previousProperties, log } = input;
  if (resourceType !== LAKE_FORMATION_RESOURCE_TYPE) return undefined;
  // Its own GetResource, not the update's shared live-model read: this one
  // must tell NotFound apart from an unreadable model. One call per update of
  // this type only.
  const live = await readLiveRegistration(provider, resourceType, physicalId, log);
  if (live === 'gone') {
    log.warn(
      `${logicalId}: the Lake Formation location is not registered with Lake Formation; registering it with the template's model instead of updating it`
    );
    return createRegistration(provider, logicalId, resourceType, properties);
  }
  if (!movesToOwnRole(resourceType, previousProperties, properties)) return undefined;
  if (live === undefined || !isServiceLinkedRoleArn(live['RoleArn'])) return undefined;

  log.info(
    `${logicalId}: the Lake Formation location moves off the service-linked role, which Lake Formation's UpdateResource refuses; deregistering and registering it with its own role, as CloudFormation does`
  );
  await runCcOperation(provider, 'DELETE', logicalId, resourceType, () =>
    provider.cloudControlClient.send(
      new DeleteResourceCommand({ TypeName: resourceType, Identifier: physicalId })
    )
  );
  // No IAM propagation wait before the register: a role created moments
  // earlier in the same deploy registers at once (measured: RegisterResource
  // right after CreateRole, and through Cloud Control's create, 6 of 6).
  try {
    return await createRegistration(provider, logicalId, resourceType, properties);
  } catch (registerError) {
    // The location is deregistered now. Put the service-linked registration
    // back, so the record (and a rollback replay) still describes AWS.
    try {
      await createRegistration(
        provider,
        logicalId,
        resourceType,
        serviceLinkedRestoreModel(physicalId, live)
      );
    } catch (restoreError) {
      // A create whose wait failed may still have registered the location
      // (the restore then fails on AlreadyExists): say what AWS holds now.
      const after = await readLiveRegistration(provider, resourceType, physicalId, log);
      const now =
        after === 'gone'
          ? "The location is not registered with Lake Formation now: register it again (aws lakeformation register-resource --resource-arn <the location's ARN> --use-service-linked-role), then re-run the deploy."
          : after === undefined
            ? "cdkd could not read whether the location is registered now: check it (aws lakeformation describe-resource --resource-arn <the location's ARN>), then re-run the deploy."
            : `The location is registered with ${isServiceLinkedRoleArn(after['RoleArn']) ? 'the service-linked role' : 'its own role'} now; re-run the deploy.`;
      throw markNonRetryable(
        new ProvisioningError(
          `${logicalId}: cdkd deregistered the Lake Formation location to register it with its own role, the register failed (${failureText(registerError)}), and registering it back with the service-linked role failed too (${failureText(restoreError)}). ${now}`,
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
