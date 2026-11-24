import {
  EventBridgeClient,
  CreateArchiveCommand,
  DeleteArchiveCommand,
  DescribeArchiveCommand,
  UpdateArchiveCommand,
  ResourceNotFoundException,
  type CreateArchiveCommandInput,
  type UpdateArchiveCommandInput,
} from '@aws-sdk/client-eventbridge';
import { getLogger } from '../../utils/logger.js';
import { safeMsg } from '../../utils/display-safe.js';
import { describeAwsFailure, verbosePointerTail } from '../../utils/aws-failure-text.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';
import { CdkdError, ProvisioningError } from '../../utils/error-handler.js';
import { markCreatedBeforeFailure } from '../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../created-resource-sink.js';
import {
  markNonRetryable,
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import { maskerOrIdentity, type MaskerFn } from '../masked-retry-logger.js';
import { isInterruptedWaitError, startInterruptWatch } from '../interrupt-watch.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { markNotGone } from '../not-gone.js';
import { isThrottlingError, isTransientServerError } from '../../deployment/retryable-errors.js';
import { resolveExplicitPhysicalId } from '../import-helpers.js';
import { generatedNameFor } from '../resource-name.js';
import { coerceCfnInteger } from '../config-shape.js';
import { resolvedResourceTimeoutMs } from '../resource-timeout-registry.js';
import type {
  CreateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import { definedAttributes } from '../attribute-map.js';
import { abortableSleep, deferReadiness } from '../deferred-readiness.js';

const RESOURCE_TYPE = 'AWS::Events::Archive';

/**
 * The `EventPattern` string the API takes. The template may carry the pattern
 * as an object or as a JSON string (the CFn schema types it `object`, and
 * CloudFormation accepts both); `undefined` when none is declared.
 */
export function archiveEventPattern(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * A comparison key for an `EventPattern`, so the same pattern spelled once as
 * an object and once as a JSON string, or with its keys in another order,
 * compares equal. Array order is kept.
 */
function eventPatternKey(value: unknown): string | undefined {
  const doc = archiveEventPattern(value);
  if (doc === undefined) return undefined;
  try {
    return JSON.stringify(sortKeys(JSON.parse(doc)));
  } catch {
    return doc;
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortKeys(record[key])])
  );
}

/** States an archive settles in; anything else is still moving or failed. */
const SETTLED_STATES = new Set(['ENABLED', 'DISABLED']);
const FAILED_STATES = new Set(['CREATE_FAILED', 'UPDATE_FAILED']);

/**
 * SDK Provider for AWS::Events::Archive
 *
 * CreateArchive / UpdateArchive / DeleteArchive / DescribeArchive. The
 * physical id is the archive NAME, as CloudFormation's (`ArchiveName` is the
 * schema's primary identifier and what `Ref` returns); `Arn` is the one
 * read-only attribute.
 *
 * An SDK provider rather than Cloud Control: on AWS Emulator a Cloud Control
 * create reports success while the archive never reaches the EventBridge API
 * (`ListArchives` is empty, so a replay has nothing to read), and the direct
 * calls are the faster route on real AWS as well.
 *
 * Archives carry no tags, so `import()` adopts by explicit name only.
 */
export class EventBridgeArchiveProvider implements ResourceProvider {
  private eventBridgeClient: EventBridgeClient;
  private logger = getLogger().child('EventBridgeArchiveProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Events::Archive',
      new Set([
        'ArchiveName',
        'SourceArn',
        'Description',
        'EventPattern',
        'RetentionDays',
        'KmsKeyIdentifier',
      ]),
    ],
  ]);

  /**
   * Issue #1160: no `removalDefaults`. A property removed from the template is
   * left at its live value, as CloudFormation leaves it (measured on
   * us-east-1, go-to-k/cdkd#6578: removing `Description` and `RetentionDays`
   * completed UPDATE_COMPLETE with both still live, since the handler sends
   * UpdateArchive only the fields the template declares; removing every
   * mutable property failed with "At least one of EventPattern, RetentionDays
   * or Description must be provided", as cdkd's UpdateArchive does).
   *
   * Only the create-only keys are listed, whose removal is a replacement: the
   * update caller then names every other removed key as left at its AWS value.
   */
  removalHandledInUpdate = new Map<string, ReadonlySet<string>>([
    ['AWS::Events::Archive', new Set(['ArchiveName', 'SourceArn'])],
  ]);

  /** How long create / update wait for an archive to leave CREATING / UPDATING. */
  stateWait = {
    pollIntervalMs: 2_000,
    timeoutMs: 300_000,
    sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
  };

  constructor() {
    this.eventBridgeClient = getAwsClients().eventBridge;
  }

  private createClient: Promise<EventBridgeClient> | undefined;

  /**
   * The client `CreateArchive` goes through: SDK retries on, except a 5xx
   * (`withoutServerErrorRetries`, the EventBus provider's issue #4639 shape).
   * `CreateArchive` carries no idempotency token and an archive name is
   * unique per account and region, so the SDK's own replay of a 5xx whose
   * request EventBridge completed would fail `ResourceAlreadyExistsException`
   * against the archive the first request made, inside one `send`.
   */
  private getCreateClient(): Promise<EventBridgeClient> {
    const shared = this.eventBridgeClient;
    if (!(shared instanceof EventBridgeClient)) return Promise.resolve(shared);
    this.createClient ??= shared.config.region().then(
      (region) =>
        withoutServerErrorRetries(new EventBridgeClient({ ...ambientClientDefaults(), region })),
      (error: unknown) => {
        this.createClient = undefined;
        throw error;
      }
    );
    return this.createClient;
  }

  /**
   * Wrap a caught failure into the thrown error, keeping the caller's
   * identity out of its message (go-to-k/cdkd#2319): an AWS-authored failure
   * is named by its CLASS, AWS's text goes to debug through the masker. A
   * taken archive name is restated ({@link relayedNameCollision}).
   */
  private wrapMaskedError(
    mask: MaskerFn,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    const failure = describeAwsFailure(error);
    if (!(error instanceof Error)) return build(mask(failure.detail));
    if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
    this.logger.debug(mask(build(failure.detail).message));
    return markRedactedCause(
      build(`${mask(failure.summary)}${relayedNameCollision(failure.detail)}`)
    );
  }

  /**
   * `RetentionDays` as the API takes it. `undefined` when absent; throws,
   * non-retryable, on a value that is not an integer >= 0 (CloudFormation
   * coerces a numeric string, as {@link coerceCfnInteger} does).
   */
  private retentionDays(
    properties: Record<string, unknown>,
    logicalId: string,
    physicalId?: string
  ): number | undefined {
    const value = properties['RetentionDays'];
    if (value === undefined || value === null) return undefined;
    const n = coerceCfnInteger(value);
    if (n !== undefined && n >= 0) return n;
    throw markNonRetryable(
      new ProvisioningError(
        `RetentionDays of ${logicalId} must be an integer >= 0 (0 keeps events indefinitely)`,
        RESOURCE_TYPE,
        logicalId,
        physicalId
      )
    );
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    const mask = maskerOrIdentity(context?.maskSecrets);
    const sourceArn = properties['SourceArn'];
    if (typeof sourceArn !== 'string' || sourceArn === '') {
      throw markNonRetryable(
        new ProvisioningError(
          `SourceArn is required for EventBridge archive ${logicalId}`,
          resourceType,
          logicalId
        )
      );
    }
    const declaredName = properties['ArchiveName'];
    if (declaredName !== undefined && declaredName !== null && typeof declaredName !== 'string') {
      throw markNonRetryable(
        new ProvisioningError(
          `ArchiveName of EventBridge archive ${logicalId} must be a string`,
          resourceType,
          logicalId
        )
      );
    }
    const retentionDays = this.retentionDays(properties, logicalId);
    // CloudFormation generates a name when the template gives none
    // (`ArchiveName` is optional); both routes use the one rule.
    const name =
      (properties['ArchiveName'] as string | undefined) ||
      generatedNameFor('AWS::Events::Archive', logicalId);

    this.logger.debug(mask(`Creating EventBridge archive ${logicalId}: ${name}`));

    let created = false;
    try {
      const input: CreateArchiveCommandInput = { ArchiveName: name, EventSourceArn: sourceArn };
      if (properties['Description'] !== undefined && properties['Description'] !== null) {
        input.Description = properties['Description'] as string;
      }
      const pattern = archiveEventPattern(properties['EventPattern']);
      if (pattern !== undefined) input.EventPattern = pattern;
      if (retentionDays !== undefined) input.RetentionDays = retentionDays;
      if (properties['KmsKeyIdentifier']) {
        input.KmsKeyIdentifier = properties['KmsKeyIdentifier'] as string;
      }

      const createClient = await this.getCreateClient();
      const response = await createClient.send(new CreateArchiveCommand(input));
      created = true;
      reportCreatedResource(logicalId, resourceType, name); // go-to-k/cdkd#5511

      let arn = response.ArchiveArn;
      if (!SETTLED_STATES.has(response.State ?? 'ENABLED')) {
        arn = (await this.waitForSettled(name, logicalId, 'create', mask)) ?? arn;
      }

      return { physicalId: name, attributes: definedAttributes({ Arn: arn }) };
    } catch (error) {
      if (isInterruptedWaitError(error)) throw error;
      const cause = error instanceof Error ? error : undefined;
      let thrown = this.wrapMaskedError(
        mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create EventBridge archive ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            created ? name : undefined,
            cause
          )
      );
      if (created)
        thrown = await this.retireFailedCreate(thrown, logicalId, resourceType, name, mask);
      throw thrown;
    }
  }

  /**
   * An archive CreateArchive made whose create then failed (it reached
   * CREATE_FAILED, or the wait ran out) is deleted here, so it is not left
   * live with no state record (go-to-k/cdkd#2169). When that delete fails
   * too, the error names the survivor for the failed-CREATE journal.
   */
  private async retireFailedCreate(
    thrown: ProvisioningError,
    logicalId: string,
    resourceType: string,
    name: string,
    mask: MaskerFn
  ): Promise<ProvisioningError> {
    try {
      await this.eventBridgeClient.send(new DeleteArchiveCommand({ ArchiveName: name }));
      retractCreatedResource(logicalId, resourceType, name);
      return thrown;
    } catch (cleanupError) {
      if (cleanupError instanceof ResourceNotFoundException) {
        retractCreatedResource(logicalId, resourceType, name);
        return thrown;
      }
      const failure = describeAwsFailure(cleanupError);
      this.logger.debug(
        mask(`Failed to delete archive ${name} after its create failed: ${failure.detail}`)
      );
      this.logger.warn(
        mask(
          safeMsg`EventBridge archive ${logicalId} (${name}) was created but its create failed, and deleting it failed too (${failure.summary}). Delete it before the next deploy: aws events delete-archive --archive-name ${name}`
        )
      );
      return markCreatedBeforeFailure(thrown, logicalId, resourceType, name);
    }
  }

  /**
   * Poll `DescribeArchive` until the archive leaves CREATING / UPDATING: an
   * archive still CREATING records no events yet, and a CREATE_FAILED /
   * UPDATE_FAILED is an outcome the deploy must report. It ends on ENABLED or
   * DISABLED, or on a read that reports no state. Skipped under
   * `CDKD_NO_WAIT` (`--no-wait`). Returns the archive ARN from the last read.
   *
   * A throttled or transient-5xx read keeps polling. Any other read failure
   * ends the wait as a failed create, which deletes the archive: a re-create on
   * the next deploy is accepted over recording an archive whose state cdkd
   * could not read.
   */
  private async waitForSettled(
    name: string,
    logicalId: string,
    operation: 'create' | 'update',
    mask: MaskerFn
  ): Promise<string | undefined> {
    if (process.env['CDKD_NO_WAIT'] === 'true') {
      this.logger.debug(
        mask(
          `Skipping the ${operation} wait for EventBridge archive ${logicalId} (CDKD_NO_WAIT=true)`
        )
      );
      // go-to-k/cdkd#6940: the same wait, run later if the deploy needs it.
      deferReadiness(logicalId, RESOURCE_TYPE, name, (signal) =>
        this.pollUntilSettled(name, logicalId, operation, mask, signal)
      );
      return undefined;
    }
    return this.pollUntilSettled(name, logicalId, operation, mask);
  }

  /** {@link waitForSettled}'s poll, in every mode it runs in. */
  private async pollUntilSettled(
    name: string,
    logicalId: string,
    operation: 'create' | 'update',
    mask: MaskerFn,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    const { pollIntervalMs } = this.stateWait;
    // The deploy's abort of a deferred wait stops the poll at its next sleep.
    const sleep = (ms: number): Promise<void> => abortableSleep(this.stateWait.sleep, ms, signal);
    const userTimeoutMs = resolvedResourceTimeoutMs(RESOURCE_TYPE);
    const timeoutMs =
      userTimeoutMs === undefined
        ? this.stateWait.timeoutMs
        : Math.min(this.stateWait.timeoutMs, userTimeoutMs / 2);
    const deadline = Date.now() + timeoutMs;
    const watch = startInterruptWatch(`EventBridge archive ${logicalId} ${operation} wait`);
    try {
      for (;;) {
        let resp: Awaited<ReturnType<typeof this.describeArchive>>;
        try {
          resp = await this.describeArchive(name);
        } catch (error) {
          if (!isThrottlingError(error) && !isTransientServerError(error)) throw error;
          if (Date.now() >= deadline) throw error;
          this.logger.debug(mask(`EventBridge archive ${name}: state read failed transiently`));
          if (watch.isInterrupted()) throw watch.onInterrupted();
          await sleep(pollIntervalMs);
          continue;
        }
        const state = resp.State;
        if (state === undefined || SETTLED_STATES.has(state)) return resp.ArchiveArn;
        if (FAILED_STATES.has(state)) {
          // AWS's StateReason can quote the caller's identity (a KMS denial
          // names the role), so it goes to debug, never into the thrown
          // message (go-to-k/cdkd#2319).
          if (resp.StateReason) {
            this.logger.debug(
              mask(`EventBridge archive ${logicalId} entered ${state}: ${resp.StateReason}`)
            );
          }
          throw markNonRetryable(
            new ProvisioningError(
              safeMsg`EventBridge archive ${logicalId} entered ${state}.` + verbosePointerTail(),
              RESOURCE_TYPE,
              logicalId,
              name
            )
          );
        }
        if (Date.now() >= deadline) {
          throw markNonRetryable(
            new ProvisioningError(
              `EventBridge archive ${logicalId} was still ${state} ${Math.round(timeoutMs / 1000)}s after the ${operation} call`,
              RESOURCE_TYPE,
              logicalId,
              name
            )
          );
        }
        if (watch.isInterrupted()) throw watch.onInterrupted();
        this.logger.debug(mask(`EventBridge archive ${name} state: ${state}, waiting`));
        await sleep(pollIntervalMs);
      }
    } finally {
      watch.dispose();
    }
  }

  private describeArchive(name: string) {
    return this.eventBridgeClient.send(new DescribeArchiveCommand({ ArchiveName: name }));
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    // The physical id is the archive NAME: a client in another region than
    // the state record would update a same-named archive cdkd does not manage
    // (go-to-k/cdkd#2613). Refused before any call.
    assertRegionMatch(
      context?.expectedRegion ? await this.eventBridgeClient.config.region() : undefined,
      context?.expectedRegion,
      resourceType,
      logicalId,
      physicalId,
      'pre-update'
    );
    const mask = maskerOrIdentity(context?.maskSecrets);
    // A malformed RetentionDays from the template is refused before any call;
    // one carried by a state record (a rollback replay or a drift revert) is
    // left at its live value instead, so the revert still goes through.
    let retentionDays: number | undefined;
    try {
      retentionDays = this.retentionDays(properties, logicalId, physicalId);
    } catch (error) {
      if (context?.replayingState !== true && context?.desiredFromAwsReadback !== true) throw error;
      this.logger.warn(
        safeMsg`${logicalId} (${resourceType}): RetentionDays is not an integer >= 0; the archive keeps its current retention.`
      );
    }

    try {
      const descChanged = properties['Description'] !== previousProperties['Description'];
      const patternChanged =
        eventPatternKey(properties['EventPattern']) !==
        eventPatternKey(previousProperties['EventPattern']);
      const retentionChanged =
        retentionDays !== undefined &&
        retentionDays !== coerceCfnInteger(previousProperties['RetentionDays']);
      const kmsChanged = properties['KmsKeyIdentifier'] !== previousProperties['KmsKeyIdentifier'];

      if (!descChanged && !patternChanged && !retentionChanged && !kmsChanged) {
        return { physicalId, wasReplaced: false, attributes: {} };
      }

      this.logger.debug(mask(`Updating EventBridge archive ${logicalId}: ${physicalId}`));
      const input: UpdateArchiveCommandInput = { ArchiveName: physicalId };
      if (properties['Description'] !== undefined && properties['Description'] !== null) {
        input.Description = properties['Description'] as string;
      }
      const pattern = archiveEventPattern(properties['EventPattern']);
      if (pattern !== undefined) input.EventPattern = pattern;
      if (retentionDays !== undefined) input.RetentionDays = retentionDays;
      if (properties['KmsKeyIdentifier'] !== undefined && properties['KmsKeyIdentifier'] !== null) {
        input.KmsKeyIdentifier = properties['KmsKeyIdentifier'] as string;
      }
      const response = await this.eventBridgeClient.send(new UpdateArchiveCommand(input));
      let arn = response.ArchiveArn;
      if (!SETTLED_STATES.has(response.State ?? 'ENABLED')) {
        arn = (await this.waitForSettled(physicalId, logicalId, 'update', mask)) ?? arn;
      }
      return { physicalId, wasReplaced: false, attributes: definedAttributes({ Arn: arn }) };
    } catch (error) {
      if (error instanceof CdkdError || isInterruptedWaitError(error)) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapMaskedError(
        mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update EventBridge archive ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  /**
   * `DeleteArchive`. The API has no deleting state: the archive is gone from
   * `DescribeArchive` once the call returns, so there is no wait. AWS removes
   * the archive's managed rule on the event bus afterwards, which the
   * EventBus provider's delete waits out.
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(safeMsg`Deleting EventBridge archive ${logicalId}: ${physicalId}`);
    const mask = maskerOrIdentity(context?.maskSecrets);
    // The physical id is the archive NAME, the same in every region: a client
    // in another region than the record would delete a same-named archive cdkd
    // does not manage. Refused before the call.
    assertRegionMatch(
      context?.expectedRegion ? await this.eventBridgeClient.config.region() : undefined,
      context?.expectedRegion,
      resourceType,
      logicalId,
      physicalId,
      'pre-delete'
    );
    try {
      await this.eventBridgeClient.send(new DeleteArchiveCommand({ ArchiveName: physicalId }));
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.eventBridgeClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(safeMsg`EventBridge archive ${physicalId} does not exist, skipping`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      const failure = this.wrapMaskedError(
        mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete EventBridge archive ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
      // Only the typed not-found above means this archive is gone.
      throw error instanceof Error && error.name.includes('NotFound')
        ? markNotGone(failure)
        : failure;
    }
  }

  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName !== 'Arn') return undefined;
    const resp = await this.eventBridgeClient.send(
      new DescribeArchiveCommand({ ArchiveName: physicalId })
    );
    return resp.ArchiveArn;
  }

  /**
   * The archive as `DescribeArchive` reports it, in CFn property shape.
   * `EventPattern` is parsed back to an object (state holds it the way the
   * template wrote it; the comparator reads an object and a JSON string of it
   * alike). `Description`, `RetentionDays` and `KmsKeyIdentifier` always emit
   * the value an archive without them holds (`''`, `0`, `''`), so a console
   * change on an archive that declared none still reads as drift. A property
   * REMOVED from the template stays live (update sends only declared fields,
   * as CloudFormation does), so drift keeps reporting its live value until it
   * is cleared by hand; `--revert` cannot clear it either.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    try {
      const resp = await this.eventBridgeClient.send(
        new DescribeArchiveCommand({ ArchiveName: physicalId })
      );
      const result: Record<string, unknown> = {};
      if (resp.ArchiveName !== undefined) result['ArchiveName'] = resp.ArchiveName;
      if (resp.EventSourceArn !== undefined) result['SourceArn'] = resp.EventSourceArn;
      result['Description'] = resp.Description ?? '';
      if (resp.EventPattern !== undefined && resp.EventPattern !== '') {
        try {
          result['EventPattern'] = JSON.parse(resp.EventPattern) as unknown;
        } catch {
          result['EventPattern'] = resp.EventPattern;
        }
      }
      result['RetentionDays'] = resp.RetentionDays ?? 0;
      result['KmsKeyIdentifier'] = resp.KmsKeyIdentifier ?? '';
      return result;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
      throw err;
    }
  }

  /**
   * Adopt an existing archive into cdkd state: the `--resource` override or
   * `Properties.ArchiveName`, verified by `DescribeArchive`.
   *
   * No lookup without a name. Archives carry no tags, so no `aws:cdk:path`
   * tag can tell this stack's archive from another's; a `ListArchives` filter
   * on the event source would adopt whichever archive happens to sit on a
   * shared bus (the default one, say), which a later destroy would delete. A
   * generated name needs an explicit `--resource` override.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'ArchiveName');
    if (!explicit) return null;
    try {
      const resp = await this.eventBridgeClient.send(
        new DescribeArchiveCommand({ ArchiveName: explicit })
      );
      return { physicalId: explicit, attributes: definedAttributes({ Arn: resp.ArchiveArn }) };
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return null;
      throw err;
    }
  }
}
