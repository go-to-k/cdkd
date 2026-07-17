import {
  BudgetsClient,
  CreateBudgetCommand,
  UpdateBudgetCommand,
  DeleteBudgetCommand,
  DescribeBudgetCommand,
  DescribeBudgetsCommand,
  CreateNotificationCommand,
  DeleteNotificationCommand,
  CreateSubscriberCommand,
  DeleteSubscriberCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
  UntagResourceCommand,
  NotFoundException,
  DuplicateRecordException,
  type Budget,
  type Notification,
  type NotificationWithSubscribers,
  type ResourceTag,
  type Spend,
  type Subscriber,
  type TimePeriod,
} from '@aws-sdk/client-budgets';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import { matchesCdkPath } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * SDK Provider for AWS::Budgets::Budget (issue #1041).
 *
 * The type is `ProvisioningType: NON_PROVISIONABLE`, so the Cloud Control
 * fallback cannot handle it — without this provider cdkd's pre-flight
 * rejects the type outright.
 *
 * **Global endpoint / region semantics**: the Budgets API is a global,
 * per-account service served from `us-east-1`. The `@aws-sdk/client-budgets`
 * endpoint ruleset resolves EVERY aws-partition region to the single global
 * endpoint (`budgets.amazonaws.com`, SigV4 scope `us-east-1`), so the client
 * below is deliberately created with the deploy region like every other
 * provider — the SDK itself pins the endpoint. This also keeps
 * `client.config.region()` equal to the deploy region, so the standard
 * `assertRegionMatch` idempotent-delete guard behaves exactly like it does
 * for regional services: a destroy run with a mismatched `--region` still
 * refuses to trust a NotFound. (For a global namespace a NotFound would
 * actually be trustworthy from any region, but keeping the guard uniform is
 * strictly safer and costs nothing.)
 *
 * **AccountId**: every Budgets API call requires the account id. It is
 * resolved once per provider instance via STS `GetCallerIdentity` (shared
 * `AwsClients.sts`) and cached as a single-flight promise for the deploy
 * lifetime; failed resolutions are not cached so a transient STS throttle
 * cannot poison the rest of the run (mirrors
 * `src/utils/expected-bucket-owner.ts`).
 *
 * **Physical id**: the budget NAME. `Budget.BudgetName` is createOnly —
 * a rename is classified as replacement by the `AWS::Budgets::Budget`
 * conditional rule in `src/analyzer/replacement-rules.ts`.
 *
 * **NotificationsWithSubscribers**: CloudFormation treats the whole property
 * as createOnly (replacement on any change). cdkd does better — `update()`
 * reconciles in place via CreateNotification / DeleteNotification /
 * CreateSubscriber / DeleteSubscriber, so alert history and the budget
 * itself survive a notification edit.
 */
export class BudgetsBudgetProvider implements ResourceProvider {
  private client: BudgetsClient | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('BudgetsBudgetProvider');
  private accountIdPromise: Promise<string> | undefined;

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Budgets::Budget',
      new Set<string>(['Budget', 'NotificationsWithSubscribers', 'ResourceTags']),
    ],
  ]);

  private getClient(): BudgetsClient {
    if (!this.client) {
      this.client = new BudgetsClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
  }

  /**
   * Resolve the caller's AWS account id (required on every Budgets call).
   * Cached per provider instance as a single-flight promise; a failed
   * resolution is evicted so the next call retries instead of replaying a
   * transient error for the rest of the deploy.
   */
  private resolveAccountId(): Promise<string> {
    if (!this.accountIdPromise) {
      this.accountIdPromise = (async (): Promise<string> => {
        try {
          const identity = await getAwsClients().sts.send(new GetCallerIdentityCommand({}));
          if (!identity.Account) {
            throw new Error('STS GetCallerIdentity returned no Account');
          }
          return identity.Account;
        } catch (error) {
          this.accountIdPromise = undefined;
          throw error;
        }
      })();
    }
    return this.accountIdPromise;
  }

  /**
   * Budget ARN for the tagging APIs (`ListTagsForResource` / `TagResource` /
   * `UntagResource`). Budgets ARNs carry no region component. The `aws`
   * partition is assumed — consistent with other providers that construct
   * ARNs; non-`aws` partitions are not supported by cdkd today.
   */
  private budgetArn(accountId: string, budgetName: string): string {
    return `arn:aws:budgets::${accountId}:budget/${budgetName}`;
  }

  /**
   * Convert a CFn `Spend` shape to the SDK shape. CFn templates carry
   * `Amount` as a number (CDK synthesizes `budgetLimit: { amount: 10 }` to a
   * numeric JSON value); the SDK wants a numeric string.
   */
  private toSdkSpend(raw: unknown): Spend | undefined {
    if (raw === undefined || raw === null || typeof raw !== 'object') return undefined;
    const spend = raw as Record<string, unknown>;
    const amount = spend['Amount'];
    return {
      Amount:
        typeof amount === 'string'
          ? amount
          : typeof amount === 'number'
            ? String(amount)
            : undefined,
      Unit: spend['Unit'] as string | undefined,
    };
  }

  /**
   * Convert a CFn `TimePeriod` `Start` / `End` value to a `Date`. CFn accepts
   * a UTC date string (`2026-07-01T00:00:00Z`) or an epoch timestamp in
   * seconds (possibly as a numeric string).
   */
  private toSdkDate(raw: unknown, field: string, logicalId: string, resourceType: string): Date {
    let date: Date;
    if (typeof raw === 'number') {
      // Epoch. Values below 10^12 are seconds (10^12 ms is 2001-09-09;
      // an epoch-seconds value can never reach it before year 33658).
      date = new Date(raw < 1e12 ? raw * 1000 : raw);
    } else if (typeof raw === 'string' && /^\d+$/.test(raw)) {
      const num = Number(raw);
      date = new Date(num < 1e12 ? num * 1000 : num);
    } else if (typeof raw === 'string') {
      date = new Date(raw);
    } else {
      throw new ProvisioningError(
        `Invalid TimePeriod.${field} for budget ${logicalId}: expected a date string or epoch timestamp, got ${JSON.stringify(raw)}`,
        resourceType,
        logicalId
      );
    }
    if (Number.isNaN(date.getTime())) {
      throw new ProvisioningError(
        `Invalid TimePeriod.${field} for budget ${logicalId}: ${JSON.stringify(raw)} is not a parseable date`,
        resourceType,
        logicalId
      );
    }
    return date;
  }

  /**
   * Map the CFn `Budget` (BudgetData) property to the SDK `Budget` shape.
   * The two are PascalCase-identical except: `BudgetLimit` /
   * `PlannedBudgetLimits` amounts are numeric strings on the wire, and
   * `TimePeriod.Start` / `.End` are `Date`s. `FilterExpression` / `Metrics` /
   * `CostFilters` / `CostTypes` / `AutoAdjustData` pass through verbatim.
   */
  private toSdkBudget(
    raw: unknown,
    budgetName: string,
    logicalId: string,
    resourceType: string
  ): Budget {
    if (raw === undefined || raw === null || typeof raw !== 'object') {
      throw new ProvisioningError(
        `The Budget property is required for ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    const src = raw as Record<string, unknown>;
    const budget: Record<string, unknown> = { ...src, BudgetName: budgetName };

    if (src['BudgetLimit'] !== undefined) {
      budget['BudgetLimit'] = this.toSdkSpend(src['BudgetLimit']);
    }
    if (
      src['PlannedBudgetLimits'] !== undefined &&
      typeof src['PlannedBudgetLimits'] === 'object'
    ) {
      const limits: Record<string, Spend | undefined> = {};
      for (const [key, value] of Object.entries(
        src['PlannedBudgetLimits'] as Record<string, unknown>
      )) {
        limits[key] = this.toSdkSpend(value);
      }
      budget['PlannedBudgetLimits'] = limits;
    }
    if (src['TimePeriod'] !== undefined && typeof src['TimePeriod'] === 'object') {
      const rawPeriod = src['TimePeriod'] as Record<string, unknown>;
      const period: TimePeriod = {};
      if (rawPeriod['Start'] !== undefined) {
        period.Start = this.toSdkDate(rawPeriod['Start'], 'Start', logicalId, resourceType);
      }
      if (rawPeriod['End'] !== undefined) {
        period.End = this.toSdkDate(rawPeriod['End'], 'End', logicalId, resourceType);
      }
      budget['TimePeriod'] = period;
    }
    return budget as unknown as Budget;
  }

  /** Normalize a CFn notification block to the SDK `Notification` shape. */
  private toSdkNotification(raw: Record<string, unknown>): Notification {
    return {
      NotificationType: raw['NotificationType'] as Notification['NotificationType'],
      ComparisonOperator: raw['ComparisonOperator'] as Notification['ComparisonOperator'],
      Threshold: raw['Threshold'] !== undefined ? Number(raw['Threshold']) : undefined,
      ...(raw['ThresholdType'] !== undefined && {
        ThresholdType: raw['ThresholdType'] as Notification['ThresholdType'],
      }),
    };
  }

  /** Normalize a CFn subscriber block to the SDK `Subscriber` shape. */
  private toSdkSubscriber(raw: Record<string, unknown>): Subscriber {
    return {
      SubscriptionType: raw['SubscriptionType'] as Subscriber['SubscriptionType'],
      Address: raw['Address'] as string | undefined,
    };
  }

  /**
   * Parse the CFn `NotificationsWithSubscribers` property into SDK shape.
   * Tolerates absent / non-array values (returns `[]`).
   */
  private toSdkNotificationsWithSubscribers(raw: unknown): NotificationWithSubscribers[] {
    if (!Array.isArray(raw)) return [];
    const out: NotificationWithSubscribers[] = [];
    for (const item of raw) {
      if (item === null || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      const notification = entry['Notification'];
      const subscribers = entry['Subscribers'];
      out.push({
        Notification:
          notification && typeof notification === 'object'
            ? this.toSdkNotification(notification as Record<string, unknown>)
            : undefined,
        Subscribers: Array.isArray(subscribers)
          ? subscribers
              .filter((s): s is Record<string, unknown> => s !== null && typeof s === 'object')
              .map((s) => this.toSdkSubscriber(s))
          : undefined,
      });
    }
    return out;
  }

  /**
   * Identity key for a notification. The Budgets API addresses notifications
   * by their full value (there is no notification id), so the reconciler
   * treats a change to any of these fields as delete-old + create-new.
   * `ThresholdType` defaults to `PERCENTAGE` service-side — normalize the
   * absent case so an explicit `PERCENTAGE` and an omitted one compare equal.
   */
  private notificationKey(n: Notification): string {
    return JSON.stringify([
      n.NotificationType,
      n.ComparisonOperator,
      n.Threshold,
      n.ThresholdType ?? 'PERCENTAGE',
    ]);
  }

  /** Identity key for a subscriber. */
  private subscriberKey(s: Subscriber): string {
    return JSON.stringify([s.SubscriptionType, s.Address]);
  }

  /** Normalize the CFn `ResourceTags` property (`{Key,Value}[]`). */
  private toSdkResourceTags(raw: unknown): ResourceTag[] {
    if (!Array.isArray(raw)) return [];
    const out: ResourceTag[] = [];
    for (const item of raw) {
      if (item === null || typeof item !== 'object') continue;
      const tag = item as Record<string, unknown>;
      if (typeof tag['Key'] !== 'string') continue;
      const value = tag['Value'];
      out.push({
        Key: tag['Key'],
        Value:
          typeof value === 'string'
            ? value
            : typeof value === 'number' || typeof value === 'boolean'
              ? String(value)
              : '',
      });
    }
    return out;
  }

  /**
   * Create a budget via `CreateBudget` (a single call carries the budget,
   * its notifications with subscribers, and resource tags — no post-create
   * wiring to clean up on partial failure).
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating budget ${logicalId}`);

    const rawBudget = (properties['Budget'] ?? {}) as Record<string, unknown>;
    const rawName = rawBudget['BudgetName'];
    // A user-supplied BudgetName is a user contract: Budgets accepts nearly
    // every printable character except `:` and `\`, so it passes through
    // VERBATIM (no sanitize, no stack prefix) — running it through the name
    // generator would silently mutate names like "My Team Budget" and desync
    // the physical id from the template (breaking import's explicit-name
    // lookup). Only the logical-id fallback goes through the conservative
    // generator.
    const name =
      typeof rawName === 'string' && rawName.length > 0
        ? rawName
        : generateResourceName(logicalId, {
            maxLength: 100,
            allowedPattern: /[^a-zA-Z0-9\-_.]/g,
          });

    try {
      const accountId = await this.resolveAccountId();
      const notifications = this.toSdkNotificationsWithSubscribers(
        properties['NotificationsWithSubscribers']
      );
      const resourceTags = this.toSdkResourceTags(properties['ResourceTags']);

      await this.getClient().send(
        new CreateBudgetCommand({
          AccountId: accountId,
          Budget: this.toSdkBudget(properties['Budget'], name, logicalId, resourceType),
          ...(notifications.length > 0 && { NotificationsWithSubscribers: notifications }),
          ...(resourceTags.length > 0 && { ResourceTags: resourceTags }),
        })
      );

      this.logger.debug(`Successfully created budget ${logicalId}: ${name}`);
      return {
        physicalId: name,
        attributes: {
          Arn: this.budgetArn(accountId, name),
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create budget ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update a budget: `UpdateBudget` for the budget definition, then
   * reconcile `NotificationsWithSubscribers` in place (CloudFormation would
   * replace the whole budget instead) and diff `ResourceTags`.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating budget ${logicalId}: ${physicalId}`);

    try {
      const accountId = await this.resolveAccountId();

      // The physical id is the budget name: a rename is classified as
      // replacement upstream (replacement-rules.ts), so `physicalId` is the
      // authoritative name here.
      await this.getClient().send(
        new UpdateBudgetCommand({
          AccountId: accountId,
          NewBudget: this.toSdkBudget(properties['Budget'], physicalId, logicalId, resourceType),
        })
      );

      await this.reconcileNotifications(
        accountId,
        physicalId,
        this.toSdkNotificationsWithSubscribers(previousProperties['NotificationsWithSubscribers']),
        this.toSdkNotificationsWithSubscribers(properties['NotificationsWithSubscribers'])
      );

      await this.reconcileResourceTags(
        accountId,
        physicalId,
        this.toSdkResourceTags(previousProperties['ResourceTags']),
        this.toSdkResourceTags(properties['ResourceTags'])
      );

      this.logger.debug(`Successfully updated budget ${logicalId}`);
      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: this.budgetArn(accountId, physicalId),
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update budget ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Send a reconciler DELETE call, treating `NotFoundException` as success.
   * The reconciler must be idempotent: after a partial failure the deploy
   * engine retries the update forward (re-deleting an already-deleted
   * notification/subscriber) or rolls it back with the reversed diff
   * (deleting a notification the forward pass never created) — both land
   * here as NotFound and must not fail the recovery.
   */
  private async sendDeleteIdempotent(
    command: DeleteNotificationCommand | DeleteSubscriberCommand,
    what: string
  ): Promise<void> {
    try {
      await this.getClient().send(command as DeleteNotificationCommand);
    } catch (error) {
      if (error instanceof NotFoundException) {
        this.logger.debug(`${what} already absent, skipping delete`);
        return;
      }
      throw error;
    }
  }

  /**
   * Send a reconciler CREATE call, treating `DuplicateRecordException` as
   * success — the retry/rollback twin of {@link sendDeleteIdempotent} for
   * re-creating a notification/subscriber a previous partial pass already
   * created.
   */
  private async sendCreateIdempotent(
    command: CreateNotificationCommand | CreateSubscriberCommand,
    what: string
  ): Promise<void> {
    try {
      await this.getClient().send(command as CreateNotificationCommand);
    } catch (error) {
      if (error instanceof DuplicateRecordException) {
        this.logger.debug(`${what} already exists, skipping create`);
        return;
      }
      throw error;
    }
  }

  /**
   * Reconcile the notification set: delete removed notifications first
   * (frees the 10-notifications-per-budget cap before additions), create
   * added ones, then diff subscribers on retained notifications. Every
   * step is idempotent (NotFound on delete / DuplicateRecord on create are
   * success) so a partial failure can be retried forward or rolled back.
   */
  private async reconcileNotifications(
    accountId: string,
    budgetName: string,
    oldList: NotificationWithSubscribers[],
    newList: NotificationWithSubscribers[]
  ): Promise<void> {
    const buildKeyed = (
      list: NotificationWithSubscribers[],
      side: string
    ): Map<string, NotificationWithSubscribers> => {
      const byKey = new Map<string, NotificationWithSubscribers>();
      for (const nws of list) {
        if (!nws.Notification) continue;
        const key = this.notificationKey(nws.Notification);
        if (byKey.has(key)) {
          // Two notifications with identical (type, operator, threshold,
          // thresholdType) — the Budgets API itself rejects true duplicates
          // with DuplicateRecord, and Map aggregation keeps the LAST entry's
          // subscribers. Surface it so a silently-dropped subscriber list is
          // diagnosable.
          this.logger.warn(
            `Duplicate notification key ${key} in ${side} NotificationsWithSubscribers for budget ${budgetName}; the last entry's subscribers win`
          );
        }
        byKey.set(key, nws);
      }
      return byKey;
    };
    const oldByKey = buildKeyed(oldList, 'previous');
    const newByKey = buildKeyed(newList, 'desired');

    // Removed notifications (their subscribers are deleted with them).
    for (const [key, nws] of oldByKey) {
      if (newByKey.has(key)) continue;
      await this.sendDeleteIdempotent(
        new DeleteNotificationCommand({
          AccountId: accountId,
          BudgetName: budgetName,
          Notification: nws.Notification,
        }),
        `Notification ${key} on budget ${budgetName}`
      );
      this.logger.debug(`Deleted notification ${key} from budget ${budgetName}`);
    }

    // Added notifications (created with their full subscriber list).
    for (const [key, nws] of newByKey) {
      if (oldByKey.has(key)) continue;
      await this.sendCreateIdempotent(
        new CreateNotificationCommand({
          AccountId: accountId,
          BudgetName: budgetName,
          Notification: nws.Notification,
          Subscribers: nws.Subscribers,
        }),
        `Notification ${key} on budget ${budgetName}`
      );
      this.logger.debug(`Created notification ${key} on budget ${budgetName}`);
    }

    // Retained notifications: diff subscribers. Create additions BEFORE
    // deleting removals — a notification must keep at least one subscriber
    // at all times, so delete-first would fail on a full swap of a
    // single-subscriber notification. Known trade-off: a full swap of a
    // notification already AT the per-notification subscriber cap can
    // transiently exceed the cap and fail — the inverse of the delete-first
    // ordering used for whole notifications above; the at-cap full swap is
    // the rarer case.
    for (const [key, newNws] of newByKey) {
      const oldNws = oldByKey.get(key);
      if (!oldNws) continue;
      const oldSubs = new Map<string, Subscriber>();
      for (const s of oldNws.Subscribers ?? []) oldSubs.set(this.subscriberKey(s), s);
      const newSubs = new Map<string, Subscriber>();
      for (const s of newNws.Subscribers ?? []) newSubs.set(this.subscriberKey(s), s);

      for (const [subKey, subscriber] of newSubs) {
        if (oldSubs.has(subKey)) continue;
        await this.sendCreateIdempotent(
          new CreateSubscriberCommand({
            AccountId: accountId,
            BudgetName: budgetName,
            Notification: newNws.Notification,
            Subscriber: subscriber,
          }),
          `Subscriber ${subKey} on notification ${key}`
        );
        this.logger.debug(`Created subscriber ${subKey} on notification ${key}`);
      }
      for (const [subKey, subscriber] of oldSubs) {
        if (newSubs.has(subKey)) continue;
        await this.sendDeleteIdempotent(
          new DeleteSubscriberCommand({
            AccountId: accountId,
            BudgetName: budgetName,
            Notification: newNws.Notification,
            Subscriber: subscriber,
          }),
          `Subscriber ${subKey} on notification ${key}`
        );
        this.logger.debug(`Deleted subscriber ${subKey} from notification ${key}`);
      }
    }
  }

  /** Diff `ResourceTags` via `UntagResource` (removed keys) + `TagResource` (upsert). */
  private async reconcileResourceTags(
    accountId: string,
    budgetName: string,
    oldTags: ResourceTag[],
    newTags: ResourceTag[]
  ): Promise<void> {
    const sortedJson = (tags: ResourceTag[]): string =>
      JSON.stringify([...tags].sort((a, b) => (a.Key ?? '').localeCompare(b.Key ?? '')));
    if (sortedJson(oldTags) === sortedJson(newTags)) return;

    const arn = this.budgetArn(accountId, budgetName);
    const newKeys = new Set(newTags.map((t) => t.Key));
    const removedKeys = oldTags
      .map((t) => t.Key)
      .filter((k): k is string => {
        return typeof k === 'string' && !newKeys.has(k);
      });
    if (removedKeys.length > 0) {
      await this.getClient().send(
        new UntagResourceCommand({ ResourceARN: arn, ResourceTagKeys: removedKeys })
      );
    }
    if (newTags.length > 0) {
      await this.getClient().send(
        new TagResourceCommand({ ResourceARN: arn, ResourceTags: newTags })
      );
    }
    this.logger.debug(`Updated resource tags for budget ${budgetName}`);
  }

  /**
   * Delete a budget (`DeleteBudget` also deletes all of its notifications
   * and subscribers). NotFound is idempotent success — after the standard
   * region assertion (see the class doc for why the guard stays uniform
   * even though the Budgets namespace is global).
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting budget ${logicalId}: ${physicalId}`);

    try {
      const accountId = await this.resolveAccountId();
      await this.getClient().send(
        new DeleteBudgetCommand({ AccountId: accountId, BudgetName: physicalId })
      );
      this.logger.debug(`Successfully deleted budget ${logicalId}`);
    } catch (error) {
      if (error instanceof NotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Budget ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete budget ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * `Fn::GetAtt` support. CloudFormation documents no attributes for
   * `AWS::Budgets::Budget`; `Arn` is served as a cdkd convenience (computed
   * — Budgets ARNs are `arn:aws:budgets::{account}:budget/{name}`, verified
   * to exist via `DescribeBudget` first).
   */
  async getAttribute(
    physicalId: string,
    resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName !== 'Arn') {
      throw new ProvisioningError(
        `Unknown attribute ${attributeName} for ${resourceType}`,
        resourceType,
        physicalId
      );
    }
    try {
      const accountId = await this.resolveAccountId();
      await this.getClient().send(
        new DescribeBudgetCommand({ AccountId: accountId, BudgetName: physicalId })
      );
      return this.budgetArn(accountId, physicalId);
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to resolve Arn for budget ${physicalId}: ${cause?.message ?? String(error)}`,
        resourceType,
        physicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Adopt an existing budget into cdkd state.
   *
   * Lookup order:
   *  1. `--resource` override or `Properties.Budget.BudgetName` → verify via
   *     `DescribeBudget`.
   *  2. `aws:cdk:path` tag match: walk `DescribeBudgets` and check each
   *     budget's tags via `ListTagsForResource` (budget ARNs are
   *     region-free, so the lookup works from any deploy region).
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const rawBudget = (input.properties['Budget'] ?? {}) as Record<string, unknown>;
    const explicit =
      input.knownPhysicalId ??
      (typeof rawBudget['BudgetName'] === 'string' && rawBudget['BudgetName'].length > 0
        ? rawBudget['BudgetName']
        : undefined);

    const accountId = await this.resolveAccountId();
    const client = this.getClient();

    if (explicit) {
      try {
        await client.send(
          new DescribeBudgetCommand({ AccountId: accountId, BudgetName: explicit })
        );
        return {
          physicalId: explicit,
          attributes: { Arn: this.budgetArn(accountId, explicit) },
        };
      } catch (error) {
        if (error instanceof NotFoundException) return null;
        throw error;
      }
    }

    if (!input.cdkPath) return null;

    let nextToken: string | undefined;
    do {
      const list = await client.send(
        new DescribeBudgetsCommand({
          AccountId: accountId,
          ...(nextToken && { NextToken: nextToken }),
        })
      );
      for (const budget of list.Budgets ?? []) {
        if (!budget.BudgetName) continue;
        const tags = await client.send(
          new ListTagsForResourceCommand({
            ResourceARN: this.budgetArn(accountId, budget.BudgetName),
          })
        );
        if (matchesCdkPath(tags.ResourceTags, input.cdkPath)) {
          return {
            physicalId: budget.BudgetName,
            attributes: { Arn: this.budgetArn(accountId, budget.BudgetName) },
          };
        }
      }
      nextToken = list.NextToken;
    } while (nextToken);
    return null;
  }
}
