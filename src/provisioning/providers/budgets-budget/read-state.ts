import {
  DescribeBudgetCommand,
  DescribeNotificationsForBudgetCommand,
  DescribeSubscribersForNotificationCommand,
  ListTagsForResourceCommand,
  NotFoundException,
  type Budget,
  type Notification,
  type Spend,
  type Subscriber,
} from '@aws-sdk/client-budgets';
import type { BudgetsBudgetProvider } from '../budgets-budget-provider.js';
import {
  RESOURCE_NOT_FOUND,
  type ResourceNotFound,
  type ResourceImportInput,
  type ResourceImportResult,
} from '../../../types/resource.js';
import {
  declaresLegacyFilterShape,
  dropElapsedPlannedLimits,
  finiteNumber,
  isPlainRecord,
  isoDate,
} from './shared.js';

/**
 * Read the budget back in the CFn property shape (go-to-k/cdkd#5183), for
 * `cdkd drift` and the deploy-time `observedProperties` capture:
 * `DescribeBudget`, `DescribeNotificationsForBudget`, one
 * `DescribeSubscribersForNotification` per notification, and
 * `ListTagsForResource`.
 *
 * Only CFn `BudgetData` members are emitted. `CalculatedSpend`,
 * `LastUpdatedTime`, `HealthStatus`, `AutoAdjustData.LastAutoAdjustTime` and
 * `HistoricalOptions.LookBackAvailablePeriods` change on their own and
 * would read as drift. Amounts come back as numbers (AWS returns `"1.0"`,
 * a CDK template `1`), dates as ISO strings. `ThresholdType` is emitted only
 * when it is not the default `PERCENTAGE`, the shape a template that omits
 * it records. Order and the default are left to
 * {@link getDriftUnorderedPaths} and {@link canonicalizeDriftProperties},
 * which see both sides.
 *
 * `DescribeBudget` answers in one of two filter shapes, never both
 * (measured live, see PR #5188): with `ShowFilterExpression: true` it
 * returns `FilterExpression` + `Metrics` and no `CostFilters` / `CostTypes`,
 * even for a budget created with `CostFilters`; without it, the legacy
 * `CostFilters` + `CostTypes` and no `FilterExpression`. The read asks for
 * the shape the recorded properties declare ({@link declaresLegacyFilterShape}),
 * so an unchanged budget compares clean and `drift --revert`, which sends
 * the readback for every member that did not drift, sends `UpdateBudget`
 * the shape the template was deployed with, never an unfiltered budget.
 */
export async function readCurrentState(
  this: BudgetsBudgetProvider,
  physicalId: string,
  _logicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  if (resourceType !== 'AWS::Budgets::Budget') return undefined;
  const accountId = await this.resolveAccountId();
  const client = this.getClient();

  // The Budgets namespace is global (see the class doc), so a NotFound is
  // trustworthy from any region.
  const describe = async (): Promise<Budget | ResourceNotFound | undefined> => {
    try {
      const response = await client.send(
        new DescribeBudgetCommand({
          AccountId: accountId,
          BudgetName: physicalId,
          ShowFilterExpression: !declaresLegacyFilterShape(properties),
        })
      );
      return response.Budget;
    } catch (error) {
      if (error instanceof NotFoundException) return RESOURCE_NOT_FOUND;
      throw error;
    }
  };
  const budget = await describe();
  if (budget === RESOURCE_NOT_FOUND || budget === undefined) return budget;

  // A NotFound from a later call is either "none of these" or the budget
  // going away mid-read: ask again, so a deleted budget reads as deleted
  // rather than as a budget whose notifications were all removed.
  const notifications = await this.listNotifications(accountId, physicalId);
  if (notifications === undefined && (await describe()) === RESOURCE_NOT_FOUND) {
    return RESOURCE_NOT_FOUND;
  }
  const withSubscribers = await Promise.all(
    (notifications ?? []).map(async (notification) => {
      const subscribers = await this.listSubscribers(accountId, physicalId, notification);
      return subscribers === undefined ? undefined : { notification, subscribers };
    })
  );
  const notificationsWithSubscribers = withSubscribers
    .filter((e): e is { notification: Notification; subscribers: Subscriber[] } => e !== undefined)
    .map(({ notification, subscribers }) => ({
      Notification: {
        NotificationType: notification.NotificationType,
        ComparisonOperator: notification.ComparisonOperator,
        Threshold: notification.Threshold,
        ...(notification.ThresholdType !== undefined &&
          notification.ThresholdType !== 'PERCENTAGE' && {
            ThresholdType: notification.ThresholdType,
          }),
      },
      Subscribers: subscribers.map((s) => ({
        SubscriptionType: s.SubscriptionType,
        Address: s.Address,
      })),
    }));
  let tags;
  try {
    tags = await client.send(
      new ListTagsForResourceCommand({
        ResourceARN: await this.budgetArn(accountId, physicalId),
      })
    );
  } catch (error) {
    if (error instanceof NotFoundException && (await describe()) === RESOURCE_NOT_FOUND) {
      return RESOURCE_NOT_FOUND;
    }
    throw error;
  }

  return {
    Budget: this.budgetFromSdk(budget),
    NotificationsWithSubscribers: notificationsWithSubscribers,
    ResourceTags: (tags.ResourceTags ?? []).map((t) => ({ Key: t.Key, Value: t.Value })),
  };
}

/**
 * Every notification on the budget, or `undefined` on a `NotFoundException`:
 * no notification, or the budget went away mid-read (`readCurrentState`
 * tells the two apart).
 */
export async function listNotifications(
  this: BudgetsBudgetProvider,
  accountId: string,
  budgetName: string
): Promise<Notification[] | undefined> {
  const out: Notification[] = [];
  let token: string | undefined;
  try {
    do {
      const page = await this.getClient().send(
        new DescribeNotificationsForBudgetCommand({
          AccountId: accountId,
          BudgetName: budgetName,
          MaxResults: 100,
          ...(token !== undefined && { NextToken: token }),
        })
      );
      out.push(...(page.Notifications ?? []));
      token = page.NextToken;
    } while (token);
  } catch (error) {
    if (error instanceof NotFoundException) return undefined;
    throw error;
  }
  return out;
}

/**
 * Every subscriber of one notification, or `undefined` on a
 * `NotFoundException`: the notification was removed between the two reads,
 * so `readCurrentState` leaves it out rather than report it subscriber-less.
 */
export async function listSubscribers(
  this: BudgetsBudgetProvider,
  accountId: string,
  budgetName: string,
  notification: Notification
): Promise<Subscriber[] | undefined> {
  const out: Subscriber[] = [];
  let token: string | undefined;
  try {
    do {
      const page = await this.getClient().send(
        new DescribeSubscribersForNotificationCommand({
          AccountId: accountId,
          BudgetName: budgetName,
          Notification: {
            NotificationType: notification.NotificationType,
            ComparisonOperator: notification.ComparisonOperator,
            Threshold: notification.Threshold,
            ...(notification.ThresholdType !== undefined && {
              ThresholdType: notification.ThresholdType,
            }),
          },
          MaxResults: 100,
          ...(token !== undefined && { NextToken: token }),
        })
      );
      out.push(...(page.Subscribers ?? []));
      token = page.NextToken;
    } while (token);
  } catch (error) {
    if (error instanceof NotFoundException) return undefined;
    throw error;
  }
  return out;
}

/** The CFn `BudgetData` members of a `DescribeBudget` response (see {@link readCurrentState}). */
export function budgetFromSdk(
  this: BudgetsBudgetProvider,
  budget: Budget
): Record<string, unknown> {
  const raw = budget as Budget & Record<string, unknown>;
  const spend = (s: Spend | undefined): Record<string, unknown> | undefined =>
    s === undefined ? undefined : { Amount: finiteNumber(s.Amount) ?? s.Amount, Unit: s.Unit };
  const out: Record<string, unknown> = {
    BudgetName: budget.BudgetName,
    BudgetType: raw['BudgetType'],
    TimeUnit: budget.TimeUnit,
  };
  if (budget.BudgetLimit) out['BudgetLimit'] = spend(budget.BudgetLimit);
  if (budget.PlannedBudgetLimits && Object.keys(budget.PlannedBudgetLimits).length > 0) {
    out['PlannedBudgetLimits'] = Object.fromEntries(
      Object.entries(budget.PlannedBudgetLimits).map(([key, s]) => [key, spend(s)])
    );
  }
  if (budget.TimePeriod) {
    out['TimePeriod'] = {
      ...(budget.TimePeriod.Start && { Start: isoDate(budget.TimePeriod.Start) }),
      ...(budget.TimePeriod.End && { End: isoDate(budget.TimePeriod.End) }),
    };
  }
  if (budget.CostFilters && Object.keys(budget.CostFilters).length > 0) {
    out['CostFilters'] = budget.CostFilters;
  }
  if (budget.CostTypes) out['CostTypes'] = { ...budget.CostTypes };
  const autoAdjust = raw['AutoAdjustData'];
  if (isPlainRecord(autoAdjust)) {
    const historical = autoAdjust['HistoricalOptions'];
    out['AutoAdjustData'] = {
      AutoAdjustType: autoAdjust['AutoAdjustType'],
      ...(isPlainRecord(historical) && {
        HistoricalOptions: { BudgetAdjustmentPeriod: historical['BudgetAdjustmentPeriod'] },
      }),
    };
  }
  if (raw['FilterExpression'] !== undefined) out['FilterExpression'] = raw['FilterExpression'];
  if (Array.isArray(raw['Metrics']) && raw['Metrics'].length > 0) out['Metrics'] = raw['Metrics'];
  if (raw['BillingViewArn'] !== undefined) out['BillingViewArn'] = raw['BillingViewArn'];
  return out;
}

/**
 * `DescribeBudget` returns the current and future `PlannedBudgetLimits`
 * only, so a period that has ended drops out of the readback while the
 * baseline keeps it. Drop from the BASELINE each key the readback lacks
 * whose period start (the key, in epoch seconds) is already past: that
 * absence is not drift, and `drift --revert`, which sends this baseline,
 * must not send an elapsed period either. A FUTURE key the readback lacks
 * stays, and is reported.
 */
export async function canonicalizeDriftPair(
  this: BudgetsBudgetProvider,
  resourceType: string,
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>
): Promise<{ baseline: Record<string, unknown>; aws: Record<string, unknown> }> {
  if (resourceType !== 'AWS::Budgets::Budget') return { baseline, aws };
  return { baseline: dropElapsedPlannedLimits(baseline, aws, Date.now()), aws };
}

/**
 * Adopt an existing budget into cdkd state.
 *
 * Lookup order:
 *  1. `--resource` override or `Properties.Budget.BudgetName` → verify via
 *     `DescribeBudget`.
 */
export async function importImpl(
  this: BudgetsBudgetProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
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
      await client.send(new DescribeBudgetCommand({ AccountId: accountId, BudgetName: explicit }));
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
