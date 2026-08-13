import {
  SNSClient,
  SubscribeCommand,
  UnsubscribeCommand,
  GetSubscriptionAttributesCommand,
  InvalidParameterException,
  NotFoundException,
} from '@aws-sdk/client-sns';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { stringifyValue } from '../../utils/stringify.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * AWS SNS Subscription Provider
 *
 * Implements resource provisioning for AWS::SNS::Subscription using the SNS SDK.
 * This is required because SNS Subscription is not supported by Cloud Control API.
 */
export class SNSSubscriptionProvider implements ResourceProvider {
  private snsClient: SNSClient;
  private logger = getLogger().child('SNSSubscriptionProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::SNS::Subscription',
      new Set([
        'TopicArn',
        'Protocol',
        'Endpoint',
        'FilterPolicy',
        'FilterPolicyScope',
        'RawMessageDelivery',
        'RedrivePolicy',
        'DeliveryPolicy',
        'ReplayPolicy',
        'SubscriptionRoleArn',
      ]),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::SNS::Subscription',
      new Map<string, string>([
        [
          'Region',
          'CFn-only cross-region subscription hint; cdkd uses the SDK client region directly and has no per-resource region override',
        ],
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.snsClient = awsClients.sns;
  }

  /**
   * Create an SNS subscription
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating SNS subscription ${logicalId}`);

    const topicArn = properties['TopicArn'] as string | undefined;
    const protocol = properties['Protocol'] as string | undefined;
    const endpoint = properties['Endpoint'] as string | undefined;

    if (!topicArn) {
      throw new ProvisioningError(
        `TopicArn is required for SNS subscription ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    if (!protocol) {
      throw new ProvisioningError(
        `Protocol is required for SNS subscription ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    if (!endpoint) {
      throw new ProvisioningError(
        `Endpoint is required for SNS subscription ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const attributes: Record<string, string> = {};

      // Set FilterPolicy if provided.
      //
      // `!== undefined` (not truthy) so an explicit empty string / empty
      // object reaches `Subscribe` — AWS treats an empty `FilterPolicy`
      // as "no filter, match all messages", which is the documented way
      // to clear an existing FilterPolicy. A truthy gate would silently
      // drop the placeholder when `cdkd drift --revert` round-trips an
      // observedProperties snapshot taken after a console-side filter
      // removal.
      const filterPolicy = properties['FilterPolicy'];
      if (filterPolicy !== undefined) {
        attributes['FilterPolicy'] =
          typeof filterPolicy === 'string' ? filterPolicy : JSON.stringify(filterPolicy);
      }

      // The remaining attributes all ride on the same `Subscribe` Attributes
      // map. `!== undefined` gates (NOT truthy) so an explicitly-templated
      // value is preserved regardless of truthiness: `RawMessageDelivery:
      // false` is a genuine value (not a "clear" signal), and a truthy gate
      // would also drop a `cdkd drift --revert` observedProperties snapshot
      // that round-trips an empty FilterPolicy / policy object (which AWS
      // does treat as "clear", per the FilterPolicy comment above).
      // `update()` delegates to `create()` (delete + recreate), so these flow
      // through the update path automatically.

      // FilterPolicyScope: string passthrough.
      const filterPolicyScope = properties['FilterPolicyScope'];
      if (filterPolicyScope !== undefined) {
        attributes['FilterPolicyScope'] = stringifyValue(filterPolicyScope);
      }

      // RawMessageDelivery: CFn boolean; the SDK expects the string
      // "true" / "false" (stringifyValue coerces a boolean to exactly that).
      const rawMessageDelivery = properties['RawMessageDelivery'];
      if (rawMessageDelivery !== undefined) {
        attributes['RawMessageDelivery'] = stringifyValue(rawMessageDelivery);
      }

      // RedrivePolicy / DeliveryPolicy / ReplayPolicy: CFn JSON objects; the
      // SDK expects them as JSON strings. A string passes through unchanged.
      const redrivePolicy = properties['RedrivePolicy'];
      if (redrivePolicy !== undefined) {
        attributes['RedrivePolicy'] =
          typeof redrivePolicy === 'string' ? redrivePolicy : JSON.stringify(redrivePolicy);
      }

      const deliveryPolicy = properties['DeliveryPolicy'];
      if (deliveryPolicy !== undefined) {
        attributes['DeliveryPolicy'] =
          typeof deliveryPolicy === 'string' ? deliveryPolicy : JSON.stringify(deliveryPolicy);
      }

      const replayPolicy = properties['ReplayPolicy'];
      if (replayPolicy !== undefined) {
        attributes['ReplayPolicy'] =
          typeof replayPolicy === 'string' ? replayPolicy : JSON.stringify(replayPolicy);
      }

      // SubscriptionRoleArn: string passthrough (firehose protocol).
      const subscriptionRoleArn = properties['SubscriptionRoleArn'];
      if (subscriptionRoleArn !== undefined) {
        attributes['SubscriptionRoleArn'] = stringifyValue(subscriptionRoleArn);
      }

      const response = await this.snsClient.send(
        new SubscribeCommand({
          TopicArn: topicArn,
          Protocol: protocol,
          Endpoint: endpoint,
          ReturnSubscriptionArn: true,
          ...(Object.keys(attributes).length > 0 && { Attributes: attributes }),
        })
      );

      const subscriptionArn = response.SubscriptionArn || `${topicArn}:${logicalId}`;

      this.logger.debug(`Successfully created SNS subscription ${logicalId}: ${subscriptionArn}`);

      return {
        physicalId: subscriptionArn,
        attributes: {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create SNS subscription ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update an SNS subscription
   *
   * SNS subscriptions are immutable for TopicArn/Protocol/Endpoint changes.
   * For simplicity, we replace the subscription on any update.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating SNS subscription ${logicalId}: ${physicalId}`);

    // Delete old subscription
    let deleteResult: void | ResourceDeleteResult = undefined;
    try {
      deleteResult = await this.delete(logicalId, physicalId, resourceType);
    } catch (error) {
      this.logger.warn(
        `Failed to delete old subscription ${physicalId} during update: ${String(error)}`
      );
    }

    // Issue #1778: this provider replaces DELETE-first, so a skipped delete
    // means the old subscription was NOT destroyed and is still there — and
    // creating the new one below would leave two subscriptions on the topic,
    // delivering every message twice. That is user-visible, not a silent leak,
    // so abort instead: the duplicate is what the CREATE would ADD, so not
    // making it is the whole remedy, and state still names the old
    // subscription so the resource stays traceable.
    //
    // The premise is deliberately "not destroyed", NOT "no AWS call was
    // issued" — `ResourceDeleteResult`'s own contract (src/types/resource.ts)
    // warns that reading it the second way is a mistake callers build on,
    // since a recursing provider can report `skipped` AFTER deleting other
    // things. Abort is right under the weaker premise too: whatever the
    // skipping delete did or did not do, adding a second live subscription on
    // top of it cannot be an improvement.
    //
    // Deliberately NOT symmetric with the catch above, which creates anyway
    // after a FAILED delete: a throw may mean the unsubscribe partially
    // landed, was transient, or that the subscription is already gone, so
    // converging is the better bet. A skip is a positive statement that the
    // old subscription was not destroyed, which makes the duplicate a
    // certainty rather than a risk — that distinction is exactly what the
    // #1752 outcome mechanism exists to express. THIS provider's check lives
    // OUTSIDE the try for the same reason (the three create-then-delete
    // providers keep theirs inside, where a warn-only branch is harmless):
    // `delete()` raises its own `ProvisioningError` on a real failure, so
    // throwing from inside would be caught by that handler, and re-throwing
    // typed errors from it would turn today's warn-and-continue failure path
    // into a hard failure.
    //
    // Right for every `update()` caller, which is the bar an abort has to
    // clear: `cdkd deploy` (the resource fails and rolls back rather than
    // double-subscribing), `cdkd drift --revert` (the reverted subscription is
    // reported as a failed revert rather than duplicated), and the rollback
    // executor's revert arms (same). None of the three is better served by a
    // second live subscription. The rollback arms wrap `update()` in
    // `withRetry`, so the thrown message must not be classified retryable —
    // which is why the provider-supplied `reason` is LOGGED rather than
    // interpolated into it: `retryable-errors.ts` classifies by SUBSTRING, and
    // a reason carrying `does not exist` / `Rate exceeded` / `because it is in
    // use` would burn the whole backoff schedule before a certain failure.
    //
    // Latent today: the two pending-confirmation arms in `delete` are
    // deliberate CFn-parity delete-SUCCESS (see `logPendingConfirmationSkip`),
    // not skips, so no arm produces this outcome yet.
    if (deleteResult?.outcome === 'skipped') {
      this.logger.warn(
        `Cannot replace SNS subscription ${logicalId}: the old subscription ${physicalId} was not deleted — ` +
          `${deleteResult.reason}`
      );
      throw new ProvisioningError(
        `Cannot replace SNS subscription ${logicalId}: cdkd could not delete the old subscription ` +
          `${physicalId} (see the preceding warning for the cause), and creating the replacement would ` +
          `leave both subscribed to the topic and deliver every message twice. Repair the state record ` +
          `for ${logicalId}, or remove the old subscription in AWS if it is still live, then re-run.`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    // Create new subscription
    const createResult = await this.create(logicalId, resourceType, properties);

    return {
      physicalId: createResult.physicalId,
      wasReplaced: true,
      attributes: createResult.attributes ?? {},
    };
  }

  /**
   * Delete an SNS subscription
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    this.logger.debug(`Deleting SNS subscription ${logicalId}: ${physicalId}`);

    // A never-confirmed subscription may be recorded under the literal
    // "PendingConfirmation" placeholder instead of a real ARN (e.g. adopted
    // via `cdkd import --resource <id>=PendingConfirmation`). Unsubscribe
    // cannot possibly succeed on it, so skip with the same CFn-parity
    // semantics as the pending-confirmation rejection below.
    if (physicalId === 'PendingConfirmation' || physicalId === 'pending confirmation') {
      this.logPendingConfirmationSkip(logicalId, physicalId);
      return;
    }

    try {
      await this.snsClient.send(
        new UnsubscribeCommand({
          SubscriptionArn: physicalId,
        })
      );

      this.logger.debug(`Successfully deleted SNS subscription ${logicalId}`);
    } catch (error) {
      if (error instanceof NotFoundException) {
        const clientRegion = await this.snsClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Subscription ${physicalId} does not exist, skipping deletion`);
        return;
      }

      // CFn parity (issue #1301): a subscription still in PendingConfirmation
      // cannot be unsubscribed by ANY API — SNS rejects Unsubscribe with
      // "Cannot unsubscribe a subscription that is pending confirmation", and
      // the record only disappears when it auto-expires (~3 days) or its topic
      // is deleted. CloudFormation treats this as delete-success (the resource
      // is removed from the stack without unsubscribing); do the same,
      // otherwise destroy is permanently stuck (every retry hits the same
      // error). No assertRegionMatch here: unlike NotFound, this error proves
      // the subscription was positively found in the client's region.
      if (isPendingConfirmationError(error)) {
        this.logPendingConfirmationSkip(logicalId, physicalId);
        return;
      }

      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete SNS subscription ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Log the CFn-parity skip for a pending-confirmation subscription delete.
   *
   * **Do NOT convert either caller into a `ResourceDeleteResult` skip** (the
   * issue [#1770](https://github.com/go-to-k/cdkd/issues/1770) sweep) — the
   * note lives here rather than only at `update()` because this is where a
   * future converter looks. Both arms mean the resource is GONE as far as the
   * stack is concerned: CloudFormation removes a pending-confirmation
   * subscription from the stack without unsubscribing, and the pending record
   * expires on its own, so `deleted` is the honest outcome and a skip would
   * preserve state and fail an otherwise-clean destroy for no reason.
   *
   * There is a second consequence, and it is why the warning is this loud:
   * `update()` ABORTS the DELETE-first replacement on a skip (issue
   * [#1778](https://github.com/go-to-k/cdkd/issues/1778)). Reporting a skip
   * here would therefore make every deploy of a subscription whose state
   * physicalId is the `PendingConfirmation` placeholder — reachable via
   * `cdkd import --resource <id>=PendingConfirmation` — throw permanently,
   * with no flag to force it, and `cdkd drift --revert` would fail the same
   * way. Exempting that placeholder from the abort was the alternative and
   * was rejected: it would duplicate this method's knowledge of the
   * placeholder inside `update()`, where a later change to the accepted set
   * would silently un-fence the abort.
   */
  private logPendingConfirmationSkip(logicalId: string, physicalId: string): void {
    this.logger.warn(
      `SNS subscription ${logicalId} (${physicalId}) is pending confirmation and cannot be unsubscribed; ` +
        `skipping deletion to match CloudFormation behavior (the pending record expires automatically within 3 days)`
    );
  }

  /**
   * Read the AWS-current SNS Subscription configuration in CFn-property shape.
   *
   * Issues `GetSubscriptionAttributes`. AWS returns ALL attribute values
   * as strings; we type-coerce `RawMessageDelivery` to a boolean and
   * JSON-parse `FilterPolicy` so the comparator matches cdkd state's
   * already-typed values. `TopicArn`, `Protocol`, `Endpoint` pass through
   * as strings.
   *
   * Returns `undefined` when the subscription is gone (`NotFoundException`),
   * including the special "PendingConfirmation" case where the
   * `SubscriptionArn` has not yet been confirmed and `Attributes` is null.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    // The literal "PendingConfirmation" placeholder (issue #1301 — e.g. state
    // adopted via `cdkd import --resource <id>=PendingConfirmation`) is not a
    // real ARN; GetSubscriptionAttributes would throw InvalidParameterException
    // (NOT the NotFoundException handled below) and abort the whole
    // `cdkd drift` run. Treat it as unreadable-yet (no drift baseline).
    if (physicalId === 'PendingConfirmation' || physicalId === 'pending confirmation') {
      return undefined;
    }

    let attributes: Record<string, string> | undefined;
    try {
      const resp = await this.snsClient.send(
        new GetSubscriptionAttributesCommand({ SubscriptionArn: physicalId })
      );
      attributes = resp.Attributes;
    } catch (err) {
      if (err instanceof NotFoundException) return undefined;
      throw err;
    }
    if (!attributes) return undefined;

    const result: Record<string, unknown> = {};
    if (attributes['TopicArn'] !== undefined) result['TopicArn'] = attributes['TopicArn'];
    if (attributes['Protocol'] !== undefined) result['Protocol'] = attributes['Protocol'];
    if (attributes['Endpoint'] !== undefined) result['Endpoint'] = attributes['Endpoint'];

    // RawMessageDelivery is a boolean stored as a string ("true" / "false").
    if (attributes['RawMessageDelivery'] !== undefined) {
      result['RawMessageDelivery'] = attributes['RawMessageDelivery'] === 'true';
    }

    // FilterPolicy: AWS returns as a JSON string; cdkd state typically
    // holds the parsed object (post intrinsic resolution).
    if (attributes['FilterPolicy']) {
      try {
        result['FilterPolicy'] = JSON.parse(attributes['FilterPolicy']) as unknown;
      } catch {
        result['FilterPolicy'] = attributes['FilterPolicy'];
      }
    }

    // FilterPolicyScope / SubscriptionRoleArn: string passthrough.
    // Emit-when-present so a console-side change surfaces as drift. The drift
    // comparator only walks keys present in cdkd state, so surfacing a value
    // the user never templated (e.g. FilterPolicyScope's MessageAttributes
    // default, which AWS may return even when unset) cannot create a
    // false-positive drift.
    if (attributes['FilterPolicyScope'] !== undefined) {
      result['FilterPolicyScope'] = attributes['FilterPolicyScope'];
    }
    if (attributes['SubscriptionRoleArn'] !== undefined) {
      result['SubscriptionRoleArn'] = attributes['SubscriptionRoleArn'];
    }

    // RedrivePolicy / DeliveryPolicy / ReplayPolicy: AWS returns these as JSON
    // strings; cdkd state holds the parsed object (post intrinsic resolution).
    // Emit-when-present (NOT the always-emit-placeholder convention) — these
    // are protocol-discriminated and AWS omits them when absent, so emitting a
    // `{}` placeholder would round-trip into `JSON.stringify({}) === '{}'`
    // (which AWS rejects).
    for (const key of ['RedrivePolicy', 'DeliveryPolicy', 'ReplayPolicy']) {
      const raw = attributes[key];
      if (raw) {
        try {
          result[key] = JSON.parse(raw) as unknown;
        } catch {
          result[key] = raw;
        }
      }
    }

    return result;
  }

  /**
   * Adopt an existing SNS subscription into cdkd state.
   *
   * **Explicit override only.** SNS subscriptions are attached to a parent
   * topic and identified by their `SubscriptionArn`, but the SubscribeAPI
   * does not accept tags and the AWS tag APIs do not cover subscriptions
   * (only Topics are taggable). There is therefore no `aws:cdk:path` tag
   * we could use for auto-lookup.
   *
   * Users adopting an existing subscription should pass
   * `--resource <logicalId>=<subscriptionArn>`.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      return { physicalId: input.knownPhysicalId, attributes: {} };
    }
    return null;
  }
}

/**
 * SNS rejects `Unsubscribe` for any subscription still in PendingConfirmation
 * with `InvalidParameterException: Invalid parameter: SubscriptionArn Reason:
 * Cannot unsubscribe a subscription that is pending confirmation`.
 */
function isPendingConfirmationError(error: unknown): boolean {
  return (
    error instanceof InvalidParameterException &&
    error.message.toLowerCase().includes('pending confirmation')
  );
}
