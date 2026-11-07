import {
  BudgetsClient,
  DescribeBudgetCommand,
  type CreateNotificationCommand,
  type CreateSubscriberCommand,
  type DeleteNotificationCommand,
  type DeleteSubscriberCommand,
  type Budget,
  type Notification,
  type NotificationWithSubscribers,
  type ResourceTag,
  type Spend,
  type Subscriber,
  type TimePeriod,
} from '@aws-sdk/client-budgets';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { derivePartitionAndUrlSuffix } from '../../utils/aws-partition.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type { DeleteContext } from '../region-check.js';
import type {
  ResourceNotFound,
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  UpdateContext,
} from '../../types/resource.js';
import { maskDeep, maskerOrIdentity, type MaskerFn } from '../masked-retry-logger.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { parseCfnTimestamp } from '../../utils/cfn-timestamp.js';
import {
  canonicalizeBudgetDriftBag,
  isPlainRecord,
  type BudgetListKind,
} from './budgets-budget/shared.js';
import { create } from './budgets-budget/create.js';
import {
  update,
  readDesiredLists,
  addNotificationsOnly,
  createNotificationOrSubscribers,
  sendDeleteIdempotent,
  sendCreateIdempotent,
  reconcileNotifications,
  reconcileResourceTags,
} from './budgets-budget/update.js';
import { deleteImpl } from './budgets-budget/delete.js';
import {
  readCurrentState,
  listNotifications,
  listSubscribers,
  budgetFromSdk,
  canonicalizeDriftPair,
  importImpl,
} from './budgets-budget/read-state.js';

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
  private createClient: BudgetsClient | undefined;
  private readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('BudgetsBudgetProvider');
  private accountIdPromise: Promise<string> | undefined;

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Budgets::Budget',
      new Set<string>(['Budget', 'NotificationsWithSubscribers', 'ResourceTags']),
    ],
  ]);

  getClient(): BudgetsClient {
    if (!this.client) {
      // Built together with the create client, so both capture the identity
      // active at this ONE call (issue #4639).
      this.client = new BudgetsClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
      this.createClient = withoutServerErrorRetries(
        new BudgetsClient({
          ...ambientClientDefaults(),
          ...(this.providerRegion ? { region: this.providerRegion } : {}),
        })
      );
    }
    return this.client;
  }

  /**
   * The client `CreateBudget` goes through: SDK retries on, except a 5xx
   * (`withoutServerErrorRetries`, issue #4639). Separate so every other call
   * keeps the full SDK retry.
   *
   * `CreateBudget` carries no idempotency token and a budget name is unique
   * per account, so the SDK's own replay of a 5xx whose request had succeeded
   * collides with the budget the first send made, and that
   * `DuplicateRecordException` surfaced from the engine's FIRST attempt as a
   * name somebody else holds. Refused here, the 5xx reaches the deploy
   * engine's retry, which marks the create as possibly replayed (`withRetry`,
   * #3978). Nothing is adopted on that collision: a name is not attribution
   * (`docs/provider-rules.md`, "Adopt only on EXACT attribution").
   */
  /**
   * The `ProvisioningError` a failed create / update throws, through
   * {@link wrapMaskedError}: an AWS-authored failure is named by its class
   * (issue #2319), and any other text is masked through the operation's
   * masker (issue #2176), since a refusal or a 5xx can quote a resolved
   * secret-derived value.
   */
  wrapBudgetError(
    mask: MaskerFn,
    error: unknown,
    verb: 'create' | 'update',
    logicalId: string,
    resourceType: string,
    physicalId: string | undefined
  ): ProvisioningError {
    const cause = error instanceof Error ? error : undefined;
    return this.wrapMaskedError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to ${verb} budget ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }

  /**
   * A failure wrap that never quotes AWS's own text (issue #2319). The thrown
   * message is persisted to `deployments/{runId}.jsonl`, and an AWS
   * `AccessDeniedException` names the caller's assumed-role ARN, so an
   * AWS-authored failure is named by its class plus the `--verbose` pointer:
   * AWS's text goes to `debug` through the masker, and the wrap is stamped
   * `markRedactedCause` so the retry classifiers read the withheld text on the
   * `cause` chain. An "already exists" is restated
   * ({@link relayedNameCollision}). A cdkd-authored or transport error, or a
   * non-`Error` throw, keeps its text, masked (issue #2176).
   *
   * `build` must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor call.
   */
  wrapMaskedError(
    mask: MaskerFn,
    error: unknown,
    build: (maskedText: string) => ProvisioningError
  ): ProvisioningError {
    const failure = describeAwsFailure(error);
    if (!(error instanceof Error)) return build(mask(failure.detail));
    if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
    this.logger.debug(mask(build(mask(failure.detail)).message));
    return markRedactedCause(
      build(`${mask(failure.summary)}${relayedNameCollision(failure.detail)}`)
    );
  }

  getCreateClient(): BudgetsClient {
    this.getClient();
    return this.createClient as BudgetsClient;
  }

  /**
   * Resolve the caller's AWS account id (required on every Budgets call).
   * Cached per provider instance as a single-flight promise; a failed
   * resolution is evicted so the next call retries instead of replaying a
   * transient error for the rest of the deploy.
   */
  resolveAccountId(): Promise<string> {
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
   * `UntagResource`), and the `Arn` attribute recorded into state.
   *
   * Budgets ARNs carry no region component, but they DO carry a partition, so
   * a region is still needed to name it. It is read from the RESOLVED region
   * of the very client that receives this ARN — the same
   * `getClient().config.region()` the `delete()` path already consults for
   * its `assertRegionMatch` guard — and routed through the closed mapping
   * `${AWS::Partition}` uses (issue #1815).
   *
   * Asking the CLIENT rather than `providerRegion` is what makes the ARN and
   * its consumer agree. `providerRegion` is `ambientRegion()` (the stack scope's region, else
   * `process.env['AWS_REGION']`), and
   * when that is unset `getClient()` builds `new BudgetsClient({})`, leaving
   * the SDK to resolve the region from its OWN chain (`AWS_DEFAULT_REGION`,
   * the `~/.aws/config` profile). So a profile-configured `cn-north-1` /
   * `us-gov-*` caller would have derived the COMMERCIAL partition from an
   * empty string while the client itself talked to a non-commercial endpoint
   * — on the PRIMARY path, not a fallback.
   *
   * The `aws` partition USED to be hardcoded here on the stated assumption
   * that non-`aws` partitions were unsupported. That was wrong in the quiet
   * direction: the literal is structurally valid everywhere, so in `aws-cn` /
   * `aws-us-gov` nothing rejected it — the ARN was simply recorded into state
   * and handed to `TagResource` naming no budget. A client whose region is
   * unset or unrecognized still derives to `aws`, so commercial output is
   * unchanged byte for byte.
   */
  async budgetArn(accountId: string, budgetName: string): Promise<string> {
    const region = await this.getClient().config.region();
    const { partition } = derivePartitionAndUrlSuffix(region ?? '');
    return `arn:${partition}:budgets::${accountId}:budget/${budgetName}`;
  }

  /**
   * Convert a CFn `Spend` shape to the SDK shape. CFn templates carry
   * `Amount` as a number (CDK synthesizes `budgetLimit: { amount: 10 }` to a
   * numeric JSON value); the SDK wants a numeric string.
   */
  toSdkSpend(raw: unknown): Spend | undefined {
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
   * seconds (possibly as a numeric string). A date string with no offset is
   * read as UTC, never the deployer's local zone (issue #5311).
   */
  toSdkDate(
    raw: unknown,
    field: string,
    logicalId: string,
    resourceType: string,
    mask: MaskerFn
  ): Date {
    let date: Date;
    if (typeof raw === 'number') {
      // Epoch. Values below 10^12 are seconds (10^12 ms is 2001-09-09;
      // an epoch-seconds value can never reach it before year 33658).
      date = new Date(raw < 1e12 ? raw * 1000 : raw);
    } else if (typeof raw === 'string' && /^\d+$/.test(raw)) {
      const num = Number(raw);
      date = new Date(num < 1e12 ? num * 1000 : num);
    } else if (typeof raw === 'string') {
      date = parseCfnTimestamp(raw);
    } else {
      throw new ProvisioningError(
        `Invalid TimePeriod.${field} for budget ${logicalId}: expected a date string or epoch ` +
          `timestamp, got ${JSON.stringify(maskDeep(raw, mask))}`,
        resourceType,
        logicalId
      );
    }
    if (Number.isNaN(date.getTime())) {
      throw new ProvisioningError(
        `Invalid TimePeriod.${field} for budget ${logicalId}: ` +
          `${JSON.stringify(maskDeep(raw, mask))} is not a parseable date`,
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
  toSdkBudget(
    raw: unknown,
    budgetName: string,
    logicalId: string,
    resourceType: string,
    mask: MaskerFn
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
        period.Start = this.toSdkDate(rawPeriod['Start'], 'Start', logicalId, resourceType, mask);
      }
      if (rawPeriod['End'] !== undefined) {
        period.End = this.toSdkDate(rawPeriod['End'], 'End', logicalId, resourceType, mask);
      }
      budget['TimePeriod'] = period;
    }
    return budget as unknown as Budget;
  }

  /** Normalize a CFn notification block to the SDK `Notification` shape. */
  toSdkNotification(raw: Record<string, unknown>): Notification {
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
  toSdkSubscriber(raw: Record<string, unknown>): Subscriber {
    return {
      SubscriptionType: raw['SubscriptionType'] as Subscriber['SubscriptionType'],
      Address: raw['Address'] as string | undefined,
    };
  }

  /**
   * Map well-formed `NotificationsWithSubscribers` entries (see
   * `readBudgetList` in budgets-budget/shared.ts) to the SDK shape.
   */
  toSdkNotificationsWithSubscribers(
    items: Record<string, unknown>[]
  ): NotificationWithSubscribers[] {
    return items.map((entry) => {
      const subscribers = entry['Subscribers'];
      return {
        Notification: this.toSdkNotification(entry['Notification'] as Record<string, unknown>),
        Subscribers: Array.isArray(subscribers)
          ? (subscribers as Record<string, unknown>[]).map((s) => this.toSdkSubscriber(s))
          : undefined,
      };
    });
  }

  /**
   * Identity key for a notification. The Budgets API addresses notifications
   * by their full value (there is no notification id), so the reconciler
   * treats a change to any of these fields as delete-old + create-new.
   * `ThresholdType` defaults to `PERCENTAGE` service-side — normalize the
   * absent case so an explicit `PERCENTAGE` and an omitted one compare equal.
   */
  notificationKey(n: Notification): string {
    return JSON.stringify([
      n.NotificationType,
      n.ComparisonOperator,
      n.Threshold,
      n.ThresholdType ?? 'PERCENTAGE',
    ]);
  }

  /** Identity key for a subscriber. */
  subscriberKey(s: Subscriber): string {
    return JSON.stringify([s.SubscriptionType, s.Address]);
  }

  /**
   * Map well-formed `ResourceTags` entries (see `readBudgetList` in
   * budgets-budget/shared.ts) to the SDK shape.
   */
  toSdkResourceTags(items: Record<string, unknown>[]): ResourceTag[] {
    return items.map((tag) => {
      const value = tag['Value'];
      return {
        Key: tag['Key'] as string,
        Value:
          typeof value === 'string'
            ? value
            : typeof value === 'number' || typeof value === 'boolean'
              ? String(value)
              : '',
      };
    });
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

  readDesiredLists(
    logicalId: string,
    resourceType: string,
    values: Record<BudgetListKind, unknown>,
    physicalId: string | undefined
  ): Record<BudgetListKind, Record<string, unknown>[]> {
    return readDesiredLists.call(this, logicalId, resourceType, values, physicalId);
  }

  addNotificationsOnly(
    accountId: string,
    budgetName: string,
    list: NotificationWithSubscribers[]
  ): Promise<void> {
    return addNotificationsOnly.call(this, accountId, budgetName, list);
  }

  createNotificationOrSubscribers(
    accountId: string,
    budgetName: string,
    nws: NotificationWithSubscribers
  ): Promise<void> {
    return createNotificationOrSubscribers.call(this, accountId, budgetName, nws);
  }

  sendDeleteIdempotent(
    command: DeleteNotificationCommand | DeleteSubscriberCommand,
    what: string
  ): Promise<void> {
    return sendDeleteIdempotent.call(this, command, what);
  }

  sendCreateIdempotent(
    command: CreateNotificationCommand | CreateSubscriberCommand,
    what: string
  ): Promise<void> {
    return sendCreateIdempotent.call(this, command, what);
  }

  reconcileNotifications(
    accountId: string,
    budgetName: string,
    oldList: NotificationWithSubscribers[],
    newList: NotificationWithSubscribers[]
  ): Promise<void> {
    return reconcileNotifications.call(this, accountId, budgetName, oldList, newList);
  }

  reconcileResourceTags(
    accountId: string,
    budgetName: string,
    oldTags: ResourceTag[],
    newTags: ResourceTag[]
  ): Promise<void> {
    return reconcileResourceTags.call(this, accountId, budgetName, oldTags, newTags);
  }

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  /**
   * `Fn::GetAtt` support. CloudFormation documents no attributes for
   * `AWS::Budgets::Budget`; `Arn` is served as a cdkd convenience (computed
   * — Budgets ARNs are `arn:{partition}:budgets::{account}:budget/{name}`, verified
   * to exist via `DescribeBudget` first).
   */
  async getAttribute(
    physicalId: string,
    resourceType: string,
    attributeName: string,
    logicalId: string
  ): Promise<unknown> {
    if (attributeName !== 'Arn') {
      throw new ProvisioningError(
        `Unknown attribute ${attributeName} for ${resourceType}`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    try {
      const accountId = await this.resolveAccountId();
      await this.getClient().send(
        new DescribeBudgetCommand({ AccountId: accountId, BudgetName: physicalId })
      );
      return await this.budgetArn(accountId, physicalId);
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapMaskedError(
        maskerOrIdentity(undefined),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to resolve Arn for budget ${physicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  readCurrentState(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, logicalId, resourceType, properties);
  }

  listNotifications(accountId: string, budgetName: string): Promise<Notification[] | undefined> {
    return listNotifications.call(this, accountId, budgetName);
  }

  listSubscribers(
    accountId: string,
    budgetName: string,
    notification: Notification
  ): Promise<Subscriber[] | undefined> {
    return listSubscribers.call(this, accountId, budgetName, notification);
  }

  budgetFromSdk(budget: Budget): Record<string, unknown> {
    return budgetFromSdk.call(this, budget);
  }

  /**
   * Notifications, and each notification's subscribers, are sets: Budgets
   * addresses them by value and returns them in an order of its own. The
   * subtree entry also claims every `Subscribers` array inside an element.
   */
  getDriftUnorderedPaths(resourceType: string): string[] {
    return resourceType === 'AWS::Budgets::Budget' ? ['NotificationsWithSubscribers'] : [];
  }

  /**
   * - `Budget.BudgetLimit` is AWS's to set on a budget that declares
   *   `AutoAdjustData` (recomputed from spend history) or `PlannedBudgetLimits`
   *   (the current period's planned amount), so a moving value there is not
   *   drift.
   * - `Budget.CostTypes` / `Budget.CostFilters` on a budget that also declares
   *   `FilterExpression` or `Metrics`: AWS accepts that mix, but `DescribeBudget`
   *   returns neither legacy member in either shape (measured live, PR #5188),
   *   so they cannot be read back.
   */
  getDriftUnknownPaths(resourceType: string, properties?: Record<string, unknown>): string[] {
    if (resourceType !== 'AWS::Budgets::Budget') return [];
    const budget = properties?.['Budget'];
    if (!isPlainRecord(budget)) return [];
    const paths: string[] = [];
    if (budget['AutoAdjustData'] != null || budget['PlannedBudgetLimits'] != null) {
      paths.push('Budget.BudgetLimit');
    }
    if (budget['FilterExpression'] != null || budget['Metrics'] != null) {
      if (budget['CostTypes'] != null) paths.push('Budget.CostTypes');
      if (budget['CostFilters'] != null) paths.push('Budget.CostFilters');
    }
    return paths;
  }

  /** See {@link canonicalizeBudgetDriftBag}. */
  canonicalizeDriftProperties(
    resourceType: string,
    side: Record<string, unknown>
  ): Record<string, unknown> {
    return resourceType === 'AWS::Budgets::Budget' ? canonicalizeBudgetDriftBag(side) : side;
  }

  canonicalizeDriftPair(
    resourceType: string,
    baseline: Record<string, unknown>,
    aws: Record<string, unknown>
  ): Promise<{ baseline: Record<string, unknown>; aws: Record<string, unknown> }> {
    return canonicalizeDriftPair.call(this, resourceType, baseline, aws);
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }
}
