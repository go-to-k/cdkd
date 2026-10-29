import {
  EventBridgeClient,
  CreateEventBusCommand,
  DeleteEventBusCommand,
  UpdateEventBusCommand,
  DescribeEventBusCommand,
  ListRulesCommand,
  ListTagsForResourceCommand,
  RemoveTargetsCommand,
  DeleteRuleCommand,
  ListTargetsByRuleCommand,
  PutPermissionCommand,
  TagResourceCommand,
  UntagResourceCommand,
  ResourceNotFoundException,
  type Tag,
} from '@aws-sdk/client-eventbridge';
import { getLogger } from '../../utils/logger.js';
import { safeMsg } from '../../utils/display-safe.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';
import { CdkdError, ProvisioningError } from '../../utils/error-handler.js';
import {
  isAuxiliaryFailure,
  markAuxiliaryFailure,
  markCreatedBeforeFailure,
} from '../auxiliary-failure.js';
import { reportCreatedResource } from '../created-resource-sink.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import { maskerOrIdentity, type MaskerFn } from '../masked-retry-logger.js';
import { markDeleteStarted } from '../delete-started.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { markNotGone } from '../not-gone.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../tag-list.js';
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
import { withRemovalDefaults } from '../update-removal.js';

/**
 * Sanitise a CFn-shape `DeadLetterConfig` (object with optional `Arn`) for
 * the EventBridge `CreateEventBus` / `UpdateEventBus` API.
 *
 * `readCurrentState` always-emits `DeadLetterConfig: { Arn: '' }` on buses
 * without a DLQ — the comparator's top-level walk is state-keys-only, so
 * the placeholder is required to detect a console-side DLQ attach (state
 * `{Arn:''}` vs AWS `{Arn:'real-arn'}`).
 *
 * `cdkd drift --revert` later round-trips that placeholder back through
 * `update()`. `UpdateEventBus` reads `DeadLetterConfig: { Arn: '' }` as
 * "remove the DLQ", so this Class 2 sanitiser drops the placeholder before
 * it reaches the API: empty-string / null / undefined `Arn` returns
 * `undefined` (caller treats this as "do not send the DeadLetterConfig
 * field"); a real ARN passes through unchanged. A template REMOVAL sends
 * that clear on purpose instead (`applyUpdate`, issue #1160).
 */
function sanitizeDeadLetterConfig(value: unknown): { Arn: string } | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object') return undefined;
  const arn = (value as Record<string, unknown>)['Arn'];
  if (typeof arn !== 'string' || arn.length === 0) return undefined;
  return { Arn: arn };
}

/**
 * The `PutPermission` `Policy` document for a declared EventBus `Policy`
 * (issue #5044). The template may carry the document as an object or as a JSON
 * string; the API takes a string. `undefined` when no document is declared.
 */
function policyDocument(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * A comparison key for a `Policy` value, so the same document spelled once as
 * an object and once as a JSON string, or with its keys in another order,
 * compares equal. Array order is kept: statement order is the template's.
 */
function policyKey(value: unknown): string | undefined {
  const doc = policyDocument(value);
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

/**
 * SDK Provider for AWS::Events::EventBus
 *
 * Uses direct SDK calls instead of Cloud Control API because:
 * - CC API deletes EventBus in parallel with Rules on the same bus
 * - EventBridge rejects EventBus deletion while Rules still exist
 * - SDK Provider ensures all Rules+Targets are cleaned up before bus deletion
 */
export class EventBridgeBusProvider implements ResourceProvider {
  private eventBridgeClient: EventBridgeClient;
  private logger = getLogger().child('EventBridgeBusProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Events::EventBus',
      new Set([
        'Name',
        'Tags',
        'EventSourceName',
        'Description',
        'KmsKeyIdentifier',
        'Policy',
        'DeadLetterConfig',
        'LogConfig',
      ]),
    ],
  ]);

  /**
   * Issue #1160: `UpdateEventBus` keeps any field it is not given, while a
   * CloudFormation update that removes one of these clears it (real A/B,
   * us-east-1: the readback afterwards has no Description, the AWS owned key,
   * and LogConfig `OFF` / `NONE`). Each value is what clears it on the API.
   * A removed `DeadLetterConfig` is cleared in {@link applyUpdate}, since its
   * clear value is one the sanitiser otherwise drops. `Policy` has no entry:
   * CloudFormation leaves the live policy in place when it is removed (#5044).
   */
  removalDefaults = new Map<string, ReadonlyMap<string, unknown>>([
    [
      'AWS::Events::EventBus',
      new Map<string, unknown>([
        ['Description', ''],
        ['KmsKeyIdentifier', ''],
        ['LogConfig', { Level: 'OFF', IncludeDetail: 'NONE' }],
      ]),
    ],
  ]);

  constructor() {
    this.eventBridgeClient = getAwsClients().eventBridge;
  }

  private createClient: Promise<EventBridgeClient> | undefined;

  /**
   * The client `CreateEventBus` goes through (issue #4639): SDK retries on,
   * except a 5xx (`withoutServerErrorRetries`). Separate so every other call
   * keeps the full SDK retry.
   *
   * `CreateEventBus` carries no idempotency token, and a bus name is unique
   * per account and region, so the SDK's own replay of a 5xx whose request
   * EventBridge completed fails `ResourceAlreadyExistsException` against the
   * bus the first request made -- inside one `send`, where the deploy engine
   * cannot see it, so it credits the collision to another holder. Refused
   * here, the 5xx reaches the engine's retry, which marks a later collision as
   * possibly this create's own (`withRetry`, #3978).
   *
   * Built in the shared client's REGION (read from it, as `config.region()`
   * resolves it). The PROMISE is cached, so two creates on a cold provider
   * build one client; a rejected region read is not cached, so the next
   * create retries it. A shared client that is not an `EventBridgeClient` --
   * a unit-test double -- is used as is: `AwsClients` always supplies a real
   * one.
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
   * Wrap what create / update / delete caught into the error it throws, keeping the
   * caller's identity out of the thrown message (go-to-k/cdkd#2319, the Glue
   * provider's `wrapGlueError` shape). A thrown message is persisted to
   * `deployments/{runId}.jsonl`, and an `AccessDeniedException` from
   * `PutPermission` or `UpdateEventBus` names the assumed-role ARN. So an
   * AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
   * pointer, and AWS's own text goes to `debug` through the masker. A
   * cdkd-authored or transport error keeps its text (`wrapMaskedAwsError`), and
   * so does a non-`Error` throw, which AWS did not author: its text is the
   * conversion `describeAwsFailure` makes, which never throws. `build` must
   * thread `error` as `cause`, so the retry classifiers still read the withheld
   * text through the redacted-cause stamp; it runs twice, so it must stay a
   * side-effect-free constructor call. An "already exists" (a taken bus name)
   * is restated ({@link relayedNameCollision}), except from a post-create step
   * (`markAuxiliaryFailure`), where "it" would read as the bus just created.
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
    const relay = isAuxiliaryFailure(error) ? '' : relayedNameCollision(failure.detail);
    return markRedactedCause(build(`${mask(failure.summary)}${relay}`));
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
    const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);
    const name = properties['Name'] as string;
    if (!name) {
      throw new ProvisioningError(
        `Name is required for EventBus ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    this.logger.debug(`Creating EventBus ${logicalId}: ${name}`);

    let busCreated = false;
    try {
      const createParams: import('@aws-sdk/client-eventbridge').CreateEventBusCommandInput = {
        Name: name,
      };
      if (properties['EventSourceName']) {
        createParams.EventSourceName = properties['EventSourceName'] as string;
      }
      if (properties['Description']) {
        createParams.Description = properties['Description'] as string;
      }
      if (properties['KmsKeyIdentifier']) {
        createParams.KmsKeyIdentifier = properties['KmsKeyIdentifier'] as string;
      }
      if (properties['Tags'] !== undefined && properties['Tags'] !== null) {
        createParams.Tags = tags;
      }
      const dlcCreate = sanitizeDeadLetterConfig(properties['DeadLetterConfig']);
      if (dlcCreate) {
        createParams.DeadLetterConfig = dlcCreate;
      }
      if (properties['LogConfig'] !== undefined) {
        createParams.LogConfig = properties[
          'LogConfig'
        ] as import('@aws-sdk/client-eventbridge').LogConfig;
      }

      const createClient = await this.getCreateClient();
      const response = await createClient.send(new CreateEventBusCommand(createParams));
      busCreated = true;
      reportCreatedResource(logicalId, resourceType, name); // go-to-k/cdkd#5511

      // Issue #5044: the bus resource policy is a separate call, as
      // CloudFormation makes it (`PutPermission` with the whole document).
      const policy = policyDocument(properties['Policy']);
      if (policy !== undefined) {
        await this.eventBridgeClient.send(
          new PutPermissionCommand({ EventBusName: name, Policy: policy })
        );
      }

      return {
        physicalId: name,
        attributes: definedAttributes({
          Arn: response.EventBusArn,
          Name: name,
        }),
      };
    } catch (error) {
      if (busCreated) markAuxiliaryFailure(error, logicalId);
      const cause = error instanceof Error ? error : undefined;
      const thrown = this.wrapMaskedError(
        maskerOrIdentity(context?.maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create EventBus ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            busCreated ? name : undefined,
            cause
          )
      );
      // go-to-k/cdkd#4583: the bus exists with no state record once
      // CreateEventBus has returned; name it for the failed-CREATE journal.
      if (busCreated) markCreatedBeforeFailure(thrown, logicalId, resourceType, name);
      throw thrown;
    }
  }

  /**
   * Update an EventBus.
   *
   * Thin wrapper that maps any AWS SDK failure onto {@link ProvisioningError}
   * the same way {@link create} and {@link delete} do, so an update failure
   * carries cdkd's typed error formatting and exit-code handling instead of
   * surfacing raw (issue #1267). The body lives in {@link applyUpdate} so the
   * wrap is a boundary concern rather than a 70-line indentation change.
   *
   * A typed control-flow error is re-thrown untouched: the deploy engine
   * matches those by class to decide its fallback, so swallowing one into a
   * ProvisioningError would silently disable that path.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    // go-to-k/cdkd#2613: the physical id is the bus NAME, so a client in another region than
    // the state record would update and retag a same-named bus cdkd does not manage. Outside
    // the try: a refusal is not an AWS failure to re-label. Refuse before any call; the
    // client's region is resolved only when there is one to compare with.
    assertRegionMatch(
      context?.expectedRegion ? await this.eventBridgeClient.config.region() : undefined,
      context?.expectedRegion,
      resourceType,
      logicalId,
      physicalId,
      'pre-update'
    );
    // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
    refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
    properties = withRemovalDefaults(
      this.removalDefaults,
      resourceType,
      properties,
      previousProperties,
      context
    );
    try {
      return await this.applyUpdate(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context
      );
    } catch (error) {
      // Pass through every cdkd-typed error untouched: ResourceUpdateNotSupportedError
      // is control flow the deploy engine matches BY CLASS, and a ProvisioningError
      // raised deeper in the body already carries better context than a re-wrap.
      if (error instanceof CdkdError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapMaskedError(
        maskerOrIdentity(context?.maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update EventBus ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  private async applyUpdate(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context: UpdateContext | undefined
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating EventBus ${logicalId}: ${physicalId}`);

    // Update mutable properties (Description, KmsKeyIdentifier, DeadLetterConfig, LogConfig).
    // A REMOVED Description / KmsKeyIdentifier / LogConfig arrives as its
    // `removalDefaults` clear value.
    const descChanged = properties['Description'] !== previousProperties['Description'];
    const kmsChanged = properties['KmsKeyIdentifier'] !== previousProperties['KmsKeyIdentifier'];
    const dlcChanged =
      JSON.stringify(properties['DeadLetterConfig']) !==
      JSON.stringify(previousProperties['DeadLetterConfig']);
    const logCfgChanged =
      JSON.stringify(properties['LogConfig']) !== JSON.stringify(previousProperties['LogConfig']);

    if (descChanged || kmsChanged || dlcChanged || logCfgChanged) {
      const updateParams: import('@aws-sdk/client-eventbridge').UpdateEventBusCommandInput = {
        Name: physicalId,
      };
      if (properties['Description'] !== undefined) {
        updateParams.Description = properties['Description'] as string;
      }
      if (properties['KmsKeyIdentifier'] !== undefined) {
        updateParams.KmsKeyIdentifier = properties['KmsKeyIdentifier'] as string;
      }
      if (properties['DeadLetterConfig'] !== undefined) {
        const dlcUpdate = sanitizeDeadLetterConfig(properties['DeadLetterConfig']);
        if (dlcUpdate) {
          updateParams.DeadLetterConfig = dlcUpdate;
        }
      } else if (
        // Issue #1160: a DeadLetterConfig the previous template declared and
        // this one omits is cleared, as CloudFormation does; `{ Arn: '' }` is
        // the API's "remove the DLQ". The caller's `removedProperties` decides
        // (EMPTY on `drift --revert`, whose baseline is a readback); a direct
        // call reads the previous bag. A previous value with no real ARN set
        // no DLQ, so there is nothing to clear.
        (context?.removedProperties?.has('DeadLetterConfig') ??
          previousProperties['DeadLetterConfig'] !== undefined) &&
        sanitizeDeadLetterConfig(previousProperties['DeadLetterConfig']) !== undefined
      ) {
        updateParams.DeadLetterConfig = { Arn: '' };
      }
      if (properties['LogConfig'] !== undefined) {
        updateParams.LogConfig = properties[
          'LogConfig'
        ] as import('@aws-sdk/client-eventbridge').LogConfig;
      }
      await this.eventBridgeClient.send(new UpdateEventBusCommand(updateParams));
    }

    // Issue #5044: a CHANGED Policy replaces the bus's whole resource policy,
    // as CloudFormation does (real A/B: statements a separate
    // AWS::Events::EventBusPolicy added are wiped too; CFn does not merge). An
    // UNCHANGED Policy sends nothing, so those statements survive an update
    // made for another property. The previous side is the RECORDED template,
    // which keeps a secret-derived leaf as its `{{resolve:...}}` reference
    // while the desired side is resolved, so such a Policy always reads as
    // changed and is re-put: the declared document is applied rather than a
    // re-pointed reference being skipped (`onlySecretReferencesDiffer` cannot
    // tell the two apart on its own). A Policy REMOVED from the template is
    // left live, as CloudFormation leaves it, which is why `removalDefaults`
    // has no entry for it.
    const policy = policyDocument(properties['Policy']);
    if (policy !== undefined && policyKey(policy) !== policyKey(previousProperties['Policy'])) {
      await this.eventBridgeClient.send(
        new PutPermissionCommand({ EventBusName: physicalId, Policy: policy })
      );
    } else if (
      policy === undefined &&
      (context?.removedProperties?.has('Policy') ??
        policyDocument(previousProperties['Policy']) !== undefined)
    ) {
      this.logger.warn(
        safeMsg`${logicalId} (${resourceType}): Policy was removed from the template; the bus keeps its current resource policy, as CloudFormation leaves it. Remove its statements with 'aws events remove-permission' if they should go.`
      );
    }

    // Update Tags if changed. Both sides are read through `planTagDiff`
    // (go-to-k/cdkd#3994): an unreadable record untags nothing.
    const plan = planTagDiff(previousProperties['Tags'], properties['Tags']);
    // Warn before the write gate: an unreadable or secret-derived record can
    // leave nothing to set or remove, and the ARN lookup below is only for writes.
    const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
    if (tagWarning !== undefined) {
      this.logger.warn(tagWarning);
    }
    if (plan.set.size > 0 || plan.remove.length > 0) {
      // Get ARN for tagging
      const describeResponse = await this.eventBridgeClient.send(
        new DescribeEventBusCommand({ Name: physicalId })
      );
      const busArn = describeResponse.Arn;
      if (busArn) {
        // Remove tags the desired side no longer names
        if (plan.remove.length > 0) {
          await this.eventBridgeClient.send(
            new UntagResourceCommand({
              ResourceARN: busArn,
              TagKeys: plan.remove,
            })
          );
        }
        // Apply new or changed tags
        if (plan.set.size > 0) {
          const newTags: Tag[] = [...plan.set].map(([Key, Value]) => ({ Key, Value }));
          await this.eventBridgeClient.send(
            new TagResourceCommand({
              ResourceARN: busArn,
              Tags: newTags,
            })
          );
        }
        this.logger.debug(`Updated tags for EventBus ${physicalId}`);
      }
    }

    return { physicalId, wasReplaced: false, attributes: {} };
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting EventBus ${logicalId}: ${physicalId}`);
    // go-to-k/cdkd#4946: set once the cleanup has sent a rule or target
    // removal, so a refused `DeleteEventBus` is never read as a whole survivor.
    let stripped = false;

    try {
      // First, clean up all rules on this bus (they block deletion)
      stripped = await this.cleanupRulesOnBus(physicalId);

      // Then delete the bus
      await this.eventBridgeClient.send(new DeleteEventBusCommand({ Name: physicalId }));
      this.logger.debug(`Successfully deleted EventBus ${logicalId}`);
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
        this.logger.debug(`EventBus ${physicalId} does not exist, skipping`);
        return;
      }
      // `.detail`, never `.summary`: the substring test below is what keeps this
      // degradation alive, and it matches AWS's OWN wording. The thrown wrap
      // further down names an AWS failure by its class instead
      // (go-to-k/cdkd#2319).
      const msg = describeAwsFailure(error).detail;
      if (msg.includes('does not exist')) {
        const clientRegion = await this.eventBridgeClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`EventBus ${physicalId} does not exist, skipping`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      const failure = this.wrapMaskedError(
        maskerOrIdentity(context?.maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete EventBus ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
      // The wrap names an AWS failure by its CLASS, which the delete classifiers
      // read as "already deleted" on a `NotFound` needle: only the typed
      // not-found above means this bus is gone (go-to-k/cdkd#2319).
      const marked =
        error instanceof Error && error.name.includes('NotFound') ? markNotGone(failure) : failure;
      throw stripped ? markDeleteStarted(marked) : marked;
    }
  }

  getAttribute(physicalId: string, _resourceType: string, attributeName: string): Promise<unknown> {
    if (attributeName === 'Arn') {
      // Can't construct ARN without region/account, return physicalId
      return Promise.resolve(undefined);
    }
    if (attributeName === 'Name') {
      return Promise.resolve(physicalId);
    }
    return Promise.resolve(undefined);
  }

  /**
   * Remove all rules and their targets from an event bus before deletion.
   * Returns whether it found any rule to remove (and so may have removed one).
   */
  private async cleanupRulesOnBus(busName: string): Promise<boolean> {
    let found = false;
    try {
      const rulesResponse = await this.eventBridgeClient.send(
        new ListRulesCommand({ EventBusName: busName })
      );

      const rules = rulesResponse.Rules ?? [];
      if (rules.length === 0) return false;
      found = true;

      this.logger.debug(`Cleaning up ${rules.length} rule(s) on bus ${busName}`);

      for (const rule of rules) {
        if (!rule.Name) continue;

        // Remove targets first
        try {
          const targetsResponse = await this.eventBridgeClient.send(
            new ListTargetsByRuleCommand({
              Rule: rule.Name,
              EventBusName: busName,
            })
          );

          const targetIds = (targetsResponse.Targets ?? [])
            .map((t) => t.Id)
            .filter((id): id is string => !!id);

          if (targetIds.length > 0) {
            await this.eventBridgeClient.send(
              new RemoveTargetsCommand({
                Rule: rule.Name,
                EventBusName: busName,
                Ids: targetIds,
              })
            );
          }
        } catch {
          // Best-effort target removal
        }

        // Delete the rule
        try {
          await this.eventBridgeClient.send(
            new DeleteRuleCommand({
              Name: rule.Name,
              EventBusName: busName,
            })
          );
        } catch {
          // Best-effort rule removal
        }
      }
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return found;
      this.logger.debug(
        `Failed to list rules on bus ${busName}: ${describeAwsFailure(error).detail}`
      );
    }
    return found;
  }

  /**
   * Read the AWS-current EventBus configuration in CFn-property shape.
   *
   * Issues `DescribeEventBus` and surfaces `Name`, `Description`,
   * `KmsKeyIdentifier`, `DeadLetterConfig`, and `Policy` (the latter is a
   * JSON string in `DescribeEventBus.Policy`; cdkd state holds it the way
   * the user typed it, which may be either an object or a string — the
   * comparator handles either side).
   *
   * `Tags` is surfaced via a follow-up `ListTagsForResource` call (using the
   * bus ARN from the same `DescribeEventBus` response). CDK's `aws:*`
   * auto-tags are filtered out; the result key is omitted when AWS reports
   * no user tags.
   *
   * `EventSourceName` is intentionally omitted: it is set at create time
   * only and not surfaced by `DescribeEventBus`.
   *
   * Returns `RESOURCE_NOT_FOUND` when the bus is gone (`ResourceNotFoundException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    try {
      const resp = await this.eventBridgeClient.send(
        new DescribeEventBusCommand({ Name: physicalId })
      );
      const result: Record<string, unknown> = {};
      if (resp.Name !== undefined) result['Name'] = resp.Name;
      result['Description'] = resp.Description ?? '';
      result['KmsKeyIdentifier'] = resp.KmsKeyIdentifier ?? '';
      result['DeadLetterConfig'] = { Arn: resp.DeadLetterConfig?.Arn ?? '' };
      // LogConfig: emit-when-present (NOT the always-emit-placeholder
      // pattern). AWS returns LogConfig only when set; a never-configured
      // bus does not get a phantom `{ Level: 'OFF', IncludeDetail: 'NONE' }`
      // placeholder that would round-trip into spurious drift.
      if (resp.LogConfig !== undefined) {
        const lc: Record<string, unknown> = {};
        if (resp.LogConfig.IncludeDetail !== undefined)
          lc['IncludeDetail'] = resp.LogConfig.IncludeDetail;
        if (resp.LogConfig.Level !== undefined) lc['Level'] = resp.LogConfig.Level;
        if (Object.keys(lc).length > 0) result['LogConfig'] = lc;
      }
      if (resp.Policy) {
        try {
          result['Policy'] = JSON.parse(resp.Policy) as unknown;
        } catch {
          result['Policy'] = resp.Policy;
        }
      }
      // Tags via ListTagsForResource (needs the bus ARN that DescribeEventBus
      // just returned).
      if (resp.Arn) {
        try {
          const tagsResp = await this.eventBridgeClient.send(
            new ListTagsForResourceCommand({ ResourceARN: resp.Arn })
          );
          const tags = normalizeAwsTagsToCfn(tagsResp.Tags);
          result['Tags'] = tags;
        } catch (err) {
          if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
          throw err;
        }
      }
      return result;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
      throw err;
    }
  }

  /**
   * Adopt an existing EventBridge event bus into cdkd state.
   *
   * Lookup order:
   *  1. `--resource` override or `Properties.Name` → verify via `DescribeEventBus`.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'Name');
    if (explicit) {
      try {
        await this.eventBridgeClient.send(new DescribeEventBusCommand({ Name: explicit }));
        return { physicalId: explicit, attributes: {} };
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so that
    // tag never exists on a real resource and the walk could not match (issue
    // #1134). Auto-mode import resolves ids from CloudFormation's
    // DescribeStackResources or the template's physical-name property; an event
    // bus reaching here needs an explicit `--resource` override.
    return null;
  }
}
