import {
  EventBridgeClient,
  DescribeRuleCommand,
  ListTargetsByRuleCommand,
  ListTagsForResourceCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-eventbridge';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { type DeleteContext } from '../region-check.js';
import { generatedNameFor } from '../resource-name.js';
import { lookupEachName } from '../name-lookup.js';
import { normalizeAwsTagsToCfn } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  ResourceNotFound,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import { type MaskerFn } from '../masked-retry-logger.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import { create } from './eventbridge-rule/create.js';
import { update } from './eventbridge-rule/update.js';
import { deleteImpl } from './eventbridge-rule/delete.js';

/**
 * Target definition from CloudFormation AWS::Events::Rule
 */
export interface RuleTarget {
  Id: string;
  Arn: string;
  Input?: string;
  InputPath?: string;
  InputTransformer?: {
    InputPathsMap?: Record<string, string>;
    InputTemplate: string;
  };
  RoleArn?: string;
  [key: string]: unknown;
}

/**
 * AWS EventBridge Rule Provider
 *
 * Implements resource provisioning for AWS::Events::Rule using the EventBridge SDK.
 * Cloud Control manages the type correctly, a Rule with Targets included
 * (re-measured for issue #4091), so it is NOT a `'cc-broken'` sticky exemption;
 * an earlier "CC create with Targets throws NullPointerException" note no longer
 * held.
 */
export class EventBridgeRuleProvider implements ResourceProvider {
  eventBridgeClient: EventBridgeClient;
  logger: ConsoleLogger = getLogger().child('EventBridgeRuleProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Events::Rule',
      new Set([
        'Name',
        'Description',
        'EventBusName',
        'EventPattern',
        'State',
        'ScheduleExpression',
        'RoleArn',
        'Targets',
        'Tags',
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.eventBridgeClient = awsClients.eventBridge;
  }

  /**
   * Convert each target's CFn-shaped `EcsParameters` to the SDK shape
   * (issue #1381). The `AWS::Events::Rule` schema and
   * `@aws-sdk/client-eventbridge` diverge on several ECS sub-shape
   * spellings, and the SDK serializer silently drops unknown keys — a
   * Fargate target's `NetworkConfiguration.AwsVpcConfiguration` never
   * reached AWS, so PutTargets rejected with "Parameter
   * NetworkConfiguration must be specified".
   */
  toSdkTargets(targets: RuleTarget[]): RuleTarget[] {
    return targets.map((target) => {
      const ecs = target['EcsParameters'] as Record<string, unknown> | undefined;
      if (!ecs) return target;
      return { ...target, EcsParameters: this.toSdkEcsParameters(ecs) };
    });
  }

  private toSdkEcsParameters(ecs: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = { ...ecs };
    const network = result['NetworkConfiguration'] as Record<string, unknown> | undefined;
    if (network && network['AwsVpcConfiguration'] !== undefined) {
      const { AwsVpcConfiguration, ...restNetwork } = network;
      result['NetworkConfiguration'] = {
        ...restNetwork,
        awsvpcConfiguration: AwsVpcConfiguration,
      };
    }
    if (result['TagList'] !== undefined) {
      result['Tags'] = result['TagList'];
      delete result['TagList'];
    }
    if (Array.isArray(result['PlacementStrategies'])) {
      result['PlacementStrategy'] = (
        result['PlacementStrategies'] as Record<string, unknown>[]
      ).map((item) => this.lowerCaseItemKeys(item, ['Type', 'Field']));
      delete result['PlacementStrategies'];
    }
    if (Array.isArray(result['PlacementConstraints'])) {
      result['PlacementConstraints'] = (
        result['PlacementConstraints'] as Record<string, unknown>[]
      ).map((item) => this.lowerCaseItemKeys(item, ['Type', 'Expression']));
    }
    if (Array.isArray(result['CapacityProviderStrategy'])) {
      result['CapacityProviderStrategy'] = (
        result['CapacityProviderStrategy'] as Record<string, unknown>[]
      ).map((item) => this.lowerCaseItemKeys(item, ['CapacityProvider', 'Weight', 'Base']));
    }
    return result;
  }

  /**
   * Inverse of {@link toSdkEcsParameters} for `readCurrentState`:
   * ListTargetsByRule returns the SDK spellings, but drift compares the
   * whole `Targets` array against state's CFn spellings — without the
   * re-map every ECS Fargate rule target would report phantom drift on
   * `AwsVpcConfiguration` / `TagList` / `PlacementStrategies` under the
   * `properties`-fallback baseline.
   */
  private toCfnTargets(targets: RuleTarget[]): RuleTarget[] {
    return targets.map((target) => {
      const ecs = target['EcsParameters'] as Record<string, unknown> | undefined;
      if (!ecs) return target;
      return { ...target, EcsParameters: this.toCfnEcsParameters(ecs) };
    });
  }

  private toCfnEcsParameters(ecs: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = { ...ecs };
    const network = result['NetworkConfiguration'] as Record<string, unknown> | undefined;
    if (network && network['awsvpcConfiguration'] !== undefined) {
      const { awsvpcConfiguration, ...restNetwork } = network;
      result['NetworkConfiguration'] = {
        ...restNetwork,
        AwsVpcConfiguration: awsvpcConfiguration,
      };
    }
    if (result['Tags'] !== undefined) {
      result['TagList'] = result['Tags'];
      delete result['Tags'];
    }
    if (Array.isArray(result['PlacementStrategy'])) {
      result['PlacementStrategies'] = (
        result['PlacementStrategy'] as Record<string, unknown>[]
      ).map((item) => this.renameItemKeys(item, ['type', 'field'], 'upper'));
      delete result['PlacementStrategy'];
    }
    if (Array.isArray(result['PlacementConstraints'])) {
      result['PlacementConstraints'] = (
        result['PlacementConstraints'] as Record<string, unknown>[]
      ).map((item) => this.renameItemKeys(item, ['type', 'expression'], 'upper'));
    }
    if (Array.isArray(result['CapacityProviderStrategy'])) {
      result['CapacityProviderStrategy'] = (
        result['CapacityProviderStrategy'] as Record<string, unknown>[]
      ).map((item) => this.renameItemKeys(item, ['capacityProvider', 'weight', 'base'], 'upper'));
    }
    return result;
  }

  private lowerCaseItemKeys(
    item: Record<string, unknown>,
    keys: string[]
  ): Record<string, unknown> {
    return this.renameItemKeys(item, keys, 'lower');
  }

  /**
   * Flip the first letter's case on the listed keys of one array item
   * (`Type` <-> `type`, `CapacityProvider` <-> `capacityProvider`); keys
   * not listed (or absent) pass through unchanged.
   */
  private renameItemKeys(
    item: Record<string, unknown>,
    keys: string[],
    direction: 'lower' | 'upper'
  ): Record<string, unknown> {
    const result: Record<string, unknown> = { ...item };
    for (const key of keys) {
      if (result[key] !== undefined) {
        const flipped =
          direction === 'lower'
            ? key.charAt(0).toLowerCase() + key.slice(1)
            : key.charAt(0).toUpperCase() + key.slice(1);
        result[flipped] = result[key];
        delete result[key];
      }
    }
    return result;
  }

  /**
   * Create an EventBridge rule
   */
  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  /**
   * Update an EventBridge rule
   */
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

  /**
   * Delete an EventBridge rule
   *
   * Before deleting, removes all targets (required by EventBridge API).
   */
  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, _properties, context);
  }

  /**
   * Get resource attribute (for Fn::GetAtt resolution)
   */
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    const ruleName = this.extractRuleNameFromArn(physicalId);

    if (attributeName === 'Arn') {
      const response = await this.eventBridgeClient.send(
        new DescribeRuleCommand({
          Name: ruleName,
          ...this.busParamFromArn(physicalId),
        })
      );
      return response.Arn;
    }

    throw new Error(`Unsupported attribute: ${attributeName} for AWS::Events::Rule`);
  }

  /**
   * Read the AWS-current EventBridge rule configuration in CFn-property shape.
   *
   * Issues `DescribeRule` for the rule's main config, then a separate
   * `ListTargetsByRule` for `Targets`.
   *
   * Surfaced keys (when present): `Name`, `Description`, `EventBusName`,
   * `EventPattern` (parsed from JSON string back to object — cdkd state holds
   * it as the user typed it, typically an object), `ScheduleExpression`,
   * `State`, `RoleArn`, `Targets` (CFn shape `[{Id, Arn, ...}]`).
   *
   * `Tags` is surfaced via a follow-up `ListTagsForResource` call (using the
   * rule ARN — the same `physicalId` cdkd state holds). CDK's `aws:*`
   * auto-tags are filtered out; the result key is omitted entirely when AWS
   * reports no user tags.
   *
   * Returns `RESOURCE_NOT_FOUND` when the rule is gone (`ResourceNotFoundException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    const ruleName = this.extractRuleNameFromArn(physicalId);
    const busParam = this.busParamFromArn(physicalId);

    let resp: {
      Name?: string;
      Description?: string;
      EventBusName?: string;
      EventPattern?: string;
      ScheduleExpression?: string;
      State?: string;
      RoleArn?: string;
    };
    try {
      resp = (await this.eventBridgeClient.send(
        new DescribeRuleCommand({
          Name: ruleName,
          ...busParam,
        })
      )) as unknown as typeof resp;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
      throw err;
    }

    const result: Record<string, unknown> = {};
    if (resp.Name !== undefined) result['Name'] = resp.Name;
    result['Description'] = resp.Description ?? '';
    if (resp.EventBusName !== undefined && resp.EventBusName !== 'default') {
      result['EventBusName'] = resp.EventBusName;
    }
    if (resp.EventPattern !== undefined) {
      try {
        result['EventPattern'] = JSON.parse(resp.EventPattern) as unknown;
      } catch {
        result['EventPattern'] = resp.EventPattern;
      }
    }
    if (resp.ScheduleExpression !== undefined) {
      result['ScheduleExpression'] = resp.ScheduleExpression;
    }
    if (resp.State !== undefined) result['State'] = resp.State;
    if (resp.RoleArn !== undefined) result['RoleArn'] = resp.RoleArn;

    // Targets: separate API call. "Not configured" returns an empty array.
    try {
      const targetsResp = await this.eventBridgeClient.send(
        new ListTargetsByRuleCommand({
          Rule: ruleName,
          ...busParam,
        })
      );
      result['Targets'] = this.toCfnTargets((targetsResp.Targets ?? []) as RuleTarget[]);
    } catch (err) {
      if (!(err instanceof ResourceNotFoundException)) {
        throw err;
      }
    }

    // Tags via ListTagsForResource. The rule ARN is the physicalId cdkd
    // state holds.
    try {
      const tagsResp = await this.eventBridgeClient.send(
        new ListTagsForResourceCommand({ ResourceARN: physicalId })
      );
      const tags = normalizeAwsTagsToCfn(tagsResp.Tags);
      result['Tags'] = tags;
    } catch (err) {
      if (!(err instanceof ResourceNotFoundException)) {
        throw err;
      }
    }

    return result;
  }

  /**
   * Adopt an existing EventBridge rule into cdkd state.
   *
   * Lookup order:
   *  1. `--resource <id>=<arnOrName>` override → verify with
   *     `DescribeRule` (scoped to the same `EventBusName` declared in
   *     the template, if any). The override is honored as-is so users
   *     can pass either the ARN (cdkd's standard physicalId form for
   *     this provider) or just the rule name.
   *  2. If the template carries `Properties.Name` use that as the rule
   *     name lookup, then verify with `DescribeRule` and return the
   *     rule's ARN as physicalId.
   */
  /** go-to-k/cdkd#4705: the name `create()` sends when the template names none. */
  generatedCreateName(
    _resourceType: string,
    logicalId: string,
    properties: Record<string, unknown>
  ): string | undefined {
    if (properties['Name']) return undefined;
    return generatedNameFor('AWS::Events::Rule', logicalId);
  }

  /**
   * go-to-k/cdkd#4705: a rule's lookup reads its own event bus, so a bus
   * given as an intrinsic waits for the create's resolved properties.
   */
  lookupNeedsResolvedProperties(
    _resourceType: string,
    properties: Record<string, unknown>
  ): boolean {
    const bus = properties['EventBusName'];
    return bus !== undefined && bus !== null && bus !== '' && typeof bus !== 'string';
  }

  /**
   * go-to-k/cdkd#4705: one exact `DescribeRule` per name on its own event bus,
   * never `ListRules` (an eventually consistent listing can omit a rule just
   * created). Any failure but `ResourceNotFoundException` throws, which
   * refuses the create. A rule's physical id is its ARN.
   */
  async lookupNames(
    _resourceType: string,
    names: readonly string[],
    context: { propertiesByName: ReadonlyMap<string, Record<string, unknown>> }
  ): Promise<Map<string, string>> {
    const busOf = (name: string): string | undefined => {
      const bus = context.propertiesByName.get(name)?.['EventBusName'];
      if (bus === undefined || bus === null || bus === '') return undefined;
      // Never the default bus for one not yet known: the guard defers such a
      // lookup to the create (`lookupNeedsResolvedProperties`).
      if (typeof bus !== 'string') throw new Error(`EventBusName of rule ${name} is not resolved`);
      return bus;
    };
    const byBus = new Map<string | undefined, string[]>();
    for (const name of names) {
      const bus = busOf(name);
      byBus.set(bus, [...(byBus.get(bus) ?? []), name]);
    }
    const found = new Map<string, string>();
    await Promise.all(
      [...byBus].map(async ([bus, group]) => {
        const each = await lookupEachName(group, 'events:DescribeRule', 5, async (name) => {
          try {
            const resp = await this.eventBridgeClient.send(
              new DescribeRuleCommand({
                Name: name,
                ...(bus !== undefined && { EventBusName: bus }),
              })
            );
            return resp.Arn;
          } catch (err) {
            if (err instanceof ResourceNotFoundException) return undefined;
            throw err;
          }
        });
        for (const [name, arn] of each) found.set(name, arn);
      })
    );
    return found;
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const eventBusName = input.properties['EventBusName'] as string | undefined;
    if (input.knownPhysicalId) {
      try {
        const ruleName = this.extractRuleNameFromArn(input.knownPhysicalId);
        // An ARN override already names its bus — derive it from the ARN
        // (the template property may still be an unresolved intrinsic
        // object at import time). Bare-name overrides fall back to the
        // template property when it is a literal string.
        const arnBusParam = this.busParamFromArn(input.knownPhysicalId);
        const busParam =
          'EventBusName' in arnBusParam
            ? arnBusParam
            : typeof eventBusName === 'string' && eventBusName
              ? { EventBusName: eventBusName }
              : {};
        const resp = await this.eventBridgeClient.send(
          new DescribeRuleCommand({
            Name: ruleName,
            ...busParam,
          })
        );
        // Return the ARN form as physicalId (matches `create`).
        return { physicalId: resp.Arn ?? input.knownPhysicalId, attributes: {} };
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    const templateName = input.properties['Name'] as string | undefined;
    if (templateName) {
      try {
        const resp = await this.eventBridgeClient.send(
          new DescribeRuleCommand({
            Name: templateName,
            ...(eventBusName && { EventBusName: eventBusName }),
          })
        );
        if (resp.Arn) return { physicalId: resp.Arn, attributes: {} };
        return null;
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so that
    // tag never exists on a real resource and the walk could not match (issue
    // #1134). Auto-mode import resolves ids from CloudFormation's
    // DescribeStackResources or the template's physical-name property; a rule
    // reaching here needs an explicit `--resource` override.
    return null;
  }

  /**
   * The failure wrap the create, update and delete catches throw.
   *
   * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
   * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
   * `deployments/{runId}.jsonl`, and an `AccessDenied` names the caller's
   * assumed-role ARN. AWS's own text goes to `debug` through the operation's
   * masker, and the wrap is stamped `markRedactedCause`, so the retry
   * classifiers read the withheld text on the `cause` chain. An "already
   * exists" is restated ({@link relayedNameCollision}); one from the targets
   * step keeps its auxiliary mark on the chain, so it is still not read as the
   * rule's own name collision. A cdkd-authored or transport error keeps its
   * text, masked, stamped only when the mask changed it (`wrapMaskedAwsError`,
   * issue #4244); a non-`Error` throw is withheld like an AWS one, unstamped
   * (it has no chain). The delete catch tests not-found before it wraps.
   *
   * `build` must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor call.
   */
  wrapCaughtError(
    mask: MaskerFn,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    const failure = describeAwsFailure(error);
    if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
    this.logger.debug(mask(build(mask(failure.detail)).message));
    const wrapped = build(`${mask(failure.summary)}${relayedNameCollision(failure.detail)}`);
    return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
  }

  /**
   * Extract rule name from an ARN
   *
   * ARN format: arn:aws:events:region:account:rule/rule-name
   * or: arn:aws:events:region:account:rule/bus-name/rule-name
   */
  extractRuleNameFromArn(arn: string): string {
    // If it's not an ARN, assume it's already a rule name
    if (!arn.startsWith('arn:')) {
      return arn;
    }

    const parts = arn.split('/');
    // Last segment is always the rule name
    return parts[parts.length - 1] ?? arn;
  }

  /**
   * Extract the event bus name from a rule ARN.
   *
   * ARN format: `arn:aws:events:region:account:rule/rule-name` (default bus, returns 'default')
   *          or `arn:aws:events:region:account:rule/bus-name/rule-name` (custom bus).
   *
   * Returns `undefined` when the input is not an ARN (we can't tell which bus).
   */
  /**
   * `EventBusName` request parameter derived from a rule ARN — `{}` for
   * default-bus rules (preserves the Name-only wire shape) and for non-ARN
   * physical ids (bus unknowable).
   */
  busParamFromArn(arn: string): { EventBusName?: string } {
    const eventBusName = this.extractBusNameFromArn(arn);
    return eventBusName && eventBusName !== 'default' ? { EventBusName: eventBusName } : {};
  }

  private extractBusNameFromArn(arn: string): string | undefined {
    if (!arn.startsWith('arn:')) return undefined;
    const parts = arn.split('/');
    // arn:aws:events:r:a:rule/<rule>              → 2 segments (split by '/')
    // arn:aws:events:r:a:rule/<bus>/<rule>        → 3 segments
    // arn:aws:events:r:a:rule/aws.partner/x/y/<r> → 5 segments (partner-bus
    //   NAMES contain slashes; rule names cannot, so the bus is everything
    //   between the first and last segment — same last-slash rule as
    //   cfnRefValueFromPhysicalId in the intrinsic resolver)
    if (parts.length >= 3) return parts.slice(1, -1).join('/');
    return 'default';
  }
}
