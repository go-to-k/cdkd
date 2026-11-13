import {
  PipesClient,
  DescribePipeCommand,
  NotFoundException,
  type DescribePipeCommandOutput,
  type PipeLogConfigurationParameters,
} from '@aws-sdk/client-pipes';
import type { ResourceNotFound } from '../../types/resource.js';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import type { ProvisioningError } from '../../utils/error-handler.js';
import { safeMsg } from '../../utils/display-safe.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import type { DeleteContext } from '../region-check.js';
import { maskerOrIdentity, type MaskerFn } from '../masked-retry-logger.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { definedAttributes } from '../attribute-map.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  UpdateContext,
  ResourceIdentityVerdict,
} from '../../types/resource.js';
import { asRecord } from './pipes/shared.js';
import { create, retireFailedCreate } from './pipes/create.js';
import { waitForSettled } from './pipes/settle.js';
import { update } from './pipes/update.js';
import { deleteImpl } from './pipes/delete.js';
import { isSameResource, resourceIdentity } from './pipes/identity.js';
import {
  getAttribute,
  readCurrentState,
  importImpl,
  unsettledInTransition,
  readUnsettled,
} from './pipes/read-state.js';

export { toUpdateSourceParameters } from './pipes/shared.js';

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

/** Seams for the unit suite; production passes none. */
export interface PipesProviderOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class PipesPipeProvider implements ResourceProvider {
  private client: PipesClient | undefined;
  private createClient: PipesClient | undefined;
  private readonly providerRegion = ambientRegion();
  readonly logger: ConsoleLogger = getLogger().child('PipesPipeProvider');

  /**
   * The failure wrap the create / update / delete / getAttribute catches throw.
   *
   * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
   * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
   * `deployments/{runId}.jsonl`, and an `AccessDeniedException` names the
   * caller's assumed-role ARN. AWS's own text goes to `debug` through the
   * operation's `maskSecrets` (`mask`), and the wrap is stamped
   * `markRedactedCause`, so the retry classifiers read the withheld text on the
   * `cause` chain. An "already exists" is restated ({@link relayedNameCollision}).
   * A cdkd-authored or transport error keeps its text, masked, stamped only
   * when the mask changed it (`wrapMaskedAwsError`, issue #4244); a non-`Error`
   * throw is withheld like an AWS one, unstamped (it has no chain). The delete
   * checks `NotFoundException` by type before it wraps.
   *
   * `build` must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor call.
   */
  wrapCaughtError(
    mask: MaskerFn | undefined,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    const m = maskerOrIdentity(mask);
    const failure = describeAwsFailure(error);
    if (!failure.redacted) return wrapMaskedAwsError(m, error, build);
    this.logger.debug(m(build(m(failure.detail)).message));
    const wrapped = build(`${m(failure.summary)}${relayedNameCollision(failure.detail)}`);
    return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
  }
  private readonly options: PipesProviderOptions;
  readonly sleep = (ms: number): Promise<void> =>
    this.options.sleep ? this.options.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  readonly now = (): number => (this.options.now ? this.options.now() : Date.now());

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
   * {@link toUpdateSourceParameters}, `Tags` through `UntagResource`, and
   * `EnrichmentParameters` / `TargetParameters` through
   * `toUpdateParameterBlock` (go-to-k/cdkd#6233), which clears a removed
   * `InputTemplate`; `update()` itself reports every other member those blocks
   * drop, so the removal is still reported rather than claimed.
   */
  removalHandledInUpdate = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Pipes::Pipe',
      new Set(['SourceParameters', 'Tags', 'EnrichmentParameters', 'TargetParameters']),
    ],
  ]);

  constructor(options: PipesProviderOptions = {}) {
    this.options = options;
  }

  getClient(): PipesClient {
    if (!this.client) {
      this.client = new PipesClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
      this.createClient = withoutServerErrorRetries(
        new PipesClient({
          ...ambientClientDefaults(),
          ...(this.providerRegion ? { region: this.providerRegion } : {}),
        })
      );
    }
    return this.client;
  }

  /**
   * The client `CreatePipe` goes through: SDK retries on, except a 5xx
   * (`withoutServerErrorRetries`, issue #4639). Separate so every other call
   * keeps the full SDK retry; built in {@link getClient}'s step, so both
   * capture the region and identity active at that ONE call.
   *
   * `CreatePipe` carries no idempotency token (the Pipes API has no
   * `ClientToken`), and a pipe name is unique per account and region, so the SDK's own replay of a 5xx whose request had
   * succeeded collides with what the first send made, and that "already
   * exists" surfaced from the engine's FIRST attempt as a name somebody else
   * holds. Refused here, the 5xx reaches the deploy engine's retry, which
   * marks the create as possibly replayed (`withRetry`, #3978). Nothing is
   * adopted on that collision: a name is not attribution
   * (`docs/provider-rules.md`, "Adopt only on EXACT attribution").
   */
  getCreateClient(): PipesClient {
    this.getClient();
    return this.createClient as PipesClient;
  }

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
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

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, _properties, context);
  }

  /**
   * The not-found arm of `delete`. A journaled failed-CREATE orphan already
   * gone settles with exit 0 (go-to-k/cdkd#4606), so it is said once at info;
   * the name is interpolated verbatim for the caller's printing bag to mask.
   */
  logGoneOnDelete(logicalId: string, physicalId: string, context: DeleteContext | undefined): void {
    if (context?.failedCreateOrphan === true) {
      this.logger.info(
        safeMsg`  Pipe ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
      );
    } else {
      this.logger.debug(
        safeMsg`Pipe ${logicalId} already deleted (not found), treating as success`
      );
    }
  }

  // ─── Identity (go-to-k/cdkd#4606) ────────────────────────────────

  isSameResource(
    journaledPhysicalId: string,
    record: { physicalId: string },
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<ResourceIdentityVerdict> {
    return isSameResource.call(this, journaledPhysicalId, record, resourceType, context);
  }

  resourceIdentity(
    physicalId: string,
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<string | ResourceNotFound | undefined> {
    return resourceIdentity.call(this, physicalId, resourceType, context);
  }

  /** `DescribePipe`, or `undefined` on AWS's `NotFoundException`; any other failure throws. */
  async describeIfExists(name: string): Promise<DescribePipeCommandOutput | undefined> {
    try {
      return await this.describe(name);
    } catch (error) {
      if (error instanceof NotFoundException) return undefined;
      throw error;
    }
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
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, _resourceType);
  }

  getDriftUnknownPaths(): string[] {
    return ['SourceParameters', 'TargetParameters'];
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }

  async describe(name: string): Promise<DescribePipeCommandOutput> {
    return this.getClient().send(new DescribePipeCommand({ Name: name }));
  }

  /** Every CFn `Fn::GetAtt` the type documents; an unread one is left out. */
  attributesOf(r: DescribePipeCommandOutput): Record<string, unknown> {
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
  logConfigurationOf(value: unknown): PipeLogConfigurationParameters {
    const config = asRecord(value);
    if (config && Object.keys(config).length === 0) return { Level: 'OFF' };
    return value as PipeLogConfigurationParameters;
  }

  /** Whether anything `UpdatePipe` carries differs; a Tags-only change skips it. */
  pipeFieldsChanged(desired: Record<string, unknown>, previous: Record<string, unknown>): boolean {
    return this.changedPipeFields(desired, previous).length > 0;
  }

  /** The non-`Tags` top-level keys whose desired value differs from `previous`. */
  changedPipeFields(desired: Record<string, unknown>, previous: Record<string, unknown>): string[] {
    const keys = new Set([...Object.keys(desired), ...Object.keys(previous)]);
    keys.delete('Tags');
    return [...keys].filter(
      (key) => JSON.stringify(desired[key]) !== JSON.stringify(previous[key])
    );
  }

  unsettledInTransition(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    names: ReadonlySet<string>
  ): Promise<ReadonlySet<string>> {
    return unsettledInTransition.call(this, physicalId, _logicalId, _resourceType, names);
  }

  readUnsettled(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    names: ReadonlySet<string>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readUnsettled.call(this, physicalId, logicalId, resourceType, names);
  }

  /** The pipe's current state, or `undefined` once it is gone. */
  async readStateForDelete(name: string): Promise<string | undefined> {
    try {
      return (await this.describe(name)).CurrentState ?? 'UNKNOWN';
    } catch (error) {
      if (error instanceof NotFoundException) return undefined;
      throw error;
    }
  }

  waitForSettled(
    name: string,
    logicalId: string,
    resourceType: string,
    phase: 'create' | 'update',
    mask: MaskerFn,
    modifiedAt?: Date
  ): Promise<DescribePipeCommandOutput> {
    return waitForSettled.call(this, name, logicalId, resourceType, phase, mask, modifiedAt);
  }

  retireFailedCreate(
    name: string,
    logicalId: string,
    resourceType: string,
    error: unknown,
    mask: MaskerFn,
    createdIdentity: string | undefined
  ): Promise<Error> {
    return retireFailedCreate.call(
      this,
      name,
      logicalId,
      resourceType,
      error,
      mask,
      createdIdentity
    );
  }
}
