import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());
const mockStsSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-budgets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-budgets')>();
  return {
    ...actual,
    BudgetsClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ sts: { send: mockStsSend } }),
}));

import {
  DescribeBudgetCommand,
  DescribeNotificationsForBudgetCommand,
  DescribeSubscribersForNotificationCommand,
  ListTagsForResourceCommand,
  NotFoundException,
  UpdateBudgetCommand,
} from '@aws-sdk/client-budgets';
import { BudgetsBudgetProvider } from '../../../../src/provisioning/providers/budgets-budget-provider.js';
import { calculateResourceDrift } from '../../../../src/analyzer/drift-calculator.js';
import { RESOURCE_NOT_FOUND } from '../../../../src/types/resource.js';

/**
 * go-to-k/cdkd#5183: the budget's own read-back, which replaced the Cloud
 * Control fallback deny-list entry (#5179). Every AWS response below is the
 * shape the Budgets API returns live: amounts as `"1.0"` strings, dates as
 * `Date`s, `NotificationState` beside each notification, read-only spend and
 * health members on the budget.
 */

const TYPE = 'AWS::Budgets::Budget';
const ACCOUNT = '123456789012';
const NAME = 'cdkd-budgets-integ-budget';

const notFound = (): NotFoundException =>
  new NotFoundException({ message: 'not found', $metadata: {} });

interface AwsSide {
  amount?: string;
  notifications?: Record<string, unknown>[];
  subscribers?: Record<string, Record<string, unknown>[]>;
  tags?: { Key: string; Value: string }[] | undefined;
  budget?: Record<string, unknown>;
}

/** Route each command to the AWS-side fixture; subscribers keyed by Threshold. */
function awsHolds(side: AwsSide): void {
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof DescribeBudgetCommand) {
      return Promise.resolve({
        Budget: side.budget ?? {
          BudgetName: NAME,
          BudgetLimit: { Amount: side.amount ?? '1.0', Unit: 'USD' },
          CostTypes: { IncludeTax: true, UseBlended: false },
          TimeUnit: 'MONTHLY',
          TimePeriod: {
            Start: new Date('2026-10-01T00:00:00Z'),
            End: new Date('2087-06-15T00:00:00Z'),
          },
          CalculatedSpend: { ActualSpend: { Amount: '0.0', Unit: 'USD' } },
          BudgetType: 'COST',
          LastUpdatedTime: new Date('2026-10-23T01:02:03Z'),
          HealthStatus: { Status: 'HEALTHY' },
        },
      });
    }
    if (command instanceof DescribeNotificationsForBudgetCommand) {
      return Promise.resolve({
        Notifications: side.notifications ?? [
          {
            NotificationType: 'ACTUAL',
            ComparisonOperator: 'GREATER_THAN',
            Threshold: 80,
            ThresholdType: 'PERCENTAGE',
            NotificationState: 'OK',
          },
        ],
      });
    }
    if (command instanceof DescribeSubscribersForNotificationCommand) {
      const threshold = String(command.input.Notification?.Threshold);
      return Promise.resolve({
        Subscribers: side.subscribers?.[threshold] ?? [
          { SubscriptionType: 'EMAIL', Address: 'b@example.com' },
          { SubscriptionType: 'EMAIL', Address: 'a@example.com' },
        ],
      });
    }
    if (command instanceof ListTagsForResourceCommand) {
      return Promise.resolve(side.tags === undefined ? {} : { ResourceTags: side.tags });
    }
    return Promise.reject(new Error(`unexpected command ${String(command)}`));
  });
}

/** What a CDK `CfnBudget` records in state for the AWS side above. */
const templateState = (): Record<string, unknown> => ({
  Budget: {
    BudgetName: NAME,
    BudgetType: 'COST',
    TimeUnit: 'MONTHLY',
    BudgetLimit: { Amount: 1, Unit: 'USD' },
  },
  NotificationsWithSubscribers: [
    {
      Notification: { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: 80 },
      Subscribers: [
        { SubscriptionType: 'EMAIL', Address: 'a@example.com' },
        { SubscriptionType: 'EMAIL', Address: 'b@example.com' },
      ],
    },
  ],
  ResourceTags: [
    { Key: 'team', Value: 'platform' },
    { Key: 'env', Value: 'dev' },
  ],
});

/** `cdkd drift`'s comparison through the provider's hooks, in drift.ts's order. */
function driftOf(
  provider: BudgetsBudgetProvider,
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>,
  // drift.ts walks the union of keys when the baseline is observedProperties.
  observed = false
): ReturnType<typeof calculateResourceDrift> {
  return calculateResourceDrift(
    provider.canonicalizeDriftProperties(TYPE, baseline),
    provider.canonicalizeDriftProperties(TYPE, aws),
    {
      ignorePaths: provider.getDriftUnknownPaths(TYPE, baseline),
      unorderedPaths: provider.getDriftUnorderedPaths(TYPE),
      unionWalkObjects: observed,
    }
  );
}

describe('BudgetsBudgetProvider readCurrentState (go-to-k/cdkd#5183)', () => {
  let provider: BudgetsBudgetProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStsSend.mockResolvedValue({ Account: ACCOUNT });
    provider = new BudgetsBudgetProvider();
  });

  it('maps the four reads into the CFn shape and drops the members AWS moves on its own', async () => {
    awsHolds({ tags: [{ Key: 'env', Value: 'dev' }] });

    const read = await provider.readCurrentState(NAME, 'CostBudget', TYPE);

    expect(read).toEqual({
      Budget: {
        BudgetName: NAME,
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: 1, Unit: 'USD' },
        TimePeriod: { Start: '2026-10-01T00:00:00.000Z', End: '2087-06-15T00:00:00.000Z' },
        CostTypes: { IncludeTax: true, UseBlended: false },
      },
      NotificationsWithSubscribers: [
        {
          // The default PERCENTAGE is left out, as a template omitting it records.
          Notification: {
            NotificationType: 'ACTUAL',
            ComparisonOperator: 'GREATER_THAN',
            Threshold: 80,
          },
          Subscribers: [
            { SubscriptionType: 'EMAIL', Address: 'b@example.com' },
            { SubscriptionType: 'EMAIL', Address: 'a@example.com' },
          ],
        },
      ],
      ResourceTags: [{ Key: 'env', Value: 'dev' }],
    });
    const describe = mockSend.mock.calls.find((c) => c[0] instanceof DescribeBudgetCommand);
    // FilterExpression is only returned on ShowFilterExpression.
    expect(describe?.[0].input).toEqual({
      AccountId: ACCOUNT,
      BudgetName: NAME,
      ShowFilterExpression: true,
    });
    const tags = mockSend.mock.calls.find((c) => c[0] instanceof ListTagsForResourceCommand);
    expect(tags?.[0].input).toEqual({
      ResourceARN: `arn:aws:budgets::${ACCOUNT}:budget/${NAME}`,
    });
  });

  it('asks for each notification its own subscribers, by its full value', async () => {
    awsHolds({
      notifications: [
        { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: 80 },
        {
          NotificationType: 'FORECASTED',
          ComparisonOperator: 'GREATER_THAN',
          Threshold: 100,
          ThresholdType: 'ABSOLUTE_VALUE',
        },
      ],
      subscribers: {
        '80': [{ SubscriptionType: 'EMAIL', Address: 'a@example.com' }],
        '100': [{ SubscriptionType: 'SNS', Address: 'arn:aws:sns:us-east-1:1:t' }],
      },
    });

    const read = (await provider.readCurrentState(NAME, 'CostBudget', TYPE)) as Record<
      string,
      unknown
    >;

    expect(read['NotificationsWithSubscribers']).toEqual([
      {
        Notification: { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: 80 },
        Subscribers: [{ SubscriptionType: 'EMAIL', Address: 'a@example.com' }],
      },
      {
        Notification: {
          NotificationType: 'FORECASTED',
          ComparisonOperator: 'GREATER_THAN',
          Threshold: 100,
          ThresholdType: 'ABSOLUTE_VALUE',
        },
        Subscribers: [{ SubscriptionType: 'SNS', Address: 'arn:aws:sns:us-east-1:1:t' }],
      },
    ]);
    const asked = mockSend.mock.calls
      .filter((c) => c[0] instanceof DescribeSubscribersForNotificationCommand)
      .map((c) => c[0].input.Notification);
    expect(asked).toEqual([
      { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: 80 },
      {
        NotificationType: 'FORECASTED',
        ComparisonOperator: 'GREATER_THAN',
        Threshold: 100,
        ThresholdType: 'ABSOLUTE_VALUE',
      },
    ]);
  });

  it('follows NextToken on the notification and subscriber lists', async () => {
    awsHolds({});
    const base = mockSend.getMockImplementation()!;
    let notificationPage = 0;
    let subscriberPage = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeNotificationsForBudgetCommand) {
        notificationPage++;
        return Promise.resolve(
          notificationPage === 1
            ? {
                Notifications: [
                  { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: 80 },
                ],
                NextToken: 'n2',
              }
            : {
                Notifications: [
                  { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: 90 },
                ],
              }
        );
      }
      if (command instanceof DescribeSubscribersForNotificationCommand) {
        if (command.input.Notification?.Threshold !== 80) {
          return Promise.resolve({ Subscribers: [{ SubscriptionType: 'EMAIL', Address: 'z@x.com' }] });
        }
        subscriberPage++;
        return Promise.resolve(
          subscriberPage === 1
            ? { Subscribers: [{ SubscriptionType: 'EMAIL', Address: 'a@x.com' }], NextToken: 's2' }
            : { Subscribers: [{ SubscriptionType: 'EMAIL', Address: 'b@x.com' }] }
        );
      }
      return base(command);
    });

    const read = (await provider.readCurrentState(NAME, 'CostBudget', TYPE)) as Record<
      string,
      unknown
    >;
    const list = read['NotificationsWithSubscribers'] as Record<string, unknown>[];

    expect(list.map((e) => (e['Notification'] as Record<string, unknown>)['Threshold'])).toEqual([
      80, 90,
    ]);
    expect(list[0]!['Subscribers']).toEqual([
      { SubscriptionType: 'EMAIL', Address: 'a@x.com' },
      { SubscriptionType: 'EMAIL', Address: 'b@x.com' },
    ]);
    const tokens = mockSend.mock.calls
      .filter((c) => c[0] instanceof DescribeNotificationsForBudgetCommand)
      .map((c) => c[0].input.NextToken);
    expect(tokens).toEqual([undefined, 'n2']);
    const subTokens = mockSend.mock.calls
      .filter(
        (c) =>
          c[0] instanceof DescribeSubscribersForNotificationCommand &&
          c[0].input.Notification?.Threshold === 80
      )
      .map((c) => c[0].input.NextToken);
    expect(subTokens).toEqual([undefined, 's2']);
  });

  it('reads a budget that is gone as RESOURCE_NOT_FOUND', async () => {
    mockSend.mockRejectedValue(notFound());
    await expect(provider.readCurrentState(NAME, 'CostBudget', TYPE)).resolves.toBe(
      RESOURCE_NOT_FOUND
    );
  });

  it('reads a NotFound from the notification list as no notifications, and no tags as []', async () => {
    awsHolds({ tags: undefined });
    const base = mockSend.getMockImplementation()!;
    mockSend.mockImplementation((command: unknown) =>
      command instanceof DescribeNotificationsForBudgetCommand
        ? Promise.reject(notFound())
        : base(command)
    );

    const read = (await provider.readCurrentState(NAME, 'CostBudget', TYPE)) as Record<
      string,
      unknown
    >;

    expect(read['NotificationsWithSubscribers']).toEqual([]);
    expect(read['ResourceTags']).toEqual([]);
  });

  it('reads a NotFound from a later call, with the budget gone, as RESOURCE_NOT_FOUND', async () => {
    for (const late of [DescribeNotificationsForBudgetCommand, ListTagsForResourceCommand]) {
      vi.clearAllMocks();
      mockStsSend.mockResolvedValue({ Account: ACCOUNT });
      awsHolds({});
      const base = mockSend.getMockImplementation()!;
      let describes = 0;
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof DescribeBudgetCommand && ++describes > 1) {
          return Promise.reject(notFound());
        }
        return command instanceof late ? Promise.reject(notFound()) : base(command);
      });
      await expect(provider.readCurrentState(NAME, 'CostBudget', TYPE)).resolves.toBe(
        RESOURCE_NOT_FOUND
      );
      expect(describes).toBe(2);
    }
  });

  it('leaves out a notification whose subscriber list answers NotFound (removed mid-read)', async () => {
    awsHolds({
      notifications: [
        { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: 80 },
        { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: 90 },
      ],
      subscribers: { '80': [{ SubscriptionType: 'EMAIL', Address: 'a@example.com' }] },
    });
    const base = mockSend.getMockImplementation()!;
    mockSend.mockImplementation((command: unknown) =>
      command instanceof DescribeSubscribersForNotificationCommand &&
      command.input.Notification?.Threshold === 90
        ? Promise.reject(notFound())
        : base(command)
    );
    const read = (await provider.readCurrentState(NAME, 'CostBudget', TYPE)) as Record<
      string,
      unknown
    >;
    expect(read['NotificationsWithSubscribers']).toEqual([
      {
        Notification: { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: 80 },
        Subscribers: [{ SubscriptionType: 'EMAIL', Address: 'a@example.com' }],
      },
    ]);
  });

  it('rethrows a tags NotFound while the budget still exists', async () => {
    awsHolds({});
    const base = mockSend.getMockImplementation()!;
    const tagsNotFound = notFound();
    mockSend.mockImplementation((command: unknown) =>
      command instanceof ListTagsForResourceCommand ? Promise.reject(tagsNotFound) : base(command)
    );
    await expect(provider.readCurrentState(NAME, 'CostBudget', TYPE)).rejects.toBe(tagsNotFound);
  });

  it('carries FilterExpression through, so a revert of another member keeps the filter', async () => {
    const filter = { Dimensions: { Key: 'SERVICE', Values: ['Amazon Simple Storage Service'] } };
    awsHolds({
      budget: {
        BudgetName: NAME,
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: '1.0', Unit: 'USD' },
        FilterExpression: filter,
      },
    });
    const read = (await provider.readCurrentState(NAME, 'CostBudget', TYPE)) as Record<
      string,
      unknown
    >;
    expect((read['Budget'] as Record<string, unknown>)['FilterExpression']).toEqual(filter);
  });

  it('rethrows any other read failure, so drift reports it rather than a clean row', async () => {
    const denied = new Error('AccessDenied');
    mockSend.mockRejectedValue(denied);
    await expect(provider.readCurrentState(NAME, 'CostBudget', TYPE)).rejects.toBe(denied);
  });

  it('answers undefined for any other type', async () => {
    await expect(provider.readCurrentState(NAME, 'L', 'AWS::SQS::Queue')).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('BudgetsBudgetProvider drift comparison (go-to-k/cdkd#5183)', () => {
  let provider: BudgetsBudgetProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStsSend.mockResolvedValue({ Account: ACCOUNT });
    provider = new BudgetsBudgetProvider();
  });

  const readBack = async (side: AwsSide): Promise<Record<string, unknown>> => {
    awsHolds({
      tags: [
        { Key: 'env', Value: 'dev' },
        { Key: 'team', Value: 'platform' },
      ],
      ...side,
    });
    return (await provider.readCurrentState(NAME, 'CostBudget', TYPE)) as Record<string, unknown>;
  };

  it('an unchanged budget compares clean against the template baseline', async () => {
    // Reordered subscribers, the defaulted ThresholdType, "1.0" for 1, and the
    // members the template never declared (TimePeriod, CostTypes).
    expect(driftOf(provider, templateState(), await readBack({}))).toEqual([]);
  });

  it('an unchanged budget compares clean against its own captured readback', async () => {
    const observed = JSON.parse(JSON.stringify(await readBack({}))) as Record<string, unknown>;
    expect(driftOf(provider, observed, await readBack({}), true)).toEqual([]);
    // ...and the union walk still sees a change against that baseline.
    expect(
      driftOf(provider, observed, await readBack({ amount: '3.0' }), true).map((d) => d.path)
    ).toEqual(['Budget.BudgetLimit.Amount']);
  });

  it('reads a CostFilters-only budget in the legacy shape, and it compares clean', async () => {
    // What DescribeBudget returns WITHOUT ShowFilterExpression for a budget
    // created with CostFilters only (measured live, PR #5188). With the flag
    // the same budget answers FilterExpression + Metrics and no CostFilters.
    const legacy = {
      Budget: {
        BudgetName: NAME,
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: 1, Unit: 'USD' },
        CostFilters: { Service: ['Amazon Simple Queue Service'] },
      },
    };
    awsHolds({
      budget: {
        BudgetName: NAME,
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: '1.0', Unit: 'USD' },
        CostFilters: { Service: ['Amazon Simple Queue Service'] },
        CostTypes: { IncludeTax: true },
      },
    });
    const read = (await provider.readCurrentState(NAME, 'CostBudget', TYPE, legacy)) as Record<
      string,
      unknown
    >;
    const describe = mockSend.mock.calls.find((c) => c[0] instanceof DescribeBudgetCommand);
    expect(describe?.[0].input.ShowFilterExpression).toBe(false);
    expect((read['Budget'] as Record<string, unknown>)['CostFilters']).toEqual({
      Service: ['Amazon Simple Queue Service'],
    });
    expect(driftOf(provider, legacy, read).filter((d) => d.path.startsWith('Budget'))).toEqual([]);
  });

  it('asks for the FilterExpression shape unless the budget declares only the legacy one', async () => {
    const asked = async (properties?: Record<string, unknown>): Promise<unknown> => {
      vi.clearAllMocks();
      mockStsSend.mockResolvedValue({ Account: ACCOUNT });
      awsHolds({});
      await provider.readCurrentState(NAME, 'CostBudget', TYPE, properties);
      const describe = mockSend.mock.calls.find((c) => c[0] instanceof DescribeBudgetCommand);
      return describe?.[0].input.ShowFilterExpression;
    };
    expect(await asked(undefined)).toBe(true);
    expect(await asked({})).toBe(true);
    expect(await asked(templateState())).toBe(true);
    expect(await asked({ Budget: { CostTypes: { IncludeTax: false } } })).toBe(false);
    expect(await asked({ Budget: { CostFilters: { Service: ['x'] } } })).toBe(false);
    expect(
      await asked({ Budget: { CostFilters: { Service: ['x'] }, FilterExpression: { Not: {} } } })
    ).toBe(true);
    expect(await asked({ Budget: { CostTypes: {}, Metrics: ['UnblendedCost'] } })).toBe(true);
  });

  it('an out-of-band limit change is drift', async () => {
    const drift = driftOf(provider, templateState(), await readBack({ amount: '3.0' }));
    expect(drift).toEqual([
      { path: 'Budget.BudgetLimit.Amount', stateValue: 1, awsValue: 3 },
    ]);
  });

  it('an out-of-band subscriber change is drift, whatever the order', async () => {
    const drift = driftOf(
      provider,
      templateState(),
      await readBack({
        subscribers: {
          '80': [
            { SubscriptionType: 'EMAIL', Address: 'c@example.com' },
            { SubscriptionType: 'EMAIL', Address: 'a@example.com' },
          ],
        },
      })
    );
    expect(drift.map((d) => d.path)).toEqual(['NotificationsWithSubscribers']);
  });

  it('an explicit ThresholdType other than the default is still compared', async () => {
    const drift = driftOf(
      provider,
      templateState(),
      await readBack({
        notifications: [
          {
            NotificationType: 'ACTUAL',
            ComparisonOperator: 'GREATER_THAN',
            Threshold: 80,
            ThresholdType: 'ABSOLUTE_VALUE',
          },
        ],
      })
    );
    expect(drift.map((d) => d.path)).toEqual(['NotificationsWithSubscribers']);
  });

  it('a template spelling amounts, thresholds and dates as strings compares clean', async () => {
    const baseline = templateState();
    const budget = baseline['Budget'] as Record<string, unknown>;
    budget['BudgetLimit'] = { Amount: '1', Unit: 'USD' };
    budget['TimePeriod'] = { Start: '2026-10-01T00:00:00Z', End: '3706473600' };
    const list = baseline['NotificationsWithSubscribers'] as Record<string, unknown>[];
    (list[0]!['Notification'] as Record<string, unknown>)['Threshold'] = '80';
    (list[0]!['Notification'] as Record<string, unknown>)['ThresholdType'] = 'PERCENTAGE';

    expect(driftOf(provider, baseline, await readBack({}))).toEqual([]);
  });

  it('ignores BudgetLimit only where AWS sets it (AutoAdjustData / PlannedBudgetLimits)', () => {
    expect(provider.getDriftUnknownPaths(TYPE, templateState())).toEqual([]);
    expect(provider.getDriftUnknownPaths(TYPE, {})).toEqual([]);
    expect(provider.getDriftUnknownPaths(TYPE)).toEqual([]);
    expect(
      provider.getDriftUnknownPaths(TYPE, {
        Budget: { AutoAdjustData: { AutoAdjustType: 'HISTORICAL' } },
      })
    ).toEqual(['Budget.BudgetLimit']);
    expect(
      provider.getDriftUnknownPaths(TYPE, {
        Budget: { PlannedBudgetLimits: { '1759276800': { Amount: 5, Unit: 'USD' } } },
      })
    ).toEqual(['Budget.BudgetLimit']);
    expect(provider.getDriftUnknownPaths('AWS::SQS::Queue', templateState())).toEqual([]);
  });

  it('ignores a legacy filter member declared beside FilterExpression / Metrics, which AWS never returns', async () => {
    // Measured live (PR #5188): CreateBudget accepts CostTypes + FilterExpression,
    // and DescribeBudget returns CostTypes in neither shape.
    const mixed = {
      Budget: {
        BudgetName: NAME,
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: 1, Unit: 'USD' },
        CostTypes: { IncludeTax: false },
        FilterExpression: { Dimensions: { Key: 'SERVICE', Values: ['Amazon Simple Queue Service'] } },
      },
    };
    expect(provider.getDriftUnknownPaths(TYPE, mixed)).toEqual(['Budget.CostTypes']);
    expect(
      provider.getDriftUnknownPaths(TYPE, {
        Budget: { CostFilters: { Service: ['x'] }, Metrics: ['UnblendedCost'] },
      })
    ).toEqual(['Budget.CostFilters']);
    expect(provider.getDriftUnknownPaths(TYPE, { Budget: { CostTypes: {} } })).toEqual([]);
    awsHolds({
      budget: {
        BudgetName: NAME,
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: '1.0', Unit: 'USD' },
        FilterExpression: mixed.Budget.FilterExpression,
      },
    });
    const read = (await provider.readCurrentState(NAME, 'CostBudget', TYPE, mixed)) as Record<
      string,
      unknown
    >;
    expect(driftOf(provider, mixed, read).filter((d) => d.path.startsWith('Budget'))).toEqual([]);
  });

  it('canonicalizes PlannedBudgetLimits amounts, keeping every key its own property', () => {
    const planned = JSON.parse(
      '{"1759276800":{"Amount":"5.0","Unit":"USD"},"__proto__":{"Amount":"6","Unit":"USD"}}'
    ) as Record<string, unknown>;
    const out = provider.canonicalizeDriftProperties(TYPE, { Budget: { PlannedBudgetLimits: planned } });
    const result = (out['Budget'] as Record<string, unknown>)['PlannedBudgetLimits'] as Record<
      string,
      unknown
    >;
    expect(result['1759276800']).toEqual({ Amount: 5, Unit: 'USD' });
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  it('returns the bag by identity when nothing applies, and never mutates it', () => {
    const canonical = {
      Budget: { BudgetLimit: { Amount: 1, Unit: 'USD' } },
      NotificationsWithSubscribers: [
        {
          Notification: { Threshold: 80, ThresholdType: 'PERCENTAGE' },
          Subscribers: [],
        },
      ],
    };
    expect(provider.canonicalizeDriftProperties(TYPE, canonical)).toBe(canonical);
    const other = { Budget: { BudgetLimit: { Amount: 1 } } };
    expect(provider.canonicalizeDriftProperties('AWS::SQS::Queue', other)).toBe(other);

    const raw = templateState();
    const snapshot = JSON.stringify(raw);
    provider.canonicalizeDriftProperties(TYPE, raw);
    expect(JSON.stringify(raw)).toBe(snapshot);
  });

  it('drops from the baseline only the elapsed planned periods the readback no longer returns', async () => {
    const past = String(Math.floor(Date.now() / 1000) - 90 * 86400);
    const current = String(Math.floor(Date.now() / 1000) - 86400);
    const future = String(Math.floor(Date.now() / 1000) + 90 * 86400);
    const spend = { Amount: 5, Unit: 'USD' };
    const baseline = {
      Budget: { PlannedBudgetLimits: { [past]: spend, [current]: spend, [future]: spend } },
    };
    const aws = { Budget: { PlannedBudgetLimits: { [current]: spend } } };

    const out = await provider.canonicalizeDriftPair(TYPE, baseline, aws);

    // The future period AWS no longer holds stays, and is reported.
    expect(out.baseline).toEqual({
      Budget: { PlannedBudgetLimits: { [current]: spend, [future]: spend } },
    });
    expect(out.aws).toBe(aws);
    expect(baseline.Budget.PlannedBudgetLimits[past]).toEqual(spend);
    expect(
      driftOf(provider, out.baseline, aws).map((d) => d.path)
    ).toEqual([`Budget.PlannedBudgetLimits.${future}`]);
  });

  it('returns both bags by identity when no planned period has elapsed', async () => {
    const baseline = templateState();
    const aws = { Budget: {} };
    const out = await provider.canonicalizeDriftPair(TYPE, baseline, aws);
    expect(out.baseline).toBe(baseline);
    expect(out.aws).toBe(aws);
    const other = await provider.canonicalizeDriftPair('AWS::SQS::Queue', baseline, aws);
    expect(other.baseline).toBe(baseline);
  });

  it('declares the notification list (and the subscriber lists inside it) unordered', () => {
    expect(provider.getDriftUnorderedPaths(TYPE)).toEqual(['NotificationsWithSubscribers']);
    expect(provider.getDriftUnorderedPaths('AWS::SQS::Queue')).toEqual([]);
  });
});

describe('BudgetsBudgetProvider drift --revert round trip (go-to-k/cdkd#5183)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStsSend.mockResolvedValue({ Account: ACCOUNT });
  });

  it('sends UpdateBudget the readback FilterExpression and Metrics, so the filter survives a revert', async () => {
    // `drift --revert` overlays the drifted path onto the AWS readback and
    // hands that bag to `update()`: the FilterExpression shape must reach
    // UpdateBudget whole, or AWS resets the budget to all spend.
    const provider = new BudgetsBudgetProvider();
    const filter = { Dimensions: { Key: 'SERVICE', Values: ['Amazon Simple Queue Service'] } };
    awsHolds({
      notifications: [],
      budget: {
        BudgetName: NAME,
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: '3.0', Unit: 'USD' },
        TimePeriod: { Start: new Date('2026-10-01T00:00:00Z'), End: new Date('2087-06-15T00:00:00Z') },
        FilterExpression: filter,
        Metrics: ['UnblendedCost'],
      },
    });
    const read = (await provider.readCurrentState(NAME, 'CostBudget', TYPE)) as Record<
      string,
      unknown
    >;
    const reverted = {
      ...read,
      Budget: {
        ...(read['Budget'] as Record<string, unknown>),
        BudgetLimit: { Amount: 2, Unit: 'USD' },
      },
    };
    mockSend.mockReset();
    mockSend.mockResolvedValue({});

    await provider.update('CostBudget', NAME, TYPE, reverted, read);

    const updates = mockSend.mock.calls
      .filter((c) => c[0] instanceof UpdateBudgetCommand)
      .map((c) => c[0].input);
    expect(updates).toEqual([
      {
        AccountId: ACCOUNT,
        NewBudget: {
          BudgetName: NAME,
          BudgetType: 'COST',
          TimeUnit: 'MONTHLY',
          BudgetLimit: { Amount: '2', Unit: 'USD' },
          TimePeriod: {
            Start: new Date('2026-10-01T00:00:00Z'),
            End: new Date('2087-06-15T00:00:00Z'),
          },
          FilterExpression: filter,
          Metrics: ['UnblendedCost'],
        },
      },
    ]);
  });
});
