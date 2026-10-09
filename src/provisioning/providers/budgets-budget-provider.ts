import {
  BudgetsClient,
  CreateBudgetCommand,
  UpdateBudgetCommand,
  DeleteBudgetCommand,
  DescribeBudgetCommand,
  CreateNotificationCommand,
  DeleteNotificationCommand,
  CreateSubscriberCommand,
  DeleteSubscriberCommand,
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
import { derivePartitionAndUrlSuffix } from '../../utils/aws-partition.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import type {
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
import { markNonRetryable, wrapMaskedAwsError } from '../../deployment/retryable-errors.js';
import { safeMsg } from '../../utils/display-safe.js';
import { holdsSecretDerivedEntry } from '../iam-policy-targets.js';

// ─── List reads (go-to-k/cdkd#3989) ─────────────────────────────────
//
// `reconcileNotifications` / `reconcileResourceTags` derive their DELETES from
// the gap between the desired and the recorded list. Reading a present-but-
// malformed value (or dropping a malformed entry) as empty therefore deleted
// every notification (with its subscribers) / untagged every key the other
// side holds: on a rollback or `drift --revert`, where the desired side is a
// recorded bag, `NotificationsWithSubscribers: {}` stripped the budget of its
// alerts. So `undefined` / `null` is ABSENT (an empty list), and anything else
// that is not a list of well-formed entries is MALFORMED. A malformed DESIRED
// side is refused before any call; a malformed RECORDED side is applied
// ADD-only (see `update`).

type BudgetListKind = 'NotificationsWithSubscribers' | 'ResourceTags';
type BudgetListSide = 'desired' | 'recorded';

type BudgetListRead =
  | { kind: 'list'; items: Record<string, unknown>[] }
  // `onlySecret`: well-shaped, and malformed ONLY because an identity member
  // holds a dynamic reference or its mask.
  | { kind: 'malformed'; onlySecret: boolean };

const BUDGET_LIST_WHAT: Record<BudgetListKind, string> = {
  NotificationsWithSubscribers:
    'entries with a Notification (NotificationType, ComparisonOperator, numeric Threshold) ' +
    'and Subscribers (SubscriptionType, Address)',
  ResourceTags: 'tags with a string Key',
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** A finite number, or a string holding one (CFn coerces scalars). */
function isThreshold(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
}

/**
 * `side` matters for identity members only. A DESIRED notification or
 * subscriber Address (or tag Key) holding a dynamic reference or its mask names
 * nothing Budgets holds, so it is malformed. A RECORDED one is what cdkd writes
 * for a value that came from a secret (cdkd keeps the reference in state): it
 * is read, and `removableRecorded` keeps it out of the delete set.
 */
function isWellFormedBudgetEntry(
  kind: BudgetListKind,
  entry: unknown,
  side: BudgetListSide,
  ignoreSecrets = false
): boolean {
  if (!isPlainRecord(entry)) return false;
  const checkSecret = side === 'desired' && !ignoreSecrets;
  if (kind === 'ResourceTags') {
    if (!isNonEmptyString(entry['Key'])) return false;
    // A `Value` keeps its existing coercion (a non-scalar sends `''`): only the
    // Key decides what is untagged.
    return !(checkSecret && holdsSecretDerivedEntry(entry['Key']));
  }
  const notification = entry['Notification'];
  if (
    !isPlainRecord(notification) ||
    !isNonEmptyString(notification['NotificationType']) ||
    !isNonEmptyString(notification['ComparisonOperator']) ||
    !isThreshold(notification['Threshold']) ||
    (notification['ThresholdType'] != null && !isNonEmptyString(notification['ThresholdType']))
  ) {
    return false;
  }
  if (checkSecret && holdsSecretDerivedEntry(notification)) return false;
  const subscribers = entry['Subscribers'];
  if (subscribers == null) return true;
  return (
    Array.isArray(subscribers) &&
    subscribers.every(
      (s) =>
        isPlainRecord(s) &&
        isNonEmptyString(s['SubscriptionType']) &&
        isNonEmptyString(s['Address']) &&
        !(checkSecret && holdsSecretDerivedEntry(s['Address']))
    )
  );
}

/** Read one list property; ABSENT (`undefined` / `null`) reads as the empty list. */
function readBudgetList(
  kind: BudgetListKind,
  value: unknown,
  side: BudgetListSide
): BudgetListRead {
  if (value === undefined || value === null) return { kind: 'list', items: [] };
  if (Array.isArray(value) && value.every((e) => isWellFormedBudgetEntry(kind, e, side))) {
    return { kind: 'list', items: value as Record<string, unknown>[] };
  }
  return {
    kind: 'malformed',
    onlySecret:
      Array.isArray(value) && value.every((e) => isWellFormedBudgetEntry(kind, e, side, true)),
  };
}

/**
 * A recorded list minus every secret-derived identity: a notification whose
 * block holds one, a subscriber whose Address does, a tag whose Key does. The
 * reconciler would otherwise send a delete naming a literal `{{resolve:...}}`.
 * Dropping it only misses that one removal, the safe direction.
 */
function removableRecorded(
  kind: BudgetListKind,
  items: Record<string, unknown>[]
): Record<string, unknown>[] {
  if (kind === 'ResourceTags') return items.filter((t) => !holdsSecretDerivedEntry(t['Key']));
  return items
    .filter((e) => !holdsSecretDerivedEntry(e['Notification']))
    .map((e) =>
      Array.isArray(e['Subscribers'])
        ? {
            ...e,
            Subscribers: (e['Subscribers'] as Record<string, unknown>[]).filter(
              (s) => !holdsSecretDerivedEntry(s['Address'])
            ),
          }
        : e
    );
}

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
   * The `ProvisioningError` a failed create / update throws, quoting AWS's
   * text through the operation's masker (issue #2176): a refusal or a 5xx can
   * quote a resolved secret-derived value.
   */
  private wrapBudgetError(
    mask: MaskerFn,
    error: unknown,
    verb: 'create' | 'update',
    logicalId: string,
    resourceType: string,
    physicalId: string | undefined
  ): ProvisioningError {
    const cause = error instanceof Error ? error : undefined;
    return wrapMaskedAwsError(
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

  private getCreateClient(): BudgetsClient {
    this.getClient();
    return this.createClient as BudgetsClient;
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
  private async budgetArn(accountId: string, budgetName: string): Promise<string> {
    const region = await this.getClient().config.region();
    const { partition } = derivePartitionAndUrlSuffix(region ?? '');
    return `arn:${partition}:budgets::${accountId}:budget/${budgetName}`;
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
  private toSdkDate(
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
      date = new Date(raw);
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
  private toSdkBudget(
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
   * Map well-formed `NotificationsWithSubscribers` entries (see
   * {@link readBudgetList}) to the SDK shape.
   */
  private toSdkNotificationsWithSubscribers(
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

  /** Map well-formed `ResourceTags` entries (see {@link readBudgetList}) to the SDK shape. */
  private toSdkResourceTags(items: Record<string, unknown>[]): ResourceTag[] {
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

  /**
   * Create a budget via `CreateBudget` (a single call carries the budget,
   * its notifications with subscribers, and resource tags — no post-create
   * wiring to clean up on partial failure).
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    // Issue #2178: `toSdkDate` quotes the offending `TimePeriod` value back at
    // the user, and `properties` arrives RESOLVED. Absent means unmasked, the
    // back-compatible default the SecretMaskingContext contract mandates.
    const mask = maskerOrIdentity(context?.maskSecrets);

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

    // go-to-k/cdkd#3989: refused before any call, so a malformed list never
    // creates a budget missing the alerts or tags the template declares.
    const lists = this.readDesiredLists(
      logicalId,
      resourceType,
      {
        NotificationsWithSubscribers: properties['NotificationsWithSubscribers'],
        ResourceTags: properties['ResourceTags'],
      },
      undefined
    );

    try {
      const accountId = await this.resolveAccountId();
      const notifications = this.toSdkNotificationsWithSubscribers(
        lists.NotificationsWithSubscribers
      );
      const resourceTags = this.toSdkResourceTags(lists.ResourceTags);
      // Read before CreateBudget, so nothing can fail once the budget exists
      // (go-to-k/cdkd#4583).
      const arn = await this.budgetArn(accountId, name);

      await this.getCreateClient().send(
        new CreateBudgetCommand({
          AccountId: accountId,
          Budget: this.toSdkBudget(properties['Budget'], name, logicalId, resourceType, mask),
          ...(notifications.length > 0 && { NotificationsWithSubscribers: notifications }),
          ...(resourceTags.length > 0 && { ResourceTags: resourceTags }),
        })
      );

      this.logger.debug(`Successfully created budget ${logicalId}: ${name}`);
      return {
        physicalId: name,
        attributes: {
          Arn: arn,
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      throw this.wrapBudgetError(mask, error, 'create', logicalId, resourceType, undefined);
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
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    // Issue #2178: same refusal, same bag, so the same sink (see `create`).
    const mask = maskerOrIdentity(context?.maskSecrets);

    this.logger.debug(`Updating budget ${logicalId}: ${physicalId}`);

    // go-to-k/cdkd#3989: a malformed desired list is refused before any call.
    const next = this.readDesiredLists(
      logicalId,
      resourceType,
      {
        NotificationsWithSubscribers: properties['NotificationsWithSubscribers'],
        ResourceTags: properties['ResourceTags'],
      },
      physicalId
    );
    const prevNotifications = readBudgetList(
      'NotificationsWithSubscribers',
      previousProperties['NotificationsWithSubscribers'],
      'recorded'
    );
    const prevTags = readBudgetList('ResourceTags', previousProperties['ResourceTags'], 'recorded');

    try {
      const accountId = await this.resolveAccountId();

      // The physical id is the budget name: a rename is classified as
      // replacement upstream (replacement-rules.ts), so `physicalId` is the
      // authoritative name here.
      await this.getClient().send(
        new UpdateBudgetCommand({
          AccountId: accountId,
          NewBudget: this.toSdkBudget(
            properties['Budget'],
            physicalId,
            logicalId,
            resourceType,
            mask
          ),
        })
      );

      const newNotifications = this.toSdkNotificationsWithSubscribers(
        next.NotificationsWithSubscribers
      );
      if (prevNotifications.kind === 'list') {
        await this.reconcileNotifications(
          accountId,
          physicalId,
          this.toSdkNotificationsWithSubscribers(
            removableRecorded('NotificationsWithSubscribers', prevNotifications.items)
          ),
          newNotifications
        );
      } else {
        try {
          await this.addNotificationsOnly(accountId, physicalId, newNotifications);
        } catch (error) {
          // Nothing was deleted first, so the budget's existing notifications
          // still count toward its limits (5 notifications, 10 email
          // subscribers each): name what was being added beside them.
          throw new ProvisioningError(
            `Failed to update budget ${logicalId}: adding ${newNotifications.length} desired ` +
              `notification(s) beside every notification the budget already holds (the recorded ` +
              `NotificationsWithSubscribers is not a list cdkd can read, so none was deleted; a ` +
              `budget allows at most 5 notifications and 10 email subscribers each): ` +
              `${error instanceof Error ? error.message : String(error)}`,
            resourceType,
            logicalId,
            physicalId,
            error instanceof Error ? error : undefined
          );
        }
        this.logger.warn(
          safeMsg`The recorded NotificationsWithSubscribers of budget ${logicalId} is not a list cdkd can read, so cdkd deleted no notification or subscriber and only added the desired ones. Delete any the template no longer names yourself.`
        );
      }

      const newTags = this.toSdkResourceTags(next.ResourceTags);
      if (prevTags.kind === 'list') {
        await this.reconcileResourceTags(
          accountId,
          physicalId,
          this.toSdkResourceTags(removableRecorded('ResourceTags', prevTags.items)),
          newTags
        );
      } else {
        if (newTags.length > 0) {
          await this.getClient().send(
            new TagResourceCommand({
              ResourceARN: await this.budgetArn(accountId, physicalId),
              ResourceTags: newTags,
            })
          );
        }
        this.logger.warn(
          safeMsg`The recorded ResourceTags of budget ${logicalId} is not a list cdkd can read, so cdkd removed no tag and only applied the desired ones. Untag any key the template no longer names yourself.`
        );
      }

      this.logger.debug(`Successfully updated budget ${logicalId}`);
      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: await this.budgetArn(accountId, physicalId),
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      throw this.wrapBudgetError(mask, error, 'update', logicalId, resourceType, physicalId);
    }
  }

  /**
   * Read the DESIRED lists of a create or update, refusing a malformed one
   * before any call (go-to-k/cdkd#3989). The caller passes its own literal read
   * of each property so the handled-property wiring walk still sees which
   * property feeds the calls. `physicalId` is set on the update path.
   */
  private readDesiredLists(
    logicalId: string,
    resourceType: string,
    values: Record<BudgetListKind, unknown>,
    physicalId: string | undefined
  ): Record<BudgetListKind, Record<string, unknown>[]> {
    const kinds: BudgetListKind[] = ['NotificationsWithSubscribers', 'ResourceTags'];
    const out = {} as Record<BudgetListKind, Record<string, unknown>[]>;
    const bad: BudgetListKind[] = [];
    const secret: BudgetListKind[] = [];
    for (const kind of kinds) {
      const read = readBudgetList(kind, values[kind], 'desired');
      if (read.kind === 'list') {
        out[kind] = read.items;
      } else {
        bad.push(kind);
        if (read.onlySecret) secret.push(kind);
      }
    }
    if (bad.length === 0) return out;
    const updating = physicalId !== undefined;
    throw markNonRetryable(
      new ProvisioningError(
        `${updating ? 'desired ' : ''}${bad.join(' / ')} of budget ${logicalId} is not a list ` +
          `of ${bad.map((k) => BUDGET_LIST_WHAT[k]).join(' / ')}` +
          (secret.length > 0
            ? ` (${secret.join(' / ')} holds a dynamic reference or its mask where an ` +
              `identifying value belongs, which names nothing Budgets holds)`
            : '') +
          ` — the budget was not ${updating ? 'updated' : 'created'}`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }

  /**
   * The ADD-only arm for a recorded `NotificationsWithSubscribers` cdkd cannot
   * read (go-to-k/cdkd#3989): create every desired notification (see
   * {@link createNotificationOrSubscribers}). Nothing is deleted, so a
   * notification or subscriber the desired side omits stays in place.
   */
  private async addNotificationsOnly(
    accountId: string,
    budgetName: string,
    list: NotificationWithSubscribers[]
  ): Promise<void> {
    for (const nws of list) {
      await this.createNotificationOrSubscribers(accountId, budgetName, nws);
    }
  }

  /**
   * Create a notification with its subscribers; on one that already exists
   * (`DuplicateRecordException` — a retry, or a notification the old side did
   * not list) create each desired subscriber instead, so none is skipped.
   */
  private async createNotificationOrSubscribers(
    accountId: string,
    budgetName: string,
    nws: NotificationWithSubscribers
  ): Promise<void> {
    const key = this.notificationKey(nws.Notification as Notification);
    try {
      await this.getClient().send(
        new CreateNotificationCommand({
          AccountId: accountId,
          BudgetName: budgetName,
          Notification: nws.Notification,
          Subscribers: nws.Subscribers,
        })
      );
      return;
    } catch (error) {
      if (!(error instanceof DuplicateRecordException)) throw error;
      this.logger.debug(safeMsg`Notification ${key} already exists, creating its subscribers`);
    }
    for (const subscriber of nws.Subscribers ?? []) {
      await this.sendCreateIdempotent(
        new CreateSubscriberCommand({
          AccountId: accountId,
          BudgetName: budgetName,
          Notification: nws.Notification,
          Subscriber: subscriber,
        }),
        `Subscriber ${this.subscriberKey(subscriber)} on notification ${key}`
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

    // Added notifications (created with their full subscriber list; one that
    // already exists gets its desired subscribers instead).
    for (const [key, nws] of newByKey) {
      if (oldByKey.has(key)) continue;
      await this.createNotificationOrSubscribers(accountId, budgetName, nws);
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

    const arn = await this.budgetArn(accountId, budgetName);
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
      throw new ProvisioningError(
        `Failed to resolve Arn for budget ${physicalId}: ${cause?.message ?? String(error)}`,
        resourceType,
        logicalId,
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
          attributes: { Arn: await this.budgetArn(accountId, explicit) },
        };
      } catch (error) {
        if (error instanceof NotFoundException) return null;
        throw error;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // DescribeStackResources or the template's physical-name property; a
    // budget reaching here needs an explicit `--resource` override.
    return null;
  }
}
