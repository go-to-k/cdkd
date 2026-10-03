import {
  PipesClient,
  CreatePipeCommand,
  UpdatePipeCommand,
  DeletePipeCommand,
  DescribePipeCommand,
  TagResourceCommand,
  UntagResourceCommand,
  NotFoundException,
  type DescribePipeCommandOutput,
  type PipeSourceParameters,
  type PipeTargetParameters,
  type PipeEnrichmentParameters,
  type PipeLogConfigurationParameters,
  type UpdatePipeCommandInput,
  type UpdatePipeSourceParameters,
} from '@aws-sdk/client-pipes';
import { RESOURCE_NOT_FOUND, type ResourceNotFound } from '../../types/resource.js';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { safeMsg } from '../../utils/display-safe.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import {
  isThrottlingError,
  isTransientServerError,
  markNonRetryable,
} from '../../deployment/retryable-errors.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { resolveExplicitPhysicalId } from '../import-helpers.js';
import { generateResourceName } from '../resource-name.js';
import { maskerOrIdentity, type MaskerFn } from '../masked-retry-logger.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { definedAttributes } from '../attribute-map.js';
import { startInterruptWatch } from '../interrupt-watch.js';
import { resolvedResourceTimeoutMs } from '../resource-timeout-registry.js';
import { waitForGoneAfterDelete } from '../delete-gone-wait.js';
import { withRemovalDefaults } from '../update-removal.js';
import {
  planTagDiff,
  refuseMalformedDesiredTags,
  tagMapAsList,
  tagPlanWarning,
} from '../tag-list.js';
import { pasteableAwsCommand } from '../replacement-protection-advice.js';
import { orphanCommandRegionArg } from './orphan-report.js';
import { unchangedBehindSecretReference } from '../secret-reference-immutable.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  UpdateContext,
} from '../../types/resource.js';

/**
 * SDK Provider for `AWS::Pipes::Pipe` (go-to-k/cdkd#4423).
 *
 * WHY AN SDK PROVIDER. Cloud Control cannot express a change to a mutable
 * member of a Kinesis / DynamoDB / MSK / self-managed Kafka / ActiveMQ /
 * RabbitMQ source's `SourceParameters` (e.g. `KinesisStreamParameters.BatchSize`):
 * `SourceParameters` is write-only, so the read handler returns none of it, and
 * any patch that brings the create-only `StartingPosition` back in is refused
 * as a create-only change while any patch without it fails model validation.
 * `UpdatePipe` takes an `UpdatePipeSource*Parameters` shape that simply has no
 * create-only member, which is what {@link toUpdateSourceParameters} builds.
 *
 * physicalId is the pipe NAME — the schema's only `primaryIdentifier`, and
 * what the Cloud Control route stored — so a record pinned to `cc-api` moves
 * here without churn (`STICKY_CC_MIGRATION_EXEMPT` in `provider-registry.ts`).
 *
 * Every create and update waits for the pipe to settle (`RUNNING` /
 * `STOPPED`), the way CloudFormation's handler does: a pipe sitting in
 * `CREATING` refuses an `UpdatePipe`, and a `*_FAILED` state is the only place
 * AWS reports a bad role or target. A delete waits until the pipe is gone,
 * since a `DELETING` pipe still holds its name.
 */

const PIPE_TYPE = 'AWS::Pipes::Pipe';

/** States a pipe rests in. */
const SETTLED_STATES: ReadonlySet<string> = new Set(['RUNNING', 'STOPPED']);

/** Poll interval for the settle and gone waits. */
const PIPE_POLL_INTERVAL_MS = 5_000;
/** The settle wait's own cap, well under the default 30-minute resource deadline. */
const PIPE_SETTLE_MAX_WAIT_MS = 15 * 60_000;
/** The delete wait's own cap. */
const PIPE_DELETE_MAX_WAIT_MS = 10 * 60_000;
/** The gone wait after deleting a pipe whose create failed: short, see `retireFailedCreate`. */
const PIPE_CLEANUP_MAX_WAIT_MS = 60_000;

/**
 * Members of each `UpdatePipeSource*Parameters` shape, per source block.
 * Every member the create-side block has and these lack is CREATE-ONLY in the
 * CFn schema (`StartingPosition`, `StartingPositionTimestamp`, `QueueName`,
 * `VirtualHost`, `TopicName`, `ConsumerGroupID`, `AdditionalBootstrapServers`),
 * and a change to one is a replacement the diff decides before `update()`.
 */
const UPDATABLE_SOURCE_MEMBERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    'KinesisStreamParameters',
    new Set([
      'BatchSize',
      'DeadLetterConfig',
      'OnPartialBatchItemFailure',
      'MaximumBatchingWindowInSeconds',
      'MaximumRecordAgeInSeconds',
      'MaximumRetryAttempts',
      'ParallelizationFactor',
    ]),
  ],
  [
    'DynamoDBStreamParameters',
    new Set([
      'BatchSize',
      'DeadLetterConfig',
      'OnPartialBatchItemFailure',
      'MaximumBatchingWindowInSeconds',
      'MaximumRecordAgeInSeconds',
      'MaximumRetryAttempts',
      'ParallelizationFactor',
    ]),
  ],
  ['SqsQueueParameters', new Set(['BatchSize', 'MaximumBatchingWindowInSeconds'])],
  [
    'ActiveMQBrokerParameters',
    new Set(['Credentials', 'BatchSize', 'MaximumBatchingWindowInSeconds']),
  ],
  [
    'RabbitMQBrokerParameters',
    new Set(['Credentials', 'BatchSize', 'MaximumBatchingWindowInSeconds']),
  ],
  [
    'ManagedStreamingKafkaParameters',
    new Set(['BatchSize', 'Credentials', 'MaximumBatchingWindowInSeconds']),
  ],
  [
    'SelfManagedKafkaParameters',
    new Set([
      'BatchSize',
      'MaximumBatchingWindowInSeconds',
      'Credentials',
      'ServerRootCaCertificate',
      'Vpc',
    ]),
  ],
]);

/**
 * The `EcsTaskParameters` members the CFn schema spells PascalCase and the
 * Pipes API spells camelCase. The SDK serializer silently drops a member it
 * does not know, so each is renamed on the way out. Enumerated mechanically
 * against `@aws-sdk/client-pipes`'s model: these are the only divergences
 * across the whole `AWS::Pipes::Pipe` property tree.
 */
function toSdkEcsTaskParameters(ecs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...ecs };
  const network = asRecord(out['NetworkConfiguration']);
  if (network && network['AwsvpcConfiguration'] !== undefined) {
    const { AwsvpcConfiguration, ...rest } = network;
    out['NetworkConfiguration'] = { ...rest, awsvpcConfiguration: AwsvpcConfiguration };
  }
  renameInList(out, 'CapacityProviderStrategy', ['CapacityProvider', 'Weight', 'Base']);
  renameInList(out, 'PlacementConstraints', ['Type', 'Expression']);
  renameInList(out, 'PlacementStrategy', ['Type', 'Field']);
  const overrides = asRecord(out['Overrides']);
  if (overrides) {
    const o: Record<string, unknown> = { ...overrides };
    if (Array.isArray(o['ContainerOverrides'])) {
      o['ContainerOverrides'] = (o['ContainerOverrides'] as unknown[]).map((item) => {
        const c = asRecord(item);
        if (!c) return item;
        const container: Record<string, unknown> = { ...c };
        renameInList(container, 'Environment', ['Name', 'Value']);
        renameInList(container, 'EnvironmentFiles', ['Type', 'Value']);
        renameInList(container, 'ResourceRequirements', ['Type', 'Value']);
        return container;
      });
    }
    const storage = asRecord(o['EphemeralStorage']);
    if (storage) o['EphemeralStorage'] = renameKeys(storage, ['SizeInGiB']);
    renameInList(o, 'InferenceAcceleratorOverrides', ['DeviceName', 'DeviceType']);
    out['Overrides'] = o;
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `PascalCase` -> `camelCase` on the listed keys of one object; others pass through. */
function renameKeys(
  item: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...item };
  for (const key of keys) {
    if (out[key] === undefined) continue;
    out[key.charAt(0).toLowerCase() + key.slice(1)] = out[key];
    delete out[key];
  }
  return out;
}

/** {@link renameKeys} over each object element of `holder[listKey]`. */
function renameInList(
  holder: Record<string, unknown>,
  listKey: string,
  keys: readonly string[]
): void {
  const list = holder[listKey];
  if (!Array.isArray(list)) return;
  holder[listKey] = list.map((item) => {
    const r = asRecord(item);
    return r ? renameKeys(r, keys) : item;
  });
}

/** CFn `TargetParameters` -> the SDK shape (the `EcsTaskParameters` islands). */
function toSdkTargetParameters(value: unknown): PipeTargetParameters | undefined {
  const target = asRecord(value);
  if (!target) return value as PipeTargetParameters | undefined;
  const ecs = asRecord(target['EcsTaskParameters']);
  if (!ecs) return target as PipeTargetParameters;
  return {
    ...target,
    EcsTaskParameters: toSdkEcsTaskParameters(ecs),
  } as unknown as PipeTargetParameters;
}

/**
 * CFn `SourceParameters` -> the CreatePipe shape. The only divergence is
 * Kinesis `StartingPositionTimestamp`: CFn carries an ISO string, the SDK
 * types a `Date`.
 */
function toSdkSourceParameters(value: unknown): PipeSourceParameters | undefined {
  const source = asRecord(value);
  if (!source) return value as PipeSourceParameters | undefined;
  const kinesis = asRecord(source['KinesisStreamParameters']);
  if (!kinesis || typeof kinesis['StartingPositionTimestamp'] !== 'string') {
    return source as PipeSourceParameters;
  }
  return {
    ...source,
    KinesisStreamParameters: {
      ...kinesis,
      StartingPositionTimestamp: new Date(kinesis['StartingPositionTimestamp']),
    },
  } as PipeSourceParameters;
}

/**
 * The `UpdatePipe` `SourceParameters` for a desired / previous pair
 * (go-to-k/cdkd#4423). Exported for the unit suite.
 *
 * - Each source block keeps only its {@link UPDATABLE_SOURCE_MEMBERS}: the
 *   create-only members are not members of the update shape at all.
 * - AWS replaces a source block ATOMICALLY ("if you don't specify an optional
 *   field ... EventBridge sets that field to its system-default value"), so a
 *   block the previous template declared and the desired one drops is sent
 *   EMPTY, which resets it the way CloudFormation's removal does.
 * - A removed `FilterCriteria` is sent as `{ Filters: [] }`, the documented
 *   way to remove a filter; an absent one would keep the live filter.
 *
 * Returns `undefined` when neither side declares anything.
 */
export function toUpdateSourceParameters(
  desired: unknown,
  previous: unknown
): UpdatePipeSourceParameters | undefined {
  const next = asRecord(desired) ?? {};
  const prev = asRecord(previous) ?? {};
  const out: Record<string, unknown> = {};
  if (next['FilterCriteria'] !== undefined) {
    out['FilterCriteria'] = next['FilterCriteria'];
  } else if (prev['FilterCriteria'] !== undefined) {
    out['FilterCriteria'] = { Filters: [] };
  }
  for (const [block, members] of UPDATABLE_SOURCE_MEMBERS) {
    const desiredBlock = asRecord(next[block]);
    if (desiredBlock) {
      const kept: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(desiredBlock)) {
        if (members.has(key) && value !== undefined) kept[key] = value;
      }
      out[block] = kept;
    } else if (next[block] === undefined && prev[block] !== undefined) {
      out[block] = {};
    }
  }
  return Object.keys(out).length === 0 ? undefined : (out as UpdatePipeSourceParameters);
}

/** A key -> value tag map, refused when malformed (it would read as "no tags"). */
function desiredTagMap(
  value: unknown,
  logicalId: string,
  physicalId?: string
): Record<string, string> {
  const tags = refuseMalformedDesiredTags(
    tagMapAsList(value),
    PIPE_TYPE,
    logicalId,
    physicalId,
    'Tags',
    'a map of tag keys to scalar values'
  );
  return Object.fromEntries(tags.map((t) => [t.Key, t.Value]));
}

/** Delete failures that are terminal on any read. */
const DELETE_FAILED_STATES: ReadonlySet<string> = new Set([
  'DELETE_FAILED',
  'DELETE_ROLLBACK_FAILED',
]);

/**
 * The delete wait's TERMINAL states, for one delete. Returning normally on
 * any of them would drop the state record of a live pipe.
 * - `DELETE_FAILED` / `DELETE_ROLLBACK_FAILED`, on any read.
 * - Any other `*_FAILED` state, only AFTER a `DELETING` read. Before it, the
 *   read may still show the state the pipe was in when the delete was sent
 *   (a pipe destroyed while in `UPDATE_FAILED`).
 * - Two consecutive `RUNNING` / `STOPPED` reads AFTER a `DELETING` read: the
 *   delete rolled back. A settled read before any `DELETING` read is not
 *   terminal: the delete may not have started yet.
 * The message names no already-deleted phrase (`delete-outcome.ts`).
 */
function deleteFailureClassifier(
  resourceType: string,
  logicalId: string,
  physicalId: string
): (status: string) => Error | undefined {
  let sawDeleting = false;
  let settledAfterDeleting = 0;
  return (status) => {
    if (status === 'DELETING') {
      sawDeleting = true;
      settledAfterDeleting = 0;
      return undefined;
    }
    settledAfterDeleting = sawDeleting && SETTLED_STATES.has(status) ? settledAfterDeleting + 1 : 0;
    const terminal =
      DELETE_FAILED_STATES.has(status) ||
      (sawDeleting && status.endsWith('_FAILED')) ||
      settledAfterDeleting >= 2;
    if (!terminal) return undefined;
    return new ProvisioningError(
      `Pipe ${logicalId} reached ${status} after its delete was accepted; AWS will not ` +
        `finish the delete on its own, so cdkd keeps its record`,
      resourceType,
      logicalId,
      physicalId
    );
  };
}

/** Seams for the unit suite; production passes none. */
export interface PipesProviderOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class PipesPipeProvider implements ResourceProvider {
  private client: PipesClient | undefined;
  private readonly providerRegion = ambientRegion();
  private readonly logger = getLogger().child('PipesPipeProvider');
  private readonly options: PipesProviderOptions;
  private readonly sleep = (ms: number): Promise<void> =>
    this.options.sleep ? this.options.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  private readonly now = (): number => (this.options.now ? this.options.now() : Date.now());

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Pipes::Pipe',
      new Set([
        'Name',
        'Description',
        'DesiredState',
        'Source',
        'SourceParameters',
        'Enrichment',
        'EnrichmentParameters',
        'Target',
        'TargetParameters',
        'RoleArn',
        'LogConfiguration',
        'KmsKeyIdentifier',
        'Tags',
      ]),
    ],
  ]);

  /**
   * Clear values for a property the template REMOVED (`UpdatePipe` merges:
   * an absent field keeps the live value). `''` clears the description, the
   * enrichment and a customer managed key (the API documents the empty string
   * as "use the AWS owned key"); `RUNNING` is CloudFormation's default
   * `DesiredState`; `Level: OFF` turns logging off.
   */
  removalDefaults = new Map<string, ReadonlyMap<string, unknown>>([
    [
      'AWS::Pipes::Pipe',
      new Map<string, unknown>([
        ['Description', ''],
        ['Enrichment', ''],
        ['KmsKeyIdentifier', ''],
        ['DesiredState', 'RUNNING'],
        ['LogConfiguration', { Level: 'OFF' }],
      ]),
    ],
  ]);

  /**
   * Removals `update()` handles itself: `SourceParameters` through
   * {@link toUpdateSourceParameters}, `Tags` through `UntagResource`.
   * `EnrichmentParameters` / `TargetParameters` are deliberately absent: what
   * `UpdatePipe` does with a block that is left out is not documented, so the
   * deploy reports their removal rather than claim it.
   */
  removalHandledInUpdate = new Map<string, ReadonlySet<string>>([
    ['AWS::Pipes::Pipe', new Set(['SourceParameters', 'Tags'])],
  ]);

  constructor(options: PipesProviderOptions = {}) {
    this.options = options;
  }

  private getClient(): PipesClient {
    if (!this.client) {
      this.client = new PipesClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.client;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    const mask = maskerOrIdentity(context?.maskSecrets);
    // Pipe names: 1-64 chars of [.\-_A-Za-z0-9]. generateResourceName's
    // stack-prefixed output keeps to that charset and `maxLength` caps it.
    const name =
      (properties['Name'] as string | undefined) ??
      generateResourceName(logicalId, { maxLength: 64 });
    const tags = desiredTagMap(properties['Tags'], logicalId);
    this.logger.debug(mask(`Creating Pipe ${logicalId}: ${name}`));

    try {
      await this.getClient().send(
        new CreatePipeCommand({
          Name: name,
          RoleArn: properties['RoleArn'] as string,
          Source: properties['Source'] as string,
          Target: properties['Target'] as string,
          ...(properties['Description'] !== undefined && {
            Description: properties['Description'] as string,
          }),
          ...(properties['DesiredState'] !== undefined && {
            DesiredState: properties['DesiredState'] as 'RUNNING' | 'STOPPED',
          }),
          ...(properties['SourceParameters'] !== undefined && {
            SourceParameters: toSdkSourceParameters(properties['SourceParameters']),
          }),
          ...(properties['Enrichment'] !== undefined && {
            Enrichment: properties['Enrichment'] as string,
          }),
          ...(properties['EnrichmentParameters'] !== undefined && {
            EnrichmentParameters: properties['EnrichmentParameters'] as PipeEnrichmentParameters,
          }),
          ...(properties['TargetParameters'] !== undefined && {
            TargetParameters: toSdkTargetParameters(properties['TargetParameters']),
          }),
          ...(properties['LogConfiguration'] !== undefined && {
            LogConfiguration: properties['LogConfiguration'] as PipeLogConfigurationParameters,
          }),
          ...(properties['KmsKeyIdentifier'] !== undefined && {
            KmsKeyIdentifier: properties['KmsKeyIdentifier'] as string,
          }),
          ...(Object.keys(tags).length > 0 && { Tags: tags }),
        })
      );
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Pipe ${logicalId}: ${cause?.message ?? String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }

    // The pipe now EXISTS. A failed settle (a *_FAILED state, the cap, a
    // Ctrl-C) would otherwise leave it alive with nothing recorded: invisible
    // to `cdkd destroy`, and holding the name the next deploy creates.
    let settled: DescribePipeCommandOutput;
    try {
      settled = await this.waitForSettled(name, logicalId, resourceType, 'create', mask);
    } catch (error) {
      throw await this.retireFailedCreate(name, logicalId, error, mask);
    }
    return { physicalId: name, attributes: this.attributesOf(settled) };
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    const mask = maskerOrIdentity(context?.maskSecrets);
    assertRegionMatch(
      await this.getClient().config.region(),
      context?.expectedRegion,
      resourceType,
      logicalId,
      physicalId,
      'pre-update'
    );
    // Name and Source are create-only: the diff replaces the pipe before this
    // is called. Refuse rather than send an UpdatePipe that would act on the
    // old pipe while the record claims the new values. A secret-derived value
    // is recorded as its `{{resolve:...}}` reference and handed here resolved,
    // which is no change (go-to-k/cdkd#4275): the Name is checked against the
    // physical id, which is the pipe's name.
    for (const key of ['Name', 'Source'] as const) {
      const desiredValue = properties[key];
      const recordedValue = previousProperties[key];
      if (
        desiredValue !== undefined &&
        recordedValue !== undefined &&
        desiredValue !== recordedValue &&
        !(await unchangedBehindSecretReference({
          resourceType,
          key,
          desired: desiredValue,
          previous: recordedValue,
          ...(key === 'Name' ? { physicalName: physicalId } : {}),
          maskSecrets: context?.maskSecrets,
        }))
      ) {
        throw new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          `${key} is create-only; re-run with \`cdkd deploy --replace\` to recreate the pipe ` +
            `(--replace is a boolean flag and takes no resource id; it applies to every ` +
            `resource in the run whose in-place update is refused)`
        );
      }
    }
    const desired = withRemovalDefaults(
      this.removalDefaults,
      resourceType,
      properties,
      previousProperties,
      context
    );
    const desiredTags = desiredTagMap(desired['Tags'], logicalId, physicalId);
    this.logger.debug(mask(`Updating Pipe ${logicalId}: ${physicalId}`));

    let settled: DescribePipeCommandOutput | undefined;
    try {
      if (this.pipeFieldsChanged(desired, previousProperties)) {
        const input: UpdatePipeCommandInput = {
          Name: physicalId,
          RoleArn: desired['RoleArn'] as string,
          Target: desired['Target'] as string,
          ...(desired['Description'] !== undefined && {
            Description: desired['Description'] as string,
          }),
          ...(desired['DesiredState'] !== undefined && {
            DesiredState: desired['DesiredState'] as 'RUNNING' | 'STOPPED',
          }),
          ...(desired['Enrichment'] !== undefined && {
            Enrichment: desired['Enrichment'] as string,
          }),
          ...(desired['EnrichmentParameters'] !== undefined && {
            EnrichmentParameters: desired['EnrichmentParameters'] as PipeEnrichmentParameters,
          }),
          ...(desired['TargetParameters'] !== undefined && {
            TargetParameters: toSdkTargetParameters(desired['TargetParameters']),
          }),
          ...(desired['LogConfiguration'] !== undefined && {
            LogConfiguration: this.logConfigurationOf(desired['LogConfiguration']),
          }),
          ...(desired['KmsKeyIdentifier'] !== undefined && {
            KmsKeyIdentifier: desired['KmsKeyIdentifier'] as string,
          }),
        };
        const sourceParameters = toUpdateSourceParameters(
          desired['SourceParameters'],
          previousProperties['SourceParameters']
        );
        if (sourceParameters !== undefined) input.SourceParameters = sourceParameters;
        const accepted = await this.getClient().send(new UpdatePipeCommand(input));
        settled = await this.waitForSettled(
          physicalId,
          logicalId,
          resourceType,
          'update',
          mask,
          accepted.LastModifiedTime
        );
      }

      const plan = planTagDiff(tagMapAsList(previousProperties['Tags']), tagMapAsList(desiredTags));
      const warning = tagPlanWarning(plan, resourceType, logicalId);
      if (warning) this.logger.warn(warning);
      if (plan.set.size > 0 || plan.remove.length > 0) {
        settled ??= await this.describe(physicalId);
        const arn = settled.Arn;
        if (!arn) {
          throw new Error('DescribePipe returned no Arn, which tagging needs');
        }
        if (plan.remove.length > 0) {
          await this.getClient().send(
            new UntagResourceCommand({ resourceArn: arn, tagKeys: plan.remove })
          );
        }
        if (plan.set.size > 0) {
          await this.getClient().send(
            new TagResourceCommand({ resourceArn: arn, tags: Object.fromEntries(plan.set) })
          );
        }
      }
      settled ??= await this.describe(physicalId);
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      if (error instanceof NotFoundException) {
        assertRegionMatch(
          await this.getClient().config.region(),
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Pipe ${logicalId}: ${cause?.message ?? String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
    return { physicalId, wasReplaced: false, attributes: this.attributesOf(settled) };
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    const clientRegion = await this.getClient().config.region();
    assertRegionMatch(
      clientRegion,
      context?.expectedRegion,
      resourceType,
      logicalId,
      physicalId,
      'pre-delete'
    );
    this.logger.debug(safeMsg`Deleting Pipe ${logicalId}: ${physicalId}`);
    try {
      await this.getClient().send(new DeletePipeCommand({ Name: physicalId }));
    } catch (error) {
      if (error instanceof NotFoundException) {
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(
          safeMsg`Pipe ${logicalId} already deleted (not found), treating as success`
        );
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Pipe ${logicalId}: ${cause?.message ?? String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
    // A DELETING pipe still holds its name, so a same-name create (a
    // delete-first replacement, a destroy then a deploy) would be refused.
    await waitForGoneAfterDelete({
      what: `Pipe ${physicalId}`,
      resourceType,
      describe: () => this.readStateForDelete(physicalId),
      failedStatus: deleteFailureClassifier(resourceType, logicalId, physicalId),
      logger: this.logger,
      pollIntervalMs: PIPE_POLL_INTERVAL_MS,
      maxWaitMs: PIPE_DELETE_MAX_WAIT_MS,
      sleep: this.sleep,
      now: this.now,
    });
  }

  /**
   * Live `Fn::GetAtt`. The attributes are recorded at create / update time,
   * so this serves imported or degraded records. `undefined` for an unknown
   * attribute or a pipe that is gone.
   */
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string,
    _logicalId: string
  ): Promise<unknown> {
    let response: DescribePipeCommandOutput;
    try {
      response = await this.describe(physicalId);
    } catch (error) {
      if (error instanceof NotFoundException) return undefined;
      throw error;
    }
    return this.attributesOf(response)[attributeName];
  }

  /**
   * Drift read-back. `SourceParameters` and `TargetParameters` are WRITE-ONLY
   * in the CFn schema, and `DescribePipe` fills them with AWS defaults the
   * template never declared, so they are left out and declared unknown
   * ({@link getDriftUnknownPaths}) rather than reported as drift on every
   * pipe. Returns `RESOURCE_NOT_FOUND` when the pipe is gone (`NotFoundException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let r: DescribePipeCommandOutput;
    try {
      r = await this.describe(physicalId);
    } catch (error) {
      if (error instanceof NotFoundException) return RESOURCE_NOT_FOUND;
      throw error;
    }
    const tags: Record<string, string> = {};
    for (const [key, value] of Object.entries(r.Tags ?? {})) {
      if (!key.startsWith('aws:')) tags[key] = value;
    }
    return {
      Name: r.Name ?? physicalId,
      Description: r.Description ?? '',
      DesiredState: r.DesiredState ?? 'RUNNING',
      Source: r.Source,
      Enrichment: r.Enrichment ?? '',
      EnrichmentParameters: r.EnrichmentParameters ?? {},
      Target: r.Target,
      RoleArn: r.RoleArn,
      LogConfiguration: r.LogConfiguration ?? {},
      KmsKeyIdentifier: r.KmsKeyIdentifier ?? '',
      Tags: tags,
    };
  }

  getDriftUnknownPaths(): string[] {
    return ['SourceParameters', 'TargetParameters'];
  }

  /**
   * Import by explicit name (`--resource <logicalId>=<name>` or the template's
   * `Name`). No tag lookup: a pipe carries no `aws:cdk:path` tag.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'Name');
    if (!explicit) return null;
    try {
      const response = await this.describe(explicit);
      return { physicalId: explicit, attributes: this.attributesOf(response) };
    } catch (error) {
      if (error instanceof NotFoundException) return null;
      throw error;
    }
  }

  private async describe(name: string): Promise<DescribePipeCommandOutput> {
    return this.getClient().send(new DescribePipeCommand({ Name: name }));
  }

  /** Every CFn `Fn::GetAtt` the type documents; an unread one is left out. */
  private attributesOf(r: DescribePipeCommandOutput): Record<string, unknown> {
    return definedAttributes({
      Arn: r.Arn,
      CurrentState: r.CurrentState,
      StateReason: r.StateReason,
      CreationTime: r.CreationTime?.toISOString(),
      LastModifiedTime: r.LastModifiedTime?.toISOString(),
    });
  }

  /**
   * An EMPTY `LogConfiguration` (the drift read-back's placeholder for a pipe
   * that logs nothing, round-tripped by `drift --revert`) means "no logging".
   * Sent as is, AWS refuses it for the missing `Level`.
   */
  private logConfigurationOf(value: unknown): PipeLogConfigurationParameters {
    const config = asRecord(value);
    if (config && Object.keys(config).length === 0) return { Level: 'OFF' };
    return value as PipeLogConfigurationParameters;
  }

  /** Whether anything `UpdatePipe` carries differs; a Tags-only change skips it. */
  private pipeFieldsChanged(
    desired: Record<string, unknown>,
    previous: Record<string, unknown>
  ): boolean {
    const keys = new Set([...Object.keys(desired), ...Object.keys(previous)]);
    keys.delete('Tags');
    for (const key of keys) {
      if (JSON.stringify(desired[key]) !== JSON.stringify(previous[key])) return true;
    }
    return false;
  }

  /** The pipe's current state, or `undefined` once it is gone. */
  private async readStateForDelete(name: string): Promise<string | undefined> {
    try {
      return (await this.describe(name)).CurrentState ?? 'UNKNOWN';
    } catch (error) {
      if (error instanceof NotFoundException) return undefined;
      throw error;
    }
  }

  /**
   * Poll `DescribePipe` until the pipe rests in `RUNNING` / `STOPPED`.
   * Throws on a `*_FAILED` state (AWS's `StateReason` is where a bad role or
   * target is reported), on the cap, and on Ctrl-C. A throttled or transient
   * read, and a not-found straight after `CreatePipe` (read-after-create lag),
   * keep polling. `modifiedAt` (the `UpdatePipe` answer's `LastModifiedTime`)
   * keeps a read that still shows the state from BEFORE the update — a pipe
   * that has not yet left `RUNNING` — from counting as settled. When an update
   * has no such time to compare, a settled read counts only after a
   * non-settled read or one poll interval.
   */
  private async waitForSettled(
    name: string,
    logicalId: string,
    resourceType: string,
    phase: 'create' | 'update',
    mask: MaskerFn,
    modifiedAt?: Date
  ): Promise<DescribePipeCommandOutput> {
    const userTimeoutMs = resolvedResourceTimeoutMs(resourceType);
    const maxWaitMs =
      userTimeoutMs === undefined
        ? PIPE_SETTLE_MAX_WAIT_MS
        : Math.min(PIPE_SETTLE_MAX_WAIT_MS, userTimeoutMs / 2);
    const startedAt = this.now();
    const watch = startInterruptWatch(`Pipe ${logicalId} ${phase}`);
    const needsEvidence = phase === 'update' && modifiedAt === undefined;
    let sawUnsettled = false;
    try {
      let lastState: string | undefined;
      for (;;) {
        if (watch.isInterrupted()) throw watch.onInterrupted();
        try {
          const response = await this.describe(name);
          const state = response.CurrentState;
          lastState = state;
          const stale =
            modifiedAt !== undefined &&
            response.LastModifiedTime !== undefined &&
            response.LastModifiedTime.getTime() < modifiedAt.getTime();
          const settled = state !== undefined && SETTLED_STATES.has(state) && !stale;
          if (
            settled &&
            (!needsEvidence || sawUnsettled || this.now() - startedAt >= PIPE_POLL_INTERVAL_MS)
          ) {
            return response;
          }
          if (!settled) sawUnsettled = true;
          // A stale read shows the state from BEFORE the update, a failure
          // included, which the update may be about to clear: poll again.
          if (state !== undefined && state.endsWith('_FAILED') && !stale) {
            const reason = response.StateReason ? `: ${mask(response.StateReason)}` : '';
            throw markNonRetryable(
              new ProvisioningError(
                `Pipe ${logicalId} ${phase} failed: AWS reports ${state}${reason}`,
                resourceType,
                logicalId,
                name
              )
            );
          }
          this.logger.debug(mask(`Pipe ${name} state: ${state ?? 'unknown'}, waiting to settle`));
        } catch (error) {
          if (error instanceof ProvisioningError) throw error;
          const lag = error instanceof NotFoundException && phase === 'create';
          if (!lag && !isThrottlingError(error) && !isTransientServerError(error)) throw error;
          this.logger.debug(
            safeMsg`Pipe ${logicalId}: state read failed transiently (${describeAwsFailure(error).summary}), re-polling`
          );
        }
        const remainingMs = maxWaitMs - (this.now() - startedAt);
        if (remainingMs <= 0) {
          throw markNonRetryable(
            new ProvisioningError(
              `Pipe ${logicalId} did not settle within ${Math.round(maxWaitMs / 1000)}s of its ` +
                `${phase} (last state: ${lastState ?? 'unknown'})`,
              resourceType,
              logicalId,
              name
            )
          );
        }
        await this.sleep(Math.min(PIPE_POLL_INTERVAL_MS, remainingMs));
      }
    } finally {
      watch.dispose();
    }
  }

  /**
   * After `CreatePipe` succeeded and the settle wait failed: delete the pipe
   * so it does not survive unrecorded, then return the ORIGINAL error,
   * extended with what happened to the pipe. The gone wait is SHORT (a failed
   * create must not also spend the full delete wait), so the message claims
   * the pipe is gone only when a read confirmed it.
   */
  private async retireFailedCreate(
    name: string,
    logicalId: string,
    error: unknown,
    mask: MaskerFn
  ): Promise<Error> {
    // The settle wait throws only Errors; the fallback keeps the type honest.
    const original = error instanceof Error ? error : new Error(String(error));
    // The pipe survives, live and unrecorded: say so and how to delete it,
    // named with the client's region (the name alone would address a
    // same-named pipe in the profile's default region).
    const orphaned = async (why: string): Promise<Error> => {
      const aws = pasteableAwsCommand(mask);
      const region = await orphanCommandRegionArg(this.getClient(), aws);
      const command = aws`aws pipes delete-pipe --name ${name}${region}`;
      original.message +=
        ` (cdkd could not delete the pipe it had created: ${why}; it is not recorded in state. ` +
        (command.text !== undefined
          ? `Delete it with: ${command.text})`
          : `Delete it from the EventBridge Pipes console.)`);
      return original;
    };
    try {
      await this.getClient().send(new DeletePipeCommand({ Name: name }));
    } catch (cleanupError) {
      if (cleanupError instanceof NotFoundException) return original;
      return orphaned(describeAwsFailure(cleanupError).summary);
    }
    let gone = false;
    let sawDeleting = false;
    try {
      await waitForGoneAfterDelete({
        what: `Pipe ${name}`,
        resourceType: PIPE_TYPE,
        describe: async () => {
          const state = await this.readStateForDelete(name);
          if (state === undefined) gone = true;
          if (state === 'DELETING') sawDeleting = true;
          return state;
        },
        failedStatus: deleteFailureClassifier(PIPE_TYPE, logicalId, name),
        logger: this.logger,
        pollIntervalMs: PIPE_POLL_INTERVAL_MS,
        maxWaitMs: PIPE_CLEANUP_MAX_WAIT_MS,
        sleep: this.sleep,
        now: this.now,
      });
    } catch {
      // Only a terminal delete state throws here: AWS will not finish it.
      return orphaned('its delete did not complete (AWS reports a failed or rolled-back delete)');
    }
    if (gone) {
      original.message += ' (cdkd deleted the pipe it had created, so nothing is left behind)';
      return original;
    }
    // Not confirmed gone: the wait ended on its cap, a Ctrl-C (which can mean
    // no read at all), or a status read that failed. Only a DELETING read
    // shows the delete progressing; without one, cdkd cannot say it did.
    if (sawDeleting) {
      original.message +=
        ' (cdkd started deleting the pipe it had created; a re-deploy may report the ' +
        'name in use until AWS finishes)';
      return original;
    }
    const aws = pasteableAwsCommand(mask);
    const region = await orphanCommandRegionArg(this.getClient(), aws);
    const describe = aws`aws pipes describe-pipe --name ${name}${region}`;
    const remove = aws`aws pipes delete-pipe --name ${name}${region}`;
    original.message +=
      ' (cdkd asked AWS to delete the pipe it had created but could not confirm the delete ' +
      'progressed; ' +
      (describe.text !== undefined && remove.text !== undefined
        ? // No backticks around the command: pasted, they would run it.
          `if ${describe.text} still shows it, delete it with: ${remove.text})`
        : 'if the EventBridge Pipes console still shows it, delete it there.)');
    return original;
  }
}
