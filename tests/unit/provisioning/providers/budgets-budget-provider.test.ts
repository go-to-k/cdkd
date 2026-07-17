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
  getAwsClients: () => ({
    sts: { send: mockStsSend },
  }),
}));

vi.mock('../../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => child,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import {
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
} from '@aws-sdk/client-budgets';
import { BudgetsBudgetProvider } from '../../../../src/provisioning/providers/budgets-budget-provider.js';
import {
  ReplacementRulesRegistry,
  budgetNameChanged,
} from '../../../../src/analyzer/replacement-rules.js';
import { ProvisioningError } from '../../../../src/utils/error-handler.js';

const TYPE = 'AWS::Budgets::Budget';
const ACCOUNT = '123456789012';

const notFound = (): NotFoundException =>
  new NotFoundException({ message: 'not found', $metadata: {} });

const budgetProps = (name?: string): Record<string, unknown> => ({
  Budget: {
    ...(name !== undefined && { BudgetName: name }),
    BudgetType: 'COST',
    TimeUnit: 'MONTHLY',
    BudgetLimit: { Amount: 10, Unit: 'USD' },
  },
});

const emailNotification = (threshold: number, address: string): Record<string, unknown> => ({
  Notification: {
    NotificationType: 'ACTUAL',
    ComparisonOperator: 'GREATER_THAN',
    Threshold: threshold,
  },
  Subscribers: [{ SubscriptionType: 'EMAIL', Address: address }],
});

const callsOf = (ctor: unknown): unknown[] =>
  mockSend.mock.calls
    .filter((call: unknown[]) => call[0] instanceof (ctor as new (...args: never[]) => object))
    .map((call: unknown[]) => (call[0] as { input: unknown }).input);

describe('BudgetsBudgetProvider', () => {
  let provider: BudgetsBudgetProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStsSend.mockResolvedValue({ Account: ACCOUNT });
    mockSend.mockResolvedValue({});
    provider = new BudgetsBudgetProvider();
  });

  describe('create', () => {
    it('creates a budget with the explicit name and converts Amount to a string', async () => {
      const result = await provider.create('MyBudget', TYPE, budgetProps('team-budget'));

      expect(result.physicalId).toBe('team-budget');
      expect(result.attributes).toEqual({
        Arn: `arn:aws:budgets::${ACCOUNT}:budget/team-budget`,
      });

      const [input] = callsOf(CreateBudgetCommand) as [Record<string, unknown>];
      expect(input['AccountId']).toBe(ACCOUNT);
      const budget = input['Budget'] as Record<string, unknown>;
      expect(budget['BudgetName']).toBe('team-budget');
      expect(budget['BudgetLimit']).toEqual({ Amount: '10', Unit: 'USD' });
      // No notifications / tags supplied — the optional params stay absent.
      expect(input['NotificationsWithSubscribers']).toBeUndefined();
      expect(input['ResourceTags']).toBeUndefined();
    });

    it('passes a user-supplied BudgetName through verbatim (no sanitize, no prefix)', async () => {
      const result = await provider.create('MyBudget', TYPE, budgetProps('My Team Budget 2026'));
      expect(result.physicalId).toBe('My Team Budget 2026');

      const [input] = callsOf(CreateBudgetCommand) as [Record<string, unknown>];
      expect((input['Budget'] as Record<string, unknown>)['BudgetName']).toBe(
        'My Team Budget 2026'
      );
    });

    it('generates a budget name when Budget.BudgetName is absent', async () => {
      const result = await provider.create('MyBudget', TYPE, budgetProps());
      expect(result.physicalId).toMatch(/MyBudget/);

      const [input] = callsOf(CreateBudgetCommand) as [Record<string, unknown>];
      expect((input['Budget'] as Record<string, unknown>)['BudgetName']).toBe(result.physicalId);
    });

    it('passes NotificationsWithSubscribers and ResourceTags through CreateBudget', async () => {
      await provider.create('MyBudget', TYPE, {
        ...budgetProps('nb'),
        NotificationsWithSubscribers: [emailNotification(80, 'ops@example.com')],
        ResourceTags: [{ Key: 'env', Value: 'test' }],
      });

      const [input] = callsOf(CreateBudgetCommand) as [Record<string, unknown>];
      expect(input['NotificationsWithSubscribers']).toEqual([
        {
          Notification: {
            NotificationType: 'ACTUAL',
            ComparisonOperator: 'GREATER_THAN',
            Threshold: 80,
          },
          Subscribers: [{ SubscriptionType: 'EMAIL', Address: 'ops@example.com' }],
        },
      ]);
      expect(input['ResourceTags']).toEqual([{ Key: 'env', Value: 'test' }]);
    });

    it('converts TimePeriod date strings and epoch seconds to Dates', async () => {
      await provider.create('MyBudget', TYPE, {
        Budget: {
          BudgetName: 'tp',
          BudgetType: 'COST',
          TimeUnit: 'MONTHLY',
          TimePeriod: { Start: '2026-07-01T00:00:00Z', End: '1783036800' },
        },
      });

      const [input] = callsOf(CreateBudgetCommand) as [Record<string, unknown>];
      const period = (input['Budget'] as Record<string, unknown>)['TimePeriod'] as {
        Start: Date;
        End: Date;
      };
      expect(period.Start).toEqual(new Date('2026-07-01T00:00:00Z'));
      expect(period.End).toEqual(new Date(1783036800 * 1000));
    });

    it('rejects an unparseable TimePeriod date with a clear error', async () => {
      await expect(
        provider.create('MyBudget', TYPE, {
          Budget: {
            BudgetName: 'bad',
            BudgetType: 'COST',
            TimeUnit: 'MONTHLY',
            TimePeriod: { Start: 'not-a-date' },
          },
        })
      ).rejects.toThrow(/TimePeriod.Start/);
    });

    it('requires the Budget property', async () => {
      await expect(provider.create('MyBudget', TYPE, {})).rejects.toThrow(ProvisioningError);
    });

    it('converts PlannedBudgetLimits amounts to numeric strings per key', async () => {
      await provider.create('MyBudget', TYPE, {
        Budget: {
          BudgetName: 'pbl',
          BudgetType: 'COST',
          TimeUnit: 'MONTHLY',
          PlannedBudgetLimits: {
            '1783036800': { Amount: 5, Unit: 'USD' },
            '1785715200': { Amount: 7.5, Unit: 'USD' },
          },
        },
      });

      const [input] = callsOf(CreateBudgetCommand) as [Record<string, unknown>];
      expect((input['Budget'] as Record<string, unknown>)['PlannedBudgetLimits']).toEqual({
        '1783036800': { Amount: '5', Unit: 'USD' },
        '1785715200': { Amount: '7.5', Unit: 'USD' },
      });
    });

    it('converts numeric epoch TimePeriod values (seconds and milliseconds)', async () => {
      await provider.create('MyBudget', TYPE, {
        Budget: {
          BudgetName: 'tp-num',
          BudgetType: 'COST',
          TimeUnit: 'MONTHLY',
          // Start: epoch SECONDS as a number; End: epoch MILLISECONDS as a
          // numeric string (>= 1e12 triggers the millis branch).
          TimePeriod: { Start: 1783036800, End: '1783036800000' },
        },
      });

      const [input] = callsOf(CreateBudgetCommand) as [Record<string, unknown>];
      const period = (input['Budget'] as Record<string, unknown>)['TimePeriod'] as {
        Start: Date;
        End: Date;
      };
      expect(period.Start).toEqual(new Date(1783036800 * 1000));
      expect(period.End).toEqual(new Date(1783036800000));
    });

    it('wraps CreateBudget failures in ProvisioningError', async () => {
      mockSend.mockRejectedValueOnce(new Error('AccessDenied'));
      await expect(provider.create('MyBudget', TYPE, budgetProps('x'))).rejects.toThrow(
        /Failed to create budget MyBudget: AccessDenied/
      );
    });

    it('coerces ResourceTags values and skips entries without a string Key', async () => {
      await provider.create('MyBudget', TYPE, {
        ...budgetProps('rt'),
        ResourceTags: [
          { Key: 'num', Value: 7 },
          { Key: 'bool', Value: true },
          { Value: 'no-key' },
        ],
      });

      const [input] = callsOf(CreateBudgetCommand) as [Record<string, unknown>];
      expect(input['ResourceTags']).toEqual([
        { Key: 'num', Value: '7' },
        { Key: 'bool', Value: 'true' },
      ]);
    });

    it('caches the STS account id across calls (single-flight per instance)', async () => {
      await provider.create('A', TYPE, budgetProps('a'));
      await provider.create('B', TYPE, budgetProps('b'));
      expect(mockStsSend).toHaveBeenCalledTimes(1);
    });

    it('does not cache a failed STS resolution', async () => {
      mockStsSend.mockRejectedValueOnce(new Error('throttled'));
      await expect(provider.create('A', TYPE, budgetProps('a'))).rejects.toThrow(/throttled/);
      await provider.create('B', TYPE, budgetProps('b'));
      expect(mockStsSend).toHaveBeenCalledTimes(2);
    });
  });

  describe('update', () => {
    it('updates the budget definition via UpdateBudget addressed by physical id', async () => {
      const result = await provider.update(
        'MyBudget',
        'team-budget',
        TYPE,
        budgetProps('team-budget'),
        budgetProps('team-budget')
      );

      expect(result.wasReplaced).toBe(false);
      expect(result.physicalId).toBe('team-budget');
      const [input] = callsOf(UpdateBudgetCommand) as [Record<string, unknown>];
      expect(input['AccountId']).toBe(ACCOUNT);
      expect((input['NewBudget'] as Record<string, unknown>)['BudgetName']).toBe('team-budget');
    });

    it('creates added notifications and deletes removed ones', async () => {
      await provider.update(
        'MyBudget',
        'team-budget',
        TYPE,
        {
          ...budgetProps('team-budget'),
          NotificationsWithSubscribers: [emailNotification(90, 'ops@example.com')],
        },
        {
          ...budgetProps('team-budget'),
          NotificationsWithSubscribers: [emailNotification(80, 'ops@example.com')],
        }
      );

      const deletes = callsOf(DeleteNotificationCommand) as Array<Record<string, unknown>>;
      expect(deletes).toHaveLength(1);
      expect((deletes[0]!['Notification'] as Record<string, unknown>)['Threshold']).toBe(80);

      const creates = callsOf(CreateNotificationCommand) as Array<Record<string, unknown>>;
      expect(creates).toHaveLength(1);
      expect((creates[0]!['Notification'] as Record<string, unknown>)['Threshold']).toBe(90);
      expect(creates[0]!['Subscribers']).toEqual([
        { SubscriptionType: 'EMAIL', Address: 'ops@example.com' },
      ]);
    });

    it('reconciles subscribers on a retained notification, creating before deleting', async () => {
      const previous = {
        ...budgetProps('team-budget'),
        NotificationsWithSubscribers: [emailNotification(80, 'old@example.com')],
      };
      const next = {
        ...budgetProps('team-budget'),
        NotificationsWithSubscribers: [emailNotification(80, 'new@example.com')],
      };

      await provider.update('MyBudget', 'team-budget', TYPE, next, previous);

      expect(callsOf(DeleteNotificationCommand)).toHaveLength(0);
      expect(callsOf(CreateNotificationCommand)).toHaveLength(0);

      const createSub = callsOf(CreateSubscriberCommand) as Array<Record<string, unknown>>;
      const deleteSub = callsOf(DeleteSubscriberCommand) as Array<Record<string, unknown>>;
      expect(createSub).toHaveLength(1);
      expect((createSub[0]!['Subscriber'] as Record<string, unknown>)['Address']).toBe(
        'new@example.com'
      );
      expect(deleteSub).toHaveLength(1);
      expect((deleteSub[0]!['Subscriber'] as Record<string, unknown>)['Address']).toBe(
        'old@example.com'
      );

      // A notification must always keep >= 1 subscriber: the create must be
      // issued BEFORE the delete on a full swap.
      const createIndex = mockSend.mock.calls.findIndex(
        (call: unknown[]) => call[0] instanceof CreateSubscriberCommand
      );
      const deleteIndex = mockSend.mock.calls.findIndex(
        (call: unknown[]) => call[0] instanceof DeleteSubscriberCommand
      );
      expect(createIndex).toBeLessThan(deleteIndex);
    });

    it('treats an omitted ThresholdType as equal to an explicit PERCENTAGE', async () => {
      const withExplicit = emailNotification(80, 'ops@example.com');
      (withExplicit['Notification'] as Record<string, unknown>)['ThresholdType'] = 'PERCENTAGE';

      await provider.update(
        'MyBudget',
        'team-budget',
        TYPE,
        { ...budgetProps('team-budget'), NotificationsWithSubscribers: [withExplicit] },
        {
          ...budgetProps('team-budget'),
          NotificationsWithSubscribers: [emailNotification(80, 'ops@example.com')],
        }
      );

      expect(callsOf(DeleteNotificationCommand)).toHaveLength(0);
      expect(callsOf(CreateNotificationCommand)).toHaveLength(0);
      expect(callsOf(CreateSubscriberCommand)).toHaveLength(0);
      expect(callsOf(DeleteSubscriberCommand)).toHaveLength(0);
    });

    it('diffs ResourceTags via UntagResource + TagResource', async () => {
      await provider.update(
        'MyBudget',
        'team-budget',
        TYPE,
        { ...budgetProps('team-budget'), ResourceTags: [{ Key: 'keep', Value: 'v2' }] },
        {
          ...budgetProps('team-budget'),
          ResourceTags: [
            { Key: 'keep', Value: 'v1' },
            { Key: 'drop', Value: 'x' },
          ],
        }
      );

      const untags = callsOf(UntagResourceCommand) as Array<Record<string, unknown>>;
      expect(untags).toHaveLength(1);
      expect(untags[0]!['ResourceTagKeys']).toEqual(['drop']);
      expect(untags[0]!['ResourceARN']).toBe(`arn:aws:budgets::${ACCOUNT}:budget/team-budget`);

      const tags = callsOf(TagResourceCommand) as Array<Record<string, unknown>>;
      expect(tags).toHaveLength(1);
      expect(tags[0]!['ResourceTags']).toEqual([{ Key: 'keep', Value: 'v2' }]);
    });

    it('creates all notifications when the previous set was absent', async () => {
      await provider.update(
        'MyBudget',
        'team-budget',
        TYPE,
        {
          ...budgetProps('team-budget'),
          NotificationsWithSubscribers: [
            emailNotification(80, 'a@example.com'),
            emailNotification(90, 'b@example.com'),
          ],
        },
        budgetProps('team-budget')
      );

      expect(callsOf(CreateNotificationCommand)).toHaveLength(2);
      expect(callsOf(DeleteNotificationCommand)).toHaveLength(0);
    });

    it('deletes all notifications when the new set is absent', async () => {
      await provider.update('MyBudget', 'team-budget', TYPE, budgetProps('team-budget'), {
        ...budgetProps('team-budget'),
        NotificationsWithSubscribers: [emailNotification(80, 'a@example.com')],
      });

      expect(callsOf(DeleteNotificationCommand)).toHaveLength(1);
      expect(callsOf(CreateNotificationCommand)).toHaveLength(0);
    });

    it('removes all tags via UntagResource only when ResourceTags becomes empty', async () => {
      await provider.update('MyBudget', 'team-budget', TYPE, budgetProps('team-budget'), {
        ...budgetProps('team-budget'),
        ResourceTags: [{ Key: 'drop', Value: 'x' }],
      });

      const untags = callsOf(UntagResourceCommand) as Array<Record<string, unknown>>;
      expect(untags).toHaveLength(1);
      expect(untags[0]!['ResourceTagKeys']).toEqual(['drop']);
      expect(callsOf(TagResourceCommand)).toHaveLength(0);
    });

    it('treats NotFound on reconciler deletes as idempotent success (retry/rollback safety)', async () => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof DeleteNotificationCommand) {
          return Promise.reject(new NotFoundException({ message: 'gone', $metadata: {} }));
        }
        return Promise.resolve({});
      });

      await expect(
        provider.update('MyBudget', 'team-budget', TYPE, budgetProps('team-budget'), {
          ...budgetProps('team-budget'),
          NotificationsWithSubscribers: [emailNotification(80, 'a@example.com')],
        })
      ).resolves.toBeDefined();
    });

    it('treats DuplicateRecord on reconciler creates as idempotent success (retry safety)', async () => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof CreateNotificationCommand || cmd instanceof CreateSubscriberCommand) {
          return Promise.reject(new DuplicateRecordException({ message: 'dup', $metadata: {} }));
        }
        return Promise.resolve({});
      });

      await expect(
        provider.update(
          'MyBudget',
          'team-budget',
          TYPE,
          {
            ...budgetProps('team-budget'),
            NotificationsWithSubscribers: [
              emailNotification(90, 'a@example.com'),
              emailNotification(80, 'b@example.com'),
            ],
          },
          {
            ...budgetProps('team-budget'),
            NotificationsWithSubscribers: [emailNotification(80, 'a@example.com')],
          }
        )
      ).resolves.toBeDefined();
    });

    it('still fails the update when a reconciler delete errors with a non-NotFound error', async () => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof DeleteNotificationCommand) {
          return Promise.reject(new Error('AccessDenied'));
        }
        return Promise.resolve({});
      });

      await expect(
        provider.update('MyBudget', 'team-budget', TYPE, budgetProps('team-budget'), {
          ...budgetProps('team-budget'),
          NotificationsWithSubscribers: [emailNotification(80, 'a@example.com')],
        })
      ).rejects.toThrow(/AccessDenied/);
    });

    it('wraps UpdateBudget failures in ProvisioningError', async () => {
      mockSend.mockRejectedValueOnce(new Error('Throttling'));
      await expect(
        provider.update(
          'MyBudget',
          'team-budget',
          TYPE,
          budgetProps('team-budget'),
          budgetProps('team-budget')
        )
      ).rejects.toThrow(/Failed to update budget MyBudget: Throttling/);
    });

    it('skips tag calls when ResourceTags are unchanged', async () => {
      const props = {
        ...budgetProps('team-budget'),
        ResourceTags: [{ Key: 'env', Value: 'test' }],
      };
      await provider.update('MyBudget', 'team-budget', TYPE, props, props);
      expect(callsOf(UntagResourceCommand)).toHaveLength(0);
      expect(callsOf(TagResourceCommand)).toHaveLength(0);
    });
  });

  describe('delete', () => {
    it('deletes the budget by physical id', async () => {
      await provider.delete('MyBudget', 'team-budget', TYPE);
      const [input] = callsOf(DeleteBudgetCommand) as [Record<string, unknown>];
      expect(input).toEqual({ AccountId: ACCOUNT, BudgetName: 'team-budget' });
    });

    it('treats NotFound as idempotent success when the region matches', async () => {
      mockSend.mockRejectedValueOnce(notFound());
      await expect(
        provider.delete('MyBudget', 'team-budget', TYPE, undefined, {
          expectedRegion: 'us-east-1',
        })
      ).resolves.toBeUndefined();
    });

    it('refuses to trust NotFound when the client region mismatches the state region', async () => {
      mockSend.mockRejectedValueOnce(notFound());
      await expect(
        provider.delete('MyBudget', 'team-budget', TYPE, undefined, {
          expectedRegion: 'ap-northeast-1',
        })
      ).rejects.toThrow(ProvisioningError);
    });

    it('wraps non-NotFound errors in ProvisioningError', async () => {
      mockSend.mockRejectedValueOnce(new Error('access denied'));
      await expect(provider.delete('MyBudget', 'team-budget', TYPE)).rejects.toThrow(
        /access denied/
      );
    });
  });

  describe('getAttribute', () => {
    it('serves Arn after verifying the budget exists', async () => {
      const arn = await provider.getAttribute('team-budget', TYPE, 'Arn');
      expect(arn).toBe(`arn:aws:budgets::${ACCOUNT}:budget/team-budget`);
      expect(callsOf(DescribeBudgetCommand)).toHaveLength(1);
    });

    it('rejects unknown attributes', async () => {
      await expect(provider.getAttribute('team-budget', TYPE, 'Nope')).rejects.toThrow(
        /Unknown attribute/
      );
    });

    it('wraps DescribeBudget failures in ProvisioningError', async () => {
      mockSend.mockRejectedValueOnce(new Error('boom'));
      await expect(provider.getAttribute('team-budget', TYPE, 'Arn')).rejects.toThrow(
        /Failed to resolve Arn for budget team-budget: boom/
      );
    });
  });

  describe('import', () => {
    const input = (overrides: Record<string, unknown> = {}): never =>
      ({
        logicalId: 'MyBudget',
        resourceType: TYPE,
        cdkPath: 'MyStack/MyBudget',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {},
        ...overrides,
      }) as never;

    it('verifies a known physical id via DescribeBudget', async () => {
      const result = await provider.import(input({ knownPhysicalId: 'team-budget' }));
      expect(result).toEqual({
        physicalId: 'team-budget',
        attributes: { Arn: `arn:aws:budgets::${ACCOUNT}:budget/team-budget` },
      });
    });

    it('falls back to Properties.Budget.BudgetName', async () => {
      const result = await provider.import(
        input({ properties: { Budget: { BudgetName: 'named-budget' } } })
      );
      expect(result?.physicalId).toBe('named-budget');
    });

    it('returns null when the explicit budget does not exist', async () => {
      mockSend.mockRejectedValueOnce(notFound());
      const result = await provider.import(input({ knownPhysicalId: 'gone' }));
      expect(result).toBeNull();
    });

    it('looks budgets up by the aws:cdk:path tag', async () => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof DescribeBudgetsCommand) {
          return Promise.resolve({ Budgets: [{ BudgetName: 'tagged' }] });
        }
        if (cmd instanceof ListTagsForResourceCommand) {
          return Promise.resolve({
            ResourceTags: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyBudget' }],
          });
        }
        return Promise.resolve({});
      });

      const result = await provider.import(input());
      expect(result?.physicalId).toBe('tagged');
    });

    it('walks DescribeBudgets pagination and forwards NextToken', async () => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof DescribeBudgetsCommand) {
          const token = (cmd as { input: { NextToken?: string } }).input.NextToken;
          if (!token) {
            return Promise.resolve({ Budgets: [{ BudgetName: 'other' }], NextToken: 't1' });
          }
          return Promise.resolve({ Budgets: [{ BudgetName: 'tagged' }] });
        }
        if (cmd instanceof ListTagsForResourceCommand) {
          const arn = (cmd as { input: { ResourceARN: string } }).input.ResourceARN;
          return Promise.resolve({
            ResourceTags: arn.endsWith('/tagged')
              ? [{ Key: 'aws:cdk:path', Value: 'MyStack/MyBudget' }]
              : [],
          });
        }
        return Promise.resolve({});
      });

      const result = await provider.import(input());
      expect(result?.physicalId).toBe('tagged');

      const describeCalls = callsOf(DescribeBudgetsCommand) as Array<Record<string, unknown>>;
      expect(describeCalls).toHaveLength(2);
      expect(describeCalls[1]!['NextToken']).toBe('t1');
    });

    it('returns null when there is no explicit name and no cdkPath', async () => {
      const result = await provider.import(input({ cdkPath: '' }));
      expect(result).toBeNull();
      expect(callsOf(DescribeBudgetsCommand)).toHaveLength(0);
    });

    it('rethrows non-NotFound errors from the explicit DescribeBudget unwrapped', async () => {
      mockSend.mockRejectedValueOnce(new Error('AccessDenied'));
      await expect(provider.import(input({ knownPhysicalId: 'team-budget' }))).rejects.toThrow(
        'AccessDenied'
      );
    });

    it('returns null when no budget carries the cdk path tag', async () => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof DescribeBudgetsCommand) {
          return Promise.resolve({ Budgets: [{ BudgetName: 'other' }] });
        }
        if (cmd instanceof ListTagsForResourceCommand) {
          return Promise.resolve({ ResourceTags: [] });
        }
        return Promise.resolve({});
      });

      const result = await provider.import(input());
      expect(result).toBeNull();
    });
  });
});

describe('AWS::Budgets::Budget replacement rule', () => {
  const registry = new ReplacementRulesRegistry();

  it('classifies a BudgetName change as replacement', () => {
    expect(
      registry.requiresReplacement(
        TYPE,
        'Budget',
        { BudgetName: 'old', BudgetType: 'COST' },
        { BudgetName: 'new', BudgetType: 'COST' }
      )
    ).toBe(true);
  });

  it('keeps non-name Budget edits in place', () => {
    expect(
      registry.requiresReplacement(
        TYPE,
        'Budget',
        { BudgetName: 'same', BudgetLimit: { Amount: 10, Unit: 'USD' } },
        { BudgetName: 'same', BudgetLimit: { Amount: 20, Unit: 'USD' } }
      )
    ).toBe(false);
  });

  it('keeps NotificationsWithSubscribers and ResourceTags updateable', () => {
    expect(registry.requiresReplacement(TYPE, 'NotificationsWithSubscribers', [], [{}])).toBe(
      false
    );
    expect(registry.requiresReplacement(TYPE, 'ResourceTags', [], [{}])).toBe(false);
  });

  it('treats a one-sided explicit name as a change and double-absent as no change', () => {
    expect(budgetNameChanged({}, { BudgetName: 'now-named' })).toBe(true);
    expect(budgetNameChanged({ BudgetName: 'was-named' }, {})).toBe(true);
    expect(budgetNameChanged({}, {})).toBe(false);
  });
});
