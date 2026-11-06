import {
  GlueClient,
  CreateJobCommand,
  UpdateJobCommand,
  DeleteJobCommand,
  GetJobCommand,
  EntityNotFoundException,
  type JobUpdate,
  type JobCommand as JobCommandShape,
  type ExecutionProperty,
  type NotificationProperty,
  type SourceControlDetails,
} from '@aws-sdk/client-glue';
import { STSClient } from '@aws-sdk/client-sts';
import { ProvisioningError } from '../../../utils/error-handler.js';
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
import type { GlueJobProvider } from '../glue-provider.js';
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
  pickDefined,
  fetchGlueTags,
  buildGlueResourceArn,
  coerceNumber,
  asRecord,
} from './shared.js';

/** {@link GlueProvider}'s `wrapMaskedError` (issue #4244). */
export function jobWrapMaskedError(
  this: GlueJobProvider,
  mask: MaskerFn,
  error: unknown,
  build: (maskedText: string) => ProvisioningError
): ProvisioningError {
  return wrapGlueError(mask, (message) => this.logger.debug(message), error, build);
}

export function jobGetClient(this: GlueJobProvider): GlueClient {
  if (!this.client) {
    ({ client: this.client, createClient: this.createClient } = newGlueClients(
      this.providerRegion
    ));
  }
  return this.client;
}

/** The main create's client (issue #4639); see {@link newGlueClients}. */
export function jobGetCreateClient(this: GlueJobProvider): GlueClient {
  this.getClient();
  return this.createClient as GlueClient;
}

export function jobGetStsClient(this: GlueJobProvider): STSClient {
  if (!this.stsClient) {
    this.stsClient = new STSClient({
      ...ambientClientDefaults(),
      ...(this.providerRegion ? { region: this.providerRegion } : {}),
    });
  }
  return this.stsClient;
}

export async function jobCreate(
  this: GlueJobProvider,
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
  log.debug(`Creating Glue Job ${logicalId}`);
  // go-to-k/cdkd#5095: a stack with an instance id generates the name; a
  // legacy stack keeps the bare logical id.
  const name =
    (properties['Name'] as string | undefined) ?? generatedNameFor('AWS::Glue::Job', logicalId);
  const role = properties['Role'] as string | undefined;
  const command = properties['Command'] as Record<string, unknown> | undefined;
  if (!role) {
    throw new ProvisioningError(
      `Role is required for Glue Job ${logicalId}`,
      resourceType,
      logicalId
    );
  }
  if (!command) {
    throw new ProvisioningError(
      `Command is required for Glue Job ${logicalId}`,
      resourceType,
      logicalId
    );
  }
  // go-to-k/cdkd#4073: a malformed Tags is refused before any call.
  const tags = desiredGlueTags(properties['Tags'], resourceType, logicalId);
  try {
    await this.getCreateClient().send(
      new CreateJobCommand({
        Name: name,
        Role: role,
        Command: buildJobCommand(command),
        ...buildJobCommonFields(properties),
        ...(tags && { Tags: tags }),
      })
    );
    log.debug(`Successfully created Glue Job ${logicalId}: ${v(name)}`);
    return { physicalId: name, attributes: {} };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create Glue Job ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

export async function jobUpdate(
  this: GlueJobProvider,
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
  log.debug(`Updating Glue Job ${logicalId}: ${v(physicalId)}`);
  // go-to-k/cdkd#4073: a malformed desired Tags is refused before any call.
  desiredGlueTags(properties['Tags'], resourceType, logicalId, physicalId);
  try {
    const command = properties['Command'] as Record<string, unknown> | undefined;
    const update: JobUpdate = {
      ...(command !== undefined && { Command: buildJobCommand(command) }),
      ...buildJobCommonFields(properties),
      // Role is required at create but mutable on update; include only when defined
      ...(properties['Role'] !== undefined && { Role: properties['Role'] as string }),
    };
    await this.getClient().send(new UpdateJobCommand({ JobName: physicalId, JobUpdate: update }));

    // Tags are not part of JobUpdate; reconcile via TagResource diff if tags changed.
    await applyGlueTagDiff(
      this.getClient(),
      () => this.resourceArn(physicalId),
      previousProperties['Tags'],
      properties['Tags'],
      resourceType,
      logicalId,
      log.warn
    );

    return { physicalId, wasReplaced: false };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update Glue Job ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

export async function jobDelete(
  this: GlueJobProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting Glue Job ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#2613: the physical id is a NAME, so a client in another
  // region than the state record would delete a same-named
  // job cdkd does not manage. Refuse before any call, not only
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
  try {
    await this.getClient().send(new DeleteJobCommand({ JobName: physicalId }));
  } catch (error) {
    if (error instanceof EntityNotFoundException) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`Glue Job ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapMaskedError(
      context?.maskSecrets ?? ((text: string) => text),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete Glue Job ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    // The wrap names an AWS failure by its CLASS, and the delete classifiers
    // read `NotFoundException` in a message as "already deleted": only the
    // typed not-found above means this resource is gone (go-to-k/cdkd#2319).
    throw error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
  }
}

// eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
export async function jobGetAttribute(
  this: GlueJobProvider,
  physicalId: string,
  _resourceType: string,
  attributeName: string
): Promise<unknown> {
  if (attributeName === 'Id' || attributeName === 'Ref' || attributeName === 'Name') {
    return physicalId;
  }
  return undefined;
}

/**
 * Read the AWS-current Glue Job in CFn-property shape.
 *
 * Always-emit placeholders for user-controllable top-level keys per
 * PR #145 (`?? '' | [] | {}`) so the v3 `observedProperties` baseline
 * detects console-side ADDs to fields that weren't templated. Tags
 * always emit `[]` (PR H pattern).
 */
export async function jobReadCurrentState(
  this: GlueJobProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let job;
  try {
    const resp = await this.getClient().send(new GetJobCommand({ JobName: physicalId }));
    job = resp.Job;
  } catch (err) {
    if (err instanceof EntityNotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
  if (!job) return undefined;

  const result: Record<string, unknown> = {
    Name: job.Name ?? physicalId,
    Role: job.Role ?? '',
    Command: pickDefined({
      Name: job.Command?.Name,
      ScriptLocation: job.Command?.ScriptLocation,
      PythonVersion: job.Command?.PythonVersion,
      Runtime: job.Command?.Runtime,
    }),
    Description: job.Description ?? '',
    LogUri: job.LogUri ?? '',
    DefaultArguments: job.DefaultArguments ?? {},
    NonOverridableArguments: job.NonOverridableArguments ?? {},
    Connections: { Connections: job.Connections?.Connections ?? [] },
    MaxRetries: job.MaxRetries ?? 0,
    Timeout: job.Timeout ?? 0,
    ExecutionProperty: { MaxConcurrentRuns: job.ExecutionProperty?.MaxConcurrentRuns ?? 1 },
    NotificationProperty: { NotifyDelayAfter: job.NotificationProperty?.NotifyDelayAfter ?? 0 },
    GlueVersion: job.GlueVersion ?? '',
    NumberOfWorkers: job.NumberOfWorkers ?? 0,
    WorkerType: job.WorkerType ?? '',
    MaxCapacity: job.MaxCapacity ?? 0,
    AllocatedCapacity: job.AllocatedCapacity ?? 0,
    SecurityConfiguration: job.SecurityConfiguration ?? '',
    ExecutionClass: job.ExecutionClass ?? '',
    JobMode: job.JobMode ?? '',
    JobRunQueuingEnabled: job.JobRunQueuingEnabled ?? false,
    MaintenanceWindow: job.MaintenanceWindow ?? '',
    SourceControlDetails: job.SourceControlDetails
      ? pickDefined(job.SourceControlDetails as Record<string, unknown>)
      : {},
  };
  result['Tags'] = await fetchGlueTags(
    this.getClient(),
    this.getStsClient(),
    'job',
    job.Name ?? physicalId,
    this.cachedAccountId,
    this.logger
  );
  return result;
}

/** The job ARN `TagResource` / `UntagResource` target. */
export function jobResourceArn(this: GlueJobProvider, physicalId: string): Promise<string> {
  return buildGlueResourceArn(
    this.getClient(),
    this.getStsClient(),
    'job',
    physicalId,
    this.cachedAccountId
  );
}

export async function jobImport(
  this: GlueJobProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicitName = input.knownPhysicalId ?? (input.properties['Name'] as string | undefined);
  if (!explicitName) return null;
  try {
    await this.getClient().send(new GetJobCommand({ JobName: explicitName }));
    return { physicalId: explicitName, attributes: {} };
  } catch (err) {
    if (err instanceof EntityNotFoundException) return null;
    throw err;
  }
}

// ─── helpers shared by GlueJobProvider ──────────────────────────────────

function buildJobCommand(c: Record<string, unknown>): JobCommandShape {
  const result: JobCommandShape = {};
  if (c['Name'] !== undefined) result.Name = c['Name'] as string;
  if (c['ScriptLocation'] !== undefined) result.ScriptLocation = c['ScriptLocation'] as string;
  if (c['PythonVersion'] !== undefined) result.PythonVersion = c['PythonVersion'] as string;
  if (c['Runtime'] !== undefined) result.Runtime = c['Runtime'] as string;
  return result;
}

/**
 * Fields shared by `CreateJob` and `UpdateJob.JobUpdate` (everything except
 * `Name` / `Role` / `Command`). Each is gated on `!== undefined` so empty
 * strings / `false` / `0` round-trip cleanly via `cdkd drift --revert`.
 */
function buildJobCommonFields(p: Record<string, unknown>): Partial<JobUpdate> {
  const r: Partial<JobUpdate> = {};
  // String pass-through props (CFn delivers these as strings and the SDK types
  // them as strings too).
  const stringPassThrough: Array<keyof JobUpdate> = [
    'JobMode',
    'JobRunQueuingEnabled',
    'Description',
    'LogUri',
    'DefaultArguments',
    'NonOverridableArguments',
    'WorkerType',
    'SecurityConfiguration',
    'GlueVersion',
    'ExecutionClass',
    'MaintenanceWindow',
  ];
  for (const k of stringPassThrough) {
    if (p[k as string] !== undefined) {
      // Cast to any: union of multiple field types, type-gated by AWS SDK at the wire layer.
      (r as Record<string, unknown>)[k as string] = p[k as string];
    }
  }
  // Numeric props: CFn delivers these as STRINGS (CDK synths e.g. "10"), but the
  // Glue SDK types them as int/double. `as number` is compile-only and does NOT
  // coerce at runtime, so the SDK would receive a string for a number-typed field.
  // Coerce at the wire boundary. See feedback_cfn_stringly_typed_numerics_need_coerce.
  const numericPassThrough: Array<keyof JobUpdate> = [
    'MaxRetries',
    'AllocatedCapacity',
    'Timeout',
    'MaxCapacity',
    'NumberOfWorkers',
  ];
  for (const k of numericPassThrough) {
    const v = p[k as string];
    if (v !== undefined) {
      (r as Record<string, unknown>)[k as string] = coerceNumber(v);
    }
  }
  if (p['ExecutionProperty'] !== undefined) {
    const ep = { ...(p['ExecutionProperty'] as Record<string, unknown>) };
    if (ep['MaxConcurrentRuns'] !== undefined) {
      ep['MaxConcurrentRuns'] = coerceNumber(ep['MaxConcurrentRuns']);
    }
    r.ExecutionProperty = ep as ExecutionProperty;
  }
  if (p['Connections'] !== undefined) {
    const conn = p['Connections'] as Record<string, unknown>;
    r.Connections = { Connections: (conn['Connections'] as string[] | undefined) ?? [] };
  }
  if (p['NotificationProperty'] !== undefined) {
    const np = { ...(p['NotificationProperty'] as Record<string, unknown>) };
    if (np['NotifyDelayAfter'] !== undefined) {
      np['NotifyDelayAfter'] = coerceNumber(np['NotifyDelayAfter']);
    }
    r.NotificationProperty = np as NotificationProperty;
  }
  if (p['SourceControlDetails'] !== undefined) {
    r.SourceControlDetails = p['SourceControlDetails'] as SourceControlDetails;
  }
  return r;
}

/**
 * CFn `Parameters` map -> the SDK's `Record<string, string>`. CDK may deliver
 * booleans / numbers; the SDK member is string-valued.
 */
export function stringifyParameterValues(raw: unknown): Record<string, string> {
  const params: Record<string, string> = {};
  // A non-object (a string / array / unresolved intrinsic) must contribute NO
  // keys: `Object.entries('s3://x')` yields {'0':'s','1':'3',...}, which would
  // be written to AWS as a real map. Same refusal as `parameterKeySet` /
  // `asRecord` (the #1471 convention).
  const source = asRecord(raw);
  if (source === undefined) return params;
  for (const [k, v] of Object.entries(source)) {
    params[k] = String(v);
  }
  return params;
}

/**
 * Key set of a CFn-side `Parameters` map, for
 * {@link GlueProvider.preserveAwsManagedParameters}.
 *
 * A non-object (absent, or an unresolved intrinsic) contributes NO keys — so
 * a template that declares no `Parameters` at all can never be mistaken for
 * one that removed a key, and every live key stays preserved.
 */
export function parameterKeySet(value: unknown): Set<string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return new Set<string>();
  }
  return new Set(Object.keys(value as Record<string, unknown>));
}
