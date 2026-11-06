import {
  GlueClient,
  CreateTriggerCommand,
  UpdateTriggerCommand,
  DeleteTriggerCommand,
  GetTriggerCommand,
  StartTriggerCommand,
  StopTriggerCommand,
  EntityNotFoundException,
  type TriggerUpdate,
  type Action as TriggerAction,
  type Predicate,
  type Condition as TriggerCondition,
  type EventBatchingCondition,
} from '@aws-sdk/client-glue';
import { STSClient } from '@aws-sdk/client-sts';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { isRefusedByName, markDeleteStarted } from '../../delete-started.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import type { MaskerFn } from '../../masked-retry-logger.js';
import {
  type CreateContext,
  type ResourceCreateResult,
  type ResourceUpdateResult,
  type ResourceImportInput,
  type ResourceImportResult,
  type UpdateContext,
  type ResourceNotFound,
  RESOURCE_NOT_FOUND,
} from '../../../types/resource.js';
import { ambientClientDefaults } from '../../../utils/ambient-client-defaults.js';
import { markNotGone } from '../../not-gone.js';
import { generatedNameFor } from '../../resource-name.js';
import type { GlueTriggerProvider } from '../glue-provider.js';
import {
  wrapGlueError,
  newGlueClients,
  glueOperationSinks,
  secretNamePairs,
  previousNamePairs,
} from './names.js';
import {
  desiredGlueTags,
  applyGlueTagDiff,
  TRIGGER_DEACTIVATE_MAX_ATTEMPTS,
  sleep,
  TRIGGER_DEACTIVATE_POLL_INTERVAL_MS,
  pickDefined,
  fetchGlueTags,
  buildGlueResourceArn,
} from './shared.js';

/**
 * go-to-k/cdkd#5487: the top-level keys `UpdateTrigger`'s `TriggerUpdate`
 * carries, each marked unsettled before the call when it changes.
 */
const TRIGGER_UPDATE_KEYS = [
  'Description',
  'Schedule',
  'Actions',
  'Predicate',
  'EventBatchingCondition',
] as const;

/** {@link GlueProvider}'s `wrapMaskedError` (issue #4244). */
export function triggerWrapMaskedError(
  this: GlueTriggerProvider,
  mask: MaskerFn,
  error: unknown,
  build: (maskedText: string) => ProvisioningError
): ProvisioningError {
  return wrapGlueError(mask, (message) => this.logger.debug(message), error, build);
}

export function triggerGetClient(this: GlueTriggerProvider): GlueClient {
  if (!this.client) {
    ({ client: this.client, createClient: this.createClient } = newGlueClients(
      this.providerRegion
    ));
  }
  return this.client;
}

/** The main create's client (issue #4639); see {@link newGlueClients}. */
export function triggerGetCreateClient(this: GlueTriggerProvider): GlueClient {
  this.getClient();
  return this.createClient as GlueClient;
}

export function triggerGetStsClient(this: GlueTriggerProvider): STSClient {
  if (!this.stsClient) {
    this.stsClient = new STSClient({
      ...ambientClientDefaults(),
      ...(this.providerRegion ? { region: this.providerRegion } : {}),
    });
  }
  return this.stsClient;
}

export async function triggerCreate(
  this: GlueTriggerProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  // Issue #2177: ONE masked sink per operation, every bag value masked RAW.
  const log = glueOperationSinks(
    this.logger,
    context?.maskSecrets,
    secretNamePairs([properties['Name']])
  );
  const { value: v } = log;
  log.debug(`Creating Glue Trigger ${logicalId}`);
  // go-to-k/cdkd#5095, as the Glue job's create.
  const name =
    (properties['Name'] as string | undefined) ?? generatedNameFor('AWS::Glue::Trigger', logicalId);
  const type = properties['Type'] as string | undefined;
  const actions = properties['Actions'] as TriggerAction[] | undefined;
  if (!type) {
    throw new ProvisioningError(
      `Type is required for Glue Trigger ${logicalId}`,
      resourceType,
      logicalId
    );
  }
  if (!actions) {
    throw new ProvisioningError(
      `Actions is required for Glue Trigger ${logicalId}`,
      resourceType,
      logicalId
    );
  }
  // go-to-k/cdkd#4073: a malformed Tags is refused before any call.
  const tags = desiredGlueTags(properties['Tags'], resourceType, logicalId);
  try {
    await this.getCreateClient().send(
      new CreateTriggerCommand({
        Name: name,
        Type: type as 'SCHEDULED' | 'CONDITIONAL' | 'ON_DEMAND' | 'EVENT',
        Actions: actions,
        ...(properties['Schedule'] !== undefined && {
          Schedule: properties['Schedule'] as string,
        }),
        ...(properties['Predicate'] !== undefined && {
          Predicate: properties['Predicate'] as Predicate,
        }),
        ...(properties['Description'] !== undefined && {
          Description: properties['Description'] as string,
        }),
        ...(properties['StartOnCreation'] !== undefined && {
          StartOnCreation: properties['StartOnCreation'] as boolean,
        }),
        ...(properties['WorkflowName'] !== undefined && {
          WorkflowName: properties['WorkflowName'] as string,
        }),
        ...(properties['EventBatchingCondition'] !== undefined && {
          EventBatchingCondition: properties['EventBatchingCondition'] as EventBatchingCondition,
        }),
        ...(tags && { Tags: tags }),
      })
    );
    log.debug(`Successfully created Glue Trigger ${logicalId}: ${v(name)}`);
    return { physicalId: name, attributes: {} };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create Glue Trigger ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

export async function triggerUpdate(
  this: GlueTriggerProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // Issue #2177 -- the recorded name is a needle too after a rotated secret.
  const log = glueOperationSinks(
    this.logger,
    context?.maskSecrets,
    previousNamePairs(physicalId, [previousProperties?.['Name']])
  );
  const { value: v } = log;
  log.debug(`Updating Glue Trigger ${logicalId}: ${v(physicalId)}`);
  // go-to-k/cdkd#4073: a malformed desired Tags is refused before any call,
  // so a doomed update never deactivates the trigger.
  desiredGlueTags(properties['Tags'], resourceType, logicalId, physicalId);
  const markUnsettled = (key: string): void => context?.markUnsettled?.(key);
  try {
    // Glue requires the trigger be DEACTIVATED before UpdateTrigger. Read the
    // current state to decide whether we need to stop+restart.
    let restart = false;
    try {
      const cur = await this.getClient().send(new GetTriggerCommand({ Name: physicalId }));
      if (cur.Trigger?.State === 'ACTIVATED') {
        restart = true;
        await this.getClient().send(new StopTriggerCommand({ Name: physicalId }));
        // StopTrigger is async — UpdateTrigger fails if the trigger has not
        // yet transitioned out of ACTIVATED, so wait for DEACTIVATED first.
        await this.waitForTriggerDeactivated(physicalId);
      }
    } catch (err) {
      // If GetTrigger fails for any reason other than NotFound, fall
      // through and let UpdateTrigger surface a clear AWS error.
      if (!(err instanceof EntityNotFoundException)) {
        log.debug(
          `GetTrigger pre-check failed for ${v(physicalId)}; continuing anyway: ${
            describeAwsFailure(err).detail
          }`
        );
      }
    }

    // A full replace: a field left out here is CLEARED on AWS, which is how a
    // property removed from the template is reset, as CloudFormation does for
    // Description and EventBatchingCondition (issue #1160). Never fill an
    // absent field from `previousProperties`.
    const update: TriggerUpdate = {
      ...(properties['Description'] !== undefined && {
        Description: properties['Description'] as string,
      }),
      ...(properties['Schedule'] !== undefined && {
        Schedule: properties['Schedule'] as string,
      }),
      ...(properties['Actions'] !== undefined && {
        Actions: properties['Actions'] as TriggerAction[],
      }),
      ...(properties['Predicate'] !== undefined && {
        Predicate: properties['Predicate'] as Predicate,
      }),
      ...(properties['EventBatchingCondition'] !== undefined && {
        EventBatchingCondition: properties['EventBatchingCondition'] as EventBatchingCondition,
      }),
    };
    // Restore the ACTIVATED state even if UpdateTrigger throws — otherwise a
    // failed update would leave a previously-running trigger stuck
    // DEACTIVATED. Capture the update error rather than using `finally` so
    // that if BOTH the update and the re-activation throw, the root-cause
    // update error wins (a bare `finally` would let the secondary
    // "failed to re-activate" error mask it). A re-activation failure on an
    // OTHERWISE-successful update still surfaces (the trigger really is stuck
    // deactivated in that case).
    let updateError: unknown;
    for (const key of TRIGGER_UPDATE_KEYS) {
      if (JSON.stringify(properties[key]) !== JSON.stringify(previousProperties[key])) {
        markUnsettled(key);
      }
    }
    try {
      await this.getClient().send(
        new UpdateTriggerCommand({ Name: physicalId, TriggerUpdate: update })
      );
    } catch (err) {
      updateError = err;
    }
    if (restart) {
      try {
        await this.getClient().send(new StartTriggerCommand({ Name: physicalId }));
      } catch (restartError) {
        if (updateError === undefined) throw restartError;
        // The class at default level, AWS's text (which can name the
        // caller) at debug only (go-to-k/cdkd#2319).
        const restartFailure = describeAwsFailure(restartError);
        log.warn(
          `Failed to re-activate Glue Trigger ${v(physicalId)} after a failed update: ${restartFailure.summary}`
        );
        if (restartFailure.redacted) {
          log.debug(
            `Failed to re-activate Glue Trigger ${v(physicalId)} after a failed update: ${restartFailure.detail}`
          );
        }
      }
    }
    if (updateError !== undefined) throw updateError;

    await applyGlueTagDiff(
      this.getClient(),
      () => this.resourceArn(physicalId),
      previousProperties['Tags'],
      properties['Tags'],
      resourceType,
      logicalId,
      log.warn,
      {
        forceUpsert: context?.unsettledProperties?.has('Tags') === true,
        beforeWrite: () => markUnsettled('Tags'),
      }
    );

    return { physicalId, wasReplaced: false };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update Glue Trigger ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * go-to-k/cdkd#5487: while the trigger reads ACTIVATING, DEACTIVATING,
 * CREATING or UPDATING, an unsettled key other than `Tags` is still
 * changing. A failed read keeps every name, which only costs the next deploy
 * a re-send.
 */
export async function triggerUnsettledInTransition(
  this: GlueTriggerProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string,
  names: ReadonlySet<string>
): Promise<ReadonlySet<string>> {
  try {
    const state = (await this.getClient().send(new GetTriggerCommand({ Name: physicalId }))).Trigger
      ?.State;
    return state === 'ACTIVATING' ||
      state === 'DEACTIVATING' ||
      state === 'CREATING' ||
      state === 'UPDATING'
      ? new Set([...names].filter((name) => name !== 'Tags'))
      : new Set();
  } catch {
    return names;
  }
}

/**
 * Poll GetTrigger until the trigger leaves the ACTIVATED / ACTIVATING state
 * (StopTrigger is async). Returns once DEACTIVATED (or any non-active state)
 * is observed, the trigger is gone, or the attempt budget is exhausted —
 * callers then proceed with UpdateTrigger / DeleteTrigger.
 */
export async function waitForTriggerDeactivated(
  this: GlueTriggerProvider,
  physicalId: string
): Promise<void> {
  for (let attempt = 0; attempt < TRIGGER_DEACTIVATE_MAX_ATTEMPTS; attempt++) {
    try {
      const cur = await this.getClient().send(new GetTriggerCommand({ Name: physicalId }));
      const state = cur.Trigger?.State;
      if (state !== 'ACTIVATED' && state !== 'ACTIVATING') return;
    } catch (err) {
      if (err instanceof EntityNotFoundException) return;
      // Inconclusive read — keep polling until the budget is gone.
    }
    await sleep(TRIGGER_DEACTIVATE_POLL_INTERVAL_MS);
  }
}

export async function triggerDelete(
  this: GlueTriggerProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting Glue Trigger ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#2613: the physical id is a NAME, so a client in another
  // region than the state record would delete a same-named
  // trigger cdkd does not manage. Refuse before any call, not only
  // on NotFound; the client's region is resolved only when there is one
  // to compare with.
  assertRegionMatch(
    context?.expectedRegion ? await this.getClient().config.region() : undefined,
    context?.expectedRegion,
    resourceType,
    logicalId,
    physicalId,
    'pre-delete'
  );
  // go-to-k/cdkd#4946: set once a stop is sent, so a refused
  // `DeleteTrigger` is never read as a whole (still firing) survivor.
  let stripped = false;
  try {
    // An ACTIVATED scheduled / conditional trigger should be stopped before
    // deletion so a firing trigger does not race the delete.
    try {
      const cur = await this.getClient().send(new GetTriggerCommand({ Name: physicalId }));
      if (cur.Trigger?.State === 'ACTIVATED') {
        // Before the stop: its failure is swallowed below and may have landed,
        // unless AWS refused it by name (then nothing changed).
        stripped = true;
        try {
          await this.getClient().send(new StopTriggerCommand({ Name: physicalId }));
        } catch (stopError) {
          if (isRefusedByName(stopError)) stripped = false;
          throw stopError;
        }
        await this.waitForTriggerDeactivated(physicalId);
      }
    } catch (err) {
      // Pre-check is best-effort; if it fails for anything other than NotFound
      // (which DeleteTrigger handles below) let DeleteTrigger surface the error.
      if (!(err instanceof EntityNotFoundException)) {
        this.logger.debug(
          `GetTrigger pre-delete check failed for ${physicalId}; continuing: ${
            describeAwsFailure(err).detail
          }`
        );
      }
    }
    await this.getClient().send(new DeleteTriggerCommand({ Name: physicalId }));
  } catch (error) {
    if (error instanceof EntityNotFoundException) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`Glue Trigger ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const wrapped = this.wrapMaskedError(
      context?.maskSecrets ?? ((text: string) => text),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete Glue Trigger ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    // The wrap names an AWS failure by its CLASS, and the delete classifiers
    // read `NotFoundException` in a message as "already deleted": only the
    // typed not-found above means this resource is gone (go-to-k/cdkd#2319).
    const failure =
      error instanceof Error && error.name.includes('NotFound') ? markNotGone(wrapped) : wrapped;
    throw stripped ? markDeleteStarted(failure) : failure;
  }
}

// eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
export async function triggerGetAttribute(
  this: GlueTriggerProvider,
  physicalId: string,
  _resourceType: string,
  attributeName: string
): Promise<unknown> {
  if (attributeName === 'Id' || attributeName === 'Ref' || attributeName === 'Name') {
    return physicalId;
  }
  return undefined;
}

export async function triggerReadCurrentState(
  this: GlueTriggerProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let trig;
  try {
    const resp = await this.getClient().send(new GetTriggerCommand({ Name: physicalId }));
    trig = resp.Trigger;
  } catch (err) {
    if (err instanceof EntityNotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
  if (!trig) return undefined;

  // Predicate.Conditions[]: AWS preserves the array order on read; we
  // surface entries as-is since cdkd state holds the same shape.
  const result: Record<string, unknown> = {
    Name: trig.Name ?? physicalId,
    Type: trig.Type ?? '',
    Schedule: trig.Schedule ?? '',
    Description: trig.Description ?? '',
    WorkflowName: trig.WorkflowName ?? '',
    Actions: (trig.Actions ?? []).map((a) => pickDefined(a as unknown as Record<string, unknown>)),
    Predicate: trig.Predicate
      ? {
          Logical: trig.Predicate.Logical ?? '',
          Conditions: (trig.Predicate.Conditions ?? []).map((c: TriggerCondition) =>
            pickDefined(c as unknown as Record<string, unknown>)
          ),
        }
      : {},
    EventBatchingCondition: trig.EventBatchingCondition
      ? pickDefined(trig.EventBatchingCondition as unknown as Record<string, unknown>)
      : {},
  };
  result['Tags'] = await fetchGlueTags(
    this.getClient(),
    this.getStsClient(),
    'trigger',
    trig.Name ?? physicalId,
    this.cachedAccountId,
    this.logger
  );
  return result;
}

/** The trigger ARN `TagResource` / `UntagResource` target. */
export function triggerResourceArn(this: GlueTriggerProvider, physicalId: string): Promise<string> {
  return buildGlueResourceArn(
    this.getClient(),
    this.getStsClient(),
    'trigger',
    physicalId,
    this.cachedAccountId
  );
}

export async function triggerImport(
  this: GlueTriggerProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicitName = input.knownPhysicalId ?? (input.properties['Name'] as string | undefined);
  if (!explicitName) return null;
  try {
    await this.getClient().send(new GetTriggerCommand({ Name: explicitName }));
    return { physicalId: explicitName, attributes: {} };
  } catch (err) {
    if (err instanceof EntityNotFoundException) return null;
    throw err;
  }
}

export const triggerMethods = { waitForTriggerDeactivated };
