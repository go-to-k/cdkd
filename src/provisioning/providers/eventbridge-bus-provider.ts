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
  TagResourceCommand,
  UntagResourceCommand,
  ResourceNotFoundException,
  type Tag,
} from '@aws-sdk/client-eventbridge';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

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
 * `update()`. AWS rejects `DeadLetterConfig: { Arn: '' }` as an invalid
 * ARN, so this Class 2 sanitiser drops the placeholder before it reaches
 * the API: empty-string / null / undefined `Arn` returns `undefined`
 * (caller treats this as "do not send the DeadLetterConfig field"); a
 * real ARN passes through unchanged.
 */
function sanitizeDeadLetterConfig(value: unknown): { Arn: string } | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object') return undefined;
  const arn = (value as Record<string, unknown>)['Arn'];
  if (typeof arn !== 'string' || arn.length === 0) return undefined;
  return { Arn: arn };
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

  constructor() {
    this.eventBridgeClient = getAwsClients().eventBridge;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    const name = properties['Name'] as string;
    if (!name) {
      throw new ProvisioningError(
        `Name is required for EventBus ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    this.logger.debug(`Creating EventBus ${logicalId}: ${name}`);

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
      if (properties['Tags']) {
        createParams.Tags = properties['Tags'] as Tag[];
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

      const response = await this.eventBridgeClient.send(new CreateEventBusCommand(createParams));

      const eventBusArn = response.EventBusArn ?? '';

      // Apply Policy if specified (must be done after creation)
      if (properties['Policy']) {
        // EventBridge uses PutPermission for policies, but for simplicity
        // we note it in handledProperties. The CC API fallback handles complex policies.
      }

      return {
        physicalId: name,
        attributes: {
          Arn: eventBusArn,
          Name: name,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create EventBus ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  async update(
    _logicalId: string,
    physicalId: string,
    _resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating EventBus ${_logicalId}: ${physicalId}`);

    // Update mutable properties (Description, KmsKeyIdentifier, DeadLetterConfig, LogConfig)
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
      }
      if (properties['LogConfig'] !== undefined) {
        updateParams.LogConfig = properties[
          'LogConfig'
        ] as import('@aws-sdk/client-eventbridge').LogConfig;
      }
      await this.eventBridgeClient.send(new UpdateEventBusCommand(updateParams));
    }

    // Update Tags if changed
    const newTags = properties['Tags'] as Tag[] | undefined;
    const oldTags = previousProperties['Tags'] as Tag[] | undefined;
    if (JSON.stringify(newTags) !== JSON.stringify(oldTags)) {
      // Get ARN for tagging
      const describeResponse = await this.eventBridgeClient.send(
        new DescribeEventBusCommand({ Name: physicalId })
      );
      const busArn = describeResponse.Arn;
      if (busArn) {
        // Remove old tags
        if (oldTags && oldTags.length > 0) {
          const oldTagKeys = oldTags.map((t) => t.Key).filter((k): k is string => !!k);
          if (oldTagKeys.length > 0) {
            await this.eventBridgeClient.send(
              new UntagResourceCommand({
                ResourceARN: busArn,
                TagKeys: oldTagKeys,
              })
            );
          }
        }
        // Apply new tags
        if (newTags && newTags.length > 0) {
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

    try {
      // First, clean up all rules on this bus (they block deletion)
      await this.cleanupRulesOnBus(physicalId);

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
      const msg = error instanceof Error ? error.message : String(error);
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
      throw new ProvisioningError(
        `Failed to delete EventBus ${logicalId}: ${msg}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
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
   */
  private async cleanupRulesOnBus(busName: string): Promise<void> {
    try {
      const rulesResponse = await this.eventBridgeClient.send(
        new ListRulesCommand({ EventBusName: busName })
      );

      const rules = rulesResponse.Rules ?? [];
      if (rules.length === 0) return;

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
      if (error instanceof ResourceNotFoundException) return;
      this.logger.debug(
        `Failed to list rules on bus ${busName}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
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
   * Returns `undefined` when the bus is gone (`ResourceNotFoundException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
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
          if (err instanceof ResourceNotFoundException) return undefined;
          throw err;
        }
      }
      return result;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
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
